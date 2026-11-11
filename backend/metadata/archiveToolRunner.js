'use strict';
const { spawn } = require('node:child_process');

// Direct known archive executables only, never a shell. Do not settle on abort
// until close: staging must not clean scratch while the converter still runs.
function createArchiveToolRunner({ executables = {}, signal, timeoutMs = 60000, maxOutputBytes = 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16 * 1024 * 1024) throw new TypeError('Bounded tool timeout/output required');
  if (signal && !(signal instanceof AbortSignal)) throw new TypeError('A native AbortSignal is required');
  return (tool, args, options = {}) => new Promise((resolve, reject) => {
    const error = (code, message) => Object.assign(new Error(message), { code });
    if (!['7z', 'unrar', 'bsdtar'].includes(tool)) return reject(new TypeError('Unsupported archive tool'));
    if (signal?.aborted) return reject(error('ARCHIVE_CANCELLED', 'Archive tool cancelled'));
    const child = spawn(executables[tool] || tool, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: options.env || process.env });
    const output = { stdout: [], stderr: [] }; let size = 0, failure;
    const stop = reason => { failure ||= reason; child.kill('SIGKILL'); };
    const cancel = () => stop(error('ARCHIVE_CANCELLED', 'Archive tool cancelled'));
    const timer = setTimeout(() => stop(error('ARCHIVE_TIMEOUT', 'Archive tool exceeded time limit')), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    for (const key of ['stdout', 'stderr']) child[key].on('data', chunk => {
      size += chunk.length;
      if (size > maxOutputBytes) stop(error('ARCHIVE_OUTPUT_LIMIT', 'Archive tool exceeded output limit'));
      else output[key].push(chunk);
    });
    child.on('error', e => { failure ||= e; });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      const result = { stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8') };
      if (!failure && code !== 0) failure = Object.assign(error('ARCHIVE_TOOL_FAILED', `${tool} exited with ${code ?? exitSignal}`), { exitCode: code });
      if (failure) reject(Object.assign(failure, result)); else resolve(result);
    });
    if (signal?.aborted) cancel();
  });
}
module.exports = { createArchiveToolRunner };
