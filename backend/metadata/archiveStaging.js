'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createArchiveTools } = require('./archiveTools');
const { createArchiveToolRunner } = require('./archiveToolRunner');
const { inspectArchiveForStaging, validateArchiveCandidate } = require('./archiveValidation');
const { limitsFor, applyMetadataReport } = require('./archiveValidationCore');
const { fingerprintFile, signature } = require('./archiveFile');
const digest = data => createHash('sha256').update(data).digest('hex');
const fingerprint = data => ({ sha256: digest(data), size: data.length });
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

// Private preparation only. RAR integrity/extraction stays with the existing
// tools. ZIP validation, XML preservation and final readback are shared.
async function prepareValidatedArchive({ input, inputPath, sourceName, metadata = null, planMetadata = null, forceOutput = false, scratchParent, signal, executables, limits, mode = 'library', ownership = null, onStage = null, salvage = false }) {
  const stage = name => { try { onStage?.(name); } catch {} };
  if (!path.isAbsolute(scratchParent || '')) throw new TypeError('Absolute trusted scratch parent required');
  if (!path.isAbsolute(inputPath || '') && (!(input instanceof Uint8Array) || !input.byteLength || input.byteLength > 128 * 1024 * 1024)) throw new TypeError('Bounded archive bytes required');
  if (typeof sourceName !== 'string' || !sourceName || !['library', 'download_container'].includes(mode)) throw new TypeError('Explicit source name and mode required');
  if (ownership && ['register', 'created', 'settled', 'beginCleanup', 'finishCleanup'].some(key => typeof ownership[key] !== 'function')) throw new TypeError('Complete trusted scratch ownership adapter required');
  const source = inputPath || Buffer.from(input), bounds = limitsFor(limits);
  const sourceFingerprint = inputPath ? await fingerprintFile(inputPath,signal) : fingerprint(source);
  stage('prep_fingerprint_source');
  if(sourceFingerprint.size > bounds.inputBytes)fail('ARCHIVE_LIMIT','Input exceeds size limit');
  const RAR_SIGNATURE = Buffer.from('526172211a07','hex');
  let rar = (inputPath ? await signature(inputPath) : source.subarray(0,6)).equals(RAR_SIGNATURE);
  let report;
  if (signal?.aborted) fail('ARCHIVE_CANCELLED', 'Staging cancelled');
  // Most refreshes have no XML changes. Inspect in place and do not create a
  // scratch copy or invoke a converter for those books.
  if(!rar && mode==='library'){
    const inspected=await inspectArchiveForStaging({...(inputPath?{inputPath}:{input:source}),sourceName,limits,mode},{signal});
    const {selectedArchivePath,selectedArchiveBytes,...facts}=inspected;
    if(planMetadata)metadata=await planMetadata(facts.comicInfo.xml);
    report=applyMetadataReport(facts,metadata);
    if(JSON.stringify(report.sourceFingerprint)!==JSON.stringify(sourceFingerprint))fail('ARCHIVE_FACTS_CHANGED','Source changed during inspection');
    if(forceOutput)report.requiresOutput=true;
    if(!report.requiresOutput)return {status:'unchanged',report};
  }
  const parent = await fs.realpath(scratchParent);
  if (!(await fs.lstat(scratchParent)).isDirectory()) throw new TypeError('Scratch parent must be a real directory');
  const root = path.join(parent, 'omnibus-archive-' + randomUUID());
  // Register intent BEFORE mkdir/tool work. A crash can leave a record without
  // a directory, but cannot leave an unregistered active scratch directory.
  ownership?.register({ root, parent, sourceFingerprint });
  const candidatePath = path.join(root, 'candidate.cbz');
  const contained = target => {
    const relative = path.relative(root, path.resolve(target));
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) fail('UNSAFE_SCRATCH', 'Path escaped owned scratch');
    return path.resolve(target);
  };
  let settled = false, created = false, cleanupPromise;
  const cleanup = () => {
    if (!settled) return Promise.reject(Object.assign(new Error('Preparation still active'), { code: 'SCRATCH_ACTIVE' }));
    if (!created) return Promise.reject(Object.assign(new Error('This job did not create the scratch directory; retain it for review'), { code: 'SCRATCH_NOT_CREATED' }));
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const target = path.resolve(root);
      if (path.dirname(target) !== parent || !path.basename(target).startsWith('omnibus-archive-')) fail('UNSAFE_SCRATCH', 'Unexpected cleanup path');
      ownership?.beginCleanup();
      await fs.rm(target, { recursive: true, force: true });
      ownership?.finishCleanup();
    })();
    // Failed cleanup stays recorded for recovery; never silently retry an
    // asynchronous deletion which another recovery owner could have claimed.
    return cleanupPromise;
  };
  const tools = createArchiveTools({ run: createArchiveToolRunner({ signal, executables }) });
  const inventory = async directory => {
    const observed = []; let entries = 0, bytes = 0;
    const walk = async (folder, prefix = '') => {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        if (signal?.aborted) fail('ARCHIVE_CANCELLED', 'Staging cancelled');
        if (++entries > bounds.entries) fail('ARCHIVE_LIMIT', 'Extraction produced too many entries');
        const full = contained(path.join(folder, entry.name)), name = prefix + entry.name;
        const stat = await fs.lstat(full);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) fail('UNSAFE_SCRATCH', 'Extraction produced a link or special file');
        if (stat.isDirectory()) { observed.push({ name: name + '/', directory: true, size: 0, sha256: digest(Buffer.alloc(0)) }); await walk(full, name + '/'); }
        else {
          bytes += stat.size;
          if (stat.size > bounds.memberBytes || bytes > bounds.expandedBytes) fail('ARCHIVE_LIMIT', 'Extraction exceeded payload limits');
          const facts = await fingerprintFile(full,signal);
          observed.push({ name, directory: false, size: facts.size, sha256: facts.sha256 });
        }
      }
    };
    await walk(directory);
    return observed.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  };
  try {
    await fs.mkdir(root, { mode: 0o700 });
    created = true;
    ownership?.created();
    let sourcePath = path.join(root, rar ? 'input.rar' : 'input.zip');
    if(inputPath)await fs.copyFile(inputPath,sourcePath,require('node:fs').constants.COPYFILE_EXCL);
    else await fs.writeFile(sourcePath,source,{flag:'wx',mode:0o600});
    if(JSON.stringify(await fingerprintFile(sourcePath,signal))!==JSON.stringify(sourceFingerprint))fail('ARCHIVE_FACTS_CHANGED','Source changed during staging');
    stage('prep_copy_to_scratch');
    if(!rar && !report){
      let inspected=null;
      try{inspected=await inspectArchiveForStaging({inputPath:sourcePath,scratchDirectory:root,sourceName,limits,mode},{signal});}
      catch(error){
        // A download wrapper (a ZIP holding a single .cbr, as GetComics' "….zip" files do) whose inner
        // archive is RAR: the wrapper check extracted the inner file into this scratch folder; convert it
        // through the same RAR path as a .cbr download (2026-10-22). Anything else still fails.
        if(error.code!=='RAR_TOOL_REQUIRED'||mode!=='download_container')throw error;
        const inner=(await fs.readdir(root)).filter(name=>/^wrapper-[0-9a-f-]+\.zip$/i.test(name));
        if(inner.length!==1)throw error;
        const innerPath=contained(path.join(root,inner[0]));
        if(!(await signature(innerPath)).equals(RAR_SIGNATURE))throw error;
        const rarPath=contained(path.join(root,'input-inner.rar'));
        await fs.rename(innerPath,rarPath);
        sourcePath=rarPath;rar=true;
        stage('prep_unwrap_rar');
      }
      if(inspected){
        const {selectedArchivePath,...facts}=inspected;sourcePath=selectedArchivePath;
        if(planMetadata)metadata=await planMetadata(facts.comicInfo.xml);
        report=applyMetadataReport(facts,metadata);
        if(forceOutput)report.requiresOutput=true;
        if(!report.requiresOutput){settled=true;ownership?.settled(null);await cleanup();return {status:'unchanged',report};}
      }
    }
    // salvage: the reader chose "Convert anyway" for a damaged RAR; unreadable
    // members are left out and listed in the report.
    const extraction = await tools.extractArchive({ source: sourcePath, profile: rar && mode === 'library' ? 'retag' : 'download', format: rar ? 'rar' : 'zip', preservePaths: true, salvage: !!salvage,
      attemptDirectory: async ({ index }) => { const directory = contained(path.join(root, `attempt-${index}`)); await fs.mkdir(directory); return directory; } });
    stage('prep_extract');
    const observed = await inventory(extraction.directory);
    stage('prep_hash_extracted_files');
    if (rar) {
      // Reuse the same builder to expose the extracted RAR payload to existing
      // ZIP/XML preservation inspection. No custom RAR parser or compression engine.
      const baselinePath = path.join(root, 'baseline.cbz');
      await tools.buildCbzFromDirectory(extraction.directory, baselinePath, { level: 0 });
      const {selectedArchivePath,...facts}=await inspectArchiveForStaging({inputPath:baselinePath,sourceName:'converted.cbr',limits,mode:'library'},{signal});
      if(planMetadata)metadata=await planMetadata(facts.comicInfo.xml);
      report=applyMetadataReport(facts,metadata);
      report = { ...report, sourceFingerprint, selectedArchiveFingerprint: sourceFingerprint,
        conversion: { format: 'rar', extractor: extraction.tool, baselineFingerprint: facts.sourceFingerprint, evidence: 'existing_tool_extraction',
          ...(extraction.damaged ? { damagedMembersDropped: extraction.damaged } : {}) } };
      stage('prep_rar_baseline_and_metadata');

    }
    if (JSON.stringify(observed) !== JSON.stringify(report.originalMembers.map(m => ({ name: m.name, directory: m.directory, size: m.size, sha256: m.sha256 })))) fail('ARCHIVE_PRESERVATION_FAILED', 'Extraction/build changed source paths or payloads');
    if (report.metadataChanged) {
      const xmlPath = contained(path.join(extraction.directory, ...report.comicInfo.name.split('/')));
      await fs.writeFile(xmlPath, report.comicInfo.xml, { encoding: 'utf8', flag: report.originalMembers.some(m => m.name === report.comicInfo.name) ? 'w' : 'wx' });
    }
    if (signal?.aborted) fail('ARCHIVE_CANCELLED', 'Staging cancelled');
    await tools.buildCbzFromDirectory(extraction.directory, candidatePath);
    stage('prep_build_cbz');
    const validation = await validateArchiveCandidate({ inputPath: candidatePath, report }, { signal });
    stage('prep_validate_cbz');
    if (signal?.aborted) fail('ARCHIVE_CANCELLED', 'Staging cancelled');
    settled = true;
    ownership?.settled({ path: candidatePath, fingerprint: validation.fingerprint });
    return { status: 'prepared', root, candidatePath, report, validation, cleanup };
  } catch (error) {
    // Awaited tool/worker calls settle after close/exit. Recovery must separately
    // prove quiescence if the application itself died before this point.
    settled = true;
    try { ownership?.settled(null); await cleanup(); }
    catch (cleanupError) { error.cleanupError = cleanupError; error.scratchPath = root; }
    throw error;
  }
}
// Compatibility export for the isolated Step 3.2c/d callers.
module.exports = { prepareValidatedArchive, prepareValidatedZip: prepareValidatedArchive };
