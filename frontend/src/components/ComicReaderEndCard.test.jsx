import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import ComicReaderEndCard, { endIssueLabel } from './ComicReaderEndCard';

vi.mock('./ReadingTheme', () => ({ useReadingTheme: () => ({ style: {} }) }));
let container, root;
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ issues: [] }) }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = async props => { await act(async () => root.render(<ComicReaderEndCard headline="Finished issue" {...props} />)); };
const click = element => act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));

test('event next and skip actions retain their exact issue targets', async () => {
  const next = { id: 'next', series_name: 'The Darkstars', issue_number: 24, tier: 'tie-in' };
  const rec = { id: 'recommended', series_name: 'Legion', issue_number: 61 };
  const essential = { id: 'essential', series_name: 'Zero Hour', issue_number: 0 };
  const onRead = vi.fn(), back = vi.fn();
  await render({ context: { kind: 'event', id: 'zero-hour', name: 'Zero Hour', position: 33, total: 46 }, next,
    nextRecommended: rec, nextEssential: essential, showRec: true, showEss: true, onRead, onBackContext: back });
  click(container.querySelector('.next-panel'));
  container.querySelectorAll('.route').forEach(click);
  expect(onRead.mock.calls.map(args => args[0])).toEqual([next, rec, essential]);
  click(container.querySelector('footer .secondary')); // Back to event lives in the footer.
  expect(back).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('33');
  expect(endIssueLabel(essential)).toBe('Zero Hour #0');
});

test('series card handles missing artwork, footer actions, and assistant visibility', async () => {
  const last = vi.fn(), series = vi.fn(), discuss = vi.fn();
  const props = { context: { kind: 'series', position: 23, total: 25 }, next: { id: '23', issue_number: 23, series_name: 'Absolute Batman' },
    onLastPage: last, onBackSeries: series, onDiscuss: discuss, assistant: { enabled: true, name: 'Comic Book Guy' } };
  await render(props);
  act(() => container.querySelector('img').dispatchEvent(new Event('error')));
  expect(container.querySelector('.issue-stamp').textContent).toContain('23');
  container.querySelectorAll('footer button').forEach(click);
  [last, series, discuss].forEach(fn => expect(fn).toHaveBeenCalledTimes(1));
  await render({ ...props, assistant: { enabled: false } });
  expect(container.querySelector('.discuss')).toBeNull();
  expect(container.querySelector('.position-line').textContent).toContain('Library position');
});

test('loading and end-of-route states do not expose stale next or skip actions', async () => {
  await render({ loading: true, next: { id: 'stale' }, showRec: true });
  expect(container.querySelector('[role="status"]')).not.toBeNull();
  expect(container.querySelector('.next-panel')).toBeNull();
  expect(container.querySelector('.alternatives')).toBeNull();
  await render({ context: { kind: 'list', name: 'My list' } });
  expect(container.querySelector('.end-none').textContent).toContain('last issue you own in this list');
});


test('selected path exposes one-time detours at the end without changing the primary action', async () => {
 const onRead=vi.fn();const extra={id:'optional',series_name:'After',issue_number:1};
 await render({completed:true,context:{kind:'event',id:'e',name:'Event',path:'essential'},next:null,
  alternatives:[{label:'Next issue of any tier',issue:extra}],endMessage:'Essential reading complete ✓',onRead});
 expect(container.textContent).toContain('Essential reading complete');expect(container.textContent).toContain('Reading path: Essential');
 expect(container.querySelector('.next-panel')).toBeNull();
 act(()=>container.querySelector('.route').click());expect(onRead).toHaveBeenCalledWith(extra);
});

test('series reading: the next issue shows the Timeline event it is part of; event reading does not repeat it', async () => {
  const next = { id: 'kt1', series_name: 'Knight Terrors: Wonder Woman', issue_number: 1, events: [{ id: 'kt', name: 'Knight Terrors' }, { id: 'x', name: 'Other' }] };
  await render({ context: { kind: 'series', id: 'ww', name: 'Wonder Woman', position: 1, total: 48 }, next, onRead: () => {} });
  const note = container.querySelector('.next-panel .next-event');
  expect(note.textContent).toContain('Part of Knight Terrors');
  expect(note.textContent).toContain('+1');
  await render({ context: { kind: 'series', id: 'ww', name: 'Wonder Woman' }, next: { ...next, events: [] }, onRead: () => {} });
  expect(container.querySelector('.next-event')).toBeNull();
  await render({ context: { kind: 'event', id: 'kt', name: 'Knight Terrors' }, next, onRead: () => {}, onBackContext: () => {} });
  expect(container.querySelector('.next-event')).toBeNull();
});

test('series reading: the event callout names the event, year and role, and opens the event at that issue', async () => {
  const next = { id: 'gl0', series_name: 'Green Lantern', issue_number: 0, events: [{ id: 'zh', name: 'Zero Hour', year: 1994, tier: 'tie-in', eventTier: 1 }] };
  const onEvent = vi.fn(), onRead = vi.fn();
  await render({ context: { kind: 'series', id: 'gl', name: 'Green Lantern' }, next, onRead, onEvent });
  const side = container.querySelector('.next-row.has-event .next-event-side');
  expect(side.textContent).toContain('Zero Hour');
  expect(side.querySelector('.nes-badge').textContent).toBe('★★★Crisis');   // the Timeline's tier badge
  expect(side.querySelector('.nes-role').textContent).toBe('Tie-in');
  expect(side.querySelector('.nes-meta').textContent).toContain('1994');
  click(side.querySelector('.nes-link'));
  expect(onEvent).toHaveBeenCalledWith(next.events[0], next);
  expect(onRead).not.toHaveBeenCalled();                       // the link is not the panel
  await render({ context: { kind: 'series', id: 'gl', name: 'Green Lantern' }, next, onRead });
  expect(container.querySelector('.nes-link')).toBeNull();      // no handler: no link
});

test('series reading: a crossover takes the right side over the event, reads its issue, and names a missing one', async () => {
  const next = { id: 'gl41', series_name: 'Green Lantern', issue_number: 41, events: [{ id: 'zh', name: 'Zero Hour', year: 1994, tier: 'tie-in' }] };
  const crossover = { id: 'glc22', series_name: 'Green Lantern Corps', issue_number: 22, story: 'First Light', owned: true };
  const onRead = vi.fn(), onEvent = vi.fn();
  await render({ context: { kind: 'series', id: 'gl', name: 'Green Lantern' }, next, crossover, onRead, onEvent });
  const row = container.querySelector('.next-row.has-side.has-crossover');
  expect(row.classList.contains('has-event')).toBe(false);          // the event shows as the panel's strip instead
  const side = row.querySelector('.next-crossover-side');
  expect(side.textContent).toContain('Story continues in');
  expect(side.textContent).toContain('Green Lantern Corps #22');
  expect(side.textContent).toContain('First Light');
  expect(row.querySelector('.next-panel .next-event').textContent).toContain('Part of Zero Hour');
  click(side.querySelector('.nes-link'));
  expect(onRead).toHaveBeenCalledWith(crossover);
  click(row.querySelector('.crossover-alt .route'));                 // the narrow cards' row
  expect(onRead).toHaveBeenLastCalledWith(crossover);
  await render({ context: { kind: 'series', id: 'gl', name: 'Green Lantern' }, next, crossover: { ...crossover, id: null, owned: false }, onRead });
  expect(container.querySelector('.nes-link')).toBeNull();
  expect(container.querySelector('.nes-missing').textContent).toBe('Not in your library yet');
  expect(container.querySelector('.crossover-alt button')).toBeNull();
  // The last issue of the series: the crossover is still offered.
  await render({ context: { kind: 'series', id: 'gl', name: 'Green Lantern' }, next: null, crossover, onRead });
  expect(container.querySelector('.end-none')).not.toBeNull();
  click(container.querySelector('.crossover-alt .route'));
  expect(onRead).toHaveBeenLastCalledWith(crossover);
  // Event reading follows the event's path: no crossover.
  await render({ context: { kind: 'event', id: 'zh', name: 'Zero Hour' }, next, crossover, onRead, onBackContext: () => {} });
  expect(container.querySelector('.crossover-alt')).toBeNull();
});

test('reading list and Top Shelf run: the footer goes back to the list or run, the series link sits by its name', async () => {
  for (const [kind, word] of [['list', 'list'], ['run', 'run']]) {
    const back = vi.fn(), series = vi.fn();
    await render({ context: { kind, id: '48', name: 'Hellblazer by Garth Ennis', position: 5, total: 49 }, next: { id: 'n', series_name: 'Hellblazer', issue_number: 46 },
      onBackContext: back, onBackSeries: series });
    const footer = container.querySelector('footer .secondary');
    expect(footer.textContent).toContain(`Back to ${word}`);
    click(footer);
    expect(back).toHaveBeenCalledTimes(1);
    const byName = container.querySelector('.event-context .quiet');
    expect(byName.textContent).toContain('Back to series');
    click(byName);
    expect(series).toHaveBeenCalledTimes(1);
  }
});
