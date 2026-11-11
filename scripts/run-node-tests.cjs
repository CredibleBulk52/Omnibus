'use strict';
// Explicit discovery works on Windows and POSIX without shell glob expansion.
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const target = process.argv[2];
if (!['backend', 'frontend/tests'].includes(target)) throw new Error('Expected backend or frontend/tests');
const tests = [];
function discover(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) discover(file);
    else if (/\.test\.(?:js|cjs|mjs)$/.test(entry.name)) tests.push(file);
  }
}
discover(path.join(root, target));
if (!tests.length) throw new Error('No tests found');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...tests.sort().map(file => path.relative(root, file).split(path.sep).join('/'))], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
