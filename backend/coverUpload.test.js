'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PassThrough,Readable}=require('node:stream');
const {readCover}=require('./coverUpload');
function request(chunks,headers={}){const req=Readable.from(chunks);req.headers={'content-type':'image/png',...headers};return req;}
test('bounded cover reader accepts supported images',async()=>{
  const result=await readCover(request([Buffer.from('image')]),5);assert.equal(result.body.toString(),'image');assert.equal(result.ext,'.png');
});
test('declared and chunked oversized uploads reject with 413',async()=>{
  await assert.rejects(readCover(request([] ,{'content-length':'100'}),5),{status:413});
  await assert.rejects(readCover(request([Buffer.alloc(3),Buffer.alloc(3)]),5),{status:413});
});
test('empty, unsupported and interrupted uploads cannot replace covers',async()=>{
  await assert.rejects(readCover(request([])),{status:400});
  await assert.rejects(readCover(request([] ,{'content-type':'text/html'})),{status:415});
  const req=new PassThrough();req.headers={'content-type':'image/jpeg'};const pending=readCover(req);req.emit('aborted');req.end();await assert.rejects(pending,{status:400});
});
