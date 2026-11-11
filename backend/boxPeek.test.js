'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickPeek, spread } = require('./boxPeek');

const noShuffle = () => 0.999999;   // Fisher-Yates with this keeps the order
const books = { a: ['a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'], b: ['b2', 'b3'], c: [] };

test('a box with enough series shows series only, at most n', () => {
  const ids = Array.from({ length: 12 }, (_, i) => 's' + i);
  const out = pickPeek(ids, () => { throw new Error('no issues needed'); }, 8, noShuffle);
  assert.equal(out.length, 8);
  assert.ok(out.every(x => x.kind === 'series'));
});

test('a small box is topped up with issues: shared between series, spread through each run, interleaved', () => {
  const out = pickPeek(['a', 'b', 'c'], id => books[id], 8, noShuffle);
  assert.deepEqual(out.slice(0, 3).map(x => x.id), ['a', 'b', 'c']);
  const issues = out.slice(3).map(x => x.id);
  assert.equal(issues.length, 5);
  assert.deepEqual(issues.filter(id => id.startsWith('b')).sort(), ['b2', 'b3'], 'a short run gives what it has');
  assert.equal(issues.filter(id => id.startsWith('a')).length, 3, 'the rest come from the longer run');
  assert.deepEqual(issues.slice(0, 2).map(id => id[0]), ['a', 'b'], 'alternating series');
});

test('spread picks evenly through a run; an empty box shows nothing', () => {
  assert.deepEqual(spread(['1', '2', '3', '4', '5', '6', '7', '8'], 2), ['3', '7']);
  assert.deepEqual(spread(['1', '2'], 5), ['1', '2']);
  assert.deepEqual(pickPeek([], () => [], 8), []);
  assert.deepEqual(pickPeek(['c'], id => books[id], 8, noShuffle), [{ kind: 'series', id: 'c' }]);
});
