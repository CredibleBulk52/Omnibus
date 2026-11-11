'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createMetron, metronPrompt, issueKey } = require('./metron');

const item = (order, series, year, number, store, type, cv) => ({ order, issue_type: type, issue: { series: { name: series, year_began: year }, number, store_date: store, cover_date: store, cv_id: cv } });

function fake(routes) {
  const calls = [];
  const axios = { get: async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization, ua: opts.headers['User-Agent'] });
    const r = typeof routes === 'function' ? routes(url, opts) : routes[url];
    return r || { status: 404, data: {} };
  } };
  let t = 0;
  const m = createMetron({ axios, getToken: () => 'tok', db: new Database(':memory:'), sleep: async ms => { t += ms; }, now: () => t });
  return { m, calls };
}

test('requests end in "/" before the query, carry the token and a User-Agent, and follow "next"', async () => {
  const p1 = 'https://metron.cloud/api/reading_list/156/items/';
  const p2 = 'https://metron.cloud/api/reading_list/156/items/?page=2';
  const { m, calls } = fake({
    [p1]: { status: 200, data: { next: p2, results: [item(1, 'DC K.O.', 2025, '1', '2025-10-08', 'Core Issue', 1137136)] } },
    [p2]: { status: 200, data: { next: null, results: [item(2, 'Titans', 2023, '28', '2025-10-15', 'Tie-In', 1138106)] } },
  });
  const list = await m.items(156);
  assert.deepEqual(list.map(x => x.cv_id), [1137136, 1138106]);
  assert.deepEqual(calls.map(c => c.url), [p1, p2]);
  assert.ok(calls.every(c => c.auth === 'Bearer tok' && /^Omnibus\//.test(c.ua)));
  await m.items(156);
  assert.equal(calls.length, 2);   // cached
  await m.search('DC K.O.').catch(() => {});
  assert.equal(calls[2].url, 'https://metron.cloud/api/reading_list/?name=DC+K.O.');
});

test('a refused Bearer token is tried once as "Token"', async () => {
  const { m, calls } = fake((url, opts) => opts.headers.Authorization === 'Token tok' ? { status: 200, data: { count: 1, results: [] } } : { status: 401, data: {} });
  assert.deepEqual(await m.test(), { ok: true, lists: 1 });
  assert.deepEqual(calls.map(c => c.auth), ['Bearer tok', 'Token tok']);
});

test('findEventList: exact name, Metron first, era checked; short form; no near-names', async () => {
  const lists = {
    'secret wars': [{ id: 246, name: 'Marvel Super Heroes Secret Wars', list_type: 'Event', user: { username: 'bpepple' } },
      { id: 266, name: 'Secret Wars', list_type: 'Event', attribution_source: 'LOCG', user: { username: 'Metron' } },
      { id: 244, name: 'Secret Wars II', list_type: 'Event', attribution_source: 'CBRO', user: { username: 'Metron' } }],
    'civil war': [{ id: 176, name: 'Civil War', list_type: 'Event', attribution_source: 'LOCG', user: { username: 'Metron' } },
      { id: 117, name: 'Civil War II', list_type: 'Event', attribution_source: 'LOCG', user: { username: 'Metron' } }],
    'zero hour': [{ id: 16, name: 'Zero Hour', list_type: 'Event', attribution_source: 'LOCG', user: { username: 'Metron' } }],
  };
  const itemsOf = { 266: [item(1, 'Secret Wars', 2015, '1', '2015-05-06', 'Core Issue', 1)], 246: [item(1, 'Marvel Super-Heroes Secret Wars', 1984, '1', null, null, 2)],
    176: [item(1, 'Civil War', 2006, '1', '2006-05-03', 'Core Issue', 3)], 16: [item(1, 'Zero Hour: Crisis in Time', 1994, '4', '1994-08-31', 'Core Issue', 4)] };
  const { m } = fake(url => {
    const u = new URL(url);
    if (u.pathname === '/api/reading_list/') return { status: 200, data: { next: null, results: lists[u.searchParams.get('name').toLowerCase().split(':')[0].trim()] || [] } };
    const id = (u.pathname.match(/reading_list\/(\d+)\/items/) || [])[1];
    return { status: 200, data: { next: null, results: (itemsOf[id] || []).map(x => ({ ...x, issue: { ...x.issue, cover_date: x.issue.cover_date || '1984-05-01' } })) } };
  });
  assert.equal((await m.findEventList('Secret Wars', 2015)).list.id, 266);
  const sw84 = await m.findEventList('Secret Wars', 1984);
  assert.equal(sw84.list.id, 246);                        // Metron's 2015 list rejected by its years; the user list fits
  assert.ok(sw84.tried.some(t => t.id === 266 && /2015/.test(t.why)));
  assert.equal((await m.findEventList('Civil War', 2006)).list.id, 176);
  assert.equal((await m.findEventList('Zero Hour: Crisis in Time', 1994)).list.id, 16);
  assert.equal((await m.findEventList('Absolute Power', 2024)).list, null);
});

test('prompt table and issue keys', () => {
  const found = { list: { id: 39, name: 'The Sinestro Corps War', attribution_source: 'LOCG', owner: 'Metron', url: 'https://metron.cloud/api/reading_list/39/' },
    items: [{ order: 11, series: 'The Blue Beetle', volume_year: 2006, number: '20', store_date: '2007-10-24', cover_date: null, issue_type: 'Tie-In' },
      { order: 12, series: 'Chronos', volume_year: 1998, number: '1000000', store_date: null, cover_date: '1998-11-01', issue_type: 'Tie-In' }] };
  const p = metronPrompt(found);
  assert.match(p, /11 \| The Blue Beetle \(2006\) #20 \| 2007-10-24 \| Tie-In/);
  assert.match(p, /12 \| Chronos \(1998\) #1000000 \| cover 1998-11 \| Tie-In/);
  assert.match(p, /League of Comic Geeks' list/);
  assert.equal(issueKey('The Blue Beetle', '20'), issueKey('Blue Beetle', '#20'));
  assert.equal(issueKey('DC K.O.: Knightfight', '01'), issueKey('DC K.O. Knightfight', '1'));
  assert.equal(metronPrompt({ list: null, items: [] }), '');
});
