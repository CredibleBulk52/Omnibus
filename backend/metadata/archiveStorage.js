'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const fingerprint = bytes => ({sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length});
const { fingerprintFileSync, regular, sameFile } = require('./archiveFile');
function fail(message) { throw Object.assign(new Error(message),{code:'ARCHIVE_STORAGE_UNSAFE'}); }
// File-only effects for the journal. No conversion/provider calls or recursive
// library cleanup. Cooperating writers/scanner must be excluded by the caller.
function createArchiveStorage({libraryRoots,candidate=null}) {
  if (!Array.isArray(libraryRoots) || !libraryRoots.length) throw new TypeError('Trusted library roots required');
  const roots=libraryRoots.map(p=>fs.realpathSync(p));
  const inside=(root,p)=>{const rel=path.relative(root,p);return rel==='' || (!path.isAbsolute(rel) && rel!=='..' && !rel.startsWith('..'+path.sep));};
  function checked(file) {
    if(!path.isAbsolute(file)) fail('Absolute artifact path required');
    const parent=fs.realpathSync(path.dirname(file));
    if(!roots.some(root=>inside(root,parent))) fail('Artifact parent is outside trusted libraries');
    // Resolve only parents: destination may not exist yet. Reject links below.
    return path.join(parent,path.basename(file));
  }
  function readFile(file, library=true) {
    const target=library?checked(file):file, stat=fs.lstatSync(target);
    regular(stat);
    const facts=fingerprintFileSync(target),after=fs.lstatSync(target);
    if(!sameFile(stat,after))fail('Archive changed while being read');
    return {path:target,stat,fingerprint:facts};
  }
  function observe(file) {
    if(!file) return {status:'missing'};
    try {const value=readFile(file);return {status:'file',...value.fingerprint,mtimeMs:Math.floor(value.stat.mtimeMs)};}
    catch(error) {
      if(error.code==='ENOENT') {try {checked(file);return {status:'missing'};}catch{}}
      return {status:'unavailable'};
    }
  }
  function write(file,source,exclusive=true) {
    const target=checked(file);
    // Existing destination must already have been fingerprint-verified under
    // the journal lock. In-place copy is recoverable via the retained backup;
    // this is not a cross-platform atomic replacement/power-loss guarantee.
    if(!exclusive) readFile(target);
    fs.copyFileSync(source,target,exclusive?fs.constants.COPYFILE_EXCL:0);
    const fd=fs.openSync(target,'r+');
    try {fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }
  function remove(file) {const target=checked(file);try{readFile(target);fs.unlinkSync(target);}catch(error){if(error.code!=='ENOENT')throw error;}}
  return {
    readSource: file=>readFile(file),
    inspect: row=>({source:observe(row.payload.source),destination:observe(row.payload.destination),staged:observe(row.payload.artifacts.staged),backup:observe(row.payload.artifacts.backup),replacement:observe(row.payload.replacement?.path)}),
    prepare: row=>{
      if(!candidate?.candidatePath || !candidate.validation?.fingerprint) fail('Validated private candidate required');
      const value=readFile(candidate.candidatePath,false), expected=candidate.validation.fingerprint;
      if(value.fingerprint.sha256!==expected.sha256 || value.fingerprint.size!==expected.size) fail('Private candidate changed');
      write(row.payload.artifacts.staged,value.path);return expected;
    },
    backup: row=>write(row.payload.artifacts.backup,readFile(row.payload.source).path),
    publish: row=>write(row.payload.destination,readFile(row.payload.artifacts.staged).path,path.resolve(row.payload.source)!==path.resolve(row.payload.destination)),
    cleanup: row=>{const p=row.payload;if(path.resolve(p.source)!==path.resolve(p.destination))remove(p.source);remove(p.artifacts.staged);remove(p.artifacts.backup);},
    rollback: row=>{
      const p=row.payload;
      if(observe(p.artifacts.backup).status==='file') write(p.source,readFile(p.artifacts.backup).path,observe(p.source).status==='missing');
      if(path.resolve(p.source)!==path.resolve(p.destination))remove(p.destination);
      remove(p.artifacts.staged);remove(p.artifacts.backup);
    },
  };
}
module.exports={createArchiveStorage,fingerprint};
