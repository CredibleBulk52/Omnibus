'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto'), fs = require('node:fs'), vm = require('node:vm');
const security = require('./authSecurity');
const secret = 'a-test-only-secret-with-at-least-32-characters';
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE, email TEXT UNIQUE, role TEXT, password_hash TEXT, authentik_id TEXT UNIQUE, last_login TEXT)`);
  security.initializeAuthSchema(db); security.initializeAuthSchema(db);
  db.prepare('INSERT INTO users(id,username,role,password_hash) VALUES (?,?,?,?)').run('admin-id','admin','admin','old-hash');
  db.transaction = fn => () => { db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value; } catch(e) { db.exec('ROLLBACK'); throw e; } };
  return db;
}
function response() { return { code:200, status(code){this.code=code;return this}, json(body){this.body=body;return this}, set(){return this}, redirect(url){this.url=url;return this}, clearCookie(){}, cookie(){} }; }
// Exercise the actual registered handlers without starting background jobs or the production DB.
const source = fs.readFileSync(require.resolve('./server'), 'utf8');
function handler(marker, globals = {}) {
  const start = source.indexOf(marker), end = source.indexOf('\n});', start);
  assert.ok(start >= 0 && end > start);
  let route;
  const register = (...args) => {route = args.at(-1)};
  vm.runInNewContext(source.slice(start,end+4), {app:{post:register,get:register,patch:register}, requireAdmin(){},requireAuth(){},authSecurity:security,logger:{error(){}},...globals});
  return route;
}
function signed(payload, header = {alg:'HS256',typ:'JWT'}) {
  const input = [header,payload].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return input+'.'+crypto.createHmac('sha256',secret).update(input).digest('base64url');
}
test('tokens honor current roles, deleted accounts, expiration and migration', t => {
  const db=fixture(t);let now=1000000;const tokens=security.createTokens({db,secret,now:()=>now});
  const token=tokens.sign({sub:'admin-id',role:'ignored'});
  assert.equal(tokens.verify(token).role,'admin');
  db.exec("UPDATE users SET role='user'");assert.equal(tokens.verify(token).role,'user');
  assert.throws(()=>tokens.verify(signed({sub:'admin-id',exp:2000,role:'admin'})));
  assert.throws(()=>tokens.verify(signed({sub:'admin-id',ver:1})));
  assert.throws(()=>tokens.verify(signed({sub:'admin-id',ver:1,exp:2000},{alg:'none',typ:'JWT'})));
  assert.throws(()=>tokens.verify(token.slice(0,-4)+'abcd'));
  now+=30*86400000;assert.throws(()=>tokens.verify(token));now=1000000;
  db.exec('DELETE FROM users');assert.throws(()=>tokens.verify(token));
});
test('missing, short and example signing secrets are refused', () => {
  for(const value of [undefined,'','short','change-me-in-production-use-long-random-string','change-me-to-a-long-random-string-before-going-live']) assert.throws(()=>security.validateSecret(value));
  assert.equal(security.validateSecret(secret),secret);
});
test('password reset and role change revoke tokens; blank password preserves existing hash', async t => {
  const db=fixture(t),tokens=security.createTokens({db,secret});
  const update=handler("app.patch('/api/users/:id'", {db,hashPassword:async p=>'hashed:'+p});
  let token=tokens.sign({sub:'admin-id'}),res=response();
  await update({params:{id:'admin-id'},body:{password:'',role:'admin',username:'admin'}},res);
  assert.equal(res.code,200);assert.equal(tokens.verify(token).role,'admin');
  assert.equal(db.prepare('SELECT password_hash FROM users').get().password_hash,'old-hash');
  await update({params:{id:'admin-id'},body:{password:'new-password'}},response());
  assert.throws(()=>tokens.verify(token));token=tokens.sign({sub:'admin-id'});
  await update({params:{id:'admin-id'},body:{role:'user'}},response());assert.throws(()=>tokens.verify(token));
  res=response();await update({params:{id:'admin-id'},body:{role:'made-up'}},res);assert.equal(res.code,400);
});
test('failed account edit rolls back all fields and does not revoke session', async t => {
  const db=fixture(t),tokens=security.createTokens({db,secret}),token=tokens.sign({sub:'admin-id'});
  db.prepare('INSERT INTO users(id,username,role) VALUES (?,?,?)').run('other','taken','user');
  const update=handler("app.patch('/api/users/:id'", {db,hashPassword:async p=>'hash:'+p}),res=response();
  await update({params:{id:'admin-id'},body:{role:'user',username:'taken',password:'new'}},res);
  assert.equal(res.code,409);assert.equal(tokens.verify(token).role,'admin');
  assert.equal(db.prepare('SELECT password_hash FROM users WHERE id=?').get('admin-id').password_hash,'old-hash');
});
test('malformed login responds before DB/hash work; async failure returns 500', async () => {
  const login=handler("app.post('/api/auth/login'",{db:{prepare(){throw Error('DB unavailable')}}});
  for(const body of [{username:{},password:'x'},{username:'admin',password:[]},{username:' ',password:'x'},{username:'admin',password:'x'.repeat(1025)}]) {
    const res=response();await login({body},res);assert.equal(res.code,400);
  }
  const res=response();await login({body:{username:'admin',password:'ok'}},res);assert.equal(res.code,500);
});
test('SSO collisions never link accounts or grant first-user admin rights', t => {
  const db=fixture(t);
  assert.throws(()=>security.resolveOidcUser(db,{sub:'attacker',preferred_username:'ADMIN'}));
  assert.equal(db.prepare('SELECT authentik_id FROM users WHERE id=?').get('admin-id').authentik_id,null);
  db.prepare('UPDATE users SET authentik_id=? WHERE id=?').run('existing-sub','admin-id');
  assert.equal(security.resolveOidcUser(db,{sub:'existing-sub',preferred_username:'renamed'}).id,'admin-id');
  assert.throws(()=>security.resolveOidcUser(db,{sub:'different-sub',preferred_username:'admin'}));
  db.exec('DELETE FROM users');assert.equal(security.resolveOidcUser(db,{sub:'first',preferred_username:'new'}).role,'user');
});
test('OIDC state is bound to browser, single-use, bounded and expiring', () => {
  let now=0,cookie;const state=security.createOidcState({now:()=>now,maxPending:1});
  const res={cookie(name,value,options){cookie=name+'='+value;assert.equal(options.httpOnly,true);assert.equal(options.secure,true)},clearCookie(){}};
  const key=state.begin({secure:true},res);
  assert.throws(()=>state.begin({secure:true},res));
  assert.equal(state.consume({query:{state:key},headers:{cookie:'omnibus_oidc=wrong'}},res),false);
  assert.equal(state.consume({query:{state:key},headers:{cookie}},res),true);
  assert.equal(state.consume({query:{state:key},headers:{cookie}},res),false);
  const expired=state.begin({secure:true},res);now=600000;
  assert.equal(state.consume({query:{state:expired},headers:{cookie}},res),false);
  assert.equal(state.consume({query:{state:[key]},headers:{}},res),false);
});
test('SSO callback rejects missing state before contacting provider', async () => {
  const callback=handler("app.get('/api/auth/callback'",{oidcState:security.createOidcState()}),res=response();
  await callback({query:{code:'unsolicited'},headers:{}},res);assert.equal(res.url,'/login?error=invalid_sso_state');
});
test('private collection membership is restricted to owner; public membership stays readable', async () => {
  let col={owner_id:'owner'};
  const read=handler("app.get('/api/collections/:id/series-ids'",{db:{prepare:()=>({get:()=>col})},collectionSeriesIds:()=>['series'],
    boxSharing:{canView:(c,u)=>!!c&&(!c.owner_id||c.owner_id===u||c.visibility==='shared')}});
  for(const [user,expected] of [['other',403],['owner',200]]){const res=response();await read({params:{id:'c'},user:{sub:user}},res);assert.equal(res.code,expected)}
  col={owner_id:null};const res=response();await read({params:{id:'c'},user:{sub:'other'}},res);assert.deepEqual(res.body,['series']);
  col={owner_id:'owner',visibility:'shared'};const shared=response();await read({params:{id:'c'},user:{sub:'other'}},shared);assert.deepEqual(shared.body,['series']);   // a shared box (2026-11-03)
});
test('successful login issues a session but concurrent reset cannot mint one from old password', async t => {
  const db=fixture(t),tokens=security.createTokens({db,secret});
  let reset=false;
  const login=handler("app.post('/api/auth/login'",{db,jwtSign:tokens.sign,verifyPassword:async()=>{
    if(reset)db.exec("UPDATE users SET password_hash='changed', auth_version=auth_version+1");return true;
  }});
  const req={body:{username:'admin',password:'old-password'}},res=response();
  await login(req,res);assert.equal(res.code,200);assert.equal(tokens.verify(res.body.token).role,'admin');
  reset=true;const rejected=response();await login(req,rejected);assert.equal(rejected.code,401);
});
test('valid browser-bound SSO still signs in an existing linked account',async t=>{
  const db=fixture(t);db.exec("UPDATE users SET authentik_id='known-sub'");
  const state=security.createOidcState(),tokens=security.createTokens({db,secret});let cookie;
  const key=state.begin({secure:true},{cookie:(k,v)=>cookie=k+'='+v});
  const callback=handler("app.get('/api/auth/callback'",{db,oidcState:state,jwtSign:tokens.sign,URLSearchParams,
    OIDC_BASE_URL:'https://identity.invalid',OIDC_REDIRECT_URI:'https://app.invalid/api/auth/callback',OIDC_CLIENT_ID:'test',OIDC_CLIENT_SECRET:'test',
    axios:{post:async()=>({data:{access_token:'fixture'}}),get:async()=>({data:{sub:'known-sub',preferred_username:'changed'}})}});
  const res=response();await callback({query:{code:'fixture-code',state:key},headers:{cookie}},res);
  const token=new URL(res.url,'https://app.invalid').searchParams.get('token');assert.equal(tokens.verify(token).sub,'admin-id');
});
test('cover handler preserves previous cover on rejection/failure and cleans up after success',async t=>{
  const db=fixture(t),path=require('node:path'),{Readable}=require('node:stream');
  db.exec("CREATE TABLE collections(id TEXT PRIMARY KEY, owner_id TEXT, cover_image TEXT, cover_position TEXT); INSERT INTO collections VALUES('c','owner','old.png',NULL)");
  const root=path.resolve('virtual-cover-fixture'),files=new Map([[path.join(root,'old.png'),Buffer.from('old')]]);let failWrite=false;
  const upload=handler("app.post('/api/collections/:id/cover'",{db,path,crypto,require,COLLECTION_COVERS_DIR:root,fs:{promises:{
    writeFile:async(p,body)=>{if(failWrite)throw Error('disk full');files.set(p,body)},unlink:async p=>files.delete(p)
  }}});
  function request(headers={}){const req=Readable.from([Buffer.from('image')]);Object.assign(req,{headers:{'content-type':'image/png',...headers},params:{id:'c'},query:{},user:{sub:'owner',role:'user'}});return req;}
  let res=response();await upload(request({'content-length':String(11*1024*1024)}),res);assert.equal(res.code,413);assert.equal(files.size,1);
  failWrite=true;res=response();await upload(request(),res);assert.equal(res.code,500);assert.equal(db.prepare('SELECT cover_image FROM collections').get().cover_image,'old.png');assert.equal(files.size,1);
  failWrite=false;res=response();await upload(request(),res);assert.equal(res.code,200);assert.equal(files.size,1);assert.equal(files.has(path.join(root,'old.png')),false);assert.equal(files.has(path.join(root,res.body.filename)),true);
});

test('central API guard blocks non-admins on mixed-case admin, debug and import paths', () => {
  const start = source.indexOf('const PUBLIC_API_PREFIXES =');
  const end = source.indexOf('\n});', source.indexOf("app.use('/api',", start));
  assert.ok(start >= 0 && end > start);
  let guard;
  const authenticate = (req, res, next) => req.user ? next() : res.status(401).json({error:'Unauthorised'});
  vm.runInNewContext(source.slice(start, end + 4), {
    app: {use: (prefix, middleware) => { assert.equal(prefix, '/api'); guard = middleware; }},
    readerSecurity: {READER_IMAGE: /never-match/},
    requireAuth: authenticate,
    requireAdmin: (req, res, next) => authenticate(req, res, () => req.user.role === 'admin' ? next() : res.status(403).json({error:'Forbidden'}))
  });
  for (const path of ['/import/execute', '/IMPORT/execute', '/ImPoRt/scan', '/DEBUG/path', '/AdMiN/location']) {
    for (const method of ['GET', 'POST', 'HEAD']) {
      for (const [user, expected] of [[undefined, 401], [{role:'user'}, 403], [{role:'admin'}, 200]]) {
        const res = response(); let reached = false;
        guard({path, method, user}, res, () => { reached = true; });
        assert.equal(res.code, expected, method + ' ' + path);
        assert.equal(reached, expected === 200, method + ' ' + path);
      }
    }
  }
  let reached = false;
  guard({path:'/series',method:'GET',user:{role:'user'}},response(),()=>{reached=true});
  assert.equal(reached,true);
});
