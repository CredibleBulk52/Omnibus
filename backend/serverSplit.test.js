'use strict';
// server.js split (2026-11-10): Comic Book Roundup ratings (cbr.js), Timeline event generation
// (eventGenerator.js) and Top Shelf run generation (canonGenerator.js) were moved unchanged.
// server.js must give each module every name it needs; each refuses to start without them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');

// 2026-11-19: Home (home.js), the Series list (seriesList.js) and the series caches (seriesCaches.js).
const MODULES = { 'cbr.js': 'createCbr', 'eventGenerator.js': 'registerEventGenerator', 'canonGenerator.js': 'registerCanonGenerator',
  'home.js': 'registerHome', 'seriesList.js': 'registerSeriesList', 'seriesCaches.js': 'createSeriesCaches',
  'topShelf.js': 'registerTopShelf',   // step 2, 2026-11-19
  'shelfRoutes.js': 'registerShelfRoutes',   // step 3
  'covers.js': 'createCovers', 'archiveFiles.js': 'createArchiveFiles',   // step 4
  'libraryScanner.js': 'createLibraryScanner',   // step 5
  'comicInfoFiles.js': 'createComicInfoFiles',   // step 6a
  'postProcessing.js': 'createPostProcessing', 'postProcessScan.js': 'createPostProcessScan', 'arrivalRegistration.js': 'createRegisterArrival' };   // step 6b
const needs = file => /const (?:missing|NEEDS) = \[([^\]]*)\]/.exec(fs.readFileSync(path.join(__dirname, file), 'utf8'))[1]
  .split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean);

test('server.js passes every name each moved module needs', () => {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  for (const [file, fn] of Object.entries(MODULES)) {
    const a = src.indexOf(`.${fn}({`);
    assert.ok(a > 0, `${fn} is called in server.js`);
    const args = src.slice(a + fn.length + 3, src.indexOf('});', a));
    const given = new Set(args.split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean));
    const missing = needs(file).filter(n => !given.has(n));
    assert.deepEqual(missing, [], `${fn} is not given ${missing.join(', ')}`);
  }
});

test('each moved module refuses to start when something it needs is missing', () => {
  for (const [file, fn] of Object.entries(MODULES)) {
    assert.throws(() => require('./' + file)[fn]({}), new RegExp(`${fn}: missing `));
  }
});

test('the CBR queue is started after the module exists (no use before it is created)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.ok(src.includes('setTimeout(() => runCbrQueue(), 20000)'));
  assert.ok(!/^setTimeout\(runCbrQueue,/m.test(src));   // at load time; calls inside functions run later
});
