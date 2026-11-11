'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { randomUUID } = require('node:crypto');
const { fingerprintFile, signature } = require('./archiveFile');
const { createHash } = require('node:crypto');
const yauzl = require('yauzl');
const { parseComicInfoEvidence } = require('./evidence');
const { applyComicInfoPlan } = require('./comicInfoPatch');

const DEFAULT_LIMITS = Object.freeze({ inputBytes: Number.MAX_SAFE_INTEGER, expandedBytes: Number.MAX_SAFE_INTEGER,
  memberBytes: Number.MAX_SAFE_INTEGER, outputBytes: Number.MAX_SAFE_INTEGER, entries: 4096,
  imagePixels: 16 * 1024 * 1024, ratio: 1000, depth: 3 });
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fingerprint = bytes => ({ sha256: sha256(bytes), size: bytes.length });
function limitsFor(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new TypeError('Invalid archive limits');
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key]) throw new TypeError('Archive limits may only lower the documented bounds');
  }
  return { ...DEFAULT_LIMITS, ...overrides };
}
function formatOf(bytes) {
  if (bytes.subarray(0, 6).equals(Buffer.from('526172211a07', 'hex'))) return 'rar';
  if (['504b0304', '504b0506'].includes(bytes.subarray(0, 4).toString('hex'))) return 'zip';
  return 'unsupported';
}
function safeName(name) {
  if (!name || name.length > 1024 || /[\\\x00-\x1f\x7f:\ufffd]/.test(name) || name.startsWith('/')) fail('UNSAFE_MEMBER', 'Unsafe archive member path');
  const components = name.replace(/\/$/, '').split('/');
  if (components.some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('UNSAFE_MEMBER', 'Ambiguous archive member path');
  return components.join('/').normalize('NFC').toLowerCase();
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Stream member hashes/CRC; retain only bounded ComicInfo text in memory.
// Small buffer callers retain nested archives for compatibility; production uses files.
function readZip(bytes, limits, budget) {
  return new Promise((resolve, reject) => {
    (typeof bytes === 'string' ? yauzl.open : yauzl.fromBuffer)(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false }, (error, zip) => {
      if (error) return reject(error);
      let finished = false;
      const members = [], names = new Map(), spellings = new Map();
      const done = error => { if (finished) return; finished = true; zip.close(); error ? reject(error) : resolve(members); };
      zip.on('error', done);
      zip.on('end', () => {
        // Implicit directories count across the whole wrapper chain, too.
        budget.entries += spellings.size - members.length;
        if (budget.entries > limits.entries) return done(Object.assign(new Error('Archive directory entries exceed cumulative budget'), { code: 'ARCHIVE_LIMIT' }));
        done();
      });
      zip.on('entry', entry => {
        try {
          if (++budget.entries > limits.entries) fail('ARCHIVE_LIMIT', 'Too many archive entries');
          const name = entry.fileName, key = safeName(name), directory = name.endsWith('/');
          const parts = name.replace(/\/$/, '').split('/');
          for (let i = 1; i <= parts.length; i++) {
            const spelling = parts.slice(0, i).join('/'), folded = spelling.normalize('NFC').toLowerCase();
            if (spellings.has(folded) && spellings.get(folded) !== spelling) fail('DUPLICATE_MEMBER', 'Directory spelling aliases are ambiguous');
            spellings.set(folded, spelling);
            if (spellings.size > limits.entries) fail('ARCHIVE_LIMIT', 'Implicit directories exceed entry budget');
          }
          if (names.has(key)) fail('DUPLICATE_MEMBER', 'Duplicate or case/Unicode-ambiguous archive members');
          for (const [existing, isDirectory] of names) {
            if ((!isDirectory && key.startsWith(existing + '/')) || (!directory && existing.startsWith(key + '/'))) fail('DUPLICATE_MEMBER', 'File/directory path collision');
          }
          names.set(key, directory);
          const type = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (![0, 0x8000, 0x4000].includes(type) || (type === 0x4000 && !directory) || (type === 0x8000 && directory)) fail('UNSAFE_MEMBER', 'Links and special files are unsupported');
          if (entry.generalPurposeBitFlag & 1) fail('ENCRYPTED_ARCHIVE', 'Encrypted archives require review');
          if (![0, 8].includes(entry.compressionMethod)) fail('UNSUPPORTED_COMPRESSION', 'Unsupported ZIP compression');
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > limits.memberBytes
            || entry.uncompressedSize / Math.max(entry.compressedSize, 1) > limits.ratio) fail('ARCHIVE_LIMIT', 'Archive member exceeds resource limits');
          budget.bytes += entry.uncompressedSize;
          if (budget.bytes > limits.expandedBytes) fail('ARCHIVE_LIMIT', 'Archive expansion exceeds resource limits');
          if (directory && entry.uncompressedSize) fail('UNSAFE_MEMBER', 'Directory member contains payload');
          zip.openReadStream(entry, (error, stream) => {
            if (error) return done(error);
            const xml = /(^|\/)ComicInfo\.xml$/i.test(name);
            const keep = xml || (typeof bytes !== 'string' && /\.(zip|cbz|cbr|rar)$/i.test(name));
            const maxRetained = xml ? 2 * 1024 * 1024 : 128 * 1024 * 1024;
            if (keep && entry.uncompressedSize > maxRetained) { stream.destroy();return done(Object.assign(new Error('Buffered metadata/wrapper exceeds limit'),{code:xml?'XML_LIMIT':'ARCHIVE_LIMIT'})); }
            const chunks = [], hash = createHash('sha256'); let size = 0, crc = 0xffffffff;
            // A damaged deflate member can stall the stream with nothing left
            // to run, so the worker exited without a result (Iron Man #198 and
            // #249, 2026-10-16). A watchdog names the member instead.
            let watchdog;
            const stalled = () => { stream.destroy(); done(Object.assign(new Error(`Damaged archive: ${path.posix.basename(name)} cannot be read (the file stops partway). Replace the file.`), { code: 'ARCHIVE_DAMAGED', damaged: [name] })); };
            const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(stalled, 15000); };
            arm();
            stream.on('error', e => { clearTimeout(watchdog); done(/invalid|incorrect|unexpected end|zlib|inflate/i.test(e.message || '') ? Object.assign(new Error(`Damaged archive: ${path.posix.basename(name)} cannot be read (${e.message}). Replace the file.`), { code: 'ARCHIVE_DAMAGED', damaged: [name] }) : e); });
            stream.on('data', chunk => {
              arm();
              size += chunk.length;
              if (size > entry.uncompressedSize || size > limits.memberBytes) { stream.destroy(); done(Object.assign(new Error('Member expansion exceeded declared bounds'), { code: 'ARCHIVE_LIMIT' })); }
              else { hash.update(chunk);for(const byte of chunk)crc=crcTable[(crc^byte)&255]^(crc>>>8);if(keep)chunks.push(chunk); }
            });
            stream.on('end', () => {
              clearTimeout(watchdog);
              if (finished) return;
              const data = keep ? Buffer.concat(chunks) : null;
              if (size !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) return done(Object.assign(new Error('Archive payload integrity check failed'), { code: 'ARCHIVE_INTEGRITY' }));
              members.push({ name, directory, data, fingerprint: {sha256:hash.digest('hex'),size} }); zip.readEntry();
            });
          });
        } catch (error) { done(error); }
      });
      zip.readEntry();
    });
  });
}
// Exact reader policy: full internal names sorted using JavaScript's default
// lexical sort, not ZIP order, locale sorting, basename or numeric page order.
function pageNames(members) {
  return members.filter(member => !member.directory && /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(member.name)
    && !member.name.includes('__MACOSX') && !path.posix.basename(member.name).startsWith('._')).map(member => member.name).sort();
}
async function validatePages(members, limits) {
  const pages = pageNames(members);
  if (!pages.length) fail('NO_IMAGE_PAGES', 'Archive has no usable reader image entries');
  // Metadata edits preserve the reader's ordered page bytes. Decoding images
  // adds no preservation evidence and rejects otherwise readable large pages.
  // This manifest is deliberately not a claim about image health.
  const byName = new Map(members.map(member => [member.name, member]));
  return pages.map(name => ({ name, ...byName.get(name).fingerprint }));
}
// Readers use the top-level ComicInfo.xml. Copies inside a page folder are left
// as they are. An empty top-level file (left by an older writer) is replaced by
// the single non-empty nested copy, so the book keeps its existing details.
function comicInfo(members) {
  const matches = members.filter(member => !member.directory && /(^|\/)ComicInfo\.xml$/i.test(member.name));
  if (!matches.length) return { name: null, xml: null };
  let chosen = matches[0], rewriteRoot = null;
  if (matches.length > 1) {
    const roots = matches.filter(member => !member.name.includes('/'));
    const blank = member => !member.data.toString('utf8').replace(/^\uFEFF/, '').trim();
    if (roots.length !== 1) fail('AMBIGUOUS_COMICINFO', 'Multiple ComicInfo documents require review');
    chosen = roots[0];
    if (blank(roots[0])) {
      const filled = matches.filter(member => member !== roots[0] && !blank(member));
      if (filled.length > 1) fail('AMBIGUOUS_COMICINFO', 'Multiple ComicInfo documents require review');
      if (filled.length === 1) { chosen = filled[0]; rewriteRoot = roots[0].name; }
    }
  }
  if (chosen.data.length > 2 * 1024 * 1024) fail('XML_LIMIT', 'ComicInfo exceeds size limit');
  let xml;
  try { xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(chosen.data); }
  catch { fail('UNSUPPORTED_ENCODING', 'ComicInfo must decode losslessly as UTF-8'); }
  const encoding = /^\uFEFF?<\?xml\b[^?]*\bencoding\s*=\s*(['"])([^'"]+)\1/i.exec(xml);
  if (encoding && !/^utf-8$/i.test(encoding[2])) fail('UNSUPPORTED_ENCODING', 'ComicInfo declares an unsupported byte encoding');
  if (parseComicInfoEvidence(xml).status === 'invalid') fail('INVALID_COMICINFO', 'Malformed ComicInfo is preserved for review');
  return rewriteRoot ? { name: rewriteRoot, xml, rewriteRoot: true } : { name: chosen.name, xml };
}
function payloadManifest(members) {
  const normalized = new Map(members.map(m => [m.name, { name: m.name, directory: m.directory, ...(m.fingerprint || fingerprint(m.data)) }]));
  // ZIP tools differ in whether parent directory entries are explicit. Include
  // implicit parents canonically while still retaining explicit empty folders.
  for (const member of members) {
    const parts = member.name.replace(/\/$/, '').split('/');
    for (let i = 1; i < parts.length; i++) {
      const name = parts.slice(0, i).join('/') + '/';
      if (!normalized.has(name)) normalized.set(name, { name, directory: true, ...fingerprint(Buffer.alloc(0)) });
    }
  }
  return [...normalized.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

// Validation/planning only. Conversion remains the existing unrar/7z/bsdtar
// workflow. Only an unambiguous wrapper is streamed to a fixed scratch filename.
async function inspectArchiveBuffer({ input, inputPath, scratchDirectory, sourceName, mode = 'library', metadata = null, limits: overrides = {} }, includeSelectedBytes = false) {
  const limits = limitsFor(overrides), bytes = inputPath || Buffer.from(input);
  const sourceFingerprint = inputPath ? await fingerprintFile(inputPath) : fingerprint(bytes);
  if (!sourceFingerprint.size || sourceFingerprint.size > limits.inputBytes) fail('ARCHIVE_LIMIT', 'Input archive size exceeds limits');
  if (typeof sourceName !== 'string' || !sourceName || !['library', 'download_container'].includes(mode)) throw new TypeError('Explicit source name and supported mode required');
  const budget = { bytes: 0, entries: 0 }, wrappers = [];
  let payload = bytes, members;
  while (true) {
    const format = formatOf(typeof payload === 'string' ? await signature(payload) : payload);
    if (format === 'rar') fail('RAR_TOOL_REQUIRED', 'Actual RAR input requires the separately validated RAR conversion adapter');
    if (format !== 'zip') fail('UNSUPPORTED_ARCHIVE', 'Archive format is not a supported ZIP container');
    members = await readZip(payload, limits, budget);
    if (pageNames(members).length) break;
    const files = members.filter(m => !m.directory && !m.name.includes('__MACOSX') && !path.posix.basename(m.name).startsWith('._'));
    if (mode !== 'download_container' || files.length !== 1 || !/\.(zip|cbz|rar|cbr)$/i.test(files[0].name)) fail('NO_IMAGE_PAGES', 'Archive has no pages or contains an ambiguous nested download');
    if (wrappers.length >= limits.depth) fail('ARCHIVE_LIMIT', 'Nested download depth exceeded');
    wrappers.push({ name: files[0].name, ...(typeof payload === 'string' ? await fingerprintFile(payload) : fingerprint(payload)), members: payloadManifest(members) });
    if(typeof payload === 'string') {
      if(!path.isAbsolute(scratchDirectory || '')) fail('UNSAFE_SCRATCH','Owned wrapper scratch directory required');
      const target=path.join(scratchDirectory,'wrapper-'+randomUUID()+'.zip');
      await extractWrapper(payload,files[0].name,target);
      const observed=await fingerprintFile(target);
      if(JSON.stringify(observed)!==JSON.stringify(files[0].fingerprint))fail('ARCHIVE_FACTS_CHANGED','Nested archive changed during preparation');
      payload=target;
    } else payload=files[0].data;
  }
  const pages = await validatePages(members, limits), ci = comicInfo(members);
  const applied = metadata ? applyComicInfoPlan({ ...metadata, currentXml: ci.xml }) : { xml: ci.xml, changed: false };
  const patch = ci.rewriteRoot ? { ...applied, changed: true } : applied;
  let outputMembers = members;
  if (patch.changed) {
    outputMembers = members.map(m => m.name === ci.name ? { ...m, data: Buffer.from(patch.xml, 'utf8'), fingerprint: fingerprint(Buffer.from(patch.xml, 'utf8')) } : m);
    if (!ci.name) outputMembers = [...outputMembers, { name: 'ComicInfo.xml', directory: false, data: Buffer.from(patch.xml, 'utf8') }];
  }
  const needsNormalization = !/\.cbz$/i.test(sourceName) || wrappers.length > 0;
  return { sourceFingerprint, selectedArchiveFingerprint: typeof payload === 'string' ? await fingerprintFile(payload) : fingerprint(payload), limits,
    pages, originalMembers: payloadManifest(members), expectedMembers: payloadManifest(outputMembers), comicInfo: { name: ci.name || (patch.changed ? 'ComicInfo.xml' : null), xml: patch.xml },
    metadataChanged: patch.changed, needsNormalization, requiresOutput: patch.changed || needsNormalization, wrappers, comicInfoRewrite: !!ci.rewriteRoot,
    ...(includeSelectedBytes ? (typeof payload === 'string' ? { selectedArchivePath: payload } : { selectedArchiveBytes: payload }) : {}) };
}

async function validateCandidateBuffer({ input, inputPath, report }) {
  const limits = limitsFor(report?.limits), bytes = inputPath || Buffer.from(input);
  const facts = inputPath ? await fingerprintFile(inputPath) : fingerprint(bytes);
  if (!facts.size || facts.size > limits.outputBytes) fail('ARCHIVE_LIMIT', 'Candidate exceeds size limit');
  if (formatOf(inputPath ? await signature(inputPath) : bytes) !== 'zip') fail('CBZ_REQUIRED', 'Candidate must contain actual ZIP bytes');
  const members = await readZip(bytes, limits, { bytes: 0, entries: 0 });
  if (JSON.stringify(payloadManifest(members)) !== JSON.stringify(report.expectedMembers)) fail('ARCHIVE_PRESERVATION_FAILED', 'Candidate changed expected archive member paths or payloads');
  const pages = await validatePages(members, limits), ci = comicInfo(members);
  if (JSON.stringify(pages) !== JSON.stringify(report.pages) || ci.name !== report.comicInfo.name || ci.xml !== report.comicInfo.xml) fail('ARCHIVE_PRESERVATION_FAILED', 'Candidate changed page mapping or ComicInfo');
  return { fingerprint: facts, pages, comicInfo: ci };
}


function extractWrapper(source, name, target) {
  return new Promise((resolve,reject)=>{
    yauzl.open(source,{lazyEntries:true,strictFileNames:true,autoClose:false},(error,zip)=>{
      if(error)return reject(error);
      let found=false,done=false;
      const finish=error=>{if(done)return;done=true;zip.close();error?reject(error):resolve();};
      zip.on('error',finish);zip.on('end',()=>{if(!found)finish(new Error('Nested archive disappeared'));});
      zip.on('entry',entry=>{
        if(entry.fileName!==name)return zip.readEntry();found=true;
        zip.openReadStream(entry,(error,stream)=>{
          if(error)return finish(error);
          pipeline(stream,fs.createWriteStream(target,{flags:'wx',mode:0o600})).then(()=>finish(),finish);
        });
      });zip.readEntry();
    });
  });
}
// Apply a planned XML change to already-inspected facts without rereading pages.
function applyMetadataReport(report, metadata) {
  const applied=metadata?applyComicInfoPlan({...metadata,currentXml:report.comicInfo.xml}):{xml:report.comicInfo.xml,changed:false};
  const patch=report.comicInfoRewrite?{...applied,changed:true}:applied;
  const name=report.comicInfo.name || (patch.changed?'ComicInfo.xml':null);
  const members=report.originalMembers.filter(m=>!patch.changed || m.name!==name);
  if(patch.changed)members.push({name,directory:false,...fingerprint(Buffer.from(patch.xml,'utf8'))});
  members.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  return {...report,expectedMembers:members,comicInfo:{name,xml:patch.xml},metadataChanged:patch.changed,requiresOutput:patch.changed||report.needsNormalization,...(metadata?{appliedMetadata:metadata}:{})};
}

module.exports = { applyMetadataReport, DEFAULT_LIMITS, limitsFor, inspectArchiveBuffer, validateCandidateBuffer };
