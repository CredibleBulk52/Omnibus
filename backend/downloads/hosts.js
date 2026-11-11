'use strict';
// ─── File hosts: Pixeldrain, MediaFire, MEGA, and the one entry point for them ─
// Moved out of server.js unchanged (2026-11-04, downloads stage 2). Progress and
// cancellation go through the server's download list (pushDownloadUpdate/Progress,
// isCancelled); stallGuard comes from ./retryPolicy.js.
module.exports.createHostDownloaders = function createHostDownloaders({ axios, logger, fs, stallGuard, isCancelled, pushDownloadUpdate, pushDownloadProgress }) {

// GetComics /dls/ links can redirect (on GET only) to a Pixeldrain page.
// Probe the link: returns a pixeldrain.com/u/<id> URL to download through the
// API, null for an ordinary file, or throws for any other web page.
async function pixeldrainBehind(url, headers = {}) {
  const ac = new AbortController();
  const r = await axios.get(url, { headers, responseType: 'stream', timeout: 60000, signal: ac.signal });
  const finalUrl = r.request?.res?.responseUrl || url;
  const direct = finalUrl.match(/https?:\/\/(?:www\.)?pixeldrain\.(?:com|net)\/u\/[A-Za-z0-9]+/i)?.[0];
  if (direct) { ac.abort(); r.data.destroy(); return direct; }
  if (!/text\/html/i.test(String(r.headers['content-type'] || ''))) { ac.abort(); r.data.destroy(); return null; }
  const page = await new Promise((resolve, reject) => {
    let text = '';
    r.data.on('data', chunk => { text += chunk.toString('utf8'); if (text.length > 512 * 1024) { r.data.destroy(); resolve(text); } });
    r.data.on('end', () => resolve(text)); r.data.on('close', () => resolve(text)); r.data.on('error', reject);
  });
  const id = page.match(/pixeldrain\.(?:com|net)\/(?:u|api\/file)\/([A-Za-z0-9]+)/i)?.[1];
  if (!id) throw new Error(`Download host returned a web page instead of the file (${new URL(finalUrl).hostname})`);
  return `https://pixeldrain.com/u/${id}`;
}

// ─── Pixeldrain downloader ───────────────────────────────────────
async function downloadPixeldrain(url, destPath, dlEntry) {
  const fileId = url.match(/pixeldrain\.com\/u\/([a-zA-Z0-9]+)/)?.[1];
  if (!fileId) throw new Error(`Cannot extract Pixeldrain file ID from: ${url}`);
  const apiUrl = `https://pixeldrain.com/api/file/${fileId}`;
  logger.info('getcomics', `Pixeldrain: downloading ${fileId}`);
  const r = await axios.get(apiUrl, {
    responseType: 'stream', timeout: 0,
    headers: { 'Referer': 'https://pixeldrain.com/' },
  });
  const cd = r.headers['content-disposition'] || '';
  const cdM = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
  if (cdM) {
    const n = decodeURIComponent(cdM[1].trim().replace(/["']/g, ''));
    if (n) destPath = require('path').join(require('path').dirname(destPath), n.replace(/[^a-zA-Z0-9._\-() ]/g, '_'));
  }
  const totalBytes = parseInt(r.headers['content-length'] || '0', 10);
  if (dlEntry) { dlEntry.totalBytes = totalBytes; pushDownloadUpdate({ ...dlEntry }); }
  await new Promise((resolve, reject) => {
    const w = require('fs').createWriteStream(destPath);
    r.data.on('data', chunk => { if (dlEntry) { dlEntry.bytesReceived += chunk.length; pushDownloadProgress(dlEntry); } });
    stallGuard(r.data);
    r.data.pipe(w);
    w.on('finish', resolve);
    w.on('error', reject);
    r.data.on('error', reject);
  });
  return destPath;
}

// ─── MediaFire downloader ─────────────────────────────────────────
async function downloadMediaFire(url, destPath, dlEntry) {
  // MediaFire has two URL shapes on GetComics:
  //   /file/<quickkey>/<name>        — single file, old behaviour
  //   /folder/<folderkey>/<name>     — whole folder of files (common on packs)
  // Route to the right handler based on path.
  if (/\/folder\//i.test(url)) {
    return downloadMediaFireFolder(url, destPath, dlEntry);
  }
  return downloadMediaFireFile(url, destPath, dlEntry);
}

async function downloadMediaFireFile(url, destPath, dlEntry) {
  logger.info('getcomics', `MediaFire: fetching page`, { url });
  const pageResp = await axios.get(url, {
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  const html = pageResp.data;
  const dlMatch = /href="(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/.exec(html) ||
                  /<a[^>]+(?:aria-label="Download file"|id="downloadButton")[^>]+href="([^"]+)"/.exec(html) ||
                  /<a[^>]+href="([^"]+)"[^>]+(?:aria-label="Download file"|id="downloadButton")/.exec(html);
  if (!dlMatch) throw new Error('Could not find MediaFire direct download link');
  const directUrl = dlMatch[1];
  logger.info('getcomics', `MediaFire: direct URL`, { directUrl });
  const r = await axios.get(directUrl, {
    responseType: 'stream', timeout: 0,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': url,
    },
  });
  const cd = r.headers['content-disposition'] || '';
  const cdM = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
  if (cdM) {
    const n = decodeURIComponent(cdM[1].trim().replace(/["']/g, ''));
    if (n) destPath = require('path').join(require('path').dirname(destPath), n.replace(/[^a-zA-Z0-9._\-() ]/g, '_'));
  }
  const totalBytes = parseInt(r.headers['content-length'] || '0', 10);
  if (dlEntry) { dlEntry.totalBytes = totalBytes; pushDownloadUpdate({ ...dlEntry }); }
  await new Promise((resolve, reject) => {
    const w = require('fs').createWriteStream(destPath);
    r.data.on('data', chunk => { if (dlEntry) { dlEntry.bytesReceived += chunk.length; pushDownloadProgress(dlEntry); } });
    stallGuard(r.data);
    r.data.pipe(w);
    w.on('finish', resolve);
    w.on('error', reject);
    r.data.on('error', reject);
  });
  return destPath;
}

/**
 * Download every file in a public MediaFire folder into a directory and return
 * the directory path. The pack post-processor already knows how to scan a
 * directory (added earlier for SAB unpacked folders), so returning a directory
 * is the simplest hand-off: no zipping needed.
 *
 * Uses MediaFire's public /api/1.5/folder/get_content.php endpoint — no session
 * token required for public folders. Paginates via chunk= if there are more
 * files than chunk_size (default 100).
 *
 * For each file, we call get_links to get a direct_download URL. Alternatively
 * we could call downloadMediaFireFile() per-file, but that's 2 HTTP calls per
 * file (HTML scrape + download); get_links is 1 API call per batch.
 *
 * The dlEntry progress reporting matches the regular DDL toast contract:
 *  - bytesReceived / totalBytes show overall folder progress
 *  - filename is updated to "Folder name (file N of M)" so the toast reflects
 *    which file is currently in flight
 *  - updates are throttled to ~500ms to avoid flooding SSE clients
 */
async function downloadMediaFireFolder(url, destPath, dlEntry) {
  const path = require('path');
  const fs   = require('fs');

  // Throttled push — caps update frequency regardless of chunk arrival rate.
  // This matches what the regular pack download does implicitly by pushing
  // per-chunk; for folders (many files, each much smaller than a pack) the
  // per-chunk rate is high enough to flood SSE clients without throttling.
  let lastPushAt = 0;
  const PROGRESS_PUSH_MS = 500;
  const throttledPush = (force = false) => {
    if (!dlEntry) return;
    const now = Date.now();
    if (force || now - lastPushAt >= PROGRESS_PUSH_MS) {
      lastPushAt = now;
      pushDownloadUpdate({ ...dlEntry });
    }
  };

  // Extract folder key from URL: /folder/<key>/<optional name>
  const keyMatch = /\/folder\/([^/?#]+)/i.exec(url);
  if (!keyMatch) throw new Error(`Could not extract folder key from ${url}`);
  const folderKey = keyMatch[1];

  // Use the URL's slug as the directory name, or fall back to the folder key.
  // Sanitize for filesystem.
  const slugMatch = /\/folder\/[^/?#]+\/([^?#]+)/i.exec(url);
  const rawName = slugMatch ? decodeURIComponent(slugMatch[1].replace(/\+/g, ' ')) : `mediafire-${folderKey}`;
  const folderName = rawName.replace(/[^a-zA-Z0-9._\-() ]/g, '_').trim() || `mediafire-${folderKey}`;

  // destPath was originally a single file path — redirect to a sibling directory
  const outDir = path.join(path.dirname(destPath), folderName);
  fs.mkdirSync(outDir, { recursive: true });
  logger.info('getcomics', `MediaFire folder: ${folderKey} -> ${outDir}`);

  // Update toast label from the auto-derived URL filename to the real folder name
  if (dlEntry) {
    dlEntry.filename = folderName;
    throttledPush(true);
  }

  // ── Step 1: enumerate files via folder/get_content ─────────────
  const API_BASE = 'https://www.mediafire.com/api/1.5';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

  const files = [];
  let chunk = 1;
  while (true) {
    const listResp = await axios.get(`${API_BASE}/folder/get_content.php`, {
      params: {
        folder_key: folderKey,
        content_type: 'files',
        chunk,
        chunk_size: 100,
        response_format: 'json',
      },
      headers: { 'User-Agent': UA },
      timeout: 20000,
    });
    const body = listResp.data?.response;
    if (!body || body.result !== 'Success') {
      throw new Error(`MediaFire folder list failed: ${body?.message || 'unknown'}`);
    }
    const items = body.folder_content?.files || [];
    for (const f of items) {
      files.push({
        quickkey: f.quickkey,
        name: f.filename,
        size: parseInt(f.size || '0', 10),
      });
    }
    // more_chunks: "yes" | "no"
    if (body.folder_content?.more_chunks !== 'yes') break;
    chunk++;
    if (chunk > 50) {
      logger.warn('getcomics', `MediaFire folder: stopping after 50 chunks (too large?)`, { folderKey });
      break;
    }
  }

  if (!files.length) {
    throw new Error('MediaFire folder is empty or access denied');
  }
  logger.info('getcomics', `MediaFire folder: ${files.length} file(s) to download`);

  // Compute total size for progress reporting
  const grandTotal = files.reduce((s, f) => s + (f.size || 0), 0);
  if (dlEntry) {
    dlEntry.totalBytes = grandTotal;
    throttledPush(true);
  }

  // ── Step 2: get direct links (batched, up to 100 keys per call) ──
  const linkMap = new Map(); // quickkey -> direct_download URL
  for (let i = 0; i < files.length; i += 100) {
    const batch = files.slice(i, i + 100);
    const keys = batch.map(f => f.quickkey).join(',');
    const linksResp = await axios.get(`${API_BASE}/file/get_links.php`, {
      params: {
        link_type: 'direct_download',
        quick_key: keys,
        response_format: 'json',
      },
      headers: { 'User-Agent': UA },
      timeout: 30000,
    });
    const linksBody = linksResp.data?.response;
    if (!linksBody || linksBody.result !== 'Success') {
      throw new Error(`MediaFire get_links failed: ${linksBody?.message || 'unknown'}`);
    }
    const resultLinks = Array.isArray(linksBody.links) ? linksBody.links : [];
    for (const entry of resultLinks) {
      if (entry.quickkey && entry.direct_download) {
        linkMap.set(entry.quickkey, entry.direct_download);
      }
    }
  }

  // Some folders won't return direct links (bandwidth exceeded, password-protected).
  // Fall back to scraping the individual file page for those.
  let fallbackScrapes = 0;

  // ── Step 3: download each file sequentially ───────────────────
  let downloaded = 0;
  // Track bytes logged so we can emit log progress every ~50MB like the regular DDL
  let lastLogAt = 0;

  for (let idx = 0; idx < files.length; idx++) {
    // Cancel check — user clicked ✕ mid-folder. Leave already-downloaded
    // files where they are (they're in outDir, user can keep them) but stop
    // fetching new ones. Throw so the caller catches via pack-level logic.
    if (dlEntry && isCancelled(dlEntry.id)) {
      logger.info('getcomics', `MediaFire folder cancelled by user at file ${idx + 1}/${files.length}`);
      const err = new Error('Cancelled by user');
      err.name = 'CanceledError';
      err.code = 'ERR_CANCELED';
      throw err;
    }
    const file = files[idx];
    const outFile = path.join(outDir, file.name.replace(/[/\\]/g, '_'));

    // Update toast label with current file position so users can see progress
    // through the folder, not just overall bytes.
    if (dlEntry) {
      dlEntry.filename = `${folderName} — file ${idx + 1}/${files.length}: ${file.name}`;
      throttledPush(true);
    }

    let directUrl = linkMap.get(file.quickkey);

    if (!directUrl) {
      // Fall back to per-file HTML scrape
      fallbackScrapes++;
      const filePageUrl = `https://www.mediafire.com/file/${file.quickkey}/${encodeURIComponent(file.name)}`;
      try {
        const pr = await axios.get(filePageUrl, {
          headers: { 'User-Agent': UA },
          timeout: 20000,
        });
        const m = /href="(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/.exec(pr.data);
        if (m) directUrl = m[1];
      } catch {}
      if (!directUrl) {
        logger.warn('getcomics', `MediaFire folder: no direct URL for ${file.name}, skipping`);
        continue;
      }
    }

    const beforeBytes = dlEntry ? dlEntry.bytesReceived : 0;
    // Attach a fresh AbortController for this file so mid-download ✕ works
    // even when we're in the middle of a large file. The cancel endpoint
    // reads dlEntry.abortController and aborts it directly.
    const ac = new AbortController();
    if (dlEntry) dlEntry.abortController = ac;
    try {
      const r = await axios.get(directUrl, {
        responseType: 'stream', timeout: 0,
        signal: ac.signal,
        headers: { 'User-Agent': UA, 'Referer': 'https://www.mediafire.com/' },
      });
      await new Promise((resolve, reject) => {
        const w = fs.createWriteStream(outFile);
        r.data.on('data', chunkBytes => {
          if (dlEntry) {
            dlEntry.bytesReceived += chunkBytes.length;
            throttledPush();
            // Emit a log line every 50MB to match the regular pack DDL logging cadence
            if (dlEntry.bytesReceived - lastLogAt > 50 * 1024 * 1024) {
              lastLogAt = dlEntry.bytesReceived;
              const pct = dlEntry.totalBytes ? Math.floor(dlEntry.bytesReceived / dlEntry.totalBytes * 100) : null;
              logger.info('getcomics', `MediaFire folder progress: ${folderName}`,
                { mb: Math.floor(dlEntry.bytesReceived / 1024 / 1024), pct, file: `${idx + 1}/${files.length}` });
            }
          }
        });
        stallGuard(r.data);
        r.data.pipe(w);
        w.on('finish', resolve);
        w.on('error', reject);
        r.data.on('error', reject);
      });
      downloaded++;
    } catch (e) {
      // Cancel propagation: if this failure was triggered by the user
      // clicking ✕, bail out of the whole folder download (don't "continue")
      // and surface the cancel to the caller so it can clean up.
      if (axios.isCancel(e) || (dlEntry && isCancelled(dlEntry.id))) {
        logger.info('getcomics', `MediaFire folder cancelled mid-file (${file.name})`);
        try { fs.unlinkSync(outFile); } catch {}
        const err = new Error('Cancelled by user');
        err.name = 'CanceledError';
        err.code = 'ERR_CANCELED';
        throw err;
      }
      // Non-cancel errors: log and continue — pack processor can still
      // work with a partial folder, user can re-run for missing issues.
      logger.warn('getcomics', `MediaFire folder: ${file.name} failed`, e.message);
      try { fs.unlinkSync(outFile); } catch {}
      // Roll back bytes count so progress doesn't count a failed file
      if (dlEntry) dlEntry.bytesReceived = beforeBytes;
    }
  }

  if (fallbackScrapes > 0) {
    logger.info('getcomics', `MediaFire folder: used page-scrape fallback for ${fallbackScrapes} file(s)`);
  }
  if (downloaded === 0) {
    throw new Error('MediaFire folder: no files could be downloaded (all direct links failed)');
  }
  logger.info('getcomics', `MediaFire folder complete: ${downloaded}/${files.length} files in ${outDir}`);

  // Final label refresh — shows the full folder name without the per-file tail
  if (dlEntry) {
    dlEntry.filename = folderName;
    throttledPush(true);
  }

  // Return the directory — pack post-processor detects directories via
  // statSync and scans them directly.
  return outDir;
}

// ─── Mega downloader ──────────────────────────────────────────────
async function downloadMega(url, destPath, dlEntry) {
  // Mega URLs split into two shapes at the /file/ vs /folder/ path:
  //   https://mega.nz/file/<id>#<key>        single file
  //   https://mega.nz/folder/<id>#<key>      folder (multiple files)
  //   https://mega.nz/#F!<id>!<key>          legacy folder (older share links)
  // All three need the `#<key>` fragment to decrypt attributes. The GC scraper
  // captures fragments (href regex is `[^"]+`), so they survive the round-trip.
  //
  // Route to the right handler based on URL shape. megajs's File.fromURL()
  // technically auto-detects this via the loaded `.directory` flag, but we
  // split early so the folder path can set up a separate output directory
  // and per-file progress reporting.
  const isFolder = /\/folder\//i.test(url) || /#F!/.test(url);
  if (isFolder) return downloadMegaFolder(url, destPath, dlEntry);
  return downloadMegaFile(url, destPath, dlEntry);
}

async function downloadMegaFile(url, destPath, dlEntry) {
  let mega;
  try { mega = require('megajs'); } catch {
    throw new Error('megajs not installed — add to package.json and rebuild');
  }
  logger.info('getcomics', `Mega: downloading`, { url });
  const file = mega.File.fromURL(url);
  await file.loadAttributes();
  const filename = (file.name || `mega-${Date.now()}.cbz`).replace(/[^a-zA-Z0-9._\-() ]/g, '_');
  destPath = require('path').join(require('path').dirname(destPath), filename);
  if (dlEntry) { dlEntry.totalBytes = file.size || 0; dlEntry.filename = filename; pushDownloadUpdate({ ...dlEntry }); }
  logger.info('getcomics', `Mega: file="${file.name}" size=${file.size}`);
  await new Promise((resolve, reject) => {
    const download = file.download();
    const w = require('fs').createWriteStream(destPath);
    download.on('data', chunk => { if (dlEntry) { dlEntry.bytesReceived += chunk.length; pushDownloadProgress(dlEntry); } });
    download.on('error', reject);
    w.on('error', reject);
    w.on('finish', resolve);
    stallGuard(download);
    download.pipe(w);
  });
  return destPath;
}

/**
 * Download every file in a public Mega folder into a directory and return
 * the directory path — same contract as downloadMediaFireFolder.
 *
 * megajs handles the crypto: File.fromURL() on a folder URL gives us a
 * directory-typed File, and after loadAttributes() the .children array
 * contains sub-entries (files and potentially sub-folders).
 *
 * We flatten sub-folders (recursively collect all files into one list) and
 * drop them into a single output directory. The vast majority of Mega
 * folders shared on GC are flat comic dumps; nested structure is rare and
 * flattening is simpler than preserving it for pack post-processing, which
 * doesn't care about directory hierarchy anyway.
 */
async function downloadMegaFolder(url, destPath, dlEntry) {
  let mega;
  try { mega = require('megajs'); } catch {
    throw new Error('megajs not installed — add to package.json and rebuild');
  }
  const path = require('path');
  const fs   = require('fs');

  // Throttled SSE push — see downloadMediaFireFolder for rationale.
  let lastPushAt = 0;
  const PROGRESS_PUSH_MS = 500;
  const throttledPush = (force = false) => {
    if (!dlEntry) return;
    const now = Date.now();
    if (force || now - lastPushAt >= PROGRESS_PUSH_MS) {
      lastPushAt = now;
      pushDownloadUpdate({ ...dlEntry });
    }
  };

  logger.info('getcomics', `Mega folder: loading`, { url });

  // Load the folder's root node. Without `.loadAttributes()` we have no children.
  const root = mega.File.fromURL(url);
  await root.loadAttributes();

  if (!root.directory) {
    throw new Error('Mega URL resolved to a file, not a folder — unexpected');
  }

  // Recursively walk the folder, collecting leaf files only.
  const files = [];
  const walk = (node) => {
    if (!node) return;
    if (node.directory) {
      for (const child of (node.children || [])) walk(child);
    } else {
      files.push(node);
    }
  };
  walk(root);

  if (!files.length) {
    throw new Error('Mega folder is empty');
  }

  // Output directory: based on the root folder name, sibling to the destPath
  const folderName = (root.name || `mega-folder-${Date.now()}`).replace(/[^a-zA-Z0-9._\-() ]/g, '_').trim()
                     || `mega-folder-${Date.now()}`;
  const outDir = path.join(path.dirname(destPath), folderName);
  fs.mkdirSync(outDir, { recursive: true });
  logger.info('getcomics', `Mega folder: ${files.length} file(s) -> ${outDir}`);

  // Set up toast initial state
  const grandTotal = files.reduce((s, f) => s + (f.size || 0), 0);
  if (dlEntry) {
    dlEntry.totalBytes = grandTotal;
    dlEntry.filename = folderName;
    throttledPush(true);
  }

  let lastLogAt  = 0;
  let downloaded = 0;

  for (let idx = 0; idx < files.length; idx++) {
    // Between-file cancel check
    if (dlEntry && isCancelled(dlEntry.id)) {
      logger.info('getcomics', `Mega folder cancelled by user at file ${idx + 1}/${files.length}`);
      const err = new Error('Cancelled by user');
      err.name = 'CanceledError';
      err.code = 'ERR_CANCELED';
      throw err;
    }
    const file = files[idx];
    const safeName = (file.name || `file-${idx}.bin`).replace(/[/\\]/g, '_');
    const outFile  = path.join(outDir, safeName);

    if (dlEntry) {
      dlEntry.filename = `${folderName} — file ${idx + 1}/${files.length}: ${safeName}`;
      throttledPush(true);
    }

    const beforeBytes = dlEntry ? dlEntry.bytesReceived : 0;
    try {
      await new Promise((resolve, reject) => {
        const download = file.download();
        const w = fs.createWriteStream(outFile);
        // Expose stream on dlEntry so the cancel endpoint can destroy it
        // mid-download. Unlike axios streams (which use AbortController), the
        // megajs stream has to be torn down directly. Store it under a
        // differently-named field so the cancel endpoint can find it.
        if (dlEntry) {
          dlEntry.abortController = { abort: () => { try { download.destroy(new Error('Cancelled by user')); } catch {} } };
        }
        download.on('data', chunk => {
          if (dlEntry) {
            // In-stream cancel check — destroys the stream which triggers
            // the 'error' handler below with our 'Cancelled by user' error.
            if (isCancelled(dlEntry.id)) {
              try { download.destroy(new Error('Cancelled by user')); } catch {}
              return;
            }
            dlEntry.bytesReceived += chunk.length;
            throttledPush();
            if (dlEntry.bytesReceived - lastLogAt > 50 * 1024 * 1024) {
              lastLogAt = dlEntry.bytesReceived;
              const pct = dlEntry.totalBytes ? Math.floor(dlEntry.bytesReceived / dlEntry.totalBytes * 100) : null;
              logger.info('getcomics', `Mega folder progress: ${folderName}`,
                { mb: Math.floor(dlEntry.bytesReceived / 1024 / 1024), pct, file: `${idx + 1}/${files.length}` });
            }
          }
        });
        download.on('error', reject);
        w.on('error', reject);
        w.on('finish', resolve);
        stallGuard(download);
        download.pipe(w);
      });
      downloaded++;
    } catch (e) {
      // Cancel propagation — same pattern as MediaFire folder
      if ((dlEntry && isCancelled(dlEntry.id)) || /Cancelled by user/i.test(e.message || '')) {
        logger.info('getcomics', `Mega folder cancelled mid-file (${safeName})`);
        try { fs.unlinkSync(outFile); } catch {}
        const err = new Error('Cancelled by user');
        err.name = 'CanceledError';
        err.code = 'ERR_CANCELED';
        throw err;
      }
      logger.warn('getcomics', `Mega folder: ${safeName} failed`, e.message);
      try { fs.unlinkSync(outFile); } catch {}
      if (dlEntry) dlEntry.bytesReceived = beforeBytes;
    }
  }

  if (downloaded === 0) {
    throw new Error('Mega folder: no files could be downloaded');
  }
  logger.info('getcomics', `Mega folder complete: ${downloaded}/${files.length} files in ${outDir}`);

  if (dlEntry) {
    dlEntry.filename = folderName;
    throttledPush(true);
  }

  return outDir;
}

// ─── Unified third-party downloader ──────────────────────────────
// What a downloaded file really is, from its first bytes: 'zip' | 'rar' | '7z'
// | 'pdf' | 'html' | null. Hosts sometimes answer a file link with a web page
// (a MEGA landing page, a login or error page); that must never be treated as
// a finished download.
function sniffDownload(filePath) {
  let buf = Buffer.alloc(0);
  try { const fd = fs.openSync(filePath, 'r'); buf = Buffer.alloc(512); const n = fs.readSync(fd, buf, 0, 512, 0); fs.closeSync(fd); buf = buf.subarray(0, n); }
  catch { return null; }
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';
  if (buf.subarray(0, 4).toString('latin1') === 'Rar!') return 'rar';
  if (buf.length >= 6 && buf[0] === 0x37 && buf[1] === 0x7a && buf[2] === 0xbc && buf[3] === 0xaf) return '7z';
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (/^\s*<(?:!doctype|html|head|\?xml)/i.test(buf.toString('utf8'))) return 'html';
  return null;
}
const THIRD_PARTY_HOST = /pixeldrain\.(?:com|net)|mediafire\.com|mega\.nz/i;

async function downloadThirdParty(url, destPath, dlEntry) {
  if (/pixeldrain\.com/i.test(url)) return downloadPixeldrain(url, destPath, dlEntry);
  if (/mediafire\.com/i.test(url))  return downloadMediaFire(url, destPath, dlEntry);
  if (/mega\.nz/i.test(url))        return downloadMega(url, destPath, dlEntry);
  throw new Error(`No handler for URL: ${url}`);
}

return { pixeldrainBehind, downloadPixeldrain, downloadMediaFire, downloadMega, sniffDownload, THIRD_PARTY_HOST, downloadThirdParty };
};
