import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import ListEditor from './ListEditor';

vi.mock('../../App', () => ({ isAdmin: () => false }));
let root, host, adapter;
const row = (key, label) => ({ key, id: key, type: 'issue', label, note: '', total: 1, owned: 1 });
beforeEach(() => {
 global.IS_REACT_ACT_ENVIRONMENT = true;
 localStorage.clear();
 window.innerWidth = 390;
 host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
 adapter = { kind: 'list', noun: 'list', caps: { reorder: true, notes: true },
  load: vi.fn(async () => ({ title: 'Test reading order', subtitle: 'Reading list', version: 1, rows: [row('a','First issue'), row('b','Second issue')] })),
  buildSave: vi.fn(rows => ({ rows })), save: vi.fn(async () => ({})) };
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = () => act(async () => root.render(<MemoryRouter><ListEditor adapter={adapter} id="test" backTo="/reading-lists/test" /></MemoryRouter>));
const click = el => act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const button = label => [...host.querySelectorAll('button')].find(b => b.textContent === label);

test('phone editor supports menu reordering without writing until Save', async () => {
 await render();
 expect(host.querySelectorAll('.le-item')).toHaveLength(2);
 click(host.querySelector('.le-more'));
 expect(button('Move up').disabled).toBe(true);
 click(button('Move down'));
 expect([...host.querySelectorAll('.le-label')].map(x => x.textContent)).toEqual(['Second issue','First issue']);
 expect(adapter.save).not.toHaveBeenCalled();
 await act(async () => button('Save').click());
 expect(adapter.save).toHaveBeenCalledWith('test', expect.objectContaining({ rows: expect.arrayContaining([expect.objectContaining({ key: 'a' })]) }));
 expect(adapter.buildSave.mock.calls[0][0].map(r => r.key)).toEqual(['b','a']);
});

test('failed save retains the reordered draft and shows an error', async () => {
 adapter.save.mockRejectedValue(new Error('Offline'));
 await render(); click(host.querySelector('.le-more')); click(button('Move down'));
 await act(async () => button('Save').click());
 expect(host.textContent).toContain('Save failed: Offline');
 expect(JSON.parse(localStorage.getItem('omnibus.listEditor.list.test')).rows[0].key).toBe('b');
 expect(button('Save').disabled).toBe(false);
});

test('fixed-order adapters do not gain reordering controls', async () => {
 adapter.caps.reorder = false;
 await render(); click(host.querySelector('.le-more'));
 expect(button('Move up')).toBeUndefined();
 expect(button('Move down')).toBeUndefined();
});

test('a range still fetching its issues takes them in when they arrive; a doubled period is not shown', async () => {
 vi.useFakeTimers();
 try {
  const kid = n => ({ key: 'li' + n, liId: n, label: `#${n}`, issue: { id: n } });
  const range = (pending, kids) => ({ key: 'r', id: 'r', type: 'range', label: 'Range', note: '', total: kids.length, owned: 0, pending, children: kids.map(kid), childrenOrig: kids });
  adapter.load.mockResolvedValueOnce({ title: 'T', version: 1, rows: [row('a', 'First issue'), range(true, [3, 4])] })
   .mockResolvedValue({ title: 'T', version: 1, rows: [row('a', 'First issue'), range(false, [3, 4, 5])] });
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  expect(adapter.load).toHaveBeenCalledTimes(2);
  expect(button('Save').disabled).toBe(true);                       // taking the fetched issues in is not a change
  adapter.save.mockRejectedValue(new Error('Out of step. Reload the editor.'));
  click(host.querySelector('.le-more')); click(button('Move down'));
  await act(async () => button('Save').click());
  expect(adapter.buildSave.mock.calls[0][0].find(r => r.key === 'r').children.map(c => c.key)).toEqual(['li3', 'li4', 'li5']);
  expect(host.textContent).toContain('Reload the editor. Your draft is kept.');
 } finally { vi.useRealTimers(); }
});

test('an owned issue can be picked as the cover (adapters with coverPick); it saves with the details', async () => {
 adapter.kind = 'event'; adapter.matchTarget = () => null;
 adapter.coverPick = { field: 'cover_issue_id', label: 'Timeline cover' };
 adapter.fields = () => [];
 adapter.summary = () => '';
 const issue = (id, owned) => ({ key: 'i' + id, id, type: 'issue', label: `Issue ${id}`, note: '', total: 1, owned: owned ? 1 : 0, single: { id, owned, book_id: owned ? 'b' + id : null } });
 adapter.load.mockResolvedValue({ title: 'Event', version: 1, rows: [issue(1, true), issue(2, false)], details: { name: 'Event', cover_issue_id: null } });
 await render();
 const moreOf = n => host.querySelectorAll('.le-more')[n];
 click(moreOf(1));
 expect(button('Use as Timeline cover')).toBeUndefined();          // not in the library: nothing to show
 click(moreOf(0));
 click(button('Use as Timeline cover'));
 expect(host.textContent).toContain('Timeline cover');
 await act(async () => button('Save').click());
 expect(adapter.save.mock.calls[0][1].details).toEqual({ cover_issue_id: 1 });
});
