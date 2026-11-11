'use strict';
// ─── Synopsis test (admin only; stores nothing) ───────────────────
// Before building recaps on stored issue synopses (claude/ADMIN_REORG.md › recaps, user 2026-10-18),
// compare how well models write a short synopsis of one issue, and what it costs:
//   web:   the model searches the web (fan wikis, reviews) for THIS issue and condenses it
//   pages: the model reads the issue's own pages (the same page images Comic Book Guy's view_page uses)
// The teaser in ComicInfo is passed along as a hint, marked as not a synopsis.
//
//   POST /api/admin/synopsis-test  { series, issues: ['7','8'], book_ids?, models?: [...], modes?: ['web','pages'],
//                                    pageIssues?: 1, pageModels?: [...], maxPages?: 40 }  → starts a background job
//   GET  /api/admin/synopsis-test  → { job, results }
// Each result: issue, mode, model, found, synopsis, words, source_url, confidence, ms, tokens, searches, pages, est_cost.

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['found', 'synopsis', 'source_url', 'confidence'],
  properties: {
    found: { type: 'boolean' },
    synopsis: { type: ['string', 'null'] },
    source_url: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};
// v2 page reading (user, 2026-10-18): beats first, then the synopsis written from them.
const SCHEMA2 = {
  type: 'object', additionalProperties: false, required: ['found', 'beats', 'synopsis', 'confidence'],
  properties: {
    found: { type: 'boolean' },
    beats: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['pages', 'what'], properties: { pages: { type: 'string' }, what: { type: 'string' } } } },
    synopsis: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};
const SEARCH_FEE = 0.01;   // assumed per web search (not in the price table); shown separately in est_cost

const tag = (ci, t) => {
  const m = String(ci || '').match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`));
  return m ? m[1].replace(/&lt;[^&]*?&gt;|<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&#39;/g, '’').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim() : '';
};

function describe(book) {
  const ci = book.comicinfo || '';
  const month = tag(ci, 'Month'), year = tag(ci, 'Year');
  return {
    book_id: book.id,
    series: tag(ci, 'Series') || book.series_name, volume: tag(ci, 'Volume') || book.series_year || '',
    number: tag(ci, 'Number') || book.issue_number, title: tag(ci, 'Title'), year: book.series_year || '',
    date: [year, month && String(month).padStart(2, '0')].filter(Boolean).join('-'),
    writer: tag(ci, 'Writer'), teaser: tag(ci, 'Summary').slice(0, 600),
  };
}

const ISSUE_LINE = i => `${i.series}${i.volume ? ` (${i.volume} volume)` : ''} #${i.number}${i.title ? `, titled "${i.title}"` : ''}${i.date ? `, cover date ${i.date}` : ''}${i.writer ? `, written by ${i.writer}` : ''}`;
const WRITE_RULES = `Write a synopsis of 80–150 words for a reader who finished this issue and wants to remember it: what happens, who matters, what changes, and the threads left open. Plain prose, past tense, no headings. Spoilers for THIS issue are fine; nothing from later issues.`;

const webPrompt = i => `Find what happens in this comic issue and write a short synopsis.

Issue: ${ISSUE_LINE(i)}.
${i.teaser ? `Publisher teaser (a sales blurb, not a synopsis): "${i.teaser}"\n` : ''}
Search the web for a summary of THIS issue's story (fan wikis such as DC Database or Marvel Database, issue reviews, recaps). Make sure it is this series, volume and issue number, not another volume or a reprint.
${WRITE_RULES}
If you cannot find a source that covers this issue's story, set found to false and synopsis to null. Never invent events.
Reply with only JSON: {"found": true, "synopsis": "…", "source_url": "https://…", "confidence": "high"}`;

const pagesPrompt = (i, n, total) => `These are ${n === total ? `all ${n}` : `the first ${n} of ${total}`} pages of ${ISSUE_LINE(i)}, in order.
${i.teaser ? `Publisher teaser (a sales blurb, not a synopsis): "${i.teaser}"\n` : ''}
Read the pages (art and lettering) and write a synopsis of what happens in them.
${WRITE_RULES}
Use only what the pages show; if they are unreadable, set found to false. source_url is null.
Reply with only JSON: {"found": true, "synopsis": "…", "source_url": null, "confidence": "high"}`;

// v2: only series, volume year, number, title and date (ComicInfo teasers and character lists were wrong in 3 of 8 control issues).
const pagesPrompt2 = (i, n, total) => `These are ${n === total ? 'the' : `the first ${n} of ${total}`} pages of ${i.series}${i.year ? ` (${i.year})` : ''} #${i.number}${i.title ? `, "${i.title}"` : ''}${i.date ? `, cover date ${i.date}` : ''}, in order.

Read every page: art, captions, dialogue and sound effects. Skip covers, ads, letters pages, pin-ups and previews. Some scans have a page mirrored or out of order.

Step 1 (beats): list what happens, scene by scene, with page numbers. One short line each: who does what to whom. Mark flashbacks as "(flashback)". Up to 15 beats.

Step 2 (synopsis): from your beats, write 80–150 words for a reader who finished this issue and wants to remember it. Plain prose, past tense, no headings.
- Be specific: name characters, say what they did, who was hurt or killed, and how the issue ends. Avoid mood words in place of events.
- Use names only as the lettering gives them. If someone is never named, describe them ("a young man outside a nightclub"). Do not name characters from memory.
- Only what these pages show. Even if you know this story, do not add events from other issues.
- If you cannot tell who did something, say less rather than guess.

If the pages cannot be read, set found to false.
Reply with only JSON: {"found": true, "beats": [{"pages": "3-4", "what": "…"}], "synopsis": "…", "confidence": "high"}`;

// web v2: no ComicInfo teaser (teasers were wrong or misleading in the control set); folder volume year.
const webPrompt2 = i => `Find what happens in this comic issue and write a short synopsis.

Issue: ${i.series}${i.year ? ` (${i.year})` : ''} #${i.number}${i.title ? `, titled "${i.title}"` : ''}${i.date ? `, cover date ${i.date}` : ''}${i.writer ? `, written by ${i.writer}` : ''}.

Search the web for a summary of THIS issue's story (fan wikis such as DC Database or Marvel Database, issue reviews, recaps). Make sure it is this series, volume and issue number, not another volume or a reprint.
${WRITE_RULES}
If you cannot find a source that covers this issue's story, set found to false and synopsis to null. Never invent events.
Reply with only JSON: {"found": true, "synopsis": "…", "source_url": "https://…", "confidence": "high"}`;

module.exports = function createSynopsisTest({ app, db, requireAdmin, logger, ai, getPageImage, modelCatalog }) {
  let job = null;

  const cost = (model, u, searches) => {
    const p = modelCatalog.price(model) || { in: 0, out: 0 };
    const tokens = ((u.input_tokens || 0) * p.in + (u.cache_read_input_tokens || 0) * p.in * 0.1 + (u.output_tokens || 0) * p.out) / 1e6;
    return { tokens: Math.round(tokens * 100000) / 100000, searches: Math.round(searches * SEARCH_FEE * 1000) / 1000, total: Math.round((tokens + searches * SEARCH_FEE) * 10000) / 10000 };
  };
  const parse = text => {
    const s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
    try { return JSON.parse(s.slice(a, b + 1)); } catch { return { found: false, synopsis: null, source_url: null, confidence: 'low', parse_error: s.slice(0, 200) }; }
  };

  async function runOne(issue, mode, model, opts, height) {
    const t0 = Date.now();
    const base = { issue: `${issue.series} #${issue.number}`, title: issue.title, mode: height ? `${mode}@${height}` : mode, model };
    try {
      let r, pages = 0;
      if (mode === 'web2') {
        r = await ai.complete({ task: 'recap_web', model, prompt: webPrompt2(issue), maxTokens: 4000, webSearch: 2, outputSchema: SCHEMA, timeout: 180000, source: 'test' });
      } else if (mode === 'web') {
        r = await ai.complete({ task: 'recap_web', model, prompt: webPrompt(issue), maxTokens: 1500, webSearch: 2, outputSchema: SCHEMA, timeout: 180000, source: 'test' });
      } else {
        const v2 = mode === 'pages2';
        const size = height ? { height } : undefined;
        const first = await getPageImage(issue.book_id, 0, size);
        const total = first.count || 1, n = Math.min(total, opts.maxPages || 40);
        const content = [{ type: 'image', source: { type: 'base64', media_type: first.media_type, data: first.data } }];
        for (let k = 1; k < n; k++) { const img = await getPageImage(issue.book_id, k, size); content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } }); }
        pages = n;
        content.push({ type: 'text', text: (v2 ? pagesPrompt2 : pagesPrompt)(issue, n, total) });
        r = await ai.complete({ task: 'recap_reader', model, messages: [{ role: 'user', content }], maxTokens: v2 ? 8000 : 1500, outputSchema: v2 ? SCHEMA2 : SCHEMA, timeout: 300000, source: 'test' });
      }
      const u = r.usage || {}, searches = u.server_tool_use?.web_search_requests || 0;
      const out = parse(r.text);
      const words = out.synopsis ? out.synopsis.trim().split(/\s+/).length : 0;
      return { ...base, ...out, words, ms: Date.now() - t0, tokens: { in: u.input_tokens || 0, cached: u.cache_read_input_tokens || 0, out: u.output_tokens || 0 }, searches, pages, est_cost: cost(model, u, searches) };
    } catch (e) {
      return { ...base, error: e.response?.data?.error?.message || e.message, ms: Date.now() - t0 };
    }
  }

  async function run(books, opts) {
    const issues = books.map(describe);
    const models = opts.models && opts.models.length ? opts.models : ['openai:gpt-6-luna', 'claude-haiku-5-5'];
    const pageModels = opts.pageModels && opts.pageModels.length ? opts.pageModels : models;
    const modes = opts.modes && opts.modes.length ? opts.modes : ['web', 'pages'];
    const plan = [];
    issues.forEach((issue, k) => {
      if (modes.includes('web')) for (const m of models) plan.push([issue, 'web', m]);
      if (modes.includes('pages') && k < (opts.pageIssues ?? 1)) for (const m of pageModels) plan.push([issue, 'pages', m]);
      if (modes.includes('web2')) for (const m of models) plan.push([issue, 'web2', m]);
      if (modes.includes('pages2')) for (const h of (opts.pageHeights && opts.pageHeights.length ? opts.pageHeights : [null])) for (const m of pageModels) plan.push([issue, 'pages2', m, h]);
    });
    job = { running: true, total: plan.length, done: 0, startedAt: Date.now(), finishedAt: null, issues: issues.map(i => `${i.series} #${i.number}`), results: [] };
    for (const [issue, mode, model, height] of plan) {
      const r = await runOne(issue, mode, model, opts, height);
      job.results.push(r); job.done++;
      logger.info('synopsis-test', `${r.issue} ${r.mode} ${model}: ${r.error ? `error ${r.error}` : `${r.found ? 'found' : 'not found'}, ${r.words} words, ${r.ms} ms, ~$${r.est_cost.total}`}`,
        r.error ? undefined : { synopsis: r.synopsis, beats: r.beats, source: r.source_url, confidence: r.confidence, tokens: r.tokens, searches: r.searches, pages: r.pages });
    }
    job.running = false; job.finishedAt = Date.now();
  }

  app.post('/api/admin/synopsis-test', requireAdmin, (req, res) => {
    if (job && job.running) return res.status(409).json({ error: 'A synopsis test is already running.' });
    const b = req.body || {};
    let books = [];
    if (Array.isArray(b.book_ids) && b.book_ids.length) {
      books = b.book_ids.map(id => db.prepare('SELECT sb.*, ss.name AS series_name, ss.year AS series_year FROM scanned_books sb JOIN scanned_series ss ON ss.id = sb.series_id WHERE sb.id = ?').get(String(id))).filter(Boolean);
    } else if (b.series && Array.isArray(b.issues)) {
      const ss = db.prepare('SELECT id, name, year FROM scanned_series WHERE lower(name) = lower(?) ORDER BY year DESC').get(String(b.series));
      if (!ss) return res.status(404).json({ error: `No library series named "${b.series}".` });
      const q = db.prepare('SELECT sb.*, ? AS series_name, ? AS series_year FROM scanned_books sb WHERE sb.series_id = ? AND sb.issue_number = ?');
      books = b.issues.map(n => q.get(ss.name, ss.year, ss.id, String(n))).filter(Boolean);
    }
    if (!books.length) return res.status(400).json({ error: 'No issues found: give book_ids, or series and issues.' });
    run(books.slice(0, 10), b).catch(e => { logger.error('synopsis-test', 'Test failed', { error: e.message }); if (job) { job.running = false; job.error = e.message; } });
    res.json({ ok: true, issues: books.length });
  });

  app.get('/api/admin/synopsis-test', requireAdmin, (req, res) => res.json({ job }));

  return { describe, webPrompt, webPrompt2, pagesPrompt, pagesPrompt2, status: () => job };
};
