'use strict';
// ─── Issue synopses for recaps (RECAPS_DESIGN.md, user 2026-10-19) ─────────
// One short synopsis per issue, stored and reused, so an issue is paid for once.
// Cheapest first:
//   1. stored synopsis (free)
//   2. the issue's ComicInfo summary, when it is a real synopsis (600+ characters, not a sales teaser; free)
//   3. web search — task recap_web (default Haiku 5.5, ~2.3¢)
//   4. the issue's pages — task recap_reader (default Sol, pages 1125 px tall, ~7.4¢), only when allowed
//   5. nothing found → stored as missing, tried again after 30 days
// Prompts are the tested ones (synopsis test v2; scores in SYNOPSIS_CONTROL.md).
// Keyed by Comic Vine issue id (every scanned book has one), else "book:<id>".

const PAGE_HEIGHT = 1125;     // tested: same accuracy as full size, ~40% cheaper; 900 px misreads lettering
const MAX_PAGES = 40;
const RETRY_MISSING_DAYS = 30;
const SEARCH_FEE = 0.01;      // assumed per web search (not in the price table)
// Never searched (user 2026-10-19): publisher solicits and a database index. Solicits are
// already in every issue's ComicInfo; comics.org has a line or two at most. Kept to sites
// that are never useful, rather than rating sites one by one. (Claude models; with an
// OpenAI model the prompt's "skip solicitations" is the only guard.)
const BLOCKED_DOMAINS = ['dcuguide.com', 'dc.com', 'marvel.com', 'comics.org'];

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['found', 'synopsis', 'source_url', 'confidence', 'covers_ending', 'source_is_this_issue'],
  properties: {
    found: { type: 'boolean' },
    synopsis: { type: ['string', 'null'] },
    source_url: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    covers_ending: { type: 'boolean' },
    source_is_this_issue: { type: 'boolean' },
  },
};
const PAGES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['found', 'beats', 'synopsis', 'confidence'],
  properties: {
    found: { type: 'boolean' },
    beats: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['pages', 'what'], properties: { pages: { type: 'string' }, what: { type: 'string' } } } },
    synopsis: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

const tag = (ci, t) => {
  const m = String(ci || '').match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`));
  return m ? m[1].replace(/&lt;[^&]*?&gt;|<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&#39;|&apos;/g, '’').replace(/&quot;/g, '"').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim() : '';
};

// Series, volume year (library folder), number, title, date, writer. Never the
// ComicInfo character list or teaser: those were wrong in 3 of 8 control issues.
function describe(book) {
  const ci = book.comicinfo || '';
  const month = tag(ci, 'Month'), year = tag(ci, 'Year');
  return {
    book_id: book.id,
    // The volume as published (ComicInfo), not the library folder: Batman #401+ are filed
    // in a "Batman (1986)" folder but are the 1940 volume.
    series: tag(ci, 'Series') || book.series_name || '', year: (/^\d{4}$/.test(tag(ci, 'Volume')) && tag(ci, 'Volume')) || book.series_year || '',
    number: tag(ci, 'Number') || book.issue_number || '', title: tag(ci, 'Title'),
    date: [year, month && String(month).padStart(2, '0')].filter(Boolean).join('-'),
    writer: tag(ci, 'Writer'),
  };
}

// A ComicInfo summary good enough to stand in for a synopsis: long, and not a
// publisher's sales blurb ("Don't miss…", "find out…", questions, "this issue").
function comicInfoSynopsis(ci) {
  const s = tag(ci, 'Summary');
  if (s.length < 600) return null;
  const teaser = /\b(don'?t miss|find out|you won'?t believe|in this issue|this issue|on sale|variant cover|the beginning of|the start of|kicks off|begins here|from the (?:creators?|writer|artist) of|the critically acclaimed|new #1|all-new|must-read|guest[- ]starring|plus,)\b/i;
  const questions = (s.match(/\?/g) || []).length;
  if (teaser.test(s.slice(0, 400)) || questions >= 2) return null;
  return s.length > 1500 ? `${s.slice(0, 1500).replace(/\s+\S*$/, '')}…` : s;
}

const WRITE_RULES = `Write a synopsis of 80–150 words for a reader who finished this issue and wants to remember it: what happens, who matters, what changes, and the threads left open. Plain prose, past tense, no headings. Spoilers for THIS issue are fine; nothing from later issues.`;

// Searches aim at the full plot, ending included (user 2026-10-19): solicits and short
// reviews only give the set-up, which sent most recent issues on to page reading.
const SEARCH_RULES = `Search for a FULL PLOT SUMMARY that includes how the issue ends. Put words such as "plot summary", "spoilers", "recap" or "ending" in your searches, with the series, volume year and issue number.
Good sources: fan wikis with a full synopsis (DC Database, Marvel Database and other fandom wikis) and spoiler reviews or recaps that walk through the plot.
Skip solicitations and previews (the publisher's blurb written before release, as on dc.com, marvel.com, dcuguide, Previews or most shop listings): they only describe the set-up.
Search results show only excerpts. Once you have found the most promising page about this issue (a wiki entry or a scene-by-scene spoiler review of this issue), open it with web_fetch and write from its full text. If that page is vague (it does not say who did what), open a better one: you may open two.`;

const CONFIDENCE_RULES = i => `confidence "high" only when your source walks through this exact issue's plot and says who did what in each major scene (main story and any backup); a review that stays vague ("one of them", "the man", "the backup also ends") is "medium" at most. covers_ending: true only when it says how the issue ends. source_is_this_issue: true only when the page is about this single issue (a wiki page or review of #${i.number}), not a series overview, a list or another issue.`;

const webPrompt = i => `Find what happens in this comic issue and write a short synopsis.

Issue: ${i.series}${i.year ? ` (${i.year})` : ''} #${i.number}${i.title ? `, titled "${i.title}"` : ''}${i.date ? `, cover date ${i.date}` : ''}${i.writer ? `, written by ${i.writer}` : ''}.

${SEARCH_RULES}
Make sure it is this series, volume and issue number, not another volume or a reprint.
${WRITE_RULES}
If you cannot find a source that covers this issue's story, set found to false and synopsis to null. Never invent events.
${CONFIDENCE_RULES(i)}
Reply with only JSON: {"found": true, "synopsis": "…", "source_url": "https://…", "confidence": "high", "covers_ending": true, "source_is_this_issue": true}`;

// Recap lookup step 2 (2026-10-20): the Summary Writer writes from the pages Web Search found,
// which Omnibus downloaded (any model can do this; no tools).
const issueLine = i => `${i.series}${i.year ? ` (${i.year})` : ''} #${i.number}${i.title ? `, titled "${i.title}"` : ''}${i.date ? `, cover date ${i.date}` : ''}${i.writer ? `, written by ${i.writer}` : ''}`;
// backed: the search notes Google's sources back sentence by sentence (Gemini grounding supports).
// They count as a source, like the pages (2026-10-20: Google's own answers combine many sources;
// reading only two pages threw most of that away).
const writerPrompt = (i, notes, pages, backed = false) => `Write a short synopsis of this comic issue from the search notes and web pages below.

Issue: ${issueLine(i)}.

${WRITE_RULES}
Use only what the ${backed ? 'notes and pages' : 'pages'} say about this exact issue: check the series, volume and issue number, and ignore other issues, reprints, solicitations and previews. If they do not cover this issue's story, set found to false and synopsis to null. Never invent events.
${CONFIDENCE_RULES(i)}${backed ? '\nJudge the notes and the pages together as your source: "high" when together they say who did what in each major scene and how the issue ends; covers_ending when either says how it ends (a teaser such as "heads to the infirmary" is not an ending).' : ''}
source_url: the address of the page you relied on most, exactly as given below.

${backed ? `SEARCH NOTES (each sentence is backed by a search result about this issue; a source like the pages):\n${notes}` : `SEARCH NOTES (a summary of the search results; may be incomplete or wrong; use them only where a page below agrees):\n${notes || '(none)'}`}

${pages.map((p, k) => `PAGE ${k + 1}: ${p.url}\n${p.text}`).join('\n\n')}

Reply with only JSON: {"found": true, "synopsis": "…", "source_url": "https://…", "confidence": "high", "covers_ending": true, "source_is_this_issue": true}`;
const issueQuestion = i => `${i.series}${i.year ? ` (${i.year} series)` : ''} #${i.number}${i.title ? ` ("${i.title}")` : ''}${i.date ? `, cover date ${i.date}` : ''}`;
// Pages most likely to walk through this exact issue first: a wiki or recap page for it, then pages
// whose address carries the issue number, then reviews.
const pageScore = (url, i) => {
  const u = String(url || ''), n = String(i.number || '').replace(/^0+(?=\d)/, '');
  return (isIssuePage(u) ? 4 : 0) + (/fandom\.com|wiki/i.test(u) ? 2 : 0) + (n && new RegExp(`(^|[^0-9])0*${n.replace(/[^0-9a-z]/gi, '')}([^0-9]|$)`, 'i').test(u.replace(/^https?:\/\/[^/]+/, '')) ? 2 : 0) + (/review|recap|spoiler|summary/i.test(u) ? 1 : 0);
};
// A wiki or recap page for one issue (DC/Marvel Database "…_Vol_6_34", TV Tropes "Recap/…"): with the
// ending covered, a medium rating from one is trusted (2026-10-20: Superman #34, Absolute Green Lantern #13).
const isIssuePage = url => /fandom\.com\/wiki\/[^?#]*_\d+[a-z]?\/?$/i.test(String(url || '')) || /tvtropes\.org\/pmwiki\/pmwiki\.php\/Recap\//i.test(String(url || ''));

const pagesPrompt = (i, n, total) => `These are ${n === total ? 'the' : `the first ${n} of ${total}`} pages of ${i.series}${i.year ? ` (${i.year})` : ''} #${i.number}${i.title ? `, "${i.title}"` : ''}${i.date ? `, cover date ${i.date}` : ''}, in order.

Read every page: art, captions, dialogue and sound effects. Skip covers, ads, letters pages, pin-ups and previews. Some scans have a page mirrored or out of order.

Step 1 (beats): list what happens, scene by scene, with page numbers. One short line each: who does what to whom. Mark flashbacks as "(flashback)". Up to 15 beats.

Step 2 (synopsis): from your beats, write 80–150 words for a reader who finished this issue and wants to remember it. Plain prose, past tense, no headings.
- Be specific: name characters, say what they did, who was hurt or killed, and how the issue ends. Avoid mood words in place of events.
- Use names only as the lettering gives them. If someone is never named, describe them ("a young man outside a nightclub"). Do not name characters from memory.
- Only what these pages show. Even if you know this story, do not add events from other issues.
- If you cannot tell who did something, say less rather than guess.

If the pages cannot be read, set found to false.
Reply with only JSON: {"found": true, "beats": [{"pages": "3-4", "what": "…"}], "synopsis": "…", "confidence": "high"}`;

const parseJson = text => {
  const s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
};

function createSynopses({ db, ai, logger, getPageImage, modelCatalog, axios = null, webLookup = null, readPage = require('../ai/pageReader').readPage, now = () => Date.now() }) {
  // Two-step recap lookups need Web Search and a way to download pages; without them the Summary
  // Writer searches itself (the one-step lookup used before 2026-10-20).
  const finder = webLookup || (axios ? require('../ai/webLookup').createWebLookup({ ai, modelCatalog, logger }) : null);
  db.exec(`CREATE TABLE IF NOT EXISTS issue_synopses (
    issue_key TEXT PRIMARY KEY,            -- Comic Vine issue id, else "book:<id>"
    book_id TEXT,
    status TEXT NOT NULL,                  -- ok | missing
    synopsis TEXT,
    source TEXT,                           -- comicinfo | web | pages
    source_url TEXT,
    model TEXT,
    confidence TEXT,
    notes TEXT,                            -- page reading: the scene list (JSON), for checking errors
    est_cost REAL DEFAULT 0,
    created_at INTEGER NOT NULL,
    retry_after INTEGER
  )`);

  const bookRow = db.prepare(`SELECT sb.id, sb.issue_number, sb.comicinfo, sb.cv_issue_id, ss.name AS series_name, ss.year AS series_year
    FROM scanned_books sb JOIN scanned_series ss ON ss.id = sb.series_id WHERE sb.id = ?`);
  const getRow = db.prepare('SELECT * FROM issue_synopses WHERE issue_key = ?');
  const putRow = db.prepare(`INSERT INTO issue_synopses (issue_key, book_id, status, synopsis, source, source_url, model, confidence, notes, est_cost, created_at, retry_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(issue_key) DO UPDATE SET book_id = excluded.book_id, status = excluded.status, synopsis = excluded.synopsis, source = excluded.source,
      source_url = excluded.source_url, model = excluded.model, confidence = excluded.confidence, notes = excluded.notes,
      est_cost = issue_synopses.est_cost + excluded.est_cost, created_at = excluded.created_at, retry_after = excluded.retry_after`);

  const keyOf = b => (b.cv_issue_id ? String(b.cv_issue_id) : `book:${b.id}`);
  const cents = (model, u, searches = 0) => {
    const p = (modelCatalog && modelCatalog.price(model)) || { in: 0, out: 0 };
    const tok = ((u.input_tokens || 0) * p.in + (u.cache_read_input_tokens || 0) * p.in * 0.1 + (u.output_tokens || 0) * p.out) / 1e6;
    const fee = modelCatalog && modelCatalog.searchFee ? modelCatalog.searchFee(model) : SEARCH_FEE;   // Gemini's searches are free up to 5,000 a month
    return Math.round((tok + searches * fee) * 10000) / 10000;
  };

  // What is stored for a book (no lookups). null = nothing yet or a missing mark that may be retried.
  function stored(bookId) {
    const b = bookRow.get(String(bookId));
    if (!b) return null;
    const r = getRow.get(keyOf(b));
    if (!r) return null;
    if (r.status === 'missing' && (r.retry_after || 0) <= now()) return null;
    return r;
  }

  // Free sources only: stored, then a ComicInfo synopsis (stored on first use).
  function free(bookId) {
    const b = bookRow.get(String(bookId));
    if (!b) return null;
    const r = stored(b.id);
    if (r) return r;
    const s = comicInfoSynopsis(b.comicinfo);
    if (!s) return null;
    putRow.run(keyOf(b), b.id, 'ok', s, 'comicinfo', null, null, null, null, 0, now(), null);
    return getRow.get(keyOf(b));
  }

  // Recap lookup (2026-10-20, docs/AI_MODELS.md "Lookups"):
  //   1. Web Search finds pages about the issue (a plain question; it must actually search).
  //   2. Omnibus downloads the best one or two of them.
  //   3. The Summary Writer writes the synopsis from those pages and rates it.
  // When Web Search did not search (after one retry) or nothing it found could be read, nothing is
  // found: the issue goes to the Page Reader (trimmed 2026-10-21: the Summary Writer searching itself
  // fired once in 14 tests). Without Web Search (no page downloads configured, e.g. tests) the
  // Summary Writer searches itself (viaWebDirect).
  async function viaWeb(issue, signal) {
    if (!finder || !axios) return viaWebDirect(issue, signal);
    const steps = { finder: null, read: [], failed: [], fallback: null };
    let found = null, cost = 0;
    const ask = detail => finder.lookup(issueQuestion(issue), { detail, blockedDomains: BLOCKED_DOMAINS, source: 'recap', signal });
    try {
      found = await ask('full');
      // Answered without searching: ask once more, plainly (cheap with Gemini).
      if (!found.grounded) { cost += found.cost; steps.retried = true; found = await ask('retry'); }
    } catch (e) { if (signal?.aborted) throw e; steps.fallback = `web search failed: ${e.message}`; }
    if (found) { cost += found.cost; steps.finder = { model: found.model, queries: found.queries, grounded: found.grounded, sources: found.sources.length }; }
    const pages = [];
    if (found && found.grounded) {
      const ranked = found.sources.map(x => x.url).sort((a, b) => pageScore(b, issue) - pageScore(a, issue));
      for (const url of ranked.slice(0, 6)) {
        if (pages.length >= 3) break;
        try {
          const pg = await readPage(url, { axios, maxChars: 40000, timeout: 15000 });
          if (String(pg.text || '').length >= 800) pages.push(pg); else steps.failed.push({ url, error: 'too little text' });
        } catch (e) { steps.failed.push({ url, error: e.message }); }
      }
      steps.read = pages.map(pg => pg.url);
    } else if (found && !steps.fallback) steps.fallback = 'web search answered without searching';
    // Backed notes alone are enough to write from when no page could be downloaded.
    if (!pages.length && !(found && found.grounded && found.backed)) {
      if (!steps.fallback) steps.fallback = 'none of the pages found could be read';
      logger?.info?.('recaps', `Web lookup found nothing usable: ${issue.series} #${issue.number}`, { reason: steps.fallback, finder: steps.finder?.model });
      return { found: false, synopsis: null, source_url: null, confidence: null, covers_ending: false, this_issue: false, queries: found ? found.queries : [], fetched: [],
        sources: found ? found.sources.map(x => x.url) : [], grounded: !!(found && found.grounded), model: null, finder_model: found ? found.model : null, steps, cost };
    }
    const r = await ai.complete({ task: 'recap_web', prompt: writerPrompt(issue, found.backed || found.notes, pages, !!found.backed),
      maxTokens: 6000, outputSchema: SCHEMA, schemaInWords: true, timeout: 120000, source: 'recap', signal });   // room for thinking (largest seen 2,733 of 3,000)
    cost += cents(r.model, r.usage || {}, 0);
    const out = parseJson(r.text) || {};
    const norm = x => String(x || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
    const sourceUrl = (pages.find(pg => norm(pg.url) === norm(out.source_url)) || pages[0] || { url: found.sources.find(x => isWiki(x.url))?.url || found.sources[0]?.url || null }).url;
    return { found: !!(out.found && out.synopsis), synopsis: out.synopsis || null, source_url: sourceUrl, confidence: out.confidence || null,
      covers_ending: out.covers_ending === true, this_issue: out.source_is_this_issue === true, queries: found.queries, fetched: steps.read,
      sources: found.sources.map(x => x.url), grounded: true, model: r.model, finder_model: found.model, steps, cost };
  }

  // One step (before 2026-10-20; now only when page downloads are not configured): the Summary Writer
  // searches and reads pages itself.
  async function viaWebDirect(issue, signal, model) {
    // Up to 2 searches, then up to 2 pages read in full (2026-10-19): excerpts missed key events.
    const r = await ai.complete({ task: 'recap_web', ...(model ? { model } : {}), prompt: webPrompt(issue), maxTokens: 4000, webSearch: 2, webFetch: 2, webFetchTokens: 15000, blockedDomains: BLOCKED_DOMAINS, outputSchema: SCHEMA, schemaInWords: true, timeout: 180000, source: 'recap', signal });
    const u = r.usage || {}, searches = u.server_tool_use?.web_search_requests || 0;
    const out = parseJson(r.text) || {};
    const content = Array.isArray(r.data?.content) ? r.data.content : [];
    const used = content.filter(c => c.type === 'server_tool_use' || (c.type === 'tool_use' && c.name === 'read_page'));
    const queries = used.filter(c => c.input?.query).map(c => String(c.input.query));
    const fetched = used.filter(c => c.input?.url).map(c => String(c.input.url));
    const sources = content.filter(c => c.type === 'web_search_tool_result' && Array.isArray(c.content)).flatMap(c => c.content).map(x => x && x.url).filter(Boolean);
    let confidence = out.confidence || null, sourceUrl = out.source_url || null, grounded = true;
    if (/^gemini:/.test(String(r.model || ''))) {
      // Gemini (2026-10-20): trust only what it found by searching. No search → not trusted. Its
      // source_url may be made up, so use a page it actually found (a wiki page first).
      grounded = queries.length > 0 || sources.length > 0;
      if (!grounded && confidence === 'high') confidence = 'medium';
      const norm = x => String(x || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
      if (!sources.some(x => norm(x) === norm(sourceUrl))) sourceUrl = sources.find(isWiki) || sources[0] || null;
    }
    return { found: !!(out.found && out.synopsis), synopsis: out.synopsis || null, source_url: sourceUrl, confidence,
      covers_ending: out.covers_ending === true, this_issue: out.source_is_this_issue === true, queries, fetched, sources, grounded, model: r.model, cost: cents(r.model, u, searches) };
  }

  async function viaPages(issue, signal) {
    const size = { height: PAGE_HEIGHT };
    const first = await getPageImage(issue.book_id, 0, size);
    const total = first.count || 1, n = Math.min(total, MAX_PAGES);
    const content = [{ type: 'image', source: { type: 'base64', media_type: first.media_type, data: first.data } }];
    for (let k = 1; k < n; k++) {
      if (signal?.aborted) throw new Error('Stopped');
      const img = await getPageImage(issue.book_id, k, size);
      content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
    }
    content.push({ type: 'text', text: pagesPrompt(issue, n, total) });
    const r = await ai.complete({ task: 'recap_reader', messages: [{ role: 'user', content }], maxTokens: 8000, outputSchema: PAGES_SCHEMA, geminiThinking: 'medium', timeout: 300000, source: 'recap', signal });
    const out = parseJson(r.text) || {};
    return { found: !!(out.found && out.synopsis), synopsis: out.synopsis || null, beats: Array.isArray(out.beats) ? out.beats : null, confidence: out.confidence || null, model: r.model, cost: cents(r.model, r.usage || {}) };
  }

  // Get or make one book's synopsis. allowPages: may fall back to reading pages.
  // Returns the stored row plus { spent } (dollars spent now). One lookup per key at a time.
  // A web synopsis worth checking against the pages (user 2026-10-19): one from a review
  // or other non-wiki page, or not marked high confidence. Reviews often skip how things
  // end. Tried once per issue, and only for the last few issues of a recap.
  const isWiki = url => /fandom\.com|wiki/i.test(String(url || ''));
  // Trusted without reading the pages: high confidence only, from a wiki or a source that covers
  // the ending. Trusting medium results was tried and undone (2026-10-19): 4 of 6 trusted synopses
  // missed key events (Detective #1058, #1059; 100 Bullets #45, #47) next to their page-read versions.
  const trustedWeb = r => {
    const n = (() => { try { return JSON.parse(r.notes || '{}'); } catch { return {}; } })();
    if (r.confidence === 'high') return isWiki(r.source_url) || n.covers_ending === true;
    // Medium from a wiki or recap page for this exact issue that covers the ending (2026-10-20):
    // the medium results that missed key events all came from reviews.
    return r.confidence === 'medium' && n.covers_ending === true && n.this_issue === true && isIssuePage(r.source_url);
  };
  // Imported summaries (recaps/importSummaries.js) are trusted, except "partial" ones, whose
  // unreadable pages leave gaps: those are read from the pages once if a recap needs them.
  const partialImport = r => r.source === 'import' && (() => { try { return JSON.parse(r.notes || '{}').import?.status === 'partial'; } catch { return false; } })();
  const wantsPages = r => !!r && r.status === 'ok' && (r.source === 'web' || partialImport(r)) && !/"pages_tried"/.test(r.notes || '') && (r.source === 'import' || !trustedWeb(r));
  const markTried = db.prepare('UPDATE issue_synopses SET notes = ?, est_cost = est_cost + ? WHERE issue_key = ?');

  async function upgradeFromPages(b, row, signal) {
    const issue = describe(b), key = keyOf(b);
    try {
      const p = await viaPages(issue, signal);
      if (p.found) {
        putRow.run(key, b.id, 'ok', p.synopsis, 'pages', null, p.model, p.confidence,
          JSON.stringify({ beats: p.beats, replaced_web: row.source_url, pages_tried: true }), p.cost, now(), null);
        logger?.info?.('recaps', `Synopsis checked against the pages: ${issue.series} #${issue.number}`, { model: p.model, cost: p.cost, was: row.source_url });
        return { ...getRow.get(key), spent: p.cost };
      }
      markTried.run(JSON.stringify({ ...(() => { try { return JSON.parse(row.notes || '{}'); } catch { return {}; } })(), pages_tried: true }), p.cost, key);
      return { ...getRow.get(key), spent: p.cost };
    } catch (e) {
      if (signal?.aborted) throw e;
      logger?.warn?.('recaps', `Page check failed: ${issue.series} #${issue.number}`, { error: e.message });
      markTried.run(JSON.stringify({ ...(() => { try { return JSON.parse(row.notes || '{}'); } catch { return {}; } })(), pages_tried: true }), 0, key);
      return { ...getRow.get(key), spent: 0 };
    }
  }

  const inFlight = new Map();
  async function ensure(bookId, { allowPages = true, force = false, signal } = {}) {
    const b = bookRow.get(String(bookId));
    if (!b) throw new Error('Book not found');
    const key = keyOf(b);
    if (!force) {
      const f = free(b.id);
      if (f && !(allowPages && getPageImage && wantsPages(f))) return { ...f, spent: 0 };
      if (f) {
        if (inFlight.has(key)) return inFlight.get(key);
        const up = upgradeFromPages(b, f, signal);
        inFlight.set(key, up);
        try { return await up; } finally { inFlight.delete(key); }
      }
    }
    if (inFlight.has(key)) return inFlight.get(key);
    const job = (async () => {
      const issue = describe(b);
      let spent = 0;
      try {
        const w = await viaWeb(issue, signal);
        spent += w.cost;
        if (w.found) {
          putRow.run(key, b.id, 'ok', w.synopsis, 'web', w.source_url, w.model, w.confidence, JSON.stringify({ covers_ending: w.covers_ending, this_issue: w.this_issue, queries: w.queries, fetched: w.fetched, finder: w.finder_model || undefined, fallback: w.steps?.fallback || undefined }), w.cost, now(), null);
          logger?.info?.('recaps', `Synopsis from the web: ${issue.series} #${issue.number}`, { model: w.model, finder: w.finder_model, fallback: w.steps?.fallback, cost: w.cost, source: w.source_url, confidence: w.confidence, ending: w.covers_ending, queries: w.queries, fetched: w.fetched });
          const row = getRow.get(key);
          if (allowPages && getPageImage && wantsPages(row)) { const u = await upgradeFromPages(b, row, signal); return { ...u, spent: spent + u.spent }; }
          return { ...row, spent };
        }
      } catch (e) {
        if (signal?.aborted) throw e;
        logger?.warn?.('recaps', `Web synopsis failed: ${issue.series} #${issue.number}`, { error: e.message });
      }
      if (allowPages && getPageImage) {
        try {
          const p = await viaPages(issue, signal);
          spent += p.cost;
          if (p.found) {
            putRow.run(key, b.id, 'ok', p.synopsis, 'pages', null, p.model, p.confidence, p.beats ? JSON.stringify(p.beats) : null, spent, now(), null);
            logger?.info?.('recaps', `Synopsis from the pages: ${issue.series} #${issue.number}`, { model: p.model, cost: p.cost });
            return { ...getRow.get(key), spent };
          }
        } catch (e) {
          if (signal?.aborted) throw e;
          logger?.warn?.('recaps', `Page synopsis failed: ${issue.series} #${issue.number}`, { error: e.message });
        }
      }
      logger?.info?.('recaps', `No synopsis found: ${issue.series} #${issue.number}`, { cost: spent, pages: !!allowPages });
      // Missing: tried again after 30 days (or sooner when pages were not allowed).
      const retry = now() + (allowPages ? RETRY_MISSING_DAYS : 1) * 864e5;
      putRow.run(key, b.id, 'missing', null, null, null, null, null, null, spent, now(), retry);
      return { ...getRow.get(key), spent };
    })();
    inFlight.set(key, job);
    try { return await job; } finally { inFlight.delete(key); }
  }

  const forget = bookId => { const b = bookRow.get(String(bookId)); if (b) db.prepare('DELETE FROM issue_synopses WHERE issue_key = ?').run(keyOf(b)); };

  // Admin trial: the web step alone, nothing stored (compare search wording on issues already read from pages).
  async function tryWeb(bookId) {
    const b = bookRow.get(String(bookId));
    if (!b) throw new Error('Book not found');
    const issue = describe(b);
    const w = await viaWeb(issue);
    const row = { status: 'ok', source: 'web', source_url: w.source_url, confidence: w.confidence, notes: JSON.stringify({ covers_ending: w.covers_ending, this_issue: w.this_issue }) };
    const st = stored(b.id);
    logger?.info?.('recaps', `Web test: ${issue.series} #${issue.number}`, { confidence: w.confidence, ending: w.covers_ending, this_issue: w.this_issue, fetched: w.fetched, page_check: !w.found || wantsPages(row), source: w.source_url, queries: w.queries,
      web: String(w.synopsis || '').slice(0, 1500), stored: st ? `${st.source}: ${String(st.synopsis || '').slice(0, 1500)}` : null });
    return { ...w, would_page_check: !w.found || wantsPages(row), stored: stored(b.id) ? { source: stored(b.id).source, synopsis: stored(b.id).synopsis } : null };
  }

  // Cents per lookup / page read for the recap estimate, by the models in use (lookup comparison
  // 2026-10-20: Gemini lookup ~0.4¢ and page read ~3.7¢; Haiku search ~2.3¢, Sol page read ~7.4¢; two-step arc stretch ~0.4¢).
  const costs = () => {
    const gem = task => { try { return /^gemini:/.test(String((ai.choose ? ai.choose(task) : '') || '')); } catch { return false; } };
    return { web: gem('web_lookup') ? 0.5 : 2.3, pages: gem('recap_reader') ? 4 : 7.4, stretch: gem('web_lookup') ? 0.5 : 1.3 };
  };

  return { describe, comicInfoSynopsis, stored, free, ensure, forget, keyOf, wantsPages, tryWeb, costs, webPrompt, pagesPrompt, PAGE_HEIGHT };
}

module.exports = { createSynopses, describe, comicInfoSynopsis, webPrompt, pagesPrompt, SCHEMA, PAGES_SCHEMA, SEARCH_RULES, BLOCKED_DOMAINS };
