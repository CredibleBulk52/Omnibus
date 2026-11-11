import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import GenreRetag from './GenreRetag';

const status = over => ({ running: false, test: false, total: 0, done: 0, written: 0, changed: 0, noAnswer: 0, failed: 0, cost: 0,
  startedAt: null, finishedAt: null, stopped: false, error: null, results: [], pending: 2325, version: '2026-11',
  genres: [{ name: 'Superhero', definition: 'Costumed heroes.' }, { name: 'Kaiju', definition: 'Giant monsters.' }],
  estimate: { perSeries: 0.0000333, basis: 'last run' }, ...over });

let host, root, calls;
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  calls = [];
  global.fetch = vi.fn(async (url, opts = {}) => {
    calls.push([url, opts.method || 'GET', opts.body]);
    if (opts.method === 'POST') return { ok: true, json: async () => status({ test: true, total: 2, finishedAt: 'x', written: 1, changed: 1, noAnswer: 1, cost: 0.0004,
      results: [{ id: 'ss_1', name: 'Avengers', status: 'written', before: ['Superhero', 'Adventure'], after: ['Superhero', 'Team'] },
                { id: 'ss_2', name: 'Masks', status: 'no_answer', before: [], after: [] }] }) };
    return { ok: true, json: async () => status() };
  });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

test('shows what is left and the estimate; a test run shows each series before and after', async () => {
  await act(async () => root.render(<GenreRetag />));
  expect(host.textContent).toContain('2 genres (list 2026-11)');
  expect(host.textContent).toContain('2,325 series not yet tagged');
  expect(host.textContent).toContain('Retag all 2,325 (about 8¢)');
  const test = [...host.querySelectorAll('button')].find(b => b.textContent === 'Retag 30 (test)');
  await act(async () => test.click());
  expect(calls.at(-1)).toEqual(['/api/admin/genres/retag', 'POST', JSON.stringify({ test: true })]);
  expect(host.textContent).toContain('Done: 1 of 2 series written · 1 without an answer · 0.04¢');
  const rows = [...host.querySelectorAll('tbody tr')].map(tr => tr.textContent);
  expect(rows).toEqual(['AvengersSuperhero, AdventureSuperhero, Team', 'Masks—No answer, unchanged']);
});

test('a test can use Sonnet and can run again on the same series', async () => {
  global.fetch = vi.fn(async (url, opts = {}) => {
    calls.push([url, opts.method || 'GET', opts.body]);
    return { ok: true, json: async () => status({ lastTest: 30, testModels: ['sonnet'], ...(opts.method === 'POST' ? { test: true, again: true, model: 'claude-sonnet-5-5', finishedAt: 'x', total: 30, written: 30, changed: 12 } : {}) }) };
  });
  await act(async () => root.render(<GenreRetag />));
  await act(async () => { const sel = host.querySelector('select'); sel.value = 'sonnet'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Test the same 30 again').click());
  expect(JSON.parse(calls.at(-1)[2])).toEqual({ test: true, again: true, model: 'sonnet' });
  expect(host.textContent).toContain('Done: (test, same series, claude-sonnet-5-5) 30 of 30 series written');
});

test('Retag all can use Sonnet, with Sonnet\'s estimate', async () => {
  global.fetch = vi.fn(async (url, opts = {}) => {
    calls.push([url, opts.method || 'GET', opts.body]);
    return { ok: true, json: async () => status({ testModels: ['sonnet'], estimates: { sonnet: { perSeries: 0.00084, basis: 'last run' } } }) };
  });
  await act(async () => root.render(<GenreRetag />));
  await act(async () => { const sel = host.querySelector('select'); sel.value = 'sonnet'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
  const all = [...host.querySelectorAll('button')].find(b => b.textContent.startsWith('Retag all'));
  expect(all.textContent).toBe('Retag all 2,325 (about $1.96)');
  await act(async () => all.click());
  expect(JSON.parse(calls.at(-1)[2])).toEqual({ model: 'sonnet' });
});
