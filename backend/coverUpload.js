'use strict';
const MAX_COVER_BYTES = 10 * 1024 * 1024;
const COVER_TYPES = Object.freeze({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' });
function readCover(req, limit = MAX_COVER_BYTES) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!COVER_TYPES[type]) { req.resume(); return Promise.reject(fail(415, 'Use a JPEG, PNG, WebP or GIF cover')); }
  if (Number(req.headers['content-length']) > limit) { req.resume(); return Promise.reject(fail(413, 'Cover must be 10 MB or smaller')); }
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0, done = false;
    function finish(error) {
      if (done) return; done = true;
      req.removeListener('data', data); req.removeListener('end', end); req.removeListener('aborted', aborted);
      const body = !error && Buffer.concat(chunks, size); chunks = [];
      if (error) { req.resume(); reject(error); } else resolve({ body, ext: COVER_TYPES[type] });
    }
    function data(chunk) {
      size += chunk.length;
      if (size > limit) return finish(fail(413, 'Cover must be 10 MB or smaller'));
      chunks.push(chunk);
    }
    function end() { finish(size ? null : fail(400, 'Cover is empty')); }
    function aborted() { finish(fail(400, 'Cover upload interrupted')); }
    req.on('data', data); req.once('end', end); req.once('aborted', aborted);
    // Keep the error listener after rejection while the rest of the body drains.
    req.once('error', error => finish(error));
  });
}
module.exports = { readCover, MAX_COVER_BYTES };
