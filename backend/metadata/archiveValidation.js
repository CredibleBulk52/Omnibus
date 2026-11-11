'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');

// File path (or small fixture buffer) in, preservation report out. Nested
// wrappers may stream only to the supplied owned scratch directory. Awaiting
// this API always waits for worker exit,
// including timeout/cancellation; callers must still revalidate source identity
// before any later write. This is not journal ownership or publish permission.
function runValidation(task, request, { signal, timeoutMs = 60000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError('Validation timeout must be 1–60000 ms');
  if (!path.isAbsolute(request?.inputPath || '') && (!(request?.input instanceof Uint8Array) || !request.input.byteLength || request.input.byteLength > 128 * 1024 * 1024)) throw new TypeError('Bounded archive bytes required');
  const error = (code, message) => Object.assign(new Error(message), { code });
  if (signal?.aborted) return Promise.reject(error('ARCHIVE_CANCELLED', 'Archive validation cancelled'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(require.resolve('./archiveValidationWorker'), { workerData: { task, request }, resourceLimits: { maxOldGenerationSizeMb: 384 } });
    let result, failure;
    const stop = why => { if (!failure) failure = why; worker.terminate().catch(e => { failure ||= e; }); };
    const cancel = () => stop(error('ARCHIVE_CANCELLED', 'Archive validation cancelled'));
    const timer = setTimeout(() => stop(error('ARCHIVE_TIMEOUT', 'Archive validation exceeded its time limit')), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.on('message', message => { if (message.error) failure ||= error(message.error.code, message.error.message); else result = message.result; });
    worker.on('error', e => { failure ||= e; });
    worker.on('exit', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (failure) reject(failure);
      else if (code !== 0 || !result) reject(error('ARCHIVE_WORKER_FAILED', 'Archive worker exited without a validated result'));
      else resolve(result);
    });
    if (signal?.aborted) cancel();
  });
}

module.exports = {
  inspectArchive: (request, options) => runValidation('inspect', request, options),
  // Staging handoff returns the selected private ZIP path (or fixture bytes).
  inspectArchiveForStaging: (request, options) => runValidation('staging', request, options),
  validateArchiveCandidate: (request, options) => runValidation('candidate', request, options),
};
