'use strict';
// Missing reading-list issues → Download Manager (admin / open downloads) or a
// request to the admin (Download Manager admin-only).
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const createDownloadRequests = require('./downloadRequests');

function setup(adminOnly) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT);
    CREATE TABLE reading_lists (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE list_issues (id INTEGER PRIMARY KEY, scanned_book_id TEXT, scanned_series_id TEXT, series_name TEXT, issue_number TEXT, volume_year INTEGER, cv_issue_id TEXT);
    CREATE TABLE scanned_series (id TEXT PRIMARY KEY, monitored_series_id TEXT);
    CREATE TABLE monitored_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER);
    CREATE TABLE monitored_issues (id TEXT PRIMARY KEY, series_id TEXT, issue_number TEXT, status TEXT, is_annual INTEGER DEFAULT 0);
    INSERT INTO users VALUES ('u1', 'reader', 'user'), ('a1', 'boss', 'admin');
    INSERT INTO reading_lists VALUES (7, 'Wally West');
    INSERT INTO monitored_series VALUES ('91750', 'The Flash', 2016);
    INSERT INTO monitored_issues VALUES ('500', '91750', '50', 'skipped', 0), ('900', '91750', '1', 'wanted', 1);
    INSERT INTO scanned_series VALUES ('ss1', '91750');
    INSERT INTO list_issues VALUES
      (1, NULL, NULL, 'Impulse', '1', 1995, NULL),
      (2, NULL, NULL, 'The Flash', '50', 2016, '500'),
      (3, NULL, 'ss1', 'The Flash Annual', '1', 2016, NULL);
  `);
  const routes = {};
  const app = { get: (p, ...h) => { routes['GET ' + p] = h.at(-1); }, post: (p, ...h) => { routes['POST ' + p] = h.at(-1); } };
  const r = createDownloadRequests({ app, db, requireAuth: null, requireAdmin: null,
    getSetting: k => (k === 'download_manager_admin_only' ? String(adminOnly) : null),
    logger: { info() {} }, IN: { normIssueNumber: s => String(s).replace(/^0+(?=\d)/, '') } });
  const call = (key, req) => { let out, code = 200; routes[key](req, { json: d => { out = d; }, status: c => { code = c; return { json: d => { out = d; } }; } }); return { code, out }; };
  return { db, r, call };
}
const user = { sub: 'u1', role: 'user' }, admin = { sub: 'a1', role: 'admin' };
const row = (db, id) => db.prepare('SELECT * FROM list_issues WHERE id = ?').get(id);

test('admin: unmonitored series opens Add Series; monitored issues report their status', () => {
  const { db, r } = setup(true);
  assert.deepStrictEqual(r.info(row(db, 1), admin), { mode: 'download', monitored: null, plan: null, search: 'Impulse', request: null });
  assert.strictEqual(r.info(row(db, 2), admin).monitored.status, 'skipped');           // by CV issue id
  const ann = r.info(row(db, 3), admin).monitored;                                     // by folder → monitored series, annual #1 not #1
  assert.deepStrictEqual([ann.issue_id, ann.status], ['900', 'wanted']);
});

test('users get the Download Manager path when downloads are open to all', () => {
  const { db, r } = setup(false);
  assert.strictEqual(r.info(row(db, 1), user).mode, 'download');
  assert.throws(() => r.request(row(db, 1), { id: 7 }, user), /Download Manager/);
});

test('admin-only downloads: users request; duplicates collapse; admin sees, adds, dismisses', () => {
  const { db, r, call } = setup(true);
  const i = r.info(row(db, 1), user);
  assert.deepStrictEqual([i.mode, i.monitored, i.request], ['request', null, null]);
  const q = r.request(row(db, 1), { id: 7 }, user);
  assert.strictEqual(q.status, 'open');
  assert.strictEqual(r.request(row(db, 1), { id: 7 }, user).id, q.id);                 // still open: no duplicate
  assert.deepStrictEqual(r.mineForList(7, 'u1'), { 1: 'open' });
  const list = call('GET /api/download-requests', { query: {} }).out;
  assert.strictEqual(list.open, 1);
  assert.deepStrictEqual([list.requests[0].user, list.requests[0].list_name, list.requests[0].search], ['reader', 'Wally West', 'Impulse']);
  assert.strictEqual(call('POST /api/download-requests/:id', { params: { id: q.id }, body: { status: 'dismissed' }, user: admin }).out.open, 0);
  assert.strictEqual(r.info(row(db, 1), user).request.status, 'dismissed');
  const again = r.request(row(db, 1), { id: 7 }, user);                                  // dismissed → may ask again
  assert.notStrictEqual(again.id, q.id);
  assert.strictEqual(call('POST /api/download-requests/:id', { params: { id: again.id }, body: { status: 'nope' } }).code, 400);
  db.prepare("UPDATE list_issues SET scanned_book_id = 'b1' WHERE id = 1").run();
  assert.strictEqual(r.info(row(db, 1), user).request.owned, true);
});
