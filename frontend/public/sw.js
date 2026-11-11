// sw.js — Omnibus Service Worker v4
const CACHE_NAME    = 'omnibus-shell-v6';
const OPFS_ROOT     = 'omnibus';
const OPFS_MANIFEST = 'manifest.json';
const PAGE_ROUTE    = /^\/api\/books\/([^/]+)\/pages\/(\d+)$/;

// ─── Offline response helper ──────────────────────────────────────
function offlineApiResponse() {
  return new Response(
    JSON.stringify({ offline: true, content: [], error: 'offline' }),
    { status: 503, headers: { 'Content-Type': 'application/json' } }
  );
}

// ─── Offline-aware fetch ──────────────────────────────────────────
// When online: pass straight through with no timeout — don't interfere
// with legitimate slow requests (large uploads, AI generation, etc.)
// When offline: race against a short timeout so the app fails fast
// instead of hanging for 30-60s waiting for an OS network timeout.
function fetchWithTimeout(request, ms = 3000) {
  // If browser reports online, don't add any timeout — trust the network
  if (self.navigator && self.navigator.onLine) {
    return fetch(request);
  }
  // Offline — race against timeout for fast failure
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sw-timeout')), ms);
    fetch(request)
      .then(r => { clearTimeout(timer); resolve(r); })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
}

// ─── Message handler ─────────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// ─── Install ─────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    cacheShellAssets().catch(e =>
      console.warn('[sw] Shell cache skipped:', e.message)
    )
  );
});

async function cacheShellAssets() {
  const cache = await caches.open(CACHE_NAME);
  await cache.add('/');
  const res = await fetch('/asset-manifest.json');
  const assetManifest = await res.json();
  const urls = Object.values(assetManifest.files || {})
    .filter(u => u.endsWith('.js') || u.endsWith('.css'));
  await Promise.allSettled(urls.map(u => cache.add(u)));
  console.log(`[sw] Cached ${urls.length} shell assets`);
}

// ─── Activate ────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }).then(clients =>
        clients.forEach(c => c.postMessage({ type: 'SW_ACTIVATED' }))
      ))
  );
});

// ─── Fetch ───────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Comic page images — OPFS first, network fallback
  const pageMatch = PAGE_ROUTE.exec(url.pathname);
  if (pageMatch) {
    event.respondWith(
      servePageFromOpfs(pageMatch[1], parseInt(pageMatch[2], 10), event.request)
    );
    return;
  }

  // API calls — timeout after 3s and return offline response.
  // Cannot use fetch().catch() alone because Android hangs rather
  // than rejects when there is no network connection.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetchWithTimeout(event.request, 3000).catch(() => offlineApiResponse())
    );
    return;
  }

  // Navigation — network first, cached shell fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetchWithTimeout(event.request, 4000).catch(() =>
        caches.match('/').then(r => r ||
          new Response(
            '<html><body style="background:#0d0d0f;color:#c0b89a;font-family:serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;flex-direction:column"><div style="text-align:center;padding:40px"><div style="font-size:3rem">📚</div><div style="margin-top:1rem;font-size:1.1rem">Omnibus</div><div style="font-size:0.8rem;color:#666;margin-top:0.5rem">Loading offline library…</div></div></body></html>',
            { headers: { 'Content-Type': 'text/html' } }
          )
        )
      )
    );
    return;
  }

  // Static assets — cache first, network fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok && (
          url.pathname.startsWith('/static/') ||
          url.pathname.endsWith('.png') ||
          url.pathname.endsWith('.ico')
        )) {
          caches.open(CACHE_NAME)
            .then(c => c.put(event.request, response.clone()))
            .catch(() => {});
        }
        return response;
      });
    })
  );
});

// ─── Serve comic page from OPFS ──────────────────────────────────
async function servePageFromOpfs(bookId, pageIndex, originalRequest) {
  try {
    const root = await navigator.storage.getDirectory();
    const omnibusDir = await root.getDirectoryHandle(OPFS_ROOT, { create: false })
      .catch(() => null);
    if (!omnibusDir) return fetchWithTimeout(originalRequest).catch(() => offlineApiResponse());

    const mh = await omnibusDir.getFileHandle(OPFS_MANIFEST).catch(() => null);
    if (!mh) return fetchWithTimeout(originalRequest).catch(() => offlineApiResponse());

    const mf = await mh.getFile();
    // If manifest is empty, try serving directly by checking if file exists
    let isInManifest = false;
    if (mf.size > 0) {
      const manifest = JSON.parse(await mf.text());
      isInManifest = bookId in manifest;
    } else {
      // Manifest is 0KB — check if book directory exists anyway
      const bookDir = await omnibusDir.getDirectoryHandle(bookId, { create: false })
        .catch(() => null);
      isInManifest = !!bookDir;
    }

    if (!isInManifest) return fetchWithTimeout(originalRequest).catch(() => offlineApiResponse());

    const filename = `page_${String(pageIndex).padStart(4, '0')}.jpg`;
    const bookDir = await omnibusDir.getDirectoryHandle(bookId, { create: false })
      .catch(() => null);
    if (!bookDir) return fetchWithTimeout(originalRequest).catch(() => offlineApiResponse());

    const ph = await bookDir.getFileHandle(filename).catch(() => null);
    if (!ph) return fetchWithTimeout(originalRequest).catch(() => offlineApiResponse());

    const pf = await ph.getFile();
    return new Response(pf, {
      status: 200,
      headers: {
        'Content-Type': pf.type || 'image/jpeg',
        'Content-Length': String(pf.size),
        'X-Served-From': 'opfs',
      },
    });
  } catch (err) {
    console.warn('[sw] OPFS error:', err.message);
    return fetchWithTimeout(originalRequest).catch(() => offlineApiResponse());
  }
}
