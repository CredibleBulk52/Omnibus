// ─── Wraparound covers (2026-10-28) ───────────────────────────────────────────
// A few comics' first page is a double-page spread (wraparound cover): the front
// cover is the right half. Covers are shown cropped (object-fit: cover), which
// centred them on the spine. Any issue or series cover image that turns out wider
// than tall is aligned right instead, everywhere in the app. One listener for the
// whole page: image load events do not bubble, but they reach a capture listener.
//
// Manga (2026-11-10): read right to left, so a wraparound's front cover is the LEFT
// half. The server lists the books and series read right to left
// (GET /api/covers/right-to-left); it is asked once, when the first spread shows up,
// and spreads already on the page are marked again when it answers.
const COVER = /\/api\/(books|series)\/([^/?#]+)\/thumbnail(?:[?#]|$)/;
export const isSpread = (w, h) => w > 0 && h > 0 && w > h * 1.1;

let rtl = { books: new Set(), series: new Set() };
let rtlState = 'none';   // none | loading | loaded

export function setRightToLeft({ books = [], series = [] } = {}) {
  rtl = { books: new Set(books.map(String)), series: new Set(series.map(String)) };
  rtlState = 'loaded';
  if (typeof document !== 'undefined') document.querySelectorAll('img.cover-spread').forEach(markSpread);
}

function loadRightToLeft() {
  if (rtlState !== 'none' || typeof fetch !== 'function') return;
  rtlState = 'loading';
  fetch('/api/covers/right-to-left')
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then(setRightToLeft)
    .catch(() => { rtlState = 'none'; });   // e.g. not signed in yet: asked again at the next spread
}

export function markSpread(img) {
  if (!img || img.tagName !== 'IMG') return;
  const m = COVER.exec(img.currentSrc || img.src || '');
  if (!m) return;
  const spread = isSpread(img.naturalWidth, img.naturalHeight);
  img.classList.toggle('cover-spread', spread);
  if (spread) loadRightToLeft();
  const id = decodeURIComponent(m[2]);
  img.classList.toggle('cover-spread-rtl', spread && (m[1] === 'books' ? rtl.books : rtl.series).has(id));
}

if (typeof document !== 'undefined') {
  document.addEventListener('load', e => markSpread(e.target), true);
}
