'use strict';
// ─── Database shape (2026-11-18) ──────────────────────────────────
// The shape of an Omnibus database: its tables, columns, unique rules, indexes, triggers and views.
// Used by freshInstall.test.js to check that a brand-new install ends up with the same shape as a
// long-running one (three new-install bugs on 2026-11-05, 11-11 and 11-14 came from a difference).
//
//   Snapshot a database's shape (no data) for the test's "long-running install" fixture:
//     docker exec omnibus node backend/schemaShape.js snapshot /appdata/omnibus.db /backups/schema.sql
//   then copy _backups/db/schema.sql to backend/fixtures/schema-<date>.sql.

// shape(db): db is an open better-sqlite3 (or node:sqlite) database.
function shape(db) {
  const out = { tables: {}, indexes: {}, other: {} };
  const rows = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all();
  for (const r of rows) {
    if (r.type === 'table') {
      const cols = {};
      for (const c of db.prepare(`PRAGMA table_xinfo("${r.name}")`).all()) cols[c.name] = { type: String(c.type || '').toUpperCase(), notnull: c.notnull, default: c.dflt_value ?? null, pk: c.pk };
      const unique = db.prepare(`PRAGMA index_list("${r.name}")`).all()
        .filter(i => i.unique && i.origin !== 'pk')
        .map(i => db.prepare(`PRAGMA index_info("${i.name}")`).all().map(c => c.name).join(','))
        .sort();
      out.tables[r.name] = { cols, unique };
    } else if (r.type === 'index') out.indexes[r.name] = tidy(r.sql);
    else out.other[`${r.type} ${r.name}`] = tidy(r.sql);
  }
  return out;
}
const tidy = sql => String(sql).replace(/\s+/g, ' ').replace(/ IF NOT EXISTS/i, '').replace(/"/g, '').trim();

// Differences between a fresh install (a) and an upgraded long-running one (b). `leftovers` names
// things only old installs have and nothing uses any more ("table x", "column t.c", "index i").
function compare(a, b, leftovers = []) {
  const skip = new Set(leftovers);
  const missing = [];   // the upgraded install has it, a new install does not
  const extra = [];     // a new install has it, an upgraded install does not
  const differ = [];
  for (const [t, tb] of Object.entries(b.tables)) {
    const ta = a.tables[t];
    if (!ta) { if (!skip.has(`table ${t}`)) missing.push(`table ${t}`); continue; }
    for (const [c, cb] of Object.entries(tb.cols)) {
      const ca = ta.cols[c];
      if (!ca) { if (!skip.has(`column ${t}.${c}`)) missing.push(`column ${t}.${c}`); continue; }
      for (const k of ['type', 'notnull', 'default', 'pk']) if (String(ca[k]) !== String(cb[k])) differ.push(`column ${t}.${c} ${k}: new install ${ca[k]}, upgraded ${cb[k]}`);
    }
    for (const c of Object.keys(ta.cols)) if (!tb.cols[c]) extra.push(`column ${t}.${c}`);
    if (ta.unique.join('|') !== tb.unique.join('|')) differ.push(`unique rules on ${t}: new install [${ta.unique.join('; ')}], upgraded [${tb.unique.join('; ')}]`);
  }
  for (const t of Object.keys(a.tables)) if (!b.tables[t]) extra.push(`table ${t}`);
  for (const [i, sql] of Object.entries(b.indexes)) {
    if (!a.indexes[i]) { if (!skip.has(`index ${i}`)) missing.push(`index ${i}`); }
    else if (a.indexes[i] !== sql) differ.push(`index ${i}: new install "${a.indexes[i]}", upgraded "${sql}"`);
  }
  for (const i of Object.keys(a.indexes)) if (!b.indexes[i]) extra.push(`index ${i}`);
  for (const o of Object.keys(b.other)) if (!a.other[o] && !skip.has(o)) missing.push(o);
  for (const o of Object.keys(a.other)) if (!b.other[o]) extra.push(o);
  return { missing, extra, differ, same: !missing.length && !extra.length && !differ.length };
}

// The CREATE statements of a database, tables first (no data).
function snapshotSql(db) {
  const order = { table: 0, index: 1, view: 2, trigger: 3 };
  return db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all()
    .sort((x, y) => (order[x.type] - order[y.type]) || x.name.localeCompare(y.name))
    .map(r => `${r.sql.trim()};\n`).join('\n');
}

module.exports = { shape, compare, snapshotSql };

if (require.main === module) {
  const [cmd, file, out] = process.argv.slice(2);
  if (cmd !== 'snapshot' || !file) { console.log('Usage: node backend/schemaShape.js snapshot <database> [out.sql]'); process.exit(1); }
  const Database = require('better-sqlite3');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const sql = `-- Omnibus database shape (no data), ${new Date().toISOString().slice(0, 10)}\n\n${snapshotSql(db)}`;
  if (out) { require('fs').writeFileSync(out, sql); console.log(`Wrote ${out}`); } else process.stdout.write(sql);
}
