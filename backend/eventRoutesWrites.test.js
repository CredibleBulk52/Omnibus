'use strict';
// Creating and updating events (2026-11-25): a create whose issues are refused leaves no empty event,
// a missing sort_order takes the issue's place, and an update changes only the fields it sends.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { registerEventRoutes, NEEDS } = require('./eventRoutes');

async function setup() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT NOT NULL, publisher TEXT, year INTEGER, cv_story_arc_id TEXT, description TEXT,
      cover_image TEXT, source TEXT, generator_sources TEXT, event_tier INTEGER DEFAULT 2, sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE event_issues (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE, cv_issue_id TEXT,
      scanned_book_id TEXT, sort_order INTEGER NOT NULL, tier TEXT, tier_note TEXT, phase TEXT, series_name TEXT NOT NULL, issue_number TEXT NOT NULL,
      issue_title TEXT, volume_year TEXT, sources TEXT, order_note TEXT, order_flag TEXT, tier_reason TEXT, manually_matched INTEGER DEFAULT 0);`);
  const app = express(); app.use(express.json());
  const pass = (req, res, next) => next();
  const deps = Object.fromEntries(NEEDS.map(k => [k, () => {}]));
  Object.assign(deps, { app, db, requireAdmin: pass, requireAuth: pass, EVENT_ADMIN_ONLY: false, THUMB_CACHE_DIR: '/nonexistent',
    logger: { info() {}, warn() {}, error() {} }, editorTools: { fillUnmatched() {} }, reconcileEventIssues() {},
    aiInfo: { track: () => pass }, modelCatalog: {}, ai: {}, coverThumb: {} });
  registerEventRoutes(deps);
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  return { db, call, close: () => server.close() };
}

test('create: a refused issue leaves no event; a missing sort_order takes the issue\'s place', async () => {
  const { db, call, close } = await setup();
  try {
    let r = await call('POST', '/api/events', { name: 'Zero Hour', issues: [{ series_name: 'Zero Hour', issue_number: '4' }, { series_name: '', issue_number: '3' }] });
    assert.equal(r.status, 400); assert.match(r.json.error, /issue 2/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 0, 'no empty event left behind');
    r = await call('POST', '/api/events', { name: 'Zero Hour', issues: [{ series_name: 'Zero Hour', issue_number: '4' }, { series_name: 'Zero Hour', issue_number: '3', sort_order: 7 }, { series_name: 'Zero Hour', issue_number: '2' }] });
    assert.equal(r.status, 200);
    assert.deepEqual(db.prepare('SELECT issue_number, sort_order FROM event_issues WHERE event_id = ? ORDER BY id').all(r.json.id).map(x => [x.issue_number, x.sort_order]), [['4', 1], ['3', 7], ['2', 3]]);
    // A database error part-way also leaves nothing: the event and its issues are one transaction.
    db.exec("CREATE TRIGGER no_five BEFORE INSERT ON event_issues WHEN NEW.issue_number = '5' BEGIN SELECT RAISE(ABORT, 'refused'); END");
    r = await call('POST', '/api/events', { name: 'Final Night', issues: [{ series_name: 'Final Night', issue_number: '1' }, { series_name: 'Final Night', issue_number: '5' }] });
    assert.equal(r.status, 500);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE name = 'Final Night'").get().n, 0);
  } finally { close(); }
});

test('update: only the fields sent change; an empty name is refused', async () => {
  const { db, call, close } = await setup();
  try {
    db.prepare("INSERT INTO events (id, name, publisher, year, description, event_tier, sort_order) VALUES ('e1', 'Knightfall', 'DC', 1993, 'Bane breaks the Bat.', 1, 4)").run();
    const row = () => ({ ...db.prepare('SELECT name, publisher, year, description, event_tier, sort_order FROM events WHERE id = ?').get('e1') });
    let r = await call('PUT', '/api/events/e1', { sort_order: 9 });
    assert.equal(r.status, 200);
    assert.deepEqual(row(), { name: 'Knightfall', publisher: 'DC', year: 1993, description: 'Bane breaks the Bat.', event_tier: 1, sort_order: 9 });
    r = await call('PUT', '/api/events/e1', { description: '' });   // sent empty: cleared, as before
    assert.equal(row().description, null);
    r = await call('PUT', '/api/events/e1', { name: '  ' }); assert.equal(r.status, 400);
    r = await call('PUT', '/api/events/e1', {}); assert.equal(r.status, 400);
    r = await call('PUT', '/api/events/nope', { name: 'X' }); assert.equal(r.status, 404);
    // A full body behaves as before.
    r = await call('PUT', '/api/events/e1', { name: 'Knightfall', publisher: '', year: '', description: 'x', cover_image: '', event_tier: null, sort_order: null });
    assert.deepEqual(row(), { name: 'Knightfall', publisher: null, year: null, description: 'x', event_tier: 2, sort_order: 0 });
  } finally { close(); }
});
