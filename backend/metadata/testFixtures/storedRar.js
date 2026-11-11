'use strict';
// TEST DATA ONLY: minimal stored RAR5, no compressor/production dependency.
// Layout: https://www.rarlab.com/technote.htm
function vint(value) {
  const bytes = [];
  do { const next = value & 127; value = Math.floor(value / 128); bytes.push(next | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(4); result.writeUInt32LE((crc ^ 0xffffffff) >>> 0); return result;
}
function block(header, data = Buffer.alloc(0)) {
  const checked = Buffer.concat([vint(header.length), header]);
  return Buffer.concat([crc32(checked), checked, data]);
}
function storedRar(entries) {
  const blocks = [Buffer.from('526172211a070100', 'hex'), block(Buffer.from([1, 0, 0]))];
  for (const [name, value] of entries) {
    const filename = Buffer.from(name, 'utf8');
    // RAR5 redirection extra record: tests only, no production archive parser.
    if (value && !Buffer.isBuffer(value) && typeof value === 'object' && value.link) {
      const { type, target, directory = false } = value.link;
      if (![1, 4].includes(type) || typeof target !== 'string') throw new TypeError('Unsupported test link');
      const destination = Buffer.from(target, 'utf8');
      const record = Buffer.concat([vint(5), vint(type), vint(directory ? 1 : 0), vint(destination.length), destination]);
      const extra = Buffer.concat([vint(record.length), record]);
      const header = Buffer.concat([vint(2), vint(3), vint(extra.length), vint(0), vint(4), vint(0),
        vint(type === 1 ? 0o120777 : 0o100644), crc32(Buffer.alloc(0)), vint(0), vint(1), vint(filename.length), filename, extra]);
      blocks.push(block(header));
      continue;
    }
    const data = Buffer.from(value);
    const header = Buffer.concat([Buffer.from([2, 2]), vint(data.length), Buffer.from([4]), vint(data.length),
      Buffer.from([0]), crc32(data), Buffer.from([0, 0]), vint(filename.length), filename]);
    blocks.push(block(header, data));
  }
  blocks.push(block(Buffer.from([5, 0, 0])));
  return Buffer.concat(blocks);
}
module.exports = { storedRar };
