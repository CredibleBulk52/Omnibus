'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { decideSeriesStatus: d, metronStatusOf } = require('./seriesStatus');
const now = Date.parse('2026-10-28T00:00:00Z');
const daysAgo = n => new Date(now - n * 86400000).toISOString().slice(0, 10);

test('Comic Vine alone: recent issue ongoing, quiet series ended, no dates unknown', () => {
  assert.equal(d({ newCount: 2, latestDate: daysAgo(400), now }).status, 'ongoing');
  assert.equal(d({ latestDate: daysAgo(30), now }).status, 'ongoing');
  assert.equal(d({ latestDate: daysAgo(200), now }).status, 'ended');
  assert.equal(d({ now }).status, 'unknown');
});

test('Metron Completed ends a finished mini at once, but not while issues are still missing', () => {
  const m = { status: 'ended', raw: 'Completed', issueCount: 6 };
  const r = d({ newCount: 1, latestDate: daysAgo(3), issueCount: 6, metron: m, now });
  assert.deepEqual([r.status, r.source], ['ended', 'metron']);
  assert.equal(d({ latestDate: daysAgo(3), issueCount: 5, metron: m, now }).status, 'ongoing');
  assert.equal(d({ latestDate: daysAgo(300), issueCount: 2, metron: m, now }).status, 'ended');
});

test('Metron Ongoing keeps a quiet series open for up to a year', () => {
  const m = { status: 'ongoing', raw: 'Ongoing', issueCount: 40 };
  assert.deepEqual([d({ latestDate: daysAgo(200), metron: m, now }).status, d({ latestDate: daysAgo(200), metron: m, now }).source], ['ongoing', 'metron']);
  assert.equal(d({ latestDate: daysAgo(500), metron: m, now }).status, 'ended');
});

test('Metron status words', () => {
  assert.equal(metronStatusOf('Ongoing'), 'ongoing');
  assert.equal(metronStatusOf('Hiatus'), 'ongoing');
  assert.equal(metronStatusOf('Completed'), 'ended');
  assert.equal(metronStatusOf({ id: 2, name: 'Cancelled' }), 'ended');
  assert.equal(metronStatusOf('Limited Series'), null);
  assert.equal(metronStatusOf(null), null);
});

test('Metron lookup confirms the Comic Vine ID on the series record and falls back to a name search', async () => {
  const { createMetron } = require('./metron');
  const calls = [];
  const series = { 11: { id: 11, cv_id: 999, status: 'Ongoing', issue_count: 50 }, 22: { id: 22, cv_id: 155555, status: 'Completed', issue_count: 6 } };
  const axios = { get: async url => {
    const u = new URL(url); calls.push(u.pathname + u.search);
    const m = u.pathname.match(/\/series\/(\d+)\/$/);
    if (m) return { status: 200, data: series[m[1]] };
    if (u.searchParams.get('cv_id')) return { status: 200, data: { results: [{ id: 11 }] } };   // filter ignored: wrong series first
    if (u.searchParams.get('name')) return { status: 200, data: { results: [{ id: 22 }] } };
    return { status: 404, data: {} };
  } };
  const m = createMetron({ axios, getToken: () => 't', db: null, sleep: async () => {} });
  const r = await m.seriesStatus(155555, { name: 'Absolute Flash', year: 2025 });
  assert.deepEqual(r, { id: 22, status: 'ended', raw: 'Completed', issueCount: 6, yearEnd: null, seriesType: null });
  assert.ok(calls.every(c => /\/api\/series\/(\d+\/)?(\?|$)/.test(c)), calls.join(' '));
  assert.equal(await m.seriesStatus(424242, {}), null);
});

test('a cached answer from before series types were kept is asked again', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { createMetron } = require('./metron');
  const db = new DatabaseSync(':memory:');
  let gets = 0;
  const axios = { get: async url => { gets++; const u = new URL(url);
    if (/\/series\/22\/$/.test(u.pathname)) return { status: 200, data: { id: 22, cv_id: 777, status: 'Cancelled', issue_count: 6, series_type: { name: 'Cancelled Series' } } };
    return { status: 200, data: { results: [{ id: 22 }] } }; } };
  const m = createMetron({ axios, getToken: () => 't', db, sleep: async () => {} });
  db.prepare('INSERT INTO metron_cache (key, value, at) VALUES (?, ?, ?)').run('series-status:777', JSON.stringify({ found: { id: 22, status: 'ended', raw: 'Cancelled', issueCount: 6, yearEnd: null } }), Date.now());
  const r = await m.seriesStatus(777, {});
  assert.ok(gets > 0);
  assert.equal(r.seriesType, 'Cancelled Series');
  const before = gets;
  await m.seriesStatus(777, {});
  assert.equal(gets, before);   // the new answer is cached
});
