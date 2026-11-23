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

test('first grid after restart resolves a saved Matriarch placeholder by its published issue', () => {
  const lib = library(), { db } = lib;
  C.schema(db);
  db.exec(`CREATE TABLE book_ci_index (book_id TEXT, series_name TEXT, volume_year INTEGER, orig_number TEXT, cv_issue_id TEXT);
    INSERT INTO scanned_series (id,name,year) VALUES ('ww','Wonder Woman',2023),('annual','Wonder Woman Annual',2026);
    INSERT INTO scanned_books (id,series_id,issue_number,store_date) VALUES
      ('ww37','ww','37','2026-09-16'), ('matriarch','annual','1','2026-09-30');
    INSERT INTO book_ci_index VALUES ('matriarch','Wonder Woman 2026 Annual: Wonder War - The Matriarch Special',2026,'1','1195410');
    INSERT INTO crossover_links (key,from_book_id,from_series,from_issue,to_series,to_issue,to_year,source,found_at)
      VALUES ('pending','ww37','Wonder Woman','37','Wonder Woman Annual: Wonder War - The Matriarch','1',2026,'web',0)`);
  for (let i = 0; i < 2; i++) {
    const x = create(lib);
    assert.deepEqual(x.placementFor('ww').map(row => row.bookId), ['matriarch']);
    assert.equal(x.missingRow(db.prepare("SELECT id FROM crossover_links WHERE key='pending'").get().id), null);
  }
});

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

test('only eligible continuations compete, and series orders are reused within one lookup', () => {
  const lib = library(), { db } = lib;
  const calls = new Map();
  let alreadyPlaced = [];
  const x = create(lib, { sequence: id => {
    calls.set(id, (calls.get(id) || 0) + 1);
    return id === 'cw' ? alreadyPlaced : [];
  } });
  const add = db.prepare("INSERT INTO crossover_links (key,from_book_id,from_series,from_issue,to_book_id,to_series,to_issue,source,found_at) VALUES (?,'cw3','Catwoman','3',?,'target','1','wiki',0)");
  add.run('near', 'cc1'); add.run('far', 'gl40');
  assert.equal(x.nextFor('cw3').id, 'cc1');
  alreadyPlaced = ['cc1'];
  calls.clear();
  assert.deepEqual(x.placementFor('cw').map(r => r.bookId), ['gl40']);
  assert.equal(Math.max(...calls.values()), 1);
  alreadyPlaced = [];
  db.exec("INSERT INTO events(id,name) VALUES ('ev','Event'); INSERT INTO event_issues(event_id,scanned_book_id) VALUES ('ev','cw3'),('ev','cc1')");
  assert.equal(x.nextFor('cw3').id, 'gl40');
  db.exec("DELETE FROM event_issues WHERE event_id='ev'");
  assert.equal(x.nextFor('cw3').id, 'cc1');
});

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
  lib.settings.set('crossover_check_frequency', 'daily');
  lib.settings.set('crossover_check_last_run', String(Date.now() - 24 * 3600000));
  assert.equal(x.due(), true);
  lib.settings.set('crossover_check_last_run', String(Date.now() - 2 * 3600000));
  assert.equal(x.due(), false);
  // An evening "Check now" (8.5 hours before the 4:35 run) does not hold Daily back a night.
  lib.settings.set('crossover_check_last_run', String(Date.now() - 8.5 * 3600000));
  assert.equal(x.due(), true);
  const next = new Date(x.status().nextRun);
  assert.deepEqual([next.getHours(), next.getMinutes()], [4, 35]);
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
    // Two stories with one name: Green Lantern #83–84 "Retribution, Part 1–2" and The Spectre #52 "Retribution, Part 1".
    book('gl83', 'gl', '1997-02-05', 'Retribution, Part 1 of 3'), book('gl84', 'gl', '1997-03-05', 'Retribution, Part 2'),
    book('sp52', 'sp', '1997-02-12', 'Retribution, Part 1'),
    // A "next part" released eight weeks before: not one story, even without a shared part number.
    book('x1', 'x', '1999-03-01', 'Lonely Road, Part 1'), book('y2', 'y', '1999-01-04', 'Lonely Road, Part 2'),
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
  const strip = list => list.map(({ chainDate, seq, ...rest }) => rest);
  assert.deepEqual(strip(x.placementFor('gl')), [{ bookId: 'glc22', afterBookId: 'gl40', story: 'First Light' }]);
  assert.deepEqual(strip(x.placementFor('glc')), [{ bookId: 'gl40', beforeBookId: 'glc22', story: 'First Light' }]);
  lib.settings.set('crossover_ai_enabled', '0');                // web links: the AI switch
  assert.deepEqual(x.placementFor('gl'), []);
});

test('Reading order follows the whole story through other series, in story order, until it comes back', () => {
  const lib = library(), x = create(lib);
  const add = lib.db.prepare('INSERT INTO scanned_books (id, series_id, issue_number, comicinfo, store_date, cv_issue_id) VALUES (?,?,?,?,?,?)');
  lib.db.prepare('INSERT INTO scanned_series VALUES (?,?,?)').run('nt', 'New Titans', 1988);
  lib.db.prepare('INSERT INTO scanned_series VALUES (?,?,?)').run('ds', 'Darkstars', 1992);
  lib.db.prepare('INSERT INTO scanned_series VALUES (?,?,?)').run('gg', 'Guy Gardner', 1992);
  add.run('nt124', 'nt', '124', '<ComicInfo/>', '1995-06-22', 'c1'); add.run('gl65', 'gl', '65', '<ComicInfo/>', '1995-06-27', 'c2');
  add.run('ds34', 'ds', '34', '<ComicInfo/>', '1995-07-06', 'c3'); add.run('gg33', 'gg', '33', '<ComicInfo/>', '1995-07-13', 'c4');
  add.run('nt125', 'nt', '125', '<ComicInfo/>', '1995-07-20', 'c5'); add.run('gl66', 'gl', '66', '<ComicInfo/>', '1995-07-27', 'c6');
  const ins = lib.db.prepare(`INSERT INTO crossover_links (key, from_book_id, from_series, from_issue, to_book_id, to_series, to_issue, story, source, found_at) VALUES (?,?,'a','1',?,'b','1',?,'title',0)`);
  const chain = ['nt124', 'gl65', 'ds34', 'gg33', 'nt125', 'gl66'];
  for (let i = 0; i + 1 < chain.length; i++) ins.run(`t:${chain[i]}>${chain[i + 1]}`, chain[i], chain[i + 1], 'The Siege of the Zi Charam');
  const gl = x.placementFor('gl');
  assert.deepEqual(gl.filter(p => p.afterBookId === 'gl65').sort((a, b) => a.seq - b.seq).map(p => p.bookId), ['ds34', 'gg33', 'nt125']);   // stops at #66, this series
  assert.deepEqual(gl.filter(p => p.beforeBookId === 'gl65').map(p => p.bookId), ['nt124']);
  assert.ok(!gl.some(p => p.bookId === 'gl66'));
  // Darkstars' grid: the parts before #34 back to the start, and after it to the end.
  const ds = x.placementFor('ds');
  assert.deepEqual(ds.filter(p => p.beforeBookId === 'ds34').sort((a, b) => a.seq - b.seq).map(p => p.bookId), ['nt124', 'gl65']);
  assert.deepEqual(ds.filter(p => p.afterBookId === 'ds34').sort((a, b) => a.seq - b.seq).map(p => p.bookId), ['gg33', 'nt125', 'gl66']);
});

test('fan wiki pages: "continues from / in" notes, Marvel (Story) previous/next, the event name and the date', () => {
  const W = require('./crossoverWiki');
  const pages = file => Object.values(require(`./fixtures/${file}`).query.pages).map(p => [p.title, W.parsePage(p.revisions[0].slots.main['*'])]);
  const got = Object.fromEntries([...pages('wiki-dc-sample.json'), ...pages('wiki-marvel-sample.json')].map(([t, r]) => [t, r]));
  const links = r => r.links.map(l => `${l.dir} ${l.series} #${l.issue}`);
  assert.deepEqual(links(got['Green Lantern Vol 3 162']), ['from Green Arrow #23', 'in Green Arrow #24']);
  assert.deepEqual(links(got['Green Lantern Vol 3 65']), ['from New Titans #124', 'in Darkstars #34']);
  assert.deepEqual(links(got['Mighty Thor Vol 1 19']), ['from Journey Into Mystery #642', 'in Journey Into Mystery #643']);
  assert.deepEqual(links(got['Amazing Spider-Man Vol 1 404']), ['from Web of Spider-Man #127', 'in Spider-Man #61']);
  assert.equal(got['Green Lantern Vol 3 65'].event, 'The Siege of the Zi Charam');
  assert.ok(W.dateFits(got['Green Lantern Vol 3 65'], '1995-06-27'));          // cover August 1995, on sale June 27
  assert.ok(!W.dateFits(got['Green Lantern Vol 3 65'], '2014-06-27'));         // another volume's #65
  assert.ok(W.dateFits(got['Mighty Thor Vol 1 19'], '2012-09-05'));
  // Character pages and "see also" links are not story links; "in X and Y" gives both.
  assert.deepEqual(W.parsePage('| Notes = Story continues in {{c|A Vol 1 2}} and {{c|B Vol 2 3}}. See also [[C Vol 1 4]] and [[Peter Parker (Earth-616)|Peter]].').links.map(l => l.series), ['A', 'B']);
  assert.equal(W.wikiName('The Amazing Spider-Man (1963)'), 'Amazing Spider-Man');
});

test('a finale can name its previous chapter and several characters’ next appearances', () => {
  const { parsePage } = require('./crossoverWiki');
  const page = parsePage(`| Notes = The Thaumaton storyline continues from {{c|Trinity of Sin: Pandora Vol 1 9}}.
** [[John Constantine]]'s story chronologically continues in {{c|Constantine Vol 1 13}};
** Pandora’s story is continued in {{c|Trinity of Sin: Pandora Vol 1 10}};
** Phantom Stranger's story is continued in {{c|Trinity of Sin: The Phantom Stranger Vol 4 18}}.
* This issue's story concludes in [[Another Title Vol 2 7]].`);
  assert.deepEqual(page.links.map(l => [l.dir, l.issue]), [['from', '9'], ['in', '7']]);
  assert.deepEqual(page.characterLinks.map(l => l.issue), ['13', '10', '18']);
});

test('a wiki note can send the reader through two consecutive issues of the same guest series', async () => {
  const W = require('./crossoverWiki');
  const lib = library(), { db } = lib;
  const title = 'Green Lantern Vol 7 40';
  const note = "The story continues in ''New Titans'' #116 and [[New Titans Vol 1 117|#117]].";
  const parse = s => W.parsePage('| Notes = ' + s);
  assert.deepEqual(parse(note).pairs[0].map(r => r.issue), ['116', '117']);
  assert.equal(parse(note.replace('#116', '#114')).pairs.length, 0);
  assert.equal(parse(note.replace('The story', "Kyle's story")).pairs.length, 0);
  assert.equal(parse('Story continues in {{c|New Titans Vol 1 116}} or {{c|New Titans Vol 1 117}}.').pairs.length, 0);
  assert.equal(parse('Story continues in {{c|New Titans Vol 2 116}} and {{c|New Titans Vol 1 117}}.').pairs.length, 0);
  const axios = { get: async () => ({ data: { query: { pages: { 1: { title, revisions: [{ slots: { main: {
    '*': '| Month = December\n| Year = 2026\n| Notes = ' + note,
  } } }] } } } } }) };
  db.exec(`INSERT INTO scanned_series (id,name,year) VALUES ('nt','The New Titans',1988);
    INSERT INTO scanned_books(id,series_id,issue_number,store_date) VALUES
      ('nt116','nt','116','2026-11-01'),('nt117','nt','117','2026-12-01');
    UPDATE scanned_books SET comicinfo='<Publisher>DC Comics</Publisher>' WHERE id='gl40'`);
  const x = create(lib, { axios });
  db.prepare('INSERT INTO crossover_wiki_books VALUES (?,?,?,?,?)').run('gl40', Date.now(), title, 1, 2);
  const refresh = lib.app.routes['POST /api/admin/crossovers/refresh'];
  let response;
  refresh({ body: { wiki: true } }, { json(value) { response = value; } });
  assert.equal(response.status.wiki.running, true);
  while (x.wikiState.running) await new Promise(r => setTimeout(r, 5));
  assert.equal(x.wikiState.error, null);
  assert.equal(x.nextFor('gl40').id, 'nt116');
  assert.deepEqual(x.placementFor('gl').map(r => r.bookId), ['nt116', 'nt117']);
  db.prepare("UPDATE crossover_links SET hidden=1 WHERE to_book_id='nt117'").run();
  assert.deepEqual(x.placementFor('gl').map(r => r.bookId), ['nt116']);
});

test('the fan wiki pass: finds each series\' volume by date, reads pages 50 at a time, stores links, reads each issue once', async () => {
  const lib = library();
  const page = (title, notes, month, year) => `{{DC Database:Comic Template\n| Title = x\n| Month = ${month}\n| Year = ${year}\n| Notes = ${notes}\n}}`;
  const wiki = {
    'Green Lantern Vol 1 40': page('Green Lantern Vol 1 40', 'Old story.', 'June', 1965),      // another volume (wrong date)
    'Green Lantern Vol 7 40': page('Green Lantern Vol 7 40', 'This is part one of "First Light". This story continues in {{c|Green Lantern Corps Vol 5 22}}.', 'December', 2026),
  };
  const calls = [];
  const axios = { get: async (url, { params }) => {
    calls.push(params.titles);
    const pages = {};
    params.titles.split('|').forEach((t, i) => { pages[wiki[t] ? i : -1 - i] = wiki[t] ? { title: t, revisions: [{ slots: { main: { '*': wiki[t] } } }] } : { title: t, missing: '' }; });
    return { data: { query: { pages } } };
  } };
  lib.db.exec(`UPDATE scanned_books SET comicinfo = '<ComicInfo><Publisher>DC Comics</Publisher></ComicInfo>'`);
  const x = create(lib, { axios });
  await x.wikiPass({ maxRequests: 50 });
  assert.equal(x.nextFor('gl40').id, 'glc22');
  const row = lib.db.prepare(`SELECT * FROM crossover_links WHERE source = 'wiki'`).get();
  assert.equal(row.story, 'First Light');
  assert.equal(lib.db.prepare(`SELECT vol FROM crossover_wiki_series WHERE name = 'Green Lantern'`).get().vol, 7);
  const n = calls.length;
  await x.wikiPass({ maxRequests: 50 });
  assert.equal(calls.length, n);   // nothing new to read
  // A recent issue with a page is read again a week later (notes are often added after release).
  lib.db.prepare(`UPDATE scanned_books SET store_date = date('now', '-20 days') WHERE id = 'gl40'`).run();
  lib.db.prepare(`UPDATE crossover_wiki_books SET checked_at = ? WHERE book_id = 'gl40'`).run(Date.now() - 8 * 86400000);
  await x.wikiPass({ maxRequests: 50 });
  assert.equal(calls.length, n + 1);
  assert.ok(calls.at(-1).includes('Green Lantern Vol 7 40'));
  lib.settings.set('crossover_code_enabled', '0');
  assert.equal(x.nextFor('gl40'), null);
  lib.settings.set('crossover_code_enabled', '1');
  // Simulate a link saved by the previous parser. A failed fetch preserves it; a
  // successful re-read removes only this page's character-only evidence.
  lib.db.prepare("UPDATE crossover_wiki_books SET story_reviewed = 0 WHERE book_id = 'gl40'").run();
  const title = 'Green Lantern Vol 7 40';
  delete wiki[title];
  await x.wikiPass({ maxRequests: 50 });
  assert.equal(x.nextFor('gl40').id, 'glc22');
  const personal = "John's story is continued in {{c|Green Lantern Corps Vol 5 22}}.";
  wiki[title] = page(title, personal + ' This story concludes in {{c|Green Lantern Corps Vol 5 22}}.', 'December', 2026);
  await x.wikiPass({ maxRequests: 50 });
  assert.equal(x.nextFor('gl40').id, 'glc22');
  lib.db.prepare("UPDATE crossover_wiki_books SET story_reviewed = 0 WHERE book_id = 'gl40'").run();
  wiki[title] = page(title, personal, 'December', 2026);
  await x.wikiPass({ maxRequests: 50 });
  assert.equal(x.nextFor('gl40'), null);
  assert.equal(lib.db.prepare("SELECT story_reviewed FROM crossover_wiki_books WHERE book_id = 'gl40'").get().story_reviewed, 2);
});

test('fan wiki volumes: other spellings when the first finds none (The Flash, Atom and Hawkman); old notes and reversed dates', async () => {
  const W = require('./crossoverWiki');
  const have = { 'The Flash Vol 4 1': '| Month = 11\n| Year = 2011\n', 'Atom and Hawkman Vol 1 39': '| Month = 10\n| Year = 1968\n' };
  const client = { pages: async (wiki, titles) => new Map(titles.map(t => [t, have[t] ? { title: t, text: have[t] } : null])) };
  const found = await W.findVolumes(client, 'dc', [
    { key: 'f', name: W.wikiName('The Flash'), series: 'The Flash', probe: { issue: '1', store_date: '2011-09-28' } },
    { key: 'a', name: W.wikiName('The Atom & Hawkman'), series: 'The Atom & Hawkman', probe: { issue: '39', store_date: '1968-08-01' } },
    { key: 'x', name: 'Nothing Here', series: 'Nothing Here', probe: { issue: '1', store_date: '2000-01-01' } },
  ]);
  assert.deepEqual(Object.fromEntries(found), { f: { name: 'The Flash', vol: 4 }, a: { name: 'Atom and Hawkman', vol: 1 }, x: { name: 'Nothing Here', vol: 0 } });
  // wikiRow: "continued from" an issue not owned is a look back, not a part; a next part released well before is dropped.
  const lib = library();
  const L = C.loadLibrary(lib.db);
  const gl40 = L.byId.get('gl40');
  assert.equal(C.wikiRow(L, gl40, { dir: 'from', series: 'Giant-Size Avengers', issue: '4' }, null, 'p'), null);
  assert.equal(C.wikiRow(L, gl40, { dir: 'in', series: 'Giant-Size Avengers', issue: '5' }, null, 'p').toName.series, 'Giant-Size Avengers');
  assert.ok(C.wikiRow(L, L.byId.get('glc22'), { dir: 'in', series: 'Green Lantern', issue: '40' }, null, 'p'));   // 2 weeks earlier: allowed (up to 45 days)
  lib.db.prepare(`UPDATE scanned_books SET store_date = '2026-08-20' WHERE id = 'gl40'`).run();
  assert.equal(C.wikiRow(C.loadLibrary(lib.db), C.loadLibrary(lib.db).byId.get('glc22'), { dir: 'in', series: 'Green Lantern', issue: '40' }, null, 'p'), null);   // 83 days earlier: dropped
  assert.equal(C.wikiRow(L, gl40, { dir: 'in', series: 'Green Lantern Corps', issue: '22' }, null, 'p').to.id, 'glc22');
});

test('Reading order: a missing next part ends the chain as a missing issue; requests get its name and number', () => {
  const lib = library(), x = create(lib);
  addWeb(x, lib, [[{ series: 'Green Lantern Corps', issue: '22' }, { series: 'Green Lantern', issue: '41' }, 'First Light', '2026-11-11'],
    [{ series: 'Green Lantern', issue: '40' }, { series: 'Green Lantern Corps', issue: '22' }, 'First Light', '2026-10-28']]);
  // In Green Lantern's own grid #41 is its own missing issue (shown already), not a crossover card.
  assert.ok(!x.placementFor('gl').some(p => p.missing));
  const glc = x.placementFor('glc');
  const miss = glc.find(p => p.missing);
  assert.deepEqual([miss.afterBookId, miss.missing.series_name, miss.missing.issue_number, miss.missing.story], ['glc22', 'Green Lantern', '41', 'First Light']);
  const row = x.missingRow(miss.missing.linkId);
  assert.deepEqual([row.series_name, row.issue_number, row.cv_issue_id], ['Green Lantern', '41', null]);
  lib.settings.set('crossover_ai_enabled', '0');
  assert.equal(x.missingRow(miss.missing.linkId), null);   // its source switched off
});

test('a missing part in a monitored series: its folder, monitored issue, status and release date', () => {
  const lib = library(), x = create(lib);
  lib.db.exec(`ALTER TABLE scanned_series ADD COLUMN monitored_series_id TEXT;
    CREATE TABLE monitored_issues (id TEXT, series_id TEXT, issue_number TEXT, status TEXT, store_date TEXT, release_date TEXT, is_annual INTEGER DEFAULT 0);
    UPDATE scanned_series SET monitored_series_id = 'cv-gl' WHERE id = 'gl';
    INSERT INTO monitored_issues VALUES ('cv41', 'cv-gl', '41', 'wanted', '2026-11-25', NULL, 0);`);
  addWeb(x, lib, [[{ series: 'Green Lantern Corps', issue: '22' }, { series: 'Green Lantern', issue: '41' }, 'First Light', '2026-11-11']]);
  const miss = x.placementFor('glc').find(p => p.missing);
  assert.deepEqual([miss.missing.status, miss.missing.date], ['wanted', '2026-11-25']);
  const row = x.missingRow(miss.missing.linkId);
  assert.deepEqual([row.scanned_series_id, row.cv_issue_id, row.volume_year], ['gl', 'cv41', 2023]);
});
