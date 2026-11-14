'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createSeriesGrouping } = require('./seriesGrouping');
const { createShelfSorter } = require('./shelfSorter');
const B = require('./shelfSorterSeries');

function fixture(reply) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER, series_json TEXT, book_count INTEGER, path TEXT);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, is_special INTEGER DEFAULT 0, comicinfo TEXT);`);
  const series = (id, name, year, issues, { publisher = 'Marvel', chars = '', run = '', status = 'Ended', folder = 'Marvel Comics/2. Modern Age' } = {}) => {
    db.prepare('INSERT INTO scanned_series VALUES (?, ?, ?, ?, ?, ?)').run(id, name, year,
      JSON.stringify({ metadata: { name, year, total_issues: issues, publisher, publication_run: run, status, description_text: `${name} story` } }), issues, `/comics/${folder}/${name} (${year})`);
    for (let i = 0; i < Math.min(issues, 3); i++) db.prepare('INSERT INTO scanned_books (id, series_id, comicinfo) VALUES (?, ?, ?)')
      .run(`${id}-${i}`, id, `<ComicInfo><Series>${name}</Series><Characters>${chars}</Characters></ComicInfo>`);
  };
  series('bp16', 'Black Panther', 2016, 25, { run: 'June 2016 - June 2018' });
  series('bp98', 'Black Panther', 1998, 62, { run: 'November 1998 - September 2003' });
  series('wow', 'Black Panther: World of Wakanda', 2016, 6, { chars: 'Ayo, Aneka, Shuri' });
  series('bat', 'Batman', 1986, 744, { publisher: 'DC Comics', run: 'November 1986 - October 2011' });
  series('kj', 'Batman: The Killing Joke', 1988, 1, { publisher: 'DC Comics', chars: 'Batman, Joker' });
  series('hawk', 'Hawkeye', 2012, 22);
  series('uhawk', 'Ultimate Comics Hawkeye', 2011, 4, { chars: 'Hawkeye', folder: 'Marvel Comics/Ultimate Comics' });
  series('am', 'America', 2017, 12, { chars: 'America Chavez' });
  series('amc', 'America Chavez', 2021, 30);
  series('dhb', 'Batman', 2010, 30, { publisher: 'Dark Horse' });     // another publisher: never a candidate
  series('aoa', 'Agents of Atlas', 2019, 5, { run: 'October 2019 - February 2020' });
  series('aa', 'Atlantis Attacks', 2020, 5, { chars: 'Agents of Atlas', run: 'March 2020 - November 2020' });
  const g = createSeriesGrouping({ db });
  const calls = [];
  const ai = {
    run: (o, fn) => fn(), choose: () => 'claude-sonnet-5-5',
    complete: async opts => { calls.push(opts); return { text: JSON.stringify(reply(opts)), jobId: `j${calls.length}`, model: 'claude-sonnet-5-5' }; },
  };
  const settings = new Map();
  const s = createShelfSorter({ db, grouping: g, ai, getSetting: k => settings.get(k) || null, setSetting: (k, v) => settings.set(k, v) });
  return { db, g, s, calls, settings };
}

// The fake model reads the T and C ids back out of the prompt.
const idOf = (text, re) => (re.exec(text) || [])[1];
const answer = opts => {
  const t = opts.prompt;
  const T = name => idOf(t, new RegExp(`(T\\d+) ${name}`));
  return { series: [
    { item: T('Black Panther: World of Wakanda'), verdict: 'home', home: idOf(t, /(C\d+) Black Panther \(2016\)/), confidence: 'sure', why: 'Companion to that run' },
    { item: T('Batman: The Killing Joke'), verdict: 'landmark', home: null, confidence: 'sure', why: 'Iconic standalone' },
    { item: T('Ultimate Comics Hawkeye'), verdict: 'none', home: null, confidence: 'likely', why: 'Belongs to the Ultimate line' },
    { item: T('America'), verdict: 'own', home: null, confidence: 'sure', why: 'Her own series' },
  ].filter(x => x.item) };
};

test('local candidates: prefix first, then running then and size; same publisher, larger only', () => {
  const { db } = fixture(answer);
  const ctx = B.seriesContext(db);
  const wow = B.seriesFacts(ctx.S.get('wow'), ctx);
  assert.deepEqual(wow.candidates.map(c => [c.id, c.running]), [['bp16', true], ['bp98', false]]);
  assert.deepEqual(B.seriesFacts(ctx.S.get('kj'), ctx).candidates.map(c => c.id), ['bat']);     // not Dark Horse's Batman
  assert.deepEqual(B.seriesFacts(ctx.S.get('am'), ctx).candidates.map(c => c.id), ['amc']);     // by its main character
  assert.deepEqual(ctx.targets.map(t => t.id).sort(), ['aa', 'am', 'aoa', 'kj', 'uhawk', 'wow']);   // 12 issues or fewer
  assert.deepEqual(B.seriesFacts(ctx.S.get('aa'), ctx).candidates.map(c => c.id), ['aoa']);    // as large counts (5 and 5)
  assert.match(B.renderSeries([B.seriesFacts(ctx.S.get('aa'), ctx)]).text, /^T1 Atlantis Attacks \(2020\) · Marvel · 5 issues · March 2020 - November 2020/);
  const { text } = B.renderSeries([wow]);
  assert.match(text, /^T1 Black Panther: World of Wakanda \(2016\) · Marvel · 6 issues · folder "2\. Modern Age"/);
  assert.doesNotMatch(text, /running then/);
  assert.match(text, /characters: Ayo, Aneka, Shuri/);
  assert.match(text, /C1 Black Panther \(2016\) · 25 issues · June 2016 - June 2018$/m);
});

test('ask, then apply the sure home: shelved like a tie-in; own, landmark and none change nothing; Undo', async () => {
  const { s, g, calls } = fixture(answer);
  const r = await s.ask({ kinds: ['series'] });
  assert.equal(r.asked, 4);                                                   // the fake model skips Atlantis Attacks
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /Series to check \(5\)/);
  assert.match(calls[0].system[0].text, /Gotham Academy: Second Semester continues Gotham Academy/);
  let sum = s.seriesSummary();
  assert.deepEqual(sum.suggested.map(x => [x.seriesId, x.homeId, x.confidence]), [['wow', 'bp16', 'sure']]);
  assert.deepEqual([sum.counts.own, sum.counts.landmark, sum.counts.none, sum.ready, sum.toAsk], [1, 1, 1, 1, 1]);
  assert.equal((await s.ask({ kinds: ['series'] })).total, 1);                 // only the unanswered one is asked again
  const a = s.apply();
  assert.equal(a.applied, 1);
  const m = g.groupMap().get('wow');
  assert.deepEqual([m.homes[0].id, m.homes[0].source, m.hidden], ['bp16', 'ai', true]);
  g.run();                                                                    // the rules leave it alone
  assert.equal(g.groupMap().get('wow').homes[0].source, 'ai');
  sum = s.seriesSummary();
  assert.deepEqual([sum.suggested.length, sum.shelved.map(x => x.seriesId)], [0, ['wow']]);
  s.undo(a.runId);
  assert.equal(g.groupMap().has('wow'), false);
  assert.equal(s.apply().applied, 0);                                         // undone: advice only
  assert.equal(s.seriesSummary().suggested[0].undone, true);
  assert.equal(s.apply({ seriesIds: ['wow'], sureOnly: false, mode: 'row' }).applied, 1);   // the admin's "Shelve"
});

test('Not this one sets a suggestion aside for good; a removal sticks; Restore puts it back', async () => {
  const { s, g } = fixture(answer);
  await s.ask({ kinds: ['series'] });
  const d = s.decline('wow');
  assert.equal(s.seriesSummary().suggested.length, 0);
  assert.equal(s.apply().applied, 0);
  s.undecline('wow', d.previous);
  assert.equal(s.seriesSummary().suggested.length, 1);
  s.apply();
  assert.equal(g.unlink('wow', 'bp16'), 'ai');                               // ✕ on the series page
  await s.ask({ kinds: ['series'], force: true });
  assert.equal(s.apply().applied, 0);                                         // never shelved there again
  assert.deepEqual(g.removed().map(x => x.seriesId), ['wow']);
  g.restore([{ seriesId: 'wow', homeId: 'bp16' }]);
  assert.deepEqual([g.groupMap().get('wow').homes[0].id, g.groupMap().get('wow').homes[0].source], ['bp16', 'manual']);
});

test('a series still publishing is shelved but stays visible', async () => {
  const { s, g, db } = fixture(answer);
  db.prepare("UPDATE scanned_series SET series_json = json_set(series_json, '$.metadata.status', 'Continuing') WHERE id = 'wow'").run();
  await s.ask({ kinds: ['series'] });
  s.apply();
  assert.equal(g.groupMap().get('wow').hidden, false);
});

const { createSeriesTypes, kindOf } = require('./seriesTypes');

test('Metron kinds: an ongoing is kept as its own without the AI; the kind is shown for the rest', async () => {
  const { db, g, calls } = fixture(answer);
  db.prepare("UPDATE scanned_series SET series_json = json_set(series_json, '$.metadata.comicid', ?) WHERE id = ?").run(100, 'am');
  db.prepare("UPDATE scanned_series SET series_json = json_set(series_json, '$.metadata.comicid', ?) WHERE id = ?").run(200, 'wow');
  const metron = { seriesStatus: async id => ({ id: Number(id) + 1, seriesType: id === '100' ? 'Ongoing Series' : 'Limited Series' }) };
  const types = createSeriesTypes({ db, metron });
  const settings = new Map();
  const ai = { run: (o, fn) => fn(), choose: () => 'm', complete: async opts => { calls.push(opts); return { text: JSON.stringify(answer(opts)), jobId: 'j', model: 'm' }; } };
  const s = createShelfSorter({ db, grouping: g, ai, getSetting: k => settings.get(k) || null, setSetting: (k, v) => settings.set(k, v), seriesTypes: types });
  const r = await s.lookUpTypes();
  assert.deepEqual([r.looked, r.ongoing, r.limited], [2, 1, 1]);
  assert.equal(kindOf('One-Shot'), 'one-shot');
  let sum = s.seriesSummary();
  assert.deepEqual([sum.counts.own, sum.counts.ongoing, sum.types.known, sum.types.total], [1, 1, 1, 1]);   // America is settled now: out of scope
  await s.ask({ kinds: ['series'] });
  assert.doesNotMatch(calls[0].prompt, /T\d+ America /);                       // never sent to the AI
  assert.match(calls[0].prompt, /Black Panther: World of Wakanda \(2016\) · Marvel · 6 issues · Metron: limited series/);
});

test('answers stay put: a new candidate does not ask again; "ask again about the suggested" covers only open suggestions; a lost home asks again', async () => {
  const unsureAnswer = opts => ({ series: answer(opts).series.map(x => (/Killing Joke/.test(opts.prompt.split('\n').find(l => l.startsWith(x.item + ' ')) || '') ? { ...x, confidence: 'unsure' } : x)) });
  const { s, db, calls, g } = fixture(unsureAnswer);
  await s.ask({ kinds: ['series'] });
  const n = calls.length;
  db.prepare('INSERT INTO scanned_series (id, name, year, series_json, book_count) VALUES (?, ?, ?, ?, ?)')
    .run('bp18', 'Black Panther', 2018, JSON.stringify({ metadata: { name: 'Black Panther', year: 2018, total_issues: 25, publisher: 'Marvel' } }), 25);
  await s.ask({ kinds: ['series'] });
  assert.match(calls[n].prompt, /Series to check \(1\)/);                   // only the one never answered (the fake skips it)
  assert.match(calls[n].prompt, /Atlantis Attacks/);
  const r = await s.ask({ kinds: ['series'], suggested: true });               // only the waiting suggestion (World of Wakanda)
  assert.match(calls[n + 1].prompt, /Series to check \(1\)/);
  assert.match(calls[n + 1].prompt, /World of Wakanda/);
  assert.doesNotMatch(calls[n + 1].prompt, /Killing Joke|Ultimate Comics Hawkeye|Atlantis Attacks|T\d+ America /);
  s.decline('wow');
  const before = calls.length;
  await s.ask({ kinds: ['series'], suggested: true });                         // declined: nothing left to ask
  assert.equal(calls.length, before);
  s.undecline('wow', null);
  assert.ok(r.asked >= 1);
  db.prepare("DELETE FROM scanned_series WHERE id = 'bp16'").run();            // the home it named is gone
  const ai = { run: (o, fn) => fn(), choose: () => 'm', complete: async opts => { calls.push(opts); return { text: JSON.stringify(unsureAnswer(opts)), jobId: 'j', model: 'm' }; } };
  const s2 = createShelfSorter({ db, grouping: g, ai, getSetting: () => null, setSetting: () => {} });   // a fresh library read
  assert.equal(s2.seriesSummary().suggested.length, 0);
  await s2.ask({ kinds: ['series'] });
  assert.match(calls[calls.length - 1].prompt, /World of Wakanda/);
});

test('"main story": shelved under the series but kept visible', async () => {
  const mainAnswer = opts => ({ series: answer(opts).series.map(x => (x.verdict === 'home' ? { ...x, verdict: 'main' } : x)) });
  const { s, g } = fixture(mainAnswer);
  await s.ask({ kinds: ['series'] });
  assert.equal(s.seriesSummary().suggested[0].main, true);
  s.apply();
  const m = g.groupMap().get('wow');
  assert.deepEqual([m.homes[0].id, m.homes[0].role, m.hidden], ['bp16', 'core', false]);
});

test('answers saved under the old rule (whole facts) carry over without asking again', async () => {
  const { s, db, calls } = fixture(answer);
  const crypto = require('crypto');
  const ctx = B.seriesContext(db);
  const f = B.seriesFacts(ctx.S.get('wow'), ctx);
  const b2 = crypto.createHash('sha1').update(JSON.stringify({ f, v: 'b2' })).digest('hex').slice(0, 16);
  db.prepare("INSERT INTO shelf_sorter_answers (kind, item_id, hash, model, answer, asked_at) VALUES ('series', 'wow', ?, 'm', ?, 1)")
    .run(b2, JSON.stringify({ verdict: 'home', homeId: 'bp16', confidence: 'sure', why: 'x' }));
  const sum = s.seriesSummary();
  assert.deepEqual(sum.suggested.map(x => [x.seriesId, x.stale]), [['wow', false]]);
  await s.ask({ kinds: ['series'] });
  assert.doesNotMatch(calls[0].prompt, /World of Wakanda/);
});

test('without an AI key, Ask gives Omnibus\'s own cautious suggestions (never applied on their own)', async () => {
  const { db, g } = fixture(answer);
  const setRun = (id, run) => db.prepare("UPDATE scanned_series SET series_json = json_set(series_json, '$.metadata.publication_run', ?) WHERE id = ?").run(run, id);
  setRun('wow', 'December 2016 - May 2017');                    // inside Black Panther (2016): June 2016 - June 2018
  db.prepare('INSERT INTO scanned_series (id, name, year, series_json, book_count) VALUES (?, ?, ?, ?, ?)')
    .run('bps', 'Black Panther: The Sequel', 2018, JSON.stringify({ metadata: { name: 'Black Panther: The Sequel', year: 2018, total_issues: 4, publisher: 'Marvel', publication_run: 'August 2018 - November 2018' } }), 4);
  const calls = [];
  const ai = { run: (o, fn) => fn(), choose: () => 'm', complete: async o => { calls.push(o); return { text: '{}', jobId: 'j' }; } };
  const s = createShelfSorter({ db, grouping: g, ai, getSetting: () => null, setSetting: () => {}, aiAvailable: () => false });
  const r = await s.ask();
  assert.equal(r.local, true);
  assert.equal(calls.length, 0);
  const sum = s.seriesSummary();
  assert.deepEqual(sum.suggested.map(x => [x.seriesId, x.homeId, x.confidence, x.model]), [['wow', 'bp16', 'likely', 'omnibus']]);   // not the one begun after it ended
  assert.equal(s.apply().applied, 0);                            // "Apply sure" leaves it to the admin
  assert.equal(s.apply({ seriesIds: ['wow'], sureOnly: false, mode: 'row' }).applied, 1);
  assert.equal(s.status().aiAvailable, false);
});

test('Metron lookups cover only what a type can still change: open suggestions first, then unasked series', async () => {
  const { db, g } = fixture(answer);
  const ids = { wow: 200, kj: 300, am: 100, uhawk: 400, aa: 500 };
  for (const [id, cid] of Object.entries(ids)) db.prepare("UPDATE scanned_series SET series_json = json_set(series_json, '$.metadata.comicid', ?) WHERE id = ?").run(cid, id);
  const asked = [];
  const metron = { seriesStatus: async id => { asked.push(id); return { id: 1, seriesType: 'Limited Series' }; } };
  const types = createSeriesTypes({ db, metron });
  const ai = { run: (o, fn) => fn(), choose: () => 'm', complete: async opts => ({ text: JSON.stringify(answer(opts)), jobId: 'j', model: 'm' }) };
  const s = createShelfSorter({ db, grouping: g, ai, getSetting: () => null, setSetting: () => {}, seriesTypes: types });
  await s.ask({ kinds: ['series'] });   // wow → home (open); kj landmark, uhawk none, am own: settled; aa not answered by the fake
  assert.deepEqual(s.seriesSummary().types, { known: 0, total: 2, running: false, words: [] });
  await s.lookUpTypes();
  assert.deepEqual(asked, ['200', '500']);                                    // the suggestion first, then the unanswered one
  assert.deepEqual(s.seriesSummary().types.known, 2);
  assert.deepEqual(s.seriesSummary().types.words, [{ word: 'Limited Series', count: 2 }]);
});

test('Metron kinds: a cancelled series counts as an ongoing, also for types saved before', () => {
  const { db } = fixture(answer);
  assert.equal(kindOf('Cancelled Series'), 'ongoing');
  assert.equal(kindOf('Single Issue'), 'one-shot');
  assert.equal(kindOf('Graphic Novel'), 'other');
  const types = createSeriesTypes({ db });
  db.prepare("INSERT INTO series_types (comicid, metron_id, type, kind, checked_at) VALUES ('7', 1, 'Cancelled Series', 'other', 1)").run();
  assert.equal(types.all().get('7').kind, 'ongoing');
});

test('a full review asks about what the AI shelved too; a disagreement waits on Shelved by the AI; Keep it ends it', async () => {
  let reply = answer;
  const { s, db, settings } = fixture(o => reply(o));
  await s.ask({ kinds: ['series'] });
  s.apply();
  const linked = () => db.prepare("SELECT home_id FROM series_links WHERE series_id = 'wow'").all().map(r => r.home_id);
  assert.deepEqual(linked(), ['bp16']);
  const n = scope => s.estimate({ scope, kinds: ['series'] }).series;
  assert.deepEqual(['new', 'suggested', 'all'].map(n), [1, 0, 5]);   // new: Atlantis Attacks (never answered); all: the 4 with a candidate and wow on its shelf
  // Asked again, the model now says World of Wakanda is a series of its own.
  reply = o => ({ series: answer(o).series.map(x => /World of Wakanda/.test(o.prompt) && x.verdict === 'home' ? { ...x, verdict: 'own', home: null, why: 'Its own team book' } : x) });
  settings.set('shelf_sorter_auto', '1');
  const r = await s.ask({ scope: 'all', kinds: ['series'] });
  assert.equal(r.applied, undefined);                                         // a re-ask never applies
  assert.deepEqual(linked(), ['bp16']);                                       // still on its shelf
  let sum = s.seriesSummary();
  assert.deepEqual([sum.shelved[0].seriesId, sum.shelved[0].rethink.verdict, sum.counts.rethink], ['wow', 'own', 1]);
  assert.equal(n('suggested'), 1);                                            // the disagreement is open advice
  const k = s.keep('wow');
  sum = s.seriesSummary();
  assert.equal(sum.shelved[0].rethink, null);
  assert.equal(n('all'), 4);                                                  // kept: the admin's decision
  s.keep('wow', { undo: true, previous: k.previous });
  assert.equal(s.seriesSummary().counts.rethink, 1);
});

test('too new to judge: a series with only #1 out and still publishing waits for Metron or a second issue', async () => {
  const { db, s, g, calls } = fixture(answer);
  db.prepare('INSERT INTO scanned_series VALUES (?, ?, ?, ?, ?, ?)').run('bpn', 'Black Panther: Gangs of Wakanda', 2027,
    JSON.stringify({ metadata: { name: 'Black Panther: Gangs of Wakanda', year: 2027, total_issues: 1, publisher: 'Marvel', publication_run: 'January 2027 - Present', status: 'Continuing', comicid: 999 } }), 1, '/comics/Marvel/x/Black Panther - Gangs of Wakanda (2027)');
  assert.equal(B.tooNew({ issues: 1, status: 'Continuing' }), true);
  assert.equal(B.tooNew({ issues: 1, status: 'Ended' }), false);                 // a real one-shot is asked about
  assert.equal(B.tooNew({ issues: 1, status: 'Continuing', kind: 'limited' }), false);   // Metron knows: ask
  await s.ask({ kinds: ['series'] });
  assert.doesNotMatch(calls[0].prompt, /Gangs of Wakanda/);
  assert.equal(s.seriesSummary().waiting, 1);
  // A second issue arrives: it is asked about.
  db.prepare("UPDATE scanned_series SET series_json = json_set(series_json, '$.metadata.total_issues', 2), book_count = 2 WHERE id = 'bpn'").run();
  const fresh = createShelfSorter({ db, grouping: g, ai: { run: (o, fn) => fn() }, getSetting: () => null, setSetting: () => {} });   // no cached library facts
  assert.ok(fresh.plan({ kinds: ['series'] }).bTodo.some(b => b.f.id === 'bpn'));
  assert.equal(fresh.seriesSummary().waiting, 0);
});

test('Events only: minis and one-shots are left alone (no asks, no estimates, no Metron lookups)', async () => {
  const { db, g, calls } = fixture(answer);
  let minis = false;
  const asked = [];
  const types = createSeriesTypes({ db, metron: { seriesStatus: async id => { asked.push(id); return null; } } });
  const ai = { run: (o, fn) => fn(), choose: () => 'm', complete: async opts => { calls.push(opts); return { text: JSON.stringify(answer(opts)), jobId: 'j', model: 'm' }; } };
  const s = createShelfSorter({ db, grouping: g, ai, getSetting: () => null, setSetting: () => {}, seriesTypes: types, minisEnabled: () => minis });
  assert.equal(s.estimate({ kinds: ['series'] }).series, 0);
  assert.equal((await s.ask({ kinds: ['event', 'series'] })).asked, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(await s.lookUpTypes(), { skipped: true });
  assert.equal(s.seriesReady(), 0);
  assert.equal(s.status().minis, false);
  minis = true;                                                               // Events and minis
  assert.ok(s.estimate({ kinds: ['series'] }).series > 0);
  const noAi = createShelfSorter({ db, grouping: g, ai, getSetting: () => null, setSetting: () => {}, aiAvailable: () => false, minisEnabled: () => false });
  assert.deepEqual(await noAi.ask(), { asked: 0, runId: null, local: true });   // events need the AI; minis are off
});
