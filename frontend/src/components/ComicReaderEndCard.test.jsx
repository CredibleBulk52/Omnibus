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
