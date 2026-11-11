'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const zlib = require('node:zlib');
const { removeInside } = require('./removeInside');

// Extracted toolchain, not a second converter. Legacy callers retain their
// original XML handling, flattening and fallback order. Validated staging uses
// the same tools with explicit path preservation and an isolated attempt dir.
function createArchiveTools({ run = promisify(execFile), fileSystem = fs } = {}) {
  // level 0 = store only: used for the private RAR comparison copy, which is
  // never published. Published CBZs keep the existing -mx=6.
  async function buildCbzFromDirectory(srcDir, destPath, { level = 6 } = {}) {
    await run('7z', ['a', '-tzip', `-mx=${level === 0 ? 0 : 6}`, destPath, path.join(srcDir, '*')], { maxBuffer: 100 * 1024 * 1024 });
  }
  async function createCbzFromDir(srcDir, destPath, comicInfoXml) {
    fileSystem.writeFileSync(path.join(srcDir, 'ComicInfo.xml'), comicInfoXml, 'utf8');
    try {
      for (const f of fileSystem.readdirSync(srcDir)) {
        if (f === '__MACOSX' || f.startsWith('._')) {
          try { fileSystem.unlinkSync(path.join(srcDir, f)); } catch {}
        }
      }
    } catch {}
    await buildCbzFromDirectory(srcDir, destPath);
  }
  // Damaged-archive support. A RAR member whose data is bad stops every tool
  // on the whole archive, and bsdtar 3.6 under LANG=C can drop that member
  // from its listing and extraction without an error (Excalibur #75,
  // 2026-10-15). So members are listed with unrar first (the RARLab binary in
  // the image), then bsdtar in the normal locale, then bsdtar under C.
  const C = { ...process.env, LANG: 'C', LC_ALL: 'C' };
  const STOP = ['ABORT_ERR', 'ARCHIVE_CANCELLED', 'ARCHIVE_TIMEOUT', 'ARCHIVE_OUTPUT_LIMIT'];
  const BIG = 16 * 1024 * 1024;
  const pattern = name => name.replace(/[\\*?[\]]/g, ch => '\\' + ch);   // bsdtar names are patterns
  const lines = out => String(out || '').split('\n').map(n => n.replace(/\r$/, '').replace(/\\/g, '/')).filter(Boolean);
  // RAR 1.5-4.x member names straight from the file headers (the archive's own
  // table, which no tool's error handling can shorten). null for RAR5, Unicode
  // names (decoded differently by each tool) or anything unexpected.
  function rar4Names(source) { return rar4Entries(source)?.map(e => e.name) || null; }
  // Same walk, with each member's unpacked size and CRC32.
  function rar4Entries(source) {
    let data;
    try { data = fileSystem.readFileSync(source); } catch { return null; }
    if (data.length < 7 || data.subarray(0, 7).toString('latin1') !== 'Rar!\x1a\x07\x00') return null;
    const names = [];
    let i = 7;
    while (i + 7 <= data.length) {
      const type = data[i + 2], flags = data.readUInt16LE(i + 3), size = data.readUInt16LE(i + 5);
      if (size < 7) return null;
      if (type === 0x74) {
        if (i + 32 > data.length) return null;
        const pack = data.readUInt32LE(i + 7), nameSize = data.readUInt16LE(i + 26);
        if (flags & 0x200) return null;                       // Unicode name
        if (flags & 0x100) return null;                       // >4 GB member: not a comic page
        const name = data.subarray(i + 32, i + 32 + nameSize).toString('latin1').replace(/\\/g, '/');
        const dir = (flags & 0xe0) === 0xe0;
        names.push({ name: dir ? name + '/' : name, dir, size: data.readUInt32LE(i + 11), crc: data.readUInt32LE(i + 16) >>> 0 });
        i += size + pack;
      } else if (type === 0x7b) break;                        // end of archive
      else i += size + ((flags & 0x8000) && i + 11 <= data.length ? data.readUInt32LE(i + 7) : 0);
    }
    return names.length ? names : null;
  }
  // unrar exits 3 on some old Mac-made RAR files (unsupported sub-blocks) after
  // extracting every member correctly (Fantastic Four #107, 2026-10-16). That
  // extraction counts only when every member's size and CRC32 match the
  // archive's own headers.
  const crc32 = typeof zlib.crc32 === 'function' ? buf => zlib.crc32(buf) >>> 0 : (() => {
    const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    return buf => { let c = 0xFFFFFFFF; for (const byte of buf) c = table[(c ^ byte) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  })();
  function verifiedByCrc(source, directory, preservePaths) {
    const entries = rar4Entries(source);
    if (!entries || !entries.some(e => !e.dir)) return false;
    for (const e of entries) {
      if (e.dir) continue;
      let buf;
      try { buf = fileSystem.readFileSync(path.resolve(directory, preservePaths ? e.name : path.basename(e.name))); } catch { return false; }
      if (buf.length !== e.size || crc32(buf) !== e.crc) return false;
    }
    return true;
  }
  async function listMembers(source, rar) {
    if (rar) { const own = rar4Names(source); if (own) return own; }
    const tries = [...(rar ? [['unrar', ['lb', source], {}]] : []), ['bsdtar', ['-tf', source], {}], ['bsdtar', ['-tf', source], { env: C }]];
    let best = null;
    for (const [tool, args, opts] of tries) {
      try { const names = lines((await run(tool, args, { maxBuffer: BIG, ...opts })).stdout); if (names.length > (best?.length || 0)) best = names; if (tool === 'unrar' && names.length) break; }
      catch (error) { if (STOP.includes(error.code)) throw error; }
    }
    return best && best.length ? best : null;
  }
  // Members (not folders) of `names` that are not on disk under `directory`.
  const stat = (directory, n) => { try { return fileSystem.statSync(path.resolve(directory, n)); } catch { return null; } };
  function fileMembers(names, directory) { return names.filter(n => !n.endsWith('/') && !stat(directory, n)?.isDirectory()); }
  // After every tool failed on the whole archive: read the members one at a
  // time. null when the archive cannot be listed or nothing reads (a broken or
  // unsupported file, not damaged pages). Readable members stay in `directory`.
  async function scanDamage(source, directory, rar) {
    const names = await listMembers(source, rar);
    if (!names) return null;
    const bad = [], root = path.resolve(directory);
    let unrar = rar;
    for (const name of names.filter(n => !n.endsWith('/'))) {
      let ok = false;
      if (unrar) {
        try { await run('unrar', ['x', '-inul', '-y', source, '--', name, directory + '/'], { maxBuffer: BIG }); ok = true; }
        catch (error) { if (STOP.includes(error.code)) throw error; if (error.code === 'ENOENT') unrar = false; }
      }
      if (!unrar && !ok) {
        try { await run('bsdtar', ['-xf', source, '-C', directory, '--', pattern(name)], { env: C, maxBuffer: BIG }); ok = true; }
        catch (error) { if (STOP.includes(error.code)) throw error; }
      }
      const s = stat(directory, name);
      if (s?.isDirectory()) continue;
      if (!ok || !s) {
        bad.push(name);
        // A partly written member must not be kept; never removed through a link the archive made.
        if (path.resolve(directory, name).startsWith(root + path.sep)) removeInside(root, name, fileSystem);
      }
    }
    const files = fileMembers(names, directory).concat(bad.filter(n => !stat(directory, n))).filter((n, i, a) => a.indexOf(n) === i);
    return bad.length && bad.length < files.length ? { names: files, bad } : null;
  }
  function damagedError(scan, cause) {
    const shown = scan.bad.map(n => path.basename(n)).slice(0, 5).join(', ') + (scan.bad.length > 5 ? ', …' : '');
    const ok = scan.names.length - scan.bad.length;
    return Object.assign(new Error(`Damaged archive: ${scan.bad.length} of ${scan.names.length} files cannot be read (${shown}). Replace the file, or use Convert anyway to keep the ${ok} readable file${ok === 1 ? '' : 's'}.`),
      { code: 'ARCHIVE_DAMAGED', damaged: scan.bad, members: scan.names.length, cause });
  }
  async function extractArchive({ source, directory, profile, preservePaths = false, format = null, attemptDirectory, onFallback, salvage = false }) {
    if (!['download', 'retag'].includes(profile) || (format !== null && !['zip', 'rar'].includes(format))) throw new TypeError('Explicit supported extraction profile/format required');
    const rar = format ? format === 'rar' : /\.(cbr|rar)$/i.test(source);
    const tools = rar ? profile === 'retag' ? ['unrar', '7z', 'bsdtar'] : ['unrar', 'bsdtar'] : profile === 'download' ? ['7z', 'bsdtar'] : ['bsdtar'];
    for (let index = 0; index < tools.length; index++) {
      const tool = tools[index], target = attemptDirectory ? await attemptDirectory({ tool, index }) : directory;
      let args, options;
      if (tool === 'unrar') {
        args = [preservePaths ? 'x' : 'e', '-inul', '-y', source, `${target}/`]; options = { maxBuffer: 50 * 1024 * 1024 };
      } else if (tool === '7z') {
        args = [preservePaths ? 'x' : 'e', '-y', '-o' + target, source]; options = { maxBuffer: 50 * 1024 * 1024 };
      } else {
        args = ['-xf', source, '-C', target]; options = { env: { ...process.env, LANG: 'C', LC_ALL: 'C' }, ...(rar ? { maxBuffer: 50 * 1024 * 1024 } : {}) };
      }
      let extracted = false;
      try { await run(tool, args, options); extracted = true; }
      catch (error) {
        if (STOP.includes(error.code)) throw error;
        if (tool === 'unrar' && rar && verifiedByCrc(source, target, preservePaths)) return { directory: target, tool, crcVerified: true };
        if (index === tools.length - 1) {
          // Every tool failed. If only some members are unreadable the file is
          // damaged, not unsupported: say which, and with salvage (an explicit
          // "Convert anyway", RAR only) continue with the readable members.
          if (!preservePaths) throw error;
          const scanDir = attemptDirectory ? await attemptDirectory({ tool: 'scan', index: tools.length }) : directory;
          const scan = await scanDamage(source, scanDir, rar);
          if (!scan) throw error;
          if (salvage && rar) return { directory: scanDir, tool: 'bsdtar-salvage', damaged: scan.bad };
          throw damagedError(scan, error);
        }
        if (onFallback) onFallback({ tool, nextTool: tools[index + 1], error });
      }
      if (extracted) {
        // A tool can skip a damaged RAR member and still exit 0 (bsdtar 3.6
        // under LANG=C did on Excalibur #75). Every listed member must be on
        // disk, or the file is damaged: never publish it short a page silently.
        if (rar && preservePaths) {
          const missing = await membersMissing(source, target);
          if (missing && missing.bad.length) {
            if (salvage) return { directory: target, tool, damaged: missing.bad };
            throw damagedError(missing, null);
          }
        }
        return { directory: target, tool };
      }
    }
  }
  async function membersMissing(source, directory) {
    const names = await listMembers(source, true);
    if (!names) return null;   // unlistable: nothing to compare
    const files = fileMembers(names, directory);
    return { names: files, bad: files.filter(n => !stat(directory, n)) };
  }

  return { buildCbzFromDirectory, createCbzFromDir, extractArchive };
}
module.exports = { createArchiveTools };
