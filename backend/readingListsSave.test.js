'use strict';
// Shared list editor, stage 1 (2026-10-16): the draft is saved in one go.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const schema = require('./schema');
const createReadingLists = require('./readingLists');

function setup() {
  const db = new DatabaseSync(':memory:');
  // better-sqlite3's transaction(): nested calls become savepoints.
  let depth = 0;
  db.transaction = fn => (...a) => {
    const sp = 'sp' + depth; db.exec(depth ? `SAVEPOINT ${sp}` : 'BEGIN'); depth++;
    try { const r = fn(...a); depth--; db.exec(depth ? `RELEASE ${sp}` : 'COMMIT'); return r; }
    catch (e) { depth--; db.exec(depth ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK'); throw e; }
  };
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT); INSERT INTO users VALUES ('u1','reader','user'),('a1','boss','admin');
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, path TEXT, filename TEXT, issue_number TEXT, title TEXT, comicinfo TEXT, cv_issue_id TEXT);
    CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, path TEXT, series_json TEXT);
    CREATE TABLE read_progress (id INTEGER PRIMARY KEY, book_id TEXT, user_id TEXT, page INTEGER, completed INTEGER);`);
  schema.applyReadingListsSchema(db);
  db.exec(`INSERT INTO reading_lists (id, name, owner_id, visibility, updated_at) VALUES (1, 'Mine', 'u1', 'private', '2026-10-16 10:00:00');
    INSERT INTO reading_list_entries (id, list_id, entry_type, label, sort_order) VALUES
      (11, 1, 'section', 'Part one', 1), (12, 1, 'issue', 'A #1', 2), (13, 1, 'issue', 'B #1', 3), (14, 1, 'issue', 'C #1', 4);`);
  const routes = {};
  const reg = m => (p, ...h) => { routes[m + ' ' + p] = h.at(-1); };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE') };
  const logger = { info() {}, warn() {}, error() {} };
  createReadingLists({ app, db, requireAuth: (q, r, n) => n(), cvApiGet: async () => null, getCVKey: () => null, logger, IN: { normIssueNumber: n => String(n) } });
  const call = (body, user = { sub: 'u1', role: 'user' }) => { const out = {}; const res = { status(c) { out.code = c; return res; }, json(v) { out.body = v; } };
    routes['POST /api/reading-lists/:id/save']({ params: { id: '1' }, body, user }, res); return out; };
  return { db, call };
}
const order = db => db.prepare('SELECT id, entry_type, label, note FROM reading_list_entries WHERE list_id = 1 ORDER BY sort_order').all();

test('save: reorder, remove, rename a section, note, new section — in one transaction', () => {
  const { db, call } = setup();
  const r = call({ version: '2026-10-16 10:00:00', order: [{ add: { type: 'section', label: 'Prologue' } }, 13, 11, 12], remove: [14], labels: { 11: 'Part One' }, notes: { 12: 'Read first' } });
  assert.deepEqual(r.body.errors, []); assert.equal(r.body.ok, true);
  assert.deepEqual(order(db).map(e => e.label), ['Prologue', 'B #1', 'Part One', 'A #1']);
  assert.equal(order(db).find(e => e.id === 12).note, 'Read first');
  assert.ok(r.body.version);
});
test('save: a stale version or a draft that misses entries is refused and changes nothing', () => {
  const { db, call } = setup();
  assert.equal(call({ version: '2026-10-15 00:00:00', order: [11, 12, 13, 14] }).code, 409);
  assert.equal(call({ order: [11, 12, 13] }).code, 409);              // 14 neither kept nor removed
  assert.equal(call({ order: [11, 12, 13, 14, 14] }).code, 409);      // twice
  assert.deepEqual(order(db).map(e => e.id), [11, 12, 13, 14]);
});
test('save: only someone who may edit the list', () => {
  const { call } = setup();
  assert.equal(call({ order: [11, 12, 13, 14] }, { sub: 'other', role: 'user' }).code, 404);   // private list: not visible
});

// Crossover groups and issues inside entries (rework, 2026-10-16).
function withIssues() {
  const t = setup();
  t.db.exec(`INSERT INTO list_issues (id, owner_kind, owner_id, sort_order, series_name, issue_number) VALUES
    (101, 'reading_list_entry', 12, 1, 'A', '1'), (102, 'reading_list_entry', 13, 1, 'B', '1'), (103, 'reading_list_entry', 14, 1, 'C', '1');
    INSERT INTO reading_list_entries (id, list_id, entry_type, label, sort_order, unpacked) VALUES (15, 1, 'story', 'Old crossover', 5, 1);
    INSERT INTO list_issues (id, owner_kind, owner_id, sort_order, series_name, issue_number) VALUES
    (104, 'reading_list_entry', 15, 1, 'D', '1'), (105, 'reading_list_entry', 15, 2, 'E', '1'), (106, 'reading_list_entry', 15, 3, 'F', '1');`);
  const issuesOf = id => t.db.prepare("SELECT id FROM list_issues WHERE owner_kind = 'reading_list_entry' AND owner_id = ? ORDER BY sort_order").all(id).map(r => r.id);
  return { ...t, issuesOf };
}
test('crossover: combine whole entries; take one issue out of another crossover; reorder and drop inside it', () => {
  const { db, call, issuesOf } = withIssues();
  const r = call({ order: [11, { add: { type: 'story', label: 'Uprising' }, members: [{ entry: 12 }, { entry: 13 }] },
    { add: { type: 'issue' }, members: [{ li: 104 }] }, { id: 15, issues: [106] }, 14], remove: [] });
  assert.deepEqual(r.body.errors, []);
  const rows = order(db);
  assert.deepEqual(rows.map(e => e.entry_type), ['section', 'story', 'issue', 'story', 'issue']);
  const story = rows[1], single = rows[2];
  assert.equal(story.label, 'Uprising'); assert.equal(issuesOf(story.id).length, 2);
  assert.deepEqual(issuesOf(single.id), [104]); assert.equal(single.label, 'D #1');
  assert.deepEqual(issuesOf(15), [106]);                                  // 105 dropped, 104 moved out
  assert.equal(db.prepare('SELECT COUNT(*) n FROM list_issues WHERE id = 105').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reading_list_entries WHERE id IN (12, 13)').get().n, 0);
});
test('crossover: a crossover emptied by the draft goes; an issue cannot leave an entry the draft does not describe', () => {
  const { db, call } = withIssues();
  assert.equal(call({ order: [11, 12, 13, 14, { add: { type: 'issue' }, members: [{ li: 104 }] }, 15] }).code, 409);   // 15 not re-described
  const r = call({ order: [11, 12, 13, 14, { id: 15, issues: [] }] });
  assert.deepEqual(r.body.errors, []);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reading_list_entries WHERE id = 15').get().n, 0);
});

test('save: list details (name, description, visibility) with the draft; Essentials stay admin only', () => {
  const { db, call } = setup();
  const r = call({ version: '2026-10-16 10:00:00', order: [11, 12, 13, 14], details: { name: 'Mine, renamed', description: '**Start** here', visibility: 'public' } });
  assert.equal(r.body.ok, true);
  assert.deepEqual({ ...db.prepare('SELECT name, description, visibility FROM reading_lists WHERE id = 1').get() },
    { name: 'Mine, renamed', description: '**Start** here', visibility: 'public' });
  const v = db.prepare('SELECT updated_at FROM reading_lists WHERE id = 1').get().updated_at;
  const e = call({ version: v, order: [14, 13, 12, 11], details: { visibility: 'essential' } });
  assert.equal(e.code, 403);
  assert.equal(order(db)[0].id, 11);   // nothing changed when the details were refused
  assert.equal(call({ version: v, order: [11, 12, 13, 14], details: { name: '  ' } }).code, 400);
});

test('match with syncCv: the issue takes the chosen comic\'s Comic Vine id; without it, the id is kept', () => {
  const { db } = setup();
  const routes = {};
  const reg = m => (p, ...h) => { routes[m + ' ' + p] = h.at(-1); };
  createReadingLists({ app: { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE') }, db, requireAuth: (q, r, n) => n(),
    cvApiGet: async () => null, getCVKey: () => null, logger: { info() {}, warn() {}, error() {} }, IN: { normIssueNumber: n => String(n) } });
  db.exec(`INSERT INTO scanned_books (id, series_id, filename, issue_number, cv_issue_id) VALUES ('b16', 's', 'Wonder Woman 001.cbz', '1', '537223');
    INSERT INTO list_issues (id, owner_kind, owner_id, sort_order, cv_issue_id, series_name, issue_number) VALUES (501, 'reading_list_entry', 12, 1, '106754', 'Wonder Woman', '1')`);
  const call = body => { const out = {}; const res = { status(c) { out.code = c; return res; }, json(v) { out.body = v; } };
    routes['PATCH /api/reading-lists/:id/issues/:issueId/match']({ params: { id: '1', issueId: '501' }, body, user: { sub: 'u1', role: 'user' } }, res); return out; };
  call({ bookId: 'b16' });
  assert.equal(db.prepare('SELECT cv_issue_id FROM list_issues WHERE id = 501').get().cv_issue_id, '106754');
  assert.equal(call({ bookId: 'b16', syncCv: true }).body.cv_issue_id, '537223');
  assert.deepEqual({ ...db.prepare('SELECT cv_issue_id, scanned_book_id, manually_matched FROM list_issues WHERE id = 501').get() }, { cv_issue_id: '537223', scanned_book_id: 'b16', manually_matched: 1 });
});

test('add: entries from the Add window — an owned issue, a named range, a picked set (story), a Timeline event with its tier', () => {
  const { db, call } = setup();
  db.exec(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, name TEXT, year INTEGER); INSERT INTO events VALUES ('ev1', 'Blackest Night', 2009);
    CREATE TABLE IF NOT EXISTS event_issues (id INTEGER PRIMARY KEY, event_id TEXT, cv_issue_id TEXT, scanned_book_id TEXT, sort_order INTEGER, tier TEXT, series_name TEXT, issue_number TEXT, issue_title TEXT, volume_year TEXT);
    ALTER TABLE scanned_series ADD COLUMN year INTEGER; ALTER TABLE scanned_books ADD COLUMN monitored_issue_id TEXT;
    INSERT INTO scanned_series (id, name, path) VALUES ('s16', 'Wonder Woman', '/c/ww');
    INSERT INTO scanned_books (id, series_id, filename, issue_number) VALUES ('b3', 's16', 'Wonder Woman 003.cbz', '3');`);
  const r = call({ version: '2026-10-16 10:00:00', order: [11,
    { add: { type: 'issue', bookId: 'b3' } },
    { add: { type: 'range', seriesName: 'Wonder Woman', volumeYear: 2016, issueStart: '1', issueEnd: '2' } },
    { add: { type: 'story', label: 'Wonder Woman (2016) #5, 7', issues: [{ seriesName: 'Wonder Woman', issueNumber: '5', volumeYear: 2016 }, { seriesName: 'Wonder Woman', issueNumber: '7', volumeYear: 2016 }] } },
    { add: { type: 'event', refId: 'ev1' }, tier: 'all' }, 12, 13, 14] });
  assert.deepEqual(r.body.errors, []);
  const e = db.prepare('SELECT id, entry_type t, label, tier_filter tf FROM reading_list_entries WHERE list_id = 1 ORDER BY sort_order').all().map(x => ({ ...x }));
  assert.deepEqual(e.map(x => x.t), ['section', 'issue', 'range', 'story', 'event', 'issue', 'issue', 'issue']);
  assert.equal(e[4].tf, 'all');
  const iss = id => db.prepare('SELECT issue_number n, scanned_book_id b FROM list_issues WHERE owner_id = ? ORDER BY sort_order').all(id).map(x => x.n + (x.b ? '=' + x.b : ''));
  assert.deepEqual(iss(e[1].id), ['3=b3']); assert.deepEqual(iss(e[2].id), ['1', '2']); assert.deepEqual(iss(e[3].id), ['5', '7']);
});

test('fetch: an entry\'s issue rows keep their ids, so a draft made before the fetch still saves', async () => {
  // 2026-11-10: the fetch after a save deleted and re-inserted every row; the editor's next
  // save (an issue moved out of the new range) was refused as "out of step".
  const { db, call } = setup();
  db.exec(`ALTER TABLE scanned_series ADD COLUMN year INTEGER; ALTER TABLE scanned_books ADD COLUMN monitored_issue_id TEXT;
    CREATE TABLE IF NOT EXISTS monitored_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER, cv_url TEXT);
    INSERT INTO scanned_series (id, name, path) VALUES ('s16', 'Wonder Woman', '/c/ww');
    INSERT INTO scanned_books (id, series_id, filename, issue_number) VALUES ('b3', 's16', 'Wonder Woman 003.cbz', '3'), ('b4', 's16', 'Wonder Woman 004.cbz', '4'), ('b5', 's16', 'Wonder Woman 005.cbz', '5');`);
  const r = call({ order: [11, { add: { type: 'range', seriesId: 's16', issueStart: '3', issueEnd: '5', issues: [{ bookId: 'b3' }, { bookId: 'b4' }] } }, 12, 13, 14] });
  assert.deepEqual(r.body.errors, []);
  const range = db.prepare("SELECT id FROM reading_list_entries WHERE list_id = 1 AND entry_type = 'range'").get().id;
  const rows = () => db.prepare('SELECT id, issue_number n FROM list_issues WHERE owner_id = ? ORDER BY sort_order').all(range);
  const seed = rows();                                            // what the editor loads straight after the save
  assert.deepEqual(seed.map(x => x.n), ['3', '4']);
  await new Promise(res => setTimeout(res, 50));                 // the background fetch adds #5
  assert.deepEqual(rows().map(x => x.n), ['3', '4', '5']);
  assert.deepEqual(rows().slice(0, 2).map(x => x.id), seed.map(x => x.id));
  // The draft from before the fetch: take #4 out of the range as its own entry.
  const s = call({ version: r.body.version, order: [11, { id: range, unpack: true, issues: [seed[0].id] }, { add: { type: 'issue' }, members: [{ li: seed[1].id }] }, 12, 13, 14] });
  assert.equal(s.code, undefined, JSON.stringify(s.body)); assert.deepEqual(s.body.errors, []);
  assert.deepEqual(rows().map(x => x.n), ['3']);
  const e = db.prepare('SELECT unpacked, resolve_status FROM reading_list_entries WHERE id = ?').get(range);
  assert.equal(e.unpacked, 1); assert.notEqual(e.resolve_status, 'pending');
  // An issue that really is gone: refused, with a message that says so.
  const g = call({ order: [11, { id: range, issues: [seed[0].id, 99999] }, ...order(db).slice(2).map(x => x.id)] });
  assert.equal(g.code, 409); assert.match(g.body.error, /no longer in the list/);
});
test('homepage text saves through normal list editor, remains admin-only, and preserves other details',()=>{
  const {db,call}=setup();const order=[11,12,13,14];
  assert.equal(call({order,details:{home_tagline:'Not allowed'}}).code,403);
  db.exec("UPDATE reading_lists SET visibility='essential'");
  const admin={sub:'a1',role:'admin'};
  assert.equal(call({order,details:{home_tagline:'Meet your hero.',home_description:'Start the journey.'}},admin).body.ok,true);
  assert.equal(call({order,details:{description:'Updated'}},admin).body.ok,true);
  assert.equal(db.prepare('SELECT home_tagline FROM reading_lists').get().home_tagline,'Meet your hero.');
  assert.equal(call({order,details:{home_tagline:'x'.repeat(121)}},admin).code,400);
  assert.equal(call({order,details:{home_tagline:''}},admin).body.ok,true);
  assert.equal(db.prepare('SELECT home_tagline FROM reading_lists').get().home_tagline,null);db.close();
});

test('add: a range from the Add window keeps the picked issues at once, and a volume list without them does not empty it', async () => {
  const { db, call } = setup();
  db.exec(`ALTER TABLE scanned_series ADD COLUMN year INTEGER; ALTER TABLE scanned_books ADD COLUMN monitored_issue_id TEXT;
    CREATE TABLE IF NOT EXISTS monitored_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER, cv_url TEXT);
    INSERT INTO scanned_series (id, name, path) VALUES ('s16', 'Wonder Woman', '/c/ww');
    INSERT INTO scanned_books (id, series_id, filename, issue_number) VALUES ('b3', 's16', 'Wonder Woman 003.cbz', '3'), ('b4', 's16', 'Wonder Woman 004.cbz', '4');`);
  const r = call({ order: [11,
    { add: { type: 'range', seriesId: 's16', issueStart: '3', issueEnd: '4', issues: [{ bookId: 'b3' }, { bookId: 'b4' }] } },
    { add: { type: 'range', seriesId: 's16', issueStart: '7', issueEnd: '8', issues: [{ seriesName: 'Wonder Woman', issueNumber: '7' }, { seriesName: 'Wonder Woman', issueNumber: '8' }] } },
    12, 13, 14] });
  assert.deepEqual(r.body.errors, []);
  const ranges = db.prepare("SELECT id FROM reading_list_entries WHERE list_id = 1 AND entry_type = 'range' ORDER BY sort_order").all().map(x => x.id);
  const iss = id => db.prepare('SELECT issue_number n, scanned_book_id b FROM list_issues WHERE owner_id = ? ORDER BY sort_order').all(id).map(x => x.n + (x.b ? '=' + x.b : ''));
  assert.deepEqual(iss(ranges[0]), ['3=b3', '4=b4']);            // straight after the save
  assert.deepEqual(iss(ranges[1]), ['7', '8']);
  await new Promise(res => setTimeout(res, 50));                 // the background fetch (library books here)
  assert.deepEqual(iss(ranges[0]), ['3=b3', '4=b4']);
  assert.deepEqual(iss(ranges[1]), ['7', '8']);                  // the volume has no #7–8: kept, not emptied
  assert.equal(db.prepare('SELECT resolve_status s FROM reading_list_entries WHERE id = ?').get(ranges[1]).s, 'partial');
  assert.equal(db.prepare('SELECT resolve_status s FROM reading_list_entries WHERE id = ?').get(ranges[0]).s, 'partial');   // library-only list
});
