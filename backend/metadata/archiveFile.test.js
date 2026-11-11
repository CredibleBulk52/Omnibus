'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {randomBytes,createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const archiver=require('archiver');
const {fingerprintFile}=require('./archiveFile');
const {inspectArchive}=require('./archiveValidation');
const {prepareValidatedArchive}=require('./archiveStaging');
const {createArchiveStorage}=require('./archiveStorage');
const {planMetadataMerge}=require('./merge');
const binary=process.env.OMNIBUS_TEST_7Z||'7z';
const available=!spawnSync(binary,[],{windowsHide:true}).error;
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'omnibus-file-test-'));
  t.after(()=>{const target=path.resolve(root);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.match(path.basename(target),/^omnibus-file-test-/);fs.rmSync(target,{recursive:true,force:true});});
  return root;
}
async function zipFile(target,entries){
  const archive=archiver('zip',{store:true});
  const done=pipeline(archive,fs.createWriteStream(target,{flags:'wx'}));
  for(const [name,bytes] of entries)archive.append(bytes,{name});
  await Promise.all([archive.finalize(),done]);
}
test('file-backed tagging and publication preserve a page larger than the former archive cap', {skip:!available&&'7z required'},async t=>{
  const root=fixture(t),source=path.join(root,'Large.cbz');
  const block=randomBytes(1024*1024),hash=createHash('sha256');
  function* chunks(){for(let i=0;i<129;i++){hash.update(block);yield block;}}
  await zipFile(source,[['001.jpg',Readable.from(chunks())],['notes.txt','keep']]);
  const original=await fingerprintFile(source),pageHash=hash.digest('hex');
  assert.ok(original.size>128*1024*1024);
  const storage=createArchiveStorage({libraryRoots:[root]}),read=storage.readSource(source);
  assert.equal(read.bytes,undefined);assert.equal(read.path,source);assert.deepEqual(read.fingerprint,original);
  const before=await inspectArchive({inputPath:source,sourceName:'Large.cbz'});
  assert.equal(before.pages[0].sha256,pageHash);assert.equal(before.pages[0].size,129*1024*1024);
  const prepared=await prepareValidatedArchive({inputPath:source,sourceName:'Large.cbz',scratchParent:root,executables:{'7z':binary},
    planMetadata:async currentXml=>({bookId:'large',cvIssueId:'123',plan:planMetadataMerge({bookId:'large',currentXml,
      decision:{status:'accepted',bookId:'large',cvIssueId:'123'},source:{cvIssueId:'123',fields:{Writer:'Added'}}})})});
  assert.equal(prepared.status,'prepared');assert.equal(prepared.validation.pages[0].sha256,pageHash);
  assert.match(prepared.report.comicInfo.xml,/<Writer>Added<\/Writer>/);
  const adapter=createArchiveStorage({libraryRoots:[root],candidate:prepared});
  const row={payload:{source,destination:source,artifacts:{staged:path.join(root,'staged.cbz'),backup:path.join(root,'backup.cbz')}}};
  adapter.prepare(row);await prepared.cleanup();adapter.backup(row);
  assert.deepEqual(await fingerprintFile(row.payload.artifacts.backup),original);
  adapter.publish(row);assert.deepEqual(await fingerprintFile(source),prepared.validation.fingerprint);
  adapter.rollback(row);assert.deepEqual(await fingerprintFile(source),original);
});
test('file-backed unchanged refresh does not write scratch files or run a converter',async t=>{
  const root=fixture(t),source=path.join(root,'Comic.cbz');
  await zipFile(source,[['001.bmp',Buffer.from('opaque page bytes')]]);
  const before=fs.statSync(source),facts=await fingerprintFile(source);
  const result=await prepareValidatedArchive({inputPath:source,sourceName:'Comic.cbz',scratchParent:root,executables:{'7z':'must-not-run'}});
  assert.equal(result.status,'unchanged');assert.deepEqual(fs.readdirSync(root),['Comic.cbz']);
  assert.deepEqual(await fingerprintFile(source),facts);assert.equal(fs.statSync(source).mtimeMs,before.mtimeMs);
});

// Phase 6.8: fingerprints are reused only while the file is unchanged.
test('fingerprint cache never hides a same-size rewrite',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {fingerprintFileSync}=require('./archiveFile');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fp-cache-')),file=path.join(dir,'a.cbz');
 try{
  fs.writeFileSync(file,'AAAAAAAA');const first=fingerprintFileSync(file);
  assert.deepEqual(fingerprintFileSync(file),first,'unchanged file reuses the fingerprint');
  await new Promise(r=>setTimeout(r,20));fs.writeFileSync(file,'BBBBBBBB');
  const second=fingerprintFileSync(file);assert.notEqual(second.sha256,first.sha256);assert.equal(second.size,8);
  const mutated=fingerprintFileSync(file);mutated.sha256='x';assert.equal(fingerprintFileSync(file).sha256,second.sha256,'callers cannot corrupt the cache');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
