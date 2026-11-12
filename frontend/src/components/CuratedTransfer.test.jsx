import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ImportButton } from './CuratedTransfer';
import { ADAPTERS } from './listEditor/adapters';

function Landed() { const s = useLocation().state; return <p id="landed">{s?.imported?.issues}</p>; }

async function choose(host, text) {
  const input = host.querySelector('input[type=file]');
  const file = new File([text], 'x.json', { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(r => setTimeout(r, 0)); });
}

test('Import sends the file and opens the draft in the editor; a non-JSON file is refused in place', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const prev = global.fetch;
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ kind: 'event', id: 'e1', editUrl: '/events/e1/edit', summary: { issues: 3, owned: 2 } }) }));
  const host = document.createElement('div'), root = createRoot(host);
  try {
    act(() => root.render(<MemoryRouter initialEntries={['/events']}><Routes>
      <Route path="/events" element={<ImportButton />} /><Route path="/events/:id/edit" element={<Landed />} /></Routes></MemoryRouter>));
    await choose(host, 'not json');
    expect(host.querySelector('[role=alert]').textContent).toMatch(/not an Omnibus export/);
    expect(global.fetch).not.toHaveBeenCalled();
    await choose(host, JSON.stringify({ format: 'omnibus-curated', version: 1, kind: 'event', item: { name: 'X' }, issues: [] }));
    expect(global.fetch).toHaveBeenCalledWith('/api/curated/import', expect.objectContaining({ method: 'POST' }));
    expect(host.querySelector('#landed').textContent).toBe('3');
  } finally { act(() => root.unmount()); global.fetch = prev; }
});

test('the editor explains how to publish each kind of draft', () => {
  expect(ADAPTERS.list.draftNote({ source: 'import', details: { visibility: 'private' } })).toMatch(/Essential/);
  expect(ADAPTERS.list.draftNote({ source: 'manual', details: { visibility: 'private' } })).toBeNull();
  expect(ADAPTERS.event.draftNote({ details: { draft: 1 } })).toMatch(/Hidden draft/);
  expect(ADAPTERS.event.draftNote({ details: { draft: 0 } })).toBeNull();
  expect(ADAPTERS.run.draftNote({ details: { status: 'pending' } })).toMatch(/Approved/);
  expect(ADAPTERS.event.fields({ details: { draft: 1 }, rows: [] })[0].key).toBe('draft');
  expect(ADAPTERS.event.fields({ details: {}, rows: [] }).some(f => f.key === 'draft')).toBe(false);
});
