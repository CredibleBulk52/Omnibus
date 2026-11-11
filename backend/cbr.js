'use strict';
// ─── Comic Book Roundup ratings: lookup, background fetch queue, admin trigger ───
// Moved out of server.js unchanged (2026-11-10, server.js split): CBR slug guessing and page
// scraping, the routes for series and issue ratings, the background auto-fetch queue
// (runCbrQueue, started by server.js 20 s after startup) and the admin queue trigger.
module.exports.createCbr = function createCbr(deps) {
  const missing = ['app', 'db', 'FLARESOLVERR_URL', 'getSeriesAwards', 'logger', 'requireAdmin', 'requireAuth'].filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createCbr: missing ${missing.join(', ')}`);
  const { app, db, FLARESOLVERR_URL, getSeriesAwards, logger, requireAdmin, requireAuth } = deps;

// ─── Comic Book Roundup ratings ──────────────────────────────────
// === CBR Publisher slug map ===
const CBR_PUB_SLUGS = {
  'marvel comics':        'marvel-comics',
  'marvel':               'marvel-comics',
  'dc comics':            'dc-comics',
  'dc':                   'dc-comics',
  'image comics':         'image-comics',
  'image':                'image-comics',
  'dark horse comics':    'dark-horse-comics',
  'dark horse':           'dark-horse-comics',
  'idw publishing':       'idw-publishing',
  'idw':                  'idw-publishing',
  'boom! studios':        'boom-studios',
  'boom studios':         'boom-studios',
  'dynamite entertainment': 'dynamite',
  'dynamite':             'dynamite',
  'mad cave studios':     'mad-cave-studios',
  'mad cave':             'mad-cave-studios',
  'titan books':          'titan-books',
  'titan comics':         'titan-books',
  'titan':                'titan-books',
  'archie comics':        'archie-comics',
  'aftershock comics':    'aftershock-comics',
  'aftershock':           'aftershock-comics',
  'vault comics':         'vault-comics',
  'vault':                'vault-comics',
  'oni press':            'oni-press',
  'zenescope':            'zenescope',
  'avatar press':         'avatar-press',
  'ahoy comics':          'ahoy-comics',
  'top cow':              'top-cow',
  'valiant':              'valiant',
  'scout comics':         'scout-comics',
  // DC imprints — CBR uses them as separate publishers
  'vertigo':              'vertigo',
  'dc vertigo':           'vertigo',
  'dc comics - vertigo':  'vertigo',
  'dc black label':       'dc-black-label',
  'black label':          'dc-black-label',
  'dc comics - black label': 'dc-black-label',
  'dc elseworlds':        'elseworlds',
  'elseworlds':           'elseworlds',
  // Marvel imprints
  'marvel max':           'marvel-max',
  'max comics':           'marvel-max',
  'marvel knights':       'marvel-comics',
  // Other
  'fantagraphics':        'fantagraphics',
  'fantagraphics books':  'fantagraphics',
  'drawn and quarterly':  'drawn-quarterly',
  'drawn & quarterly':    'drawn-quarterly',
  'abrams comicarts':     'abrams-comicarts',
  'ablaze':               'ablaze',
  'awakenings':           'awakenings',
  'heavy metal':          'heavy-metal',
};

function titleToSlug(t) {
  return (t || '')
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, '')
    .replace(/&/g, '')          // strip & rather than expand to "and" — CBR omits it
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');       // collapse any double-dashes from stripped chars
}

function publisherToSlug(publisher) {
  const key = (publisher || '').toLowerCase().trim();
  if (CBR_PUB_SLUGS[key]) return CBR_PUB_SLUGS[key];
  return titleToSlug(publisher) || null;
}

async function fetchHttp(url) {
  // Try FlareSolverr first (handles Cloudflare-protected sites like CBR)
  try {
    const postBody = JSON.stringify({ cmd: 'request.get', url, maxTimeout: 30000 });
    const fsUrl = new URL(FLARESOLVERR_URL + '/v1');
    const result = await new Promise((resolve, reject) => {
      const lib = require(fsUrl.protocol === 'https:' ? 'https' : 'http');
      const req = lib.request({
        hostname: fsUrl.hostname,
        port: fsUrl.port || (fsUrl.protocol === 'https:' ? 443 : 80),
        path: fsUrl.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postBody) },
        timeout: 35000,
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(postBody);
      req.end();
    });
    if (result.status === 200) {
      const json = JSON.parse(result.data);
      logger.debug('cbr', 'FlareSolverr response', { status: json.status, hasSolution: !!json.solution });
      if (json.status === 'ok' && json.solution) {
        const s = json.solution;
        logger.debug('cbr', 'FlareSolverr solution', { status: s.status, length: (s.response||'').length });
        if (s.status === 404) return { status: 404, body: null };
        return { status: s.status || 200, body: s.response || '' };
      }
    }
    logger.debug('cbr', 'FlareSolverr non-ok response', { status: result.status });
  } catch (e) {
    logger.debug('cbr', 'FlareSolverr unavailable, falling back to direct fetch', { error: e.message });
  }

  // Fallback: direct request
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    const reqObj = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 12000,
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const loc = response.headers.location;
        const nextUrl = loc.startsWith('http') ? loc : 'https://comicbookroundup.com' + loc;
        return fetchHttp(nextUrl).then(resolve).catch(() => resolve(null));
      }
      if (response.statusCode === 404) return resolve({ status: 404, body: null });
      if (response.statusCode !== 200) return resolve(null);
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => resolve({ status: 200, body: data }));
    });
    reqObj.on('error', () => resolve(null));
    reqObj.on('timeout', () => { reqObj.destroy(); resolve(null); });
  });
}

function parseCBRPage(html, pageUrl) {
  if (!html) return null;

  // ── Primary: JSON-LD structured data ─────────────────────────────
  // CBR embeds AggregateRating schema in <script type="application/ld+json"> tags.
  // This is far more reliable than regex on rendered HTML.
  let criticScore = null, userScore = null;

  const ldMatches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of ldMatches) {
    try {
      const obj = JSON.parse(m[1]);
      const blocks = Array.isArray(obj) ? obj : [obj];
      for (const block of blocks) {
        const rating = block['@type'] === 'AggregateRating' ? block
          : (block.aggregateRating?.['@type'] === 'AggregateRating' ? block.aggregateRating : null);
        if (rating) {
          const score = parseFloat(rating.ratingValue);
          const count = parseInt(String(rating.ratingCount || rating.reviewCount || '0').replace(/,/g, ''));
          if (!isNaN(score)) {
            // First AggregateRating = critic score, second = user score
            if (!criticScore) criticScore = { score, count };
            else if (!userScore) userScore = { score, count };
          }
        }
      }
    } catch {}
  }

  // ── Fallback: regex on HTML body ──────────────────────────────────
  if (!criticScore) {
    const a = html.match(/(\d+\.\d+)[\s\S]{0,200}?Critic Rating[\s\S]{0,200}?(\d[\d,]*)\s*Review/i);
    if (a) criticScore = { score: parseFloat(a[1]), count: parseInt(a[2].replace(/,/g, '')) };
  }
  if (!criticScore) {
    const b = html.match(/(\d+\.\d+)[^<]*<\/[^>]+>[\s\S]{0,100}<h2[^>]*>[^<]*Critic Rating[^<]*<\/h2>[\s\S]{0,200}?(\d[\d,]*)\s*Review/i);
    if (b) criticScore = { score: parseFloat(b[1]), count: parseInt(b[2].replace(/,/g, '')) };
  }
  if (!userScore) {
    // Structure: <div class="review user ..."><span>8.3</span></div> ... <h2>User Rating</h2> ... <div class="review-count">38 Reviews</div>
    const u = html.match(/class="review user[^"]*"[^>]*>\s*<span>([\d.]+)<\/span>[\s\S]{0,400}?<h2>User Rating<\/h2>[\s\S]{0,200}?(\d[\d,]*)\s*Review/i);
    if (u) userScore = { score: parseFloat(u[1]), count: parseInt(u[2].replace(/,/g, '')) };
  }

  if (!criticScore && !userScore) return null;

  return {
    score:     criticScore?.score ?? null,
    count:     criticScore?.count ?? null,
    userScore: userScore?.score ?? null,
    userCount: userScore?.count ?? null,
    url:       pageUrl,
  };
}

// A pasted CBR address → its series page: an issue page (…/titans-(2023)/39) is trimmed to the
// series (…/titans-(2023)). null when it is not a Comic Book Roundup reviews address.
function cbrSeriesUrl(raw) {
  const m = String(raw || '').trim().match(/^https?:\/\/(?:www\.)?comicbookroundup\.com\/comic-books\/reviews\/([^/?#]+)\/([^/?#]+)/i);
  return m ? `https://comicbookroundup.com/comic-books/reviews/${m[1]}/${m[2]}` : null;
}
// Fetch and read one known CBR series page; null when it cannot be read.
async function fetchCBRSeriesPage(url) {
  const res = await fetchHttp(url);
  if (res && res.status === 200 && res.body && !isCBRHomepage(res.body)) return parseCBRPage(res.body, url);
  logger.warn('cbr', 'page could not be read', { url, status: res?.status });
  return null;
}

// CBR redirects unknown URLs to the homepage (200 OK, ~430KB+) instead of 404.
// Detect this by checking for a homepage-only marker.
function isCBRHomepage(body) {
  if (!body) return false;
  // Homepage has this string; series pages never do
  if (body.includes('NEW COMICSCompare What The Critics Say')) return true;
  // Homepage title — series pages have the series name in the title
  if (body.includes('<title>Comic Book RoundUp - Comic Book Reviews</title>')) return true;
  // A large page with no ratings on it. Size alone is not enough: long-running series pages
  // are large too (Action Comics (2016), Batman (2016): 147+ issues, 2026-10-28).
  if (body.length > 400000 && !/AggregateRating|Critic Rating|User Rating/i.test(body)) return true;
  return false;
}

async function scrapeCBR(title, publisher, year, imprint = null) {
  const titleSlug = titleToSlug(title);
  if (!titleSlug) return null;
  const pubSlug = publisherToSlug(publisher);
  const imprintSlug = imprint ? publisherToSlug(imprint) : null;

  // Build title slug variants — CBR is inconsistent with "and" / "&"
  const titleSlugs = [titleSlug];
  // "nubia-and-the-amazons" → "nubia-the-amazons" (drop "and")
  const withoutAnd = titleSlug.replace(/-and-/g, '-');
  if (withoutAnd !== titleSlug) titleSlugs.push(withoutAnd);
  // "robin-and-batman" → "robin-batman" (already covered above)
  // Also try replacing "-and-" with "-" just the first occurrence
  const withoutFirstAnd = titleSlug.replace(/-and-/, '-');
  if (withoutFirstAnd !== titleSlug && !titleSlugs.includes(withoutFirstAnd)) titleSlugs.push(withoutFirstAnd);
  // Leading article (2026-10-23): "The Deadman" (2026) is filed as deadman-(2026). Tried after the full title.
  for (const sl of [...titleSlugs]) {
    const bare = sl.replace(/^the-/, '');
    if (bare !== sl && bare && !titleSlugs.includes(bare)) titleSlugs.push(bare);
  }

  // Build candidate URLs.
  // CBR uses the year the series STARTED — which can be year-1 OR year+1 from CV's year.
  const candidates = [];
  const addUrl = (pub, slug) => {
    if (year) {
      candidates.push('https://comicbookroundup.com/comic-books/reviews/' + pub + '/' + slug + '-(' + year + ')');
      candidates.push('https://comicbookroundup.com/comic-books/reviews/' + pub + '/' + slug + '-(' + (year - 1) + ')');
      candidates.push('https://comicbookroundup.com/comic-books/reviews/' + pub + '/' + slug + '-(' + (year + 1) + ')');
    }
    candidates.push('https://comicbookroundup.com/comic-books/reviews/' + pub + '/' + slug);
  };

  const pubSlugs = [];
  if (imprintSlug && imprintSlug !== pubSlug) pubSlugs.push(imprintSlug);
  if (pubSlug) pubSlugs.push(pubSlug);
  // DC Comics series are sometimes filed under vertigo/black-label on CBR
  if (pubSlug === 'dc-comics') {
    if (!pubSlugs.includes('vertigo')) pubSlugs.push('vertigo');
    if (!pubSlugs.includes('dc-black-label')) pubSlugs.push('dc-black-label');
  }
  if (!pubSlugs.length) pubSlugs.push(...['marvel-comics','dc-comics','image-comics','dark-horse-comics','idw-publishing','boom-studios','dynamite']);

  // Try each title slug variant with each publisher slug
  for (const slug of titleSlugs) {
    for (const pub of pubSlugs) {
      addUrl(pub, slug);
    }
  }

  for (const url of candidates) {
    logger.info('cbr', `trying`, { url });
    const res = await fetchHttp(url);
    if (!res || res.status === 404) { logger.debug('cbr', `404`, { url }); continue; }
    if (res.status === 200 && res.body) {
      if (isCBRHomepage(res.body)) { logger.debug('cbr', `homepage/blocked`, { url }); continue; }
      const parsed = parseCBRPage(res.body, url);
      if (parsed) {
        logger.info('cbr', `hit`, { score: parsed.score, count: parsed.count, userScore: parsed.userScore, userCount: parsed.userCount, url });
        return parsed;
      }
      const snip = res.body.indexOf('Critic Rating');
      const userSnip = res.body.indexOf('User Rating');
      if (snip !== -1) {
        logger.warn('cbr', `found "Critic Rating" but parse failed`, { snippet: res.body.slice(Math.max(0,snip-60), snip+200) });
      } else if (userSnip !== -1) {
        logger.warn('cbr', `found "User Rating" but no "Critic Rating"`, { snippet: res.body.slice(Math.max(0,userSnip-60), userSnip+200) });
      } else {
        logger.warn('cbr', `neither "Critic Rating" nor "User Rating" found in page`, { url, bodyLength: res.body.length, bodySnippet: res.body.slice(0, 300) });
      }
    } else {
      logger.warn('cbr', `unexpected status`, { status: res && res.status, url });
    }
  }
  return null;
}

// ─── Background CBR auto-fetch queue ─────────────────────────────
// Runs after each scan: fetches CBR ratings for any series not yet cached.
// Processes one series at a time with a delay to avoid hammering CBR/FlareSolverr.
let cbrQueueRunning = false;
async function runCbrQueue() {
  if (cbrQueueRunning) return;
  cbrQueueRunning = true;
  try {
    // Find series without a real CBR rating (no row, or null sentinel older than 30 days)
    const uncached = db.prepare(`
      SELECT s.id, s.name, s.series_json, r.cbr_url
      FROM scanned_series s
      LEFT JOIN series_ratings r ON r.series_id = s.id
      WHERE r.series_id IS NULL
         OR (r.cbr_score IS NULL AND r.user_score IS NULL AND (r.fetched_at IS NULL OR r.fetched_at < datetime('now', '-30 days')))
         OR (r.user_score IS NULL AND r.cbr_score IS NOT NULL AND r.fetched_at < datetime('now', '-7 days'))
      ORDER BY s.last_scanned DESC
    `).all();
    logger.info('cbr', `auto-queue: ${uncached.length} series need CBR rating`);
    for (const row of uncached) {
      let title = '', publisher = '', year = null, imprint = null;
      try {
        const m = JSON.parse(row.series_json || '{}');
        title     = (m.metadata && m.metadata.name) ? m.metadata.name : (row.name || '');
        publisher = (m.metadata && m.metadata.publisher) ? m.metadata.publisher : '';
        year      = (m.metadata && m.metadata.year) ? parseInt(m.metadata.year) : null;
        imprint   = (m.metadata && m.metadata.imprint) ? m.metadata.imprint : null;
      } catch(e) { title = row.name || ''; }
      const cleanTitle = title.replace(/\s*\(\d{4}(-\d{4})?\)\s*/g, '').trim();
      if (!cleanTitle) continue;
      try {
        // A series whose page is known (found before, or pasted by hand) is refreshed from that page,
        // and keeps its scores when the page cannot be read (2026-10-23: refreshes used to guess again
        // and could wipe a pasted page such as New Titans → titans-(2023)).
        if (row.cbr_url) {
          const again = await fetchCBRSeriesPage(row.cbr_url);
          if (again) db.prepare("UPDATE series_ratings SET cbr_score = ?, cbr_count = ?, user_score = ?, user_count = ?, fetched_at = datetime('now') WHERE series_id = ?").run(again.score, again.count, again.userScore ?? null, again.userCount ?? null, row.id);
          else db.prepare("UPDATE series_ratings SET fetched_at = datetime('now') WHERE series_id = ?").run(row.id);
          await new Promise(r => setTimeout(r, 18000));
          continue;
        }
        const result = await scrapeCBR(cleanTitle, publisher, year, imprint);
        if (result) {
          db.prepare("INSERT OR REPLACE INTO series_ratings (series_id, cbr_score, cbr_count, cbr_url, user_score, user_count, fetched_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))").run(row.id, result.score, result.count, result.url, result.userScore ?? null, result.userCount ?? null);
          logger.info('cbr', `cached for: ${cleanTitle}`, { critic: result.score, user: result.userScore });
        } else {
          // No match found — upsert a sentinel with updated fetched_at so we don't retry for 30 days.
          // Use INSERT OR REPLACE so existing rows (e.g. those with only user_score) get their
          // fetched_at refreshed rather than being silently skipped by INSERT OR IGNORE.
          db.prepare("INSERT OR REPLACE INTO series_ratings (series_id, cbr_score, cbr_count, cbr_url, user_score, user_count, fetched_at) VALUES (?, NULL, NULL, NULL, NULL, NULL, datetime('now'))").run(row.id);
        }
      } catch (e) {
        logger.warn('cbr', `error fetching ${cleanTitle}: ${e.message}`);
      }
      // Polite delay between requests — FlareSolverr needs ~15s per page
      await new Promise(r => setTimeout(r, 18000));
    }
    logger.info('cbr', 'auto-queue complete');
  } finally {
    cbrQueueRunning = false;
  }
}

// GET /api/series/:id/ratings   → returns cached rating + awards
app.get('/api/series/:id/ratings', requireAuth, (req, res) => {
  const rating = db.prepare('SELECT cbr_score, cbr_count, cbr_url, user_score, user_count FROM series_ratings WHERE series_id = ?').get(req.params.id);
  const row = db.prepare('SELECT series_json, name FROM scanned_series WHERE id = ?').get(req.params.id);
  let title = '';
  try { const m = JSON.parse(row && row.series_json ? row.series_json : '{}'); title = (m.metadata && m.metadata.name) ? m.metadata.name : (row ? row.name : ''); } catch(e) { title = row ? row.name : ''; }
  const awards = getSeriesAwards(title);
  // Return rating if it has either a critic score OR a user score
  const ratingOut = (rating && (rating.cbr_score != null || rating.user_score != null)) ? rating : null;
  res.json({ rating: ratingOut, awards });
});

// POST /api/series/:id/ratings/fetch  → scrape CBR and cache
// Optional body: { cbrUrl: 'https://comicbookroundup.com/...' } to bypass auto-detection
app.post('/api/series/:id/ratings/fetch', requireAdmin, async (req, res) => {
  const row = db.prepare('SELECT series_json, name FROM scanned_series WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Series not found' });
  let seriesTitle = '', publisher = '', year = null, imprint = null;
  try {
    const m = JSON.parse(row.series_json || '{}');
    seriesTitle = (m.metadata && m.metadata.name) ? m.metadata.name : (row.name || '');
    publisher   = (m.metadata && m.metadata.publisher) ? m.metadata.publisher : '';
    year        = (m.metadata && m.metadata.year) ? parseInt(m.metadata.year) : null;
    imprint     = (m.metadata && m.metadata.imprint) ? m.metadata.imprint : null;
  } catch(e) { seriesTitle = row.name || ''; }
  const cleanTitle = seriesTitle.replace(/\s*\(\d{4}(-\d{4})?\)\s*/g, '').trim();
  if (!cleanTitle) return res.status(400).json({ error: 'No series title' });

  const { cbrUrl } = req.body || {};
  logger.info('cbr', `manual fetch`, { title: cleanTitle, publisher, year, cbrUrl: cbrUrl || null });
  try {
    let result;
    if (cbrUrl) {
      // Pasted page: an issue page is trimmed to its series page; only that page is read.
      const page = cbrSeriesUrl(cbrUrl);
      if (!page) return res.json({ ok: false, message: 'That is not a Comic Book Roundup reviews address (comicbookroundup.com/comic-books/reviews/…).' });
      result = await fetchCBRSeriesPage(page);
      if (!result) return res.json({ ok: false, message: `Could not read scores from ${page}` });
    } else {
      result = await scrapeCBR(cleanTitle, publisher, year, imprint);
    }
    if (result) {
      db.prepare("INSERT OR REPLACE INTO series_ratings (series_id, cbr_score, cbr_count, cbr_url, user_score, user_count, fetched_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))").run(req.params.id, result.score, result.count, result.url, result.userScore ?? null, result.userCount ?? null);
      return res.json({ ok: true, rating: result });
    }
    res.json({ ok: false, message: 'No match found on Comic Book Roundup' });
  } catch (e) {
    logger.error('cbr', `manual fetch failed`, { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ─── Admin CBR queue trigger ──────────────────────────────────────
// POST /api/admin/cbr-queue        → start queue, returns { ok, queued }
// GET  /api/admin/cbr-queue/status → { running, total, cached, remaining }
app.post('/api/admin/cbr-queue', requireAuth, requireAdmin, async (req, res) => {
  // Count series without a real (non-null) rating
  const uncached = db.prepare(`
    SELECT COUNT(*) as n FROM scanned_series s
    LEFT JOIN series_ratings r ON r.series_id = s.id
    WHERE r.series_id IS NULL OR r.cbr_score IS NULL
  `).get();
  const queued = uncached.n || 0;
  if (cbrQueueRunning) {
    return res.json({ ok: false, message: 'Already running', queued });
  }
  res.json({ ok: true, message: 'CBR queue started', queued });
  // Kick off after response — clear null sentinels so queue picks them up fresh
  db.prepare(`DELETE FROM series_ratings WHERE cbr_score IS NULL`).run();
  runCbrQueue();
});

app.get('/api/admin/cbr-queue/status', requireAuth, requireAdmin, (req, res) => {
  const total  = db.prepare(`SELECT COUNT(*) as n FROM scanned_series`).get().n;
  const cached = db.prepare(`SELECT COUNT(*) as n FROM series_ratings WHERE cbr_score IS NOT NULL`).get().n;
  const remaining = db.prepare(`
    SELECT COUNT(*) as n FROM scanned_series s
    LEFT JOIN series_ratings r ON r.series_id = s.id
    WHERE r.series_id IS NULL OR r.cbr_score IS NULL
  `).get().n;
  res.json({ running: cbrQueueRunning, total, cached, remaining });
});

return { runCbrQueue };
};
