'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { createHostDownloaders } = require('./hosts');
const { createGetComics } = require('./getcomics');

const noop = () => {};
const logger = { info: noop, warn: noop, error: noop, debug: noop };
const hosts = createHostDownloaders({ axios: null, logger, fs, stallGuard: noop, isCancelled: () => false, pushDownloadUpdate: noop, pushDownloadProgress: noop });

test('hosts module: what a downloaded file really is, from its first bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sniff-'));
  const file = (name, bytes) => { const p = path.join(dir, name); fs.writeFileSync(p, bytes); return p; };
  assert.equal(hosts.sniffDownload(file('a', Buffer.from('PK\x03\x04rest', 'latin1'))), 'zip');
  assert.equal(hosts.sniffDownload(file('b', Buffer.from('Rar!\x1a\x07', 'latin1'))), 'rar');
  assert.equal(hosts.sniffDownload(file('c', Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))), '7z');
  assert.equal(hosts.sniffDownload(file('d', '%PDF-1.7')), 'pdf');
  assert.equal(hosts.sniffDownload(file('e', '  <!DOCTYPE html><html>')), 'html');
  assert.equal(hosts.sniffDownload(path.join(dir, 'missing')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hosts module: links it handles, and an unknown host is refused', async () => {
  for (const u of ['https://pixeldrain.com/u/abc', 'https://www.mediafire.com/file/x', 'https://mega.nz/file/y']) assert.ok(hosts.THIRD_PARTY_HOST.test(u), u);
  assert.equal(hosts.THIRD_PARTY_HOST.test('https://getcomics.org/dls/x'), false);
  await assert.rejects(hosts.downloadThirdParty('https://example.com/f.cbz', '/tmp/x', {}), /No handler/);
});

test('getcomics module loads with what server.js passes it', () => {
  const gc = createGetComics({ axios: null, logger, fs, path, LOG_DIR: os.tmpdir(), fsCache: new Map(), fetchViaFlareSolverr: async () => '' });
  for (const f of ['scrapeGcResults', 'saveGcSample', 'scrapeGcLinks', 'resolveDldsLink']) assert.equal(typeof gc[f], 'function');
  assert.ok(Array.isArray(gc.scrapeGcResults('<html><body>nothing here</body></html>')));
});
