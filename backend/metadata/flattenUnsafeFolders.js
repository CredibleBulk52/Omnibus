'use strict';
// ─── Flatten unsafe folders ───────────────────────────────────────
// A CBZ whose pages sit in a folder with a name the archive validator rejects
// ("Wizard Wolverine 1:2" in Wolverine #0.5, 2026-10-16) is rebuilt with every
// file at the top level before retagging. Only when each file name on its own
// is safe and the names are unique; otherwise nothing changes and the retag
// fails as before, naming the path. Page bytes are verified (SHA-256) before
// the rebuilt file replaces the original, and the original is kept in
// backupDir. The rules mirror archiveValidationCore.js safeName().
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const yauzl = require('yauzl');
const archiver = require('archiver');

const UNSAFE = /[\\\x00-\x1f\x7f:\ufffd]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const okPart = p => !!p && p.length <= 255 && !UNSAFE.test(p) && p !== '.' && p !== '..' && !/[ .]$/.test(p) && !RESERVED.test(p);
const okPath = name => !!name && name.length <= 1024 && !name.startsWith('/') && name.replace(/\/$/, '').split('/').every(okPart);
const MAX_TOTAL = 1024 * 1024 * 1024;
const TIME_LIMIT = 60000;   // a damaged member can stall the inflate stream (Iron Man #249, 2026-10-16)

// Names and types only, from the central directory: no page data is read.
function listNames(file) {
  return withTimeout(new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true, decodeStrings: true }, (error, zip) => {
      if (error) return reject(error);
      const out = [];
      zip.on('error', reject);
      zip.on('end', () => resolve(out));
      zip.on('entry', entry => {
        out.push({ name: entry.fileName, directory: entry.fileName.endsWith('/'), type: (entry.externalFileAttributes >>> 16) & 0xf000 });
        zip.readEntry();
      });
      zip.readEntry();
    });
  }));
}
function withTimeout(promise, ms = TIME_LIMIT) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Archive read timed out'), { code: 'FLATTEN_TIMEOUT' })), ms); })])
    .finally(() => clearTimeout(timer));
}

// Every entry with its SHA-256 (and bytes when keep=true). Time-limited.
function readEntries(file, keep) {
  let zipRef = null;
  return withTimeout(new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      zipRef = zip;
      const out = []; let total = 0, done = false;
      const finish = e => { if (done) return; done = true; zip.close(); e ? reject(e) : resolve(out); };
      zip.on('error', finish);
      zip.on('end', () => finish());
      zip.on('entry', entry => {
        const name = entry.fileName, directory = name.endsWith('/');
        const type = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (directory) { out.push({ name, directory, type }); return zip.readEntry(); }
        total += entry.uncompressedSize;
        if (total > MAX_TOTAL) return finish(Object.assign(new Error('Archive too large to rebuild'), { code: 'FLATTEN_SKIPPED' }));
        zip.openReadStream(entry, (err, stream) => {
          if (err) return finish(err);
          const hash = crypto.createHash('sha256'), chunks = [];
          stream.on('data', c => { hash.update(c); if (keep) chunks.push(c); });
          stream.on('error', finish);
          stream.on('end', () => {
            out.push({ name, directory, type, date: entry.getLastModDate(), sha256: hash.digest('hex'), data: keep ? Buffer.concat(chunks) : null });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  })).catch(error => { try { zipRef?.close(); } catch {} throw error; });
}

// null = nothing to do or not safely fixable; otherwise the file entries to keep.
function plan(entries) {
  const files = entries.filter(e => !e.directory);
  if (!files.length || entries.every(e => okPath(e.name))) return null;
  if (entries.some(e => ![0, 0x8000, 0x4000].includes(e.type))) return null;      // links / special files
  const seen = new Set();
  for (const f of files) {
    const base = f.name.split('/').pop();
    if (!okPart(base)) return null;                                               // an unsafe file name itself
    const key = base.normalize('NFC').toLowerCase();
    if (seen.has(key)) return null;                                               // names would clash
    seen.add(key);
  }
  return files.map(f => ({ ...f, base: f.name.split('/').pop() }));
}

async function writeZip(target, files) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(target, { flags: 'wx', mode: 0o644 });
    const zip = archiver('zip', { store: true });
    output.on('close', resolve); output.on('error', reject); zip.on('error', reject);
    zip.pipe(output);
    for (const f of files) zip.append(f.data, { name: f.base, date: f.date });
    zip.finalize();
  });
}

async function flattenUnsafeFolders(file, { backupDir, logger = null } = {}) {
  if (!/\.cbz$/i.test(file)) return { changed: false };
  // Check the names first (central directory only); read page data only when a
  // rebuild is needed. Any read problem leaves the file for the retag to report.
  let names;
  try { names = await listNames(file); } catch { return { changed: false }; }
  if (!plan(names.map(n => n.directory ? n : { ...n, directory: false }))) return { changed: false };
  let entries, files;
  try { entries = await readEntries(file, true); files = plan(entries); } catch { return { changed: false }; }
  if (!files) return { changed: false };
  const temp = path.join(path.dirname(file), `.omnibus-flatten-${crypto.randomUUID()}.tmp`);
  try {
    await writeZip(temp, files);
    const check = (await readEntries(temp, false)).filter(e => !e.directory);
    const want = new Map(files.map(f => [f.base, f.sha256]));
    if (check.length !== files.length || check.some(e => want.get(e.name) !== e.sha256))
      throw Object.assign(new Error('Rebuilt archive did not match the original pages'), { code: 'FLATTEN_VERIFY_FAILED' });
    let backup = null;
    if (backupDir) {
      fs.mkdirSync(backupDir, { recursive: true });
      backup = path.join(backupDir, `${path.basename(file)}.${Date.now()}.orig`);
      fs.copyFileSync(file, backup);
    }
    fs.renameSync(temp, file);
    const folders = [...new Set(entries.filter(e => !okPath(e.name)).map(e => e.name.split('/')[0]))];
    logger?.info?.('retag', 'Rebuilt archive without unsafe folders', { file: path.basename(file), pages: files.length, folders, backup });
    return { changed: true, files: files.length, folders, backup };
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch {}
  }
}

module.exports = { flattenUnsafeFolders, okPath, plan, listNames };
