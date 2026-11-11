'use strict';
// ─── Series packs: grab a pack, post-process a downloaded pack ───────────────
// Moved out of server.js unchanged (2026-11-05, downloads stage 3): the grab-pack route
// (qBittorrent or SABnzbd) and postProcessPack with its file-matching helpers. Tests:
// metadata/packPause.test.js. server.js passes in what it shares.
const crypto = require('crypto');
const { removeInside } = require('../metadata/removeInside');
const { deletableDownload } = require('./heldDownloads');
module.exports.createPacks = function createPacks(deps) {
  const missing = ['app', 'asArrival', 'axios', 'coverThumb', 'CV_WAIT_REASON', 'db', 'DB_PATH', 'execFileAsync', 'filenameYear', 'filterImages', 'fs', 'getSetting', 'IN', 'issueYearsOf', 'listArchiveFiles', 'logger', 'metadataRuntime', 'path', 'qbtLogin', 'readArchiveMember', 'requireAdmin', 'requireDownloadAccess', 'resolveQbtHash', 'SABNZBD_API_KEY', 'SABNZBD_URL', 'schedulePostProcessScan', 'sniffDownload', 'sqlTime'].filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createPacks: missing ${missing.join(', ')}`);
  const { app, asArrival, axios, coverThumb, CV_WAIT_REASON, db, DB_PATH, execFileAsync, filenameYear, filterImages, fs, getSetting, IN, issueYearsOf, listArchiveFiles, logger, metadataRuntime, path, qbtLogin, readArchiveMember, requireAdmin, requireDownloadAccess, resolveQbtHash, SABNZBD_API_KEY, SABNZBD_URL, schedulePostProcessScan, sniffDownload, sqlTime } = deps;
  const extractIssueNumber = IN.extractIssueNumber;

// ─── Series pack grab endpoint ────────────────────────────────────
// Grabs a full-series pack release. Stores tracking in series_packs table.
app.post('/api/monitor/series/:id/grab-pack', requireDownloadAccess, async (req, res) => {
  const { id } = req.params;
  const { url, name, protocol } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  // Routing decision: if the caller passed an explicit protocol from Prowlarr's
  // response, trust it. Otherwise fall back to URL-shape detection (magnet:
  // prefix or .torrent extension). The fallback exists for non-Prowlarr
  // callers and for paranoid defense — but in practice the explicit signal is
  // far more reliable, because Prowlarr's downloadUrl for torrent results is
  // typically an HTTPS proxy URL with neither characteristic, which the
  // URL-shape heuristic would mis-classify as NZB.
  const isTorrent = protocol === 'torrent'
    || url.startsWith('magnet:')
    || /\.torrent($|\?)/i.test(url);

  if (isTorrent) {
    // Look up series_type so the qBit dispatcher uses the right category.
    // For comic series we use the comic category + savepath; for manga
    // (rare path — manga normally goes through Nyaa) we use the manga ones.
    const series = db.prepare('SELECT series_type FROM monitored_series WHERE id = ?').get(id);
    const seriesType = series?.series_type === 'manga' ? 'manga' : 'comic';
    try {
      const { url: qbtUrl, qbtHeaders } = await qbtLogin();
      const cat = seriesType === 'comic'
        ? (getSetting('qbittorrent_comic_category') || 'comics')
        : (getSetting('qbittorrent_category') || 'manga');
      const qbtSavepath = seriesType === 'comic'
        ? (getSetting('qbittorrent_comic_savepath') || '')
        : (getSetting('qbittorrent_savepath') || '');
      const formData = new URLSearchParams();
      formData.append('urls', url);
      formData.append('category', cat);
      if (qbtSavepath) formData.append('savepath', qbtSavepath);
      // Capture the snapshot of existing torrent hashes BEFORE the add, so we
      // can identify the newly-added one by set difference afterward. This is
      // necessary when the input is a Prowlarr proxy URL (HTTPS, no embedded
      // hash) — qBit only computes the hash after fetching the .torrent file.
      const beforeRes = await axios.get(`${qbtUrl}/api/v2/torrents/info`, {
        headers: qbtHeaders, timeout: 5000,
        params: { category: cat },
      });
      const beforeHashes = new Set((beforeRes.data || []).map(t => t.hash?.toLowerCase()));

      await axios.post(`${qbtUrl}/api/v2/torrents/add`, formData.toString(), {
        headers: { ...qbtHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      });

      const torrentHash = await resolveQbtHash({ url: qbtUrl, qbtHeaders }, url, cat, beforeHashes);
      const downloadId = `qbt_${torrentHash}`;
      const info = db.prepare(
        `INSERT INTO series_packs (series_id, download_id, status) VALUES (?, ?, 'snatched')`
      ).run(id, downloadId);
      logger.info('pack', `Series ${id} pack snatched (qBit)`, { hash: torrentHash, packId: info.lastInsertRowid, category: cat });
      return res.json({ success: true, downloadId, packId: info.lastInsertRowid, source: 'qbittorrent' });
    } catch (e) {
      logger.error('pack', 'qBit grab failed', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // NZB path — original SAB logic
  const sabUrl = getSetting('sabnzbd_url')     || SABNZBD_URL;
  const sabKey = getSetting('sabnzbd_api_key') || SABNZBD_API_KEY;
  const sabCat = getSetting('sabnzbd_category') || 'comics';

  try {
    const r = await axios.get(`${sabUrl}/api`, {
      params: { apikey: sabKey, mode: 'addurl', name: url, nzbname: name || '', cat: sabCat, output: 'json' },
      timeout: 10000,
    });
    if (r.data.status === true || r.data.nzo_ids?.length) {
      const nzo_id = r.data.nzo_ids?.[0] || null;
      const info = db.prepare(
        `INSERT INTO series_packs (series_id, download_id, status) VALUES (?, ?, 'snatched')`
      ).run(id, nzo_id);
      logger.info('pack', `Series ${id} pack snatched`, { nzo_id, packId: info.lastInsertRowid });
      res.json({ success: true, nzo_id, packId: info.lastInsertRowid, source: 'sabnzbd' });
    } else {
      res.json({ success: false, error: r.data.error || 'SABnzbd rejected' });
    }
  } catch (e) {
    logger.error('pack', 'Grab failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Pack post-processor ──────────────────────────────────────────

/**
 * Returns true if a CV issue_number matches an extracted filename number.
 * Suffix-aware: "8" and "8AU" are different issues and must NOT match.
 * Handles plain integers, milestones (1000000), decimals (14.1), suffixes
 * (14.MU, 14.MCU, 1.NOW, 8.AU) — both dot and no-dot input forms.
 */
// Series name written in a pack file's name, as a comparable key: the words
// before the issue number, without "v1"/"vol", bracketed groups or punctuation.
// "Showcase v1 001 (1956) - Fire Fighters.cbr" → "showcase";
// "Showcase '93 01 (of 12) (1993).cbr" → "showcase 93". null when unreadable.
function packSeriesKey(name) {
  return String(name || '').toLowerCase()
    .replace(/\((?:19|20)\d\d\)/g, ' ').replace(/&/g, ' and ').replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/^the /, '').replace(/\b(?:v|vol|volume)\s*\d+\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function packFileSeriesKey(basename, num) {
  const stem = String(basename).replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/[._]+/g, ' ');
  const want = IN.normIssueNumber(num);
  const tokens = stem.split(/\s+/).filter(Boolean);
  for (let i = tokens.length - 1; i > 0; i--) {
    const t = tokens[i].replace(/^#/, '').replace(/^(\d+(?:\.\w+)?)-[A-Za-z].*$/, '$1');   // "283-Superboy," → 283
    if (/^\d/.test(t) && IN.normIssueNumber(t) === want) {
      const key = packSeriesKey(tokens.slice(0, i).join(' '));
      return key || null;
    }
  }
  return null;
}

function issueNumMatches(cvNum, extractedNum) {
  if (!cvNum || !extractedNum) return false;
  const a = IN.normIssueNumber(cvNum);
  const b = IN.normIssueNumber(extractedNum);
  if (!a || !b) return false;
  // Strict canonical equality. The old "integer fallback" branch is
  // intentionally removed — it caused 8AU/8 false-matches that wrongly
  // marked tie-in monitored_issues as processed during pack import.
  return a === b;
}


// True when an extracted pack is one comic's pages: at least 3 page images and
// nothing else that is a comic. Cover galleries ("(50 covers)") are not issues.
const PAGE_IMAGE = /\.(jpe?g|png|gif|webp|avif|bmp|jxl)$/i;
function packHoldsPages(dir, packName = '') {
  if (/\bcover (?:upgrade|collection|gallery)\b|\(\d+ covers\)/i.test(packName)) return false;
  let pages = 0;
  (function walk(d, depth) {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === '__MACOSX') continue;
      if (e.isDirectory()) { if (depth < 3) walk(path.join(d, e.name), depth + 1); }
      else if (e.isFile() && PAGE_IMAGE.test(e.name)) pages++;
    }
  })(dir, 0);
  return pages >= 3;
}

async function postProcessPack(pack, series) {
  const tmpDir = path.join(path.dirname(DB_PATH), 'metadata-pack-' + crypto.randomUUID());
  logger.info('pack-process', `Starting pack ${pack.id} for series ${series.id}`, { file: pack.file_path });

  // SAB can hand us either a single archive file (which we extract) or a directory
  // (already-unpacked contents — SAB did the work for us). Detecting up front lets
  // us skip the outer-archive step for the directory case.
  let packIsDirectory = false;
  const damagedFiles = [];   // files the archive holds damaged (bad CRC); skipped
  try {
    const st = fs.statSync(pack.file_path);
    packIsDirectory = st.isDirectory();
  } catch (e) {
    logger.error('pack-process', `Pack ${pack.id} source missing`, { path: pack.file_path, error: e.message });
    db.prepare(`UPDATE series_packs SET status = 'failed' WHERE id = ?`).run(pack.id);
    return;
  }

  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    // Outer extraction — only if SAB gave us an archive. If it handed us a
    // directory (common for packs that unpack cleanly without nested archives),
    // treat that directory as our working extraction root directly.
    let workDir;
    if (packIsDirectory) {
      workDir = pack.file_path;
      logger.info('pack-process', `Pack is a directory — scanning directly`, { workDir });
    } else {
      const kind = sniffDownload(pack.file_path);
      if (!['zip', 'rar', '7z'].includes(kind)) {
        const why = kind === 'html' ? 'Not an archive: the download is a web page (the host sent its page, not the file)' : 'Not an archive';
        logger.error('pack-process', `Pack ${pack.id}: ${why}`, { file: pack.file_path });
        db.prepare(`UPDATE series_packs SET status = 'failed', fail_reason = ?, failed_at = datetime('now') WHERE id = ?`).run(why, pack.id);
        return false;
      }
      try {
        await execFileAsync('bsdtar', ['-xf', pack.file_path, '-C', tmpDir], { env: { ...process.env, LANG: 'C', LC_ALL: 'C' } });
      } catch (e) {
        // One damaged file used to fail the whole pack (2026-10-25: Adventure Comics 401-503, a bad CRC in
        // #407). bsdtar still extracts every other file; drop the damaged ones and carry on. Their issues
        // stay wanted and are searched for on their own. Anything else (unreadable archive) still fails.
        const bad = [...String(e.stderr || e.message || '').matchAll(/^(?:bsdtar: )?(.+?): (?:ZIP bad CRC|Truncated|Damaged|Decompression failed|Invalid data)/gim)]
          .map(m => m[1].replace(/^Command failed: .* -C \S+\s*/, '').trim()).filter(Boolean);
        const extracted = (() => { try { return fs.readdirSync(tmpDir).length; } catch { return 0; } })();
        if (!bad.length || !extracted) throw e;
        for (const rel of bad) removeInside(tmpDir, rel, fs);   // never through a link the archive made (2026-11-09)
        damagedFiles.push(...bad.map(rel => path.basename(rel)));
        logger.warn('pack-process', `Pack ${pack.id}: ${bad.length} damaged file(s) in the archive skipped; their issues stay wanted`, { files: damagedFiles });
      }
      workDir = tmpDir;
      logger.info('pack-process', `Extracted outer archive`, { tmpDir });
    }

    // Every comic file in the pack, at any depth (packs nest: "Pack/Volume/
    // file.cbr"). Cover galleries and cover-upgrade files are not issues.
    const comicFiles = [];
    let coverFiles = 0;
    (function walk(dir, depth) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === '__MACOSX') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (/^covers?$/i.test(e.name)) { coverFiles++; continue; }
          if (depth < 6) walk(full, depth + 1);
        } else if (e.isFile() && /\.(cbr|cbz|cb7|rar|zip|7z)$/i.test(e.name)) {
          if (/\bcover (?:upgrade|collection|gallery)\b|\(\d+ covers\)/i.test(e.name)) { coverFiles++; continue; }
          comicFiles.push(full);
        }
      }
    })(workDir, 0);

    // A single issue grabbed as a pack (2026-11-03: "Tales of Wonder 001", grabbed
    // from the series Packs panel): the archive holds page images, not comic
    // files. File the archive itself as one issue, the way a single download is.
    if (!comicFiles.length && !packIsDirectory && packHoldsPages(workDir, path.basename(pack.file_path))) {
      comicFiles.push(pack.file_path);
      logger.info('pack-process', `Pack ${pack.id} is a single issue (pages, not comic files); filing it as one issue`, { file: path.basename(pack.file_path) });
    }

    if (!comicFiles.length) {
      logger.warn('pack-process', `No comic files found in pack`, { tmpDir });
      db.prepare(`UPDATE series_packs SET status = 'failed' WHERE id = ?`).run(pack.id);
      return;
    }

    logger.info('pack-process', `Found ${comicFiles.length} comic files in pack`);

    // Load all wanted/snatched issues for this series for matching
    const seriesIssues = db.prepare(
      `SELECT * FROM monitored_issues WHERE series_id = ? AND status IN ('wanted', 'snatched')`
    ).all(series.id);
    // Already processed with the file in place (an earlier pass of this pack,
    // e.g. before a Comic Vine pause): those files count as done, not unmatched.
    const doneIssues = db.prepare(
      `SELECT * FROM monitored_issues WHERE series_id = ? AND status = 'processed' AND file_path IS NOT NULL`
    ).all(series.id).filter(i => { try { return fs.existsSync(i.file_path); } catch { return false; } });

    // Load linked annual series so annual files in the pack match the correct annual series
    // instead of being confused with regular issue #1
    const annualLinks = db.prepare(`
      SELECT l.annual_series_id
      FROM series_annual_links l
      WHERE l.parent_series_id = ?
    `).all(series.id);
    const annualSeriesMap = new Map(); // annual_series_id → { series, issues[] }
    for (const link of annualLinks) {
      const aSeries = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(link.annual_series_id);
      const aIssues = db.prepare(
        `SELECT * FROM monitored_issues WHERE series_id = ? AND status IN ('wanted', 'snatched')`
      ).all(link.annual_series_id);
      const aDone = db.prepare(
        `SELECT * FROM monitored_issues WHERE series_id = ? AND status = 'processed' AND file_path IS NOT NULL`
      ).all(link.annual_series_id).filter(i => { try { return fs.existsSync(i.file_path); } catch { return false; } });
      if (aSeries) annualSeriesMap.set(link.annual_series_id, { series: aSeries, issues: aIssues, done: aDone });
    }

    let processed = 0, unmatched = 0, failed = 0, done = 0, rateLimited = null, otherSeries = 0, notOnCv = 0;
    // Every issue number Comic Vine lists for this series (any status). A file
    // named like the series whose number is not there at all (Showcase #105,
    // unpublished) cannot be identified; it does not fail the pack.
    const cvNumbers = db.prepare('SELECT issue_number FROM monitored_issues WHERE series_id = ? AND (is_annual IS NULL OR is_annual = 0)').all(series.id).map(r => r.issue_number);
    // Packs often bundle related volumes ("Showcase v1" with Showcase '93-'96).
    // Files whose series name is another volume are left alone: matching by
    // number alone would file "Showcase '93 01" as Showcase (1956) #1.
    // 'named': the file names this series exactly; 'loose': no readable name
    // (or an annual under the parent's name); false: another series.
    const seriesNameOk = (basename, num, annual) => {
      const fileKey = packFileSeriesKey(basename, num);
      if (fileKey == null) return 'loose';                  // no readable name: fall back to number matching
      const keys = annual
        ? [...annualSeriesMap.values()].map(a => packSeriesKey(a.series.name))
        : [packSeriesKey(series.name)];
      if (keys.includes(fileKey)) return 'named';
      // "Nightwing 2025 Annual" / "X-Men Annual" under the parent's name
      return !!annual && fileKey.startsWith(packSeriesKey(series.name) + ' ') && /\bannual\b/.test(fileKey) ? 'loose' : false;
    };
    const annualDone = (num, fy) => {
      const c = [];
      for (const { done: d = [] } of annualSeriesMap.values()) for (const i of d) if (issueNumMatches(i.issue_number, num)) c.push(i);
      const fit = fy ? c.filter(i => { const ys = issueYearsOf(i); return !ys.length || ys.includes(fy); }) : c;
      return fit.length === 1;
    };

    // Files this pass leaves unfiled (2026-11-10): saved when the pass ends, for the Queue tab's
    // "Pack files not filed" (View, File as issue…). Path inside the pack ('' = the pack itself).
    const leftovers = [];
    const leave = (comicPath, reason, detail = null) => leftovers.push({
      file: comicPath === pack.file_path ? '' : path.relative(workDir, comicPath), name: path.basename(comicPath), reason, detail });
    for (const comicPath of comicFiles) {
      const issueTmpDir = path.join(tmpDir, `issue_${path.basename(comicPath)}`);
      try {
        const basename = path.basename(comicPath);
        const extractedNum = extractIssueNumber(basename);
        const fileIsAnnual = /annual/i.test(basename);
        // "023.NOW" matches #23 when Comic Vine lists it without the branding.
        const regularNum = extractedNum ? IN.brandingFallback(extractedNum, cvNumbers) : extractedNum;

        // Try to match to a monitored issue
        // Annual files → search linked annual series only, never match regular issues
        // Regular files → search parent series only, never match annual issues
        let matchedIssue = null;
        let matchedSeries = series;

        const nameCheck = extractedNum ? seriesNameOk(basename, extractedNum, fileIsAnnual) : 'loose';
        if (!nameCheck) {
          otherSeries++; leave(comicPath, 'other_series');
          logger.info('pack-process', 'Another series in the pack; left alone', { file: basename });
          continue;
        }

        if (fileIsAnnual && extractedNum) {
          // Every year's annual is #1: collect all linked annual issues with this
          // number, keep those whose year matches the file's year, and only take
          // one when it is the only candidate. Never the first one found.
          const cands = [];
          for (const { series: aSeries, issues: aIssues } of annualSeriesMap.values()) {
            for (const i of aIssues) if (issueNumMatches(i.issue_number, extractedNum)) cands.push({ i, s: aSeries });
          }
          const fy = filenameYear(basename);
          const fit = fy ? cands.filter(c => { const ys = issueYearsOf(c.i); return !ys.length || ys.includes(fy); }) : cands;
          if (fit.length === 1) { matchedIssue = fit[0].i; matchedSeries = fit[0].s; }
          else if (fit.length > 1) logger.warn('pack-process', `Annual file — ${fit.length} annual issues #${extractedNum} fit; not matched`, { basename, year: fy });
          if (!matchedIssue) {
            logger.info('pack-process', `Annual file — no linked annual series match for #${extractedNum}`, { basename });
          }
        } else if (!fileIsAnnual && extractedNum) {
          matchedIssue = seriesIssues.find(i => issueNumMatches(i.issue_number, regularNum)) || null;
        }

        if (!matchedIssue && extractedNum && (fileIsAnnual
            ? annualDone(extractedNum, filenameYear(basename))
            : doneIssues.some(i => issueNumMatches(i.issue_number, regularNum)))) { done++; continue; }
        if (!matchedIssue && !fileIsAnnual && nameCheck === 'named' && cvNumbers.length && !cvNumbers.some(n => issueNumMatches(n, regularNum))) {
          notOnCv++; leave(comicPath, 'not_on_cv'); logger.info('pack-process', 'Not on Comic Vine (no such issue in this series); left in the pack', { file: basename }); continue;
        }
        if(!matchedIssue){unmatched++;leave(comicPath,'unmatched');logger.warn('pack-process','No safe issue candidate; source retained',{file:basename});continue;}
        // A regular file that names this series and matches a wanted issue's
        // number in a pack grabbed for this series identifies that issue, as
        // single downloads do (and as packs did before 2026-10-12, when arrivals
        // were unified and packs started needing a clean, Comic Vine-corroborated
        // filename: "Showcase v1 001 (1956) (c2c) (Flattermann) - Fire Fighters"
        // failed). A Comic Vine ID already inside the file still wins or forces
        // review. Annuals and unreadable names keep the stricter check.
        const trusted = nameCheck === 'named' && !fileIsAnnual;
        const result=await metadataRuntime.arrive({sourcePath:comicPath,sourceName:basename,issue:matchedIssue,directory:matchedSeries.directory||series.directory,matchedByFilename:!trusted});
        db.prepare("UPDATE monitored_issues SET status='processed',file_path=?,date_processed=datetime('now'),has_comicinfo=1 WHERE id=?").run(result.path,matchedIssue.id);
        processed++;
      } catch (e) {
        // Comic Vine limit: stop here and wait for the reset instead of failing
        // every remaining file. Nothing was written for this file.
        if (e.code === 'CV_RATE_LIMIT') { rateLimited = e; break; }
        failed++; leave(comicPath, 'failed', `${e.code ? e.code + ': ' : ''}${e.message}`.slice(0, 300)); logger.error('pack-process', `Failed on file ${path.basename(comicPath)}`, e.message);
        if(metadataRuntime.status().length)throw e;
      } finally {
        try { fs.rmSync(issueTmpDir, { recursive: true, force: true }); } catch {}
      }
    }

    if (rateLimited) {
      const until = sqlTime(rateLimited.retryAt);
      db.prepare(`UPDATE series_packs SET status = 'downloaded', retry_after = ?, fail_reason = ? WHERE id = ?`).run(until, CV_WAIT_REASON, pack.id);
      logger.info('pack-process', `Pack ${pack.id} paused for the Comic Vine limit; resumes at ${until} UTC`, { processed, done, failed, unmatched, otherSeries });
      if (processed) schedulePostProcessScan();
      return false;
    }
    saveLeftovers(pack, series, leftovers);
    if (!processed && !done && !failed && !unmatched && otherSeries) {
      // Nothing in the pack is named like this series: say so instead of
      // reporting a clean pack that filed nothing.
      const why = `No files named like ${series.name}; ${otherSeries} file(s) look like other series`;
      db.prepare(`UPDATE series_packs SET status = 'failed', fail_reason = ?, retry_after = NULL, failed_at = datetime('now') WHERE id = ?`).run(why, pack.id);
      logger.warn('pack-process', `Pack ${pack.id}: ${why}`);
      return false;
    }
    db.prepare("UPDATE series_packs SET status=?, fail_reason=?, retry_after=NULL, failed_at=CASE WHEN ?='failed' THEN datetime('now') ELSE failed_at END WHERE id=?")
      .run(failed || unmatched ? 'failed' : 'processed', failed || unmatched ? `${failed} failed, ${unmatched} unmatched file(s)` : null, failed || unmatched ? 'failed' : 'processed', pack.id);
    logger.info('pack-process', `Pack ${pack.id} complete`, { processed, done, unmatched, notOnCv, otherSeries, coverFiles, damaged: damagedFiles.length || undefined });

    // Clean up source file if it came from the DDL download folder
    const ddlDir = getSetting('ddl_download_path') || '/downloads/getcomics';
    // Kept when it holds files Comic Vine has no record of (their only copy).
    if (!failed && !unmatched && !notOnCv && pack.file_path && pack.file_path.startsWith(ddlDir) && fs.existsSync(pack.file_path)) {
      try { fs.unlinkSync(pack.file_path); logger.info('pack-process', `Deleted source file`, { file: pack.file_path }); } catch {}
    }

    // Schedule a library scan to pick up the new files
    schedulePostProcessScan();

    return !failed && !unmatched;
  } catch (e) {
    logger.error('pack-process', `Pack ${pack.id} failed`, e.message);
    const held = e.code === 'LIBRARY_RECOVERY_REQUIRED' || metadataRuntime.status().length > 0;
    db.prepare(`UPDATE series_packs SET status = 'failed', fail_reason = ?, failed_at = datetime('now') WHERE id = ?`)
      .run(held ? 'LIBRARY_RECOVERY_REQUIRED' : String(e.code || e.message || 'error').slice(0, 300), pack.id);
    return false;
  } finally {
    if(!metadataRuntime.status().some(op=>op.source && path.relative(tmpDir,op.source).split(path.sep)[0]!=='..' && !path.isAbsolute(path.relative(tmpDir,op.source)))) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  }
}

// ─── Pack files not filed (2026-11-10) ────────────────────────────
// A pack pass can leave files unfiled: no matching wanted issue, named like another series,
// not on Comic Vine, or failed. They are listed in Download Manager › Queue while the pack
// file is on disk; an admin can View a file's cover or File it as an issue they choose
// (as Process anyway: the admin's choice is the identity), or delete the whole pack file.
db.exec(`CREATE TABLE IF NOT EXISTS pack_leftovers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, pack_id INTEGER NOT NULL, series_id TEXT, file TEXT NOT NULL, name TEXT NOT NULL,
  reason TEXT NOT NULL, detail TEXT, status TEXT NOT NULL DEFAULT 'open', issue_id TEXT, created_at TEXT DEFAULT (datetime('now')));
  CREATE INDEX IF NOT EXISTS pack_leftovers_pack ON pack_leftovers(pack_id, status);`);
function saveLeftovers(pack, series, list) {
  try {
    db.prepare("DELETE FROM pack_leftovers WHERE pack_id = ? AND status = 'open'").run(pack.id);
    const add = db.prepare('INSERT INTO pack_leftovers (pack_id, series_id, file, name, reason, detail) VALUES (?, ?, ?, ?, ?, ?)');
    for (const l of list) add.run(pack.id, String(series.id), l.file, l.name, l.reason, l.detail);
  } catch (e) { logger.warn('pack-process', `Pack ${pack.id}: unfiled files not recorded`, e.message); }
}

const COMIC = /\.(cbz|cbr|zip|rar|7z|cb7)$/i;
const scratchDir = () => path.join(path.dirname(DB_PATH), 'metadata-pack-' + crypto.randomUUID());
const insideDir = (root, p) => { const rel = path.relative(root, p); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
function leftoverOf(req, res) {
  const lo = db.prepare("SELECT * FROM pack_leftovers WHERE id = ? AND status = 'open'").get(Number(req.params.id));
  if (!lo) { res.status(404).json({ error: 'Not found (it may already be filed)' }); return null; }
  const pack = db.prepare('SELECT * FROM series_packs WHERE id = ?').get(lo.pack_id);
  if (!pack || !pack.file_path || !fs.existsSync(pack.file_path)) { res.status(409).json({ error: 'The pack file is no longer on disk' }); return null; }
  if (pack.status === 'processing') { res.status(409).json({ error: 'The pack is being processed right now' }); return null; }
  return { lo, pack };
}
// The file itself: from a folder pack on disk, the pack file when it is the issue, or
// pulled out of the archive into `scratch` (never through a link the archive made).
async function memberFile(pack, lo, scratch) {
  if (!lo.file) return pack.file_path;
  if (fs.statSync(pack.file_path).isDirectory()) {
    const p = path.resolve(pack.file_path, lo.file);
    if (!insideDir(fs.realpathSync(pack.file_path), fs.realpathSync(p))) throw Object.assign(new Error('File is outside the pack folder'), { code: 'UNSAFE_PATH' });
    return p;
  }
  fs.mkdirSync(scratch, { recursive: true });
  const C = { ...process.env, LANG: 'C', LC_ALL: 'C' };
  const pattern = lo.file.replace(/[\\*?[\]]/g, ch => '\\' + ch);   // bsdtar names are patterns
  try { await execFileAsync('bsdtar', ['-xf', pack.file_path, '-C', scratch, '--', pattern], { env: C, maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) {
    if (!/\.(rar|cbr)$/i.test(pack.file_path)) throw e;
    await execFileAsync('unrar', ['x', '-inul', '-y', pack.file_path, '--', lo.file, scratch + '/'], { maxBuffer: 64 * 1024 * 1024 });
  }
  const p = path.resolve(scratch, lo.file);
  if (!fs.existsSync(p) || !insideDir(fs.realpathSync(scratch), fs.realpathSync(p))) throw Object.assign(new Error('The file could not be taken out of the pack'), { code: 'EXTRACT_FAILED' });
  return p;
}
const dropScratch = scratch => {
  const busy = metadataRuntime.status().some(op => op.source && insideDir(scratch, op.source));
  if (!busy) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {} }
};
// The pack's series and its linked annual series: the issues a file may be filed as.
function candidateIssues(pack) {
  const ids = [String(pack.series_id), ...db.prepare('SELECT annual_series_id FROM series_annual_links WHERE parent_series_id = ?').all(pack.series_id).map(r => String(r.annual_series_id))];
  return db.prepare(`SELECT i.id, i.issue_number, i.status, i.series_id, s.name AS series_name, s.year AS series_year
    FROM monitored_issues i JOIN monitored_series s ON s.id = i.series_id
    WHERE i.series_id IN (${ids.map(() => '?').join(',')}) AND i.status != 'processed'
    ORDER BY i.series_id = ? DESC, s.name COLLATE NOCASE, CAST(i.issue_number AS REAL), i.issue_number`).all(...ids, String(pack.series_id));
}

app.get('/api/admin/pack-leftovers/:id/issues', requireAdmin, (req, res) => {
  const x = leftoverOf(req, res); if (!x) return;
  res.json({ issues: candidateIssues(x.pack).map(i => ({ id: i.id, label: `${i.series_name}${i.series_year ? ` (${i.series_year})` : ''} #${i.issue_number}`, status: i.status })) });
});

app.get('/api/admin/pack-leftovers/:id/cover', requireAdmin, async (req, res) => {
  const x = leftoverOf(req, res); if (!x) return;
  const scratch = scratchDir();
  try {
    const file = await memberFile(x.pack, x.lo, scratch);
    const first = filterImages(await listArchiveFiles(file) || [])[0];
    if (!first) return res.status(404).json({ error: 'No pages found in the file' });
    const out = await coverThumb(await readArchiveMember(file, first), path.extname(first));
    res.set('Cache-Control', 'no-store').type(out.mime).send(out.buf);
  } catch (e) {
    logger.warn('pack-process', `Cover of unfiled pack file ${x.lo.id} could not be read`, e.message);
    res.status(500).json({ error: 'The cover could not be read' });
  } finally { dropScratch(scratch); }
});

app.post('/api/admin/pack-leftovers/:id/file', requireAdmin, async (req, res) => {
  const x = leftoverOf(req, res); if (!x) return;
  const issue = candidateIssues(x.pack).find(i => String(i.id) === String(req.body?.issueId));
  if (!issue) return res.status(400).json({ error: 'Choose an issue of this series that is not in the library yet' });
  const full = db.prepare('SELECT * FROM monitored_issues WHERE id = ?').get(issue.id);
  const issueSeries = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(issue.series_id);
  const packSeries = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(x.pack.series_id);
  const scratch = scratchDir();
  try {
    const src = await memberFile(x.pack, x.lo, scratch);
    logger.info('pack-process', `Pack ${x.pack.id}: "${x.lo.name}" filed as ${issue.series_name} #${issue.issue_number} by ${req.user?.username || 'admin'}`);
    const result = await asArrival('pack-process', () => metadataRuntime.arrive({ sourcePath: src, sourceName: x.lo.name, issue: full,
      directory: issueSeries?.directory || packSeries?.directory, force: true }));
    db.prepare("UPDATE monitored_issues SET status='processed',file_path=?,date_processed=datetime('now'),has_comicinfo=1 WHERE id=?").run(result.path, issue.id);
    db.prepare("UPDATE pack_leftovers SET status = 'filed', issue_id = ? WHERE id = ?").run(String(issue.id), x.lo.id);
    schedulePostProcessScan(result.path);
    res.json({ ok: true, path: result.path });
  } catch (e) {
    logger.warn('pack-process', `Pack ${x.pack.id}: "${x.lo.name}" could not be filed`, { code: e.code, error: e.message });
    const why = e.code === 'DESTINATION_OCCUPIED' ? 'That issue already has a file in the library' : e.code === 'ARCHIVE_DAMAGED' ? 'The file is damaged' : e.message;
    res.status(409).json({ error: why, code: e.code || null });
  } finally { dropScratch(scratch); }
});

// The whole pack file (or folder), only inside a download folder; its unfiled files go with it.
app.post('/api/admin/series-packs/:id/delete-file', requireAdmin, (req, res) => {
  const pack = db.prepare('SELECT * FROM series_packs WHERE id = ?').get(Number(req.params.id));
  if (!pack) return res.status(404).json({ error: 'Pack not found' });
  if (pack.status === 'processing') return res.status(409).json({ error: 'The pack is being processed right now' });
  const target = deletableDownload({ fs, path, db, getSetting }, pack.file_path);
  if (!target) return res.status(409).json({ error: 'The pack is not in a download folder; delete it by hand' });
  try { fs.rmSync(target, { recursive: fs.statSync(target).isDirectory(), force: true }); }
  catch (e) { return res.status(500).json({ error: `Could not delete the pack: ${e.message}` }); }
  db.prepare("UPDATE pack_leftovers SET status = 'deleted' WHERE pack_id = ? AND status = 'open'").run(pack.id);
  if (pack.status !== 'processed') db.prepare("UPDATE series_packs SET status = 'failed', fail_reason = 'Pack file deleted by an admin', retry_after = NULL WHERE id = ?").run(pack.id);
  logger.info('pack-process', `Pack ${pack.id} file deleted by ${req.user?.username || 'admin'}`, { file: path.basename(pack.file_path) });
  res.json({ ok: true });
});

return { postProcessPack, packHoldsPages, packSeriesKey, packFileSeriesKey, issueNumMatches };
};
