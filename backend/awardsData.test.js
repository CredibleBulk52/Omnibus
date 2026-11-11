'use strict';
// data/comic_awards.json (verified award winners, 2026-10-18): shape and a few known facts.
const test = require('node:test');
const assert = require('node:assert/strict');
const doc = require('./data/comic_awards.json');

test('every row is a sourced winner with the fields the sync needs', () => {
  assert.ok(doc.version && doc.rows.length > 700);
  const keys = new Set();
  for (const r of doc.rows) {
    assert.ok(['eisner', 'harvey', 'kirby', 'hugo', 'stoker'].includes(r.award), r.award);
    assert.ok(Number.isInteger(r.year) && r.year >= 1985 && r.year <= 2026, `${r.award} ${r.year}`);
    assert.ok(r.category && /^https?:\/\//.test(r.source), JSON.stringify(r));
    if (r.kind === 'work') assert.ok(r.title); else { assert.equal(r.kind, 'creator'); assert.ok(r.creator && Array.isArray(r.cited_works)); }
    const k = `${r.award}|${r.year}|${r.category}|${r.title || r.creator}`;
    assert.ok(!keys.has(k), `duplicate ${k}`); keys.add(k);
  }
});

test('known winners', () => {
  const has = (award, year, category, name) => doc.rows.some(r => r.award === award && r.year === year && r.category === category && (r.title || r.creator) === name);
  assert.ok(has('eisner', 1988, 'Best Finite Series', 'Watchmen'));
  assert.ok(has('eisner', 2023, 'Best Continuing Series', 'Nightwing'));
  assert.ok(has('eisner', 2024, 'Best Continuing Series', 'Transformers'));
  assert.ok(has('kirby', 1987, 'Best Graphic Album', 'Batman: The Dark Knight Returns'));
  const brubaker = doc.rows.find(r => r.award === 'eisner' && r.year === 2007 && r.category === 'Best Writer');
  assert.deepEqual(brubaker.cited_works, ['Captain America', 'Daredevil', 'Criminal']);
  assert.ok(!doc.rows.some(r => /Hall of Fame/.test(r.category)));
});
