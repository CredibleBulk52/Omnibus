'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { create, PREFIX } = require('./secrets');

const SECRET = 'a'.repeat(64);

test('secrets: sealed values open with the same secret only; plain values read as they are', () => {
  const s = create({ secret: SECRET });
  const a = s.seal('cv-key-123456'), b = s.seal('cv-key-123456');
  assert.ok(a.startsWith(PREFIX) && a !== b);                 // a fresh IV each time
  assert.equal(s.open(a, 'cv_api_key'), 'cv-key-123456');
  assert.equal(s.open('plain-old-key', 'cv_api_key'), 'plain-old-key');
  assert.equal(s.seal(''), '');
  assert.equal(s.seal(a), a);                                   // never sealed twice
  const logs = [];
  const other = create({ secret: 'b'.repeat(64), logger: { error: m => logs.push(m) } });
  assert.equal(other.open(a, 'cv_api_key'), '');
  assert.equal(other.open(a, 'cv_api_key'), '');
  assert.equal(logs.length, 1);                                 // said once, not on every read
  const none = create({ secret: '' });
  assert.equal(none.seal('x-key'), 'x-key');                     // no secret: stored as before
  assert.equal(none.open(a, 'cv_api_key'), '');
  const tampered = a.slice(0, -4) + (a.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.equal(s.open(tampered, 'k'), '');
});

test('secrets: the settings page sees a mask, never the key; masks are recognised', () => {
  const s = create({ secret: SECRET });
  assert.equal(s.mask(s.seal('sk-abcdef9876'), 'anthropic_api_key'), '••••••••9876');
  assert.equal(s.mask('', 'anthropic_api_key'), '');
  assert.ok(s.isMask('••••••••9876') && !s.isMask('sk-abc'));
  assert.ok(create({ secret: 'c'.repeat(64) }).mask(s.seal('k-1234'), 'x').includes('unreadable'));
  assert.ok(s.isSecret('qbittorrent_password') && !s.isSecret('qbittorrent_username') && !s.isSecret('cv_poll_interval_days'));
});

test('secrets: stored plain keys are encrypted at startup; other settings are left alone', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('cv_api_key', 'cvkey'), ('sabnzbd_url', 'http://sab'), ('openai_api_key', ''), ('metron_api_token', 'tok');`);
  const s = create({ secret: SECRET });
  assert.deepEqual(s.status(db), { configured: true, stored: 2, encrypted: 0, plain: 2, unreadable: [] });
  assert.equal(s.sealStored(db), 2);
  assert.equal(s.sealStored(db), 0);
  const v = k => db.prepare('SELECT value FROM settings WHERE key = ?').get(k).value;
  assert.ok(v('cv_api_key').startsWith(PREFIX) && v('metron_api_token').startsWith(PREFIX));
  assert.equal(v('sabnzbd_url'), 'http://sab'); assert.equal(v('openai_api_key'), '');
  assert.equal(s.open(v('cv_api_key'), 'cv_api_key'), 'cvkey');
  assert.equal(create({ secret: '' }).sealStored(db), 0);
  assert.deepEqual(create({ secret: 'd'.repeat(64) }).status(db).unreadable.sort(), ['cv_api_key', 'metron_api_token']);
});
