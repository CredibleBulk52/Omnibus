'use strict';
// ─── Secrets at rest (API keys and passwords in the settings table) ─────────
// User 2026-11-02: keys encrypted in the database, the encryption key in .env
// (OMNIBUS_SECRET; deploy.ps1 adds one when it is missing). Database backups
// then never hold readable keys; restoring onto another machine needs the
// same OMNIBUS_SECRET.
//
// Stored form: "enc:v1:" + base64(iv 12 bytes | auth tag 16 bytes | ciphertext),
// AES-256-GCM with a key derived from OMNIBUS_SECRET (SHA-256). A plain value
// (from before encryption, or saved while no secret was set) is still read as
// is and is encrypted at the next startup that has a secret.
// Without OMNIBUS_SECRET nothing is encrypted and stored keys keep working;
// an encrypted value that cannot be opened (secret missing or changed) reads
// as empty, and status() says so for the admin.
const crypto = require('crypto');

const SECRET_KEYS = new Set([
  'cv_api_key', 'metron_api_token', 'prowlarr_api_key', 'sabnzbd_api_key',
  'qbittorrent_password', 'anthropic_api_key', 'openai_api_key', 'gemini_api_key',
]);
const PREFIX = 'enc:v1:';
const MASK = '••••••••';

function create({ secret = process.env.OMNIBUS_SECRET, logger = null } = {}) {
  const raw = String(secret || '').trim();
  const key = raw.length >= 16 ? crypto.createHash('sha256').update(raw).digest() : null;
  const unreadable = new Set();          // keys whose stored value could not be opened
  const isSecret = k => SECRET_KEYS.has(String(k));
  const isSealed = v => typeof v === 'string' && v.startsWith(PREFIX);

  function seal(value) {
    if (value == null || value === '' || !key || isSealed(value)) return value;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
    return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }
  function open(value, name = '') {
    if (!isSealed(value)) return value;
    if (key) {
      try {
        const b = Buffer.from(value.slice(PREFIX.length), 'base64');
        const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
        d.setAuthTag(b.subarray(12, 28));
        const out = Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
        unreadable.delete(name);
        return out;
      } catch {}
    }
    if (name && !unreadable.has(name)) {
      unreadable.add(name);
      logger?.error?.('secrets', `Stored ${name} cannot be read: OMNIBUS_SECRET is ${key ? 'different from the one it was saved with' : 'not set'}. Restore the original OMNIBUS_SECRET in .env, or enter the key again.`);
    }
    return '';
  }
  // For the settings page: never the key itself.
  function mask(value, name = '') {
    const v = open(value, name);
    if (!v) return isSealed(value) ? `${MASK} (unreadable)` : '';
    return `${MASK}${String(v).slice(-4)}`;
  }
  const isMask = v => typeof v === 'string' && v.startsWith(MASK);

  // Encrypt every plain secret in the settings table (startup, when a secret is set).
  function sealStored(db) {
    if (!key) return 0;
    let n = 0;
    const put = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    for (const row of db.prepare('SELECT key, value FROM settings').all()) {
      if (isSecret(row.key) && row.value && !isSealed(row.value)) { put.run(seal(row.value), row.key); n++; }
    }
    return n;
  }
  function status(db) {
    const rows = db ? db.prepare('SELECT key, value FROM settings').all().filter(r => isSecret(r.key) && r.value) : [];
    const sealed = rows.filter(r => isSealed(r.value));
    const bad = sealed.filter(r => { const before = unreadable.has(r.key); const ok = !!open(r.value, r.key); if (!before && !ok) unreadable.add(r.key); return !ok; });
    return { configured: !!key, stored: rows.length, encrypted: sealed.length, plain: rows.length - sealed.length, unreadable: bad.map(r => r.key) };
  }
  return { isSecret, isSealed, seal, open, mask, isMask, sealStored, status, MASK };
}

module.exports = { create, SECRET_KEYS, PREFIX, MASK };
