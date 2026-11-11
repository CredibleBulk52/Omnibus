import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import useBoxArtwork from './useBoxArtwork';
let root, host;
function Sample({src}) { const image=useBoxArtwork(src); return <span>{image || 'fallback'}</span>; }
beforeEach(()=>{global.IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);URL.createObjectURL=vi.fn(()=> 'blob:private-cover');URL.revokeObjectURL=vi.fn();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();});
it('loads protected artwork through fetch and releases its URL',async()=>{
 global.fetch=vi.fn(async()=>({ok:true,blob:async()=>new Blob(['image'])}));
 await act(async()=>root.render(<Sample src="/api/collections/box/cover?v=1"/>));
 expect(fetch).toHaveBeenCalledWith('/api/collections/box/cover?v=1',expect.objectContaining({signal:expect.any(AbortSignal)}));
 expect(host.textContent).toBe('blob:private-cover');
 await act(async()=>root.render(<Sample src="/pull-box-art.png"/>));
 expect(host.textContent).toBe('/pull-box-art.png');
 expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:private-cover');
});
it('uses fallback when access is denied',async()=>{
 global.fetch=vi.fn(async()=>({ok:false,status:403}));
 await act(async()=>root.render(<Sample src="/api/collections/private/cover"/>));
 expect(host.textContent).toBe('fallback');expect(URL.createObjectURL).not.toHaveBeenCalled();
});
