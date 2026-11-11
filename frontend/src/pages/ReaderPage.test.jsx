import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import ReaderPage from './ReaderPage';
vi.mock('../App',()=>({InfoTip:()=>null,getToken:()=>''}));
vi.mock('../offlineStorage',()=>({isComicOffline:async()=>false,getOfflinePage:async()=>null}));
vi.mock('../components/AddToListModal', () => ({ default: ()=>null }));
vi.mock('../components/AssistantBubble', () => ({ default: ()=>null }));
vi.mock('../components/ReadingTheme',()=>({useReadingTheme:()=>({style:{}})}));
let root,host;
function Location(){return <output data-location="1">{useLocation().pathname+useLocation().search}</output>}
const key=async value=>act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:value})));
beforeEach(()=>{localStorage.clear();vi.useFakeTimers();global.IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement('div');document.body.append(host);root=createRoot(host);
 global.fetch=vi.fn(async url=>({ok:true,json:async()=>url.includes('/adjacent')?{
 prev:{id:'prev'},next:{id:'core',series_name:'Core',issue_number:2,tier:'essential'},nextAll:{id:'side',series_name:'Side',issue_number:1,tier:'tie-in'},nextEssential:{id:'core'},nextRecommended:{id:'core'},context:{kind:'event',id:'e',name:'Event',path:'essential',position:1,total:2,remainingOther:1}
 }:url.endsWith('/pages')?{count:1}:url.includes('/read-progress/')?{page:0,completed:true}:url.startsWith('/api/events/')?{issues:[]}:{id:'start',series_name:'Core',issue_number:1}}));
});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.useRealTimers()});
const mount=()=>act(async()=>root.render(<MemoryRouter initialEntries={['/read/start?eventId=e&minTier=essential']}><Location/><Routes><Route path="/read/:bookId" element={<ReaderPage/>}/><Route path="/events/:id" element={<div>Event</div>}/></Routes></MemoryRouter>));
test('reader request and primary next keep selected tier',async()=>{
 await mount();expect(fetch.mock.calls.some(([u])=>u==='/api/books/start/adjacent?eventId=e&minTier=essential')).toBe(true);
 await key('ArrowRight');expect(host.querySelector('.next-panel').textContent).toContain('Core #2');
 await act(async()=>host.querySelector('.next-panel').click());await act(async()=>vi.advanceTimersByTime(350));
 expect(host.querySelector('output').textContent).toBe('/read/core?eventId=e&minTier=essential');
});
test('end-card detour and return to event preserve tier',async()=>{
 await mount();await key('ArrowRight');await act(async()=>host.querySelector('.route').click());await act(async()=>vi.advanceTimersByTime(350));
 expect(host.querySelector('output').textContent).toBe('/read/side?eventId=e&minTier=essential');
 await key('ArrowRight');await act(async()=>host.querySelector('footer .secondary').click());
 expect(host.querySelector('output').textContent).toBe('/events/e?minTier=essential');
});
test('previous-issue navigation keeps tier',async()=>{
 await mount();await key('ArrowLeft');expect(host.querySelector('output').textContent).toBe('/read/prev?eventId=e&minTier=essential');
});
// Swipes on an Android tablet (2026-11-06): Chrome's "desktop site" reports visualViewport.scale
// above 1 with no pinch, which counted as zoomed and blocked every swipe; and 15% of a wide
// screen asked for a ~190px sweep. A 150px swipe now turns the page; a real pinch-zoom still doesn't.
const swipe=async(el,dx)=>act(async()=>{
 const fire=(type,x)=>{const e=new Event(type,{bubbles:true,cancelable:true});const t=[{clientX:x,clientY:400,target:el}];
  Object.defineProperty(e,'touches',{value:type==='touchend'?[]:t});Object.defineProperty(e,'changedTouches',{value:t});el.dispatchEvent(e);};
 fire('touchstart',700);fire('touchend',700+dx);
});
test('swipe turns the page on a wide tablet in desktop-site mode, not while pinch-zoomed',async()=>{
 const fetch0=global.fetch;global.fetch=vi.fn(async url=>url.endsWith('/pages')?{ok:true,json:async()=>({count:3})}:fetch0(url));
 const width=window.innerWidth;window.innerWidth=1280;window.visualViewport={scale:1.3,width:1280,height:800};
 try{
  await mount();
  const page=()=>host.querySelector('img[alt^="Page"]')?.getAttribute('alt');
  expect(page()).toBe('Page 1');
  await swipe(host.querySelector('img[alt^="Page"]'),-150);await act(async()=>vi.advanceTimersByTime(400));
  expect(page()).toBe('Page 2');
  window.visualViewport={scale:2.6,width:640,height:400};   // pinched in: panning, not turning
  await swipe(host.querySelector('img[alt^="Page"]'),-150);await act(async()=>vi.advanceTimersByTime(400));
  expect(page()).toBe('Page 2');
 }finally{window.innerWidth=width;delete window.visualViewport;}
});
