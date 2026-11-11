'use strict';
// ─── Top Shelf run generation (Top Shelf: + New run › Generate) ─────────────
// Moved out of server.js unchanged (2026-11-10, server.js split): the run generator's reply
// schema, prompt and POST /api/canon/generate, with its post-generation enrichment. The
// Comic Vine resolution helpers it uses stay in server.js (canonResolve and others).
module.exports.registerCanonGenerator = function registerCanonGenerator(deps) {
  const missing = ['ai', 'aiInfo', 'aiRunStep', 'app', 'db', 'filterRunsByCategory', 'forGptPrompt', 'getAnthropicKey', 'logger', 'modelCatalog', 'requireAdmin', 'setAiJobOutcome'].filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`registerCanonGenerator: missing ${missing.join(', ')}`);
  const { ai, aiInfo, aiRunStep, app, db, filterRunsByCategory, forGptPrompt, getAnthropicKey, logger, modelCatalog, requireAdmin, setAiJobOutcome } = deps;

// ─── Canon: AI generation ─────────────────────────────────────────
// POST /api/canon/generate
// The run generator's reply (prompt v2, structured outputs).
const RUN_LIST_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['runs'],
  properties: { runs: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['title', 'parent_series', 'issue_range_hint', 'description', 'creators', 'categories', 'adaptation_notes', 'award_notes', 'is_crossover'],
    properties: {
      title: { type: 'string' }, parent_series: { type: ['string', 'null'] }, issue_range_hint: { type: 'string' }, description: { type: 'string' },
      creators: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'role'],
        properties: { name: { type: 'string' }, role: { type: 'string', enum: ['writer', 'penciler', 'inker', 'artist', 'colorist', 'letterer'] } } } },
      categories: { type: 'array', items: { type: 'string', enum: ['adapted_to_screen', 'award_winning', 'critically_acclaimed'] } },
      adaptation_notes: { type: ['string', 'null'] }, award_notes: { type: ['string', 'null'] }, is_crossover: { type: 'boolean' },
    } } } },
};
// ── Verified awards for the run generator (2026-10-25) ───────────────
// The generator used to confirm every award on the web, one work at a time, within 6 searches: Marvel
// "award winning" requests read 80–170k tokens (53–95¢) and still missed winners. The app already holds
// the verified winners (award_data rows with a source). This gives the ones for the request's scope as a
// compact list, so the model takes awards from it and spends its searches on adaptations and ranges.
// Work awards only (creator awards are not the comic's own); reprint/collection categories are left out.
const PUBLISHER_FAMILIES = {
  dc: ['dc', 'vertigo', 'dc black label', 'black label', 'wildstorm', 'abc', 'america s best', 'milestone', 'paradox', 'helix', 'minx', 'young animal'],
  marvel: ['marvel', 'icon', 'epic', 'max', 'marvel knights', 'marvel max'],
  image: ['image', 'skybound', 'top cow', 'shadowline'],
  'dark horse': ['dark horse', 'legend'],
};
function verifiedAwardsFor(scopeType, scopeValue, limit = 150) {
  const norm = x => String(x || '').toLowerCase().replace(/&/g, ' and ').replace(/\bcomics?\b|\bpublishing\b|\bentertainment\b|\binc\b|[^a-z0-9/ ]/g, ' ').replace(/\s+/g, ' ').trim();
  const want = norm(scopeValue);
  if (!want) return null;
  let rows;
  try {
    rows = db.prepare(`SELECT award, year, category, series_name, publisher FROM award_data
      WHERE winner = 1 AND source IS NOT NULL AND COALESCE(kind, 'work') = 'work' ORDER BY series_name COLLATE NOCASE, year`).all();
  } catch { return null; }
  rows = rows.filter(r => !/reprint|archiv|previously published|collected|edition|omnibus|international material/i.test(r.category || ''));
  let pick;
  if (scopeType === 'character') {
    const words = want.split(' ').filter(w => w.length > 2);
    const has = t => { const n = ` ${norm(t)} `; return words.length && words.every(w => n.includes(` ${w}`)); };
    pick = rows.filter(r => has(r.series_name));
  } else {
    const fam = PUBLISHER_FAMILIES[want] || (Object.entries(PUBLISHER_FAMILIES).find(([k]) => want.startsWith(k + ' ') || want === k) || [null, [want]])[1];
    const hit = p => norm(p).split('/').map(x => x.trim()).some(x => fam.some(f => x === f || x.startsWith(f + ' ')));
    pick = rows.filter(r => r.publisher && hit(r.publisher));
  }
  if (!pick.length) return null;
  const AWARD = { eisner: 'Eisner', harvey: 'Harvey', hugo: 'Hugo', kirby: 'Kirby', stoker: 'Stoker' };
  const byWork = new Map();
  for (const r of pick) {
    const k = r.series_name.trim();
    if (!byWork.has(k)) byWork.set(k, []);
    const a = `${AWARD[r.award] || r.award}, ${r.category} (${r.year})`;
    if (!byWork.get(k).includes(a)) byWork.get(k).push(a);
  }
  const lines = [...byWork].slice(0, limit).map(([w, a]) => `- ${w}: ${a.join(' · ')}`);
  return { count: byWork.size, text: lines.join('\n') };
}

app.post('/api/canon/generate', requireAdmin, aiRunStep(req => `Top Shelf: ${req.body?.scope_value || '?'}`), async (req, res) => {
  const { scope_type, scope_value, scope_refine_type, scope_refine_value, categories } = req.body || {};
  // Category filter (user 2026-10-18): match 'all' = every listed category required; exclude = categories a run must NOT have.
  const catMatch   = req.body?.match === 'all' ? 'all' : 'any';
  const catExclude = Array.isArray(req.body?.exclude) ? req.body.exclude.filter(c => !(categories || []).includes(c)) : [];
  if (!scope_value?.trim()) return res.status(400).json({ error: 'scope_value required' });
  if (!categories?.length)  return res.status(400).json({ error: 'At least one category required' });

  const key = getAnthropicKey();
  if (!key) return res.status(400).json({ error: 'No Anthropic API key configured' });

  const categoryLabels = {
    adapted_to_screen:    'Adapted to Screen — the comic was later adapted into a film, TV show, or animated production',
    award_winning:        'Award Winning — won an Eisner, Harvey, Hugo, or other major comics industry award',
    critically_acclaimed: 'Critically Acclaimed — widely regarded by critics and fans as a landmark or essential work',
  };

  // ── Era date ranges ───────────────────────────────────────────────
  const ERA_RANGES = {
    'Golden Age':    '1938–1956',
    'Silver Age':    '1956–1970',
    'Bronze Age':    '1970–1985',
    'Modern Age':    '1985–2010',
    'Contemporary':  '2010–present',
  };

  // ── Story type descriptions ───────────────────────────────────────
  const STORY_TYPE_DESCS = {
    'Elseworlds':       'Elseworlds or alternate universe stories (non-canon "What If" tales)',
    'Graphic Novels':   'standalone prestige format graphic novels and one-shots',
    'Limited Series':   'limited series (finite runs of 2–12 issues with a defined beginning and end)',
    'Annuals':          'annual specials and holiday one-shots',
    'Team-Up':          'stories featuring team-ups or significant guest appearances',
  };

  const catDesc = categories.map(c => `- ${categoryLabels[c] || c}`).join('\n');

  // ── Build scope description ───────────────────────────────────────
  let scopeDesc = scope_type === 'character'
    ? `comic works featuring ${scope_value} as a primary character`
    : scope_type === 'imprint'
    ? `comic works published under the ${scope_value} imprint`
    : `comic works published by ${scope_value}`;

  // Apply refinement to scope description
  let refinementNote = '';
  if (scope_refine_type && scope_refine_value) {
    if (scope_refine_type === 'era') {
      const dateRange = ERA_RANGES[scope_refine_value] || scope_refine_value;
      scopeDesc += ` published during the ${scope_refine_value} (approximately ${dateRange})`;
      refinementNote = `ERA SCOPE: Limit results strictly to works published during the ${scope_refine_value} (${dateRange}). Do not include works from other eras even if they are significant.`;
    } else if (scope_refine_type === 'creator') {
      scopeDesc += ` written or created by ${scope_refine_value}`;
      refinementNote = `CREATOR SCOPE: Only include works where ${scope_refine_value} was the primary writer or creator. Do not include works where they had a minor role.`;
    } else if (scope_refine_type === 'story_type') {
      const typeDesc = STORY_TYPE_DESCS[scope_refine_value] || scope_refine_value;
      scopeDesc += ` that are ${typeDesc}`;
      refinementNote = `STORY TYPE SCOPE: Only include ${typeDesc}. Do not include standard ongoing series runs.`;
    } else if (scope_refine_type === 'series') {
      scopeDesc += ` published in the series "${scope_refine_value}"`;
      refinementNote = `SERIES SCOPE: Only include works published within the series "${scope_refine_value}". Include individual story arcs within that series, not the entire run as one entry.`;
    }
  }

  // ── Series note for character scopes ─────────────────────────────
  const seriesNote = scope_type === 'character' && !scope_refine_type
    ? `IMPORTANT: Include runs across ALL series where ${scope_value} is the primary focus — not just the main title. For example, Batman runs appear in Detective Comics, Batman and Robin, Shadow of the Bat, Legends of the Dark Knight, Gotham Knights, Batman: The Dark Knight, and many others. Do not limit yourself to the primary ongoing series.`
    : scope_type === 'character' && scope_refine_type === 'era'
    ? `IMPORTANT: Include runs across ALL series where ${scope_value} appeared during this era — check all titles from that period, not just the main series.`
    : '';

  // ── Existing works exclusion list ────────────────────────────────
  // For character scopes: filter by character name in title/series/creator
  // For publisher/imprint scopes: use ALL existing approved/pending runs (can't filter by publisher)
  let exclusionList = '';
  try {
    let existing = [];

    // Every run on Top Shelf, rejected ones too, whatever the scope (2026-10-17). The old per-scope
    // filter matched only titles/series containing the name (31 of the Batman runs) and capped the
    // list at 120–200 titles; all 151 titles are about 1,000 tokens.
    existing = db.prepare('SELECT title, parent_series, status FROM canon_runs ORDER BY title ASC').all();

    if (existing.length > 0) {
      // Compact (titles only). Blocked runs (status 'rejected', user 2026-10-18) are listed apart:
      // the reader chose never to see them; deleted runs are not listed at all.
      const list = rows => [...new Set(rows.map(r => r.title))].map(t => `"${t}"`).join(', ');
      const shelf = existing.filter(r => r.status !== 'rejected'), blocked = existing.filter(r => r.status === 'rejected');
      exclusionList = (shelf.length ? `\n⛔ ALREADY IN DATABASE — DO NOT INCLUDE ANY OF THESE ${shelf.length} WORKS:\n${list(shelf)}\n` : '')
        + (blocked.length ? `\n⛔ BLOCKED BY THE READER — NEVER SUGGEST THESE ${blocked.length} WORKS:\n${list(blocked)}\n` : '')
        + `\nDo not generate any entry that matches a title above. If this scope is well-covered, surface lesser-known but genuinely qualifying works that were missed, or return an empty list.`;
    }
  } catch (e) {
    logger.warn('canon', 'Failed to build exclusion list', e.message);
  }


  // ── Run generator prompt v2 (2026-10-17; claude/ADMIN_REORG.md "Run generator improvements") ──
  // Written for current models: checks awards, adaptations and issue ranges on the web instead of
  // relying on memory, Comic Vine-style volumes and every piece of a split range, structured reply.
  // The original prompt and its Settings switch (topshelf_generator_classic) were retired on 2026-10-26.
  const verifiedAwards = verifiedAwardsFor(scope_type, scope_value);
  const verifiedAwardsBlock = verifiedAwards ? `
VERIFIED AWARDS — the app's own records of awards won by ${scope_type === 'character' ? `works about ${scope_value}` : `${scope_value} works`} (${verifiedAwards.count} works, each checked against the award body's own list):
${verifiedAwards.text}
- A work on this list won those awards: tag it award_winning and copy them into award_notes. Do not search to confirm them.
- An entry may be a single issue or story ("Hawkeye #11", "Amazing Spider-Man #30-35 (Coming Home)"). The run or arc that contains it counts as award winning, naming that award.
- Not on the list: tag award_winning only for an award the list does not cover that you can confirm; otherwise leave the category out.
` : '';
  const shortLabel = c => ({ adapted_to_screen: 'adapted to screen', award_winning: 'award winning', critically_acclaimed: 'critically acclaimed' }[c] || c);
  const catFilterNote = [
    catMatch === 'all' && categories.length > 1 ? `A run qualifies only if it meets ALL of these categories, not just one.` : '',
    catExclude.length ? `Leave out any run that is ${catExclude.map(shortLabel).join(' or ')}: the reader is looking for works WITHOUT ${catExclude.length > 1 ? 'those' : 'that'}. Check it like the other categories; the app drops runs tagged with it.` : '',
  ].filter(Boolean).join('\n');
  const promptV2 = `You are a comics curator building a "Top Shelf" list for a personal comic library app: significant ${scopeDesc} that qualify for ${catMatch === 'all' && categories.length > 1 ? 'ALL' : 'one or more'} of these categories:
${catDesc}${catFilterNote ? '\n' + catFilterNote : ''}
${exclusionList}${verifiedAwardsBlock}
Each run you list is looked up on Comic Vine by its parent series, issue range and volume year and matched to the reader's files, and its awards and adaptations are shown to the reader as facts. A wrong award, adaptation or issue range is a real error; leaving out a doubtful entry is not.

RESEARCH (web search and web fetch are limited: about 6 searches and 3 page reads, so spend them on what you are unsure of)
- Draw up candidates from what you know first. Search to confirm what you are not sure of (an adaptation, an award, a volume), and read a page only when the search results do not settle it. Where to check:
  - Issue range and volume: Comic Vine (comicvine.gamespot.com), Comic Book Herald (comicbookherald.com) or League of Comic Geeks.
  - Awards: ${verifiedAwards ? 'take them from the VERIFIED AWARDS list below and do not search for them; search only for an award the list does not cover (it holds Eisner, Harvey, Hugo, Kirby and Stoker winners).' : "the award's own records (Eisner Awards history at comic-con.org, the Harvey Awards, the Hugo Awards) or Wikipedia's article on the work."}
  - Adaptations: Wikipedia, IMDb or the studio/publisher announcement.
- One search can check many works (an award's full winners list, a list of comics adapted to film or TV). Stop when you are confident.
- Issue ranges are checked against Comic Vine after you answer, so give the range of a well-known run without searching for it; leave an entry out only if you do not know its range.
- If you cannot confirm an award or an adaptation, leave that category out of the entry.

WHAT TO INCLUDE
- Definitive creator runs on an ongoing series (Frank Miller's Daredevil #168-191), limited series (Watchmen #1-12), standalone graphic novels and one-shots (Batman: The Killing Joke). A work that qualifies for several categories lists them all.

WHAT NOT TO INCLUDE
- Films, TV, animation, games or any non-comic media; comics BASED ON earlier films or TV (movie tie-ins, comics of an animated series). "Adapted to screen" means the comic came first.
- Crossover events spanning 3 or more ongoing titles (Knightfall, No Man's Land, War Games); if unsure, set is_crossover true.
- A whole anthology series as one entry: list its acclaimed arcs instead ("Batman: Gothic", Legends of the Dark Knight #6-10).
- Collected editions, trade paperbacks, omnibuses or reprints. Works that do not genuinely qualify: quality over quantity.

EACH RUN
- title: the exact published title of the run or arc ("A Death in the Family", "The Dark Knight Returns"). If you are not sure of it, leave the entry out. Never the same work twice.
- parent_series: the series the issues are in, as Comic Vine names it, without a year ("Daredevil", "Detective Comics", "Batman: Legends of the Dark Knight"); null for a standalone graphic novel or a limited series that is its own title.
- issue_range_hint: every issue of the run, then the volume's start year: "#168-191 (1964 vol)". The year is when the VOLUME began on Comic Vine, never the issues' cover year. Relaunches are separate volumes (Wonder Woman (2006), (2011) and (2016) are three volumes); legacy-numbered issues belong to the volume that carries that number on Comic Vine. A run in pieces lists every piece: "#1, #3, #5, #7, #9, #11 (2016 vol)", "#635-641, #645-650 (1940 vol)". One-shots and graphic novels: "One-shot (YEAR)" with the publication year.
- description: one or two sentences on why it belongs on the shelf.
- creators: the writer and the main artists, with roles (writer, penciler, inker, artist, colorist, letterer).
- categories: for EVERY run you keep, check all three — adapted_to_screen, award_winning, critically_acclaimed — even the ones this request did not ask for, and list each one you confirmed (the scope above only decides which runs qualify).
- adaptation_notes (when adapted_to_screen): a short badge label, never a sentence or a source: each production as "Title (format, year)", with "Inspired " before ones that were a well-documented inspiration rather than a credited adaptation, at most 4, joined with " · ", best known first (theatrical films and major TV series before direct-to-video animation; keep inspirations, they are often the best known; combine parts into one item): "Inspired The Dark Knight Rises (film, 2012) · Inspired Batman v Superman (film, 2016) · The Dark Knight Returns, Parts 1–2 (animated films, 2012–13)". Otherwise null.
- award_notes (when award_winning): a short badge label: each award the WORK itself won as "Award, Category (year)", at most 3, joined with " · ": "Eisner, Best Limited Series (1987) · Hugo, Best Other Form (1988)". Otherwise null.
- is_crossover: see above.
${refinementNote}
${seriesNote}
At most 30 runs; if more qualify, the most significant.

Reply with only this JSON object: {"runs": [ {"title": "Born Again", "parent_series": "Daredevil", "issue_range_hint": "#227-233 (1964 vol)", "description": "…", "creators": [{"name": "Frank Miller", "role": "writer"}, {"name": "David Mazzucchelli", "role": "artist"}], "categories": ["critically_acclaimed"], "adaptation_notes": null, "award_notes": null, "is_crossover": false} ]}`;
  // v2: one model for the whole job (trial split applied once); GPT gets the read_page wording.
  const runModel = ai.choose('topshelf');
  const runGpt = !!runModel && ai.providerOf(runModel) === 'openai';
  const prompt = runGpt ? forGptPrompt(promptV2) : promptV2;

  try {
    logger.info('canon', `AI generate: ${scope_type}="${scope_value}" categories=[${categories.join(',')}] match=${catMatch}${catExclude.length ? ` exclude=[${catExclude.join(',')}]` : ''} (v2 prompt${verifiedAwards ? `, ${verifiedAwards.count} verified award winners given` : ''})`);

    var topshelfJob = ai.newJobId();
    let responseData = null;
    const runCalls = [];   // every response of this job, for the cost line
    // As the event generator: newest tools and a structured reply first; a refused (400)
    // combination is dropped step by step, ending with no web tools at all (the original way).
    const attempts = [
      // Limits (2026-10-22): 12 searches / 8 full pages let Sonnet read 520k tokens for 10 runs ($1.35;
      // Opus 93k for 22). Now 6 searches, 3 page reads of at most 15k tokens, as the event generator.
      { label: 'search+fetch (2026) with structured output', webSearch: 6, webFetch: 3, webFetchTokens: 15000, tools2026: true, outputSchema: RUN_LIST_SCHEMA },
      { label: 'search+fetch (2026)', webSearch: 6, webFetch: 3, webFetchTokens: 15000, tools2026: true },
      { label: 'search+fetch', webSearch: 6, webFetch: 3, webFetchTokens: 15000 },
      { label: 'no web tools' },
    ];
    let lastErr = null;
    for (const { label, ...a } of attempts) {
      try {
        runCalls.length = 0;
        const opts = { task: 'topshelf', model: runModel, maxTokens: 16000, timeout: 480000, jobId: topshelfJob, ...a };
        ({ data: responseData } = await ai.complete({ ...opts, prompt }));
        runCalls.push(responseData);
        for (let turn = 0; turn < 4 && responseData && responseData.stop_reason === 'pause_turn'; turn++) {
          logger.info('canon', `AI generate: continuing a paused turn (${turn + 1})`);
          ({ data: responseData } = await ai.complete({ ...opts, messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: responseData.content }] }));
          runCalls.push(responseData);
        }
        logger.info('canon', `AI generate: used ${label}${runGpt ? ' (OpenAI: web search, read_page, strict JSON)' : ''}`, { model: runModel });
        break;
      } catch (e) {
        lastErr = e;
        if (e.response?.status !== 400) throw e;
        logger.warn('canon', `AI generate: the API refused ${label} (${e.response?.data?.error?.message || e.message}); trying a simpler set`);
      }
    }
    if (!responseData) throw lastErr;
    const response = { data: responseData };

    // v2: the last text block holding the JSON (searching can leave short text blocks before it)
    const textBlocks = (response.data.content || []).filter(b => b.type === 'text').map(b => b.text);
    const lastJson = [...textBlocks].reverse().find(t => /^\s*[[{]/.test(t));
    const text = lastJson || textBlocks.join('');

    // Check for truncation before attempting parse
    if (response.data.stop_reason === 'max_tokens') {
      throw new Error('Response was truncated — the scope produced too many results. Try narrowing to a single category, or a more specific character/publisher.');
    }

    const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    let runs;
    const objStart = cleaned.search(/\{\s*"runs"\s*:/);
    if (objStart >= 0) {
      // v2 reply: {"runs": [...]} (structured output); the object is read up to its last brace.
      const obj = JSON.parse(cleaned.slice(objStart, cleaned.lastIndexOf('}') + 1));
      runs = obj && obj.runs;
    } else {
      const startBracket = cleaned.indexOf('[');
      if (startBracket === -1) throw new Error('No JSON array in response');
      runs = JSON.parse(cleaned.slice(startBracket, cleaned.lastIndexOf(']') + 1));
    }
    if (!Array.isArray(runs)) throw new Error('Response was not an array');

    // Totals over every call of the job (paused turns included; the log used to show the last call only).
    const calls = runCalls.length ? runCalls : [response.data];
    const sum = k => calls.reduce((n, d) => n + (d?.usage?.[k] || 0), 0);
    const searches = calls.reduce((n, d) => n + (d?.usage?.server_tool_use?.web_search_requests || 0), 0);
    const fetches = calls.reduce((n, d) => n + (d?.usage?.server_tool_use?.web_fetch_requests || 0), 0);
    const usedRunModel = runModel || response.data.model || '';
    const estCents = Math.round(modelCatalog.estimateCost(usedRunModel, { input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'),
      cache_read: sum('cache_read_input_tokens'), cache_write: sum('cache_creation_input_tokens'), web_searches: searches }) * 1000) / 10;
    logger.info('canon', `AI generate complete`, { runs: runs.length, model: runModel || response.data.model, calls: calls.length,
      input: sum('input_tokens'), output: sum('output_tokens'), searches, fetches, est_cents: estCents });

    // ── Post-generation enrichment ────────────────────────────────
    // Normalise: lowercase, strip leading articles, strip punctuation.
    // No longer hardcodes "batman" — scope words are handled by the dynamic STOP set below.
    const normalise = (s = '') => s.toLowerCase()
      .replace(/^(the\s+|a\s+|an\s+)/i, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ').trim();

    // Build stop words dynamically: base set + words from the scope value itself.
    // This means "batman" is noise for a Batman query, "marvel" for a Marvel query,
    // "spider" and "man" for Spider-Man, etc. — without any hardcoded character names.
    const scopeStopWords = scope_value.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
    const STOP = new Set([
      'of', 'the', 'a', 'an', 'and', 'in', 'to', 'for', 'at', 'by', 'on', 'with', 'from', 'as', 'into',
      ...scopeStopWords,
    ]);
    const sigWords = (s) => normalise(s).split(' ').filter(w => w.length > 2 && !STOP.has(w));

    const wordOverlap = (a, b) => {
      const wa = new Set(sigWords(a));
      const wb = new Set(sigWords(b));
      if (!wa.size || !wb.size) return 0;
      const intersection = [...wa].filter(w => wb.has(w)).length;
      return intersection / Math.max(wa.size, wb.size);
    };

    // Stricter event match: requires both high overlap AND that neither title
    // is so short that common words cause false positives.
    // "Death of the Family" vs "A Death in the Family":
    //   sigWords("Death of the Family") = ["death", "family"]
    //   sigWords("A Death in the Family") = ["death", "family"]
    //   overlap = 1.0 BUT both titles only have 2 sig words — too few to be reliable
    // Fix: require at least 3 significant words matched, OR exact normalised match
    const eventMatch = (runTitle, eventName) => {
      const normRun   = normalise(runTitle);
      const normEvent = normalise(eventName);
      // Exact normalised match is always valid
      if (normRun === normEvent) return { match: true, score: 1.0 };
      const wa = sigWords(runTitle);
      const wb = sigWords(eventName);
      if (!wa.length || !wb.length) return { match: false, score: 0 };
      const shared = wa.filter(w => wb.includes(w));
      const score  = shared.length / Math.max(wa.length, wb.length);
      // Require at least 3 significant words shared, and high overlap
      if (shared.length >= 3 && score >= 0.75) return { match: true, score };
      // For longer titles (4+ sig words each), allow 2 shared with very high overlap
      if (shared.length >= 2 && wa.length >= 4 && wb.length >= 4 && score >= 0.8) return { match: true, score };
      return { match: false, score };
    };

    // Load all events and existing canon runs for matching
    const allEvents    = db.prepare('SELECT id, name FROM events').all();
    const existingRuns = db.prepare('SELECT id, title, parent_series FROM canon_runs').all();

    const enriched = runs.map(run => {
      // Event match
      let matchedEvent = null;
      let bestScore = 0;
      for (const ev of allEvents) {
        const { match, score } = eventMatch(run.title, ev.name);
        if (match && score > bestScore) {
          bestScore = score;
          matchedEvent = { id: ev.id, name: ev.name, score };
        }
      }

      // Duplicate detection — existing canon run with same title + series
      let duplicateOf = null;
      const normRunTitle = normalise(run.title);
      for (const existing of existingRuns) {
        const normExistingTitle = normalise(existing.title);
        // Exact normalised match — always a duplicate
        const exactMatch = normRunTitle === normExistingTitle;
        const titleMatch = exactMatch || wordOverlap(run.title, existing.title) >= 0.85;
        const seriesMatch = !run.parent_series || !existing.parent_series ||
          wordOverlap(run.parent_series, existing.parent_series) >= 0.7;
        if (titleMatch && seriesMatch) {
          duplicateOf = { id: existing.id, title: existing.title };
          break;
        }
      }

      return { ...run, matched_event: matchedEvent, duplicate_of: duplicateOf };
    });

    // Within-batch dedup — Claude sometimes generates near-duplicates in one response
    // (e.g. "Dark Knight Returns" and "The Dark Knight Returns"). Keep the first
    // occurrence of any pair that matches on both title and series.
    const batchSeen = [];
    const finalRuns = enriched.filter(run => {
      const normTitle = normalise(run.title);
      const isDup = batchSeen.some(s => {
        const exactMatch = normalise(s.title) === normTitle;
        const titleMatch = exactMatch || wordOverlap(run.title, s.title) >= 0.85;
        const seriesMatch = !run.parent_series || !s.parent_series ||
          wordOverlap(run.parent_series, s.parent_series) >= 0.7;
        return titleMatch && seriesMatch;
      });
      if (!isDup) batchSeen.push(run);
      return !isDup;
    });
    if (finalRuns.length < enriched.length) {
      logger.info('canon', `Within-batch dedup removed ${enriched.length - finalRuns.length} duplicate(s)`);
    }

    setAiJobOutcome(topshelfJob, 'ok', `${finalRuns.length} runs`);
    for (const r of finalRuns) r.categories_checked = true;
    // Category filter enforced in code: runs missing a required category or carrying an excluded one are dropped.
    const { kept, dropped } = filterRunsByCategory(finalRuns, { categories, match: catMatch, exclude: catExclude });
    if (dropped.length) logger.info('canon', `Category filter dropped ${dropped.length} run(s)`, { dropped: dropped.map(d => `${d.title}: ${d.reason}`) });
    res.json({ success: true, runs: kept, dropped, usage: { input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), searches, fetches, est_cents: aiInfo.requestTotals(db)?.cents ?? estCents,
      model: usedRunModel ? modelCatalog.displayName(usedRunModel) : null } });
  } catch (e) {
    if (typeof topshelfJob !== 'undefined') setAiJobOutcome(topshelfJob, /truncated/i.test(e.message) ? 'truncated' : /JSON|array/i.test(e.message) ? 'bad_json' : 'error', e.message);
    logger.error('canon', 'AI generate failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

return {};
};
