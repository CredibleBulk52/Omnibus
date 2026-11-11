'use strict';
// ─── GetComics: search results, download links, /dls/ link resolution ─────────
// Moved out of server.js unchanged (2026-11-04, downloads stage 2). Pages come through
// FlareSolverr (./flaresolverr.js); server.js passes in what it shares.
module.exports.createGetComics = function createGetComics({ axios, logger, fs, path, LOG_DIR, fsCache, fetchViaFlareSolverr }) {

function scrapeGcResults(html) {
  // Parse getcomics.org search results — WordPress posts
  const results = [];
  // Each post: <article ...><a href="URL"><h1>TITLE</h1></a>...<p>DESC</p>...</article>
  const articleRe = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  let am;
  while ((am = articleRe.exec(html)) !== null) {
    const block = am[1];
    const urlM  = /href="(https?:\/\/getcomics\.org\/[^"]+)"/.exec(block);
    // Post headings were h1; h2/h3 are accepted too in case GetComics changes them (2026-11-03).
    const linked = /<h([1-3])[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>[\s\S]*?<\/h\1>/i.exec(block);
    const plain  = linked ? null : /<h[1-3][^>]*>([^<]+)<\/h[1-3]>/i.exec(block);
    const title  = linked ? linked[2] : plain ? plain[1] : null;
    const imgM  = /<img[^>]+src="([^"]+)"[^>]*>/i.exec(block);
    const descM = /<p[^>]*>([^<]{20,})<\/p>/i.exec(block);
    if (!urlM || !title) continue;
    results.push({
      url:   urlM[1],
      title: title.trim().replace(/&#038;/g, '&').replace(/&amp;/g, '&').replace(/&#8211;/g, '–'),
      cover: imgM ? imgM[1] : null,
      description: descM ? descM[1].trim().slice(0, 200) : '',
    });
  }
  if (!results.length) saveGcSample(html);
  return results;
}

// A GetComics search page with nothing read from it: keep what came back
// (logs/getcomics-search-*.html, newest 5) and say what it was, so an empty
// search can be told apart from a changed page or a Cloudflare challenge (2026-11-03).
function saveGcSample(html) {
  try {
    const text = String(html || '');
    const title = (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '(no title)';
    const articles = (text.match(/<article\b/gi) || []).length;
    const challenged = require('./flaresolverr').looksChallenged(text);
    const file = path.join(LOG_DIR, `getcomics-search-${new Date().toISOString().replace(/[:.]/g, '-')}.html`);
    fs.writeFileSync(file, text);
    const old = fs.readdirSync(LOG_DIR).filter(f => /^getcomics-search-.*\.html$/.test(f)).sort().slice(0, -5);
    for (const f of old) { try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch {} }
    logger.warn('getcomics', 'Search page gave no results', { title: title.trim().slice(0, 120), bytes: text.length, articles, challenged, saved: path.basename(file) });
  } catch (e) { logger.warn('getcomics', 'Could not save the search page', e.message); }
}

function scrapeGcLinks(html) {
  // Walk *from* each download link outward, looking backwards through the HTML
  // for the nearest pack-label text. This is more robust than the old approach
  // of trying to pre-segment the page into <li>/<p> blocks — GC pages vary
  // wildly in markup (bullet lists, paragraphs, tables, bare inline text) and
  // segment-based extraction silently skipped packs in the odd layouts.
  //
  // Also previously the stripHtml helper deleted numeric entities like &#8211;
  // (en-dash) entirely; now we decode them so dashes in "#1 – 50" survive.
  const SKIP_LABEL = /read online|how.?to|support|donate|contact|discord|rco|ai |nsfw|anime/i;
  const seen = new Set();
  const links = [];

  // Entity decoder — handles numeric refs like &#8211; and common named entities.
  // Previously these were stripped entirely which wrecked labels containing dashes.
  const decodeEntities = s => s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&[a-z]+;/gi, ''); // last-resort drop any remaining named entities

  const stripHtml = s => decodeEntities(s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).trim();

  // A pack label: contains a digit, has reasonable length, and isn't the entire page.
  // Normalized dash variants all count.
  const isPackLabel = t => /\d/.test(t) && t.length >= 4 && t.length <= 200;

  // Build an index of all link positions in the HTML with their enclosing text.
  // For each <a href="..."> we record: url, start, end, link-label (inner text),
  // then later walk backwards from `start` to find the nearest preceding text node
  // that looks like a pack label.
  const linkMatches = [];
  const tagRe = /<a\s([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const attrs = m[1];
    const inner = m[2];
    const hrefM = /href="([^"]+)"/i.exec(attrs);
    if (!hrefM) continue;
    const url = hrefM[1];

    let kind = null;
    let linkType = null;
    if (/^https?:\/\/getcomics\.org\/dl[ds]s?\//i.test(url))            { kind = 'dlds';  linkType = null; }
    else if (/^https?:\/\/(www\.)?mega\.nz\//i.test(url))                { kind = 'mega';  linkType = 'mega'; }
    else if (/^https?:\/\/(www\.)?mediafire\.com\//i.test(url))          { kind = 'mediafire'; linkType = 'mediafire'; }
    else if (/^https?:\/\/(www\.)?pixeldrain\.com\//i.test(url))         { kind = 'pixeldrain'; linkType = 'pixeldrain'; }
    else if (/^https?:\/\/(www\.)?(teraboxapp|terabox|1024terabox)\.com\//i.test(url)) { kind = 'terabox'; linkType = 'terabox'; }
    else if (/^https?:\/\/(www\.)?rootz\.so\//i.test(url))               { kind = 'rootz'; linkType = 'rootz'; }
    else if (/^https?:\/\/(www\.)?vikingfile\.com\//i.test(url))         { kind = 'vikingfile'; linkType = 'vikingfile'; }
    else if (/^https?:\/\/cloud\.mail\.ru\//i.test(url))                 { kind = 'cloudmail'; linkType = 'cloudmail'; }
    // Main Server — GetComics rotates comicfiles.ru through many subdomains
    // (fs1/fs2/dl1/twlv/four/seven/eight/nine etc.). Accept any subdomain rather
    // than enumerate — the path structure (zip file, Referer: getcomics.org) is
    // identical across all of them. Previously only matched fs\d*|twlv|dl\d*
    // which dropped Main Server links on ~70% of posts (eight.comicfiles.ru is
    // one of the most commonly used prefixes).
    else if (/^https?:\/\/(?:[a-z0-9-]+\.)?comicfiles\.ru\//i.test(url)) { kind = 'comicfiles'; linkType = null; }
    // UFile / WeTransfer — manual-only hosts. UFile has CAPTCHA + wait-timer
    // gates on its free tier; WeTransfer links expire after 7 days and require
    // a browser session to collect. Show them in the UI so users can click
    // through manually but don't attempt auto-grab.
    else if (/^https?:\/\/(?:[a-z0-9-]+\.)?ufile\.io\//i.test(url))      { kind = 'ufile'; linkType = 'ufile'; }
    else if (/^https?:\/\/(?:we\.tl|(?:www\.)?wetransfer\.com)\//i.test(url)) { kind = 'wetransfer'; linkType = 'wetransfer'; }
    // Additional manual-only hosts that appear on GC posts. These are
    // displayed in the UI so the user can click through manually, but no
    // auto-downloader exists for them. Userscloud is common on pre-2020 GC
    // posts; Gofile is actively used on current posts (2023+) and often
    // appears as the first/only working mirror for newer releases; Sendspace
    // and Uploadhaven appear occasionally on older posts.
    // NOTE: Zippyshare shut down in March 2023 — links are dead, not shown.
    else if (/^https?:\/\/(?:www\.)?userscloud\.com\//i.test(url))        { kind = 'userscloud'; linkType = 'userscloud'; }
    else if (/^https?:\/\/(?:www\.)?gofile\.io\//i.test(url))             { kind = 'gofile'; linkType = 'gofile'; }
    else if (/^https?:\/\/(?:www\.)?sendspace\.com\//i.test(url))         { kind = 'sendspace'; linkType = 'sendspace'; }
    else if (/^https?:\/\/(?:www\.)?uploadhaven\.com\//i.test(url))       { kind = 'uploadhaven'; linkType = 'uploadhaven'; }
    // Direct CDN zip URLs on GetComics' own subdomains. These are the
    // "Download Now" (light) and "Mirror Download" (shadow) big buttons and
    // are the highest-quality sources: no CAPTCHA, no third-party throttling,
    // no session tokens. Route through the default axios-streaming path
    // (not isThirdParty) so they get the retry + range-resume treatment.
    else if (/^https?:\/\/light\.getcomics\.info\//i.test(url))          { kind = 'direct';  linkType = null; }
    else if (/^https?:\/\/shadow\.getcomics\.info\//i.test(url))         { kind = 'mirror';  linkType = null; }
    else continue;

    const titleM = /title="([^"]+)"/i.exec(attrs);
    const rawLabel = titleM ? titleM[1] : inner;
    const label = stripHtml(rawLabel);

    linkMatches.push({
      url,
      kind,
      linkType,
      label,
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  // For each link, walk backwards in the HTML from the link's start index to
  // find the nearest block of plain text (outside any <a>) that looks like a
  // pack label. GC's markup puts the label once at the start of a <li>, then
  // several download links follow (TERABOX | Mega | MediaFire) — so links 2,3
  // have the label further away, past link 1's `</a>`. We collect all text
  // before the current link, stripping out the inner text of preceding <a>
  // tags, then scan that collected text for pack-label-shaped content.
  //
  // Some pack offerings use standalone "big buttons" wrapped in an empty
  // <p><div class="aio-button-center">...</div></p> — the immediately
  // enclosing <p> has no text of its own, so we need to keep peeling back
  // through prior <p>/<li> blocks until we find one with a real label.
  // Capped at 8 attempts to avoid pathological cases.
  const LOOKBACK     = 1200;
  const MAX_ATTEMPTS = 8;

  for (const link of linkMatches) {
    let packLabel = null;
    let searchEnd = link.start;

    for (let attempts = 0; attempts < MAX_ATTEMPTS; attempts++) {
      const chunkStart = Math.max(0, searchEnd - LOOKBACK);
      const chunk = html.slice(chunkStart, searchEnd);
      if (!chunk.length) break;

      // Anchor to the most recent <li>/<p> open tag in this window. If the
      // current block has no label text, we'll rewind past this open tag
      // on the next iteration to look at the previous block.
      const liOpen = Math.max(
        chunk.lastIndexOf('<li>'), chunk.lastIndexOf('<li '),
        chunk.lastIndexOf('<p>'),  chunk.lastIndexOf('<p '),
      );
      if (liOpen === -1) break;

      // Stop if we've crossed a section heading — that's a different pack
      // section and we shouldn't inherit labels across it.
      const focused  = chunk.slice(liOpen);
      if (/<h[1-4][\s>]/i.test(focused)) break;

      // Strip preceding <a>...</a> link text (anchor labels aren't pack
      // labels) and then all remaining tags.
      const withoutLinks = focused.replace(/<a\s[^>]*>[\s\S]*?<\/a>/gi, ' ');
      const text = stripHtml(withoutLinks);

      if (isPackLabel(text)) {
        let cleaned = text.replace(/[:|\s]+$/, '').trim();
        // The "big button" pack blocks on GC typically look like:
        //   "<Title> Language : English | Year : 1985-2010 | Size : 1.9 GB"
        // That's too noisy for a group header. Collapse it to "<Title> (1.9 GB)"
        // when we can identify those tokens, otherwise keep as-is.
        const sizeM = /Size\s*:\s*([\d.]+\s*[KMGT]?B)/i.exec(cleaned);
        const titleM = /^(.*?)\s+Language\s*:/i.exec(cleaned);
        if (titleM && sizeM) {
          cleaned = `${titleM[1].trim()} (${sizeM[1].trim()})`;
        }
        packLabel = cleaned;
        break;
      }

      // No label here — move searchEnd back past this open tag so the
      // next iteration looks at the PREVIOUS <p>/<li> block.
      const newEnd = chunkStart + liOpen;
      if (newEnd >= searchEnd) break; // safety: no progress
      searchEnd = newEnd;
    }

    if (seen.has(link.url)) continue;
    if (!link.label || SKIP_LABEL.test(link.label)) continue;
    seen.add(link.url);

    if (link.kind === 'dlds') {
      links.push({ url: link.url, label: link.label, isDlds: true, packLabel });
    } else if (link.kind === 'comicfiles') {
      links.push({ url: link.url, label: link.label || 'Direct', isDlds: false, packLabel });
    } else if (link.kind === 'direct' || link.kind === 'mirror') {
      // Direct GetComics CDN URLs (light.getcomics.info / shadow.getcomics.info).
      // No resolver needed; the URL is already a .zip. Mark isDlds=false so the
      // download flow treats it like any direct URL.
      const host = link.kind === 'direct' ? 'Direct' : 'Mirror';
      links.push({ url: link.url, label: host, isDlds: false, packLabel });
    } else {
      // External mirrors — replace label with host for clean UI. Note: some of
      // these hosts (Terabox, Rootz, VikingFile, CloudMail) don't have working
      // auto-resolvers and can't be grabbed automatically; they're shown for
      // manual click-through. Mega and MediaFire do have downloaders.
      const host = link.kind === 'mega' ? 'Mega'
                 : link.kind === 'mediafire' ? 'MediaFire'
                 : link.kind === 'pixeldrain' ? 'Pixeldrain'
                 : link.kind === 'terabox' ? 'Terabox'
                 : link.kind === 'rootz' ? 'Rootz'
                 : link.kind === 'vikingfile' ? 'VikingFile'
                 : link.kind === 'cloudmail' ? 'CloudMail'
                 : link.kind === 'ufile' ? 'UFile'
                 : link.kind === 'wetransfer' ? 'WeTransfer'
                 : link.kind === 'userscloud' ? 'Userscloud'
                 : link.kind === 'gofile' ? 'Gofile'
                 : link.kind === 'sendspace' ? 'Sendspace'
                 : link.kind === 'uploadhaven' ? 'Uploadhaven'
                 : link.label || 'Link';
      links.push({ url: link.url, label: host, isDlds: false, linkType: link.linkType, packLabel });
    }
  }

  // GetComics can show the same set of buttons twice (top and bottom of the post),
  // each copy with its own address; the issue search listed both (user 2026-11-03).
  // Keep the first of each button name under the same heading text: a different
  // file has its own heading, so it is never dropped.
  const seenButton = new Set();
  return links.filter(l => {
    const key = `${String(l.label || '').toLowerCase()}|${String(l.packLabel || '').toLowerCase()}|${l.isDlds ? 'dlds' : 'direct'}`;
    if (seenButton.has(key)) return false;
    seenButton.add(key);
    return true;
  });
}

// Resolve a getcomics.org/dlds/ redirect to its final URL.
// /dlds/ links trigger a file download (Content-Disposition: attachment), so FlareSolverr's
// Chromium opens chrome://new-tab-page/ instead of navigating. Instead:
//   1. Use cached CF cookies (or fetch homepage via FlareSolverr to get them)
//   2. Use axios with those CF cookies to follow the redirect chain — axios gets the Location header
// Returns null if the final destination is an unsupported host (Mega, Terabox, etc.)
async function resolveDldsLink(url) {
  // Mega and MediaFire now have dedicated downloaders — keep truly unsupported hosts only
  const SKIP = /terabox|1024terabox|fileq\.net|vikingfile|zippyshare|sendspace|uploadhaven|gofile/i;

  // Ensure we have CF clearance cookies for getcomics.org
  const now = Date.now();
  let cached = fsCache.get('getcomics.org');
  if (!cached || cached.expiry <= now) {
    logger.info('getcomics', 'resolveDldsLink: fetching CF cookies via FlareSolverr homepage');
    try {
      // Fetch the homepage just to get cookies — we don't need the content
      await fetchViaFlareSolverr('https://getcomics.org/');
      cached = fsCache.get('getcomics.org');
    } catch (e) {
      logger.warn('getcomics', `resolveDldsLink: failed to get CF cookies: ${e.message}`);
    }
  }

  const headers = {
    'User-Agent': cached?.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://getcomics.org/',
  };


  // Follow redirect chain manually — do NOT let axios download the body.
  // The dlds URL may point to a large pack file (500MB+); reading the body causes stream abort.
  // Instead: issue HEAD requests (no body), fall back to GET-and-abort if server rejects HEAD.
  try {
    let current = url;
    for (let hop = 0; hop < 10; hop++) {
      let location = null;
      const hopHeaders = require('../downloadSecurity').cachedDownloadHeaders(current, fsCache, headers);

      // Try HEAD first (no body transfer)
      try {
        const r = await axios.head(current, {
          maxRedirects: 0,
          timeout: 10000,
          validateStatus: s => true,
          headers: hopHeaders,
        });
        if (r.status >= 300 && r.status < 400) {
          location = r.headers['location'];
        } else {
          // Non-redirect — current is the final URL
          break;
        }
      } catch (headErr) {
        // HEAD rejected or network error — try GET but abort immediately after headers
        try {
          const r = await axios.get(current, {
            maxRedirects: 0,
            timeout: 10000,
            validateStatus: s => true,
            headers: hopHeaders,
            responseType: 'stream',
          });
          // Destroy the stream immediately — we only wanted headers
          r.data.destroy();
          if (r.status >= 300 && r.status < 400) {
            location = r.headers['location'];
          } else {
            break;
          }
        } catch (getErr) {
          // axios throws on maxRedirects:0 with 3xx — Location is in error.response
          if (getErr.response?.status >= 300 && getErr.response?.status < 400) {
            location = getErr.response.headers['location'];
          } else {
            throw getErr;
          }
        }
      }

      if (!location) break;
      // Resolve relative Location headers
      current = new URL(location, current).href;
    }

    const finalUrl = current;
    logger.info('getcomics', `resolveDldsLink: ${url} → ${finalUrl}`);
    if (SKIP.test(finalUrl)) {
      logger.warn('getcomics', `resolveDldsLink: skipping unsupported host`, { finalUrl });
      return null;
    }
    if (!/^https?:\/\//i.test(finalUrl)) {
      logger.warn('getcomics', `resolveDldsLink: non-HTTP final URL`, { finalUrl });
      return null;
    }
    // Detect error pages (MediaFire errno, dead links etc.)
    if (/error\.php|errno=|404|not.found|deleted|removed/i.test(new URL(finalUrl).pathname + new URL(finalUrl).search)) {
      logger.warn('getcomics', `resolveDldsLink: error page detected`, { finalUrl });
      return null;
    }
    return finalUrl;
  } catch (e) {
    logger.warn('getcomics', `resolveDldsLink failed: ${e.message}`, { url });
    return null;
  }
}

return { scrapeGcResults, saveGcSample, scrapeGcLinks, resolveDldsLink };
};
