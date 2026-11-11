'use strict';
// ─── Covers peeking out of a box tile (2026-11-04) ───────────────────────────
// A box shows up to n covers sticking out of its top. Its series come first (a
// random handful). A box with too few series to fill the row is topped up with
// issues from those series: spread through each run, never the issue already
// shown as the series cover, shared out evenly between the series.

function shuffled(list, rand = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// k issues spread evenly through a run (not the ends first: the middle reads as variety).
function spread(list, k) {
  if (k >= list.length) return list.slice();
  const out = [];
  for (let i = 0; i < k; i++) out.push(list[Math.floor(((i + 0.5) * list.length) / k)]);
  return out;
}

// seriesIds: the box's series. booksFor(seriesId): its book ids in reading order,
// without its cover book. Returns [{ kind: 'series'|'book', id }].
function pickPeek(seriesIds, booksFor, n = 8, rand = Math.random) {
  const series = shuffled(seriesIds, rand).slice(0, n);
  const out = series.map(id => ({ kind: 'series', id }));
  let left = n - out.length;
  if (left <= 0 || !series.length) return out;
  return out.concat(fillFrom(series, booksFor, left).map(id => ({ kind: 'book', id })));
}

// k issues from these series: the slots shared out evenly (a short run passes its unused
// share on), spread through each run, interleaved so neighbours differ.
function fillFrom(seriesIds, booksFor, k) {
  const pools = seriesIds.map(id => ({ id, books: booksFor(id) || [] })).filter(p => p.books.length);
  const want = new Map(pools.map(p => [p.id, 0]));
  let left = k;
  while (left > 0) {
    let gave = false;
    for (const p of pools) {
      if (left <= 0) break;
      if (want.get(p.id) < p.books.length) { want.set(p.id, want.get(p.id) + 1); left--; gave = true; }
    }
    if (!gave) break;
  }
  const picks = pools.map(p => spread(p.books, want.get(p.id)));
  const out = [];
  for (let i = 0; picks.some(l => i < l.length); i++)
    for (const l of picks) if (i < l.length) out.push(l[i]);
  return out;
}

module.exports = { pickPeek, fillFrom, spread, shuffled };
