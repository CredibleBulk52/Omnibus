'use strict';
// ─── Timeline event markers on issue cards (2026-11-19) ──────────────
// The Timeline events each book belongs to, for the series page's Issues, Annuals and Specials shelves
// (claude/SERIES_READING_ORDER.md: event markers). From event_issues rows matched to a library book
// (scanned_book_id); draft events are left out. A book's events are ordered by its role in them
// (essential, recommended, tie-in, aftermath), then by event year and name, so the card names the
// event where the issue matters most and "+1" holds the rest.

const ROLE_RANK = { essential: 0, recommended: 1, 'tie-in': 2, aftermath: 3 };
const CHUNK = 500;

// bookIds → Map(bookId → [{ id, name, year, tier, eventTier }])
function eventMarkersFor(db, bookIds) {
  const ids = [...new Set((bookIds || []).filter(Boolean).map(String))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const rows = db.prepare(`SELECT ei.scanned_book_id AS book_id, e.id, e.name, e.year, e.event_tier, ei.tier
      FROM event_issues ei JOIN events e ON e.id = ei.event_id
      WHERE ei.scanned_book_id IN (${part.map(() => '?').join(',')}) AND COALESCE(e.draft, 0) = 0`).all(...part);
    for (const r of rows) {
      const list = out.get(r.book_id) || [];
      const seen = list.find(x => x.id === r.id);
      // One book listed twice in the same event: keep its most important role.
      if (seen) { if ((ROLE_RANK[r.tier] ?? 9) < (ROLE_RANK[seen.tier] ?? 9)) seen.tier = r.tier; continue; }
      // eventTier: 1 crisis, 2 major, 3 crossover (the Timeline's ★ badge; the reader's end card).
      list.push({ id: r.id, name: r.name, year: r.year || null, tier: r.tier || null, eventTier: r.event_tier ?? null });
      out.set(r.book_id, list);
    }
  }
  for (const list of out.values()) {
    list.sort((a, b) => (ROLE_RANK[a.tier] ?? 9) - (ROLE_RANK[b.tier] ?? 9)
      || String(a.year || '').localeCompare(String(b.year || '')) || String(a.name).localeCompare(String(b.name)));
  }
  return out;
}

// Adds `events` (possibly empty) to each mapped book object.
function withEventMarkers(db, books) {
  const markers = eventMarkersFor(db, books.map(b => b.id));
  return books.map(b => ({ ...b, events: markers.get(String(b.id)) || [] }));
}

module.exports = { eventMarkersFor, withEventMarkers, ROLE_RANK };
