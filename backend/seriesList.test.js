'use strict';
// The series list (2026-11-10): no raw series_json, no description, seriesJson only with the
// keys the list pages fall back on. Runs the real seriesListItem from server.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const code = src.slice(src.indexOf('const SERIES_LIST_JSON_KEYS'), src.indexOf("app.get('/api/series', (req, res) => {"));
const seriesListItem = new Function(code + '\nreturn seriesListItem;')();

test('series list item: display fields kept, series.json sent once and only what the list uses', () => {
  const merged = { id: 's1', name: 'Hulk', series_json: '{"metadata":{}}', displayTitle: 'Hulk (2016)', displayDescription: 'Long text…', displayGenres: ['Superhero'],
    seriesJson: { name: 'Hulk', year: 2016, characters: ['Jennifer Walters'], description_text: 'Long text…', description_formatted: '<p>Long</p>', comicid: 1 } };
  assert.deepEqual(seriesListItem(merged), { id: 's1', name: 'Hulk', displayTitle: 'Hulk (2016)', displayGenres: ['Superhero'],
    seriesJson: { name: 'Hulk', year: 2016, characters: ['Jennifer Walters'] } });
  assert.deepEqual(seriesListItem({ id: 's2', seriesJson: null, series_json: null }), { id: 's2', seriesJson: null });
  assert.deepEqual(seriesListItem({ id: 's3', seriesJson: [{ name: 'A-Z' }] }).seriesJson, [{ name: 'A-Z' }]);
});
