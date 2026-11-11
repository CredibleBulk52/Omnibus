'use strict';
// ─── Timeline event generation (Events: + New event › Generate) ─────────────
// Moved out of server.js unchanged (2026-11-10, server.js split): the generator's prompt
// rules and reply schema, Comic Vine id enrichment of generated issues (enrichWithCVIds),
// the guide-page test route and POST /api/events/generate. Sources and guide pages are in
// eventSources.js and guidePages.js; Metron reading lists in metron.js.
module.exports.registerEventGenerator = function registerEventGenerator(deps) {
  const missing = ['ai', 'aiInfo', 'aiRunStep', 'app', 'axios', 'canonResolve', 'cvApiGet', 'db', 'eventSources', 'forGptPrompt', 'getAnthropicKey', 'getCVKey', 'getSetting', 'guidePages', 'IN', 'logger', 'metron', 'metronLib', 'modelCatalog', 'requireAdmin', 'setAiJobOutcome'].filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`registerEventGenerator: missing ${missing.join(', ')}`);
  const { ai, aiInfo, aiRunStep, app, axios, canonResolve, cvApiGet, db, eventSources, forGptPrompt, getAnthropicKey, getCVKey, getSetting, guidePages, IN, logger, metron, metronLib, modelCatalog, requireAdmin, setAiJobOutcome } = deps;

// Cached guide directories (FindMeComics' index of reading lists), re-read weekly by guidePages.js.
db.exec(`CREATE TABLE IF NOT EXISTS guide_directory (site TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')))`);
const fmcDirectoryStore = {
  get: () => db.prepare("SELECT value FROM guide_directory WHERE site = 'findmecomics'").get()?.value || null,
  set: v => db.prepare("INSERT OR REPLACE INTO guide_directory (site, value, updated_at) VALUES ('findmecomics', ?, datetime('now'))").run(v),
};
const GPT_EVENT_RULES = `RULES THAT OVERRIDE YOUR SOURCES (a source page's layout and labels never change these):
- Order: a crossover told through several titles is read chapter by chapter, alternating between the titles in release order, even when a page lists it series by series.
- Tiers: every numbered chapter of the story is "essential", whatever labels a site uses. A readingorders.com label counts only when that page is about this event itself, not a wider line or era it belongs to.
- Include issues a source marks as optional or complementary as "tie-in"; leave out only issues outside the event's story.

`;
const forGptEventPrompt = p => forGptPrompt(p).replace('Reply with only this JSON object:', GPT_EVENT_RULES + 'Reply with only this JSON object:');
// v2 reply (2026-10-20, claude/EVENT_GENERATOR_V3.md): sources per issue, order notes, the pages
// read and the issues left out are stored with the event and shown to the admin behind a toggle.
// Reading-order sites the event generator may search and read (enforced by the API's allowed_domains;
// for GPT by OpenAI's search filter and read_page). The prompt budgets three useful pages; the page
// limit is higher because failed reads count against it. Pages are cut at EVENT_PAGE_TOKENS so a
// long line-wide guide cannot flood the context.
const EVENT_SITES = ['findmecomics.com', 'comicbooktreasury.com', 'readingorders.com', 'howtolovecomics.com', 'dcuguide.com',
  'omniversecomics.guide', 'comicbookherald.com', 'comicbookreadingorders.com', 'crushingkrisis.com', 'dc.com', 'marvel.com',
  'marvelreading.com', 'cmro.travis-starnes.com', 'marvelguides.com'];
const EVENT_SEARCH_LIMIT = 4, EVENT_PAGE_LIMIT = 5, EVENT_PAGE_TOKENS = 30000;
const EVENT_SOURCE_CODES = ['MET', 'USER', 'FMC', 'CBT', 'RO', 'HTLC', 'DCUG', 'OMNI', 'CBH', 'CBRO', 'CK', 'CMRO', 'MG', 'PUB', 'AI'];
const EVENT_ORDER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['source', 'source_url', 'central_narrative', 'sources_read', 'issues', 'omitted'],
  properties: {
    source: { type: 'string' }, source_url: { type: ['string', 'null'] }, central_narrative: { type: 'string' },
    sources_read: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['code', 'url'],
      properties: { code: { type: 'string', enum: EVENT_SOURCE_CODES }, url: { type: 'string' } } } },
    issues: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['series_name', 'issue_number', 'issue_year', 'volume_year', 'sort_order', 'tier', 'tier_reason', 'phase', 'sources', 'order_note'],
      properties: { series_name: { type: 'string' }, issue_number: { type: 'string' }, issue_year: { type: 'string' }, volume_year: { type: ['string', 'null'] }, sort_order: { type: 'integer' },
        tier: { type: 'string', enum: ['essential', 'recommended', 'tie-in', 'aftermath'] }, tier_reason: { type: 'string' }, phase: { type: ['string', 'null'] },
        sources: { type: 'array', items: { type: 'string', enum: EVENT_SOURCE_CODES } }, order_note: { type: ['string', 'null'] } } } },
    omitted: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['series_name', 'issue_number', 'volume_year', 'listed_by', 'reason'],
      properties: { series_name: { type: 'string' }, issue_number: { type: 'string' }, volume_year: { type: ['string', 'null'] },
        listed_by: { type: 'array', items: { type: 'string', enum: EVENT_SOURCE_CODES } }, reason: { type: 'string' } } } },
  },
};
async function enrichWithCVIds(issues, _cvApiKey, arcIssues = [], known = new Map()) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const cvGet = async (endpoint, params) => {
    const url = `https://comicvine.gamespot.com/api/${endpoint}/`;
    const r = await cvApiGet(url, {
      params: { api_key: getCVKey(), format: 'json', ...params },
      headers: { 'User-Agent': 'Omnibus/1.0' },
      timeout: 15000,
    });
    return r.data;
  };

  // Null out any Claude-supplied IDs — all IDs must come from CV lookup
  for (const issue of issues) issue.cv_issue_id = null;

  // Build lookup map from CV story arc data: "series_name||issue_number" → cv_issue_id
  // This gives us exact IDs for any issue CV has in the arc without any API calls.
  const arcMap = new Map();
  for (const ai of arcIssues) {
    if (!ai.id || !ai.issue_number) continue;
    const volName = (ai.volume?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    // Canonical form preserves Marvel suffixes (8AU vs 8) so the lookup
    // distinguishes tie-in issues from their numeric base.
    const normNum = IN.normIssueNumber(ai.issue_number) || '0';
    if (volName) arcMap.set(`${volName}||${normNum}`, { id: String(ai.id), year: parseInt(String(ai.cover_date || '').slice(0, 4), 10) || null,
      date: ai.store_date || ai.cover_date || null, kind: ai.store_date ? 'store' : (ai.cover_date ? 'cover' : null) });
  }

  if (arcMap.size > 0) {
    logger.info('events', `CV enrich: arc lookup table has ${arcMap.size} entries`);
  }

  // Cache volume lookups so we don't re-query the same series twice
  const volumeCache = new Map();
  const legacyCache = new Map();   // series → later volumes to try for legacy numbers
  const altVolumeCache = new Map();   // issue-year matches: next-best volumes to try when the issue is not in the first

  for (const issue of issues) {
    if (!issue.series_name || !issue.issue_number) continue;

    try {
      // Step -1 (2026-10-21): an issue on the event's Metron list → its Comic Vine ID and on-sale date.
      const knownHit = known.size ? known.get(metronLib.issueKey(issue.series_name, issue.issue_number)) : null;
      if (knownHit) {
        issue.cv_issue_id = knownHit.id;
        issue.release_date = knownHit.date;
        issue.release_date_kind = knownHit.kind;
        continue;
      }
      // Step 0: try arc lookup table first — exact match, no API call needed
      if (arcMap.size > 0) {
        const normSeries = issue.series_name.toLowerCase().replace(/[^a-z0-9]/g, '');
        // Match the canonical form used to populate arcMap above.
        const normNum = IN.normIssueNumber(issue.issue_number) || '0';
        const arcHit = arcMap.get(`${normSeries}||${normNum}`)
          || (/(special|annual)$/.test(normSeries) ? arcMap.get(`${normSeries.replace(/(special|annual)$/, '')}||${normNum}`) : null);
        // Not an issue published before its volume began (that is an older volume's issue).
        const vy = issue.volume_year ? parseInt(issue.volume_year, 10) : null;
        const arcId = arcHit && !(vy && arcHit.year && arcHit.year < vy - 1) ? arcHit.id : null;
        if (arcId) {
          issue.cv_issue_id = arcId;
          issue.release_date = arcHit.date || null;
          issue.release_date_kind = arcHit.kind || null;
          logger.info('events', `CV enrich: arc match for "${issue.series_name}" #${issue.issue_number} → ${arcId}`);
          continue; // found in arc, skip API search
        }
      }

      // Step 1: find the right volume via CV API
      // No volume year (the generator gives null when unsure, 2026-10-20): the issue's own year
      // picks among same-named volumes (the latest one begun by then), never the biggest volume.
      const issueYear = !issue.volume_year && issue.issue_year ? parseInt(issue.issue_year, 10) || null : null;
      const cacheKey = `${issue.series_name}||${issue.volume_year || (issueYear ? `issue ${issueYear}` : '')}`;
      let volumeId = volumeCache.get(cacheKey);
      let altVolumes = altVolumeCache.get(cacheKey) || [];

      // A library folder with this series name and start year knows its Comic Vine volume
      // (series.json): use it before searching (2026-10-17).
      if (!volumeId && issue.volume_year) {
        const libVol = canonResolve.libraryVolume(db, issue.series_name, parseInt(issue.volume_year, 10));
        if (libVol) {
          volumeId = libVol; volumeCache.set(cacheKey, volumeId);
          logger.info('events', `CV enrich: library folder "${issue.series_name} (${issue.volume_year})" → CV volume ${volumeId}`);
        }
      }

      if (!volumeId) {
        await sleep(300);
        const normName = issue.series_name.replace(/\s*&\s*/g, ' and ').replace(/[^a-z0-9 ]/gi, '').replace(/\s+/g, ' ').trim();
        const eiYear = issue.volume_year ? parseInt(issue.volume_year) : null;

        const volData = await cvGet('volumes', {
          filter: `name:${normName}`,
          field_list: 'id,name,start_year,count_of_issues',
          limit: 100,   // was 20: popular names (Avengers) left the right volume out
        });

        let results = volData.results || [];
        // A common name ("Wolverine", "Storm") has more than 100 volumes, and the first page may not hold
        // the right one: Death of Wolverine took "Wolverine: Switchback" (2009) and "Stormblazer"
        // (2026-10-22). Without an exact-name volume near the year, read up to two more pages.
        {
          const plain = x => String(x || '').replace(/\s*&\s*/g, ' and ').replace(/[^a-z0-9 ]/gi, '').toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, ' ').trim();
          const wantYear = eiYear || (issue.issue_year ? parseInt(issue.issue_year, 10) : null);
          const exactNear = list => list.some(v => plain(v.name) === plain(normName) &&
            (!wantYear || !v.start_year || Math.abs(parseInt(v.start_year, 10) - wantYear) <= 5));
          for (let offset = 100; offset <= 200 && results.length >= offset && !exactNear(results); offset += 100) {
            await sleep(300);
            const more = (await cvGet('volumes', { filter: `name:${normName}`, field_list: 'id,name,start_year,count_of_issues', limit: 100, offset })).results || [];
            results = results.concat(more);
            if (more.length) logger.info('events', `CV enrich: "${issue.series_name}" has over ${offset} volumes; read the next page`);
            if (more.length < 100) break;
          }
        }
        // "Justice League: The Omega Act Special" is "Justice League: The Omega Act" on Comic Vine:
        // no volume by the full name → try once without a trailing Special / Annual (2026-10-21).
        const shortName = /\s+(special|annual)$/i.test(normName) ? normName.replace(/\s+(special|annual)$/i, '').trim() : null;
        if (!results.length && shortName) {
          await sleep(300);
          results = ((await cvGet('volumes', { filter: `name:${shortName}`, field_list: 'id,name,start_year,count_of_issues', limit: 100 })).results || [])
            .map(v => ({ ...v, _short: true }));
          if (results.length) logger.info('events', `CV enrich: no volume named "${issue.series_name}"; trying "${shortName}"`);
        }
        // Comic Vine's name filter misses a name once its colon is dropped ("Justice League The Omega
        // Act Special" finds nothing; the volume is "Justice League: The Omega Act Special"). Search by
        // the longest part of the name instead and score the results against the full name (2026-10-21).
        const parts = String(issue.series_name).split(':').map(x => x.replace(/\s*&\s*/g, ' and ').replace(/[^a-z0-9 ]/gi, '').replace(/\s+/g, ' ').trim()).filter(x => x.split(/\s+/).length >= 2);
        const longest = parts.length > 1 ? parts.sort((a, b) => b.length - a.length)[0] : null;
        if (!results.length && longest) {
          await sleep(300);
          results = (await cvGet('volumes', { filter: `name:${longest}`, field_list: 'id,name,start_year,count_of_issues', limit: 100 })).results || [];
          if (results.length) logger.info('events', `CV enrich: no volume found by the full name "${issue.series_name}"; searched "${longest}"`);
        }
        // "Spider-Man and the X-Men" is "Spider-Man & the X-Men" on Comic Vine (and the other way round).
        // normName always says "and"; the search is tried once more with "&".
        const ampName = / and /i.test(normName) ? normName.replace(/ and /i, ' & ') : null;
        // Then the longest part of a colon name with "&" ("Death of Wolverine: Deadpool & Captain America").
        const ampPart = longest && / and /i.test(longest) ? longest.replace(/ and /i, ' & ') : null;
        for (const q of [ampName, ampPart].filter(Boolean)) {
          if (results.length) break;
          await sleep(300);
          results = (await cvGet('volumes', { filter: `name:${q}`, field_list: 'id,name,start_year,count_of_issues', limit: 100 })).results || [];
          if (results.length) logger.info('events', `CV enrich: no volume named "${issue.series_name}"; searched "${q}"`);
        }
        // Yearly titles: DC renamed some series each year ("L.E.G.I.O.N. '94", "R.E.B.E.L.S. '95"),
        // but Comic Vine keeps one volume under the plain name ("L.E.G.I.O.N.", 1989). Search
        // without the year tag; the volume must have begun by that year (2026-10-29).
        const yearTag = String(issue.series_name).match(/^(.*?\S)\s*['’](\d{2})$/);
        const tagYear = yearTag ? (Number(yearTag[2]) > 30 ? 1900 : 2000) + Number(yearTag[2]) : null;
        const tagName = yearTag ? yearTag[1].replace(/\s*&\s*/g, ' and ').replace(/[^a-z0-9 ]/gi, '').replace(/\s+/g, ' ').trim() : null;
        for (const q of yearTag && !results.length ? [...new Set([yearTag[1].trim(), tagName])] : []) {
          await sleep(300);
          results = ((await cvGet('volumes', { filter: `name:${q}`, field_list: 'id,name,start_year,count_of_issues', limit: 100 })).results || [])
            .map(v => ({ ...v, _tag: true }));
          if (results.length) { logger.info('events', `CV enrich: "${issue.series_name}" is a yearly title; searched "${q}"`); break; }
        }
        if (results.length === 0) {
          logger.info('events', `CV enrich: no volumes found for "${issue.series_name}"`);
          continue;
        }

        // Score candidates by name match + year proximity.
        // When volume_year is known, HARD REJECT any volume whose start_year differs by more than 5.
        // This prevents Batman (1940) from ever winning when we want Batman (2011).
        let best = null, bestScore = -Infinity;
        const scored = [];
        for (const v of results) {
          const vNorm = (v.name || '').replace(/\s*&\s*/g, ' and ').replace(/[^a-z0-9 ]/gi, '').toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, ' ').trim();
          const eNorm = (v._short ? shortName : v._tag ? tagName : normName).toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, ' ').trim();
          const nameMatch = vNorm === eNorm ? 2 : (vNorm.includes(eNorm) || eNorm.includes(vNorm) ? 1 : 0);
          if (nameMatch === 0) continue;
          // A partial match only for names of three words or more: "Wolverine" is not "Wolverine: Switchback".
          if (nameMatch === 1 && Math.min(vNorm.split(' ').length, eNorm.split(' ').length) < 3) continue;
          // Penalize volumes with more words than the query — tie-ins have longer names
          const eWords = eNorm.split(/\s+/).filter(Boolean).length;
          const vWords = vNorm.split(/\s+/).filter(Boolean).length;
          const extraWordPenalty = Math.max(0, vWords - eWords) * 5;
          const vYear = v.start_year ? parseInt(v.start_year) : null;
          let score;
          if (v._tag) {
            // Yearly title: begun by the tag's year (a year's leeway), the latest such volume first.
            if (!vYear || vYear > tagYear + 1 || tagYear - vYear > 12) continue;
            score = nameMatch * 100 - (tagYear - vYear) * 0.5 - extraWordPenalty;
            scored.push({ v, score });
            if (score > bestScore) { bestScore = score; best = v; }
            continue;
          }
          // Hard year rejection: if we know the volume year, reject volumes more than 5 years off
          if (eiYear && vYear && Math.abs(vYear - eiYear) > 5) continue;
          if (eiYear && vYear) {
            const yearDiff = Math.abs(vYear - eiYear);
            score = nameMatch * 100 - yearDiff - extraWordPenalty;
          } else if (issueYear) {
            // A volume cannot begin after its issue came out (a year's leeway for cover dating);
            // of the rest, the latest begun is most likely (Green Lantern #21 from 2007 → 2005).
            if (!vYear || vYear > issueYear + 1) continue;
            score = nameMatch * 100 - (issueYear - vYear) * 0.5 - extraWordPenalty;
          } else {
            score = nameMatch * 100 + (v.count_of_issues || 0) * 0.01 - extraWordPenalty;
          }
          scored.push({ v, score });
          if (score > bestScore) { bestScore = score; best = v; }
        }
        if (issueYear) {
          altVolumes = scored.filter(x => x.v !== best).sort((a, b) => b.score - a.score).slice(0, 2).map(x => x.v);
          altVolumeCache.set(cacheKey, altVolumes);
        }

        // (A fallback that relaxed to ±15 years when nothing was within 5 took an older same-named
        // volume — Avengers (2012) → (1998), Nova (2016) → (2007) — and was removed 2026-10-17.)

        if (!best) {
          logger.info('events', `CV enrich: no good volume match for "${issue.series_name}" (${issue.volume_year})`);
          continue;
        }

        volumeId = String(best.id);
        volumeCache.set(cacheKey, volumeId);
        logger.info('events', `CV enrich: matched volume "${issue.series_name}" → "${best.name}" (${best.start_year}) id=${volumeId}${issueYear ? ` (from the issue's year ${issueYear})` : ''}`);
      }

      // Step 2: find the issue within that volume
      await sleep(300);
      const issData = await cvGet('issues', {
        filter: `volume:${volumeId},issue_number:${issue.issue_number}`,
        field_list: 'id,issue_number,cover_date,store_date',
        limit: 5,
      });

      let issResults = issData.results || [];
      // Issue-year match: the issue is not in the likeliest volume → try the next ones (at most 2).
      for (const v of issResults.length ? [] : altVolumes) {
        await sleep(300);
        const r = (await cvGet('issues', { filter: `volume:${v.id},issue_number:${issue.issue_number}`, field_list: 'id,issue_number,cover_date,store_date', limit: 5 })).results || [];
        if (r.length) {
          issResults = r;
          logger.info('events', `CV enrich: "${issue.series_name}" #${issue.issue_number} found in ${v.name} (${v.start_year}) instead`);
          break;
        }
      }
      if (issResults.length === 0) {
        // Legacy numbering (2026-10-17): Detective Comics #1022 listed under the 1937 volume is in
        // Comic Vine's 2016 volume. For #100 and up, try later volumes of the same name: library
        // folders' volumes first, then Comic Vine's, newest first, at most 3; a volume that worked is
        // tried first for the next issue of that series (Action Comics #1096–1100).
        const vy = issue.volume_year ? parseInt(issue.volume_year, 10) : null;
        if (vy && parseFloat(issue.issue_number) >= 100) {
          const plain = t => String(t || '').replace(/[^a-z0-9 ]/gi, '').toLowerCase().trim();
          const lkey = plain(issue.series_name);
          let cands = legacyCache.get(lkey);
          if (!cands) {
            const lib = db.prepare("SELECT name, year, json_extract(series_json, '$.metadata.comicid') AS cid FROM scanned_series WHERE series_json IS NOT NULL").all()
              .filter(f => f.cid && plain(f.name) === lkey && parseInt(f.year, 10) > vy).map(f => ({ id: String(f.cid), name: f.name, start_year: f.year }));
            await sleep(300);
            const fromCv = ((await cvGet('volumes', { filter: `name:${issue.series_name.replace(/[^a-z0-9 ]/gi, '').trim()}`, field_list: 'id,name,start_year', limit: 100 })).results || [])
              .filter(v => plain(v.name) === lkey && parseInt(v.start_year, 10) > vy).map(v => ({ id: String(v.id), name: v.name, start_year: v.start_year }));
            const seen = new Set([String(volumeId)]);
            const byYear = (x, y) => parseInt(y.start_year, 10) - parseInt(x.start_year, 10);
            cands = [...lib.sort(byYear), ...fromCv.sort(byYear)].filter(v => !seen.has(v.id) && seen.add(v.id)).slice(0, 3);
            legacyCache.set(lkey, cands);
            logger.info('events', `CV enrich: later volumes to try for "${issue.series_name}": ${cands.map(v => `${v.start_year} (${v.id})`).join(', ') || 'none'}`);
          }
          for (const v of cands) {
            await sleep(300);
            const hit = ((await cvGet('issues', { filter: `volume:${v.id},issue_number:${issue.issue_number}`, field_list: 'id,issue_number,cover_date,store_date', limit: 5 })).results || [])[0];
            if (hit) {
              issue.cv_issue_id = String(hit.id);
              issue.release_date = hit.store_date || hit.cover_date || null;
              issue.release_date_kind = hit.store_date ? 'store' : (hit.cover_date ? 'cover' : null);
              legacyCache.set(lkey, [v, ...cands.filter(c => c !== v)]);
              logger.info('events', `CV enrich: "${issue.series_name}" #${issue.issue_number} found in the later volume ${v.name} (${v.start_year}) → ${hit.id}`);
              break;
            }
          }
          if (issue.cv_issue_id) continue;
        }
        logger.info('events', `CV enrich: no issue found for "${issue.series_name}" #${issue.issue_number} in volume ${volumeId}`);
        continue;
      }

      // Pick the result whose issue_number matches most closely
      const target = parseFloat(issue.issue_number);
      const best_issue = issResults.reduce((a, b) =>
        Math.abs(parseFloat(a.issue_number) - target) <= Math.abs(parseFloat(b.issue_number) - target) ? a : b
      );

      issue.cv_issue_id = String(best_issue.id);
      issue.release_date = best_issue.store_date || best_issue.cover_date || null;   // for the preview's "Order by release date"
      issue.release_date_kind = best_issue.store_date ? 'store' : (best_issue.cover_date ? 'cover' : null);
      logger.info('events', `CV enrich: found cv_issue_id=${issue.cv_issue_id} for "${issue.series_name}" #${issue.issue_number}`);

    } catch (err) {
      logger.warn('events', `CV enrich: failed for "${issue.series_name}" #${issue.issue_number}`, err.message);
      // Non-fatal — continue with other issues
    }
  }

  return issues;
}

// ─── Generate reading order via Claude (with web search) ─────────
// First call: Claude searches the web for the reading order and returns
// structured JSON. If web search yields nothing useful, falls back to
// Claude's own knowledge + optional CV arc hints.
// Returns: { issues, source, sourceUrl }
// ─── Generate reading order via Claude (with web search) ─────────
// Simple direct await — no SSE, no job store.
// Test an admin-chosen guide page before generating: can Omnibus read it, and does it look like a
// reading order for this event? Warnings only; the page can be used anyway.
app.post('/api/events/guide-page/test', requireAdmin, async (req, res) => {
  const { url, name, year, text } = req.body || {};
  if (!String(url || '').trim() && !String(text || '').trim()) return res.status(400).json({ error: 'url or text required' });
  try {
    const p = await guidePages.readUserPage({ url: String(url || '').trim(), name, year, axios, pastedText: text });
    res.json({ ok: true, url: p.url, chars: p.chars, namesEvent: p.namesEvent, issueMarks: p.issueMarks, warnings: p.warnings, pasted: p.pasted, preview: p.text.slice(0, 300) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/events/generate', requireAdmin, aiRunStep(req => `Timeline: ${req.body?.name || '?'}${req.body?.year ? ` (${req.body.year})` : ''}`), async (req, res) => {
  const { name, publisher, year, cvIssues } = req.body;
  const guideUrl = String(req.body.guideUrl || '').trim();   // admin-chosen guide page (optional)
  const guideText = String(req.body.guideText || '');         // its text pasted by the admin, when the site refuses Omnibus
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!getAnthropicKey()) return res.status(500).json({ error: 'Anthropic API key not configured — add it in Settings → Connections' });

  const eventLabel = `"${name}"${publisher ? ` (${publisher})` : ''}${year ? `, ${year}` : ''}`;

  const sortedCvIssues = cvIssues && cvIssues.length > 0
    ? [...cvIssues].sort((a, b) => (a.cover_date || '').localeCompare(b.cover_date || ''))
    : [];



  // ── Generator prompt v2 (2026-10-17; claude/ADMIN_REORG.md "Generator improvements") ──
  // Written for current models: goals instead of a fixed search script, whole pages read with
  // web fetch (search snippets cut long reading orders short), a second source to check what is
  // included, Comic Vine-style volume years, and no tier notes (the grounded "Write tier notes"
  // tool writes them afterwards). The original prompt and its Settings switch
  // (event_generator_classic) were retired on 2026-10-26.
  const promptV2 = `You are building the issue-by-issue reading order for the comic event ${eventLabel}, for a personal comic library app. The list answers four questions: which comics belong to this event, how each one relates to it, how important each one is, and the order to read them in. Aim for complete coverage of the event itself: an issue the guides agree belongs is a real loss if it is missing. Every issue you list is looked up on Comic Vine and matched to the reader's files, so each one must be a real issue.

RESEARCH (web search and web fetch work only on the reading-order sites below)
1. Start with one search for the event's reading order to see which of these sites has a page for it. Prefer a page about this event over a section of a long page about a character, a creator's run, a publishing line or collected editions.
2. Read pages in full with web fetch (search snippets cut long lists short). Aim for three useful pages that cover different needs. When findmecomics.com has a page for the event, read it first: it is short and the only source that labels each issue's role.
   - a complete list of the event's issues: findmecomics.com (its lists come from League of Comic Geeks, labelled Core, Tie-in, Prologue, Epilogue; check its issue numbers against another page, it sometimes drops a digit, #1 for #11) or comicbooktreasury.com (event checklists);
   - order or editorial guidance: howtolovecomics.com (release dates; recent events), dcuguide.com (story chronology; older DC events), omniversecomics.guide or comicbookherald.com (what to read and why); for Marvel, marvelreading.com (Complete Marvel Reading Order: story-arc lists that can be shown in release order) and marvelguides.com (Marvel Guides: continuity reading paths);
   - importance: readingorders.com (Essential / Recommended / Optional), only when its page is about this event itself, not a wider line or era.
   If a site has no page for the event, use the next one; comicbookreadingorders.com and crushingkrisis.com are fallbacks. FindMeComics and League of Comic Geeks are one source, not two.
3. Read one more page only if one of those three needs is still unmet, or the pages disagree on which issues belong. A page that fails to load or turns out not to cover the event does not count toward the three.
If no site covers the event, use your own knowledge and say so in "source".

WHAT BELONGS
Collect every issue the pages you read list for the event, then decide each one.
- Include the issues that are part of the event's story: the main series, the chapters of a crossover, official tie-ins (event banner or publisher checklist), and specials and one-shots published for the event.
- An event checklist is evidence that an issue belongs. A broader reading path is not: an issue that appears only in a guide's wider sequence (a character's or creator's run, a continuity era; Marvel Guides and Comic Book Treasury's run pages often extend well before and after the event) belongs only with an explicit link to the event: a tie-in banner, a publisher checklist, the event's own collected editions, a guide's note that it is part of or leads into the event, or the prelude and aftermath rules below.
- The event's own collected editions (the publisher's trades and omnibuses named for the event, as guides list their contents) are strong evidence: they are sold as the complete story. An issue they collect belongs (as prelude when it comes before the event, aftermath after it), unless it is excluded below or is plainly a reprint of older background material.
- Prelude: a lead-in issue belongs when the publisher brands it as leading in ("Road to", "Countdown", a prelude special), when the event's collected editions include it, when a guide puts it in its own prelude section, or when two or more guides recommend reading it right before the event. A special or one-shot that two or more guides recommend reading before the event (including under "background reading" or "what to read before") also belongs, unless it is part of another named storyline or crossover. Long runs that only give background, such as a series' earlier arcs, do not belong.
- A lead-in storyline's own collected edition is evidence too: when an issue belongs as prelude and a guide or publisher lists the trade that collects it, the other issues of that trade that tell the same storyline also belong, as prelude, even though the trade is not named for the event. For example, Justice League Unlimited Vol. 2: The Omega Act collects JLU #9-11, the Dark Tomorrow Special and the Omega Act Special; when the Omega Act Special leads into the event, JLU #9-11 and Dark Tomorrow come with it. Not the trade's separate stories, and not other volumes of the same series.
- Aftermath: an issue after the conclusion belongs when the publisher labels it an epilogue or aftermath; when it is the #1 of a new series that spins directly out of the event (the publisher or a guide says so; only the #1, and not a relaunch of a whole publishing line); or when two or more guides list it as aftermath because it deals with the event's fallout. League of Comic Geeks' (FindMeComics', Metron's) "Epilogue" label on an issue released after the finale counts as such a label; on an issue that is really part of the conclusion (a final chapter), keep it in the event and tier it as usual.
- Never: trade paperbacks, collected editions, omnibuses, facsimile or anniversary reprints, "Giant" reprint issues; sketchbooks, handbooks, previews and guides to the event; "What If?" and other alternate-reality retellings; sequel events or later crossovers; later issues of spin-out series; issues published more than 2 years after the event ended.
- When the pages you read cover the event, an issue none of them lists does not go in the reading order: put it in "omitted" with the reason (listed_by as below). Your own knowledge fills the list only when no site covers the event.
- "omitted" lists only issues that a page you read lists for the event (or, as above, issues only you thought of) and that you left out, each with the sites that list it and a one-line reason. Do not list issues you only imagine a guide might include. Give a run of consecutive issues left out for the same reason as one entry with a range ("1-10"). Do not leave an issue out only because one site does not list it. listed_by names every page that mentions the issue, even in passing (in a collected edition's contents, as background reading); use AI only when no page you read mentions it.

EACH ISSUE
- series_name: the series title as Comic Vine names it, without a year or volume number ("Avengers", "The Amazing Spider-Man", "Green Lantern Corps"). Annuals: "<series> Annual" with the annual's own number. One-shots and specials: their own title, issue_number "1".
- issue_number: as printed ("1", "0", "23.1", "1000000").
- issue_year: the year this issue came out (from the guides' dates). Required.
- volume_year: the year the VOLUME began, never the issue's year. Relaunches are separate volumes: Avengers (2010), Avengers (2012) and Avengers (2016) are three volumes, so give the one this issue is in. Legacy-numbered issues belong to the volume that carries that number (Detective Comics #1022 → 2016; The Amazing Spider-Man #666 → 1963). Give it when a page you read or what you know reliably establishes it; if you are not sure, use null: a wrong year matches the wrong comic, while null lets the app work it out from the issue year. Never leave out an issue because its volume is uncertain.
- tier: how important the issue is to this event. First identify the event's central narrative (its primary conflict, objectives, protagonists and resolution) and write it in "central_narrative". Then answer two questions for each issue:
  1. Is it necessary to follow the central narrative? If skipping it leaves a meaningful gap in the main story, it is "essential". The chapters that make up the main story itself are essential, and so is an issue of an ongoing series or a side storyline when the main story depends on what happens in it.
  2. If it is not necessary, how much does it add to the event?
     - "recommended": it adds meaningfully: a storyline with real consequences for the event, a major consequence of the event, important development of a central character, or a substantial expansion of the event's story.
     - "tie-in": it is peripheral or loosely connected, or a largely self-contained adventure set during the event.
  "aftermath": the aftermath rule decides. Every issue that qualifies gets this tier and the "Aftermath" phase, whatever its importance; all other issues get essential, recommended or tie-in.
  Crossover branding, major characters, consequential events, or a place in the event's collected editions or structure do not by themselves make an issue essential.
  Judge from the guides' descriptions of what each issue covers, and from your own knowledge of the story where it is reliable. Editorial classifications are evidence, not rules: League of Comic Geeks' (Metron's, FindMeComics') "Core/Tie-In" does not rank tie-ins, and a guide's "optional" or "skippable" means not necessary (question 1), not peripheral (question 2). Guides' notes such as "must-read" are strong evidence. Where sources disagree, decide. When the evidence is too thin to judge, keep a classification a credible source supports rather than inventing a plot reason.
- tier_reason: 10–20 words answering the two questions: "necessary: <why>; <basis>" or "not necessary; adds: <what>; <basis>" (for a tie-in, "not necessary; peripheral: <why>; <basis>"). The basis says where the judgement comes from: a source code only for what that page says about this issue (its note, mark or label for it: "CBT: no consequences for the main story"); "own reading" when the judgement is yours ("own reading; CBT lists it as core"). A page listing an issue supports that it belongs, not its tier. Add "thin evidence" when it rests only on a site's label. It is for the app's admin checking your work, not for readers.
- phase: named sections of the whole event, shown as dividers. A phase is one unbroken block of the reading order: once the next phase begins, never use an earlier phase's name again. It is an act of the event, not one title's own arc name; a thread that runs through the event (one team's side story, say) is not a phase: mention it in tier_reason instead. For events of 10 or more issues always assign phases: use official act or storyline names when they exist ("Knightfall" / "Knightquest" / "KnightsEnd"), otherwise short chapter-like names. Usually 2–5 phases. Prelude issues go in a "Prelude" phase and aftermath issues in an "Aftermath" phase. Use the identical string for every issue in a phase; null only for very short events.
- sources: the sites whose page explicitly lists this issue as part of the event, not every site you read. Codes: MET (the Metron list given below, if any), USER (the guide page the app's admin chose, if given below), FMC (FindMeComics / League of Comic Geeks), CBT, RO (readingorders.com), HTLC, DCUG, OMNI, CBH, CBRO, CK (Crushing Krisis), CMRO, MG (Marvel Guides), PUB (a publisher page you read), AI (your own knowledge, only when no site covers the event). Every code except AI must match a page in "sources_read".
- sort_order and order_note: see Order.
- Do not write tier notes; they are written separately from sources.

ORDER
Read in story order, starting from release order.
1. Begin with release (on-sale) order, using the dates the guides give. Not cover dates.
2. Move an issue away from its release position only with evidence from a page you read: "Part X of Y" chapter numbers; a guide that places it elsewhere and says why (including a guide's warning that one issue gives away another: read the other first); the issue says it takes place before or after another; an editor's note pointing to another issue (that issue comes first). Give the reason in "order_note" only for an issue you moved away from its release position, including a prelude issue released after the event began (say which guide calls it a lead-in); for every other issue, order_note is null, even when a guide confirms its place.
3. Without such evidence keep release order, even when a tie-in released before a main issue reveals part of it: that is what readers saw on release day. Do not reorder on your own judgement of what a reader should know first.
4. Issues out the same week: the main series first, unless the tie-in leads directly into it.
5. A crossover told across several titles is read chapter by chapter, alternating between titles; do not copy a page that lists it series by series. Keep a run of one title together only when a guide does so and it gives away nothing from a later main issue.
Prelude first, aftermath last.

Reply with only this JSON object:
{"source": "FindMeComics / readingorders.com", "source_url": "https://…the main page you used…", "central_narrative": "One or two sentences: the primary conflict, objectives, protagonists and resolution.", "sources_read": [{"code": "FMC", "url": "https://…"}], "issues": [{"series_name": "Infinity", "issue_number": "1", "issue_year": "2013", "volume_year": "2013", "sort_order": 1, "tier": "essential", "phase": "The Builders", "sources": ["FMC", "RO"], "order_note": null}], "omitted": [{"series_name": "…", "issue_number": "…", "volume_year": null, "listed_by": ["CBT"], "reason": "…"}]}
Use real URLs only; if you relied on your own knowledge, "source" is "AI knowledge", "source_url" is null and "sources_read" is empty.`;
  // v2: one model for the whole job (trial split applied once); GPT gets the read_page wording.
  const eventModel = ai.choose('timeline');
  const eventGpt = !!eventModel && ai.providerOf(eventModel) === 'openai';
  // v2: pages Omnibus found and checked itself are handed to the AI, so it reads them instead of
  // searching for them (2026-10-21). Nothing found → the prompt is unchanged.
  // v2 + Metron (2026-10-21): when Metron has the event, its list is the starting list and one
  // guide page (Comic Book Treasury, else readingorders.com) is the editorial source.
  let guide = { pages: [], tried: [] };
  let metronFound = null;
  let userPage = null;   // the admin's own guide page: replaces the automatic pick, read by Omnibus and passed as text
  if (guideUrl || guideText.trim()) {
    try {
      userPage = await guidePages.readUserPage({ url: guideUrl, name, year, axios, pastedText: guideText });
      logger.info('events', `Generate: admin guide page ${userPage.url || '(no address)'} (${userPage.chars} chars${userPage.pasted ? ', pasted' : ''})`, { warnings: userPage.warnings });
    } catch (e) {
      return res.status(400).json({ error: 'The guide page could not be read', detail: e.message });
    }
  }
  if (getSetting('metron_api_token') || process.env.METRON_API_TOKEN) {
    try {
      metronFound = await metron.findEventList(name, year);
      if (metronFound.list) logger.info('events', `Generate: Metron list "${metronFound.list.name}" (${metronFound.list.id}, ${metronFound.list.attribution_source || metronFound.list.owner}), ${metronFound.items.length} issues`, { tried: metronFound.tried });
      else { logger.info('events', 'Generate: no Metron list for this event', { tried: metronFound.tried }); metronFound = null; }
    } catch (e) { logger.warn('events', 'Generate: Metron lookup failed', { error: e.message }); metronFound = null; }
  }
  if (!userPage) {
    try { guide = await guidePages.findGuidePages({ name, year, axios, store: fmcDirectoryStore, logger }); }
    catch (e) { logger.warn('events', 'Generate: guide page lookup failed', { error: e.message }); }
  }
  if (metronFound && !userPage) {
    // One page with Metron (runs 4/6/7 beat the two-page runs 5/8/9 on stability and cost): Comic Book
    // Treasury; else one editorial page found through the site's own search; else readingorders.com.
    let pick = guide.pages.find(p => p.code === 'CBT') || null;
    if (!pick) {
      try {
        const ed = await guidePages.findEditorialPage({ name, year, axios });
        pick = ed.page;
        guide.tried = [...(guide.tried || []), ...ed.tried];
      } catch (e) { logger.warn('events', 'Generate: editorial page lookup failed', { error: e.message }); }
    }
    if (!pick) pick = guide.pages.find(p => p.code === 'RO') || null;
    guide.pages = pick ? [pick] : [];
  } else if (!userPage && !guide.pages.length) {
    // No Metron list and no list page: try one editorial page found through the sites' own search
    // before the model searches (House of X / Powers of X: 4 searches and 5 page reads, ~50¢; the
    // page it settled on was How To Love Comics', which the site search finds for free).
    try {
      const ed = await guidePages.findEditorialPage({ name, year, axios });
      if (ed.page) guide.pages = [ed.page];
      guide.tried = [...(guide.tried || []), ...ed.tried];
    } catch (e) { logger.warn('events', 'Generate: editorial page lookup failed', { error: e.message }); }
  }
  logger.info('events', `Generate: guide pages found: ${guide.pages.map(p => p.code).join(', ') || 'none'}`, { pages: guide.pages, tried: guide.tried });
  // v2.8: Omnibus supplied the list and the pages, so the model gets no search tool (run 5 searched anyway: +$0.30).
  // Any path (2026-10-22): when Omnibus supplied the pages, no search tool. With searching allowed the
  // model ignored "Do not search" (Death of Wolverine: 4 searches, 5 pages, 465k tokens, ~$1.25).
  const searchLimit = userPage || guide.pages.length ? 0 : EVENT_SEARCH_LIMIT;
  // Pages handed over: read each once, plus one spare for a failed load (run 9 re-read two pages five times: $0.55).
  const pageLimit = userPage ? 0 : guide.pages.length && searchLimit === 0 ? guide.pages.length + 1 : EVENT_PAGE_LIMIT;
  const pagesPrompt = userPage ? guidePages.userPagePrompt(userPage)
    : guidePages.guidePagesPrompt(guide.pages, metronFound ? { withMetron: true } : undefined);
  const extraPrompt = metronFound ? metronLib.metronPrompt(metronFound) + pagesPrompt : pagesPrompt;
  const promptV2g = extraPrompt
    ? promptV2.replace('\n\nReply with only this JSON object:', `${extraPrompt}\n\nReply with only this JSON object:`)
    : promptV2;
  const prompt = eventGpt ? forGptEventPrompt(promptV2g) : promptV2g;

  try {
    logger.info('events', `Generate: "${name}", v2 prompt ${prompt.length} chars`);

    var timelineJob = ai.newJobId();
    var genCost = null;   // estimated cost of this generation, shown in the preview (2026-10-22)
    let responseData = null;
    const genCalls = [];   // every API response of this job, for the cost data line
    // Newest tools and a structured reply first; if the API refuses a combination (400), the
    // next attempt drops it, ending with the original tool set.
    const attempts = [
      { label: 'search+fetch (2026) with structured output', tools2026: true, webFetch: pageLimit, outputSchema: EVENT_ORDER_SCHEMA },
      { label: 'search+fetch (2026)', tools2026: true, webFetch: pageLimit },
      { label: 'search+fetch', webFetch: pageLimit },
      { label: 'search only' },
    ];
    let lastErr = null;
    for (const { label, ...a } of attempts) {
      genCalls.length = 0;
      try {
        const opts = { task: 'timeline', model: eventModel, maxTokens: 32000, webSearch: searchLimit, webFetchTokens: EVENT_PAGE_TOKENS,
          allowedDomains: EVENT_SITES, timeout: 480000, jobId: timelineJob, ...a };
        ({ data: responseData } = await ai.complete({ ...opts, prompt }));
        genCalls.push(responseData);
        // A long run of searches and fetches can pause the turn (stop_reason "pause_turn"):
        // send it back as is to let it continue (up to 4 times).
        for (let turn = 0; turn < 4 && responseData && responseData.stop_reason === 'pause_turn'; turn++) {
          logger.info('events', `Generate: continuing a paused turn (${turn + 1})`);
          ({ data: responseData } = await ai.complete({ ...opts, messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: responseData.content }] }));
          genCalls.push(responseData);
        }
        logger.info('events', `Generate: used ${label}${eventGpt ? ' (OpenAI: web search, read_page, strict JSON)' : ''}`, { model: eventModel });
        break;
      } catch (e) {
        lastErr = e;
        if (e.response?.status !== 400) throw e;
        logger.warn('events', `Generate: the API refused ${label} (${e.response?.data?.error?.message || e.message}); trying a simpler set`);
      }
    }
    if (!responseData) throw lastErr;
    const response = { data: responseData };

    logger.info('events', 'Web search complete — parsing reading order…');
    // Cost data (2026-10-21): every call of the job, its searches and page reads with their sizes.
    if (genCalls.length) {
      const rep = eventSources.toolReport(genCalls);
      const usedModel = responseData.model || eventModel;
      genCost = { cents: Math.round(modelCatalog.estimateCost(usedModel, { input_tokens: rep.usage.input, output_tokens: rep.usage.output,
        cache_read: rep.usage.cache_read, cache_write: rep.usage.cache_write, web_searches: rep.usage.searches }) * 1000) / 10,
        model: modelCatalog.displayName(usedModel), input: rep.usage.input, output: rep.usage.output, searches: rep.usage.searches, pages: rep.usage.fetches };
      const { searches: searchCount, fetches: fetchCount, ...tokens } = rep.usage;
      logger.info('events', 'Generate cost data', { model: responseData.model || eventModel, calls: rep.calls, ...tokens,
        search_count: searchCount, fetch_count: fetchCount, tool_result_chars: rep.toolResultChars, searches: rep.searches, pages: rep.pages, other: rep.other });
    }

    // Check for truncated response (max_tokens hit)
    const stopReason = response.data.stop_reason;
    if (stopReason === 'max_tokens') {
      logger.warn('events', `Response hit max_tokens limit — JSON may be truncated. Consider reducing event size or splitting into phases.`);
    }

    // Log full usage for diagnostics
    const usage = response.data.usage || {};
    logger.info('events', `Token usage`, { input: usage.input_tokens, output: usage.output_tokens, stop_reason: stopReason });

    // Extract all text blocks (v2: the last block that is a JSON object, since searching and
    // fetching can leave short text blocks before the answer)
    const textBlocks = (response.data.content || []).filter(b => b.type === 'text').map(b => b.text);
    const lastJsonBlock = [...textBlocks].reverse().find(t => t.trim().startsWith('{'));
    const text = lastJsonBlock || textBlocks.join('');

    // Extract JSON object from response
    const stripped = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const startBrace = stripped.indexOf('{');
    if (startBrace === -1) throw new Error(`No JSON object in response. Raw: ${stripped.slice(0, 300)}`);

    const endBrace = (() => {
      let depth = 0, inStr = false, esc = false;
      for (let i = startBrace; i < stripped.length; i++) {
        const ch = stripped[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\' && inStr) { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        if (ch === '}') { depth--; if (depth === 0) return i; }
      }
      return -1;
    })();
    if (endBrace === -1) throw new Error(`Unmatched braces in response.`);

    let jsonStr = stripped.slice(startBrace, endBrace + 1);
    jsonStr = jsonStr.replace(/"https?:\/\/\.\.\."/g, 'null');
    jsonStr = jsonStr.replace(/:\s*"\.\.\."(\s*[,}])/g, ': null$1');
    jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');

    const tryParse = s => { try { return JSON.parse(s); } catch(e) { return null; } };
    let parsed = tryParse(jsonStr);
    if (!parsed) {
      const repaired = (() => {
        const src = jsonStr;
        let out = '', inStr = false, escaped = false;
        for (let i = 0; i < src.length; i++) {
          const ch = src[i];
          if (escaped) { out += ch; escaped = false; continue; }
          if (ch === '\\') { out += ch; escaped = true; continue; }
          if (!inStr) {
            if (ch === '"') { inStr = true; out += ch; continue; }
            out += ch; continue;
          }
          if (ch === '"') {
            let j = i + 1;
            while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
            const next = src[j] || '';
            if (':,}]\n\r"'.includes(next) || j >= src.length) {
              inStr = false; out += ch;
            } else { out += '\\"'; }
            continue;
          }
          if (ch === '\n' || ch === '\r') { out += ' '; continue; }
          out += ch;
        }
        return out;
      })();
      parsed = tryParse(repaired);
      if (!parsed) {
        logger.error('events', 'JSON parse failed after repair', { raw: jsonStr.slice(0, 8000) });
        throw new Error('Invalid JSON from AI even after repair — check server logs for full output.');
      }
      logger.info('events', 'JSON repaired (had unescaped quotes or newlines in strings)');
    }

    if (!Array.isArray(parsed.issues)) throw new Error('Response missing issues array');
    // v2: sources must match a page read; left-out issues need a reason (admin-only "Show sources").
    if (metronFound) {
      parsed.sources_read = (Array.isArray(parsed.sources_read) ? parsed.sources_read : []).filter(s => s && s.code !== 'MET');
      parsed.sources_read.unshift({ code: 'MET', url: metronFound.list.url });
    }
    if (userPage) {
      parsed.sources_read = (Array.isArray(parsed.sources_read) ? parsed.sources_read : []).filter(s => s && s.code !== 'USER');
      parsed.sources_read.splice(metronFound ? 1 : 0, 0, { code: 'USER', url: userPage.url || '' });
    }
    const genSources = eventSources.cleanSources(parsed);
    if (genSources?.dropped) logger.info('events', `Generate: dropped ${genSources.dropped} source code(s) that match no page read`);
    if (genSources?.noReason) logger.info('events', `Generate: ${genSources.noReason} left-out issue(s) have no reason`);
    const rejoined = eventSources.unbrokenPhases(parsed.issues);
    if (rejoined) logger.info('events', `Generate: ${rejoined} issue(s) moved into the surrounding phase (a phase name came back after another phase began)`);

    const source    = parsed.source    || 'AI knowledge';
    const sourceUrl = parsed.source_url || null;
    const issueCount = parsed.issues.length;

    logger.info('events', `Generated reading order for "${name}"`, { count: issueCount, source });
    logger.info('events', `Found ${issueCount} issues — enriching with Comic Vine IDs…`);

    // Auto-search CV for a matching story arc if none was manually provided.
    // The arc gives us authoritative cv_issue_ids without volume-guessing.
    const CV_API_KEY = getCVKey();
    let autoArcId = null;
    let autoArcName = null;
    let effectiveCvIssues = sortedCvIssues;

    if (effectiveCvIssues.length === 0) {
      try {
        logger.info('events', `Auto-searching CV for story arc: "${name}"`);

        // CV arc filter is substring-based — "Night of Owls" won't match "Batman: The Night of the Owls"
        // Strategy: search for the longest significant keyword, then score all results by how many
        // of our event's words appear in the arc name.
        const stopWords = new Set(['the','of','and','in','a','an','at','to','for','with','by','on','as','is','it']);
        const nameWords = name.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));

        // Search with each significant word and pool the results
        const arcMap = new Map(); // id → arc object (deduped)
        for (const word of nameWords.slice(0, 3)) { // max 3 searches to stay within rate limits
          try {
            const r = await cvApiGet('https://comicvine.gamespot.com/api/story_arcs/', {
              params: {
                api_key: getCVKey(), format: 'json',
                filter: `name:${word}`,
                field_list: 'id,name,publisher,count_of_issue_appearances',
                limit: 15,
              },
              headers: { 'User-Agent': 'Omnibus/1.0' },
              timeout: 15000,
            });
            for (const arc of (r.data.results || [])) arcMap.set(arc.id, arc);
          } catch {}
          await new Promise(r => setTimeout(r, 300));
        }

        // Score pooled results: count how many of our name words appear in the arc name
        let bestArc = null, bestScore = -1;
        for (const arc of arcMap.values()) {
          const arcLower = (arc.name || '').toLowerCase();
          const wordMatches = nameWords.filter(w => arcLower.includes(w)).length;
          if (wordMatches === 0) continue;
          const wordRatio = wordMatches / nameWords.length; // what fraction of our words matched
          // Short names need every word ("Death of Wolverine" matched "Death of Superman" at half, 2026-10-22);
          // longer ones three quarters. An arc named exactly like the event wins.
          if (wordRatio < (nameWords.length <= 3 ? 1 : 0.75)) continue;
          const pubMatch = publisher && arc.publisher?.name?.toLowerCase().includes(publisher.toLowerCase()) ? 1 : 0;
          const bare = x => String(x || '').toLowerCase().replace(/^"[^"]*"\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();
          const score = wordRatio * 10 + pubMatch + (bare(arc.name) === bare(name) ? 5 : 0);
          if (score > bestScore) { bestScore = score; bestArc = arc; }
        }

        if (bestArc) {
          logger.info('events', `Auto-matched CV arc: "${bestArc.name}" (${bestArc.id}), ${bestArc.count_of_issue_appearances} issues`);
          // Step 1: get the list of issue IDs in the arc
          const arcDetail = await cvApiGet(`https://comicvine.gamespot.com/api/story_arc/4045-${bestArc.id}/`, {
            params: { api_key: getCVKey(), format: 'json', field_list: 'id,name,issues' },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 15000,
          });
          const issueStubs = arcDetail.data.results?.issues || [];

          // Step 2: fetch full issue data in batches (CV /api/issues/ with id filter)
          // This gives us volume name, issue_number, and cover_date
          const arcIssues = [];
          const batchSize = 25;
          for (let i = 0; i < issueStubs.length; i += batchSize) {
            const batch = issueStubs.slice(i, i + batchSize);
            const ids = batch.map(s => s.id).join('|');
            try {
              await new Promise(r => setTimeout(r, 300));
              const issData = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
                params: {
                  api_key: getCVKey(), format: 'json',
                  filter: `id:${ids}`,
                  field_list: 'id,issue_number,cover_date,store_date,volume',
                  limit: batchSize,
                },
                headers: { 'User-Agent': 'Omnibus/1.0' },
                timeout: 15000,
              });
              for (const iss of (issData.data.results || [])) {
                arcIssues.push({
                  id: String(iss.id),
                  issue_number: iss.issue_number,
                  cover_date: iss.cover_date,
                  store_date: iss.store_date || null,
                  volume: iss.volume ? { name: iss.volume.name } : null,
                  volume_name: iss.volume?.name || '',
                });
              }
            } catch (batchErr) {
              logger.warn('events', `Arc issue batch fetch failed`, batchErr.message);
            }
          }

          // Same-named arcs from another era (Infinity (2013) matched the Infinity Gauntlet arc;
          // Secret Wars (2015) the 1984 arc): the arc's middle cover year must be within 3 of the
          // event's year (2026-10-17; claude/ADMIN_REORG.md "Three matchers compared").
          const arcYears = arcIssues.map(i => parseInt(String(i.cover_date || '').slice(0, 4), 10)).filter(Boolean).sort((a, b) => a - b);
          const arcMid = arcYears.length ? arcYears[Math.floor(arcYears.length / 2)] : null;
          const eventYear = parseInt(year, 10) || null;
          if (eventYear && arcMid && Math.abs(arcMid - eventYear) > 3) {
            logger.info('events', `CV arc "${bestArc.name}" (${bestArc.id}) rejected: its issues are from ${arcMid}, the event is ${eventYear}`);
          } else {
          effectiveCvIssues = arcIssues.sort((a, b) => (a.cover_date || '').localeCompare(b.cover_date || ''));
          autoArcId = String(bestArc.id);
          autoArcName = bestArc.name;
          logger.info('events', `CV arc fetched: ${effectiveCvIssues.length} issues for enrichment`);
          if (effectiveCvIssues.length > 0) {
            logger.info('events', `Arc sample: ${effectiveCvIssues.slice(0,3).map(i => `${i.volume_name} #${i.issue_number}`).join(', ')}`);
          }
          }
        } else {
          logger.info('events', `No matching CV arc found for "${name}" — using volume search fallback`);
        }
      } catch (arcErr) {
        logger.warn('events', `CV arc auto-search failed (non-fatal)`, arcErr.message);
      }
    }

    logger.info('events', `CV enrichment: looking up ${parsed.issues.length} issues`);
    // Issues on the Metron list carry their Comic Vine ID and on-sale date: no lookup needed.
    const knownIssues = new Map();
    for (const x of (metronFound?.items || [])) if (x.cv_id) knownIssues.set(metronLib.issueKey(x.series, x.number),
      { id: String(x.cv_id), date: x.store_date || x.cover_date || null, kind: x.store_date ? 'store' : (x.cover_date ? 'cover' : null) });
    await enrichWithCVIds(parsed.issues, null, effectiveCvIssues, knownIssues);
    if (knownIssues.size) logger.info('events', `CV enrichment: ${parsed.issues.filter(i => knownIssues.has(metronLib.issueKey(i.series_name, i.issue_number))).length}/${parsed.issues.length} issues taken from the Metron list`);
    const found = parsed.issues.filter(i => i.cv_issue_id).length;
    logger.info('events', `CV enrichment complete: ${found}/${parsed.issues.length} matched`);
    const orderFlags = eventSources.releaseFlags(parsed.issues);
    if (orderFlags) logger.info('events', `Generate: ${orderFlags} issue(s) read weeks from their release position with no reason`);

    setAiJobOutcome(timelineJob, responseData.stop_reason === 'max_tokens' ? 'truncated' : 'ok', `${parsed.issues.length} issues, ${found} matched to Comic Vine`);
    // notesIncluded: false for v2 (the editor opens Write tier notes after the event is created).
    res.json({ issues: parsed.issues, source, sourceUrl, autoArcId, autoArcName, notesIncluded: false,
      sourcesRead: genSources?.sourcesRead || [], omitted: genSources?.omitted || [], orderFlags,
      centralNarrative: (String(parsed.central_narrative || '').trim().slice(0, 1000) || null),
      // The whole request's saved calls, the same total the ⓘ shows (2026-11-09).
      cost: genCost ? { ...genCost, cents: aiInfo.requestTotals(db)?.cents ?? genCost.cents } : null });
  } catch (e) {
    if (typeof timelineJob !== 'undefined') setAiJobOutcome(timelineJob, /JSON|issues array|braces/i.test(e.message) ? 'bad_json' : 'error', e.message);
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 500) : '';
    logger.error('events', 'Generate failed', { message: e.message, status: e.response?.status, code: e.code });
    res.status(500).json({ error: e.message, detail });
  }
});

return {};
};
