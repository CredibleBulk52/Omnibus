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
  assert.deepEqual(ctx.targets.map(t => t.id).sort(), ['am', 'kj', 'uhawk', 'wow']);          // 12 issues or fewer
  const { text } = B.renderSeries([wow]);
  assert.match(text, /^T1 Black Panther: World of Wakanda \(2016\) · Marvel · 6 issues · folder "2\. Modern Age"/);
  assert.match(text, /characters: Ayo, Aneka, Shuri/);
  assert.match(text, /C1 Black Panther \(2016\) · 25 issues · June 2016 - June 2018 · running then/);
});

test('ask, then apply the sure home: shelved like a tie-in; own, landmark and none change nothing; Undo', async () => {
  const { s, g, calls } = fixture(answer);
  const r = await s.ask({ kinds: ['series'] });
  assert.equal(r.asked, 4);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /Series to check \(4\)/);
  let sum = s.seriesSummary();
  assert.deepEqual(sum.suggested.map(x => [x.seriesId, x.homeId, x.confidence]), [['wow', 'bp16', 'sure']]);
  assert.deepEqual([sum.counts.own, sum.counts.landmark, sum.counts.none, sum.ready, sum.toAsk], [1, 1, 1, 1, 0]);
  assert.equal((await s.ask({ kinds: ['series'] })).asked, 0);                 // nothing changed: not asked again
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
