'use strict';
// ─── Annuals of monitored series (moved out of server.js 2026-11-19, server.js split step 7A) ───
// Finding a series' annual volume on Comic Vine (with an AI pick among close candidates), linking and
// unlinking it, the manual "Find annuals" trigger and the weekly Tuesday 03:45 discovery, and which
// in-series annuals the Download Manager hides when a linked annual has the same issue. Moved unchanged.
const cron = require('node-cron');

const NEEDS = ['ai', 'app', 'cvApiGet', 'db', 'getCVKey', 'getSetting', 'logger', 'requireAdmin', 'runRefreshDirectory', 'setAiJobOutcome'];
module.exports.NEEDS = NEEDS;

module.exports.createAnnuals = function createAnnuals(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createAnnuals: missing ${missing.join(', ')}`);
  const { ai, app, cvApiGet, db, getCVKey, getSetting, logger, requireAdmin, runRefreshDirectory, setAiJobOutcome } = deps;
  // In-series issues flagged as annuals are usually the same real issues as a
  // linked annual volume, so they're hidden when one exists. Hide only those that
  // actually match a linked annual issue (same number, same cover year); anything
  // else stays visible and counted — so a regular issue wrongly flagged as an
  // annual still shows, and shows as missing if it has no file (Blue Devil #1).
  const annualNumKey = n => {
    const m = String(n ?? '').match(/(\d+(?:\.\d+)?)\s*$/);
    return m ? String(parseFloat(m[1])) : String(n ?? '').trim().toLowerCase();
  };
  const annualYear = r => String(r.release_date || r.store_date || '').slice(0, 4);
  function visibleInSeriesAnnuals(inSeriesAnnuals, linkedAnnualIssues) {
    if (!linkedAnnualIssues.length) return inSeriesAnnuals;
    const keys = new Set(linkedAnnualIssues.map(i => `${annualNumKey(i.issue_number)}|${annualYear(i)}`));
    return inSeriesAnnuals.filter(r => !keys.has(`${annualNumKey(r.issue_number)}|${annualYear(r)}`));
  }


  // ─── Annual helpers ───────────────────────────────────────────────

  /** Fetch CV issues for an annual volume, insert as wanted (is_annual=1), update series row. */
  async function fetchAndInsertAnnualIssues(annualCvId, directory) {
    const CV_API_KEY = getCVKey();
    let offset = 0, allIssues = [], total = Infinity;
    while (allIssues.length < total) {
      const r = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
        params: {
          api_key: getCVKey(), format: 'json',
          filter: `volume:${annualCvId}`,
          field_list: 'id,issue_number,name,cover_date,store_date,site_detail_url,description,person_credits,character_credits,team_credits,location_credits',
          offset, limit: 100,
        },
        headers: { 'User-Agent': 'Omnibus/1.0' },
      });
      total = r.data.number_of_total_results || 0;
      const batch = r.data.results || [];
      allIssues = allIssues.concat(batch);
      if (!batch.length) break;
      offset += 100;
      if (allIssues.length < total) await new Promise(r => setTimeout(r, 600));
    }
    const insertIssue = db.prepare(`
    INSERT OR IGNORE INTO monitored_issues
      (id, series_id, issue_number, title, release_date, store_date, cv_data, is_annual)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `);
    db.transaction(issues => {
      for (const i of issues) {
        insertIssue.run(String(i.id), annualCvId, i.issue_number || '0',
          i.name || null, i.cover_date || null, i.store_date || null, JSON.stringify(i));
      }
    })(allIssues);
    db.prepare(`UPDATE monitored_series SET total_issues = ?, last_cv_check = datetime('now') WHERE id = ?`)
      .run(allIssues.length, annualCvId);
    return allIssues.length;
  }

  /**
   * Auto-discover and link standalone annual volumes for a series.
   * Searches CV for "[Series Name] Annual" (and "[Series Name] '96" for runs in 1995-98),
   * filters to volumes named as annuals (annualNames.js) that share key words with the series name, then
   * auto-links each match.  Fire-and-forget — errors are logged, not thrown.
   */
  // Latest year among an annual volume's monitored issues (store date, else cover date).
  function annualLastYear(annualId) {
    const r = db.prepare(`SELECT MAX(substr(COALESCE(NULLIF(store_date, ''), release_date), 1, 4)) AS y
    FROM monitored_issues WHERE series_id = ?`).get(String(annualId));
    return parseInt(r?.y, 10) || null;
  }
  // "Still publishing": an issue dated this year or last (yearly annuals; solicited ones count).
  function annualStillPublishing(annualId) {
    const y = annualLastYear(annualId);
    return !!y && y >= new Date().getFullYear() - 1;
  }

  // Name checks for annual candidates: annualNames.js (moved 2026-11-10; also Marvel's yearly annuals).
  const { annualNameFits, yearlyTag, isAnnualName, yearlyAnnualYears } = require('./annualNames');
  // One-time: remove the 5 links above (parent id, annual volume id). Files are not touched.
  if (!getSetting('annual_links_name_cleanup_2026_10')) {
    try {
      const del = db.prepare('DELETE FROM series_annual_links WHERE parent_series_id = ? AND annual_series_id = ?');
      let n = 0;
      for (const [pid, aid] of [['33615', '104595'], ['158814', '171435'], ['170960', '170792'], ['168718', '160862'], ['171579', '170303']]) n += del.run(pid, aid).changes;
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('annual_links_name_cleanup_2026_10', '1');
      if (n) console.log(`[annual-auto] Removed ${n} annual link(s) to series with a different name`);
    } catch (e) { console.warn('annual link cleanup failed:', e.message); }
  }

  // `alt` (2026-11-10, seriesAnnuals.js): a library series that is not monitored, asked from its
  // series page (Manage › Find annuals). It brings the run's details from Comic Vine's issue list
  // (parent {year, publisher}, firstDate, lastDate) and its own linking: linkedHere(id), link(c).
  // No cooldown and no hand-offs for these; monitored links are never changed by them.
  async function autoDiscoverAnnuals(seriesId, seriesName, directory, alt = null) {
    // Skip if Claude recently found no match — 30-day cooldown to avoid burning API calls
    // on series like Supergirl/Venom/Black Cat that repeatedly yield no confident result.
    const cooldownRow = alt ? null : db.prepare('SELECT annual_no_match_until FROM monitored_series WHERE id = ?').get(seriesId);
    if (cooldownRow?.annual_no_match_until && new Date(cooldownRow.annual_no_match_until) > new Date()) {
      logger.debug('annual-auto', `Skipping "${seriesName}" — no-match cooldown until ${cooldownRow.annual_no_match_until}`);
      return;
    }

    // An annual volume never gets annuals of its own: monitoring "Action Comics
    // 2023 Annual" used to link the 2022 and 2021 annual volumes to it.
    if (/\bannual\b/i.test(seriesName || '') || yearlyTag(seriesName)) {
      logger.debug('annual-auto', `Skipping "${seriesName}" — it is an annual volume itself`);
      return;
    }

    const CV_API_KEY = getCVKey();
    const STOPWORDS = new Set(['the','a','an','of','and','or','in','to','for','by']);

    const keyWords = seriesName
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w));

    // Core words are the most distinctive terms — used for looser matching.
    // For "Uncanny X-Men", core = ["men"] since "x" is too short and "uncanny"
    // may not appear in early-era annual volumes named just "X-Men Annual".
    // We require the candidate to contain at least ONE of the key words
    // AND the word "annual", rather than ALL keywords.
    // Claude does the final validation to reject false matches.
    const coreWords = keyWords.filter(w => w.length >= 3);

    if (!coreWords.length) return;

    const parentSeries = alt ? alt.parent : db.prepare('SELECT year, publisher FROM monitored_series WHERE id = ?').get(seriesId);

    // Derive end year from the latest known issue date for this series. Point issues (#258.1) are
    // left out: Comic Vine files retro issues like Iron Man #258.1–258.4 (2013) in the 1968 volume,
    // which made the run look like it ended in 2013 and let the 2014 annual in (2026-10-21).
    const lastIssueRow = alt ? { last_date: alt.lastDate || null } : db.prepare(
      "SELECT MAX(COALESCE(NULLIF(store_date, ''), release_date)) as last_date FROM monitored_issues WHERE series_id = ? AND is_annual = 0 AND issue_number NOT LIKE '%.%'"
    ).get(seriesId);
    const firstIssueRow = alt ? { first_date: alt.firstDate || null } : db.prepare(
      "SELECT MIN(COALESCE(NULLIF(store_date, ''), release_date)) as first_date FROM monitored_issues WHERE series_id = ? AND is_annual = 0 AND issue_number NOT LIKE '%.%'"
    ).get(seriesId);
    const runFirstDate = firstIssueRow?.first_date ? String(firstIssueRow.first_date).slice(0, 10) : null;
    const runLastDate = lastIssueRow?.last_date ? String(lastIssueRow.last_date).slice(0, 10) : null;
    const parentEndYear = lastIssueRow?.last_date
      ? parseInt(lastIssueRow.last_date.slice(0, 4), 10) || null
      : null;

    try {
      const r = await cvApiGet('https://comicvine.gamespot.com/api/search', {
        params: {
          api_key: getCVKey(), format: 'json',
          query: `${seriesName} Annual`,
          resources: 'volume',
          limit: 25,
          field_list: 'id,name,start_year,publisher,count_of_issues,image,site_detail_url,description',
        },
        headers: { 'User-Agent': 'Omnibus/1.0' },
        timeout: 10000,
      });

      const results = (r.data.results || []).slice();
      // Marvel's 1995–98 annuals are named for the year ("Sensational Spider-Man '96") and the
      // "… Annual" search does not return them: one more search for each such year the run covers.
      const runFromYear = parseInt(String(runFirstDate || '').slice(0, 4), 10) || parseInt(parentSeries?.year, 10) || null;
      for (const y of yearlyAnnualYears(runFromYear, parentEndYear || new Date().getFullYear())) {
        try {
          const yr = await cvApiGet('https://comicvine.gamespot.com/api/search', {
            params: { api_key: getCVKey(), format: 'json', query: `${seriesName} '${String(y).slice(2)}`, resources: 'volume', limit: 10,
              field_list: 'id,name,start_year,publisher,count_of_issues,image,site_detail_url,description' },
            headers: { 'User-Agent': 'Omnibus/1.0' }, timeout: 10000,
          });
          const seen = new Set(results.map(x => String(x.id)));
          const found = (yr.data?.results || []).filter(x => yearlyTag(x.name) && !seen.has(String(x.id)));
          results.push(...found);
          logger.info('annual-auto', `Yearly annual search '${String(y).slice(2)} for "${seriesName}": ${found.length ? found.map(x => `${x.name} (${x.id})`).join(', ') : 'none'}`);
        } catch (e) { logger.warn('annual-auto', `Yearly annual search ${y} failed for "${seriesName}"`, e.message); }
      }

      const candidates = results.filter(c => {
        const cNameLower = (c.name || '').toLowerCase();
        if (!isAnnualName(c.name)) return false;
        // Use OR logic — require at least one core word to match.
        // "ALL words must match" is too strict: "Uncanny X-Men" searching for
        // "X-Men Annual" (the pre-1981 era volume) would fail because "uncanny"
        // isn't in the name. Claude does the precise era validation.
        return coreWords.some(w => cNameLower.includes(w));
      }).filter(c => {
        if (annualNameFits(c.name, seriesName)) return true;
        logger.debug('annual-auto', `"${c.name}" (${c.id}) is named for another series; not a candidate for "${seriesName}"`);
        return false;
      });

      logger.info('annual-auto', `CV search: ${results.length} results, ${candidates.length} passed filter for "${seriesName}"`, {
        coreWords,
        passed: candidates.map(c => `${c.name} (${c.id}, ${c.start_year})`),
      });

      // Era check in code (not only Claude): the annual volume must start inside
      // this run. Start = the year the run's first issue came out (earliest store or
      // cover date) — not the volume's start year minus one, which let 2023 X-Men
      // annuals attach to X-Men (2024). End gets one year of slack (an annual can
      // follow a run's last issue). Unknown years pass through.
      const firstRow = alt ? { s: alt.firstDate ? String(alt.firstDate).slice(0, 4) : null, r: null } : db.prepare(`SELECT MIN(substr(store_date, 1, 4)) AS s, MIN(substr(release_date, 1, 4)) AS r
      FROM monitored_issues WHERE series_id = ? AND is_annual = 0 AND issue_number NOT LIKE '%.%'`).get(seriesId) || {};
      const firstYears = [firstRow.s, firstRow.r].map(v => parseInt(v, 10)).filter(Boolean);
      const runStart = firstYears.length ? Math.min(...firstYears)
        : ((parseInt(parentSeries?.year, 10) || 0) ? parseInt(parentSeries.year, 10) - 1 : null);
      const runEnd = parentEndYear || new Date().getFullYear();
      // A volume we already monitor is judged on its whole span (start to latest
      // issue; still publishing = open-ended), so a long-running annual volume can
      // be handed to the next run. A volume not monitored yet is judged on its start.
      const inEra = c => {
        const y = parseInt(c.start_year, 10);
        if (!y || !runStart) return true;
        const id = String(c.id);
        const last = annualLastYear(id);
        const hi = annualStillPublishing(id) ? Math.max(last, new Date().getFullYear() + 1) : Math.max(y, last || 0);
        return hi >= runStart && y <= runEnd + 1;
      };
      const outOfEra = candidates.filter(c => !inEra(c));
      if (outOfEra.length) {
        logger.info('annual-auto', `Dropped ${outOfEra.length} candidate(s) outside the run ${runStart}-${runEnd}`,
          { dropped: outOfEra.map(c => `${c.name} (${c.id}, ${c.start_year})`) });
      }

      // Separate already-linked from new candidates; never auto-link a volume
      // that already belongs to another series (link it by hand if it really is shared).
      const linkedHere = c => (alt ? alt.linkedHere(String(c.id))
        : !!db.prepare('SELECT 1 FROM series_annual_links WHERE parent_series_id = ? AND annual_series_id = ?').get(seriesId, String(c.id)));
      const newCandidates = candidates.filter(inEra).filter(c => {
        if (linkedHere(c)) return false;
        const others = db.prepare(`SELECT l.parent_series_id AS id, p.name, p.year, p.series_status AS st
        FROM series_annual_links l LEFT JOIN monitored_series p ON p.id = l.parent_series_id
        WHERE l.annual_series_id = ? AND l.parent_series_id != ?`).all(String(c.id), seriesId);
        if (others.length) {
          // Hand-off: a volume that outlived its run (every parent ended) and is
          // still publishing may move to this run, if Claude agrees below.
          if (!alt && others.every(o => o.st === 'ended') && annualStillPublishing(String(c.id))) {
            c._handoffFrom = others;
            c._lastYear = annualLastYear(String(c.id));
            logger.info('annual-auto', `Hand-off candidate: ${c.name} (${c.id}) — previous run(s) ended: ${others.map(o => `${o.name} (${o.year || '?'})`).join(', ')}`);
            return true;
          }
          const o = others[0];
          logger.info('annual-auto', `Skipping ${c.name} (${c.id}) — already linked to ${o.name || 'series'} (${o.id})` + (o.st === 'ended' ? ' (ended; volume no longer publishing)' : ''));
          return false;
        }
        return true;
      });

      // Month check at the run's edges (2026-10-21): an annual volume that starts in the run's first
      // year, or at/after its last year, is checked by its first issue's date. Avengers Annual (2012)
      // came out in early 2012, before Avengers (2012) began that December; it belongs to the run before.
      // One Comic Vine lookup per edge candidate; not for volumes already monitored (hand-offs).
      const dayDiff = (a, b) => (Date.parse(a) - Date.parse(b)) / 864e5;
      for (const c of [...newCandidates]) {
        const y = parseInt(c.start_year, 10);
        if (c._handoffFrom || !y || !runStart || !(y === runStart || y >= runEnd)) continue;
        try {
          const ir = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
            params: { api_key: getCVKey(), format: 'json', filter: `volume:${c.id}`, sort: 'cover_date:asc', limit: 1, field_list: 'issue_number,cover_date,store_date' },
            headers: { 'User-Agent': 'Omnibus/1.0' }, timeout: 10000,
          });
          const first = (ir.data?.results || [])[0];
          const d = first && String(first.store_date || first.cover_date || '').slice(0, 10);
          if (!d || !/^\d{4}-\d{2}/.test(d)) continue;
          c._firstDate = d;
          const before = runFirstDate && dayDiff(runFirstDate, d) > 75;            // came out well before this run began (cover dates run ~2 months after store dates)
          const after = runLastDate && parentEndYear && parentEndYear < new Date().getFullYear() - 1 && dayDiff(d, runLastDate) > 300;   // long after an ended run
          if (before || after) {
            newCandidates.splice(newCandidates.indexOf(c), 1);
            logger.info('annual-auto', `Dropped ${c.name} (${c.id}): first issue ${d} is ${before ? `before this run began (${runFirstDate})` : `long after this run ended (${runLastDate})`}`);
          }
        } catch (e) { logger.debug?.('annual-auto', `First-issue date lookup failed for ${c.name} (${c.id})`, e.message); }
      }

      if (!newCandidates.length) {
        const own = candidates.filter(inEra).filter(linkedHere);
        logger.info('annual-auto', `No new candidates for "${seriesName}"` + (own.length ? ` — already linked here: ${own.map(c => `${c.name} (${c.id})`).join(', ')}` : ''));
        return;
      }

      // ── Validation via Claude ─────────────────────────────────────
      // Always ask Claude to validate candidates — even a single candidate can be wrong
      // (e.g. a 1995 annual matched to a series that ended in 1989).
      // Claude has context on publisher, era, and series run to make the right call.
      logger.info('annual-auto', `${newCandidates.length} candidate(s) for "${seriesName}" — asking Claude to validate`);
      const chosen = await askClaudeForAnnualMatch(seriesId, seriesName, parentSeries, newCandidates, parentEndYear, { firstDate: runFirstDate, lastDate: runLastDate });
      if (chosen === null) {
        logger.info('annual-auto', `Validation unavailable for "${seriesName}" — nothing linked, no cooldown set`);
        return;
      }
      const toLink = [];
      if (chosen && chosen.length > 0) {
        toLink.push(...chosen);
        logger.info('annual-auto', `Claude validated ${chosen.length} volume(s): ${chosen.map(c => `"${c.name}" (${c.id})`).join(', ')}`);
      } else {
        logger.info('annual-auto', `Claude rejected all candidates for "${seriesName}" annuals`);
        // 14-day cooldown so we don't keep burning API calls on this series, while a
        // newly solicited annual is still picked up within two weekly runs.
        if (alt) return;
        const until = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
        db.prepare("UPDATE monitored_series SET annual_no_match_until = ? WHERE id = ?").run(until, seriesId);
        return;
      }

      // ── Link each selected candidate ──────────────────────────────
      for (const c of toLink) {
        const annualId = String(c.id);
        if (alt) { alt.link(c); logger.info('annual-auto', `Linked for the series page: ${c.name} (${annualId}) → ${seriesName}`); continue; }

        if (c._handoffFrom?.length) {
          // Move the whole volume to this run: new downloads land in this folder;
          // owned files stay where they are (their Comic Vine identity is unchanged).
          db.transaction(() => {
            for (const o of c._handoffFrom) {
              db.prepare('DELETE FROM series_annual_links WHERE parent_series_id = ? AND annual_series_id = ?').run(o.id, annualId);
            }
            db.prepare('UPDATE monitored_series SET directory = ? WHERE id = ?').run(directory, annualId);
          })();
          logger.info('annual-auto', `Handed off ${c.name} (${annualId}) from ${c._handoffFrom.map(o => `${o.name} (${o.id})`).join(', ')} to ${seriesName} (${seriesId})`, { directory });
        }

        const existing = db.prepare('SELECT id FROM monitored_series WHERE id = ?').get(annualId);
        if (!existing) {
          db.prepare(`
          INSERT OR IGNORE INTO monitored_series
            (id, name, publisher, year, total_issues, image_url, cv_url, directory, last_cv_check)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(annualId, c.name, c.publisher?.name || null, c.start_year || null,
                 c.count_of_issues || 0, c.image?.medium_url || null,
                 c.site_detail_url || null, directory);
        }

        try {
          await new Promise(res => setTimeout(res, 700));
          const count = await fetchAndInsertAnnualIssues(annualId, directory);
          logger.info('annual-auto', `${c.name}: ${count} issues fetched`);
        } catch (e) {
          logger.warn('annual-auto', `Issue fetch failed for ${c.name}`, e.message);
        }

        db.prepare(`INSERT OR IGNORE INTO series_annual_links (parent_series_id, annual_series_id) VALUES (?, ?)`)
          .run(seriesId, annualId);
        logger.info('annual-auto', `Auto-linked: ${c.name} → ${seriesName} (${seriesId})`);
        // Clear no-match cooldown — a link was found, future checks remain valid
        db.prepare("UPDATE monitored_series SET annual_no_match_until = NULL WHERE id = ?").run(seriesId);
        // Immediately scan directory so any existing annual files get matched without
        // requiring a manual Refresh button press
        try {
          await runRefreshDirectory(seriesId);
          logger.info('annual-auto', `Directory refresh triggered for "${seriesName}" after annual link`);
        } catch (e) {
          logger.warn('annual-auto', `Post-link directory refresh failed for "${seriesName}"`, e.message);
        }
      }
    } catch (e) {
      logger.warn('annual-auto', `Auto-discover failed for "${seriesName}"`, e.message);
    }
  }

  /**
   * Ask Claude to pick the correct annual volume from a list of candidates.
   * Returns the matching candidate object, or null if no confident match.
   * Only called when there are 2+ candidates — single candidates bypass this entirely.
   */
  async function askClaudeForAnnualMatch(seriesId, seriesName, parentSeries, candidates, parentEndYear = null, runDates = {}) {
    // Any provider's model may run this task (Settings → AI Models → Annual Validator); a missing key
    // fails the call below, which returns null (nothing linked, no cooldown).

    const parentYear = parentSeries?.year || 'unknown';
    const parentPublisher = parentSeries?.publisher || 'unknown';

    const candidateList = candidates.map(c => ({
      id: String(c.id),
      name: c.name,
      start_year: c.start_year || 'unknown',
      publisher: c.publisher?.name || 'unknown',
      issue_count: c.count_of_issues || 0,
      description: (c.description || '').replace(/<[^>]*>/g, '').slice(0, 300),
      ...(c._firstDate ? { first_issue_date: c._firstDate } : {}),
      ...(c._handoffFrom ? {
        latest_issue_year: c._lastYear || 'unknown',
        note: `Still publishing. It was linked to ${c._handoffFrom.map(o => `"${o.name}" (${o.year || '?'})`).join(', ')}, which has ended. Match it only if this parent series is the continuation/relaunch of that title, so the volume's newer annuals belong to this run.`,
      } : {}),
    }));

    const endYearLine = parentEndYear
      ? `- End year: approximately ${parentEndYear} (derived from last known issue)`
      : `- End year: unknown (may still be ongoing)`;
    const datesLine = runDates.firstDate || runDates.lastDate
      ? `\n- First regular issue: ${runDates.firstDate || 'unknown'}; latest regular issue: ${runDates.lastDate || 'unknown'}`
      : '';

    const prompt = `You are a comic book expert validating which annual companion volumes belong to a specific comic series run on Comic Vine.

Parent series:
- Name: "${seriesName}"
- Publisher: ${parentPublisher}
- Start year: ${parentYear}
${endYearLine}${datesLine}

Candidate annual volume(s) from Comic Vine:
${JSON.stringify(candidateList, null, 2)}

Task: Determine which candidates (if any) are genuine annual companions to THIS SPECIFIC run of the series. A series may have multiple legitimate annual volumes covering different eras (e.g. one volume for 1970-1980 annuals and another for 1981-2011 annuals). Apply these rules:
1. Publisher must match (or be a very close imprint match e.g. Marvel/Marvel Comics).
2. The annual volume's era must overlap with this parent series' run. Use start_year and issue_count to estimate the annual volume's coverage era.
3. CRITICAL for split series: Comic Vine sometimes splits a long-running series into multiple volumes at a specific issue number. If this parent series has a start_year that is NOT the original series launch year (e.g. "Uncanny X-Men" starting in 1981 when the original X-Men launched in 1963), link ONLY annual volumes whose era falls within this specific volume's run — NOT annual volumes that belong to the earlier split-off volume.
4. A single series run may legitimately have multiple annual volumes (e.g. original run annuals + a later restarted annual series). Return all that match.
5. If a candidate fails any rule, exclude it even if it is the only candidate.
6. A candidate with a "note" is a long-running annual volume whose earlier run has ended. Judge its era by latest_issue_year (not start_year), and match it only if this parent series is the relaunch of the same title (a relaunch may change its name, e.g. "New Titans" after "Titans") AND the volume's newest annual came out during this parent's run (compare latest_issue_year with this run's first regular issue). A volume whose newest annual came out before this run began still belongs to the earlier run: do not match it.
7. When first_issue_date is given, the annual belongs to the run whose regular issues were coming out at that date: one that came out before this run's first regular issue belongs to the earlier run.
8. Marvel's 1995-1998 annuals are one-issue volumes named for the year without the word "Annual" (e.g. "Uncanny X-Men '96"); in 1998 most paired two titles (e.g. "Uncanny X-Men / Fantastic Four '98") and belong to the first-named title. Treat these as annuals of the series with exactly that name.

Respond with ONLY a JSON object, no explanation, no markdown:
{"matched_ids": ["<cv_volume_id>", "<cv_volume_id>"]}

If no candidates match, respond with:
{"matched_ids": []}`;

    try {
      // Room for models that reason before answering; 200 left them with no text on harder cases.
      var annualJob = ai.newJobId();
      const { data: responseData, text } = await ai.complete({ task: 'annual_validator', prompt, maxTokens: 2048, timeout: 30000, jobId: annualJob });
      const response = { data: responseData };

      const stripped = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      const start = stripped.indexOf('{');
      const end = stripped.lastIndexOf('}');
      if (start === -1 || end === -1) {
        const blocks = (response.data.content || []).map(b => b.type).join(',') || 'none';
        throw new Error(`No JSON in response (stop_reason ${response.data.stop_reason}, blocks ${blocks}, model ${response.data.model}): ${stripped.slice(0, 200)}`);
      }

      const parsed = JSON.parse(stripped.slice(start, end + 1));

      // Support both old matched_id (single) and new matched_ids (array) for safety
      let matchedIds = [];
      if (Array.isArray(parsed.matched_ids)) {
        matchedIds = parsed.matched_ids.filter(Boolean).map(String);
      } else if (parsed.matched_id) {
        matchedIds = [String(parsed.matched_id)];
      }

      if (!matchedIds.length) { setAiJobOutcome(annualJob, 'no_match'); return []; }

      const matches = matchedIds
        .map(id => candidates.find(c => String(c.id) === id))
        .filter(Boolean);

      if (matches.length < matchedIds.length) {
        logger.warn('annual-auto', `Claude returned ${matchedIds.length} IDs but only ${matches.length} found in candidate list`);
      }

      setAiJobOutcome(annualJob, 'matched', `${matches.length} volume${matches.length === 1 ? '' : 's'}`);
      return matches;
    } catch (e) {
      setAiJobOutcome(typeof annualJob !== 'undefined' ? annualJob : null, /JSON/i.test(e.message) ? 'bad_json' : 'error', e.message);
      // An API/parse failure is not an answer: null tells the caller not to set
      // the 30-day no-match cooldown (failures used to pause discovery for a month).
      logger.warn('annual-auto', `Claude disambiguation failed: ${e.message}`);
      return null;
    }
  }

  // ─── Annual linking endpoints ─────────────────────────────────────

  // Link a standalone annual CV volume to a parent series (manual override endpoint).
  // Manual link (Download Manager ⋯ › Link annual volume…, 2026-11-10): the body may carry only a
  // Comic Vine volume link or id (annualCvId or url); the volume's details are then looked up.
  app.post('/api/monitor/series/:id/link-annual', requireAdmin, async (req, res) => {
    const { id } = req.params;
    let { annualCvId, annualName, annualPublisher, annualYear, annualTotalIssues, annualImageUrl, annualCvUrl, annualDirectory } = req.body || {};
    const given = String(annualCvId || req.body?.url || '').trim();
    annualCvId = (given.match(/4050-(\d+)/) || given.match(/^(\d+)$/) || [])[1] || null;
    if (!annualCvId) return res.status(400).json({ error: 'Paste a Comic Vine volume link (…/4050-12345/) or its number' });

    const parent = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(id);
    if (!parent) return res.status(404).json({ error: 'Parent series not found' });
    if (String(annualCvId) === String(id)) return res.status(400).json({ error: 'That is this series itself' });
    if (!annualName && !db.prepare('SELECT 1 FROM monitored_series WHERE id = ?').get(annualCvId)) {
      try {
        const r = await cvApiGet(`https://comicvine.gamespot.com/api/volume/4050-${annualCvId}/`, {
          params: { api_key: getCVKey(), format: 'json', field_list: 'id,name,start_year,publisher,count_of_issues,image,site_detail_url' },
          headers: { 'User-Agent': 'Omnibus/1.0' }, timeout: 10000 });
        const v = r.data?.results;
        if (!v?.id) return res.status(404).json({ error: `Comic Vine has no volume ${annualCvId}` });
        annualName = v.name; annualPublisher = v.publisher?.name || null; annualYear = v.start_year || null;
        annualTotalIssues = v.count_of_issues || 0; annualImageUrl = v.image?.medium_url || null; annualCvUrl = v.site_detail_url || null;
      } catch (e) { return res.status(502).json({ error: `Comic Vine lookup failed: ${e.message}` }); }
    }

    const annualDir = annualDirectory || parent.directory;
    const existing = db.prepare('SELECT id FROM monitored_series WHERE id = ?').get(annualCvId);
    if (!existing) {
      db.prepare(`
      INSERT OR IGNORE INTO monitored_series
        (id, name, publisher, year, total_issues, image_url, cv_url, directory, last_cv_check)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(annualCvId, annualName || annualCvId, annualPublisher || null,
             annualYear || null, annualTotalIssues || 0,
             annualImageUrl || null, annualCvUrl || null, annualDir);
      try {
        await fetchAndInsertAnnualIssues(annualCvId, annualDir);
      } catch (e) {
        logger.error('annual-link', `CV fetch failed for annual ${annualCvId}`, e.message);
      }
    }

    try {
      db.prepare(`INSERT OR IGNORE INTO series_annual_links (parent_series_id, annual_series_id) VALUES (?, ?)`)
        .run(id, annualCvId);
      logger.info('annual-link', `Manually linked annual ${annualCvId} → parent ${id}`);
      const linked = db.prepare('SELECT id, name, year FROM monitored_series WHERE id = ?').get(annualCvId);
      res.json({ success: true, annual: linked || { id: annualCvId } });
      // Match annual files already in the folder (as the finder does after a link).
      setImmediate(() => runRefreshDirectory(id).catch(e => logger.warn('annual-link', 'Directory refresh after link failed', e.message)));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Remove an annual link
  app.delete('/api/monitor/series/:id/link-annual/:annualId', requireAdmin, (req, res) => {
    db.prepare(`
    DELETE FROM series_annual_links WHERE parent_series_id = ? AND annual_series_id = ?
  `).run(req.params.id, req.params.annualId);
    res.json({ success: true });
  });

  // List linked annuals for a series (for UI display)
  app.get('/api/monitor/series/:id/linked-annuals', (req, res) => {
    const links = db.prepare(`
    SELECT s.* FROM monitored_series s
    JOIN series_annual_links l ON l.annual_series_id = s.id
    WHERE l.parent_series_id = ?
  `).all(req.params.id);
    res.json(links);
  });

  // ─── Manual annual discovery trigger ────────────────────────────
  app.post('/api/monitor/series/:id/discover-annuals', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(id);
    if (!series) return res.status(404).json({ error: 'Series not found' });
    // Clear any cooldown so discovery runs immediately
    db.prepare("UPDATE monitored_series SET annual_no_match_until = NULL WHERE id = ?").run(id);
    try {
      await autoDiscoverAnnuals(id, series.name, series.directory);
      const links = db.prepare('SELECT ms.id, ms.name FROM series_annual_links sal JOIN monitored_series ms ON ms.id = sal.annual_series_id WHERE sal.parent_series_id = ?').all(id);
      res.json({ success: true, linked: links });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Weekly annual discovery cron (Tuesday 03:45) ───────────────
  // Only runs for ongoing/unknown series — ended series have no new annuals to find.
  // On-add and manual button handle one-time discovery for ended series.
  cron.schedule('45 3 * * 2', async () => {
    logger.info('annual-cron', 'Weekly annual discovery starting');
    const series = db.prepare(
      `SELECT id, name, directory FROM monitored_series
     WHERE status = 'active'
       AND (series_status = 'ongoing' OR series_status = 'unknown' OR series_status IS NULL)`
    ).all();
    logger.info('annual-cron', `Checking ${series.length} active ongoing series for new annuals`);
    let found = 0;
    for (const s of series) {
      try {
        await autoDiscoverAnnuals(s.id, s.name, s.directory);
        found++;
      } catch (e) {
        logger.warn('annual-cron', `Annual discovery failed for "${s.name}"`, e.message);
      }
    }
    logger.info('annual-cron', `Annual discovery complete (${found}/${series.length} series checked)`);
  });
  return { annualStillPublishing, autoDiscoverAnnuals, visibleInSeriesAnnuals, yearlyTag };
};
