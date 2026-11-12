'use strict';
const crypto = require('node:crypto');
class SessionError extends Error {}
function validateSecret(secret) {
  if (typeof secret !== 'string' || secret.trim().length < 32 || /change.me|your[_-]|placeholder/i.test(secret)) {
    throw new Error('JWT_SECRET must be a non-placeholder secret of at least 32 characters. Generate one with openssl rand -hex 32.');
  }
  return secret;
}
function initializeAuthSchema(db) {
  db.exec('CREATE TABLE IF NOT EXISTS revoked_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
  if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'auth_version')) {
    db.exec('ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1');
  }
}
function createTokens({ db, secret, expiresDays = 30, now = Date.now }) {
  validateSecret(secret);
  const account = db.prepare('SELECT id, username, role, auth_version FROM users WHERE id = ?');
  const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
  const revoked = db.prepare('SELECT 1 FROM revoked_sessions WHERE token_hash = ?');
  const prune = () => db.prepare('DELETE FROM revoked_sessions WHERE expires_at <= ?').run(Math.floor(now() / 1000));
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = value => crypto.createHmac('sha256', secret).update(value).digest();
  function sign({ sub }) {
    const user = account.get(sub);
    if (!user) throw new SessionError('Account no longer exists');
    prune();
    const iat = Math.floor(now() / 1000);
    const body = part({ sub: user.id, username: user.username, role: user.role, ver: user.auth_version, jti: crypto.randomUUID(), iat, exp: iat + expiresDays * 86400 });
    const input = `${part({ alg: 'HS256', typ: 'JWT' })}.${body}`;
    return `${input}.${signature(input).toString('base64url')}`;
  }
  function verify(token) {
    if (typeof token !== 'string' || token.length > 8192) throw new SessionError('Invalid token');
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new SessionError('Malformed token');
    const [header, body, sig] = parts;
    const expected = signature(`${header}.${body}`), actual = Buffer.from(sig, 'base64url');
    if (actual.length !== expected.length || actual.toString('base64url') !== sig || !crypto.timingSafeEqual(actual, expected)) throw new SessionError('Invalid signature');
    let meta, payload;
    try { meta = JSON.parse(Buffer.from(header, 'base64url').toString()); payload = JSON.parse(Buffer.from(body, 'base64url').toString()); }
    catch { throw new SessionError('Malformed token'); }
    if (!meta || !payload) throw new SessionError('Malformed token');
    if (meta.alg !== 'HS256' || meta.typ !== 'JWT' || typeof payload.sub !== 'string' ||
        !Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(now() / 1000) ||
        !Number.isSafeInteger(payload.ver)) throw new SessionError('Invalid or expired token');
    if (revoked.get(tokenHash(token))) throw new SessionError('Session revoked');
    const user = account.get(payload.sub);
    if (!user || user.auth_version !== payload.ver || !['admin', 'user'].includes(user.role)) throw new SessionError('Session revoked');
    return { ...payload, username: user.username, role: user.role };
  }
  function revoke(token) {
    const payload = verify(token);
    prune();
    db.prepare('INSERT OR IGNORE INTO revoked_sessions(token_hash, expires_at) VALUES (?,?)').run(tokenHash(token), payload.exp);
  }
  return { sign, verify, revoke };
}
// The HttpOnly browser nonce binds a single-use, ten-minute state to its browser.
function createOidcState({ now = Date.now, maxPending = 1000 } = {}) {
  const pending = new Map(), cookieName = 'omnibus_oidc';
  const options = req => ({ httpOnly: true, sameSite: 'lax', secure: !!req.secure, path: '/api/auth' });
  function begin(req, res) {
    for (const [key, entry] of pending) if (entry.expires <= now()) pending.delete(key);
    if (pending.size >= maxPending) throw new Error('Too many pending sign-ins; try again shortly');
    const state = crypto.randomBytes(32).toString('hex'), nonce = crypto.randomBytes(32).toString('hex');
    pending.set(state, { nonce, expires: now() + 600000 });
    res.cookie(cookieName, nonce, { ...options(req), maxAge: 600000 });
    return state;
  }
  function consume(req, res) {
    const state = req.query?.state;
    const nonce = String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    res.clearCookie(cookieName, options(req));
    if (typeof state !== 'string') return false;
    const entry = pending.get(state);
    if (!entry || entry.expires <= now()) { pending.delete(state); return false; }
    if (!nonce || nonce !== entry.nonce) return false;
    pending.delete(state);
    return true;
  }
  return { begin, consume };
}
// Failed local sign-ins (security review 2026-11-12). Two windows: one per account
// (stops guessing one password from many addresses) and one per client address
// (stops trying many accounts). Kept in memory; a restart clears it.
function createLoginLimiter({ perUser = 20, perAddress = 30, windowMs = 15 * 60 * 1000, maxKeys = 10000, now = Date.now } = {}) {
  const failures = new Map();   // key → timestamps of recent failures
  const keys = (username, address) => [['u:' + String(username || '').toLowerCase().trim(), perUser], ['a:' + String(address || 'unknown'), perAddress]];
  const recent = key => {
    const cutoff = now() - windowMs;
    const list = (failures.get(key) || []).filter(t => t > cutoff);
    if (list.length) failures.set(key, list); else failures.delete(key);
    return list;
  };
  // Seconds until the caller may try again, or 0 when allowed.
  function retryAfter(username, address) {
    let wait = 0;
    for (const [key, limit] of keys(username, address)) {
      const list = recent(key);
      if (list.length >= limit) wait = Math.max(wait, Math.ceil((list[list.length - limit] + windowMs - now()) / 1000));
    }
    return wait;
  }
  function fail(username, address) {
    if (failures.size >= maxKeys) {   // drop the oldest entries rather than grow without bound
      for (const key of [...failures.keys()].slice(0, Math.ceil(maxKeys / 10))) failures.delete(key);
    }
    for (const [key] of keys(username, address)) { const list = recent(key); list.push(now()); failures.set(key, list); }
  }
  // A correct password clears that account's count; the address count stays.
  function succeed(username) { failures.delete(keys(username, '')[0][0]); }
  return { retryAfter, fail, succeed };
}
function validCredentials(username, password) {
  return typeof username === 'string' && username.trim().length > 0 && username.length <= 256 &&
    typeof password === 'string' && password.length > 0 && Buffer.byteLength(password) <= 1024;
}
// Only the provider's stable subject identifies an existing SSO account.
function resolveOidcUser(db, claims) {
  const { sub, email, preferred_username } = claims || {};
  if (typeof sub !== 'string' || !sub || sub.length > 512) throw new Error('Invalid SSO subject');
  const linked = db.prepare('SELECT * FROM users WHERE authentik_id = ?').get(sub);
  if (linked) return linked;
  const username = (typeof preferred_username === 'string' && preferred_username || typeof email === 'string' && email || sub).toLowerCase().trim();
  if (!username || username.length > 256) throw new Error('Invalid SSO username');
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) throw new Error('SSO username conflicts with an existing account; use the existing sign-in method');
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, username, email, role, authentik_id) VALUES (?,?,?,?,?)')
    .run(id, username, typeof email === 'string' ? email : null, 'user', sub);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
module.exports = { SessionError, validateSecret, initializeAuthSchema, createTokens, createOidcState, createLoginLimiter, validCredentials, resolveOidcUser };
