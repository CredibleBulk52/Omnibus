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

test('the AI line: Ask (after showing its cost), its view on a row, Use the AI\'s advice, and Apply sure changes with Undo', async () => {
  const { SeriesGroupingPanel } = await import('./SeriesShelf');
  const summary = { counts: { rule: { links: 2, hidden: 1 } }, ai: { asked: 1, ready: 2, model: 'Claude Sonnet 5.5', auto: false, running: null, lastApplied: null, outdated: { events: 1, series: 0 } },
    events: [
      { id: 'ok', name: 'Siege', year: 2010, confirmed: false, how: 'name', why: 'Named like the event · 2010', home: 'siege', homeName: 'Siege (2010)', members: [{ id: 'emb', name: 'Siege: Embedded (2010)', role: 'tie-in', hidden: true }],
        ai: { home: { verdict: 'agree', confidence: 'sure', why: 'The event\'s own series', open: true }, members: [], stale: false } },
      { id: 'aoa', name: 'Age of Apocalypse', year: 1995, confirmed: false, how: 'essential', why: 'Most main-story issues', home: 'gen', homeName: 'Generation Next (1995)',
        members: [{ id: 'tales', name: 'Tales from the Age of Apocalypse (1996)', role: 'tie-in', hidden: true }],
        ai: { home: { verdict: 'change', seriesId: 'ast', name: 'Astonishing X-Men (1995)', confidence: 'sure', why: 'The flagship during the event', open: true },
          members: [{ seriesId: 'tales', name: 'Tales from the Age of Apocalypse (1996)', action: 'remove', confidence: 'likely', why: 'Published after' }], stale: false } },
      { id: 'ghosts', name: 'Ghosts', year: 1998, confirmed: false, how: 'essential', why: 'Most main-story issues', home: 'gl', homeName: 'Green Lantern (1990)', members: [] }] };   // nothing on its shelf: not in To check
  const prev = global.fetch;
  global.fetch = vi.fn(async (url, opts = {}) => ({ ok: true, json: async () => {
    if (url === '/api/grouping') return summary;
    if (url === '/api/grouping/removed') return { items: [] };
    if (url === '/api/grouping/ai/apply') return { applied: 2, runId: 'run1' };
    if (url === '/api/grouping/ai/estimate') return JSON.parse(opts.body).scopes[0] === 'new'
      ? { new: { scope: 'new', events: 1, series: 4, calls: 2, model: 'Claude Sonnet 5.5', local: false } }
      : { suggested: { scope: 'suggested', events: 1, series: 0, calls: 1, local: false }, all: { scope: 'all', events: 0, series: 0, calls: 0, local: false } };
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
    expect(rows.length).toBe(2);
    expect(host.querySelector('.gp-ai-line').textContent).toMatch(/Asked about 1 events and 0 series · Claude Sonnet 5.5/);
    await act(async () => { button('Use the AI\'s advice').click(); }); await tick();
    expect(global.fetch).toHaveBeenCalledWith('/api/grouping/ai/apply', expect.objectContaining({ body: JSON.stringify({ eventIds: ['aoa'] }) }));
    await act(async () => { button('✓ Apply 2 sure changes').click(); }); await tick();
    expect(host.querySelector('.gp-undo').textContent).toMatch(/Applied 2 changes from the AI/);
    await act(async () => { button('Undo').click(); }); await tick();
    expect(global.fetch).toHaveBeenCalledWith('/api/grouping/ai/runs/run1/undo', expect.objectContaining({ method: 'POST' }));
    expect(host.querySelector('.gp-outdated').textContent).toMatch(/1 suggestion came from another model or an older prompt · Ask again/);
    await act(async () => { button('✦ Ask the AI').click(); }); await tick();
    expect(global.fetch).not.toHaveBeenCalledWith('/api/grouping/ai/ask', expect.anything());   // nothing runs before the go
    const card = host.querySelector('.gp-pending');
    expect(card.textContent).toMatch(/✦ Ask the AI · Claude Sonnet 5.5New and changed: 1 event and 4 series · 2 AI calls/);
    await act(async () => { card.querySelector('.adm-btn').click(); }); await tick();
    expect(global.fetch).toHaveBeenCalledWith('/api/grouping/ai/ask', expect.objectContaining({ body: JSON.stringify({ kinds: ['event', 'series'], scope: 'new' }) }));
    expect(host.querySelector('.gp-pending')).toBeNull();
    // Review the events again: only the choices with something to ask about.
    await act(async () => { button('Review the events again…').click(); }); await tick();
    expect([...host.querySelectorAll('.gp-pending .adm-btn')].map(b => b.textContent)).toEqual(['Open suggestions only: 1 event · 1 AI call']);
    await act(async () => { button('Cancel').click(); });
    expect(host.querySelector('.gp-pending')).toBeNull();
  } finally { act(() => root.unmount()); global.fetch = prev; }
});

test('Minis & one-shots: suggested homes as two covers; Shelve and Not this one, each with Undo', async () => {
  const { SeriesGroupingPanel } = await import('./SeriesShelf');
  const summary = { counts: { rule: { links: 1, hidden: 1 }, ai: { links: 1, hidden: 1 } }, ai: { asked: 0, askedSeries: 3, ready: 1 }, events: [] };
  const minis = { suggested: [{ seriesId: 'wow', name: 'Black Panther: World of Wakanda (2016)', homeId: 'bp16', homeName: 'Black Panther (2016)', confidence: 'sure', why: 'Companion to that run' }],
    shelved: [{ seriesId: 'kh', name: 'Kraven Hunts (2020)', homeId: 'asm', homeName: 'The Amazing Spider-Man (2018)', why: 'A spin-off',
      rethink: { verdict: 'own', confidence: 'likely', why: 'A Kraven series in its own right' } }],
    counts: { own: 1, landmark: 1, none: 0, rethink: 1 }, toAsk: 5, asked: 3, ready: 1 };
  const prev = global.fetch;
  global.fetch = vi.fn(async url => ({ ok: true, json: async () => {
    if (url === '/api/grouping') return summary;
    if (url === '/api/grouping/series') return minis;
    if (url === '/api/grouping/removed') return { items: [] };
    if (url === '/api/grouping/ai/apply') return { applied: 1, runId: 'r9' };
    if (url === '/api/grouping/series/wow/decline') return { declined: true, previous: null };
    if (url === '/api/grouping/series/kh/keep') return { kept: true, previous: 'run3' };
    return { ok: true };
  } }));
  const { host, root } = mount(<SeriesGroupingPanel />);
  const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
  const button = t => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === t);
  try {
    await tick();
    expect(host.textContent).toMatch(/2 series on shelves · 2 out of the browser/);
    expect(host.querySelector('.gp-ai-line').textContent).toMatch(/Asked about 0 events and 3 series/);
    await act(async () => { [...host.querySelectorAll('[role=tab]')].find(b => /Minis & one-shots/.test(b.textContent)).click(); });
    const card = host.querySelector('.gp-mcard');
    expect(card.textContent).toMatch(/Black Panther: World of Wakanda \(2016\)→Black Panther \(2016\)sureCompanion to that run/);
    expect(host.querySelector('.gp-subtabs').textContent).toMatch(/1 own series · 1 landmarks · 0 no fitting home · 5 not asked yet/);
    await act(async () => { button('✓ Shelve').click(); }); await tick();
    expect(global.fetch).toHaveBeenCalledWith('/api/grouping/ai/apply', expect.objectContaining({ body: JSON.stringify({ seriesIds: ['wow'] }) }));
    await act(async () => { button('Undo').click(); }); await tick();
    expect(global.fetch).toHaveBeenCalledWith('/api/grouping/ai/runs/r9/undo', expect.objectContaining({ method: 'POST' }));
    await act(async () => { button('Not this one').click(); }); await tick();
    await act(async () => { button('Undo').click(); }); await tick();
    expect(global.fetch).toHaveBeenCalledWith('/api/grouping/series/wow/undecline', expect.objectContaining({ body: JSON.stringify({ previous: null }) }));
    expect([...host.querySelectorAll('[role=tab]')].find(b => /Minis/.test(b.textContent)).textContent).toBe('Minis & one-shots 2');   // 1 suggested + 1 to recheck
    await act(async () => { button('Shelved by the AI 1 1 to recheck').click(); });
    expect(host.querySelector('.gp-mcard').textContent).toMatch(/AI now says: a series of its own/);
    await act(async () => { button('Keep it').click(); }); await tick();
    expect(host.querySelector('.gp-undo').textContent).toMatch(/Kraven Hunts \(2020\) stays on The Amazing Spider-Man \(2018\)'s shelf/);
    await act(async () => { button('Undo').click(); }); await tick();
    expect(global.fetch).toHaveBeenCalledWith('/api/grouping/series/kh/keep', expect.objectContaining({ body: JSON.stringify({ undo: true, previous: 'run3' }) }));
    await act(async () => { button('✕ Take it off').click(); }); await tick();
    expect(global.fetch).toHaveBeenCalledWith('/api/series/kh/shelf/asm', expect.objectContaining({ method: 'DELETE' }));
  } finally { act(() => root.unmount()); global.fetch = prev; }
});

test('with shelves off, the panel explains them and offers the switch', async () => {
  const { SeriesGroupingPanel } = await import('./SeriesShelf');
  const prev = global.fetch;
  global.fetch = vi.fn(async url => ({ ok: true, json: async () => (url === '/api/grouping' ? { enabled: false } : url === '/api/grouping/removed' ? { items: [] } : { ok: true }) }));
  const changed = vi.fn();
  window.addEventListener('omnibus:settings', changed);   // the series page's views follow the switch
  const { host, root } = mount(<SeriesGroupingPanel />);
  try {
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(host.textContent).toMatch(/Specials shelves are off\./);
    expect(host.textContent).toMatch(/Nothing on disk moves/);
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === 'Turn on Specials shelves').click(); });
    expect(global.fetch).toHaveBeenCalledWith('/api/grouping/enabled', expect.objectContaining({ body: JSON.stringify({ on: true }) }));
    expect(changed).toHaveBeenCalled();
  } finally { act(() => root.unmount()); global.fetch = prev; window.removeEventListener('omnibus:settings', changed); }
});
