'use strict';
// ─── Importing issue summaries written outside Omnibus (2026-10-20) ─────────
// Page-read summaries written by ChatGPT ("Astra") under docs/ASTRA_SUMMARY_INSTRUCTIONS.md:
// one JSON Lines run file per run in <comics>/_summaries_outputs, one record per issue.
// They go into issue_synopses as source "import", where recaps, story questions and the
// reader already look, so an imported issue is never looked up or paid for again.
//
//   ok          → stored and trusted (never replaced by a web lookup)
//   partial     → stored, but the issue's pages are still read once if a recap needs it
//   unreadable  → not stored; listed for a retry run
//
// The full record is kept in notes ({ import, record }) for later use (characters,
// key events, separate backup stories, uncertainties). Matching: Comic Vine issue id,
// else the archive path, else the file name. The newest ok record for an issue wins.
// Developer tool, not a user feature: run from the admin route or the hourly check;
// nothing happens when the folder does not exist.

const fs = require('fs');
const path = require('path');

const STATUSES = new Set(['ok', 'partial', 'unreadable']);
const DIR_NAME = '_summaries_outputs';

const tag = (ci, t) => {
  const m = String(ci || '').match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`));
  return m ? m[1].replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() : '';
};
const normNum = n => String(n ?? '').trim().toLowerCase().replace(/^#/, '').replace(/^0+(?=\d)/, '');
const parseJson = s => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
const pageList = p => (Array.isArray(p) ? p : String(p ?? '').split(',').flatMap(part => {
  const m = String(part).trim().match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (m) { const out = []; for (let k = +m[1]; k <= +m[2] && out.length < 500; k++) out.push(k); return out; }
  return /^\d+$/.test(String(part).trim()) ? [+String(part).trim()] : [];
})).map(Number);

// Problems that make a record unusable (empty list = valid).
function validate(r) {
  const p = [];
  if (!r || typeof r !== 'object') return ['not a JSON object'];
  if (r.schema !== 1) p.push(`unknown schema ${JSON.stringify(r.schema)}`);
  if (!STATUSES.has(r.status)) p.push(`status must be ok, partial or unreadable (got ${JSON.stringify(r.status)})`);
  if (!r.cv_issue_id && !r.path && !r.file) p.push('no cv_issue_id, path or file to match the issue');
  if (r.cv_issue_id != null && !/^\d+$/.test(String(r.cv_issue_id))) p.push(`cv_issue_id is not a number: ${r.cv_issue_id}`);
  if (r.status === 'unreadable') return p;
  if (typeof r.synopsis !== 'string' || r.synopsis.trim().length < 40) p.push('synopsis missing or too short');
  if (!Array.isArray(r.stories) || !r.stories.length) p.push('no stories');
  const total = Number(r.pages_total);
  if (!(total > 0)) p.push('pages_total missing');
  else {
    const excluded = (r.excluded_pages || []).length, unreadable = (r.unreadable_pages || []).length;
    if (Number(r.pages_read) + excluded + unreadable !== total) p.push(`pages_read ${r.pages_read} + excluded ${excluded} + unreadable ${unreadable} ≠ pages_total ${total}`);
    for (const s of r.stories || []) for (const sc of s.scenes || []) for (const n of pageList(sc.pages))
      if (!(n >= 1 && n <= total)) { p.push(`scene page ${n} is outside 1–${total}`); return p; }
  }
  return p;
}

function createSummaryImport({ db, logger, comicsRoot = process.env.COMICS_PATH || '/comics', dir, now = () => Date.now() }) {
  const root = String(comicsRoot).replace(/\/+$/, '');
  const folder = dir || path.posix.join(root, DIR_NAME);
  db.exec(`CREATE TABLE IF NOT EXISTS summary_import_files (
    file TEXT PRIMARY KEY, size INTEGER, mtime INTEGER, imported_at INTEGER, report TEXT
  )`);
  // Statements are prepared on first use, so creating the importer never fails on a database
  // that lacks a column (tests, older installs).
  let S = null;
  const st = () => S || (S = {
    byCv: db.prepare('SELECT id, comicinfo, issue_number FROM scanned_books WHERE cv_issue_id = ? LIMIT 1'),
    byPath: db.prepare('SELECT id, comicinfo, issue_number, cv_issue_id FROM scanned_books WHERE path = ?'),
    byName: db.prepare("SELECT id, comicinfo, issue_number, cv_issue_id FROM scanned_books WHERE path LIKE ? ESCAPE '\\' LIMIT 2"),
    getRow: db.prepare('SELECT * FROM issue_synopses WHERE issue_key = ?'),
    putRow: db.prepare(`INSERT INTO issue_synopses (issue_key, book_id, status, synopsis, source, source_url, model, confidence, notes, est_cost, created_at, retry_after)
      VALUES (?, ?, 'ok', ?, 'import', NULL, ?, ?, ?, 0, ?, NULL)
      ON CONFLICT(issue_key) DO UPDATE SET book_id = excluded.book_id, status = 'ok', synopsis = excluded.synopsis, source = 'import', source_url = NULL,
        model = excluded.model, confidence = excluded.confidence, notes = excluded.notes, created_at = excluded.created_at, retry_after = NULL`),
    fileRow: db.prepare('SELECT * FROM summary_import_files WHERE file = ?'),
    putFile: db.prepare('INSERT OR REPLACE INTO summary_import_files (file, size, mtime, imported_at, report) VALUES (?, ?, ?, ?, ?)'),
  });

  // The library book for a record: { book, key } or { error }.
  function match(r) {
    let book = null, key = null;
    if (r.cv_issue_id) { key = String(r.cv_issue_id); book = st().byCv.get(key) || null; }
    if (!book && r.path) {
      const full = path.posix.join(root, String(r.path).replace(/\\/g, '/'));
      book = st().byPath.get(full) || null;
    }
    if (!book && r.file) {
      const hits = st().byName.all(`%/${String(r.file).replace(/[\\%_]/g, c => `\\${c}`)}`);
      if (hits.length === 1) book = hits[0];
    }
    if (book && !key) key = book.cv_issue_id ? String(book.cv_issue_id) : `book:${book.id}`;
    if (!key) return { error: 'not in the library and no Comic Vine id' };
    if (book) {
      const own = tag(book.comicinfo, 'Number') || book.issue_number;
      if (r.number != null && own && normNum(own) !== normNum(r.number)) return { error: `issue number ${r.number} does not match the library's #${own}` };
    }
    return { book, key };
  }

  // One record → 'imported' | 'replaced' | 'kept_newer' | 'kept_better' | retry/reject entries.
  function storeRecord(r, file, dryRun) {
    const m = match(r);
    if (m.error) return { result: 'rejected', reason: m.error };
    if (r.status === 'unreadable') return { result: 'retry', reason: r.reason || 'unreadable' };
    const old = st().getRow.get(m.key);
    const finished = Date.parse(r.finished_at || r.written_at || '') || now();
    if (old && old.status === 'ok' && old.source === 'import') {
      const was = parseJson(old.notes);
      const oldFinished = Date.parse(was.record?.finished_at || was.record?.written_at || '') || old.created_at || 0;
      if (was.import?.status === 'ok' && r.status === 'partial') return { result: 'kept_better' };
      if (oldFinished > finished) return { result: 'kept_newer' };
    }
    if (r.status === 'partial' && old && old.status === 'ok' && old.source === 'pages') return { result: 'kept_better' };
    if (!dryRun) {
      const notes = JSON.stringify({ import: { file, status: r.status, prompt_version: r.prompt_version ?? null, imported_at: new Date(now()).toISOString() }, record: r });
      st().putRow.run(m.key, m.book ? m.book.id : null, String(r.synopsis).trim(), String(r.model || 'chatgpt (Astra)'), r.status === 'ok' ? 'high' : 'medium', notes, finished);
    }
    return { result: old && old.status === 'ok' ? 'replaced' : 'imported', notInLibrary: !m.book, partial: r.status === 'partial' };
  }

  function importFile(full, { dryRun = false } = {}) {
    const file = path.basename(full);
    const report = { file, lines: 0, imported: 0, replaced: 0, kept_newer: 0, kept_better: 0, partial: 0, not_in_library: 0, rejected: [], retry: [] };
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    const work = () => lines.forEach((line, k) => {
      if (!line.trim()) return;
      report.lines++;
      let r;
      try { r = JSON.parse(line); } catch (e) { report.rejected.push({ line: k + 1, reason: `not valid JSON: ${e.message}` }); return; }
      const problems = validate(r);
      const who = `${r.series || '?'} #${r.number ?? '?'}${r.cv_issue_id ? ` [${r.cv_issue_id}]` : ''}`;
      if (problems.length) { report.rejected.push({ line: k + 1, issue: who, reason: problems.join('; ') }); return; }
      const out = storeRecord(r, file, dryRun);
      if (out.result === 'rejected') report.rejected.push({ line: k + 1, issue: who, reason: out.reason });
      else if (out.result === 'retry') report.retry.push({ issue: who, path: r.path || r.file || null, reason: out.reason });
      else {
        report[out.result]++;
        if (out.partial) { report.partial++; report.retry.push({ issue: who, path: r.path || r.file || null, reason: `partial: ${r.reason || 'some pages unreadable'}` }); }
        if (out.notInLibrary) report.not_in_library++;
      }
    });
    if (dryRun) work(); else db.transaction(work)();
    return report;
  }

  // Every run file in the folder not imported before (or changed since). force: all again.
  function importAll({ dryRun = false, force = false } = {}) {
    if (!fs.existsSync(folder)) return { folder, missing: true, files: [] };
    const names = fs.readdirSync(folder).filter(f => /\.jsonl$/i.test(f)).sort();
    const files = [];
    for (const name of names) {
      const full = path.join(folder, name);
      const stat = fs.statSync(full);
      const seen = st().fileRow.get(name);
      if (!force && seen && seen.size === stat.size && seen.mtime === Math.floor(stat.mtimeMs)) continue;
      try {
        const rep = importFile(full, { dryRun });
        if (!dryRun) st().putFile.run(name, stat.size, Math.floor(stat.mtimeMs), now(), JSON.stringify(rep));
        files.push(rep);
      } catch (e) { files.push({ file: name, error: e.message }); }
    }
    const total = k => files.reduce((n, f) => n + (Array.isArray(f[k]) ? f[k].length : f[k] || 0), 0);
    const summary = { folder, dryRun, files: files.length, imported: total('imported'), replaced: total('replaced'), kept_newer: total('kept_newer'),
      kept_better: total('kept_better'), partial: total('partial'), not_in_library: total('not_in_library'), rejected: total('rejected'), retry: total('retry') };
    if (!dryRun && files.length) logger?.info?.('recaps', 'Imported summaries', summary);
    return { ...summary, details: files };
  }

  const history = () => db.prepare('SELECT file, size, imported_at, report FROM summary_import_files ORDER BY imported_at DESC LIMIT 100').all()
    .map(r => ({ file: r.file, size: r.size, imported_at: new Date(r.imported_at).toISOString(), report: parseJson(r.report) }));
  const counts = () => db.prepare(`SELECT COUNT(*) AS total, SUM(json_extract(notes, '$.import.status') = 'partial') AS partial FROM issue_synopses WHERE source = 'import' AND status = 'ok'`).get();

  return { importAll, importFile, validate, match, history, counts, folder };
}

module.exports = { createSummaryImport, validate, pageList };
