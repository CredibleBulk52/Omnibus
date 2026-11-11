'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {maintenanceWindow}=require('./maintenanceWindow');
const {waitForRoutineSlot}=require('./routinePacing');
const {respondToCheck}=require('./respondToCheck');
const {metadataRequestDiagnostics}=require('./requestDiagnostics');
const {EventEmitter}=require('node:events');
test('Central window follows winter, summer and both DST transitions',()=>{
 for(const [instant,open,next] of [
 ['2026-01-12T06:59:00Z',false,'2026-01-12T07:00:00Z'],
 ['2026-01-12T07:00:00Z',true],['2026-01-12T12:00:00Z',false,'2026-01-13T07:00:00Z'],
 ['2026-07-12T06:00:00Z',true],['2026-07-12T11:00:00Z',false,'2026-07-13T06:00:00Z'],
 ['2026-03-08T06:59:00Z',false,'2026-03-08T07:00:00Z'],['2026-03-08T08:00:00Z',true],
 ['2026-11-01T06:00:00Z',true],['2026-11-01T07:00:00Z',true],['2026-11-01T12:00:00Z',false,'2026-11-02T07:00:00Z']]){
 const w=maintenanceWindow(Date.parse(instant));assert.equal(w.open,open,instant);assert.equal(w.nextStart,next?Date.parse(next):null,instant);
 }
});
test('routine pacing leaves 24 seconds after resource traffic and rechecks other callers',async()=>{
 let time=100000,last=99000;const waits=[];
 await waitForRoutineSlot({now:()=>time,readLast:()=>last,sleep:async ms=>{waits.push(ms);time+=ms;if(waits.length===1)last=time-1000;}});
 assert.deepEqual(waits,[23000,23000]);
});
function response(){return {statusCode:200,status(n){this.statusCode=n;return this;},json(value){this.body=value;}};}
test('short checks return their result; long checks return 202 without repeating work',async()=>{
 const res=response(),logs=[],logger={warn:(...a)=>logs.push(a)};
 await respondToCheck({work:Promise.resolve({completed:1}),res,logger});assert.equal(res.body.completed,1);
 let reject;const work=new Promise((_,r)=>reject=r),slow=response();
 await respondToCheck({work,res:slow,logger,waitMs:1});assert.equal(slow.statusCode,202);assert.equal(slow.body.started,true);
 reject(Error('late failure'));await new Promise(setImmediate);assert.equal(logs.length,1);
 const closed={...response(),destroyed:true};await respondToCheck({work:Promise.resolve({}),res:closed,logger});assert.equal(closed.body,undefined);
});
test('diagnostics record disconnected and failed responses without logging query strings',()=>{
 let time=0;const logs=[],middleware=metadataRequestDiagnostics({now:()=>time,logger:{warn:(...a)=>logs.push(a)}});
 function start(){const res=new EventEmitter();res.statusCode=200;res.setHeader=()=>{};middleware({path:'/api/admin/metadata-status',method:'GET',url:'/api/admin/metadata-status?secret=hidden'},res,()=>{});return res;}
 let res=start();res.emit('finish');res.emit('close');assert.equal(logs.length,0);
 res=start();res.emit('close');assert.equal(logs.length,1);assert.ok(logs[0][2].requestId);assert.ok(!JSON.stringify(logs).includes('hidden'));
 res=start();res.statusCode=500;res.emit('finish');res.emit('close');assert.equal(logs.length,2);
 res=start();time=3000;res.emit('finish');assert.equal(logs.length,3);
});
