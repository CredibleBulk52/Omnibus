'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { inspectArchiveBuffer, validateCandidateBuffer } = require('./archiveValidationCore');
if (!parentPort) throw new Error('Archive validator must run in a worker');
(async () => {
  try {
    if (!['inspect', 'staging', 'candidate'].includes(workerData.task)) throw new TypeError('Unsupported archive validation task');
    const action = workerData.task === 'candidate' ? validateCandidateBuffer : inspectArchiveBuffer;
    parentPort.postMessage({ result: await action(workerData.request, workerData.task === 'staging') });
  } catch (error) {
    parentPort.postMessage({ error: { code: error.code || 'ARCHIVE_READ_FAILED', message: error.message } });
  } finally { parentPort.close(); }
})();
