'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {DatabaseSync}=require('node:sqlite');
const security=require('./authSecurity'),reader=require('./readerSecurity');
function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,role TEXT); INSERT INTO users VALUES('u','reader','user')");security.initializeAuthSchema(db);const tokens=security.createTokens({db,secret:'test-secret-at-least-thirty-two-characters'});return {db,tokens};}
function response(){return {code:200,headers:{},set(k,v){this.headers[k]=v;return this},vary(){},status(c){this.code=c;return this},json(b){this.body=b},cookie(k,v,o){this.cookieValue={k,v,o}},clearCookie(k,o){this.cleared={k,o}}};}
const source=fs.readFileSync(require.resolve('./server'),'utf8');
function gate(tokens){const start=source.indexOf("const PUBLIC_API_PREFIXES"),end=source.indexOf('\n});',start)+4;let handle;vm.runInNewContext(source.slice(start,end),{app:{use:(p,h)=>handle=h},readerSecurity:reader,authTokens:tokens,requireAuth:(req,res,next)=>{try{tokens.verify((req.headers.authorization||'').replace('Bearer ',''));next()}catch{res.status(401).json({})}},requireAdmin:()=>{throw Error('unexpected admin')}});return handle;}
test('server gate protects GET/HEAD reader pages and thumbnails, with no cookie access to write APIs',t=>{
 const {tokens}=fixture(t),token=tokens.sign({sub:'u'}),handle=gate(tokens);
 for(const path of ['/books/b/pages/0','/books/b/page-thumbs/0','/books/b/pages/0/','/BOOKS/b/PAGES/0'])for(const method of ['GET','HEAD']){
  let called=false,res=response();handle({path,method,headers:{}},res,()=>called=true);assert.equal(res.code,401);assert.equal(called,false);
  res=response();handle({path,method,headers:{cookie:'omnibus_reader='+token}},res,()=>called=true);assert.equal(called,true);assert.equal(res.headers['Cache-Control'],'private, no-store');
 }
 let called=false,res=response();handle({path:'/books/b/tag',method:'POST',headers:{cookie:'omnibus_reader='+token}},res,()=>called=true);assert.equal(res.code,401);assert.equal(called,false);
 res=response();handle({path:'/books/b/pages/0',method:'GET',headers:{authorization:'Bearer '+token}},res,()=>called=true);assert.equal(called,true);
});
test('revoking a session blocks bearer and reader cookie, survives token-service recreation, and leaves other sessions usable',t=>{
 const {db,tokens}=fixture(t),first=tokens.sign({sub:'u'}),second=tokens.sign({sub:'u'});assert.notEqual(first,second);
 tokens.revoke(first);assert.throws(()=>tokens.verify(first),security.SessionError);assert.equal(tokens.verify(second).sub,'u');
 const restarted=security.createTokens({db,secret:'test-secret-at-least-thirty-two-characters'});assert.throws(()=>restarted.verify(first),security.SessionError);
 const row=db.prepare('SELECT token_hash FROM revoked_sessions').get();assert.notEqual(row.token_hash,first);assert.match(row.token_hash,/^[a-f0-9]{64}$/);
 const res=response();reader.protectReader({headers:{cookie:'omnibus_reader='+first}},res,()=>assert.fail('revoked image allowed'),tokens);assert.equal(res.code,401);
});
test('reader cookie is scoped and expires with token; invalid bearer cannot fall back to cookie',t=>{
 const {tokens}=fixture(t),token=tokens.sign({sub:'u'}),res=response();reader.setReaderCookie({secure:true},res,token,tokens.verify(token));
 assert.equal(res.cookieValue.o.httpOnly,true);assert.equal(res.cookieValue.o.secure,true);assert.equal(res.cookieValue.o.sameSite,'strict');assert.equal(res.cookieValue.o.path,'/api/books');assert.ok(res.cookieValue.o.maxAge>0);
 reader.protectReader({headers:{authorization:'Bearer invalid',cookie:'omnibus_reader='+token}},res,()=>assert.fail('fallback'),tokens);assert.equal(res.code,401);
});
test('actual logout revokes with explicit bearer; operational failures do not falsely report sign-out',t=>{
 const {tokens}=fixture(t),token=tokens.sign({sub:'u'});let handle;const a=source.indexOf("app.post('/api/auth/logout'"),b=source.indexOf('\n});',a)+4;
 const load=authTokens=>vm.runInNewContext(source.slice(a,b),{app:{post:(p,h)=>handle=h},readerSecurity:reader,authSecurity:security,authTokens,requestToken:req=>(req.headers.authorization||'').replace('Bearer ','')});
 load(tokens);let res=response();handle({headers:{authorization:'Bearer '+token}},res);assert.equal(res.code,200);assert.ok(res.cleared);assert.throws(()=>tokens.verify(token));
 res=response();handle({headers:{authorization:'Bearer '+token}},res);assert.equal(res.code,401);assert.ok(res.cleared);
 load({revoke(){throw Error('disk unavailable')}});res=response();handle({headers:{}},res);assert.equal(res.code,500);assert.equal(res.cleared,undefined);
});
test('alternate base64 encodings cannot bypass logout revocation',t=>{
 const {tokens}=fixture(t),token=tokens.sign({sub:'u'});tokens.revoke(token);
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
 const last=alphabet.indexOf(token.at(-1));const alias=token.slice(0,-1)+alphabet[last+1];
 assert.deepEqual(Buffer.from(alias.split('.')[2],'base64url'),Buffer.from(token.split('.')[2],'base64url'));
 assert.throws(()=>tokens.verify(alias),security.SessionError);
});
