const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const create=require('./essentialCollections');
function setup(){const db=new DatabaseSync(':memory:');db.transaction=fn=>(...a)=>{db.exec('BEGIN');try{const result=fn(...a);db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};db.exec("CREATE TABLE reading_lists(id INTEGER PRIMARY KEY,visibility TEXT,catalog_json TEXT);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)");const registry=create(db),routes={},app={get:(p,...h)=>routes['GET '+p]=h.at(-1),post:(p,...h)=>routes['POST '+p]=h.at(-1),delete:(p,...h)=>routes['DELETE '+p]=h.at(-1)};registry.register(app,()=>{});const call=(route,body={},role='admin')=>{const result={};const res={json(v){result.body=v;return res;},status(v){result.status=v;return res;}};routes[route]({body,params:{id:body.id},user:{role}},res);return result;};return {db,registry,call};}
test('legacy collections migrate once, preserving header branding and stable memberships after rename',()=>{
 const {db,registry,call}=setup();db.prepare('INSERT INTO settings VALUES (?,?)').run('catalog_publisher_notes',JSON.stringify({essentials:{DC:"The Hero’s Journey"},essentials_styles:{DC:{publisher:'DC',fill:'#123456'}}}));
 db.prepare('INSERT INTO reading_lists VALUES (?,?,?)').run(1,'essential',JSON.stringify({collections:['DC','Cosmic']}));
 const resolve=r=>JSON.parse(r.catalog_json);registry.migrate(resolve);const first=registry.all(),dc=first.find(c=>c.legacyKey==='DC');assert.equal(dc.name,'The Hero’s Journey');assert.equal(dc.appearance.fill,'#123456');
 const ids=JSON.parse(db.prepare('SELECT catalog_json FROM reading_lists WHERE id=1').get().catalog_json).collections;assert(ids.includes(dc.id));
 assert.equal(call('POST /api/essential-collections',{id:dc.id,name:'DC journeys',appearance:dc.appearance,pinned:['1']}).body.ok,true);
 registry.migrate(resolve);assert.equal(registry.all().length,2);assert.equal(registry.names(ids)[0],'DC journeys');assert.deepEqual(JSON.parse(db.prepare('SELECT catalog_json FROM reading_lists WHERE id=1').get().catalog_json).collections,ids);
});
test('collection administration validates permissions, duplicate names, pins and complete ordering',()=>{
 const {registry,call}=setup();assert.equal(call('POST /api/essential-collections',{name:'Heroes'},'user').status,403);
 const a=call('POST /api/essential-collections',{name:'Heroes'}).body.id,b=call('POST /api/essential-collections',{name:'Teams'}).body.id;
 assert.equal(call('POST /api/essential-collections',{name:'heroes'}).status,409);
 assert.equal(call('POST /api/essential-collections',{id:a,name:'Heroes',pinned:['999']}).status,400);
 assert.equal(call('POST /api/essential-collections/order',{ids:[a,a]}).status,400);
 assert.equal(call('POST /api/essential-collections/order',{ids:[b,a]},'user').status,403);
 assert.equal(call('POST /api/essential-collections/order',{ids:[b,a]}).body.ok,true);assert.deepEqual(registry.all().map(c=>c.id),[b,a]);
});

test('deleting a collection is admin-only and preserves journeys without recreating the collection',()=>{
 const {db,registry,call}=setup();const id=call('POST /api/essential-collections',{name:'Heroes'}).body.id;
 db.prepare('INSERT INTO reading_lists VALUES (?,?,?)').run(1,'essential',JSON.stringify({collections:[id],group:'Heroes'}));
 assert.equal(call('DELETE /api/essential-collections/:id',{id},'user').status,403);
 assert.equal(call('DELETE /api/essential-collections/:id',{id}).body.ok,true);
 assert.equal(db.prepare('SELECT count(*) AS n FROM reading_lists').get().n,1);
 assert.deepEqual(JSON.parse(db.prepare('SELECT catalog_json FROM reading_lists').get().catalog_json).collections,[]);
 registry.migrate(r=>JSON.parse(r.catalog_json));assert.equal(registry.all().length,0);
 assert.equal(call('DELETE /api/essential-collections/:id',{id}).status,404);
});

test('membership editing preserves other collections and rejects private or missing orders',()=>{
 const {db,registry,call}=setup();const a=call('POST /api/essential-collections',{name:'Heroes'}).body.id,b=call('POST /api/essential-collections',{name:'Teams'}).body.id;
 db.prepare('INSERT INTO reading_lists VALUES (?,?,?)').run(1,'essential',JSON.stringify({collections:[a,b],other:'kept'}));
 db.prepare('INSERT INTO reading_lists VALUES (?,?,?)').run(2,'essential',JSON.stringify({collections:[b]}));
 db.prepare('INSERT INTO reading_lists VALUES (?,?,?)').run(3,'private','{}');
 assert.equal(call('POST /api/essential-collections',{id:a,name:'Heroes',members:['3']}).status,400);
 assert.equal(call('POST /api/essential-collections',{id:a,name:'Heroes',members:['2']},'user').status,403);
 assert.equal(call('POST /api/essential-collections',{id:a,name:'Heroes',members:['2'],pinned:['2']}).body.ok,true);
 const one=JSON.parse(db.prepare('SELECT catalog_json FROM reading_lists WHERE id=1').get().catalog_json),two=JSON.parse(db.prepare('SELECT catalog_json FROM reading_lists WHERE id=2').get().catalog_json);
 assert.deepEqual(one,{collections:[b],other:'kept'});assert.deepEqual(two.collections,[b,a]);
 assert.equal(call('POST /api/essential-collections',{id:a,name:'Heroes',members:[],pinned:['2']}).status,400);
 assert.equal(call('POST /api/essential-collections',{id:a,name:'Heroes',members:[]}).body.ok,true);
 assert.deepEqual(JSON.parse(db.prepare('SELECT catalog_json FROM reading_lists WHERE id=2').get().catalog_json).collections,[b]);
});
