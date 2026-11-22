'use strict';
// Series view: Issues only (default) or Reading order (seriesView.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createSeriesView, sequenceFor } = require('./seriesView');

const order = [{ id: 'a0', placed: { label: 'Prelude' } }, { id: 'i1', placed: null }, { id: 'an1', placed: { label: 'Annual #1' } }, { id: 'i2', placed: null }];

test('Issues only keeps the regular issues; an extra opened on its own still reads in the full order', () => {
  assert.deepEqual(sequenceFor(order, 'reading', 'i1'), ['a0', 'i1', 'an1', 'i2']);
  assert.deepEqual(sequenceFor(order, 'issues', 'i1'), ['i1', 'i2']);
  assert.deepEqual(sequenceFor(order, 'issues', 'an1'), ['a0', 'i1', 'an1', 'i2']);
  assert.equal(sequenceFor(null, 'issues', 'i1'), null);
});

test('each reader\'s view: Issues only until they choose; only the two views are accepted', () => {
  const db = new Database(':memory:');
  const routes = {};
  const app = { get: (p, ...f) => { routes[`GET ${p}`] = f.at(-1); }, put: (p, ...f) => { routes[`PUT ${p}`] = f.at(-1); } };
  const sv = createSeriesView({ app, db, requireAuth: () => {} });
  assert.equal(sv.viewOf('u1'), 'issues');
  assert.equal(sv.viewOf(null), 'issues');
  let out, code;
  const res = { json(d) { out = d; }, status(c) { code = c; return this; } };
  routes['PUT /api/users/me/series-view']({ user: { sub: 'u1' }, body: { view: 'reading' } }, res);
  assert.equal(sv.viewOf('u1'), 'reading');
  assert.equal(sv.viewOf('u2'), 'issues');
  routes['PUT /api/users/me/series-view']({ user: { sub: 'u1' }, body: { view: 'everything' } }, res);
  assert.equal(code, 400);
  routes['GET /api/users/me/series-view']({ user: { sub: 'u1' } }, res);
  assert.deepEqual(out, { view: 'reading', views: ['issues', 'reading'] });
  assert.throws(() => createSeriesView({}), /createSeriesView: missing /);
});
