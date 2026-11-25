'use strict';
// ─── Sign-in, sessions and the /api gate (moved out of server.js 2026-11-25, shared core, step 0a) ───
// Session tokens (HS256, authSecurity.js), password hashing (scrypt), the first admin account on an empty
// database, the requireAuth / requireAdmin / requireDownloadAccess checks, and the /api gate (public
// sign-in and media routes, admin-only prefixes, everything else signed in). Shared by every side of the
// app (claude/BOOKS_DESIGN.md). Moved unchanged.
const crypto = require('crypto');

const NEEDS = ['app', 'authSecurity', 'db', 'getSetting', 'JWT_EXPIRES_DAYS', 'JWT_SECRET', 'logger', 'readerSecurity'];
module.exports.NEEDS = NEEDS;

module.exports.createAuth = function createAuth(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createAuth: missing ${missing.join(', ')}`);
  const { app, authSecurity, db, getSetting, JWT_EXPIRES_DAYS, JWT_SECRET, logger, readerSecurity } = deps;
  // ─── Auth helpers ─────────────────────────────────────────────────

  // JWT — HS256 using built-in crypto (no jsonwebtoken dependency)
  authSecurity.initializeAuthSchema(db);
  const authTokens = authSecurity.createTokens({ db, secret: JWT_SECRET, expiresDays: JWT_EXPIRES_DAYS });
  const oidcState = authSecurity.createOidcState();
  function jwtSign(payload) { return authTokens.sign(payload); }
  function jwtVerify(token) { return authTokens.verify(token); }

  // Password hashing — scrypt using built-in crypto
  async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await new Promise((res, rej) =>
      crypto.scrypt(password, salt, 64, (err, key) => err ? rej(err) : res(key.toString('hex')))
    );
    return `${salt}:${hash}`;
  }

  async function verifyPassword(password, stored) {
    const [salt, hash] = stored.split(':');
    const derived = await new Promise((res, rej) =>
      crypto.scrypt(password, salt, 64, (err, key) => err ? rej(err) : res(key.toString('hex')))
    );
    try {
      return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
    } catch { return false; }
  }

  // Auto-create first admin user if users table is empty
  (async () => {
    const count = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
    if (count === 0) {
      const id   = crypto.randomUUID();
      const hash = await hashPassword('admin');
      db.prepare(`INSERT INTO users (id, username, email, password_hash, role)
                VALUES (?, 'admin', 'admin@localhost', ?, 'admin')`).run(id, hash);
      logger.info('auth', 'Created default admin user', { username: 'admin', password: 'admin' });
      logger.warn('auth', '⚠️  Change the default admin password immediately via Settings › People');
    }
  })();

  // ─── Auth middleware ───────────────────────────────────────────────

  // EventSource (server-sent event streams) can't send an Authorization header,
  // so those requests may pass the token as ?token=. Only accepted for streams.
  function requestToken(req) {
    const header = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (header) return header;
    if ((req.headers.accept || '').includes('text/event-stream') && req.query?.token) return String(req.query.token);
    return '';
  }

  function requireAuth(req, res, next) {
    try {
      const token = requestToken(req);
      req.user = jwtVerify(token);
      next();
    } catch {
      res.status(401).json({ error: 'Unauthorised' });
    }
  }

  function requireAdmin(req, res, next) {
    try {
      const token = requestToken(req);
      const user  = jwtVerify(token);
      if (user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
      req.user = user;
      next();
    } catch {
      res.status(401).json({ error: 'Unauthorised' });
    }
  }

  // Download Manager functions: any logged-in user, unless Settings has
  // "download manager admin only" on, in which case admin only.
  function requireDownloadAccess(req, res, next) {
    requireAuth(req, res, () => {
      if (req.user?.role === 'admin') return next();
      if (getSetting('download_manager_admin_only') === 'true') return res.status(403).json({ error: 'Downloads are limited to the admin' });
      next();
    });
  }

  // Apply auth to all /api routes EXCEPT auth endpoints and media routes.
  // img src / browser-native requests cannot send Authorization headers.
  // Only images (which the browser loads without headers) and the login routes
  // are public. Previously whole /series/, /books/, /collections/ and /debug/
  // prefixes were public, which exposed editing routes to anyone.
  const PUBLIC_API_PREFIXES = ['/auth/', '/health'];
  const PUBLIC_MEDIA_GETS = [
    /^\/series\/[^/]+\/thumbnail$/,        // series covers
    /^\/books\/[^/]+\/thumbnail$/,         // issue covers
    /^\/collections\/[^/]+\/cover$/,       // box covers
    /^\/assistant\/avatar$/,               // assistant avatar (img src)
  ];
  const ADMIN_API_PREFIXES = ['/debug/', '/admin/', '/import/'];
  app.use('/api', (req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && readerSecurity.READER_IMAGE.test(req.path)) return readerSecurity.protectReader(req, res, next, authTokens);
    if (PUBLIC_API_PREFIXES.some(p => req.path.startsWith(p))) return next();
    if ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC_MEDIA_GETS.some(r => r.test(req.path))) return next();
    // Match Express's default case-insensitive routing so mixed-case URLs cannot bypass the admin gate.
    if (ADMIN_API_PREFIXES.some(p => req.path.toLowerCase().startsWith(p))) return requireAdmin(req, res, next);
    requireAuth(req, res, next);
  });
  return { authTokens, oidcState, jwtSign, jwtVerify, hashPassword, verifyPassword, requestToken, requireAuth, requireAdmin, requireDownloadAccess };
};
