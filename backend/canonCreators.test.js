const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {DatabaseSync}=require('node:sqlite');

test('creator shelf includes a single-run writer beyond the former top forty',()=>{
  const source=fs.readFileSync(require.resolve('./server.js'),'utf8');
  const route=source.slice(source.indexOf("app.get('/api/canon/creators'"));
  const sql=route.match(/const rows = db.prepare\(`([\s\S]*?)`\).all\(\)/)[1];
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE canon_runs (id INTEGER PRIMARY KEY, status TEXT); CREATE TABLE canon_run_creators (run_id INTEGER, person_name TEXT, role TEXT); CREATE TABLE canon_run_categories (run_id INTEGER, category TEXT);');
    const run=db.prepare('INSERT INTO canon_runs VALUES (?, ?)');
    const credit=db.prepare('INSERT INTO canon_run_creators VALUES (?, ?, ?)');
    const cat=db.prepare('INSERT INTO canon_run_categories VALUES (?, ?)');
    for(let i=1;i<=80;i++){run.run(i,'approved');credit.run(i,'Established '+Math.ceil(i/2),'writer');cat.run(i,'critically_acclaimed');}
    run.run(81,'approved');credit.run(81,'Mariko Tamaki','writer');cat.run(81,'award_winning');cat.run(81,'critically_acclaimed');
    run.run(82,'pending');credit.run(82,'Pending Writer','writer');cat.run(82,'critically_acclaimed');
    const rows=db.prepare(sql).all();
    assert.equal(rows.length,41);assert.equal(rows.find(r=>r.person_name==='Mariko Tamaki').run_count,1);
    assert.equal(rows.some(r=>r.person_name==='Pending Writer'),false);
  } finally {db.close();}
});
