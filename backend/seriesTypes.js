'use strict';
// ─── Metron series types for the Shelf Sorter (2026-11-14) ─────────
// claude/SHELF_SORTER_STAGE_B.md. Comic Vine only gives an issue count, so a 6-issue ongoing that was
// cancelled (Arkham Manor, Avengers Inc.) looks like a planned mini. Metron records the kind of
// series ("Ongoing Series", "Limited Series", "One-Shot", …). This job looks it up, by the Comic Vine
// volume ID in series.json, for the series the Shelf Sorter may ask about, a batch at a time (each
// series costs Metron one or two requests at its shared pace). Without a Metron token it does nothing.
//   kind: 'ongoing' | 'limited' | 'one-shot' | 'other' (graphic novel, annual, …) | 'unknown' (Metron has no match)
const RECHECK_UNKNOWN_DAYS = 30;
const DAY = 86400000;

function kindOf(type) {
  const t = String(type || '').toLowerCase();
  if (!t) return 'unknown';
  if (/ongoing/.test(t)) return 'ongoing';
  if (/limited|mini/.test(t)) return 'limited';
  if (/one[- ]?shot/.test(t)) return 'one-shot';
  return 'other';
}

function initSeriesTypes(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS series_types (
    comicid    TEXT PRIMARY KEY,      -- Comic Vine volume ID (series.json comicid)
    metron_id  INTEGER,
    type       TEXT,                  -- Metron's own words, e.g. "Ongoing Series"
    kind       TEXT NOT NULL,         -- ongoing | limited | one-shot | other | unknown
    checked_at INTEGER NOT NULL)`);
}

function createSeriesTypes({ db, metron = null, logger = null, now = Date.now }) {
  initSeriesTypes(db);
  const put = db.prepare(`INSERT INTO series_types (comicid, metron_id, type, kind, checked_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(comicid) DO UPDATE SET metron_id = excluded.metron_id, type = excluded.type, kind = excluded.kind, checked_at = excluded.checked_at`);
  const all = () => new Map(db.prepare('SELECT comicid, type, kind, checked_at FROM series_types').all().map(r => [r.comicid, r]));
  let running = false;
  const state = { done: 0, total: 0 };

  // items: [{ comicid, name, year }]. Looks up those not known yet (an unknown is tried again after 30 days).
  async function run(items, { limit = 60, onKinds = null } = {}) {
    if (running) return { skipped: true };
    if (!metron) return { skipped: true, reason: 'no Metron client' };
    const known = all();
    const todo = items.filter(it => it.comicid && (() => {
      const k = known.get(String(it.comicid));
      return !k || (k.kind === 'unknown' && now() - k.checked_at > RECHECK_UNKNOWN_DAYS * DAY);
    })()).slice(0, limit);
    if (!todo.length) return { looked: 0 };
    running = true;
    Object.assign(state, { done: 0, total: todo.length });
    const stats = { looked: 0, ongoing: 0, limited: 0, 'one-shot': 0, other: 0, unknown: 0 };
    const found = [];
    try {
      for (const it of todo) {
        let r;
        try { r = await metron.seriesStatus(String(it.comicid), { name: it.name, year: it.year }); }
        catch (e) {
          if (e.code === 'METRON_TOKEN_MISSING' || e.code === 'METRON_AUTH') { stats.stopped = e.message; break; }
          logger?.warn?.('series-types', `Metron lookup failed for "${it.name}"`, e.message);
          state.done++; continue;
        }
        state.done++;
        if (r && r.seriesType === undefined) continue;   // an older cached answer without the type: try again later
        const kind = r ? kindOf(r.seriesType) : 'unknown';
        put.run(String(it.comicid), r ? r.id : null, r ? r.seriesType : null, kind, now());
        stats.looked++; stats[kind]++;
        found.push(String(it.comicid));
      }
    } finally { running = false; }
    if (stats.looked) logger?.info?.('series-types', 'Run complete', stats);
    if (found.length && onKinds) { try { onKinds(found); } catch (e) { logger?.warn?.('series-types', 'Follow-up failed', e.message); } }
    return stats;
  }

  return { run, all, kindOf, status: () => ({ running, ...state }) };
}

module.exports = { createSeriesTypes, initSeriesTypes, kindOf };
