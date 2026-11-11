import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import AiModelsSettings from './AiModelsSettings';
import AiUsage from './AiUsage';

const config = { top: { quick: 'claude-fast', generation: 'claude-deep' }, providers: [{id:'anthropic',label:'Anthropic',keySet:true},{id:'openai',label:'OpenAI',keySet:true,features:['web']}], tiers: {quick:{label:'Quick',note:'Quick tasks'},generation:{label:'Generation',note:'Long tasks'}}, tasks:[{id:'quick_answer',label:'Short answers',tier:'quick',pinned:'',default:'claude-fast',where:'Reader answers'},{id:'event',label:'Timeline event',tier:'generation',pinned:'claude-deep',default:'claude-deep',needs:['web'],where:'Event generation'}] };
const stats={jobs:10,cost:1,good_rate:90,cost_per_job:.1,median_ms:200,p90_ms:500};
const usage={total:stats,anthropic:stats,openai:stats,byTask:[{key:'answer',label:'Task report',anthropic:stats,openai:stats}],byTier:[{key:'fast',label:'Category report',anthropic:stats,openai:stats}],byModel:[{key:'fast',label:'Model report',all:stats}],daily:[{day:'2026-10-18',anthropic:1,openai:1}]};
let host,root;
beforeEach(()=>{global.IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement('div');document.body.append(host);root=createRoot(host);global.fetch=vi.fn(async url=>({ok:true,json:async()=>url.startsWith('/api/ai/models')?{models:[{id:'claude-fast',name:'Claude Fast',provider:'anthropic',family:'haiku',newest:true,input:1,output:2},{id:'claude-deep',name:'Claude Deep',provider:'anthropic',family:'sonnet',newest:true,input:2,output:3},{id:'openai:example',name:'Example',provider:'openai',tier:'luna',newest:true,input:1,output:2}]}:url.startsWith('/api/ai/usage')?usage:url.startsWith('/api/settings/test')?{ok:true,version:'test'}:config}));});
afterEach(()=>{act(()=>root.unmount());host.remove();});
const render=node=>act(async()=>root.render(node));
const change=(el,value)=>act(async()=>{el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));});
const type=(el,value)=>act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));});
test('compact: task models and trials save on their own, keys on their own',async()=>{
 await render(<AiModelsSettings compact />);
 expect(host.querySelector('.ai-task').textContent).toContain('Recommended');
 await change(host.querySelector('[aria-label="Short answers model"]'),'openai:example');
 await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent.includes('+ Trial split')).click());
 await change(host.querySelector('[aria-label="Short answers trial model"]'),'claude-fast');
 await change(host.querySelector('[aria-label="Short answers trial share"]'),'0.5');
 await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Save task models').click());
 const posts=()=>fetch.mock.calls.filter(([u,o])=>u==='/api/ai/settings'&&o?.method==='POST').map(([,o])=>JSON.parse(o.body));
 expect(posts()[0]).toEqual({tasks:{quick_answer:'openai:example',event:'claude-deep'},trials:{quick_answer:{model:'claude-fast',share:.5},event:null}});
 await type(host.querySelector('input[type="password"]'),'new-key');
 await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Save API keys').click());
 expect(posts()[1]).toEqual({anthropic_api_key:'new-key'});
 await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Test OpenAI').click());
 expect(fetch.mock.calls.some(([u])=>u.includes('/api/settings/test/anthropic?model=openai%3Aexample'))).toBe(true);
});
test('compact reports switch, real use is requested, and reset keeps confirmation',async()=>{
 await render(<AiUsage compact />);
 expect(host.textContent).toContain('Task report');expect(host.textContent).not.toContain('Category report');
 await change(host.querySelector('[aria-label="Usage report"]'),'tier');expect(host.textContent).toContain('Category report');
 expect(fetch).toHaveBeenCalledWith('/api/ai/usage?days=0&source=live');
 window.confirm=vi.fn(()=>false);
 await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Reset counts').click());
 expect(fetch.mock.calls.some(([u])=>u==='/api/ai/usage/reset')).toBe(false);
});
test('legacy retains expanded controls and reports',async()=>{
 await render(<AiModelsSettings />);
 expect(host.querySelector('.ai-settings-refined')).toBeNull();
 expect(host.textContent).toContain('Task models');expect(host.textContent).not.toContain('Top-level models');expect(host.textContent).toContain('Task report');expect(host.textContent).toContain('Category report');expect(host.textContent).toContain('Model report');
});
