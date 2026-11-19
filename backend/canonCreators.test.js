const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {registerTopShelf}=require('./topShelf');

// Runs the real Notable Creators route (topShelf.js since the server.js split, 2026-11-19).
function creatorsRoute(db){
  const routes={};
  const app=new Proxy({},{get:(_,m)=>(p,...h)=>{routes[`${String(m).toUpperCase()} ${p}`]=h.at(-1);}});
  const none=()=>null;
  registerTopShelf({app,db,bookCvId:none,cvApiGet:none,getCVKey:none,getSeriesAwards:()=>[],logger:{info(){},warn(){},error(){},debug(){}},parseComicInfo:()=>({}),
    personPhotos:{resolve:async()=>null},requireAdmin:none,requireAuth:none,tidyBadge:x=>x});
  return routes['GET /api/canon/creators'];
}

test('creator shelf includes a single-run writer beyond the former top forty',async()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE canon_runs (id INTEGER PRIMARY KEY, status TEXT); CREATE TABLE canon_run_creators (run_id INTEGER, person_name TEXT, role TEXT); CREATE TABLE canon_run_categories (run_id INTEGER, category TEXT); CREATE TABLE cv_person_cache (name TEXT PRIMARY KEY, cv_person_id TEXT, image_url TEXT, cached_at TEXT);');
    const run=db.prepare('INSERT INTO canon_runs VALUES (?, ?)');
    const credit=db.prepare('INSERT INTO canon_run_creators VALUES (?, ?, ?)');
    const cat=db.prepare('INSERT INTO canon_run_categories VALUES (?, ?)');
    for(let i=1;i<=80;i++){run.run(i,'approved');credit.run(i,'Established '+Math.ceil(i/2),'writer');cat.run(i,'critically_acclaimed');}
    run.run(81,'approved');credit.run(81,'Mariko Tamaki','writer');cat.run(81,'award_winning');cat.run(81,'critically_acclaimed');
    run.run(82,'pending');credit.run(82,'Pending Writer','writer');cat.run(82,'critically_acclaimed');
    let rows;
    await creatorsRoute(db)({query:{},user:{sub:'u'}},{json:v=>{rows=v;},status(){return this;}});
    assert.equal(rows.length,41);assert.equal(rows.find(r=>r.name==='Mariko Tamaki').run_count,1);
    assert.equal(rows.some(r=>r.name==='Pending Writer'),false);
  } finally {db.close();}
});
