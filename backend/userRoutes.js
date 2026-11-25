'use strict';
// ─── Accounts: sign-in, sign-out, SSO, the current user, appearance, user management (moved out of server.js 2026-11-25, shared core, step 0a) ───
// Local sign-in with the failed-attempt limiter, /api/auth/me, OIDC (SSO) sign-in and callback, the reader
// image session, per-user appearance, and the admin People routes. Moved unchanged.
const crypto = require('crypto');

const NEEDS = ['achievements', 'app', 'authSecurity', 'authTokens', 'axios', 'db', 'getSetting', 'hashPassword', 'jwtSign', 'logger', 'OIDC_BASE_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI', 'oidcState', 'readerSecurity', 'requestToken', 'requireAdmin', 'requireAuth', 'verifyPassword'];
module.exports.NEEDS = NEEDS;

module.exports.registerUserRoutes = function registerUserRoutes(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`registerUserRoutes: missing ${missing.join(', ')}`);
  const { achievements, app, authSecurity, authTokens, axios, db, getSetting, hashPassword, jwtSign, logger, OIDC_BASE_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI, oidcState, readerSecurity, requestToken, requireAdmin, requireAuth, verifyPassword } = deps;
  // ─── Auth routes ──────────────────────────────────────────────────

  // POST /api/auth/login — local username/password login
  const loginLimiter = authSecurity.createLoginLimiter();
  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!authSecurity.validCredentials(username, password)) return res.status(400).json({ error: 'Valid username and password required' });
    // Too many failed attempts: refuse before checking the password (security review 2026-11-12).
    const wait = loginLimiter.retryAfter(username, req.ip);
    if (wait > 0) {
      logger.warn('auth', 'Sign-in refused after repeated failures', { username: String(username).slice(0, 64), ip: req.ip });
      res.set('Retry-After', String(wait));
      return res.status(429).json({ error: `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}.` });
    }
    try {
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase().trim());
      if (!user || !user.password_hash || !await verifyPassword(password, user.password_hash)) {
        loginLimiter.fail(username, req.ip);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      loginLimiter.succeed(username);
      // Password verification yields: a concurrent reset/deletion must not mint a fresh session.
      const current = db.prepare('SELECT password_hash, auth_version FROM users WHERE id = ?').get(user.id);
      if (!current || current.password_hash !== user.password_hash || current.auth_version !== user.auth_version) return res.status(401).json({ error: 'Invalid credentials' });
      db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);
      const token = jwtSign({ sub: user.id });
      res.set('Cache-Control', 'no-store');
      res.json({ token, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
    } catch (e) {
      logger.error('auth', 'Local login failed', { error: e.message });
      res.status(500).json({ error: 'Unable to sign in' });
    }
  });

  // ─── APPEARANCE (per-user colours, 2026-10-27) ────────────────────
  // Four root colours (base, secondary, highlight, text) and whether character /
  // cover colours may override them on reading pages. Null colours = Omnibus defaults.
  db.exec(`CREATE TABLE IF NOT EXISTS user_appearance (
  user_id    TEXT PRIMARY KEY,
  prefs      TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
)`);
  const { cleanAppearance } = require('./appearancePrefs');
  app.get('/api/users/me/appearance', requireAuth, (req, res) => {
    try {
      const row = db.prepare('SELECT prefs FROM user_appearance WHERE user_id = ?').get(req.user.sub);
      res.json(row ? (cleanAppearance(JSON.parse(row.prefs)) || { colors: null, pageColors: true }) : { colors: null, pageColors: true });
    } catch (e) { res.status(500).json({ error: 'Unable to load appearance' }); }
  });
  app.put('/api/users/me/appearance', requireAuth, (req, res) => {
    const prefs = cleanAppearance(req.body);
    if (!prefs) return res.status(400).json({ error: 'Colours must be #rrggbb values for base, secondary, highlight and text' });
    try {
      // A theme switch counts toward the hidden "New Costume, Who Dis?" achievement (2026-11-11).
      let before = null; try { before = JSON.parse(db.prepare('SELECT prefs FROM user_appearance WHERE user_id = ?').get(req.user.sub)?.prefs || 'null'); } catch {}
      if (prefs.themeId !== undefined && (before?.themeId ?? null) !== (prefs.themeId ?? null)) { try { achievements?.bump(req.user.sub, 'theme'); } catch {} }
      db.prepare(`INSERT INTO user_appearance (user_id, prefs, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`).run(req.user.sub, JSON.stringify(prefs));
      res.json(prefs);
    } catch (e) { res.status(500).json({ error: 'Unable to save appearance' }); }
  });

  // Legacy favorites are retained only for the optional Pull Box import.
  // GET /api/auth/me — verify token and return current user
  app.get('/api/auth/me', requireAuth, async (req, res) => {
    const user = db.prepare('SELECT id, username, email, role, last_login, password_hash FROM users WHERE id = ?').get(req.user.sub);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { password_hash, ...out } = user;
    // An admin still on the first-run password (admin / admin) is told so on Home (2026-11-11).
    if (out.role === 'admin' && out.username === 'admin' && password_hash) { try { out.default_password = await verifyPassword('admin', password_hash); } catch {} }
    res.json(out);
  });

  // GET /api/auth/oidc-status — returns whether SSO is configured (safe to call unauthenticated)
  app.get('/api/auth/oidc-status', (req, res) => {
    const configured = !!(OIDC_CLIENT_ID && OIDC_CLIENT_SECRET && OIDC_BASE_URL);
    res.json({
      configured,
      // Admin setting: show only the SSO button on the login page. The local
      // form stays reachable at /login?local=1 (admin fallback if SSO is down).
      hide_local_login: configured && getSetting('oidc_hide_local_login') === 'true',
      base_url:   OIDC_BASE_URL  || null,
      client_id:  OIDC_CLIENT_ID ? `${OIDC_CLIENT_ID.slice(0, 6)}…` : null, // partial — never expose full ID
    });
  });

  // POST /api/auth/logout revokes this session persistently and clears reader access
  app.post('/api/auth/logout', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { authTokens.revoke(requestToken(req)); }
    catch (e) {
      if (!(e instanceof authSecurity.SessionError)) return res.status(500).json({ error: 'Unable to revoke session; try again' });
      readerSecurity.clearReaderCookie(req, res);
      return res.status(401).json({ error: 'Session is no longer valid' });
    }
    readerSecurity.clearReaderCookie(req, res);
    res.json({ ok: true });
  });

  app.post('/api/auth/reader-session', requireAuth, (req, res) => {
    readerSecurity.setReaderCookie(req, res, requestToken(req), req.user);
    res.json({ ok: true });
  });

  // GET /api/auth/oidc — redirect browser to OIDC provider authorize endpoint
  app.get('/api/auth/authentik', (req, res) => {  // keep path for backwards compat with frontend
    if (!OIDC_CLIENT_ID || !OIDC_BASE_URL) return res.status(503).json({ error: 'SSO not configured — set OIDC_BASE_URL, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET in your .env' });
    let state;
    try { state = oidcState.begin(req, res); }
    catch { return res.status(429).json({ error: 'Too many pending sign-ins; try again shortly' }); }
    const params = new URLSearchParams({
      client_id:     OIDC_CLIENT_ID,
      redirect_uri:  OIDC_REDIRECT_URI,
      response_type: 'code',
      scope:         'openid email profile',
      state,
    });
    res.redirect(`${OIDC_BASE_URL}/authorize/?${params}`);
  });

  // GET /api/auth/callback — OIDC provider posts browser back here after login
  app.get('/api/auth/callback', async (req, res) => {
    if (!oidcState.consume(req, res)) return res.redirect('/login?error=invalid_sso_state');
    const { code, error } = req.query;
    if (error) return res.redirect(`/login?error=${encodeURIComponent(error)}`);
    if (typeof code !== 'string' || !code || code.length > 4096) return res.redirect('/login?error=no_code');
    let _step = 'init';
    try {
      _step = 'token_exchange';
      const tokenRes = await axios.post(`${OIDC_BASE_URL}/token/`, new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  OIDC_REDIRECT_URI,
        client_id:     OIDC_CLIENT_ID,
        client_secret: OIDC_CLIENT_SECRET,
      }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });

      _step = 'userinfo_fetch';
      const userRes = await axios.get(`${OIDC_BASE_URL}/userinfo/`, {
        headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }, timeout: 15000,
      });
      _step = 'user_lookup';
      const user = authSecurity.resolveOidcUser(db, userRes.data);
      _step = 'last_login_update';
      db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);
      _step = 'sign_token';
      const token = jwtSign({ sub: user.id, username: user.username, role: user.role });
      _step = 'redirect';
      res.set('Cache-Control', 'no-store');
      res.set('Referrer-Policy', 'no-referrer');
      res.redirect(`/auth-callback?token=${encodeURIComponent(token)}`);
    } catch (e) {
      logger.error('auth', 'OIDC callback error', { step: _step, error: e.message, stack: e.stack });
      res.redirect(`/login?error=${encodeURIComponent('Authentication failed — check server logs')}`);
    }
  });

  // ─── User management routes (admin only) ──────────────────────────

  // GET /api/users
  app.get('/api/users', requireAdmin, (req, res) => {
    const users = db.prepare(
      'SELECT id, username, email, role, authentik_id, created_at, last_login FROM users ORDER BY created_at ASC'
    ).all();
    res.json(users);
  });

  // POST /api/users — create local user
  app.post('/api/users', requireAdmin, async (req, res) => {
    const { username, email, password, role = 'user' } = req.body || {};
    if (!authSecurity.validCredentials(username, password)) return res.status(400).json({ error: 'Valid username and password required' });
    if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    try {
      const id   = crypto.randomUUID();
      const hash = await hashPassword(password);
      db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
        .run(id, username.toLowerCase().trim(), email || null, hash, role);
      res.json({ ok: true, id });
    } catch (e) {
      if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username or email already exists' });
      res.status(500).json({ error: e.message });
    }
  });

  // PATCH /api/users/:id — update role, email, password, username
  app.patch('/api/users/:id', requireAdmin, async (req, res) => {
    const { role, email, password, username } = req.body || {};
    if ((role !== undefined && !['admin', 'user'].includes(role)) ||
        (username !== undefined && !authSecurity.validCredentials(username, 'validation')) ||
        (password !== undefined && password !== '' && !authSecurity.validCredentials('validation', password)) ||
        (email !== undefined && (typeof email !== 'string' || email.length > 320))) {
      return res.status(400).json({ error: 'Invalid account fields' });
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    try {
      const hash = password ? await hashPassword(password) : null;
      db.transaction(() => {
        if (role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
        if (email) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, user.id);
        if (username) db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username.toLowerCase().trim(), user.id);
        if (hash) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
        if (hash || (role && role !== user.role) || (username && username.toLowerCase().trim() !== user.username)) db.prepare('UPDATE users SET auth_version = auth_version + 1 WHERE id = ?').run(user.id);
      })();
      res.json({ ok: true });
    } catch (e) {
      if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username or email already exists' });
      res.status(500).json({ error: 'Unable to update account' });
    }
  });

  // DELETE /api/users/:id — cannot delete yourself
  app.delete('/api/users/:id', requireAdmin, (req, res) => {
    if (req.params.id === req.user.sub) return res.status(400).json({ error: 'Cannot delete your own account' });
    db.prepare('DELETE FROM user_appearance WHERE user_id = ?').run(req.params.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });
  return {};
};
