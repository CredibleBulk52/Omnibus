'use strict';
// Requests for series-page issues and whole series, and problem reports (2026-10-28).
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const createDownloadRequests = require('./downloadRequests');
const createProblemReports = require('./problemReports');

function harness(adminOnly = true) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT);
    CREATE TABLE reading_lists (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE list_issues (id INTEGER PRIMARY KEY, scanned_book_id TEXT, scanned_series_id TEXT, series_name TEXT, issue_number TEXT, volume_year INTEGER, cv_issue_id TEXT);
    CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER, monitored_series_id TEXT);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, cv_issue_id TEXT);
    CREATE TABLE monitored_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER);
    CREATE TABLE monitored_issues (id TEXT PRIMARY KEY, series_id TEXT, issue_number TEXT, status TEXT, is_annual INTEGER DEFAULT 0);
    CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE event_issues (id INTEGER PRIMARY KEY, event_id TEXT, cv_issue_id TEXT, scanned_book_id TEXT, series_name TEXT, issue_number TEXT, volume_year INTEGER);
    CREATE TABLE canon_runs (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE canon_run_issues (id INTEGER PRIMARY KEY, run_id INTEGER, cv_issue_id TEXT, scanned_book_id TEXT, series_name TEXT, issue_number TEXT, volume_year INTEGER);
    INSERT INTO users VALUES ('u1', 'reader', 'user'), ('a1', 'boss', 'admin');
    INSERT INTO scanned_series VALUES ('ss9', 'Absolute Flash', 2025, NULL);
    INSERT INTO events VALUES ('ev1', 'Knightfall');
    INSERT INTO event_issues VALUES (31, 'ev1', '4100', NULL, 'Batman', '497', 1993);
    INSERT INTO canon_runs VALUES (5, 'Moore Swamp Thing');
    INSERT INTO canon_run_issues VALUES (77, 5, NULL, NULL, 'Saga of the Swamp Thing', '21', 1982);
  `);
  const routes = {};
  const app = { get: (p, ...h) => { routes['GET ' + p] = h.at(-1); }, post: (p, ...h) => { routes['POST ' + p] = h.at(-1); } };
  const logger = { info() {}, warn() {} };
  const rowFor = async (src, owner, issue) => {
    if (src === 'event') return db.prepare('SELECT * FROM event_issues WHERE id = ? AND event_id = ?').get(Number(issue), owner) || null;
    if (src === 'run') return db.prepare('SELECT * FROM canon_run_issues WHERE id = ? AND run_id = ?').get(Number(issue), Number(owner)) || null;
    if (src === 'series') return issue === '1100' ? { id: '1100', cv_issue_id: '1100', scanned_series_id: owner, series_name: 'Absolute Flash', issue_number: '7', volume_year: 2025 } : null;
    return null;
  };
  const planFor = async () => ({ state: 'fill', scanned_id: 'ss9', cv_issue_id: '1100' });
  const dr = createDownloadRequests({ app, db, requireAuth: null, requireAdmin: null, rowFor, planFor,
    getSetting: k => (k === 'download_manager_admin_only' ? String(adminOnly) : null), logger, IN: { normIssueNumber: s => String(s) } });
  const pr = createProblemReports({ app, db, requireAuth: null, requireAdmin: null, logger });
  const call = async (key, req) => {
    let out, code = 200;
    await routes[key]({ params: {}, query: {}, ...req }, { json: d => { out = d; }, status: c => { code = c; return { json: d => { out = d; } }; } });
    return { code, out };
  };
  return { db, dr, pr, call };
}
const user = { sub: 'u1', role: 'user' }, admin = { sub: 'a1', role: 'admin' };
const P = (src, owner, issue) => ({ params: { src, owner, issue } });

test('events, runs and series pages use the same request service as lists', async () => {
  const { db, call } = harness();
  const info = (await call('GET /api/requests/:src/:owner/issues/:issue/acquire', { ...P('event', 'ev1', '31'), user })).out;
  assert.deepEqual([info.mode, info.request, info.plan], ['request', null, null]);
  const a = (await call('POST /api/requests/:src/:owner/issues/:issue/request', { ...P('event', 'ev1', '31'), user })).out;
  const b = (await call('POST /api/requests/:src/:owner/issues/:issue/request', { ...P('event', 'ev1', '31'), user })).out;
  assert.equal(a.id, b.id);
  await call('POST /api/requests/:src/:owner/issues/:issue/request', { ...P('run', '5', '77'), user });
  await call('POST /api/requests/:src/:owner/issues/:issue/request', { ...P('series', 'ss9', '1100'), user });
  assert.deepEqual((await call('GET /api/requests/:src/:owner/mine', { params: { src: 'event', owner: 'ev1' }, user })).out, { 31: 'open' });
  assert.deepEqual((await call('GET /api/requests/:src/:owner/mine', { params: { src: 'series', owner: 'ss9' }, user })).out, { 1100: 'open' });
  assert.equal((await call('GET /api/requests/:src/:owner/issues/:issue/acquire', { ...P('run', '5', '99'), user })).code, 404);
  const list = (await call('GET /api/download-requests', { user: admin })).out.requests;
  assert.deepEqual(list.map(r => [r.kind, r.from.label, r.from.link]), [
    ['series_issue', 'Absolute Flash (2025)', '/series/ss9'],
    ['run_issue', 'Moore Swamp Thing', '/canon/run/5'],
    ['event_issue', 'Knightfall', '/events/ev1'],
  ]);
  assert.equal(list[0].cv_issue_id, '1100');
  db.exec(`UPDATE event_issues SET scanned_book_id = 'b9' WHERE id = 31`);
  db.exec(`INSERT INTO scanned_books VALUES ('b1', 'ss9', '1100')`);
  const now = (await call('GET /api/download-requests', { user: admin })).out.requests;
  assert.deepEqual(now.map(r => r.owned), [true, false, true]);
  const mine = (await call('GET /api/requests/mine', { user })).out.requests;
  assert.equal(mine.length, 3);
});

test('users who may download get the plan instead of a request', async () => {
  const { call } = harness(false);
  const info = (await call('GET /api/requests/:src/:owner/issues/:issue/acquire', { ...P('series', 'ss9', '1100'), user })).out;
  assert.deepEqual([info.mode, info.plan.state, info.request], ['download', 'fill', null]);
  assert.equal((await call('POST /api/requests/:src/:owner/issues/:issue/request', { ...P('series', 'ss9', '1100'), user })).code, 400);
});

test('series requests need a name, ignore duplicates, and are refused when the user may download', async () => {
  const { call } = harness();
  assert.equal((await call('POST /api/requests/series', { body: { name: '  ' }, user })).code, 400);
  const one = (await call('POST /api/requests/series', { body: { name: 'Saga', year: '2012', publisher: 'Image', note: 'from #1' }, user })).out;
  const two = (await call('POST /api/requests/series', { body: { name: 'saga', year: 2012 }, user })).out;
  assert.equal(one.id, two.id);
  const mine = (await call('GET /api/requests/mine', { user })).out.requests;
  assert.equal(mine.length, 1);
  assert.deepEqual([mine[0].kind, mine[0].series_name, mine[0].volume_year, mine[0].publisher, mine[0].note], ['series', 'Saga', 2012, 'Image', 'from #1']);
  assert.equal((await harness(false).call('POST /api/requests/series', { body: { name: 'Saga' }, user })).code, 400);
});

test('problem reports: kinds checked, "other" needs a note, only app paths kept, admin closes with a reply', async () => {
  const { call } = harness();
  assert.equal((await call('POST /api/reports', { body: { kind: 'nope' }, user })).code, 400);
  assert.equal((await call('POST /api/reports', { body: { kind: 'other' }, user })).code, 400);
  const r = (await call('POST /api/reports', { body: { kind: 'file', target_type: 'book', target_id: 42, target_label: 'Flash #7', note: 'pages 3-4 missing', page_url: 'https://evil.example/x' }, user })).out;
  assert.equal(r.status, 'open');
  assert.equal(r.page_url, null);
  assert.equal(r.target_id, '42');
  await call('POST /api/reports', { body: { kind: 'order', target_type: 'event', target_id: '3', page_url: '/events/3' }, user });
  assert.equal((await call('GET /api/reports/count', { user: admin })).out.open, 2);
  const listed = (await call('GET /api/reports', { user: admin })).out.reports;
  assert.equal(listed[0].page_url, '/events/3');
  assert.equal(listed[1].user, 'reader');
  assert.equal((await call('POST /api/reports/:id', { params: { id: String(r.id) }, body: { status: 'resolved', admin_note: 'Replaced the file' }, user: admin })).out.open, 1);
  const mine = (await call('GET /api/reports/mine', { user })).out.reports.find(x => x.id === r.id);
  assert.deepEqual([mine.status, mine.admin_note], ['resolved', 'Replaced the file']);
});

test('problem reports are limited per user per day', async () => {
  const { call } = harness();
  for (let i = 0; i < 30; i++) assert.equal((await call('POST /api/reports', { body: { kind: 'metadata' }, user })).code, 200);
  assert.equal((await call('POST /api/reports', { body: { kind: 'metadata' }, user })).code, 429);
});
