'use strict';
// comicInfoFiles.js (moved out of server.js 2026-11-19): ComicInfo read from real ZIP archives (top level,
// nested, none, not a zip, wrong extension), parsed, and the Comic Vine issue id found.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFile } = require('node:child_process');
const execFileAsync = require('node:util').promisify(execFile);
const { createComicInfoFiles, parseComicInfo, extractCvIdFromComicInfo } = require('./comicInfoFiles');

function zipOf(file, entries) {   // a stored ZIP written by hand (no zip tool needed)
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xFFFFFFFF; for (const x of b) c = crcTable[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const parts = [], central = []; let off = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text), n = Buffer.from(name), c = crc(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(c, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    const d = Buffer.alloc(46); d.writeUInt32LE(0x02014b50, 0); d.writeUInt16LE(20, 4); d.writeUInt16LE(20, 6); d.writeUInt32LE(c, 16); d.writeUInt32LE(data.length, 20); d.writeUInt32LE(data.length, 24); d.writeUInt16LE(n.length, 28); d.writeUInt32LE(off, 42);
    parts.push(h, n, data); central.push(d, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  fs.writeFileSync(file, Buffer.concat([...parts, cd, e]));
}

test('ComicInfo is read from ZIP archives, nested or not, and parsed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-ci-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const xml = '<ComicInfo><Series>Batman</Series><Number>1</Number><Year>2016</Year><PageCount>24</PageCount><Web>https://comicvine.gamespot.com/batman-1/4000-525051/</Web></ComicInfo>';
  const ci = createComicInfoFiles({ execFileAsync, listArchiveFiles: async f => (f.endsWith('nested.cbz') ? ['x/ComicInfo.xml', '001.jpg'] : ['001.jpg']) });
  zipOf(path.join(dir, 'top.cbz'), [['ComicInfo.xml', xml], ['001.jpg', 'img']]);
  zipOf(path.join(dir, 'nested.cbz'), [['x/comicinfo.XML', xml], ['001.jpg', 'img']]);
  zipOf(path.join(dir, 'none.cbz'), [['001.jpg', 'img']]);
  zipOf(path.join(dir, 'misnamed.cbr'), [['ComicInfo.xml', xml]]);   // a ZIP with a RAR name: still read
  fs.writeFileSync(path.join(dir, 'broken.cbz'), 'not an archive');
  assert.equal(await ci.extractComicInfo(path.join(dir, 'top.cbz')), xml);
  assert.equal(await ci.extractComicInfo(path.join(dir, 'nested.cbz')), xml);
  assert.equal(await ci.extractComicInfo(path.join(dir, 'none.cbz')), '');
  assert.equal(await ci.readZipComicInfo(path.join(dir, 'misnamed.cbr')), xml);
  assert.equal(await ci.readZipComicInfo(path.join(dir, 'broken.cbz')), null);
  assert.equal(await ci.archiveHasComicInfo(path.join(dir, 'nested.cbz')), true);
  assert.equal(await ci.archiveHasComicInfo(path.join(dir, 'none.cbz')), false);
  assert.deepEqual([parseComicInfo(xml).series, parseComicInfo(xml).year, parseComicInfo(xml).pageCount], ['Batman', 2016, 24]);
  assert.deepEqual(parseComicInfo(''), {});
  assert.equal(String(extractCvIdFromComicInfo(xml)), '525051');
});
