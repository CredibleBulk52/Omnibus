'use strict';
// ── Stable IDs ─────────────────────────────────────────────────────
// Design: claude/STABLE_IDS.md (project) and the "Omnibus Stable IDs —
// Design" doc.
//
// Series and book IDs used to be md5(path), so a move or rename produced a
// new record and stranded every link to the old one. Now (always on since
// 2026-10-11; the `stable_ids` setting and dry-run mode were removed):
//   - a row found at its path keeps its ID (existing IDs are never rewritten);
//   - an unknown path first tries to reclaim the record it used to be (CV
//     volume ID for series, CV issue ID — or size + issue number — for books);
//     only a one-to-one match (after tie-breaks) is reclaimed, else a new ID;
//   - vanished records move to missing_series / missing_books instead of being
//     deleted, so a later scan can still reclaim them. Purge with
//     tools/purgeMissing.js.

module.exports = function createStableIds({ db, logger, fs, path, crypto }) {
  const COMIC_RE = /\.(cbz|cbr|zip|rar|pdf)$/i;

  const hashId = (prefix, p) => prefix + crypto.createHash('md5').update(p).digest('hex').slice(0, 16);
  const idTaken = id => !!(
    db.prepare('SELECT 1 FROM scanned_series WHERE id = ?').get(id) ||
    db.prepare('SELECT 1 FROM scanned_books WHERE id = ?').get(id) ||
    db.prepare('SELECT 1 FROM missing_series WHERE id = ?').get(id) ||
    db.prepare('SELECT 1 FROM missing_books WHERE id = ?').get(id));
  const randomId = prefix => {
    for (;;) { const id = prefix + crypto.randomBytes(8).toString('hex'); if (!idTaken(id)) return id; }
  };
  const comicidOf = json => {
    const v = json?.metadata?.comicid ?? json?.comicid ?? null;
    return v == null || v === '' ? null : String(v);
  };
  const exists = p => { try { return fs.existsSync(p); } catch { return false; } };
  const dirHasComics = p => {
    try { return fs.readdirSync(p, { withFileTypes: true }).some(e => e.isFile() && COMIC_RE.test(e.name)); }
    catch { return false; }
  };

  const insLog = db.prepare(`INSERT INTO identity_rebinds
    (kind, mode, outcome, entity_id, old_path, new_path, match_key, candidates) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  function log(kind, outcome, { id = null, oldPath = null, newPath = null, key = null, cands = null } = {}) {
    const out = outcome;
    try {
      insLog.run(kind, 'on', out, id, oldPath, newPath, key,
        cands ? JSON.stringify(cands.map(c => ({ id: c.id, path: c.path, source: c.source }))) : null);
    } catch (e) { logger.warn('stable-ids', 'log write failed', { error: e.message }); }
    if (outcome !== 'tombstoned') logger.info('stable-ids', `${kind} ${out}`, { id, oldPath, newPath, key });
  }

  // Copy a row back into a live table from its JSON snapshot (only columns
  // the table still has), with some fields overridden.
  function restoreRow(table, rowJson, overrides) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    const row = { ...JSON.parse(rowJson), ...overrides };
    const use = cols.filter(c => c in row);
    db.prepare(`INSERT INTO ${table} (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`)
      .run(...use.map(c => row[c]));
  }

  // Monitored-series directory and file paths follow a reclaimed folder/file.
  function followMonitored(oldPath, newPath, isDir) {
    if (!oldPath || oldPath === newPath) return;
    if (isDir) {
      db.prepare('UPDATE monitored_series SET directory = ? WHERE directory = ?').run(newPath, oldPath);
      const pre = oldPath + path.sep;
      for (const t of ['monitored_issues', 'series_packs']) {
        try {
          db.prepare(`UPDATE ${t} SET file_path = ? || substr(file_path, ?) WHERE substr(file_path, 1, ?) = ?`)
            .run(newPath, oldPath.length + 1, pre.length, pre);
        } catch {}
      }
    } else {
      db.prepare('UPDATE monitored_issues SET file_path = ? WHERE file_path = ?').run(newPath, oldPath);
    }
  }

  // Several candidates: narrow by tie-breakers in order, stopping at the first
  // that leaves exactly one. E.g. two folders for the same CV volume
  // ("Thor (2018)" and "Thor (2018-)") moved together — the folder name decides.
  function narrow(cands, tests) {
    if (cands.length <= 1) return cands;
    for (const t of tests) {
      const hit = cands.filter(t);
      if (hit.length === 1) return hit;
    }
    return cands;
  }

  // ── Series ─────────────────────────────────────────────────────
  function seriesCandidates(cv, newPath) {
    const live = db.prepare(`SELECT id, path FROM scanned_series
      WHERE path != ? AND CAST(COALESCE(json_extract(series_json, '$.metadata.comicid'), json_extract(series_json, '$.comicid')) AS TEXT) = ?`)
      .all(newPath, cv)
      .filter(r => !exists(r.path) || !dirHasComics(r.path))
      .map(r => ({ ...r, source: 'live' }));
    const gone = db.prepare('SELECT id, path FROM missing_series WHERE cv_volume_id = ?').all(cv)
      .map(r => ({ ...r, source: 'missing' }));
    return [...live, ...gone];
  }

  // Returns the ID to use for a series folder. Applies a reclaim in 'on' mode.
  function resolveSeriesId(seriesDir, jsonData) {
    const atPath = db.prepare('SELECT id FROM scanned_series WHERE path = ?').get(seriesDir);
    if (atPath) return atPath.id;

    const cv = comicidOf(typeof jsonData === 'function' ? jsonData() : jsonData);
    const all = cv ? seriesCandidates(cv, seriesDir) : [];
    const base = path.basename(seriesDir);
    const cands = narrow(all, [c => path.basename(c.path) === base]);
    const key = cv ? `cv_volume:${cv}` + (all.length > 1 && cands.length === 1 ? '+folder_name' : '') : null;
    if (cands.length > 1) log('series', 'ambiguous', { newPath: seriesDir, key, cands });
    if (cands.length !== 1) return randomId('ss_');

    const c = cands[0];
    log('series', 'reclaimed', { id: c.id, oldPath: c.path, newPath: seriesDir, key });

    db.transaction(() => {
      if (c.source === 'live') {
        // dir_mtime = 0 forces the scanner to re-read the folder: a moved folder
        // keeps its mtime, and without a rescan its books keep their old paths.
        db.prepare('UPDATE scanned_series SET path = ?, dir_mtime = 0 WHERE id = ?').run(seriesDir, c.id);
      } else {
        const t = db.prepare('SELECT row_json FROM missing_series WHERE id = ?').get(c.id);
        restoreRow('scanned_series', t.row_json, { path: seriesDir, dir_mtime: 0 });
        db.prepare('DELETE FROM missing_series WHERE id = ?').run(c.id);
      }
      followMonitored(c.path, seriesDir, true);
    })();
    return c.id;
  }

  // ── Books ──────────────────────────────────────────────────────
  // The live row at this path, if any.
  const bookAtPath = filePath =>
    db.prepare('SELECT id, file_mtime, file_size FROM scanned_books WHERE path = ?').get(filePath) || null;

  function bookCandidates({ filePath, seriesId, cvIssueId, issueNum, fileSize }) {
    let live, gone, key;
    if (cvIssueId) {
      key = `cv_issue:${cvIssueId}`;
      live = db.prepare('SELECT id, path, series_id FROM scanned_books WHERE cv_issue_id = ? AND path != ?').all(String(cvIssueId), filePath);
      gone = db.prepare('SELECT id, path, series_id FROM missing_books WHERE cv_issue_id = ?').all(String(cvIssueId));
    } else if (fileSize && issueNum != null && issueNum !== '') {
      key = `size+number:${fileSize}/#${issueNum}`;
      live = db.prepare(`SELECT id, path, series_id FROM scanned_books WHERE series_id = ? AND file_size = ? AND issue_number = ?
        AND (cv_issue_id IS NULL OR cv_issue_id = '') AND path != ?`).all(seriesId, fileSize, String(issueNum), filePath);
      gone = db.prepare(`SELECT id, path, series_id FROM missing_books WHERE series_id = ? AND file_size = ? AND issue_number = ?
        AND (cv_issue_id IS NULL OR cv_issue_id = '')`).all(seriesId, fileSize, String(issueNum));
    } else return { key: null, cands: [] };
    const cands = [
      ...live.filter(r => !exists(r.path)).map(r => ({ ...r, source: 'live' })),
      ...gone.map(r => ({ ...r, source: 'missing' })),
    ];
    return { key, cands };
  }

  // Called for a file whose path has no live row. Returns the ID to use and
  // applies a reclaim (the caller's upsert then updates the row).
  function resolveBookId(info) {
    const found = bookCandidates(info);
    const cands = narrow(found.cands, [
      c => c.series_id === info.seriesId && path.basename(c.path) === path.basename(info.filePath),
      c => c.series_id === info.seriesId,
      c => path.basename(c.path) === path.basename(info.filePath),
    ]);
    const key = found.key && (found.cands.length > 1 && cands.length === 1 ? found.key + '+tiebreak' : found.key);
    if (cands.length > 1) log('book', 'ambiguous', { newPath: info.filePath, key, cands });
    if (cands.length !== 1) return randomId('sb_');

    const c = cands[0];
    log('book', 'reclaimed', { id: c.id, oldPath: c.path, newPath: info.filePath, key });

    db.transaction(() => {
      if (c.source === 'live') {
        db.prepare('UPDATE scanned_books SET path = ?, series_id = ? WHERE id = ?').run(info.filePath, info.seriesId, c.id);
      } else {
        const t = db.prepare('SELECT row_json FROM missing_books WHERE id = ?').get(c.id);
        restoreRow('scanned_books', t.row_json, { path: info.filePath, series_id: info.seriesId });
        db.prepare('DELETE FROM missing_books WHERE id = ?').run(c.id);
      }
      followMonitored(c.path, info.filePath, false);
    })();
    return c.id;
  }

  // ── Vanished records ───────────────────────────────────────────
  const insMissingBook = db.prepare(`INSERT OR REPLACE INTO missing_books
    (id, series_id, path, filename, issue_number, cv_issue_id, file_size, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insMissingSeries = db.prepare(`INSERT OR REPLACE INTO missing_series
    (id, library_id, path, name, year, cv_volume_id, row_json) VALUES (?, ?, ?, ?, ?, ?, ?)`);

  function tombstoneBook(bookId) {
    const row = db.prepare('SELECT * FROM scanned_books WHERE id = ?').get(bookId);
    if (!row) return;
    db.transaction(() => {
      insMissingBook.run(row.id, row.series_id, row.path, row.filename, row.issue_number, row.cv_issue_id, row.file_size, JSON.stringify(row));
      db.prepare('DELETE FROM scanned_books WHERE id = ?').run(row.id);
    })();
    log('book', 'tombstoned', { id: row.id, oldPath: row.path, key: row.cv_issue_id ? `cv_issue:${row.cv_issue_id}` : null });
  }

  function tombstoneSeries(seriesId) {
    const row = db.prepare('SELECT * FROM scanned_series WHERE id = ?').get(seriesId);
    if (!row) return;
    let cv = null;
    try { cv = comicidOf(JSON.parse(row.series_json || 'null')); } catch {}
    for (const b of db.prepare('SELECT id FROM scanned_books WHERE series_id = ?').all(seriesId)) tombstoneBook(b.id);
    db.transaction(() => {
      insMissingSeries.run(row.id, row.library_id, row.path, row.name, row.year, cv, JSON.stringify(row));
      db.prepare('DELETE FROM scanned_series WHERE id = ?').run(row.id);
    })();
    log('series', 'tombstoned', { id: row.id, oldPath: row.path, key: cv ? `cv_volume:${cv}` : null });
  }


  // Permanently drop missing records (older than N days, or all when days is null).
  // Monitored issues they held are reset to 'wanted' here — not at vanish time —
  // so a move never triggers a re-download.
  function purgeMissing(days = null) {
    const cond = days == null ? '1=1' : `missing_since <= datetime('now', ?)`;
    const args = days == null ? [] : [`-${Number(days)} days`];
    const books = db.prepare(`SELECT id, row_json FROM missing_books WHERE ${cond}`).all(...args);
    const series = db.prepare(`SELECT id FROM missing_series WHERE ${cond}`).all(...args);
    db.transaction(() => {
      for (const b of books) {
        let mi = null; try { mi = JSON.parse(b.row_json).monitored_issue_id; } catch {}
        if (mi) db.prepare(`UPDATE monitored_issues SET status = 'wanted', file_path = NULL, download_id = NULL, date_processed = NULL
          WHERE id = ? AND status = 'processed'`).run(mi);
        db.prepare('DELETE FROM missing_books WHERE id = ?').run(b.id);
      }
      for (const s of series) db.prepare('DELETE FROM missing_series WHERE id = ?').run(s.id);
    })();
    return { books: books.length, series: series.length };
  }

  // Automatic purge (user 2026-10-21, Stable IDs design doc): records missing `days` or more are
  // purged, unless the vanishing looks like an outage rather than deletions: the comics folder is
  // unreadable or empty, a whole top-level folder of a due record is gone, or more records are due
  // than max(minBooks, share × library). Then nothing is purged and the reason is returned.
  function autoPurge({ days = 5, comicsRoot = '/comics', share = 0.02, minBooks = 50 } = {}) {
    const cutoff = [`-${Number(days)} days`];
    const due = db.prepare(`SELECT path FROM missing_books WHERE missing_since <= datetime('now', ?)`).all(...cutoff);
    const dueSeries = db.prepare(`SELECT path FROM missing_series WHERE missing_since <= datetime('now', ?)`).all(...cutoff);
    if (!due.length && !dueSeries.length) return { books: 0, series: 0 };
    let entries = [];
    try { entries = fs.readdirSync(comicsRoot); } catch (e) { return { skipped: true, reason: `comics folder unreadable (${e.message})` }; }
    if (!entries.length) return { skipped: true, reason: 'comics folder is empty' };
    const root = String(comicsRoot).replace(/\/+$/, '');
    const tops = new Set([...due, ...dueSeries].map(r => String(r.path || '')).filter(p => p.startsWith(`${root}/`)).map(p => p.slice(root.length + 1).split('/')[0]).filter(Boolean));
    const goneTop = [...tops].find(t => !fs.existsSync(path.join(root, t)));
    if (goneTop) return { skipped: true, reason: `the whole folder "${goneTop}" is missing` };
    const live = db.prepare('SELECT COUNT(*) AS n FROM scanned_books').get().n;
    const limit = Math.max(minBooks, Math.round(share * live));
    if (due.length > limit) return { skipped: true, reason: `${due.length} records due at once (limit ${limit}); check and purge by hand` };
    return purgeMissing(days);
  }

  function status(limit = 200) {
    const counts = db.prepare(`SELECT outcome, kind, COUNT(*) AS n FROM identity_rebinds GROUP BY outcome, kind`).all();
    return {
      missing: {
        series: db.prepare('SELECT COUNT(*) AS n FROM missing_series').get().n,
        books: db.prepare('SELECT COUNT(*) AS n FROM missing_books').get().n,
      },
      counts,
      recent: db.prepare('SELECT * FROM identity_rebinds ORDER BY id DESC LIMIT ?').all(limit),
    };
  }

  // Explicit existing-copy publication. Called only inside the metadata
  // journal's transaction; never resolve/reclaim by shared CV issue identity.
  function updatePublishedBook({ bookId, expectedPath, destination, comicinfo, fileSize, fileMtime }) {
    if (!(db.inTransaction || db.isTransaction)) throw new Error('Published-book update requires the caller transaction');
    const row = db.prepare('SELECT * FROM scanned_books WHERE id=?').get(bookId);
    if (!row || row.path !== expectedPath) throw new Error('Published-book source changed');
    if (typeof destination !== 'string' || !path.isAbsolute(destination) || !/\.cbz$/i.test(destination)
      || (comicinfo !== null && typeof comicinfo !== 'string') || !Number.isSafeInteger(fileSize) || fileSize < 1
      || !Number.isFinite(fileMtime) || fileMtime < 0) throw new TypeError('Validated published file facts required');
    const occupied = db.prepare('SELECT id FROM scanned_books WHERE path=? AND id!=?').get(destination, bookId);
    if (occupied) throw new Error('Published-book destination belongs to another copy');
    db.prepare('UPDATE scanned_books SET path=?,filename=?,comicinfo=?,file_size=?,file_mtime=? WHERE id=? AND path=?')
      .run(destination, path.basename(destination), comicinfo, fileSize, fileMtime, bookId, expectedPath);
    // Only this physical copy's path-linked monitoring record follows it.
    // Other copies, filing/sort fields, CV IDs, overrides and relationships stay.
    followMonitored(expectedPath, destination, false);
    return db.prepare('SELECT * FROM scanned_books WHERE id=?').get(bookId);
  }
  return { hashId, resolveSeriesId, bookAtPath, resolveBookId, tombstoneBook, tombstoneSeries, purgeMissing, autoPurge, status, updatePublishedBook };
};
