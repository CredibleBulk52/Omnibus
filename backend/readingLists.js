// ─── readingLists.js ──────────────────────────────────────────────
// Reading lists: ordered lists of issues, issue ranges, whole series,
// events (Timeline) and Top Shelf runs. Design: claude/READING_LISTS_AI_DESIGN.md.
//
//   issue / range / series  → issues stored in list_issues (owner_kind
//                              'reading_list_entry', owner_id = entry id)
//   event / canon_run       → linked: read live from event_issues /
//                              canon_run_issues, so admin edits flow through.
//                              "Unpack" copies them into list_issues.
//   unpacked = 1            → the entry is the user's own copy: no automatic
//                              refresh, issues can be removed and reordered.
//
// Whole-series and range entries list every issue (owned or not). Issue
// lists come from, in order: monitored_issues (no Comic Vine call), Comic
// Vine through cvApiGet, or the owned books only (status 'partial').
//
// Exposes routes under /api/reading-lists plus helpers server.js calls:
//   reconcile(scanChanged)  after library scans
//   refreshAll(trigger)     nightly, after the 04:45 series.json refresh
//   adjacent(listId, bookId, user)  reader prev/next
'use strict';

module.exports = function createReadingLists(deps) {
  const { app, db, requireAuth, cvApiGet, getCVKey, logger, IN } = deps;
  require('./homepageFields').ensure(db, ['reading_lists']);
  const boxArtwork = require('./boxArtwork').create(db);
  const collectionRegistry = require('./essentialCollections')(db);
  const runBackground = deps.runBackground || ((name, fn) => fn);
  const bookIndex = deps.bookIndex || null;   // ComicInfo index (bookIndex.js): real series names and original numbers
  const MAX_NAMED_ISSUES = 100;

  const OWNER_KIND   = 'reading_list_entry';
  const VISIBILITY   = new Set(['private', 'public', 'essential']);
  const ENTRY_TYPES  = new Set(['issue', 'range', 'series', 'event', 'canon_run', 'section', 'story']);
  const TIER_FILTERS = ['essential', 'recommended', 'all'];   // event entries; each widens the one before
  const MAX_ENTRIES  = 500;
  const CV_REFRESH_DAYS    = 7;    // Comic Vine-sourced entries: weekly
  const CV_VOLUMES_PER_RUN = 25;   // cap Comic Vine volumes per nightly run
  const VOL_CACHE_MS = 24 * 3600 * 1000;
  const yieldLoop = () => new Promise(r => setImmediate(r));

  // ── Small helpers ───────────────────────────────────────────────
  const uid     = req => req.user?.sub || null;
  const isAdmin = req => req.user?.role === 'admin';
  const normNum = n => (n == null || n === '') ? null : IN.normIssueNumber(n);
  const numKey  = n => { const c = normNum(n); const f = c == null ? NaN : parseFloat(c); return isNaN(f) ? Number.MAX_SAFE_INTEGER : f; };
  const toInt   = v => { const n = parseInt(v, 10); return isNaN(n) ? null : n; };
  const str     = (v, max = 2000) => (v == null ? null : (String(v).trim().slice(0, max) || null));
  const numStr  = n => (n == null ? null : String(n));
  const placeholders = arr => arr.map(() => '?').join(',');
  const ciYearSql = `CASE WHEN instr(sb.comicinfo, '<Year>') > 0
                      THEN CAST(substr(sb.comicinfo, instr(sb.comicinfo, '<Year>') + 6, 4) AS INTEGER) END`;

  function cmpIssues(a, b) {
    const an = a.is_annual ? 1 : 0, bn = b.is_annual ? 1 : 0;
    if (an !== bn) return an - bn;                       // annuals after the main numbering
    const d = numKey(a.issue_number) - numKey(b.issue_number);
    if (d) return d;
    const sa = String(normNum(a.issue_number) || a.issue_number || '');
    const sb = String(normNum(b.issue_number) || b.issue_number || '');
    if (sa !== sb) return sa < sb ? -1 : 1;
    return String(a.cover_date || '').localeCompare(String(b.cover_date || ''));
  }

  // Significant-word set, same rule the event reconciler uses
  // ("Wolverine & the X-Men" == "Wolverine and the X-Men"; "Avengers" != "New Avengers").
  const NOISE = new Set(['the', 'and', 'of', 'a', 'an']);
  const sigWords = name => new Set(String(name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(w => w && !NOISE.has(w)));
  const sameWords = (a, b) => a.size > 0 && a.size === b.size && [...a].every(w => b.has(w));

  // Issue-number check for ID-based matches: equal, or both plain numbers
  // within 1 (parsing artefacts). Suffixes ("8.AU") must be equal.
  function numbersAgree(bookNum, rowNum) {
    if (!bookNum || !rowNum) return true;
    const a = normNum(bookNum), b = normNum(rowNum);
    if (!a || !b || a === b) return true;
    if (a.includes('.') || b.includes('.')) return false;
    return Math.abs(parseFloat(a) - parseFloat(b)) <= 1;
  }

  function bad(status, message) { const e = new Error(message); e.status = status; return e; }

  // ── Access ──────────────────────────────────────────────────────
  // Private lists: owner only. Public/essential: every user can view.
  // Admin may edit any non-private list (moderation, Essentials).
  const getList  = id => db.prepare('SELECT * FROM reading_lists WHERE id = ?').get(toInt(id));
  const getEntry = (listId, entryId) => db.prepare('SELECT * FROM reading_list_entries WHERE id = ? AND list_id = ?').get(toInt(entryId), toInt(listId));
  const canView  = (list, user) => !!list && (list.owner_id === user?.sub || list.visibility !== 'private');
  const canEdit  = (list, user) => !!list && (list.owner_id === user?.sub || (user?.role === 'admin' && list.visibility !== 'private'));
  const touch    = listId => db.prepare(`UPDATE reading_lists SET updated_at = datetime('now') WHERE id = ?`).run(listId);
  const listEntries = listId => db.prepare('SELECT * FROM reading_list_entries WHERE list_id = ? ORDER BY sort_order, id').all(listId);

  function loadForView(req) {
    const list = getList(req.params.id);
    if (!list || !canView(list, req.user)) throw bad(404, 'Reading list not found');
    return list;
  }
  function loadForEdit(req) {
    const list = loadForView(req);
    if (!canEdit(list, req.user)) throw bad(403, 'You can only change your own reading lists');
    return list;
  }

  // ── Volume issue lists (series and range entries) ───────────────
  const volCache = new Map();   // cvVolumeId → { at, issues, name, year }

  function comicIdOf(ss) {
    if (!ss?.series_json) return null;
    try { const sj = JSON.parse(ss.series_json); const id = sj?.metadata?.comicid || sj?.comicid; return id ? String(id) : null; }
    catch { return null; }
  }
  function monitoredFor(ss, vid) {
    if (ss?.monitored_series_id) {
      const m = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(ss.monitored_series_id);
      if (m) return m;
    }
    if (!vid) return null;
    return db.prepare(`SELECT * FROM monitored_series WHERE cv_url LIKE ? OR cv_url LIKE ? LIMIT 1`)
      .get(`%4050-${vid}/%`, `%4050-${vid}`) || null;
  }

  async function fetchCvVolume(vid, needName) {
    const hit = volCache.get(vid);
    if (hit && Date.now() - hit.at < VOL_CACHE_MS && (!needName || hit.name)) return hit;
    if (!getCVKey()) throw new Error('No Comic Vine API key');
    const issues = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const r = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
        params: { api_key: getCVKey(), format: 'json', filter: `volume:${vid}`, field_list: 'id,issue_number,name,cover_date', limit: 100, offset },
        timeout: 20000,
      });
      if (r.data?.error && r.data.error !== 'OK') throw new Error(`Comic Vine: ${r.data.error}`);
      const page = r.data?.results || [];
      issues.push(...page);
      if (page.length < 100 || issues.length >= (r.data?.number_of_total_results || 0)) break;
    }
    let name = hit?.name || null, year = hit?.year || null;
    if (needName && !name) {
      const r = await cvApiGet(`https://comicvine.gamespot.com/api/volume/4050-${vid}/`, {
        params: { api_key: getCVKey(), format: 'json', field_list: 'name,start_year' }, timeout: 20000,
      });
      name = r.data?.results?.name || null;
      year = toInt(r.data?.results?.start_year);
    }
    const out = {
      at: Date.now(), name, year,
      issues: issues.map(i => ({
        cv_issue_id: String(i.id), issue_number: IN.normIssueNumber(i.issue_number) || String(i.issue_number || ''),
        issue_title: i.name || null, cover_date: i.cover_date || null, is_annual: 0,
      })),
    };
    volCache.set(vid, out);
    return out;
  }

  // → { source, partial, error, cvVolumeId, seriesName, volumeYear, issues[] }
  async function volumeIssues({ scannedSeriesId, cvVolumeId }) {
    const ss = scannedSeriesId ? db.prepare('SELECT * FROM scanned_series WHERE id = ?').get(scannedSeriesId) : null;
    const vid = cvVolumeId ? String(cvVolumeId) : comicIdOf(ss);
    const base = { cvVolumeId: vid, seriesName: ss?.name || null, volumeYear: ss?.year || null };

    // 1. Monitored series: the pollers keep monitored_issues current; no CV call.
    const mon = monitoredFor(ss, vid);
    if (mon) {
      const rows = db.prepare('SELECT id, issue_number, title, release_date, store_date, is_annual FROM monitored_issues WHERE series_id = ?').all(mon.id);
      if (rows.length) {
        return { ...base, source: 'monitored', partial: false, error: null,
          seriesName: base.seriesName || mon.name, volumeYear: base.volumeYear || mon.year,
          issues: rows.map(r => ({ cv_issue_id: String(r.id), issue_number: r.issue_number, issue_title: r.title || null,
            cover_date: r.release_date || r.store_date || null, is_annual: r.is_annual ? 1 : 0 })) };
      }
    }
    // 2. Comic Vine.
    let error = null;
    if (vid) {
      try {
        const v = await fetchCvVolume(vid, !base.seriesName);
        return { ...base, source: 'comicvine', partial: false, error: null,
          seriesName: base.seriesName || v.name, volumeYear: base.volumeYear || v.year, issues: v.issues };
      } catch (e) { error = e.message; }
    } else error = 'No Comic Vine ID for this series';
    // 3. Owned books only.
    if (ss) {
      const books = db.prepare('SELECT id, issue_number, title, cv_issue_id FROM scanned_books WHERE series_id = ?').all(ss.id);
      return { ...base, source: 'library', partial: true, error,
        issues: books.map(b => ({ cv_issue_id: b.cv_issue_id || null, issue_number: b.issue_number, issue_title: b.title || null,
          cover_date: null, is_annual: 0, book_id: b.id })) };
    }
    throw new Error(error || 'Series not found');
  }

  function inRange(n, start, end) {
    const k = numKey(n);
    if (k === Number.MAX_SAFE_INTEGER) return false;
    if (start && k < numKey(start)) return false;
    if (end && k > numKey(end)) return false;
    return true;
  }

  function defaultLabel(type, { seriesName, year, start, end, number }) {
    const s = seriesName || 'Unknown series';
    const y = year ? ` (${year})` : '';
    if (type === 'issue')  return `${s}${y} #${number ?? '?'}`;
    if (type === 'series') return `${s}${y}`;
    if (type === 'range')  return `${s}${y} ${start ? '#' + start : 'start'}–${end ? '#' + end : 'latest'}`;
    return s;
  }

  // ── Resolve a series/range entry into list_issues ───────────────
  // Rebuilds the rows in issue order, keeping existing matches (by CV id,
  // else by issue number) so a refresh never loses a manual match.
  const resolving = new Set();
  async function resolveEntry(entryId) {
    if (resolving.has(entryId)) return { skipped: 'already resolving' };
    resolving.add(entryId);
    try {
      const e = db.prepare('SELECT * FROM reading_list_entries WHERE id = ?').get(entryId);
      if (!e || e.unpacked || !(e.entry_type === 'series' || e.entry_type === 'range')) return { skipped: 'not refreshable' };
      let vi;
      try { vi = await volumeIssues({ scannedSeriesId: e.scanned_series_id, cvVolumeId: e.cv_volume_id }); }
      catch (err) {
        db.prepare(`UPDATE reading_list_entries SET resolve_status = 'error', resolved_at = datetime('now') WHERE id = ?`).run(entryId);
        logger.warn('reading-lists', 'Entry could not be resolved', { entryId, error: err.message });
        return { error: err.message };
      }
      let issues = vi.issues.slice();
      // Owned books in the entry's folder that the volume list lacks. Comic Vine
      // can split one printed run into volumes: Action Comics #601-642 are its
      // "Action Comics Weekly" volume, so the folder's Action Comics (1938)
      // volume has no #601 and the range came back empty.
      if (vi.source !== 'library' && e.scanned_series_id) {
        const have = new Set(issues.filter(i => !i.is_annual).map(i => normNum(i.issue_number)));
        for (const b of db.prepare('SELECT id, issue_number, title, cv_issue_id, filename, is_special FROM scanned_books WHERE series_id = ?').all(e.scanned_series_id)) {
          const n = normNum(b.issue_number);
          if (!n || have.has(n) || b.is_special || /annual/i.test(b.filename || '') || !/^[1-9]\d*$/.test(n)) continue;   // not renumbered specials (#0.1)
          have.add(n);
          issues.push({ cv_issue_id: b.cv_issue_id || null, issue_number: b.issue_number, issue_title: b.title || null, cover_date: null, is_annual: 0, book_id: b.id });
        }
      }
      if (e.entry_type === 'range') issues = issues.filter(i => !i.is_annual && inRange(i.issue_number, e.issue_start, e.issue_end));
      issues.sort(cmpIssues);
      // Nothing in the volume list for this entry: keep the issues it has (picked in the Add
      // window, or from an earlier fetch) rather than emptying it.
      if (!issues.length && db.prepare('SELECT 1 FROM list_issues WHERE owner_kind = ? AND owner_id = ?').get(OWNER_KIND, entryId)) {
        db.prepare(`UPDATE reading_list_entries SET resolve_status = 'partial', resolved_at = datetime('now') WHERE id = ?`).run(entryId);
        logger.warn('reading-lists', 'Volume list has none of this entry\'s issues; kept the ones it has', { entryId, source: vi.source, start: e.issue_start, end: e.issue_end });
        return { ok: true, source: vi.source, partial: true, count: 0, kept: true };
      }

      const done = db.transaction(() => {
        const now = db.prepare('SELECT unpacked FROM reading_list_entries WHERE id = ?').get(entryId);
        if (!now || now.unpacked) return false;   // deleted, or made an own copy in the editor, while the list was fetched
        const old = db.prepare('SELECT * FROM list_issues WHERE owner_kind = ? AND owner_id = ? ORDER BY sort_order, id').all(OWNER_KIND, entryId);
        const oldByCv = new Map(), oldByNum = new Map();
        for (const o of old) {
          if (o.cv_issue_id) oldByCv.set(String(o.cv_issue_id), o);
          const n = normNum(o.issue_number); if (n && !oldByNum.has(n)) oldByNum.set(n, o);
        }
        // Rows keep their ids (2026-11-10): an open editor and download requests refer to them.
        // Deleting and re-inserting gave every row a new id seconds after a save added a range,
        // so the editor's next save was refused as "out of step". A row that matches an issue is
        // updated in place, new issues are added, and rows the volume no longer lists go.
        const ins = db.prepare(`INSERT INTO list_issues (owner_kind, owner_id, sort_order, cv_issue_id, scanned_book_id, scanned_series_id,
          series_name, issue_number, issue_title, volume_year, cover_date, manually_matched) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
        const upd = db.prepare(`UPDATE list_issues SET sort_order = ?, cv_issue_id = ?, scanned_book_id = ?, scanned_series_id = ?,
          series_name = ?, issue_number = ?, issue_title = ?, volume_year = ?, cover_date = ?, manually_matched = ? WHERE id = ?`);
        const kept = new Set();
        issues.forEach((i, idx) => {
          const prev = (i.cv_issue_id && oldByCv.get(String(i.cv_issue_id))) || (!i.is_annual && oldByNum.get(normNum(i.issue_number))) || null;
          const vals = [idx + 1, i.cv_issue_id || null, i.book_id || prev?.scanned_book_id || null, e.scanned_series_id || null,
            (i.is_annual && vi.seriesName && !/annual/i.test(vi.seriesName)) ? `${vi.seriesName} Annual` : (vi.seriesName || null), numStr(i.issue_number), i.issue_title || null, toInt(vi.volumeYear), i.cover_date || null,
            prev?.manually_matched ? 1 : 0];
          if (prev && !kept.has(prev.id)) { kept.add(prev.id); upd.run(...vals, prev.id); }
          else ins.run(OWNER_KIND, entryId, ...vals);
        });
        const del = db.prepare('DELETE FROM list_issues WHERE id = ?');
        for (const o of old) if (!kept.has(o.id)) del.run(o.id);
        const label = e.label || defaultLabel(e.entry_type, { seriesName: vi.seriesName, year: vi.volumeYear, start: e.issue_start, end: e.issue_end });
        db.prepare(`UPDATE reading_list_entries SET resolve_status = ?, resolve_source = ?, resolved_at = datetime('now'),
          cv_volume_id = COALESCE(cv_volume_id, ?), label = ? WHERE id = ?`)
          .run(vi.partial ? 'partial' : 'ok', vi.source, vi.cvVolumeId || null, label, entryId);
        return true;
      })();
      if (!done) return { skipped: 'deleted or made an own copy meanwhile' };
      matchRows(db.prepare(`SELECT li.*, ? AS entry_type FROM list_issues li
        WHERE li.owner_kind = ? AND li.owner_id = ? AND li.scanned_book_id IS NULL`).all(e.entry_type, OWNER_KIND, entryId));
      logger.info('reading-lists', 'Entry issue list fetched', { entryId, source: vi.source, issues: issues.length });
      return { ok: true, source: vi.source, partial: vi.partial, count: issues.length, error: vi.error };
    } finally { resolving.delete(entryId); }
  }

  // ── Shared matcher (list_issues → scanned_books) ────────────────
  // Levels, highest trust first:
  //   L1 scanned_books.cv_issue_id   L2 monitored_issue_id   (both with number check)
  //   L3 ComicInfo Web/Notes CV id   (single 'issue' entries only — a table scan)
  //   L4a same scanned series + same issue number
  //   L4c ComicInfo series name + ORIGINAL issue number + volume year within 1
  //       (finds minis and specials filed and renumbered inside a parent folder)
  //   L4b series name word-set + issue number + year within 4 (closest wins)
  function buildBookIndex() {
    const books = db.prepare(`SELECT sb.id, sb.series_id, sb.issue_number, sb.cv_issue_id, sb.monitored_issue_id,
        ${ciYearSql} AS ci_year, ss.name AS sname, ss.year AS syear
      FROM scanned_books sb JOIN scanned_series ss ON ss.id = sb.series_id`).all();
    const byCv = new Map(), byMon = new Map(), bySeriesNum = new Map(), byNum = new Map();
    for (const b of books) {
      if (b.cv_issue_id && !byCv.has(String(b.cv_issue_id))) byCv.set(String(b.cv_issue_id), b);
      if (b.monitored_issue_id && !byMon.has(String(b.monitored_issue_id))) byMon.set(String(b.monitored_issue_id), b);
      const n = normNum(b.issue_number);
      if (!n) continue;
      const k = `${b.series_id}|${n}`;
      if (!bySeriesNum.has(k)) bySeriesNum.set(k, b);
      if (!byNum.has(n)) byNum.set(n, []);
      byNum.get(n).push(b);
    }
    return { byCv, byMon, bySeriesNum, byNum, words: new Map(), ci: bookIndex ? bookIndex.matcherMap() : new Map() };
  }

  // Lowest regular (non-annual, non-special) issue number in a folder.
  const lowCache = new Map();
  function folderLow(seriesId) {
    if (lowCache.has(seriesId)) return lowCache.get(seriesId);
    const r = db.prepare(`SELECT MIN(CAST(issue_number AS REAL)) AS lo FROM scanned_books
      WHERE series_id = ? AND is_special = 0 AND LOWER(filename) NOT LIKE '%annual%' AND CAST(issue_number AS REAL) > 0`).get(seriesId);
    const lo = r?.lo || 0; lowCache.set(seriesId, lo); return lo;
  }

  function matchOne(row, idx) {
    const num = normNum(row.issue_number);
    const cv  = row.cv_issue_id ? String(row.cv_issue_id) : null;
    let b;
    if (cv) {
      b = idx.byCv.get(cv);  if (b && numbersAgree(b.issue_number, row.issue_number)) return b.id;
      b = idx.byMon.get(cv); if (b && numbersAgree(b.issue_number, row.issue_number)) return b.id;
      if (row.entry_type === 'issue') {
        b = db.prepare(`SELECT id, issue_number FROM scanned_books WHERE comicinfo LIKE ? OR comicinfo LIKE ? LIMIT 1`)
          .get(`%4000-${cv}%`, `%[Issue ID ${cv}]%`);
        if (b && numbersAgree(b.issue_number, row.issue_number)) return b.id;
      }
    }
    if (!num) return null;
    const rowAnnual = /annual/i.test(row.series_name || '');
    if (row.scanned_series_id) {
      b = idx.bySeriesNum.get(`${row.scanned_series_id}|${num}`);
      if (b && rowAnnual === /annual/i.test(b.sname || '')) return b.id;   // Annual #1 is not #1
    }
    if (!row.series_name) return null;
    const rowYear   = toInt(row.volume_year);
    if (bookIndex && idx.ci) {
      // A year in the name already pins the book: "The Flash 2021 Annual" is
      // tagged <Volume>2016 (the parent volume) while Comic Vine starts it in 2021.
      const nameYear = /\b(19|20)\d{2}\b/.test(row.series_name);
      const cands = (idx.ci.get(`${bookIndex.nameKey(row.series_name)}|${num}`) || [])
        .filter(c => !rowYear || !c.year || nameYear || Math.abs(c.year - rowYear) <= 1)
        .sort((a, b) => ((rowYear && a.year ? Math.abs(a.year - rowYear) : 2) - (rowYear && b.year ? Math.abs(b.year - rowYear) : 2)) || (a.retag - b.retag));
      if (cands[0]) return cands[0].id;
    }
    const rowWords  = sigWords(row.series_name);
    let best = null, cont = null;
    for (const c of idx.byNum.get(num) || []) {
      if (!rowAnnual && /annual/i.test(c.sname || '')) continue;
      let w = idx.words.get(c.series_id);
      if (!w) { w = sigWords(c.sname); idx.words.set(c.series_id, w); }
      if (!sameWords(rowWords, w)) continue;
      // Volume start year: the folder year or the ComicInfo year, whichever is
      // closer. <Year> is the COVER year, decades past the start in a long run
      // (Green Lantern (1960) #184 is dated 1985).
      const ys = [toInt(c.syear), c.ci_year].filter(Boolean);
      const dist = rowYear && ys.length ? Math.min(...ys.map(y => Math.abs(y - rowYear))) : 5;
      if (rowYear && ys.length && dist > 4) {
        // A long volume split across folders: Action Comics (1938) #601 sits in
        // the "Action Comics (1987)" folder, which continues the numbering at
        // #501. Accepted only when the folder starts well above #1 (a relaunch
        // restarts at #1) and is later than the requested volume.
        const y = toInt(c.syear), lo = folderLow(c.series_id);
        if (y && y > rowYear && lo > 1 && numKey(num) >= lo && (!cont || y < cont.y)) cont = { id: c.id, y };
        continue;
      }
      if (!best || dist < best.dist) best = { id: c.id, dist };
    }
    return best ? best.id : (cont ? cont.id : null);
  }

  function matchRows(rows, idx) {
    if (!rows.length) return 0;
    idx = idx || buildBookIndex();
    const upd = db.prepare('UPDATE list_issues SET scanned_book_id = ? WHERE id = ? AND scanned_book_id IS NULL');
    let n = 0;
    db.transaction(() => { for (const r of rows) { const id = matchOne(r, idx); if (id) { upd.run(id, r.id); n++; } } })();
    return n;
  }

  // After library scans: clear matches to books that no longer exist
  // (except manual ones), then match every unmatched row.
  const completeReconcile = require('./metadata/completionQueue').createCompletionQueue();
  function reconcile(scanChanged = true, options = {}) {
    return completeReconcile(() => runReconcile(scanChanged, options));
  }
  async function runReconcile(scanChanged = true, { strict = false } = {}) {
    try {
      // Keep the ComicInfo index current first (incremental; only changed books).
      if (bookIndex && scanChanged) await bookIndex.refresh();
      if (scanChanged) {
        db.prepare(`UPDATE list_issues SET scanned_book_id = NULL
          WHERE scanned_book_id IS NOT NULL AND manually_matched = 0
            AND scanned_book_id NOT IN (SELECT id FROM scanned_books)
            AND scanned_book_id NOT IN (SELECT id FROM missing_books)`).run();
        await yieldLoop();
      }
      const rows = db.prepare(`SELECT li.*, e.entry_type FROM list_issues li
        JOIN reading_list_entries e ON e.id = li.owner_id
        WHERE li.owner_kind = ? AND li.scanned_book_id IS NULL`).all(OWNER_KIND);
      if (!rows.length) return;
      const idx = buildBookIndex();
      let matched = 0;
      for (let i = 0; i < rows.length; i += 500) {
        matched += matchRows(rows.slice(i, i + 500), idx);
        await yieldLoop();
      }
      if (matched) logger.info('reading-lists', `Matched ${matched} of ${rows.length} unmatched list issues`);
    } catch (e) {
      logger.error('reading-lists', 'Reconcile failed', { error: e.message });
      if (strict) throw e;
    }
  }

  // ── Reading entry issues ────────────────────────────────────────
  const isLinked = e => (e.entry_type === 'event' || e.entry_type === 'canon_run') && !e.unpacked;

  // Event tier filter. Stored filter (default essential) widens automatically
  // when it would show nothing, e.g. events with no issues marked essential.
  const TIER_SETS = { essential: new Set(['essential']), recommended: new Set(['essential', 'recommended']) };
  function tierInfo(all, wanted) {
    const counts = {
      essential: all.filter(i => i.tier === 'essential').length,
      recommended: all.filter(i => i.tier === 'essential' || i.tier === 'recommended').length,
      all: all.length,
    };
    let effective = TIER_FILTERS.includes(wanted) ? wanted : 'essential';
    while (effective !== 'all' && counts[effective] === 0) effective = TIER_FILTERS[TIER_FILTERS.indexOf(effective) + 1];
    return { counts, effective };
  }
  function filterTiers(all, wanted) {
    const { effective } = tierInfo(all, wanted);
    return effective === 'all' ? all : all.filter(i => TIER_SETS[effective].has(i.tier));
  }

  function linkedIssues(e, { unfiltered = false } = {}) {
    if (e.entry_type === 'event') {
      const all = db.prepare(`SELECT NULL AS id, cv_issue_id, scanned_book_id, series_name, issue_number, issue_title,
          volume_year, tier, 0 AS manually_matched FROM event_issues WHERE event_id = ? ORDER BY sort_order`).all(String(e.ref_id));
      return unfiltered ? all : filterTiers(all, e.tier_filter);
    }
    if (e.entry_type === 'canon_run') {
      return db.prepare(`SELECT NULL AS id, cv_issue_id, CAST(scanned_book_id AS TEXT) AS scanned_book_id, series_name, issue_number,
          NULL AS issue_title, volume_year, NULL AS tier, 0 AS manually_matched FROM canon_run_issues WHERE run_id = ? ORDER BY sort_order`).all(toInt(e.ref_id));
    }
    return [];
  }
  function entryIssues(e) {
    if (e.entry_type === 'section') return [];
    if (isLinked(e)) return linkedIssues(e);
    return db.prepare(`SELECT id, cv_issue_id, scanned_book_id, series_name, issue_number, issue_title, volume_year,
        NULL AS tier, manually_matched FROM list_issues WHERE owner_kind = ? AND owner_id = ? ORDER BY sort_order, id`).all(OWNER_KIND, e.id);
  }
  function sourceExists(e) {
    if (e.entry_type === 'event') return !!db.prepare('SELECT 1 FROM events WHERE id = ?').get(String(e.ref_id));
    if (e.entry_type === 'canon_run') return !!db.prepare('SELECT 1 FROM canon_runs WHERE id = ?').get(toInt(e.ref_id));
    return true;
  }

  // Per-user progress (same rule as event detail: legacy rows with
  // user_id NULL count for everyone; the user's own row wins).
  function progressMap(bookIds, userId) {
    const out = new Map();
    const ids = [...new Set(bookIds.filter(Boolean))];
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const rows = db.prepare(`SELECT book_id, page, completed, user_id FROM read_progress
        WHERE book_id IN (${placeholders(chunk)}) AND (user_id = ? OR user_id IS NULL)`).all(...chunk, userId);
      for (const r of rows) {
        if (!out.has(r.book_id) || r.user_id) out.set(r.book_id, { page: r.page || 0, completed: !!r.completed });
      }
    }
    return out;
  }
  function bookMap(bookIds) {
    const out = new Map();
    const ids = [...new Set(bookIds.filter(Boolean))];
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      for (const b of db.prepare(`SELECT id, series_id, title, filename FROM scanned_books WHERE id IN (${placeholders(chunk)})`).all(...chunk))
        out.set(b.id, b);
    }
    return out;
  }
  function summarize(bookIds, pm, bm) {
    let total = 0, owned = 0, read = 0;
    for (const id of bookIds) {
      total++;
      if (id && bm.has(id)) { owned++; if (pm.get(id)?.completed) read++; }
    }
    return { total, owned, read };
  }
  // Progress plus up to 8 cover book ids for list cards and box tiles (2026-11-04): the
  // first 4 owned issues in order (the card's fan and theme use these), then owned issues
  // spread through the rest of the list; a short list is topped up with other issues
  // from the series it uses (boxPeek.fillFrom).
  function listProgress(listId, userId) {
    const ids = [];
    for (const e of listEntries(listId)) for (const i of entryIssues(e)) ids.push(i.scanned_book_id);
    const pm = progressMap(ids, userId), bm = bookMap(ids);
    const owned = [...new Set(ids.filter(id => id && bm.has(id)))];
    const { spread, fillFrom } = require('./boxPeek');
    const covers = owned.slice(0, 4).concat(spread(owned.slice(4), 4));
    if (covers.length < 8 && covers.length) {
      const seriesIds = [...new Set(covers.map(id => bm.get(id)?.series_id).filter(Boolean))];
      const taken = new Set(owned);
      const booksFor = sid => db.prepare('SELECT id FROM scanned_books WHERE series_id = ? ORDER BY sort_order ASC, filename ASC').all(sid).map(b => b.id).filter(id => !taken.has(id));
      covers.push(...fillFrom(seriesIds, booksFor, 8 - covers.length));
    }
    return { ...summarize(ids, pm, bm), cover_book_ids: covers };
  }

  function catalogOf(l) {
    let saved = {}; try { saved = JSON.parse(l.catalog_json || '{}'); } catch {}
    const publishers = new Set(), libraries = new Set(), seenBooks = new Set(), seenSeries = new Set(), seenNames = new Set();
    const artworkSeries = new Map();
    const addSeries = ss => {
      if (!ss) return;
      artworkSeries.set(ss.id, ss);
      if (ss.library_id) libraries.add(String(ss.library_id));
      let sj = {}; try { sj = JSON.parse(ss.series_json || '{}'); } catch {}
      const pub = sj.metadata?.publisher || sj.publisher;
      if (typeof pub === 'string' && pub.trim()) publishers.add(pub.trim());
    };
    for (const e of listEntries(l.id)) {
      if (e.scanned_series_id && !seenSeries.has(e.scanned_series_id)) { seenSeries.add(e.scanned_series_id); addSeries(db.prepare('SELECT * FROM scanned_series WHERE id = ?').get(e.scanned_series_id)); }
      for (const i of entryIssues(e)) {
        if (i.scanned_book_id && !seenBooks.has(i.scanned_book_id)) { seenBooks.add(i.scanned_book_id); addSeries(db.prepare('SELECT s.* FROM scanned_series s JOIN scanned_books b ON b.series_id = s.id WHERE b.id = ?').get(i.scanned_book_id)); }
        // Named missing issues still associate through their series, without an owned-book requirement.
        const key = i.series_name + '|' + (i.volume_year || '');
        if (!seenNames.has(key) && i.series_name) {
          seenNames.add(key);
          const matches = db.prepare('SELECT * FROM scanned_series WHERE name = ? COLLATE NOCASE').all(i.series_name);
          for (const ss of matches) if (!i.volume_year || !ss.year || Number(ss.year) === Number(i.volume_year)) addSeries(ss);
        }
      }
      if (isLinked(e)) {
        const table = e.entry_type === 'event' ? 'events' : 'canon_runs';
        const linked = db.prepare('SELECT * FROM ' + table + ' WHERE id = ?').get(e.ref_id);
        if (linked?.publisher) publishers.add(linked.publisher);
      }
    }
    return { artwork: boxArtwork.describe('order', l.id, [...artworkSeries.values()]), publishers: saved.publishers?.length ? saved.publishers : [...publishers],
      library_ids: saved.library_ids?.length ? saved.library_ids : [...libraries],
      collection_ids: saved.collections?.map(v => collectionRegistry.find(v)?.id).filter(Boolean), collections: collectionRegistry.names(saved.collections), featured: saved.featured === true, group: saved.group || '', by_publisher: saved.by_publisher === true, explicit: saved };
  }

  function validateCatalog(value, req, previous = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad(400, 'Invalid catalog settings');
    const result = {};
    for (const key of ['publishers', 'library_ids']) {
      const a = value[key] || [];
      if (!Array.isArray(a) || a.length > 30 || a.some(v => typeof v !== 'string' || !v.trim() || v.length > 100)) throw bad(400, 'Invalid ' + key);
      result[key] = [...new Set(a.map(v => v.trim()))];
    }
    result.featured = value.featured === true;
    if (result.featured !== (previous.featured === true) && !isAdmin(req)) throw bad(403, 'Only the admin can feature Essentials');
    // Catalog section: a custom group name and/or "group by publisher". Kept when not sent.
    const group = value.group !== undefined ? value.group : previous.group;
    if (group != null && (typeof group !== 'string' || group.length > 60)) throw bad(400, 'Invalid group');
    if (group && group.trim()) result.group = group.trim();
    if (value.by_publisher !== undefined ? value.by_publisher === true || value.by_publisher === 1 : previous.by_publisher === true) result.by_publisher = true;
    const collections = value.collections !== undefined ? value.collections : previous.collections;
    if (collections !== undefined) {
      if (!Array.isArray(collections) || collections.length > 20 || collections.some(v => typeof v !== 'string' || !v.trim() || v.length > 60)) throw bad(400, 'Choose up to 20 collections, with names up to 60 characters');
      if (collections.some(v => v.startsWith('ec_') && !collectionRegistry.find(v))) throw bad(400, 'Collection no longer exists; reload the editor');
      result.collections = [...new Set([...new Map(collections.map(v => [v.trim().toLowerCase(), v.trim()])).values()].map(v => collectionRegistry.find(v)?.id || v))];
    }
    return JSON.stringify(result);
  }

  function listSummary(l, userId, extra = {}) {
    return {
      id: l.id, name: l.name, description: l.description, home_tagline:l.home_tagline, home_description:l.home_description, visibility: l.visibility, owner_id: l.owner_id,
      owner_name: l.owner_name || null, source: l.source, cover_image: l.cover_image, copied_from: l.copied_from,
      created_at: l.created_at, updated_at: l.updated_at,
      catalog: catalogOf(l),
      entry_count: l.entry_count ?? db.prepare(`SELECT COUNT(*) AS n FROM reading_list_entries WHERE list_id = ? AND entry_type != 'section'`).get(l.id).n,
      follower_count: db.prepare('SELECT COUNT(*) AS n FROM reading_list_follows WHERE list_id = ?').get(l.id).n,
      is_owner: l.owner_id === userId,
      following: !!db.prepare('SELECT 1 FROM reading_list_follows WHERE user_id = ? AND list_id = ?').get(userId, l.id),
      ...extra,
    };
  }

  // ── Adding entries ──────────────────────────────────────────────
  // body: { type, note?, label?, position? (0-based; default end), ... }
  //   issue:      bookId  |  seriesName + issueNumber [+ cvIssueId, volumeYear, issueTitle]
  //   range:      seriesId | cvVolumeId, plus issueStart and/or issueEnd
  //   series:     seriesId | cvVolumeId
  //   event:      refId (events.id)        canon_run: refId (canon_runs.id)
  //   story:      label + issues[] ({bookId} | {seriesName, issueNumber, volumeYear}),
  //               a short crossover read as one row, issues from several series in order
  function insertEntry(list, body) {
    const type = String(body.type || '');
    if (!ENTRY_TYPES.has(type)) throw bad(400, 'Unknown entry type');
    const note = str(body.note, 2000);
    let label = str(body.label, 300);
    const f = { ref_id: null, cv_volume_id: null, scanned_series_id: null, issue_start: null, issue_end: null };
    let issueRow = null, seriesForLabel = null, namedRows = null, storyRows = null, seedRows = null;
    // Picked issues ({ bookId } or { seriesName, issueNumber, volumeYear, cvIssueId }) → list_issues rows.
    const pickedRows = items => items.map(it => {
        if (it.bookId) {
          const b = db.prepare(`SELECT sb.id, sb.issue_number, sb.title, sb.cv_issue_id, sb.series_id, ss.name AS sname, ss.year AS syear
            FROM scanned_books sb JOIN scanned_series ss ON ss.id = sb.series_id WHERE sb.id = ?`).get(String(it.bookId));
          if (b) {
            const ci = bookIndex ? bookIndex.info(b.id) : null;
            return { cv_issue_id: b.cv_issue_id || null, scanned_book_id: b.id, scanned_series_id: b.series_id,
              series_name: ci?.series_name || b.sname, issue_number: (ci?.series_name && ci.orig_number) || b.issue_number,
              issue_title: b.title || null, volume_year: (ci?.series_name && ci.volume_year) || toInt(b.syear), manually_matched: 1 };
          }
        }
        const sName = str(it.seriesName, 300), num = str(it.issueNumber, 40);
        if (!sName || !num) throw bad(400, 'Each story issue needs bookId, or seriesName and issueNumber');
        return { cv_issue_id: str(it.cvIssueId, 40), scanned_book_id: null, scanned_series_id: null, series_name: sName,
          issue_number: normNum(num) || num, issue_title: str(it.issueTitle, 300), volume_year: toInt(it.volumeYear), manually_matched: 0 };
      });

    if (type === 'story') {
      if (!label) throw bad(400, 'A story needs a name');
      const items = (Array.isArray(body.issues) ? body.issues : []).filter(x => x && typeof x === 'object');
      if (!items.length) throw bad(400, 'A story needs its issues');
      if (items.length > MAX_NAMED_ISSUES) throw bad(400, `At most ${MAX_NAMED_ISSUES} issues in a story`);
      storyRows = pickedRows(items);
    } else if (type === 'issue') {
      if (body.bookId) {
        const b = db.prepare(`SELECT sb.id, sb.issue_number, sb.title, sb.cv_issue_id, sb.series_id, ss.name AS sname, ss.year AS syear
          FROM scanned_books sb JOIN scanned_series ss ON ss.id = sb.series_id WHERE sb.id = ?`).get(String(body.bookId));
        if (!b) throw bad(404, 'Book not found');
        // Name and number as published (ComicInfo), so a mini filed in a parent
        // folder reads "Green Lantern: Rebirth #2", not "Green Lantern #0.2".
        const ci = bookIndex ? bookIndex.info(b.id) : null;
        issueRow = { cv_issue_id: b.cv_issue_id || null, scanned_book_id: b.id, scanned_series_id: b.series_id,
          series_name: ci?.series_name || b.sname, issue_number: (ci?.series_name && ci.orig_number) || b.issue_number,
          issue_title: b.title || null, volume_year: (ci?.series_name && ci.volume_year) || toInt(b.syear), manually_matched: 1 };
        f.scanned_series_id = b.series_id;
      } else {
        const seriesName = str(body.seriesName, 300), issueNumber = str(body.issueNumber, 40);
        if (!seriesName || !issueNumber) throw bad(400, 'bookId, or seriesName and issueNumber, required');
        issueRow = { cv_issue_id: str(body.cvIssueId, 40), scanned_book_id: null, scanned_series_id: null, series_name: seriesName,
          issue_number: normNum(issueNumber) || issueNumber, issue_title: str(body.issueTitle, 300), volume_year: toInt(body.volumeYear), manually_matched: 0 };
      }
      label = label || defaultLabel('issue', { seriesName: issueRow.series_name, year: issueRow.volume_year, number: issueRow.issue_number });
    } else if (type === 'range' && !body.seriesId && !body.cvVolumeId && str(body.seriesName, 300)) {
      // Range by name ("Green Lantern: Rebirth (2004) #1-6"): a fixed list of
      // issues matched like single issues (ComicInfo name + original number
      // first). Stored unpacked: there is no volume to refresh from.
      const sName = str(body.seriesName, 300), vYear = toInt(body.volumeYear);
      const a = normNum(str(body.issueStart, 40)), z = normNum(str(body.issueEnd, 40)) || a;
      if (!a) throw bad(400, 'issueStart required');
      const ai = Number(a), zi = Number(z);
      let nums;
      if (Number.isInteger(ai) && Number.isInteger(zi)) {
        if (Math.abs(zi - ai) + 1 > MAX_NAMED_ISSUES) throw bad(400, `At most ${MAX_NAMED_ISSUES} issues in a named range`);
        const step = zi >= ai ? 1 : -1;   // Zero Hour counts down: #4, 3, 2, 1, 0
        nums = Array.from({ length: Math.abs(zi - ai) + 1 }, (_, k) => String(ai + k * step));
      } else nums = a === z ? [a] : [a, z];
      namedRows = nums.map(n => ({ series_name: sName, issue_number: n, volume_year: vYear }));
      f.issue_start = a; f.issue_end = z;
      label = label || defaultLabel(nums.length > 1 ? 'range' : 'issue', { seriesName: sName, year: vYear, start: a, end: z, number: a });
    } else if (type === 'series' || type === 'range') {
      if (body.seriesId) {
        const ss = db.prepare('SELECT id, name, year FROM scanned_series WHERE id = ?').get(String(body.seriesId));
        if (!ss) throw bad(404, 'Series not found');
        f.scanned_series_id = ss.id;
        seriesForLabel = ss;
      }
      if (body.cvVolumeId) f.cv_volume_id = String(body.cvVolumeId).replace(/^4050-/, '');
      if (!f.scanned_series_id && !f.cv_volume_id) throw bad(400, 'seriesId or cvVolumeId required');
      if (type === 'range') {
        f.issue_start = normNum(str(body.issueStart, 40)); f.issue_end = normNum(str(body.issueEnd, 40));
        if (!f.issue_start && !f.issue_end) throw bad(400, 'issueStart or issueEnd required');
        if (f.issue_start && f.issue_end && numKey(f.issue_start) > numKey(f.issue_end)) throw bad(400, 'The first issue is after the last issue');
        // The issues picked in the Add window, stored at once: the entry is not empty while its
        // issue list is fetched in the background, nor after, if that list has none of these
        // numbers (user 2026-10-30: ranges came back empty after saving).
        const items = (Array.isArray(body.issues) ? body.issues : []).filter(x => x && typeof x === 'object').slice(0, MAX_NAMED_ISSUES);
        if (items.length) seedRows = pickedRows(items);
      }
      if (!label && seriesForLabel) label = defaultLabel(type, { seriesName: seriesForLabel.name, year: seriesForLabel.year, start: f.issue_start, end: f.issue_end });
    } else if (type === 'event') {
      const ev = db.prepare('SELECT id, name, year FROM events WHERE id = ?').get(String(body.refId));
      if (!ev) throw bad(404, 'Event not found');
      f.ref_id = String(ev.id);
      label = label || (ev.year ? `${ev.name} (${ev.year})` : ev.name);
    } else if (type === 'section') {
      if (!label) throw bad(400, 'A section needs a title');
    } else if (type === 'canon_run') {
      const run = db.prepare('SELECT id, title FROM canon_runs WHERE id = ?').get(toInt(body.refId));
      if (!run) throw bad(404, 'Top Shelf run not found');
      f.ref_id = String(run.id);
      label = label || run.title;
    }

    const entries = listEntries(list.id);
    if (entries.length >= MAX_ENTRIES) throw bad(400, `A list can have at most ${MAX_ENTRIES} entries`);
    const reqPos = toInt(body.position);
    const pos = reqPos == null ? entries.length : Math.max(0, Math.min(entries.length, reqPos));
    const duplicate = type !== 'section' && entries.some(x => x.entry_type === type && (
      (f.ref_id && x.ref_id === f.ref_id) ||
      (type !== 'issue' && f.scanned_series_id && x.scanned_series_id === f.scanned_series_id && x.issue_start === f.issue_start && x.issue_end === f.issue_end) ||
      (type === 'issue' && issueRow.scanned_book_id &&
        !!db.prepare('SELECT 1 FROM list_issues WHERE owner_kind = ? AND owner_id = ? AND scanned_book_id = ?').get(OWNER_KIND, x.id, issueRow.scanned_book_id))));

    const stored = (type === 'series' || type === 'range') && !namedRows;
    let entryId;
    db.transaction(() => {
      const r = db.prepare(`INSERT INTO reading_list_entries (list_id, sort_order, entry_type, ref_id, cv_volume_id, scanned_series_id,
          issue_start, issue_end, label, note, unpacked, resolve_status, resolve_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(list.id, pos + 1, type, f.ref_id, f.cv_volume_id, f.scanned_series_id, f.issue_start, f.issue_end,
          label, note, (namedRows || storyRows) ? 1 : 0, stored ? 'pending' : 'ok', namedRows ? 'named' : storyRows ? 'story' : null);
      entryId = Number(r.lastInsertRowid);
      const ordered = entries.map(x => x.id); ordered.splice(pos, 0, entryId);
      const upd = db.prepare('UPDATE reading_list_entries SET sort_order = ? WHERE id = ?');
      ordered.forEach((id, i) => upd.run(i + 1, id));
      if (namedRows) {
        const insN = db.prepare(`INSERT INTO list_issues (owner_kind, owner_id, sort_order, series_name, issue_number, volume_year, manually_matched)
          VALUES (?,?,?,?,?,?,0)`);
        namedRows.forEach((r, i) => insN.run(OWNER_KIND, entryId, i + 1, r.series_name, r.issue_number, r.volume_year));
      }
      if (storyRows) insertIssueRows(entryId, storyRows);
      if (seedRows) insertIssueRows(entryId, seedRows);
      if (issueRow) {
        db.prepare(`INSERT INTO list_issues (owner_kind, owner_id, sort_order, cv_issue_id, scanned_book_id, scanned_series_id, series_name,
            issue_number, issue_title, volume_year, manually_matched) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(OWNER_KIND, entryId, 1, issueRow.cv_issue_id, issueRow.scanned_book_id, issueRow.scanned_series_id, issueRow.series_name,
            numStr(issueRow.issue_number), issueRow.issue_title, issueRow.volume_year, issueRow.manually_matched);
      }
      touch(list.id);
    })();
    if (namedRows) {
      matchRows(db.prepare(`SELECT li.*, 'range' AS entry_type FROM list_issues li WHERE owner_kind = ? AND owner_id = ?`).all(OWNER_KIND, entryId));
    }
    if (seedRows && seedRows.some(r => !r.scanned_book_id)) {
      matchRows(db.prepare(`SELECT li.*, 'range' AS entry_type FROM list_issues li WHERE owner_kind = ? AND owner_id = ? AND scanned_book_id IS NULL`).all(OWNER_KIND, entryId));
    }
    if (storyRows && storyRows.some(r => !r.scanned_book_id)) {
      matchRows(db.prepare(`SELECT li.*, 'range' AS entry_type FROM list_issues li WHERE owner_kind = ? AND owner_id = ? AND scanned_book_id IS NULL`).all(OWNER_KIND, entryId));
    }
    if (issueRow && !issueRow.scanned_book_id) {
      matchRows(db.prepare(`SELECT li.*, 'issue' AS entry_type FROM list_issues li WHERE owner_kind = ? AND owner_id = ?`).all(OWNER_KIND, entryId));
    }
    return { entryId, needsResolve: stored, duplicate };
  }

  // Copy issue rows (list_issues shape) under an entry, in order.
  function insertIssueRows(entryId, rows) {
    const ins = db.prepare(`INSERT INTO list_issues (owner_kind, owner_id, sort_order, cv_issue_id, scanned_book_id, scanned_series_id,
        series_name, issue_number, issue_title, volume_year, manually_matched) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    rows.forEach((r, i) => ins.run(OWNER_KIND, entryId, i + 1, r.cv_issue_id || null, r.scanned_book_id || null, r.scanned_series_id || null,
      r.series_name || null, numStr(r.issue_number), r.issue_title || null, toInt(r.volume_year), r.manually_matched ? 1 : 0));
  }
  // An entry's issues with every column (linked entries: from the event/run).
  const rawIssues = e => isLinked(e) ? linkedIssues(e)
    : db.prepare('SELECT * FROM list_issues WHERE owner_kind = ? AND owner_id = ? ORDER BY sort_order, id').all(OWNER_KIND, e.id);
  function renumber(listId) {
    const upd = db.prepare('UPDATE reading_list_entries SET sort_order = ? WHERE id = ?');
    db.prepare('SELECT id FROM reading_list_entries WHERE list_id = ? ORDER BY sort_order, id').all(listId).forEach((x, i) => upd.run(i + 1, x.id));
  }

  function startResolve(entryId) {
    setImmediate(() => {
      Promise.resolve(runBackground('reading-list-resolve', () => resolveEntry(entryId))())
        .catch(e => logger.error('reading-lists', 'Resolve failed', { entryId, error: e.message }));
    });
  }

  function deleteEntryRows(entryId) {
    db.prepare('DELETE FROM list_issues WHERE owner_kind = ? AND owner_id = ?').run(OWNER_KIND, entryId);
    db.prepare('DELETE FROM reading_list_entries WHERE id = ?').run(entryId);
  }

  function entryDetail(e, pm, bm) {
    const issues = entryIssues(e).map(i => {
      const b = i.scanned_book_id ? bm.get(i.scanned_book_id) : null;
      const p = b ? pm.get(b.id) : null;
      return {
        id: i.id, cv_issue_id: i.cv_issue_id, book_id: b ? b.id : null, series_id: b ? b.series_id : null,
        series_name: i.series_name, issue_number: i.issue_number, title: i.issue_title || b?.title || null,
        volume_year: i.volume_year, tier: i.tier || null, owned: !!b, completed: !!p?.completed, page: p?.page || 0,
        manually_matched: !!i.manually_matched,
      };
    });
    return {
      id: e.id, type: e.entry_type, label: e.label || (e.cv_volume_id ? `Comic Vine volume ${e.cv_volume_id}` : 'Untitled entry'), note: e.note, sort_order: e.sort_order, ref_id: e.ref_id,
      scanned_series_id: e.scanned_series_id, cv_volume_id: e.cv_volume_id, issue_start: e.issue_start, issue_end: e.issue_end,
      unpacked: !!e.unpacked, linked: isLinked(e), source_missing: isLinked(e) && !sourceExists(e),
      resolve_status: e.resolve_status, resolve_source: e.resolve_source, resolved_at: e.resolved_at,
      refreshable: !e.unpacked && (e.entry_type === 'series' || e.entry_type === 'range'),
      tier: e.entry_type === 'event' && isLinked(e) ? (() => {
        const t = tierInfo(linkedIssues(e, { unfiltered: true }), e.tier_filter);
        return { filter: e.tier_filter || 'essential', effective: t.effective, counts: t.counts };
      })() : null,
      progress: summarize(issues.map(i => i.book_id), pm, bm),
      issues,
    };
  }

  // ── Routes ──────────────────────────────────────────────────────
  function fail(res, e) {
    if (res.headersSent) return;
    if (e.status) return res.status(e.status).json({ error: e.message });
    logger.error('reading-lists', 'Request failed', { error: e.message, stack: e.stack });
    res.status(500).json({ error: e.message });
  }
  const wrap = fn => (req, res) => {
    try { const r = fn(req, res); if (r && typeof r.catch === 'function') r.catch(e => fail(res, e)); }
    catch (e) { fail(res, e); }
  };
  function sameIdSet(ids, have) {
    return ids.length === have.length && new Set(ids).size === ids.length && ids.every(id => have.includes(id));
  }

  app.put('/api/reading-lists/:id/artwork', requireAuth, wrap((req,res) => {
    const list=loadForEdit(req);
    boxArtwork.save('order',list.id,req.body.choice);
    res.json({artwork:catalogOf(list).artwork});
  }));

  // Index. scope = mine | following | public | essential. lite=1 → id/name only (pickers).
  app.get('/api/reading-lists', requireAuth, wrap((req, res) => {
    const me = uid(req);
    const scope = String(req.query.scope || 'mine');
    const base = `SELECT rl.*, u.username AS owner_name FROM reading_lists rl LEFT JOIN users u ON u.id = rl.owner_id`;
    let rows;
    // Essentials live on their own page: not in My Lists (unless includeEssential=1, used by
    // the admin's add-to-list picker) and never in Following.
    const withEss = req.query.includeEssential === '1';
    if (scope === 'mine') rows = db.prepare(`${base} WHERE rl.owner_id = ? ${withEss ? '' : "AND rl.visibility != 'essential'"} ORDER BY rl.updated_at DESC`).all(me);
    else if (scope === 'following') rows = db.prepare(`${base} JOIN reading_list_follows f ON f.list_id = rl.id
        WHERE f.user_id = ? AND rl.visibility = 'public' AND rl.owner_id != ? ORDER BY f.followed_at DESC`).all(me, me);
    else if (scope === 'public') rows = db.prepare(`${base} WHERE rl.visibility = 'public' ORDER BY rl.updated_at DESC`).all();
    else if (scope === 'essential') rows = db.prepare(`${base} WHERE rl.visibility = 'essential' ORDER BY rl.name`).all();
    else throw bad(400, 'Unknown scope');
    if (req.query.lite === '1') return res.json({ lists: rows.map(r => ({ id: r.id, name: r.name, visibility: r.visibility })) });
    res.json({ lists: rows.map(r => listSummary(r, me, { progress: listProgress(r.id, me) })) });
  }));

  // Create. Optional entries[] (same shape as POST .../entries) for lists built in one step.
  app.post('/api/reading-lists', requireAuth, wrap((req, res) => {
    const b = req.body || {};
    const name = str(b.name, 200);
    if (!name) throw bad(400, 'Name required');
    const visibility = String(b.visibility || 'private');
    if (!VISIBILITY.has(visibility)) throw bad(400, 'Unknown visibility');
    if (visibility === 'essential' && !isAdmin(req)) throw bad(403, 'Only the admin can make Essentials lists');
    const r = db.prepare(`INSERT INTO reading_lists (name, description, owner_id, visibility, source) VALUES (?,?,?,?,?)`)
      .run(name, str(b.description, 4000), uid(req), visibility, b.source === 'ai' ? 'ai' : 'manual');
    const list = getList(Number(r.lastInsertRowid));
    const errors = [];
    (Array.isArray(b.entries) ? b.entries.slice(0, MAX_ENTRIES) : []).forEach((body, i) => {
      try { const out = insertEntry(list, body || {}); if (out.needsResolve) startResolve(out.entryId); }
      catch (e) { errors.push({ index: i, error: e.message }); }
    });
    res.status(201).json({ id: list.id, errors });
  }));

  // ── Apply a proposed list to an existing list (Comic Book Guy "Update this list") ──
  // body: { entries: [create-style entry bodies, in the new order], dryRun }
  // Entries that already exist (same section title, event, run, series, range or
  // issue) are KEPT as they are, with their notes, manual matches and unpacked
  // edits; new ones are added; existing ones not in the new list are removed;
  // then everything is put in the new order. dryRun returns the summary only.
  const nk = s => (bookIndex ? bookIndex.nameKey(s) : [...sigWords(s)].sort().join(' '));
  const firstIssue = id => db.prepare('SELECT * FROM list_issues WHERE owner_kind = ? AND owner_id = ? ORDER BY sort_order LIMIT 1').get(OWNER_KIND, id);
  function existingKeys(e) {
    const t = e.entry_type, a = normNum(e.issue_start) || '', z = normNum(e.issue_end) || a;
    if (t === 'section') return [`section|${String(e.label || '').trim().toLowerCase()}`];
    if (t === 'story') return [`story|${String(e.label || '').trim().toLowerCase()}`];
    if (t === 'event' || t === 'canon_run') return [`${t}|${e.ref_id}`];
    if (t === 'series') return [e.scanned_series_id ? `series|${e.scanned_series_id}` : `series|cv${e.cv_volume_id}`];
    if (t === 'range') {
      if (e.resolve_source === 'named') { const li = firstIssue(e.id); return [`named|${nk(li?.series_name)}|${li?.volume_year || ''}|${a}|${z}`]; }
      return [e.scanned_series_id ? `range|${e.scanned_series_id}|${a}|${z}` : `range|cv${e.cv_volume_id}|${a}|${z}`];
    }
    if (t === 'issue') {
      const li = firstIssue(e.id); if (!li) return [];
      const keys = [`issue|${nk(li.series_name)}|${normNum(li.issue_number) || ''}|${li.volume_year || ''}`];
      if (li.scanned_book_id) keys.unshift(`issue|book|${li.scanned_book_id}`);
      return keys;
    }
    return [];
  }
  function incomingKeys(b) {
    const t = String(b.type || ''), a = normNum(str(b.issueStart, 40)) || '', z = normNum(str(b.issueEnd, 40)) || a;
    if (t === 'section') return [`section|${String(b.label || '').trim().toLowerCase()}`];
    if (t === 'story') return [`story|${String(b.label || '').trim().toLowerCase()}`];
    if (t === 'event' || t === 'canon_run') return [`${t}|${b.refId}`];
    if (t === 'series') return [b.seriesId ? `series|${b.seriesId}` : `series|cv${b.cvVolumeId}`];
    if (t === 'range') {
      if (!b.seriesId && !b.cvVolumeId && b.seriesName) return [`named|${nk(b.seriesName)}|${toInt(b.volumeYear) || ''}|${a}|${z}`];
      return [b.seriesId ? `range|${b.seriesId}|${a}|${z}` : `range|cv${b.cvVolumeId}|${a}|${z}`];
    }
    if (t === 'issue') {
      if (b.bookId) {
        const ci = bookIndex ? bookIndex.info(b.bookId) : null;
        const keys = [`issue|book|${b.bookId}`];
        if (ci?.series_name) keys.push(`issue|${nk(ci.series_name)}|${normNum(ci.orig_number) || ''}|${ci.volume_year || ''}`);
        return keys;
      }
      return [`issue|${nk(b.seriesName)}|${normNum(b.issueNumber) || ''}|${toInt(b.volumeYear) || ''}`];
    }
    return [];
  }
  function planApply(list, incoming) {
    const ex = listEntries(list.id);
    const byKey = new Map();
    for (const e of ex) for (const k of existingKeys(e)) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(e); }
    const used = new Set();
    const steps = incoming.map(b => {
      for (const k of incomingKeys(b)) {
        const hit = (byKey.get(k) || []).find(e => !used.has(e.id));
        if (hit) { used.add(hit.id); return { keep: hit, body: b }; }
      }
      return { add: true, body: b };
    });
    const removes = ex.filter(e => !used.has(e.id));
    // Moved = kept entries outside the longest run already in the old order.
    const keptOrder = steps.filter(x => x.keep).map(x => x.keep.sort_order);
    const lis = []; for (const v of keptOrder) { let lo = 0, hi = lis.length; while (lo < hi) { const m = (lo + hi) >> 1; if (lis[m] < v) lo = m + 1; else hi = m; } lis[lo] = v; }
    const label = b => str(b.display, 300) || str(b.label, 300) || (b.type === 'range' && b.seriesName ? `${b.seriesName} #${b.issueStart}${b.issueEnd && b.issueEnd !== b.issueStart ? '–' + b.issueEnd : ''}` : b.type);
    return {
      steps, removes,
      summary: {
        adds: steps.filter(x => x.add && x.body.type !== 'section').map(x => label(x.body)),
        sections_added: steps.filter(x => x.add && x.body.type === 'section').map(x => label(x.body)),
        removes: removes.filter(e => e.entry_type !== 'section').map(e => e.label || e.entry_type),
        sections_removed: removes.filter(e => e.entry_type === 'section').map(e => e.label),
        kept: keptOrder.length, moved: keptOrder.length - lis.length,
      },
    };
  }

  app.post('/api/reading-lists/:id/apply', requireAuth, wrap((req, res) => {
    const list = loadForEdit(req);
    const incoming = (Array.isArray(req.body?.entries) ? req.body.entries : []).slice(0, MAX_ENTRIES).filter(b => b && typeof b === 'object');
    if (!incoming.some(b => b.type !== 'section')) throw bad(400, 'The new list is empty');
    const plan = planApply(list, incoming);
    if (req.body?.dryRun) return res.json({ dryRun: true, ...plan.summary });
    const errors = [], resolve = [];
    db.transaction(() => {
      for (const e of plan.removes) deleteEntryRows(e.id);
      const order = [];
      plan.steps.forEach((x, i) => {
        if (x.keep) { order.push(x.keep.id); return; }
        try {
          const { display, missing, owned, position, ...body } = x.body;
          const out = insertEntry(list, body);
          order.push(out.entryId);
          if (out.needsResolve) resolve.push(out.entryId);
        } catch (e) { errors.push({ index: i, error: e.message }); }
      });
      const upd = db.prepare('UPDATE reading_list_entries SET sort_order = ? WHERE id = ?');
      order.forEach((id, i) => upd.run(i + 1, id));
      touch(list.id);
    })();
    resolve.forEach(startResolve);
    logger.info('reading-lists', 'Applied proposed list', { listId: list.id, adds: plan.summary.adds.length, removes: plan.summary.removes.length, moved: plan.summary.moved, errors: errors.length });
    res.json({ ok: true, ...plan.summary, errors });
  }));

  // ── Outline for Comic Book Guy (the whole list, compact) ────────
  // Every entry has a position (1…n). Neighbouring single issues of the same
  // published series share a line ("14–21. Green Lantern (2005) #1–7, 9"),
  // positions following the issues in the order shown.
  function outline(listId) {
    const es = listEntries(listId);
    const ids = es.map(e => e.id);
    const lines = [];
    const compress = nums => {
      const out = []; let i = 0;
      while (i < nums.length) {
        let j = i; const f = k => parseFloat(nums[k]);
        while (j + 1 < nums.length && Number.isInteger(f(j)) && f(j + 1) === f(j) + 1 && /^\d+$/.test(nums[j + 1])) j++;
        out.push(j > i ? `${nums[i]}–${nums[j]}` : nums[i]); i = j + 1;
      }
      return out.join(', ');
    };
    let run = null;
    const flush = () => {
      if (!run) return;
      const miss = run.items.filter(x => !x.owned).map(x => x.n);
      lines.push(`${run.p1}${run.p2 > run.p1 ? `–${run.p2}` : ''}. ${run.name}${run.year ? ` (${run.year})` : ''} #${compress(run.items.map(x => x.n))}`
        + (miss.length === run.items.length ? ' (not in library)' : miss.length ? ` (missing #${compress(miss)})` : ''));
      run = null;
    };
    // The yellow annotation box under an entry, so Comic Book Guy can reword it.
    const noteLine = (e) => { if (e.note) lines.push(`   note: "${String(e.note).replace(/\s+/g, ' ').trim().slice(0, 300)}"`); };
    es.forEach((e, k) => {
      const p = k + 1;
      if (e.entry_type === 'issue' && e.note) {
        // An annotated single issue gets its own line so its note sits under it.
        flush();
        const li = firstIssue(e.id);
        lines.push(`${p}. ${li?.series_name || e.label || 'Issue'}${li?.volume_year ? ` (${li.volume_year})` : ''} #${li?.issue_number ?? '?'}${li?.scanned_book_id ? '' : ' (not in library)'}`);
        noteLine(e);
        return;
      }
      if (e.entry_type === 'issue') {
        const li = firstIssue(e.id);
        const name = li?.series_name || e.label || 'Issue', year = li?.volume_year || null, n = String(li?.issue_number ?? '?');
        const key = `${String(name).toLowerCase()}|${year || ''}`;
        if (run && run.key === key) { run.p2 = p; run.items.push({ n, owned: !!li?.scanned_book_id }); return; }
        flush();
        run = { key, name, year, p1: p, p2: p, items: [{ n, owned: !!li?.scanned_book_id }] };
        return;
      }
      flush();
      if (e.entry_type === 'section') { lines.push(`${p}. == ${e.label || 'Part'} ==`); noteLine(e); return; }
      const iss = entryIssues(e), own = iss.filter(i => i.scanned_book_id).length;
      if (e.entry_type === 'story') {
        const parts = iss.map(i => `${i.series_name || '?'}${i.volume_year ? ` (${i.volume_year})` : ''} #${i.issue_number ?? '?'}`);
        lines.push(`${p}. ${e.label} [story, one row: ${parts.join(', ')}; ${own} of ${iss.length} owned]`);
        noteLine(e);
        return;
      }
      const kind = { range: 'issues', series: 'whole series', event: 'Timeline event', canon_run: 'Top Shelf run' }[e.entry_type] || e.entry_type;
      lines.push(`${p}. ${e.label || kind} [${kind}${e.ref_id && (e.entry_type === 'event' || e.entry_type === 'canon_run') ? ` ${e.entry_type === 'event' ? 'event_id' : 'run_id'} ${e.ref_id}` : ''}; ${own} of ${iss.length} owned]`);
      noteLine(e);
    });
    flush();
    const l = db.prepare('SELECT updated_at FROM reading_lists WHERE id = ?').get(listId);
    return { lines, ids, count: es.length, version: l?.updated_at || null };
  }

  // ── Edits by position (Comic Book Guy's repairs to a long list) ──
  // ops: { op:'insert', after: entryId|null (top), entries:[bodies] }
  //      { op:'remove', entryId } · { op:'move', entryId, after: entryId|null }
  // Only what the ops name changes; every other entry is kept as it is.
  function planEdits(list, ops) {
    const ex = listEntries(list.id);
    const byId = new Map(ex.map(e => [e.id, e]));
    let seq = ex.map(e => ({ keep: e }));
    const idx = id => seq.findIndex(x => x.keep && x.keep.id === id);
    const removes = [], adds = [], moved = [], notes = [], labels = [];
    const missing = id => { const err = new Error('The list changed since he read it. Ask him again.'); err.status = 409; err.entryId = id; return err; };
    // Removes last, so an insert may still anchor on an entry being removed.
    const ordered = [...ops.filter(o => o.op !== 'remove'), ...ops.filter(o => o.op === 'remove')];
    for (const o of ordered) {
      const after = o.after == null || o.after === 0 ? null : toInt(o.after);
      if (after != null && !byId.has(after)) throw missing(after);
      const at = () => (after == null ? 0 : idx(after) + 1);
      if (o.op === 'remove') {
        const id = toInt(o.entryId), i = idx(id); if (i < 0) throw missing(id);
        removes.push(seq[i].keep); seq.splice(i, 1);
      } else if (o.op === 'move') {
        const id = toInt(o.entryId), i = idx(id); if (i < 0) throw missing(id);
        const [x] = seq.splice(i, 1); const j = at(); if (after != null && j === 0) throw missing(after);
        seq.splice(j, 0, x); moved.push(x.keep);
      } else if (o.op === 'note' || o.op === 'label') {
        // Reword an entry's annotation (note) or a section header (label); the
        // entry itself, its issues and its place stay as they are.
        const id = toInt(o.entryId); if (!byId.has(id)) throw missing(id);
        const text = str(o.text, o.op === 'note' ? 2000 : 300);
        if (o.op === 'label' && !text) continue;
        (o.op === 'note' ? notes : labels).push({ id, text, entry: byId.get(id) });
      } else if (o.op === 'insert') {
        const bodies = (Array.isArray(o.entries) ? o.entries : []).filter(b => b && typeof b === 'object').slice(0, 60);
        const j = at(); if (after != null && j === 0) throw missing(after);
        seq.splice(j, 0, ...bodies.map(b => ({ add: b })));
        adds.push(...bodies);
      }
    }
    const label = b => str(b.display, 300) || str(b.label, 300) || (b.type === 'range' && b.seriesName ? `${b.seriesName} #${b.issueStart}${b.issueEnd && b.issueEnd !== b.issueStart ? '–' + b.issueEnd : ''}` : b.type);
    return { seq, removes, summary: {
      adds: adds.filter(b => b.type !== 'section').map(label), sections_added: adds.filter(b => b.type === 'section').map(label),
      removes: removes.filter(e => e.entry_type !== 'section').map(e => e.label || e.entry_type),
      sections_removed: removes.filter(e => e.entry_type === 'section').map(e => e.label),
      kept: seq.filter(x => x.keep).length, moved: moved.length,
      notes_changed: notes.length, labels_changed: labels.length }, notes, labels };
  }

  app.post('/api/reading-lists/:id/edit', requireAuth, wrap((req, res) => {
    const list = loadForEdit(req);
    const ops = (Array.isArray(req.body?.ops) ? req.body.ops : []).slice(0, 150).filter(o => o && ['insert', 'remove', 'move', 'note', 'label'].includes(o.op));
    if (!ops.length) throw bad(400, 'No changes');
    if (req.body?.version && list.updated_at && req.body.version !== list.updated_at) throw bad(409, 'The list changed since he read it. Ask him again.');
    let plan;
    try { plan = planEdits(list, ops); } catch (e) { throw bad(e.status || 400, e.message); }
    if (req.body?.dryRun) return res.json({ dryRun: true, ...plan.summary });
    const errors = [], resolve = [];
    db.transaction(() => {
      for (const e of plan.removes) deleteEntryRows(e.id);
      const order = [];
      plan.seq.forEach((x, i) => {
        if (x.keep) { order.push(x.keep.id); return; }
        try {
          const { display, missing, owned, position, ...body } = x.add;
          const out = insertEntry(list, body);
          order.push(out.entryId);
          if (out.needsResolve) resolve.push(out.entryId);
        } catch (e) { errors.push({ index: i, error: e.message }); }
      });
      const upd = db.prepare('UPDATE reading_list_entries SET sort_order = ? WHERE id = ?');
      order.forEach((id, i) => upd.run(i + 1, id));
      const setNote = db.prepare('UPDATE reading_list_entries SET note = ? WHERE id = ? AND list_id = ?');
      const setLabel = db.prepare('UPDATE reading_list_entries SET label = ? WHERE id = ? AND list_id = ?');
      for (const n of plan.notes) setNote.run(n.text, n.id, list.id);
      for (const l of plan.labels) setLabel.run(l.text, l.id, list.id);
      touch(list.id);
    })();
    resolve.forEach(startResolve);
    logger.info('reading-lists', 'Applied list edits', { listId: list.id, adds: plan.summary.adds.length, removes: plan.summary.removes.length, moved: plan.summary.moved, notes: plan.summary.notes_changed, labels: plan.summary.labels_changed, errors: errors.length });
    res.json({ ok: true, ...plan.summary, errors });
  }));

  // ── Editor save (shared list editor; claude/ADMIN_REORG.md) ─────
  // The editor keeps a draft and saves it here in one transaction.
  //   { version, order: [item…], remove: [entryId], notes, labels, tiers }
  // order items:
  //   entryId                         existing entry, issues unchanged
  //   { id, label?, note?, tier?, unpack?, issues?: [listIssueId] }
  //                                   existing entry; `issues` re-describes a
  //                                   crossover / own-copy entry (order, issues
  //                                   moved in from other entries, removals)
  //   { add: { type:'section', label, note } }
  //   { add: { type:'story', label, note }, members: [{entry:id} | {li:id}] }
  //                                   new crossover from whole entries (their
  //                                   issues are copied in) and/or single issues
  //   { add: { type:'issue' }, members: [{li:id}] }   an issue taken out of an entry
  // Checks: every existing entry is accounted for exactly once (kept, removed
  // or combined into a new crossover); a single issue can be moved only out of
  // an entry the draft also re-describes (or removes); stale versions refused.
  app.post('/api/reading-lists/:id/save', requireAuth, wrap((req, res) => {
    const list = loadForEdit(req);
    const b = req.body || {};
    if (b.version && list.updated_at && b.version !== list.updated_at)
      return res.status(409).json({ conflict: true, error: 'This list was changed somewhere else after you opened the editor. Your draft is kept; reload to see the other changes.' });
    const order = Array.isArray(b.order) ? b.order : null;
    if (!order) throw bad(400, 'order is required');
    const details = b.details && typeof b.details === 'object' ? nextDetails(list, b.details, req) : null;   // checked before anything changes
    if (order.length > MAX_ENTRIES) throw bad(400, `A list can hold at most ${MAX_ENTRIES} entries`);
    // A draft that no longer fits the list is refused; the log says which check failed (2026-11-10).
    const stale = (msg, info) => {
      logger.warn('reading-lists', 'Editor save refused: draft out of step', { listId: list.id, by: uid(req), ...info });
      return bad(409, msg || "The editor's copy is out of step with the list. Reload the editor.");
    };
    const ex = listEntries(list.id), byId = new Map(ex.map(e => [e.id, e]));
    const items = order.map(x => (x && typeof x === 'object') ? x : { id: x });
    const keptIds = items.filter(x => x.id != null).map(x => toInt(x.id));
    const removeIds = (Array.isArray(b.remove) ? b.remove : []).map(toInt);
    const consumed = items.filter(x => x.add).flatMap(x => (Array.isArray(x.members) ? x.members : []).filter(m => m.entry != null).map(m => toInt(m.entry)));
    const all = [...keptIds, ...removeIds, ...consumed];
    if (new Set(all).size !== all.length || !sameIdSet(all, ex.map(e => e.id))) {
      const have = new Set(ex.map(e => e.id)), seen = new Set();
      const twice = all.filter(id => (seen.has(id) ? true : (seen.add(id), false)));
      const gone = all.filter(id => !have.has(id)), missing = [...have].filter(id => !all.includes(id));
      throw stale(gone.length ? 'An entry in the draft is no longer in the list (removed somewhere else). Reload the editor.'
        : missing.length ? 'The list has an entry the editor does not show (added somewhere else). Reload the editor.'
        : null, { check: 'entries', gone, missing, twice });
    }
    for (const id of consumed) if (byId.get(id).entry_type === 'section') throw bad(400, 'Section banners cannot go in a crossover');
    // Entries whose issues the draft re-describes.
    const described = new Map();   // entryId -> [li ids]
    for (const x of items) if (x.id != null && Array.isArray(x.issues)) {
      const e = byId.get(toInt(x.id));
      if (isLinked(e) && !e.unpacked) throw bad(400, `Save "${e.label}" as its own copy first; then its issues can be edited`);
      if (!(e.entry_type === 'story' || e.entry_type === 'issue' || e.unpacked || x.unpack)) throw bad(400, `"${e.label}" refreshes on its own; make it your own copy to edit its issues`);
      described.set(e.id, x.issues.map(toInt));
    }
    // Every single-issue reference: unique, from this list, out of a described or removed entry.
    const liOwner = db.prepare('SELECT owner_id FROM list_issues WHERE id = ? AND owner_kind = ?');
    const refs = [...[...described.values()].flat(), ...items.filter(x => x.add).flatMap(x => (x.members || []).filter(m => m.li != null).map(m => toInt(m.li)))];
    if (new Set(refs).size !== refs.length) throw stale('An issue appears twice in the draft. Reload the editor.', { check: 'issue twice' });
    const ownerOf = new Map();
    for (const li of refs) {
      const o = liOwner.get(li, OWNER_KIND)?.owner_id;
      if (o == null) throw stale('An issue in the draft is no longer in the list (its entry\'s issue list was fetched again). Reload the editor.', { check: 'issue gone', li });
      if (!byId.has(o)) throw stale('An issue in the draft belongs to another list. Reload the editor.', { check: 'issue elsewhere', li, owner: o });
      if (!described.has(o) && !removeIds.includes(o)) throw stale(null, { check: 'issue moved from an entry the draft does not describe', li, owner: o });
      ownerOf.set(li, o);
    }
    // New crossovers made in the editor carry members; a story added from the
    // Add window carries add.issues instead (checked by insertEntry).
    for (const x of items) if (x.add?.type === 'story' && Array.isArray(x.members)) {
      if (!str(x.add.label, 300)) throw bad(400, 'Name the crossover');
      if (!x.members.length) throw bad(400, 'A crossover needs issues');
    }
    const keyed = o => Object.entries(o && typeof o === 'object' ? o : {}).map(([k, v]) => ({ id: toInt(k), v })).filter(z => keptIds.includes(z.id));
    const notes = [...keyed(b.notes), ...items.filter(x => x.id != null && x.note !== undefined).map(x => ({ id: toInt(x.id), v: x.note }))];
    const labels = [...keyed(b.labels), ...items.filter(x => x.id != null && x.label !== undefined).map(x => ({ id: toInt(x.id), v: x.label }))];
    const tiers = [...keyed(b.tiers), ...items.filter(x => x.id != null && x.tier !== undefined).map(x => ({ id: toInt(x.id), v: x.tier }))];
    for (const t of tiers) if (!TIER_FILTERS.includes(t.v)) throw bad(400, 'tier filter must be essential, recommended or all');

    const errors = [], resolve = [];
    let stats = { added: 0, crossovers: 0, moved: 0 };
    db.transaction(() => {
      const moveLi = db.prepare('UPDATE list_issues SET owner_id = ?, sort_order = ? WHERE id = ? AND owner_kind = ?');
      const newEntry = db.prepare(`INSERT INTO reading_list_entries (list_id, sort_order, entry_type, label, note, unpacked, resolve_status, resolve_source)
        VALUES (?, 0, ?, ?, ?, 1, 'ok', ?)`);
      // 1. Own copies (unpack) before anything moves.
      for (const x of items) if (x.id != null && x.unpack) {
        const e = byId.get(toInt(x.id));
        if (e.unpacked || ['issue', 'section', 'story'].includes(e.entry_type)) continue;
        if (isLinked(e)) insertIssueRows(e.id, linkedIssues(e).map(i => ({ ...i, manually_matched: 0 })));
        // An entry still fetching its issue list stops waiting: it is the user's copy now.
        db.prepare("UPDATE reading_list_entries SET unpacked = 1, resolve_status = CASE WHEN resolve_status = 'pending' THEN 'ok' ELSE resolve_status END WHERE id = ?").run(e.id);
      }
      // 2. New entries; moved issues change owner, whole entries are copied in.
      const ids = [];
      const keepLis = new Set();
      items.forEach((x, i) => {
        if (x.id != null) { ids.push(toInt(x.id)); return; }
        const a = x.add || {};
        try {
          if ((a.type === 'story' || a.type === 'issue') && Array.isArray(x.members)) {
            const mem = x.members;
            const first = mem.find(m => m.li != null) ? db.prepare('SELECT * FROM list_issues WHERE id = ?').get(toInt(mem.find(m => m.li != null).li)) : null;
            const label = a.type === 'story' ? str(a.label, 300)
              : defaultLabel('issue', { seriesName: first?.series_name, year: first?.volume_year, number: first?.issue_number });
            const eid = Number(newEntry.run(list.id, a.type, label, str(a.note, 2000), a.type === 'story' ? 'story' : 'editor').lastInsertRowid);
            let k = 0;
            for (const m of mem) {
              if (m.li != null) { moveLi.run(eid, ++k, toInt(m.li), OWNER_KIND); keepLis.add(toInt(m.li)); stats.moved++; }
              else {
                const rows = rawIssues(byId.get(toInt(m.entry)));
                const ins = db.prepare(`INSERT INTO list_issues (owner_kind, owner_id, sort_order, cv_issue_id, scanned_book_id, scanned_series_id,
                  series_name, issue_number, issue_title, volume_year, manually_matched) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
                for (const r of rows) ins.run(OWNER_KIND, eid, ++k, r.cv_issue_id || null, r.scanned_book_id || null, r.scanned_series_id || null,
                  r.series_name || null, numStr(r.issue_number), r.issue_title || null, toInt(r.volume_year), r.manually_matched ? 1 : 0);
              }
            }
            if (a.type === 'story') stats.crossovers++;
            ids.push(eid); stats.added++;
          } else {
            const { display, missing, owned, position, ...body } = a;
            const out = insertEntry(list, body);
            ids.push(out.entryId); stats.added++;
            if (out.needsResolve) resolve.push(out.entryId);
            // A Timeline event added from the Add window: its tie-in filter.
            const tf = x.tier || a.tier;
            if (a.type === 'event' && TIER_FILTERS.includes(tf)) db.prepare('UPDATE reading_list_entries SET tier_filter = ? WHERE id = ?').run(tf, out.entryId);
          }
        } catch (e) { errors.push({ index: i, error: e.message }); }
      });
      // 3. Re-described entries: their issues in the new order.
      for (const [eid, lis] of described) lis.forEach((li, k) => { moveLi.run(eid, k + 1, li, OWNER_KIND); keepLis.add(li); if (ownerOf.get(li) !== eid) stats.moved++; });
      // 4. Removed and combined entries go (issues moved out of them already have a new owner).
      for (const id of [...removeIds, ...consumed]) deleteEntryRows(id);
      // 5. Issues a re-described entry no longer lists are removed; entries left empty go.
      for (const eid of described.keys()) {
        for (const r of db.prepare('SELECT id FROM list_issues WHERE owner_kind = ? AND owner_id = ?').all(OWNER_KIND, eid))
          if (!keepLis.has(r.id)) db.prepare('DELETE FROM list_issues WHERE id = ?').run(r.id);
        if (!db.prepare('SELECT 1 FROM list_issues WHERE owner_kind = ? AND owner_id = ?').get(OWNER_KIND, eid)) {
          deleteEntryRows(eid); const j = ids.indexOf(eid); if (j >= 0) ids.splice(j, 1);
        }
      }
      const upd = db.prepare('UPDATE reading_list_entries SET sort_order = ? WHERE id = ?');
      ids.forEach((id, i) => upd.run(i + 1, id));
      const setNote = db.prepare('UPDATE reading_list_entries SET note = ? WHERE id = ? AND list_id = ?');
      const setLabel = db.prepare('UPDATE reading_list_entries SET label = ? WHERE id = ? AND list_id = ?');
      const setTier = db.prepare("UPDATE reading_list_entries SET tier_filter = ? WHERE id = ? AND list_id = ? AND entry_type = 'event'");
      for (const n of notes) setNote.run(str(n.v, 2000), n.id, list.id);
      for (const l of labels) { const t = str(l.v, 300); if (t) setLabel.run(t, l.id, list.id); }
      for (const t of tiers) setTier.run(t.v, t.id, list.id);
      if (details) writeDetails(list, details);
      touch(list.id);
    })();
    resolve.forEach(startResolve);
    const version = db.prepare('SELECT updated_at FROM reading_lists WHERE id = ?').get(list.id)?.updated_at || null;
    logger.info('reading-lists', 'Editor saved', { listId: list.id, entries: order.length, removed: removeIds.length, combined: consumed.length, ...stats, errors: errors.length, by: uid(req) });
    res.json({ ok: true, version, errors });
  }));

  collectionRegistry.migrate(catalogOf);
  collectionRegistry.register(app, requireAuth);

  // Section names already in use on lists this user can see (suggestions for the Details panel).
  app.get('/api/reading-lists/groups', requireAuth, wrap((req, res) => {
    const rows = db.prepare(`SELECT catalog_json FROM reading_lists WHERE catalog_json IS NOT NULL AND (visibility IN ('public','essential') OR owner_id = ?)`).all(uid(req));
    const names = new Map();
    for (const r of rows) { let c = {}; try { c = JSON.parse(r.catalog_json) || {}; } catch {} for (const g of [...(c.collections || []), ...(c.group ? [c.group] : []), ...(c.by_publisher ? c.publishers || [] : [])]) { if (typeof g === 'string' && g.trim() && !names.has(g.toLowerCase())) names.set(g.toLowerCase(), g.trim()); } }
    res.json({ collections: collectionRegistry.all(), groups: [...names.values()].map(v => collectionRegistry.find(v)?.name || v).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })) });
  }));
  app.get('/api/reading-lists/containing/:bookId', requireAuth, wrap((req, res) => {
    const rows = db.prepare(`SELECT DISTINCT rl.id, rl.name FROM reading_lists rl
      JOIN reading_list_entries e ON e.list_id = rl.id
      JOIN list_issues li ON li.owner_kind = ? AND li.owner_id = e.id
      WHERE rl.owner_id = ? AND li.scanned_book_id = ?`).all(OWNER_KIND, uid(req), String(req.params.bookId));
    res.json({ lists: rows });
  }));

  app.get('/api/reading-lists/:id', requireAuth, wrap((req, res) => {
    const list = loadForView(req);
    const me = uid(req);
    const entries = listEntries(list.id);
    const ids = [];
    for (const e of entries) for (const i of entryIssues(e)) ids.push(i.scanned_book_id);
    const pm = progressMap(ids, me), bm = bookMap(ids);
    const detail = entries.map(e => entryDetail(e, pm, bm));
    const progress = detail.reduce((a, e) => ({ total: a.total + e.progress.total, owned: a.owned + e.progress.owned, read: a.read + e.progress.read }),
      { total: 0, owned: 0, read: 0 });
    const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(list.owner_id);
    res.json({
      list: listSummary({ ...list, owner_name: owner?.username || null, entry_count: entries.filter(e => e.entry_type !== 'section').length }, me),
      can_edit: canEdit(list, req.user), progress, entries: detail,
    });
  }));

  // A list's details (name, description, visibility, cover) after applying b; throws on a bad change.
  // Used by PATCH and by the editor's Save (b.details).
  function nextDetails(list, b, req) {
    const home = require('./homepageFields').changes(b);
    if (Object.keys(home).length && !isAdmin(req)) throw bad(403, 'Only admins can change homepage text');
    const next = { home_tagline:list.home_tagline, home_description:list.home_description, ...home, name: list.name, description: list.description, visibility: list.visibility, cover_image: list.cover_image, catalog_json: list.catalog_json || null };
    if (b.catalog !== undefined) { let previous = {}; try { previous = JSON.parse(list.catalog_json || '{}'); } catch {} next.catalog_json = validateCatalog(b.catalog, req, previous); }
    // The editor's Details panel sets the catalog section through two flat fields.
    if (b.catalog_collections !== undefined || b.catalog_group !== undefined || b.catalog_by_publisher !== undefined) {
      let current = {}; try { current = JSON.parse(next.catalog_json || '{}') || {}; } catch {}
      const patch = { ...current };
      if (b.catalog_collections !== undefined) patch.collections = b.catalog_collections;
      if (b.catalog_group !== undefined) patch.group = b.catalog_group == null ? '' : b.catalog_group;
      if (b.catalog_by_publisher !== undefined) patch.by_publisher = !!b.catalog_by_publisher;
      next.catalog_json = validateCatalog(patch, req, current);
    }
    if (b.name !== undefined) { next.name = str(b.name, 200); if (!next.name) throw bad(400, 'Name required'); }
    if (b.description !== undefined) next.description = str(b.description, 4000);
    if (b.cover_image !== undefined) next.cover_image = str(b.cover_image, 1000);
    if (b.visibility !== undefined && b.visibility !== list.visibility) {
      if (!VISIBILITY.has(b.visibility)) throw bad(400, 'Unknown visibility');
      if ((b.visibility === 'essential' || list.visibility === 'essential') && !isAdmin(req)) throw bad(403, 'Only the admin can change Essentials lists');
      if (b.visibility === 'private' && list.owner_id !== uid(req)) throw bad(403, 'Only the owner can make a list private');
      next.visibility = b.visibility;
    }
    return next;
  }
  const writeDetails = (list, next) => db.prepare(`UPDATE reading_lists SET name = ?, description = ?, visibility = ?, cover_image = ?, catalog_json = ?, home_tagline = ?, home_description = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(next.name, next.description, next.visibility, next.cover_image, next.catalog_json, next.home_tagline || null, next.home_description || null, list.id);
  app.patch('/api/reading-lists/:id', requireAuth, wrap((req, res) => {
    const list = loadForEdit(req);
    const next = nextDetails(list, req.body || {}, req);
    writeDetails(list, next);
    // No longer shared: it leaves its followers' boxes, as a series box does (2026-11-04).
    if (list.visibility === 'public' && next.visibility === 'private') db.prepare('DELETE FROM reading_list_follows WHERE list_id = ?').run(list.id);
    res.json({ ok: true });
  }));

  app.delete('/api/reading-lists/:id', requireAuth, wrap((req, res) => {
    const list = loadForEdit(req);
    if (list.visibility === 'essential' && !isAdmin(req)) throw bad(403, 'Only admins can delete Essentials');
    db.transaction(() => {
      for (const e of listEntries(list.id)) deleteEntryRows(e.id);
      db.prepare('DELETE FROM reading_list_follows WHERE list_id = ?').run(list.id);
      db.prepare('DELETE FROM reading_lists WHERE id = ?').run(list.id);
    })();
    res.json({ ok: true });
  }));

  // Copy: a private, editable copy for the caller. Linked entries stay linked.
  app.post('/api/reading-lists/:id/copy', requireAuth, wrap((req, res) => {
    const list = loadForView(req);
    let newId;
    db.transaction(() => {
      const name = str(req.body?.name, 200) || (list.owner_id === uid(req) ? `${list.name} (copy)` : list.name);
      newId = Number(db.prepare(`INSERT INTO reading_lists (name, description, owner_id, visibility, cover_image, source, copied_from)
        VALUES (?,?,?,'private',?,?,?)`).run(name, list.description, uid(req), list.cover_image, list.source, list.id).lastInsertRowid);
      if (list.catalog_json) { const c = JSON.parse(list.catalog_json); c.featured = false; db.prepare('UPDATE reading_lists SET catalog_json = ? WHERE id = ?').run(JSON.stringify(c), newId); }
      const insE = db.prepare(`INSERT INTO reading_list_entries (list_id, sort_order, entry_type, ref_id, cv_volume_id, scanned_series_id,
        issue_start, issue_end, label, note, unpacked, resolve_status, resolve_source, resolved_at, tier_filter) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const copyRows = db.prepare(`INSERT INTO list_issues (owner_kind, owner_id, sort_order, cv_issue_id, scanned_book_id, scanned_series_id,
          series_name, issue_number, issue_title, volume_year, cover_date, manually_matched)
        SELECT owner_kind, ?, sort_order, cv_issue_id, scanned_book_id, scanned_series_id, series_name, issue_number, issue_title,
          volume_year, cover_date, manually_matched FROM list_issues WHERE owner_kind = ? AND owner_id = ?`);
      for (const e of listEntries(list.id)) {
        const eid = Number(insE.run(newId, e.sort_order, e.entry_type, e.ref_id, e.cv_volume_id, e.scanned_series_id, e.issue_start, e.issue_end,
          e.label, e.note, e.unpacked, e.resolve_status, e.resolve_source, e.resolved_at, e.tier_filter).lastInsertRowid);
        copyRows.run(eid, OWNER_KIND, e.id);
      }
    })();
    res.status(201).json({ id: newId });
  }));

  // Follow: a live link to someone else's public list; progress is the follower's own.
  app.post('/api/reading-lists/:id/follow', requireAuth, wrap((req, res) => {
    const list = loadForView(req);
    if (list.owner_id === uid(req)) throw bad(400, 'You own this list');
    if (list.visibility === 'essential') throw bad(400, 'Essentials are already on everyone\'s menu. Copy it to make your own version.');
    db.prepare('INSERT OR IGNORE INTO reading_list_follows (user_id, list_id) VALUES (?, ?)').run(uid(req), list.id);
    res.json({ ok: true, following: true });
  }));
  app.delete('/api/reading-lists/:id/follow', requireAuth, wrap((req, res) => {
    db.prepare('DELETE FROM reading_list_follows WHERE user_id = ? AND list_id = ?').run(uid(req), toInt(req.params.id));
    res.json({ ok: true, following: false });
  }));

  app.post('/api/reading-lists/:id/entries', requireAuth, wrap((req, res) => {
    const list = loadForEdit(req);
    const out = insertEntry(list, req.body || {});
    if (out.needsResolve) startResolve(out.entryId);
    res.status(201).json({ id: out.entryId, pending: out.needsResolve, duplicate: out.duplicate });
  }));

  app.patch('/api/reading-lists/:id/entries/:entryId', requireAuth, wrap((req, res) => {
    const list = loadForEdit(req);
    const e = getEntry(list.id, req.params.entryId); if (!e) throw bad(404, 'Entry not found');
    const b = req.body || {};
    let tierFilter = e.tier_filter;
    if (b.tier_filter !== undefined) {
      if (e.entry_type !== 'event') throw bad(400, 'Only Timeline entries have a tier filter');
      if (!TIER_FILTERS.includes(b.tier_filter)) throw bad(400, 'tier_filter must be essential, recommended or all');
      tierFilter = b.tier_filter;
    }
    db.prepare('UPDATE reading_list_entries SET label = ?, note = ?, tier_filter = ? WHERE id = ?')
      .run(b.label !== undefined ? (str(b.label, 300) || e.label) : e.label, b.note !== undefined ? str(b.note, 2000) : e.note, tierFilter, e.id);
    touch(list.id);
    res.json({ ok: true });
  }));

  app.delete('/api/reading-lists/:id/entries/:entryId', requireAuth, wrap((req, res) => {
    const list = loadForEdit(req);
    const e = getEntry(list.id, req.params.entryId); if (!e) throw bad(404, 'Entry not found');
    db.transaction(() => { deleteEntryRows(e.id); touch(list.id); })();
    res.json({ ok: true });
  }));

  // Reorder entries: { entryIds: [...] } naming every entry once.
  app.put('/api/reading-lists/:id/order', requireAuth, wrap((req, res) => {
    const list = loadForEdit(req);
    const ids = (Array.isArray(req.body?.entryIds) ? req.body.entryIds : []).map(toInt);
    if (!sameIdSet(ids, listEntries(list.id).map(e => e.id))) throw bad(400, 'entryIds must list every entry exactly once');
    const upd = db.prepare('UPDATE reading_list_entries SET sort_order = ? WHERE id = ?');
    db.transaction(() => { ids.forEach((id, i) => upd.run(i + 1, id)); touch(list.id); })();
    res.json({ ok: true });
  }));

  // Unpack: event/Top Shelf → copy its issues into the list; series/range → freeze (no refresh).
  app.post('/api/reading-lists/:id/entries/:entryId/unpack', requireAuth, wrap((req, res) => {
    const list = loadForEdit(req);
    const e = getEntry(list.id, req.params.entryId); if (!e) throw bad(404, 'Entry not found');
    if (e.entry_type === 'issue' || e.entry_type === 'section' || e.entry_type === 'story') throw bad(400, 'This entry is already editable');
    if (e.unpacked) return res.json({ ok: true });
    db.transaction(() => {
      if (isLinked(e)) {
        const ins = db.prepare(`INSERT INTO list_issues (owner_kind, owner_id, sort_order, cv_issue_id, scanned_book_id, series_name,
          issue_number, issue_title, volume_year, manually_matched) VALUES (?,?,?,?,?,?,?,?,?,0)`);
        linkedIssues(e).forEach((i, idx) => ins.run(OWNER_KIND, e.id, idx + 1, i.cv_issue_id || null, i.scanned_book_id || null,
          i.series_name || null, numStr(i.issue_number), i.issue_title || null, toInt(i.volume_year)));
      }
      db.prepare("UPDATE reading_list_entries SET unpacked = 1, resolve_status = CASE WHEN resolve_status = 'pending' THEN 'ok' ELSE resolve_status END WHERE id = ?").run(e.id);
      touch(list.id);
    })();
    res.json({ ok: true });
  }));

  // Combine neighbouring entries into one story row (a short crossover such as
  // Green Lantern: Uprising, GL #31-33 and GL Corps #31-34). Issues keep the
  // list order; the story takes the first entry's place.
  app.post('/api/reading-lists/:id/entries/combine', requireAuth, wrap((req, res) => {
    const list = loadForEdit(req);
    const label = str(req.body?.label, 300);
    if (!label) throw bad(400, 'Name the story');
    const ids = new Set((Array.isArray(req.body?.entryIds) ? req.body.entryIds : []).map(toInt).filter(Boolean));
    const chosen = listEntries(list.id).filter(e => ids.has(e.id));
    if (chosen.length < 2 || chosen.length !== ids.size) throw bad(400, 'Select two or more entries in this list');
    if (chosen.some(e => e.entry_type === 'section')) throw bad(400, 'Section banners cannot go in a story');
    const rows = chosen.flatMap(rawIssues);
    if (!rows.length) throw bad(400, 'Those entries have no issues yet');
    if (rows.length > MAX_NAMED_ISSUES) throw bad(400, `At most ${MAX_NAMED_ISSUES} issues in a story`);
    const note = chosen.map(e => e.note).filter(Boolean).join(' ').slice(0, 2000) || null;
    let entryId;
    db.transaction(() => {
      entryId = Number(db.prepare(`INSERT INTO reading_list_entries (list_id, sort_order, entry_type, label, note, unpacked, resolve_status, resolve_source)
        VALUES (?,?,'story',?,?,1,'ok','story')`).run(list.id, chosen[0].sort_order, label, note).lastInsertRowid);
      insertIssueRows(entryId, rows);
      for (const e of chosen) deleteEntryRows(e.id);
      renumber(list.id);
      touch(list.id);
    })();
    res.json({ ok: true, entryId, issues: rows.length });
  }));

  // Split a story back into single-issue rows, in place.
  app.post('/api/reading-lists/:id/entries/:entryId/split', requireAuth, wrap((req, res) => {
    const list = loadForEdit(req);
    const e = getEntry(list.id, req.params.entryId); if (!e) throw bad(404, 'Entry not found');
    if (e.entry_type !== 'story') throw bad(400, 'Only story rows can be split');
    const rows = rawIssues(e);
    db.transaction(() => {
      const insE = db.prepare(`INSERT INTO reading_list_entries (list_id, sort_order, entry_type, label, note, unpacked, resolve_status)
        VALUES (?,?,'issue',?,?,0,'ok')`);
      rows.forEach((r, k) => {
        const id = Number(insE.run(list.id, e.sort_order + (k + 1) / 1000,
          defaultLabel('issue', { seriesName: r.series_name, year: r.volume_year, number: r.issue_number }), k === 0 ? e.note : null).lastInsertRowid);
        insertIssueRows(id, [r]);
      });
      deleteEntryRows(e.id);
      renumber(list.id);
      touch(list.id);
    })();
    res.json({ ok: true, entries: rows.length });
  }));

  app.post('/api/reading-lists/:id/entries/:entryId/refresh', requireAuth, wrap((req, res) => {
    const list = loadForEdit(req);
    const e = getEntry(list.id, req.params.entryId); if (!e) throw bad(404, 'Entry not found');
    if (e.unpacked || !(e.entry_type === 'series' || e.entry_type === 'range')) throw bad(400, 'This entry does not refresh');
    db.prepare(`UPDATE reading_list_entries SET resolve_status = 'pending' WHERE id = ?`).run(e.id);
    startResolve(e.id);
    res.json({ ok: true, pending: true });
  }));

  // Issue-level edits — only inside unpacked entries (single-issue entries: remove the entry).
  function loadIssue(list, issueId) {
    return db.prepare(`SELECT li.*, e.unpacked, e.entry_type, e.id AS entry_id FROM list_issues li
      JOIN reading_list_entries e ON e.id = li.owner_id
      WHERE li.owner_kind = ? AND li.id = ? AND e.list_id = ?`).get(OWNER_KIND, toInt(issueId), list.id);
  }
  app.delete('/api/reading-lists/:id/issues/:issueId', requireAuth, wrap((req, res) => {
    const list = loadForEdit(req);
    const li = loadIssue(list, req.params.issueId); if (!li) throw bad(404, 'Issue not found');
    if (li.entry_type === 'issue') {
      db.transaction(() => { deleteEntryRows(li.entry_id); touch(list.id); })();
      return res.json({ ok: true, entryRemoved: true });
    }
    if (!li.unpacked) throw bad(400, 'Unpack this entry before removing single issues');
    db.prepare('DELETE FROM list_issues WHERE id = ?').run(li.id); touch(list.id);
    res.json({ ok: true });
  }));
  app.put('/api/reading-lists/:id/entries/:entryId/issue-order', requireAuth, wrap((req, res) => {
    const list = loadForEdit(req);
    const e = getEntry(list.id, req.params.entryId); if (!e) throw bad(404, 'Entry not found');
    if (!e.unpacked) throw bad(400, 'Unpack this entry before reordering its issues');
    const ids = (Array.isArray(req.body?.issueIds) ? req.body.issueIds : []).map(toInt);
    const have = db.prepare('SELECT id FROM list_issues WHERE owner_kind = ? AND owner_id = ?').all(OWNER_KIND, e.id).map(r => r.id);
    if (!sameIdSet(ids, have)) throw bad(400, 'issueIds must list every issue exactly once');
    const upd = db.prepare('UPDATE list_issues SET sort_order = ? WHERE id = ?');
    db.transaction(() => { ids.forEach((id, i) => upd.run(i + 1, id)); touch(list.id); })();
    res.json({ ok: true });
  }));
  // Manual match on a stored issue: { bookId } to set, { bookId: null } to clear.
  app.patch('/api/reading-lists/:id/issues/:issueId/match', requireAuth, wrap((req, res) => {
    const list = loadForEdit(req);
    const li = loadIssue(list, req.params.issueId); if (!li) throw bad(404, 'Issue not found');
    const bookId = req.body?.bookId ? String(req.body.bookId) : null;
    if (bookId && !db.prepare('SELECT 1 FROM scanned_books WHERE id = ?').get(bookId)) throw bad(404, 'Book not found');
    db.prepare('UPDATE list_issues SET scanned_book_id = ?, manually_matched = ? WHERE id = ?').run(bookId, bookId ? 1 : 0, li.id);
    // syncCv (the shared editor's Confirm match): take the comic's Comic Vine id too.
    let cv = null;
    if (bookId && req.body?.syncCv) {
      const r = db.prepare('SELECT cv_issue_id FROM scanned_books WHERE id = ?').get(bookId);
      cv = r?.cv_issue_id || null;
      if (!cv) { try { cv = db.prepare('SELECT cv_issue_id FROM book_ci_index WHERE book_id = ?').get(bookId)?.cv_issue_id || null; } catch {} }
      if (cv) db.prepare('UPDATE list_issues SET cv_issue_id = ? WHERE id = ?').run(String(cv), li.id);
    }
    res.json({ ok: true, cv_issue_id: cv });
  }));

  // Missing issue → Download Manager (or a request to the admin), from the
  // Find modal when nothing in the library matches. Any viewer of the list.
  const acquire = deps.acquire || null;
  app.get('/api/reading-lists/:id/issues/:issueId/acquire', requireAuth, wrap(async (req, res) => {
    if (!acquire) throw bad(404, 'Not available');
    const list = loadForView(req);
    const li = loadIssue(list, req.params.issueId); if (!li) throw bad(404, 'Issue not found');
    res.json(acquire.infoWithPlan ? await acquire.infoWithPlan('list', li, req.user) : acquire.info(li, req.user));
  }));
  app.post('/api/reading-lists/:id/issues/:issueId/request', requireAuth, wrap((req, res) => {
    if (!acquire) throw bad(404, 'Not available');
    const list = loadForView(req);
    const li = loadIssue(list, req.params.issueId); if (!li) throw bad(404, 'Issue not found');
    if (li.scanned_book_id) throw bad(400, 'This issue is already in the library');
    res.json(acquire.request(li, list, req.user));
  }));
  app.get('/api/reading-lists/:id/requests', requireAuth, wrap((req, res) => {
    const list = loadForView(req);
    res.json(acquire ? acquire.mineForList(list.id, uid(req)) : {});
  }));

  // ── Reader navigation ───────────────────────────────────────────
  // prev/next owned issue around bookId, in list order. null = no access.
  function adjacent(listId, bookId, user) {
    const list = getList(listId);
    if (!list || !canView(list, user)) return null;
    const flat = [];
    const all = [];   // every stop, owned or not, for "Stop N of M"
    for (const e of listEntries(list.id)) for (const i of entryIssues(e)) { all.push(i); if (i.scanned_book_id) flat.push(i); }
    const bm = bookMap(flat.map(i => i.scanned_book_id));
    const owned = flat.filter(i => bm.has(i.scanned_book_id));
    const idx = owned.findIndex(i => i.scanned_book_id === bookId);
    const stop = all.findIndex(i => i.scanned_book_id === bookId);
    const where = { listName: list.name, position: stop === -1 ? null : stop + 1, total: all.length };
    if (idx === -1) return { prev: null, next: null, ...where };
    const fmt = i => i ? {
      id: i.scanned_book_id, title: i.issue_title || bm.get(i.scanned_book_id)?.title || `${i.series_name} #${i.issue_number}`,
      series_name: i.series_name, issue_number: i.issue_number,
    } : null;
    return { prev: fmt(owned[idx - 1]), next: fmt(owned[idx + 1]), ...where };
  }

  // Owned books in list order (recaps: everything before the reader's place). null = no access.
  function orderedBooks(listId, user) {
    const list = getList(listId);
    if (!list || !canView(list, user)) return null;
    const flat = [];
    for (const e of listEntries(list.id)) for (const i of entryIssues(e)) if (i.scanned_book_id) flat.push(i.scanned_book_id);
    const bm = bookMap(flat);
    return [...new Set(flat.filter(id => bm.has(id)))];
  }

  // ── Nightly refresh ─────────────────────────────────────────────
  // Monitored-sourced entries: every night (no CV calls). Comic Vine-sourced:
  // weekly. Partial / error / pending: every night. At most
  // CV_VOLUMES_PER_RUN distinct Comic Vine volumes per run.
  let refreshing = false;
  async function refreshAll(trigger = 'scheduled') {
    if (refreshing) return { skipped: 'already running' };
    refreshing = true;
    const stats = { trigger, entries: 0, refreshed: 0, skippedFresh: 0, skippedCap: 0, cvVolumes: 0, errors: 0 };
    try {
      const entries = db.prepare(`SELECT * FROM reading_list_entries WHERE unpacked = 0 AND entry_type IN ('series','range') ORDER BY id`).all();
      stats.entries = entries.length;
      const cvSeen = new Set();
      const weekAgo = Date.now() - CV_REFRESH_DAYS * 864e5;
      for (const e of entries) {
        const ss = e.scanned_series_id ? db.prepare('SELECT * FROM scanned_series WHERE id = ?').get(e.scanned_series_id) : null;
        const vid = e.cv_volume_id || comicIdOf(ss);
        const usesCv = !!vid && !monitoredFor(ss, vid);
        if (usesCv) {
          const fresh = e.resolve_status === 'ok' && e.resolved_at && Date.parse(e.resolved_at.replace(' ', 'T') + 'Z') > weekAgo;
          if (fresh) { stats.skippedFresh++; continue; }
          if (!cvSeen.has(vid)) {
            if (cvSeen.size >= CV_VOLUMES_PER_RUN) { stats.skippedCap++; continue; }
            cvSeen.add(vid);
          }
        }
        const r = await resolveEntry(e.id);
        if (r?.error) stats.errors++; else if (r?.ok) stats.refreshed++;
        await yieldLoop();
      }
      stats.cvVolumes = cvSeen.size;
      logger.info('reading-lists', 'Refresh finished', stats);
      return stats;
    } catch (e) {
      logger.error('reading-lists', 'Refresh failed', { error: e.message });
      return { error: e.message };
    } finally { refreshing = false; }
  }

  // Entries left 'pending' by a restart mid-resolve.
  function resumePending() {
    for (const e of db.prepare(`SELECT id FROM reading_list_entries WHERE resolve_status = 'pending' AND unpacked = 0`).all()) startResolve(e.id);
  }

  // ── Export and import (curatedTransfer.js, 2026-11-12) ──────────
  // A list as a portable file: its details and entries, each with the issues it shows (series,
  // volume year, number, Comic Vine id), never this library's book or series ids. Entries that
  // follow a Timeline event or Top Shelf run name it, so an import can follow the same one there.
  const issueOut = r => ({ series_name: r.series_name || null, volume_year: toInt(r.volume_year), issue_number: r.issue_number == null ? null : String(r.issue_number),
    issue_title: r.issue_title || null, cv_issue_id: r.cv_issue_id ? String(r.cv_issue_id) : null });
  function exportList(id) {
    const list = getList(id);
    if (!list) throw bad(404, 'Reading list not found');
    let saved = {}; try { saved = JSON.parse(list.catalog_json || '{}') || {}; } catch {}
    const entries = listEntries(list.id).map(e => {
      const out = { type: e.entry_type, label: e.label || null, note: e.note || null };
      if (e.entry_type === 'section') return out;
      if (isLinked(e)) {
        if (e.entry_type === 'event') {
          const ev = db.prepare('SELECT name, year FROM events WHERE id = ?').get(String(e.ref_id));
          if (ev) out.source = { kind: 'event', name: ev.name, year: ev.year || null };
          out.tier_filter = e.tier_filter || null;
        } else {
          const run = db.prepare('SELECT title, parent_series FROM canon_runs WHERE id = ?').get(toInt(e.ref_id));
          if (run) out.source = { kind: 'run', title: run.title, parent_series: run.parent_series || null };
        }
      } else {
        out.unpacked = !!e.unpacked;
        if (e.resolve_source) out.resolve_source = e.resolve_source;
        if (e.cv_volume_id) out.cv_volume_id = String(e.cv_volume_id);
        if (e.issue_start != null) out.issue_start = String(e.issue_start);
        if (e.issue_end != null) out.issue_end = String(e.issue_end);
      }
      out.issues = entryIssues(e).map(issueOut);
      return out;
    });
    return {
      item: { name: list.name, description: list.description || null, visibility: list.visibility,
        home_tagline: list.home_tagline || null, home_description: list.home_description || null,
        collections: collectionRegistry.names(Array.isArray(saved.collections) ? saved.collections : []) || [] },
      entries,
    };
  }

  // Import as the admin's own private list (a draft: readers cannot see it). The editor's Details
  // panel publishes it (Who can see it: Essential). Event and run entries follow an event or run of
  // the same name here; without one, they keep the exported issues as a story.
  function importList(data, user) {
    const item = data && data.item && typeof data.item === 'object' ? data.item : {};
    const name = str(item.name, 200);
    if (!name) throw bad(400, 'The file has no list name');
    const entriesIn = (Array.isArray(data.entries) ? data.entries : []).filter(x => x && typeof x === 'object').slice(0, MAX_ENTRIES);
    const collections = (Array.isArray(item.collections) ? item.collections : []).map(v => str(v, 60)).filter(Boolean).slice(0, 20);
    const issuesOf = x => (Array.isArray(x.issues) ? x.issues : []).filter(i => i && typeof i === 'object' && str(i.series_name, 300) && str(i.issue_number, 40)).slice(0, 1000)
      .map(i => ({ series_name: str(i.series_name, 300), issue_number: normNum(str(i.issue_number, 40)) || str(i.issue_number, 40), volume_year: toInt(i.volume_year),
        issue_title: str(i.issue_title, 300), cv_issue_id: str(i.cv_issue_id, 40), manually_matched: 0 }));
    const findEvent = src => {
      const rows = db.prepare('SELECT id, year FROM events WHERE lower(name) = lower(?)').all(String(src.name || ''));
      return rows.find(r => src.year && Number(r.year) === Number(src.year)) || (rows.length === 1 ? rows[0] : null);
    };
    const findRun = src => {
      const rows = db.prepare('SELECT id, parent_series FROM canon_runs WHERE lower(title) = lower(?)').all(String(src.title || ''));
      return rows.find(r => src.parent_series && String(r.parent_series || '').toLowerCase() === String(src.parent_series).toLowerCase()) || (rows.length === 1 ? rows[0] : null);
    };
    const summary = { entries: 0, issues: 0, linked: 0, copied: 0, refreshing: 0 };
    let listId; const toResolve = [];
    db.transaction(() => {
      const catalog = collections.length ? JSON.stringify({ publishers: [], library_ids: [], featured: false, collections: collections.map(c => collectionRegistry.ensure(c)) }) : null;
      listId = Number(db.prepare(`INSERT INTO reading_lists (name, description, owner_id, visibility, source, catalog_json) VALUES (?,?,?,?,?,?)`)
        .run(name, str(item.description, 4000), user.sub, 'private', 'import', catalog).lastInsertRowid);
      require('./homepageFields').write(db, 'reading_lists', listId, { home_tagline: str(item.home_tagline, 120), home_description: str(item.home_description, 400) });
      const ins = db.prepare(`INSERT INTO reading_list_entries (list_id, sort_order, entry_type, ref_id, cv_volume_id, scanned_series_id,
          issue_start, issue_end, label, note, unpacked, resolve_status, resolve_source, tier_filter) VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,?,?)`);
      let pos = 0;
      for (const x of entriesIn) {
        const type = String(x.type || ''), label = str(x.label, 300), note = str(x.note, 2000);
        if (!ENTRY_TYPES.has(type)) continue;
        if (type === 'section') { if (label) { ins.run(listId, ++pos, 'section', null, null, null, null, label, note, 0, 'ok', null, null); summary.entries++; } continue; }
        const issues = issuesOf(x);
        if (type === 'event' || type === 'canon_run') {
          const src = x.source && typeof x.source === 'object' ? x.source : {};
          const target = type === 'event' ? findEvent(src) : findRun(src);
          if (target) {
            const tier = TIER_FILTERS.includes(x.tier_filter) ? x.tier_filter : null;
            ins.run(listId, ++pos, type, String(target.id), null, null, null, label || str(src.name || src.title, 300), note, 0, 'ok', null, type === 'event' ? tier : null);
            summary.entries++; summary.linked++; continue;
          }
          if (!issues.length) continue;
          const id = Number(ins.run(listId, ++pos, 'story', null, null, null, null, label || str(src.name || src.title, 300) || 'Imported', note, 1, 'ok', 'story', null).lastInsertRowid);
          insertIssueRows(id, issues); summary.entries++; summary.copied++; summary.issues += issues.length; continue;
        }
        const cvVol = str(x.cv_volume_id, 40);
        // A series or range that follows a Comic Vine volume keeps doing so (refreshed in the background);
        // anything else keeps exactly the exported issues.
        const live = (type === 'series' || type === 'range') && !x.unpacked && cvVol;
        if (!live && !issues.length) continue;
        const entryType = type === 'issue' || live || x.unpacked ? type : 'story';
        const id = Number(ins.run(listId, ++pos, entryType, null, live ? cvVol : null, str(x.issue_start, 40), str(x.issue_end, 40),
          label || (issues[0] ? `${issues[0].series_name} #${issues[0].issue_number}` : 'Imported'), note, live ? 0 : (type === 'issue' ? 0 : 1),
          live ? 'pending' : 'ok', live ? null : (type === 'issue' ? null : (str(x.resolve_source, 20) || 'story')), null).lastInsertRowid);
        insertIssueRows(id, type === 'issue' ? issues.slice(0, 1) : issues);
        if (live) { toResolve.push(id); summary.refreshing++; }
        summary.entries++; summary.issues += type === 'issue' ? Math.min(1, issues.length) : issues.length;
      }
      touch(listId);
    })();
    const rows = db.prepare(`SELECT li.*, e.entry_type FROM list_issues li JOIN reading_list_entries e ON e.id = li.owner_id
      WHERE li.owner_kind = ? AND e.list_id = ? AND li.scanned_book_id IS NULL`).all(OWNER_KIND, listId);
    matchRows(rows);
    for (const id of toResolve) startResolve(id);
    summary.owned = db.prepare(`SELECT COUNT(*) AS n FROM list_issues li JOIN reading_list_entries e ON e.id = li.owner_id
      WHERE li.owner_kind = ? AND e.list_id = ? AND li.scanned_book_id IS NOT NULL`).get(OWNER_KIND, listId).n;
    logger?.info?.('reading-lists', 'Reading list imported', { listId, name, ...summary, by: user.username });
    return { id: listId, name, summary };
  }

  return { reconcile, refreshAll, adjacent, orderedBooks, resumePending, resolveEntry, outline, exportList, importList,
    _internal: { volumeIssues, matchOne, buildBookIndex, insertEntry, cmpIssues, planApply, planEdits } };
};
