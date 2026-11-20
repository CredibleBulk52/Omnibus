'use strict';
// Metron's rate limits (2026-11-20): Retry-After and X-RateLimit-{Burst,Sustained}-* are obeyed, and a
// refusal on the daily limit stops every Metron caller (shared metron_limits) with no retry.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createMetron, parseLimitHeaders } = require('./metron');

function setup(respond, db = new Database(':memory:')) {
  const sent = [];
  let t = 1_700_000_000_000;
  const slept = [];
  const axios = { get: async url => { sent.push(url); return respond(sent.length, t); } };
  const m = createMetron({ axios, getToken: () => 'tok', db, sleep: async ms => { slept.push(ms); t += ms; }, now: () => t });
  return { m, sent, slept, db, clock: () => t, advance: ms => { t += ms; } };
}
const ok = (extra = {}) => ({ status: 200, headers: extra, data: { count: 0, results: [] } });
const limits = (burstRem, sustRem, t, burstIn = 60, sustIn = 3600) => ({
  'x-ratelimit-burst-limit': '20', 'x-ratelimit-burst-remaining': String(burstRem), 'x-ratelimit-burst-reset': String(Math.floor(t / 1000) + burstIn),
  'x-ratelimit-sustained-limit': '5000', 'x-ratelimit-sustained-remaining': String(sustRem), 'x-ratelimit-sustained-reset': String(Math.floor(t / 1000) + sustIn) });

test('headers are read for both counters', () => {
  assert.deepEqual(parseLimitHeaders({ 'X-RateLimit-Burst-Remaining': '17', 'X-RateLimit-Burst-Reset': '1700000060',
    'X-RateLimit-Sustained-Remaining': '4982', 'X-RateLimit-Sustained-Reset': '1700003600' }),
  { burst_remaining: 17, burst_reset: 1700000060000, sustained_remaining: 4982, sustained_reset: 1700003600000 });
  assert.deepEqual(parseLimitHeaders({}), {});
});

test('a refusal on the daily limit is not retried and stops later requests until the reset', async () => {
  const { m, sent } = setup((n, t) => ({ status: 429, headers: { 'retry-after': '30000', ...limits(19, 0, t, 60, 30000) }, data: {} }));
  await assert.rejects(m.get('issue/', { cv_id: 1 }), e => e.code === 'METRON_LIMITED');
  assert.equal(sent.length, 1);
  await assert.rejects(m.get('issue/', { cv_id: 2 }), e => e.code === 'METRON_LIMITED');
  assert.equal(sent.length, 1);                        // nothing sent while blocked
  assert.equal(m.limits().reason, 'Metron daily limit');
});

test('a short refusal (per-minute limit) is waited out exactly and tried once more', async () => {
  const { m, sent, slept } = setup((n, t) => n === 1 ? { status: 429, headers: { 'retry-after': '42', ...limits(0, 4000, t, 42) }, data: {} } : ok(limits(19, 3999, t)));
  await m.get('issue/', { cv_id: 1 });
  assert.equal(sent.length, 2);
  assert.ok(slept.includes(42000));
});

test('a second short refusal gives up instead of retrying again', async () => {
  const { m, sent } = setup(() => ({ status: 429, headers: { 'retry-after': '10' }, data: {} }));
  await assert.rejects(m.get('issue/'), e => e.code === 'METRON_LIMITED');
  assert.equal(sent.length, 2);
});

test('a used-up daily count stops requests before Metron has to refuse; a used-up minute is waited out', async () => {
  const daily = setup((n, t) => ok(limits(10, 0, t)));
  await daily.m.get('issue/');
  await assert.rejects(daily.m.get('issue/'), e => e.code === 'METRON_LIMITED');
  assert.equal(daily.sent.length, 1);
  const burst = setup((n, t) => ok(n === 1 ? limits(0, 4000, t, 30) : limits(19, 3999, t)));
  await burst.m.get('issue/');
  const before = burst.clock();
  await burst.m.get('issue/');
  assert.equal(burst.sent.length, 2);
  assert.ok(burst.clock() - before >= 30000);
});

test('the block is shared through the database with every other Metron caller', async () => {
  const db = new Database(':memory:');
  const first = setup((n, t) => ({ status: 429, headers: { 'retry-after': '7200' }, data: {} }), db);
  await assert.rejects(first.m.get('issue/'), e => e.code === 'METRON_LIMITED');
  const second = setup(() => ok(), db);
  await assert.rejects(second.m.get('issue/'), e => e.code === 'METRON_LIMITED');
  assert.equal(second.sent.length, 0);
});

test('without Retry-After or headers a refusal blocks for an hour', async () => {
  const { m, clock } = setup(() => ({ status: 429, headers: {}, data: {} }));
  await assert.rejects(m.get('issue/'), e => e.code === 'METRON_LIMITED' && e.until - clock() >= 3599000);
});
