'use strict';
// Comic Book Guy routing: Quick Answers is the first stop; it points to saved
// reading orders, or hands off to the generator / Long Answers. Uses
// node:sqlite and a scripted model, so no network or API key is needed.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const fuzzy = require('./fuzzyMatch');
const createAssistant = require('../assistant');

function setup(script, extra = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT);
    CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER, path TEXT, series_json TEXT, monitored_series_id TEXT);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, issue_number TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT, publisher TEXT, year INTEGER, description TEXT);
    CREATE TABLE event_issues (id INTEGER PRIMARY KEY, event_id TEXT, series_name TEXT, issue_number TEXT, tier TEXT, phase TEXT, scanned_book_id TEXT, sort_order REAL);
    CREATE TABLE canon_runs (id INTEGER PRIMARY KEY, title TEXT, parent_series TEXT, issue_range_hint TEXT, status TEXT, description TEXT);
    CREATE TABLE canon_run_issues (id INTEGER PRIMARY KEY, run_id INTEGER, series_name TEXT, issue_number TEXT, volume_year INTEGER, scanned_book_id TEXT, sort_order REAL);
    CREATE TABLE reading_lists (id INTEGER PRIMARY KEY, name TEXT, description TEXT, owner_id TEXT, visibility TEXT, source TEXT, updated_at TEXT);
    CREATE TABLE reading_list_entries (id INTEGER PRIMARY KEY, list_id INTEGER, entry_type TEXT, sort_order REAL);
    INSERT INTO events VALUES ('ev-bn', 'Blackest Night', 'DC Comics', 2009, ''), ('ev-ic', 'Infinite Crisis', 'DC Comics', 2005, '');
    INSERT INTO event_issues (event_id, series_name, issue_number, tier) VALUES ('ev-bn', 'Blackest Night', '1', 'essential'), ('ev-bn', 'Green Lantern', '43', 'essential');
    INSERT INTO canon_runs VALUES (1, 'Batman: The Long Halloween', 'Batman: The Long Halloween', '1-13', 'approved', '');
    INSERT INTO reading_lists VALUES (1, 'Where to Start: Hal Jordan', '', 'admin', 'essential', 'manual', NULL), (2, 'Secret list', '', 'someone', 'private', 'manual', NULL);
  `);
  const calls = [];
  const deps = {
    app: { get() {}, post() {}, put() {}, delete() {}, patch() {} }, db, express: { raw: () => (q, r, n) => n() },
    axios: null, requireAuth: (q, r, n) => n(), requireAdmin: (q, r, n) => n(),
    getSetting: () => null, logger: { info() {}, warn() {}, error() {} }, IN: { normIssueNumber: s => s },
    getAnthropicKey: () => 'k', getEventModel: () => 'gen', getValidationModel: () => 'quick',
    modelFor: id => ({ quick_answer: 'quick', reading_list: 'gen', long_answer: 'long' }[id]),
    fetchAllSeries: () => db.prepare('SELECT id, name, year, path FROM scanned_series').all(), getSeriesJsonCached: () => null, dataDir: os.tmpdir(),
    callModel: async body => { calls.push(body); return script(body, calls.length); },
    ...extra,
  };
  return { a: createAssistant(deps), calls, db };
}
const use = (name, input, id = 't' + Math.random()) => ({ type: 'tool_use', id, name, input });
const reply = (...content) => ({ content, stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } });
const toolNames = body => body.tools.map(t => t.name);
// The reader's answers from the setup form (selectionSetup.js).
const confirmed = (subject, format = 'order', more = {}) => ({ selection_setup: { kind: 'character', subject, format, priority: 'best', start: 'modern', availability: 'library', ...more } });
const ask = (a, q) => a.converse({ messages: [{ role: 'user', content: q }], context: {}, userId: 'admin' });

test('fuzzy: misspellings, joined names and filler still find saved titles', () => {
  const items = ['Blackest Night', 'Absolute Batman', 'Infinite Crisis', 'Batman: The Long Halloween', 'Spider-Man: Clone Saga'].map(title => ({ title }));
  const top = q => fuzzy.rank(q, items, { limit: 1 })[0];
  assert.equal(top('blakest nite').item.title, 'Blackest Night');
  assert.equal(top('Blackest Night reading order').match, 'exact');
  assert.equal(top('infinate crisis').item.title, 'Infinite Crisis');
  assert.equal(top('long haloween').item.title, 'Batman: The Long Halloween');
  assert.equal(top('spiderman clone saga').item.title, 'Spider-Man: Clone Saga');
  assert.equal(top('DC Absolute').item.title, 'Absolute Batman');
  assert.equal(fuzzy.rank('Watchmen', items).length, 0);
});

test('Quick points to a saved reading order without the generator', async () => {
  const { a, calls } = setup((body, n) => n === 1
    ? reply(use('search_reading_lists', { query: 'Blackest Night' }))
    : reply(use('respond', { answer: 'The Timeline has it.', refs: [{ type: 'event', id: 'ev-bn', label: 'Blackest Night' }], proposed_list: { name: 'x', entries: [{ type: 'event', event_id: 'ev-bn' }] } })));
  const out = await ask(a, 'whats the reading order for blakest nite');
  assert.equal(out.route, 'quick');
  assert.deepEqual(calls.map(c => c.model), ['quick', 'quick']);
  assert.ok(toolNames(calls[0]).includes('hand_off') && toolNames(calls[0]).includes('search_reading_lists'));
  assert.ok(!toolNames(calls[0]).includes('web_search'));
  assert.ok(!calls[0].tools.find(t => t.name === 'respond').input_schema.properties.proposed_list, 'Quick cannot make lists');
  assert.match(JSON.stringify(calls[0].system), /ROUTING/);
  const result = JSON.parse(calls[1].messages.at(-1).content[0].content);
  assert.equal(result.results[0].event_id, 'ev-bn');
  assert.equal(result.results[0].match, 'exact');
  assert.equal(out.reply.proposed_list, null, 'a list from Quick is dropped');
  assert.deepEqual(out.reply.refs.map(r => r.id), ['ev-bn']);
});

test('hand_off to the generator without the reader\'s choices opens the setup form, keeping only saved orders Quick saw', async () => {
  const { a, calls } = setup((body, n) => n === 1 ? reply(use('search_reading_lists', { query: 'Green Lantern' }))
    : reply(use('hand_off', { target: 'reading_list', reason: 'Broader than one event.', kind: 'character', subject: 'Hal Jordan', priority: 'best', how: 'inferred',
      saved: [{ type: 'event', id: 'ev-bn', name: 'Blackest Night' }, { type: 'event', id: 'ev-fake' }] })));
  const out = await ask(a, 'What is the Hal Jordan reading order from Rebirth onward?');
  assert.deepEqual(calls.map(c => c.model), ['quick', 'quick'], 'no generator call');
  const form = out.reply.selection_setup;
  assert.equal(form.kind, 'character'); assert.equal(form.subject, 'Hal Jordan');
  assert.deepEqual(form.values, { format: 'order' }, 'only the format is known; priority is the reader\'s to pick');
  assert.deepEqual(form.saved.map(x => x.id), ['ev-bn'], 'ids Quick never saw are dropped');
  assert.equal(out.reply.proposed_list, null);
});

test('the confirmed choices reach the generator clean, with the brief and the saved matches', async () => {
  const { a, calls } = setup(() => reply(use('respond', { answer: 'Done.', proposed_list: { name: 'GL', entries: [{ type: 'event', event_id: 'ev-bn' }] } })));
  const ctx = confirmed('Hal Jordan', 'order', { saved: [{ type: 'event', id: 'ev-bn', name: 'Blackest Night' }, { type: 'event', id: 'ev-fake' }] });
  const out = await a.converse({ messages: [{ role: 'user', content: 'Build it from my choices.' }], context: ctx, userId: 'admin' });
  assert.equal(out.route, 'setup → reading_list');
  assert.deepEqual(calls.map(c => c.model), ['gen']);
  const gen = calls[0];
  const text = JSON.stringify(gen.messages);
  assert.match(text, /SAVED READING ORDERS.*Blackest Night.*event_id ev-bn/);
  assert.doesNotMatch(text, /ev-fake/, 'saved orders that do not exist are dropped');
  assert.ok(!toolNames(gen).includes('hand_off') && !toolNames(gen).includes('ask_reader'));
  assert.deepEqual(gen.tools.find(t => t.name === 'respond').input_schema.required, ['answer', 'proposed_list']);
  assert.match(JSON.stringify(gen.system), /PROPOSED READING LISTS/);
  assert.equal(out.reply.proposed_list.entries.length, 1);
});

test('hand_off to Long Answers: no list, long model', async () => {
  const { a, calls } = setup((body, n) => n === 1 ? reply(use('hand_off', { target: 'long_answer', reason: 'Deep continuity.' }))
    : reply(use('respond', { answer: 'A long history.', proposed_list: { name: 'x', entries: [{ type: 'event', event_id: 'ev-bn' }] } })));
  const out = await ask(a, 'Explain how Hal Jordan became Parallax and came back.');
  assert.equal(out.route, 'quick → long_answer');
  assert.equal(calls[1].model, 'long');
  assert.ok(!calls[1].tools.find(t => t.name === 'respond').input_schema.properties.proposed_list);
  assert.match(JSON.stringify(calls[1].system), /LONG ANSWERS/);
  assert.equal(out.reply.proposed_list, null);
});

test('a personal version goes through Quick, which opens the setup form', async () => {
  const { a, calls } = setup(() => reply(use('ask_reader', { kind: 'character', subject: 'Flash', format: 'order', message: 'Your OWN Flash list. Which Flash, and what for?' })));
  const out = await ask(a, 'Build me my own Flash reading list');
  assert.equal(out.route, 'quick');
  assert.deepEqual(calls.map(c => c.model), ['quick']);
  assert.match(JSON.stringify(calls[0].messages), /wants their own list/);
  assert.deepEqual(out.reply.selection_setup.values, { format: 'order' });
});

test('search_reading_lists hides other users\' private lists', () => {
  const { a } = setup(() => reply());
  const seen = new Set();
  const r = a.runTool('search_reading_lists', { query: 'Hal Jordan' }, { seen, userId: 'admin' });
  assert.equal(r.results[0].type, 'Essentials');
  assert.equal(a.runTool('search_reading_lists', { query: 'Secret list' }, { seen, userId: 'admin' }).results.length, 0);
});

test('recent openings and endings ride along with the next question', async () => {
  const answers = ['Ah, yes. Kyle Rayner, the last Green Lantern standing after Emerald Twilight. Verdict: tolerable.', 'Second answer here, which is long enough to count. Fine.'];
  let i = 0;
  const { a, calls } = setup(() => reply(use('respond', { answer: answers[i++] || 'x' })));
  await ask(a, 'Who is Kyle Rayner?');
  assert.doesNotMatch(JSON.stringify(calls[0].messages), /RECENT CHARACTER PERFORMANCE/, 'nothing to show yet');
  await ask(a, 'Who is Guy Gardner?');
  const sent = JSON.stringify(calls[1].messages);
  assert.match(sent, /RECENT CHARACTER PERFORMANCE/);
  assert.match(sent, /Recent openings: \\"Ah, yes\.\\"/);
  assert.match(sent, /Recent endings: \\"Verdict: tolerable\.\\"/);
  const sys = JSON.stringify(calls[0].system);
  assert.match(sys, /As Quick Answers, answer in 80-200 words/);
  assert.match(sys, /JEFF ALBERTSON/);
  assert.doesNotMatch(sys, /\$\{/, 'no unfilled template slots');
});

test('ids written into the text are removed and kept as links; shared names need a year', async () => {
  const answer = 'Read Starman (1994) from #0, a Star Trek of a run, minus the Klingons. Ooh, and kindly refrain from skipping. Green Lantern is irrelevant here. I am forced to concede the art is uneven.\n\nRefs: Starman (series ss_aaaa1111); Green Lantern (series ss_cccc3333).';
  const { a, calls, db } = setup((body, n) => n === 1
    ? reply(use('library_search', { query: 'Starman' }), use('library_search', { query: 'Green Lantern' }))
    : reply(use('respond', { answer, refs: [] })));
  db.exec(`INSERT INTO scanned_series (id, name, year) VALUES ('ss_aaaa1111', 'Starman', 1994), ('ss_bbbb2222', 'Starman', 1988),
    ('ss_cccc3333', 'Green Lantern', 2005), ('ss_dddd4444', 'Green Lantern', 1990)`);
  const out = await ask(a, 'Tell me about Starman');
  assert.doesNotMatch(out.reply.answer, /Refs:|ss_/);
  const ids = out.reply.refs.map(r => r.id);
  assert.ok(ids.includes('ss_aaaa1111'), 'Starman (1994): named with its year');
  assert.ok(!ids.includes('ss_bbbb2222'), 'Starman (1988): same name, no year');
  assert.ok(ids.includes('ss_cccc3333'), 'salvaged from the Refs line');
  assert.ok(!ids.includes('ss_dddd4444'), 'Green Lantern (1990) not linked without its year');
  // stock phrases go into the next note; the catchphrase is never listed
  await ask(a, 'And then?');
  const note = JSON.stringify(calls.at(-1).messages);
  assert.match(note, /Stock phrases used lately: .*I am forced to concede/);
  assert.match(note, /Kindly refrain/);
  assert.match(note, /Universes you compared things to lately: Star Trek/);
  assert.doesNotMatch(note, /Stock phrases used lately:[^\n]*Worst/);
});

test('catchphrase pacing: due after two answers without it, rested after one', async () => {
  const answers = ['First answer, long enough to be remembered here. Fine.', 'Second answer, also long enough to be remembered. Fine.',
    'Third answer with the punchline at the end. Worst. Renumbering. Ever.', 'Fourth answer, long enough to be remembered as well. Fine.'];
  let i = 0;
  const { a, calls } = setup(() => reply(use('respond', { answer: answers[i++] || 'x' })));
  const sent = n => JSON.stringify(calls[n].messages);
  await ask(a, 'One?'); await ask(a, 'Two?');
  assert.doesNotMatch(sent(1), /Catchphrase:/, 'one answer without it: no note');
  await ask(a, 'Three?');
  assert.match(sent(2), /Catchphrase: due\. You have not said it in your last 2 answers/);
  await ask(a, 'Four?');
  assert.match(sent(3), /Catchphrase: you used .* in your last answer; leave it out/);
  await ask(a, 'Five?');
  assert.doesNotMatch(sent(4), /Catchphrase:/);
  assert.match(JSON.stringify(calls[0].system), /roughly one answer in three/);
});

test('reading_history shows the last finished issue and the next one up per series', () => {
  const { a, db } = setup(() => reply());
  db.exec(`ALTER TABLE scanned_books ADD COLUMN sort_order REAL;
    CREATE TABLE read_progress (id INTEGER PRIMARY KEY, user_id TEXT, book_id TEXT, page INTEGER, completed INTEGER, updated_at TEXT);
    INSERT INTO scanned_series (id, name, year) VALUES ('ss_agl', 'Absolute Green Lantern', 2025);`);
  for (let i = 1; i <= 19; i++) db.prepare('INSERT INTO scanned_books (id, series_id, issue_number, sort_order) VALUES (?,?,?,?)').run(`sb_agl${i}`, 'ss_agl', String(i), i);
  for (let i = 1; i <= 12; i++) db.prepare('INSERT INTO read_progress (user_id, book_id, page, completed, updated_at) VALUES (?,?,?,?,?)').run('admin', `sb_agl${i}`, 22, 1, `2026-10-0${i % 9 + 1}`);
  const r = a.runTool('reading_history', {}, { seen: new Set(), userId: 'admin' });
  assert.match(r.recent_series[0], /Absolute Green Lantern \(2025\).*finished through #12 \(12 of 19.*next up #13, not started/);
  // in progress wins over next-unstarted
  db.prepare('INSERT INTO read_progress (user_id, book_id, page, completed, updated_at) VALUES (?,?,?,?,?)').run('admin', 'sb_agl13', 5, 0, '2026-10-12');
  const r2 = a.runTool('reading_history', { series_id: 'ss_agl' }, { seen: new Set(), userId: 'admin' });
  assert.match(r2.recent_series[0], /currently reading #13, page 5/);
  // by name, without an id
  const r3 = a.runTool('reading_history', { series: 'absolute green lanturn' }, { seen: new Set(), userId: 'admin' });
  assert.match(String(r3.series), /Absolute Green Lantern.*currently reading #13/);
});

test('OpenAI citation markers are removed from answers', () => {
  const { a } = setup(() => reply());
  const strip = a._internal.stripCites;
  const raw = 'Not exactly glamorous. citeturn6search1turn2view1\n\nCameron arrives. citeturn3search0 Then #11.';
  const out = strip(raw);
  assert.doesNotMatch(out, /cite|turn\d|[-]/);
  assert.match(out, /Not exactly glamorous\./);
  assert.match(out, /Cameron arrives\. Then #11\./);
});

test('a list sent as a JSON string is accepted; a missing list is admitted in the answer', async () => {
  const listStr = JSON.stringify({ name: 'GL', entries: [{ type: 'event', event_id: 'ev-bn' }] });
  const first = setup((body, n) => n === 1 ? reply(use('search_reading_lists', { query: 'Blackest Night' }))
    : reply(use('respond', { answer: 'I have drawn up the order.', proposed_list: listStr })));
  const ok = await first.a.converse({ messages: [{ role: 'user', content: 'Build me my own reading list for Blackest Night' }], context: confirmed('A focused reading order'), userId: 'admin' });
  assert.equal(ok.reply.proposed_list.entries.length, 1);
  assert.equal(first.calls.length, 2, 'no rescue call needed');
  assert.doesNotMatch(ok.reply.answer, /failed to print/);

  const second = setup(body => reply(use('respond', { answer: 'I have drawn up the order.' })));
  const bad = await second.a.converse({ messages: [{ role: 'user', content: 'Build me my own reading list for Hal Jordan' }], context: confirmed('A focused reading order'), userId: 'admin' });
  assert.equal(bad.reply.proposed_list, null);
  assert.equal(second.calls.length, 2, 'one rescue call');
  assert.match(bad.reply.answer, /failed to print/);
});

test('the "spent ... of my life" joke shape is tracked', async () => {
  const answers = ['Sigh. Read Year One. I have spent an unreasonable portion of my life verifying that sort of thing, so do not thank me.', 'Fine. Another answer here for the note.'];
  let i = 0;
  const { a, calls } = setup(() => reply(use('respond', { answer: answers[i++] || 'x' })));
  await ask(a, 'Best Batman comic?');
  await ask(a, 'And then?');
  assert.match(JSON.stringify(calls[1].messages), /spent\/devoted \.\.\. of my life/);
});

test('a story label keeps the actual book next to it', async () => {
  const { a, db } = setup((body, n) => n === 1 ? reply(use('library_search', { query: 'Flash' }), use('search_reading_lists', { query: 'Blackest Night' }))
    : reply(use('respond', { answer: 'Here.', proposed_list: { name: 'Flash', entries: [
      { type: 'range', series_id: 'ss_fl', issue_start: '108', issue_end: '108', label: 'Dead Heat — part 1' },
      { type: 'event', event_id: 'ev-bn', label: 'Blackest Night' },
      { type: 'range', series_id: 'ss_nope', issue_start: '10', issue_end: '10', label: 'Dead Heat — part 2' }] } })));
  db.exec(`INSERT INTO scanned_series (id, name, year) VALUES ('ss_fl', 'The Flash', 1987)`);
  const out = await a.converse({ messages: [{ role: 'user', content: 'Build me my own reading list for the Flash' }], context: confirmed('A focused reading order'), userId: 'admin' });
  const shown = out.reply.proposed_list.entries.map(e => e.display);
  assert.deepEqual(shown, ['Dead Heat — part 1 · The Flash (1987) #108', 'Blackest Night']);
});

test('a drafted list gets the editorial checklist once; the review is written first and kept out of the answer', async () => {
  const draft = ['Showcase', 'Green Lantern', 'Mosaic', 'JLA'].map((series, k) => ({ series, issue_start: String(k + 1) }));
  const { a, calls, db } = setup((body, n) => n === 1 ? reply(use('check_list', { items: draft }))
    : n === 2 ? reply(use('check_list', { items: draft.slice(0, 1) }))
    : reply(use('respond', { review: '1. Setup: added #87. 2. Arcs: none. 3. Size: none. 4. Focus: none.', answer: 'Here it is.',
        proposed_list: { name: 'John Stewart', entries: [{ type: 'event', event_id: 'ev-bn' }] } })));
  db.exec('ALTER TABLE event_issues ADD COLUMN volume_year INTEGER');   // as in the real schema
  const out = await a.converse({messages:[{role:'user',content:'Build me an essential John Stewart reading list'}], context:confirmed('Build me an essential John Stewart reading list'), userId:'admin'});
  const props = Object.keys(calls[0].tools.find(t => t.name === 'respond').input_schema.properties);
  assert.equal(props[0], 'review', 'the review is written before the answer and the list');
  const first = JSON.parse(calls[1].messages.at(-1).content[0].content);
  assert.match(first.review_before_respond, /Setup.*Arcs.*Size.*Focus/);
  const second = JSON.parse(calls[2].messages.at(-1).content[0].content);
  assert.equal(second.review_before_respond, undefined, 'only once per question');
  assert.doesNotMatch(out.reply.content || out.reply.answer || '', /Setup: added/);
});

test('Quick and short checks do not get the checklist', async () => {
  const { a, calls, db } = setup((body, n) => n === 1 ? reply(use('check_list', { items: [{ series: 'Green Lantern', issue_start: '87' }] }))
    : reply(use('respond', { answer: 'You own it.' })));
  db.exec('ALTER TABLE event_issues ADD COLUMN volume_year INTEGER');
  await ask(a, 'Do I own Green Lantern #87?');
  const res = JSON.parse(calls[1].messages.at(-1).content[0].content);
  assert.equal(res.error, undefined);
  assert.equal(res.review_before_respond, undefined);
});

test('a short new list (under 4 entries) still gets the checklist, with issue counting and crossovers', async () => {
  const { a, calls, db } = setup((body, n) => n === 1 ? reply(use('check_list', { items: [{ series: 'Green Lantern', issue_start: '87' }, { series: 'Green Lantern: Mosaic', issue_start: '1', issue_end: '18' }] }))
    : reply(use('respond', { review: 'Size: 19 issues.', answer: 'Here.', proposed_list: { name: 'x', entries: [{ type: 'event', event_id: 'ev-bn' }] } })));
  db.exec('ALTER TABLE event_issues ADD COLUMN volume_year INTEGER');
  await a.converse({messages:[{role:'user',content:'Build me a short John Stewart reading list'}], context:confirmed('Build me a short John Stewart reading list'), userId:'admin'});
  const res = JSON.parse(calls[1].messages.at(-1).content[0].content);
  assert.match(res.review_before_respond, /count the actual comic issues/);
  assert.match(res.review_before_respond, /other series/);
  assert.match(res.review_before_respond, /removals as well as additions/);
  assert.match(JSON.stringify(calls[0].system), /Measure length in ISSUES, not entries/);
});

test('web searches share one budget per question across calls', async () => {
  const web = (n, ...content) => ({ content, stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: n } } });
  const { a, calls, db } = setup((body, n) => n === 1 ? web(2, use('check_list', { items: [{ series: 'Green Lantern', issue_start: '87' }] }))
    : n === 2 ? web(1, use('check_list', { items: [{ series: 'Green Lantern', issue_start: '88' }] }))
    : reply(use('respond', { review: 'Size: 2 issues.', answer: 'Here.', proposed_list: { name: 'x', entries: [{ type: 'event', event_id: 'ev-bn' }] } })));
  db.exec('ALTER TABLE event_issues ADD COLUMN volume_year INTEGER');
  const out = await a.converse({messages:[{role:'user',content:'Build me a John Stewart reading list'}], context:confirmed('Build me a John Stewart reading list'), userId:'admin'});
  const webTool = body => body.tools.find(t => t.type === 'web_search_20250305');
  assert.equal(webTool(calls[0]).max_uses, 3, 'full budget on the first generator call');
  assert.equal(webTool(calls[1]).max_uses, 1, 'only what is left after 2 searches');
  assert.ok(webTool(calls[2]), 'kept listed so earlier results stay readable');
  assert.match(JSON.stringify(calls[2].messages.at(-1).content), /budget for this question is spent \(3 of 3\)/);
  assert.match(JSON.stringify(calls[0].system), /at most 3 searches per question/);
  assert.equal(out.usage.web_searches, 3);
});

test('OpenAI gets the search budget as max_tool_calls and a low search size; Claude never sees the OpenAI option', () => {
  const { toOpenAI, anthropicSafe } = require('./openaiAdapter');
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2, openai_search_context: 'low' }];
  const req = toOpenAI({ model: 'openai:gpt-6-astra', max_tokens: 100, tools, messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(req.tools[0], { type: 'web_search', search_context_size: 'low' });
  assert.equal(req.max_tool_calls, 2);
  const plain = toOpenAI({ model: 'openai:gpt-6-astra', max_tokens: 100, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }], messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(plain.tools[0], { type: 'web_search' }, 'Timeline generation keeps the default size');
  const safe = anthropicSafe({ model: 'claude-opus-5-5', tools, messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(safe.tools[0], { type: 'web_search_20250305', name: 'web_search', max_uses: 2 });
});


// ── Selection setup (BOXES_UNIFIED_PLAN.md stage 3; stock options from LIST_INTAKE_DESIGN.md) ──
const selectionSetup = require('./selectionSetup');
const keys = form => form.fields.map(f => f.key);

test('Quick asks with ask_reader: the turn ends, the reply carries the form, no list, no defaults', async () => {
  const { a, calls } = setup((body, n) => n === 1 ? reply(use('search_reading_lists', { query: 'John Stewart' }))
    : reply(use('ask_reader', { kind: 'character', subject: 'John Stewart', message: 'An "essential" list. Essential to WHOM? Tell me what you are after.' })));
  const out = await ask(a, 'Give me an essential John Stewart reading list');
  assert.equal(out.route, 'quick');
  assert.equal(calls.length, 2, 'no generator call');
  const form = out.reply.selection_setup;
  assert.deepEqual(keys(form), ['format', 'availability', 'size', 'priority', 'start']);
  assert.deepEqual(form.fields.find(f => f.key === 'priority').choices.map(c => c[0]), ['best', 'journey', 'history']);
  assert.match(form.fields.find(f => f.key === 'priority').choices[1][2], /John Stewart's defining moments/);
  assert.deepEqual(form.values, {});
  assert.match(out.reply.answer, /Essential to WHOM/);
  assert.equal(out.reply.proposed_list, null);
  const sys = JSON.stringify(calls[0].system);
  assert.match(sys, /BEFORE YOU BUILD ANYTHING NEW/);
  assert.match(sys, /SAVED READING ORDERS FIRST/);
});

test('questions about reading orders reach Quick (no form without a model call); a list edit stays an edit', async () => {
  for (const q of ['Is there a reading order for Blackest Night?', 'What are the best Batman stories?', 'Where does Year One fit in the reading order?']) {
    const { a, calls } = setup(() => reply(use('respond', { answer: 'Here is what I know.' })));
    const out = await ask(a, q);
    assert.equal(calls[0].model, 'quick', q);
    assert.ok(!out.reply.selection_setup, q);
  }
  const { a, calls } = setup(() => reply(use('respond', { answer: 'Added.' })));
  const out = await a.converse({ messages: [{ role: 'user', content: 'Add Final Night to this reading list' }], context: { page: 'reading_list', listId: 1 }, userId: 'admin' });
  assert.equal(calls[0].model, 'gen');
  assert.equal(out.route, 'reading_list');
  assert.ok(!out.reply.selection_setup);
});

test('on a list page, a request for something new opens the form; the form sent from there builds new, not edits', async () => {
  let s = setup(() => reply(use('ask_reader', { kind: 'theme', subject: 'sci-fi', message: 'Sci-fi. Now we are talking.' })));
  let out = await s.a.converse({ messages: [{ role: 'user', content: 'im interested in some good sci-fi comics' }], context: { page: 'reading_list', listId: 1 }, userId: 'admin' });
  assert.equal(s.calls[0].model, 'gen');
  assert.ok(toolNames(s.calls[0]).includes('ask_reader') && !toolNames(s.calls[0]).includes('hand_off'));
  assert.match(JSON.stringify(s.calls[0].messages), /something new that is not a change to this list/);
  assert.equal(out.reply.selection_setup.subject, 'sci-fi');
  assert.equal(out.reply.answer, 'Sci-fi. Now we are talking.');
  assert.equal(out.reply.proposed_list, null);
  s = setup(() => reply(use('respond', { answer: 'Here.', proposed_list: { name: 'Hal', entries: [{ type: 'event', event_id: 'ev-bn' }] } })));
  out = await s.a.converse({ messages: [{ role: 'user', content: 'Build it.' }], context: { page: 'reading_list', listId: 1, ...confirmed('Hal Jordan', 'order', { saved: [{ type: 'event', id: 'ev-bn' }] }) }, userId: 'admin' });
  assert.equal(out.route, 'setup → reading_list');
  assert.match(JSON.stringify(s.calls[0].messages), /READER'S BRIEF/);
  assert.ok(!toolNames(s.calls[0]).includes('ask_reader'));
  assert.equal(out.reply.target_list, null);
  assert.notEqual(out.reply.proposed_list?.mode, 'edit');
  assert.equal(out.reply.proposed_list.entries.length, 1);
});

test('a reading order from the form: the brief, the start and notes reach the generator; Built for lists the alternatives', async () => {
  const { a, calls } = setup(() => reply(use('respond', { answer: 'Here.', proposed_list: { name: 'John Stewart', description: 'Greatest hits.', entries: [{ type: 'event', event_id: 'ev-bn' }] } })));
  const ctx = confirmed('John Stewart', 'order', { start: 'specific', startDetail: 'Mosaic', notes: 'No alternate universes', saved: [{ type: 'event', id: 'ev-bn', name: 'Blackest Night' }] });
  const out = await a.converse({ messages: [{ role: 'user', content: 'Build it.' }], context: ctx, userId: 'admin' });
  const first = JSON.stringify(calls[0].messages);
  assert.match(first, /READER'S BRIEF/);
  assert.match(first, /Built for: Best stories/);
  assert.match(first, /How chosen: the reader chose it/);
  assert.match(first, /Reader notes: Begin at: Mosaic\. No alternate universes/);
  assert.equal(out.reply.brief.option.id, 'best');
  assert.deepEqual(out.reply.brief.alternatives.map(o => o.id), ['journey', 'history']);
  assert.match(out.reply.brief.notes, /Mosaic/);
  assert.match(out.reply.proposed_list.description, /^Built for: Best stories\. Greatest hits\./);
});

test('"go" after the form picks nothing: it goes to Quick like any message', async () => {
  const form = selectionSetup.form({ kind: 'character', subject: 'John Stewart' });
  const { a, calls } = setup(() => reply(use('respond', { answer: 'Pick from the choices, peasant.' })));
  const out = await a.converse({ messages: [{ role: 'user', content: 'a John Stewart list' }, { role: 'assistant', content: 'Which?', selection_setup: form }, { role: 'user', content: 'go' }], context: {}, userId: 'admin' });
  assert.deepEqual(calls.map(c => c.model), ['quick']);
  assert.equal(out.reply.brief, null);
});

test('a box from the form: Long Answers, no list; only verified series are offered, under a topic name', async () => {
  const { a, calls, db } = setup((body, n) => n === 1 ? reply(use('library_search', { query: 'horror' })) : reply(use('respond', { answer: 'A horror series.', proposed_list: { name: 'x', entries: [{ type: 'event', event_id: 'ev-bn' }] },
    refs: [{ type: 'series', id: 'ss_horror', label: 'Horror' }, { type: 'series', id: 'invented', label: 'Fake' }, { type: 'event', id: 'ev-bn', label: 'Blackest Night' }] })));
  db.exec("INSERT INTO scanned_series(id,name,year) VALUES('ss_horror','Horror',2020)");
  const out = await a.converse({ messages: [{ role: 'user', content: 'Build it.' }], context: confirmed('cosmic horror', 'box', { kind: 'theme', size: 'full' }), userId: 'admin' });
  assert.equal(out.route, 'setup → box');
  assert.equal(calls[0].model, 'long');
  assert.match(JSON.stringify(calls[0].messages), /A box of series about: cosmic horror[\s\S]*a full box, about 25 series[\s\S]*Only series in Omnibus/);
  assert.equal(out.reply.proposed_box.name, 'Cosmic Horror');
  assert.deepEqual(out.reply.proposed_box.series.map(s => s.id), ['ss_horror']);
  assert.deepEqual(out.reply.proposed_box.missing, [], 'library only: no missing series');
  const props = Object.keys(calls.at(-1).tools.find(t => t.name === 'respond').input_schema.properties);
  assert.ok(props.includes('box_series') && !props.includes('missing_series') && !props.includes('proposed_list'));
  assert.equal(out.reply.proposed_list, null);
});

test('a box with missing series: box_series and missing_series; a "missing" one the library has joins the box', async () => {
  const { a, calls, db } = setup((body, n) => n === 1 ? reply(use('library_search', { query: 'horror' })) : reply(use('respond', { answer: 'Highlights: Harrow County.',
    box_series: [{ id: 'ss_horror', label: 'Horror' }, { id: 'invented', label: 'Fake' }],
    missing_series: [{ name: 'Harrow County', start_year: 2015, publisher: 'Dark Horse', reason: 'Southern gothic.' }, { name: 'harrow county', start_year: 2015 },
      { name: 'The Woods', start_year: 2014, reason: 'Actually here.' }, { name: '' }] })));
  db.exec("INSERT INTO scanned_series(id,name,year) VALUES('ss_horror','Horror',2020), ('ss_woods','The Woods',2014)");
  const out = await a.converse({ messages: [{ role: 'user', content: 'Build it.' }], context: confirmed('horror', 'box', { kind: 'theme', size: 'short', availability: 'missing' }), userId: 'admin' });
  assert.ok(Object.keys(calls.at(-1).tools.find(t => t.name === 'respond').input_schema.properties).includes('missing_series'));
  assert.match(JSON.stringify(calls[0].messages), /missing_series/);
  assert.deepEqual(out.reply.proposed_box.series.map(s => s.id), ['ss_horror', 'ss_woods']);
  assert.deepEqual(out.reply.proposed_box.missing, [{ name: 'Harrow County', start_year: 2015, publisher: 'Dark Horse', reason: 'Southern gothic.' }]);
});

test('a theme skips "what matters most"; ask_reader can preselect the format the reader named', async () => {
  const { a } = setup(() => reply(use('ask_reader', { kind: 'theme', subject: 'cosmic horror', format: 'box', message: 'Cosmic horror. Finally, taste.' })));
  const out = await ask(a, 'Make me a box of cosmic horror comics');
  assert.deepEqual(keys(out.reply.selection_setup), ['format', 'availability', 'size']);
  assert.deepEqual(out.reply.selection_setup.values, { format: 'box' });
});

test('a line: Quick answers and offers the line choices; a malformed custom question gets an error and a retry', async () => {
  let s = setup(() => reply(use('ask_reader', { kind: 'line', subject: 'Absolute Universe', message: 'There is no reading order. Each series stands alone. Still, if you insist, I can build you one.' })));
  let out = await ask(s.a, 'What is the reading order for the Absolute Universe?');
  assert.deepEqual(out.reply.selection_setup.fields.find(f => f.key === 'priority').choices.map(c => c[1]), ['Try each series', 'The best of the line', 'Follow the whole line']);
  assert.ok(!keys(out.reply.selection_setup).includes('start'), 'a line has no starting-point question');
  assert.match(JSON.stringify(s.calls[0].system), /push back on it, in voice/);
  s = setup((body, n) => n === 1 ? reply(use('ask_reader', { kind: 'custom', subject: 'Something good', message: 'Taste?', options: ['Only one'] }))
    : reply(use('ask_reader', { kind: 'custom', subject: 'Something good', message: 'What have you liked?', options: ['Superheroes', 'Horror', 'Crime'] })));
  out = await ask(s.a, 'Give me something good to read');
  assert.match(JSON.stringify(s.calls[1].messages.at(-1).content), /2-4 options/);
  assert.deepEqual(out.reply.selection_setup.fields.find(f => f.key === 'priority').choices.map(c => c[1]), ['Superheroes', 'Horror', 'Crime']);
});

test('the rebuild buttons under a list: an explicit pick rebuilds with the reader\'s notes; typing does not', async () => {
  const brief = { kind: 'character', subject: 'John Stewart', option: { id: 'journey' }, saved: [], notes: 'Begin at: Mosaic.' };
  const msgs = t => [{ role: 'user', content: 'list' }, { role: 'assistant', content: 'Here.', list: ['Mosaic #1-18'], brief }, { role: 'user', content: t }];
  let s = setup(() => reply(use('respond', { answer: 'Rebuilt.', proposed_list: { name: 'x', entries: [{ type: 'section', label: 'A' }, { type: 'section', label: 'B' }] } })));
  let out = await s.a.converse({ messages: msgs('Rebuild it as Comprehensive history.'), context: { intake_answer: { option: 'history' } }, userId: 'admin' });
  assert.equal(out.route, 'rebuild → reading_list');
  assert.match(JSON.stringify(s.calls[0].messages), /Built for: Comprehensive history[\s\S]*Begin at: Mosaic/);
  s = setup(() => reply(use('respond', { answer: 'Fine.' })));
  out = await s.a.converse({ messages: msgs('what is the best Mosaic issue?'), context: {}, userId: 'admin' });
  assert.notEqual(out.route, 'rebuild → reading_list');
});

test('validation: every shown question needs an answer; a particular start needs its detail; bad kinds are refused', () => {
  const b = confirmed('Hal Jordan').selection_setup;
  assert.ok(selectionSetup.validate(b));
  assert.equal(selectionSetup.validate({ ...b, priority: undefined }), null);
  assert.equal(selectionSetup.validate({ ...b, priority: 'invented' }), null);
  assert.equal(selectionSetup.validate({ ...b, start: 'specific' }), null);
  assert.ok(selectionSetup.validate({ ...b, start: 'specific', startDetail: 'Rebirth' }));
  assert.ok(selectionSetup.validate({ kind: 'character', subject: 'Hal Jordan', format: 'box', availability: 'missing', size: 'short' }), 'a box needs no priority or start');
  assert.equal(selectionSetup.validate({ kind: 'character', subject: 'Hal Jordan', format: 'box', availability: 'missing' }), null, 'a box needs its size');
  assert.equal(selectionSetup.validate({ kind: 'character', subject: 'Hal Jordan', format: 'box' }), null);
  assert.equal(selectionSetup.validate({ ...b, kind: 'nonsense' }), null);
  assert.equal(selectionSetup.validate({ ...b, format: 'recommendations' }), null);
});

test('web_lookup: the first stop (any model) asks one plain question; a second is refused; sources are kept', async () => {
  const lookups = [];
  const { a, calls } = setup((body, n) => n === 1 ? reply(use('web_lookup', { question: 'When did Lois Lane first get superpowers?' }))
    : n === 2 ? reply(use('web_lookup', { question: 'again?' }))
    : reply(use('respond', { answer: 'Action Comics #156 (1951).' })));
  const out0 = await (async () => {
    // aiComplete is a dependency: add it to this assistant (setup has none by default).
    const { a: withLookup, calls: c2 } = setup((body, n) => n === 1 ? reply(use('web_lookup', { question: 'When did Lois Lane first get superpowers?' }))
      : n === 2 ? reply(use('web_lookup', { question: 'again?' }))
      : reply(use('respond', { answer: 'Action Comics #156 (1951).' })), {
      aiComplete: async opts => { lookups.push(opts); return { model: 'gemini:gemini-3.5-flash-lite', text: 'Action Comics #156 (1951).', usage: { input_tokens: 100, output_tokens: 50 },
        data: { content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://www.dc.com/blog/x?utm_source=g', title: 'DC' }] }] } }; } });
    const out = await ask(withLookup, 'when did lois lane get powers?');
    return { out, c2 };
  })();
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].task, 'web_lookup');
  assert.match(lookups[0].prompt, /Lois Lane/);
  assert.ok(toolNames(out0.c2[0]).includes('web_lookup'));
  assert.ok(!toolNames(out0.c2[0]).includes('web_search'));
  assert.match(out0.c2[1].messages.at(-1).content[0].content, /Action Comics #156[\s\S]*dc\.com\/blog\/x/);
  assert.match(out0.c2[2].messages.at(-1).content[0].content, /one web lookup for this question is used/);
  // Without aiComplete (or for other roles) the tool is not offered.
  await ask(a, 'when did lois lane get powers?');
  assert.ok(!toolNames(calls[0]).includes('web_lookup'));
});

test('page guides: every page the bubble can name has a guide; admin lines only for admins', () => {
  const { a } = setup(() => reply());
  const { guideFor, PAGE_GUIDES } = a._internal;
  const pages = ['home', 'series_index', 'series', 'collections', 'collection', 'top_shelf', 'top_shelf_category', 'canon_run', 'timeline', 'event',
    'essentials', 'reading_lists', 'reading_list', 'editor', 'reader', 'search', 'my_requests', 'appearance'];
  for (const p of pages) assert.ok(PAGE_GUIDES[p] && PAGE_GUIDES[p].length > 80, `no guide for ${p}`);
  for (const label of ['Offline', 'Downloads', 'Settings', 'Library']) assert.ok(PAGE_GUIDES[`other_${label.toLowerCase()}`], `no guide for ${label}`);
  const user = guideFor({ page: 'essentials' }, false), admin = guideFor({ page: 'essentials' }, true);
  assert.ok(!/\[admin\]|New Essential/.test(user));
  assert.ok(/New Essential/.test(admin) && !/\[admin\]/.test(admin));
  assert.ok(!/Settings: Libraries/.test(guideFor({ page: 'other', label: 'Settings' }, false)));   // admin-only page: nothing for users
  assert.ok(/Continue Reading/.test(guideFor({ page: 'home' }, false)));
});

