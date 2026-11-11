'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createDeploymentGate}=require('./deploymentGate');
const {createLibraryAccess}=require('./libraryAccess');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('deployment waits through provider work and nested publication, without admitting new work',async()=>{
  const gate=createDeploymentGate(),access=createLibraryAccess({deploymentGate:gate});
  const provider=deferred(),published=deferred(),finish=deferred();
  const job=gate.run(async()=>{await provider.promise;await access.run('write',async()=>{published.resolve();await finish.promise;});});
  const drain=gate.drain(1000);assert.equal(gate.snapshot().draining,true);
  await assert.rejects(gate.run(()=>assert.fail()),{code:'DEPLOYMENT_PAUSED'});
  await assert.rejects(access.run('write',()=>assert.fail()),{code:'DEPLOYMENT_PAUSED'});
  await access.run('read',()=>{});
  provider.resolve();await published.promise;assert.equal(gate.snapshot().active,1);
  finish.resolve();await job;assert.equal(await drain,true);assert.equal(gate.snapshot().active,0);
});
test('drain timeout preserves active work and explicit resume restores admission',async()=>{
  const gate=createDeploymentGate(),finish=deferred();let completed=false;
  const job=gate.run(async()=>{await finish.promise;completed=true;});
  assert.equal(await gate.drain(5),false);assert.equal(completed,false);
  await assert.rejects(gate.run(()=>{}),{code:'DEPLOYMENT_PAUSED'});
  gate.resume();await gate.run(()=>{});finish.resolve();await job;assert.equal(completed,true);
});
test('drain includes already queued writers and tracked converter children',async()=>{
  const gate=createDeploymentGate(),access=createLibraryAccess({deploymentGate:gate}),finish=deferred(),child=deferred(),started=deferred();
  const first=access.run('write',async()=>{access.track(child.promise);started.resolve();await finish.promise;});
  await started.promise;let secondFinished=false;
  const second=access.run('write',()=>{secondFinished=true;});
  const drain=gate.drain(1000);finish.resolve();await new Promise(r=>setImmediate(r));
  assert.equal(secondFinished,false);assert.equal(gate.snapshot().active,2);
  child.resolve();await Promise.all([first,second]);assert.equal(await drain,true);assert.equal(secondFinished,true);
});
test('failed writes release drain accounting and stale async context cannot start more work',async()=>{
  const gate=createDeploymentGate();let later;
  await assert.rejects(gate.run(async()=>{later=new Promise(resolve=>setImmediate(()=>resolve(gate.run(()=>{}))));throw Error('failed');}));
  assert.equal(await gate.drain(),true);
  await assert.rejects(later,{code:'DEPLOYMENT_PAUSED'});
});
