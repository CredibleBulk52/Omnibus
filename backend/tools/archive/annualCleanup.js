'use strict';
// Annual cleanup — one-time repair of annual links made before 2026-10-11.
// Principle: an annual keeps its Comic Vine identity; links only decide where
// it is shown, filed and monitored.
//
// Part A (always): processed annual issues whose file is not that issue.
//   OK         the linked file is tagged with this issue's CV id
//   REPOINT    another file in the library carries this issue's CV id → link to it
//   UNLINK     linked file is tagged as another issue, or its filename year is
//              another year, and no file carries this issue's CV id
//   UNVERIFIED linked file is untagged and its year fits → left alone (tag it)
//   MISSING    linked file is not on disk → left alone (Refresh handles it)
// Part B (--links): annual-to-annual links (parent is itself an annual volume).
//   Removed only when the annual keeps a real parent. Self-links always removed
//   (they hide a series from its own card).
// Part C (--era): links whose annual volume starts outside the parent's run
//   (first issue's year .. last issue year +1). The annual becomes its own card.
//
// Usage (inside the container):
//   node /app/backend/tools/archive/annualCleanup.js                  preview everything
//   node /app/backend/tools/archive/annualCleanup.js --apply          apply Part A
//   node /app/backend/tools/archive/annualCleanup.js --apply --links --era
//   --unowned skipped|wanted   status for UNLINK rows (default skipped: no download)
const Database = require('better-sqlite3');
const fs = require('fs'), path = require('path');

const db = new Database(process.env.DB_PATH || '/appdata/omnibus.db');
db.pragma('busy_timeout = 10000');
const has = k => process.argv.includes(k);
// Test aid: ASSUME_SCANNED=1 treats a path as on disk when the scanner has it (for previews outside the container).
const scannedPath = p => !!db.prepare('SELECT 1 FROM scanned_books WHERE path = ?').get(p);
const onDisk = p => fs.existsSync(p) || (process.env.ASSUME_SCANNED === '1' && scannedPath(p));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const APPLY = has('--apply'), LINKS = has('--links'), ERA = has('--era');
const UNOWNED = arg('--unowned', 'skipped');
if (!['skipped', 'wanted'].includes(UNOWNED)) { console.error('--unowned must be skipped or wanted'); process.exit(1); }

const fileYear = p => { const m = path.basename(p || '').match(/(?:^|[^0-9])((?:19|20)[0-9]{2})(?:[^0-9]|$)/); return m ? m[1] : null; };
const years = i => [i.release_date, i.store_date].filter(Boolean).map(d => String(d).slice(0, 4));
const isAnnualName = n => /\bannual\b/i.test(n || '');
const short = p => p ? p.replace(/^\/comics\//, '') : '-';

// ── Part A ────────────────────────────────────────────────────────
const issues = db.prepare(`
  SELECT i.*, s.name AS series_name, s.directory AS series_dir
  FROM monitored_issues i JOIN monitored_series s ON s.id = i.series_id
  WHERE i.status = 'processed' AND i.file_path IS NOT NULL
    AND (i.is_annual = 1 OR s.name LIKE '%annual%'
         OR i.series_id IN (SELECT annual_series_id FROM series_annual_links))
  ORDER BY s.name, i.release_date`).all();
const bookAt = db.prepare('SELECT id, path, cv_issue_id FROM scanned_books WHERE path = ?');
const booksByCv = db.prepare('SELECT id, path FROM scanned_books WHERE cv_issue_id = ?');

const A = { OK: [], REPOINT: [], UNLINK: [], UNVERIFIED: [], MISSING: [] };
for (const i of issues) {
  const cur = bookAt.get(i.file_path);
  const id = String(i.id);
  if (cur && String(cur.cv_issue_id || '') === id) { A.OK.push({ i }); continue; }
  const own = booksByCv.all(id).filter(b => onDisk(b.path));
  if (own.length) {
    const pick = own.length === 1 ? own[0]
      : (own.find(b => path.dirname(b.path) === path.dirname(i.file_path)) || own.find(b => path.dirname(b.path) === i.series_dir) || null);
    if (pick) { A.REPOINT.push({ i, to: pick.path }); continue; }
  }
  if (!onDisk(i.file_path)) { A.MISSING.push({ i }); continue; }
  const otherCv = cur && cur.cv_issue_id && String(cur.cv_issue_id) !== id ? String(cur.cv_issue_id) : null;
  const fy = fileYear(i.file_path), ys = years(i);
  if (otherCv) { A.UNLINK.push({ i, why: `file is CV issue ${otherCv}` }); continue; }
  if (fy && ys.length && !ys.includes(fy)) { A.UNLINK.push({ i, why: `file is ${fy}, issue is ${ys.join('/')}` }); continue; }
  A.UNVERIFIED.push({ i });
}

// ── Part B: annual-to-annual links ────────────────────────────────
const links = db.prepare(`
  SELECT l.parent_series_id AS pid, l.annual_series_id AS aid, p.name AS pname, p.year AS pyear, a.name AS aname, a.year AS ayear
  FROM series_annual_links l JOIN monitored_series p ON p.id = l.parent_series_id JOIN monitored_series a ON a.id = l.annual_series_id`).all();
const parentsOf = new Map();
for (const l of links) { if (!parentsOf.has(l.aid)) parentsOf.set(l.aid, []); parentsOf.get(l.aid).push(l); }
const B = { remove: [], keep: [] };
for (const l of links) {
  if (!(isAnnualName(l.pname) || l.pid === l.aid)) continue;
  // A self-link is always removed: it hides the series from its own card.
  if (l.pid === l.aid) { B.remove.push(l); continue; }
  const realLeft = parentsOf.get(l.aid).filter(x => !(isAnnualName(x.pname) || x.pid === x.aid));
  (realLeft.length ? B.remove : B.keep).push(l);
}

// ── Part C: out-of-era links (real parents only) ──────────────────
// Same rule as the linker: run start = year of the run's first issue (earliest
// store/cover date; else volume start year - 1); end = last issue year + 1.
const lastYear = db.prepare(`SELECT MAX(substr(COALESCE(store_date, release_date), 1, 4)) AS y FROM monitored_issues WHERE series_id = ? AND is_annual = 0`);
const firstYears = db.prepare(`SELECT MIN(substr(store_date, 1, 4)) AS s, MIN(substr(release_date, 1, 4)) AS r FROM monitored_issues WHERE series_id = ? AND is_annual = 0`);
const C = [];
for (const l of links) {
  if (isAnnualName(l.pname) || l.pid === l.aid) continue;
  const ay = parseInt(l.ayear, 10);
  const fy = Object.values(firstYears.get(l.pid) || {}).map(v => parseInt(v, 10)).filter(Boolean);
  const start = fy.length ? Math.min(...fy) : ((parseInt(l.pyear, 10) || 0) ? parseInt(l.pyear, 10) - 1 : null);
  if (!start || !ay) continue;
  const end = parseInt(lastYear.get(l.pid)?.y, 10) || new Date().getFullYear();
  if (ay < start || ay > end + 1) C.push({ ...l, run: `${start}-${end}` });
}

// ── Report ────────────────────────────────────────────────────────
const line = (tag, i, extra) => console.log(`  ${tag.padEnd(10)} ${i.series_name} #${i.issue_number} (${years(i)[0] || '?'}, CV ${i.id})  ${short(i.file_path)}${extra ? '  ' + extra : ''}`);
console.log(APPLY ? 'APPLYING' : 'PREVIEW — nothing changed (add --apply)');
console.log(`\nPart A — ${issues.length} processed annual issues: ${A.OK.length} ok, ${A.REPOINT.length} repoint, ${A.UNLINK.length} unlink (→ ${UNOWNED}), ${A.UNVERIFIED.length} unverified, ${A.MISSING.length} file missing`);
A.REPOINT.forEach(x => line('REPOINT', x.i, `→ ${short(x.to)}`));
A.UNLINK.forEach(x => line('UNLINK', x.i, `(${x.why})`));
A.UNVERIFIED.forEach(x => line('UNVERIFIED', x.i, '(untagged; tag it to verify)'));
A.MISSING.forEach(x => line('MISSING', x.i));
console.log(`\nPart B — annual-to-annual links: ${B.remove.length} to remove${LINKS ? '' : ' (add --links)'}, ${B.keep.length} kept (would leave an annual with no series)`);
B.keep.forEach(l => console.log(`  KEEP       ${l.aname} (${l.ayear}) under ${l.pname} (${l.pyear})`));
console.log(`\nPart C — links outside the parent's run: ${C.length}${ERA ? '' : ' (add --era)'}`);
C.forEach(l => console.log(`  ${'UNLINK'.padEnd(10)} ${l.aname} (${l.ayear}, ${l.aid})  from ${l.pname} (run ${l.run})${parentsOf.get(l.aid).length === 1 ? '  → becomes its own card' : ''}`));

if (APPLY) {
  db.transaction(() => {
    const rp = db.prepare(`UPDATE monitored_issues SET file_path = ?, status = 'processed', has_comicinfo = NULL, last_retag_cv_hash = NULL WHERE id = ?`);
    for (const x of A.REPOINT) rp.run(x.to, x.i.id);
    const ul = db.prepare(`UPDATE monitored_issues SET status = ?, file_path = NULL, download_id = NULL, date_processed = NULL, has_comicinfo = NULL, last_retag_cv_hash = NULL WHERE id = ?`);
    for (const x of A.UNLINK) ul.run(UNOWNED, x.i.id);
    const del = db.prepare('DELETE FROM series_annual_links WHERE parent_series_id = ? AND annual_series_id = ?');
    if (LINKS) for (const l of B.remove) del.run(l.pid, l.aid);
    if (ERA) for (const l of C) del.run(l.pid, l.aid);
  })();
  console.log(`\nDone: ${A.REPOINT.length} repointed, ${A.UNLINK.length} unlinked${LINKS ? `, ${B.remove.length} annual-to-annual links removed` : ''}${ERA ? `, ${C.length} out-of-era links removed` : ''}.`);
}
