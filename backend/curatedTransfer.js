'use strict';
// ─── curatedTransfer.js (2026-11-12) ──────────────────────────────
// Export and import of curated reading orders between Omnibus installs: Essentials (and other
// reading lists), Timeline events and Top Shelf runs. Admin only.
//
//   GET  /api/curated/:kind/:id/export   kind: list | event | run → the file (JSON, downloaded)
//   POST /api/curated/import             the file → { kind, id, name, editUrl, summary }
//
// The file carries structure and words (names, descriptions, notes, tiers) and, per issue, the
// series name, volume year, issue number and Comic Vine issue id: never this library's book or
// series ids, covers or comics. An import is a draft until published in the editor:
//   list  → the admin's private list (Details › Who can see it: Essential)
//   event → events.draft = 1 (Details › Hidden draft off)
//   run   → status pending (Details › Status: Approved)
// Issues are matched to the library at once (the same matchers as after a scan).
const crypto = require('node:crypto');

const FORMAT = 'omnibus-curated';
const VERSION = 1;
const KINDS = ['list', 'event', 'run'];
const EVENT_TIERS = ['essential', 'recommended', 'tie-in', 'aftermath'];
const RUN_CATEGORIES = ['adapted_to_screen', 'award_winning', 'critically_acclaimed'];
const RUN_ROLES = ['writer', 'penciler', 'inker', 'artist', 'colorist', 'letterer'];
const MAX_ISSUES = 2000;

const txt = (v, max) => { const t = v == null ? '' : String(v).trim(); return t ? t.slice(0, max) : null; };
const int = v => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));
class Bad extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const slug = s => String(s || 'export').toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'export';

// An issue as it travels, and back.
const issueOut = r => ({ series_name: r.series_name || null, volume_year: int(r.volume_year), issue_number: r.issue_number == null ? null : String(r.issue_number),
  issue_title: r.issue_title || null, cv_issue_id: r.cv_issue_id ? String(r.cv_issue_id) : null });
function issueIn(i) {
  if (!i || typeof i !== 'object') return null;
  const series = txt(i.series_name, 300), num = txt(i.issue_number, 40);
  if (!series || !num) return null;
  return { series, num, year: int(i.volume_year), title: txt(i.issue_title, 300), cv: txt(i.cv_issue_id, 40) };
}

// Check the envelope of an uploaded file; returns its kind.
function checkFile(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Bad('That is not an Omnibus export file.');
  if (data.format !== FORMAT) throw new Bad('That is not an Omnibus export file (unknown format).');
  if (!Number.isInteger(data.version) || data.version < 1) throw new Bad('The file has no version.');
  if (data.version > VERSION) throw new Bad('This file was made by a newer version of Omnibus. Update Omnibus, then import it again.');
  if (!KINDS.includes(data.kind)) throw new Bad('The file is not an Essential, a Timeline event or a Top Shelf run.');
  if (!data.item || typeof data.item !== 'object') throw new Bad('The file has no details.');
  return data.kind;
}

function createCuratedTransfer({ app, db, requireAdmin, logger, readingLists, reconcileEvents, reconcileRuns, appVersion = null }) {
  const drafts = require('./eventDrafts');
  const hasCol = (table, col) => { try { return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col); } catch { return false; } };

  // ── Timeline events ──
  function exportEvent(id) {
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(String(id));
    if (!ev) throw new Bad('Timeline event not found', 404);
    const reason = hasCol('event_issues', 'tier_reason') ? ', tier_reason' : '';
    const rows = db.prepare(`SELECT id, series_name, volume_year, issue_number, issue_title, cv_issue_id, tier, tier_note, phase${reason}
      FROM event_issues WHERE event_id = ? ORDER BY sort_order, id`).all(String(ev.id));
    const cover = ev.cover_issue_id != null ? rows.findIndex(r => r.id === ev.cover_issue_id) : -1;
    return {
      item: { name: ev.name, publisher: ev.publisher || null, year: int(ev.year), description: ev.description || null, event_tier: int(ev.event_tier),
        sort_order: int(ev.sort_order), cover_image: ev.cover_image || null, home_tagline: ev.home_tagline || null, home_description: ev.home_description || null,
        cover_issue: cover >= 0 ? cover : null },
      issues: rows.map(r => ({ ...issueOut(r), tier: r.tier || 'recommended', tier_note: r.tier_note || null, phase: r.phase || null, ...(r.tier_reason ? { tier_reason: r.tier_reason } : {}) })),
    };
  }
  function importEvent(data, user) {
    const it = data.item;
    const name = txt(it.name, 200);
    if (!name) throw new Bad('The file has no event name.');
    const issues = (Array.isArray(data.issues) ? data.issues : []).slice(0, MAX_ISSUES).map(i => ({ i, a: issueIn(i) })).filter(x => x.a);
    if (!issues.length) throw new Bad('The file has no issues.');
    drafts.ensure(db);
    const id = crypto.randomUUID();
    const tierOk = t => (EVENT_TIERS.includes(t) ? t : 'recommended');
    const year = int(it.year), tier = [1, 2, 3].includes(int(it.event_tier)) ? int(it.event_tier) : 2;
    const reason = hasCol('event_issues', 'tier_reason');
    const same = db.prepare('SELECT COUNT(*) AS n FROM events WHERE lower(name) = lower(?) AND (year IS ? OR year = ?)').get(name, year, year).n;
    db.transaction(() => {
      db.prepare(`INSERT INTO events (id, name, publisher, year, description, cover_image, event_tier, sort_order, source, draft)
        VALUES (?,?,?,?,?,?,?,?,'import',1)`).run(id, name, txt(it.publisher, 120), year && year >= 1900 && year <= 2100 ? year : null,
        txt(it.description, 8000), txt(it.cover_image, 1000), tier, Math.max(0, int(it.sort_order) || 0));
      require('./homepageFields').write(db, 'events', id, { home_tagline: txt(it.home_tagline, 120), home_description: txt(it.home_description, 400) });
      const ins = db.prepare(`INSERT INTO event_issues (event_id, cv_issue_id, scanned_book_id, sort_order, tier, tier_note, series_name, issue_number, issue_title,
          volume_year, manually_matched, phase${reason ? ', tier_reason' : ''}) VALUES (?,?,NULL,?,?,?,?,?,?,?,0,?${reason ? ',?' : ''})`);
      const ids = issues.map(({ i, a }, n) => Number(ins.run(id, a.cv, n + 1, tierOk(i.tier), txt(i.tier_note, 1000), a.series, a.num, a.title,
        a.year == null ? null : String(a.year), txt(i.phase, 120), ...(reason ? [txt(i.tier_reason, 1000)] : [])).lastInsertRowid));
      const cover = int(it.cover_issue);
      if (cover != null && ids[cover]) db.prepare('UPDATE events SET cover_issue_id = ? WHERE id = ?').run(ids[cover], id);
    })();
    return { id, name, editUrl: `/events/${id}/edit`, summary: { issues: issues.length, sameName: same } };
  }
  const eventOwned = id => db.prepare('SELECT COUNT(*) AS n FROM event_issues WHERE event_id = ? AND scanned_book_id IS NOT NULL').get(String(id)).n;

  // ── Top Shelf runs ──
  function exportRun(id) {
    const run = db.prepare('SELECT * FROM canon_runs WHERE id = ?').get(int(id));
    if (!run) throw new Bad('Top Shelf run not found', 404);
    const rows = db.prepare('SELECT series_name, volume_year, issue_number, cv_issue_id FROM canon_run_issues WHERE run_id = ? ORDER BY sort_order, id').all(run.id);
    const ev = run.event_id != null ? db.prepare('SELECT name, year FROM events WHERE id = ?').get(String(run.event_id)) : null;
    return {
      item: { title: run.title, parent_series: run.parent_series || null, issue_range_hint: run.issue_range_hint || null, description: run.description || null,
        cv_volume_id: run.cv_volume_id || null, home_tagline: run.home_tagline || null, home_description: run.home_description || null,
        categories: db.prepare('SELECT category, adaptation_notes FROM canon_run_categories WHERE run_id = ? ORDER BY id').all(run.id).map(c => ({ ...c })),
        creators: db.prepare('SELECT person_name, role FROM canon_run_creators WHERE run_id = ? ORDER BY id').all(run.id).map(c => ({ ...c })),
        event: ev ? { name: ev.name, year: int(ev.year) } : null },
      issues: rows.map(issueOut),
    };
  }
  function importRun(data, user) {
    const it = data.item;
    const title = txt(it.title, 300);
    if (!title) throw new Bad('The file has no run title.');
    const issues = (Array.isArray(data.issues) ? data.issues : []).slice(0, MAX_ISSUES).map(issueIn).filter(Boolean);
    if (!issues.length) throw new Bad('The file has no issues.');
    let eventId = null;
    if (it.event && typeof it.event === 'object' && it.event.name) {
      const evs = db.prepare('SELECT id, year FROM events WHERE lower(name) = lower(?)').all(String(it.event.name));
      const ev = evs.find(e => it.event.year && Number(e.year) === Number(it.event.year)) || (evs.length === 1 ? evs[0] : null);
      eventId = ev ? String(ev.id) : null;
    }
    const same = db.prepare('SELECT COUNT(*) AS n FROM canon_runs WHERE lower(title) = lower(?)').get(title).n;
    let id;
    db.transaction(() => {
      id = Number(db.prepare(`INSERT INTO canon_runs (title, parent_series, cv_volume_id, issue_range_hint, description, status, event_id)
        VALUES (?,?,?,?,?,'pending',?)`).run(title, txt(it.parent_series, 200), txt(it.cv_volume_id, 40), txt(it.issue_range_hint, 120), txt(it.description, 8000), eventId).lastInsertRowid);
      require('./homepageFields').write(db, 'canon_runs', id, { home_tagline: txt(it.home_tagline, 120), home_description: txt(it.home_description, 400) });
      const seen = new Set();
      for (const c of Array.isArray(it.categories) ? it.categories : []) {
        if (!c || !RUN_CATEGORIES.includes(c.category) || seen.has(c.category)) continue;
        seen.add(c.category);
        db.prepare('INSERT INTO canon_run_categories (run_id, category, adaptation_notes) VALUES (?,?,?)').run(id, c.category, txt(c.adaptation_notes, 500));
      }
      for (const c of (Array.isArray(it.creators) ? it.creators : []).slice(0, 40)) {
        const person = txt(c && c.person_name, 200);
        if (person) db.prepare('INSERT INTO canon_run_creators (run_id, person_name, role) VALUES (?,?,?)').run(id, person, RUN_ROLES.includes(c.role) ? c.role : 'writer');
      }
      const ins = db.prepare(`INSERT INTO canon_run_issues (run_id, cv_issue_id, scanned_book_id, sort_order, series_name, issue_number, volume_year, manually_matched)
        VALUES (?,?,NULL,?,?,?,?,0)`);
      issues.forEach((a, n) => ins.run(id, a.cv, n + 1, a.series, a.num, a.year == null ? null : String(a.year)));
    })();
    return { id, name: title, editUrl: `/canon/run/${id}/edit`, summary: { issues: issues.length, sameName: same, eventLinked: !!eventId, eventMissing: !!(it.event && it.event.name && !eventId) } };
  }
  const runOwned = id => db.prepare('SELECT COUNT(*) AS n FROM canon_run_issues WHERE run_id = ? AND scanned_book_id IS NOT NULL').get(int(id)).n;

  // ── Routes ──
  function exportFile(kind, id, user = null) {
    if (kind === 'list') {   // someone else's private list stays private, even from admins
      const l = db.prepare('SELECT owner_id, visibility FROM reading_lists WHERE id = ?').get(int(id));
      if (!l || (l.visibility === 'private' && user && l.owner_id !== user.sub)) throw new Bad('Reading list not found', 404);
    }
    const body = kind === 'list' ? readingLists.exportList(id) : kind === 'event' ? exportEvent(id) : exportRun(id);
    return { format: FORMAT, version: VERSION, kind, exported_at: new Date().toISOString(), ...(appVersion ? { app_version: appVersion } : {}), ...body };
  }
  async function importFile(data, user) {
    const kind = checkFile(data);
    let out;
    if (kind === 'list') {
      out = readingLists.importList(data, user);
      out.editUrl = `/reading-lists/${out.id}/edit`;
    } else if (kind === 'event') {
      out = importEvent(data, user);
      try { await reconcileEvents(); } catch (e) { logger?.warn?.('curated', 'Matching after import failed; the next scan will match', { error: e.message }); }
      out.summary.owned = eventOwned(out.id);
    } else {
      out = importRun(data, user);
      try { await reconcileRuns(); } catch (e) { logger?.warn?.('curated', 'Matching after import failed; the next scan will match', { error: e.message }); }
      out.summary.owned = runOwned(out.id);
    }
    logger?.info?.('curated', 'Imported', { kind, id: out.id, name: out.name, ...out.summary, by: user?.username });
    return { kind, ...out };
  }

  if (app) {
    app.get('/api/curated/:kind/:id/export', requireAdmin, (req, res) => {
      try {
        if (!KINDS.includes(req.params.kind)) throw new Bad('Unknown kind', 404);
        const file = exportFile(req.params.kind, req.params.id, req.user);
        const name = file.item.name || file.item.title;
        const label = { list: 'list', event: 'event', run: 'run' }[req.params.kind];
        res.set('Content-Disposition', `attachment; filename="omnibus-${label}-${slug(name)}.json"`);
        res.set('Cache-Control', 'no-store');
        res.type('application/json').send(JSON.stringify(file, null, 2));
      } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Unable to export' }); }
    });
    app.post('/api/curated/import', requireAdmin, async (req, res) => {
      try { res.status(201).json(await importFile(req.body, req.user)); }
      catch (e) {
        if (!e.status) logger?.error?.('curated', 'Import failed', { error: e.message });
        res.status(e.status || 500).json({ error: e.status ? e.message : 'Unable to import that file' });
      }
    });
  }
  return { exportFile, importFile, checkFile };
}

module.exports = { createCuratedTransfer, FORMAT, VERSION };
