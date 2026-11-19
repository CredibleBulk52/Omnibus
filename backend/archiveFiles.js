'use strict';
// ─── Archive files (moved out of server.js 2026-11-19, server.js split step 4) ───
// List an archive's members (7z for CBZ/ZIP; unrar, then 7z and bsdtar for CBR/RAR), read one
// member as a Buffer (with the fallbacks between tools), and keep only real image pages.
// Moved unchanged. server.js wraps listArchiveFiles for library reads once the file has loaded.
const path = require('path');

module.exports.createArchiveFiles = function createArchiveFiles(deps) {
  const missing = ['execFileAsync', 'logger'].filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createArchiveFiles: missing ${missing.join(', ')}`);
  const { execFileAsync, logger } = deps;

  // List all files inside an archive
  async function listArchiveFiles(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    try {
      if (ext === '.cbz' || ext === '.zip') {
        // Use 7z l for CBZ — outputs literal filenames, handles brackets/special chars
        const { stdout } = await execFileAsync('7z', ['l', '-ba', '-slt', filePath]);
        // 7z -slt outputs "Path = filename" lines
        const files = [];
        for (const line of stdout.split('\n')) {
          const m = line.match(/^Path = (.+)$/);
          if (m) files.push(m[1].trim());
        }
        return files;
      } else {
        // CBR/RAR — use unrar (RARLab binary) which handles all RAR variants
        // including older files with non-UTF8 filenames that bsdtar cannot parse
        // unrar lb = list bare filenames only
        // unrar exits 3 on some old Mac-made RARs (unsupported sub-blocks) after
        // listing every member (Fantastic Four #107, 2026-10-16): keep that list.
        let listed = '';
        try { ({ stdout: listed } = await execFileAsync('unrar', ['lb', filePath], { maxBuffer: 16 * 1024 * 1024 })); }
        catch (e) { listed = e.stdout ? String(e.stdout) : ''; }
        const rarFiles = String(listed).split('\n').map(s => s.trim()).filter(Boolean);
        if (rarFiles.length > 0) return rarFiles;
        // unrar returned empty — may be a ZIP misnamed as CBR, fall through
        // Fallback: try as ZIP (some CBRs are actually ZIP archives)
        try {
          const { stdout } = await execFileAsync('7z', ['l', '-ba', '-slt', filePath]);
          const files = [];
          for (const line of stdout.split('\n')) {
            const m = line.match(/^Path = (.+)$/);
            if (m) files.push(m[1].trim());
          }
          if (files.length > 0) {
            logger.debug('thumb', `CBR is actually a ZIP: ${path.basename(filePath)}`);
            return files;
          }
        } catch {}
        try {
          const { stdout } = await execFileAsync('bsdtar', ['-tf', filePath], { maxBuffer: 16 * 1024 * 1024 });
          return stdout.split('\n').map(s => s.replace(/\r$/, '')).filter(Boolean);
        } catch {}
        return [];
      }
    } catch { return []; }
  }

  // ─── One archive member as a Buffer ───────────────────────────────
  // Reader pages, page thumbnails, cover thumbnails and Comic Book Guy's page view.
  // - Member names go after "--": "-= cover =-.jpg" was read as a command switch
  //   (Fantastic Four #104, 2026-10-16).
  // - unrar exits 3 on some old Mac-made RARs (unsupported sub-blocks) after writing
  //   the page correctly (Fantastic Four #107): output that is a complete image is kept.
  function completeImage(buf) {
    if (!buf || buf.length < 64) return false;
    const b = Buffer.from(buf);
    if (b[0] === 0xFF && b[1] === 0xD8) return b.subarray(Math.max(0, b.length - 2048)).includes(Buffer.from([0xFF, 0xD9]));
    if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return b.subarray(-16).includes(Buffer.from('IEND'));
    if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return b.readUInt32LE(4) + 8 <= b.length;
    if (b.subarray(0, 3).toString('latin1') === 'GIF') return b[b.length - 1] === 0x3B;
    return false;
  }
  async function readArchiveMember(filePath, member, maxBuffer = 30 * 1024 * 1024) {
    const zip = /\.(cbz|zip)$/i.test(filePath);
    const C = { ...process.env, LANG: 'C', LC_ALL: 'C' };
    const unrar = ['unrar', ['p', '-inul', '-y', filePath, '--', member]];
    const sevenZip = ['7z', ['e', '-so', filePath, '--', member]];
    const tar = ['bsdtar', ['-p', '-O', '-xf', filePath, '--', member.replace(/[\\*?[\]]/g, '\\$&')], C];   // bsdtar names are patterns
    let last = null;
    for (const [tool, args, env] of zip ? [sevenZip, tar, unrar] : [unrar, sevenZip, tar]) {
      try {
        const { stdout } = await execFileAsync(tool, args, { maxBuffer, encoding: 'buffer', ...(env ? { env } : {}) });
        if (stdout && stdout.length) return stdout;
      } catch (e) {
        if (e.stdout && completeImage(e.stdout)) return Buffer.from(e.stdout);
        last = e;
      }
    }
    throw last || new Error(`Archive member not found: ${member}`);
  }

  // Filter an archive file list to real image files only.
  // Excludes Apple double files (__MACOSX, ._prefix) and non-image entries.
  function filterImages(files) {
    return files.filter(f =>
      /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(f) &&
      !f.includes('__MACOSX') &&
      !path.basename(f).startsWith('._')
    ).sort();
  }

  return { listArchiveFiles, completeImage, readArchiveMember, filterImages };
};
