const test = require('node:test'), assert = require('node:assert/strict'), sharp = require('sharp');
const { prepareBrandingImage } = require('./brandingImage');
test('transparent padding is removed without losing faint visible edges or changing proportions', async () => {
  const input = await sharp({create:{width:200,height:100,channels:4,background:{r:0,g:0,b:0,alpha:0}}})
    .composite([{input:await sharp({create:{width:60,height:30,channels:4,background:{r:255,g:0,b:0,alpha:0.01}}}).png().toBuffer(),left:40,top:20}]).png().toBuffer();
  const meta = await sharp(await prepareBrandingImage(sharp,input)).metadata();
  assert.equal(meta.width,60); assert.equal(meta.height,30);
});
test('opaque backgrounds stay intact unless explicitly cropped; bad and empty crops fail', async () => {
  const input = await sharp({create:{width:200,height:100,channels:3,background:'#ffffff'}}).jpeg().toBuffer();
  let meta = await sharp(await prepareBrandingImage(sharp,input)).metadata();
  assert.equal(meta.width,200); assert.equal(meta.height,100);
  meta = await sharp(await prepareBrandingImage(sharp,input,{left:20,top:10,width:70,height:40})).metadata();
  assert.equal(meta.width,70); assert.equal(meta.height,40);
  for(const crop of [{left:-1,top:0,width:50,height:50},{left:190,top:0,width:50,height:50},{left:0,top:0,width:0,height:20},{left:0.5,top:0,width:10,height:10}])
    await assert.rejects(prepareBrandingImage(sharp,input,crop));
  const blank = await sharp({create:{width:10,height:10,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer();
  await assert.rejects(prepareBrandingImage(sharp,blank));
});
