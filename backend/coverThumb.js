'use strict';
// ─── Cover thumbnails (2026-11-05) ───────────────────────────────────────────
// The cover cache (appdata/thumbcache) used to keep each issue's first page exactly as
// it is in the archive: ~1.3 MB on average, 73.5 GB for the library, and every shelf
// downloaded megabytes per cover. Covers are now saved resized: 720 px tall (sharp on
// high-resolution screens at the sizes covers are shown), so a wraparound cover keeps
// its full width. Only the cached cover is resized; the reader still gets full pages.
const COVER_THUMB_HEIGHT = 720;

let sharp = null;
function loadSharp() { if (!sharp) sharp = require('sharp'); return sharp; }

// buf: the image as read from the archive; ext: its extension ('.jpg', '.png', ...).
// Returns { buf, ext, mime }: a JPEG thumbnail, or the original when it cannot be read
// as an image (it is then cached and served as before).
async function coverThumb(buf, ext = '.jpg') {
  try {
    const out = await loadSharp()(buf, { failOn: 'none' })
      .resize({ height: COVER_THUMB_HEIGHT, withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    return { buf: out, ext: '.jpg', mime: 'image/jpeg' };
  } catch {
    const e = String(ext || '.jpg').toLowerCase();
    return { buf, ext: e, mime: e === '.png' ? 'image/png' : e === '.gif' ? 'image/gif' : e === '.webp' ? 'image/webp' : 'image/jpeg' };
  }
}

module.exports = { coverThumb, COVER_THUMB_HEIGHT };
