import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import RunReadingPanel from './RunReadingPanel';
import ReadingOrderActions from './ReadingOrderActions';
import { runReadingState, runReadUrl } from './runReading';
vi.mock('./ReadingTheme', () => ({ useReadingTheme: () => ({ style: {} }) }));
const issue = (id, progress, owned = true) => ({ id, issue_number: id, series_name: 'Batman', scanned_book_id: owned ? `book-${id}` : null, media: { pagesCount: 24 }, readProgress: progress });
let root, host;
beforeEach(() => { global.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = node => act(() => root.render(node));
test('resume prefers unfinished progress, then fills earlier unread gaps', () => {
 const rows = [issue(0), issue(1,{completed:true,page:23}), issue(2,{completed:false,page:5}), issue(3,null,false)];
 expect(runReadingState(rows).current.id).toBe(2);
 rows[2].readProgress.completed = true;
 expect(runReadingState(rows).current.id).toBe(0);
});
test('completion distinguishes missing issues and never offers an unavailable issue', () => {
 const state = runReadingState([issue(1,{completed:true,page:23}),issue(2,null,false)]);
 expect(state.completed).toBe(false);
 expect(state.ownedCompleted).toBe(true);
 render(<RunReadingPanel state={state} onRead={() => {}} />);
 expect(host.textContent).toContain('Owned issues finished');
 expect(host.textContent).toContain('1 missing');
 render(<RunReadingPanel state={runReadingState([issue(2,null,false)])} onRead={() => {}} />);
 expect(host.querySelector('button')).toBeNull();
});
test('rereading uses first owned issue, explicit restart and retains run context', () => {
 const rows = [issue(0,{completed:true,page:23}),issue(1,{completed:true,page:23})];
 const read = vi.fn(); render(<RunReadingPanel state={runReadingState(rows)} onRead={read} />);
 expect(host.textContent).toContain('Run complete');
 act(() => host.querySelector('button').click());
 expect(read).toHaveBeenCalledWith(rows[0], true);
 expect(runReadUrl(9,rows[0],true)).toBe('/read/book-0?canonRunId=9&restart=1');
});
test('resume shows human page number and preserves issue zero', () => {
 const rows = [issue(0,{completed:false,page:5})];
 render(<RunReadingPanel state={runReadingState(rows)} onRead={() => {}} />);
 expect(host.textContent).toContain('Batman #0');
 expect(host.textContent).toContain('Page 6 of 24');
 expect(host.querySelector('[aria-label="Current issue reading progress"]').getAttribute('aria-valuenow')).toBe('6');
});
test('utility actions only expose editor when the caller supplies permission', () => {
 const add = vi.fn(), edit = vi.fn();
 render(<ReadingOrderActions name="Batman" onAdd={add} />);
 expect(host.querySelectorAll('button')).toHaveLength(1);
 act(() => host.querySelector('button').click()); expect(add).toHaveBeenCalledTimes(1);
 render(<ReadingOrderActions name="Batman" onAdd={add} onEdit={edit} />);
 act(() => host.querySelectorAll('button')[1].click());   // Manage ⌄ (2026-11-04: the editor is behind it)
 act(() => [...document.querySelectorAll('.manage-menu-panel button')].find(b => b.textContent === '✎ Open Editor').click()); expect(edit).toHaveBeenCalledTimes(1);
});

test.each(['event', 'list'])('%s completion uses its own labels and keeps the exact issue target', kind => {
 const first = issue(180, { completed: true, page: 23 });
 const read = vi.fn();
 render(<RunReadingPanel kind={kind} state={runReadingState([first])} onRead={read} />);
 expect(host.textContent).toContain(`Reread ${kind}`);
 expect(host.textContent).toContain('Batman #180');
 act(() => host.querySelector('button').click());
 expect(read).toHaveBeenCalledWith(first, true);
 expect(host.textContent).not.toContain('Run complete');
});
