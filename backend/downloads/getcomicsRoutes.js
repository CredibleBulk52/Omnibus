'use strict';
// ─── GetComics routes: search, post links, download (single issue or pack) ───
// Moved out of server.js unchanged (2026-11-05, downloads stage 3). Scraping is in
// ./getcomics.js, host downloaders in ./hosts.js, single issues go through the queue in
// ./issueDownloads.js and packs to ./packs.js.
module.exports.registerGetComicsRoutes = function registerGetComicsRoutes(deps) {
  const missing = ['MANUAL_ONLY_HOSTS', 'THIRD_PARTY_HOST', 'activeDownloads', 'app', 'asArrival', 'axios', 'blacklistAndRetry', 'db', 'downloadThirdParty', 'fetchViaFlareSolverr', 'finalizeCancellation', 'fs', 'getSetting', 'isCancelled', 'logger', 'path', 'pixeldrainBehind', 'postProcessPack', 'pushDownloadProgress', 'pushDownloadUpdate', 'requireAdmin', 'requireDownloadAccess', 'resolveDldsLink', 'runDdlDownload', 'scrapeGcLinks', 'scrapeGcResults', 'sniffDownload', 'stallGuard'].filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`registerGetComicsRoutes: missing ${missing.join(', ')}`);
  const { MANUAL_ONLY_HOSTS, THIRD_PARTY_HOST, activeDownloads, app, asArrival, axios, blacklistAndRetry, db, downloadThirdParty, fetchViaFlareSolverr, finalizeCancellation, fs, getSetting, isCancelled, logger, path, pixeldrainBehind, postProcessPack, pushDownloadProgress, pushDownloadUpdate, requireAdmin, requireDownloadAccess, resolveDldsLink, runDdlDownload, scrapeGcLinks, scrapeGcResults, sniffDownload, stallGuard } = deps;

// Search GetComics
// Debug: returns raw FlareSolverr HTML for a GC page — use to diagnose scraping issues
// Usage: GET /api/getcomics/debug?url=https://getcomics.org/...&filter=article
app.get('/api/getcomics/debug', requireAdmin, async (req, res) => {
  const { url, filter } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const html = await fetchViaFlareSolverr(url);
    let lines;
    if (filter) {
      lines = html.split('\n').filter(l => l.toLowerCase().includes(filter.toLowerCase()));
    } else {
      // Default: lines with /dlds/, comicfiles, <article, or <h1
      lines = html.split('\n').filter(l =>
        l.includes('/dlds/') || l.includes('comicfiles') ||
        l.includes('<article') || l.includes('<h1') || l.includes('getcomics.org/')
      );
    }
    res.json({ matchingLines: lines, totalLength: html.length, lineCount: lines.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/getcomics/search', requireDownloadAccess, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const searchUrl = `https://getcomics.org/?s=${encodeURIComponent(q)}`;
    const html = await fetchViaFlareSolverr(searchUrl);
    const results = scrapeGcResults(html);
    logger.info('getcomics', `Search "${q}": ${results.length} result${results.length === 1 ? '' : 's'}`);
    res.json(results);
  } catch (e) {
    logger.error('getcomics', 'Search failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Fetch direct download links from a GetComics post page
app.get('/api/getcomics/links', requireDownloadAccess, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const html = await fetchViaFlareSolverr(url);
    const links = scrapeGcLinks(html);
    // Return immediately with button labels — redirect resolution happens at grab time
    logger.info('getcomics', `Found ${links.length} links`, { url });
    res.json({ links });
  } catch (e) {
    logger.error('getcomics', 'Link fetch failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Download a direct file from GetComics and feed it into the pack post-processor
app.post('/api/getcomics/download', requireDownloadAccess, async (req, res) => {
  const { seriesId, issueId, downloadUrl, filename } = req.body;
  if (!seriesId || !downloadUrl) return res.status(400).json({ error: 'seriesId and downloadUrl required' });

  const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(seriesId);
  if (!series) return res.status(404).json({ error: 'Series not found' });

  const issue = issueId ? db.prepare('SELECT * FROM monitored_issues WHERE id = ?').get(issueId) : null;
  if (issueId && !issue) return res.status(404).json({ error: 'Issue not found' });
  if (issue && String(issue.series_id) !== String(series.id)) return res.status(400).json({ error: 'Issue does not belong to the selected series' });

  res.json({ success: true, message: 'Download started' });

  if (issue) {
    // Single issue — resolve URL, mark snatched, use runDdlDownload (handles retry on failure)
    setImmediate(async () => {
      try {
        let resolvedUrl = downloadUrl;
        if (/\/dl?ds\//.test(downloadUrl)) {
          const final = await resolveDldsLink(downloadUrl);
          if (!final) {
            await blacklistAndRetry(issue, series, downloadUrl, 'DDL link resolved to unsupported host');
            return;
          }
          resolvedUrl = final;
        }
        db.prepare(`UPDATE monitored_issues SET status='snatched', download_id='ddl', download_url=? WHERE id=?`)
          .run(resolvedUrl, issueId);
        await runDdlDownload(issue, series, resolvedUrl, filename);
      } catch (e) {
        logger.error('getcomics', `DDL setup failed for issue ${issueId}`, e.message);
        await blacklistAndRetry(issue, series, downloadUrl, e.message);
      }
    });
  } else {
    // Pack download — keep original inline flow (no retry for packs)
    setImmediate(async () => {
      const dlDir = getSetting('ddl_download_path') || '/downloads/getcomics';
      if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
      // Hoisted out of the try so the catch block can surface failure to the toast.
      let dlEntry = null;
      try {
        // Resolve the dlds redirect first so we can derive the real filename
        let resolvedUrl = downloadUrl;
        if (/\/dl?ds\//.test(downloadUrl)) {
          const final = await resolveDldsLink(downloadUrl);
          if (!final) throw new Error('DDL link resolved to unsupported host');
          resolvedUrl = final;
        }

        // Derive filename from resolved URL
        const rawFilename = decodeURIComponent(path.basename(new URL(resolvedUrl).pathname));
        const safeFilename = (rawFilename || `getcomics-${Date.now()}.zip`)
          .replace(/[^a-zA-Z0-9._\-() ]/g, '_');
        let destPath = path.join(dlDir, safeFilename);

        const dlId = `gc-pack-${Date.now()}`;
        // source/kind (2026-10-25): without a source the Queue tab left packs out, so they could not be cancelled there.
        dlEntry = { id: dlId, source: 'getcomics', kind: 'pack', filename: safeFilename, seriesName: series.name, bytesReceived: 0, totalBytes: 0, status: 'downloading', startedAt: new Date().toISOString() };
        activeDownloads.set(dlId, dlEntry);
        pushDownloadUpdate(dlEntry);

        // Known hosts we can't auto-grab. These are landing pages, not direct file
        // URLs — the user's browser works because it loads the page, clicks a
        // button, and receives the file via a session-bound token. Replicating
        // that requires a dedicated resolver per host (CF bypass + page scrape +
        // token handling). Until those exist, fail fast with a clear message
        // instead of hammering the host with 5 retry loops that all 403.
        if (MANUAL_ONLY_HOSTS.test(resolvedUrl)) {
          const host = resolvedUrl.split('/')[2] || 'this host';
          const msg  = `${host} is not supported for auto-download. Click the link to download manually in your browser.`;
          dlEntry.status = 'error';
          dlEntry.error  = msg;
          pushDownloadUpdate({ ...dlEntry });
          logger.info('getcomics', `Pack download skipped — manual-only host`, { resolvedUrl });
          setTimeout(() => { activeDownloads.delete(dlId); pushDownloadUpdate({ id: dlId, status: 'removed' }); }, 15000);
          return;
        }

        // A GetComics link that still points at getcomics.org may lead to Pixeldrain.
        if (!/pixeldrain\.com|mediafire\.com|mega\.nz/i.test(resolvedUrl) && /getcomics\.org\/dl?ds\//i.test(resolvedUrl)) {
          const pd = await pixeldrainBehind(resolvedUrl, { 'Referer': 'https://getcomics.org/' });
          if (pd) { logger.info('getcomics', `Pack link led to Pixeldrain — using its file API`, { from: resolvedUrl, pixeldrainUrl: pd }); resolvedUrl = pd; }
        }
        const isThirdPartyPack = /pixeldrain\.com|mediafire\.com|mega\.nz/i.test(resolvedUrl);
        if (isThirdPartyPack) {
          // Route through dedicated handlers — they handle auth, decryption, filename detection
          logger.info('getcomics', `Pack: third-party download via ${resolvedUrl.split('/')[2]}`, { resolvedUrl });
          destPath = await downloadThirdParty(resolvedUrl, destPath, dlEntry);
        } else {
          logger.info('getcomics', `Pack download starting: ${safeFilename}`, { resolvedUrl });

          // Download with retry + HTTP range resume — GetComics drops connections on large files
          const MAX_RETRIES = 5;
          let attempt = 0;
          let success  = false;

          while (attempt <= MAX_RETRIES && !success) {
            // Cancel check before each retry — if user clicked ✕ between
            // retries, bail without starting another request.
            if (isCancelled(dlId)) {
              logger.info('getcomics', `Pack download cancelled by user at ${Math.floor(dlEntry.bytesReceived / 1024 / 1024)}MB`);
              try { fs.unlinkSync(destPath); } catch {}
              finalizeCancellation(dlEntry, `Cancelled at ${Math.floor(dlEntry.bytesReceived / 1024 / 1024)}MB`);
              return;
            }
            // Resume from what is on disk, not the byte counter: the counter
            // includes data still buffered when the connection dropped.
            let bytesAlready = 0;
            if (attempt > 0) { try { bytesAlready = fs.statSync(destPath).size; } catch {} }
            dlEntry.bytesReceived = bytesAlready;
            if (attempt > 0) {
              logger.info('getcomics', `Pack download retry ${attempt}/${MAX_RETRIES} from byte ${bytesAlready}`, { resolvedUrl });
              await new Promise(r => setTimeout(r, 3000 * attempt)); // back off
            }

            // Fresh AbortController per attempt — old one may have been aborted
            // by the retry path (server disconnect). Cancel endpoint calls
            // dlEntry.abortController?.abort() on whichever is current.
            const ac = new AbortController();
            dlEntry.abortController = ac;

            try {
              const headers = { 'Referer': 'https://getcomics.org/' };
              if (bytesAlready > 0) headers['Range'] = `bytes=${bytesAlready}-`;

              const r = await axios.get(resolvedUrl, {
                responseType: 'stream',
                timeout: 0,
                headers,
                signal: ac.signal,
              });

              // A GetComics link can redirect (on GET only) to MEGA, MediaFire
              // or Pixeldrain. Saving that response stores their web page, not
              // the pack (pack 810, 2026-10-15: a 2 KB MEGA page). Hand those
              // to the host's own downloader instead.
              const finalUrl = r.request?.res?.responseUrl || resolvedUrl;
              if (THIRD_PARTY_HOST.test(finalUrl)) {
                r.data.destroy();
                logger.info('getcomics', `Pack link redirected to ${new URL(finalUrl).hostname} — using its downloader`, { from: resolvedUrl, to: finalUrl });
                try { destPath = await downloadThirdParty(finalUrl, destPath, dlEntry); }
                catch (e) { e.noRetry = true; throw e; }
                success = true;
                continue;
              }
              if (/text\/html/i.test(String(r.headers['content-type'] || ''))) {
                r.data.destroy();
                const err = new Error(`Download host returned a web page instead of the pack (${new URL(finalUrl).hostname})`);
                err.noRetry = true;
                throw err;
              }

              // Resume check. Only a 206 to a Range request means "append".
              // Anything else (usually a 200 from a host that ignores Range,
              // e.g. getcomics /dls/ redirects) restarts the file from byte 0,
              // so the counter must restart too — otherwise progress runs
              // past 100% by the bytes received before the drop.
              const cl = parseInt(r.headers['content-length'] || '0', 10);
              const crStart = parseInt((/^bytes (\d+)-/.exec(r.headers['content-range'] || '') || [])[1], 10);
              if (bytesAlready > 0 && r.status === 206 && crStart !== bytesAlready) {
                // Appending from the wrong offset would corrupt the pack. Start over.
                r.data.destroy();
                try { fs.unlinkSync(destPath); } catch {}
                throw new Error(`Server resumed at byte ${crStart}, expected ${bytesAlready}; restarting`);
              }
              const isResume = bytesAlready > 0 && r.status === 206;
              if (isResume) {
                const crTotal = parseInt(((r.headers['content-range'] || '').split('/')[1]) || '0', 10);
                if (crTotal) dlEntry.totalBytes = crTotal;
                else if (!dlEntry.totalBytes) dlEntry.totalBytes = bytesAlready + cl;
              } else {
                if (bytesAlready > 0) {
                  logger.warn('getcomics', `Pack download: server ignored resume (HTTP ${r.status}), restarting from 0`,
                    { discardedMB: Math.floor(bytesAlready / 1024 / 1024) });
                }
                dlEntry.bytesReceived = 0;
                dlEntry.totalBytes = cl;
              }

              // Filename is fixed on the first attempt only, so a retry never
              // switches files mid-download.
              if (attempt === 0) {
                const cd = r.headers['content-disposition'] || '';
                const cdMatch = cd.match(/filename[*]?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
                let realName = cdMatch ? decodeURIComponent(cdMatch[1].trim().replace(/["']/g, '')) : '';
                // No usable header: fall back to the final URL after redirects
                // (getcomics /dls/ tokens redirect to the real file path).
                if (!realName) {
                  try {
                    const finalUrl = r.request?.res?.responseUrl || '';
                    const base = finalUrl ? decodeURIComponent(path.basename(new URL(finalUrl).pathname)) : '';
                    if (/\.(zip|cbz|cbr|rar|7z|cb7)$/i.test(base)) realName = base;
                  } catch {}
                }
                if (realName) destPath = path.join(dlDir, realName.replace(/[^a-zA-Z0-9._\-() ]/g, '_'));
              }
              dlEntry.filename = path.basename(destPath);
              pushDownloadUpdate({ ...dlEntry });

              let lastLogAt = dlEntry.bytesReceived;
              const writeMode = isResume ? 'a' : 'w';

              await new Promise((resolve, reject) => {
                const w = fs.createWriteStream(destPath, { flags: writeMode });
                let failed = null;
                const fail = (err) => { if (failed) return; failed = err; r.data.unpipe(w); w.end(); };
                stallGuard(r.data);
                r.data.on('data', chunk => {
                  dlEntry.bytesReceived += chunk.length;
                  pushDownloadProgress(dlEntry);
                  if (dlEntry.bytesReceived - lastLogAt > 50 * 1024 * 1024) {
                    lastLogAt = dlEntry.bytesReceived;
                    const pct = dlEntry.totalBytes ? Math.floor(dlEntry.bytesReceived / dlEntry.totalBytes * 100) : null;
                    logger.info('getcomics', `Pack progress: ${path.basename(destPath)}`,
                      { mb: Math.floor(dlEntry.bytesReceived / 1024 / 1024), pct });
                  }
                });
                r.data.pipe(w);
                // Settle once the file is closed, so a retry resumes from what is really on disk.
                w.on('close', () => (failed ? reject(failed) : resolve()));
                w.on('error', fail);
                r.data.on('error', fail);
              });

              // An empty body is not a finished download — fail instead of
              // handing a 0-byte file to the pack processor.
              if (dlEntry.bytesReceived === 0) {
                const err = new Error(`Server returned an empty file (HTTP ${r.status})`);
                err.noRetry = true;
                throw err;
              }
              if (dlEntry.totalBytes && dlEntry.bytesReceived < dlEntry.totalBytes) {
                throw new Error(`Stream ended early at ${Math.floor(dlEntry.bytesReceived / 1024 / 1024)}MB of ${Math.floor(dlEntry.totalBytes / 1024 / 1024)}MB`);
              }

              success = true;
            } catch (retryErr) {
              // Distinguish user cancel from transient network failure:
              //   - axios.isCancel() covers AbortController signal aborts
              //   - checking isCancelled(dlId) covers the race where the
              //     user cancels mid-chunk but the abort hasn't propagated yet
              // In both cases, don't retry. Clean up partial file + exit.
              if (axios.isCancel(retryErr) || isCancelled(dlId)) {
                logger.info('getcomics', `Pack download cancelled at ${Math.floor(dlEntry.bytesReceived / 1024 / 1024)}MB`);
                try { fs.unlinkSync(destPath); } catch {}
                finalizeCancellation(dlEntry, `Cancelled at ${Math.floor(dlEntry.bytesReceived / 1024 / 1024)}MB`);
                return;
              }
              if (retryErr.noRetry) { try { fs.unlinkSync(destPath); } catch {} throw retryErr; }
              attempt++;
              if (attempt > MAX_RETRIES) throw retryErr;
              logger.warn('getcomics', `Pack download interrupted at ${Math.floor(dlEntry.bytesReceived / 1024 / 1024)}MB, will retry`, { error: retryErr.message });
            }
          }
        }

        // Whatever path produced it, a pack must be an archive (or a folder).
        try {
          if (fs.statSync(destPath).isFile()) {
            const kind = sniffDownload(destPath);
            if (!['zip', 'rar', '7z'].includes(kind)) {
              throw new Error(kind === 'html' ? 'Download host returned a web page instead of the pack' : 'Downloaded pack is not an archive');
            }
          }
        } catch (e) { if (e.code !== 'ENOENT') throw e; }

        dlEntry.status = 'complete';
        pushDownloadUpdate({ ...dlEntry });
        logger.info('getcomics', `Pack download complete: ${path.basename(destPath)}`,
          { mb: Math.floor(dlEntry.bytesReceived / 1024 / 1024) });
        setTimeout(() => { activeDownloads.delete(dlId); pushDownloadUpdate({ id: dlId, status: 'removed' }); }, 8000);

        const packId = db.prepare(`INSERT INTO series_packs (series_id, file_path, status) VALUES (?, ?, 'downloaded')`)
          .run(seriesId, destPath).lastInsertRowid;
        db.prepare(`UPDATE series_packs SET status = 'processing' WHERE id = ?`).run(packId);
        await asArrival('pack-process', () => postProcessPack({ id: packId, series_id: seriesId, file_path: destPath }, series));
      } catch (e) {
        // Cancellation path — user clicked ✕ mid-pack. finalizeCancellation
        // was already called by whichever worker caught the cancel first
        // (folder loop, retry loop, etc.). If the entry still exists and
        // is cancelling, skip the error toast. Otherwise treat as a real error.
        if (dlEntry && (dlEntry.cancelling || dlEntry.status === 'cancelled' || axios.isCancel?.(e) || /Cancelled by user/i.test(e.message || ''))) {
          logger.info('getcomics', `Pack download cancelled: ${downloadUrl}`);
          // finalizeCancellation is idempotent-ish — if already set, just re-push
          if (dlEntry.status !== 'cancelled') finalizeCancellation(dlEntry);
          return;
        }
        logger.error('getcomics', `Pack download failed: ${downloadUrl}`, e.message);
        // Surface the failure to the download toast so the user can see something
        // went wrong. Without this, the toast just sits at its last-known state
        // (e.g. 0MB) until it eventually auto-dismisses, which is confusing.
        // dlEntry may still be null if we threw before creating it (e.g. dlds
        // resolve failed) — guard accordingly.
        if (dlEntry) {
          dlEntry.status = 'error';
          dlEntry.error  = e.message || 'Download failed';
          pushDownloadUpdate({ ...dlEntry });
          setTimeout(() => {
            activeDownloads.delete(dlEntry.id);
            pushDownloadUpdate({ id: dlEntry.id, status: 'removed' });
          }, 15000);
        }
      }
    });
  }
});
};
