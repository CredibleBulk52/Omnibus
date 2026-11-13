'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createSeriesGrouping } = require('./seriesGrouping');
const { createShelfSorter, parseReply } = require('./shelfSorter');

function fixture(reply) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER, series_json TEXT, book_count INTEGER, path TEXT);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, is_special INTEGER DEFAULT 0, comicinfo TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT, year INTEGER, publisher TEXT, draft INTEGER DEFAULT 0);
    CREATE TABLE event_issues (id INTEGER PRIMARY KEY, event_id TEXT, scanned_book_id TEXT, series_name TEXT, volume_year TEXT, tier TEXT, phase TEXT, sort_order INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  let n = 0;
  const series = (id, name, year, issues) => {
    db.prepare('INSERT INTO scanned_series (id, name, year, series_json, book_count) VALUES (?, ?, ?, ?, ?)').run(id, name, year, JSON.stringify({ metadata: { name, year, total_issues: issues, status: 'Ended' } }), issues);
    const ids = [];
    for (let i = 0; i < issues; i++) { const b = `${id}-${i}`; db.prepare('INSERT INTO scanned_books (id, series_id) VALUES (?, ?)').run(b, id); ids.push(b); }
    return ids;
  };
  const inEvent = (event, bookIds, tier = 'tie-in') => bookIds.forEach(b =>
    db.prepare('INSERT INTO event_issues (id, event_id, scanned_book_id, series_name, tier, phase, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)').run(++n, event, b, b, tier, '', n));
  db.prepare("INSERT INTO events (id, name, year, publisher) VALUES ('aoa', 'Age of Apocalypse', 1995, 'Marvel')").run();
  inEvent('aoa', series('gen', 'Generation Next', 1995, 4), 'essential');
  inEvent('aoa', series('ast', 'Astonishing X-Men', 1995, 4), 'essential');
  inEvent('aoa', series('tales', 'Tales from the Age of Apocalypse', 1996, 1));
  inEvent('aoa', series('omega', 'X-Men: Omega', 1995, 1));
  const g = createSeriesGrouping({ db });
  g.run();
  const calls = [];
  const settings = new Map();
  const ai = {
    run: (o, fn) => fn(),
    choose: () => 'claude-sonnet-5-5',
    complete: async opts => { calls.push(opts); return { text: JSON.stringify(reply(opts)), jobId: `j${calls.length}`, model: 'claude-sonnet-5-5' }; },
  };
  const s = createShelfSorter({ db, grouping: g, ai, getSetting: k => settings.get(k) || null, setSetting: (k, v) => settings.set(k, v) });
  return { db, g, s, calls, settings };
}

// The fake model: change the home to Astonishing X-Men, take Tales off (sure), keep Omega visible (likely).
const answer = opts => {
  const text = opts.prompt;
  const id = name => (new RegExp(`(S\\d+) ${name}`).exec(text) || [])[1];
  return { events: [{ event: 'E1', home: { verdict: 'change', series: id('Astonishing X-Men'), confidence: 'sure', why: 'The flagship during the event' },
    members: [{ series: id('Tales from'), action: 'remove', confidence: 'sure', why: 'Published after the event' },
      { series: id('X-Men: Omega'), action: 'keep_visible', confidence: 'likely', why: 'The finale' }] }] };
};

test('Ask saves answers only; the prompt is one line per series with local ids', async () => {
  const { s, g, calls } = fixture(answer);
  const r = await s.ask();
  assert.equal(r.asked, 1);
  assert.match(calls[0].prompt, /E1 Age of Apocalypse \(1995, Marvel\)/);
  assert.match(calls[0].prompt, /S\d+ Astonishing X-Men \(1995\) · 4 in order \(main 4\) · from #5 · 4-issue series · ON SHELF: core, visible/);
  assert.equal(calls[0].task, 'shelf_sorter');
  assert.equal(g.summary().events[0].home, 'gen');                  // nothing applied yet
  const sum = g.summary();
  assert.equal(s.annotate(sum), 2);                                 // two sure changes are waiting
  assert.deepEqual([sum.events[0].ai.home.verdict, sum.events[0].ai.home.name], ['change', 'Astonishing X-Men (1995)']);
  // Asking again sends nothing: the event has not changed.
  assert.equal((await s.ask()).asked, 0);
  assert.equal(calls.length, 1);
});

test('Apply sure ones changes the home and takes a series off; Undo puts the run back', async () => {
  const { s, g } = fixture(answer);
  await s.ask();
  const r = s.apply();
  assert.equal(r.applied, 2);
  let e = g.summary().events[0];
  assert.deepEqual([e.home, e.confirmed, e.source, e.why], ['ast', true, 'ai', 'Chosen by the AI']);
  assert.deepEqual(g.removed().map(x => x.seriesId), ['tales']);
  assert.equal(g.groupMap().get('omega').keepVisible, false);      // "likely" is not applied
  assert.equal(s.apply().applied, 0);                               // already applied
  s.undo(r.runId);
  e = g.summary().events[0];
  assert.deepEqual([e.home, e.confirmed], ['gen', false]);
  assert.equal(g.removed().length, 0);
  assert.equal(g.groupMap().get('tales').homes[0].id, 'gen');
  assert.equal(s.apply().applied, 0);                               // an undone answer is not applied again
});

test('the admin wins: a home they approved and a series they put back are left alone', async () => {
  const { s, g } = fixture(answer);
  g.setEvent('aoa', { confirm: true });
  g.unlink('tales', 'gen'); g.restore([{ seriesId: 'tales', homeId: 'gen' }]);
  await s.ask();
  assert.equal(s.apply().applied, 0);
  assert.equal(g.summary().events[0].home, 'gen');
  assert.equal(g.groupMap().get('tales').homes[0].id, 'gen');
  // A row's "Use the AI's advice" applies everything for that event, sure or not, except over the admin's own choices.
  const r = s.apply({ eventIds: ['aoa'], sureOnly: false, mode: 'row' });
  assert.equal(r.applied, 1);                                       // Omega kept visible
  assert.equal(g.groupMap().get('omega').keepVisible, true);
});

test('automatic mode asks about new events and applies sure answers; off does nothing', async () => {
  const { s, g, settings, calls } = fixture(answer);
  assert.deepEqual(await s.auto(), { skipped: true });
  settings.set('shelf_sorter_auto', '1');
  const r = await s.auto();
  assert.equal(r.asked, 1); assert.equal(r.applied, 2);
  assert.equal(g.summary().events[0].home, 'ast');
  await s.auto();
  assert.ok(calls.length >= 1);
});

test('answers naming series outside the event, or a missing key, change nothing', async () => {
  const bad = () => ({ events: [{ event: 'E1', home: { verdict: 'change', series: 'S99', confidence: 'sure', why: 'x' }, members: [{ series: 'S98', action: 'remove', confidence: 'sure', why: 'x' }] }] });
  const { s, g } = fixture(bad);
  await s.ask();
  assert.equal(s.apply().applied, 0);
  assert.equal(g.summary().events[0].home, 'gen');
  const f2 = fixture(answer);
  f2.s.ask = f2.s.ask;   // a missing key stops the run with its message
  const ai2 = { run: (o, fn) => fn(), choose: () => 'x', complete: async () => { throw Object.assign(new Error('No Anthropic API key set'), { code: 'AI_KEY_MISSING' }); } };
  const s2 = createShelfSorter({ db: f2.db, grouping: f2.g, ai: ai2, getSetting: () => null, setSetting: () => {} });
  const r = await s2.ask();
  assert.deepEqual([r.asked, r.error], [0, 'No Anthropic API key set']);
});

test('parseReply reads fenced or wrapped JSON', () => {
  assert.deepEqual(parseReply('```json\n{"events":[]}\n```'), { events: [] });
  assert.equal(parseReply('nope'), null);
});
