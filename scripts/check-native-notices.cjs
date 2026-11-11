'use strict';
// Check packaged notice integrity and report dependency drift separately.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { alpinePackages } = require('./image-license-inventory.cjs');
function verifyCoverage(coverage, installed) {
  const warnings = [];
  for (const p of installed.filter(p => /GPL|MPL/i.test(p.license || '') || coverage.alpine.some(e => e.name === p.name))) {
    const expected = coverage.alpine.find(e => e.name === p.name);
    if (!expected || expected.version !== p.version || expected.sourceCommit !== p.sourceCommit) {
      warnings.push('Review changed Alpine dependency: ' + p.name + '@' + p.version);
    }
  }
  return warnings;
}
function verifyFiles(dir, coverage) {
  const failures = [];
  for (const f of coverage.files) {
    if (path.basename(f.file) !== f.file) throw new Error('Invalid notice filename');
    const full = path.join(dir, f.file);
    if (!fs.existsSync(full) || crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') !== f.sha256) {
      failures.push('Missing or changed native notice: ' + f.file);
    }
  }
  return failures;
}
function review(dir, coverage, installed, libvips) {
  const failures = verifyFiles(dir, coverage);
  if (failures.length) throw new Error(failures.join('\n'));
  const warnings = verifyCoverage(coverage, installed);
  for (const p of libvips) {
    if (!coverage.libvips.some(e => e.name === p.name && e.version === p.version)) {
      warnings.push('Review changed libvips dependency: ' + p.name + '@' + p.version);
    }
  }
  if (!libvips.length) warnings.push('Bundled libvips not found; review the changed dependency layout');
  return {
    schemaVersion: 1,
    referenceImage: coverage.image,
    noticeIntegrity: 'passed',
    dependencyComparison: warnings.length ? 'review-needed' : 'matches-reference',
    sourceCompleteness: 'not-established',
    scope: 'Selected Alpine packages and bundled libvips. Matching versions do not establish source completeness or license compliance.',
    warnings
  };
}
function check(dir = '/usr/share/doc/omnibus/native') {
  const coverage = JSON.parse(fs.readFileSync(path.join(dir, 'coverage.json'), 'utf8'));
  const installed = alpinePackages(fs.readFileSync('/lib/apk/db/installed', 'utf8'));
  const img = '/app/backend/node_modules/@img';
  const names = fs.existsSync(img) ? fs.readdirSync(img).filter(n => n.startsWith('sharp-libvips-')) : [];
  const libvips = names.map(name => JSON.parse(fs.readFileSync(path.join(img, name, 'package.json'), 'utf8')));
  const result = review(dir, coverage, installed, libvips);
  fs.writeFileSync(path.join(dir, 'review-status.json'), JSON.stringify(result, null, 2) + '\n');
  for (const warning of result.warnings) console.warn('Native notice review: ' + warning);
  console.log('Packaged notice integrity passed. Source completeness is not established; see native/README.md.');
}
if (require.main === module) check(process.argv[2]);
module.exports = { verifyCoverage, verifyFiles, review };
