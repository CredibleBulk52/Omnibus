import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import SelectionSetup from './SelectionSetup';

let root, host;
beforeEach(() => { global.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

// The shape backend/ai/selectionSetup.js sends for a character.
const form = (values = {}) => ({
  version: 2, kind: 'character', subject: 'Hal Jordan', saved: [{ type: 'event', id: 'ev-bn', name: 'Blackest Night' }], values,
  fields: [
    { key: 'format', title: 'What should I make?', choices: [['box', 'A box of series', ''], ['order', 'A reading order', '']] },
    { key: 'availability', title: 'Which series?', only: 'box', choices: [['library', 'Only series in Omnibus', ''], ['missing', 'Include missing', '']] },
    { key: 'priority', title: 'What matters most to you?', only: 'order', choices: [['best', 'Best stories', ''], ['journey', 'Character journey', 'Follow Hal Jordan.']] },
    { key: 'start', title: 'Where should it begin?', only: 'order', choices: [['origins', 'From the beginning', ''], ['specific', 'A particular era or story', '']] },
  ],
});
const click = value => act(() => host.querySelector(`input[value="${value}"]`).click());
const submitBtn = () => host.querySelector('button[type=submit]');
const submit = () => act(() => host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

test('no defaults; the order questions appear only for a reading order; one click builds with the request attached', () => {
  const onSubmit = vi.fn();
  act(() => root.render(<SelectionSetup setup={form()} onSubmit={onSubmit} onCancel={() => {}} />));
  expect(submitBtn().disabled).toBe(true);
  expect(host.textContent).not.toContain('What matters most');
  click('order');
  expect(host.textContent).toContain('What matters most');
  expect(host.textContent).not.toContain('Which series?');
  click('journey'); expect(submitBtn().disabled).toBe(true);
  click('specific'); expect(submitBtn().disabled).toBe(true);          // the era is required
  act(() => { const i = host.querySelector('input:not([type=radio])'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Rebirth'); i.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(submitBtn().textContent).toBe('Build the reading order');
  submit();
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'character', subject: 'Hal Jordan', format: 'order', priority: 'journey', start: 'specific', startDetail: 'Rebirth', saved: [{ type: 'event', id: 'ev-bn', name: 'Blackest Night' }] }));
});

test('a box asks only which series; a format the reader named is preselected; cancel never submits', () => {
  const onSubmit = vi.fn(), onCancel = vi.fn();
  act(() => root.render(<SelectionSetup setup={form({ format: 'box' })} onSubmit={onSubmit} onCancel={onCancel} />));
  expect(host.querySelector('input[value=box]').checked).toBe(true);
  expect(host.textContent).toContain('Which series?');
  expect(host.textContent).not.toContain('Where should it begin?');
  click('library');
  expect(submitBtn().textContent).toBe('Build the box');
  act(() => [...host.querySelectorAll('button')].find(b => b.textContent === 'Cancel').click());
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onSubmit).not.toHaveBeenCalled();
});

// ── The box preview under his answer (AssistantBubble) ──
import { ProposedBox } from './AssistantBubble';
const box = { name: 'Cosmic Horror', series: [{ id: 's1', label: 'Uzumaki' }, { id: 's2', label: 'Harrow County' }] };
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

test('box preview: a failed series add retries into the same box; a saved box is remembered, never saved twice', async () => {
  const calls = []; let failOnce = true;
  global.fetch = vi.fn(async (url, opts) => {
    calls.push([opts.method, url]);
    if (url.endsWith('/series') && JSON.parse(opts.body).seriesId === 's2' && failOnce) { failOnce = false; return { ok: false, status: 500, json: async () => ({ error: 'boom' }) }; }
    return { ok: true, status: 200, json: async () => (url === '/api/collections' ? { id: 'col_9' } : { success: true }) };
  });
  const onSaved = vi.fn();
  act(() => root.render(<ProposedBox box={box} onGo={() => {}} onSaved={onSaved} />));
  const btn = () => [...host.querySelectorAll('button')].at(-1);
  await act(async () => btn().click()); await flush();
  expect(host.textContent).toContain('Retry adding series');
  await act(async () => btn().click()); await flush();
  expect(calls.filter(([m, u]) => m === 'POST' && u === '/api/collections').length).toBe(1);
  expect(onSaved).toHaveBeenCalledWith('col_9');
  expect(btn().textContent).toBe('Open my box →');
  // After a reload the message carries saved_id: nothing to save.
  act(() => root.render(<ProposedBox box={{ ...box, saved_id: 'col_9' }} onGo={() => {}} onSaved={onSaved} />));
  expect(btn().textContent).toBe('Open my box →');
});

test('box preview: series not in Omnibus are listed and saved as placeholders with the box', async () => {
  const calls = [];
  global.fetch = vi.fn(async (url, opts) => { calls.push([opts.method, url, opts.body ? JSON.parse(opts.body) : null]); return { ok: true, status: 200, json: async () => (url === '/api/collections' ? { id: 'col_5' } : { success: true }) }; });
  const missing = [{ name: 'Harrow County', start_year: 2015, publisher: 'Dark Horse', reason: 'Southern gothic.' }];
  act(() => root.render(<ProposedBox box={{ ...box, missing }} onGo={() => {}} />));
  expect(host.querySelector('.cbg-box-counts').textContent).toBe('2 in Omnibus1 to find');
  expect(host.querySelector('.cbg-box-missing li').textContent).toBe('Harrow County2015 · Dark Horse');
  expect(host.querySelectorAll('.cbg-box-covers img')[0].getAttribute('src')).toBe('/api/series/s1/thumbnail');
  await act(async () => [...host.querySelectorAll('button')].at(-1).click()); await flush();
  expect(calls.at(-1)).toEqual(['POST', '/api/collections/col_5/missing', { items: missing }]);
});
