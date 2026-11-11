'use strict';
const aiInfo = require('./aiInfo');
// ─── canonCategories.js ───────────────────────────────────────────
// "Check categories" for Top Shelf runs (claude/ADMIN_REORG.md, run generator option C;
// user 2026-10-18). Each run is checked on the web for all three categories (adapted to
// screen, award winning, critically acclaimed); the result is a set of proposals the admin
// reviews (add / correct notes / remove) before anything changes.
// Runs remember when they were checked (canon_runs.categories_checked_at), so a run is not
// checked again unless asked ("again"); runs from the updated generator count as checked.
// Several runs share one AI request (5 per batch, 4 searches, no page reads); runs already settled are skipped. Model: Settings task
// "Top Shelf – Category Check" (topshelf_categories; follows the Quick model unless pinned). A verdict
// without a web source counts as unsure (nothing proposed). Notes are badge labels, not sentences.
//
//   GET  /api/editor/runs/categories            { counts: {unchecked, pending, all}, job, proposals: [{run…, items}] }
//   POST /api/editor/runs/categories/check      { scope: 'unchecked'|'pending'|'all'|'ids', ids? } → starts a background job
//   POST /api/editor/runs/categories/apply      { apply: [proposalId], dismiss: [proposalId] }
//   POST /api/editor/runs/categories/stop       stops the running check after abandoning the batch in progress

const CATS = ['adapted_to_screen', 'award_winning', 'critically_acclaimed'];
const LABEL = { adapted_to_screen: 'Adapted to screen', award_winning: 'Award winning', critically_acclaimed: 'Critically acclaimed' };
// 5 runs per request: every search re-sends the whole conversation, so cost grows faster than the
// batch. Search results only, no page reads (pages were the bulk of the tokens: 20 runs took ~530k
// with 3 page reads per batch), 4 searches per batch (user 2026-10-18, budget cuts 1–2).
const BATCH = 5;
const LIMITS = { webSearch: 4 };

// "Settled" (budget cut 3): a tag whose notes are already badge-style was checked by this tool or the
// v2 generator, so it is not researched again; an acclaimed tag is settled once present (its notes are
// never updated here). A run with all three settled is skipped (no request).
// Badge style only: adaptations "Title (format, year)", awards "Award, Category (year)"; older notes
// ("Eisner Award — Best Writer (2012)", "Film 2009 (direct)") are not settled and get checked.
const BADGE_ITEM = {
  adapted_to_screen: item => /\([^()]*, (1[89]|20)\d\d[^()]*\)$/.test(item),
  // "Eisner, Best Limited Series (2019)" or a creator award "Eisner, Best Writer — Tom King (2018, 2019)"
  award_winning: item => /^[^()—,]+, [^()]+? \((1[89]|20)\d\d(, (1[89]|20)\d\d)*\)$/.test(item),
};
const isBadge = (n, category = 'adapted_to_screen') => !!n && !/;|\((direct|inspired)\)/i.test(n)
  && String(n).trim().split(/\s+·\s+/).every(item => (BADGE_ITEM[category] || BADGE_ITEM.adapted_to_screen)(item.trim()));
// Award facts from the app's records for this run (not the [series] ones, which may belong to another
// run of the series), and those its award notes do not yet mention (category and year).
const awardFacts = run => (run.hints || []).filter(h => /^(award wins|creator awards citing this run):/.test(h))
  .flatMap(h => h.replace(/^[^:]+:\s*/, '').split(' · ')).filter(f => !/\[series\]/.test(f));
const missingAwardFacts = run => {
  const notes = String((run.cats.find(c => c.category === 'award_winning') || {}).adaptation_notes || '').toLowerCase();
  return awardFacts(run).filter(f => {
    const m = f.match(/^[^,]+,\s*(.+?)(?:\s+—\s+.+)?\s+\((\d{4})\)$/);
    const cat = m ? m[1].split(/ or |\(/)[0].trim().toLowerCase() : '';   // "Best Penciller/Inker or … Team" → "best penciller/inker"
    return !m || !notes.includes(cat) || !notes.includes(m[2]);
  });
};
// An award tag is settled only when its notes are badge-style AND mention every recorded award.
const settledCats = run => new Set(run.cats.filter(c => c.category === 'critically_acclaimed'
  || (isBadge(c.adaptation_notes, c.category) && (c.category !== 'award_winning' || !missingAwardFacts(run).length))).map(c => c.category));

const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['runs'],
  properties: { runs: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['id', 'adapted_to_screen', 'award_winning', 'critically_acclaimed', 'sources'],
    properties: {
      id: { type: 'integer' },
      ...Object.fromEntries(CATS.map(c => [c, { type: 'object', additionalProperties: false,
        properties: { verdict: { type: 'string', enum: ['yes', 'no', 'unsure'] }, notes: { type: ['string', 'null'] }, why: { type: ['string', 'null'] } },
        required: ['verdict', 'notes', 'why'] }])),
      sources: { type: 'array', items: { type: 'string' } },
    } } } },
};

// Badge-length notes: one line, no trailing explanation, at most ~180 characters (cut at a " · ";
// the badge folds long notes). 180 fits four productions, e.g. The Dark Knight Returns' two films,
// one animated pair and nothing lost (user 2026-10-18: keep the well-known inspirations).
const NOTES_MAX = 200;
function tidyNotes(n, max = NOTES_MAX) {
  if (!n) return null;
  let t = String(n).replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  if (t.length > max) { const cut = t.lastIndexOf(' · ', max); t = cut > 20 ? t.slice(0, cut) : t.slice(0, max).replace(/\s+\S*$/, '') + '…'; }
  return t || null;
}
// Items in a note, old style ("A (direct); B (inspired)") or badge style ("A · B").
const noteItems = n => (n ? String(n).split(/\s+·\s+|;\s*/).filter(x => x.trim()).length : 0);
const tidyWhy = w => (w ? String(w).replace(/\s+/g, ' ').trim().replace(/\.$/, '').slice(0, 140) || null : null);

// Generate modal filter (user 2026-10-18): each category is "doesn't matter", "must have" or "must not have".
// match 'all' → a run needs every category in `categories`; exclude → a run tagged with any of them is dropped.
// (match 'any' needs no check here: the generator only keeps runs that qualify for one of them.)
const LOWER = { adapted_to_screen: 'adapted to screen', award_winning: 'award winning', critically_acclaimed: 'critically acclaimed' };
function filterRunsByCategory(runs, { categories = [], match = 'any', exclude = [] } = {}) {
  const kept = [], dropped = [];
  for (const run of runs || []) {
    const tags = new Set(run.categories || []);
    const missing = match === 'all' ? categories.filter(c => !tags.has(c)) : [];
    const banned = exclude.filter(c => tags.has(c));
    if (banned.length) dropped.push({ title: run.title, reason: `${banned.map(c => LOWER[c] || c).join(', ')} (excluded)` });
    else if (missing.length) dropped.push({ title: run.title, reason: `not ${missing.map(c => LOWER[c] || c).join(', ')}` });
    else kept.push(run);
  }
  return { kept, dropped };
}

function promptFor(runs) {
  const list = runs.map(r => `- id ${r.id}: "${r.title}"${r.parent_series ? ` — ${r.parent_series}` : ''}${r.issue_range_hint ? ` ${r.issue_range_hint}` : ''}${r.creators ? ` — by ${r.creators}` : ''}`
    + (r.cats.length ? `\n  currently tagged: ${r.cats.map(c => `${LABEL[c.category]}${c.adaptation_notes ? ` (${c.adaptation_notes})` : ''}`).join('; ')}` : '\n  currently tagged: nothing')
    + (r.settled && r.settled.size ? `\n  already confirmed, do not research: ${[...r.settled].join(', ')} (answer "yes" with the current notes)` : '')
    + (r.hints && r.hints.length ? `\n  the app's records: ${r.hints.join('; ')}` : '')).join('\n');
  return `You are checking the categories of comic runs on a reader's "Top Shelf" (a personal comic library app). For each run below, decide each of three categories from evidence you find on the web, not from memory alone:

- adapted_to_screen: the comic (the comic came first) was adapted into a film, TV series, episode or animated production (credited source), or was a well-documented creative inspiration for one. Not for comics based on earlier films or TV.
- award_winning: the WORK itself won a major comics or genre award (Eisner, Harvey, Hugo, Bram Stoker, Kirby, Eagle, Shuster…), or a juried creator award (Eisner, Harvey or Kirby Best Writer, Artist, Penciller/Inker, Writer/Artist…) whose citation names this run's series in the years of this run. Not a nomination, not a fan poll, and not an award its creators won for other work. Every award listed under "the app's records" (award wins, creator awards citing this run) is verified: include them all.
- critically_acclaimed: widely regarded by critics and fans as a landmark or essential work (best-of lists, critical consensus, influence). Best-of lists (IGN, CBR, Polygon, Paste) and review aggregators (Comic Book Roundup) are good sources. An arc of a larger acclaimed storyline counts when the praise covers that storyline (the second arc of an acclaimed saga).

NOTES are shown to the reader on a small badge next to the category name, so they are short labels, never sentences or explanations, never sources:
- adapted_to_screen: each production as "Title (format, year)", "Inspired " before ones that were a well-documented inspiration rather than a credited adaptation, joined with " · ", at most 4. Best known first: theatrical films and major TV series before direct-to-video animation. Keep inspirations: they are often the best-known productions. Combine parts and seasons into one item. Example: "Inspired The Dark Knight Rises (film, 2012) · Inspired Batman v Superman (film, 2016) · The Dark Knight Returns, Parts 1–2 (animated films, 2012–13)".
- award_winning: work awards first as "Award, Category (year)", then creator awards as "Award, Category — Creator (years)", one item per category with its years combined, at most 5, joined with " · ". Example: "Eisner, Best Limited Series (2019) · Eisner, Best Writer — Tom King (2018, 2019) · Eisner, Best Penciller/Inker — Mitch Gerads (2018, 2019)".
- critically_acclaimed: a few words, at most 8. Example: "Defined the grim Batman of the 1980s".
- A run's CURRENT notes were researched before: keep every item in them that still checks out (rewritten in this style) and add what is missing. Never drop a confirmed item to make the notes shorter. A current tag with no notes: fill them in.
WHY (shown only to the reader reviewing your changes, never on the badge): for a "no", or when your notes leave out something in the current notes, a few words on the reason, at most 12, e.g. "Eagle went to the writer; Goodreads was for Vol. 1". Otherwise null.

RESEARCH, keeping it lean: you have at most 4 web searches for the whole batch and no page reading, so decide from the search results (Wikipedia, the award's winners lists, IMDb). One search can settle several runs (an award's winners list, a best-of list). Skip the categories marked as already confirmed. "The app's records" are facts from the reader's library: an award listed there is a confirmed win (use it as a source: "app records"), but series-level awards and Comic Book Roundup scores cover the whole series, so they count for this run only when the run is what that series was known for in those years. Stop when you are confident.
verdict: "yes" with notes when you found it; "no" when you checked and it does not qualify (notes null, why given); "unsure" when you could not establish it either way (notes null). A current tag you cannot confirm is "unsure", not "no", unless you found that it is wrong.
sources: the URLs you relied on for this run, or "app records" (a verdict without a source counts as "unsure").

Runs:
${list}

Reply with only this JSON object: {"runs": [{"id": 12, "adapted_to_screen": {"verdict": "yes", "notes": "Son of Batman (animated film, 2014)", "why": null}, "award_winning": {"verdict": "no", "notes": null, "why": "The Eisner went to the writer, not this arc"}, "critically_acclaimed": {"verdict": "unsure", "notes": null, "why": null}, "sources": ["https://…"]}]}`;
}

module.exports = function createCanonCategories({ app, db, requireAdmin, logger, ai, setAiJobOutcome = () => {}, hintsFor = () => [] }) {
  try { db.exec('ALTER TABLE canon_runs ADD COLUMN categories_checked_at TEXT'); } catch {}
  db.exec(`CREATE TABLE IF NOT EXISTS canon_category_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL REFERENCES canon_runs(id) ON DELETE CASCADE,
    category TEXT NOT NULL, action TEXT NOT NULL, notes TEXT, current_notes TEXT, sources TEXT, why TEXT, created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(run_id, category))`);
  try { db.exec('ALTER TABLE canon_category_proposals ADD COLUMN why TEXT'); } catch {}   // tables made before 2026-10-18

  const runRows = ids => ids.map(id => {
    const r = db.prepare('SELECT id, title, parent_series, issue_range_hint FROM canon_runs WHERE id = ?').get(id);
    if (!r) return null;
    r.cats = db.prepare('SELECT category, adaptation_notes FROM canon_run_categories WHERE run_id = ?').all(id);
    r.creators = db.prepare("SELECT person_name FROM canon_run_creators WHERE run_id = ? AND role IN ('writer','artist','penciler') ORDER BY role DESC").all(id).map(c => c.person_name).join(', ');
    try { r.hints = hintsFor(r) || []; } catch { r.hints = []; }   // budget cut 4: awards and Comic Book Roundup from the app
    r.settled = settledCats(r);
    if (onlyAwards) for (const c of CATS) if (c !== 'award_winning') r.settled.add(c);   // "missing awards" pass: award tag only
    return r;
  }).filter(Boolean);
  let onlyAwards = false;
  // Runs whose award tag is missing (or whose notes leave out) an award in the app's records. Cached 60 s.
  let awardsCache = null;
  const runsMissingAwards = () => {
    if (awardsCache && Date.now() - awardsCache.at < 60000) return awardsCache.ids;
    const prev = onlyAwards; onlyAwards = false;
    const ids = runRows(db.prepare("SELECT id FROM canon_runs WHERE status != 'rejected' ORDER BY id").all().map(r => r.id))
      .filter(r => missingAwardFacts(r).length).map(r => r.id);
    onlyAwards = prev;
    awardsCache = { at: Date.now(), ids };
    return ids;
  };

  // Compare the AI's verdicts with the run's tags → proposals (replacing older ones for that run).
  function propose(run, result) {
    const have = new Map(run.cats.map(c => [c.category, c.adaptation_notes || null]));
    const raw = result.sources || [];
    const srcList = raw.filter(u => /^https?:\/\//.test(String(u)));
    const appRecords = !!(run.hints && run.hints.length && raw.some(u => /app records/i.test(String(u))));
    const sources = JSON.stringify([...srcList.slice(0, 8), ...(appRecords ? ['app records'] : [])]);
    const out = [];
    for (const c of CATS) {
      const v = { ...(result[c] || {}) };
      if (run.settled && run.settled.has(c)) continue;                        // already confirmed: not re-decided
      if (!srcList.length && !appRecords && v.verdict !== 'unsure') v.verdict = 'unsure';   // no source → not from the web → nothing proposed
      const notes = tidyNotes(v.notes);
      if (v.verdict === 'yes' && !have.has(c)) out.push({ category: c, action: 'add', notes });
      else if (v.verdict === 'yes' && have.has(c) && notes && c !== 'critically_acclaimed' && notes !== have.get(c)) out.push({ category: c, action: 'update', notes, current: have.get(c) });
      else if (v.verdict === 'no' && have.has(c)) out.push({ category: c, action: 'remove', notes: null, current: have.get(c) });
      if (out.length && out[out.length - 1].category === c) out[out.length - 1].why = tidyWhy(v.why);
    }
    db.transaction(() => {
      db.prepare('DELETE FROM canon_category_proposals WHERE run_id = ?').run(run.id);
      const ins = db.prepare('INSERT INTO canon_category_proposals (run_id, category, action, notes, current_notes, sources, why) VALUES (?,?,?,?,?,?,?)');
      for (const p of out) ins.run(run.id, p.category, p.action, p.notes, p.current || null, sources, p.why || null);
      db.prepare("UPDATE canon_runs SET categories_checked_at = datetime('now') WHERE id = ?").run(run.id);
    })();
    return out.length;
  }

  async function checkBatch(runs, signal) {
    const prompt = promptFor(runs);
    const jobId = ai.newJobId();
    const attempts = [
      { label: 'search+fetch (2026) with structured output', ...LIMITS, tools2026: true, outputSchema: RESULT_SCHEMA },
      { label: 'search+fetch (2026)', ...LIMITS, tools2026: true },
      { label: 'search+fetch', ...LIMITS },
    ];
    let data = null, lastErr = null, tokens = 0, cost = 0;
    const catalog = require('./modelCatalog');
    for (const { label, ...a } of attempts) {
      try {
        const opts = { task: 'topshelf_categories', maxTokens: 8000, timeout: 480000, jobId, signal, ...a };
        const count = d => { const u = d?.usage || {}; tokens += (u.input_tokens || 0) + (u.output_tokens || 0);
          cost += catalog.estimateCost(d?.model || '', { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_read: u.cache_read_input_tokens || 0,
            web_searches: u.server_tool_use?.web_search_requests || 0 }); return d; };
        ({ data } = await ai.complete({ ...opts, prompt })); count(data);
        for (let turn = 0; turn < 4 && data && data.stop_reason === 'pause_turn'; turn++) {
          ({ data } = await ai.complete({ ...opts, messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: data.content }] })); count(data);
        }
        logger.info('canon', `Category check: used ${label}`, { runs: runs.length, input: data.usage?.input_tokens, output: data.usage?.output_tokens });
        break;
      } catch (e) {
        lastErr = e;
        if (e.response?.status !== 400) throw e;
        logger.warn('canon', `Category check: the API refused ${label}; trying a simpler set`);
      }
    }
    if (!data) throw lastErr;
    const texts = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
    const text = [...texts].reverse().find(t => /\{\s*"runs"\s*:/.test(t)) || texts.join('');
    const start = text.search(/\{\s*"runs"\s*:/);
    if (start < 0) throw new Error('No result in the reply');
    const parsed = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
    setAiJobOutcome(jobId, 'ok', `${(parsed.runs || []).length} runs checked`);
    return { results: parsed.runs || [], tokens, cost };
  }

  // { running, total, done, batches, batch, proposals, tokens, msPerBatch, errors, stopped, startedAt, finishedAt }
  let job = null, controller = null;
  async function runJob(ids, opts = {}) {
    controller = new AbortController();
    onlyAwards = !!opts.onlyAwards; awardsCache = null;
    // Runs whose three tags are all settled need no request: remembered as checked and skipped.
    const all = ids;
    const done = runRows(all).filter(r => CATS.every(c => r.settled.has(c))).map(r => r.id);
    const mark = db.prepare("UPDATE canon_runs SET categories_checked_at = datetime('now') WHERE id = ?");
    for (const id of done) mark.run(id);
    ids = all.filter(id => !done.includes(id));
    job = { running: true, total: all.length, done: done.length, skipped: done.length, batches: Math.ceil(ids.length / BATCH), batch: 0, proposals: 0, tokens: 0, msPerBatch: null,
      errors: [], stopped: false, startedAt: Date.now(), finishedAt: null, aiRequest: aiInfo.currentRequest() };
    for (let i = 0; i < ids.length && !job.stopped; i += BATCH) {
      job.batch += 1;
      const runs = runRows(ids.slice(i, i + BATCH)), t0 = Date.now();
      try {
        const { results, tokens, cost } = await checkBatch(runs, controller.signal);
        job.tokens += tokens; job.cents = Math.round(((job.cents || 0) + cost * 100) * 10) / 10;
        const byId = new Map(results.map(r => [Number(r.id), r]));
        for (const run of runs) { const r = byId.get(run.id); if (r) job.proposals += propose(run, r); else job.errors.push(`"${run.title}": no answer`); }
        job.done = done.length + Math.min(ids.length, i + BATCH);
      } catch (e) {
        if (job.stopped) break;
        job.errors.push(e.message);
        logger.warn('canon', 'Category check batch failed', { error: e.message });
        job.done = done.length + Math.min(ids.length, i + BATCH);
      }
      const ms = Date.now() - t0;
      job.msPerBatch = job.msPerBatch ? Math.round((job.msPerBatch * (job.batch - 1) + ms) / job.batch) : ms;
    }
    job.running = false; job.finishedAt = Date.now(); controller = null; onlyAwards = false; awardsCache = null;
    logger.info('canon', `Category check ${job.stopped ? 'stopped' : 'finished'}`, { runs: job.done, of: all.length, skipped: done.length, proposals: job.proposals, tokens: job.tokens, errors: job.errors.length });
  }

  app.get('/api/editor/runs/categories', requireAdmin, (req, res) => {
    const counts = db.prepare(`SELECT SUM(CASE WHEN categories_checked_at IS NULL AND status != 'rejected' THEN 1 ELSE 0 END) AS unchecked,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status != 'rejected' THEN 1 ELSE 0 END) AS "all" FROM canon_runs`).get();
    const rows = db.prepare(`SELECT p.*, r.title, r.parent_series, r.issue_range_hint FROM canon_category_proposals p JOIN canon_runs r ON r.id = p.run_id ORDER BY r.title, p.category`).all();
    const byRun = new Map();
    for (const p of rows) {
      if (!byRun.has(p.run_id)) byRun.set(p.run_id, { run_id: p.run_id, title: p.title, parent_series: p.parent_series, issue_range_hint: p.issue_range_hint, sources: JSON.parse(p.sources || '[]'), items: [] });
      byRun.get(p.run_id).items.push({ id: p.id, category: p.category, label: LABEL[p.category], action: p.action, notes: p.notes, current_notes: p.current_notes, why: p.why || null,
        drops: p.action === 'update' && noteItems(p.notes) < noteItems(p.current_notes) });   // lists fewer items than the current tag: offered unticked
    }
    // A removal that would leave the run with no tag (unless one of its additions is applied too).
    const tagCount = db.prepare('SELECT COUNT(*) n FROM canon_run_categories WHERE run_id = ?');
    for (const pr of byRun.values()) {
      const removes = pr.items.filter(i => i.action === 'remove').length, adds = pr.items.some(i => i.action === 'add');
      if (removes && !adds && tagCount.get(pr.run_id).n - removes <= 0) for (const i of pr.items) if (i.action === 'remove') i.lastTag = true;
      pr.tags = tagCount.get(pr.run_id).n;
    }
    // "Runs missing recorded awards" takes a few seconds to count (every run's award records), so only
    // when asked (?awards=1, when the menu opens), not on every Top Shelf page load and poll.
    const c = { unchecked: counts.unchecked || 0, pending: counts.pending || 0, all: counts.all || 0 };
    if (req.query && req.query.awards) { try { c.awards = runsMissingAwards().length; } catch { c.awards = 0; } }
    // Tokens and cost from the saved calls of the request that started the check: the same totals as its ⓘ (2026-11-09).
    const t = job && aiInfo.totals(db, 'request_id', job.aiRequest);
    res.json({ counts: c, job: job && { ...job, ...(t ? { tokens: t.tokens, cents: t.cents } : {}), ai_request: job.aiRequest || null }, proposals: [...byRun.values()] });
  });

  app.post('/api/editor/runs/categories/check', requireAdmin, (req, res) => {
    if (job && job.running) return res.status(409).json({ error: 'A category check is already running.' });
    const { scope = 'unchecked', ids } = req.body || {};
    const where = { unchecked: "categories_checked_at IS NULL AND status != 'rejected'", pending: "status = 'pending'", all: "status != 'rejected'" }[scope];
    const list = scope === 'ids' ? (Array.isArray(ids) ? ids.map(Number).filter(Boolean) : [])
      : scope === 'awards' ? runsMissingAwards()
      : where ? db.prepare(`SELECT id FROM canon_runs WHERE ${where} ORDER BY id`).all().map(r => r.id) : [];
    if (!list.length) return res.status(400).json({ error: 'No runs to check.' });
    runJob(list, { onlyAwards: scope === 'awards' }).catch(e => { logger.error('canon', 'Category check failed', { error: e.message }); if (job) { job.running = false; job.errors.push(e.message); } });
    res.json({ ok: true, count: list.length, batches: Math.ceil(list.length / BATCH) });
  });

  // Stop: the batch in progress is abandoned (its runs stay unchecked); finished batches keep their proposals.
  app.post('/api/editor/runs/categories/stop', requireAdmin, (req, res) => {
    if (!job || !job.running) return res.json({ ok: true, running: false });
    job.stopped = true;
    try { controller && controller.abort(); } catch {}
    res.json({ ok: true });
  });

  app.post('/api/editor/runs/categories/apply', requireAdmin, (req, res) => {
    const apply = (req.body && req.body.apply) || [], dismiss = (req.body && req.body.dismiss) || [];
    const get = db.prepare('SELECT * FROM canon_category_proposals WHERE id = ?');
    let applied = 0; const kept = [];
    // A run never loses its last tag: removals are skipped when nothing else would remain (adds in this apply count).
    const props = apply.map(id => get.get(Number(id))).filter(Boolean);
    const tagsLeft = new Map();
    for (const p of props) {
      if (!tagsLeft.has(p.run_id)) tagsLeft.set(p.run_id, new Set(db.prepare('SELECT category FROM canon_run_categories WHERE run_id = ?').all(p.run_id).map(r => r.category)));
      if (p.action === 'remove') tagsLeft.get(p.run_id).delete(p.category); else tagsLeft.get(p.run_id).add(p.category);
    }
    db.transaction(() => {
      for (const p of props) {
        if (p.action === 'remove' && !tagsLeft.get(p.run_id).size) {
          const t = db.prepare('SELECT title FROM canon_runs WHERE id = ?').get(p.run_id);
          kept.push({ title: t ? t.title : `Run ${p.run_id}`, category: LABEL[p.category] });
          continue;   // proposal stays for another look
        }
        if (p.action === 'remove') db.prepare('DELETE FROM canon_run_categories WHERE run_id = ? AND category = ?').run(p.run_id, p.category);
        else db.prepare(`INSERT INTO canon_run_categories (run_id, category, adaptation_notes) VALUES (?,?,?)
          ON CONFLICT(run_id, category) DO UPDATE SET adaptation_notes = excluded.adaptation_notes`).run(p.run_id, p.category, p.notes);
        db.prepare('DELETE FROM canon_category_proposals WHERE id = ?').run(p.id);
        applied++;
      }
      for (const id of dismiss) db.prepare('DELETE FROM canon_category_proposals WHERE id = ?').run(Number(id));
    })();
    logger.info('canon', `Category proposals: ${applied} applied, ${dismiss.length} dismissed${kept.length ? `, ${kept.length} last-tag removal(s) kept` : ''}`);
    res.json({ ok: true, applied, dismissed: dismiss.length, kept });
  });

  return { promptFor, propose, checkBatch, tidyNotes, RESULT_SCHEMA, status: () => job };
};
module.exports.tidyNotes = tidyNotes;   // also used by the run generator's import (server.js)
module.exports.filterRunsByCategory = filterRunsByCategory;
module.exports.isBadge = isBadge;
