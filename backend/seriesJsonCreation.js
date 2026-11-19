'use strict';
// ─── Creating series.json for a monitored series (moved out of server.js 2026-11-19, server.js split step 7A) ───
// createSeriesJsonIfMissing (the enricher's "create" in a staging folder, then copied in under the library
// write lock), the manual create route, and adding League of Comic Geeks ids to a series.json. Moved
// unchanged. server.js wraps createSeriesJsonIfMissing with the deployment gate once the file has loaded.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const NEEDS = ['app', 'buildEnricherConfig', 'db', 'DB_PATH', 'deriveStatusFromSeriesJson', 'finishEnricherRun', 'invalidateDirectoryExistsCache', 'invalidateSeriesJsonCache', 'libraryAccess', 'LOCG_BASE', 'logger', 'nativeSpawn', 'requireAdmin', 'SCRIPTS_PATH', 'startEnricherRun', 'syncSeriesJsonRow'];
module.exports.NEEDS = NEEDS;

module.exports.createSeriesJsonCreation = function createSeriesJsonCreation(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createSeriesJsonCreation: missing ${missing.join(', ')}`);
  const { app, buildEnricherConfig, db, DB_PATH, deriveStatusFromSeriesJson, finishEnricherRun, invalidateDirectoryExistsCache, invalidateSeriesJsonCache, libraryAccess, LOCG_BASE, logger, nativeSpawn, requireAdmin, SCRIPTS_PATH, startEnricherRun, syncSeriesJsonRow } = deps;
  /** Patch locg_series_id/slug into an existing series.json at the top level.
   *  Non-destructive: reads the file, sets/overwrites locg fields, rewrites it.
   *  Returns true if the file was updated, false if skipped or failed. */
  function patchSeriesJsonWithLocg(directory, locgSeriesId, locgSeriesSlug) {
    if (!locgSeriesId) return false;
    const jsonPath = path.join(directory, 'series.json');
    if (!fs.existsSync(jsonPath)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      data.locg_series_id  = String(locgSeriesId);
      data.locg_series_slug = locgSeriesSlug || null;
      data.locg_series_url  = `${LOCG_BASE}/comics/series/${locgSeriesId}/${locgSeriesSlug}`;
      fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (e) {
      logger.warn('series.json', `Failed to patch LOCG IDs`, { directory, error: e.message });
      return false;
    }
  }


  // ─── Create series.json for a monitored series directory ─────────
  // Calls enricher.py --create with the series directory + CV volume ID.
  // Creates + enriches in one pass. No-ops if series.json already exists.
  // Returns true on success, false on skip or failure.
  async function createSeriesJsonIfMissing(series) {
    const jsonPath = path.join(series.directory, 'series.json');
    if (fs.existsSync(jsonPath)) {
      logger.debug('series.json', `Already exists, skipping`, { path: jsonPath });
      return false;
    }

    const enricherPath = path.join(SCRIPTS_PATH, 'enricher.py');
    if (!fs.existsSync(enricherPath)) {
      logger.warn('series.json', `Enricher script not found`, { enricherPath });
      return false;
    }

    const stageRoot=fs.mkdtempSync(path.join(path.dirname(DB_PATH),'series-create-'));
    const stageDirectory=path.join(stageRoot,'series');
    const configPath = path.join(stageRoot,'config.yaml');
    const aiRun = startEnricherRun(`Create series.json: ${series.name}`);
    fs.writeFileSync(configPath, yaml.dump(buildEnricherConfig(false, aiRun)));

    try {
      fs.mkdirSync(stageDirectory);

      const output = await new Promise((resolve, reject) => {
        const proc = nativeSpawn('python3',
          [enricherPath, 'create', stageDirectory, String(series.id), '--context-folder', series.directory, '--config', configPath],
          { env: { ...process.env, PYTHONUNBUFFERED: '1' } }
        );
        proc.on('error',reject);
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => { stdout += d; });
        proc.stderr.on('data', d => { stderr += d; logger.debug('series.json', d.toString().trim()); });
        proc.on('close', code => {
          finishEnricherRun(aiRun);
          try { fs.unlinkSync(configPath); } catch {}
          const lines = stdout.trim().split('\n').filter(l => l.trim().startsWith('{'));
          if (lines.length > 0) return resolve(lines[lines.length - 1].trim());
          if (code !== 0) return reject(new Error(stderr.trim() || `Script exited ${code}`));
          resolve(stdout.trim());
        });
      });

      const result = JSON.parse(output);
      if (result.success) {
        return await libraryAccess.run('write',async()=>{
        const current=db.prepare('SELECT directory FROM monitored_series WHERE id=?').get(series.id);
        if(current&&current.directory!==series.directory)throw new Error('Series moved during metadata lookup; retry');
        if(fs.existsSync(jsonPath))return false;
        const staged=path.join(stageDirectory,'series.json');
        JSON.parse(fs.readFileSync(staged,'utf8'));
        fs.mkdirSync(series.directory,{recursive:true});
        fs.copyFileSync(staged,jsonPath,fs.constants.COPYFILE_EXCL);
        invalidateDirectoryExistsCache(series.id);
        result.path=jsonPath;
        logger.info('series.json', `Created + enriched for series ${series.id}`, { path: result.path, name: result.name });
        invalidateSeriesJsonCache(series.id);
        // Patch LOCG series IDs into the freshly created series.json (if already resolved)
        try {
          const locgRow = db.prepare('SELECT locg_series_id, locg_series_slug FROM monitored_series WHERE id = ?').get(series.id);
          if (locgRow?.locg_series_id) {
            const patched = patchSeriesJsonWithLocg(series.directory, locgRow.locg_series_id, locgRow.locg_series_slug);
            if (patched) logger.info('series.json', `Patched LOCG series ID into series.json`, { id: series.id, locg_series_id: locgRow.locg_series_id });
          }
        } catch (e) {
          logger.warn('series.json', `LOCG patch skipped`, { id: series.id, error: e.message });
        }
        syncSeriesJsonRow({ seriesPath: series.directory });
        return true;
        });
      } else {
        logger.warn('series.json', `Script reported failure`, { error: result.error });
        return false;
      }
    } catch (e) {
      logger.error('series.json', `Failed for series ${series.id}`, e.message);
      return false;
    } finally {
      fs.rmSync(stageRoot,{recursive:true,force:true});
    }
  }

  // ─── Manual series.json creation endpoint (monitored series) ─────
  app.post('/api/monitor/series/:id/create-series-json', requireAdmin, async (req, res) => {
    const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(req.params.id);
    if (!series) return res.status(404).json({ error: 'Series not found' });

    const jsonPath = path.join(series.directory, 'series.json');

    // Create only. Rebuilding an existing file (old ?force=true) wiped manual edits
    // and regenerated AI text; the nightly series.json refresh now keeps files current.
    if (fs.existsSync(jsonPath)) {
      return res.json({ success: false, skipped: true, reason: 'series.json already exists', path: jsonPath });
    }

    const ok = await createSeriesJsonIfMissing(series);
    if (ok) {
      // Update series_status from the freshly written series.json
      const status = deriveStatusFromSeriesJson(series.directory);
      if (status) db.prepare(`UPDATE monitored_series SET series_status = ? WHERE id = ?`).run(status, series.id);
      res.json({ success: true, path: jsonPath });
    } else {
      res.status(500).json({ success: false, error: 'Failed to create series.json — check server logs' });
    }
  });

  // The deployment gate (server.js, once everything has loaded), as server.js did for its own name.
  function wrapCreate(gate) { const original = createSeriesJsonIfMissing; createSeriesJsonIfMissing = (...args) => gate(() => original(...args)); }
  return { patchSeriesJsonWithLocg, wrapCreate, get createSeriesJsonIfMissing() { return createSeriesJsonIfMissing; } };
};
