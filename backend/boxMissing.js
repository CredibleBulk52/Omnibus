'use strict';
// ─── Missing series in a box (2026-11-04, claude/BOXES_UNIFIED_PLAN.md stage 3) ──
// A box Comic Book Guy builds may recommend series the library does not have. They
// are kept as placeholders: name, start year, publisher and his reason, plus the
// Comic Vine volume (id and cover) once it is found. The page shows them as dashed
// tiles with Request (or Add in Downloads for users who may download).
//
// - Comic Vine is asked once per placeholder, in the background, through the shared
//   rate-limit pool (searchVolumes). No match → name only, still requestable.
// - When the series arrives in the library (same Comic Vine id, or same name and
//   year), the placeholder becomes the real series in the box.

const MAX_PER_BOX = 60;
const clean = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
// "The Nice House on the Lake" = "nice house on the lake" = "Nice House On The Lake!"
const norm = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/^the /, '').trim();
const yearOf = v => { const y = parseInt(v, 10); return y >= 1900 && y <= 2100 ? y : null; };
const httpError = (status, message) => Object.assign(new Error(message), { status });

function applyBoxMissingSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS collection_missing_series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id TEXT NOT NULL,
    name TEXT NOT NULL, norm_name TEXT NOT NULL, start_year INTEGER, publisher TEXT, reason TEXT,
    cv_volume_id TEXT, cv_name TEXT, image_url TEXT, issue_count INTEGER, cv_checked_at TEXT,
    added_at TEXT DEFAULT (datetime('now')));
  CREATE INDEX IF NOT EXISTS idx_cms_box ON collection_missing_series(collection_id);
  CREATE INDEX IF NOT EXISTS idx_cms_pending ON collection_missing_series(cv_checked_at);`);
}

// The Comic Vine volume for a name (and year): same name only; the year decides
// between same-named volumes (exact, then ±1); without a year, the longest run.
function pickVolume(results, name, year) {
  const want = norm(name);
  const same = (Array.isArray(results) ? results : []).filter(r => r && r.id && norm(r.name) === want);
  if (!same.length) return null;
  if (year) {
    const yr = r => yearOf(r.start_year);
    return same.find(r => yr(r) === year) || same.find(r => yr(r) && Math.abs(yr(r) - year) <= 1) || null;
  }
  return same.sort((a, b) => (b.count_of_issues || 0) - (a.count_of_issues || 0))[0];
}

function createBoxMissing({ db, logger = console, searchVolumes = null, librarySeries = null }) {
  applyBoxMissingSchema(db);
  // Library series as { id, name, year, cv } (cv: the Comic Vine volume id in series.json).
  const library = librarySeries || (() => db.prepare("SELECT id, name, year, json_extract(series_json, '$.metadata.comicid') AS cv FROM scanned_series").all());

  // A library series for a placeholder: by Comic Vine id, else by name and year.
  function inLibrary(item, lib = library()) {
    if (item.cv_volume_id) { const hit = lib.find(s => s.cv != null && String(s.cv) === String(item.cv_volume_id)); if (hit) return hit; }
    const n = norm(item.name), y = yearOf(item.start_year);
    return lib.find(s => norm(s.name) === n && (!y || !yearOf(s.year) || yearOf(s.year) === y)) || null;
  }

  const rowsOf = id => db.prepare('SELECT * FROM collection_missing_series WHERE collection_id = ? ORDER BY id').all(String(id));
  const addSeries = (colId, seriesId) => db.prepare('INSERT OR IGNORE INTO collection_series (collection_id, series_id, manually_added) VALUES (?, ?, 1)').run(String(colId), String(seriesId));

  // Placeholders the library now has become real series in the box.
  function reconcile(colId) {
    const rows = rowsOf(colId);
    if (!rows.length) return rows;
    const lib = library();
    const kept = [];
    for (const r of rows) {
      const hit = inLibrary(r, lib);
      if (hit) {
        addSeries(colId, hit.id);
        db.prepare('DELETE FROM collection_missing_series WHERE id = ?').run(r.id);
        logger.info?.('boxes', 'Missing series arrived', { box: colId, series: hit.id, name: r.name });
      } else kept.push(r);
    }
    return kept;
  }

  const view = r => ({ id: r.id, name: r.name, start_year: r.start_year, publisher: r.publisher, reason: r.reason,
    cv_volume_id: r.cv_volume_id, cv_name: r.cv_name, image_url: r.image_url, issue_count: r.issue_count, looked_up: !!r.cv_checked_at });

  function list(colId) {
    const rows = reconcile(colId);
    if (rows.some(r => !r.cv_checked_at)) resolveSoon();
    return rows.map(view);
  }

  // Add placeholders. Ones the library already has go into the box as series.
  function add(colId, items) {
    const lib = library();
    const have = new Set(rowsOf(colId).map(r => `${r.norm_name}|${r.start_year || ''}`));
    let count = have.size, added = 0;
    const inBox = [];
    const ins = db.prepare('INSERT INTO collection_missing_series (collection_id, name, norm_name, start_year, publisher, reason) VALUES (?, ?, ?, ?, ?, ?)');
    db.transaction(() => {
      for (const it of (Array.isArray(items) ? items : []).slice(0, MAX_PER_BOX)) {
        const name = clean(it?.name, 200);
        if (!name || !norm(name)) continue;
        const item = { name, start_year: yearOf(it.start_year), publisher: clean(it.publisher, 100) || null, reason: clean(it.reason, 300) || null };
        const hit = inLibrary(item, lib);
        if (hit) { addSeries(colId, hit.id); inBox.push(hit.id); continue; }
        const key = `${norm(name)}|${item.start_year || ''}`;
        if (have.has(key) || count >= MAX_PER_BOX) continue;
        ins.run(String(colId), name, norm(name), item.start_year, item.publisher, item.reason);
        have.add(key); count++; added++;
      }
    })();
    if (added) resolveSoon();
    return { added, in_library: inBox };
  }

  function remove(colId, rowId) {
    db.prepare('DELETE FROM collection_missing_series WHERE collection_id = ? AND id = ?').run(String(colId), Number(rowId));
  }
  const forget = colId => db.prepare('DELETE FROM collection_missing_series WHERE collection_id = ?').run(String(colId));
  function copy(fromId, toId) {
    db.prepare(`INSERT INTO collection_missing_series (collection_id, name, norm_name, start_year, publisher, reason, cv_volume_id, cv_name, image_url, issue_count, cv_checked_at)
      SELECT ?, name, norm_name, start_year, publisher, reason, cv_volume_id, cv_name, image_url, issue_count, cv_checked_at FROM collection_missing_series WHERE collection_id = ?`).run(String(toId), String(fromId));
  }

  // ── Comic Vine, one placeholder at a time, in the background ──
  let running = null, lastFailAt = 0;
  async function resolvePending(limit = 100) {
    if (!searchVolumes) return 0;
    let done = 0;
    while (done < limit) {
      const r = db.prepare('SELECT * FROM collection_missing_series WHERE cv_checked_at IS NULL ORDER BY id LIMIT 1').get();
      if (!r) break;
      // The same name and year already looked up for another box: reuse it.
      const prior = db.prepare(`SELECT cv_volume_id, cv_name, image_url, issue_count FROM collection_missing_series
        WHERE norm_name = ? AND COALESCE(start_year, 0) = ? AND cv_checked_at IS NOT NULL ORDER BY id DESC LIMIT 1`).get(r.norm_name, r.start_year || 0);
      let found = prior || null;
      if (!prior) {
        const results = await searchVolumes(r.name);   // throws on rate limits: stop, retry later
        const v = pickVolume(results, r.name, r.start_year);
        found = v ? { cv_volume_id: String(v.id), cv_name: v.name || null, image_url: v.image?.small_url || v.image?.thumb_url || null, issue_count: v.count_of_issues || null } : {};
      }
      db.prepare(`UPDATE collection_missing_series SET cv_volume_id = ?, cv_name = ?, image_url = ?, issue_count = ?, cv_checked_at = datetime('now')
        WHERE norm_name = ? AND COALESCE(start_year, 0) = ? AND cv_checked_at IS NULL`)
        .run(found.cv_volume_id || null, found.cv_name || null, found.image_url || null, found.issue_count || null, r.norm_name, r.start_year || 0);
      done++;
    }
    return done;
  }
  function resolveSoon() {
    if (running || !searchVolumes || Date.now() - lastFailAt < 10 * 60 * 1000) return running;
    running = resolvePending()
      .then(n => { if (n) logger.info?.('boxes', 'Missing series looked up on Comic Vine', { count: n }); return n; })
      .catch(e => { lastFailAt = Date.now(); logger.warn?.('boxes', 'Missing series lookup paused', { error: e.message }); return 0; })
      .finally(() => { running = null; });
    return running;
  }

  return { list, add, remove, forget, copy, reconcile, resolvePending, resolveSoon, inLibrary };
}

// Routes. canView/canEdit: (collection row, user) → boolean.
function registerBoxMissingRoutes(app, { db, requireAuth, boxMissing, canView, canEdit }) {
  const box = id => db.prepare('SELECT * FROM collections WHERE id = ?').get(String(id));
  const route = (need, fn) => (req, res) => {
    try {
      const col = box(req.params.id);
      if (!col || !canView(col, req.user)) throw httpError(404, 'Not found');
      if (need === 'edit' && !canEdit(col, req.user)) throw httpError(403, 'Only the owner can change this box.');
      res.json(fn(req, col));
    } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Unable to update the box.' }); }
  };
  app.get('/api/collections/:id/missing', requireAuth, route('view', (req, col) => ({ missing: boxMissing.list(col.id) })));
  app.post('/api/collections/:id/missing', requireAuth, route('edit', (req, col) => boxMissing.add(col.id, req.body?.items)));
  app.delete('/api/collections/:id/missing/:rowId', requireAuth, route('edit', (req, col) => { boxMissing.remove(col.id, req.params.rowId); return { success: true }; }));
}

module.exports = { applyBoxMissingSchema, createBoxMissing, registerBoxMissingRoutes, pickVolume, norm };
