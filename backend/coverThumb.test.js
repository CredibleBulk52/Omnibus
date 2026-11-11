'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { coverThumb, COVER_THUMB_HEIGHT } = require('./coverThumb');

test('a large cover becomes a 720 px tall JPEG; a wraparound keeps its width ratio', async () => {
  const big = await sharp({ create: { width: 1988, height: 3056, channels: 3, background: '#c33' } }).png().toBuffer();
  const t = await coverThumb(big, '.png');
  const meta = await sharp(t.buf).metadata();
  assert.equal(t.ext, '.jpg'); assert.equal(t.mime, 'image/jpeg');
  assert.equal(meta.format, 'jpeg'); assert.equal(meta.height, COVER_THUMB_HEIGHT);
  assert.ok(t.buf.length < big.length / 5, `${t.buf.length} vs ${big.length}`);
  const wrap = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#33c' } }).jpeg().toBuffer();
  const w = await sharp((await coverThumb(wrap, '.jpg')).buf).metadata();
  assert.deepEqual([w.width, w.height], [960, 720]);
});

test('a small cover is not enlarged; something that is not an image is kept as it was', async () => {
  const small = await sharp({ create: { width: 300, height: 450, channels: 3, background: '#3c3' } }).jpeg().toBuffer();
  assert.equal((await sharp((await coverThumb(small, '.jpg')).buf).metadata()).height, 450);
  const junk = Buffer.from('not an image');
  const t = await coverThumb(junk, '.PNG');
  assert.equal(t.buf, junk); assert.equal(t.ext, '.png'); assert.equal(t.mime, 'image/png');
});
