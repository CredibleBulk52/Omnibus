import { filterSeriesView, viewCounts } from './seriesViews';

const list = [
  { id: 'bat', displayTotalIssues: 52 },
  { id: 'mini', displayTotalIssues: 4 },
  { id: 'kj', displayTotalIssues: 1 },                                           // a one-shot on no shelf
  { id: 'part', displayTotalIssues: 6, book_count: 1 },                          // own only #1 of a mini: a series
  { id: 'tie', displayTotalIssues: 1, group: { hidden: true, homes: [] } },      // a shelved one-shot: a tie-in
  { id: 'lead', displayTotalIssues: 3, group: { hidden: false, homes: [] } },    // a lead-in: visible, and a tie-in
  { id: 'nojson', book_count: 1 },                                               // no series.json: files decide
];
const ids = view => filterSeriesView(list, view).map(s => s.id);

test('Series, One-shots and Tie-ins', () => {
  expect(ids('main')).toEqual(['bat', 'mini', 'part', 'lead']);
  expect(ids('oneshots')).toEqual(['kj', 'nojson']);
  expect(ids('homeless')).toEqual(['kj', 'nojson']);
  expect(ids('grouped')).toEqual(['tie', 'lead']);
  expect(viewCounts(list)).toEqual({ tieIns: 2, oneShots: 2 });
});
