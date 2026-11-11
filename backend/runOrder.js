'use strict';
// ─── runOrder.js ──────────────────────────────────────────────────
// Top Shelf run order. canon_run_issues.sort_order is the one reading
// order: run page, reader next/previous, reading lists that follow a run,
// and the editor (where it can be dragged). User 2026-10-16.
//
// placeNew   — issues just added to a run go in by number next to the same
//              series (never appended at the end, which is how 33 runs
//              became scrambled: issues added back one at a time).
// resetNumberOrder — one-time: runs that are a single series put back in
//              issue-number order. Runs with several series (crossovers)
//              keep their stored order.
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : Infinity; };
const norm = s => String(s || '').trim().toLowerCase();
// Same series: same name, and same volume year unless one is unknown.
const sameSeries = (a, b) => norm(a.series_name) === norm(b.series_name)
  && (!a.volume_year || !b.volume_year || String(a.volume_year) === String(b.volume_year));
const byNumber = (a, b) => num(a.issue_number) - num(b.issue_number) || (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id;

function rowsOf(db, runId) {
  return db.prepare('SELECT id, series_name, volume_year, issue_number, sort_order FROM canon_run_issues WHERE run_id = ? ORDER BY sort_order, id').all(runId);
}
function write(db, rows) {
  const upd = db.prepare('UPDATE canon_run_issues SET sort_order = ? WHERE id = ?');
  let changed = 0;
  rows.forEach((r, i) => { if (r.sort_order !== i + 1) { upd.run(i + 1, r.id); changed++; } });
  return changed;
}

function placeNew(db, runId, newIds) {
  const ids = new Set((newIds || []).map(Number).filter(Boolean));
  if (!ids.size) return 0;
  const rows = rowsOf(db, runId);
  const seq = rows.filter(r => !ids.has(r.id));
  for (const r of rows.filter(x => ids.has(x.id)).sort(byNumber)) {
    const n = num(r.issue_number);
    let at = -1;
    seq.forEach((x, i) => { if (sameSeries(x, r) && num(x.issue_number) <= n) at = i + 1; });   // after the last lower issue
    if (at < 0) { const j = seq.findIndex(x => sameSeries(x, r)); at = j >= 0 ? j : seq.length; } // before the first of its series, or at the end
    seq.splice(at, 0, r);
  }
  return write(db, seq);
}

function isSingleSeries(rows) { return rows.every(r => sameSeries(r, rows[0])); }

function resetNumberOrder(db) {
  const changed = [];
  for (const run of db.prepare('SELECT id, title FROM canon_runs').all()) {
    const rows = rowsOf(db, run.id);
    if (rows.length < 2 || !isSingleSeries(rows)) continue;
    const sorted = [...rows].sort(byNumber);
    if (sorted.some((r, i) => r.id !== rows[i].id) || rows.some((r, i) => r.sort_order !== i + 1)) {
      if (write(db, sorted)) changed.push({ id: run.id, title: run.title });
    }
  }
  return changed;
}

module.exports = { placeNew, resetNumberOrder, sameSeries };
