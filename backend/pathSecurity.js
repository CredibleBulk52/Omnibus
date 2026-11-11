'use strict';
const fs = require('node:fs');
const path = require('node:path');
function resolveExistingWithinRoot(root, requested, { fileSystem = fs, paths = path } = {}) {
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) fail(400, 'Invalid path');
  const inside = (base, target) => {
    const relative = paths.relative(base, target);
    return relative === '' || (!paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + paths.sep));
  };
  const base = paths.resolve(root), target = paths.resolve(requested);
  if (!inside(base, target)) fail(403, 'Access denied');
  let actualBase, actualTarget;
  try {
    actualBase = fileSystem.realpathSync(base);
    actualTarget = fileSystem.realpathSync(target);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) fail(404, 'Path not found');
    if (['EACCES', 'EPERM'].includes(error.code)) fail(403, 'Access denied');
    throw error;
  }
  if (!inside(actualBase, actualTarget)) fail(403, 'Access denied');
  return actualTarget;
}
// For folders that may not exist yet: the nearest existing ancestor must
// resolve inside the root, and no missing segment may be a dangling symlink.
function resolveCreatableWithinRoot(root, requested, { fileSystem = fs, paths = path } = {}) {
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) fail(400, 'Invalid path');
  const inside = (base, target) => {
    const relative = paths.relative(base, target);
    return relative === '' || (!paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + paths.sep));
  };
  const base = paths.resolve(root), target = paths.resolve(requested);
  if (!inside(base, target)) fail(403, 'Access denied');
  const mapError = error => {
    if (['EACCES', 'EPERM'].includes(error.code)) fail(403, 'Access denied');
    throw error;
  };
  let actualBase;
  try { actualBase = fileSystem.realpathSync(base); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) fail(404, 'Path not found'); mapError(error); }
  const missing = [];
  for (let current = target; ; current = paths.dirname(current)) {
    let actual;
    try { actual = fileSystem.realpathSync(current); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) mapError(error);
      let exists = false;
      try { fileSystem.lstatSync(current); exists = true; } catch {}
      if (exists) fail(403, 'Access denied');  // dangling or unreadable link
      if (current === base) fail(404, 'Path not found');
      missing.unshift(paths.basename(current));
      continue;
    }
    if (!inside(actualBase, actual)) fail(403, 'Access denied');
    return missing.length ? paths.join(actual, ...missing) : actual;
  }
}
module.exports = { resolveExistingWithinRoot, resolveCreatableWithinRoot };
