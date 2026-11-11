import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import Shelf from './ReadingListShelf';
let host, root, width, resized, disconnected;
const issues = Array.from({length: 10}, (_, n) => ({id:n+1, book_id:'book-'+n, issue_number:n+1, owned:n!==1, title:'Issue '+(n+1)}));
const onRead=vi.fn(), onMatch=vi.fn();
function Example() { const [expanded,setExpanded]=useState(false); return <Shelf issues={issues} current={issues[0]} expanded={expanded} onMore={()=>setExpanded(!expanded)} onRead={onRead} onMatch={onMatch} requests={{2:'open'}}/>; }
beforeEach(()=>{global.IS_REACT_ACT_ENVIRONMENT=true; width=600; disconnected=vi.fn(); global.ResizeObserver=class {constructor(cb){resized=cb;} observe(){} disconnect(){disconnected();}}; vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockImplementation(()=>width); host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.restoreAllMocks();delete global.ResizeObserver;});
test('opens and closes only the current shelf, preserving issue order and actions',()=>{
 act(()=>root.render(<Example/>));
 expect(host.querySelectorAll('.issue-book')).toHaveLength(2);
 expect(host.textContent).toContain('Requested');
 act(()=>host.querySelector('.issue-action-btn').click()); expect(onRead).toHaveBeenCalledWith(issues[0]);
 act(()=>host.querySelector('.rl-match-btn').click()); expect(onMatch).toHaveBeenCalledWith(issues[1]);
 act(()=>host.querySelector('.rl-shelf-more').click());
 expect(host.querySelectorAll('.issue-book')).toHaveLength(10);
 expect([...host.querySelectorAll('.issue-number')].map(x=>x.textContent)).toEqual(issues.map(x=>'#'+x.issue_number));
 expect(host.querySelector('.rl-more').getAttribute('aria-expanded')).toBe('true');
 act(()=>host.querySelector('.rl-more').click());expect(host.querySelectorAll('.issue-book')).toHaveLength(2);
});
test('remeasures width and puts More below a narrow shelf',()=>{
 act(()=>root.render(<Example/>));
 act(()=>{width=240;resized();});
 expect(host.querySelectorAll('.issue-book')).toHaveLength(1);
 expect(host.querySelector('.rl-shelf > .rl-shelf-more')).not.toBeNull();
 act(()=>{width=1200;resized();});expect(host.querySelectorAll('.issue-book')).toHaveLength(6);
 act(()=>root.unmount());expect(disconnected).toHaveBeenCalled(); root=createRoot(host);
});
