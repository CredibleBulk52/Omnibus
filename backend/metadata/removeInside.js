'use strict';
// Remove one extracted archive member, only when it really is inside `root` (2026-11-09).
// A member path can be lexically inside the extraction folder while a folder on the way is
// a symlink the archive itself created ("redirect" -> ../outside): removing
// "redirect/victim.txt" then deleted a file outside the folder (found by
// archiveBoundary.test.js). The real path of the member's folder must be inside the real
// root, and only a file or link is removed, never what a link points to.
const fs = require('fs');
const path = require('path');

function removeInside(root, rel, fileSystem = fs) {
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  if (!target.startsWith(base + path.sep)) return false;
  let realRoot, realParent;
  try { realRoot = fileSystem.realpathSync(base); realParent = fileSystem.realpathSync(path.dirname(target)); } catch { return false; }
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) return false;
  let st;
  try { st = fileSystem.lstatSync(target); } catch { return false; }
  if (st.isDirectory()) return false;
  try { fileSystem.rmSync(target, { force: true }); return true; } catch { return false; }
}

module.exports = { removeInside };
