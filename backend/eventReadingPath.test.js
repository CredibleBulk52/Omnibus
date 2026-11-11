const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { eventReadingPath, getEventPathIssues } = require('./eventReadingPath');
const rows = [
 { scanned_book_id:'a',tier:'essential',completed:1 },
 { scanned_book_id:'b',tier:'recommended',completed:0 },
 { scanned_book_id:'c',tier:'tie-in',completed:0 },
 { scanned_book_id:'d',tier:'essential',completed:0 },
 { scanned_book_id:'e',tier:'aftermath',completed:0 }
];
test('all, recommended and essential select matching next and previous without changing history',()=>{
 const before=JSON.stringify(rows);
 assert.equal(eventReadingPath(rows,'a','all').next.scanned_book_id,'b');
 assert.equal(eventReadingPath(rows,'a','recommended').next.scanned_book_id,'b');
 assert.equal(eventReadingPath(rows,'a','essential').next.scanned_book_id,'d');
 assert.equal(eventReadingPath(rows,'d','essential').prev.scanned_book_id,'a');
 assert.equal(JSON.stringify(rows),before);
});
test('one-time detour resumes chosen path in both directions',()=>{
 const r=eventReadingPath(rows,'c','essential');
 assert.equal(r.next.scanned_book_id,'d'); assert.equal(r.prev.scanned_book_id,'a'); assert.equal(r.position,null);
});
test('final essential retains optional alternative and ignores optional completion',()=>{
 const r=eventReadingPath(rows,'d','essential');
 assert.equal(r.next,null); assert.equal(r.nextAll.scanned_book_id,'e'); assert.equal(r.remainingOther,0); assert.equal(r.total,2);
});
test('earlier unread gaps and missing files prevent false completion',()=>{
 const r=eventReadingPath([{tier:'essential',scanned_book_id:null},...rows.map(i=>({...i,completed:0}))],'d','essential');
 assert.equal(r.remainingOther,2); assert.equal(r.total,3); assert.equal(r.next,null);
});
test('unknown paths use All and unknown current issue never jumps to start',()=>{
 assert.equal(eventReadingPath(rows,'a','bad').next.scanned_book_id,'b');
 assert.equal(eventReadingPath(rows,'outside','essential').next,null);
});
test('database query isolates accounts, ignores anonymous progress and treats stale matches as missing',()=>{
 const db=new DatabaseSync(':memory:');
 try {
 db.exec(`CREATE TABLE event_issues(event_id TEXT,sort_order INTEGER,scanned_book_id TEXT,tier TEXT,tier_note TEXT,issue_title TEXT,series_name TEXT,issue_number TEXT);
 CREATE TABLE scanned_books(id TEXT,title TEXT,filename TEXT);
 CREATE TABLE read_progress(book_id TEXT,user_id TEXT,completed INTEGER);
 INSERT INTO scanned_books VALUES ('a','A','a.cbz');
 INSERT INTO event_issues VALUES ('event',1,'a','essential','note','title','Series','1'),('event',2,'deleted','essential',NULL,NULL,'Series','2');
 INSERT INTO read_progress VALUES ('a','reader',0),('a','other',1),('a',NULL,1);`);
 const mine=getEventPathIssues(db,'event','reader');assert.equal(mine.length,2);assert.equal(mine[0].completed,0);assert.equal(mine[1].scanned_book_id,null);
 assert.equal(getEventPathIssues(db,'event','other')[0].completed,1);
 assert.equal(getEventPathIssues(db,'event',null)[0].completed,null);
 } finally { db.close(); }
});
