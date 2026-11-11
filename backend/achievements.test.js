'use strict';
// Achievements (2026-11-10).
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createAchievements } = require('./achievements');

function setup() {
  const db = new DatabaseSync(':memory:');
  db.transaction = fn => (...a) => { db.exec('BEGIN'); try { const r = fn(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, created_at TEXT);
    INSERT INTO users VALUES ('a', 'ann', '2025-03-01 10:00:00'), ('b', 'bob', '2025-06-01 10:00:00');
    CREATE TABLE libraries (id TEXT PRIMARY KEY, name TEXT, color TEXT);
    INSERT INTO libraries VALUES ('m', 'Marvel Comics', NULL), ('d', 'DC Comics', NULL), ('x', 'Intercompany Crossovers', NULL);
    CREATE TABLE scanned_series (id TEXT PRIMARY KEY, library_id TEXT, name TEXT, series_json TEXT, monitored_series_id TEXT);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, issue_number TEXT, filename TEXT, is_special INTEGER, comicinfo TEXT, monitored_issue_id TEXT, cv_issue_id TEXT);
    CREATE TABLE book_ci_index (book_id TEXT, volume_year INTEGER, cv_issue_id TEXT);
    CREATE TABLE monitored_series (id TEXT PRIMARY KEY, series_type TEXT);
    CREATE TABLE monitored_issues (id TEXT PRIMARY KEY, store_date TEXT, release_date TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT, event_tier INTEGER);
    CREATE TABLE event_issues (id INTEGER PRIMARY KEY, event_id TEXT, tier TEXT, scanned_book_id TEXT);
    CREATE TABLE canon_runs (id INTEGER PRIMARY KEY, title TEXT, status TEXT);
    CREATE TABLE canon_run_issues (id INTEGER PRIMARY KEY, run_id INTEGER, scanned_book_id TEXT);
    CREATE TABLE canon_run_categories (run_id INTEGER, category TEXT);
    CREATE TABLE canon_run_creators (run_id INTEGER, person_name TEXT, role TEXT);
    CREATE TABLE reading_lists (id INTEGER PRIMARY KEY, owner_id TEXT, visibility TEXT, source TEXT, created_at TEXT);
    CREATE TABLE reading_list_follows (user_id TEXT, list_id INTEGER, followed_at TEXT);
    CREATE TABLE collections (id TEXT PRIMARY KEY, owner_id TEXT, purpose TEXT, created_at TEXT);
    CREATE TABLE collection_series (collection_id TEXT, series_id TEXT);
    CREATE TABLE read_progress (book_id TEXT, user_id TEXT, page INTEGER, completed INTEGER);
    CREATE TABLE ai_usage (user_id TEXT, kind TEXT, created_at TEXT);
    CREATE TABLE download_requests (user_id TEXT, status TEXT, handled_at TEXT);
    CREATE TABLE problem_reports (user_id TEXT, status TEXT, handled_at TEXT);
    CREATE TABLE award_data (award TEXT, winner INTEGER, cv_volume_id TEXT);
    INSERT INTO collections VALUES ('pull_a', 'a', 'pull', '2025-01-01 00:00:00');`);
  // Marvel: a 5-issue series "Horror Tales" (genre Horror, 1975), a #-1 and a special; DC: one series.
  db.exec(`INSERT INTO scanned_series VALUES ('s1', 'm', 'Horror Tales', '{"metadata":{"comicid":111,"genres":["Horror","Superhero"]}}', NULL),
    ('s2', 'd', 'Big Crisis', '{"metadata":{"comicid":222,"genres":["Superhero"]}}', NULL), ('s3', 'x', 'Versus', '{}', NULL)`);
  for (let i = 1; i <= 5; i++) db.prepare('INSERT INTO scanned_books VALUES (?, ?, ?, ?, 0, ?, NULL, NULL)').run(`h${i}`, 's1', String(i), `Horror Tales ${i}.cbz`, '<ComicInfo><Year>1975</Year></ComicInfo>');
  db.exec(`INSERT INTO scanned_books VALUES ('hm1', 's1', '-1', 'Horror Tales -1.cbz', 1, NULL, NULL, NULL), ('hsp', 's1', '1', 'Horror Tales Special.cbz', 1, NULL, NULL, NULL);
    INSERT INTO scanned_books VALUES ('c1', 's2', '1', 'Big Crisis 1.cbz', 0, NULL, NULL, NULL), ('c2', 's2', '2', 'Big Crisis 2.cbz', 0, NULL, NULL, NULL), ('c3', 's2', '3', 'Big Crisis 3.cbz', 0, NULL, NULL, NULL),
      ('v1', 's3', '1', 'Versus 1.cbz', 0, NULL, NULL, NULL);
    INSERT INTO collection_series VALUES ('pull_a', 's2');`);
  // A Crisis-level event: 4 essential issues, 3 in the library (c1-c3), one not (NULL); a tie-in in the library.
  db.exec(`INSERT INTO events VALUES ('e1', 'Big Crisis', 1);
    INSERT INTO event_issues (event_id, tier, scanned_book_id) VALUES ('e1', 'essential', 'c1'), ('e1', 'essential', 'c2'), ('e1', 'essential', 'c3'), ('e1', 'essential', NULL), ('e1', 'tie-in', 'h1');`);
  let t = Date.parse('2026-11-10T12:00:00Z');
  const clock = { set: iso => { t = Date.parse(iso); }, add: ms => { t += ms; } };
  const routes = {};
  const reg = m => (p, ...h) => { routes[`${m} ${p}`] = h.at(-1); };
  const ach = createAchievements({ app: { get: reg('GET'), post: reg('POST') }, db, requireAuth: (q, r, n) => n(), logger: { info() {}, warn() {}, error() {} },
    orderedBooks: () => null, now: () => t });
  const call = (key, user, query = {}, body = {}) => { const out = {}; const res = { status(c) { out.code = c; return res; }, json(v) { out.body = v; } };
    routes[key]({ user: { sub: user }, query, body }, res); return out.body; };
  return { db, ach, clock, call };
}
const ids = list => list.map(a => a.id);

test('achievements: a factory missing a piece refuses to start', () => {
  assert.throws(() => createAchievements({ app: {} }), /createAchievements: missing db/);
});

test('achievements: only finishes after launch count; the same finish twice is one; a hidden one shows when earned', () => {
  const { db, ach, clock } = setup();
  const first = ach.recordFinish('a', 'hm1', { tz: 0 });
  assert.deepEqual(first.find(a => a.id === 'minus_one').name, 'Minus One');
  assert.ok(ids(first).includes('lib_m_1'));                                                           // a small library: one step
  assert.deepEqual(ach.recordFinish('a', 'hm1', { tz: 0 }), []);                                  // sent again
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reading_log').get().n, 1);
  clock.add(7 * 3600 * 1000);                                                                          // a later read
  ach.recordFinish('a', 'hm1', { tz: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reading_log').get().n, 2);
});

test('achievements: local day and hour come from the reader\'s clock (Creature of the Night)', () => {
  const { db, ach, clock } = setup();
  clock.set('2026-11-10T07:30:00Z');
  const got = ach.recordFinish('a', 'h1', { tz: 300 });                                              // UTC-5: 02:30 local
  assert.ok(ids(got).includes('creature_of_the_night'));
  assert.deepEqual({ ...db.prepare('SELECT local_day, local_hour FROM reading_log').get() }, { local_day: '2026-11-10', local_hour: 2 });
});

test('achievements: a series read through in a day, its library, its era and its genre', () => {
  const { ach } = setup();
  let got = [];
  for (let i = 1; i <= 5; i++) got = got.concat(ach.recordFinish('a', `h${i}`, { tz: 0 }));
  const g = ids(got);
  for (const id of ['series_1', 'one_sitting', 'age_bronze', 'genre_horror']) assert.ok(g.includes(id), id);
  assert.ok(!g.includes('issues_10') && !g.includes('genre_superhero'));
  assert.deepEqual(ach.progressFor('a').get('genre_superhero'), { have: 5, need: 25, note: null });   // most of a library is superhero: 25
  const p = ach.progressFor('a');
  assert.deepEqual(p.get('issues_10'), { have: 5, need: 10, note: null });
});

test('achievements: a Crisis-level event is finished when 3 in 4 of its Essential issues are in the library and all of them read; first in the household', () => {
  const { ach, clock } = setup();
  for (const b of ['c1', 'c2']) ach.recordFinish('a', b);
  assert.equal(ach.progressFor('a').get('crisis_1').have, 0);
  const got = ids(ach.recordFinish('a', 'c3'));
  assert.ok(got.includes('crisis_1') && got.includes('first_finish'), got.join());
  assert.ok(!got.includes('every_tie_in'));
  clock.add(86400000);
  const bob = [];
  for (const b of ['c1', 'c2', 'c3']) bob.push(...ach.recordFinish('b', b));
  assert.ok(ids(bob).includes('crisis_1') && !ids(bob).includes('first_finish'));
  assert.ok(ids(ach.recordFinish('a', 'h1')).includes('every_tie_in'));
});

test('achievements: pulls count only after launch; boxes and lists made before launch do not count', () => {
  const { db, ach, clock } = setup();
  db.exec("INSERT INTO collections VALUES ('box_old', 'a', NULL, '2025-01-01 00:00:00'); INSERT INTO reading_lists (owner_id, visibility, source, created_at) VALUES ('a', 'private', 'manual', '2025-01-01 00:00:00')");
  assert.equal(ach.progressFor('a').get('pulls_5').have, 0);                                         // s2 was pulled before launch
  assert.equal(ach.progressFor('a').get('box_builder').have, 0);
  db.exec("INSERT INTO collection_series VALUES ('pull_a', 's1'); INSERT INTO collections VALUES ('box_new', 'a', NULL, '2026-11-10 12:30:00')");
  clock.add(31000);                                                                                    // progress is kept for 30 s
  const p = ach.evaluate('a');
  assert.ok(ids(p).includes('box_builder'));
});

test('achievements: the page masks hidden ones, counts holders and ranks the household', () => {
  const { ach, call } = setup();
  ach.recordFinish('a', 'hm1');
  ach.recordFinish('b', 'v1');
  const page = call('GET /api/achievements', 'b');
  const items = page.groups.flatMap(g => g.items);
  const minus = items.find(i => i.id === 'minus_one');
  assert.deepEqual([minus.name, minus.label, minus.have, minus.holders], ['???', '?', null, 1]);   // ann has it, bob does not
  assert.ok(items.find(i => i.id === 'amalgam').earned_at);                                            // bob read an intercompany crossover
  assert.equal(page.readers, 2);
  assert.deepEqual(page.leaderboard.map(r => r.username).sort(), ['ann', 'bob']);
  const annPage = call('GET /api/achievements', 'b', { user: 'a' });
  assert.equal(annPage.me, false);
  assert.equal(annPage.groups.flatMap(g => g.items).find(i => i.id === 'minus_one').name, 'Minus One');
  assert.ok(page.groups.some(g => g.id === 'libraries' && g.items.some(i => i.id === 'lib_m_1')));   // small libraries: one step
});

test('achievements: unseen ones are listed once, then marked seen', () => {
  const { ach, call } = setup();
  ach.recordFinish('a', 'hm1');
  const unseen = ids(call('GET /api/achievements/unseen', 'a').items);
  assert.ok(unseen.includes('minus_one'));
  call('POST /api/achievements/seen', 'a', {}, { ids: unseen });
  assert.deepEqual(call('GET /api/achievements/unseen', 'a').items, []);
});

test('achievements: reading streaks by day', () => {
  const { ach, clock } = setup();
  clock.set('2026-11-10T12:00:00Z'); ach.recordFinish('a', 'h1');
  clock.set('2026-11-11T12:00:00Z'); ach.recordFinish('a', 'h2');
  clock.set('2026-11-12T12:00:00Z');
  assert.ok(ids(ach.recordFinish('a', 'h3')).includes('streak_days_3'));
});

test('achievements: libraries have names of their own and their name on the ribbon; genres their own glyph', () => {
  const { ach } = setup();
  const byId = new Map(ach.allDefs().map(d => [d.id, d]));
  assert.deepEqual([byId.get('lib_m_1').name, byId.get('lib_m_1').label], ['True Believer', 'MARVEL']);
  assert.deepEqual([byId.get('lib_d_1').name, byId.get('lib_d_1').label], ['Truth and Justice', 'DC']);
  assert.deepEqual([byId.get('lib_x_1').name, byId.get('lib_x_1').label], ['Unlikely Allies', 'CROSSOVER']);
  assert.deepEqual([byId.get('genre_horror').icon, byId.get('genre_horror').label], ['pumpkin', 'HORROR']);
  assert.equal(byId.get('genre_science_fiction').label, 'SCI-FI');
});

test('achievements: near-duplicates separated (acclaimed from 5 runs, Modern Age 25 issues); Happy Birthday on a release anniversary', () => {
  const { db, ach, clock } = setup();
  const ids2 = ach.allDefs().map(d => d.id);
  assert.ok(ids2.includes('acclaimed_5') && !ids2.includes('acclaimed_1') && ids2.includes('acclaimed_25'));
  assert.ok(!ids2.includes('golden_oldie') && ids2.includes('happy_birthday'));
  db.exec("UPDATE scanned_books SET comicinfo = '<ComicInfo><Year>2020</Year></ComicInfo>', monitored_issue_id = 'mi1' WHERE id = 'h1'; INSERT INTO monitored_issues VALUES ('mi1', '2021-11-10', NULL)");
  clock.set('2026-11-10T12:00:00Z');
  const got = ids(ach.recordFinish('a', 'h1'));
  assert.ok(got.includes('happy_birthday') && !got.includes('age_modern'), got.join());
  assert.equal(ach.progressFor('a').get('age_modern').need, 25);
});

test('achievements: a Legendary Story is earned by reading all of it, matched by ComicInfo series, number and cover year, or by Comic Vine id', () => {
  const { db, ach } = setup();
  db.exec("INSERT INTO scanned_series VALUES ('bat', 'd', 'Batman', '{}', NULL)");
  for (const n of [404, 405, 406]) db.prepare('INSERT INTO scanned_books VALUES (?, ?, ?, ?, 0, ?, NULL, NULL)').run(`b${n}`, 'bat', String(n), `Batman ${n}.cbz`, `<ComicInfo><Series>Batman</Series><Number>${n}</Number><Year>1987</Year></ComicInfo>`);
  db.exec("INSERT INTO scanned_books VALUES ('b407', 'bat', '407', 'Batman 407.cbz', 0, NULL, NULL, '28066')");   // no ComicInfo: its Comic Vine id
  db.exec("INSERT INTO scanned_books VALUES ('old404', 'bat', '404', 'Batman 404 (1950s).cbz', 0, '<ComicInfo><Series>Batman</Series><Number>404</Number><Year>1955</Year></ComicInfo>', NULL, NULL)");
  const defs = ach.allDefs();
  assert.ok(defs.filter(d => d.group === 'legendary').length >= 40 && defs.every(d => d.group !== 'legendary' || d.hidden));
  assert.ok(!defs.some(d => d.id === 'specials_25' || d.id === 'annuals_25'));
  ach.recordFinish('a', 'old404');                                                    // wrong year: not part of it
  for (const n of [404, 405, 406]) assert.ok(!ids(ach.recordFinish('a', `b${n}`)).includes('story_year_one'));
  assert.deepEqual(ach.progressFor('a').get('story_year_one'), { have: 3, need: 4, note: null });
  assert.ok(ids(ach.recordFinish('a', 'b407')).includes('story_year_one'));
});

test('sassy Easter Eggs (2026-11-11): habits the shopkeeper teases', () => {
  const { db, ach, clock } = setup();
  const has = (u, id) => { clock.add(31000); return ach.progressFor(u).get(id).have >= 1; };
  // Reading Horror Tales (5 issues, 1975, long finished) from the end: last issue first, then the one before it.
  ach.recordFinish('a', 'h5', { pages: 22 });
  assert.ok(has('a', 'spoiler_alert'), 'last issue of a finished series first');
  assert.ok(has('a', 'who_starts_at_37'), 'started in the middle with #1 in the library');
  assert.ok(has('a', 'older_than_your_dad'), '1975, read in 2026');
  assert.ok(!has('a', 'continuity_error'));
  ach.recordFinish('a', 'h4', { pages: 22 });
  assert.ok(has('a', 'continuity_error'), '#5 then #4');
  // Bob read #1-#4 before launch, so starting his log at #5 is not a spoiler or a mid-series start.
  db.exec("INSERT INTO read_progress VALUES ('h1','b',22,1),('h2','b',22,1),('h3','b',22,1),('h4','b',22,1)");
  ach.recordFinish('b', 'h5', { pages: 22 });
  assert.ok(!has('b', 'spoiler_alert') && !has('b', 'who_starts_at_37'));
  // Speed: 16+ pages from the first page in under 2 minutes; a short one does not count.
  ach.recordFinish('b', 'c1', { pages: 10, seconds: 40 });
  assert.ok(!has('b', 'only_the_pictures'));
  ach.recordFinish('b', 'c2', { pages: 22, seconds: 95 });
  assert.ok(has('b', 'only_the_pictures'));
  // Theme changes: a small counter.
  for (let i = 0; i < 4; i++) ach.bump('a', 'theme');
  assert.ok(!has('a', 'new_costume'));
  ach.bump('a', 'theme');
  assert.ok(has('a', 'new_costume'));
  // Thumbs down on Comic Book Guy, and marking as read by hand (after launch only).
  db.exec('CREATE TABLE ai_feedback (usage_id INTEGER, user_id TEXT, rating INTEGER, question TEXT, answer TEXT, page TEXT, created_at TEXT)');
  for (let i = 0; i < 10; i++) db.prepare("INSERT INTO ai_feedback VALUES (?, 'a', -1, 'q', 'a', NULL, '2026-11-10 13:00:00')").run(i);
  assert.ok(has('a', 'everyones_a_critic'));
  db.exec('ALTER TABLE read_progress ADD COLUMN marked INTEGER; ALTER TABLE read_progress ADD COLUMN updated_at TEXT');
  for (let i = 0; i < 50; i++) db.prepare("INSERT INTO read_progress VALUES (?, 'a', 999, 1, 1, '2026-11-10 13:00:00')").run(`m${i}`);
  assert.ok(has('a', 'i_read_it'));
  // Ten issues on a Tuesday; back after 31 days away; three events in one day.
  for (let i = 0; i < 10; i++) db.prepare("INSERT INTO reading_log (user_id, book_id, finished_at, local_day, local_hour) VALUES ('c', ?, '2026-11-10 12:00:00', '2026-11-10', 12)").run(`h${(i % 5) + 1}`);
  assert.ok(has('c', 'called_in_sick'));
  assert.ok(!has('c', 'touched_grass'));
  db.prepare("INSERT INTO reading_log (user_id, book_id, finished_at, local_day, local_hour) VALUES ('c', 'c1', '2026-12-12 12:00:00', '2026-12-12', 12)").run();
  assert.ok(has('c', 'touched_grass'));
  db.exec(`INSERT INTO events VALUES ('e2', 'Small War', 3), ('e3', 'Third Thing', 3);
    INSERT INTO event_issues (event_id, tier, scanned_book_id) VALUES ('e2', 'essential', 'v1'), ('e3', 'essential', 'h2')`);
  for (const b of ['c1', 'v1', 'h2']) db.prepare("INSERT INTO reading_log (user_id, book_id, finished_at, local_day, local_hour) VALUES ('d', ?, '2026-11-10 12:00:00', '2026-11-10', 12)").run(b);
  assert.ok(has('d', 'event_fatigue'));
  // Five first issues, no second issues, 30 days on.
  for (let s = 0; s < 5; s++) {
    db.prepare("INSERT INTO scanned_series VALUES (?, 'm', ?, '{}', NULL)").run(`n${s}`, `New ${s}`);
    for (const n of [1, 2]) db.prepare("INSERT INTO scanned_books VALUES (?, ?, ?, ?, 0, NULL, NULL, NULL)").run(`n${s}_${n}`, `n${s}`, String(n), `New ${s} ${n}.cbz`);
    ach.recordFinish('e', `n${s}_1`, { pages: 22 });
  }
  assert.ok(!has('e', 'commitment_issues'), 'not yet 30 days');
  clock.add(31 * 864e5);
  assert.ok(has('e', 'commitment_issues'));
  // A Pull Box of series pulled after launch with 100 unread issues.
  db.exec("INSERT INTO scanned_series VALUES ('big', 'm', 'Big Run', '{}', NULL); INSERT INTO collections VALUES ('pull_e', 'e', 'pull', '2026-11-10 12:00:00'); INSERT INTO collection_series VALUES ('pull_e', 'big')");
  for (let i = 1; i <= 99; i++) db.prepare("INSERT INTO scanned_books VALUES (?, 'big', ?, ?, 0, NULL, NULL, NULL)").run(`big${i}`, String(i), `Big Run ${i}.cbz`);
  assert.ok(!has('e', 'pile_of_shame'));
  db.prepare("INSERT INTO scanned_books VALUES ('big100', 'big', '100', 'Big Run 100.cbz', 0, NULL, NULL, NULL)").run();
  assert.ok(has('e', 'pile_of_shame'));
  // All hidden, all in Easter Eggs.
  const sassy = ach.allDefs().filter(d => ['i_read_it', 'spoiler_alert', 'continuity_error', 'who_starts_at_37', 'commitment_issues', 'called_in_sick', 'older_than_your_dad',
    'touched_grass', 'event_fatigue', 'everyones_a_critic', 'new_costume', 'pile_of_shame', 'only_the_pictures'].includes(d.id));
  assert.equal(sassy.length, 13);
  assert.ok(sassy.every(d => d.hidden && d.group === 'secret'));
});
