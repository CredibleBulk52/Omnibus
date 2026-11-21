import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import IssueCardMenu from './IssueCardMenu';
import ReadingOrderActions from './ReadingOrderActions';

vi.mock('../App', async () => ({ ...(await vi.importActual('../App')), isAdmin: () => false, getUser: () => ({ id: 'u1' }) }));

let host, root, calls;
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  calls = [];
  global.fetch = vi.fn(async (url, opts = {}) => {
    calls.push([url, opts.method || 'GET', opts.body ? JSON.parse(opts.body) : null]);
    const json = url.startsWith('/api/reading-lists?') ? { lists: [{ id: 9, name: 'Batman journey', visibility: 'private' }] } : { ok: true };
    return { ok: true, status: 200, json: async () => json, headers: { get: () => 'application/json' } };
  });
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.querySelectorAll('.scm-panel').forEach(n => n.remove()); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const item = text => [...document.querySelectorAll('.scm-panel button')].find(b => b.textContent === text);

test('issue ⋮: an unread issue offers Mark as read; it marks that one issue and tells the page', async () => {
  const onChanged = vi.fn();
  act(() => root.render(<MemoryRouter><IssueCardMenu bookId="b7" label="Saga #7" read={false} onChanged={onChanged} /></MemoryRouter>));
  await act(async () => host.querySelector('.scm-toggle').click());
  expect(item('↺ Mark as unread')).toBeFalsy();
  await act(async () => item('✓ Mark as read').click()); await flush();
  expect(calls.at(-1)).toEqual(['/api/books/batch/mark-read', 'POST', { bookIds: ['b7'], completed: true }]);
  expect(onChanged).toHaveBeenCalledWith(true);
  expect(document.querySelector('.scm-panel')).toBeNull();
});

test('issue ⋮: a read issue offers Mark as unread; Add to a reading order opens the dialog for that issue', async () => {
  act(() => root.render(<MemoryRouter><IssueCardMenu bookId="b7" label="Saga #7" read onChanged={() => {}} /></MemoryRouter>));
  await act(async () => host.querySelector('.scm-toggle').click());
  expect(item('✓ Mark as read')).toBeFalsy();
  await act(async () => item('+ Add to a reading order').click()); await flush();
  expect(document.body.textContent).toContain('Add this issue to a reading order.');
});

test('event and run pages: the editor is behind Manage; + Add to a box stays in view', async () => {
  const onEdit = vi.fn();
  act(() => root.render(<ReadingOrderActions name="Blackest Night" onAdd={() => {}} onEdit={onEdit} />));
  expect([...host.querySelectorAll('button')].map(b => b.textContent)).toEqual(['+ Add to a box', 'Manage ⌄']);
  await act(async () => host.querySelector('.manage-menu-toggle').click());
  await act(async () => [...document.querySelectorAll('.manage-menu-panel button')].find(b => b.textContent === '✎ Open Editor').click());
  expect(onEdit).toHaveBeenCalled();
});

test('issue ⋮ placement (admins): shows where the book is, pins it after an issue, to the shelf, or back to automatic', async () => {
  const onSet = vi.fn(async () => {});
  const placement = { status: 'In Issues after #37 · release week', pinned: false, mode: null, current: 'w37',
    regular: [{ id: 'w36', number: '36' }, { id: 'w37', number: '37' }, { id: 'w38', number: '38' }], onSet };
  act(() => root.render(<MemoryRouter><IssueCardMenu bookId="ann" label="Wonder Woman 2026 Annual #1" read={false} placement={placement} /></MemoryRouter>));
  await act(async () => host.querySelector('.scm-toggle').click());
  expect(document.querySelector('.scm-panel').textContent).toContain('In Issues after #37 · release week');
  expect(item('⟲ Automatic placement')).toBeFalsy();                       // nothing pinned yet
  await act(async () => item('▭ Show on shelf only').click()); await flush();
  expect(onSet).toHaveBeenLastCalledWith({ mode: 'shelf' });
  await act(async () => host.querySelector('.scm-toggle').click());
  await act(async () => item('↳ Read after…').click()); await flush();
  const select = document.querySelector('.rl-modal select');
  expect(select.value).toBe('w37');
  await act(async () => { select.value = 'w36'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => [...document.querySelectorAll('.rl-modal button')].find(b => b.textContent === 'Save').click()); await flush();
  expect(onSet).toHaveBeenLastCalledWith({ mode: 'after', anchorBookId: 'w36' });
  expect(document.querySelector('.rl-modal')).toBeNull();
  act(() => root.render(<MemoryRouter><IssueCardMenu bookId="ann" label="x" placement={{ ...placement, pinned: true, mode: 'shelf' }} /></MemoryRouter>));
  await act(async () => host.querySelector('.scm-toggle').click());
  expect(item('▭ Show on shelf only')).toBeFalsy();
  await act(async () => item('⟲ Automatic placement').click()); await flush();
  expect(onSet).toHaveBeenLastCalledWith(null);
});

test('issue ⋮ without placement (readers, other pages): no placement items', async () => {
  act(() => root.render(<MemoryRouter><IssueCardMenu bookId="b7" label="Saga #7" read={false} onChanged={() => {}} /></MemoryRouter>));
  await act(async () => host.querySelector('.scm-toggle').click());
  expect(item('↳ Read after…')).toBeFalsy();
});
