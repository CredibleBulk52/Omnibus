'use strict';
// ─── Series list (moved out of server.js 2026-11-19, server.js split) ─────────
// GET /api/series (the Series page, comic boxes, pickers) and the trimmed list item it sends
// (2026-11-10: no raw series_json or description; seriesJson only with the keys the list pages
// fall back on). Moved unchanged.
const SERIES_LIST_JSON_KEYS = ['name', 'year', 'era', 'publisher', 'imprint', 'genres', 'characters', 'status', 'writers', 'artists'];
function seriesListItemCore(merged) {
  const { series_json, displayDescription, seriesJson, ...rest } = merged;
  if (!seriesJson || typeof seriesJson !== 'object' || Array.isArray(seriesJson)) return { ...rest, seriesJson: seriesJson || null };   // a few series.json files hold a list: passed on as before
  const slim = {};
  for (const k of SERIES_LIST_JSON_KEYS) if (seriesJson[k] !== undefined) slim[k] = seriesJson[k];
  return { ...rest, seriesJson: slim };
}

module.exports.SERIES_LIST_JSON_KEYS = SERIES_LIST_JSON_KEYS;
module.exports.seriesListItemCore = seriesListItemCore;

module.exports.registerSeriesList = function registerSeriesList(deps) {
  const missing = ['app', 'fetchAllSeries', 'getSeriesCacheKey', 'logger', 'mergeSeriesWithJson', 'seriesCache', 'seriesGroupOf'].filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`registerSeriesList: missing ${missing.join(', ')}`);
  const { app, fetchAllSeries, getSeriesCacheKey, logger, mergeSeriesWithJson, seriesCache, seriesGroupOf } = deps;

  function seriesListItem(merged) {
    const item = seriesListItemCore(merged);
    const group = typeof seriesGroupOf === 'function' ? seriesGroupOf(item.id) : null;
    if (group) item.group = group;
    return item;
  }
  app.get('/api/series', (req, res) => {
    try {
      const { libraryId, search, tag, page, size, enrich } = req.query;
      const pageNum  = page !== undefined ? parseInt(page) : 0;
      const pageSize = size !== undefined ? parseInt(size) : 48;

      let series = fetchAllSeries(libraryId, search, tag);
      const totalElements = series.length;

      // The whole enriched list (Series page, comic boxes): built once and kept with the cached
      // rows (2026-11-05). It was rebuilt on every request (~1.1 s, ~12 MB), holding up other
      // requests meanwhile. Kept on the same seriesCache entry, so anything that clears or
      // refreshes the rows (scans, edits, tags, the 5-minute expiry) drops it too.
      const whole = enrich === 'true' && page === undefined && !search && !tag ? seriesCache.get(getSeriesCacheKey(libraryId)) : null;
      if (whole && whole.data === series && whole.enrichedJson) return res.type('application/json').send(whole.enrichedJson);

      // Paginate if page param provided
      if (page !== undefined) {
        const start = pageNum * pageSize;
        series = series.slice(start, start + pageSize);
      }

      if (enrich === 'true') series = series.map(s => {
        try {
          return seriesListItem(mergeSeriesWithJson(s));
        } catch (e) {
          logger.error('series', `mergeSeriesWithJson failed for series ${s.id} (${s.name})`, e.message);
          // Return a minimal safe object so the grid still renders
          return seriesListItem({ ...s, seriesJson: null, metadataStatus: 'none',
            displayTitle: s.name || s.id, displayDescription: '', displayEra: null,
            displayCharacters: [], displayGenres: [], displayStatus: '',
            displayYear: s.year || null, displayPublicationRun: null,
            displayTotalIssues: s.book_count || 0, displayWriters: [], displayArtists: [],
            displayTags: [], displayAwards: [], displayRating: null, latestReleaseDate: null });
        }
      });
      const body = { content: series, totalElements, totalPages: Math.ceil(totalElements / pageSize), number: pageNum };
      if (whole && whole.data === fetchAllSeries(libraryId)) {
        whole.enrichedJson = JSON.stringify(body);
        return res.type('application/json').send(whole.enrichedJson);
      }
      res.json(body);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { seriesListItem };
};
