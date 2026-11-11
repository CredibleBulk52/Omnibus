import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import EventDetail from './EventDetail';
vi.mock('../App',()=>({InfoTip:()=>null,isAdmin:()=>false,useAppSettings:()=>({})}));
vi.mock('./EventsPage',()=>({TierBadge:()=>null}));
vi.mock('../components/ReadingTheme',()=>({useReadingTheme:()=>({style:{}})}));
vi.mock('../components/CoverHero',()=>({__esModule:true,default:({children})=>children,CoverStack:()=>null}));
vi.mock('../components/AddToListModal', () => ({ default: ()=>null }));
let mockPrevious=null;   // the page one step back, as the shared back button sees it
vi.mock('../components/navTrail',()=>({previousPage:()=>mockPrevious,pageName:()=>'Back',useNavTrail:()=>{}}));
const rows=[{id:1,scanned_book_id:'a',tier:'essential',series_name:'Core',issue_number:1,readProgress:{completed:true}},
{id:2,scanned_book_id:'b',tier:'recommended',series_name:'Side',issue_number:2,readProgress:{page:3}},
{id:3,scanned_book_id:'c',tier:'essential',series_name:'Core',issue_number:3},
{id:4,scanned_book_id:'d',tier:'aftermath',series_name:'After',issue_number:4}];
let root,host;
function Destination(){const l=useLocation();return <output>{l.pathname+l.search}</output>}
const mount=async (url='/events/a',issues=rows)=>{
 global.fetch=vi.fn(async()=>({json:async()=>({name:'Event',event_tier:2,issues})}));
 await act(async()=>root.render(<MemoryRouter initialEntries={[url]}><Routes><Route path="/events/:id" element={<EventDetail/>}/><Route path="/read/:bookId" element={<Destination/>}/></Routes></MemoryRouter>));
};
beforeEach(()=>{localStorage.clear();global.IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement('div');document.body.append(host);root=createRoot(host)});
afterEach(()=>{act(()=>root.unmount());host.remove()});
test('essential selection controls progress and continue URL while excluding in-progress side issue',async()=>{
 await mount();await act(async()=>[...host.querySelectorAll('.rl-seg button')].find(b=>b.textContent==='Essential 2').click());
 const panel=host.querySelector('aside');expect(panel.textContent).toContain('1 / 2 read');expect(panel.textContent).toContain('Core #3');expect(panel.textContent).not.toContain('Side #2');
 expect(host.textContent).toContain('Overall event');await act(async()=>panel.querySelector('.order-read-button').click());
 expect(host.textContent).toBe('/read/c?eventId=a&minTier=essential');
});
test('saved path survives a fresh mount and does not affect another event',async()=>{
 await mount();await act(async()=>host.querySelector('.rl-seg button').click());
 act(()=>root.unmount());root=createRoot(host);await mount();expect(host.querySelector('aside').textContent).toContain('1 / 2 read');
 act(()=>root.unmount());root=createRoot(host);await mount('/events/b');expect(host.querySelector('aside').textContent).toContain('1 / 4 read');
});
test('completed essential path offers reread without requiring optional issues',async()=>{
 await mount('/events/a?minTier=essential',rows.map(i=>i.id===3?{...i,readProgress:{completed:true}}:i));
 expect(host.querySelector('aside').textContent).toContain('Essential reading complete');
 await act(async()=>host.querySelector('.order-read-button').click());expect(host.textContent).toBe('/read/a?eventId=a&minTier=essential&restart=1');
});

// Back to the timeline (shared BackLink, 2026-10-26): when the page before this one was the
// timeline, "← Timeline" goes Back (the timeline keeps its place); otherwise it opens the timeline.
test('Timeline button goes back when the event was opened from the timeline', async () => {
  global.fetch=vi.fn(async()=>({json:async()=>({name:'Event',event_tier:2,issues:rows})}));
  function Timeline(){const l=useLocation();return <output>{'timeline '+(l.key==='back'?'back':'new')}</output>}
  const render=entries=>act(async()=>root.render(<MemoryRouter initialEntries={entries} initialIndex={entries.length-1}><Routes><Route path="/events/:id" element={<EventDetail/>}/><Route path="/events" element={<Timeline/>}/></Routes></MemoryRouter>));
  const click=()=>act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent.includes('Timeline')).click());
  mockPrevious={path:'/events'};
  await render([{pathname:'/events',key:'back'},{pathname:'/events/a'}]);
  await click();
  expect(host.querySelector('output').textContent).toBe('timeline back');
  act(()=>root.unmount());root=createRoot(host);
  mockPrevious=null;
  await render(['/events/a']);
  await click();
  expect(host.querySelector('output').textContent).toBe('timeline new');
});
