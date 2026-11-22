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
  assert.deepEqual(r.homeEvents, [{ id: 'wwar', name: 'Wonder War', year: 2026, tier: null }]);   // the Issues page's link
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
  // A six-issue prelude that ends three weeks before #1 leads in whole, though its #1 is months earlier.
  const add2 = db.prepare('INSERT INTO scanned_books VALUES (?,?,?,?,?,?,?,?,?)');
  add2.run('ed1', 'ww', 'Emerald Dawn 001.cbz', '1', '', '<Series>Emerald Dawn</Series><Number>1</Number>', 1, 9010, '2023-03-02');
  add2.run('ed6', 'ww', 'Emerald Dawn 006.cbz', '6', '', '<Series>Emerald Dawn</Series><Number>6</Number>', 1, 9015, '2023-08-29');
  const r2 = p.placement('ww');
  assert.equal(where(r2, 'ed1').afterBookId, null);
  assert.equal(where(r2, 'ed6').afterBookId, null);
  assert.deepEqual(p.sequence('ww').slice(0, 4), ['ed1', 'kt1', 'kt2', 'ed6']);
});

test('labels for the number line', () => {
  const b = (series, n, title = 'Book title') => ({ comicinfo: `<Series>${series}</Series><Number>${n}</Number>`, title });
  const ww = ['Wonder Woman'];
  assert.deepEqual(extraLabel(b('Wonder Woman 2026 Annual: Wonder War - The Matriarch Special', '1'), ww, true), { label: '2026 Annual #1', title: 'Matriarch Special' });
  assert.deepEqual(extraLabel(b('Wonder Woman Annual', '03'), ww, true), { label: 'Annual #3', title: 'Book title' });
  assert.deepEqual(extraLabel(b('Amazons Attack', '1'), ww, false), { label: 'Amazons Attack #1', title: 'Book title' });
  assert.deepEqual(extraLabel(b('Wonder Woman', '1'), ww, false), { label: 'Special #1', title: 'Book title' });
  assert.deepEqual(extraLabel(b('Green Lantern', '1000000'), ['Green Lantern'], false, new Set([1, 2])), { label: '#1000000', title: 'Book title' });
  assert.deepEqual(extraLabel(b('Green Lantern', '1'), ['Green Lantern'], false, new Set([1, 2])), { label: 'Special #1', title: 'Book title' });
  assert.deepEqual(extraLabel(b('Green Lantern/Adam Strange', '1'), ['Green Lantern'], false), { label: 'Green Lantern/Adam Strange #1', title: 'Book title' });
  assert.deepEqual(extraLabel(b('Daredevil & Echo', '2'), ['Daredevil'], false), { label: 'Daredevil & Echo #2', title: 'Book title' });
  assert.deepEqual(extraLabel(b("Uncanny X-Men '95", '1'), ['The Uncanny X-Men'], true), { label: "Uncanny X-Men '95 #1", title: 'Book title' });
  assert.deepEqual(extraLabel(b('X-Men: Blood Hunt - Laura Kinney the Wolverine', '1'), ['X-Men'], false), { label: 'Blood Hunt #1', title: 'Laura Kinney the Wolverine' });
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

test('an ongoing that hosts an event (few of its issues in it) is placed as usual', () => {
  const { db, p } = fixture({ eventHome: true });
  db.prepare("DELETE FROM event_issues WHERE scanned_book_id = 'w38'").run();   // 1 of 3 issues in the event
  const r = p.placement('ww');
  assert.equal(r.eventHome, false);
  assert.deepEqual(r.homeEvents, []);
  assert.equal(where(r, 'ann').afterBookId, 'w37');
});

test('#0, negative and #1,000,000 issues go by release date in the run; a #0 released first stays first; 0.1 stays', () => {
  const { db, p } = fixture();
  const add = db.prepare('INSERT INTO scanned_books VALUES (?,?,?,?,?,?,?,?,?)');
  add.run('w0', 'ww', 'Wonder Woman 000.cbz', '0', 'Zero Month', '<Series>Wonder Woman</Series><Number>0</Number>', 0, 0, '2026-09-23');
  add.run('wm', 'ww', 'Wonder Woman 1000000.cbz', '1000000', 'One Million', '<Series>Wonder Woman</Series><Number>1000000</Number>', 0, 1000000, '2026-08-20');
  add.run('w01', 'ww', 'Wonder Woman 000.1.cbz', '0.1', 'Prequel', '<Series>Wonder Woman</Series><Number>0.1</Number>', 0, 0.1, '2026-10-28');
  const r = p.placement('ww');
  assert.deepEqual(r.regular.map(x => x.id), ['w01', 'w36', 'wm', 'w37', 'w0', 'w38']);
  assert.equal(where(r, 'ann').afterBookId, 'w0');                       // Sep 30: after #0 (Sep 23), before #38
  db.prepare("UPDATE scanned_books SET store_date = '2026-01-07' WHERE id = 'w0'").run();
  assert.equal(p.placement('ww').regular[0].id, 'w0');                   // released before the run: first
});

test('books after one issue from the same Timeline keep its order though a finale shipped late; others stay by date', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, monitored_series_id TEXT);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, filename TEXT, issue_number TEXT, title TEXT, comicinfo TEXT,
      is_special INTEGER DEFAULT 0, sort_order REAL, store_date TEXT);
    CREATE TABLE series_annual_links (parent_series_id TEXT, annual_series_id TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT, year INTEGER, draft INTEGER DEFAULT 0, home_series_id TEXT);
    CREATE TABLE event_issues (id INTEGER PRIMARY KEY, event_id TEXT, scanned_book_id TEXT, sort_order INTEGER);`);
  db.prepare('INSERT INTO scanned_series VALUES (?,?,?)').run('cap', 'Captain America', null);
  const add = db.prepare('INSERT INTO scanned_books VALUES (?,?,?,?,?,?,?,?,?)');
  const ci = (series, n) => `<ComicInfo><Series>${series}</Series><Number>${n}</Number></ComicInfo>`;
  add.run('c600', 'cap', 'Captain America 600.cbz', '600', '', ci('Captain America', 600), 0, 600, '2009-06-17');
  add.run('c601', 'cap', 'Captain America 601.cbz', '601', '', ci('Captain America', 601), 0, 601, '2009-08-26');
  add.run('c602', 'cap', 'Captain America 602.cbz', '602', '', ci('Captain America', 602), 0, 602, '2010-01-27');
  const reborn = ['2009-09-02', '2009-09-30', '2009-10-21', '2009-11-04', '2009-11-25', '2010-01-27'];
  reborn.forEach((d, k) => add.run(`r${k + 1}`, 'cap', `Captain America Reborn 00${k + 1}.cbz`, String(k + 1), '', ci('Captain America: Reborn', k + 1), 1, 9000 + k, d));
  add.run('wws', 'cap', 'Captain America Reborn Who Will Wield the Shield 001.cbz', '1', '', ci('Captain America: Who Will Wield the Shield?', 1), 1, 9010, '2010-01-20');
  add.run('xs', 'cap', 'Captain America Special 001.cbz', '1', '', ci('Captain America Special', 1), 1, 9011, '2009-12-02');   // no Timeline
  db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run('reb', 'Captain America: Reborn', 2009, 0, null);
  const ei = db.prepare('INSERT INTO event_issues (event_id, scanned_book_id, sort_order) VALUES (?,?,?)');
  ['c600', 'c601', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'wws'].forEach((id, k) => ei.run('reb', id, k + 1));
  const p = createSeriesPlacement({ db, members: () => [] });
  assert.deepEqual(p.sequence('cap'), ['c600', 'c601', 'r1', 'r2', 'r3', 'r4', 'r5', 'xs', 'r6', 'wws', 'c602']);
});

test('crossover issues (crossovers.js) go after the issue they continue, or before the one they lead into; not twice, not over a placed book', () => {
  const { db } = fixture();
  const add = db.prepare('INSERT INTO scanned_books VALUES (?,?,?,?,?,?,?,?,?)');
  db.prepare('INSERT INTO scanned_series VALUES (?,?,?)').run('bat', 'Batman', null);
  add.run('b16', 'bat', 'Batman 016.cbz', '16', 'Mark of Hecate', '<ComicInfo><Series>Absolute Batman</Series><Number>16</Number></ComicInfo>', 0, 16, '2026-09-23');
  add.run('b17', 'bat', 'Batman 017.cbz', '17', 'Next', '<ComicInfo><Series>Absolute Batman</Series><Number>17</Number></ComicInfo>', 0, 17, '2026-10-28');
  const links = [
    { bookId: 'b16', afterBookId: 'w37', story: 'The Mark of Hecate' },   // Wonder Woman #37 → Batman #16
    { bookId: 'b16', beforeBookId: 'w38', story: 'The Mark of Hecate' },  // and Batman #16 → Wonder Woman #38: one card
    { bookId: 'b17', beforeBookId: 'w36', story: 'Earlier' },             // leads into #36: after the issue before it (none: first)
    { bookId: 'aa1', afterBookId: 'w36', story: 'x' },                    // Amazons Attack #1 is already placed as a mini
  ];
  const p = createSeriesPlacement({ db, members: id => (id === 'ww' ? [{ id: 'aa' }] : []), crossoversFor: id => (id === 'ww' ? links : []) });
  const seq = p.sequence('ww');
  assert.equal(seq.filter(id => id === 'b16').length, 1);
  assert.ok(seq.indexOf('b16') > seq.indexOf('w37') && seq.indexOf('b16') < seq.indexOf('w38'));
  assert.ok(seq.indexOf('b17') < seq.indexOf('w36'));
  const card = p.placement('ww').placed.find(x => x.bookId === 'b16');
  assert.deepEqual([card.kind, card.label, card.title, card.afterBookId], ['crossover', 'Absolute Batman #16', 'Crossover · The Mark of Hecate', 'w37']);
  assert.equal(p.placement('ww').placed.find(x => x.bookId === 'aa1').kind, 'linked');
  assert.ok(!p.sequence('ww', { crossovers: false }).includes('b16'));   // the order crossovers.js checks against
  p.setPin('ww', 'b16', { mode: 'shelf' });                              // an admin can shelve a wrong one
  assert.ok(!p.sequence('ww').includes('b16'));
});
