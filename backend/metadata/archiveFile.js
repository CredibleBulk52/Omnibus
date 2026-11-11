'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const sameFile = (a,b) => a.size===b.size && a.mtimeMs===b.mtimeMs && a.ctimeMs===b.ctimeMs && a.ino===b.ino;
function regular(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1) throw Object.assign(new Error('Archive must be a regular file with one link'), {code:'ARCHIVE_STORAGE_UNSAFE'});
}
async function fingerprintFile(file, signal) {
  const before=await fs.promises.lstat(file); regular(before);
  const cached=fingerprintCache.get(cacheKey(before));
  if(cached&&cached.size===before.size)return {...cached};
  const hash=createHash('sha256'); let size=0;
  try {
    for await (const chunk of fs.createReadStream(file,{highWaterMark:1024*1024,signal})) { hash.update(chunk); size+=chunk.length; }
  } catch(error) {
    if(error.code==='ABORT_ERR')throw Object.assign(new Error('Archive preparation cancelled'),{code:'ARCHIVE_CANCELLED'});
    throw error;
  }
  const after=await fs.promises.lstat(file);
  if(size!==before.size || !sameFile(before,after)) throw Object.assign(new Error('Archive changed while being read'),{code:'ARCHIVE_FACTS_CHANGED'});
  const result={sha256:hash.digest('hex'),size};
  if(fingerprintCache.size>=256)fingerprintCache.delete(fingerprintCache.keys().next().value);
  fingerprintCache.set(cacheKey(before),result);
  return {...result};
}
// Journal effects are synchronous by contract. Keep their memory use bounded;
// preparation uses the asynchronous equivalent above.
// Phase 6.8: the journal re-checks the same files many times per operation
// (inspect before/after every step). Reuse a fingerprint while the file's
// identity, size and timestamps are unchanged; any write, rename or link
// changes ctime, so a changed file is always hashed again.
const fingerprintCache=new Map();
const cacheKey=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
function fingerprintFileSync(file) {
  const before=fs.lstatSync(file);regular(before);
  const key=cacheKey(before),hit=fingerprintCache.get(key);
  if(hit&&hit.size===before.size)return {...hit};
  const fd=fs.openSync(file,'r'),hash=createHash('sha256'),chunk=Buffer.allocUnsafe(1024*1024);let size=0;
  try { for (;;) { const n=fs.readSync(fd,chunk,0,chunk.length,null);if(!n)break;hash.update(chunk.subarray(0,n));size+=n; } }
  finally {fs.closeSync(fd);}
  if(size!==before.size || !sameFile(before,fs.lstatSync(file))) throw Object.assign(new Error('Archive changed while being read'),{code:'ARCHIVE_FACTS_CHANGED'});
  const result={sha256:hash.digest('hex'),size};
  if(fingerprintCache.size>=256)fingerprintCache.delete(fingerprintCache.keys().next().value);
  fingerprintCache.set(key,result);
  return {...result};
}
async function signature(file) {
  const handle=await fs.promises.open(file,'r');
  try {const bytes=Buffer.alloc(6);await handle.read(bytes,0,6,0);return bytes;}
  finally {await handle.close();}
}
module.exports={fingerprintFile,fingerprintFileSync,signature,regular,sameFile};
