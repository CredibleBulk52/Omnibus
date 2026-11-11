import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import BoxMissingSeries from './BoxMissingSeries';

let host, root, calls, rows;
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  calls = [];
  rows = [
    { id: 1, name: 'Harrow County', start_year: 2015, publisher: 'Dark Horse', reason: 'Southern gothic.', cv_volume_id: '777', cv_name: 'Harrow County', image_url: 'https://cv/hc.jpg', issue_count: 32, looked_up: true },
    { id: 2, name: 'Gideon Falls', start_year: 2018, publisher: 'Image', reason: null, cv_volume_id: null, image_url: null, looked_up: true },
  ];
  global.fetch = vi.fn(async (url, opts = {}) => {
    calls.push([opts.method || 'GET', url]);
    const json = url === '/api/requests/mine' ? { requests: [{ kind: 'series', status: 'open', series_name: 'Gideon Falls', volume_year: 2018 }] }
      : url.endsWith('/missing') ? { missing: rows } : { success: true };
    return { ok: true, status: 200, json: async () => json };
  });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const render = props => act(() => root.render(<MemoryRouter><BoxMissingSeries boxId="col_1" boxName="Cosmic Horror" {...props} /></MemoryRouter>));

test('placeholders: Comic Vine cover and link, reason; Request for readers (Requested once asked); owners can remove', async () => {
  render({ canEdit: true, canDownload: false }); await flush();
  expect(host.textContent).toContain('Not in Omnibus yet (2)');
  expect(host.querySelector('img').getAttribute('src')).toBe('https://cv/hc.jpg');
  expect(host.querySelector('a[href*="comicvine"]').getAttribute('href')).toBe('https://comicvine.gamespot.com/volume/4050-777/');
  expect(host.textContent).toContain('Southern gothic.');
  const cards = [...host.querySelectorAll('.box-missing-card')];
  expect(cards[0].textContent).toContain('✉ Request');
  expect(cards[1].textContent).toContain('Requested');
  expect(cards[1].textContent).not.toContain('✉ Request');
  await act(async () => [...cards[0].querySelectorAll('button')].find(b => b.textContent === '✉ Request').click());
  expect(document.body.textContent).toContain('Request a series');
  expect(document.querySelector('textarea').value).toBe('For the box "Cosmic Horror". Southern gothic.');
  await act(async () => [...cards[1].querySelectorAll('button')].find(b => b.textContent === 'Remove').click());
  expect(calls).toContainEqual(['DELETE', '/api/collections/col_1/missing/2']);
  expect(host.querySelectorAll('.box-missing-card').length).toBe(1);
});

test('placeholders: download users get Add in Downloads; others cannot remove; nothing shows for a box without any', async () => {
  render({ canEdit: false, canDownload: true }); await flush();
  expect(host.querySelector('a.missing-cover-action').getAttribute('href')).toBe('/downloads?search=Harrow%20County');
  expect(host.textContent).not.toContain('Remove');
  expect(calls.some(([, u]) => u === '/api/requests/mine')).toBe(false);
  rows = [];
  act(() => root.unmount()); root = createRoot(host);
  render({ canEdit: true, canDownload: false }); await flush();
  expect(host.textContent).toBe('');
});
