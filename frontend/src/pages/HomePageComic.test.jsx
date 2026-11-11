import React from 'react';
import {createRoot} from 'react-dom/client';
import {act} from 'react-dom/test-utils';
import {MemoryRouter} from 'react-router-dom';
import HomePage from './HomePageComic';
vi.mock('../App',()=>({useLibrary:()=>({activeLibrary:null,libraries:[]}),isAdmin:()=>false}));
vi.mock('../components/PageHeader', () => ({ default: ({children,title})=><header>{title}{children}</header> }));
vi.mock('../components/HomeFeatures',()=>({__esModule:true,default:()=> <div>Curated destinations</div>,ReleasePanel:()=>null}));
vi.mock('../components/CoverSizeControl',()=>({__esModule:true,default:()=>null,useCoverSize:()=>({width:150})}));
let host,root;
beforeEach(()=>{global.IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);window.matchMedia=()=>({matches:false});const data={stats:{},inProgress:[{id:'a',seriesId:'s',seriesName:'A series',page:4,pagesCount:20},{id:'b',fromEvent:true,eventId:7,eventName:'A crossover'}]};global.fetch=vi.fn(async url=>({ok:true,json:async()=>url.includes('/discover')?{}:data}));});
afterEach(()=>{act(()=>root.unmount());host.remove();});
test('continue reading retains per-issue progress and event dismissal restrictions',async()=>{await act(async()=>root.render(<MemoryRouter><HomePage/></MemoryRouter>));expect(host.textContent).toContain('Page 4 of 20');expect(host.textContent).toContain('A crossover');expect(host.querySelectorAll('.home-book-dismiss')).toHaveLength(1);act(()=>host.querySelector('.home-book-dismiss').click());const hide=[...host.querySelectorAll('button')].find(b=>b.textContent==='Hide');await act(async()=>hide.click());expect(fetch).toHaveBeenCalledWith('/api/home/continue-reading/dismiss',expect.objectContaining({body:JSON.stringify({seriesId:'s'})}));expect(host.textContent).toContain('A crossover');expect(host.textContent).not.toContain('A series');});
test('clear progress still marks only the shown issue unread',async()=>{await act(async()=>root.render(<MemoryRouter><HomePage/></MemoryRouter>));act(()=>host.querySelector('.home-book-dismiss').click());await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Clear progress').click());expect(fetch).toHaveBeenCalledWith('/api/books/batch/mark-read',expect.objectContaining({body:JSON.stringify({bookIds:['a'],completed:false})}));});

test('live home response supplies visible progress, series link, and native wheel scrolling',async()=>{await act(async()=>root.render(<MemoryRouter><HomePage/></MemoryRouter>));expect(host.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('20');expect(host.querySelector('.hp-series-link').getAttribute('href')).toBe('/series/s');expect(host.querySelector('.hp-read-action').getAttribute('href')).toBe('/read/a');expect(host.querySelector('.hp-read-action').textContent).toContain('Resume');const wheel=new WheelEvent('wheel',{deltaY:120,bubbles:true,cancelable:true});host.querySelector('.home-shelf-track').dispatchEvent(wheel);expect(wheel.defaultPrevented).toBe(false);});

test('event / run / list cards: next issue in that order, read link keeps the context, hide sends the context key',async()=>{
  const data={stats:{},inProgress:[{id:'gl0',seriesId:'gl',seriesName:'Green Lantern',issue_number:'0',page:0,fromContext:{key:'event:zh',kind:'event',id:'zh',name:'Zero Hour',label:'Event',to:'/events/zh',readQs:'?eventId=zh&minTier=all',position:2,total:3,read:1}}]};
  global.fetch=vi.fn(async url=>({ok:true,json:async()=>url.includes('/discover')?{}:data}));
  await act(async()=>root.render(<MemoryRouter><HomePage/></MemoryRouter>));
  expect(host.textContent).toContain('Zero Hour');expect(host.textContent).toContain('Next: Green Lantern #0');expect(host.textContent).toContain('Event · 1 of 3 read');
  expect(host.querySelector('.hp-read-action').getAttribute('href')).toBe('/read/gl0?eventId=zh&minTier=all');
  expect(host.querySelector('.hp-series-link').getAttribute('href')).toBe('/events/zh');
  await act(async()=>host.querySelector('.home-book-dismiss').click());
  expect(fetch).toHaveBeenCalledWith('/api/home/continue-reading/dismiss',expect.objectContaining({body:JSON.stringify({context:'event:zh'})}));
  expect(host.textContent).not.toContain('Zero Hour');
});
