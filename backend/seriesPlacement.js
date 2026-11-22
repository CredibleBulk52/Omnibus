'use strict';
// ─── Annuals and specials in a series' reading order (2026-11-21) ───────────────────────────────
// Where each annual, special and linked mini of a series goes in its Issues grid. Decided with the
// user 2026-11-20/21 (claude/SERIES_READING_ORDER.md, "Placement rules"):
//   1. an admin's pin (Read after #N, Read first, Show on shelf only) wins;
//   2. a filename hint "(Read after N)" / "(After N)" naming an issue of the run;
//   3. a saved Timeline that holds the extra and an issue of this run: the Timeline's order;
//   4. the release week (store dates; sources differ by a few days, so weeks, not days);
//   5. the same week as a regular issue: the regular issue first.
// Stay on the shelf: reprints, books without a store date, books far outside the run (more than 4
// weeks after the last or before the first issue; minis may lead in up to 10 weeks before #1),
// books next to issues without a date. On an event's own series (Convergence, Secret Wars…; at least
// half its issues in the events it homes) only pins place anything: the Event page is the full order.
// The regular issues keep their order; nothing here changes numbering, totals or the shelves.

const PIN_MODES = new Set(['after', 'first', 'shelf']);
const ANNUAL_RE = /annual/i;
const HINT_RE = /\((?:read\s+)?after\s+#?(\d+(?:\.\d+)?)\)/i;
const AFTER_WEEKS = 4, BEFORE_WEEKS = 4, MINI_BEFORE_WEEKS = 10;

function ensurePlacementSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS series_placement_pins (
    series_id      TEXT NOT NULL,
    book_id        TEXT NOT NULL,
    mode           TEXT NOT NULL,            -- after | first | shelf
    anchor_book_id TEXT,                     -- after: the regular issue it follows
    anchor_number  TEXT,                     -- after: that issue's number (used if the book is replaced)
    updated_at     INTEGER NOT NULL,
    updated_by     TEXT,
    PRIMARY KEY (series_id, book_id))`);
}

const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml || '');
  return m ? m[1].replace(/&amp;/g, '&').trim() : '';
};
// Monday-based week number of a YYYY-MM-DD date (1970-01-01 was a Thursday).
const weekOf = d => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
  return m ? Math.floor((Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 + 3) / 7) : null;
};
const num = s => { const n = parseFloat(String(s ?? '').replace(/^#/, '')); return Number.isFinite(n) ? n : null; };
const norm = s => String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');

// The label on the card's number line and its title line: "2026 Annual #1" / "Matriarch Special",
// "Knight Terrors #1", "Annual #3", "Amazons Attack #1".
function extraLabel(book, parentNames, isAnnual, runNumbers = null) {
  const ci = book.comicinfo || '';
  const number = tag(ci, 'Number') || book.issue_number || '';
  const full = tag(ci, 'Series');
  let rest = full;
  for (const p of parentNames) {
    const clean = String(p || '').replace(/^the\s+/i, '');
    const body = rest.replace(/^the\s+/i, '');
    if (clean && body.toLowerCase().startsWith(clean.toLowerCase()) && /^($|[\s:–-])/.test(body.slice(clean.length))) {
      rest = body.slice(clean.length).replace(/^[\s:–-]+/, '');
      break;
    }
  }
  // A team-up ("Green Lantern/Adam Strange", "Daredevil & Echo") or a year-named annual
  // ("Uncanny X-Men '95", "Thor 1999") keeps its full name.
  if (/^\s*(\/|&|and\s)/i.test(rest) || /^'?\d{2,4}$/.test(rest.trim())) rest = full;
  let head = rest, sub = '';
  const colon = rest.indexOf(':');
  const dash = /\s[-–]+\s/.exec(rest);                 // "Blood Hunt - Laura Kinney the Wolverine"
  if (colon >= 0) { head = rest.slice(0, colon).trim(); sub = rest.slice(colon + 1).trim(); }
  else if (dash && rest !== full) { head = rest.slice(0, dash.index).trim(); sub = rest.slice(dash.index + dash[0].length).trim(); }
  const n = String(number).replace(/^0+(?=\d)/, '');
  if (!head && !isAnnual && n && runNumbers && !runNumbers.has(num(n))) return { label: `#${n}`, title: book.title || '' };   // Green Lantern #1,000,000
  if (!head) head = isAnnual ? 'Annual' : 'Special';
  let title = book.title || '';
  if (sub && !parentNames.some(p => norm(p) === norm(sub))) title = sub.split(/\s+[-–]\s+/).pop().replace(/^the\s+/i, '');
  return { label: number ? `${head} #${String(number).replace(/^0+(?=\d)/, '')}` : head, title };
}

// The run's own order: issue number, except special numbers that went out of sequence — #0 (Zero
// Hour 1994, the New 52's Zero Month 2012), negative (Flashback #-1, 1997) and #1,000,000 (DC One
// Million, 1998) — which go by release date: Green Lantern (1990) #0 after #55, a #0 released before
// #1 stays first (user 2026-11-21: "the zero issue isn't always the first to be read"). Numbers such as
// 0.1–0.5 are left alone: libraries use them on purpose to file a prequel first.
function runOrder(regular) {
  const floats = r => { const n = num(r.issue_number); return n != null && (n === 0 || n < 0 || n >= 1000000) && weekOf(r.store_date) != null; };
  const run = regular.filter(r => !floats(r));
  const moving = regular.filter(floats).sort((a, b) => weekOf(a.store_date) - weekOf(b.store_date));
  for (const f of moving) {
    const w = weekOf(f.store_date);
    let at = -1;
    run.forEach((r, k) => { const rw = weekOf(r.store_date); if (rw != null && rw <= w) at = k; });
    run.splice(at + 1, 0, f);
  }
  return run;
}

// crossoversFor(seriesId) (crossovers.js, 2026-11-22): owned issues of other series that continue this
// series' story or lead into it — [{ bookId, afterBookId | beforeBookId, story }]. Placed in Reading order
// after the issue they continue from (or before the one they lead into). { crossovers: false } leaves them
// out: crossovers.js asks for that order to see whether a series already reads two books together.
function createSeriesPlacement({ db, members = () => [], crossoversFor = () => [] }) {
  ensurePlacementSchema(db);
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const COLS = 'id, series_id, filename, issue_number, title, comicinfo, is_special, sort_order, store_date';

  function extrasOf(seriesId, series) {
    const own = all(`SELECT ${COLS} FROM scanned_books WHERE series_id = ?`, seriesId);
    const regular = runOrder(own.filter(b => !b.is_special && !ANNUAL_RE.test(b.filename))
      .sort((a, b) => (a.sort_order - b.sort_order) || String(a.filename).localeCompare(String(b.filename))));
    const extras = [];
    const seen = new Set(own.map(b => b.id));
    // In the folder: annuals and specials. A special whose ComicInfo series has other books here is a mini.
    const inFolder = own.filter(b => b.is_special || ANNUAL_RE.test(b.filename));
    const seriesCount = new Map();
    for (const b of inFolder) if (b.is_special && !ANNUAL_RE.test(b.filename)) {
      const k = norm(tag(b.comicinfo, 'Series')); seriesCount.set(k, (seriesCount.get(k) || 0) + 1);
    }
    for (const b of inFolder) {
      const annual = ANNUAL_RE.test(b.filename);
      extras.push({ book: b, kind: annual ? 'annual' : 'special', mini: !annual && (seriesCount.get(norm(tag(b.comicinfo, 'Series'))) || 0) > 1 });
    }
    // Linked annual volumes (series_annual_links), as on the Annuals shelf.
    if (series?.monitored_series_id) {
      for (const s of all(`SELECT ss.id FROM series_annual_links l JOIN scanned_series ss ON ss.monitored_series_id = l.annual_series_id
                           WHERE l.parent_series_id = ?`, series.monitored_series_id)) {
        for (const b of all(`SELECT ${COLS} FROM scanned_books WHERE series_id = ?`, s.id)) {
          if (!seen.has(b.id)) { seen.add(b.id); extras.push({ book: b, kind: 'annual', mini: false }); }
        }
      }
    }
    // Series on the Specials shelf (series grouping): one-shots, and minis of two or more books.
    for (const m of members(seriesId) || []) {
      const books = all(`SELECT ${COLS} FROM scanned_books WHERE series_id = ?`, m.id);
      for (const b of books) if (!seen.has(b.id)) { seen.add(b.id); extras.push({ book: b, kind: 'linked', mini: books.length > 1 }); }
    }
    // Each mini's latest release week, for the lead-in window.
    const groupKey = x => (x.kind === 'linked' ? `s:${x.book.series_id}` : `c:${norm(tag(x.book.comicinfo, 'Series'))}`);
    const last = new Map();
    for (const x of extras) if (x.mini) {
      const w = weekOf(x.book.store_date);
      if (w != null && (!last.has(groupKey(x)) || w > last.get(groupKey(x)))) last.set(groupKey(x), w);
    }
    for (const x of extras) if (x.mini) x.miniLast = last.get(groupKey(x)) ?? null;
    return { regular, extras };
  }

  // Timeline positions: book id -> [{event, order}] for saved (non-draft) events.
  function timelineOf(ids) {
    const out = new Map();
    if (!ids.length) return out;
    try {
      for (let i = 0; i < ids.length; i += 500) {
        const part = ids.slice(i, i + 500);
        for (const r of all(`SELECT ei.event_id AS event, ei.scanned_book_id AS book, ei.sort_order AS ord, e.year, e.name
            FROM event_issues ei JOIN events e ON e.id = ei.event_id
            WHERE COALESCE(e.draft, 0) = 0 AND ei.scanned_book_id IN (${part.map(() => '?').join(',')})`, ...part)) {
          if (!out.has(r.book)) out.set(r.book, []);
          out.get(r.book).push(r);
        }
      }
    } catch { /* no events tables yet */ }
    return out;
  }

  // An event's own series: the home of a saved event with at least half of its issues in the events it
  // homes (2026-11-21: Convergence, Secret Wars, House of M 89%; an ongoing that hosts an event —
  // Green Lantern (1990) and Circle of Fire, The Amazing Spider-Man and Spider-Island — has at most 42%).
  // Returns those events ([{ id, name, year, tier }], by year) or [] — the Issues page links to them
  // ("Read in event order", 2026-11-21).
  function eventHomeOf(seriesId, regular) {
    try {
      const evs = all('SELECT * FROM events WHERE home_series_id = ? AND COALESCE(draft, 0) = 0', seriesId);
      if (!evs.length || !regular.length) return [];
      const inEvent = new Set(all(`SELECT scanned_book_id AS b FROM event_issues WHERE scanned_book_id IS NOT NULL
        AND event_id IN (${evs.map(() => '?').join(',')})`, ...evs.map(e => e.id)).map(r => r.b));
      if (regular.filter(r => inEvent.has(r.id)).length * 2 < regular.length) return [];
      return evs.map(e => ({ id: e.id, name: e.name, year: e.year || null, tier: e.event_tier ?? null }))
        .sort((a, b) => (a.year || 0) - (b.year || 0) || String(a.name).localeCompare(String(b.name)));
    } catch { return []; }
  }

  // The automatic position of one extra: { after: index of the regular issue it follows (-1 = before the
  // first), evidence, ord } or { shelf: reason }.
  function automatic(x, regular, weeks, timeline, regIndex) {
    const b = x.book;
    const hint = HINT_RE.exec(b.filename || '');
    if (hint) {
      const n = num(hint[1]);
      const i = regular.findIndex(r => num(r.issue_number) === n);
      if (i >= 0) return { after: i, evidence: 'filename' };
    }
    const tl = (timeline.get(b.id) || []).slice().sort((a, c) => (a.year || 0) - (c.year || 0) || String(a.name).localeCompare(String(c.name)));
    for (const ev of tl) {
      const regs = [];
      for (const r of regular) for (const p of timeline.get(r.id) || []) if (p.event === ev.event) regs.push({ i: regIndex.get(r.id), ord: p.ord });
      if (!regs.length) continue;
      const before = regs.filter(r => r.ord < ev.ord).sort((a, c) => c.ord - a.ord)[0];
      if (before) return { after: before.i, evidence: 'timeline', ord: ev.ord, event: ev.event };
      const first = regs.sort((a, c) => a.ord - c.ord)[0];
      return { after: first.i - 1, evidence: 'timeline', ord: ev.ord, event: ev.event };
    }
    if (/\breprint/i.test(`${tag(b.comicinfo, 'Summary')} ${tag(b.comicinfo, 'Notes')}`)) return { shelf: 'reprint' };
    const w = weekOf(b.store_date);
    if (w == null) return { shelf: 'no store date' };
    let i = -1;
    weeks.forEach((rw, k) => { if (rw != null && rw <= w) i = k; });
    if (i < 0) {
      const first = weeks.findIndex(rw => rw != null);
      if (first < 0) return { shelf: 'no dates in the run' };
      if (first > 0) return { shelf: 'next to issues without a date' };
      const lead = x.mini && x.miniLast != null ? x.miniLast : w;   // a mini counts from its last issue
      // The run's earliest release, not its first issue's: #0 issues often came out years later (Zero Hour).
      const start = Math.min(...weeks.filter(v => v != null));
      return start - lead <= (x.mini ? MINI_BEFORE_WEEKS : BEFORE_WEEKS) && start >= lead
        ? { after: -1, evidence: 'release week' } : { shelf: 'long before the run' };
    }
    let j = i + 1;
    while (j < weeks.length && weeks[j] == null) j++;
    if (j > i + 1) return { shelf: 'next to issues without a date' };
    if (j >= weeks.length && w - weeks[i] > AFTER_WEEKS) return { shelf: 'long after the run' };
    return { after: i, evidence: weeks[i] === w ? 'same week, regular issue first' : 'release week' };
  }

  // The series' reading order: placed extras with the regular issue each follows, and the shelved rest.
  function placement(seriesId, { crossovers = true } = {}) {
    const series = one('SELECT id, name, monitored_series_id FROM scanned_series WHERE id = ?', seriesId);
    if (!series) return null;
    const { regular, extras } = extrasOf(seriesId, series);
    const regIndex = new Map(regular.map((r, i) => [r.id, i]));
    const weeks = regular.map(r => weekOf(r.store_date));
    const timeline = timelineOf([...regular, ...extras.map(x => x.book)].map(b => b.id));
    const pins = new Map(all('SELECT * FROM series_placement_pins WHERE series_id = ?', seriesId).map(p => [p.book_id, p]));
    const homeEvents = eventHomeOf(seriesId, regular);
    const eventHome = homeEvents.length > 0;
    const parentNames = [series.name, tag(regular[0]?.comicinfo, 'Series')].filter(Boolean);
    const runNumbers = new Set(regular.map(r => num(r.issue_number)).filter(v => v != null));
    const placed = [], shelf = [];
    for (const x of extras) {
      const pin = pins.get(x.book.id);
      let pos;
      if (pin?.mode === 'shelf') pos = { shelf: 'pinned to the shelf' };
      else if (pin?.mode === 'first') pos = { after: -1, evidence: 'pin' };
      else if (pin?.mode === 'after') {
        let i = regIndex.has(pin.anchor_book_id) ? regIndex.get(pin.anchor_book_id) : -2;
        if (i === -2 && num(pin.anchor_number) != null) {      // the anchor was replaced: follow its number
          i = -1;
          regular.forEach((r, k) => { if (num(r.issue_number) != null && num(r.issue_number) <= num(pin.anchor_number)) i = k; });
        }
        pos = i === -2 ? { shelf: 'pinned issue is gone' } : { after: i, evidence: 'pin' };
      } else if (eventHome) pos = { shelf: "event series: the Event page has the full order" };
      else pos = automatic(x, regular, weeks, timeline, regIndex);
      const label = extraLabel(x.book, parentNames, x.kind === 'annual' || ANNUAL_RE.test(x.book.filename), runNumbers);
      if (pos.shelf) shelf.push({ bookId: x.book.id, reason: pos.shelf, pinned: !!pin });
      else placed.push({ bookId: x.book.id, afterBookId: pos.after >= 0 ? regular[pos.after].id : null, after: pos.after,
        evidence: pos.evidence, kind: x.kind, mini: x.mini, pinned: !!pin, ...label,
        sortKey: [x.book.store_date || '9999-99-99', pos.ord ?? 0, String(x.book.filename || ''), pos.event ?? null] });
    }
    // Crossover issues from other series (crossovers.js): after the issue they continue, before the one
    // they lead into. A pin moves or shelves one like any extra; a book already placed is not added twice.
    // Parts not in the library go to `missing` (shown like other missing issues; same order keys).
    const missing = [];
    if (crossovers) {
      const taken = new Set([...placed.map(p => p.bookId), ...shelf.map(p => p.bookId), ...regIndex.keys()]);
      let list = [];
      try { list = crossoversFor(seriesId) || []; } catch { list = []; }
      for (const c of list) {
        if (c.missing) {   // a part not in the library: shown as a missing issue after its anchor
          const after = c.afterBookId != null ? regIndex.get(c.afterBookId) : regIndex.has(c.beforeBookId) ? regIndex.get(c.beforeBookId) - 1 : undefined;
          if (after === undefined || missing.some(m => m.linkId === c.missing.linkId)) continue;
          const n = String(c.missing.issue_number || '').replace(/^0+(?=\d)/, '');
          missing.push({ linkId: c.missing.linkId, after, afterBookId: after >= 0 ? regular[after].id : null, kind: 'crossover',
            series_name: c.missing.series_name, number: n, label: `${c.missing.series_name}${n ? ` #${n}` : ''}`,
            title: c.missing.story ? `Crossover · ${c.missing.story}` : 'Crossover',
            status: c.missing.status || null, date: c.missing.date || null,   // its Download Manager state, release date
            sortKey: [c.chainDate || '9999-99-99', c.seq ?? 0, '', null] });
          continue;
        }
        if (taken.has(c.bookId)) continue;
        const book = one(`SELECT ${COLS} FROM scanned_books WHERE id = ?`, c.bookId);
        if (!book) continue;
        let after = c.afterBookId != null ? regIndex.get(c.afterBookId) : regIndex.has(c.beforeBookId) ? regIndex.get(c.beforeBookId) - 1 : undefined;
        if (after === undefined) continue;
        const pin = pins.get(c.bookId);
        if (pin?.mode === 'shelf') { shelf.push({ bookId: c.bookId, reason: 'pinned to the shelf', pinned: true }); taken.add(c.bookId); continue; }
        if (pin?.mode === 'first') after = -1;
        else if (pin?.mode === 'after' && regIndex.has(pin.anchor_book_id)) after = regIndex.get(pin.anchor_book_id);
        const name = tag(book.comicinfo, 'Series') || one('SELECT name FROM scanned_series WHERE id = ?', book.series_id)?.name || '';
        const n = String(tag(book.comicinfo, 'Number') || book.issue_number || '').replace(/^0+(?=\d)/, '');
        placed.push({ bookId: c.bookId, afterBookId: after >= 0 ? regular[after].id : null, after, evidence: pin ? 'pin' : 'crossover', kind: 'crossover', mini: false,
          pinned: !!pin, label: n ? `${name} #${n}` : name, title: c.story ? `Crossover · ${c.story}` : 'Crossover', story: c.story || null,
          // One story's parts after one issue keep the story's order (crossovers.js walks the chain).
          sortKey: [c.chainDate || book.store_date || '9999-99-99', c.seq ?? 0, String(book.filename || ''), null] });
        taken.add(c.bookId);
      }
    }
    // Several extras after one issue: by date, then Timeline order, then filename (and see below).
    placed.sort((a, b) => (a.after - b.after) || (a.sortKey[0] < b.sortKey[0] ? -1 : a.sortKey[0] > b.sortKey[0] ? 1 : 0)
      || (a.sortKey[1] - b.sortKey[1]) || a.sortKey[2].localeCompare(b.sortKey[2]));
    // Books placed after one issue by the same Timeline follow that Timeline among themselves: they swap
    // within the places they hold, so a late-shipping finale stays before its epilogue (Captain America:
    // Reborn #6 before Who Will Wield the Shield?) and the other books keep their date order around them.
    const sameTimeline = new Map();
    placed.forEach((p, i) => {
      if (p.evidence !== 'timeline' || p.sortKey[3] == null) return;
      const k = `${p.after}|${p.sortKey[3]}`;
      if (!sameTimeline.has(k)) sameTimeline.set(k, []);
      sameTimeline.get(k).push(i);
    });
    for (const idx of sameTimeline.values()) {
      if (idx.length < 2) continue;
      const items = idx.map(i => placed[i]).sort((a, b) => (a.sortKey[1] - b.sortKey[1]) || a.sortKey[2].localeCompare(b.sortKey[2]));
      idx.forEach((i, k) => { placed[i] = items[k]; });
    }
    // Missing crossover parts take their place among the placed books after the same issue: `order` is the
    // position in one list sorted the same way (after, date, story order).
    const cmp = (a, b) => (a.after - b.after) || (a.sortKey[0] < b.sortKey[0] ? -1 : a.sortKey[0] > b.sortKey[0] ? 1 : 0) || (a.sortKey[1] - b.sortKey[1]);
    const byAnchor = new Map();
    placed.forEach((p, i) => { p.order = i * 10; });
    for (const m of missing) {
      // After the last placed book it sorts after (or at the front of the group).
      const group = placed.filter(p => p.after === m.after);
      const before = group.filter(p => cmp(p, m) <= 0).pop();
      m.order = before ? before.order + 1 + (byAnchor.get(before) || 0) : (group[0] ? group[0].order - 5 : (m.after + 1) * 100000);
      byAnchor.set(before, (byAnchor.get(before) || 0) + 1);
    }
    for (const m of missing) delete m.sortKey;
    placed.forEach(p => { delete p.sortKey; });
    return { seriesId, eventHome, homeEvents, regular: regular.map(r => ({ id: r.id, number: r.issue_number })), placed, shelf, missing,
      pins: Object.fromEntries([...pins.values()].map(p => [p.book_id, { mode: p.mode, anchorBookId: p.anchor_book_id || null }])) };
  }

  // The displayed order: regular issues with the placed extras after their anchors —
  // [{ id, placed }] (placed: the extra's entry with its label, or null for a regular issue).
  function order(seriesId, opts) {
    const p = placement(seriesId, opts);
    if (!p) return null;
    const out = p.placed.filter(x => x.after < 0).map(x => ({ id: x.bookId, placed: x }));
    p.regular.forEach((r, i) => { out.push({ id: r.id, placed: null }); for (const x of p.placed) if (x.after === i) out.push({ id: x.bookId, placed: x }); });
    return out;
  }
  const sequence = (seriesId, opts) => order(seriesId, opts)?.map(x => x.id) ?? null;

  function setPin(seriesId, bookId, { mode, anchorBookId } = {}, userId = null) {
    if (!PIN_MODES.has(mode)) throw Object.assign(new Error('mode must be after, first or shelf'), { status: 400 });
    let anchorNumber = null;
    if (mode === 'after') {
      const a = one('SELECT id, issue_number, filename, is_special FROM scanned_books WHERE id = ? AND series_id = ?', String(anchorBookId || ''), seriesId);
      if (!a || a.is_special || ANNUAL_RE.test(a.filename)) throw Object.assign(new Error('Choose a regular issue of this series'), { status: 400 });
      anchorNumber = a.issue_number;
    }
    if (!one('SELECT 1 FROM scanned_books WHERE id = ?', bookId)) throw Object.assign(new Error('Book not found'), { status: 404 });
    db.prepare(`INSERT INTO series_placement_pins (series_id, book_id, mode, anchor_book_id, anchor_number, updated_at, updated_by)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(series_id, book_id) DO UPDATE SET mode = excluded.mode, anchor_book_id = excluded.anchor_book_id,
      anchor_number = excluded.anchor_number, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(seriesId, bookId, mode, mode === 'after' ? String(anchorBookId) : null, anchorNumber, Date.now(), userId);
  }
  const clearPin = (seriesId, bookId) => db.prepare('DELETE FROM series_placement_pins WHERE series_id = ? AND book_id = ?').run(seriesId, bookId).changes;

  return { placement, order, sequence, setPin, clearPin };
}

// Routes (2026-11-21). GET for any signed-in reader (the series page's Issues grid); pins for admins:
// one shared reading order per series (user's choice).
function registerPlacementRoutes({ app, db, requireAuth, requireAdmin, members, parseComicInfo, withEventMarkers, crossoversFor }) {
  const placement = createSeriesPlacement({ db, members, crossoversFor });
  const fail = (res, e) => res.status(e.status || 500).json({ error: e.message });
  app.get('/api/series/:id/placement', requireAuth, (req, res) => {
    try {
      const p = placement.placement(req.params.id);
      if (!p) return res.status(404).json({ error: 'Series not found' });
      const ids = p.placed.map(x => x.bookId);
      const rows = new Map();
      for (let i = 0; i < ids.length; i += 500) {
        const part = ids.slice(i, i + 500);
        for (const b of db.prepare(`SELECT * FROM scanned_books WHERE id IN (${part.map(() => '?').join(',')})`).all(...part)) rows.set(b.id, b);
      }
      const userId = req.user?.sub || null;
      const progress = new Map();
      if (userId && ids.length) {
        for (let i = 0; i < ids.length; i += 500) {
          const part = ids.slice(i, i + 500);
          for (const r of db.prepare(`SELECT book_id, page, completed FROM read_progress WHERE user_id = ? AND book_id IN (${part.map(() => '?').join(',')})`).all(userId, ...part)) progress.set(r.book_id, r);
        }
      }
      // The same shape as /api/series/:id/books, so the grid renders a placed book like an issue.
      const mapped = ids.filter(id => rows.has(id)).map(id => {
        const b = rows.get(id), ci = b.comicinfo ? parseComicInfo(b.comicinfo) : {}, rp = progress.get(id);
        return { ...b, comicinfo: ci, metadata: { number: b.issue_number, title: b.title, numberSort: b.sort_order },
          media: { pagesCount: ci.pageCount || null }, readProgress: rp ? { page: rp.page, completed: !!rp.completed } : null };
      });
      const books = new Map(withEventMarkers(db, mapped).map(b => [b.id, b]));
      res.json({ ...p, placed: p.placed.filter(x => books.has(x.bookId)).map(x => ({ ...x, book: books.get(x.bookId) })) });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/series/:id/placement/:bookId', requireAdmin, (req, res) => {
    try { placement.setPin(req.params.id, req.params.bookId, req.body || {}, req.user?.sub || null); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.delete('/api/series/:id/placement/:bookId', requireAdmin, (req, res) => {
    try { res.json({ ok: true, cleared: placement.clearPin(req.params.id, req.params.bookId) }); } catch (e) { fail(res, e); }
  });
  return placement;
}

module.exports = { createSeriesPlacement, ensurePlacementSchema, extraLabel, weekOf, registerPlacementRoutes };
