// ─── libraryHealth.js ─────────────────────────────────────────────
// The Library page's attention list (claude/ADMIN_REORG.md, LIBRARY_HEALTH.md).
// "Needs you" rows count toward the Library button's badge; "for your
// information" rows (work Omnibus is still doing on its own) do not.
//
//   GET  /api/admin/library-health                      counts + badge
//   GET  /api/admin/library-health/duplicates           duplicate groups (checker v2)
//   POST /api/admin/library-health/duplicates/:cv/keep  keep one copy, move the rest to the holding folder
//   POST /api/admin/library-health/duplicates/:cv/keep-all   not duplicates, both tags right (hide the group)
//   POST /api/admin/library-health/duplicates/:cv/wrong      not duplicates, this copy's tag is wrong:
//                                                             identify it again (body: { bookId })
//   POST /api/admin/library-health/duplicates/keep-best          job: keep the recommended copy everywhere
//   GET  /api/admin/library-health/duplicates/job                progress of the running job
//
// Checker v2 (duplicateRules.js, 2026-10-16): of the books sharing a Comic Vine
// issue ID, a file whose own name says it is another comic is mistagged; it
// leaves the list and is identified again (sweepMistags → re-identify queue →
// Manual intervention when no match). The rest is a duplicate with a
// recommended copy and a plain reason, or needs a look (editions, subtitles).
// Removed copies go to the holding folder; reading progress and list links
// move to the kept copy.
'use strict';
const path = require('node:path');
const { parseComicInfoEvidence, parseIssueNumberEvidence, filenameEvidence } = require('./metadata/evidence');
const { titleKey } = require('./metadata/candidate');
const { IDLE } = require('./metadata/maintenancePolicy');
const { listNames } = require('./metadata/flattenUnsafeFolders');
const { pageResolution } = require('./metadata/pageResolution');
const rules = require('./duplicateRules');
const PAGE = /\.(jpe?g|png|gif|webp|bmp)$/i;

const fs = require('node:fs');

// ── File name vs tag ───────────────────────────────────────────────
const STOP = new Set(['the', 'and', 'of', 'vol', 'volume']);
const words = s => new Set(titleKey(s || '').split(' ').filter(w => w.length > 2 && !STOP.has(w)));
const num = v => (v == null ? null : parseIssueNumberEvidence(v).normalized);
const tag = (xml, key) => { const f = parseComicInfoEvidence(xml).fields[key]; return f && f.length === 1 ? f[0] : null; };
function fileView(filename) {
  const candidates = filenameEvidence(filename).candidates;
  // Release-site tags outside brackets ("… (2017) GetComics.NFO") are not title.
  const base = String(filename || '').replace(/\.(cbz|cbr|zip|rar)$/i, '').replace(/\s*\bGetComics(?:\.[A-Z]+)?\b/ig, '')
    .replace(/\s*\([^)]*\)|\s*\[[^\]]*\]/g, '').trim();
  const m = /^(.*?)\s+#?\d[\d.]*\w*\s*$/.exec(base);
  const title = (m ? m[1] : base).replace(/\bannual\b/ig, '').replace(/\b(19|20)\d{2}\b/g, '').trim();
  const namedYear = (/\b((?:19|20)\d{2})\s+annual\b/i.exec(base) || [])[1] || null;   // "Batman 2022 Annual"
  return { number: candidates.length === 1 ? candidates[0].normalized : null, annual: /\bannual\b/i.test(filename || ''), title, namedYear };
}
// The Comic Vine page the stored ID points to, from the ComicInfo <Web> link
// ("…/green-lantern-13-revenge-of-…/4000-113255/"): title and number. Catches
// files whose ComicInfo text is right but whose ID is another issue
// ("Tales of the Sinestro Corps – Ion" pointing at Green Lantern #13).
function webTarget(book) {
  const m = /comicvine\.gamespot\.com\/([a-z0-9-]+)\/4000-(\d+)/i.exec(tag(book.comicinfo, 'web') || '');
  if (!m || m[1] === 'issue' || String(m[2]) !== String(book.cv_issue_id)) return null;
  // "batman-2021-annual-1-…": 2021 belongs to the volume name ("Batman 2021
  // Annual"), 1 is the issue. A four-digit year followed by another number is
  // part of the title.
  const parts = m[1].split('-');
  const numeric = parts.map((p, i) => /^\d+[a-z]*$/i.test(p) ? i : -1).filter(i => i >= 1);
  if (!numeric.length) return null;
  let i = numeric[0];
  if (/^(19|20)\d{2}$/.test(parts[i]) && numeric.length > 1) i = numeric[1];
  const title = parts.slice(0, i).join(' ');
  return { title, number: num(parts[i]), numbers: numeric.map(k => num(parts[k])), namedYear: (/\b((?:19|20)\d{2})\s+annual\b/i.exec(title) || [])[1] || null };
}
// Year evidence (sample of 80 groups, 2026-10-16): "Avengers 012 (2011)" tagged
// as Avengers (2012) #12 of 2013, and "The Shadow 2012-2014/The Shadow 002"
// tagged with a 2015 issue, are different comics with the same number.
// - the file's own (year) must be within a year of the tagged issue's year, or
//   be its volume's start year ("Doctor Strange 051 (1974)" for the 1974 run);
// - a folder year range ("2012-2014") must contain the tagged year (a year early
//   is allowed); a single folder year is only a lower bound (series start).
function yearProblem(book) {
  const tagYear = Number(tag(book.comicinfo, 'year')) || null;
  if (!tagYear) return null;
  const volumeYear = Number(tag(book.comicinfo, 'volume')) || null;
  const folder = path.basename(path.dirname(book.path || ''));
  const range = /\b((?:19|20)\d{2})\s*-\s*((?:19|20)\d{2})\b/.exec(folder);
  const start = range ? Number(range[1]) : Number((/\b((?:19|20)\d{2})\b/.exec(folder) || [])[1]) || null;
  const fileYear = Number((/\(((?:19|20)\d{2})\)/.exec(String(book.filename || '')) || [])[1]) || null;   // the first "(YYYY)" 
  if (fileYear && Math.abs(fileYear - tagYear) > 1 && fileYear !== volumeYear && fileYear !== start)
    return `File is from ${fileYear}; the tagged issue is from ${tagYear}`;
  if (range && (tagYear < Number(range[1]) - 1 || tagYear > Number(range[2])))
    return `Folder covers ${range[1]}–${range[2]}; the tagged issue is from ${tagYear}`;
  if (!range && start && tagYear < start - 1) return `Folder starts in ${start}; the tagged issue is from ${tagYear}`;
  return null;
}
// Editions that share an issue ID but are not the same read (director's cut,
// new material only, a special or incomplete copy): a person decides.
const EDITION = /director'?s cut|new material|special edition|incomplete|preview|sketch|2nd printing|second printing|ashcan/i;

// { status: 'ok' | 'mismatch' | 'unknown', reason }
function judge(book) {
  const f = fileView(book.filename);
  const web = webTarget(book);
  if (web) {
    const label = `${web.title.replace(/\b\w/g, c => c.toUpperCase())} #${web.number}`;
    const ww = words(web.title.replace(/\bannual\b/ig, '')), fw0 = words(f.title);
    if (f.annual !== /\bannual\b/i.test(web.title)) return { status: 'mismatch', reason: `File is ${f.annual ? '' : 'not '}an annual; its Comic Vine ID is ${label}` };
    if (f.namedYear && web.namedYear && f.namedYear !== web.namedYear) return { status: 'mismatch', reason: `File is the ${f.namedYear} Annual; its Comic Vine ID is ${label}` };
    // Titles can hold numbers ("Season 11", "Earth 2"): any number in the link may be the issue.
    if (f.number && web.number && !web.numbers.includes(f.number)) return { status: 'mismatch', reason: `File says #${f.number}; its Comic Vine ID is ${label}` };
    // Different title: no word in common, or three or more extra words in the
    // file's title ("Catwoman 80th Anniversary 100-Page Super Spectacular" is
    // not Catwoman #1; "Star Wars Poe Dameron" is still Poe Dameron).
    const extra = [...fw0].filter(w => !ww.has(w)).length;
    // Comic Vine link names run words together ("legion-of-super-heroesbugs-
    // bunny-special" for "Legion of Super Heroes/Bugs Bunny Special"): the same
    // letters in the same order count as the same title.
    const compact = t => titleKey(t || '').replace(/[^a-z0-9]/g, '');
    const a = compact(f.title), b = compact(web.title);
    const sameLetters = a && b && (a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) / Math.max(a.length, b.length) >= 0.75;
    if (!sameLetters && fw0.size && ww.size && (![...fw0].some(w => ww.has(w)) || extra >= 3)) return { status: 'mismatch', reason: `File is titled "${f.title}"; its Comic Vine ID is ${label}` };
    // The ID is what makes the duplicate; ComicInfo text from an older tool
    // ("Batman" #1 for Batman 2021 Annual #1) is not compared when it is known.
    return f.number && web.number ? { status: 'ok', reason: null } : { status: 'unknown', reason: 'File name has no issue number to compare' };
  }
  const series = tag(book.comicinfo, 'series') || '', tagNumber = num(tag(book.comicinfo, 'number'));
  const tagAnnual = /\bannual\b/i.test(series);
  const label = `${series || 'unknown'}${tagNumber ? ' #' + tagNumber : ''}`;
  if (f.annual && !tagAnnual) return { status: 'mismatch', reason: `File is an annual; tagged as ${label}` };
  if (!f.annual && tagAnnual) return { status: 'mismatch', reason: `File is not an annual; tagged as ${label}` };
  if (f.number && tagNumber && f.number !== tagNumber) return { status: 'mismatch', reason: `File says #${f.number}; tagged as ${label}` };
  const fw = words(f.title), tw = words(series.replace(/\bannual\b/ig, ''));
  const overlap = [...fw].filter(w => tw.has(w)).length;
  if (fw.size && tw.size && overlap < Math.min(2, fw.size, tw.size) && overlap !== fw.size)
    return { status: 'mismatch', reason: `File is titled "${f.title}"; tagged as ${label}` };
  return f.number && tagNumber ? { status: 'ok', reason: null } : { status: 'unknown', reason: 'File name has no issue number to compare' };
}
// A copy's own year: its "(YYYY)" in the name, else its folder's range or
// start year. Copies whose own years cannot be the same issue (2011 vs 2013;
// folder 2012–2014 vs 2015) point to a mistag. The ComicInfo year alone is not
// trusted: other taggers write the digital release year ("Doctor Strange 065
// (1984)" with Year 2022).
function ownYears(book) {
  const fileYear = Number((/\(((?:19|20)\d{2})\)/.exec(String(book.filename || '')) || [])[1]) || null;
  if (fileYear) return { lo: fileYear, hi: fileYear, exact: true };
  const folder = path.basename(path.dirname(book.path || ''));
  const range = /\b((?:19|20)\d{2})\s*-\s*((?:19|20)\d{2})\b/.exec(folder);
  if (range) return { lo: Number(range[1]), hi: Number(range[2]) };
  const start = Number((/\b((?:19|20)\d{2})\b/.exec(folder) || [])[1]) || null;
  return start ? { lo: start, hi: Infinity } : null;
}
function yearsConflict(books) {
  const spans = books.map(ownYears).filter(Boolean);
  for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) {
    const a = spans[i], b = spans[j], slack = a.exact && b.exact ? 1 : 0;
    if (a.lo > b.hi + slack || b.lo > a.hi + slack) return true;
  }
  return false;
}
function groupKind(books) {
  if (books.some(b => b.check.status === 'mismatch')) return 'mistag';
  if (books.some(b => EDITION.test(b.filename))) return 'unsure';
  return books.every(b => b.check.status === 'ok') ? 'duplicate' : 'unsure';
}
// Keep: reading progress first, then the sharper pages (b.resolution, median
// pixels per page, measured when the cleanup runs; more than 5% apart), then
// the copy whose folder matches the tagged series, then the larger file.
// File names and sizes do not say which release is better (user, 2026-10-16).
function chooseKeep(books) {
  const folderMatch = b => { const fw = words(path.basename(path.dirname(b.path)).replace(/\(.*\)/g, '')), tw = words(tag(b.comicinfo, 'series'));
    return [...tw].filter(w => fw.has(w)).length; };
  const sharper = (a, b) => {
    if (!a.resolution || !b.resolution) return 0;
    const ratio = b.resolution / a.resolution;
    return ratio > 1.05 ? 1 : ratio < 1 / 1.05 ? -1 : 0;
  };
  // A copy filed under its own series ("Uncanny Avengers (2012)", not
  // "Uncanny X-Force (2013)") beats a slightly larger one elsewhere.
  return [...books].sort((a, b) => (b.has_progress - a.has_progress) || sharper(a, b) || (folderMatch(b) - folderMatch(a)) || ((b.file_size || 0) - (a.file_size || 0)))[0];
}

module.exports = function createLibraryHealth({ app, db, requireAdmin, logger, now = () => Date.now(), fileExists = p => fs.existsSync(p),
  retag = null, forgetBook = null, withWrite = fn => fn(), holdingRoot = '/downloads/_Removed duplicates', sleep = ms => new Promise(r => setTimeout(r, ms)),
  // Pages in a CBZ from its central directory (names only); 0 = empty or unreadable.
  measure = file => pageResolution(file),
  countPages = async file => { if (!/\.cbz$/i.test(file)) return null; try { return (await listNames(file)).filter(e => !e.directory && PAGE.test(e.name) && !/__MACOSX/.test(e.name)).length; } catch { return 0; } },
  queueDelayMs = 120000 }) {
  db.exec(`CREATE TABLE IF NOT EXISTS library_health_dismissed (
    kind TEXT NOT NULL, key TEXT NOT NULL, dismissed_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (kind, key))`);
  // Books waiting to be identified again from filename and folder. Filled by
  // hand while the app is offline (manual duplicate pass, 2026-10-16); worked
  // off by the retag job shortly after startup, one row removed per book done.
  db.exec(`CREATE TABLE IF NOT EXISTS library_health_reidentify (
    book_id TEXT PRIMARY KEY, note TEXT, added_at TEXT DEFAULT (datetime('now')))`);
  const has = table => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const count = (sql, ...args) => { try { return db.prepare(sql).get(...args)?.n || 0; } catch { return 0; } };

  const DAMAGED = "j.last_error LIKE '%Damaged archive%'";
  const UNSAFE = "(j.last_error LIKE '%Unsafe archive member path%' OR j.last_error LIKE '%Ambiguous archive member path%')";
  const STUCK = "j.state IN ('review','waiting') AND j.checked_at IS NOT NULL";
  const DUP_GROUPS = `SELECT cv_issue_id FROM scanned_books
    WHERE cv_issue_id IS NOT NULL AND cv_issue_id <> ''
      AND cv_issue_id NOT IN (SELECT key FROM library_health_dismissed WHERE kind = 'duplicate')
    GROUP BY cv_issue_id HAVING COUNT(*) > 1`;

  // Counted exactly as Downloads › Queue lists them: failed issues of monitored
  // series, and failed packs whose file is still on disk (a pack without its
  // file has nothing to retry). A count the queue doesn't show is a dead end.
  function failedDownloads() {
    const issues = count(`SELECT COUNT(*) n FROM monitored_issues i JOIN monitored_series s ON s.id = i.series_id WHERE i.status = 'failed'`);
    let packs = 0;
    try {
      packs = db.prepare(`SELECT p.file_path FROM series_packs p JOIN monitored_series s ON s.id = p.series_id
        WHERE p.status = 'failed' AND p.file_path IS NOT NULL`).all().filter(r => fileExists(r.file_path)).length;
    } catch {}
    return issues + packs;
  }

  function summary() {
    const jobs = has('metadata_jobs');
    const needsYou = {
      stuck: jobs ? count(`SELECT COUNT(*) n FROM metadata_jobs j JOIN scanned_books b ON b.id = j.book_id
        WHERE ${STUCK} AND NOT ${DAMAGED} AND NOT ${UNSAFE}`) : 0,
      damaged: jobs ? count(`SELECT COUNT(*) n FROM metadata_jobs j JOIN scanned_books b ON b.id = j.book_id WHERE ${STUCK} AND ${DAMAGED}`) : 0,
      unsafe: jobs ? count(`SELECT COUNT(*) n FROM metadata_jobs j JOIN scanned_books b ON b.id = j.book_id WHERE ${STUCK} AND ${UNSAFE}`) : 0,
      duplicates: (() => { try { return duplicates().filter(g => g.kind === 'duplicate' || g.kind === 'look').length; } catch { return 0; } })(),
      failedDownloads: failedDownloads(),
      // Downloads held for a decision (damaged file, identity review), not the
      // Comic Vine hourly wait or recovery holds, which clear on their own.
      heldDownloads: count(`SELECT COUNT(*) n FROM monitored_issues WHERE status = 'downloaded'
        AND (last_fail_reason LIKE 'ARCHIVE_DAMAGED:%' OR last_fail_reason GLOB '[A-Z]*_[A-Z]*: *')`),
      requests: has('download_requests') ? count("SELECT COUNT(*) n FROM download_requests WHERE status = 'open'") : 0,
    };
    const retryAt = has('metadata_worker_state') ? (db.prepare('SELECT provider_retry_at FROM metadata_worker_state WHERE id = 1').get()?.provider_retry_at || 0) : 0;
    const info = {
      noCvId: count("SELECT COUNT(*) n FROM scanned_books WHERE cv_issue_id IS NULL OR cv_issue_id = ''"),
      seriesWithoutDetails: count("SELECT COUNT(*) n FROM scanned_series WHERE metadata_status = 'none'"),
      comicVinePausedUntil: retryAt > now() ? retryAt : null,
    };
    return { needsYou, info, badge: Object.values(needsYou).reduce((a, b) => a + b, 0) };
  }

  // Duplicate checker v2 (duplicateRules.js): books sharing a Comic Vine issue
  // ID. Files whose own name says they are another comic are "mistagged": they
  // leave the checker and are identified again (sweepMistags); what remains is
  // a duplicate (with a recommended copy) or needs a look.
  function duplicates() {
    const ids = db.prepare(DUP_GROUPS).all().map(r => r.cv_issue_id);
    const books = db.prepare(`SELECT b.id, b.path, b.filename, b.series_id, b.file_size, b.file_mtime, b.comicinfo, b.cv_issue_id,
        (b.comicinfo IS NOT NULL AND b.comicinfo <> '') AS tagged, s.name AS series_name, s.series_json,
        EXISTS (SELECT 1 FROM read_progress r WHERE r.book_id = b.id) AS has_progress
      FROM scanned_books b LEFT JOIN scanned_series s ON s.id = b.series_id
      WHERE b.cv_issue_id = ? ORDER BY b.path`);
    const confirmed = new Set(db.prepare("SELECT key FROM library_health_dismissed WHERE kind = 'mistag-confirmed'").all().map(r => r.key));
    const queued = new Set(db.prepare('SELECT book_id FROM library_health_reidentify').all().map(r => r.book_id));
    const jsonName = j => { try { return JSON.parse(j || 'null')?.metadata?.name || null; } catch { return null; } };
    return ids.map(cv => {
      const all = books.all(cv);
      // Copies waiting in the re-identify queue (marked as the wrong match, 2026-10-26, or
      // swept as mistags) are not listed with the group; when no two copies are left the
      // group is not listed at all. If identification keeps the same match, the copy
      // comes back for a decision.
      const waiting = all.filter(b => queued.has(b.id));
      const waitingOut = waiting.map(b => ({ id: b.id, path: b.path, filename: b.filename, cv_issue_id: b.cv_issue_id, check: { status: 'mismatch', reason: 'waiting to be identified again' } }));
      if (waiting.length && all.length - waiting.length < 2) {
        const t0 = rules.tagged(all[0]) || {};
        return { cvIssueId: cv, kind: 'reidentifying', reason: null, title: (tag(all[0]?.comicinfo, 'series') || t0.title || all[0]?.filename) + (t0.number ? ` #${t0.number}` : ''),
          keepId: null, suggestId: null, keepReason: null, books: [], mistagged: waitingOut };
      }
      const list = all.filter(b => !queued.has(b.id)).map(({ series_json, ...b }) => {
        const out = { ...b, tagged: !!b.tagged, has_progress: !!b.has_progress, folder_series_name: jsonName(series_json), confirmed: confirmed.has(b.id) };
        if (out.confirmed) { const c = rules.checkBook(out); out.check = { ...c, status: c.status === 'mismatch' ? 'same' : c.status, reason: c.status === 'mismatch' ? null : c.reason }; }
        return out;
      });
      const v = rules.classify(list);
      const t = rules.tagged(list[0]) || {};
      const year = tag(list[0]?.comicinfo, 'year');
      return { cvIssueId: cv, kind: v.kind, reason: v.reason || null, title: (tag(list[0]?.comicinfo, 'series') || t.title || list[0]?.filename) + (t.number ? ` #${t.number}` : '') + (year ? ` (${year})` : ''),
        keepId: v.keepId, suggestId: v.suggestId, keepReason: v.keepReason,
        books: v.books.map(b => ({ ...b, ownFolder: rules.folderFit(b) === 2, pages: Number(tag(b.comicinfo, 'pagecount')) || null })),
        mistagged: [...v.mistagged.map(b => ({ id: b.id, path: b.path, filename: b.filename, cv_issue_id: b.cv_issue_id, check: b.check })), ...waitingOut] };
    }).sort((a, b) => (a.books[0]?.path || a.mistagged[0]?.path || '').localeCompare(b.books[0]?.path || b.mistagged[0]?.path || ''));
  }
  // Mistagged files go to the re-identify queue once per Comic Vine ID; those
  // that still cannot be matched land in Manual intervention ("Possible mistag").
  function sweepMistags() {
    const tried = db.prepare("SELECT 1 FROM library_health_dismissed WHERE kind = 'mistag-tried' AND key = ?");
    const mark = db.prepare("INSERT OR IGNORE INTO library_health_dismissed (kind, key) VALUES ('mistag-tried', ?)");
    const queue = db.prepare('INSERT OR IGNORE INTO library_health_reidentify (book_id, note) VALUES (?, ?)');
    // Already tried and waiting for the admin in Manual intervention.
    const waiting = has('metadata_jobs') ? db.prepare("SELECT 1 FROM metadata_jobs WHERE book_id = ? AND state = 'review' AND last_error LIKE 'Possible mistag:%'") : null;
    let added = 0;
    for (const g of duplicates()) for (const b of g.mistagged) {
      const key = `${b.id}:${b.cv_issue_id}`;
      if (tried.get(key)) continue;
      if (waiting?.get(b.id)) { mark.run(key); continue; }
      queue.run(b.id, String(b.check?.reason || 'name and tag disagree').slice(0, 300)); mark.run(key); added++;
    }
    if (added) logger?.info?.('library-health', 'Mistagged files queued for re-identification', { files: added });
    return added;
  }
  function pendingMistags() {
    return count('SELECT COUNT(*) n FROM library_health_reidentify');
  }
  // Removing a copy: its reading progress moves to the kept copy (when that
  // has none), and list, event and Top Shelf entries point at the kept copy.
  function carryOver(fromId, toId) {
    const keepPath = db.prepare('SELECT path FROM scanned_books WHERE id = ?').get(toId)?.path;
    const fromPath = db.prepare('SELECT path FROM scanned_books WHERE id = ?').get(fromId)?.path;
    try {
      const users = db.prepare('SELECT user_id FROM read_progress WHERE book_id = ?').all(fromId);
      for (const { user_id } of users) if (!db.prepare('SELECT 1 FROM read_progress WHERE book_id = ? AND user_id IS ?').get(toId, user_id))
        db.prepare('INSERT INTO read_progress (book_id, user_id, page, completed, updated_at, marked) SELECT ?, user_id, page, completed, updated_at, marked FROM read_progress WHERE book_id = ? AND user_id IS ?').run(toId, fromId, user_id);
    } catch (e) { logger?.warn?.('library-health', 'Reading progress not carried over', e.message); }
    for (const t of ['event_issues', 'canon_run_issues', 'list_issues']) if (has(t)) db.prepare(`UPDATE ${t} SET scanned_book_id = ? WHERE scanned_book_id = ?`).run(toId, fromId);
    if (keepPath && fromPath && has('monitored_issues')) db.prepare('UPDATE monitored_issues SET file_path = ? WHERE file_path = ?').run(keepPath, fromPath);
  }
  async function removeCopy(bookId, keepId, why) {
    await withWrite(async () => {
      const live = db.prepare('SELECT path FROM scanned_books WHERE id = ?').get(bookId);
      if (!live) return;
      if (fileExists(live.path)) moveFile(live.path, holdingPath(live.path));
      if (keepId) carryOver(bookId, keepId);
      forgetBook(bookId, why);
    });
  }
  const publicGroup = g => ({ ...g, books: g.books.map(({ comicinfo, check, ...b }) => ({ ...b, check: { status: check.status, reason: check.reason, partial: check.partial, edition: check.edition } })) });

  // ── Bulk jobs (one at a time, in memory) ────────────────────────
  let job = null;
  const busy = () => job && job.running;
  function markReview(bookId, message) {
    db.prepare(`INSERT INTO metadata_jobs (book_id, arrival, state, due_at, last_error, checked_at) VALUES (?, 'scanner', 'review', ?, ?, ?)
      ON CONFLICT(book_id) DO UPDATE SET state = 'review', due_at = excluded.due_at, last_error = excluded.last_error, checked_at = excluded.checked_at`)
      .run(bookId, IDLE, String(message).slice(0, 900), now());
  }
  async function retagMismatched() {
    const targets = duplicates().flatMap(g => g.mistagged);
    return runRetag(targets, { label: 'mismatched files' });
  }
  // Identify every book in one series folder again from filename and folder,
  // ignoring the stored tags (Earth 2 - Society: 21 files all tagged #2 after
  // the folder's series.json named the annual; 2026-10-16).
  function seriesBooks(seriesId) {
    return db.prepare('SELECT id, filename, path, cv_issue_id FROM scanned_books WHERE series_id = ? ORDER BY sort_order, filename').all(seriesId);
  }
  async function reidentifySeries(seriesId, seriesName) {
    const targets = seriesBooks(seriesId).map(b => ({ ...b, check: { reason: 'series re-identified' } }));
    // Earlier verdicts for these books no longer apply.
    const del = db.prepare("DELETE FROM library_health_dismissed WHERE kind = 'mistag-confirmed' AND key = ?");
    for (const b of targets) del.run(b.id);
    return runRetag(targets, { label: seriesName || 'series', series: seriesName || seriesId });
  }
  async function runQueued() {
    if (!retag || busy()) return null;
    const rows = db.prepare('SELECT book_id, note FROM library_health_reidentify ORDER BY added_at, book_id').all();
    const book = db.prepare('SELECT id, filename, path, cv_issue_id FROM scanned_books WHERE id = ?');
    const gone = db.prepare('DELETE FROM library_health_reidentify WHERE book_id = ?');
    const targets = [];
    for (const r of rows) { const b = book.get(r.book_id); if (b) targets.push({ ...b, check: { reason: r.note || 'queued for re-identification' } }); else gone.run(r.book_id); }
    if (!targets.length) return null;
    const del = db.prepare("DELETE FROM library_health_dismissed WHERE kind = 'mistag-confirmed' AND key = ?");
    for (const b of targets) del.run(b.id);
    return runRetag(targets, { label: 'queued files', onEach: b => gone.run(b.id) });
  }
  if (retag && queueDelayMs != null) {
    const tick = () => { try { if (!busy()) sweepMistags(); } catch (e) { logger?.warn?.('library-health', 'Mistag sweep failed', e.message); }
      runQueued().catch(e => { logger?.error?.('library-health', 'Queued re-identification failed', e.message); if (job) Object.assign(job, { running: false, error: e.message }); }); };
    const t = setTimeout(tick, queueDelayMs); t.unref?.();
    const every = setInterval(tick, 30 * 60 * 1000); every.unref?.();
  }
  async function runRetag(targets, { label, series = null, onEach = null }) {
    job = { kind: 'retag', series, running: true, total: targets.length, done: 0, fixed: 0, confirmed: 0, needHelp: 0, failed: 0, errors: [], current: null, waitingUntil: null, startedAt: now() };
    logger?.info?.('library-health', 'Retagging ' + label, { files: targets.length });
    for (const b of targets) {
      if (job.stop) break;
      job.current = b.filename;
      for (;;) {
        try {
          const r = await retag({ bookId: b.id, rediscover: true });
          if (String(r?.cvIssueId) === String(b.cv_issue_id)) {
            job.confirmed++;   // the tag was right after all: stop flagging it
            db.prepare("INSERT OR IGNORE INTO library_health_dismissed (kind, key) VALUES ('mistag-confirmed', ?)").run(b.id);
          } else job.fixed++;
          break;
        } catch (e) {
          if (e.code === 'CV_RATE_LIMIT' && e.retryAt) {   // wait for the Comic Vine hour to reset
            const until = new Date(e.retryAt).getTime() || now() + 600000;
            job.waitingUntil = until; await sleep(Math.max(5000, until - now())); job.waitingUntil = null;
            continue;
          }
          if (e.code === 'DEPLOYMENT_PAUSED') { job.stop = true; job.errors.push({ file: b.filename, error: 'Stopped for a deployment; run again afterwards' }); break; }
          if (e.code === 'IDENTITY_REVIEW_REQUIRED') {
            job.needHelp++;
            try { markReview(b.id, `Possible mistag: ${b.check.reason}. ${e.message}`); } catch {}
          } else { job.failed++; if (job.errors.length < 50) job.errors.push({ file: b.filename, error: e.message }); }
          break;
        }
      }
      if (onEach && !job.stop) { try { onEach(b); } catch {} }
      job.done++;
    }
    Object.assign(job, { running: false, current: null, finishedAt: now() });
    logger?.info?.('library-health', 'Retag of ' + label + ' finished', { fixed: job.fixed, confirmed: job.confirmed, needHelp: job.needHelp, failed: job.failed });
  }
  function holdingPath(file) {
    const roots = db.prepare('SELECT path FROM libraries').all().map(r => r.path);
    const root = roots.find(r => file === r || file.startsWith(r.replace(/\/+$/, '') + '/'));
    const rel = root ? path.relative(root, file) : path.basename(file);
    let target = path.join(holdingRoot, rel);
    for (let i = 2; fileExists(target); i++) target = path.join(holdingRoot, path.dirname(rel), `${path.basename(rel, path.extname(rel))} (${i})${path.extname(rel)}`);
    return target;
  }
  function moveFile(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try { fs.renameSync(from, to); }
    catch (e) { if (e.code !== 'EXDEV') throw e; fs.copyFileSync(from, to); fs.unlinkSync(from); }   // across drives
  }
  async function keepBest() {
    const groups = duplicates().filter(g => g.kind === 'duplicate');
    job = { kind: 'keep', running: true, total: groups.length, done: 0, moved: 0, failed: 0, errors: [], current: null, holding: holdingRoot, startedAt: now() };
    logger?.info?.('library-health', 'Keeping one copy per duplicate group', { groups: groups.length, holding: holdingRoot });
    for (const g of groups) {
      if (job.stop) break;
      job.current = g.books[0]?.filename;
      // Checked at the time of the move (sample of 40 groups, 2026-10-16): rows
      // whose file is gone are only forgotten, and the kept copy must exist and
      // have pages (a 0-page "Justice League Annual Annual 001" was in the list).
      const usable = [];
      for (const b of g.books) {
        const pages = fileExists(b.path) ? await countPages(b.path) : -1;
        b.state = pages === -1 ? 'missing' : pages === 0 ? 'broken' : 'ok';
        if (b.state === 'ok') usable.push(b);
      }
      if (!usable.length) { job.failed++; if (job.errors.length < 50) job.errors.push({ file: g.books[0]?.filename, error: 'No readable copy; left as it is' }); job.done++; continue; }
      for (const b of usable) b.resolution = await measure(b.path).catch(() => null);
      const keepId = rules.recommend(usable).keepId;
      for (const b of g.books.filter(x => x.id !== keepId)) {
        try {
          await removeCopy(b.id, keepId, b.state === 'missing' ? 'file no longer on disk' : 'moved to the duplicates holding folder');
          if (b.state === 'missing') job.forgotten = (job.forgotten || 0) + 1; else job.moved++;
        } catch (e) { job.failed++; if (job.errors.length < 50) job.errors.push({ file: b.filename, error: e.message }); }
      }
      job.done++;
      await sleep(0);
    }
    Object.assign(job, { running: false, current: null, finishedAt: now() });
    logger?.info?.('library-health', 'Duplicate cleanup finished', { moved: job.moved, failed: job.failed });
  }

  app.get('/api/admin/library-health', requireAdmin, (req, res) => {
    try { res.json(summary()); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/admin/library-health/duplicates', requireAdmin, (req, res) => {
    try {
      const all = duplicates();
      const groups = all.filter(g => g.kind === 'duplicate' || g.kind === 'look');
      const counts = { duplicate: groups.filter(g => g.kind === 'duplicate').length, look: groups.filter(g => g.kind === 'look').length };
      const mistagged = all.reduce((n, g) => n + g.mistagged.length, 0);
      res.json({ groups: groups.map(publicGroup), counts, mistagged, reidentifying: pendingMistags(), job });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/admin/library-health/duplicates/job', requireAdmin, (req, res) => res.json({ job }));
  // "Keep current match": the admin confirms a book flagged as a possible
  // mistag is tagged correctly (Batman Beyond #0 filed as DC Sneak Peek: Batman
  // Beyond #1 on purpose, 2026-10-16). It stops being flagged and leaves
  // Manual intervention with no further automatic checks.
  app.post('/api/admin/library-health/books/:id/keep-match', requireAdmin, (req, res) => {
    try {
      const book = db.prepare('SELECT id, cv_issue_id FROM scanned_books WHERE id = ?').get(req.params.id);
      if (!book) return res.status(404).json({ error: 'Book not found' });
      if (!book.cv_issue_id) return res.status(409).json({ error: 'This book has no Comic Vine match to keep; choose one instead' });
      db.prepare("INSERT OR IGNORE INTO library_health_dismissed (kind, key) VALUES ('mistag-confirmed', ?)").run(book.id);
      if (has('metadata_jobs')) db.prepare("UPDATE metadata_jobs SET state = 'queued', due_at = ?, last_error = NULL WHERE book_id = ?").run(IDLE, book.id);
      logger?.info?.('library-health', 'Current match kept', { bookId: book.id, cvIssueId: book.cv_issue_id, by: req.user?.username });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/admin/library-health/duplicates/retag-mismatched', requireAdmin, (req, res) => {
    if (busy()) return res.status(409).json({ error: 'A cleanup job is already running', job });
    if (!retag) return res.status(503).json({ error: 'Retagging is unavailable' });
    retagMismatched().catch(e => { logger?.error?.('library-health', 'Retag job failed', e.message); if (job) Object.assign(job, { running: false, error: e.message }); });
    res.status(202).json({ job });
  });
  // Identify every book in a series folder again (series page, admin menu).
  app.post('/api/admin/library-health/series/:id/reidentify', requireAdmin, (req, res) => {
    if (busy()) return res.status(409).json({ error: 'A cleanup job is already running', job });
    if (!retag) return res.status(503).json({ error: 'Retagging is unavailable' });
    const series = db.prepare('SELECT id, name FROM scanned_series WHERE id = ?').get(req.params.id);
    if (!series) return res.status(404).json({ error: 'Series not found' });
    if (!seriesBooks(series.id).length) return res.status(409).json({ error: 'This series has no files' });
    logger?.info?.('library-health', 'Series re-identification started', { seriesId: series.id, name: series.name, by: req.user?.username });
    reidentifySeries(series.id, series.name).catch(e => { logger?.error?.('library-health', 'Series re-identification failed', e.message); if (job) Object.assign(job, { running: false, error: e.message }); });
    res.status(202).json({ job });
  });
  app.post('/api/admin/library-health/duplicates/keep-best', requireAdmin, (req, res) => {
    if (busy()) return res.status(409).json({ error: 'A cleanup job is already running', job });
    if (!forgetBook) return res.status(503).json({ error: 'Cleanup is unavailable' });
    keepBest().catch(e => { logger?.error?.('library-health', 'Keep-best job failed', e.message); if (job) Object.assign(job, { running: false, error: e.message }); });
    res.status(202).json({ job });
  });
  // One group: keep the chosen copy, move the others to the holding folder.
  app.post('/api/admin/library-health/duplicates/:cv/keep', requireAdmin, async (req, res) => {
    if (busy()) return res.status(409).json({ error: 'A cleanup job is running; try again when it finishes' });
    if (!forgetBook) return res.status(503).json({ error: 'Cleanup is unavailable' });
    try {
      const g = duplicates().find(x => String(x.cvIssueId) === String(req.params.cv));
      if (!g) return res.status(404).json({ error: 'This group is no longer listed' });
      const keepId = req.body?.keepId || g.suggestId;
      if (!g.books.some(b => b.id === keepId)) return res.status(400).json({ error: 'Choose one of the listed copies to keep' });
      const kept = g.books.find(b => b.id === keepId);
      if (!fileExists(kept.path)) return res.status(409).json({ error: 'The copy to keep is missing from disk' });
      let moved = 0;
      for (const b of g.books) if (b.id !== keepId) { await removeCopy(b.id, keepId, 'moved to the duplicates holding folder'); moved++; }
      logger?.info?.('library-health', 'Duplicate group resolved', { cvIssueId: g.cvIssueId, keep: kept.path, moved, by: req.user?.username });
      res.json({ ok: true, moved, holding: holdingRoot });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/admin/library-health/duplicates/job/stop', requireAdmin, (req, res) => { if (job) job.stop = true; res.json({ job }); });
  // "Not duplicates" with one copy tagged wrong (user 2026-10-26): before, the only
  // answer was keep-all, which hid the group and left the wrong tag in place
  // (Batman: Rebirth #1 tagged as Batman #1). This copy is identified again from its
  // file name and folder; one it cannot match goes to Manual intervention.
  app.post('/api/admin/library-health/duplicates/:cv/wrong', requireAdmin, (req, res) => {
    try {
      const cv = String(req.params.cv), bookId = String(req.body?.bookId || '');
      const book = db.prepare('SELECT id, filename, cv_issue_id FROM scanned_books WHERE id = ?').get(bookId);
      if (!book || String(book.cv_issue_id) !== cv) return res.status(400).json({ error: 'Choose one of the listed copies' });
      if (!retag) return res.status(503).json({ error: 'Identifying files is unavailable' });
      db.prepare("DELETE FROM library_health_dismissed WHERE kind = 'mistag-confirmed' AND key = ?").run(book.id);
      db.prepare("INSERT OR IGNORE INTO library_health_dismissed (kind, key) VALUES ('mistag-tried', ?)").run(`${book.id}:${cv}`);
      db.prepare('INSERT OR REPLACE INTO library_health_reidentify (book_id, note) VALUES (?, ?)').run(book.id, 'marked as the wrong match in Duplicates');
      const started = !busy();
      if (started) runQueued().catch(e => { logger?.error?.('library-health', 'Queued re-identification failed', e.message); if (job) Object.assign(job, { running: false, error: e.message }); });
      logger?.info?.('library-health', 'Duplicate copy marked as the wrong match; identifying it again', { cvIssueId: cv, bookId: book.id, file: book.filename, by: req.user?.username });
      res.json({ ok: true, started });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/admin/library-health/duplicates/:cv/keep-all', requireAdmin, (req, res) => {
    try {
      db.prepare("INSERT OR IGNORE INTO library_health_dismissed (kind, key) VALUES ('duplicate', ?)").run(String(req.params.cv));
      logger?.info?.('library-health', 'Duplicate group kept (not duplicates)', { cvIssueId: req.params.cv });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { summary, duplicates, judge, judgeFile: judge, yearProblem, yearsConflict, ownYears, chooseKeep, retagMismatched, reidentifySeries, runQueued, sweepMistags, keepBest, job: () => job };
};
