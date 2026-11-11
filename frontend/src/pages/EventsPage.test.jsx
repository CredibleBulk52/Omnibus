import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import EventsPage from './EventsPage';

vi.mock('../App', () => ({ useLibrary: () => ({}), getToken: () => '', InfoTip: () => null, isAdmin: () => false }));
vi.mock('../components/PageStats', () => ({ default: () => null }));

beforeEach(() => localStorage.clear());

// The Comic timeline shows every tier (the tier toggles were removed); updated 2026-10-26.
const typeInto = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

test('timeline preserves API narrative order across tiers and filtering', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  // API order: year, saved position, then name for ties.
  const events = [
    { id: 'a', year: 2000, sort_order: 0, name: 'Alpha', event_tier: 3 },
    { id: 'b', year: 2000, sort_order: 0, name: 'Beta', event_tier: 2 },
    { id: 'c', year: 2000, sort_order: 10, name: 'Crisis', event_tier: 1 },
    { id: 'd', year: 2001, sort_order: 0, name: 'Later', event_tier: 1 },
  ];
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => events }));
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const titles = () => [...host.querySelectorAll('.chron-card h2')].map(e => e.textContent);
  try {
    await act(async () => root.render(<MemoryRouter><EventsPage /></MemoryRouter>));
    expect(titles()).toEqual(['Alpha', 'Beta', 'Crisis', 'Later']);
    await act(async () => typeInto(host.querySelector('input[aria-label="Find an event"]'), 'a'));
    expect(titles()).toEqual(['Alpha', 'Beta', 'Later']);
  } finally { act(() => root.unmount()); host.remove(); }
});

test('timeline filters restore on remount and Reset clears the saved filters', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => [{ id: 'a', name: 'Alpha', year: 2000, event_tier: 1 }, { id: 'b', name: 'Beta', year: 2000, event_tier: 2 }] }));
  const host = document.createElement('div'); document.body.append(host); let root = createRoot(host);
  const mount = () => act(async () => root.render(<MemoryRouter><EventsPage /></MemoryRouter>));
  try {
    await mount();
    await act(async () => typeInto(host.querySelector('input[aria-label="Find an event"]'), 'beta'));
    act(() => root.unmount()); root = createRoot(host); await mount();
    expect(host.querySelector('input[aria-label="Find an event"]').value).toBe('beta');
    expect(host.querySelectorAll('.chron-card h2')).toHaveLength(1);
    await act(async () => host.querySelector('.chron-reset').click());
    act(() => root.unmount()); root = createRoot(host); await mount();
    expect(host.querySelectorAll('.chron-card h2')).toHaveLength(2);
  } finally { act(() => root.unmount()); host.remove(); }
});

// Publisher filter (2026-10-26): one button per publisher; "DC Comics" and "DC" are one.
test('timeline publisher filter shows one publisher at a time; events without a publisher always show', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => [
    { id: 'a', name: 'Crisis', year: 1985, event_tier: 1, publisher: 'DC Comics' },
    { id: 'b', name: 'Secret Wars', year: 1984, event_tier: 1, publisher: 'Marvel Comics' },
    { id: 'c', name: 'Inferno', year: 1989, event_tier: 2, publisher: 'Marvel comics' },
    { id: 'd', name: 'Unfiled', year: 1990, event_tier: 3 },
  ] }));
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const titles = () => [...host.querySelectorAll('.chron-card h2')].map(e => e.textContent).sort();
  const pubs = () => [...host.querySelectorAll('.chron-pubs button')];
  try {
    await act(async () => root.render(<MemoryRouter><EventsPage /></MemoryRouter>));
    expect(pubs().map(b => b.firstChild.textContent)).toEqual(['All', 'Marvel', 'DC']);
    expect(titles()).toEqual(['Crisis', 'Inferno', 'Secret Wars', 'Unfiled']);
    await act(async () => pubs()[1].click());
    expect(pubs()[1].getAttribute('aria-pressed')).toBe('true');
    expect(titles()).toEqual(['Inferno', 'Secret Wars', 'Unfiled']);
    await act(async () => host.querySelector('.chron-reset').click());
    expect(titles()).toHaveLength(4);
  } finally { act(() => root.unmount()); host.remove(); }
});
