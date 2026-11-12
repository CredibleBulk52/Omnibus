'use strict';
// Fixes from GitHub code scanning (CodeQL), 2026-11-12: patterns that could backtrack on crafted
// names, and the import folder parser whose patterns had lost their backslashes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { publicationHint } = require('./metadata/candidate');
const { yearlyTag, annualNameFits } = require('./annualNames');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const start = source.indexOf('function folderTitleYear'), end = source.indexOf('/** String similarity', start);
const { folderTitleYear, parseFolderName } = new Function(source.slice(start, end) + '\nreturn { folderTitleYear, parseFolderName };')();
const quick = (fn, ms = 200) => { const t = Date.now(); fn(); assert.ok(Date.now() - t < ms, `took ${Date.now() - t} ms`); };

test('import folder names give their year again', () => {
  assert.deepEqual(parseFolderName('Action Comics (2016)'), { name: 'Action Comics', year: 2016 });
  assert.deepEqual(parseFolderName('  Batman (1940) '), { name: 'Batman', year: 1940 });
  assert.deepEqual(parseFolderName('Action Comics 2016'), { name: 'Action Comics', year: 2016 });
  assert.deepEqual(parseFolderName('2000 AD'), { name: '2000 AD', year: null });
  assert.deepEqual(parseFolderName('Saga'), { name: 'Saga', year: null });
  assert.deepEqual(folderTitleYear('X-Men (1991)'), { title: 'X-Men', year: 1991 });
  quick(() => parseFolderName('a' + ' '.repeat(100000) + '!'));
});

test('scan-group tags are still recognized, and crafted ones do not hang', () => {
  for (const f of ['Batman 001 (2016) (Digital) (Minutemen-Faessla).cbz', 'Batman 001 (2016) (digital) (AnPymGold - Empire).cbz', 'Batman 001 (2016) (Glorith-Novus-HD).cbz'])
    assert.equal(publicationHint(f).number, '1', f);
  // File names are at most 255 characters.
  quick(() => publicationHint(`Batman 001 (2016) (${'a-'.repeat(110)}!).cbz`), 50);
  quick(() => publicationHint(`Batman 001 (2016) (${'a - '.repeat(55)}x).cbz`), 50);
  quick(() => publicationHint(`Batman 001 (2016) (${"a'.& ".repeat(44)}x).cbz`), 50);
  // This one hung the old pattern for over five minutes (a 230-character name).
  quick(() => publicationHint(`Batman 001 (2016) (${'a  '.repeat(70)}!).cbz`), 50);
});

test('yearly annual tags still work without the slow leading space match', () => {
  assert.equal(yearlyTag("Sensational Spider-Man '96"), 1996);
  assert.equal(annualNameFits("Sensational Spider-Man '96", 'Sensational Spider-Man (1996)'), true);
  quick(() => yearlyTag(' '.repeat(100000) + 'x'));
});
