'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {selectFamily,create}=require('./boxArtwork');
const row=(id,genres)=>({id,series_json:JSON.stringify({metadata:{genres}})});
test('one vote per distinct series per family, independent of order',()=>{
 const rows=[row('a',['Crime','Street-Level','Noir']),row('a',['Crime']),row('b',['Horror']),row('c',['Horror'])];
 assert.equal(selectFamily(rows),'horror');
 assert.equal(selectFamily(rows.reverse()),'horror');
});
test('ties, neutral tags and malformed metadata use default',()=>{
 assert.equal(selectFamily([row('a',['Fantasy','Sword & Sorcery','Pulp','Historical'])]),'default');
 assert.equal(selectFamily([row('a',['Superhero','Team','Teen']),{id:'b',series_json:'broken'}]),'default');
 assert.equal(selectFamily([]),'default');
});
test('every artwork family resolves and tags are case insensitive',()=>{
 for(const [tag,family] of [['horror','horror'],['Cosmic','scifi'],['Fantasy','fantasy'],['Noir','crime'],['Comedy','comedy'],['Western','adventure']]) assert.equal(selectFamily([row('a',[tag])]),family);
});
test('manual choices persist, auto follows changes, ids of different kinds stay separate',()=>{
 const db=new DatabaseSync(':memory:'); const svc=create(db);
 assert.deepEqual(svc.describe('order',1,[row('a',['Horror'])]),{choice:'auto',family:'horror'});
 svc.save('order',1,'comedy');
 assert.equal(svc.describe('order',1,[row('a',['Crime'])]).family,'comedy');
 assert.equal(svc.describe('collection',1,[row('a',['Crime'])]).family,'crime');
 svc.save('order',1,'auto');
 assert.equal(svc.describe('order',1,[row('a',['Crime'])]).family,'crime');
 svc.save('order',1,'default');
 assert.equal(svc.describe('order',1,[row('a',['Crime'])]).family,'default');
 assert.throws(()=>svc.save('order',1,'../../file'),/Unknown artwork/);
 db.close();
});
test('series metadata lookup deduplicates and batches beyond SQLite parameter limits',()=>{
 const db=new DatabaseSync(':memory:'); db.exec('CREATE TABLE scanned_series(id TEXT,series_json TEXT)');
 const insert=db.prepare('INSERT INTO scanned_series VALUES(?,?)');
 for(let i=0;i<901;i++) insert.run(String(i),row(i,['Comedy']).series_json);
 const svc=create(db), ids=Array.from({length:901},(_,i)=>String(i));
 assert.equal(svc.series([...ids,...ids]).length,901);
 assert.deepEqual(svc.series([]),[]);
 db.close();
});
