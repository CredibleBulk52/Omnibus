const test=require('node:test'),assert=require('node:assert/strict');
const express=require('express'),sharp=require('sharp');
const {DatabaseSync}=require('node:sqlite');
const {registerBranding,assetKey}=require('./branding');
test('publisher aliases normalize while distinct character identities stay separate',()=>{assert.equal(assetKey('publisher','DC Comics'),'dc');assert.equal(assetKey('publisher','Marvel'),'marvel');assert.notEqual(assetKey('character','Superman'),assetKey('character','Supergirl'));});
test('authenticated artwork lifecycle, image validation and alias conflict checks',async()=>{
 const sqlite=new DatabaseSync(':memory:');
 const db={exec:s=>sqlite.exec(s),prepare:s=>{const stmt=sqlite.prepare(s);return {all:(...a)=>stmt.all(...a),run:(...a)=>stmt.run(...a),get:(...a)=>{const row=stmt.get(...a);if(row?.image)row.image=Buffer.from(row.image);return row;}};}};
 const app=express();app.use(express.json());
 const auth=(req,res,next)=>req.headers.authorization?next():res.sendStatus(401);
 const admin=(req,res,next)=>req.headers.authorization==='admin'?next():res.sendStatus(403);
 registerBranding(app,{db,express,sharp,requireAuth:auth,requireAdmin:admin});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const call=(path,method='GET',body,role='admin',type='application/json')=>fetch(base+'/api/branding'+path,{method,headers:{...(role?{Authorization:role}:{}),'Content-Type':type},body});
 try{
 assert.equal((await call('','GET',null,null)).status,401);
 const image=await sharp({create:{width:1000,height:200,channels:4,background:'#ef2222'}}).png().toBuffer();
 assert.equal((await call('/publisher/dc/image','PUT',image,'reader','image/png')).status,403);
 assert.equal((await call('/publisher/dc/image','PUT',Buffer.from('bad'),'admin','image/png')).status,400);
 assert.equal((await call('/publisher/dc/image','PUT',image,'admin','image/png')).status,200);
 let assets=await (await call('','GET',null,'reader')).json();assert.equal(assets.length,1);const version=assets[0].version;
 const bytes=Buffer.from(await (await call('/publisher/dc/image','GET',null,'reader')).arrayBuffer());const meta=await sharp(bytes).metadata();assert.equal(meta.width,640);assert.equal(meta.height,128);
 assert.equal((await call('/publisher/dc','PATCH',JSON.stringify({scale:.8,aliases:['DC Comics','Detective Comics']}))).status,200);
 assert.equal((await call('/publisher/dc','PATCH',JSON.stringify({scale:99,aliases:[]}))).status,400);
 assert.equal((await call('/publisher/detective/image','PUT',image,'admin','image/png')).status,409);
 assert.equal((await call('/publisher/marvel/image','PUT',image,'admin','image/png')).status,200);
 assert.equal((await call('/publisher/marvel','PATCH',JSON.stringify({scale:1,aliases:['DC']}))).status,409);
 assert.equal((await call('/publisher/dc/image','PUT',image,'admin','image/png')).status,200);
 assets=await (await call('')).json();const dc=assets.find(a=>a.key==='dc');assert.notEqual(dc.version,version);assert.equal(dc.scale,.8);assert.deepEqual(dc.aliases,['detective']);
 assert.equal((await call('/publisher/dc','DELETE',null,'reader')).status,403);
 assert.equal((await call('/publisher/dc','DELETE')).status,200);assert.equal((await call('/publisher/dc/image')).status,404);
 }finally{await new Promise(r=>server.close(r));sqlite.close();}
});
