'use strict';
// Comic Vine's hour (cvWindow.js), checked against what Comic Vine's usage page showed on 2026-11-24
// with a fresh key (Central time): requests from 3:08, a first /search at 3:22:44, more requests on
// used paths at 3:40 and 4:08, and nothing counted at 4:25.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createCvWindows } = require('./cvWindow');

const T = (h, m, s = 0) => Date.UTC(2026, 10, 24, h + 6, m, s);   // Central → UTC
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE cv_api_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, resource TEXT NOT NULL, lane TEXT NOT NULL DEFAULT 'background', caller TEXT, status TEXT, ms INTEGER);
    CREATE TABLE cv_windows (resource TEXT PRIMARY KEY, start INTEGER NOT NULL)`);
  const w = createCvWindows(db);
  // What cvApiGet does for each request: open the hour, then log the request.
  const send = (resource, ts) => { w.window(resource, ts, { open: true }); db.prepare('INSERT INTO cv_api_log (ts, resource) VALUES (?, ?)').run(ts, resource); };
  return { db, w, send };
}
// The afternoon's requests in time order; check(time) runs the checks due by then.
function newKeyAfternoon(send, check = () => {}) {
  const ev = [['types', T(15, 4, 42)], ['volume', T(15, 8, 14)]];   // types: the Settings key check, not counted
  for (let i = 0; i < 100; i++) ev.push(['issues', T(15, 8, 16) + i * 8000], ['issue', T(15, 8, 18) + i * 8000]);
  ev.push(['search', T(15, 22, 44)], ['search', T(15, 22, 59)], ['issues', T(15, 40, 56)], ['issue', T(16, 8, 10)], ['volume', T(16, 8, 11)]);
  ev.sort((a, b) => a[1] - b[1]);
  for (const [r, t] of ev) { check(t); send(r, t); }
  check(Infinity);
}
function checks(list) {   // [[time, fn], …] run once each, in order, before the first request after `time`
  const todo = [...list];
  return t => { while (todo.length && todo[0][0] <= t) todo.shift()[1](); };
}

test('one shared hour: started by the first request, restarted by a path new to it, reset to 0 at its end', () => {
  const { w, send } = setup();
  const at = (r, t) => w.window(r, t);
  let seen = 0;
  newKeyAfternoon(send, checks([
    // 3:08:30 — Comic Vine: "reset in 60 minutes" on every path.
    [T(15, 8, 30), () => { seen++; assert.equal(at('issue', T(15, 8, 30)).resetAt, T(16, 8, 18)); assert.equal(at('volume', T(15, 8, 30)).resetAt, T(16, 8, 18)); }],
    // 3:23:30 — after the first /search every path resets at 4:22:44 ("reset in 59 minutes").
    [T(15, 23, 30), () => { seen++; for (const r of ['issue', 'issues', 'volume', 'search']) assert.equal(at(r, T(15, 23, 30)).resetAt, T(16, 22, 44), r); }],
    // 4:20 — the 3:40 and 4:08 requests on used paths did not move it; counts carried on past 60 minutes.
    [T(16, 20), () => { seen++; assert.equal(at('issue', T(16, 20)).resetAt, T(16, 22, 44)); assert.equal(at('issue', T(16, 20)).used, 101); assert.equal(at('issues', T(16, 20)).used, 101); }],
    // 4:25 — Comic Vine: "no current rate limits".
    [T(16, 25), () => { seen++; assert.deepEqual(at('issue', T(16, 25)), { start: null, resetAt: null, used: 0 }); }],
  ]));
  assert.equal(seen, 4);
});

test('/types neither starts nor restarts the hour', () => {
  const { w, send } = setup();
  send('types', T(10, 0));
  assert.equal(w.current(T(10, 1)), null);
  send('volume', T(10, 5)); send('types', T(10, 30));
  assert.equal(w.window('volume', T(10, 31)).resetAt, T(11, 5));
});

test('without a saved hour (first run after the change) the hour is rebuilt from the log the same way', () => {
  const a = setup();
  const times = [T(15, 30), T(16, 10), T(16, 22)], live = {};
  newKeyAfternoon(a.send, checks(times.map(t => [t, () => { live[t] = a.w.current(t); }])));
  // A database with the same log up to each time and no saved hour: the rebuilt hour matches the live one.
  for (const t of times) {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE cv_api_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, resource TEXT NOT NULL, lane TEXT, caller TEXT, status TEXT, ms INTEGER);
      CREATE TABLE cv_windows (resource TEXT PRIMARY KEY, start INTEGER NOT NULL)`);
    for (const r of a.db.prepare('SELECT ts, resource FROM cv_api_log WHERE ts <= ? ORDER BY id').all(t)) db.prepare('INSERT INTO cv_api_log (ts, resource) VALUES (?, ?)').run(r.ts, r.resource);
    assert.deepEqual(createCvWindows(db).fromLog(t), live[t] ? { start: live[t].start, ends: live[t].ends } : null, new Date(t).toISOString());
  }
});

test('the log is kept back to the start of a long hour', () => {
  const { w, send } = setup();
  send('issue', T(10, 0)); send('volume', T(10, 50)); send('search', T(11, 40)); send('issues', T(12, 30));
  assert.equal(w.window('issue', T(13, 0)).resetAt, T(13, 30));
  assert.equal(w.keepFrom(T(13, 0)), T(10, 0));   // older than the server's usual 2 hours
});
