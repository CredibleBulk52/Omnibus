import React from 'react';
import {createRoot} from 'react-dom/client';
import {act} from 'react-dom/test-utils';
import PageHeader from './PageHeader';
import {getMotifLayout} from './ThemeMotif';
import {PRESETS,setAppearance,clearAppearance} from './appearance';

test('every theme keeps artwork decorative and preserves heading and controls when disabled',()=>{
 global.IS_REACT_ACT_ENVIRONMENT=true;
 const host=document.createElement('div'),root=createRoot(host);
 try{
  for(const p of PRESETS){
   act(()=>{setAppearance({colors:p.colors,themeId:p.id,decorations:true},{save:false});root.render(<PageHeader title="Library"><button>Find a comic</button></PageHeader>);});
   expect(host.querySelector('.theme-motif').dataset.motif).toBe(p.id);
   expect(host.querySelector('.theme-motif').getAttribute('aria-hidden')).toBe('true');
   expect(host.querySelector('h1').textContent).toBe('Library');
   expect(host.querySelector('button').textContent).toBe('Find a comic');
  }
  act(()=>setAppearance({decorations:false},{save:false}));
  expect(host.querySelector('.theme-motif')).toBeNull();
  expect(host.querySelector('h1')).not.toBeNull();
 }finally{act(()=>{root.unmount();clearAppearance();});}
});

test('centering reserves title and stats space, including offset headers and absent stats',()=>{
 const header={left:80,width:1600,height:72},title={right:500,top:20},actions={left:1400,top:20};
 const a=getMotifLayout(header,title,actions);
 expect(a.visible).toBe(true);
 expect(a.left+header.left).toBeGreaterThan(title.right);
 expect(a.left+a.width+header.left).toBeLessThan(actions.left);
 expect(a.left+a.width/2+header.left).toBe(950);
 expect(getMotifLayout(header,title,null).visible).toBe(true);
 expect(getMotifLayout(header,{right:1300,top:20},actions).visible).toBe(false);
 expect(getMotifLayout(header,title,{left:1400,top:80}).visible).toBe(false);
 expect(getMotifLayout({left:0,width:390,height:72},{right:180,top:0},null).visible).toBe(false);
});

test('measured headers reposition for new counts and suppress art on phones without moving controls',()=>{
 global.IS_REACT_ACT_ENVIRONMENT=true;
 const previous=global.ResizeObserver,callbacks=[],disconnect=vi.fn();
 global.ResizeObserver=class{constructor(fn){callbacks.push(fn);}observe(){}disconnect(){disconnect();}};
 const host=document.createElement('div'),root=createRoot(host);
 try{
  act(()=>{setAppearance({themeId:'superman',decorations:true},{save:false});root.render(<PageHeader title="Library"><button>Counts</button></PageHeader>);});
  const header=host.querySelector('.page-header'),title=host.querySelector('h1'),actions=host.querySelector('.page-header-actions'),svg=host.querySelector('.theme-motif');
  header.getBoundingClientRect=()=>({left:0,width:1600,height:72});
  title.getBoundingClientRect=()=>({right:400,top:20});
  actions.getBoundingClientRect=()=>({left:1400,top:20});
  act(()=>callbacks.forEach(fn=>fn()));
  expect(svg.style.display).toBe('block');
  expect(svg.style.left).toBe('424px');
  expect(svg.style.width).toBe('952px');
  actions.getBoundingClientRect=()=>({left:1100,top:20});
  act(()=>callbacks.forEach(fn=>fn()));
  expect(svg.style.width).toBe('652px');
  header.getBoundingClientRect=()=>({left:0,width:390,height:100});
  act(()=>callbacks.forEach(fn=>fn()));
  expect(svg.style.display).toBe('none');
  expect(host.querySelector('button').textContent).toBe('Counts');
 }finally{act(()=>{root.unmount();clearAppearance();});global.ResizeObserver=previous;}
 expect(disconnect).toHaveBeenCalled();
});
