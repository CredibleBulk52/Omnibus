'use strict';
// Annuals and specials in a series' reading order (seriesPlacement.js, 2026-11-21).
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createSeriesPlacement, extraLabel, weekOf } = require('./seriesPlacement');

function fixture({ eventHome = false } = {}) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, monitored_series_id TEXT);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, filename TEXT, issue_number TEXT, title TEXT, comicinfo TEXT,
      is_special INTEGER DEFAULT 0, sort_order REAL, store_date TEXT);
    CREATE TABLE series_annual_links (parent_series_id TEXT, annual_series_id TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT, year INTEGER, draft INTEGER DEFAULT 0, home_series_id TEXT);
    CREATE TABLE event_issues (id INTEGER PRIMARY KEY, event_id TEXT, scanned_book_id TEXT, sort_order INTEGER);`);
  db.prepare('INSERT INTO scanned_series VALUES (?,?,?)').run('ww', 'Wonder Woman', null);
  db.prepare('INSERT INTO scanned_series VALUES (?,?,?)').run('aa', 'Amazons Attack', null);
  const add = db.prepare('INSERT INTO scanned_books VALUES (?,?,?,?,?,?,?,?,?)');
  const ci = (series, n, extra = '') => `<ComicInfo><Series>${series}</Series><Number>${n}</Number>${extra}</ComicInfo>`;
  add.run('w36', 'ww', 'Wonder Woman 036 (2026).cbz', '36', 'The Current Beneath, Part 2', ci('Wonder Woman', 36), 0, 36, '2026-08-19');
  add.run('w37', 'ww', 'Wonder Woman 037 (2026).cbz', '37', 'The Wonder War, Part 5', ci('Wonder Woman', 37), 0, 37, '2026-09-16');
  add.run('w38', 'ww', 'Wonder Woman 038 (2026).cbz', '38', 'The Wonder War, Part 6', ci('Wonder Woman', 38), 0, 38, '2026-10-21');
  // Annual between #37 and #38 by date
  add.run('ann', 'ww', 'Wonder Woman 2026 Annual Wonder War - The Matriarch Special 001.cbz', '1', 'Freedom Over Fate',
    ci('Wonder Woman 2026 Annual: Wonder War - The Matriarch Special', 1), 1, 9001, '2026-09-30');
  // Same day as #36: after #36
  add.run('same', 'ww', 'Wonder Woman 2026 Annual 002.cbz', '2', 'Same Day', ci('Wonder Woman Annual', 2), 1, 9002, '2026-08-19');
  // A filename hint wins over its later date
  add.run('hint', 'ww', 'Wonder Woman Special 001 (Read after 36).cbz', '1', 'Hinted', ci('Wonder Woman Special', 1), 1, 9003, '2026-10-28');
  // A reprint stays on the shelf
  add.run('rep', 'ww', 'Wonder Woman Giant 001.cbz', '1', 'Giant', ci('Wonder Woman Giant', 1, '<Summary>Reprints #1-3.</Summary>'), 1, 9004, '2026-09-02');
  // No date: shelf
  add.run('nod', 'ww', 'Wonder Woman Special 002.cbz', '2', 'Undated', ci('Wonder Woman Special', 2), 1, 9005, null);
  // A Timeline puts this one before #37 though its date is later
  add.run('tl', 'ww', 'Wonder War Tie-In 001.cbz', '1', 'Tie-In', ci('Wonder War: Tie-In', 1), 1, 9006, '2026-10-01');
  // Long after the run: shelf
  add.run('late', 'ww', 'Wonder Woman Special 003.cbz', '3', 'Late', ci('Wonder Woman Special', 3), 1, 9007, '2027-06-01');
  // Linked mini (series grouping): Amazons Attack #1 the week of #37, #2 after #38
  add.run('aa1', 'aa', 'Amazons Attack 001.cbz', '1', 'The Doubting Queen', ci('Amazons Attack', 1), 0, 1, '2026-09-16');
  add.run('aa2', 'aa', 'Amazons Attack 002.cbz', '2', 'Second', ci('Amazons Attack', 2), 0, 2, '2026-10-21');
  db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run('wwar', 'Wonder War', 2026, 0, eventHome ? 'ww' : null);
  const ei = db.prepare('INSERT INTO event_issues (event_id, scanned_book_id, sort_order) VALUES (?,?,?)');
  ei.run('wwar', 'w37', 5); ei.run('wwar', 'tl', 4); ei.run('wwar', 'w38', 6);
  const p = createSeriesPlacement({ db, members: id => (id === 'ww' ? [{ id: 'aa' }] : []) });
  return { db, p };
}

const where = (res, id) => res.placed.find(x => x.bookId === id);
const shelved = (res, id) => res.shelf.find(x => x.bookId === id);

test('weeks start on Monday', () => {
  assert.equal(weekOf('2026-09-14'), weekOf('2026-09-20'));       // Monday and Sunday
  assert.equal(weekOf('2026-09-21'), weekOf('2026-09-14') + 1);
  assert.equal(weekOf('nope'), null);
});

test('the order of evidence: filename hint, Timeline, release week, same week regular first', () => {
  const { p } = fixture();
  const r = p.placement('ww');
  assert.equal(where(r, 'ann').afterBookId, 'w37');
  assert.equal(where(r, 'ann').evidence, 'release week');
  assert.equal(where(r, 'same').afterBookId, 'w36');
  assert.equal(where(r, 'same').evidence, 'same week, regular issue first');
  assert.equal(where(r, 'hint').afterBookId, 'w36');
  assert.equal(where(r, 'hint').evidence, 'filename');
  assert.equal(where(r, 'tl').afterBookId, 'w36');                 // before #37 in the Timeline
  assert.equal(where(r, 'tl').evidence, 'timeline');
  assert.equal(shelved(r, 'rep').reason, 'reprint');
  assert.equal(shelved(r, 'nod').reason, 'no store date');
  assert.equal(shelved(r, 'late').reason, 'long after the run');
  assert.equal(where(r, 'aa1').afterBookId, 'w37');                // linked mini, interleaved
  assert.equal(where(r, 'aa2').afterBookId, 'w38');
});

test('the displayed sequence keeps the regular order and puts extras after their issue, by date', () => {
  const { p } = fixture();
  assert.deepEqual(p.sequence('ww'), ['w36', 'same', 'tl', 'hint', 'w37', 'aa1', 'ann', 'w38', 'aa2']);
});

test('pins win: shelf, first, after; a replaced anchor is followed by its number', () => {
  const { db, p } = fixture();
  p.setPin('ww', 'ann', { mode: 'after', anchorBookId: 'w36' }, 'admin');
  p.setPin('ww', 'rep', { mode: 'first' });
  p.setPin('ww', 'aa1', { mode: 'shelf' });
  let r = p.placement('ww');
  assert.equal(where(r, 'ann').afterBookId, 'w36');
  assert.equal(where(r, 'ann').pinned, true);
  assert.equal(where(r, 'rep').afterBookId, null);
  assert.equal(shelved(r, 'aa1').reason, 'pinned to the shelf');
  assert.deepEqual(r.pins.ann, { mode: 'after', anchorBookId: 'w36' });
  // #36 replaced by a new file (new book id): the pin follows issue 36
  db.prepare("UPDATE scanned_books SET id = 'w36b' WHERE id = 'w36'").run();
  r = p.placement('ww');
  assert.equal(where(r, 'ann').afterBookId, 'w36b');
  assert.throws(() => p.setPin('ww', 'ann', { mode: 'after', anchorBookId: 'same' }), /regular issue/);
  assert.throws(() => p.setPin('ww', 'ann', { mode: 'sideways' }), /mode/);
  assert.equal(p.clearPin('ww', 'ann'), 1);
  assert.equal(where(p.placement('ww'), 'ann').afterBookId, 'w37');
});

test("an event's own series places only pinned books", () => {
  const { p } = fixture({ eventHome: true });
  const r = p.placement('ww');
  assert.equal(r.eventHome, true);
  assert.equal(r.placed.length, 0);
  p.setPin('ww', 'ann', { mode: 'after', anchorBookId: 'w37' });
  assert.equal(where(p.placement('ww'), 'ann').afterBookId, 'w37');
});

test('minis may lead into #1 from up to 10 weeks before; single books 4', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, monitored_series_id TEXT);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, filename TEXT, issue_number TEXT, title TEXT, comicinfo TEXT,
      is_special INTEGER DEFAULT 0, sort_order REAL, store_date TEXT);
    CREATE TABLE series_annual_links (parent_series_id TEXT, annual_series_id TEXT);`);
  db.prepare('INSERT INTO scanned_series VALUES (?,?,?)').run('ww', 'Wonder Woman', null);
  const add = db.prepare('INSERT INTO scanned_books VALUES (?,?,?,?,?,?,?,?,?)');
  add.run('w1', 'ww', 'Wonder Woman 001 (2023).cbz', '1', '', '<Series>Wonder Woman</Series>', 0, 1, '2023-09-19');
  add.run('w2', 'ww', 'Wonder Woman 002 (2023).cbz', '2', '', '<Series>Wonder Woman</Series>', 0, 2, '2023-10-24');
  add.run('kt1', 'ww', 'Knight Terrors Wonder Woman 001 (2023).cbz', '1', 'Part One', '<Series>Knight Terrors: Wonder Woman</Series><Number>1</Number>', 1, 9001, '2023-07-18');
  add.run('kt2', 'ww', 'Knight Terrors Wonder Woman 002 (2023).cbz', '2', 'Part Two', '<Series>Knight Terrors: Wonder Woman</Series><Number>2</Number>', 1, 9002, '2023-08-15');
  add.run('one', 'ww', 'Wonder Woman Special 001.cbz', '1', '', '<Series>Wonder Woman Special</Series><Number>1</Number>', 1, 9003, '2023-07-18');
  const p = createSeriesPlacement({ db });
  const r = p.placement('ww');
  assert.equal(where(r, 'kt1').afterBookId, null);
  assert.equal(where(r, 'kt1').label, 'Knight Terrors #1');
  assert.equal(where(r, 'kt1').title, 'Part One');                   // "Wonder Woman" subtitle is the parent: book title instead
  assert.equal(shelved(r, 'one').reason, 'long before the run');
  assert.deepEqual(p.sequence('ww'), ['kt1', 'kt2', 'w1', 'w2']);
});

test('labels for the number line', () => {
  const b = (series, n, title = 'Book title') => ({ comicinfo: `<Series>${series}</Series><Number>${n}</Number>`, title });
  const ww = ['Wonder Woman'];
  assert.deepEqual(extraLabel(b('Wonder Woman 2026 Annual: Wonder War - The Matriarch Special', '1'), ww, true), { label: '2026 Annual #1', title: 'Matriarch Special' });
  assert.deepEqual(extraLabel(b('Wonder Woman Annual', '03'), ww, true), { label: 'Annual #3', title: 'Book title' });
  assert.deepEqual(extraLabel(b('Amazons Attack', '1'), ww, false), { label: 'Amazons Attack #1', title: 'Book title' });
  assert.deepEqual(extraLabel(b('Wonder Woman', '1'), ww, false), { label: 'Special #1', title: 'Book title' });
  assert.deepEqual(extraLabel(b('Wonder Woman Annual', '1'), ['The Amazing Spider-Man'], true), { label: 'Wonder Woman Annual #1', title: 'Book title' });
  assert.deepEqual(extraLabel(b('Amazing Spider-Man Annual', '2'), ['The Amazing Spider-Man'], true), { label: 'Annual #2', title: 'Book title' });
  assert.deepEqual(extraLabel(b('Wonder Woman Giant', '1'), ['Wonder Woman'], false), { label: 'Giant #1', title: 'Book title' });
  assert.deepEqual(extraLabel(b('Wonder Womanly', '1'), ['Wonder Woman'], false), { label: 'Wonder Womanly #1', title: 'Book title' });
});

test('routes: the placement with each placed book in the Issues shape; admins pin and unpin', () => {
  const { db } = fixture();
  db.exec('CREATE TABLE read_progress (book_id TEXT, user_id TEXT, page INTEGER, completed INTEGER)');
  db.prepare('INSERT INTO read_progress VALUES (?,?,?,?)').run('ann', 'u1', 30, 1);
  const routes = {};
  const app = { get: (p, _a, h) => { routes[`GET ${p}`] = h; }, put: (p, _a, h) => { routes[`PUT ${p}`] = h; }, delete: (p, _a, h) => { routes[`DELETE ${p}`] = h; } };
  const { registerPlacementRoutes } = require('./seriesPlacement');
  registerPlacementRoutes({ app, db, requireAuth: 1, requireAdmin: 1, members: id => (id === 'ww' ? [{ id: 'aa' }] : []),
    parseComicInfo: () => ({ pageCount: 32 }), withEventMarkers: (_db, books) => books.map(b => ({ ...b, events: [] })) });
  const call = (key, params, body) => { let out, code = 200; routes[key]({ params, body, user: { sub: 'u1' } },
    { json: d => { out = d; }, status: c => { code = c; return { json: d => { out = d; } }; } }); return { code, out }; };
  let r = call('GET /api/series/:id/placement', { id: 'ww' });
  const ann = r.out.placed.find(x => x.bookId === 'ann');
  assert.equal(ann.label, '2026 Annual #1');
  assert.deepEqual(ann.book.readProgress, { page: 30, completed: true });
  assert.equal(ann.book.media.pagesCount, 32);
  assert.deepEqual(ann.book.events, []);
  assert.equal(call('GET /api/series/:id/placement', { id: 'nope' }).code, 404);
  assert.equal(call('PUT /api/series/:id/placement/:bookId', { id: 'ww', bookId: 'ann' }, { mode: 'shelf' }).out.ok, true);
  r = call('GET /api/series/:id/placement', { id: 'ww' });
  assert.equal(r.out.placed.some(x => x.bookId === 'ann'), false);
  assert.equal(call('PUT /api/series/:id/placement/:bookId', { id: 'ww', bookId: 'ann' }, { mode: 'after', anchorBookId: 'same' }).code, 400);
  assert.equal(call('DELETE /api/series/:id/placement/:bookId', { id: 'ww', bookId: 'ann' }).out.cleared, 1);
});
