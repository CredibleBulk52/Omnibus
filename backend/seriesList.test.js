'use strict';
// The series list (2026-11-10): no raw series_json, no description, seriesJson only with the
// keys the list pages fall back on. seriesList.js since the server.js split (2026-11-19).
const test = require('node:test');
const assert = require('node:assert/strict');
const { seriesListItemCore, registerSeriesList } = require('./seriesList');
const seriesListItem = merged => seriesListItemCore(merged);

test('series list item: display fields kept, series.json sent once and only what the list uses', () => {
  const merged = { id: 's1', name: 'Hulk', series_json: '{"metadata":{}}', displayTitle: 'Hulk (2016)', displayDescription: 'Long text…', displayGenres: ['Superhero'],
    seriesJson: { name: 'Hulk', year: 2016, characters: ['Jennifer Walters'], description_text: 'Long text…', description_formatted: '<p>Long</p>', comicid: 1 } };
  assert.deepEqual(seriesListItem(merged), { id: 's1', name: 'Hulk', displayTitle: 'Hulk (2016)', displayGenres: ['Superhero'],
    seriesJson: { name: 'Hulk', year: 2016, characters: ['Jennifer Walters'] } });
  assert.deepEqual(seriesListItem({ id: 's2', seriesJson: null, series_json: null }), { id: 's2', seriesJson: null });
  assert.deepEqual(seriesListItem({ id: 's3', seriesJson: [{ name: 'A-Z' }] }).seriesJson, [{ name: 'A-Z' }]);
});

test('series list item: the Specials shelf group is added when the series has one', () => {
  const routes = {};
  const app = { get: (p, fn) => { routes[p] = fn; } };
  const { seriesListItem: withGroup } = registerSeriesList({ app, fetchAllSeries: () => [], getSeriesCacheKey: k => k || '__all__', logger: {}, mergeSeriesWithJson: s => s,
    seriesCache: new Map(), seriesGroupOf: id => (id === 's1' ? { id: 'g1', name: 'Batman' } : null) });
  assert.deepEqual(withGroup({ id: 's1', seriesJson: null }).group, { id: 'g1', name: 'Batman' });
  assert.equal(withGroup({ id: 's2', seriesJson: null }).group, undefined);
  assert.equal(typeof routes['/api/series'], 'function');
});
