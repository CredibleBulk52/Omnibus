'use strict';
// List annual files with no Comic Vine tag, grouped by folder, so they can be
// tagged (Tag Issue, or Tag with CV URL). Writes a CSV next to the backups.
//   node /app/backend/tools/archive/untaggedAnnuals.js            → prints + /backups/untagged-annuals.csv
const Database = require('better-sqlite3');
const fs = require('fs'), path = require('path');
const db = new Database(process.env.DB_PATH || '/appdata/omnibus.db', { readonly: true });
const out = process.env.OUT || '/backups/untagged-annuals.csv';

const rows = db.prepare(`
  SELECT b.path, b.filename, s.path AS folder,
    (SELECT GROUP_CONCAT(a.name || ' (' || COALESCE(a.year, '?') || ')', '; ')
       FROM monitored_series p JOIN series_annual_links l ON l.parent_series_id = p.id
       JOIN monitored_series a ON a.id = l.annual_series_id
      WHERE p.directory = s.path) AS linked_annual_volumes
  FROM scanned_books b JOIN scanned_series s ON s.id = b.series_id
  WHERE b.filename LIKE '%annual%' AND (b.cv_issue_id IS NULL OR b.cv_issue_id = '')
  ORDER BY s.path, b.filename`).all();

const byFolder = new Map();
for (const r of rows) { if (!byFolder.has(r.folder)) byFolder.set(r.folder, []); byFolder.get(r.folder).push(r); }
console.log(`${rows.length} untagged annual files in ${byFolder.size} folders`);
for (const [folder, list] of byFolder) {
  const vols = list[0].linked_annual_volumes;
  console.log(`\n${folder.replace(/^\/comics\//, '')}  (${list.length})${vols ? `  — linked annual volumes: ${vols}` : '  — no linked annual volume: use Tag with CV URL'}`);
  list.forEach(r => console.log(`  ${r.filename}`));
}
const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
try {
  fs.writeFileSync(out, ['folder,file,linked_annual_volumes', ...rows.map(r => [q(r.folder.replace(/^\/comics\//, '')), q(r.filename), q(r.linked_annual_volumes)].join(','))].join('\n') + '\n');
  console.log(`\nCSV: ${out}`);
} catch (e) { console.log(`\n(CSV not written: ${e.message})`); }
