import React from 'react';
import {createRoot} from 'react-dom/client';
import {act} from 'react-dom/test-utils';
import BoxDefaultArtwork from './BoxDefaultArtwork';
import {boxArtworkImages} from './boxArtwork';
const originalImages={...boxArtworkImages};
let host,root;
beforeEach(()=>{global.IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();Object.assign(boxArtworkImages,originalImages);});
test('unfilled image slots retain the complete live title without a broken image',()=>{
 boxArtworkImages.horror=null; boxArtworkImages.default=null;
 const title='Hal Jordan: The Renegade — A Very Long Reading Journey';
 act(()=>root.render(<BoxDefaultArtwork title={title} isOrder family="horror"/>));
 expect(host.querySelector('img')).toBeNull();
 expect(host.querySelector('.cbox-placeholder-name').textContent).toBe(title);
 expect(host.textContent).toContain('READING ORDER');
});
test('art is decorative and image failure preserves title and backing',()=>{
 boxArtworkImages.horror='/box-artwork/horror.webp';
 act(()=>root.render(<BoxDefaultArtwork title="Midnight Reads" family="horror"/>));
 expect(host.querySelector('img').alt).toBe('');
 act(()=>host.querySelector('img').dispatchEvent(new Event('error')));
 expect(host.querySelector('img')).toBeNull();
 expect(host.textContent).toContain('Midnight Reads');
});

test('all seven designs have versioned image assets',()=>{
 expect(Object.keys(boxArtworkImages)).toHaveLength(7);
 for(const src of Object.values(boxArtworkImages)) expect(src).toMatch(/^\/box-artwork\/[a-z]+-v1\.webp$/);
});
