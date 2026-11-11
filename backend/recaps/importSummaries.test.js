'use strict';
// Importing ChatGPT-written summaries (recaps/importSummaries.js) and using them in recaps.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const createRecaps = require('./index');

function setup() {
  const db = new DatabaseSync(':memory:');
  db.transaction = fn => (...a) => { db.exec('BEGIN'); try { const r = fn(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  db.exec(`CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, issue_number TEXT, title TEXT, comicinfo TEXT, cv_issue_id TEXT, sort_order REAL, path TEXT);
    CREATE TABLE read_progress (id INTEGER PRIMARY KEY, book_id TEXT, user_id TEXT, page INTEGER, completed INTEGER, updated_at TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE event_issues (id INTEGER PRIMARY KEY, event_id TEXT, scanned_book_id TEXT, sort_order INTEGER, tier TEXT);
    CREATE TABLE canon_runs (id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE canon_run_issues (id INTEGER PRIMARY KEY, run_id INTEGER, scanned_book_id INTEGER, sort_order INTEGER);
    CREATE TABLE reading_lists (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO scanned_series VALUES ('tec', 'Detective Comics', 2016);`);
  for (const n of [1057, 1058, 1059, 1060]) db.prepare('INSERT INTO scanned_books VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`tec-${n}`, 'tec', String(n), '', `<ComicInfo><Series>Detective Comics</Series><Volume>2016</Volume><Number>${n}</Number></ComicInfo>`, `cv${n}`.replace('cv', '9'), n,
      `/comics/DC Comics/4. DC Rebirth/Detective Comics (2016)/Detective Comics ${n} (2022).cbz`);
  const ai = { complete: async () => { throw new Error('no AI in these tests'); } };
  const r = createRecaps({ db, ai, logger: { info() {}, warn() {}, error() {} }, getPageImage: async () => { throw new Error('no pages'); }, modelCatalog: { price: () => ({ in: 0, out: 0 }) } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumimp-'));
  const { createSummaryImport } = require('./importSummaries');
  const imp = createSummaryImport({ db, comicsRoot: '/comics', dir, logger: { info() {} } });
  return { db, r, imp, dir };
}
const rec = (n, extra = {}) => ({ schema: 1, prompt_version: 3, cv_issue_id: `9${n}`, file: `Detective Comics ${n} (2022).cbz`,
  path: `DC Comics\\4. DC Rebirth\\Detective Comics (2016)\\Detective Comics ${n} (2022).cbz`, series: 'Detective Comics', volume: '2016', number: String(n),
  status: 'ok', pages_total: 10, pages_read: 8, unreadable_pages: [], excluded_pages: [1, 10],
  stories: [{ title: 'Main', kind: 'main', scenes: [{ pages: [2, 3, 4, 5, 6, 7, 8, 9], what: 'Things happened.' }], synopsis: 'Story synopsis.' }],
  synopsis: `Issue ${n}: Caroline shot Perry and threatened Batman after Darby jumped from the balcony.`, characters: ['Bruce Wayne (Batman)', 'Darby Turner (as Ms. Smith)'],
  key_events: ['Caroline shot Perry.'], arc: 'The Seven', uncertainties: [], started_at: '2026-10-19T23:44:22', finished_at: '2026-10-19T23:49:07', written_at: '2026-10-19', ...extra });
const write = (dir, name, recs) => fs.writeFileSync(path.join(dir, name), recs.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n');

test('ok records are stored as trusted imports; bad lines are rejected with reasons; unreadable ones listed for retry', () => {
  const { db, imp, dir } = setup();
  write(dir, 'summaries_2026-10-19_2344.jsonl', [rec(1057), rec(1058, { number: '1099' }), '{not json', rec(1059, { status: 'unreadable', reason: 'zip error' }),
    rec(1060, { pages_read: 3 })]);
  const out = imp.importAll();
  assert.equal(out.imported, 1);
  assert.equal(out.rejected, 3);
  assert.equal(out.retry, 1);
  const row = db.prepare("SELECT * FROM issue_synopses WHERE issue_key = '91057'").get();
  assert.equal(row.source, 'import'); assert.equal(row.confidence, 'high'); assert.equal(row.book_id, 'tec-1057');
  assert.match(row.synopsis, /Caroline shot Perry/);
  assert.equal(JSON.parse(row.notes).record.characters[1], 'Darby Turner (as Ms. Smith)');
  const reasons = out.details[0].rejected.map(x => x.reason).join(' | ');
  assert.match(reasons, /does not match the library's #1058/); assert.match(reasons, /not valid JSON/); assert.match(reasons, /pages_read 3/);
  // The same file again: skipped, nothing re-imported.
  assert.equal(imp.importAll().files, 0);
});

test('newest ok record wins; partial never replaces ok; matching by path when the id is missing; dry run changes nothing', () => {
  const { db, imp, dir } = setup();
  write(dir, 'a.jsonl', [rec(1057, { synopsis: 'Older summary of the issue, long enough to count as a synopsis.', finished_at: '2026-10-19T10:00:00' })]);
  write(dir, 'b.jsonl', [rec(1057), rec(1057, { status: 'partial', reason: 'p5 torn', unreadable_pages: [5], pages_read: 7, finished_at: '2026-10-20T10:00:00' }),
    rec(1058, { cv_issue_id: null })]);
  write(dir, 'c.jsonl', [rec(1060)]);
  fs.utimesSync(path.join(dir, 'c.jsonl'), new Date(), new Date());
  const dry = imp.importAll({ dryRun: true });
  assert.equal(dry.imported + dry.replaced >= 3, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM issue_synopses").get().n, 0);
  const out = imp.importAll();
  assert.equal(out.kept_better, 1);
  assert.match(db.prepare("SELECT synopsis FROM issue_synopses WHERE issue_key = '91057'").get().synopsis, /Caroline shot Perry/);
  assert.equal(db.prepare("SELECT book_id FROM issue_synopses WHERE issue_key = '91058'").get().book_id, 'tec-1058');
});

test('recaps and story questions use imports without any lookup; "who is" finds names only in the character list', async () => {
  const { r, imp, dir } = setup();
  write(dir, 'x.jsonl', [rec(1057), rec(1058), rec(1059, { synopsis: 'Batman stopped a bombing at the courthouse and chased a fleeing man.' })]);
  imp.importAll();
  const s = await r.synopses.ensure('tec-1057');
  assert.equal(s.source, 'import'); assert.equal(s.spent, 0);
  const notes = r.scope.storedNotes({ userId: 'u', bookId: 'tec-1060', about: 'Ms. Smith' });
  assert.match(notes.text, /Also named here: .*Darby Turner \(as Ms\. Smith\)/);
  const g = await r.scope.gather(r.scope.plan({ userId: 'u', bookId: 'tec-1060' }));
  assert.equal(g.spentCents, 0);
  assert.equal(g.material.near.filter(x => x.source === 'import').length, 3);
});

test('a partial import is read from the pages once when a recap needs it', async () => {
  const { r, imp, dir } = setup();
  write(dir, 'p.jsonl', [rec(1057, { status: 'partial', reason: 'p5 torn', unreadable_pages: [5], pages_read: 7 })]);
  const out = imp.importAll();
  assert.equal(out.partial, 1); assert.equal(out.retry, 1);
  const row = r.synopses.stored('tec-1057');
  assert.equal(row.confidence, 'medium');
  assert.equal(r.synopses.wantsPages(row), true);
  await r.synopses.ensure('tec-1057');                      // pages fail in this test: marked tried, record kept
  const after = r.synopses.stored('tec-1057');
  assert.equal(after.source, 'import');
  assert.equal(JSON.parse(after.notes).pages_tried, true);
  assert.equal(JSON.parse(after.notes).record.status, 'partial');
  assert.equal(r.synopses.wantsPages(after), false);
});

test('no folder: nothing happens', () => {
  const { createSummaryImport } = require('./importSummaries');
  const { db } = setup();
  const imp = createSummaryImport({ db, dir: path.join(os.tmpdir(), 'does-not-exist-omnibus') });
  assert.equal(imp.importAll().missing, true);
});
