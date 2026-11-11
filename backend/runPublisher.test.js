const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');const {resolvePublisher,getRunPublisher}=require('./runPublisher');
test('publisher consensus respects aliases and excludes unknown or conflicting data',()=>{
 assert.equal(resolvePublisher(['DC','DC Comics',null,'Unknown']),'DC');
 assert.equal(resolvePublisher(['DC','Marvel']),null);
 assert.equal(resolvePublisher(['DC','Detective Comics'],[{key:'dc',aliases:'["detective"]'}]),'DC');
 assert.equal(resolvePublisher(['Unknown',null]),null);
});
test('run publisher uses matched issue and series metadata, not title guesses',()=>{
 const db=new DatabaseSync(':memory:');try{
 db.exec("CREATE TABLE monitored_series(id TEXT,publisher TEXT); CREATE TABLE scanned_series(id TEXT,series_json TEXT,monitored_series_id TEXT); CREATE TABLE scanned_books(id TEXT,series_id TEXT,comicinfo TEXT); CREATE TABLE canon_run_issues(run_id INTEGER,scanned_book_id TEXT); CREATE TABLE branding_assets(kind TEXT,key TEXT,aliases TEXT);");
 db.prepare('INSERT INTO monitored_series VALUES (?,?)').run('10','DC Comics');
 db.prepare('INSERT INTO scanned_series VALUES (?,?,?)').run('s',JSON.stringify({metadata:{publisher:'DC'}}),'10');
 db.prepare('INSERT INTO scanned_books VALUES (?,?,?)').run('b','s',JSON.stringify({publisher:'DC Comics'}));
 db.prepare('INSERT INTO canon_run_issues VALUES (?,?)').run(1,'b');
 assert.equal(getRunPublisher(db,{id:1},JSON.parse),'DC Comics');
 assert.equal(getRunPublisher(db,{id:2,cv_volume_id:'10'},JSON.parse),'DC Comics');
 assert.equal(getRunPublisher(db,{id:3,title:'Superman'},JSON.parse),null);
 db.prepare('UPDATE scanned_books SET comicinfo=?').run(JSON.stringify({publisher:'Marvel'}));
 assert.equal(getRunPublisher(db,{id:1},JSON.parse),null);
 db.prepare('UPDATE scanned_books SET comicinfo=?').run('broken');
 assert.equal(getRunPublisher(db,{id:1},JSON.parse),'DC');
 }finally{db.close();}
});
