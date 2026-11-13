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

test('the Library panel shows each event as covers: home first, then its shelf; Looks right confirms', async () => {
  const { SeriesGroupingPanel } = await import('./SeriesShelf');
  const summary = { counts: { rule: { links: 3, hidden: 2 } }, events: [
    { id: 'e1', name: 'Beast War', year: 2024, initiative: false, confirmed: false, how: 'essential', home: 'tbw', homeName: 'Titans: Beast World (2024)', chosen: null,
      members: [{ id: 'g', name: 'Titans: Beast World Tour: Gotham (2023)', role: 'tie-in', hidden: true }, { id: 'w', name: 'Waller Rising (2024)', role: 'prelude', hidden: false }] },
    { id: 'e2', name: 'Flashpoint', year: 2011, initiative: false, confirmed: true, how: 'name', home: 'fp', homeName: 'Flashpoint (2011)', chosen: null, members: [{ id: 'c', name: 'Citizen Cold', role: 'tie-in', hidden: true }] }] };
  const prev = global.fetch; global.fetch = vi.fn(async () => ({ ok: true, json: async () => summary }));
  const { host, root } = mount(<SeriesGroupingPanel />);
  try {
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(host.textContent).toMatch(/3 series on shelves · 2 out of the browser/);
    expect(host.querySelectorAll('.gp-row').length).toBe(1);   // "To check": only the unconfirmed event
    expect(host.querySelector('.gp-row .gp-home img').getAttribute('src')).toBe('/api/series/tbw/thumbnail');
    expect(host.querySelectorAll('.gp-row .gp-cover').length).toBe(2);
    expect(host.querySelectorAll('.gp-row .gp-visible').length).toBe(1);
    expect(host.textContent).toMatch(/guessed/);
    const ok = [...host.querySelectorAll('button')].find(b => b.textContent === '✓ Looks right');
    await act(async () => { ok.click(); await new Promise(r => setTimeout(r, 0)); });
    expect(global.fetch).toHaveBeenCalledWith('/api/grouping/events/e1', expect.objectContaining({ method: 'POST', body: JSON.stringify({ confirm: true }) }));
  } finally { act(() => root.unmount()); global.fetch = prev; }
});

test('each row says why and links to the reading order; every action offers Undo; Removed restores', async () => {
  const { SeriesGroupingPanel } = await import('./SeriesShelf');
  const summary = { counts: { rule: { links: 1, hidden: 1 } }, events: [
    { id: 'aor', name: 'Age of Revelation', year: 2025, initiative: false, confirmed: false, how: 'title', why: "Its title has the event's name and it starts the main story",
      home: 'ovt', homeName: 'X-Men: Age of Revelation Overture (2025)', chosen: null, proposed: 'ovt', members: [{ id: 'amz', name: 'Amazing X-Men (2025)', role: 'core', hidden: false }] }] };
  const previous = { id: 'aor', chosen: null, confirmed: false, source: null, initiative: false };
  const removed = [{ seriesId: 'cold', name: 'Citizen Cold (2011)', homeId: 'fp', homeName: 'Flashpoint (2011)', at: 1 }];
  const prev = global.fetch;
  global.fetch = vi.fn(async (url, opts = {}) => ({ ok: true, json: async () => {
    if (url === '/api/grouping') return summary;
    if (url === '/api/grouping/removed') return { items: removed };
    if (url === '/api/grouping/events/aor' && JSON.parse(opts.body || '{}').confirm) return { previous };
    if (url.startsWith('/api/series/amz/shelf/ovt')) return { ok: true, source: 'rule' };
    return { ok: true };
  } }));
  const { host, root } = mount(<SeriesGroupingPanel />);
  const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
  const button = t => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === t);
  try {
    await tick();
    expect(host.querySelector('.gp-why').textContent).toMatch(/Its title has the event's name.*Reading order ›/);
    await act(async () => { button('✓ Looks right').click(); }); await tick();
    expect(host.querySelector('.gp-undo').textContent).toMatch(/Approved X-Men: Age of Revelation Overture \(2025\) for Age of Revelation/);
    await act(async () => { button('Undo').click(); }); await tick();
    expect(global.fetch).toHaveBeenCalledWith('/api/grouping/events/aor', expect.objectContaining({ body: JSON.stringify({ restore: previous }) }));
    // ✕ on a cover, then Undo puts the rule's link back.
    await act(async () => { host.querySelector('.gp-x').click(); }); await tick();
    await act(async () => { button('Undo').click(); }); await tick();
    expect(global.fetch).toHaveBeenCalledWith('/api/grouping/restore', expect.objectContaining({ body: JSON.stringify({ items: [{ seriesId: 'amz', homeId: 'ovt', eventId: 'aor' }] }) }));
    // Removed tab.
    await act(async () => { [...host.querySelectorAll('[role=tab]')].find(b => /Removed/.test(b.textContent)).click(); });
    expect(host.querySelector('.gp-rm').textContent).toMatch(/Citizen Cold \(2011\)from Flashpoint \(2011\)/);
    await act(async () => { button('↺ Restore').click(); }); await tick();
    expect(global.fetch).toHaveBeenCalledWith('/api/grouping/restore', expect.objectContaining({ body: JSON.stringify({ items: [{ seriesId: 'cold', homeId: 'fp' }] }) }));
  } finally { act(() => root.unmount()); global.fetch = prev; }
});

test('the AI line: Ask, its view on a row, Use the AI\'s advice, and Apply sure changes with Undo', async () => {
  const { SeriesGroupingPanel } = await import('./SeriesShelf');
  const summary = { counts: { rule: { links: 2, hidden: 1 } }, ai: { asked: 1, ready: 2, model: 'Claude Sonnet 5.5', auto: false, running: null, lastApplied: null },
    events: [
      { id: 'ok', name: 'Siege', year: 2010, confirmed: false, how: 'name', why: 'Named like the event · 2010', home: 'siege', homeName: 'Siege (2010)', members: [],
        ai: { home: { verdict: 'agree', confidence: 'sure', why: 'The event\'s own series', open: true }, members: [], stale: false } },
      { id: 'aoa', name: 'Age of Apocalypse', year: 1995, confirmed: false, how: 'essential', why: 'Most main-story issues', home: 'gen', homeName: 'Generation Next (1995)',
        members: [{ id: 'tales', name: 'Tales from the Age of Apocalypse (1996)', role: 'tie-in', hidden: true }],
        ai: { home: { verdict: 'change', seriesId: 'ast', name: 'Astonishing X-Men (1995)', confidence: 'sure', why: 'The flagship during the event', open: true },
          members: [{ seriesId: 'tales', name: 'Tales from the Age of Apocalypse (1996)', action: 'remove', confidence: 'likely', why: 'Published after' }], stale: false } }] };
  const prev = global.fetch;
  global.fetch = vi.fn(async (url, opts = {}) => ({ ok: true, json: async () => {
    if (url === '/api/grouping') return summary;
    if (url === '/api/grouping/removed') return { items: [] };
    if (url === '/api/grouping/ai/apply') return { applied: 2, runId: 'run1' };
    return { ok: true };
  } }));
  const { host, root } = mount(<SeriesGroupingPanel />);
  const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
  const button = t => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === t);
  try {
    await tick();
    const rows = [...host.querySelectorAll('.gp-row')];
    expect(rows[0].textContent).toMatch(/Age of Apocalypse/);               // the AI disagrees: first
    expect(rows[0].querySelector('.gp-airow').textContent).toMatch(/AI suggests Astonishing X-Men \(1995\) · take off 1sureUse the AI's advice/);
    expect(rows[0].querySelector('.gp-ai-remove')).toBeTruthy();
    expect(rows[1].querySelector('.gp-airow').textContent).toMatch(/AI agrees/);
    expect(host.querySelector('.gp-ai-line').textContent).toMatch(/Asked about 1 events · Claude Sonnet 5.5/);
    await act(async () => { button('Use the AI\'s advice').click(); }); await tick();
    expect(global.fetch).toHaveBeenCalledWith('/api/grouping/ai/apply', expect.objectContaining({ body: JSON.stringify({ eventIds: ['aoa'] }) }));
    await act(async () => { button('✓ Apply 2 sure changes').click(); }); await tick();
    expect(host.querySelector('.gp-undo').textContent).toMatch(/Applied 2 changes from the AI/);
    await act(async () => { button('Undo').click(); }); await tick();
    expect(global.fetch).toHaveBeenCalledWith('/api/grouping/ai/runs/run1/undo', expect.objectContaining({ method: 'POST' }));
    await act(async () => { button('✦ Ask the AI').click(); }); await tick();
    expect(global.fetch).toHaveBeenCalledWith('/api/grouping/ai/ask', expect.objectContaining({ method: 'POST' }));
  } finally { act(() => root.unmount()); global.fetch = prev; }
});
