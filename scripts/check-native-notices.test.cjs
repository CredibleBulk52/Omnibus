'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyCoverage, verifyFiles, review } = require('./check-native-notices.cjs');
test('changed and newly introduced covered Alpine dependencies require a review', () => {
  const pkg = { name: 'example', version: '1-r0', sourceCommit: 'abc', license: 'LGPL-2.1-or-later' };
  const coverage = { alpine: [pkg] };
  assert.deepEqual(verifyCoverage(coverage, [pkg]), []);
  assert.equal(verifyCoverage(coverage, [{ ...pkg, version: '2-r0' }]).length, 1);
  assert.equal(verifyCoverage(coverage, [{ ...pkg, sourceCommit: 'def' }]).length, 1);
  assert.equal(verifyCoverage(coverage, [{ ...pkg, name: 'new-component' }]).length, 1);
});
test('missing or altered license text fails integrity verification', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-notice-test-'));
  t.after(() => { fs.unlinkSync(path.join(dir, 'NOTICE.txt')); fs.rmdirSync(dir); });
  const bytes = Buffer.from('Upstream license text\n');
  const coverage = { files: [{ file: 'NOTICE.txt', sha256: crypto.createHash('sha256').update(bytes).digest('hex') }] };
  assert.equal(verifyFiles(dir, coverage).length, 1);
  fs.writeFileSync(path.join(dir, 'NOTICE.txt'), bytes);
  assert.deepEqual(verifyFiles(dir, coverage), []);
  fs.appendFileSync(path.join(dir, 'NOTICE.txt'), 'changed');
  assert.equal(verifyFiles(dir, coverage).length, 1);
});

test('committed native notice files match their recorded hashes', () => {
  const dir = path.join(__dirname, '..', 'licenses', 'native');
  const coverage = JSON.parse(fs.readFileSync(path.join(dir, 'coverage.json'), 'utf8'));
  assert.equal(coverage.schemaVersion, 1);
  assert.equal(coverage.files.length, 2);
  assert.deepEqual(verifyFiles(dir, coverage), []);
});


test('dependency drift warns without claiming that matching versions prove source completeness', () => {
  const dir = path.join(__dirname, '..', 'licenses', 'native');
  const coverage = JSON.parse(fs.readFileSync(path.join(dir, 'coverage.json'), 'utf8'));
  const matching = review(dir, coverage, coverage.alpine, coverage.libvips);
  assert.equal(matching.dependencyComparison, 'matches-reference');
  assert.equal(matching.sourceCompleteness, 'not-established');
  const changed = review(dir, coverage, [...coverage.alpine, { name: 'new-component', version: '1', license: 'GPL-2.0-only' }], [{ name: '@img/sharp-libvips-linuxmusl-x64', version: 'new' }]);
  assert.equal(changed.dependencyComparison, 'review-needed');
  assert.equal(changed.warnings.length, 2);
  const bad = { ...coverage, files: [{ file: 'missing-NOTICE.txt', sha256: 'missing' }] };
  assert.throws(() => review(dir, bad, [], []), /Missing or changed native notice/);
});
