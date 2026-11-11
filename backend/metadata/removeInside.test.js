'use strict';
// removeInside (2026-11-09): a damaged member is removed only inside the extraction folder,
// never through a symlink the archive created.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { removeInside } = require('./removeInside');

test('removes a member inside the folder; never through a link, a folder or outside', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remove-inside-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'work'), outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(work, 'pages'), { recursive: true }); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(work, 'pages', 'p1.jpg'), 'x');
  fs.writeFileSync(path.join(outside, 'victim.txt'), 'sentinel');
  fs.symlinkSync('../outside', path.join(work, 'redirect'));
  assert.equal(removeInside(work, 'redirect/victim.txt'), false);
  assert.equal(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8'), 'sentinel');
  assert.equal(removeInside(work, '../outside/victim.txt'), false);
  assert.equal(removeInside(work, 'pages'), false);
  assert.ok(fs.existsSync(path.join(work, 'pages')));
  assert.equal(removeInside(work, 'pages/p1.jpg'), true);
  assert.ok(!fs.existsSync(path.join(work, 'pages', 'p1.jpg')));
  assert.equal(removeInside(work, 'redirect'), true);   // the link itself, not what it points to
  assert.ok(fs.existsSync(path.join(outside, 'victim.txt')));
});
