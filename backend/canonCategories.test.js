'use strict';
// Check categories (canonCategories.js): proposals from web-checked verdicts, review, remembering checked runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

function setup(reply, complete, hintsFor) {
  const db = new DatabaseSync(':memory:');
  db.transaction = fn => (...a) => { db.exec('BEGIN'); try { const r = fn(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  db.exec(`CREATE TABLE canon_runs (id INTEGER PRIMARY KEY, title TEXT, parent_series TEXT, issue_range_hint TEXT, status TEXT);
    CREATE TABLE canon_run_categories (id INTEGER PRIMARY KEY, run_id INTEGER, category TEXT, adaptation_notes TEXT, UNIQUE(run_id, category));
    CREATE TABLE canon_run_creators (id INTEGER PRIMARY KEY, run_id INTEGER, person_name TEXT, role TEXT);
    INSERT INTO canon_runs VALUES (1,'Watchmen',NULL,'#1-12 (1986 vol)','approved'), (2,'V for Vendetta',NULL,'#1-10 (1988 vol)','pending'), (3,'Old',NULL,NULL,'rejected');
    INSERT INTO canon_run_categories (run_id, category, adaptation_notes) VALUES (1,'adapted_to_screen','Film 2009 (direct)'), (1,'award_winning','Some award (1999)'), (2,'adapted_to_screen','Film 2005 (direct)');
    INSERT INTO canon_run_creators (run_id, person_name, role) VALUES (1,'Alan Moore','writer');`);
  const routes = {}, prompts = [];
  const reg = m => (p, ...h) => { routes[m + ' ' + p] = h.at(-1); };
  const ai = { newJobId: () => 'j', complete: complete || (async o => { prompts.push(o.prompt); return { data: { stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 50 }, content: [{ type: 'text', text: JSON.stringify(reply) }] } }; }) };
  const mod = require('./canonCategories')({ app: { get: reg('GET'), post: reg('POST') }, db, requireAdmin: () => {}, logger: { info() {}, warn() {}, error() {} }, ai, ...(hintsFor ? { hintsFor } : {}) });
  const call = async (k, body, query = {}) => { const out = {}; const res = { status(c) { out.code = c; return res; }, json(v) { out.body = v; } }; await routes[k]({ body, query }, res); return out; };
  return { db, call, prompts, mod };
}
const wait = () => new Promise(r => setTimeout(r, 20));

test('verdicts become proposals; checked runs are remembered; applying changes the tags', async () => {
  const reply = { runs: [
    { id: 1, adapted_to_screen: { verdict: 'yes', notes: 'Film 2009 (direct)' }, award_winning: { verdict: 'yes', notes: 'Hugo Award — Best Other Form (1988)' }, critically_acclaimed: { verdict: 'yes', notes: 'Landmark' }, sources: ['https://a'] },
    { id: 2, adapted_to_screen: { verdict: 'yes', notes: 'Film 2005 (direct)' }, award_winning: { verdict: 'unsure', notes: null }, critically_acclaimed: { verdict: 'yes', notes: 'Classic.' }, sources: ['https://b'] }] };
  const { db, call, prompts, mod } = setup(reply);
  let g = await call('GET /api/editor/runs/categories');
  assert.deepEqual(g.body.counts, { unchecked: 2, pending: 1, all: 2 });   // awards counted only when asked
  assert.equal((await call('POST /api/editor/runs/categories/check', { scope: 'unchecked' })).body.count, 2);
  await wait();
  assert.equal(prompts.length, 1);                                  // both runs in one request
  assert.match(prompts[0], /id 1: "Watchmen".*by Alan Moore/);
  g = await call('GET /api/editor/runs/categories');
  assert.equal(g.body.counts.unchecked, 0);                         // remembered
  assert.equal(mod.status().tokens, 1050);                          // tokens counted for the progress line
  assert.equal(mod.status().batches, 1);
  const items = g.body.proposals.flatMap(p => p.items.map(i => [p.run_id, i.category, i.action]));
  assert.deepEqual(items.sort(), [[1, 'award_winning', 'update'], [1, 'critically_acclaimed', 'add'], [2, 'critically_acclaimed', 'add']].sort());
  const ids = g.body.proposals.flatMap(p => p.items);
  await call('POST /api/editor/runs/categories/apply', { apply: ids.filter(i => i.action !== 'update').map(i => i.id), dismiss: ids.filter(i => i.action === 'update').map(i => i.id) });
  assert.deepEqual(db.prepare('SELECT run_id, category, adaptation_notes n FROM canon_run_categories ORDER BY run_id, category').all().map(r => ({ ...r })), [
    { run_id: 1, category: 'adapted_to_screen', n: 'Film 2009 (direct)' }, { run_id: 1, category: 'award_winning', n: 'Some award (1999)' }, { run_id: 1, category: 'critically_acclaimed', n: 'Landmark' },
    { run_id: 2, category: 'adapted_to_screen', n: 'Film 2005 (direct)' }, { run_id: 2, category: 'critically_acclaimed', n: 'Classic' }]);
  assert.equal((await call('GET /api/editor/runs/categories')).body.proposals.length, 0);
  assert.equal((await call('POST /api/editor/runs/categories/check', { scope: 'unchecked' })).code, 400);   // nothing left unchecked
});

test('a tag found to be wrong is proposed for removal; "unsure" proposes nothing', async () => {
  const { call } = setup({ runs: [{ id: 1, adapted_to_screen: { verdict: 'unsure', notes: null }, award_winning: { verdict: 'no', notes: null }, critically_acclaimed: { verdict: 'unsure', notes: null }, sources: ['https://c'] }] });
  await call('POST /api/editor/runs/categories/check', { scope: 'ids', ids: [1] }); await wait();
  const g = await call('GET /api/editor/runs/categories');
  assert.deepEqual(g.body.proposals[0].items.map(i => [i.category, i.action, i.current_notes]), [['award_winning', 'remove', 'Some award (1999)']]);
});

test('a verdict with no web source proposes nothing', async () => {
  const { call } = setup({ runs: [{ id: 1, adapted_to_screen: { verdict: 'no', notes: null }, award_winning: { verdict: 'no', notes: null }, critically_acclaimed: { verdict: 'yes', notes: 'Landmark' }, sources: ['from memory'] }] });
  await call('POST /api/editor/runs/categories/check', { scope: 'ids', ids: [1] }); await wait();
  assert.equal((await call('GET /api/editor/runs/categories')).body.proposals.length, 0);
});

test('notes are tidied to badge length', () => {
  const { tidyNotes } = setup({ runs: [] }).mod;
  assert.equal(tidyNotes('  Son of Batman (animated film, 2014).  '), 'Son of Batman (animated film, 2014)');
  const dkr = 'Inspired The Dark Knight Rises (film, 2012) · Inspired Batman v Superman (film, 2016) · The Dark Knight Returns, Parts 1–2 (animated films, 2012–13)';
  assert.equal(tidyNotes(dkr), dkr);                                   // four productions' worth fits
  const long = [dkr, 'Extra One (film, 2020)', 'Extra Two (film, 2021)', 'Extra Three (film, 2022)'].join(' · ');
  assert.equal(tidyNotes(long), dkr + ' · Extra One (film, 2020) · Extra Two (film, 2021)');   // cut at a ' · ' within 200
  assert.equal(tidyNotes(null), null);
});

test('Stop abandons the batch in progress; its runs stay unchecked', async () => {
  const complete = o => new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(new Error('canceled'))));
  const { call, mod } = setup(null, complete);
  await call('POST /api/editor/runs/categories/check', { scope: 'unchecked' }); await wait();
  assert.equal(mod.status().running, true);
  await call('POST /api/editor/runs/categories/stop'); await wait();
  const j = mod.status();
  assert.equal(j.running, false); assert.equal(j.stopped, true); assert.equal(j.errors.length, 0);
  assert.equal((await call('GET /api/editor/runs/categories')).body.counts.unchecked, 2);
});

test('Generate filter: "all" needs every category; an excluded tag drops the run', () => {
  const { filterRunsByCategory: f } = require('./canonCategories');
  const runs = [{ title: 'A', categories: ['critically_acclaimed'] }, { title: 'B', categories: ['critically_acclaimed', 'award_winning'] }, { title: 'C', categories: ['adapted_to_screen', 'critically_acclaimed'] }];
  let r = f(runs, { categories: ['critically_acclaimed'], match: 'any', exclude: ['award_winning', 'adapted_to_screen'] });
  assert.deepEqual(r.kept.map(x => x.title), ['A']);
  assert.deepEqual(r.dropped, [{ title: 'B', reason: 'award winning (excluded)' }, { title: 'C', reason: 'adapted to screen (excluded)' }]);
  r = f(runs, { categories: ['critically_acclaimed', 'award_winning'], match: 'all' });
  assert.deepEqual(r.kept.map(x => x.title), ['B']);
  assert.equal(r.dropped[0].reason, 'not award winning');
  assert.equal(f(runs, { categories: ['critically_acclaimed'] }).kept.length, 3);   // default: no filtering
});

test('review: shorter updates are flagged, reasons kept, and a run never loses its last tag', async () => {
  const { db, call } = setup({ runs: [
    { id: 1, adapted_to_screen: { verdict: 'yes', notes: 'Watchmen (film, 2009)', why: null }, award_winning: { verdict: 'yes', notes: 'Hugo, Best Other Form (1988)', why: null }, critically_acclaimed: { verdict: 'unsure', notes: null, why: null }, sources: ['https://a'] },
    { id: 2, adapted_to_screen: { verdict: 'no', notes: null, why: 'Film was based on an earlier script' }, award_winning: { verdict: 'unsure', notes: null, why: null }, critically_acclaimed: { verdict: 'unsure', notes: null, why: null }, sources: ['https://b'] }] });
  db.exec("UPDATE canon_run_categories SET adaptation_notes = 'Film 2009 (direct); Tales of the Black Freighter 2009 (direct)' WHERE run_id = 1 AND category = 'adapted_to_screen'");
  await call('POST /api/editor/runs/categories/check', { scope: 'unchecked' }); await wait();
  const g = (await call('GET /api/editor/runs/categories')).body;
  const items = Object.fromEntries(g.proposals.flatMap(p => p.items.map(i => [`${p.run_id}:${i.category}`, i])));
  assert.equal(items['1:adapted_to_screen'].drops, true);                      // 2 items → 1
  assert.equal(items['1:award_winning'].drops, false);
  assert.equal(items['2:adapted_to_screen'].why, 'Film was based on an earlier script');
  assert.equal(items['2:adapted_to_screen'].lastTag, true);                   // V for Vendetta's only tag
  const r = (await call('POST /api/editor/runs/categories/apply', { apply: [items['2:adapted_to_screen'].id], dismiss: [] })).body;
  assert.deepEqual(r.kept, [{ title: 'V for Vendetta', category: 'Adapted to screen' }]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM canon_run_categories WHERE run_id = 2').get().n, 1);   // still tagged
  assert.equal((await call('GET /api/editor/runs/categories')).body.proposals.filter(p => p.run_id === 2).length, 1);   // proposal kept for another look
});

test('budget: settled tags are not re-decided, fully settled runs are skipped, app records count as a source', async () => {
  const { isBadge } = require('./canonCategories');
  assert.equal(isBadge('Inspired The Dark Knight Rises (film, 2012) · The Dark Knight Returns, Parts 1–2 (animated films, 2012–13)'), true);
  assert.equal(isBadge('Animated film 2011 (direct); Batman Begins 2005 (inspired)'), false);
  assert.equal(isBadge('Some award (1999)', 'award_winning'), false);
  assert.equal(isBadge('Eisner Award — Best Limited Series (1987)', 'award_winning'), false);
  assert.equal(isBadge('Eisner, Best Limited Series (1987) · Hugo, Best Other Form (1988)', 'award_winning'), true);
  assert.equal(isBadge('Watchmen (film, 2009)', 'adapted_to_screen'), true);
  assert.equal(isBadge(''), false);
  const prompts = [];
  const reply = { runs: [{ id: 2, adapted_to_screen: { verdict: 'no', notes: null, why: 'x' }, award_winning: { verdict: 'yes', notes: 'Eisner, Best Limited Series (1989)', why: null }, critically_acclaimed: { verdict: 'yes', notes: 'Classic', why: null }, sources: ['app records'] }] };
  const complete = async o => { prompts.push(o); return { data: { stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify(reply) }] } }; };
  const { db, call, mod } = setup(null, complete);
  db.exec("UPDATE canon_run_categories SET adaptation_notes = 'Hugo, Best Other Form (1988)' WHERE run_id = 1 AND category = 'award_winning'");
  // Watchmen (run 1): all three settled → skipped; V for Vendetta (run 2): adapted settled, others open.
  db.exec("UPDATE canon_run_categories SET adaptation_notes = 'Watchmen (film, 2009)' WHERE run_id = 1 AND category = 'adapted_to_screen'");
  db.exec("INSERT INTO canon_run_categories (run_id, category, adaptation_notes) VALUES (1, 'critically_acclaimed', NULL)");
  db.exec("UPDATE canon_run_categories SET adaptation_notes = 'V for Vendetta (film, 2005)' WHERE run_id = 2");
  await call('POST /api/editor/runs/categories/check', { scope: 'unchecked' }); await wait();
  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0].prompt, /Watchmen/);                          // skipped, no request
  assert.match(prompts[0].prompt, /already confirmed, do not research: adapted_to_screen/);
  assert.equal(prompts[0].webSearch, 4); assert.equal(prompts[0].webFetch, undefined);   // search results only
  const j = mod.status(); assert.equal(j.skipped, 1); assert.equal(j.done, 2);
  assert.equal((await call('GET /api/editor/runs/categories')).body.counts.unchecked, 0);
  // app records alone are not a source here (this run had no hints), so nothing is proposed — and the
  // settled adapted tag is never proposed for removal.
  assert.equal((await call('GET /api/editor/runs/categories')).body.proposals.length, 0);
});

test('awards pass: runs whose award notes miss a recorded award are re-checked for that tag only', async () => {
  const prompts = [];
  const reply = { runs: [{ id: 1, adapted_to_screen: { verdict: 'yes', notes: 'X (film, 2001)', why: null }, award_winning: { verdict: 'yes', notes: 'Hugo, Best Other Form (1988) · Eisner, Best Writer — Alan Moore (1988)', why: null }, critically_acclaimed: { verdict: 'yes', notes: 'x', why: null }, sources: ['app records'] }] };
  const complete = async o => { prompts.push(o.prompt); return { data: { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: JSON.stringify(reply) }] } }; };
  const hintsFor = r => (r.id === 1 ? ['award wins: Hugo, Best Other Form (1988)', 'creator awards citing this run: Eisner, Best Writer — Alan Moore (1988)'] : []);
  const { db, call } = setup(null, complete, hintsFor);
  db.exec("UPDATE canon_run_categories SET adaptation_notes = 'Hugo, Best Other Form (1988)' WHERE run_id = 1 AND category = 'award_winning'");   // badge, but misses Moore
  let g = (await call('GET /api/editor/runs/categories', undefined, { awards: '1' })).body;
  assert.equal(g.counts.awards, 1);
  await call('POST /api/editor/runs/categories/check', { scope: 'awards' }); await wait();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /already confirmed, do not research: .*adapted_to_screen/);   // other tags not researched
  g = (await call('GET /api/editor/runs/categories')).body;
  const items = g.proposals.flatMap(p => p.items);
  assert.deepEqual(items.map(i => [i.category, i.action]), [['award_winning', 'update']]);   // no adapted/acclaimed changes
  assert.equal(items[0].notes, 'Hugo, Best Other Form (1988) · Eisner, Best Writer — Alan Moore (1988)');
  await call('POST /api/editor/runs/categories/apply', { apply: [items[0].id], dismiss: [] });
  assert.equal((await call('GET /api/editor/runs/categories', undefined, { awards: '1' })).body.counts.awards, 0);   // notes now mention both
});
