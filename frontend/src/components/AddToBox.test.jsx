import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import AddToListModal, { addableSeriesBoxes } from './AddToListModal';
import { orderMyBoxes, matchesBoxQuery, sharedByOthers, matchesSharedQuery } from '../pages/CollectionsPage';

vi.mock('../App', async () => ({ ...(await vi.importActual('../App')), isAdmin: () => false, getUser: () => ({ id: 'u1' }) }));

test('boxes: My Pull Box first, then both kinds by last update; search matches titles', () => {
  const series = [{ id: 'c1', name: 'Space stuff', updated_at: '2026-10-01 10:00:00' }, { id: 'p', name: 'My Pull Box', purpose: 'pull', updated_at: '2026-01-01 00:00:00' }];
  const orders = [{ id: 7, name: 'Green Lantern journey', updated_at: '2026-11-02 08:00:00' }];
  const all = orderMyBoxes(series, orders);
  expect(all.map(b => `${b.kind}:${b.id}`)).toEqual(['series:p', 'order:7', 'series:c1']);
  expect(all.filter(b => matchesBoxQuery(b, 'lantern')).map(b => b.id)).toEqual([7]);
  expect(all.filter(b => matchesBoxQuery(b, '  ')).length).toBe(3);
});

test('sharing: followed boxes come after your own, as "Name\'s Box"; Shared by others leaves out yours and followed ones', () => {
  const mine = orderMyBoxes([{ id: 'c1', name: 'Mine', visibility: 'shared', updated_at: '2026-10-01' }], [{ id: 3, name: 'My order', visibility: 'public', updated_at: '2026-09-01' }],
    { series: [{ id: 'x', name: 'Cosmic', owner_name: 'Ann', updated_at: '2026-11-01' }], orders: [{ id: 9, name: 'GL journey', owner_name: 'Bob', updated_at: '2026-10-05' }] });
  expect(mine.map(b => b.displayName || b.name)).toEqual(['Mine', 'My order', "Ann's Cosmic", "Bob's GL journey"]);
  expect(mine.filter(b => b.sharedMine).map(b => b.id)).toEqual(['c1', 3]);
  expect(mine.filter(b => matchesBoxQuery(b, "ann's")).map(b => b.id)).toEqual(['x']);
  const others = sharedByOthers([{ id: 'x', name: 'Cosmic', owner_name: 'Ann', following: true }, { id: 'y', name: 'Horror', owner_name: 'Ann', following: false, updated_at: '2026-10-02' }],
    [{ id: 3, name: 'My order', owner_id: 'u1' }, { id: 9, name: 'GL', owner_id: 'u2', owner_name: 'Bob', following: true }, { id: 10, name: 'Flash', owner_id: 'u2', owner_name: 'Bob', updated_at: '2026-10-09' }], 'u1');
  expect(others.map(b => `${b.kind}:${b.displayName}`)).toEqual(["order:Bob's Flash", "series:Ann's Horror"]);
  // Find shared boxes searches titles and who shared them.
  expect(others.filter(b => matchesSharedQuery(b, 'bob')).map(b => b.id)).toEqual([10]);
  expect(others.filter(b => matchesSharedQuery(b, 'horr')).map(b => b.id)).toEqual(['y']);
});

test('boxes: a series can go in hand-picked boxes only; not smart boxes, My Pull Box or others\' boxes', () => {
  const cols = [
    { id: 'a', name: 'Mine', owner_id: 'u1', collection_type: 'manual' },
    { id: 'b', name: 'Smart', owner_id: 'u1', collection_type: 'auto' },
    { id: 'p', name: 'My Pull Box', owner_id: 'u1', purpose: 'pull' },
    { id: 'o', name: 'Someone else', owner_id: 'u2' },
    { id: 'l', name: 'Library', owner_id: null },
  ];
  expect(addableSeriesBoxes(cols, { admin: false, userId: 'u1' }).map(c => c.id)).toEqual(['a']);
  expect(addableSeriesBoxes(cols, { admin: true, userId: 'u1' }).map(c => c.id)).toEqual(['a', 'l']);   // own first, then the library's
});

let host, root, calls;
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  calls = []; localStorage.clear();
  global.fetch = vi.fn(async (url, opts = {}) => {
    calls.push([url, opts.method || 'GET', opts.body ? JSON.parse(opts.body) : null]);
    const json = url.startsWith('/api/reading-lists?') ? { lists: [{ id: 9, name: 'Batman journey', visibility: 'private' }] }
      : url === '/api/collections' ? [{ id: 'c1', name: 'Space stuff', owner_id: 'u1', collection_type: 'manual', seriesCount: 3 }]
      : { ok: true };
    return { ok: true, status: 200, json: async () => json, headers: { get: () => 'application/json' } };
  });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

test('Add to a box: a series goes into a series box, or its issues into a reading order', async () => {
  await act(async () => root.render(<MemoryRouter><AddToListModal withBoxes target={{ kind: 'series', seriesId: 's9', label: 'Nova' }} onClose={() => {}} /></MemoryRouter>));
  expect(document.body.textContent).toContain('Add Nova to a box');
  expect(document.body.textContent).toContain('Series boxes');
  expect(document.body.textContent).toContain('Reading orders');
  const pick = name => [...document.querySelectorAll('.rl-pick')].find(b => b.textContent.includes(name));
  const add = () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Add');
  await act(async () => pick('Space stuff').click());
  expect(document.body.textContent).not.toContain('What to add');         // a series box takes the whole series
  await act(async () => add().click());
  expect(calls.at(-1)).toEqual(['/api/collections/c1/series', 'POST', { seriesId: 's9' }]);
  expect(document.body.textContent).toContain('View box →');
});

test('Add to a box: an issue only offers reading orders', async () => {
  await act(async () => root.render(<MemoryRouter><AddToListModal withBoxes target={{ kind: 'book', bookId: 'b1', label: 'Nova #1' }} onClose={() => {}} /></MemoryRouter>));
  expect(document.body.textContent).not.toContain('Series boxes');
  expect(document.body.textContent).toContain('Add this issue to a reading order.');
  expect(calls.some(([u]) => u === '/api/collections')).toBe(false);
});
