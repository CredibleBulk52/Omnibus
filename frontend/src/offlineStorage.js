// offlineStorage.js — OPFS-backed offline comic storage
//
// Key design decisions:
// - Manifest writes are atomic: write to manifest.tmp first, then
//   rename (copy+delete) so a failed write never corrupts manifest.json
// - All read paths fall back to directory scan if manifest is missing/empty
// - isComicOffline checks directory existence as final fallback
// - listOfflineComics shows comics even with corrupt/missing manifest

const OPFS_ROOT_DIR  = 'omnibus';
const MANIFEST_FILE  = 'manifest.json';
const MANIFEST_TMP   = 'manifest.tmp';

export function isOfflineSupported() {
  return (
    'storage' in navigator &&
    'getDirectory' in navigator.storage &&
    typeof window !== 'undefined'
  );
}

async function getRoot() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_ROOT_DIR, { create: true });
}

// ─── Read manifest ────────────────────────────────────────────────
export async function readManifest(root) {
  // Try manifest.json first
  try {
    const fh = await root.getFileHandle(MANIFEST_FILE);
    const file = await fh.getFile();
    if (file.size > 0) {
      const text = await file.text();
      const parsed = JSON.parse(text);
      return parsed;
    }
  } catch {}

  // Try manifest.tmp as fallback (in case last write completed tmp but not rename)
  try {
    const fh = await root.getFileHandle(MANIFEST_TMP);
    const file = await fh.getFile();
    if (file.size > 0) {
      const text = await file.text();
      console.log('[opfs] recovered manifest from .tmp');
      return JSON.parse(text);
    }
  } catch {}

  return {};
}

// ─── Write manifest — atomic via tmp file ────────────────────────
// Writes to manifest.tmp first, verifies it, then copies to manifest.json.
// A crash during write leaves manifest.json intact (still has old data).
export async function writeManifest(root, manifest) {
  const json = JSON.stringify(manifest);
  if (!json || json === 'null') {
    console.warn('[opfs] writeManifest: refusing to write null/empty manifest');
    return;
  }

  const blob = new Blob([json], { type: 'application/json' });

  // Step 1: write to tmp file
  const tmpFh = await root.getFileHandle(MANIFEST_TMP, { create: true });
  const writable = await tmpFh.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (e) {
    try { await writable.abort(); } catch {}
    throw new Error(`manifest tmp write failed: ${e.message}`);
  }

  // Step 2: verify tmp file has content
  const tmpVerify = await tmpFh.getFile();
  if (tmpVerify.size === 0) {
    throw new Error('manifest tmp write produced 0 bytes');
  }

  // Step 3: copy tmp → manifest.json
  const mainFh = await root.getFileHandle(MANIFEST_FILE, { create: true });
  const mainWritable = await mainFh.createWritable();
  try {
    await mainWritable.write(blob); // write same blob again
    await mainWritable.close();
  } catch (e) {
    try { await mainWritable.abort(); } catch {}
    throw new Error(`manifest.json write failed: ${e.message}`);
  }

  // Step 4: verify manifest.json
  const mainVerify = await mainFh.getFile();
  if (mainVerify.size === 0) {
    throw new Error('manifest.json write produced 0 bytes');
  }

  console.log('[opfs] writeManifest: OK,', mainVerify.size, 'bytes,', Object.keys(manifest).length, 'comics');
}

function pageFilename(index) {
  return `page_${String(index).padStart(4, '0')}.jpg`;
}

// ─── Save a comic for offline reading ────────────────────────────
export async function saveComicOffline(bookId, bookMeta, onProgress) {
  if (!isOfflineSupported()) throw new Error('Offline storage not supported');

  const root    = await getRoot();
  const bookDir = await root.getDirectoryHandle(bookId, { create: true });
  const { pageCount, title } = bookMeta;

  for (let i = 0; i < pageCount; i++) {
    // Skip pages already saved (resume support)
    let alreadyExists = false;
    try {
      const fh = await bookDir.getFileHandle(pageFilename(i));
      const f  = await fh.getFile();
      if (f.size > 0) alreadyExists = true;
    } catch {}

    if (!alreadyExists) {
      const token = localStorage.getItem('omnibus_token');
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const resp = await fetch(`/api/books/${bookId}/pages/${i}`, { headers });
      if (!resp.ok) throw new Error(`Page ${i} fetch failed: ${resp.status}`);

      const blob     = await resp.blob();
      const fh       = await bookDir.getFileHandle(pageFilename(i), { create: true });
      const writable = await fh.createWritable();
      try {
        await writable.write(blob);
        await writable.close();
      } catch (e) {
        try { await writable.abort(); } catch {}
        throw e;
      }
    }

    if (onProgress) onProgress(i + 1, pageCount);
  }

  // Tally size
  let sizeBytes = 0;
  for (let i = 0; i < pageCount; i++) {
    try {
      const fh   = await bookDir.getFileHandle(pageFilename(i));
      const file = await fh.getFile();
      sizeBytes += file.size;
    } catch {}
  }

  // Update manifest
  const manifest = await readManifest(root);
  manifest[bookId] = {
    title:       title || bookId,
    pageCount,
    savedAt:     new Date().toISOString(),
    sizeBytes,
    seriesTitle: bookMeta.seriesTitle || null,
    issueNumber: bookMeta.issueNumber || null,
  };
  await writeManifest(root, manifest);
  console.log('[opfs] saved comic', bookId, 'pages:', pageCount);
}

// ─── Repair manifest from OPFS directory contents ─────────────────
export async function repairManifest() {
  if (!isOfflineSupported()) return { repaired: 0 };
  const root     = await getRoot();
  const manifest = {};
  let repaired   = 0;

  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== 'directory') continue;
    let pageCount = 0;
    let sizeBytes = 0;
    for await (const [pname, phandle] of handle.entries()) {
      if (!pname.startsWith('page_')) continue;
      pageCount++;
      try { const f = await phandle.getFile(); sizeBytes += f.size; } catch {}
    }
    if (pageCount > 0) {
      manifest[name] = {
        title: name, pageCount,
        savedAt: new Date().toISOString(),
        sizeBytes, seriesTitle: null, issueNumber: null,
      };
      repaired++;
    }
  }

  await writeManifest(root, manifest);
  return { repaired, manifest };
}

// ─── Remove a saved comic ─────────────────────────────────────────
export async function removeOfflineComic(bookId) {
  if (!isOfflineSupported()) return;
  const root = await getRoot();
  try { await root.removeEntry(bookId, { recursive: true }); } catch {}
  const manifest = await readManifest(root);
  delete manifest[bookId];
  await writeManifest(root, manifest);
}

// ─── Check if a comic is saved offline ───────────────────────────
// Checks manifest first, falls back to directory scan
export async function isComicOffline(bookId) {
  if (!isOfflineSupported()) return false;
  try {
    const root     = await getRoot();
    const manifest = await readManifest(root);
    if (bookId in manifest) return true;
    // Fallback: check directory
    try {
      const dir = await root.getDirectoryHandle(bookId, { create: false });
      for await (const [name] of dir.entries()) {
        if (name.startsWith('page_')) return true;
      }
    } catch {}
    return false;
  } catch { return false; }
}

// ─── Get a page as a blob URL ─────────────────────────────────────
export async function getOfflinePage(bookId, pageIndex) {
  if (!isOfflineSupported()) return null;
  try {
    const root   = await getRoot();
    const dir    = await root.getDirectoryHandle(bookId, { create: false });
    const fh     = await dir.getFileHandle(pageFilename(pageIndex));
    const file   = await fh.getFile();
    return URL.createObjectURL(file);
  } catch { return null; }
}

// ─── List saved comics ────────────────────────────────────────────
// Falls back to OPFS directory scan if manifest is missing/empty
export async function listOfflineComics() {
  if (!isOfflineSupported()) return [];
  try {
    const root     = await getRoot();
    const manifest = await readManifest(root);

    if (Object.keys(manifest).length > 0) {
      return Object.entries(manifest).map(([bookId, meta]) => ({ bookId, ...meta }));
    }

    // Manifest empty — scan OPFS directly
    console.warn('[opfs] manifest empty/missing, scanning OPFS');
    const result = [];
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'directory') continue;
      let pageCount = 0;
      let sizeBytes = 0;
      for await (const [pname, phandle] of handle.entries()) {
        if (!pname.startsWith('page_')) continue;
        pageCount++;
        try { const f = await phandle.getFile(); sizeBytes += f.size; } catch {}
      }
      if (pageCount > 0) {
        result.push({ bookId: name, title: name, pageCount, savedAt: null, sizeBytes });
      }
    }
    return result;
  } catch { return []; }
}

// ─── Storage usage ────────────────────────────────────────────────
export async function getStorageInfo() {
  if (!isOfflineSupported()) return { usedBytes: 0, quotaBytes: 0, comicCount: 0 };
  try {
    const estimate  = await navigator.storage.estimate();
    const root      = await getRoot();
    const manifest  = await readManifest(root);
    const comicCount = Object.keys(manifest).length;
    const comicBytes = Object.values(manifest).reduce((s, m) => s + (m.sizeBytes || 0), 0);
    return {
      usedBytes:          comicBytes,
      quotaBytes:         estimate.quota || 0,
      estimatedTotalUsed: estimate.usage || 0,
      comicCount,
    };
  } catch { return { usedBytes: 0, quotaBytes: 0, comicCount: 0 }; }
}
