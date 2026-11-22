#!/usr/bin/env node
'use strict';
// Crossover backfill test (2026-11-22). Read-only for comics and Omnibus's data, except that every AI
// call is logged to ai_calls (source 'crossover-test') so its cost and searches show in Usage.
//
// Question: for older issues (2000 to six months ago), is one Web Search question per series VOLUME as
// good as one per ISSUE? Searches are the cost that matters: Gemini ran 3.3 searches per issue in the
// first web check (Google: 5,000 free a month, then $14 per 1,000). Only "mainstay" volumes are used:
// DC or Marvel, 12+ issues, part of a saved Timeline (97% of known crossover links have an issue in one).
// Both ways use the same rule as the app: a link counts only when ONE source page names both issues.
//
// "Per volume" is asked per two years of a volume (one answer cannot cover a long run).
//   node /app/scripts/crossover_backfill_test.js                    25 volumes, 4 issues each, cap $1
//   options: --volumes 25 --issues 4 --cap 1 --seed 7 --out /logs
const fs = require('node:fs');
const path = require('node:path');

function args(argv) {
  const a = { volumes: 25, issues: 4, cap: 1, seed: 7, out: '/logs' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, ''), v = argv[i + 1];
    if (k in a) { a[k] = k === 'out' ? v : Number(v); i++; }
  }
  return a;
}
const rng = seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const shuffle = (list, r) => list.map(x => [r(), x]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
const MATURE = /vertigo|black label|\bmax\b|\bicon\b|wildstorm|young animal|hill house|sandman universe|\bepic\b|america.s best/i;

// One Web Search question with room for a list (webLookup's 'short' asks for under 200 words).
async function lookup(ai, catalog, question, words) {
  const r = await ai.complete({ task: 'web_lookup', prompt: `Answer this comics question from web sources: ${question}\n\nSearch with focused queries. Prefer pages that answer it directly (wiki story-arc, series and issue pages, reading orders, reviews). Answer in under ${words} words, naming every issue with its series, volume year and issue number. Say plainly when you could not confirm something. Do not list sources in the text.`,
    maxTokens: words > 250 ? 2400 : 1200, webSearch: 2, timeout: 120000, source: 'crossover-test' });
  const content = Array.isArray(r.data?.content) ? r.data.content : [];
  const seen = new Set(), sources = [];
  for (const b of content) {
    if (b.type !== 'web_search_tool_result' || !Array.isArray(b.content)) continue;
    for (const x of b.content) if (x?.url && !seen.has(x.url)) { seen.add(x.url); sources.push(x.url); }
  }
  const u = r.usage || {}, searches = u.server_tool_use?.web_search_requests || 0;
  const cost = catalog.estimateCost(r.model, { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, web_searches: searches }) || 0;
  return { notes: String(r.text || '').trim(), sources, searches, grounded: searches > 0 || sources.length > 0, cost, model: r.model };
}

async function run(opts, { db, ai, catalog, readPage, axios, C, T, log }) {
  const r = rng(opts.seed);
  const lib = C.loadLibrary(db);
  const until = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const inEvent = new Set(db.prepare(`SELECT ei.scanned_book_id AS b FROM event_issues ei JOIN events e ON e.id = ei.event_id
    WHERE COALESCE(e.draft, 0) = 0 AND ei.scanned_book_id IS NOT NULL`).all().map(x => x.b));
  const imprint = new Map(db.prepare(`SELECT id, CASE WHEN instr(comicinfo, '<Imprint>') > 0 THEN substr(comicinfo, instr(comicinfo, '<Imprint>') + 9,
    instr(comicinfo, '</Imprint>') - instr(comicinfo, '<Imprint>') - 9) END AS imp FROM scanned_books`).all().map(x => [x.id, x.imp || '']));

  // Mainstay volumes: books grouped by folder; DC or Marvel, 12+ dated issues before `until`, one in a Timeline.
  const vols = new Map();
  for (const b of lib.books) {
    if (!vols.has(b.series_id)) vols.set(b.series_id, { id: b.series_id, books: [] });
    vols.get(b.series_id).books.push(b);
  }
  const mainstay = [];
  for (const v of vols.values()) {
    const own = v.books.filter(b => b.cv_issue_id && b.store_date && b.store_date >= '2000-01-01' && b.store_date < until);
    if (own.length < 12 || !v.books.some(b => inEvent.has(b.id))) continue;
    if (own.filter(b => inEvent.has(b.id)).length >= own.length / 2) continue;   // an event's own series (Venom War)
    const pub = own.filter(b => /^(DC Comics|Marvel)/.test(b.publisher)).length;
    if (pub < own.length / 2 || own.some(b => MATURE.test(imprint.get(b.id)))) continue;
    own.sort((a, b) => a.store_date.localeCompare(b.store_date));
    const name = own[0].series, folder = own[0].folder, year = own[0].year;
    mainstay.push({ id: v.id, name, folder, year, publisher: own[0].publisher, first: own[0].store_date, last: own.at(-1).store_date, books: own,
      ask: own.filter(b => !inEvent.has(b.id)) });
  }
  // Known links (summary + the first web check): both books owned, neither in a Timeline.
  // Links with an issue in a Timeline are left out: Timelines cover them, and the backfill skips those issues.
  const known = db.prepare(`SELECT from_book_id AS a, to_book_id AS b, source FROM crossover_links WHERE from_book_id IS NOT NULL AND to_book_id IS NOT NULL AND hidden = 0`).all()
    .filter(k => !inEvent.has(k.a) && !inEvent.has(k.b));
  const knownBy = new Map();
  for (const k of known) for (const id of [k.a, k.b]) { if (!knownBy.has(id)) knownBy.set(id, []); knownBy.get(id).push(k); }
  const hasKnown = v => v.books.some(b => knownBy.has(b.id));

  // 25 volumes across three eras; half with a known link (to measure what each way finds), half without.
  const era = v => (v.first < '2010' ? 0 : v.first < '2020' ? 1 : 2);
  const per = [Math.floor(opts.volumes / 3), Math.floor(opts.volumes / 3), opts.volumes - 2 * Math.floor(opts.volumes / 3)];
  const chosen = [];
  for (let e = 0; e < 3; e++) {
    const pool = shuffle(mainstay.filter(v => era(v) === e), r);
    const withK = pool.filter(hasKnown), without = pool.filter(v => !hasKnown(v));
    const k = Math.ceil(per[e] / 2);
    chosen.push(...withK.slice(0, k), ...without.slice(0, per[e] - Math.min(k, withK.length)));
  }
  log(`${mainstay.length} mainstay volumes (2000 – ${until}); testing ${chosen.length}`);

  const pages = new Map();
  const page = async url => {
    if (!pages.has(url)) {
      let p; try { p = await readPage(url, { axios, maxChars: 80000 }); } catch { p = null; }
      pages.set(url, { url, text: p?.text || null });
    }
    return pages.get(url);
  };
  let spent = 0;
  const totals = { volume: { questions: 0, searches: 0, cost: 0 }, issue: { questions: 0, searches: 0, cost: 0 } };

  async function ask(kind, question, words, anchorFor) {
    if (spent >= opts.cap) return { skipped: 'cost cap' };
    const l = await lookup(ai, catalog, question, words);
    const t = totals[kind];
    t.questions++; t.searches += l.searches; t.cost += l.cost; spent += l.cost;
    if (!l.grounded) return { searches: l.searches, links: [], result: 'no search' };
    const x = await ai.complete({ task: 'crossover_check', prompt: C.EXTRACT(l.notes), maxTokens: 3000, thinking: 'off', source: 'crossover-test' });
    const u = x.usage || {};
    const xc = catalog.estimateCost(x.model, { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0 }) || 0;
    t.cost += xc; spent += xc;
    const parsed = T.parseJson(x.text);
    if (!parsed) return { searches: l.searches, links: [], result: 'unreadable reply' };
    const texts = [];
    for (const u2 of l.sources.slice(0, 10)) texts.push(await page(u2));
    const links = [];
    for (const p of C.provenLinks(parsed.stories || [], texts)) {
      const anchor = anchorFor(p);
      if (!anchor) continue;
      const row = C.linkRow(lib, p, anchor);
      if (row?.from && row?.to) links.push({ a: row.from.id, b: row.to.id, story: row.story, page: row.proof });
      else if (row) links.push({ a: row.from?.id || null, b: row.to?.id || null, missing: row.from ? `${row.toName.series} #${row.toName.issue}` : `${row.fromName.series} #${row.fromName.issue}`, story: row.story, page: row.proof });
    }
    return { searches: l.searches, links, stories: (parsed.stories || []).length, result: `${links.length} links` };
  }

  const results = [];
  for (const v of chosen) {
    // In the volume: the end of a link that is one of its issues gives the date to match the other end by.
    const anchorIn = p => {
      for (const end of [p.from, p.to]) {
        const b = lib.find(end.series, end.issue).find(x => x.series_id === v.id);
        if (b) return b.store_date;
      }
      return null;
    };
    // One question per two years of the volume: a 400-word answer cannot cover 140 issues of Action Comics.
    const vr = { searches: 0, links: [], parts: [] };
    for (let i = 0; i < v.books.length;) {
      const end = new Date(Date.parse(v.books[i].store_date) + 730 * 86400000).toISOString().slice(0, 10);
      let j = i; while (j < v.books.length && v.books[j].store_date < end) j++;
      const part = { ...v, first: v.books[i].store_date, last: v.books[j - 1].store_date };
      const pr = await ask('volume', C.volumeQuestion(part), 400, anchorIn);
      vr.searches += pr.searches || 0; vr.links.push(...(pr.links || [])); vr.parts.push(`${part.first.slice(0, 7)}–${part.last.slice(0, 7)} ${pr.result || pr.skipped}`);
      if (pr.skipped) { vr.skipped = pr.skipped; break; }
      i = j;
    }
    vr.result = `${vr.links.length} links in ${vr.parts.length} question${vr.parts.length === 1 ? '' : 's'}`;
    // The same volume per issue: its known-link issues (up to half) and others at random.
    const withK = shuffle(v.ask.filter(b => knownBy.has(b.id)), r), rest = shuffle(v.ask.filter(b => !knownBy.has(b.id)), r);
    const sample = [...withK.slice(0, Math.ceil(opts.issues / 2)), ...rest].slice(0, opts.issues);
    const ir = [];
    for (const b of sample) {
      const res = await ask('issue', C.bookQuestion(b), 200, () => b.store_date);
      ir.push({ book: b.id, label: `${b.series} #${b.issue_number}`, ...res });
    }
    const knownHere = known.filter(k => v.books.some(b => b.id === k.a || b.id === k.b));
    results.push({ volume: `${v.folder} (${v.year})`, id: v.id, first: v.first, last: v.last, issues: v.books.length, known: knownHere.length, perVolume: vr, perIssue: ir });
    log(`${v.folder} (${v.year}): volume ${vr.result || vr.skipped} (${vr.searches ?? 0} searches); issues ${ir.map(x => x.result || x.skipped).join(', ')}  [$${spent.toFixed(3)}]`);
    if (spent >= opts.cap) { log('cost cap reached'); break; }
  }

  // Compare: pairs as "a|b" (sorted); known pairs; per-issue pairs only for the issues asked.
  const key = l => [l.a, l.b].sort().join('|');
  const knownSet = new Set(known.map(key));
  const label = id => { const b = lib.byId.get(id); return b ? `${b.series} (${b.year}) #${b.issue_number} [${b.store_date}]` : id; };
  const summary = { volumes: results.length, totals, searchesPerVolume: totals.volume.searches / Math.max(1, totals.volume.questions),
    searchesPerIssue: totals.issue.searches / Math.max(1, totals.issue.questions) };
  const rows = [];
  let knownInVolumes = 0, knownFoundByVolume = 0, issueFound = 0, issueFoundAlsoByVolume = 0, knownOnAsked = 0, knownFoundByIssue = 0;
  for (const res of results) {
    const vPairs = new Set((res.perVolume.links || []).filter(l => l.a && l.b).map(key));
    const kHere = known.filter(k => [k.a, k.b].some(id => lib.byId.get(id)?.series_id === res.id));
    knownInVolumes += kHere.length;
    knownFoundByVolume += kHere.filter(k => vPairs.has(key(k))).length;
    for (const ir of res.perIssue) {
      const iPairs = new Set((ir.links || []).filter(l => l.a && l.b).map(key));
      const kAsked = known.filter(k => k.a === ir.book || k.b === ir.book);
      knownOnAsked += kAsked.length;
      knownFoundByIssue += kAsked.filter(k => iPairs.has(key(k))).length;
      for (const p of iPairs) { issueFound++; if (vPairs.has(p)) issueFoundAlsoByVolume++; }
    }
    for (const [how, links] of [['volume', res.perVolume.links || []], ...res.perIssue.map(ir => [`issue ${ir.label}`, ir.links || []])]) {
      for (const l of links) rows.push({ volume: res.volume, how, known: l.a && l.b ? knownSet.has(key(l)) : false,
        link: l.a && l.b ? `${label(l.a)} → ${label(l.b)}` : `${label(l.a || l.b)} ⇄ ${l.missing} (not owned)`, story: l.story, page: l.page });
    }
  }
  Object.assign(summary, { knownInVolumes, knownFoundByVolume, knownOnAskedIssues: knownOnAsked, knownFoundByIssue, issueFound, issueFoundAlsoByVolume,
    newByVolume: rows.filter(x => x.how === 'volume' && !x.known).length, newByIssue: rows.filter(x => x.how !== 'volume' && !x.known).length, cost: spent });
  return { summary, rows, results };
}

function text(rep) {
  const s = rep.summary, L = [];
  L.push(`Crossover backfill test: ${s.volumes} mainstay volumes. Cost $${s.cost.toFixed(3)} (searches not charged: within Google's free 5,000 a month).`);
  L.push(`Per volume: ${s.totals.volume.questions} questions, ${s.totals.volume.searches} searches (${s.searchesPerVolume.toFixed(1)} each), $${s.totals.volume.cost.toFixed(3)}.`);
  L.push(`Per issue:  ${s.totals.issue.questions} questions, ${s.totals.issue.searches} searches (${s.searchesPerIssue.toFixed(1)} each), $${s.totals.issue.cost.toFixed(3)}.`);
  L.push(`Known links in these volumes: ${s.knownInVolumes}; found by the volume questions: ${s.knownFoundByVolume}.`);
  L.push(`Known links on the issues asked one by one: ${s.knownOnAskedIssues}; found by those questions: ${s.knownFoundByIssue}.`);
  L.push(`Links the issue questions proved: ${s.issueFound}; also proved by the volume question: ${s.issueFoundAlsoByVolume}.`);
  L.push(`New links (not known before): by volume ${s.newByVolume}, by issue ${s.newByIssue}. Check these by hand:`, '');
  for (const x of rep.rows.filter(r => !r.known)) L.push(`  [${x.how}] ${x.link}  — ${x.story || ''}  ${x.page || ''}`);
  L.push('', 'Known links found again:');
  for (const x of rep.rows.filter(r => r.known)) L.push(`  [${x.how}] ${x.link}`);
  L.push('', 'Volumes:');
  for (const r of rep.results) L.push(`  ${r.volume} ${r.first}–${r.last}, ${r.issues} issues, ${r.known} known links: volume ${r.perVolume.result || r.perVolume.skipped}; issues ${r.perIssue.map(i => `${i.label} ${i.result || i.skipped}`).join('; ')}`);
  return L.join('\n');
}

async function main() {
  const opts = args(process.argv);
  const backend = process.env.OMNIBUS_BACKEND || path.join(__dirname, '..', 'backend');
  const req = m => require(path.join(backend, m));
  const Database = req('node_modules/better-sqlite3');
  const axios = req('node_modules/axios');
  const db = new Database(process.env.DB_PATH || '/appdata/omnibus.db');
  db.pragma('busy_timeout = 10000');
  const secrets = req('secrets').create();
  const getSetting = k => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? (secrets.isSecret(k) ? secrets.open(r.value, k) : r.value) : null; };
  const keys = { anthropic: () => getSetting('anthropic_api_key') || process.env.ANTHROPIC_API_KEY || '',
    openai: () => getSetting('openai_api_key') || process.env.OPENAI_API_KEY || '', gemini: () => getSetting('gemini_api_key') || process.env.GEMINI_API_KEY || '' };
  const catalog = req('modelCatalog');
  const routing = req('ai/aiModels').createModelRouting(getSetting, { hasProvider: p => !!(keys[p] && keys[p]()) });
  const insert = db.prepare(`INSERT INTO ai_calls (at, day, task, tier, provider, model, source, ok, error, ms, input_tokens, output_tokens, cache_read, cache_write, web_searches, job_id, thinking_tokens, run_id, cost, request_id)
    VALUES (@at, @day, @task, NULL, @provider, @model, 'crossover-test', @ok, @error, @ms, @input_tokens, @output_tokens, @cache_read, @cache_write, @web_searches, @job_id, @thinking_tokens, NULL, @cost, NULL)`);
  const onCall = e => {
    const at = Date.now();
    const row = { at, day: new Date(at).toISOString().slice(0, 10), task: e.task || null, provider: e.provider || 'anthropic', model: e.model || '', ok: e.ok ? 1 : 0, error: e.error || null,
      ms: e.ms || 0, input_tokens: e.input_tokens || 0, output_tokens: e.output_tokens || 0, cache_read: e.cache_read || 0, cache_write: e.cache_write || 0,
      web_searches: e.web_searches || 0, job_id: e.job_id || null, thinking_tokens: typeof e.thinking_tokens === 'number' ? e.thinking_tokens : null, cost: null };
    try { row.cost = catalog.estimateCost(row.model, row); } catch { row.cost = null; }
    try { insert.run(row); } catch { /* logging only */ }
  };
  const ai = req('ai/aiClient').createAiClient({ axios, getAnthropicKey: keys.anthropic, getOpenAIKey: keys.openai, getGeminiKey: keys.gemini,
    modelFor: id => routing.modelFor(id), pick: id => routing.pick(id), logger: null, onCall });
  const stamp = () => new Date().toISOString().slice(11, 19);
  const rep = await run(opts, { db, ai, catalog, readPage: req('ai/pageReader').readPage, axios, C: req('crossovers'), T: req('crossoverText'), log: m => console.log(`${stamp()} ${m}`) });
  const base = path.join(opts.out, 'crossover-backfill-test');
  fs.writeFileSync(`${base}.json`, JSON.stringify(rep, null, 1));
  fs.writeFileSync(`${base}.txt`, text(rep));
  console.log(`\n${text(rep).split('\nKnown links found again:')[0]}\n\nFull report: ${base}.txt (and .json)`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { run, text };
