#!/usr/bin/env node
'use strict';
// One-time (2026-11-22): store the links the crossover pilot proved (/logs/crossover-pilot-*.json) as web
// links, free. The weekly check only asks about issues from the last 180 days, so pilot finds such as
// Absolute Wonder Woman #15 → Absolute Batman #16 (December 2025) were never stored. The same rules as
// the app apply (crossovers.js linkRow): a page named both issues; library matching by release date.
//   node /app/scripts/crossover_import_pilot.js [/logs/crossover-pilot-sample.json ...]
const fs = require('node:fs');
const path = require('node:path');

function importPilot(db, C, T, files) {
  const lib = C.loadLibrary(db);
  const ins = db.prepare(`INSERT OR IGNORE INTO crossover_links (key, from_book_id, from_series, from_issue, from_year, to_book_id, to_series, to_issue, to_year, story, source, proof, found_at)
    VALUES (@key, @from_book_id, @from_series, @from_issue, @from_year, @to_book_id, @to_series, @to_issue, @to_year, @story, 'web', @proof, @found_at)`);
  let proven = 0, added = 0, skipped = 0;
  for (const f of files) {
    const rep = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const a of [...(rep.answers?.perBook || []), ...(rep.answers?.sweep || [])]) {
      const asked = a.bookId ? lib.byId.get(a.bookId) : null;
      for (const st of a.stories || []) for (const l of st.links || []) {
        if (!l.proven) continue;
        proven++;
        const anchor = asked?.store_date || st.parts[l.from]?.book?.store || st.parts[l.to]?.book?.store;
        const r = anchor ? C.linkRow(lib, { story: st.name || null, from: st.parts[l.from], to: st.parts[l.to], page: l.page }, anchor) : null;
        if (!r) { skipped++; continue; }
        const end = (b, n) => (b ? { id: b.id, series: b.series, issue: T.num(b.issue_number), year: Number(b.year) || null } : { id: null, series: n.series, issue: n.issue, year: n.year });
        const x = end(r.from, r.fromName), y = end(r.to, r.toName);
        added += ins.run({ key: r.key, from_book_id: x.id, from_series: x.series, from_issue: x.issue, from_year: x.year, to_book_id: y.id, to_series: y.series,
          to_issue: y.issue, to_year: y.year, story: r.story ? String(r.story).slice(0, 120) : null, proof: r.proof ? String(r.proof).slice(0, 300) : null, found_at: Date.now() }).changes;
      }
    }
  }
  return { proven, added, skipped };
}

if (require.main === module) {
  const backend = process.env.OMNIBUS_BACKEND || path.join(__dirname, '..', 'backend');
  const req = m => require(path.join(backend, m));
  const db = new (req('node_modules/better-sqlite3'))(process.env.DB_PATH || '/appdata/omnibus.db');
  db.pragma('busy_timeout = 10000');
  const files = process.argv.slice(2).length ? process.argv.slice(2) : ['/logs/crossover-pilot-sample.json', '/logs/crossover-pilot-smoke.json'].filter(f => fs.existsSync(f));
  const r = importPilot(db, req('crossovers'), req('crossoverText'), files);
  console.log(`Pilot links: ${r.proven} proven in ${files.length} report(s); ${r.added} added, ${r.skipped} not stored (rules), the rest already there.`);
}
module.exports = { importPilot };
