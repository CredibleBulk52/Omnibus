'use strict';
// ─── Download client routes (moved out of server.js 2026-11-19, server.js split step 7A) ───
// Searching Prowlarr and Nyaa, and sending a release to SABnzbd or qBittorrent. Moved unchanged. The two
// SABnzbd history routes were removed: nothing called them, and /history/all was shadowed by /history/:nzo_id.
const axios = require('axios');

const NEEDS = ['app', 'db', 'FLARESOLVERR_URL', 'getSetting', 'logger', 'PROWLARR_API_KEY', 'PROWLARR_TIMEOUT_MS', 'PROWLARR_URL', 'qbtLogin', 'requireDownloadAccess', 'resolveQbtHash', 'SABNZBD_API_KEY', 'SABNZBD_URL'];
module.exports.NEEDS = NEEDS;

module.exports.registerDownloadClientRoutes = function registerDownloadClientRoutes(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`registerDownloadClientRoutes: missing ${missing.join(', ')}`);
  const { app, db, FLARESOLVERR_URL, getSetting, logger, PROWLARR_API_KEY, PROWLARR_TIMEOUT_MS, PROWLARR_URL, qbtLogin, requireDownloadAccess, resolveQbtHash, SABNZBD_API_KEY, SABNZBD_URL } = deps;
  // ─── Prowlarr ─────────────────────────────────────────────────────
  // Search Prowlarr indexers — returns releases with protocol, title, size, indexer, downloadUrl, guid
  app.get('/api/prowlarr/search', requireDownloadAccess, async (req, res) => {
    try {
      const { q } = req.query;
      // Optional protocol filter — when ?protocol=usenet is set, drop torrent
      // results from the response. Used by the Prowlarr search tab on comic
      // series cards, which defaults to NZB-only because torrent coverage for
      // comics is patchy and our auto-grab heuristics aren't tuned for torrent
      // release naming. Pass ?protocol=any (or omit) to see everything.
      const protocolFilter = (req.query.protocol || 'any').toLowerCase();
      const prowlarrUrl = getSetting('prowlarr_url') || PROWLARR_URL;
      const prowlarrKey = getSetting('prowlarr_api_key') || PROWLARR_API_KEY;
      const r = await axios.get(`${prowlarrUrl}/api/v1/search`, {
        params: { query: q, type: 'search', limit: 100, categories: '7030' },
        headers: { 'X-Api-Key': prowlarrKey },
        timeout: PROWLARR_TIMEOUT_MS,
      });
      // Normalize to what frontend expects: protocol, title, size, indexer, grabs, downloadUrl, guid
      let releases = (r.data || []).map(rel => ({
        protocol:    rel.protocol    || '',
        title:       rel.title       || '',
        size:        rel.size        || 0,
        indexer:     rel.indexer     || '',
        grabs:       rel.grabs       ?? null,
        downloadUrl: rel.downloadUrl || rel.magnetUrl || '',
        guid:        rel.guid        || '',
        infoUrl:     rel.infoUrl     || '',
      }));
      if (protocolFilter === 'usenet')  releases = releases.filter(r => r.protocol !== 'torrent');
      if (protocolFilter === 'torrent') releases = releases.filter(r => r.protocol === 'torrent');
      res.json(releases);
    } catch (e) {
      logger.error('prowlarr', 'Search failed', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ─── SABnzbd ──────────────────────────────────────────────────────
  // Add NZB to SABnzbd queue by URL — also records the download against the issue
  app.post('/api/sabnzbd/add', requireDownloadAccess, async (req, res) => {
    try {
      const { url, name, issueId } = req.body;
      const sabUrl  = getSetting('sabnzbd_url')  || SABNZBD_URL;
      const sabKey  = getSetting('sabnzbd_api_key') || SABNZBD_API_KEY;
      const sabCat  = getSetting('sabnzbd_category') || 'comics';

      const r = await axios.get(`${sabUrl}/api`, {
        params: {
          apikey:  sabKey,
          mode:    'addurl',
          name:    url,
          nzbname: name || '',
          cat:     sabCat,
          output:  'json',
        },
      });

      if (r.data.status === true || r.data.nzo_ids?.length) {
        const nzo_id = r.data.nzo_ids?.[0] || null;

        // Record in DB if we have both issueId and nzo_id
        if (issueId && nzo_id) {
          db.prepare(`UPDATE monitored_issues SET status = 'snatched', download_id = ?, download_url = ? WHERE id = ?`)
            .run(nzo_id, url, issueId);
          logger.info('sabnzbd', `Issue ${issueId} snatched`, { nzo_id });
        }

        res.json({ success: true, nzo_id });
      } else {
        res.json({ success: false, error: r.data.error || 'SABnzbd rejected' });
      }
    } catch (e) {
      logger.error('sabnzbd', 'Add failed', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ─── qBittorrent — add torrent (magnet or torrent URL) ───────────
  app.post('/api/qbittorrent/add', requireDownloadAccess, async (req, res) => {
    try {
      const { magnet, torrentUrl, issueId } = req.body;
      if (!magnet && !torrentUrl) return res.status(400).json({ error: 'magnet or torrentUrl required' });

      // Determine series_type from the issue (if provided) so we can route to
      // the correct qBit category + savepath. Comic torrents and manga torrents
      // need to land in different qBit categories so the manga-pp filesystem
      // poller doesn't try to scan comic torrents (it would fail to match any
      // manga series and start deleting files — see manga-pp guard rationale).
      let seriesType = 'manga'; // safe default — preserves prior behaviour
      if (issueId) {
        const row = db.prepare(`
        SELECT s.series_type FROM monitored_issues i
        JOIN monitored_series s ON s.id = i.series_id
        WHERE i.id = ?
      `).get(issueId);
        if (row?.series_type === 'comic') seriesType = 'comic';
      }

      const { url, qbtHeaders } = await qbtLogin();
      const cat = seriesType === 'comic'
        ? (getSetting('qbittorrent_comic_category') || 'comics')
        : (getSetting('qbittorrent_category') || 'manga');

      const formData = new URLSearchParams();
      const sourceUrl = magnet || torrentUrl;
      formData.append('urls', sourceUrl);
      formData.append('category', cat);
      const qbtSavepath = seriesType === 'comic'
        ? (getSetting('qbittorrent_comic_savepath') || '')
        : (getSetting('qbittorrent_savepath') || process.env.TORRENTS_PATH || '');
      if (qbtSavepath) formData.append('savepath', qbtSavepath);

      // Snapshot existing hashes before add — see resolveQbtHash for rationale.
      const beforeRes = await axios.get(`${url}/api/v2/torrents/info`, {
        headers: qbtHeaders, timeout: 5000,
        params: { category: cat },
      });
      const beforeHashes = new Set((beforeRes.data || []).map(t => t.hash?.toLowerCase()));

      await axios.post(`${url}/api/v2/torrents/add`, formData.toString(), {
        headers: { ...qbtHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      });

      if (issueId) {
        const torrentHash = await resolveQbtHash({ url, qbtHeaders }, sourceUrl, cat, beforeHashes);
        db.prepare(`UPDATE monitored_issues SET status='snatched', download_id=?, download_url=? WHERE id=?`)
          .run(`qbt_${torrentHash}`, sourceUrl, issueId);
        logger.info('qbittorrent', `Issue ${issueId} snatched (${seriesType})`, { category: cat, hash: torrentHash });
      }

      res.json({ success: true, category: cat });
    } catch (e) {
      logger.error('qbittorrent', 'Add failed', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Nyaa.si search — manga volumes (Literature - English-translated, c=3_1) ────
  app.get('/api/nyaa/search', requireDownloadAccess, async (req, res) => {
    try {
      const { q } = req.query;
      if (!q) return res.status(400).json({ error: 'q required' });

      const rssUrl = `https://nyaa.si/?page=rss&c=3_1&q=${encodeURIComponent(q)}`;
      logger.info('nyaa', `Fetching via FlareSolverr: ${rssUrl}`);

      // Nyaa.si is behind Cloudflare — use FlareSolverr to bypass
      const fs = await axios.post(`${FLARESOLVERR_URL}/v1`, {
        cmd: 'request.get',
        url: rssUrl,
        maxTimeout: 60000,
      }, { timeout: 65000 });

      const solution = fs.data?.solution;
      if (!solution || solution.status !== 200) {
        throw new Error(`FlareSolverr failed: ${fs.data?.message || 'status ' + solution?.status}`);
      }
      const xml = solution.response;
      logger.info('nyaa', `FlareSolverr response length: ${xml?.length}, first 200 chars: ${(xml||'').slice(0,200).replace(/\n/g,' ')}`);
      const items = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(xml)) !== null) {
        const block = match[1];
        const get = (tag) => {
          const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`));
          return m ? (m[1] || m[2] || '').trim() : '';
        };
        const getAttr = (tag, attr) => {
          const m = block.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"[^>]*\\/>`));
          return m ? m[1] : '';
        };

        const title    = get('title');
        const link     = get('link') || getAttr('enclosure', 'url');
        const size     = getAttr('nyaa:size', 'nyaa:size') || get('nyaa:size');
        const seeders  = parseInt(get('nyaa:seeders') || '0');
        const leechers = parseInt(get('nyaa:leechers') || '0');
        const infoHash = get('nyaa:infoHash');
        const magnet   = infoHash
          ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce`
          : '';
        const pubDate  = get('pubDate');

        if (!title) continue;

        // Classify: pack, single volume, or chapter (skip chapters for now)
        const isChapter = /(?:ch(?:apter)?\.?\s*\d+(?!\s*-\s*\d+\s*vol)|#\d{3,}(?!\s*vol))/i.test(title) &&
                          !/v(?:ol(?:ume)?)?[\s.]?\d+/i.test(title);
        const isPack    = /v(?:ol(?:ume)?)?[\s.]?\d+\s*[-–]\s*(?:v(?:ol(?:ume)?)?[\s.]?)?\d+/i.test(title) ||
                          /\(v(?:ol)?\.?\d+\s*[-–]\s*v?(?:ol)?\.?\d+\)/i.test(title);
        const type      = isChapter ? 'chapter' : isPack ? 'pack' : 'single';

        // Extract volume number for single volumes
        let volumeNumber = null;
        if (type === 'single') {
          const vm = title.match(/v(?:ol(?:ume)?)?\.?\s*0*(\d+)/i);
          if (vm) volumeNumber = parseInt(vm[1]);
        }

        items.push({ title, link, magnet, size, seeders, leechers, pubDate, type, volumeNumber, infoHash });
      }

      logger.info('nyaa', `Search "${q}": ${items.length} results (${items.filter(i=>i.type==='single').length} single, ${items.filter(i=>i.type==='pack').length} packs, ${items.filter(i=>i.type==='chapter').length} chapters)`);
      res.json({ results: items, query: q });
    } catch (e) {
      logger.error('nyaa', 'Search failed', e.message);
      res.status(500).json({ error: e.message });
    }
  });
  return {};
};
