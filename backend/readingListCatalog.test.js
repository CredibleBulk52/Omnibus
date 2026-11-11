'use strict';
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
  return { db, call, routes };
}

function invoke(routes, method, body, user = {sub:'a1',role:'admin'}, query = {}) {
 const out = {}; const res = {status(code){out.code=code;return res;},json(value){out.body=value;}};
 routes[method]({params:{id:'1'},body,user,query},res); return out;
}
test('catalog saves associations, preserves them through normal edits, and restricts featuring', () => {
 const {db,routes}=setup();
 const catalog={publishers:['DC','Marvel'],library_ids:['dc','marvel'],featured:true};
 assert.equal(invoke(routes,'PATCH /api/reading-lists/:id',{catalog},{sub:'u1',role:'user'}).code,403);
 assert.equal(invoke(routes,'PATCH /api/reading-lists/:id',{catalog:{publishers:'DC'}},{sub:'u1',role:'user'}).code,400);
 // Admin cannot edit another user private list; make the list public first.
 db.exec("UPDATE reading_lists SET visibility='public' WHERE id=1");
 assert.equal(invoke(routes,'PATCH /api/reading-lists/:id',{catalog}).body.ok,true);
 assert.equal(invoke(routes,'PATCH /api/reading-lists/:id',{name:'Renamed'}).body.ok,true);
 const result=invoke(routes,'GET /api/reading-lists',null,undefined,{scope:'public'}).body.lists[0];
 assert.deepEqual(result.catalog.publishers,['DC','Marvel']);
 assert.deepEqual(result.catalog.library_ids,['dc','marvel']);assert.equal(result.catalog.featured,true);
 const copy=invoke(routes,'POST /api/reading-lists/:id/copy',{}).body.id;
 const copied=JSON.parse(db.prepare('SELECT catalog_json FROM reading_lists WHERE id=?').get(copy).catalog_json);
 assert.equal(copied.featured,false);assert.deepEqual(copied.library_ids,['dc','marvel']);
});
test('missing issues inherit publisher and library from series metadata',()=>{
 const {db,routes}=setup();db.exec("ALTER TABLE scanned_series ADD COLUMN library_id TEXT; ALTER TABLE scanned_series ADD COLUMN year INTEGER;");
 db.prepare('INSERT INTO scanned_series (id,name,library_id,year,series_json) VALUES (?,?,?,?,?)').run('s1','Flash','dc',1987,JSON.stringify({metadata:{publisher:'DC Comics'}}));
 db.exec("INSERT INTO list_issues (owner_kind,owner_id,series_name,volume_year,issue_number) VALUES ('reading_list_entry',12,'Flash',1987,'1')");
 const result=invoke(routes,'GET /api/reading-lists',null,{sub:'u1',role:'user'},{scope:'mine'}).body.lists[0];
 assert.deepEqual(result.catalog.library_ids,['dc']);assert.deepEqual(result.catalog.publishers,['DC Comics']);assert.equal(result.progress.owned,0);
});
test('catalog section: group and group-by-publisher save from Details and survive Organize saves', () => {
 const {db,routes,call}=setup();
 db.exec("UPDATE reading_lists SET visibility='public' WHERE id=1");
 assert.equal(invoke(routes,'PATCH /api/reading-lists/:id',{catalog_group:'  Big Events ',catalog_by_publisher:1},{sub:'u1',role:'user'}).body.ok,true);
 let c=invoke(routes,'GET /api/reading-lists',null,{sub:'u1',role:'user'},{scope:'mine'}).body.lists[0].catalog;
 assert.equal(c.group,'Big Events');assert.equal(c.by_publisher,true);
 // Organize sends publishers/libraries only; the section settings stay.
 assert.equal(invoke(routes,'PATCH /api/reading-lists/:id',{catalog:{publishers:['DC'],library_ids:[],featured:false}},{sub:'u1',role:'user'}).body.ok,true);
 c=invoke(routes,'GET /api/reading-lists',null,{sub:'u1',role:'user'},{scope:'mine'}).body.lists[0].catalog;
 assert.equal(c.group,'Big Events');assert.equal(c.by_publisher,true);assert.deepEqual(c.publishers,['DC']);
 // Clearing both, through the editor's Save.
 const saved=call({order:[11,12,13,14],details:{catalog_group:'',catalog_by_publisher:0}});assert.equal(saved.code,undefined,JSON.stringify(saved.body));
 c=invoke(routes,'GET /api/reading-lists',null,{sub:'u1',role:'user'},{scope:'mine'}).body.lists[0].catalog;
 assert.equal(c.group,'');assert.equal(c.by_publisher,false);assert.deepEqual(c.publishers,['DC']);
 assert.equal(invoke(routes,'PATCH /api/reading-lists/:id',{catalog_group:'x'.repeat(61)},{sub:'u1',role:'user'}).code,400);
 assert.deepEqual(invoke(routes,'GET /api/reading-lists/groups',null,{sub:'u1',role:'user'}).body.groups,[]);
 invoke(routes,'PATCH /api/reading-lists/:id',{catalog_group:'Cosmic'},{sub:'u1',role:'user'});
 assert.deepEqual(invoke(routes,'GET /api/reading-lists/groups',null,{sub:'u2',role:'user'}).body.groups,['Cosmic']);
});

test('artwork override respects list ownership, validates choices, and reaches summaries',()=>{
 const {db,routes}=setup();
 assert.equal(invoke(routes,'PUT /api/reading-lists/:id/artwork',{choice:'comedy'}).code,404);
 assert.equal(invoke(routes,'PUT /api/reading-lists/:id/artwork',{choice:'bad'},{sub:'u1',role:'user'}).code,400);
 assert.equal(invoke(routes,'PUT /api/reading-lists/:id/artwork',{choice:'comedy'},{sub:'u1',role:'user'}).body.artwork.family,'comedy');
 const result=invoke(routes,'GET /api/reading-lists',null,{sub:'u1',role:'user'},{scope:'mine'}).body.lists[0];
 assert.equal(result.catalog.artwork.choice,'comedy');
 db.exec("UPDATE reading_lists SET visibility='public' WHERE id=1");
 assert.equal(invoke(routes,'PUT /api/reading-lists/:id/artwork',{choice:'fantasy'},{sub:'other',role:'user'}).code,403);
 assert.equal(invoke(routes,'PUT /api/reading-lists/:id/artwork',{choice:'fantasy'}).body.artwork.family,'fantasy');
 db.exec('DELETE FROM reading_lists WHERE id=1');
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM box_artwork_preferences').get().n,0);
});

test('curated collections validate, deduplicate, survive edits and copy, and allow clearing', () => {
 const {db,routes}=setup(); db.exec("UPDATE reading_lists SET visibility='essential' WHERE id=1");
 assert.equal(invoke(routes,'PATCH /api/reading-lists/:id',{catalog_collections:['Cosmic','cosmic','Teams']}).body.ok,true);
 const read=()=>JSON.parse(db.prepare('SELECT catalog_json FROM reading_lists WHERE id=1').get().catalog_json);
 assert.deepEqual(read().collections,['cosmic','Teams']);
 assert.equal(invoke(routes,'PATCH /api/reading-lists/:id',{catalog:{publishers:['DC'],featured:true}}).body.ok,true);
 assert.deepEqual(read().collections,['cosmic','Teams']);
 assert.equal(invoke(routes,'PATCH /api/reading-lists/:id',{catalog_collections:'Cosmic'}).code,400);
 assert.equal(invoke(routes,'PATCH /api/reading-lists/:id',{catalog_collections:['x'.repeat(61)]}).code,400);
 const copy=invoke(routes,'POST /api/reading-lists/:id/copy',{}).body.id;
 assert.deepEqual(JSON.parse(db.prepare('SELECT catalog_json FROM reading_lists WHERE id=?').get(copy).catalog_json).collections,['cosmic','Teams']);
 assert.equal(invoke(routes,'PATCH /api/reading-lists/:id',{catalog_collections:[]}).body.ok,true);
 assert.deepEqual(read().collections,[]);
});


test('editor collection IDs resolve to updated names after a collection rename',()=>{
 const {db,routes}=setup();db.exec("UPDATE reading_lists SET visibility='essential' WHERE id=1");
 const c=invoke(routes,'POST /api/essential-collections',{name:'Heroes',appearance:{character:'Superman'}}).body;
 assert.equal(c.ok,true);
 assert.equal(invoke(routes,'PATCH /api/reading-lists/:id',{catalog_collections:[c.id]}).body.ok,true);
 const get=()=>invoke(routes,'GET /api/reading-lists',null,undefined,{scope:'essential'}).body.lists[0];
 assert.deepEqual(get().catalog.collection_ids,[c.id]);assert.deepEqual(get().catalog.collections,['Heroes']);
 assert.equal(invoke(routes,'POST /api/essential-collections',{id:c.id,name:'Legends',appearance:{character:'Superman'}}).body.ok,true);
 assert.deepEqual(get().catalog.collections,['Legends']);assert.deepEqual(get().catalog.collection_ids,[c.id]);
 assert.equal(invoke(routes,'PATCH /api/reading-lists/:id',{catalog_collections:['ec_missing']}).code,400);
});

test('only admins delete Essentials, while readers may delete their own reading orders',()=>{
 const a=setup();a.db.exec("UPDATE reading_lists SET visibility='essential' WHERE id=1");
 assert.equal(invoke(a.routes,'DELETE /api/reading-lists/:id',{}, {sub:'u1',role:'user'}).code,403);
 assert.equal(invoke(a.routes,'DELETE /api/reading-lists/:id',{}).body.ok,true);
 const b=setup();assert.equal(invoke(b.routes,'DELETE /api/reading-lists/:id',{}, {sub:'other',role:'user'}).code,404);
 assert.equal(invoke(b.routes,'DELETE /api/reading-lists/:id',{}, {sub:'u1',role:'user'}).body.ok,true);
});
