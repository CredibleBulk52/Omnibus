// Trim only fully transparent borders; opaque backgrounds require an explicit crop.
async function prepareBrandingImage(sharp, input, crop) {
  const processor = sharp(input, { limitInputPixels: 16000000, animated: false });
  const metadata = await processor.metadata();
  if (!['png', 'jpeg'].includes(metadata.format) || metadata.pages > 1) throw Error('Invalid image');
  const oriented = await processor.rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = oriented.info;
  let rect = { left: 0, top: 0, width, height };
  if (crop !== undefined) {
    if (!crop || !['left','top','width','height'].every(k => Number.isInteger(crop[k])) ||
        crop.left < 0 || crop.top < 0 || crop.width < 1 || crop.height < 1 ||
        crop.left + crop.width > width || crop.top + crop.height > height) throw Error('Invalid crop');
    rect = crop;
  }
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = rect.top; y < rect.top + rect.height; y++) {
    for (let x = rect.left; x < rect.left + rect.width; x++) {
      if (oriented.data[(y * width + x) * channels + channels - 1] !== 0) {
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
  }
  if (right < left) throw Error('Empty artwork');
  return sharp(oriented.data, { raw: oriented.info })
    .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
    .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
}
module.exports = { prepareBrandingImage };
