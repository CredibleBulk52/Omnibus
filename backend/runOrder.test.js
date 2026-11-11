'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { placeNew, resetNumberOrder } = require('./runOrder');
function setup(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE canon_runs (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE canon_run_issues (id INTEGER PRIMARY KEY, run_id INTEGER, sort_order INTEGER, series_name TEXT, issue_number TEXT, volume_year TEXT);
    INSERT INTO canon_runs VALUES (1, 'Run'), (2, 'Crossover');`);
  const ins = db.prepare('INSERT INTO canon_run_issues (id, run_id, sort_order, series_name, issue_number, volume_year) VALUES (?,?,?,?,?,?)');
  for (const r of rows) ins.run(...r);
  return db;
}
const order = (db, run) => db.prepare('SELECT series_name s, issue_number n FROM canon_run_issues WHERE run_id = ? ORDER BY sort_order').all(run).map(r => `${r.s} #${r.n}`);

test('reset: single-series runs go to number order; crossover runs keep theirs', () => {
  const db = setup([[1, 1, 1, 'Lucifer', '3', '2000'], [2, 1, 2, 'Lucifer', '1', '2000'], [3, 1, 3, 'Lucifer', '2', null],
    [4, 2, 1, 'Superman', '423', '1939'], [5, 2, 2, 'Action Comics', '583', '1938'], [6, 2, 3, 'Superman', '1', '1939']]);
  assert.deepEqual(resetNumberOrder(db).map(r => r.id), [1]);
  assert.deepEqual(order(db, 1), ['Lucifer #1', 'Lucifer #2', 'Lucifer #3']);
  assert.deepEqual(order(db, 2), ['Superman #423', 'Action Comics #583', 'Superman #1']);
  assert.deepEqual(resetNumberOrder(db), []);   // nothing left to change
});
test('placeNew: added issues go in by number next to their series, not at the end', () => {
  // A hand-ordered run: an annual placed after #2, and a crossover issue after #3.
  const db = setup([[1, 1, 1, 'Hellblazer', '1', '1988'], [2, 1, 2, 'Hellblazer', '2', '1988'], [3, 1, 3, 'Hellblazer Annual', '1', '1989'],
    [4, 1, 4, 'Hellblazer', '3', '1988'], [5, 1, 5, 'Swamp Thing', '76', '1982'], [6, 1, 6, 'Hellblazer', '5', '1988'],
    [7, 1, 7, 'Hellblazer', '4', '1988'], [8, 1, 8, 'Hellblazer', '6', '1988'], [9, 1, 9, 'Hellblazer', '0', '1988'], [10, 1, 10, 'Constantine', '1', '2005']]);
  placeNew(db, 1, [7, 8, 9, 10]);
  assert.deepEqual(order(db, 1), ['Hellblazer #0', 'Hellblazer #1', 'Hellblazer #2', 'Hellblazer Annual #1', 'Hellblazer #3', 'Hellblazer #4',
    'Swamp Thing #76', 'Hellblazer #5', 'Hellblazer #6', 'Constantine #1']);
});
