'use strict';
// ─── Reading contexts (Continue Reading by event / run / list) ────
// The reader sends the context it is reading through (Timeline event, Top Shelf
// run, reading list or Essential) with each progress save. Continue Reading on
// the home page then shows one card per context with the next issue in that
// context's order (crossovers and segments of series included), and leaves out
// the single-series cards for issues last read through a context (user 2026-10-29).
//
// Tables: reading_contexts (one row per user and context) and read_progress.context
// (the context an issue was last read through; NULL = read on its own).

const KINDS = new Set(['event', 'run', 'list']);
const TIERS = new Set(['essential', 'recommended', 'all']);
const inTier = (tier, path) => path === 'all' || tier === 'essential' || (path === 'recommended' && tier === 'recommended');

function applySchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS reading_contexts (
    user_id TEXT NOT NULL, ctx TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL, min_tier TEXT,
    last_book_id TEXT, updated_at TEXT NOT NULL, dismissed_at TEXT,
    PRIMARY KEY (user_id, ctx))`);
  try { db.exec('ALTER TABLE read_progress ADD COLUMN context TEXT'); } catch {}
}

// { kind, id, minTier } from the reader → a checked context, or null.
function parse(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || ''), id = String(raw.id ?? '').trim();
  if (!KINDS.has(kind) || !id || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const minTier = kind === 'event' && TIERS.has(raw.minTier) ? raw.minTier : null;
  return { kind, id, minTier, key: `${kind}:${id}` };
}

function create({ db, readingLists }) {
  applySchema(db);
  const now = () => db.prepare("SELECT datetime('now') AS t").get().t;

  // Called by PUT /api/read-progress after the progress row is saved.
  function record(userId, bookId, ctx, { page, completed }) {
    if (!userId) return;
    db.prepare('UPDATE read_progress SET context = ? WHERE user_id = ? AND book_id = ?').run(ctx ? ctx.key : null, userId, String(bookId));
    if (!ctx || (!(page > 0) && !completed)) return;    // opening an issue is not reading it
    db.prepare(`INSERT INTO reading_contexts (user_id, ctx, kind, ref_id, min_tier, last_book_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, ctx) DO UPDATE SET min_tier = excluded.min_tier, last_book_id = excluded.last_book_id, updated_at = excluded.updated_at`)
      .run(userId, ctx.key, ctx.kind, ctx.id, ctx.minTier, String(bookId), now());
  }

  function dismiss(userId, key) {
    return db.prepare('UPDATE reading_contexts SET dismissed_at = ? WHERE user_id = ? AND ctx = ?').run(now(), userId, String(key)).changes > 0;
  }

  // The context's owned issues in reading order, with its name and page; null when it is gone
  // or the user cannot see it.
  function ordered(row, userId) {
    if (row.kind === 'list') {
      const ids = readingLists && readingLists.orderedBooks(row.ref_id, { sub: userId });
      if (!ids) return null;
      const l = db.prepare('SELECT name, visibility FROM reading_lists WHERE id = ?').get(Number(row.ref_id));
      if (!l) return null;
      return { name: l.name, to: `/${l.visibility === 'essential' ? 'essentials' : 'reading-lists'}/${row.ref_id}`, label: l.visibility === 'essential' ? 'Essential' : 'Reading list',
        qs: `?listId=${encodeURIComponent(row.ref_id)}`, ids };
    }
    if (row.kind === 'event') {
      const ev = db.prepare('SELECT id, name FROM events WHERE id = ?').get(row.ref_id);
      if (!ev) return null;
      const path = TIERS.has(row.min_tier) ? row.min_tier : 'all';
      const ids = db.prepare(`SELECT ei.scanned_book_id AS b, ei.tier FROM event_issues ei JOIN scanned_books sb ON sb.id = ei.scanned_book_id
        WHERE ei.event_id = ? ORDER BY ei.sort_order`).all(ev.id).filter(r => inTier(r.tier, path)).map(r => String(r.b));
      return { name: ev.name, to: `/events/${encodeURIComponent(ev.id)}`, label: 'Event', qs: `?eventId=${encodeURIComponent(ev.id)}&minTier=${path}`, ids: [...new Set(ids)] };
    }
    const run = db.prepare('SELECT id, title FROM canon_runs WHERE id = ?').get(Number(row.ref_id));
    if (!run) return null;
    const ids = db.prepare(`SELECT CAST(cri.scanned_book_id AS TEXT) AS b FROM canon_run_issues cri JOIN scanned_books sb ON sb.id = CAST(cri.scanned_book_id AS TEXT)
      WHERE cri.run_id = ? ORDER BY cri.sort_order`).all(run.id).map(r => r.b);
    return { name: run.title, to: `/canon/run/${run.id}`, label: 'Top Shelf run', qs: `?canonRunId=${run.id}`, ids: [...new Set(ids)] };
  }

  // The issue to read next: the last one opened here if it is part-read; else the first
  // unfinished issue after it; else the first unfinished issue anywhere; null when all read.
  function nextIn(ids, lastBookId, progress) {
    const p = id => progress.get(id) || { page: 0, completed: 0 };
    const at = ids.indexOf(String(lastBookId));
    if (at !== -1 && !p(ids[at]).completed && p(ids[at]).page > 0) return at;
    for (let i = at + 1; i < ids.length; i++) if (!p(ids[i]).completed) return i;
    for (let i = 0; i < ids.length; i++) if (!p(ids[i]).completed) return i;
    return -1;
  }

  // Continue Reading cards. live: every context that still exists (finished or hidden ones
  // too), so its issues stay off the single-series cards.
  function cards(userId, { libraryId = null, limit = 30 } = {}) {
    const out = [], live = new Set();
    if (!userId) return { cards: out, live };
    const rows = db.prepare('SELECT * FROM reading_contexts WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
    const progressOf = db.prepare('SELECT book_id, page, completed FROM read_progress WHERE user_id = ? AND book_id IN (SELECT value FROM json_each(?))');
    const bookRow = db.prepare(`SELECT sb.*, ss.name AS seriesName, ss.id AS seriesId, ss.library_id AS libraryId FROM scanned_books sb
      JOIN scanned_series ss ON ss.id = sb.series_id WHERE sb.id = ?`);
    for (const row of rows) {
      let o; try { o = ordered(row, userId); } catch { o = null; }
      if (!o) continue;
      live.add(row.ctx);
      if (row.dismissed_at && row.dismissed_at >= row.updated_at) continue;
      if (out.length >= limit || !o.ids.length) continue;
      const progress = new Map(progressOf.all(userId, JSON.stringify(o.ids)).map(r => [String(r.book_id), r]));
      const i = nextIn(o.ids, row.last_book_id, progress);
      if (i === -1) continue;                                    // finished
      const book = bookRow.get(o.ids[i]);
      if (!book || (libraryId && String(book.libraryId) !== String(libraryId))) continue;
      out.push({ ...book, page: progress.get(o.ids[i])?.completed ? 0 : (progress.get(o.ids[i])?.page || 0), _activity: row.updated_at,
        fromContext: { key: row.ctx, kind: row.kind, id: row.ref_id, name: o.name, label: o.label, to: o.to, readQs: o.qs,
          position: i + 1, total: o.ids.length, read: o.ids.filter(id => progress.get(id)?.completed).length } });
    }
    return { cards: out, live };
  }

  // The context the series was last read through (its latest reading-progress row).
  const lastCtx = db.prepare(`SELECT rp.context FROM read_progress rp JOIN scanned_books sb ON sb.id = rp.book_id
    WHERE rp.user_id = ? AND sb.series_id = ? AND COALESCE(rp.marked, 0) = 0 AND (rp.completed = 1 OR rp.page > 0)
    ORDER BY rp.updated_at DESC, rp.id DESC LIMIT 1`);
  function seriesLastContext(userId, seriesId) { try { return lastCtx.get(userId, seriesId)?.context || null; } catch { return null; } }

  return { record, dismiss, cards, seriesLastContext, nextIn };
}

module.exports = { create, parse, applySchema };
