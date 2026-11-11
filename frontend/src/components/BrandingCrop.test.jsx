import React from 'react';
import {createRoot} from 'react-dom/client';
import {act} from 'react-dom/test-utils';
import BrandingCrop from './BrandingCrop';
test('preview trims padding, allows reset, and only saves on explicit action', async()=>{
 global.IS_REACT_ACT_ENVIRONMENT=true;
 const OriginalImage=global.Image;
 const pixels=new Uint8ClampedArray(4*4*4); pixels[(1*4+1)*4+3]=255; pixels[(2*4+2)*4+3]=255;
 const context={drawImage:vi.fn(),getImageData:()=>({data:pixels})};
 const spy=vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(context);
 URL.createObjectURL=vi.fn(()=> 'blob:crop');URL.revokeObjectURL=vi.fn();
 global.Image=class {naturalWidth=4;naturalHeight=4;set src(v){this.onload();}};
 const host=document.createElement('div'),root=createRoot(host),save=vi.fn(),cancel=vi.fn();
 try{
 await act(async()=>root.render(<BrandingCrop file={new Blob(['png'])} onSave={save} onCancel={cancel}/>));
 expect(save).not.toHaveBeenCalled();
 const button=t=>[...host.querySelectorAll('button')].find(b=>b.textContent===t);
 await act(async()=>button('Save artwork').click());
 expect(save).toHaveBeenLastCalledWith({left:1,top:1,width:2,height:2});
 await act(async()=>button('Reset crop').click());
 await act(async()=>button('Save artwork').click());
 expect(save).toHaveBeenLastCalledWith({left:0,top:0,width:4,height:4});
 await act(async()=>button('Cancel').click());expect(cancel).toHaveBeenCalledTimes(1);
 }finally{act(()=>root.unmount());spy.mockRestore();global.Image=OriginalImage;}
});
