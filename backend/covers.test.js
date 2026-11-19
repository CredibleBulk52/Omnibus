'use strict';
// covers.js (moved out of server.js 2026-11-19): the cover cache's ETag changes when a series rescan
// clears thumbnails (bumpThumbCacheGen), and eviction only touches plain cache file names.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createCovers } = require('./covers');

function setup() {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-covers-'));
  const routes = {}, none = () => {};
  const app = { get: (p, ...h) => { routes[p] = h.at(-1); }, post: none, delete: (p, ...h) => { routes['DELETE ' + p] = h.at(-1); } };
  const db = { prepare: () => ({ get: id => ({ id, path: '/library/x.cbz', series_id: 's' }), all: () => [] }) };
  const covers = createCovers({ app, coverThumb: async (buf, ext) => ({ buf, ext, mime: 'image/jpeg' }), db, dbDir, filterImages: f => f,
    listArchiveFiles: async () => ['001.jpg'], logger: { error() {}, debug() {}, info() {} }, readArchiveMember: async () => Buffer.from('cover'), requireAdmin: none });
  return { dbDir, routes, covers };
}
const res = () => ({ headers: {}, code: 200, req: { headers: {} }, set(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, send(v) { this.body = v; }, end() {}, json(v) { this.body = v; }, sendFile(f) { this.body = fs.readFileSync(f); } });

test('a cached cover gets a new ETag after a series rescan clears thumbnails', async () => {
  const { dbDir, routes, covers } = setup();
  try {
    const first = res(); await routes['/api/books/:id/thumbnail']({ params: { id: 'b1' } }, first);
    assert.equal(first.body.toString(), 'cover');
    const again = res(); again.req.headers['if-none-match'] = first.headers.ETag;
    await routes['/api/books/:id/thumbnail']({ params: { id: 'b1' } }, again);
    assert.equal(again.code, 304);
    await new Promise(r => setTimeout(r, 5)); covers.bumpThumbCacheGen();
    const after = res(); after.req.headers['if-none-match'] = first.headers.ETag;
    await routes['/api/books/:id/thumbnail']({ params: { id: 'b1' } }, after);
    assert.equal(after.code, 200);
    assert.notEqual(after.headers.ETag, first.headers.ETag);
  } finally { fs.rmSync(dbDir, { recursive: true, force: true }); }
});

test('evicting a cover removes only that cache file; other names are ignored', () => {
  const { dbDir, covers } = setup();
  try {
    fs.writeFileSync(path.join(covers.THUMB_CACHE_DIR, 'b1.jpg'), 'x');
    fs.writeFileSync(path.join(dbDir, 'keep.jpg'), 'x');
    covers.evictThumbCache('../keep'); covers.evictThumbCache('..');
    assert.ok(fs.existsSync(path.join(dbDir, 'keep.jpg')));
    assert.ok(covers.findThumbCache('b1'));
    covers.evictThumbCache('b1');
    assert.equal(covers.findThumbCache('b1'), null);
  } finally { fs.rmSync(dbDir, { recursive: true, force: true }); }
});
