import test from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_PALETTE, sampleSeriesPalette } from '../src/themes/seriesPalette.mjs';

function cover(pixel) {
  const data = new Uint8ClampedArray(100 * 100 * 4);
  for (let y=0;y<100;y++) for(let x=0;x<100;x++) data.set(pixel(x,y),(y*100+x)*4);
  return data;
}
test('separates olive artwork, smaller blue title area, and ivory paper',()=>{
  const pixels=cover((x,y)=> y<30 ? (x>25&&x<85&&y>8&&y<23?[80,105,165,255]:[245,244,226,255]) : [150,155,90,255]);
  const palette=sampleSeriesPalette(pixels,100,100);
  assert.equal(palette.main,'#969b5a');
  assert.equal(palette.secondary,'#5069a5');
  assert.equal(palette.highlight,'#f5f4e2');
});
test('corner publisher colors do not replace contrasting title colors',()=>{
  const pixels=cover((x,y)=>y<30?(x<15?[220,30,35,255]:x>30&&x<90&&y>8?[70,100,180,255]:[245,244,226,255]):[150,155,90,255]);
  assert.equal(sampleSeriesPalette(pixels,100,100).secondary,'#4664b4');
});
test('monochrome, transparent, and malformed input have a stable neutral fallback',()=>{
  assert.deepEqual(sampleSeriesPalette(cover(()=>[255,255,255,255]),100,100),FALLBACK_PALETTE);
  assert.deepEqual(sampleSeriesPalette(cover(()=>[220,30,35,0]),100,100),FALLBACK_PALETTE);
  assert.deepEqual(sampleSeriesPalette([],10,10),FALLBACK_PALETTE);
});
