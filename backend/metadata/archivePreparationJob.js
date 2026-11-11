'use strict';
const { createHash } = require('node:crypto');
const path = require('node:path');
const { fingerprintFile } = require('./archiveFile');
const { prepareValidatedArchive } = require('./archiveStaging');

// Internal asynchronous preparation bridge. No publication, source deletion,
// stable-ID allocation or DB transaction held over converter/worker awaits.
async function prepareJournalArchive({ journal, handle, input, inputPath, signal, heartbeatMs = 1000, ...options }) {
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > 10000) throw new TypeError('Bounded heartbeat interval required');
  if (!path.isAbsolute(inputPath || '') && (!(input instanceof Uint8Array) || !input.length || input.length > 128 * 1024 * 1024)) throw new TypeError('Bounded archive bytes required');
  const bytes = inputPath ? undefined : Buffer.from(input), operation = journal.assertOwned(handle);
  const expected = operation.payload.replacement || operation.payload.sourceFingerprint;
  const controller = new AbortController(); let ownershipError, result;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setInterval(() => {
    try { journal.heartbeat(handle); }
    catch (error) { ownershipError ||= error; controller.abort(); }
  }, heartbeatMs);
  try {
    const facts=inputPath?await fingerprintFile(inputPath,controller.signal):{size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
    if(!expected || facts.size!==expected.size || facts.sha256!==expected.sha256)throw Object.assign(new Error('Preparation input differs from reserved source'),{code:'ARCHIVE_FACTS_CHANGED'});
    result = await prepareValidatedArchive({ ...options, input: bytes, inputPath, signal: controller.signal, ownership: {
      register: facts => journal.registerScratch(handle, facts),
      created: () => journal.markScratchCreated(handle),
      settled: candidate => journal.settleScratch(handle, candidate),
      beginCleanup: () => journal.beginScratchCleanup(handle),
      finishCleanup: () => journal.finishScratchCleanup(handle),
    } });
    journal.assertOwned(handle);
    return result;
  } catch (error) {
    if (result?.cleanup) {
      try { await result.cleanup(); }
      catch (cleanupError) { error.cleanupError = cleanupError; error.scratchPath = result.root; }
    }
    if (ownershipError) error.ownershipError = ownershipError;
    throw error;
  } finally {
    clearInterval(timer); signal?.removeEventListener('abort', cancel);
  }
}
module.exports = { prepareJournalArchive };
