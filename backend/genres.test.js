'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { cleanGenres, repairStoredGenres, GENRES, GENRE_DEFS } = require('./genres');

test('genres: the AI commentary and off-list names are dropped; allowed names kept once, in order', () => {
  // Real values from the library (Nov 2 backup).
  assert.deepEqual(cleanGenres(['War', 'Action', 'Thriller\n\nI need to reconsider and choose only from the provided list:\n\nWar', 'Thriller']), ['War', 'Thriller']);
  assert.deepEqual(cleanGenres(['Noir', 'Crime', 'Heist\n\nWait', '"Heist" is not in the list. Let me choose from the provided options:\n\nNoir', 'Crime', 'Drama']), ['Noir', 'Crime', 'Drama']);
  assert.deepEqual(cleanGenres(['Superhero', 'Action', 'Horror\n\nWait', 'let me select only from the provided list:\n\nSuperhero', 'Horror', 'Thriller']), ['Superhero', 'Horror', 'Thriller']);
  assert.deepEqual(cleanGenres(['thriller\n\nWait', 'Thriller**', 'Espionage']), ['Thriller', 'Espionage']);
  assert.deepEqual(cleanGenres(['Masks is a Dynamite crossover of pulp heroes (The Shadow', 'Green Hornet']), []);
  assert.deepEqual(cleanGenres(['Superhero', 'Crime', 'Drama', 'Noir', 'Team']), ['Superhero', 'Crime', 'Drama', 'Noir']);
  assert.deepEqual(cleanGenres(['Street Level', 'sword and sorcery', 'Adventure']), ['Street-Level', 'Sword & Sorcery']);
  assert.deepEqual(cleanGenres(null), []);
  assert.equal(GENRES.length, 31);
  assert.ok(GENRE_DEFS.every(g => g.definition.length > 10) && !GENRES.includes('Adventure'));
});

test('genres: the repair rewrites only series with bad genres; an emptied series is enriched again', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE scanned_series (id TEXT, name TEXT, path TEXT, series_json TEXT)');
  const files = {
    '/c/good': { metadata: { name: 'Good', genres: ['Superhero', 'Drama'] } },
    '/c/bad': { metadata: { name: 'Bad', genres: ['Superhero', 'Action', 'Horror\n\nWait'], enrichment: { date: '2026-10-01' } } },
    '/c/empty': { metadata: { name: 'Masks', genres: ['Masks is a Dynamite crossover (The Shadow', 'Green Hornet'], enrichment: { date: '2026-10-01', sources: ['ai'] } } },
    '/c/odd': { metadata: [{ name: 'Odd' }] },
    '/c/adv': { metadata: { name: 'Adv', genres: ['Adventure', 'Superhero'] } },
    '/c/new': { metadata: { name: 'New', genres: ['Kaiju', 'Team'], enrichment: { genres_version: '2026-11' } } },
  };
  const ins = db.prepare('INSERT INTO scanned_series VALUES (?, ?, ?, ?)');
  for (const [p, d] of Object.entries(files)) ins.run(p.slice(3), d.metadata.name || 'Odd', p, JSON.stringify(d));
  const written = {};
  const r = repairStoredGenres({ db, readSeriesJson: p => structuredClone(files[p]), writeSeriesJson: (p, d) => { written[p] = d; } });
  assert.deepEqual(Object.keys(written).sort(), ['/c/bad', '/c/empty']);
  assert.deepEqual(written['/c/bad'].metadata.genres, ['Superhero', 'Horror']);
  assert.equal(written['/c/adv'], undefined);
  assert.equal(written['/c/new'], undefined);                      // already on the new list (retagged)                      // Adventure was valid when written: left for the retag
  assert.equal(written['/c/bad'].metadata.enrichment.date, '2026-10-01');
  assert.deepEqual(written['/c/empty'].metadata.genres, []);
  assert.equal(written['/c/empty'].metadata.enrichment.date, undefined);
  assert.deepEqual(written['/c/empty'].metadata.enrichment.sources, ['ai']);
  assert.deepEqual(r, { checked: 5, changed: 2, emptied: ['Masks'], failed: 0 });
  // An unreachable folder counts as failed, so the repair runs again at the next start.
  const r2 = repairStoredGenres({ db, readSeriesJson: () => null, writeSeriesJson: () => { throw new Error('no'); } });
  assert.equal(r2.failed, 2);   // the two bad ones; the others are fine in the library row
});
