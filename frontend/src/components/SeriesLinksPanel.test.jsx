import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { SeriesLinksPanel } from './LibraryHealth';

const item = { seriesId: 'ss_1', folder: 'Arkham Manor (2014)', path: '/comics/Arkham Manor (2014)',
  current: { comicid: '81000', name: 'Arkham Manor: Endgame', year: 2015, totalIssues: 1, image: 'https://cv/img.jpg' },
  proposed: { volumeId: '77000', name: 'Arkham Manor' }, groups: [{ name: 'Arkham Manor', books: 7, volumeId: '77000' }] };

test('each wrong link shows series.json against the comics, as covers; Keep dismisses it', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const prev = global.fetch;
  let items = [item];
  global.fetch = vi.fn(async (url, opts) => {
    if (String(url).endsWith('/dismiss')) { items = []; return { ok: true, json: async () => ({ ok: true }) }; }
    return { ok: true, json: async () => ({ items, progress: { counts: { mismatch: 1, ok: 4, mixed: 2, clear: 900 }, notYetRead: 100 } }) };
  });
  const host = document.createElement('div'), root = createRoot(host);
  try {
    await act(async () => { root.render(<MemoryRouter><SeriesLinksPanel /></MemoryRouter>); });
    expect(host.textContent).toMatch(/1 folder to check · 100 folders not read yet/);
    expect([...host.querySelectorAll('figcaption b')].map(b => b.textContent)).toEqual(['Arkham Manor: Endgame', 'Arkham Manor']);
    expect(host.querySelector('.lp-wrong img').getAttribute('src')).toBe('https://cv/img.jpg');
    expect(host.querySelector('.lp-right img').getAttribute('src')).toBe('/api/series/ss_1/thumbnail');
    const keep = [...host.querySelectorAll('button')].find(b => b.textContent === 'Keep');
    await act(async () => { keep.click(); await new Promise(r => setTimeout(r, 0)); });
    expect(global.fetch).toHaveBeenCalledWith('/api/admin/library-health/series-links/ss_1/dismiss', { method: 'POST' });
    expect(host.textContent).toMatch(/No wrong links found/);
  } finally { act(() => root.unmount()); global.fetch = prev; }
});
