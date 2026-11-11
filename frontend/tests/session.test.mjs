import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareReaderSession,revokeSession} from '../src/session.mjs';
test('reader handshake sends explicit credentials before pages mount',async()=>{
 const result=await prepareReaderSession('token',async(url,options)=>{assert.equal(url,'/api/auth/reader-session');assert.equal(options.headers.Authorization,'Bearer token');assert.equal(options.method,'POST');assert.equal(options.credentials,'same-origin');return {ok:true,status:200}});assert.equal(result,'ready');
});
test('offline reading is distinguished from a revoked session',async()=>{
 assert.equal(await prepareReaderSession('t',async()=>{throw Error('offline')}),'offline');
 assert.equal(await prepareReaderSession('t',async()=>({ok:false,status:503})),'offline');
 assert.equal(await prepareReaderSession('t',async()=>({ok:false,status:401})),'invalid');
});
test('logout sends bearer and awaits completion, accepting already-invalid sessions',async()=>{
 let done;const pending=revokeSession('saved-token',async(url,options)=>{assert.equal(url,'/api/auth/logout');assert.equal(options.headers.Authorization,'Bearer saved-token');await new Promise(r=>done=r);return {ok:true,status:200}});
 let resolved=false;pending.then(()=>resolved=true);await Promise.resolve();assert.equal(resolved,false);done();await pending;assert.equal(resolved,true);
 await revokeSession('old',async()=>({ok:false,status:401}));
});
test('logout errors remain errors so local credentials are retained for retry',async()=>{
 await assert.rejects(revokeSession('t',async()=>({ok:false,status:500})));
 await assert.rejects(revokeSession('t',async()=>{throw Error('offline')}));
});
