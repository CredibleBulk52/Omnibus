'use strict';
// ─── Page resolution ──────────────────────────────────────────────
// Typical page size of a CBZ, read from the image headers of a few pages
// (the first bytes of each image only). Used to keep the sharper copy of a
// duplicate: file names and sizes do not say which release is better
// (Captain America #8: the copy named "(Digital)" is 1920×2951, the plain one
// 1988×3056; print scans are often bigger files at lower resolution).
const yauzl = require('yauzl');
const PAGE = /\.(jpe?g|png|webp)$/i;
const HEAD = 256 * 1024;

// { width, height } from the start of a JPEG, PNG or WebP file; null if not found.
function imageSize(b) {
  if (b.length > 24 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8 ' && b.length > 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L' && b.length > 25) { const v = b.readUInt32LE(21); return { width: 1 + (v & 0x3fff), height: 1 + ((v >> 14) & 0x3fff) }; }
    return null;
  }
  if (b[0] !== 0xFF || b[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xFF) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if ([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF].includes(marker)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

// Median pixel count over up to `samples` pages spread through the book; null if unknown.
function pageResolution(file, { samples = 3, timeoutMs = 20000 } = {}) {
  if (!/\.cbz$/i.test(file)) return Promise.resolve(null);
  return new Promise(resolve => {
    let zip = null, done = false;
    const finish = v => { if (done) return; done = true; clearTimeout(timer); try { zip?.close(); } catch {} resolve(v); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (error, z) => {
      if (error) return finish(null);
      zip = z;
      const entries = [];
      z.on('error', () => finish(null));
      z.on('entry', e => { if (!e.fileName.endsWith('/') && PAGE.test(e.fileName) && !/__MACOSX/.test(e.fileName)) entries.push(e); z.readEntry(); });
      z.on('end', async () => {
        entries.sort((a, b) => (a.fileName < b.fileName ? -1 : 1));
        if (!entries.length) return finish(null);
        const picks = [...new Set([0.25, 0.5, 0.75].slice(0, samples).map(f => Math.min(entries.length - 1, Math.floor(entries.length * f))))].map(i => entries[i]);
        const sizes = [];
        for (const e of picks) {
          const head = await new Promise(res => z.openReadStream(e, (err, s) => {
            if (err) return res(null);
            const chunks = []; let n = 0, ended = false;
            const stop = () => { if (ended) return; ended = true; s.destroy(); res(Buffer.concat(chunks)); };
            s.on('data', c => { chunks.push(c); n += c.length; if (n >= HEAD) stop(); });
            s.on('end', stop); s.on('error', stop); s.on('close', stop);
          }));
          const size = head && imageSize(head);
          if (size && size.width > 0 && size.height > 0) sizes.push(size.width * size.height);
        }
        sizes.sort((a, b) => a - b);
        finish(sizes.length ? sizes[Math.floor(sizes.length / 2)] : null);
      });
      z.readEntry();
    });
  });
}

module.exports = { pageResolution, imageSize };
