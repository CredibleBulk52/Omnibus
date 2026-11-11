import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import SeriesCardMenu from './SeriesCardMenu';
import { ConfirmProvider } from './Confirm';

vi.mock('../App', async () => ({ ...(await vi.importActual('../App')), isAdmin: () => false, getUser: () => ({ id: 'u1' }) }));

let host, root, calls, books;
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  calls = [];
  books = [{ id: 'b1', readProgress: { completed: true } }, { id: 'b2', readProgress: null }];
  global.fetch = vi.fn(async (url, opts = {}) => {
    calls.push([url, opts.method || 'GET', opts.body ? JSON.parse(opts.body) : null]);
    const json = url.includes('/books?includeAll') ? { content: books } : url.startsWith('/api/reading-lists?') ? { lists: [] } : url === '/api/collections' ? [] : { ok: true };
    return { ok: true, status: 200, json: async () => json, headers: { get: () => 'application/json' } };
  });
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.querySelectorAll('.scm-panel').forEach(n => n.remove()); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const render = props => act(() => root.render(<MemoryRouter><ConfirmProvider><SeriesCardMenu series={{ id: 's1' }} title="Saga" {...props} /></ConfirmProvider></MemoryRouter>));
const item = text => [...document.querySelectorAll('.scm-panel button')].find(b => b.textContent === text);

test('a partly read series offers both; Add to a box opens the box dialog; no Remove outside a box', async () => {
  render({});
  await act(async () => host.querySelector('.scm-toggle').click()); await flush();
  expect(calls[0][0]).toBe('/api/series/s1/books?includeAll=true');
  expect(item('✓ Mark as read')).toBeTruthy();
  expect(item('↺ Mark as unread')).toBeTruthy();
  expect(item('Remove from this box')).toBeFalsy();
  await act(async () => item('+ Add to a box').click()); await flush();
  expect(document.body.textContent).toContain('Add Saga to a box');
});

test('a fully read series offers only Mark as unread; marking asks first, then updates every issue', async () => {
  books = books.map(b => ({ ...b, readProgress: { completed: true } }));
  render({});
  await act(async () => host.querySelector('.scm-toggle').click()); await flush();
  expect(item('✓ Mark as read')).toBeFalsy();
  await act(async () => item('↺ Mark as unread').click()); await flush();
  const yes = [...document.querySelectorAll('button')].find(b => /Mark|Confirm|OK|Yes/i.test(b.textContent) && !b.closest('.scm-panel'));
  await act(async () => yes.click()); await flush();
  expect(calls.at(-1)).toEqual(['/api/books/batch/mark-read', 'POST', { bookIds: ['b1', 'b2'], completed: false }]);
});

test('on your own box: Remove from this box, after a confirmation', async () => {
  const onRemove = vi.fn();
  render({ onRemove });
  await act(async () => host.querySelector('.scm-toggle').click()); await flush();
  await act(async () => item('Remove from this box').click()); await flush();
  await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Remove').click()); await flush();
  expect(onRemove).toHaveBeenCalledWith({ id: 's1' });
});
