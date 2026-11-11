'use strict';
// Comic Book Guy and a series page's Annuals and Specials tabs (2026-11-09): the page
// line names how many there are; series_issues lists them (no summaries), plus the
// annuals of a linked annual series and the ones Comic Vine lists that are missing.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const createAssistant = require('../assistant');

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER, path TEXT, series_json TEXT, monitored_series_id TEXT);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, issue_number TEXT, title TEXT, filename TEXT, comicinfo TEXT, is_special INTEGER DEFAULT 0, monitored_issue_id TEXT, sort_order REAL DEFAULT 0);
    CREATE TABLE monitored_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER, total_issues INTEGER, status TEXT);
    CREATE TABLE monitored_issues (id TEXT PRIMARY KEY, series_id TEXT, issue_number TEXT, status TEXT, release_date TEXT, store_date TEXT);
    CREATE TABLE series_annual_links (parent_series_id TEXT, annual_series_id TEXT);
    INSERT INTO monitored_series VALUES ('m-jl', 'Justice League', 1987, 60, 'Ended'), ('m-jla', 'Justice League Annual', 1987, 8, 'Ended');
    INSERT INTO series_annual_links VALUES ('m-jl', 'm-jla');
    INSERT INTO scanned_series VALUES ('s-jl', 'Justice League', 1987, '/l/jl', NULL, 'm-jl'), ('s-jla', 'Justice League Annual', 1987, '/l/jla', NULL, 'm-jla');
    INSERT INTO monitored_issues VALUES ('mi-q', 'm-jl', '3', 'processed', '1991-06-01', '1991-04-30'),
      ('mi-a1', 'm-jla', '1', 'processed', '1987-12-01', NULL), ('mi-a2', 'm-jla', '2', 'wanted', '1988-12-01', '1988-10-15');
  `);
  const book = db.prepare('INSERT INTO scanned_books (id, series_id, issue_number, title, filename, comicinfo, is_special, monitored_issue_id, sort_order) VALUES (?,?,?,?,?,?,?,?,?)');
  book.run('b1', 's-jl', '1', 'Born Again', 'Justice League 001 (1987).cbz', '<ComicInfo><Year>1987</Year><Month>5</Month><Summary>SPOILER the end</Summary></ComicInfo>', 0, null, 1);
  book.run('b2', 's-jl', '2', null, 'Justice League 002 (1987).cbz', '', 0, null, 2);
  book.run('b3', 's-jl', '3', 'The Quarterly', 'Justice League Quarterly 003 (1991).cbz',
    '<ComicInfo><Series>Justice League Quarterly</Series><Volume>1990</Volume><Title>Collision</Title><Year>1991</Year><Month>6</Month><StoryArc>Breakdowns</StoryArc></ComicInfo>', 1, 'mi-q', 9003);
  book.run('b4', 's-jl', '1', null, 'Justice League Annual 001 (1987).cbz', '<ComicInfo><Series>Justice League Annual</Series><Year>1987</Year><Month>12</Month></ComicInfo>', 0, null, 9);
  book.run('b5', 's-jla', '1', 'Siege', 'Justice League Annual 001 (1987).cbz', '<ComicInfo><Year>1987</Year><Month>12</Month></ComicInfo>', 0, 'mi-a1', 1);
  const deps = {
    app: { get() {}, post() {}, put() {}, delete() {}, patch() {} }, db, express: { raw: () => (q, r, n) => n() },
    axios: null, requireAuth: (q, r, n) => n(), requireAdmin: (q, r, n) => n(),
    getSetting: () => null, logger: { info() {}, warn() {}, error() {} }, IN: { normIssueNumber: s => s },
    getAnthropicKey: () => 'k', getEventModel: () => 'gen', getValidationModel: () => 'quick',
    modelFor: () => 'quick', fetchAllSeries: () => [], getSeriesJsonCached: () => null, dataDir: os.tmpdir(),
    callModel: async () => { throw new Error('no model in this test'); },
  };
  return createAssistant(deps);
}

test('series page line counts the Annuals and Specials tabs; owned issues are the regular ones', () => {
  const a = setup();
  const line = a._internal.pageContext({ page: 'series', seriesId: 's-jl' }, 'admin', new Set());
  assert.match(line, /Owned issues: 1-2 \(2\)/);
  assert.match(line, /2 annuals \(Annuals tab\) and 1 special \(Specials tab\); series_issues lists them/);
});

test('series_issues lists annuals, specials and missing annuals with dates, never summaries', () => {
  const a = setup();
  const seen = new Set();
  const r = a.runTool('series_issues', { series_id: 's-jl' }, { seen, userId: 'admin' });
  assert.equal(r.owned_issues, '1-2');
  assert.equal(r.total_published, 60);
  assert.deepEqual(r.specials, [{ book_id: 'b3', number: '3', title: 'Collision', volume: 'Justice League Quarterly (1990)', cover_date: '1991-06', store_date: '1991-04-30', story_arc: 'Breakdowns' }]);
  assert.deepEqual(r.annuals.map(x => [x.book_id, x.volume, x.cover_date]), [['b4', 'Justice League Annual', '1987-12'], ['b5', 'Justice League Annual (1987)', '1987-12']]);
  assert.deepEqual(r.annuals_not_in_library, [{ volume: 'Justice League Annual (1987)', number: '2', cover_date: '1988-12-01', store_date: '1988-10-15' }]);
  assert.equal(r.regular_issues, undefined);
  assert.ok(seen.has('book:b3') && seen.has('book:b5'));
  const d = a.runTool('series_issues', { series_id: 's-jl', details: true }, { seen, userId: 'admin' });
  assert.deepEqual(d.regular_issues[0], { book_id: 'b1', number: '1', title: 'Born Again', cover_date: '1987-05' });
  assert.ok(!JSON.stringify(d).includes('SPOILER'));
});
