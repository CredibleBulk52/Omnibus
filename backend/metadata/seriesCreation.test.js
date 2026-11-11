'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');const {createLibraryAccess}=require('./libraryAccess');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const code=source.slice(source.indexOf('async function createSeriesJsonIfMissing(series)'),source.indexOf('// ─── Manual series.json creation endpoint'));
for(const collision of [false,true])test('existing Python creator stages outside library and preserves concurrent JSON: '+collision,async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'omnibus-series-test-')),dir=path.join(root,'DC Comics','Series (2026)');
 t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('omnibus-series-test-'));fs.rmSync(root,{recursive:true,force:true});});
 const access=createLibraryAccess(),logger={debug(){},info(){},warn(){},error(...v){throw Error(JSON.stringify(v));}};let proc,args;
 const spawn=(_exe,a)=>{args=a;proc=new EventEmitter();proc.stdout=new EventEmitter();proc.stderr=new EventEmitter();return proc;};
 const db={prepare:()=>({get:()=>({directory:dir})})};
 const create=new Function('fs','path','DB_PATH','SCRIPTS_PATH','logger','yaml','buildEnricherConfig','nativeSpawn','libraryAccess','db','invalidateDirectoryExistsCache','invalidateSeriesJsonCache','patchSeriesJsonWithLocg','syncSeriesJsonRow','startEnricherRun','finishEnricherRun',code+';return createSeriesJsonIfMissing;')(fs,path,path.join(root,'app.db'),path.join(__dirname,'../../scripts'),logger,{dump:()=>''},()=>({}),spawn,access,db,()=>{},()=>{},()=>{},()=>{},()=>null,()=>{});
 const pending=create({id:'3995',directory:dir});assert.ok(proc);assert.notEqual(args[2],dir);assert.equal(args[args.indexOf('--context-folder')+1],dir);
 await access.run('read',()=>{});assert.equal(fs.existsSync(dir),false);
 fs.writeFileSync(path.join(args[2],'series.json'),JSON.stringify({metadata:{comicid:3995}}));
 if(collision){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'series.json'),'manual');}
 proc.stdout.emit('data',Buffer.from(JSON.stringify({success:true})));proc.emit('close',0);
 assert.equal(await pending,!collision);assert.equal(fs.readFileSync(path.join(dir,'series.json'),'utf8'),collision?'manual':JSON.stringify({metadata:{comicid:3995}}));assert.equal(fs.existsSync(args[2]),false);
});
