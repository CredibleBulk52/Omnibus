'use strict';
// ─── curatedEditor.js ─────────────────────────────────────────────
// Load and save for the shared list editor's Timeline event and Top Shelf
// run kinds (reading lists save through readingLists.js). Admin only.
// claude/ADMIN_REORG.md, step 3.
//
//   GET  /api/editor/event/:id        { title, version, details, rows }
//   POST /api/editor/event/:id/save   { version, order: [issueId | {section: label} | {add, tier, note}], remove: [issueId], tiers: {id: tier}, notes: {id: tierNote}, details? }
//        add (from the Add window): { series_name, issue_number, volume_year, issue_title, cv_issue_id, scanned_book_id }
//                                      Sections are the event's phases: an issue's phase is the section above it.
//   GET  /api/editor/run/:id          { title, version, details, events, rows }   (in stored order: the run's reading order, runOrder.js)
//   POST /api/editor/run/:id/save     { version, order?: [issueId | {add}], remove: [issueId], details? }
//
//   DELETE /api/editor/event/:id      delete the event and its issues; runs linked to it are unlinked
//   DELETE /api/editor/run/:id        delete the run with its issues, categories and creators
//   POST /api/editor/run/:id/status   { status: approved|pending|rejected } — Top Shelf's pending review ('rejected' = Blocked)
//   POST /api/editor/runs/bulk        { ids, action: approve|pending|block|delete } — several runs at once
//   (reading lists that follow a deleted event or run show it as missing; GET reports how many in usage.lists)
//
// details: the hero information (Details panel). Events: name, publisher, year,
// description, event_tier (1 Crisis, 2 Major, 3 Crossover arc), sort_order
// (order within its year on the Timeline), cover_image, cover_issue_id (one of the event's
// own issues as its Timeline cover, 2026-11-10: it wins over cover_image). Runs: title,
// parent_series, issue_range_hint, description, status, event_id,
// cv_volume_id, admin_recommended (0/1), categories [{category, adaptation_notes}], creators [{person_name, role}].
//
// version: a hash of the rows as loaded, so a save over changes made
// elsewhere (Events Admin, Generate, another tab) is refused.
const crypto = require('node:crypto');

const EVENT_TIERS = ['essential', 'recommended', 'tie-in', 'aftermath'];
const RUN_STATUS = ['pending', 'approved', 'rejected'];
const RUN_CATEGORIES = ['adapted_to_screen', 'award_winning', 'critically_acclaimed'];
const RUN_ROLES = ['writer', 'penciler', 'inker', 'artist', 'colorist', 'letterer'];
const txt = (v, max) => { const t = v == null ? '' : String(v).trim(); return t ? t.slice(0, max) : null; };
const int = v => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : NaN);
class Bad extends Error { constructor(msg) { super(msg); this.status = 400; } }
// A new issue from the Add window, checked.
function addRow(a) {
  const series = txt(a && a.series_name, 300), num = txt(a && a.issue_number, 40);
  if (!series || !num) throw new Bad('Each new issue needs a series name and an issue number.');
  return { series, num, year: a.volume_year ? String(a.volume_year).slice(0, 8) : null, title: txt(a.issue_title, 300), cv: txt(a.cv_issue_id, 40),
    book: a.scanned_book_id ? String(a.scanned_book_id).slice(0, 80) : null };
}

module.exports = function createCuratedEditor({ app, db, requireAdmin, logger }) {
  require('./homepageFields').ensure(db, ['events','canon_runs']);
  try { if (!db.prepare('PRAGMA table_info(events)').all().some(c => c.name === 'cover_issue_id')) db.exec('ALTER TABLE events ADD COLUMN cover_issue_id INTEGER'); } catch {}
  const bad = (res, code, error, extra = {}) => res.status(code).json({ error, ...extra });
  const hash = rows => crypto.createHash('sha1').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
  const owned = 'EXISTS (SELECT 1 FROM scanned_books sb WHERE sb.id = CAST(x.scanned_book_id AS TEXT))';   // cast: canon_run_issues declares the column INTEGER, so without it every row scans all books

  function eventRows(id) {
    return db.prepare(`SELECT x.id, x.series_name, x.issue_number, x.volume_year, x.issue_title, x.cv_issue_id, x.tier, x.tier_note, x.phase,
        x.sort_order, x.scanned_book_id, ${owned} AS owned FROM event_issues x WHERE x.event_id = ? ORDER BY x.sort_order, x.id`).all(String(id));
  }
  let tierReasonCol = null;   // event_issues.tier_reason (added by the event generator; absent in older databases)
  const hasTierReason = () => (tierReasonCol ??= db.prepare('PRAGMA table_info(event_issues)').all().some(c => c.name === 'tier_reason'));
  // draft: an imported event still hidden from readers (eventDrafts.js); only where the column exists.
  const drafts = require('./eventDrafts');
  const eventDetails = id => db.prepare(`SELECT home_tagline, home_description, name, publisher, year, description, event_tier, sort_order, cover_image, cover_issue_id${drafts.hasDraft(db) ? ', COALESCE(draft, 0) AS draft' : ''} FROM events WHERE id = ?`).get(String(id));
  const eventVersion = (rows, d) => hash([rows.map(r => [r.id, r.sort_order, r.tier, r.tier_note, r.phase]), d]);
  function eventDetailsNext(cur, d, eventId) {
    const n = { ...cur, ...require('./homepageFields').changes(d) };
    if ('name' in d) { n.name = txt(d.name, 200); if (!n.name) throw new Bad('The event needs a name.'); }
    if ('publisher' in d) n.publisher = txt(d.publisher, 120);
    if ('year' in d) { n.year = int(d.year); if (Number.isNaN(n.year) || (n.year != null && (n.year < 1900 || n.year > 2100))) throw new Bad('Year must be a four-digit year.'); }
    if ('description' in d) n.description = txt(d.description, 8000);
    if ('event_tier' in d) { n.event_tier = int(d.event_tier); if (![1, 2, 3].includes(n.event_tier)) throw new Bad('Event tier must be 1, 2 or 3.'); }
    if ('sort_order' in d) { n.sort_order = int(d.sort_order) ?? 0; if (Number.isNaN(n.sort_order) || n.sort_order < 0) throw new Bad('Order within the year must be 0 or more.'); }
    if ('cover_image' in d) n.cover_image = txt(d.cover_image, 1000);
    if ('draft' in d && 'draft' in cur) n.draft = d.draft ? 1 : 0;
    if ('cover_issue_id' in d) {
      n.cover_issue_id = d.cover_issue_id == null || d.cover_issue_id === '' ? null : int(d.cover_issue_id);
      if (n.cover_issue_id != null && (Number.isNaN(n.cover_issue_id) || !db.prepare('SELECT 1 FROM event_issues WHERE id = ? AND event_id = ?').get(n.cover_issue_id, String(eventId))))
        throw new Bad('The Timeline cover must be one of this event\'s issues.');
    }
    return n;
  }
  function runRows(id) {
    return db.prepare(`SELECT x.id, x.series_name, x.issue_number, x.volume_year, x.cv_issue_id, x.sort_order, x.scanned_book_id, ${owned} AS owned
      FROM canon_run_issues x WHERE x.run_id = ? ORDER BY x.sort_order, x.id`).all(Number(id));
  }
  function runDetails(id) {
    const d = db.prepare('SELECT home_tagline, home_description, title, parent_series, issue_range_hint, description, status, event_id, cv_volume_id, COALESCE(admin_recommended, 0) AS admin_recommended FROM canon_runs WHERE id = ?').get(Number(id));
    if (!d) return null;
    d.event_id = d.event_id == null ? null : String(d.event_id);
    d.categories = db.prepare('SELECT category, adaptation_notes FROM canon_run_categories WHERE run_id = ? ORDER BY id').all(Number(id)).map(c => ({ ...c }));
    d.creators = db.prepare('SELECT person_name, role FROM canon_run_creators WHERE run_id = ? ORDER BY id').all(Number(id)).map(c => ({ ...c }));
    return { ...d };
  }
  const runVersion = (rows, d) => hash([rows.map(r => [r.id, r.sort_order]), d]);
  function runDetailsNext(cur, d) {
    const n = { ...cur, ...require('./homepageFields').changes(d) };
    if ('title' in d) { n.title = txt(d.title, 300); if (!n.title) throw new Bad('The run needs a title.'); }
    for (const [k, max] of [['parent_series', 200], ['issue_range_hint', 120], ['description', 8000], ['cv_volume_id', 40]]) if (k in d) n[k] = txt(d[k], max);
    if ('status' in d) { if (!RUN_STATUS.includes(d.status)) throw new Bad(`Status must be one of ${RUN_STATUS.join(', ')}.`); n.status = d.status; }
    if ('admin_recommended' in d) n.admin_recommended = d.admin_recommended ? 1 : 0;
    if ('event_id' in d) {
      n.event_id = d.event_id ? String(d.event_id) : null;
      if (n.event_id && !db.prepare('SELECT 1 FROM events WHERE id = ?').get(n.event_id)) throw new Bad('That Timeline event no longer exists.');
    }
    if ('categories' in d) {
      const seen = new Set();
      n.categories = (Array.isArray(d.categories) ? d.categories : []).filter(c => c && RUN_CATEGORIES.includes(c.category) && !seen.has(c.category) && seen.add(c.category))
        .map(c => ({ category: c.category, adaptation_notes: txt(c.adaptation_notes, 500) }));
    }
    if ('creators' in d) {
      n.creators = (Array.isArray(d.creators) ? d.creators : []).map(c => ({ person_name: txt(c && c.person_name, 200), role: RUN_ROLES.includes(c && c.role) ? c.role : 'writer' }))
        .filter(c => c.person_name);
    }
    return n;
  }
  const out = r => ({ ...r, owned: !!r.owned });
  // How many reading lists follow an event or run (linked, not own copies), and runs linked to an event.
  const listsFollowing = (type, id) => db.prepare(`SELECT COUNT(DISTINCT list_id) AS n FROM reading_list_entries
    WHERE entry_type = ? AND CAST(ref_id AS TEXT) = ? AND COALESCE(unpacked, 0) = 0`).get(type, String(id))?.n || 0;
  const safeCount = fn => { try { return fn(); } catch { return 0; } };   // reading lists tables may be absent in tests

  app.get('/api/editor/event/:id', requireAdmin, (req, res) => {
    const ev = db.prepare('SELECT id, name FROM events WHERE id = ?').get(req.params.id);
    if (!ev) return bad(res, 404, 'Event not found');
    const rows = eventRows(ev.id), details = eventDetails(ev.id);
    const usage = { lists: safeCount(() => listsFollowing('event', ev.id)), runs: db.prepare('SELECT COUNT(*) AS n FROM canon_runs WHERE CAST(event_id AS TEXT) = ?').get(String(ev.id)).n };
    res.json({ title: ev.name, version: eventVersion(rows, details), tiers: EVENT_TIERS, details, usage, rows: rows.map(out) });
  });
  app.post('/api/editor/event/:id/save', requireAdmin, (req, res) => {
    try {
      const ev = db.prepare('SELECT id, name FROM events WHERE id = ?').get(req.params.id);
      if (!ev) return bad(res, 404, 'Event not found');
      const b = req.body || {}, rows = eventRows(ev.id), cur = eventDetails(ev.id);
      if (b.version && b.version !== eventVersion(rows, cur)) return bad(res, 409, 'This event was changed somewhere else after you opened the editor. Your draft is kept; reload to see the other changes.', { conflict: true });
      const order = Array.isArray(b.order) ? b.order : null;
      if (!order) return bad(res, 400, 'order is required');
      const kept = order.filter(x => typeof x !== 'object').map(Number), remove = (Array.isArray(b.remove) ? b.remove : []).map(Number);
      const all = [...kept, ...remove], have = rows.map(r => r.id);
      if (new Set(all).size !== all.length || all.length !== have.length || !all.every(x => have.includes(x)))
        return bad(res, 409, "The editor's copy is out of step with the event. Reload the editor.");
      const tiers = b.tiers && typeof b.tiers === 'object' ? b.tiers : {}, notes = b.notes && typeof b.notes === 'object' ? b.notes : {};
      const reasons = b.reasons && typeof b.reasons === 'object' ? b.reasons : {};   // admin's reason for a tier change (tier_reason)
      for (const t of Object.values(tiers)) if (!EVENT_TIERS.includes(t)) return bad(res, 400, `Tier must be one of ${EVENT_TIERS.join(', ')}`);
      const details = b.details && typeof b.details === 'object' ? eventDetailsNext(cur, b.details, ev.id) : null;
      const adds = new Map(order.filter(x => x && typeof x === 'object' && x.add).map(x => [x, addRow(x.add)]));
      const byId = new Map(rows.map(r => [r.id, r]));
      db.transaction(() => {
        if (details) require('./homepageFields').write(db, 'events', ev.id, details);
        if (details) db.prepare('UPDATE events SET name = ?, publisher = ?, year = ?, description = ?, event_tier = ?, sort_order = ?, cover_image = ?, cover_issue_id = ? WHERE id = ?')
          .run(details.name, details.publisher, details.year, details.description, details.event_tier ?? 2, details.sort_order ?? 0, details.cover_image, details.cover_issue_id ?? null, String(ev.id));
        if (details && 'draft' in details) db.prepare('UPDATE events SET draft = ? WHERE id = ?').run(details.draft ? 1 : 0, String(ev.id));
        const del = db.prepare('DELETE FROM event_issues WHERE id = ? AND event_id = ?');
        for (const id of remove) del.run(id, String(ev.id));
        // A removed issue stops being the Timeline cover (the automatic cover comes back).
        db.prepare(`UPDATE events SET cover_issue_id = NULL WHERE id = ? AND cover_issue_id IS NOT NULL
          AND cover_issue_id NOT IN (SELECT id FROM event_issues WHERE event_id = ?)`).run(String(ev.id), String(ev.id));
        const upd = db.prepare('UPDATE event_issues SET sort_order = ?, phase = ?, tier = ?, tier_note = ? WHERE id = ? AND event_id = ?');
        const ins = db.prepare(`INSERT INTO event_issues (event_id, cv_issue_id, scanned_book_id, sort_order, tier, tier_note, series_name, issue_number, issue_title, volume_year, manually_matched, phase)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
        let phase = null, n = 0;
        for (const x of order) {
          if (x && typeof x === 'object' && x.add) {
            const a = adds.get(x);
            ins.run(String(ev.id), a.cv, a.book, ++n, EVENT_TIERS.includes(x.tier) ? x.tier : 'recommended', txt(x.note, 1000), a.series, a.num, a.title, a.year, a.book ? 1 : 0, phase);
            continue;
          }
          if (x && typeof x === 'object') { phase = String(x.section || '').trim().slice(0, 120) || null; continue; }
          const id = Number(x), r = byId.get(id);
          const note = Object.prototype.hasOwnProperty.call(notes, id) ? (String(notes[id] || '').trim().slice(0, 1000) || null) : r.tier_note;
          upd.run(++n, phase, tiers[id] || r.tier, note, id, String(ev.id));
        }
        // A changed tier makes the generator's tier reason stale: keep the admin's reason, or record the change.
        const changed = Object.keys(tiers).map(Number).filter(id => byId.has(id) && byId.get(id).tier !== tiers[id]);
        if (changed.length && hasTierReason()) {
          const setReason = db.prepare('UPDATE event_issues SET tier_reason = ? WHERE id = ? AND event_id = ?');
          for (const id of changed) {
            const why = txt(reasons[id], 300);
            setReason.run(why ? `admin: ${why}` : `admin changed the tier from ${byId.get(id).tier} to ${tiers[id]}`, id, String(ev.id));
          }
        }
      })();
      logger?.info?.('editor', 'Timeline event saved', { eventId: ev.id, issues: kept.length, added: adds.size, removed: remove.length, by: req.user?.username });
      res.json({ ok: true, version: eventVersion(eventRows(ev.id), eventDetails(ev.id)) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.get('/api/editor/run/:id', requireAdmin, (req, res) => {
    const run = db.prepare('SELECT id, title FROM canon_runs WHERE id = ?').get(req.params.id);
    if (!run) return bad(res, 404, 'Run not found');
    const rows = runRows(run.id), details = runDetails(run.id);
    const events = db.prepare('SELECT id, name, year, publisher FROM events ORDER BY name COLLATE NOCASE').all().map(e => ({ ...e, id: String(e.id) }));
    const usage = { lists: safeCount(() => listsFollowing('canon_run', run.id)) };
    res.json({ title: run.title, version: runVersion(rows, details), details, events, usage, rows: rows.map(out) });
  });
  app.post('/api/editor/run/:id/save', requireAdmin, (req, res) => {
    try {
      const run = db.prepare('SELECT id, title FROM canon_runs WHERE id = ?').get(req.params.id);
      if (!run) return bad(res, 404, 'Run not found');
      const b = req.body || {}, rows = runRows(run.id), cur = runDetails(run.id);
      if (b.version && b.version !== runVersion(rows, cur)) return bad(res, 409, 'This run was changed somewhere else after you opened the editor. Your draft is kept; reload to see the other changes.', { conflict: true });
      const remove = (Array.isArray(b.remove) ? b.remove : []).map(Number), have = new Set(rows.map(r => r.id));
      if (!remove.every(id => have.has(id))) return bad(res, 409, "The editor's copy is out of step with the run. Reload the editor.");
      const order = Array.isArray(b.order) ? b.order : null;
      const adds = new Map((order || []).filter(x => x && typeof x === 'object' && x.add).map(x => [x, addRow(x.add)]));
      if (order) {   // every issue exactly once, kept or removed (new issues aside)
        const all = [...order.filter(x => typeof x !== 'object').map(Number), ...remove];
        if (new Set(all).size !== all.length || all.length !== have.size || !all.every(id => have.has(id)))
          return bad(res, 409, "The editor's copy is out of step with the run. Reload the editor.");
      }
      const details = b.details && typeof b.details === 'object' ? runDetailsNext(cur, b.details) : null;
      db.transaction(() => {
        if (details) {
          require('./homepageFields').write(db, 'canon_runs', run.id, details);
          db.prepare(`UPDATE canon_runs SET title = ?, parent_series = ?, issue_range_hint = ?, description = ?, status = ?, event_id = ?, cv_volume_id = ?,
            admin_recommended = ?, updated_at = datetime('now') WHERE id = ?`).run(details.title, details.parent_series, details.issue_range_hint, details.description, details.status,
            details.event_id, details.cv_volume_id, details.admin_recommended ? 1 : 0, run.id);
          db.prepare('DELETE FROM canon_run_categories WHERE run_id = ?').run(run.id);
          const cat = db.prepare('INSERT INTO canon_run_categories (run_id, category, adaptation_notes) VALUES (?, ?, ?)');
          for (const c of details.categories) cat.run(run.id, c.category, c.adaptation_notes);
          db.prepare('DELETE FROM canon_run_creators WHERE run_id = ?').run(run.id);
          const cr = db.prepare('INSERT INTO canon_run_creators (run_id, person_name, role) VALUES (?, ?, ?)');
          for (const c of details.creators) cr.run(run.id, c.person_name, c.role);
        }
        const del = db.prepare('DELETE FROM canon_run_issues WHERE id = ? AND run_id = ?'); for (const id of remove) del.run(id, run.id);
        if (order) {
          const upd = db.prepare('UPDATE canon_run_issues SET sort_order = ? WHERE id = ? AND run_id = ?');
          const ins = db.prepare(`INSERT INTO canon_run_issues (run_id, cv_issue_id, scanned_book_id, sort_order, series_name, issue_number, volume_year, manually_matched)
            VALUES (?,?,?,?,?,?,?,?)`);
          order.forEach((x, i) => {
            if (x && typeof x === 'object') { const a = adds.get(x); if (a) ins.run(run.id, a.cv, a.book, i + 1, a.series, a.num, a.year, a.book ? 1 : 0); }
            else upd.run(i + 1, Number(x), run.id);
          });
        }
      })();
      logger?.info?.('editor', 'Top Shelf run saved', { runId: run.id, removed: remove.length, added: adds.size, reordered: !!order, by: req.user?.username });
      res.json({ ok: true, version: runVersion(runRows(run.id), runDetails(run.id)) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.delete('/api/editor/event/:id', requireAdmin, (req, res) => {
    try {
      const ev = db.prepare('SELECT id, name FROM events WHERE id = ?').get(req.params.id);
      if (!ev) return bad(res, 404, 'Event not found');
      let issues = 0, runs = 0;
      db.transaction(() => {
        runs = db.prepare('UPDATE canon_runs SET event_id = NULL WHERE CAST(event_id AS TEXT) = ?').run(String(ev.id)).changes;
        issues = db.prepare('DELETE FROM event_issues WHERE event_id = ?').run(String(ev.id)).changes;
        db.prepare('DELETE FROM events WHERE id = ?').run(ev.id);
      })();
      logger?.info?.('editor', 'Timeline event deleted', { eventId: ev.id, name: ev.name, issues, runsUnlinked: runs, by: req.user?.username });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Deleting a run forgets it completely: the generator is no longer told about it, so it can be
  // suggested again (Block is the way to keep it out; user 2026-10-18).
  const hasProposals = () => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'canon_category_proposals'").get();
  function deleteRun(id) {
    const run = db.prepare('SELECT id, title FROM canon_runs WHERE id = ?').get(id);
    if (!run) return null;
    const tables = ['canon_run_issues', 'canon_run_categories', 'canon_run_creators', ...(hasProposals() ? ['canon_category_proposals'] : [])];
    for (const t of tables) db.prepare(`DELETE FROM ${t} WHERE run_id = ?`).run(run.id);
    db.prepare('DELETE FROM canon_runs WHERE id = ?').run(run.id);
    return run;
  }
  app.delete('/api/editor/run/:id', requireAdmin, (req, res) => {
    try {
      let run = null;
      db.transaction(() => { run = deleteRun(req.params.id); })();
      if (!run) return bad(res, 404, 'Run not found');
      logger?.info?.('editor', 'Top Shelf run deleted', { runId: run.id, title: run.title, by: req.user?.username });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/editor/runs/bulk { ids: [runId], action: approve|pending|block|delete } — Top Shelf's
  // Pending review and Blocked list act on ticked runs. "block" is stored as status 'rejected'
  // (the generator is told never to suggest it); old pages call it Rejected.
  app.post('/api/editor/runs/bulk', requireAdmin, (req, res) => {
    try {
      const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
      const action = req.body && req.body.action;
      const status = { approve: 'approved', pending: 'pending', block: 'rejected' }[action];
      if (!ids.length || (!status && action !== 'delete')) return bad(res, 400, 'Choose runs and an action (approve, pending, block or delete).');
      let n = 0;
      db.transaction(() => {
        for (const id of ids) {
          if (action === 'delete') { if (deleteRun(id)) n++; }
          else n += db.prepare("UPDATE canon_runs SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id).changes;
        }
      })();
      logger?.info?.('editor', `Top Shelf runs: ${action} × ${n}`, { ids: ids.slice(0, 50), by: req.user?.username });
      res.json({ ok: true, changed: n });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/editor/run/:id/status', requireAdmin, (req, res) => {
    try {
      const status = req.body && req.body.status;
      if (!RUN_STATUS.includes(status)) return bad(res, 400, `Status must be one of ${RUN_STATUS.join(', ')}.`);
      const r = db.prepare("UPDATE canon_runs SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, Number(req.params.id));
      if (!r.changes) return bad(res, 404, 'Run not found');
      logger?.info?.('editor', 'Top Shelf run status', { runId: Number(req.params.id), status, by: req.user?.username });
      res.json({ ok: true, status });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { eventRows, runRows };
};
