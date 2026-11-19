'use strict';
// ─── Library scan after downloads are filed (moved out of server.js 2026-11-19, server.js split step 6b) ───
// Batches rapid completions (a pack, several downloads) into one scan of the libraries that received
// files, 10 s after the last one, then tells the Download Manager to reload. Moved unchanged.
const path = require('path');

module.exports.createPostProcessScan = function createPostProcessScan(deps) {
  const missing = ['db', 'logger', 'pushSseEvent', 'runLibraryScan'].filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createPostProcessScan: missing ${missing.join(', ')}`);
  const { db, logger, pushSseEvent, runLibraryScan } = deps;

  // Batches rapid completions (e.g. pack) into a single scan 10s after last call.
  let postProcessScanTimer = null;
  // Phase 6.8: scan only the libraries that received files. Without a known
  // destination (packs, manga), fall back to every library as before.
  let postProcessScanTargets = new Set(), postProcessScanAll = false;
  function schedulePostProcessScan(destPath = null) {
    if (destPath) postProcessScanTargets.add(path.resolve(destPath)); else postProcessScanAll = true;
    if (postProcessScanTimer) clearTimeout(postProcessScanTimer);
    postProcessScanTimer = setTimeout(async () => {
      postProcessScanTimer = null;
      const targets = [...postProcessScanTargets], all = postProcessScanAll;
      postProcessScanTargets = new Set(); postProcessScanAll = false;
      try {
        const every = db.prepare('SELECT * FROM libraries').all();
        const owns = (lib, p) => { const rel = path.relative(path.resolve(lib.path), p); return !rel || (!path.isAbsolute(rel) && !rel.startsWith('..')); };
        const libs = all ? every : every.filter(lib => targets.some(p => owns(lib, p)));
        const scanLibs = libs.length ? libs : every;
        logger.info('scanner', 'Post-process scan triggered — new files incoming', { libraries: scanLibs.map(l => l.name) });
        for (const lib of scanLibs) await runLibraryScan(lib, 'postprocess');
        logger.info('scanner', 'Post-process scan complete');
        // Notify DownloadManager clients to reload monitored series
        pushSseEvent({ type: 'series_updated' });
      } catch (e) {
        logger.warn('scanner', 'Post-process scan failed', e.message);
      }
    }, 10000);
  }

  return { schedulePostProcessScan };
};
