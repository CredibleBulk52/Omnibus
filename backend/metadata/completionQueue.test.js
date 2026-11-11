'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCompletionQueue}=require('./completionQueue');
const tick=()=>new Promise(r=>setImmediate(r));
const fs=require('node:fs'),path=require('node:path');
const serverSource=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const eventCode=serverSource.slice(serverSource.indexOf('const completeEventReconcile ='),serverSource.indexOf('// ─── Monitored issue ↔ book'));
function eventFixture({broken=false,items=[]}={}){
  const errors=[];let runs=0;
  const db={prepare(sql){return {
    run(){runs++;return {changes:1};},
    all(){return sql.includes('SELECT * FROM event_issues')?items:[];},
    get(){if(broken)throw Error('per-issue failure');return {id:'book',issue_number:'1'};},
  };}};
  const deps={db,require:()=>({createCompletionQueue}),setImmediate,bookIndex:{publishedAs:()=>false},IN:{normIssueNumber:String},logger:{error:(_,__,detail)=>errors.push(detail),info(){},warn(){}}};
  const reconcile=new Function(...Object.keys(deps),eventCode+'\nreturn reconcileEventIssues;')(...Object.values(deps));
  return {reconcile,errors,get runs(){return runs;}};
}
test('actual event reconciler queues callers until their own passes complete',async()=>{
  const f=eventFixture();await Promise.all([f.reconcile(true,{strict:true}),f.reconcile(true,{strict:true})]);assert.equal(f.runs,2);
});
test('actual event reconciler propagates per-issue failure in strict mode',async()=>{
  const f=eventFixture({broken:true,items:[{id:'event',series_name:'Example',issue_number:'1',cv_issue_id:'123'}]});
  await assert.rejects(f.reconcile(false,{strict:true}),/per-issue failure/);assert.equal(f.errors.length,1);
  await f.reconcile(false);assert.equal(f.errors.length,2);
});
test('event matching leaves manual/already populated links untouched at commit',()=>{
  const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(':memory:');
  try{
    db.exec("CREATE TABLE event_issues(id TEXT,scanned_book_id TEXT,manually_matched INTEGER);INSERT INTO event_issues VALUES('manual','chosen',1),('empty',NULL,0),('linked','existing',0)");
    const sql=eventCode.match(/const update = db.prepare\('([^']+)'\)/)[1],update=db.prepare(sql);
    for(const id of ['manual','empty','linked'])update.run('auto',id);
    assert.deepEqual(db.prepare('SELECT scanned_book_id FROM event_issues').all().map(r=>r.scanned_book_id),['chosen','auto','existing']);
  }finally{db.close();}
});
test('completion waits for its own pass and failures do not poison later work',async()=>{
  const queue=createCompletionQueue(),calls=[];let release;
  const first=queue(async()=>{calls.push('first');await new Promise(r=>release=r);throw Error('first failed');});
  const failure=assert.rejects(first,/first failed/);
  const second=queue(async()=>{calls.push('second');return 'complete';});
  await tick();assert.deepEqual(calls,['first']);release();await failure;
  assert.equal(await second,'complete');assert.deepEqual(calls,['first','second']);
});
for(const name of ['canonMatch','readingLists']){
  function fixture({fail=false}={}){
    let runs=0,broken=fail;const errors=[];
    // get: boxArtwork.create checks for tables (2026-11-05); transaction: readingLists moves Essentials into collections at start (essentialCollections.js, 2026-11-09).
    const db={exec(){},transaction:fn=>(...a)=>fn(...a),prepare:()=>({run(){runs++;if(broken)throw Error('fixture DB failure');return {changes:0};},all(){return [];},get(){return undefined;}})};
    const app=Object.fromEntries(['get','post','put','patch','delete'].map(k=>[k,()=>{}]));
    const api=require('../'+name)({app,db,logger:{error:(_,__,e)=>errors.push(e),info(){}},IN:{normIssueNumber:String}});
    return {api,errors,get runs(){return runs;},fix(){broken=false;}};
  }
  test(name+' callers await distinct complete runs, including a busy reconciler',async()=>{
    const f=fixture();const a=f.api.reconcile(true,{strict:true}),b=f.api.reconcile(true,{strict:true});
    await Promise.all([a,b]);assert.equal(f.runs,2);
  });
  test(name+' strict errors reach durable caller; later work can retry',async()=>{
    const f=fixture({fail:true});await assert.rejects(f.api.reconcile(true,{strict:true}),/fixture DB failure/);
    f.fix();await f.api.reconcile(true,{strict:true});assert.equal(f.runs,2);assert.equal(f.errors.length,1);
  });
  test(name+' legacy caller retains logged-error compatibility',async()=>{
    const f=fixture({fail:true});await f.api.reconcile(true);assert.equal(f.errors.length,1);
  });
}
