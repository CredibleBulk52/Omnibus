'use strict';
// Export and import of Essentials, Timeline events and Top Shelf runs between installs (2026-11-12).
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const schema = require('./schema');
const createReadingLists = require('./readingLists');
const { createCuratedTransfer, FORMAT } = require('./curatedTransfer');

// One Omnibus install: its database, reading lists and the transfer module.
function install({ books = [] } = {}) {
  const db = new DatabaseSync(':memory:');
  let depth = 0;
  db.transaction = fn => (...a) => {
    const sp = 'sp' + depth; db.exec(depth ? `SAVEPOINT ${sp}` : 'BEGIN'); depth++;
    try { const r = fn(...a); depth--; db.exec(depth ? `RELEASE ${sp}` : 'COMMIT'); return r; }
    catch (e) { depth--; db.exec(depth ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK'); throw e; }
  };
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT); INSERT INTO users VALUES ('a1','boss','admin'),('u1','reader','user');
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, path TEXT, filename TEXT, issue_number TEXT, title TEXT, comicinfo TEXT, cv_issue_id TEXT, monitored_issue_id TEXT);
    CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER, path TEXT, series_json TEXT); INSERT INTO scanned_series (id, name, year) VALUES ('s1', 'Green Lantern', 2005);
    CREATE TABLE read_progress (id INTEGER PRIMARY KEY, book_id TEXT, user_id TEXT, page INTEGER, completed INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT NOT NULL, publisher TEXT, year INTEGER, cv_story_arc_id TEXT, description TEXT, cover_image TEXT,
      created_at TEXT, source TEXT DEFAULT 'auto', event_tier INTEGER DEFAULT 2, sort_order INTEGER DEFAULT 0, cover_issue_id INTEGER);
    CREATE TABLE event_issues (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, cv_issue_id TEXT, scanned_book_id TEXT, sort_order INTEGER NOT NULL,
      tier TEXT DEFAULT 'recommended', tier_note TEXT, series_name TEXT NOT NULL, issue_number TEXT NOT NULL, issue_title TEXT, volume_year TEXT,
      manually_matched INTEGER DEFAULT 0, phase TEXT, tier_reason TEXT);
    CREATE TABLE canon_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, parent_series TEXT, cv_volume_id TEXT, issue_range_hint TEXT, description TEXT,
      status TEXT NOT NULL DEFAULT 'pending', event_id INTEGER, created_at TEXT, updated_at TEXT, admin_recommended INTEGER DEFAULT 0);
    CREATE TABLE canon_run_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, category TEXT NOT NULL, adaptation_notes TEXT, UNIQUE(run_id, category));
    CREATE TABLE canon_run_creators (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, person_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'writer');
    CREATE TABLE canon_run_issues (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, cv_issue_id TEXT, scanned_book_id INTEGER, sort_order INTEGER NOT NULL DEFAULT 0,
      series_name TEXT, issue_number TEXT, volume_year TEXT, manually_matched INTEGER NOT NULL DEFAULT 0);`);
  schema.applyReadingListsSchema(db);
  require('./homepageFields').ensure(db, ['events', 'canon_runs', 'reading_lists']);
  for (const b of books) db.prepare('INSERT INTO scanned_books (id, series_id, issue_number, cv_issue_id) VALUES (?,?,?,?)').run(b.id, 's1', b.num, b.cv);
  const routes = {};
  const reg = m => (p, ...h) => { routes[m + ' ' + p] = h.at(-1); };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE') };
  const logger = { info() {}, warn() {}, error() {} };
  const readingLists = createReadingLists({ app, db, requireAuth: (q, r, n) => n(), cvApiGet: async () => null, getCVKey: () => null, logger,
    IN: { normIssueNumber: n => String(n) } });
  // Stand-ins for the scan matchers: match by Comic Vine issue id.
  const byCv = table => async () => db.exec(`UPDATE ${table} SET scanned_book_id = (SELECT id FROM scanned_books sb WHERE sb.cv_issue_id = ${table}.cv_issue_id)
    WHERE scanned_book_id IS NULL AND cv_issue_id IS NOT NULL`);
  const transfer = createCuratedTransfer({ app, db, requireAdmin: () => {}, logger, readingLists, reconcileEvents: byCv('event_issues'), reconcileRuns: byCv('canon_run_issues') });
  const admin = { sub: 'a1', role: 'admin', username: 'boss' };
  const exportRoute = (kind, id, user = admin) => {
    const out = { headers: {} };
    const res = { set(k, v) { out.headers[k] = v; return res; }, type() { return res; }, send(v) { out.body = JSON.parse(v); }, status(c) { out.code = c; return res; }, json(v) { out.body = v; } };
    routes['GET /api/curated/:kind/:id/export']({ params: { kind, id: String(id) }, user }, res);
    return out;
  };
  return { db, transfer, admin, exportRoute };
}

function source() {
  const s = install();
  s.db.exec(`INSERT INTO events (id, name, publisher, year, description, event_tier, sort_order) VALUES ('ev-1', 'Blackest Night', 'DC Comics', 2009, 'The dead rise.', 1, 2);
    INSERT INTO event_issues (id, event_id, cv_issue_id, scanned_book_id, sort_order, tier, tier_note, series_name, issue_number, volume_year, phase, tier_reason) VALUES
      (1, 'ev-1', '1001', 'local-1', 1, 'essential', 'Start here.', 'Blackest Night', '0', '2009', 'Prelude', 'The event opens here.'),
      (2, 'ev-1', '1002', NULL, 2, 'essential', NULL, 'Blackest Night', '1', '2009', 'Main', NULL),
      (3, 'ev-1', '2043', NULL, 3, 'tie-in', 'Optional.', 'Green Lantern', '43', '2005', 'Main', NULL);
    UPDATE events SET cover_issue_id = 2 WHERE id = 'ev-1';
    INSERT INTO canon_runs (id, title, parent_series, issue_range_hint, description, status, event_id, cv_volume_id) VALUES (9, 'Green Lantern by Geoff Johns', 'Green Lantern', '#1–67', 'The modern classic.', 'approved', 'ev-1', '17950');
    INSERT INTO canon_run_categories (run_id, category, adaptation_notes) VALUES (9, 'adapted_to_screen', 'Green Lantern (2011)');
    INSERT INTO canon_run_creators (run_id, person_name, role) VALUES (9, 'Geoff Johns', 'writer');
    INSERT INTO canon_run_issues (run_id, cv_issue_id, scanned_book_id, sort_order, series_name, issue_number, volume_year) VALUES (9, '2001', 77, 1, 'Green Lantern', '1', '2005'), (9, '2002', NULL, 2, 'Green Lantern', '2', '2005');
    INSERT INTO reading_lists (id, name, description, owner_id, visibility, catalog_json) VALUES (1, 'Green Lantern: Where to start', '**Brightest day.**', 'a1', 'essential', '{"collections":["DC Journeys"]}');
    INSERT INTO reading_list_entries (id, list_id, sort_order, entry_type, label, note, unpacked, resolve_status) VALUES (11, 1, 1, 'section', 'Rebirth', NULL, 0, 'ok'),
      (12, 1, 2, 'story', 'Rebirth', 'Read this first.', 1, 'ok'), (13, 1, 3, 'issue', 'Green Lantern #1', NULL, 0, 'ok');
    INSERT INTO reading_list_entries (id, list_id, sort_order, entry_type, ref_id, label, unpacked, resolve_status, tier_filter) VALUES (14, 1, 4, 'event', 'ev-1', 'Blackest Night', 0, 'ok', 'essential'),
      (15, 1, 5, 'canon_run', '9', 'Johns run', 0, 'ok', NULL);
    INSERT INTO reading_list_entries (id, list_id, sort_order, entry_type, cv_volume_id, issue_start, issue_end, label, unpacked, resolve_status) VALUES (16, 1, 6, 'range', '17950', '1', '2', 'Green Lantern (2005) #1–2', 0, 'ok');
    INSERT INTO list_issues (owner_kind, owner_id, sort_order, cv_issue_id, scanned_book_id, series_name, issue_number, volume_year) VALUES
      ('reading_list_entry', 12, 1, '3001', 'local-9', 'Green Lantern: Rebirth', '1', 2004), ('reading_list_entry', 12, 2, '3002', NULL, 'Green Lantern: Rebirth', '2', 2004),
      ('reading_list_entry', 13, 1, '2001', NULL, 'Green Lantern', '1', 2005),
      ('reading_list_entry', 16, 1, '2001', NULL, 'Green Lantern', '1', 2005), ('reading_list_entry', 16, 2, '2002', NULL, 'Green Lantern', '2', 2005);
    INSERT INTO reading_lists (id, name, owner_id, visibility) VALUES (2, 'Secret', 'u1', 'private');`);
  return s;
}

test('exports carry structure and Comic Vine ids, never this library\'s book ids', () => {
  const s = source();
  const ev = s.transfer.exportFile('event', 'ev-1');
  assert.equal(ev.format, FORMAT); assert.equal(ev.version, 1); assert.equal(ev.kind, 'event');
  assert.equal(ev.item.name, 'Blackest Night'); assert.equal(ev.item.cover_issue, 1);
  assert.deepEqual(ev.issues.map(i => [i.series_name, i.issue_number, i.tier, i.phase]), [['Blackest Night', '0', 'essential', 'Prelude'], ['Blackest Night', '1', 'essential', 'Main'], ['Green Lantern', '43', 'tie-in', 'Main']]);
  const run = s.transfer.exportFile('run', 9);
  assert.equal(run.item.event.name, 'Blackest Night'); assert.equal(run.item.creators[0].person_name, 'Geoff Johns');
  const list = s.transfer.exportFile('list', 1);
  assert.deepEqual(list.item.collections, ['DC Journeys']);
  assert.deepEqual(list.entries.map(e => e.type), ['section', 'story', 'issue', 'event', 'canon_run', 'range']);
  assert.equal(list.entries[3].source.name, 'Blackest Night'); assert.equal(list.entries[3].tier_filter, 'essential');
  assert.equal(list.entries[3].issues.length, 2, 'an event entry carries the issues its tier filter shows');
  for (const file of [ev, run, list]) assert.doesNotMatch(JSON.stringify(file), /local-|scanned_book|"77"/);
  const r = s.exportRoute('event', 'ev-1');
  assert.match(r.headers['Content-Disposition'], /omnibus-event-blackest-night\.json/);
  assert.equal(s.exportRoute('list', 2).code, 404, 'another user\'s private list is not exported, even for an admin');
});

test('an event imports as a hidden draft, keeps tiers, phases and cover, and matches the library', async () => {
  const file = source().transfer.exportFile('event', 'ev-1');
  const t = install({ books: [{ id: 'b-1001', num: '0', cv: '1001' }, { id: 'b-1002', num: '1', cv: '1002' }] });
  const out = await t.transfer.importFile(file, t.admin);
  assert.equal(out.kind, 'event'); assert.match(out.editUrl, /^\/events\/.+\/edit$/);
  const ev = t.db.prepare('SELECT * FROM events WHERE id = ?').get(out.id);
  assert.equal(ev.draft, 1); assert.equal(ev.source, 'import'); assert.equal(ev.event_tier, 1);
  const rows = t.db.prepare('SELECT id, tier, tier_note, phase, scanned_book_id, tier_reason FROM event_issues WHERE event_id = ? ORDER BY sort_order').all(out.id);
  assert.deepEqual(rows.map(r => [r.tier, r.phase, r.scanned_book_id]), [['essential', 'Prelude', 'b-1001'], ['essential', 'Main', 'b-1002'], ['tie-in', 'Main', null]]);
  assert.equal(rows[0].tier_note, 'Start here.'); assert.equal(rows[0].tier_reason, 'The event opens here.');
  assert.equal(ev.cover_issue_id, rows[1].id);
  assert.equal(out.summary.issues, 3); assert.equal(out.summary.owned, 2);
  assert.equal(require('./eventDrafts').published(t.db), 'COALESCE(draft, 0) = 0');
  assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${require('./eventDrafts').published(t.db)}`).get().n, 0, 'hidden from readers');
});

test('a run imports as pending with its categories, creators and event link', async () => {
  const s = source();
  const t = install({ books: [{ id: 'b-2001', num: '1', cv: '2001' }] });
  const evOut = await t.transfer.importFile(s.transfer.exportFile('event', 'ev-1'), t.admin);
  const out = await t.transfer.importFile(s.transfer.exportFile('run', 9), t.admin);
  const run = t.db.prepare('SELECT * FROM canon_runs WHERE id = ?').get(out.id);
  assert.equal(run.status, 'pending'); assert.equal(run.title, 'Green Lantern by Geoff Johns'); assert.equal(String(run.event_id), evOut.id);
  assert.deepEqual(t.db.prepare('SELECT category, adaptation_notes FROM canon_run_categories WHERE run_id = ?').all(out.id).map(c => ({ ...c })), [{ category: 'adapted_to_screen', adaptation_notes: 'Green Lantern (2011)' }]);
  assert.equal(out.summary.owned, 1); assert.equal(out.summary.eventLinked, true);
  const lone = install();
  const o2 = await lone.transfer.importFile(s.transfer.exportFile('run', 9), lone.admin);
  assert.equal(o2.summary.eventMissing, true, 'no event of that name here: imported unlinked, and said so');
});

test('a list imports as the admin\'s private draft; event entries follow a same-named event or keep their issues', async () => {
  const s = source();
  const t = install({ books: [{ id: 'b-3001', num: '1', cv: '3001' }, { id: 'b-2001', num: '1', cv: '2001' }] });
  const out = await t.transfer.importFile(s.transfer.exportFile('list', 1), t.admin);
  assert.equal(out.editUrl, `/reading-lists/${out.id}/edit`);
  const list = t.db.prepare('SELECT * FROM reading_lists WHERE id = ?').get(out.id);
  assert.equal(list.visibility, 'private'); assert.equal(list.owner_id, 'a1'); assert.equal(list.source, 'import');
  const cat = JSON.parse(list.catalog_json);
  assert.equal(t.db.prepare('SELECT name FROM essential_collections WHERE id = ?').get(cat.collections[0]).name, 'DC Journeys');
  const es = t.db.prepare('SELECT id, entry_type, label, note, unpacked, cv_volume_id, resolve_status FROM reading_list_entries WHERE list_id = ? ORDER BY sort_order').all(out.id);
  // No Blackest Night or Johns run here: those entries keep their issues as stories.
  assert.deepEqual(es.map(e => e.entry_type), ['section', 'story', 'issue', 'story', 'story', 'range']);
  assert.equal(es[1].note, 'Read this first.');
  assert.equal(es[5].cv_volume_id, '17950', 'a range that follows a Comic Vine volume keeps following it');
  assert.equal(out.summary.copied, 2); assert.equal(out.summary.linked, 0);
  assert.ok(out.summary.owned >= 2, 'issues match the library by Comic Vine id');
  // With the event imported first, the list follows it instead.
  const t2 = install();
  const ev = await t2.transfer.importFile(s.transfer.exportFile('event', 'ev-1'), t2.admin);
  const o2 = await t2.transfer.importFile(s.transfer.exportFile('list', 1), t2.admin);
  const linked = t2.db.prepare(`SELECT ref_id, tier_filter FROM reading_list_entries WHERE list_id = ? AND entry_type = 'event'`).get(o2.id);
  assert.equal(linked.ref_id, ev.id); assert.equal(linked.tier_filter, 'essential'); assert.equal(o2.summary.linked, 1);
});

test('files that are not Omnibus exports, or from a newer version, are refused', async () => {
  const t = install();
  for (const [file, msg] of [[null, /not an Omnibus export/], [{ format: 'other' }, /unknown format/], [{ format: FORMAT, version: 99, kind: 'event', item: {} }, /newer version/],
    [{ format: FORMAT, version: 1, kind: 'box', item: {} }, /not an Essential/], [{ format: FORMAT, version: 1, kind: 'event', item: { name: 'X' }, issues: [] }, /no issues/]]) {
    await assert.rejects(t.transfer.importFile(file, t.admin), e => e.status === 400 && msg.test(e.message));
  }
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
});

test('the editor shows an imported event as a draft, and publishing it clears the flag', async () => {
  const t = install();
  const out = await t.transfer.importFile(source().transfer.exportFile('event', 'ev-1'), t.admin);
  const routes = {};
  const reg = m => (p, ...h) => { routes[m + ' ' + p] = h.at(-1); };
  require('./curatedEditor')({ app: { get: reg('GET'), post: reg('POST'), delete: reg('DELETE') }, db: t.db, requireAdmin: () => {}, logger: { info() {} } });
  const call = (key, body) => { const o = {}; const res = { status(c) { o.code = c; return res; }, json(v) { o.body = v; } }; routes[key]({ params: { id: out.id }, body, user: { username: 'boss' } }, res); return o; };
  const loaded = call('GET /api/editor/event/:id');
  assert.equal(loaded.body.details.draft, 1);
  const saved = call('POST /api/editor/event/:id/save', { version: loaded.body.version, order: loaded.body.rows.map(r => r.id), details: { draft: false } });
  assert.equal(saved.body.ok, true);
  assert.equal(t.db.prepare('SELECT draft FROM events WHERE id = ?').get(out.id).draft, 0);
});
