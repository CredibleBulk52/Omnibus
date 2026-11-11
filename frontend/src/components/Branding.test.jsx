import ComicInkTitle from './ComicInkTitle';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {act} from 'react-dom/test-utils';
import {PublisherLogo,CharacterSymbol,brandingKey,assetFor,refreshBranding} from './Branding';
let host,root;
beforeEach(()=>{global.IS_REACT_ACT_ENVIRONMENT=true;localStorage.setItem('omnibus_token',Math.random().toString());host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);URL.createObjectURL=vi.fn(()=>'blob:artwork');URL.revokeObjectURL=vi.fn();});
afterEach(()=>{act(()=>root.unmount());host.remove();});
test('publisher matching uses canonical names and explicit aliases',()=>{expect(brandingKey('publisher','DC Comics')).toBe('dc');expect(assetFor([{kind:'publisher',key:'dc',aliases:['detective']}],'publisher','Detective Comics').key).toBe('dc');});
test('missing artwork retains publisher text and reserves no symbol space',async()=>{global.fetch=vi.fn(async()=>({ok:true,json:async()=>[]}));await act(async()=>{root.render(<><PublisherLogo name="DC Comics"/><CharacterSymbol title="Superman"/></>);});expect(host.textContent).toBe('DC Comics');expect(host.querySelector('img')).toBeNull();});
test('shared symbols resolve by identity, mixed titles stay empty and removal restores text',async()=>{
 let assets=[{kind:'publisher',key:'dc',version:'1',aliases:[],scale:1},{kind:'character',key:'green lantern',version:'2',aliases:[],scale:1}];
 global.fetch=vi.fn(async url=>url==='/api/branding'?{ok:true,json:async()=>assets}:{ok:true,blob:async()=>new Blob(['png'])});
 await act(async()=>{root.render(<><PublisherLogo name="DC Comics"/><CharacterSymbol title="Hal Jordan: The Renegade"/><CharacterSymbol title="John Stewart: The Builder"/><CharacterSymbol title="Superman and Batman"/></>);});
 expect(host.querySelectorAll('img')).toHaveLength(3);expect(host.querySelector('img').alt).toBe('DC Comics');expect(fetch.mock.calls.filter(([url])=>url.includes('/character/'))).toHaveLength(1);
 await act(async()=>{assets=[];await refreshBranding();});expect(host.querySelectorAll('img')).toHaveLength(0);expect(host.textContent).toBe('DC Comics');
});

test('hero emblem precedes the title and subtitle without an empty wrapper when absent',async()=>{
 global.fetch=vi.fn(async url=>url==='/api/branding'?{ok:true,json:async()=>[{kind:'character',key:'superman',version:'title',aliases:[],scale:1}]}:{ok:true,blob:async()=>new Blob(['png'])});
 await act(async()=>root.render(<ComicInkTitle title="Superman: The Man of Tomorrow" emblem={<CharacterSymbol title="Superman"/>}/>));
 const title=host.querySelector('h1');expect(title.firstElementChild.className).toBe('brand-character');expect(title.children[1].className).toBe('csh-title-face');expect(title.children[2].className).toBe('csh-subtitle');
 await act(async()=>root.render(<ComicInkTitle title="An unmatched title" emblem={<CharacterSymbol title="An unmatched title"/>}/>));expect(host.querySelector('h1').firstElementChild.className).toBe('csh-title-face');
});
test('publisher shape follows loaded image dimensions and resets for replacement artwork',async()=>{
 let assets=[{kind:'publisher',key:'dc',version:'square',aliases:[],scale:1}];
 global.fetch=vi.fn(async url=>url==='/api/branding'?{ok:true,json:async()=>assets}:{ok:true,blob:async()=>new Blob(['png'])});
 await act(async()=>root.render(<PublisherLogo name="DC" size="hero"/>));
 let img=host.querySelector('img');
 Object.defineProperty(img,'naturalWidth',{configurable:true,value:100});
 Object.defineProperty(img,'naturalHeight',{configurable:true,value:100});
 await act(async()=>img.dispatchEvent(new Event('load')));
 expect(img.dataset.shape).toBe('compact');
 await act(async()=>{assets=[{...assets[0],version:'wide'}];await refreshBranding();});
 img=host.querySelector('img');
 expect(img.dataset.shape).toBeUndefined();
 Object.defineProperty(img,'naturalWidth',{configurable:true,value:300});
 Object.defineProperty(img,'naturalHeight',{configurable:true,value:100});
 await act(async()=>img.dispatchEvent(new Event('load')));
 expect(img.dataset.shape).toBe('wide');
});
