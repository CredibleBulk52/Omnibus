'use strict';
// ─── Library import (moved out of server.js 2026-11-23, server.js split step 7B) ───
// Scan a folder for series, match each to a Comic Vine volume, show a cover from the files, re-match one,
// and import the chosen series as monitored series. Moved unchanged. server.js wraps the cover read
// (extractArchiveImage) with the library read lock once the file has loaded (wrapReads).
const fs = require('fs');
const path = require('path');
const { parseFolderName, nameSimilarity } = require('./names');

const NEEDS = ['app', 'autoDiscoverAnnuals', 'COMICS_PATH', 'cvApiGet', 'db', 'fetchAndSetSeriesStatus', 'filterImages', 'getCVKey', 'listArchiveFiles', 'logger', 'makeScanStmts', 'metadataMaintenance', 'readArchiveMember', 'runRefreshDirectory', 'scanSeriesComicInfo', 'scanSeriesDir'];
module.exports.NEEDS = NEEDS;

module.exports.registerLibraryImport = function registerLibraryImport(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`registerLibraryImport: missing ${missing.join(', ')}`);
  const { app, autoDiscoverAnnuals, COMICS_PATH, cvApiGet, db, fetchAndSetSeriesStatus, filterImages, getCVKey, listArchiveFiles, logger, makeScanStmts, metadataMaintenance, readArchiveMember, runRefreshDirectory, scanSeriesComicInfo, scanSeriesDir } = deps;
  // ─── Library Import ──────────────────────────────────────────────

  // folderTitleYear, parseFolderName and nameSimilarity: names.js (2026-11-19).

  // Known English-language publishers. Anything NOT on this list is treated as a
  // potential foreign / republisher and heavily demoted during import scoring.
  // Exception: if nameSimilarity >= 0.95 the penalty is skipped — that score means
  // the series is essentially unique to that publisher (no English version exists).
  const ENGLISH_PUBLISHERS = new Set([
    // Big two
    'dc comics', 'dc', 'marvel comics', 'marvel',
    // Major independents
    'image comics', 'dark horse comics', 'dark horse',
    'idw publishing', 'idw', 'boom! studios', 'boom studios',
    'dynamite entertainment', 'dynamite',
    'oni press', 'fantagraphics books', 'fantagraphics',
    'drawn and quarterly', 'drawn & quarterly',
    'top shelf productions', 'top shelf',
    'archie comics', 'archie comic publications',
    'valiant entertainment', 'valiant',
    'aftershock comics', 'aftershock',
    'vault comics', 'scout comics', 'ahoy comics',
    'titan comics', 'titan publishing group',
    'zenescope entertainment', 'zenescope',
    'avatar press', 'black mask studios',
    'action lab entertainment', 'action lab',
    'alterna comics', 'antarctic press',
    'aspen comics', 'aspen mlt',
    'heavy metal', 'heavy metal magazine',
    'harris comics', 'harris publications',
    'crossgen comics', 'crossgen',
    'wildstorm', 'dc/wildstorm',
    'vertigo', 'dc vertigo',
    'abc comics', "america's best comics",
    'aardvark-vanaheim',
    'kitchen sink press',
    'eclipse comics',
    'first comics',
    'comico',
    'pacific comics',
    'innovation publishing',
    'continuity comics',
    'charlton comics',
    'dell comics',
    'gold key comics', 'gold key',
    'harvey comics',
    'quality comics',
    'fawcett comics',
    'ec comics',
    'atlas comics',
    'prize comics',
    'lev gleason publications',
    'fiction house',
    'ace comics',
    // Imprints commonly listed as publisher on CV
    'focus', 'minx', 'piranha press', 'paradox press',
    'helix', 'mad', 'zuda',
  ]);

  /** Score a CV volume candidate for import matching.
   *  Returns 0–1 float; confidence display = Math.round(score * 100). */
  function scoreCvCandidate(candidate, parsedName, parsedYear, fileCount) {
    let nameSim = Math.min(nameSimilarity(parsedName, candidate.name || ''), 1.0);

    // Year scoring — when we have a parsed year, wrong years are penalised not just un-bonused.
    // Asymmetric: a series that started BEFORE the folder year is less bad than one that
    // started after (handles series that ran through a publishing rebranding, e.g. Batman
    // (2016) filed under a "2023" folder when the Dawn of DC era began).
    let yearAdjust = 0;
    if (parsedYear && candidate.start_year) {
      const cvYear = parseInt(candidate.start_year);
      const diff = cvYear - parsedYear; // negative = candidate started before folder year
      const absDiff = Math.abs(diff);
      if (absDiff === 0)       yearAdjust = +0.25; // exact match
      else if (absDiff === 1)  yearAdjust = +0.10; // off by one
      else if (diff < 0 && absDiff <= 10) yearAdjust = -0.10; // started before — lighter penalty
      else if (absDiff <= 3)   yearAdjust = -0.15; // started after, close — moderate penalty
      else                     yearAdjust = -0.35; // started after, far — heavy penalty
    } else if (parsedYear && !candidate.start_year) {
      yearAdjust = -0.10; // CV has no year data — slight skepticism
    }

    let score = nameSim + yearAdjust; // max possible: 1.25

    // Foreign / republisher penalty — whitelist approach.
    // Any publisher not on the known English whitelist gets a heavy 0.15 multiplier.
    // No exemption for name similarity — DC Comics and Panini Comics can both have a
    // series called "Action Comics"; only the publisher check decides the penalty.
    const pub = (candidate.publisher?.name || '').toLowerCase();
    const isKnownEnglish = ENGLISH_PUBLISHERS.has(pub);
    if (!isKnownEnglish) score *= 0.15;

    // Issue count — defined early so TPB check can use it
    const issues = candidate.count_of_issues || 0;

    // TPB / collected edition penalty — only apply when issue count doesn't closely
    // match file count. If CV says 6 issues and we have 6 files, it's almost certainly
    // the right series even if the description mentions a trade paperback.
    const desc = (candidate.description || '').toLowerCase();
    const isTpbDesc = /trade paperback|collected edition|tpb|hardcover collection|omnibus|compendium/.test(desc);
    const issueProximity = (fileCount && issues > 0)
      ? Math.max(0, 1 - Math.abs(issues - fileCount) / Math.max(issues, fileCount))
      : 0;
    if (isTpbDesc && issueProximity < 0.8) score *= 0.50;

    // Issue count proximity bonus — gentle nudge, not a decider.
    if (fileCount && issues > 0) {
      score += issueProximity * 0.10;
    }

    // Normalise to 0–1 (max possible: 1.0 name + 0.25 year + 0.10 proximity = 1.35)
    return Math.max(0, Math.min(score / 1.35, 1.0));
  }

  // Scan a directory and return series candidates with auto CV match
  app.post('/api/import/scan', async (req, res) => {
    const { scanPath } = req.body;
    if (!scanPath) return res.status(400).json({ error: 'scanPath required' });

    // Safety: must be inside the comics folder after resolving symlinks
    let resolved;
    try { resolved = require('./pathSecurity').resolveExistingWithinRoot(COMICS_PATH, scanPath); }
    catch (e) { return res.status(e.status || 500).json({ error: e.status === 403 ? 'Path must be inside the comics folder' : e.status ? e.message : 'Unable to read directory' }); }

    let subdirs;
    try {
      subdirs = fs.readdirSync(resolved, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    if (!subdirs.length) return res.json({ series: [] });

    const CV_API_KEY = getCVKey();
    const alreadyMonitored = new Set(
      db.prepare('SELECT directory FROM monitored_series').all().map(r => r.directory)
    );

    const results = [];

    for (const dirName of subdirs) {
      const fullPath = path.join(resolved, dirName);

      // Count comic files in this dir
      let fileCount = 0;
      try {
        fileCount = fs.readdirSync(fullPath)
          .filter(f => /\.(cbz|cbr|zip|rar|pdf)$/i.test(f)).length;
      } catch {}

      // Skip dirs with no comic files (likely not a series dir)
      if (fileCount === 0) continue;

      const { name: parsedName, year: parsedYear } = parseFolderName(dirName);
      const alreadyAdded = alreadyMonitored.has(fullPath);

      // ── series.json short-circuit ─────────────────────────────────
      // If an enriched series.json already exists with a CV ID, use it directly —
      // no API call needed. This eliminates the majority of CV calls on large
      // libraries that have already been through the enrich pipeline.
      let cvMatch = null;
      const seriesJsonFile = path.join(fullPath, 'series.json');
      if (fs.existsSync(seriesJsonFile)) {
        try {
          const sjData = JSON.parse(fs.readFileSync(seriesJsonFile, 'utf8'));
          const m = sjData.metadata || sjData;
          if (m.comicid) {
            cvMatch = {
              id:           String(m.comicid),
              name:         m.name || parsedName,
              year:         m.year || parsedYear,
              publisher:    m.publisher || null,
              total_issues: m.total_issues || null,
              image_url:    m.image_url || null,
              cv_url:       m.site_detail_url || null,
              description:  (m.description_text || '').substring(0, 200),
              confidence:   99,
              alternatives: [],
              _from_series_json: true,
            };
          }
        } catch (e) {
          logger.warn('import-scan', `series.json read failed for "${dirName}"`, e.message);
        }
      }

      // ── CV search (only when series.json gave us nothing) ─────────
      if (!cvMatch) {
        try {
        const cleanName = parsedName.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
        const cvSearchParams = {
          api_key: getCVKey(), format: 'json',
          resources: 'volume',
          limit: 25,
          field_list: 'id,name,start_year,publisher,count_of_issues,image,site_detail_url,description',
        };
        const r = await cvApiGet('https://comicvine.gamespot.com/api/search', {
          params: { ...cvSearchParams, query: cleanName },
          headers: { 'User-Agent': 'Omnibus/1.0' },
          timeout: 10000,
        });
        let candidates = r.data.results || [];

        // Fallback: if best score is low, retry with typo-corrected query.
        // Strips the trailing character from any word >4 chars ("Evile"->"Evil").
        // Catches the common "extra letter at end" typo. Only fires if top score < 0.65.
        const quickBest = candidates.length
          ? Math.max(...candidates.map(c => scoreCvCandidate(c, parsedName, parsedYear, fileCount)))
          : 0;
        if (quickBest < 0.65) {
          // Only trim the last word — that's almost always where the typo is.
          // Trimming all words corrupts correctly-spelled words (e.g. "Absolute"→"Absolut").
          const words = cleanName.split(/\s+/);
          const lastWord = words[words.length - 1];
          const corrected = lastWord.length > 4
            ? [...words.slice(0, -1), lastWord.slice(0, -1)].join(' ')
            : cleanName;
          if (corrected !== cleanName) {
            await new Promise(res => setTimeout(res, 600));
            const r2 = await cvApiGet('https://comicvine.gamespot.com/api/search', {
              params: { ...cvSearchParams, query: corrected },
              headers: { 'User-Agent': 'Omnibus/1.0' },
              timeout: 10000,
            });
            const seen = new Set(candidates.map(c => c.id));
            for (const c of r2.data.results || []) {
              if (!seen.has(c.id)) { candidates.push(c); seen.add(c.id); }
            }
          }
        }

        // Score candidates using full scoring function (name, year, publisher, issue count)
        const scored = candidates
          .map(c => ({ ...c, _score: scoreCvCandidate(c, parsedName, parsedYear, fileCount) }))
          .sort((a, b) => b._score - a._score);

        if (scored.length > 0) {
          const top = scored[0];
          cvMatch = {
            id:           String(top.id),
            name:         top.name,
            year:         top.start_year,
            publisher:    top.publisher?.name || null,
            total_issues: top.count_of_issues || 0,
            image_url:    top.image?.medium_url || null,
            cv_url:       top.site_detail_url || null,
            description:  (top.description || '').substring(0, 200),
            confidence:   Math.round(top._score * 100),
            // Include top 10 alternatives for user override
            alternatives: scored.slice(0, 10).map(c => ({
              id: String(c.id), name: c.name, year: c.start_year,
              publisher: c.publisher?.name || null,
              total_issues: c.count_of_issues || 0,
              image_url: c.image?.medium_url || null,
              cv_url: c.site_detail_url || null,
              description: (c.description || '').substring(0, 200),
              confidence: Math.round(c._score * 100),
            })),
          };
        }
      } catch (e) {
        logger.warn('import-scan', `CV search failed for "${parsedName}"`, e.message);
      }
      } // end if (!cvMatch)

      results.push({
        directory:   fullPath,
        folderName:  dirName,
        parsedName,
        parsedYear,
        fileCount,
        alreadyAdded,
        cvMatch,
      });

      // Rate-limit delay only needed when we actually hit CV
      if (!cvMatch?._from_series_json) {
        await new Promise(r => setTimeout(r, 1100));
      }
    }

    res.json({ series: results, scanned: subdirs.length });
  });

  // Concurrency limiter for disk-cover extractions — mirrors THUMB_CONCURRENCY so
  // a full import scan list (40+ rows) doesn't spawn 40 simultaneous 7z processes.
  let _diskCoverActive = 0;
  const _diskCoverQueue = [];
  function acquireDiskCoverSlot() {
    return new Promise(resolve => {
      const attempt = () => {
        if (_diskCoverActive < 4) {
          _diskCoverActive++;
          resolve(() => {
            _diskCoverActive--;
            const next = _diskCoverQueue.shift();
            if (next) next();
          });
        } else {
          _diskCoverQueue.push(attempt);
        }
      };
      attempt();
    });
  }

  // Extract first image bytes from a comic archive.
  // 7z exits with code 1 (warning) on many valid archives — catch and rescue stdout
  // when it contains real image data rather than discarding good bytes.
  async function extractArchiveImage(filePath, imageName) {
    return readArchiveMember(filePath, imageName, 10 * 1024 * 1024);
  }

  // Serve the cover image of the first comic file found in a scanned directory.
  // Used by the import UI to show the on-disk cover alongside the CV match cover.
  app.get('/api/import/disk-cover', async (req, res) => {
    const { directory } = req.query;
    if (!directory) return res.status(400).json({ error: 'directory required' });

    // Safety: must be under the configured comics root
    let resolved;
    try { resolved = require('./pathSecurity').resolveExistingWithinRoot(COMICS_PATH, directory); }
    catch (e) { return res.status(e.status || 500).json({ error: e.status ? e.message : 'Unable to read directory' }); }

    // Find first comic file alphabetically
    let comicFiles;
    try {
      comicFiles = fs.readdirSync(resolved)
        .filter(f => /\.(cbz|cbr|zip|rar|pdf)$/i.test(f))
        .sort();
    } catch {
      return res.status(404).json({ error: 'Directory not found' });
    }
    if (!comicFiles.length) return res.status(404).json({ error: 'No comic files' });

    let firstFile;
    try { firstFile = require('./pathSecurity').resolveExistingWithinRoot(fs.realpathSync(COMICS_PATH), path.join(resolved, comicFiles[0])); }
    catch (e) { return res.status(e.status || 500).json({ error: e.status ? e.message : 'Unable to read comic file' }); }
    const release = await acquireDiskCoverSlot();
    try {
      const archiveFiles = await listArchiveFiles(firstFile);
      const images = filterImages(archiveFiles);
      if (!images.length) return res.status(404).json({ error: 'No images in archive' });

      const imageBuffer = await extractArchiveImage(firstFile, images[0]);

      const imgExt = path.extname(images[0]).toLowerCase();
      const contentType =
        imgExt === '.png'  ? 'image/png'  :
        imgExt === '.gif'  ? 'image/gif'  :
        imgExt === '.webp' ? 'image/webp' :
        'image/jpeg';

      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(imageBuffer);
    } catch (e) {
      logger.warn('disk-cover', `Failed to extract cover from ${path.basename(firstFile)}: ${e.message}`);
      res.status(500).json({ error: 'Extraction failed' });
    } finally {
      release();
    }
  });

  // Re-search CV for a single directory using a custom query string
  // Called when user edits the search term in the import UI for a specific row
  app.post('/api/import/rescan-one', async (req, res) => {
    const { directory, query } = req.body;
    if (!directory || !query) return res.status(400).json({ error: 'directory and query required' });
    let safeDirectory;
    try { safeDirectory = require('./pathSecurity').resolveCreatableWithinRoot(COMICS_PATH, directory); }
    catch (e) { return res.status(e.status || 500).json({ error: e.status ? e.message : 'Unable to read directory' }); }

    const CV_API_KEY = getCVKey();
    const dirName = path.basename(directory);
    const { name: parsedName, year: parsedYear } = parseFolderName(dirName);

    let fileCount = 0;
    try {
      fileCount = require('fs').readdirSync(safeDirectory)
        .filter(f => /\.(cbz|cbr|zip|rar|pdf)$/i.test(f)).length;
    } catch {}

    // Detect direct CV URL or numeric ID — skip search entirely
    const cvIdMatch = query.trim().match(/(?:4050-)?(\d{4,})/);
    const isDirectId = /comicvine\.gamespot\.com/.test(query) || /^\d{4,}$/.test(query.trim());

    if (isDirectId && cvIdMatch) {
      try {
        const cvId = cvIdMatch[1];
        const r = await cvApiGet(`https://comicvine.gamespot.com/api/volume/4050-${cvId}/`, {
          params: { api_key: getCVKey(), format: 'json', field_list: 'id,name,start_year,publisher,count_of_issues,image,site_detail_url,description' },
          headers: { 'User-Agent': 'Omnibus/1.0' },
          timeout: 10000,
        });
        const v = r.data.results;
        if (!v) return res.json({ cvMatch: null });
        const entry = {
          id: String(v.id), name: v.name, year: v.start_year,
          publisher: v.publisher?.name || null,
          total_issues: v.count_of_issues || 0,
          image_url: v.image?.medium_url || null,
          cv_url: v.site_detail_url || null,
          description: (v.description || '').substring(0, 200),
          confidence: 100,
        };
        return res.json({ cvMatch: { ...entry, alternatives: [entry] } });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    try {
      const FIELD_LIST = 'id,name,start_year,publisher,count_of_issues,image,site_detail_url,description';
      const q = query.trim();

      // Detect "name YYYY" pattern — use CV volumes filter API for precise year+name match
      // e.g. "action comics 2016" → filter=name:action comics,start_year:2016
      const ys = /\s(\d{4})$/.exec(q);   // linear, unlike /^(.+?)\s+(\d{4})$/ (CodeQL polynomial-redos)
      const yearSuffixMatch = ys && q.slice(0, ys.index).trim() ? [q, q.slice(0, ys.index).trim(), ys[1]] : null;
      let candidates = [];

      if (yearSuffixMatch) {
        const namePart = yearSuffixMatch[1].trim();
        const yearPart = yearSuffixMatch[2];
        // Run both in parallel: filtered (exact year) + plain search (fallback)
        const [filteredRes, searchRes] = await Promise.allSettled([
          cvApiGet('https://comicvine.gamespot.com/api/volumes/', {
            params: { api_key: getCVKey(), format: 'json', limit: 10,
              field_list: FIELD_LIST,
              filter: `name:${namePart},start_year:${yearPart}` },
            headers: { 'User-Agent': 'Omnibus/1.0' }, timeout: 10000,
          }),
          cvApiGet('https://comicvine.gamespot.com/api/search', {
            params: { api_key: getCVKey(), format: 'json', resources: 'volume',
              limit: 25, field_list: FIELD_LIST, query: namePart },
            headers: { 'User-Agent': 'Omnibus/1.0' }, timeout: 10000,
          }),
        ]);
        const filtered = filteredRes.status === 'fulfilled' ? (filteredRes.value.data.results || []) : [];
        const searched = searchRes.status === 'fulfilled' ? (searchRes.value.data.results || []) : [];
        // Merge, filtered results first, dedup by id
        const seen = new Set();
        for (const c of [...filtered, ...searched]) {
          if (!seen.has(c.id)) { candidates.push(c); seen.add(c.id); }
        }
      } else {
        const r = await cvApiGet('https://comicvine.gamespot.com/api/search', {
          params: { api_key: getCVKey(), format: 'json', resources: 'volume',
            limit: 50, field_list: FIELD_LIST, query: q },
          headers: { 'User-Agent': 'Omnibus/1.0' }, timeout: 10000,
        });
        candidates = r.data.results || [];
      }

      // If the user typed a year in their query (e.g. "action comics 2016") use that year
      // for scoring — overrides the folder's parsedYear when one wasn't present.
      // This ensures the year the user explicitly asked for actually influences the result.
      const queryYear = yearSuffixMatch ? parseInt(yearSuffixMatch[2]) : null;
      const scoreYear = queryYear || parsedYear;
      logger.debug('import-rescan', `Scoring: parsedName=${parsedName} parsedYear=${parsedYear} queryYear=${queryYear} scoreYear=${scoreYear} candidates=${candidates.length}`);

      const scored = candidates
        .map(c => ({ ...c, _score: scoreCvCandidate(c, parsedName, scoreYear, fileCount) }))
        .sort((a, b) => b._score - a._score);

      const top = scored[0];
      if (!top) return res.json({ cvMatch: null });

      res.json({
        cvMatch: {
          id:           String(top.id),
          name:         top.name,
          year:         top.start_year,
          publisher:    top.publisher?.name || null,
          total_issues: top.count_of_issues || 0,
          image_url:    top.image?.medium_url || null,
          cv_url:       top.site_detail_url || null,
          description:  (top.description || '').substring(0, 200),
          confidence:   Math.round(top._score * 100),
          alternatives: scored.slice(0, 10).map(c => ({
            id: String(c.id), name: c.name, year: c.start_year,
            publisher: c.publisher?.name || null,
            total_issues: c.count_of_issues || 0,
            image_url: c.image?.medium_url || null,
            cv_url: c.site_detail_url || null,
            description: (c.description || '').substring(0, 200),
            confidence: Math.round(c._score * 100),
          })),
        }
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Execute import for confirmed series selections
  app.post('/api/import/execute', async (req, res) => {
    const { selections } = req.body;
    // selections: [{ directory, cvId, name, publisher, year, total_issues, image_url, cv_url }]
    if (!Array.isArray(selections) || !selections.length) {
      return res.status(400).json({ error: 'selections array required' });
    }

    const CV_API_KEY = getCVKey();
    const results = [];

    for (const sel of selections) {
      const { directory, cvId, name, publisher, year, total_issues, image_url, cv_url } = sel;
      const result = { directory, name, cvId, status: 'pending' };

      try {
        // Ensure directory exists, inside the comics folder only
        const safeDirectory = require('./pathSecurity').resolveCreatableWithinRoot(COMICS_PATH, directory);
        if (!fs.existsSync(safeDirectory)) fs.mkdirSync(safeDirectory, { recursive: true });

        // Insert or replace series record
        db.prepare(`
        INSERT OR REPLACE INTO monitored_series
          (id, name, publisher, year, total_issues, image_url, cv_url, directory, last_cv_check)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(cvId, name, publisher || null, year || null, total_issues || 0, image_url || null, cv_url || null, directory);

        // Fetch all issues from CV
        let offset = 0, allIssues = [], total = Infinity;
        while (allIssues.length < total) {
          const r = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
            params: {
              api_key: getCVKey(), format: 'json',
              filter: `volume:${cvId}`,
              field_list: 'id,issue_number,name,cover_date,store_date,site_detail_url,description,person_credits,character_credits,team_credits,location_credits',
              offset, limit: 100,
            },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 15000,
          });
          total = r.data.number_of_total_results || 0;
          const batch = r.data.results || [];
          allIssues = allIssues.concat(batch);
          if (!batch.length) break;
          offset += 100;
          await new Promise(r => setTimeout(r, 600));
        }

        // Insert issues
        const isAnnual = (num, n) => ((num || '') + ' ' + (n || '')).toLowerCase().includes('annual') ? 1 : 0;
        const insertIssue = db.prepare(`
        INSERT OR IGNORE INTO monitored_issues
          (id, series_id, issue_number, title, release_date, store_date, cv_data, is_annual)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
        db.transaction(issues => {
          for (const i of issues) {
            insertIssue.run(String(i.id), cvId, i.issue_number || '0',
              i.name || null, i.cover_date || null, i.store_date || null,
              JSON.stringify(i), isAnnual(i.issue_number, i.name));
          }
        })(allIssues);

        db.prepare(`UPDATE monitored_series SET total_issues = ? WHERE id = ?`).run(allIssues.length, cvId);

        // Run directory refresh to match existing files → mark processed
        let matched = 0;
        try {
          const refreshResult = await runRefreshDirectory(cvId);
          matched = refreshResult.matched || 0;
        } catch (e) {
          logger.warn('import', `Refresh failed for "${name}"`, e.message);
        }

        // Scan ComicInfo.xml presence immediately so the UI shows correct
        // untagged counts without requiring a manual refresh button press.
        try {
          const ciResult = await scanSeriesComicInfo(cvId, { onlyUnknown: true });
          if (ciResult.scanned > 0) {
            logger.info('import', `ComicInfo scan: ${ciResult.scanned} files checked for "${name}"`);
          }
        } catch (e) {
          logger.warn('import', `ComicInfo scan failed for "${name}"`, e.message);
        }

        // Set ongoing/ended status from CV
        await fetchAndSetSeriesStatus(cvId);

        // Discover standalone annual volumes — brings Import to parity with Add Series
        setImmediate(() =>
          autoDiscoverAnnuals(cvId, name, directory)
            .catch(e => logger.warn('import', `Annual discovery failed for "${name}"`, e.message))
        );

        const library=db.prepare('SELECT * FROM libraries').all().filter(l=>{const rel=path.relative(l.path,directory);return !rel||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));}).sort((a,b)=>b.path.length-a.path.length)[0];
        if(library){
          const stmts=makeScanStmts();await scanSeriesDir(directory,library.id,stmts.upsertSeries,stmts.upsertBook,'import');
          for(const book of db.prepare('SELECT id FROM scanned_books WHERE path LIKE ?').all(directory+path.sep+'%'))metadataMaintenance.enqueue(book.id,'import');
        }
        result.status = 'imported';
        result.issues_fetched = allIssues.length;
        result.files_matched = matched;
        logger.info('import', `Imported series "${name}"`, { cvId, issues: allIssues.length, matched });

      } catch (e) {
        result.status = 'error';
        result.error = e.message;
        logger.error('import', `Failed to import "${name}"`, e.message);
      }

      results.push(result);
      // Small delay between series to avoid hammering CV
      await new Promise(r => setTimeout(r, 500));
    }

    res.json({ results });
  });

  // The library read lock (server.js, once everything has loaded), as server.js did for its own name.
  function wrapReads(wrap) { extractArchiveImage = wrap('read', extractArchiveImage); }
  return { wrapReads };
};
