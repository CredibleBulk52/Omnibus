'use strict';
// Cases from the manual pass of 511 duplicate groups (2026-10-16).
const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('./duplicateRules');
const web = (slug, id) => `<ComicInfo><Web>https://comicvine.gamespot.com/${slug}/4000-${id}/</Web></ComicInfo>`;
const ci = (series, number, year, extra = '') => `<ComicInfo><Series>${series}</Series><Number>${number}</Number>${year ? `<Year>${year}</Year>` : ''}${extra}</ComicInfo>`;
const book = (id, p, comicinfo, size = 50e6, more = {}) => ({ id, path: p, filename: p.split('/').pop(), comicinfo, cv_issue_id: '1', file_size: size, ...more });

test('titles: word order, words in the middle or in front make a different comic', () => {
  assert.equal(r.titleRelation('Justice League Aquaman Drowned Earth', 'aquaman justice league drowned earth'), 'different');
  assert.equal(r.titleRelation('Aquaman - Futures End', 'aquaman and the others futures end'), 'different');
  assert.equal(r.titleRelation('Even More Secret Origins', 'secret origins'), 'different');
  assert.equal(r.titleRelation('Superman', 'superman special'), 'different');
  assert.equal(r.titleRelation('Doom PatrolJLA Special', 'jla doom patrol special'), 'different');
});
test('titles: shortened partner names, franchise words, run-together links and typos are the same', () => {
  assert.equal(r.titleRelation('Power Man', 'Power Man and Iron Fist'), 'same');
  assert.equal(r.titleRelation('Poe Dameron', 'star wars poe dameron'), 'same');
  assert.equal(r.titleRelation('Legends Of The Dark Knight', 'batman legends of the dark knight'), 'same');
  assert.equal(r.titleRelation('Harley Quinn and Power Girl', 'harley quinnpower girl'), 'same');
  assert.equal(r.titleRelation('Cave Carson Has An Interstellar Eye', 'Cave Carson Has An Intersteller Eye'), 'same');
  assert.equal(r.titleRelation('Ghost Rider - Vengeance Unbound', 'ghost rider'), 'subtitle');
});
test('file names: last number is the issue; dated releases; reading-order prefixes', () => {
  assert.equal(r.fileView('Spider-Man 2099 005 (2014).cbz').number, '5');
  assert.equal(r.fileView('The Ray, 1994-08-00 (_00) (digital) (Glorith-Novus).cbz').title, 'The Ray');
  assert.equal(r.fileView('0. Batman - Rebirth 001.cbz').title, 'Batman - Rebirth');
  assert.equal(r.fileView('Superman v2 190 Double Feature Issue.cbz').after, 'Double Feature Issue');
});
test('link titles holding numbers: the number matching the file wins', () => {
  assert.equal(r.checkBook(book('a', '/c/E2S (2015)/Earth 2 - Society 002.cbz', web('earth-2-society-2', 1))).status, 'same');
  assert.equal(r.checkBook(book('b', '/c/CA (2004)/Captain America 001 (2005).cbz', web('captain-america-1-out-of-time-part-1', 1))).status, 'same');
});
test('a group: the mistagged copy leaves, the rest is a duplicate with a reason', () => {
  const v = r.classify([
    book('ok', '/c/Aquaman and the Others (2014-2015)/Aquaman and The Others - Futures End 001.cbz', web('aquaman-and-the-others-futures-end-1', 1), 42e6),
    book('bad', '/c/Aquaman (2011-2016)/Aquaman - Futures End 001.cbz', web('aquaman-and-the-others-futures-end-1', 1), 49e6, { has_progress: true }),
  ]);
  assert.deepEqual(v.mistagged.map(b => b.id), ['bad']);
  assert.equal(v.kind, 'none');
});
test('editions and subtitles need a person; partial copies are duplicates and never kept', () => {
  const ed = r.classify([book('a', '/c/S/Superman v2 190.cbz', ci('Superman', 190, 2003), 8e6), book('b', '/c/S/Superman v2 190 Double Feature Issue.cbz', ci('Superman', 190, 2003), 52e6)]);
  assert.equal(ed.kind, 'look');
  const part = r.classify([book('a', '/c/M/Marvel Mystery Comics 082 (inc).cbz', ci('Marvel Mystery Comics', 82, 1947), 4.4e6), book('b', '/c/M/Marvel Mystery Comics 082 Miss America only.cbz', ci('Marvel Mystery Comics', 82, 1947), 0.9e6)]);
  assert.equal(part.kind, 'duplicate'); assert.equal(part.keepId, 'a');
});
test('keep: own series folder first, then the era folder, then progress, then size', () => {
  const own = r.recommend([
    { ...book('hq', '/c/Harley Quinn (2016)/Old Lady Harley 001.cbz', ci('Old Lady Harley', 1, 2018), 34e6), has_progress: true },
    book('olh', '/c/Old Landy Harley (2018)/Old Lady Harley 001.cbz', ci('Old Lady Harley', 1, 2018), 34e6),
  ]);
  assert.equal(own.keepId, 'olh'); assert.match(own.reason, /own series folder/); assert.equal(own.progressElsewhere, true);
  const era = r.recommend([
    book('2016', '/c/Detective Comics (2016)/Detective Comics 1106 (2026).cbz', ci('Detective Comics', 1106, 2026), 48e6),
    book('2023', '/c/Detective Comics (2023)/Detective Comics 1106 (2026).cbz', ci('Detective Comics', 1106, 2026), 44e6),
  ]);
  assert.equal(era.keepId, '2023'); assert.match(era.reason, /years/);
  const annual = r.recommend([
    book('2016', '/c/Batman (2016)/Batman 2021 Annual Annual 001 (2022).cbz', ci('Batman 2021 Annual', 1, 2022), 81e6),
    book('2023', '/c/Batman (2023)/Batman 2021 Annual 001.cbz', ci('Batman 2021 Annual', 1, 2022), 82e6),
  ]);
  assert.equal(annual.keepId, '2016');
});
test('years: a misfiled copy whose own name carries the year is not a mistag; a folder-only conflict is', () => {
  const hq = r.classify([
    book('a', '/c/Harley Quinn (2021)/Harley Quinn 2021 Annual Annual 001 (2021).cbz', ci('Harley Quinn 2021 Annual', 1, 2021)),
    book('b', '/c/Harley Quinn (2023)/Harley Quinn 2021 Annual 001.cbz', ci('Harley Quinn 2021 Annual', 1, 2021)),
  ]);
  assert.equal(hq.mistagged.length, 0); assert.equal(hq.keepId, 'a');
  const shadow = r.classify([
    book('a', '/c/The Shadow 2012-2014/The Shadow 001.cbz', ci('The Shadow', 1, 2015), 17e6),
    book('b', '/c/The Shadow 2015/The Shadow 001.cbz', ci('The Shadow', 1, 2015), 40e6),
  ]);
  assert.deepEqual(shadow.mistagged.map(b => b.id), ['a']);
});
