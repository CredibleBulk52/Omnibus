import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import BackLink from './BackLink';
import { pageName } from './navTrail';

let mockPrevious = null;
vi.mock('./navTrail', async () => ({ ...(await vi.importActual('./navTrail')), previousPage: () => mockPrevious }));

let host, root;
beforeEach(() => { global.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

function Where() { const l = useLocation(); return <output>{l.pathname + (l.key === 'prev' ? ' (back)' : '')}</output>; }
const render = (el, entries = [{ pathname: '/prev-page', key: 'prev' }, '/here']) => act(async () => root.render(
  <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
    <Routes><Route path="/here" element={el} /><Route path="*" element={<Where />} /></Routes>
  </MemoryRouter>));
const click = () => act(async () => host.querySelector('.back-link').click());

test('page names for the places a back button leads', () => {
  expect(pageName('/events')).toBe('Timeline');
  expect(pageName('/canon/run/12')).toBe('Top Shelf run');
  expect(pageName('/canon/award_winning')).toBe('Top Shelf');
  expect(pageName('/collections/abc')).toBe('Comic Box');
  expect(pageName('/settings')).toBe('Back');
});

test('catalog mode: goes back only when the previous page was the catalog', async () => {
  mockPrevious = { path: '/events' };
  await render(<BackLink to="/events" label="Timeline" />, [{ pathname: '/events', key: 'prev' }, '/here']);
  expect(host.textContent).toContain('Timeline');
  await click();
  expect(host.querySelector('output').textContent).toBe('/events (back)');
});

test('catalog mode: from anywhere else it opens the catalog fresh', async () => {
  mockPrevious = { path: '/series/9' };
  await render(<BackLink to="/events" label="Timeline" />, [{ pathname: '/series/9', key: 'prev' }, '/here']);
  await click();
  expect(host.querySelector('output').textContent).toBe('/events');
});

test('follow mode names the previous page and goes back to it', async () => {
  mockPrevious = { path: '/collections/abc' };
  await render(<BackLink follow to="/series" label="Series" />, [{ pathname: '/collections/abc', key: 'prev' }, '/here']);
  expect(host.textContent).toContain('Comic Box');
  await click();
  expect(host.querySelector('output').textContent).toBe('/collections/abc (back)');
});

test('follow mode with no earlier page falls back to its catalog', async () => {
  mockPrevious = null;
  await render(<BackLink follow to="/series" label="Series" />, ['/here']);
  expect(host.textContent).toContain('Series');
  await click();
  expect(host.querySelector('output').textContent).toBe('/series');
});
