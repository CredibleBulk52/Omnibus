'use strict';
// ─── Timeline: matching event issues to library books (moved out of server.js 2026-11-24, server.js split, events) ───
// reconcileEventIssues: clears matches whose book is gone or whose number or year is wrong, then matches
// each unmatched event issue by Comic Vine ID, monitored issue, ComicInfo, published name, series name and
// number, and file name. Runs after scans, after tagging (once per batch) and from the event page.
const IN = require('./issueNumber');
const { nameKey } = require('./names');
const { createLibrarySnapshot } = require('./eventLibrarySnapshot');

const NEEDS = ['bookIndex', 'db', 'extractNumberFromFilename', 'logger', 'padIssueNumStr'];
module.exports.NEEDS = NEEDS;

module.exports.createEventReconcile = function createEventReconcile(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createEventReconcile: missing ${missing.join(', ')}`);
  const { bookIndex, db, extractNumberFromFilename, logger, padIssueNumStr } = deps;
  // ─── Event Reconciliation ─────────────────────────────────────────
  // Runs after every library scan. For each event_issue that has a cv_issue_id
  // but no scanned_book_id, tries to match against scanned_books using 5-level hierarchy.
  // scanChanged: true if the scan added or removed any books — enables invalidation passes.
  // When false (nothing changed on disk), skip the expensive invalidation passes entirely
  // since they would just clear and re-match the same issues as last time.
  const completeEventReconcile = require('./metadata/completionQueue').createCompletionQueue();
  // "X Annual" #2025 (a year where the number should be) → "X 2025 Annual" #1,
  // Comic Vine's name for year-titled annuals. null when it is not that shape.
  function yearAnnual(seriesName, issueNumber) {
    const name = String(seriesName || ''), num = String(issueNumber ?? '').trim();
    if (!/^(?:19|20)\d{2}$/.test(num) || !/\bannual\b/i.test(name) || /\b(?:19|20)\d{2}\b/.test(name)) return null;
    return { name: name.replace(/\s*\bannual\b/i, ` ${num} Annual`).replace(/\s+/g, ' ').trim(), year: Number(num) };
  }
  const {eventYearMatches}=require('./metadata/eventYear');
  function reconcileEventIssues(scanChanged = true, options = {}) {
    return completeEventReconcile(() => runEventReconcile(scanChanged, options));
  }
  async function runEventReconcile(scanChanged = true, { strict = false } = {}) {
    const yieldLoop = () => new Promise(r => setImmediate(r));
    // Was the book PUBLISHED under this number? Specials and minis filed in a
    // parent folder carry folder numbers like 0.2 (Rebirth #2); their ComicInfo
    // still says #2. Such a book passes the number checks below.
    const publishedAs = (bookId, num) => { try { return !!bookId && bookIndex.publishedAs(bookId, num); } catch { return false; } };

    if (scanChanged) {
      // Pass 1: clear stale matches where the scanned book no longer exists on disk
      // Skip manually_matched — user chose this intentionally, don't auto-clear it
      db.prepare(`
      UPDATE event_issues SET scanned_book_id = NULL
      WHERE scanned_book_id IS NOT NULL
        AND (manually_matched IS NULL OR manually_matched = 0)
        AND scanned_book_id NOT IN (SELECT id FROM scanned_books)
        AND scanned_book_id NOT IN (SELECT id FROM missing_books)
    `).run();

      await yieldLoop(); // yield between passes so HTTP requests can be served

      // Pass 2: validate existing matches — clear any where the matched book's issue_number
      // differs from the event issue's expected number by more than 1.
      // This catches hallucinated cv_issue_ids that matched the wrong book (e.g. Legends #1
      // being matched to Legends of the Dark Knight #137 via a bad CV ID).
      const existingMatches = db.prepare(`
      SELECT ei.id, ei.issue_number AS ei_num, sb.issue_number AS sb_num, sb.id AS book_id
      FROM event_issues ei
      JOIN scanned_books sb ON sb.id = ei.scanned_book_id
      WHERE ei.scanned_book_id IS NOT NULL
        AND (ei.manually_matched IS NULL OR ei.manually_matched = 0)
    `).all();

      const normN = n => parseFloat(String(n || '0').replace(/,/g, '')) || 0;
      let invalidated = 0;
      for (const row of existingMatches) {
        if (row.sb_num === null || row.sb_num === undefined) continue; // no number — keep
        if (publishedAs(row.book_id, row.ei_num)) continue;             // retag-filed book, published as this number — keep
        if (Math.abs(normN(row.sb_num) - normN(row.ei_num)) > 1) {
          db.prepare('UPDATE event_issues SET scanned_book_id = NULL WHERE id = ?').run(row.id);
          invalidated++;
        }
      }
      if (invalidated > 0) logger.warn('events', `Invalidated ${invalidated} bad event matches (issue number mismatch)`);

      await yieldLoop(); // yield before year-mismatch pass

      // Pass 2b: year mismatch — clear matches where volume_year is known and the matched
      // book's ComicInfo <Year> is more than 4 years away. This catches wrong-volume matches
      // that share the same issue number (e.g. Superman #3 from 1940 matched to a 1986 event).
      // SKIP: matches where the book's cv_issue_id directly matches — these are trusted L1
      // matches and the year guard has no business clearing them (causes the clear-rematch cycle).
      const yearMatches = db.prepare(`
      SELECT ei.id, ei.volume_year, ei.cv_issue_id AS event_cv_issue_id, sb.cv_issue_id, sb.comicinfo, ss.year as syear
      FROM event_issues ei
      JOIN scanned_books sb ON sb.id = ei.scanned_book_id
      JOIN scanned_series ss ON ss.id = sb.series_id
      WHERE ei.scanned_book_id IS NOT NULL AND ei.volume_year IS NOT NULL
        AND (ei.manually_matched IS NULL OR ei.manually_matched = 0)
        AND (ei.cv_issue_id IS NULL OR sb.cv_issue_id != ei.cv_issue_id)
    `).all();

      let yearInvalidated = 0;
      for (const row of yearMatches) {
        if (!eventYearMatches({volumeYear:row.volume_year,cvIssueId:row.event_cv_issue_id,book:row})) {
          db.prepare('UPDATE event_issues SET scanned_book_id = NULL WHERE id = ?').run(row.id);
          yearInvalidated++;
        }
      }
      if (yearInvalidated > 0) logger.warn('events', `Invalidated ${yearInvalidated} bad event matches (year mismatch)`);

      await yieldLoop(); // yield before main matching loop
    }

    const eventIssues = db.prepare(
      // Query ALL unmatched issues — cv_issue_id may be null for AI-generated orders
      "SELECT * FROM event_issues WHERE scanned_book_id IS NULL"
    ).all();
    if (!eventIssues.length) return;

    let matched = 0;
    const update = db.prepare('UPDATE event_issues SET scanned_book_id = ? WHERE id = ? AND scanned_book_id IS NULL AND COALESCE(manually_matched,0)=0');

    // Canonical issue-number form. Delegates to issueNumber module so the
    // reconciler, scanner, search, and CV arc lookup all agree on shape.
    // Returns "0" when input is unparseable (preserves old fallback behaviour).
    const normIssueNum = n => IN.normIssueNumber(n) || '0';

    // Words considered noise — present-or-absent doesn't change series identity.
    // Used by the L4 name matcher to decide if two normalized names that look
    // similar are actually the same series with different filler-word treatment
    // ("Wolverine and the X-Men" vs "Wolverine the X-Men"), or whether one has
    // a meaningful additional word that makes it a different series ("Avengers"
    // vs "New Avengers").
    const SERIES_NOISE_WORDS = new Set(['the', 'and', 'of', 'a', 'an']);

    /**
     * Normalize a series name to a sorted set of significant words.
     * Strips punctuation, lowercases, splits on whitespace, drops noise words.
     * "Wolverine & the X-Men" → ["men", "wolverine", "x"]
     * "Wolverine and the X-Men" → ["men", "wolverine", "x"]
     * "New Avengers" → ["avengers", "new"]
     * "Avengers" → ["avengers"]
     */
    const sigWordSet = (name) => {
      return new Set(
        String(name || '').toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w && !SERIES_NOISE_WORDS.has(w))
      );
    };

    // Extract cover year from stored ComicInfo XML
    const ciYear = (comicinfo) => {
      if (!comicinfo) return null;
      const m = comicinfo.match(/<Year>(\d{4})<\/Year>/i);
      return m ? parseInt(m[1]) : null;
    };

    // Levels 3, 4 and 5 search every book; read the library once for this run, when the first issue
    // gets that far (eventLibrarySnapshot.js, 2026-11-24). Same rows, order and comparisons as the SQL.
    let snapshot = null;
    const library = () => snapshot || (snapshot = createLibrarySnapshot(db));

    for (let ei of eventIssues) {
      try {
        const eiNum = normIssueNum(ei.issue_number);

        // Sanity-check helper: reject a candidate book if its issue number differs
        // meaningfully from the event issue's. Guards against AI-hallucinated
        // cv_issue_ids causing cross-series matches.
        //
        // Suffix-aware: "8" and "8.AU" must NOT pass — they're different issues
        // even though parseFloat would call them equal. When both sides are
        // plain-numeric (no allow-listed suffix), keep the original ±1 tolerance
        // so off-by-one parsing artefacts don't reject legitimate matches.
        const passesNumCheck = (bookRow) => {
          if (!bookRow) return false;
          if (!bookRow.issue_number) return true; // no number stored — benefit of the doubt
          if (publishedAs(bookRow.id, ei.issue_number)) return true; // filed under another number, published as this one
          const aCanon = normIssueNum(bookRow.issue_number);
          const bCanon = eiNum;
          if (aCanon === bCanon) return true;
          // If either side carries a suffix (e.g. ".AU"), require strict equality.
          // Different suffixes = different issues, no tolerance allowed.
          if (aCanon.includes('.') || bCanon.includes('.')) return false;
          const diff = Math.abs(parseFloat(aCanon) - parseFloat(bCanon));
          return diff <= 1;
        };

        // Level 1: direct cv_issue_id match — trusted unconditionally.
        // A correct CV ID is an exact DB lookup. Year guards do not belong here —
        // long-running series (Batman 1940, JLA 1960) have volume_year far from their
        // issue cover date, causing false rejections. Only the issue number sanity check applies.
        let book = ei.cv_issue_id
          ? db.prepare("SELECT id, issue_number FROM scanned_books WHERE cv_issue_id = ? LIMIT 1").get(ei.cv_issue_id)
          : null;
        if (book && !passesNumCheck(book)) {
          logger.warn('events', `L1 cv_issue_id match rejected — issue number mismatch (bad AI cv_issue_id, nulling)`, { ei_series: ei.series_name, ei_num: ei.issue_number, book_num: book.issue_number });
          // Null out the bad cv_issue_id so it stops being tried every reconcile cycle.
          // The correct cv_issue_id can be restored by re-generating or manually tagging the event.
          db.prepare('UPDATE event_issues SET cv_issue_id = NULL WHERE id = ?').run(ei.id);
          ei = { ...ei, cv_issue_id: null }; // update local copy for L2/L3
          book = null;
        }

        // Level 2: monitored_issue_id match — same trust level as L1
        if (!book && ei.cv_issue_id) {
          book = db.prepare("SELECT id, issue_number FROM scanned_books WHERE monitored_issue_id = ? LIMIT 1").get(ei.cv_issue_id);
          if (book && !passesNumCheck(book)) {
            logger.warn('events', `L2 monitored_id match rejected — issue number mismatch`, { ei_series: ei.series_name, ei_num: ei.issue_number, book_num: book.issue_number });
            book = null;
          }
        }

        // Level 3: ComicInfo XML LIKE fallback
        if (!book && ei.cv_issue_id) {
          const webPattern   = `%4000-${ei.cv_issue_id}%`;
          const notesPattern = `%[Issue ID ${ei.cv_issue_id}]%`;
          book = library().cvInComicInfo(ei.cv_issue_id);
          if (book === undefined && !/^\d+$/.test(String(ei.cv_issue_id))) book = db.prepare(`
          SELECT id, issue_number FROM scanned_books
          WHERE comicinfo LIKE ? OR comicinfo LIKE ?
          LIMIT 1
        `).get(webPattern, notesPattern);
          if (book && !passesNumCheck(book)) {
            logger.warn('events', `L3 comicinfo match rejected — issue number mismatch`, { ei_series: ei.series_name, ei_num: ei.issue_number, book_num: book.issue_number });
            book = null;
          }
        }

        // Level 3b: the name and number each book was PUBLISHED under (ComicInfo
        // index). Year-named annuals are their own Comic Vine volumes: an event
        // row "Batman/Superman: World's Finest Annual" #2025 is published as
        // "Batman/Superman: World's Finest 2025 Annual" #1, filed in the parent
        // folder, so the folder-name levels below never find it.
        if (!book && ei.series_name) {
          const ya = yearAnnual(ei.series_name, ei.issue_number);
          const name = ya ? ya.name : ei.series_name, num = ya ? '1' : ei.issue_number, year = ya ? ya.year : ei.volume_year;
          try {
            // A year is required: without one, "Green Lantern" #1 could be any volume's #1.
            const hit = num != null && year ? bookIndex.lookup(name, year).get(normIssueNum(num)) : null;
            if (hit) book = { id: hit.book_id, issue_number: hit.folder_number };
          } catch (e) { logger.warn('events', 'Published-name lookup failed', e.message); }
        }

        // Level 4: series name normalised + issue number
        // Year guard: prefer ComicInfo <Year> (issue cover year) over ss.year (series folder year).
        // When multiple candidates pass the name+year filter, pick the one CLOSEST to volume_year
        // rather than just the first — prevents GL (1990) beating GL (2004) for an IC event issue.
        if (!book) {
          const normName = nameKey(ei.series_name);
          const eiYear = ei.volume_year ? parseInt(ei.volume_year) : null;
          const candidates = library().sameNumber(ei.issue_number) ?? db.prepare(`
          SELECT sb.id, sb.issue_number, sb.comicinfo, ss.name as sname, ss.year as syear FROM scanned_books sb
          JOIN scanned_series ss ON ss.id = sb.series_id
          WHERE sb.issue_number = ?
        `).all(ei.issue_number).map(c => ({ ...c, ciYear: ciYear(c.comicinfo) }));

          const eiIsAnnual = /annual/i.test(ei.series_name);

          // Score each candidate: null = fails filter, otherwise distance from eiYear (lower = better)
          const scoreCand = (cand) => {
            if (!eiIsAnnual && /annual/i.test(cand.sname || '')) return null;
            const cNorm = nameKey(cand.sname);
            // Name match — word-set equality after stripping filler words.
            //
            // The strategy: split each name into its set of significant words
            // (dropping "the", "and", "of", etc.). Two names match if their
            // significant-word sets are identical. This cleanly handles:
            //   - "Wolverine and the X-Men" vs "Wolverine & the X-Men"
            //     → both → {wolverine, x, men} → match
            //   - "Avengers" vs "New Avengers"
            //     → {avengers} vs {new, avengers} → DIFFERENT, no match
            //   - "Wolverine" vs "Wolverines"
            //     → {wolverine} vs {wolverines} → DIFFERENT, no match (plural is a different word)
            //   - "The Fantastic Four" vs "Fantastic Four"
            //     → both → {fantastic, four} → match
            //
            // Falls back to exact normalized equality if word-set parsing fails
            // (defensive — shouldn't happen but cheap to keep).
            const eiWords = sigWordSet(ei.series_name);
            const cWords  = sigWordSet(cand.sname || '');
            const wordsMatch =
              eiWords.size === cWords.size
              && eiWords.size > 0
              && [...eiWords].every(w => cWords.has(w));
            const nameMatch = wordsMatch || cNorm === normName;
            if (!nameMatch) return null;
            const bookYear = cand.ciYear || (cand.syear ? parseInt(cand.syear) : null);
            if (eiYear && bookYear && Math.abs(bookYear - eiYear) > 4) return null; // year too far
            // Distance: if we know both years, use distance; otherwise treat as worst passing score
            const dist = (eiYear && bookYear) ? Math.abs(bookYear - eiYear) : 5;
            return { id: cand.id, dist };
          };

          let best = null;
          for (const cand of candidates) {
            const score = scoreCand(cand);
            if (!score) continue;
            if (!best || score.dist < best.dist) best = score;
          }
          if (best) book = { id: best.id };
        }

        // Level 5: fuzzy filename — series words + issue number in filename
        // The padded LIKE (%001%) is only a pre-filter; we then extract the actual issue
        // number from the filename and verify it matches. This prevents %001% matching
        // inside a year like "2001" in "Batman_-_LOTDK_137_(2001).cbz".
        // We also require the candidate's series name to be similar enough to the event
        // series name — prevents "Legends" matching "Batman: Legends of the Dark Knight".
        // Year guard applied here too when volume_year is known.
        if (!book) {
          const words = ei.series_name.toLowerCase().split(/\s+/).filter(w => w.length > 2);
          const eiNorm = nameKey(ei.series_name);
          // Preserve dot-decimals (648.1) and suffixes — parseInt would truncate
          // these to the base integer and cause the LIKE search to match the
          // wrong issue (#648 instead of #648.1, which are different stories).
          const eiNumRaw = String(ei.issue_number || '').trim();
          // Numeric form for the post-filter sanity check below — converts "648.1"
          // to 648.1 (keeps decimal) so we can compare against extractNumberFromFilename
          // results. parseInt would lose the decimal here too.
          const eiNumNumeric = parseFloat(eiNumRaw) || 0;
          const eiYear = ei.volume_year ? parseInt(ei.volume_year) : null;
          const numStr = padIssueNumStr(eiNumRaw, 3);
          if (words.length > 0) {
            const candidates = library().fileNameContains(numStr) ?? db.prepare(`
            SELECT sb.id, sb.filename, sb.comicinfo, ss.name as sname, ss.year as syear FROM scanned_books sb
            JOIN scanned_series ss ON ss.id = sb.series_id
            WHERE sb.filename LIKE ?
          `).all(`%${numStr}%`).map(c => ({ ...c, ciYear: ciYear(c.comicinfo) }));
            const eiIsAnnual_l5 = /annual/i.test(ei.series_name);
            for (const c of candidates) {
              // Annual guard — don't match annual filenames to non-annual event issues
              if (!eiIsAnnual_l5 && /annual/i.test(c.filename)) continue;
              // Year guard — ComicInfo issue year preferred, fall back to series year
              if (eiYear) {
                const bookYear = c.ciYear || (c.syear ? parseInt(c.syear) : null);
                if (bookYear && Math.abs(bookYear - eiYear) > 4) continue;
              }
              const fn = c.filename.toLowerCase();
              // 1. Verify extracted issue number from filename actually matches (not a year substring).
              //    parseFloat to preserve decimals — extractNumberFromFilename returns "648.1" for
              //    Point One issues; comparing against eiNumNumeric (also float) keeps the match working.
              const fnNum = parseFloat(extractNumberFromFilename(c.filename) || '-1');
              if (Math.abs(fnNum - eiNumNumeric) > 1) continue;
              // 2. Series name word-set match — must share all significant
              //    words (filler words dropped) to avoid "Legends" matching
              //    "Batman Legends of the Dark Knight". This is the same rule
              //    L4 uses; consistency prevents L5 from matching cases L4
              //    would correctly reject as different series.
              const candWords = sigWordSet(c.sname || '');
              const eiWordsL5 = sigWordSet(ei.series_name);
              if (eiWordsL5.size === 0
                  || candWords.size !== eiWordsL5.size
                  || ![...eiWordsL5].every(w => candWords.has(w))) continue;
              // 3. Word-boundary check on series name words. Escape regex metacharacters in the
              //    word — e.g. "vs." in "Avengers vs. X-Men" would otherwise create an invalid regex
              //    that throws SyntaxError mid-loop.
              const escWord = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const wordMatch = w => new RegExp(`(?<![a-z0-9])${escWord(w)}(?![a-z0-9])`).test(fn);
              if (words.every(wordMatch)) {
                book = { id: c.id };
                break;
              }
            }
          }
        }

        if(book){
          const evidence=db.prepare('SELECT sb.cv_issue_id,sb.comicinfo,ss.year AS syear FROM scanned_books sb JOIN scanned_series ss ON ss.id=sb.series_id WHERE sb.id=?').get(book.id);
          if(!eventYearMatches({volumeYear:ei.volume_year,cvIssueId:ei.cv_issue_id,book:evidence}))book=null;
        }
        if (book) {
          if (ei.scanned_book_id !== book.id) {
            matched += update.run(book.id, ei.id).changes;
          }
        }
      } catch (e) {
        // Per-issue try/catch — one bad issue shouldn't kill the whole reconciler.
        // Without this, a regex SyntaxError or undefined-variable bug halts matching
        // for every event in the system. The fetch hangs forever, the user sees no
        // matches, and the bug is invisible from outside. Logging here makes it
        // diagnosable on the next click.
        logger.error('events', `Reconciler error for event_issue ${ei.id}`,
          { series: ei.series_name, num: ei.issue_number, error: e.message });
        if (strict) throw e;
      }
    }

    if (matched > 0) logger.info('events', `Reconciled ${matched} event issues`);
  }
  return { reconcileEventIssues };
};
