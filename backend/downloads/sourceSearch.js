'use strict';
// ─── Finding a source for one issue (shared, 2026-11-05) ─────────────────────
// Used by all three automatic grab paths: the next-source retry after a failed link
// (issueDownloads.js blacklistAndRetry), auto-grab of a series and the wanted scanner
// (wanted.js). Each had its own copy; they now share the same rules:
//   • Prowlarr (NZB) and GetComics (DDL) searched together, each with its own query form;
//   • GetComics results kept at any score above 0 (curated titles), NZB at 25 or more;
//   • a result whose title names a different year is dropped and logged (dropWrongYear);
//   • links that already failed for this issue are skipped: the GetComics post, each
//     link on it and the file address a link leads to (auto-grab used to ignore them);
//   • on a GetComics post, its own /dlds/ links first, then other direct links, and
//     Pixeldrain / MediaFire / MEGA last (the wanted scanner and auto-grab used to take
//     them in page order).
// What to do with the result (mark failed, leave wanted, try again) stays with each caller.
module.exports.createSourceSearch = function createSourceSearch(deps) {
  const missing = ['PROWLARR_API_KEY', 'PROWLARR_TIMEOUT_MS', 'PROWLARR_URL', 'SABNZBD_API_KEY', 'SABNZBD_URL', 'axios', 'buildIssueSearchQuery', 'dropWrongYear', 'fetchViaFlareSolverr', 'getSetting', 'logger', 'resolveDldsLink', 'retryPolicy', 'scoreResult', 'scrapeGcLinks', 'scrapeGcResults'].filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createSourceSearch: missing ${missing.join(', ')}`);
  const { PROWLARR_API_KEY, PROWLARR_TIMEOUT_MS, PROWLARR_URL, SABNZBD_API_KEY, SABNZBD_URL, axios, buildIssueSearchQuery, dropWrongYear, fetchViaFlareSolverr, getSetting, logger, resolveDldsLink, retryPolicy, scoreResult, scrapeGcLinks, scrapeGcResults } = deps;

  const THIRD_PARTY = /pixeldrain\.com|mediafire\.com|mega\.nz/i;

  // Search both sources for one issue. Returns the candidates best first, the queries
  // used (for logs) and the links already blocked for this issue.
  async function findSources(issue, seriesName, seriesYear) {
    const blocked = retryPolicy.blocked(issue.id);
    const q   = buildIssueSearchQuery(issue, seriesName, seriesYear);
    const qGc = buildIssueSearchQuery(issue, seriesName, seriesYear, { gcStyle: true });
    const prowlarrUrl = getSetting('prowlarr_url') || PROWLARR_URL;
    const prowlarrKey = getSetting('prowlarr_api_key') || PROWLARR_API_KEY;
    const [nzbResult, gcResult] = await Promise.allSettled([
      axios.get(`${prowlarrUrl}/api/v1/search`, {
        params: { query: q, type: 'search', limit: 50, categories: '7030' },
        headers: { 'X-Api-Key': prowlarrKey },
        timeout: PROWLARR_TIMEOUT_MS,
      }),
      (async () => scrapeGcResults(await fetchViaFlareSolverr(`https://getcomics.org/?s=${encodeURIComponent(qGc)}`)))(),
    ]);
    const ddl = dropWrongYear((gcResult.status === 'fulfilled' ? (gcResult.value || []) : [])
      .map(r => ({ ...r, _score: scoreResult(r.title || '', seriesName, issue.issue_number), _source: 'ddl' }))
      .filter(r => r._score > 0 && !blocked.has(r.url)), issue, seriesName)
      .sort((a, b) => b._score - a._score);
    const nzb = dropWrongYear((nzbResult.status === 'fulfilled' ? (nzbResult.value.data || []) : [])
      .map(r => ({ ...r, _score: scoreResult(r.title || '', seriesName, issue.issue_number), _source: 'nzb' }))
      .filter(r => r._score >= 25 && !blocked.has(r.downloadUrl)), issue, seriesName)
      .sort((a, b) => b._score - a._score || (b.grabs || 0) - (a.grabs || 0));
    return { ddl, nzb, q, qGc, blocked };
  }

  // The download link to use from a GetComics post: { url, label } or null when every
  // link is blocked or leads nowhere. Throws when the page cannot be read or has no links.
  async function pickDdlLink(issue, postUrl, blocked, tag = 'retry') {
    const links = scrapeGcLinks(await fetchViaFlareSolverr(postUrl));
    if (!links.length) throw new Error('No download links found on page');
    const open = links.filter(l => !blocked.has(l.url));
    const dlds = open.filter(l => l.isDlds);
    const direct = open.filter(l => !l.isDlds && !THIRD_PARTY.test(l.url));
    const thirdParty = open.filter(l => !l.isDlds && THIRD_PARTY.test(l.url));
    for (const link of [...dlds, ...direct]) {
      if (!link.isDlds) return { url: link.url, label: link.label };
      let r = null;
      try { r = await resolveDldsLink(link.url); }
      catch (e) { logger.warn(tag, `Issue ${issue.id} — GetComics link could not be resolved`, e.message); continue; }
      // The blocklist holds the file address a GetComics link led to, not the link itself, so
      // check what it resolves to (2026-10-24: the same failed file was retried every few
      // seconds, thousands of times, because the link never looked blocklisted).
      if (r && blocked.has(r)) { logger.debug(tag, `Issue ${issue.id} — link leads to a file that already failed; skipping`, { url: r }); continue; }
      if (r) return { url: r, label: link.label };
    }
    if (thirdParty.length) {
      logger.info(tag, `Falling back to third-party link: ${thirdParty[0].label}`, { url: thirdParty[0].url });
      return { url: thirdParty[0].url, label: thirdParty[0].label };
    }
    return null;
  }

  // Send an NZB to SABnzbd: { ok, nzo_id, error }.
  async function sendToSab(cand) {
    const sabUrl = getSetting('sabnzbd_url') || SABNZBD_URL;
    const sabKey = getSetting('sabnzbd_api_key') || SABNZBD_API_KEY;
    const sabCat = getSetting('sabnzbd_category') || 'comics';
    const r = await axios.get(`${sabUrl}/api`, {
      params: { apikey: sabKey, mode: 'addurl', name: cand.downloadUrl, nzbname: cand.title, cat: sabCat, output: 'json' },
      timeout: 10000,
    });
    if (r.data.status === true || r.data.nzo_ids?.length) return { ok: true, nzo_id: r.data.nzo_ids?.[0] || null };
    return { ok: false, error: r.data.error || 'SABnzbd rejected' };
  }

  return { findSources, pickDdlLink, sendToSab };
};
