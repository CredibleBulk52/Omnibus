import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';

// jsdom has no layout: scrollTo stops at `limit` (the page's height), and the
// test grows the page by changing `limit` and firing the fake ResizeObserver.
let limit = Infinity, y = 0, grow = [];
beforeEach(() => {
  limit = Infinity; y = 0; grow = [];
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y });
  window.scrollTo = vi.fn((_x, to) => { y = Math.min(to, limit); window.dispatchEvent(new Event('scroll')); });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => setTimeout(cb, 0));
  window.ResizeObserver = class { constructor(cb) { grow.push(cb); } observe() {} disconnect() {} };
});

let nav, ScrollMemory;
beforeEach(async () => { vi.resetModules(); sessionStorage.clear(); ({ ScrollMemory } = await import('./scrollMemory')); });
function Grab() { nav = useNavigate(); return null; }
let host, root;
beforeEach(() => { global.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const app = () => act(() => root.render(
  <MemoryRouter initialEntries={['/events']}>
    <ScrollMemory /><Grab />
    <Routes><Route path="*" element={<div />} /></Routes>
  </MemoryRouter>,
));
const scrollTo = to => act(() => { y = to; window.dispatchEvent(new Event('scroll')); });
const tick = () => act(async () => { await new Promise(r => setTimeout(r, 5)); });

test('a new page opens at the top; Back returns to the saved place once the page is tall enough', async () => {
  app();
  scrollTo(3000);
  act(() => nav('/events/8'));
  expect(y).toBe(0);                     // the event opens at the top
  scrollTo(500);
  limit = 111;                           // the timeline is still loading on Back: a short page
  act(() => nav(-1));
  await tick();
  expect(y).toBe(111);                   // held at the bottom of the short page, still waiting
  limit = Infinity;                      // the events arrive; the page grows
  act(() => grow.at(-1)());
  await tick();
  expect(y).toBe(3000);
  act(() => nav(1));                     // Forward: the event where it was left
  await tick();
  expect(y).toBe(500);
});

test('scrolling during the wait stops it; a query change on the same page keeps the place', async () => {
  app();
  scrollTo(2000);
  act(() => nav('/series/5'));
  limit = 300;
  act(() => nav(-1));
  await tick();
  act(() => window.dispatchEvent(new Event('wheel')));   // the reader scrolls
  limit = Infinity;
  act(() => grow.at(-1)());
  await tick();
  expect(y).toBe(300);                   // not pulled back down
  scrollTo(1200);
  act(() => nav('/events?pub=marvel'));
  expect(y).toBe(1200);
});
