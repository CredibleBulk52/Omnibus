'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const create = require('./curatedEditor');
function setup() {
  const db = new DatabaseSync(':memory:');
  db.transaction = fn => (...a) => { db.exec('BEGIN'); try { const r = fn(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  db.exec(`CREATE TABLE scanned_books (id TEXT PRIMARY KEY);
    CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT, publisher TEXT, year INTEGER, description TEXT, event_tier INTEGER DEFAULT 2, sort_order INTEGER DEFAULT 0, cover_image TEXT); INSERT INTO events (id, name, year) VALUES (5, 'Blackest Night', 2009);
    CREATE TABLE event_issues (id INTEGER PRIMARY KEY, event_id TEXT, cv_issue_id TEXT, scanned_book_id TEXT, sort_order INTEGER, tier TEXT, tier_note TEXT, series_name TEXT, issue_number TEXT, issue_title TEXT, volume_year INTEGER, manually_matched INTEGER, phase TEXT);
    INSERT INTO event_issues (id, event_id, sort_order, tier, series_name, issue_number, phase) VALUES (1,'5',1,'essential','BN','0','Prelude'),(2,'5',2,'essential','BN','1','Main'),(3,'5',3,'tie-in','GL','43','Main');
    CREATE TABLE canon_runs (id INTEGER PRIMARY KEY, title TEXT, parent_series TEXT, issue_range_hint TEXT, description TEXT, status TEXT DEFAULT 'pending', event_id INTEGER, cv_volume_id TEXT, updated_at TEXT, admin_recommended INTEGER DEFAULT 0);
    INSERT INTO canon_runs (id, title) VALUES (9, 'Sandman');
    CREATE TABLE canon_run_categories (id INTEGER PRIMARY KEY, run_id INTEGER, category TEXT, adaptation_notes TEXT, UNIQUE(run_id, category));
    CREATE TABLE canon_run_creators (id INTEGER PRIMARY KEY, run_id INTEGER, person_name TEXT, role TEXT);
    INSERT INTO canon_run_creators (run_id, person_name, role) VALUES (9, 'Neil Gaiman', 'writer');
    CREATE TABLE canon_run_issues (id INTEGER PRIMARY KEY, run_id INTEGER, cv_issue_id TEXT, scanned_book_id TEXT, sort_order INTEGER, series_name TEXT, issue_number TEXT, volume_year INTEGER, manually_matched INTEGER);
    INSERT INTO canon_run_issues (id, run_id, sort_order, series_name, issue_number) VALUES (21,9,1,'Sandman','1'),(22,9,2,'Sandman','2');`);
  const routes = {};
  const reg = m => (p, ...h) => { routes[m + ' ' + p] = h.at(-1); };
  create({ app: { get: reg('GET'), post: reg('POST'), delete: reg('DELETE') }, db, requireAdmin: () => {} });
  const call = (key, params, body) => { const out = {}; const res = { status(c) { out.code = c; return res; }, json(v) { out.body = v; } }; routes[key]({ params, body, user: { username: 'a' } }, res); return out; };
  return { db, call };
}
test('event: sections become phases; tiers and notes; removal; stale versions refused', () => {
  const { db, call } = setup();
  const g = call('GET /api/editor/event/:id', { id: '5' });
  assert.equal(g.body.rows.length, 3);
  const r = call('POST /api/editor/event/:id/save', { id: '5' }, { version: g.body.version, order: [{ section: 'Opening' }, 2, 1, { section: 'Tie-ins' }], remove: [3], tiers: { 1: 'recommended' }, notes: { 2: 'Start here' } });
  assert.equal(r.body.ok, true);
  assert.deepEqual(db.prepare('SELECT id, phase, tier, tier_note FROM event_issues ORDER BY sort_order').all().map(x => ({ ...x })),
    [{ id: 2, phase: 'Opening', tier: 'essential', tier_note: 'Start here' }, { id: 1, phase: 'Opening', tier: 'recommended', tier_note: null }]);
  assert.equal(call('POST /api/editor/event/:id/save', { id: '5' }, { version: g.body.version, order: [2, 1] }).code, 409);
  assert.equal(call('POST /api/editor/event/:id/save', { id: '5' }, { order: [2] }).code, 409);   // 1 missing
});
test('run: removal; stale version refused', () => {
  const { db, call } = setup();
  const g = call('GET /api/editor/run/:id', { id: '9' });
  assert.equal(call('POST /api/editor/run/:id/save', { id: '9' }, { version: g.body.version, remove: [22] }).body.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM canon_run_issues').get().n, 1);
  assert.equal(call('POST /api/editor/run/:id/save', { id: '9' }, { version: g.body.version, remove: [21] }).code, 409);
});
test('run: loads in stored order; save reorders; a draft missing an issue is refused', () => {
  const { db, call } = setup();
  db.exec("INSERT INTO canon_run_issues (id, run_id, sort_order, series_name, issue_number) VALUES (23,9,3,'Sandman Annual','1')");
  const g = call('GET /api/editor/run/:id', { id: '9' });
  assert.deepEqual(g.body.rows.map(r => r.id), [21, 22, 23]);
  assert.equal(call('POST /api/editor/run/:id/save', { id: '9' }, { version: g.body.version, order: [21, 23] }).code, 409);   // 22 missing
  assert.equal(call('POST /api/editor/run/:id/save', { id: '9' }, { version: g.body.version, order: [23, 21], remove: [22] }).body.ok, true);
  assert.deepEqual(call('GET /api/editor/run/:id', { id: '9' }).body.rows.map(r => r.id), [23, 21]);
});

test('event details: saved with the draft, checked, and part of the version', () => {
  const { db, call } = setup();
  const g = call('GET /api/editor/event/:id', { id: '5' });
  assert.equal(g.body.details.name, 'Blackest Night');
  assert.equal(call('POST /api/editor/event/:id/save', { id: '5' }, { version: g.body.version, order: [1, 2, 3], details: { event_tier: 7 } }).code, 400);
  const r = call('POST /api/editor/event/:id/save', { id: '5' }, { version: g.body.version, order: [1, 2, 3], details: { name: 'Blackest Night!', publisher: 'DC', year: '2009', event_tier: 1, sort_order: 2, description: 'Dead rise.' } });
  assert.equal(r.body.ok, true);
  assert.deepEqual({ ...db.prepare('SELECT name, publisher, year, event_tier, sort_order, description FROM events WHERE id = 5').get() },
    { name: 'Blackest Night!', publisher: 'DC', year: 2009, event_tier: 1, sort_order: 2, description: 'Dead rise.' });
  assert.equal(call('POST /api/editor/event/:id/save', { id: '5' }, { version: g.body.version, order: [1, 2, 3] }).code, 409);   // details changed since
});
test('run details: title, status, creators, categories, linked event', () => {
  const { db, call } = setup();
  const g = call('GET /api/editor/run/:id', { id: '9' });
  assert.deepEqual(g.body.details.creators, [{ person_name: 'Neil Gaiman', role: 'writer' }]);
  assert.deepEqual(g.body.events.map(e => e.id), ['5']);
  assert.equal(call('POST /api/editor/run/:id/save', { id: '9' }, { version: g.body.version, details: { event_id: '77' } }).code, 400);
  const r = call('POST /api/editor/run/:id/save', { id: '9' }, { version: g.body.version, details: { title: 'The Sandman', status: 'approved', event_id: '5',
    creators: [{ person_name: 'Neil Gaiman', role: 'writer' }, { person_name: 'Sam Kieth', role: 'penciler' }, { person_name: '', role: 'inker' }],
    categories: [{ category: 'award_winning', adaptation_notes: 'World Fantasy Award' }, { category: 'nonsense' }] } });
  assert.equal(r.body.ok, true);
  const d = call('GET /api/editor/run/:id', { id: '9' }).body.details;
  assert.equal(d.title, 'The Sandman'); assert.equal(d.status, 'approved'); assert.equal(d.event_id, '5');
  assert.deepEqual(d.creators.map(c => c.person_name), ['Neil Gaiman', 'Sam Kieth']);
  assert.deepEqual(d.categories, [{ category: 'award_winning', adaptation_notes: 'World Fantasy Award' }]);
});

test('delete: an event (its issues; linked runs unlinked) and a run (its issues, categories, creators)', () => {
  const { db, call } = setup();
  db.exec("UPDATE canon_runs SET event_id = 5 WHERE id = 9; INSERT INTO canon_run_categories (run_id, category) VALUES (9, 'award_winning')");
  assert.equal(call('GET /api/editor/event/:id', { id: '5' }).body.usage.runs, 1);
  assert.equal(call('DELETE /api/editor/event/:id', { id: '5' }).body.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM event_issues').get().n, 0);
  assert.equal(db.prepare('SELECT event_id FROM canon_runs WHERE id = 9').get().event_id, null);
  assert.equal(call('DELETE /api/editor/run/:id', { id: '9' }).body.ok, true);
  for (const t of ['canon_runs', 'canon_run_issues', 'canon_run_categories', 'canon_run_creators']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, t);
  assert.equal(call('DELETE /api/editor/run/:id', { id: '9' }).code, 404);
});

test('add: new issues from the Add window go in at their place (event: tier and phase; run: order)', () => {
  const { db, call } = setup();
  let g = call('GET /api/editor/event/:id', { id: '5' });
  const add = { series_name: 'Green Lantern', issue_number: '44', volume_year: 2005, cv_issue_id: '1001', scanned_book_id: null };
  assert.equal(call('POST /api/editor/event/:id/save', { id: '5' }, { version: g.body.version, order: [1, { add: { series_name: '' } }, 2, 3] }).code, 400);
  const r = call('POST /api/editor/event/:id/save', { id: '5' }, { version: g.body.version, order: [{ section: 'Prelude' }, 1, { section: 'Main' }, 2, { add, tier: 'tie-in' }, 3] });
  assert.equal(r.body.ok, true);
  assert.deepEqual(db.prepare('SELECT series_name s, issue_number n, tier, phase, cv_issue_id cv, manually_matched m FROM event_issues ORDER BY sort_order').all().map(x => ({ ...x })).slice(2, 4),
    [{ s: 'GL', n: '43', tier: 'tie-in', phase: 'Main', cv: null, m: null }, { s: 'Green Lantern', n: '44', tier: 'tie-in', phase: 'Main', cv: '1001', m: 0 }].reverse());
  g = call('GET /api/editor/run/:id', { id: '9' });
  assert.equal(call('POST /api/editor/run/:id/save', { id: '9' }, { version: g.body.version, order: [{ add: { series_name: 'Sandman', issue_number: '0', scanned_book_id: 'bk0' } }, 21, 22] }).body.ok, true);
  assert.deepEqual(db.prepare('SELECT issue_number n, scanned_book_id b, manually_matched m FROM canon_run_issues ORDER BY sort_order').all().map(x => ({ ...x })),
    [{ n: '0', b: 'bk0', m: 1 }, { n: '1', b: null, m: null }, { n: '2', b: null, m: null }]);
});

test('run status (pending review) and the Recommended switch', () => {
  const { db, call } = setup();
  assert.equal(call('POST /api/editor/run/:id/status', { id: '9' }, { status: 'approved' }).body.ok, true);
  assert.equal(call('POST /api/editor/run/:id/status', { id: '9' }, { status: 'bogus' }).code, 400);
  assert.equal(call('POST /api/editor/run/:id/status', { id: '99' }, { status: 'pending' }).code, 404);
  const g = call('GET /api/editor/run/:id', { id: '9' });
  assert.equal(g.body.details.status, 'approved'); assert.equal(g.body.details.admin_recommended, 0);
  assert.equal(call('POST /api/editor/run/:id/save', { id: '9' }, { version: g.body.version, details: { admin_recommended: true } }).body.ok, true);
  assert.equal(db.prepare('SELECT admin_recommended r FROM canon_runs WHERE id = 9').get().r, 1);
});
test('runs in bulk: approve, block (stored as rejected), back to pending, delete (gone with its issues)', () => {
  const { db, call } = setup();
  db.exec("INSERT INTO canon_runs (id, title) VALUES (10, 'Second'), (11, 'Third')");
  assert.equal(call('POST /api/editor/runs/bulk', {}, { ids: [9, 10], action: 'approve' }).body.changed, 2);
  assert.equal(call('POST /api/editor/runs/bulk', {}, { ids: [10, 11], action: 'block' }).body.changed, 2);
  assert.deepEqual(db.prepare('SELECT id, status FROM canon_runs ORDER BY id').all().map(r => [r.id, r.status]), [[9, 'approved'], [10, 'rejected'], [11, 'rejected']]);
  call('POST /api/editor/runs/bulk', {}, { ids: [11], action: 'pending' });
  assert.equal(call('POST /api/editor/runs/bulk', {}, { ids: [9, 10], action: 'delete' }).body.changed, 2);
  assert.deepEqual(db.prepare('SELECT id, status FROM canon_runs').all().map(r => [r.id, r.status]), [[11, 'pending']]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM canon_run_issues WHERE run_id = 9').get().n, 0);
  assert.equal(call('POST /api/editor/runs/bulk', {}, { ids: [11], action: 'archive' }).code, 400);
});

test('event: a tier change replaces the stale tier reason (the admin\'s reason, else a record of the change)', () => {
  const { db, call } = setup();
  db.exec("ALTER TABLE event_issues ADD COLUMN tier_reason TEXT; UPDATE event_issues SET tier_reason = 'necessary: generator reason; CBT'");
  const g = call('GET /api/editor/event/:id', { id: '5' });
  const r = call('POST /api/editor/event/:id/save', { id: '5' }, { version: g.body.version, order: [1, 2, 3], tiers: { 1: 'recommended', 3: 'essential' }, reasons: { 1: 'parallel story, read it' } });
  assert.equal(r.body.ok, true);
  const why = Object.fromEntries(db.prepare('SELECT id, tier_reason FROM event_issues').all().map(x => [x.id, x.tier_reason]));
  assert.equal(why[1], 'admin: parallel story, read it');
  assert.equal(why[3], 'admin changed the tier from tie-in to essential');
  assert.equal(why[2], 'necessary: generator reason; CBT');   // tier unchanged: kept
});

test('homepage text uses existing event/run saves, survives ordinary edits, and participates in version conflicts', () => {
  const {db,call}=setup();
  for(const [kind,id,order] of [['event','5',[1,2,3]],['run','9',[21,22]]]) {
    const get=()=>call(`GET /api/editor/${kind}/:id`,{id}).body;
    const first=get();
    const save=body=>call(`POST /api/editor/${kind}/:id/save`,{id},body);
    assert.equal(save({version:first.version,order,details:{home_tagline:'A new chapter.',home_description:'A short introduction.'}}).body.ok,true);
    assert.equal(get().details.home_tagline,'A new chapter.');
    assert.equal(save({version:first.version,order,details:{home_tagline:'Stale'}}).code,409);
    assert.equal(save({version:get().version,order,details:{description:'Updated description'}}).body.ok,true);
    assert.equal(get().details.home_tagline,'A new chapter.');
    assert.equal(save({version:get().version,order,details:{home_tagline:'x'.repeat(121)}}).code,400);
    assert.equal(save({version:get().version,order,details:{home_tagline:''}}).body.ok,true);
    assert.equal(get().details.home_tagline,null);
  }
  db.close();
});

test('event: one of its own issues as the Timeline cover; checked; cleared when that issue is removed', () => {
  const { db, call } = setup();
  let g = call('GET /api/editor/event/:id', { id: '5' });
  assert.equal(g.body.details.cover_issue_id, null);
  assert.equal(call('POST /api/editor/event/:id/save', { id: '5' }, { version: g.body.version, order: [1, 2, 3], details: { cover_issue_id: 21 } }).code, 400);   // another list's issue
  const r = call('POST /api/editor/event/:id/save', { id: '5' }, { version: g.body.version, order: [1, 2, 3], details: { cover_issue_id: 2 } });
  assert.equal(r.body.ok, true);
  g = call('GET /api/editor/event/:id', { id: '5' });
  assert.equal(g.body.details.cover_issue_id, 2);
  call('POST /api/editor/event/:id/save', { id: '5' }, { version: g.body.version, order: [1, 3], remove: [2] });
  assert.equal(db.prepare('SELECT cover_issue_id c FROM events WHERE id = 5').get().c, null);
});
