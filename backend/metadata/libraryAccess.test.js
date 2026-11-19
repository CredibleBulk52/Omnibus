'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createLibraryAccess,coordinateLibraryRoutes,WRITE_ROUTES,READ_ROUTES}=require('./libraryAccess');
const tick=()=>new Promise(r=>setImmediate(r));
function latch(){let release;const promise=new Promise(r=>release=r);return {promise,release};}
test('single-series writer permits unrelated image reads but fences its series and broad consumers',async()=>{
  const a=createLibraryAccess(),stop=latch(),events=[];
  const writing=a.run('write',()=>stop.promise,{scope:'series:a'});await tick();
  const same=a.run('read',()=>events.push('same'),{scope:'series:a'});
  const global=a.run('read',()=>events.push('global'));
  await a.run('read',()=>events.push('other'),{scope:'series:b'});
  assert.deepEqual(events,['other']);stop.release();await Promise.all([writing,same,global]);
  assert.deepEqual(events,['other','same','global']);
});
test('a queued scoped writer does not delay unrelated images; writers remain serialized',async()=>{
  const a=createLibraryAccess(),stop=latch(),writerStop=latch(),events=[];
  const reading=a.run('read',()=>stop.promise,{scope:'series:a'});await tick();
  const writing=a.run('write',async()=>{events.push('writer');await writerStop.promise;},{scope:'series:a'});
  const same=a.run('read',()=>events.push('same'),{scope:'series:a'});
  await a.run('read',()=>events.push('other'),{scope:'series:b'});
  assert.deepEqual(events,['other']);stop.release();await reading;await tick();
  const second=a.run('write',()=>events.push('second writer'),{scope:'series:b'});await tick();
  assert.deepEqual(events,['other','writer']);writerStop.release();await Promise.all([writing,same,second]);
  assert.deepEqual(events,['other','writer','same','second writer']);
});
test('global writers still fence every series and scoped helpers cannot widen ownership',async()=>{
  const a=createLibraryAccess(),stop=latch();let read=false;
  const writing=a.run('write',()=>stop.promise);await tick();
  const reading=a.run('read',()=>{read=true;},{scope:'series:b'});await tick();assert.equal(read,false);
  stop.release();await Promise.all([writing,reading]);
  await a.run('write',async()=>{
    await assert.rejects(a.run('read',()=>{}, {scope:'series:b'}),{code:'LIBRARY_SCOPE_CHANGE'});
    await assert.rejects(a.run('read',()=>{}, {scope:null}),{code:'LIBRARY_SCOPE_CHANGE'});
    await a.run('read',()=>{});
  },{scope:'series:a'});
});
test('HTTP route resolves current series after queued book movement before reading',async()=>{
  let scope='series:a';const a=createLibraryAccess(),stop=latch(),events=[];
  const writing=a.run('write',async()=>{await stop.promise;scope='series:b';});await tick();
  const handler=a.route('read',()=>events.push(scope),()=>scope);
  const reading=handler({}, {headersSent:false,status(){return this;},json(){assert.fail('unexpected response');}});
  stop.release();await Promise.all([writing,reading]);assert.deepEqual(events,['series:b']);
});
test('actual book image and series thumbnail handlers serve unrelated images through nested archive wrappers',async()=>{
  // covers.js and archiveFiles.js since the server.js split (2026-11-19): the real modules, wrapped
  // for library reads as server.js does once it has loaded.
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const a=createLibraryAccess(),routes=new Map();
  const app={get(route,...handlers){routes.set(route,handlers.at(-1));},post(){},delete(){}};
  const db={prepare(){return {get:id=>({id,path:'/library/'+id+'.cbz',series_id:id,filename:id+'.cbz'}),all:id=>[{id,path:'/library/'+id+'.cbz',series_id:id,filename:id+'.cbz',issue_number:'1',is_special:0}]};}};
  coordinateLibraryRoutes(app,a,{readScope:require('../covers').readScope(()=>db)});
  const execFileAsync=(file,args)=>a.run('read',()=>({stdout:args[0]==='l'?'Path = 001.jpg\n':Buffer.from('fixture-image')}));
  const quiet={error(){},debug(){},warn(){},info(){}};
  const archive=require('../archiveFiles').createArchiveFiles({execFileAsync,logger:quiet});
  const listArchiveFiles=a.wrap('read',archive.listArchiveFiles);
  const {coverThumb}=require('../coverThumb');   // resizes cached covers; the fixture is not an image, so it passes through
  const dbDir=fs.mkdtempSync(path.join(os.tmpdir(),'omnibus-covers-'));
  try{
    const covers=require('../covers').createCovers({app,coverThumb,db,dbDir,filterImages:archive.filterImages,listArchiveFiles,logger:quiet,readArchiveMember:archive.readArchiveMember,requireAdmin:()=>{}});
    covers.wrapReads(a.wrap);
    const response=()=>({headersSent:false,code:200,set(){},status(code){this.code=code;return this;},send(value){this.body=value;},json(value){this.body=value;},sendFile(file){this.body=fs.readFileSync(file);}});
    const stop=latch(),writer=a.run('write',()=>stop.promise,{scope:'series:a'});await tick();
    try{
      for(const route of ['/api/books/:id/pages','/api/books/:id/pages/:page','/api/books/:id/thumbnail','/api/series/:id/thumbnail']){
        const res=response();await routes.get(route)({params:{id:'b',page:'0'}},res);
        assert.equal(res.code,200,route);
        if(route.endsWith('/pages'))assert.deepEqual(res.body,{count:1});else assert.equal(res.body.toString(),'fixture-image');
      }
    }finally{stop.release();await writer;}
  }finally{fs.rmSync(dbDir,{recursive:true,force:true});}
});
test('readers overlap; a queued writer drains them and blocks later readers',async()=>{
  const a=createLibraryAccess(),stop=latch(),events=[];
  const first=a.run('read',async()=>{events.push('r1');await stop.promise;await a.run('read',()=>events.push('nested'));});
  const second=a.run('read',async()=>{events.push('r2');await stop.promise;});
  await tick();assert.equal(a.snapshot().readers,2);
  const writer=a.run('write',()=>events.push('w')),later=a.run('read',()=>events.push('r3'));
  await tick();assert.deepEqual(events,['r1','r2']);stop.release();await Promise.all([first,second,writer,later]);
  assert.deepEqual(events,['r1','r2','nested','w','r3']);assert.deepEqual(a.snapshot(),{readers:0,writer:false,queued:0});
});
test('nested writer and reader helpers reuse the outer writer',async()=>{
  const a=createLibraryAccess();await a.run('write',async()=>{
    a.assertWrite();await a.run('write',()=>a.run('read',()=>assert.equal(a.snapshot().writer,true)));
  });assert.equal(a.snapshot().writer,false);
});
test('reader upgrade rejects instead of waiting on itself',async()=>{
  const a=createLibraryAccess();await a.run('read',()=>assert.rejects(a.run('write',()=>assert.fail()),{code:'LIBRARY_LOCK_UPGRADE'}));
});
test('cancelled queued work never runs and leaves the queue usable',async()=>{
  const a=createLibraryAccess(),stop=latch(),controller=new AbortController();
  const reader=a.run('read',()=>stop.promise);await tick();
  const cancelled=a.run('write',()=>assert.fail(),{signal:controller.signal});const rejected=assert.rejects(cancelled,{code:'ARCHIVE_CANCELLED'});
  controller.abort();await rejected;stop.release();await reader;await a.run('write',()=>{});assert.equal(a.snapshot().queued,0);
});
test('cancelling an active request does not release an active consumer',async()=>{
  const a=createLibraryAccess(),stop=latch(),controller=new AbortController();let wrote=false;
  const reader=a.run('read',()=>stop.promise,{signal:controller.signal});await tick();controller.abort();
  const writer=a.run('write',()=>{wrote=true;});await tick();assert.equal(wrote,false);stop.release();await Promise.all([reader,writer]);
});
test('detached child keeps its scope until settled even when the parent throws',async()=>{
  const a=createLibraryAccess(),stop=latch();let wrote=false;
  const parent=a.run('read',()=>{void a.run('read',()=>stop.promise);throw Error('parent failed');});
  const rejected=assert.rejects(parent,/parent failed/);await tick();const writer=a.run('write',()=>{wrote=true;});
  await tick();assert.equal(wrote,false);stop.release();await Promise.all([rejected,writer]);assert.equal(wrote,true);
});
test('actual child close is awaited after its launching handler returns',async()=>{
  const {spawn}=require('node:child_process'),a=createLibraryAccess();let closed=false;
  await a.run('write',()=>{
    const p=spawn(process.execPath,['-e','setTimeout(()=>{},20)'],{windowsHide:true});
    void a.track(new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',()=>{closed=true;resolve();});}));
  });assert.equal(closed,true);assert.equal(a.snapshot().writer,false);
});
test('late callback inheriting a finished scope must reacquire access',async()=>{
  const a=createLibraryAccess(),invoke=latch(),started=latch(),stop=latch();let late,ran=false;
  await a.run('read',()=>{late=(async()=>{await invoke.promise;return a.run('read',()=>{ran=true;});})();});
  const writer=a.run('write',async()=>{started.release();await stop.promise;});await started.promise;invoke.release();await tick();
  assert.equal(ran,false);stop.release();await Promise.all([writer,late]);assert.equal(ran,true);
});
test('admission rejection cannot admit a writer while another reader remains',async()=>{
  let rejectRead=false;const a=createLibraryAccess({admit:mode=>{if(rejectRead&&mode==='read')throw Error('held');}}),stop=latch();
  const reader=a.run('read',()=>stop.promise);await tick();rejectRead=true;
  await assert.rejects(a.run('read',()=>{}),/held/);let wrote=false;const writer=a.run('write',()=>{wrote=true;});await tick();
  assert.equal(wrote,false);stop.release();await Promise.all([reader,writer]);
});
test('route installation preserves auth and unrelated cancellation handlers',()=>{
  const calls=[],app={};for(const method of ['get','post','delete'])app[method]=function(...args){calls.push({method,args});return this;};
  const a=createLibraryAccess(),auth=()=>{},handler=()=>{};coordinateLibraryRoutes(app,a);
  for(const [method,routes]of Object.entries({...WRITE_ROUTES,...READ_ROUTES}))for(const route of routes)app[method](route,auth,handler);
  for(const c of calls){assert.equal(c.args[1],auth);assert.notEqual(c.args[2],handler);}
  app.post('/api/downloads/:id/cancel',auth,handler);assert.equal(calls.at(-1).args[2],handler);
});
test('route barrier errors return a reviewable response before the handler writes',async()=>{
  const a=createLibraryAccess({admit:()=>{throw Object.assign(Error('Recovery required'),{code:'LIBRARY_RECOVERY_REQUIRED'});}}),res={headersSent:false,status(n){this.code=n;return this;},json(value){this.body=value;}};
  await a.route('write',()=>assert.fail())({},res,()=>{});assert.equal(res.code,409);assert.equal(res.body.code,'LIBRARY_RECOVERY_REQUIRED');
});
test('actual thumbnail limiter keeps each queued callback in its own reader scope',{timeout:2000},async()=>{
  // covers.js since the server.js split (2026-11-19), with one extraction at a time.
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dbDir=fs.mkdtempSync(path.join(os.tmpdir(),'omnibus-slot-'));
  try{
    const none=()=>{};
    const covers=require('../covers').createCovers({app:{get:none,post:none,delete:none},coverThumb:none,db:{},dbDir,filterImages:none,listArchiveFiles:none,logger:{},readArchiveMember:none,requireAdmin:none,thumbConcurrency:1});
    const a=createLibraryAccess(),slot=a.wrap('read',covers.withThumbSlot),stop=latch(),events=[];
    const one=slot(async()=>{events.push('one');await stop.promise;});await tick();
    const two=slot(()=>a.run('read',()=>events.push('two')));await tick();
    const writer=a.run('write',()=>events.push('writer'));stop.release();await Promise.all([one,two,writer]);assert.deepEqual(events,['one','two','writer']);
  }finally{fs.rmSync(dbDir,{recursive:true,force:true});}
});
test('actual ZIP ComicInfo reader waits for descriptor close before releasing access',async()=>{
  const fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events');
  const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),code=source.slice(source.indexOf('function readZipComicInfo('),source.indexOf('\nasync function readRarComicInfo('));
  const zip=new EventEmitter();let closeRequested=false,finished=false;
  zip.readEntry=()=>queueMicrotask(()=>zip.emit('end'));zip.close=()=>{closeRequested=true;};
  const requireFake=()=>({open:(_file,_options,callback)=>callback(null,zip)});
  const read=new Function('require',code+';return readZipComicInfo;')(requireFake),a=createLibraryAccess();
  const reading=a.run('read',()=>read('fixture').then(result=>{assert.equal(result,'');finished=true;}));await tick();
  assert.equal(closeRequested,true);assert.equal(finished,false);
  let wrote=false;const writer=a.run('write',()=>{wrote=true;});await tick();assert.equal(wrote,false);
  zip.emit('close');await Promise.all([reading,writer]);assert.equal(finished,true);
});
