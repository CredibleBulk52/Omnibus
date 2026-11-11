'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),vm=require('node:vm');
const {resolveExistingWithinRoot}=require('./pathSecurity');
const source=fs.readFileSync(require.resolve('./server'),'utf8');
const response=()=>({code:200,status(n){this.code=n;return this},json(body){this.body=body;return this}});
function fixture(mapping={}) {
  let listings=0;
  const fileSystem={realpathSync(p){if(p==='/comics/missing')throw Object.assign(Error('missing'),{code:'ENOENT'});return mapping[p] || p;},readdirSync(){listings++;return ['book.cbz'];}};
  const resolve=(root,target)=>resolveExistingWithinRoot(root,target,{fileSystem,paths:path.posix});
  return {fileSystem,resolve,get listings(){return listings}};
}
function handler(marker,f) {
  const start=source.indexOf(marker),end=source.indexOf('\n});',start);assert.ok(start>=0&&end>start);
  let route;
  vm.runInNewContext(source.slice(start,end+4),{app:{get:(...args)=>{route=args.at(-1)}},requireDownloadAccess(){},
    require:name=>{assert.equal(name,'./pathSecurity');return {resolveExistingWithinRoot:f.resolve}},fs:f.fileSystem,path:path.posix,COMICS_PATH:'/comics',
    acquireDiskCoverSlot(){throw Error('Must not extract a denied path')}});
  return route;
}
test('root containment rejects sibling prefixes, traversal and symlink escapes',()=>{
  const f=fixture({'/comics/link':'/private','/comics/link/nested':'/private/nested','/comics/alias':'/comics/DC'});
  for(const target of ['/comics-backup','/comics/../private','/comics/link','/comics/link/nested'])assert.throws(()=>f.resolve('/comics',target),e=>e.status===403);
  for(const target of ['/comics','/comics/DC','/comics/alias'])assert.ok(f.resolve('/comics',target).startsWith('/comics'));
  assert.throws(()=>f.resolve('/comics','/comics/missing'),e=>e.status===404);
  assert.throws(()=>f.resolve('/comics',{}),e=>e.status===400);
  const alias=fixture({'/library':'/mnt/comics','/library/DC':'/mnt/comics/DC'});
  assert.equal(alias.resolve('/library','/library/DC'),'/mnt/comics/DC');
});
test('filesystem browser denies escaped paths before listing',()=>{
  const f=fixture({'/comics/link':'/private'}),browse=handler("app.get('/api/filesystem/browse'",f);
  for(const target of ['/comics-backup','/comics/link']){const res=response();browse({query:{path:target}},res);assert.equal(res.code,403);}
  assert.equal(f.listings,0);
});
test('import cover denies escaped directory and symlinked comic before extraction',async()=>{
  const f=fixture({'/comics/DC/book.cbz':'/private/book.cbz'}),cover=handler("app.get('/api/import/disk-cover'",f);
  let res=response();await cover({query:{directory:'/comics-backup'}},res);assert.equal(res.code,403);assert.equal(f.listings,0);
  res=response();await cover({query:{directory:'/comics/DC'}},res);assert.equal(res.code,403);assert.equal(f.listings,1);
});

const {resolveCreatableWithinRoot}=require('./pathSecurity');
function creatable(existing,{links={},dangling=[]}={}) {
  const missing=()=>Object.assign(Error('missing'),{code:'ENOENT'});
  const fileSystem={
    realpathSync(p){if(links[p])return links[p];for(const [from,to] of Object.entries(links))if(p.startsWith(from+'/'))return to+p.slice(from.length);if(existing.includes(p))return p;throw missing();},
    lstatSync(p){if(dangling.includes(p)||existing.includes(p)||links[p])return {};throw missing();},
    existsSync:p=>existing.includes(p),mkdirSync(){throw Error('Must not create a denied folder')},readdirSync(){throw Error('Must not list a denied folder')}};
  return {fileSystem,resolve:(root,target)=>resolveCreatableWithinRoot(root,target,{fileSystem,paths:path.posix})};
}
test('creatable paths stay inside the root through symlinks and dangling links',()=>{
  const f=creatable(['/comics','/comics/DC','/private'],{links:{'/comics/link':'/private'},dangling:['/comics/broken']});
  assert.equal(f.resolve('/comics','/comics/DC/New Series (2026)'),'/comics/DC/New Series (2026)');
  assert.equal(f.resolve('/comics','/comics/A/B/C'),'/comics/A/B/C');
  assert.equal(f.resolve('/comics','/comics/DC'),'/comics/DC');
  for(const target of ['/comics-backup/x','/comics/../private/x','/comics/link/new','/comics/link','/comics/broken','/comics/broken/new'])
    assert.throws(()=>f.resolve('/comics',target),e=>e.status===403,target);
  assert.throws(()=>f.resolve('/comics',''),e=>e.status===400);
  assert.throws(()=>f.resolve('/comics',['/comics/x']),e=>e.status===400);
  assert.throws(()=>creatable([]).resolve('/comics','/comics/x'),e=>e.status===404);
});
function postRoute(marker,f,extra={}) {
  const start=source.indexOf(marker),end=source.indexOf('\n});',start);assert.ok(start>=0&&end>start);
  let route;
  vm.runInNewContext(source.slice(start,end+4),{app:{post:(...args)=>{route=args.at(-1)}},
    require:name=>{if(name==='./pathSecurity')return {resolveExistingWithinRoot:(r,t)=>resolveExistingWithinRoot(r,t,{fileSystem:f.fileSystem,paths:path.posix}),resolveCreatableWithinRoot:f.resolve};if(name==='fs')return f.fileSystem;throw Error('unexpected require '+name)},
    fs:f.fileSystem,path:path.posix,COMICS_PATH:'/comics',setTimeout:(fn)=>fn(),
    getCVKey(){throw Error('Must not reach Comic Vine for a denied path')},
    logger:{error(){},warn(){},info(){}},db:{prepare(){throw Error('Must not write a denied path')}},...extra});
  return route;
}
test('import scan, rescan and execute refuse folders outside the comics root',async()=>{
  const f=creatable(['/comics','/private'],{links:{'/comics/link':'/private'}});
  const scan=postRoute("app.post('/api/import/scan'",f);
  for(const scanPath of ['/comics-backup','/comics/link']){const res=response();await scan({body:{scanPath}},res);assert.equal(res.code,403,scanPath);}
  const rescan=postRoute("app.post('/api/import/rescan-one'",f);
  for(const directory of ['/comics-backup/X','/comics/link/X','/etc']){const res=response();await rescan({body:{directory,query:'x'}},res);assert.equal(res.code,403,directory);}
  const execute=postRoute("app.post('/api/import/execute'",f,{getCVKey:()=>'key'});
  const res=response();
  await execute({body:{selections:[{directory:'/comics-backup/X',cvId:'1',name:'X'},{directory:'/comics/link/Y',cvId:'2',name:'Y'},{directory:'/tmp/Z',cvId:'3',name:'Z'}]}},res);
  assert.equal(res.code,200);
  assert.deepEqual(JSON.parse(JSON.stringify(res.body.results.map(r=>[r.status,r.error]))),[['error','Access denied'],['error','Access denied'],['error','Access denied']]);
});

test('adding monitored series refuses unsafe destinations before mkdir or DB writes',async()=>{
  const f=creatable(['/comics','/private'],{links:{'/comics/link':'/private'},dangling:['/comics/broken']});
  const add=postRoute("app.post('/api/monitor/series',",f,{requireDownloadAccess(){},process:{env:{COMICS_PATH:'/comics'}}});
  for(const body of [
    {parentDir:'/private'}, {parentDir:'/comics-backup'}, {parentDir:'/comics/link'},
    {parentDir:'/comics/broken'}, {parentDir:'/comics',publisher:'..'}
  ]){const res=response();await add({body:{id:'1',name:'Test',year:2026,...body}},res);assert.equal(res.code,403,JSON.stringify(body));}
  const res=response();await add({body:{id:'1',name:'Test',parentDir:{bad:true}}},res);assert.equal(res.code,400);
});
test('adding monitored series still permits a new publisher folder inside comics',async()=>{
  const f=creatable(['/comics']);const created=[];f.fileSystem.mkdirSync=p=>created.push(p);
  const add=postRoute("app.post('/api/monitor/series',",f,{requireDownloadAccess(){},process:{env:{COMICS_PATH:'/comics'}},detectSeriesType:()=>'comic',db:{prepare(){throw Error('test-stop-before-insert')}}});
  const res=response();await add({body:{id:'1',name:'Test',year:2026,parentDir:'/comics',publisher:'DC'}},res);
  assert.deepEqual(created,['/comics/DC/Test (2026)']);assert.equal(res.body.error,'test-stop-before-insert');
});
