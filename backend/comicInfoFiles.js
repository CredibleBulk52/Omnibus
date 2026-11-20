'use strict';
// ─── ComicInfo in archives (moved out of server.js 2026-11-19, server.js split step 6a) ───
// Reading ComicInfo.xml from a comic archive (ZIP directly with yauzl, RAR with unrar, any folder and
// capitalisation, the file's real format tried when the extension is wrong; bsdtar as a last
// resort), whether an archive holds one, and parsing it (plain fields; the Comic Vine issue id).
// Moved unchanged. server.js wraps extractComicInfo for library reads once the file has loaded.
const path = require('path');

const COMICINFO_RE = /(^|[\/\\])comicinfo\.xml$/i;
const COMICINFO_MAX = 4 * 1024 * 1024;

// Parse ComicInfo.xml text into a plain object
function parseComicInfo(xmlText) {
  if (!xmlText) return {};
  try {
    const get = (tag) => { const m = xmlText.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : null; };
    return {
      title:         get('Title'),
      series:        get('Series'),
      number:        get('Number'),
      volume:        get('Volume'),
      year:          get('Year') ? parseInt(get('Year')) : null,
      publisher:     get('Publisher'),
      writer:        get('Writer'),
      penciller:     get('Penciller'),
      inker:         get('Inker'),
      colorist:      get('Colorist'),
      coverArtist:   get('CoverArtist'),
      characters:    get('Characters'),
      summary:       get('Summary'),
      genre:         get('Genre'),
      pageCount:     get('PageCount') ? parseInt(get('PageCount')) : null,
      web:           get('Web'),
      // Omnibus's own <StoreDate> (on-sale day, YYYY-MM-DD; backend/storeDate.js), 2026-11-19.
      storeDate:     require('./storeDate').storeDateFromComicInfo(xmlText),
    };
  } catch { return {}; }
}

// Extract CV issue ID from ComicInfo XML text
// Checks <Web> URL (4000-NNNNN) then <Notes> field ([Issue ID NNNNN])
function extractCvIdFromComicInfo(xmlText) {
  return require('./metadata/evidence').parseComicInfoEvidence(xmlText).identity.cvIssueId;
}

module.exports.COMICINFO_RE = COMICINFO_RE;
module.exports.COMICINFO_MAX = COMICINFO_MAX;
module.exports.parseComicInfo = parseComicInfo;
module.exports.extractCvIdFromComicInfo = extractCvIdFromComicInfo;

module.exports.createComicInfoFiles = function createComicInfoFiles(deps) {
  const missing = ['execFileAsync', 'listArchiveFiles'].filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createComicInfoFiles: missing ${missing.join(', ')}`);
  const { execFileAsync, listArchiveFiles } = deps;

  // Extract ComicInfo.xml text from a comic archive using bsdtar
  // Read ComicInfo.xml from a comic archive.
  // Returns the XML text, '' when the archive was read but has no ComicInfo.xml,
  // or null when no tool could open the file (so it's retried later).
  //
  // The old version asked bsdtar for a top-level "ComicInfo.xml" only, and threw
  // away the output whenever bsdtar exited non-zero — which it does on harmless
  // warnings about other entries' filenames. On 2026-10-08 that missed the tags in
  // 935 of 1,874 files that had them. Now: ZIPs are read directly (yauzl), RARs
  // with unrar, matching ComicInfo.xml in any folder and any capitalisation; the
  // file's real format is tried even when the extension is wrong (.cbz that's RAR).

  function readZipComicInfo(filePath) {
    return new Promise(resolve => {
      let yauzl;
      try { yauzl = require('yauzl'); } catch { return resolve(null); }
      yauzl.open(filePath, { lazyEntries: true }, (err, zip) => {
        if (err || !zip) return resolve(null);
        let done = false;
        let result = null;
        // Reading the last XML byte is not the end of the file consumer. The
        // access barrier must also wait for yauzl to release its descriptor.
        zip.once('close', () => { done = true; resolve(result); });
        const finish = v => { if (done) return; done = true; result = v; zip.close(); };
        zip.on('error', () => finish(null));
        // Same rule as the metadata pipeline: the top-level ComicInfo.xml wins;
        // an empty top-level file falls back to the one non-empty nested copy.
        const found = [];
        zip.on('end', () => {
          const root = found.filter(f => !/[\/\\]/.test(f.name)), filled = found.filter(f => f.text.trim());
          if (!found.length) return finish('');
          if (root.length === 1 && root[0].text.trim()) return finish(root[0].text);
          if (filled.length === 1 && root.length <= 1) return finish(filled[0].text);
          finish((root[0] || found[0]).text);
        });
        zip.on('entry', entry => {
          if (/\/$/.test(entry.fileName) || !COMICINFO_RE.test(entry.fileName)) return zip.readEntry();
          zip.openReadStream(entry, (e2, stream) => {
            if (e2 || !stream) return finish(null);
            const chunks = []; let size = 0;
            stream.on('data', c => {
              size += c.length;
              if (size > COMICINFO_MAX) { stream.destroy(); finish(null); } else chunks.push(c);
            });
            stream.on('end', () => { found.push({ name: entry.fileName, text: Buffer.concat(chunks).toString('utf8') }); zip.readEntry(); });
            stream.on('error', () => finish(null));
          });
        });
        zip.readEntry();
      });
    });
  }

  async function readRarComicInfo(filePath) {
    const opts = { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LANG: 'C', LC_ALL: 'C' } };
    let list;
    try { ({ stdout: list } = await execFileAsync('unrar', ['lb', filePath], opts)); }
    catch (e) { list = e.stdout || ''; }
    if (!list) return null;
    const member = list.split(/\r?\n/).map(l => l.trim()).find(l => COMICINFO_RE.test(l));
    if (!member) return '';
    try {
      const { stdout } = await execFileAsync('unrar', ['p', '-inul', filePath, '--', member], { ...opts, encoding: 'buffer' });
      return stdout.length ? stdout.toString('utf8') : null;
    } catch (e) {
      return e.stdout && e.stdout.length ? Buffer.from(e.stdout).toString('utf8') : null;
    }
  }

  async function extractComicInfo(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const order = (ext === '.cbr' || ext === '.rar')
      ? [readRarComicInfo, readZipComicInfo]
      : [readZipComicInfo, readRarComicInfo];
    for (const reader of order) {
      try {
        const xml = await reader(filePath);
        if (xml !== null) return xml;        // opened: XML text, or '' for "no ComicInfo"
      } catch { /* try the next reader */ }
    }
    // Last resort for other archive types (7z, tar): the original bsdtar call,
    // keeping its output even when it exits non-zero on warnings.
    try {
      const { stdout } = await execFileAsync('bsdtar', ['-p', '-O', '-xf', filePath, 'ComicInfo.xml'], { maxBuffer: COMICINFO_MAX, env: { ...process.env, LANG: 'C', LC_ALL: 'C' } });
      return stdout || null;
    } catch (e) { return e.stdout || null; }
  }

  // Returns true if the archive at filePath contains a ComicInfo.xml entry at the
  // root or anywhere inside. Returns null if the archive can't be read — callers
  // should treat null as "unknown" and not flip an existing value.
  async function archiveHasComicInfo(filePath) {
    try {
      const files = await listArchiveFiles(filePath);
      if (!files || files.length === 0) return null;
      // Match "ComicInfo.xml" case-insensitively, at root or nested.
      return files.some(f => /(^|[\\/])ComicInfo\.xml$/i.test(f));
    } catch {
      return null;
    }
  }

  return { readZipComicInfo, readRarComicInfo, extractComicInfo, archiveHasComicInfo };
};
