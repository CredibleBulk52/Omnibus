import React from 'react';
import {createRoot} from 'react-dom/client';
import {act} from 'react-dom/test-utils';
import {BrandingEditor} from './BrandingSettings';
vi.mock('./BrandingCrop', () => ({ default: function Crop({onSave,onCancel}) {return <div><button onClick={()=>onSave({left:0,top:0,width:10,height:10})}>Save artwork</button><button onClick={onCancel}>Cancel crop</button></div>;} }));
const mockConfirm=vi.fn();
vi.mock('./Confirm',()=>({useConfirm:()=>mockConfirm}));
let root,host,assets;
beforeEach(()=>{global.IS_REACT_ACT_ENVIRONMENT=true;localStorage.setItem('omnibus_token',Math.random().toString());assets=[];host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);URL.createObjectURL=()=> 'blob:preview';URL.revokeObjectURL=()=>{};mockConfirm.mockResolvedValue(false);
 global.fetch=vi.fn(async(url,options)=>{if(options?.method==='PUT')return {ok:false,json:async()=>({error:'Upload failed. Original image retained.'})};if(url==='/api/branding')return {ok:true,json:async()=>assets};return {ok:true,blob:async()=>new Blob(['png'])};});});
afterEach(()=>{act(()=>root.unmount());host.remove();});
async function choose(file){const input=host.querySelector('input[type=file]');Object.defineProperty(input,'files',{configurable:true,value:[file]});await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));}
test('invalid files are rejected before uploading; server failures are visible and recoverable',async()=>{
 await act(async()=>root.render(<BrandingEditor kind="publisher" name="DC Comics"/>));expect(host.querySelector('details').open).toBe(false);
 await choose(new File(['x'],'logo.svg',{type:'image/svg+xml'}));expect(host.querySelector('[role=alert]').textContent).toContain('PNG or JPEG');expect(fetch.mock.calls.some(([,o])=>o?.method==='PUT')).toBe(false);
 await choose(new File(['png'],'logo.png',{type:'image/png'}));expect(fetch.mock.calls.some(([,o])=>o?.method==='PUT')).toBe(false);await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Save artwork').click());expect(host.querySelector('[role=alert]').textContent).toContain('Upload failed');expect(host.querySelector('input[type=file]').disabled).toBe(true);await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Cancel crop').click());expect(host.querySelector('input[type=file]').disabled).toBe(false);
});
test('removal cancellation preserves the shared artwork',async()=>{
 assets=[{kind:'publisher',key:'dc',aliases:[],scale:1,version:'x'}];
 await act(async()=>root.render(<BrandingEditor kind="publisher" name="DC Comics"/>));
 const remove=[...host.querySelectorAll('button')].find(b=>b.textContent==='Remove image');await act(async()=>remove.click());expect(mockConfirm).toHaveBeenCalled();expect(fetch.mock.calls.some(([,o])=>o?.method==='DELETE')).toBe(false);
});
