'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {createMetadataReconciliation}=require('./reconciliation');
test('report separates stored identity disagreements and clears only dangling monitoring links idempotently',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(`CREATE TABLE scanned_books(id TEXT PRIMARY KEY,filename TEXT,comicinfo TEXT,cv_issue_id TEXT,monitored_issue_id TEXT,sort_order REAL);CREATE TABLE monitored_issues(id TEXT PRIMARY KEY);CREATE TABLE read_progress(book_id TEXT,page INTEGER);INSERT INTO monitored_issues VALUES('1');INSERT INTO read_progress VALUES('a',12)`);
 const insert=db.prepare('INSERT INTO scanned_books VALUES(?,?,?,?,?,?)');insert.run('a','A.cbz','<ComicInfo><Notes>CVDB1</Notes></ComicInfo>','1','gone',1.5);insert.run('b','B.cbz','<ComicInfo><Notes>CVDB2</Notes></ComicInfo>',null,'1',2);insert.run('c','C.cbz','<ComicInfo><Notes>CVDB3</Notes></ComicInfo>','4',null,3);
 const service=createMetadataReconciliation({db}),before=db.prepare('SELECT * FROM scanned_books').all(),report=service.report();assert.equal(report.danglingMonitoring,1);assert.equal(report.missingIndexedIdentity,1);assert.equal(report.identityConflict,1);
 assert.deepEqual(db.prepare('SELECT * FROM scanned_books').all(),before);assert.equal(service.clearDangling().cleared,1);assert.equal(service.clearDangling().cleared,0);
 const after=db.prepare('SELECT * FROM scanned_books').all();before[0].monitored_issue_id=null;assert.deepEqual(after,before);assert.equal(db.prepare('SELECT page FROM read_progress').get().page,12);
});
test('cleanup rechecks newly restored monitoring records rather than applying stale report decisions',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(`CREATE TABLE scanned_books(id TEXT,filename TEXT,comicinfo TEXT,cv_issue_id TEXT,monitored_issue_id TEXT);CREATE TABLE monitored_issues(id TEXT);INSERT INTO scanned_books VALUES('a','A.cbz',NULL,NULL,'restored')`);
 const service=createMetadataReconciliation({db});assert.equal(service.report().danglingMonitoring,1);db.exec("INSERT INTO monitored_issues VALUES('restored')");assert.equal(service.clearDangling().cleared,0);
});
test('actual monitor-removal transaction clears parent and exclusive annual references but retains shared annual links',t=>{
 const fs=require('fs'),path=require('path');const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE scanned_books(id TEXT PRIMARY KEY,monitored_issue_id TEXT,cv_issue_id TEXT);CREATE TABLE monitored_issues(id TEXT PRIMARY KEY,series_id TEXT);CREATE TABLE monitored_series(id TEXT PRIMARY KEY,directory TEXT);CREATE TABLE series_annual_links(parent_series_id TEXT,annual_series_id TEXT);CREATE TABLE series_packs(series_id TEXT);
 INSERT INTO monitored_series VALUES('parent','P'),('own','O'),('shared','S'),('other','T');INSERT INTO series_annual_links VALUES('parent','own'),('parent','shared'),('other','shared');INSERT INTO monitored_issues VALUES('1','parent'),('2','own'),('3','shared');INSERT INTO scanned_books VALUES('a','1','1'),('b','2','2'),('c','3','3')`);
 db.transaction=fn=>()=>{db.exec('BEGIN');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}};
 const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');const start=source.indexOf('function removeMonitoredSeriesRows(id) {'),end=source.indexOf("app.delete('/api/monitor/series/:id'",start);assert.ok(start>0&&end>start);
 const remove=new Function('db',source.slice(start,end)+';return removeMonitoredSeriesRows;')(db);assert.equal(remove('parent').length,1);
 assert.deepEqual(db.prepare('SELECT monitored_issue_id FROM scanned_books ORDER BY id').all().map(r=>r.monitored_issue_id),[null,null,'3']);assert.equal(db.prepare("SELECT cv_issue_id FROM scanned_books WHERE id='a'").get().cv_issue_id,'1');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM series_annual_links').get().n,1);
});
