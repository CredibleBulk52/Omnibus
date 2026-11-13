import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../App', () => {
  const cache = { invalidate: () => {}, fetchSeries: async () => [{ id: 'fp', name: 'Flashpoint', displayTitle: 'Flashpoint (2011)', book_count: 5 }, { id: 'cold', name: 'Citizen Cold', book_count: 3 }] };
  return { useSeriesCache: () => cache, isAdmin: () => true };
});
import { LinkedSeriesShelf, PutOnShelfDialog, ShelfHomes } from './SeriesShelf';

function mount(el) {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<MemoryRouter>{el}</MemoryRouter>));
  return { host, root };
}

test('a home lists the series on its shelf with their role; Remove takes one off', async () => {
  const prev = global.fetch; global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
  const changed = vi.fn();
  const { host, root } = mount(<LinkedSeriesShelf homeId="fp" onChanged={changed}
    members={[{ id: 'cold', name: 'Flashpoint: Citizen Cold', year: 2011, issues: 3, role: 'tie-in', hidden: true }, { id: 'pre', name: 'Road to Flashpoint', year: 2011, issues: 1, role: 'prelude', hidden: false }]} />);
  try {
    expect(host.textContent).toMatch(/Series on this shelf · 2/);
    expect(host.textContent).toMatch(/Tie-in · 3 issues/);
    expect(host.textContent).toMatch(/Lead-in · 1 issue · also in the browser/);
    await act(async () => { host.querySelector('.linked-shelf-remove').click(); });
    expect(global.fetch).toHaveBeenCalledWith('/api/series/cold/shelf/fp', expect.objectContaining({ method: 'DELETE' }));
    expect(changed).toHaveBeenCalled();
  } finally { act(() => root.unmount()); global.fetch = prev; }
});

test('a series names its shelf; Put on a Specials shelf searches the library and saves the pick', async () => {
  const prev = global.fetch; global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
  const a = mount(<ShelfHomes seriesId="cold" homes={[{ id: 'fp', name: 'Flashpoint (2011)', role: 'tie-in' }]} />);
  expect(a.host.textContent).toMatch(/On the Specials shelf of Flashpoint \(2011\) · Tie-in/);
  act(() => a.root.unmount());
  const done = vi.fn(), close = vi.fn();
  const { host, root } = mount(<PutOnShelfDialog seriesId="cold" seriesName="Citizen Cold" onDone={done} onClose={close} />);
  try {
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const input = document.querySelector('input.input');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(input, 'flash'); input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const hit = [...document.querySelectorAll('.put-shelf-hit')];
    expect(hit.map(b => b.textContent)).toEqual([expect.stringMatching(/^Flashpoint \(2011\)/)]);
    await act(async () => { hit[0].click(); await new Promise(r => setTimeout(r, 0)); });
    expect(global.fetch).toHaveBeenCalledWith('/api/series/cold/shelf', expect.objectContaining({ method: 'POST', body: JSON.stringify({ homeId: 'fp' }) }));
    expect(done).toHaveBeenCalled(); expect(close).toHaveBeenCalled();
  } finally { act(() => root.unmount()); global.fetch = prev; }
});
