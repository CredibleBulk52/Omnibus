'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const create = require('./missingCatalog');

function setup(overrides = {}) {
  const db = new DatabaseSync(':memory:');
  db.transaction = fn => () => { db.exec('BEGIN'); try { const v=fn(); db.exec('COMMIT'); return v; } catch(e) { db.exec('ROLLBACK'); throw e; } };
  for (const t of ['event_issues','list_issues','canon_run_issues']) db.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY,series_name,issue_number,volume_year,cv_issue_id,scanned_book_id,manually_matched)`);
  db.exec(`CREATE TABLE scanned_books(id TEXT PRIMARY KEY,store_date,comicinfo,cv_issue_id);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value);
    CREATE TABLE crossover_links(id INTEGER PRIMARY KEY,from_series,to_series,from_book_id,to_book_id,from_issue,to_issue,from_year,to_year,from_cv_issue_id,to_cv_issue_id,hidden DEFAULT 0);
    CREATE TABLE book_ci_index(series_name,volume_year,orig_number,cv_issue_id);
    CREATE TABLE monitored_series(id,name,year);
    CREATE TABLE monitored_issues(id,series_id,issue_number,is_annual,cv_data);
    CREATE TABLE cv_volume_issues_cache(vol_id,issues)`);
  const catalog = create({db,hasKey:()=>true,logger:{warn(){}},background:fn=>fn(),issueDetails:async()=>null,...overrides});
  async function run() {
    catalog.start();
    while (catalog.status().running) await new Promise(resolve=>setImmediate(resolve));
    assert.ok(!catalog.status().last.error);
  }
  return { db,catalog,run };
}

test('scans accept one exact local identity, preserving ownership, existing IDs and issue suffixes', () => {
  const {db,catalog}=setup();
  db.exec(`INSERT INTO event_issues(id,series_name,volume_year,issue_number) VALUES
    (1,'Guest',2020,'01'),(2,'Guest',2020,'1.1'),(3,'Guest',2020,'1A'),(4,'Guest',2012,'1');
    INSERT INTO book_ci_index VALUES ('Guest',2020,'1','123'),('Guest',2020,'1.1','124'),('Guest',2020,'1.1','125');
    INSERT INTO canon_run_issues VALUES (5,'Guest','1',2020,'999',NULL,0)`);
  assert.equal(catalog.scan(),1);
  assert.deepEqual(db.prepare('SELECT cv_issue_id,scanned_book_id FROM event_issues ORDER BY id').all().map(Object.values),
    [['123',null],[null,null],[null,null],[null,null]]);
  assert.equal(db.prepare('SELECT cv_issue_id FROM canon_run_issues').get().cv_issue_id,'999');
});

test('online passes share volume requests, keep ambiguous rows pending and cache art by issue ID',async()=>{
  const searches=[],volumes=[];
  const {db,catalog,run}=setup({
    searchVolumes:async name=>{ searches.push(name);return (name==='Guest'?[21]:[31,32]).map(id=>({id,name,start_year:2026})); },
    volumeIssues:async id=>{ volumes.push(id);return [{id:456,issue_number:'0',store_date:'2026-06-10',image:{thumb_url:'https://comicvine.gamespot.com/cover.jpg'}}]; }
  });
  db.exec(`INSERT INTO list_issues VALUES (1,'Guest','0',2026,NULL,NULL,0);
    INSERT INTO event_issues VALUES (1,'Other','1',2026,NULL,NULL,0);
    INSERT INTO scanned_books VALUES ('anchor','2026-06-03',NULL,NULL);
    INSERT INTO crossover_links(from_book_id,to_series,to_issue) VALUES ('anchor','Guest','0')`);
  await run(); await run();
  assert.deepEqual(searches.sort(),['Guest','Other']);
  assert.deepEqual(volumes,['21']);
  assert.equal(catalog.cover('456'),'https://comicvine.gamespot.com/cover.jpg');
  assert.deepEqual(Object.values(db.prepare('SELECT to_cv_issue_id,to_book_id FROM crossover_links').get()),['456',null]);
  assert.equal(catalog.status().last.ambiguous,1);
});
