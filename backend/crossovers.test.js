'use strict';
// Crossover links (crossovers.js, crossoverText.js; claude/CROSSOVERS.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const T = require('./crossoverText');
const C = require('./crossovers');

const mentions = s => T.summaryMentions(`<Summary>${s}</Summary>`).map(m => `${m.tail || m.series} #${m.issue}`);

test('summary phrases that name the next or previous part', () => {
  assert.deepEqual(mentions('Part 6 continues in Detective Comics #661.'), ['Detective Comics #661']);
  assert.deepEqual(mentions('part 3, continued from VALOR #22'), ['VALOR #22']);
  assert.deepEqual(mentions('Continued in DETECTIVE COMICS (1937-2011) #735'), ['DETECTIVE COMICS #735']);
  assert.deepEqual(mentions('Continued from: Adventures of Superman #537'), ['Adventures of Superman #537']);
  assert.deepEqual(mentions('Continues in this month&amp;#8217;s JUSTICE LEAGUE UNITED: FUTURES END #1'), ['JUSTICE LEAGUE UNITED: FUTURES END #1']);
  assert.deepEqual(mentions("Continuing the story that started in December's HAWKGIRL #59"), ['HAWKGIRL #59']);
  assert.deepEqual(mentions("continues from Aquaman's series in Adventure Comics #478"), ['Adventure Comics #478']);
  assert.deepEqual(mentions("Don't miss the conclusion in Batman #5!"), ['Batman #5']);
});

test('summary phrases that are not a story continuing', () => {
  assert.deepEqual(mentions("don't miss a free preview of this title in August's JACK OF FABLES #37"), []);
  assert.deepEqual(mentions('continues from the previews issue, Firefly #20'), []);   // the name must start with a capital
  assert.deepEqual(mentions('Batman fights the Joker in Gotham. Superman #4 is out now.'), []);
});

test('a page names an issue in the usual ways, and not a different number', () => {
  const p = { series: 'Green Lantern Corps', issue: '22' };
  assert.ok(T.namedOnPage('Read Green Lantern Corps #22 next', p));
  assert.ok(T.namedOnPage('Green Lantern Corps (2025) #22', p));
  assert.ok(T.namedOnPage('Green_Lantern_Corps_Vol_5_22', p));
  assert.ok(!T.namedOnPage('Green Lantern Corps #220', p));
  assert.ok(!T.namedOnPage('Green Lantern #22', p));
});

test('proven links: one page must name both neighbouring parts; same-series neighbours are not links', () => {
  const stories = [{ name: 'First Light', parts: [
    { series: 'Green Lantern', issue: '40' }, { series: 'Green Lantern Corps', issue: '21' }, { series: 'Green Lantern Corps', issue: '22' }] }];
  // Page A names GL #40 and Corps #22 (the wrongly added #21 does not hide the link); page B names only one.
  const links = C.provenLinks(stories, [{ url: 'a', text: 'Green Lantern #40 then Green Lantern Corps #22' }, { url: 'b', text: 'Green Lantern Corps #21' }]);
  assert.deepEqual(links.map(l => `${l.from.series} #${l.from.issue} > ${l.to.series} #${l.to.issue} @${l.page}`), ['Green Lantern #40 > Green Lantern Corps #22 @a']);
  assert.deepEqual(C.provenLinks(stories, [{ url: 'x', text: 'Green Lantern #40' }, { url: 'y', text: 'Green Lantern Corps #22' }]), []);
});

// ── A small library ───────────────────────────────────────────────────
function library() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, issue_number TEXT, comicinfo TEXT, store_date TEXT, cv_issue_id TEXT, is_special INTEGER DEFAULT 0, title TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT, draft INTEGER DEFAULT 0);
    CREATE TABLE event_issues (id INTEGER PRIMARY KEY, event_id TEXT, scanned_book_id TEXT, series_name TEXT, issue_number TEXT);`);
  const series = (id, name, year) => db.prepare('INSERT INTO scanned_series VALUES (?,?,?)').run(id, name, year);
  const book = (id, sid, n, date, { ci = null, summary = '' } = {}) => db.prepare('INSERT INTO scanned_books (id, series_id, issue_number, comicinfo, store_date, cv_issue_id) VALUES (?,?,?,?,?,?)')
    .run(id, sid, n, `<ComicInfo>${ci ? `<Series>${ci}</Series>` : ''}<Summary>${summary}</Summary></ComicInfo>`, date, `cv-${id}`);
  series('gl', 'Green Lantern', 2023); series('glc', 'Green Lantern Corps', 2025); series('bat', 'Batman', 2025);
  series('cw', 'Absolute Catwoman', 2026); series('cc', "Absolute Cassandra Cain: The Shadow's Hand", 2026); series('sup', 'Superman', 1987); series('act', 'Action Comics', 1938);
  book('gl40', 'gl', '40', '2026-10-28'); book('glc22', 'glc', '22', '2026-11-11');
  book('bat1', 'bat', '1', '2025-09-03');
  book('sunset', 'bat', '1', '2026-08-26', { ci: 'Batman: Bad Seeds - Sunset' });   // a one-shot on the Batman shelf
  book('cw1', 'cw', '1', '2026-06-10'); book('cw3', 'cw', '3', '2026-08-26'); book('cw4', 'cw', '4', '2026-11-04'); book('cc1', 'cc', '1', '2026-09-16');
  book('sup50', 'sup', '50', '1990-12-04', { summary: 'Part 2 continues in Action Comics #660.' });
  book('act660', 'act', '660', '1990-12-18', { summary: 'Continued from Superman #50.' });
  book('act1', 'act', '1', '1938-04-18', { summary: 'Continued in Superman #50' });   // decades apart: no link
  const settings = new Map([['crossover_ai_enabled', '1']]);   // most tests use web links; the switch tests set their own
  const app = { routes: {}, get(p, ...f) { this.routes[`GET ${p}`] = f.at(-1); }, post(p, ...f) { this.routes[`POST ${p}`] = f.at(-1); } };
  return { db, app, settings };
}
const quiet = { info() {}, warn() {}, error() {} };
function create(lib, over = {}) {
  return C.createCrossovers({ app: lib.app, db: lib.db, ai: {}, webLookup: {}, readPage: async () => ({}), axios: {}, cron: { schedule() {} },
    getSetting: k => lib.settings.get(k) ?? null, setSetting: (k, v) => lib.settings.set(k, v), logger: quiet, requireAuth: () => {}, requireAdmin: () => {},
    sequence: () => [], modelCatalog: { estimateCost: () => 0.0004 }, ...over });
}
const names = list => list.map(x => `${x.series_name} #${x.issue_number}${x.owned ? '' : ' (missing)'}`);

test('a module without everything it needs refuses to start', () => {
  assert.throws(() => C.createCrossovers({}), /createCrossovers: missing /);
});

test('summary links: both ways, ordered by release date; not across decades', () => {
  const lib = library(), x = create(lib);
  const r = x.refreshFree();
  assert.equal(r.summary, 1);   // Superman #50 ⇄ Action #660 stated twice, stored once
  assert.deepEqual(names(x.forBook('sup50').continuesIn), ['Action Comics #660']);
  assert.deepEqual(names(x.forBook('act660').continuedFrom), ['Superman #50']);
  assert.deepEqual(x.forBook('act1'), { continuesIn: [], continuedFrom: [] });
});

test('a named issue is matched by the book\'s own series name, not the shelf it sits on', () => {
  const lib = library();
  create(lib);
  const L = C.loadLibrary(lib.db);
  const row = C.linkRow(L, { story: 'Bad Seeds', from: { series: 'Poison Ivy', issue: '48' }, to: { series: 'Batman', issue: '1' }, page: 'p' }, '2026-09-30');
  assert.equal(row, null);   // Batman (2025) #1 is a year earlier; the one-shot is "Batman: Bad Seeds - Sunset"
  const row2 = C.linkRow(L, { story: 'Bad Seeds', from: { series: 'Batman: Bad Seeds - Sunset', issue: '1' }, to: { series: 'Batman', issue: '13' }, page: 'p' }, '2026-08-26');
  assert.equal(row2.from.id, 'sunset');
  assert.equal(row2.to, null);
  assert.equal(row2.toName.series, 'Batman');
});

function addWeb(x, lib, links) {
  const L = C.loadLibrary(lib.db);
  const ins = lib.db.prepare(`INSERT INTO crossover_links (key, from_book_id, from_series, from_issue, to_book_id, to_series, to_issue, story, source, proof, found_at)
    VALUES (?,?,?,?,?,?,?,?,'web','p',0)`);
  for (const [a, b, story, anchor] of links) {
    const r = C.linkRow(L, { story, from: a, to: b, page: 'p' }, anchor);
    assert.ok(r, `${a.series} #${a.issue} > ${b.series} #${b.issue}`);
    ins.run(r.key, r.from?.id || null, r.from ? r.from.series : r.fromName.series, r.from ? r.from.issue_number : r.fromName.issue,
      r.to?.id || null, r.to ? r.to.series : r.toName.series, r.to ? r.to.issue_number : r.toName.issue, story);
  }
}

test('each issue keeps its nearest link: a collection page\'s Catwoman #1 → Cassandra Cain #1 is not shown', () => {
  const lib = library(), x = create(lib);
  const cw = n => ({ series: 'Absolute Catwoman', issue: n }), cc = { series: "Absolute Cassandra Cain: The Shadow's Hand", issue: '1' };
  addWeb(x, lib, [[cw('1'), cc, 'The Yarn', '2026-09-16'], [cw('3'), cc, 'The Yarn', '2026-09-16'], [cc, cw('4'), 'The Yarn', '2026-09-16']]);
  assert.deepEqual(names(x.forBook('cc1').continuedFrom), ['Absolute Catwoman #3']);
  assert.deepEqual(names(x.forBook('cc1').continuesIn), ['Absolute Catwoman #4']);
  assert.deepEqual(x.forBook('cw1').continuesIn, []);
  assert.deepEqual(names(x.forBook('cw3').continuesIn), ["Absolute Cassandra Cain: The Shadow's Hand #1"]);
});

test('not shown: books in the same Timeline event, a missing issue the event lists, books the reading order already joins', () => {
  const lib = library();
  let joined = false;
  const x = create(lib, { sequence: id => (joined && id === 'gl' ? ['gl40', 'glc22'] : []) });
  addWeb(x, lib, [[{ series: 'Green Lantern', issue: '40' }, { series: 'Green Lantern Corps', issue: '22' }, 'First Light', '2026-10-28'],
    [{ series: 'Green Lantern Corps', issue: '22' }, { series: 'Green Lantern', issue: '41' }, 'First Light', '2026-11-11']]);
  assert.deepEqual(names(x.forBook('gl40').continuesIn), ['Green Lantern Corps #22']);
  assert.deepEqual(names(x.forBook('glc22').continuesIn), ['Green Lantern #41 (missing)']);
  assert.deepEqual(x.nextFor('gl40').id, 'glc22');
  joined = true;
  assert.deepEqual(x.forBook('gl40').continuesIn, []);
  joined = false;
  lib.db.exec(`INSERT INTO events VALUES ('e1', 'Green Lantern: First Light', 0);
    INSERT INTO event_issues (event_id, scanned_book_id, series_name, issue_number) VALUES ('e1', 'gl40', 'Green Lantern', '40'), ('e1', 'glc22', 'Green Lantern Corps', '22')`);
  assert.deepEqual(x.forBook('gl40').continuesIn, []);
  assert.deepEqual(x.forBook('glc22').continuesIn, []);   // GL #41 is not owned, but the story is the event's
  lib.db.exec(`UPDATE events SET draft = 1`);
  assert.deepEqual(names(x.forBook('gl40').continuesIn), ['Green Lantern Corps #22']);
});

test('a missing issue gets its book when it arrives; a hidden link stays hidden', () => {
  const lib = library(), x = create(lib);
  addWeb(x, lib, [[{ series: 'Green Lantern Corps', issue: '22' }, { series: 'Green Lantern', issue: '41' }, 'First Light', '2026-11-11']]);
  lib.db.prepare('INSERT INTO scanned_books (id, series_id, issue_number, comicinfo, store_date) VALUES (?,?,?,?,?)').run('gl41', 'gl', '41', '<ComicInfo/>', '2026-11-25');
  assert.equal(x.refreshFree().resolved, 1);
  const next = x.nextFor('glc22');
  assert.equal(next.id, 'gl41');
  lib.app.routes['POST /api/admin/crossovers/hide']({ body: { ids: next.linkIds } }, { json() {}, status() { return this; } });
  assert.equal(x.nextFor('glc22'), null);
});

test('a web check run: asks about new issues only, keeps page-proven links, records each issue and its cost', async () => {
  const lib = library();
  const asked = [];
  const webLookup = { lookup: async q => { asked.push(q); return { grounded: true, cost: 0.0007, notes: 'notes', sources: [{ url: 'https://example.com/first-light' }] }; } };
  const ai = { complete: async () => ({ model: 'claude-haiku-5-5', usage: {}, text: JSON.stringify({ stories: [{ name: 'First Light', parts: [
    { series: 'Green Lantern', year: 2023, issue: '40' }, { series: 'Green Lantern Corps', year: 2025, issue: '22' }] }] }) }) };
  const readPage = async url => ({ url, text: 'Green Lantern #40 leads into Green Lantern Corps #22.' });
  const x = create(lib, { webLookup, ai, readPage });
  lib.db.prepare(`UPDATE scanned_books SET store_date = date('now', '-400 days') WHERE id NOT IN ('gl40', 'glc22')`).run();
  lib.db.prepare(`UPDATE scanned_books SET store_date = date('now', '-20 days') WHERE id = 'gl40'`).run();
  lib.db.prepare(`UPDATE scanned_books SET store_date = date('now', '-6 days') WHERE id = 'glc22'`).run();
  assert.equal(x.status().pending, 2);
  await x.run('manual');
  while (x.state.running) await new Promise(r => setTimeout(r, 5));
  assert.equal(asked.length, 2);
  assert.match(asked[0], /Green Lantern \(2023\) #40 \(released \d{4}-\d{2}-\d{2}/);
  assert.equal(x.nextFor('gl40').id, 'glc22');
  const s = x.status();
  assert.equal(s.pending, 0);
  assert.equal(s.links.web, 1);
  assert.equal(s.checked, 2);
  assert.ok(Math.abs(s.spent - 2 * 0.0011) < 1e-9);
  assert.ok(lib.settings.get('crossover_check_last_run'));
});

test('schedule: off by default; weekly is due a week after the last run', () => {
  const lib = library(), x = create(lib);
  assert.equal(x.status().frequency, 'off');
  assert.equal(x.due(), false);
  lib.settings.set('crossover_check_frequency', 'weekly');
  lib.settings.set('crossover_check_last_run', String(Date.now() - 3 * 86400000));
  assert.equal(x.due(), false);
  lib.settings.set('crossover_check_last_run', String(Date.now() - 7 * 86400000));
  assert.equal(x.due(), true);
});

test('two switches: code and AI each hide their own links and stop their own work', async () => {
  const lib = library(), x = create(lib);
  x.refreshFree();
  addWeb(x, lib, [[{ series: 'Green Lantern', issue: '40' }, { series: 'Green Lantern Corps', issue: '22' }, 'First Light', '2026-10-28']]);
  lib.settings.set('crossover_check_frequency', 'weekly');
  lib.settings.set('crossover_check_last_run', String(Date.now() - 8 * 86400000));
  let out = null;
  const res = { json(d) { out = d; }, status(c) { this.code = c; return this; } };
  const flip = body => lib.app.routes['POST /api/admin/crossovers/switches']({ body }, res);
  assert.equal(x.nextFor('sup50').id, 'act660');   // code (summary)
  assert.equal(x.nextFor('gl40').id, 'glc22');     // AI (web)
  flip({ ai: false });
  assert.deepEqual([out.code, out.ai], [true, false]);
  assert.equal(x.nextFor('gl40'), null);
  assert.equal(x.nextFor('sup50').id, 'act660');
  assert.equal(x.due(), false);
  await assert.rejects(x.run('manual'), /web check is switched off/);
  flip({ code: false });
  assert.equal(x.nextFor('sup50'), null);
  assert.deepEqual(x.placementFor('sup'), []);
  flip({ ai: true });
  assert.equal(x.nextFor('gl40').id, 'glc22');
  assert.equal(x.due(), true);
  flip({ code: 'yes' });
  assert.equal(res.code, 400);
});

test('defaults: code on and AI off on a new install; the old single switch and an install already using web checks carry over', () => {
  const lib = library(), x = create(lib);
  lib.settings.delete('crossover_ai_enabled');
  assert.deepEqual([x.codeOn(), x.aiOn()], [true, false]);
  lib.settings.set('crossover_check_frequency', 'weekly');
  assert.equal(x.aiOn(), true);                                  // already scheduled before the switches
  lib.settings.set('crossover_links_enabled', '0');
  assert.deepEqual([x.codeOn(), x.aiOn()], [false, false]);       // the old switch was off
});

test('story titles link parts in different series: by part number, same publisher, 1–3 parts on, within 60 days', () => {
  const T2 = require('./crossoverText');
  assert.deepEqual(T2.storyParts('Rescue: The Siege of the Zi Charam, Part 2').map(p => [p.keys, p.part]), [[['rescuethesiegeofthezicharam', 'siegeofthezicharam'], 2]]);
  assert.deepEqual(T2.storyParts('Three of A Kind Part 3; Death at the Top of the World').map(p => p.part), [3]);
  assert.deepEqual(T2.storyParts('Chapter One: The Gathering'), []);            // no story name
  assert.deepEqual(T2.summaryParts('&quot;Black Circle: Urban Knights&quot; Part 2 of 6. A mystery.').map(p => [p.story, p.part]), [['Black Circle: Urban Knights', 2]]);
  assert.deepEqual(T2.summaryParts('The Siege of the Zi Charam part 3 of 5.').map(p => p.part), [3]);
  assert.deepEqual(T2.summaryParts('Kyle is floating in space, part 3 of the plan'), []);
  const book = (id, series_id, store_date, title, publisher = 'DC Comics') => ({ id, series_id, store_date, title, ci_title: '', publisher, series: series_id, issue_number: '1' });
  const lib = { books: [
    book('nt124', 'nt', '1995-06-22', 'The Siege of the Zi Charam Part 1 of 5: Prometheus Gathering'),
    book('gl65', 'gl', '1995-06-27', 'Rescue: The Siege of the Zi Charam, Part 2', ''),          // no publisher: its series'
    book('gl64', 'gl', '1995-05-27', 'Older', 'DC Comics'),
    book('ds34', 'ds', '1995-07-06', 'Strangers in a Strange Land'),
    book('a1', 'a', '2016-06-01', 'Rebirth, Part 1'), book('b1', 'b', '2016-06-08', 'Rebirth, Part 1'),   // two series' own arcs
    book('m2', 'm', '1995-06-29', 'The Siege of the Zi Charam, Part 3', 'Marvel'),               // another publisher
  ] };
  const links = C.titleLinks(lib, new Map([['ds34', T2.summaryParts('The Siege of the Zi Charam part 3 of 5.')]]));
  assert.deepEqual(links.map(l => `${l.from.id}>${l.to.id}`), ['nt124>gl65', 'gl65>ds34']);
  assert.equal(links[0].story, 'The Siege of the Zi Charam');
});

test('a page naming an old issue the story looks back to is not a missing part (first web run, Swamp Thing #87 from 1989)', () => {
  const lib = library(), x = create(lib);
  const L = C.loadLibrary(lib.db);
  // Superman #50 (1990) is owned: named next to Green Lantern #40 (2026), it is an old issue, not a part.
  assert.equal(C.linkRow(L, { story: 'Time', from: { series: 'Superman', issue: '50' }, to: { series: 'Green Lantern', issue: '40' }, page: 'p' }, '2026-10-28'), null);
  assert.equal(C.linkRow(L, { story: 'Time', from: { series: 'Superman', year: 1987, issue: '50' }, to: { series: 'Green Lantern', issue: '40' }, page: 'p' }, '2026-10-28'), null);
  // Another volume's #50: a missing part of this story (Green Lantern (2023) #41 with Green Lantern (1990) #41 owned).
  const row = C.linkRow(L, { story: 'Time', from: { series: 'Superman', year: 2023, issue: '50' }, to: { series: 'Green Lantern', issue: '40' }, page: 'p' }, '2026-10-28');
  assert.equal(row.from, null);
  assert.equal(row.to.id, 'gl40');
  // A row stored before this rule: the nightly pass removes it.
  lib.db.prepare(`INSERT INTO crossover_links (key, from_book_id, from_series, from_issue, to_book_id, to_series, to_issue, story, source, found_at)
    VALUES ('w:old', NULL, 'Superman', '50', 'gl40', 'Green Lantern', '40', 'Time', 'web', 0)`).run();
  lib.db.prepare(`INSERT INTO crossover_links (key, from_book_id, from_series, from_issue, from_year, to_book_id, to_series, to_issue, story, source, found_at)
    VALUES ('w:new', NULL, 'Superman', '50', 2023, 'gl40', 'Green Lantern', '40', 'Time', 'web', 0)`).run();
  x.refreshFree();
  assert.deepEqual(lib.db.prepare(`SELECT key FROM crossover_links WHERE key LIKE 'w:%'`).all().map(r => r.key), ['w:new']);
});

test('a short story name hides a missing part only when it is the event\'s name ("DNX")', () => {
  const lib = library(), x = create(lib);
  lib.db.prepare(`INSERT INTO crossover_links (key, from_book_id, from_series, from_issue, to_book_id, to_series, to_issue, story, source, found_at)
    VALUES ('w:fcbd', NULL, 'Comics Giveaway Day 2026: Armageddon / X-Men', '1', 'gl40', 'Green Lantern', '40', 'DNX', 'web', 0)`).run();
  assert.deepEqual(names(x.forBook('gl40').continuedFrom), ['Comics Giveaway Day 2026: Armageddon / X-Men #1 (missing)']);
  lib.db.exec(`INSERT INTO events VALUES ('dnx', 'DNX', 0); INSERT INTO event_issues (event_id, scanned_book_id, series_name, issue_number) VALUES ('dnx', 'gl40', 'Green Lantern', '40')`);
  assert.deepEqual(x.forBook('gl40').continuedFrom, []);
  lib.db.exec(`UPDATE events SET name = 'DNX Aftermath'`);
  assert.equal(x.forBook('gl40').continuedFrom.length, 1);   // "DNX" is not "DNX Aftermath"
});

test('Reading order placements: the next part after its issue, an earlier part before its issue; none when off', () => {
  const lib = library(), x = create(lib);
  addWeb(x, lib, [[{ series: 'Green Lantern', issue: '40' }, { series: 'Green Lantern Corps', issue: '22' }, 'First Light', '2026-10-28']]);
  assert.deepEqual(x.placementFor('gl'), [{ bookId: 'glc22', afterBookId: 'gl40', story: 'First Light' }]);
  assert.deepEqual(x.placementFor('glc'), [{ bookId: 'gl40', beforeBookId: 'glc22', story: 'First Light' }]);
  lib.settings.set('crossover_ai_enabled', '0');                // web links: the AI switch
  assert.deepEqual(x.placementFor('gl'), []);
});
