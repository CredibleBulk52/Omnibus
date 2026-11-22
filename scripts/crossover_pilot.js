#!/usr/bin/env node
'use strict';
// Crossover pilot (2026-11-21). Read-only for comics and Omnibus's data, except that every AI call is
// logged to ai_calls (source 'crossover-pilot') so its cost shows in Settings › AI Models › Usage.
//
// Question: can AI find small crossovers (one story continuing across two series, e.g. Green Lantern #40
// → Green Lantern Corps #22 "First Light") reliably and cheaply? Two ways are compared on the same books:
//   sweep    one Web Search question per publisher and month ("which issues continue a story across series?")
//   per-book one Web Search question per book
// Each answer goes through the same steps:
//   1. Web Search (task web_lookup, Omnibus's own lookup: plain question → notes + source pages)
//   2. a cheap model turns the notes into a list of stories and their issues (no search)
//   3. code: the source pages are downloaded (Omnibus's page reader) and each issue must be named on one of
//      them; the issues are matched to the library by name, number and release date; stories whose books
//      already share a Timeline are marked as such
// Nothing is decided by a model alone: a story counts only when the pages name its issues.
//
// Usage (in the container):
//   node /app/scripts/crossover_pilot.js --stage smoke            20 books + one DC month
//   node /app/scripts/crossover_pilot.js --stage full             the window's books + every month × publisher
//   options: --since 2026-08-21 --until 2026-11-21 --cap 5 (USD) --out /logs
const fs = require('node:fs');
const path = require('node:path');

const KNOWN = [   // crossovers we know: [label, [cv ids in reading order], expected]
  ['Green Lantern: First Light (GL #40 → GLC #22)', ['1197557', '1198794'], 'found'],
  ['Absolute Wonder Woman #15 → Absolute Batman #16', ['1149795', '1154054'], 'found'],
  ['The Starbreaker Supremacy (GL #25–27, GLC #7–9)', ['1121445', '1125381', '1128912', '1131757', '1134434', '1137149'], 'already a Timeline'],
];

function args(argv) {
  const a = { stage: 'smoke', since: null, until: null, cap: 5, out: '/logs', books: 100, lookupModel: null, sweep: true };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, ''), v = argv[i + 1];
    if (['stage', 'since', 'until', 'out'].includes(k)) { a[k] = v; i++; }
    else if (k === 'cap') { a.cap = Number(v); i++; }
    else if (k === 'books') { a.books = Number(v); i++; }
    else if (k === 'lookup-model') { a.lookupModel = v; i++; }
    else if (k === 'no-sweep') a.sweep = false;
  }
  const today = new Date().toISOString().slice(0, 10);
  a.until = a.until || today;
  a.since = a.since || new Date(Date.parse(a.until) - 92 * 86400000).toISOString().slice(0, 10);
  return a;
}

const norm = s => String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/&/g, ' and ').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
const tag = (xml, n) => { const m = new RegExp(`<${n}>([^<]*)</${n}>`).exec(xml || ''); return m ? m[1].trim() : ''; };
const num = s => String(s || '').trim().replace(/^#/, '').replace(/^0+(?=\d)/, '');
const days = (a, b) => (a && b ? Math.abs(Date.parse(a) - Date.parse(b)) / 86400000 : Infinity);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = ym => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

// ── The library ─────────────────────────────────────────────────────
function loadLibrary(db) {
  const books = db.prepare(`SELECT b.id, b.series_id, s.name AS series, s.year, b.issue_number, b.store_date, b.cv_issue_id, b.comicinfo, b.is_special
    FROM scanned_books b JOIN scanned_series s ON s.id = b.series_id`).all();
  const byName = new Map();
  for (const b of books) {
    b.publisher = tag(b.comicinfo, 'Publisher');
    const names = new Set([b.series, tag(b.comicinfo, 'Series')].filter(Boolean).map(n => n.replace(/\s*\(\d{4}.*?\)$/, '')));
    for (const n of names) {
      const k = `${norm(n)}|${num(b.issue_number)}`;
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(b);
    }
  }
  const events = new Map();
  try {
    for (const r of db.prepare(`SELECT ei.scanned_book_id AS b, e.id, e.name FROM event_issues ei JOIN events e ON e.id = ei.event_id
      WHERE COALESCE(e.draft, 0) = 0 AND ei.scanned_book_id IS NOT NULL`).all()) {
      if (!events.has(r.b)) events.set(r.b, new Map());
      events.get(r.b).set(r.id, r.name);
    }
  } catch { /* no events */ }
  return { books, byName, events, byCv: new Map(books.filter(b => b.cv_issue_id).map(b => [String(b.cv_issue_id), b])) };
}

// A part named by the AI ("Green Lantern Corps", 2025, "22") → the library book released nearest the anchor date (≤150 days).
function matchPart(lib, part, anchorDate) {
  const c = (lib.byName.get(`${norm(String(part.series || '').replace(/\s*\(\d{4}.*?\)$/, ''))}|${num(part.issue)}`) || [])
    .filter(b => !part.year || !b.year || Math.abs(Number(b.year) - Number(part.year)) <= 2 || days(b.store_date, anchorDate) <= 150);
  if (!c.length) return null;
  const best = c.slice().sort((x, y) => days(x.store_date, anchorDate) - days(y.store_date, anchorDate))[0];
  return days(best.store_date, anchorDate) <= 150 || !anchorDate ? best : null;
}

// ── Page evidence ───────────────────────────────────────────────────
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function namedOnPage(text, part) {
  const words = String(part.series || '').replace(/\s*\(\d{4}.*?\)$/, '').toLowerCase().replace(/&/g, 'and').split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return false;
  const n = num(part.issue);
  const name = words.map(esc).join('[^a-z0-9]{1,3}');
  const re = new RegExp(`${name}[^a-z0-9]{0,4}(?:(?:vol\\.?|volume)\\s*\\d+[^a-z0-9]{0,3}|\\(?\\d{4}(?:\\s*-\\s*\\d{0,4})?\\)?[^a-z0-9]{0,3})?(?:#|no\\.?\\s*|issue\\s*)0*${esc(n)}(?![0-9])`, 'i');
  // Fandom wikis name issues "Supergirl Vol 9 16" (no #): sample run 2026-11-21, Kingdom of Zod.
  const wiki = new RegExp(`${name}[\\s_]+vol[\\s_]+\\d+[\\s_]+0*${esc(n)}(?![0-9])`, 'i');
  const t = String(text).toLowerCase().replace(/&/g, 'and').replace(/[‘’]/g, "'");
  return re.test(t) || wiki.test(t);
}

// ── One question → stories ──────────────────────────────────────────
const EXTRACT = notes => `Below are notes from a web search about comic book crossovers. List only stories whose chapters run across two or more DIFFERENT series (for example part 1 in Green Lantern, part 2 in Green Lantern Corps). Leave out: guest appearances, a story told within one series, large line-wide events with many tie-ins, and anything the notes are unsure about.

Reply with JSON only, no other text:
{"stories":[{"name":"story name","parts":[{"series":"series name without the year","year":2025,"issue":"22","part":2}]}]}
Use "stories":[] when there are none. Keep the parts in reading order.

Notes:
${notes}`;

function parseJson(text) {
  const s = String(text || '').replace(/```(?:json)?/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function createPilot({ db, webLookup, ai, extractModel, readPage, axios, cap, logCost, lookupModel = null, log = console.log }) {
  const lib = loadLibrary(db);
  const pages = new Map();
  let spent = 0;
  const pageStats = { read: 0, failed: 0 };

  async function page(url) {
    if (pages.has(url)) return pages.get(url);
    let p;
    try { p = await readPage(url, { axios, maxChars: 80000 }); pageStats.read++; }
    catch (e) { p = { url, text: null, error: e.message }; pageStats.failed++; }
    pages.set(url, p);
    return p;
  }

  async function ask(question, anchorDate, label) {
    if (spent >= cap) return { label, skipped: 'cost cap reached' };
    const r = await webLookup.lookup(question, { detail: 'short', source: 'crossover-pilot', maxSources: 6, ...(lookupModel ? { model: lookupModel } : {}) });
    spent += r.cost || 0;
    const out = { label, question, model: r.model, grounded: r.grounded, sources: r.sources.map(s => s.url), notes: r.notes, stories: [], cost: r.cost || 0 };
    if (!r.grounded) { out.result = 'answered without searching (ignored)'; return out; }
    const x = await ai.complete({ model: extractModel, task: 'quick_answer', prompt: EXTRACT(r.notes), maxTokens: 1500, thinking: 'off', source: 'crossover-pilot' });
    const xc = logCost(x);
    spent += xc; out.cost += xc;
    const parsed = parseJson(x.text);
    if (!parsed) { out.result = 'could not read the extraction'; return out; }
    const texts = [];
    for (const u of out.sources.slice(0, 6)) { const p = await page(u); texts.push(p); }
    for (const st of parsed.stories || []) {
      const parts = (st.parts || []).map(p => {
        const onPage = texts.filter(t => t.text && namedOnPage(t.text, p)).map(t => t.url);
        const book = matchPart(lib, p, anchorDate);
        return { series: p.series, year: p.year || null, issue: num(p.issue), part: p.part || null, onPage: onPage.length > 0,
          pages: onPage.slice(0, 2), book: book ? { id: book.id, series: book.series, year: book.year, issue: book.issue_number, store: book.store_date } : null };
      });
      const seriesSet = new Set(parts.map(p => norm(p.series)));
      // A link between two neighbouring parts in different series counts only when ONE page names both
      // (smoke run 2026-11-21: separate pages each naming one issue, e.g. a shop's search page, prove nothing about the link).
      // Per page: the parts it names, in story order; neighbours among them in different series are linked.
      // (A wrongly added part, e.g. Corps #21 between Green Lantern #40 and Corps #22, then does not hide a
      // link that one page does prove.) Unproven neighbours are listed too, for the report.
      const linkMap = new Map();
      for (const t of texts) {
        if (!t.text) continue;
        const named = parts.map((p, i) => (namedOnPage(t.text, p) ? i : -1)).filter(i => i >= 0);
        for (let k = 0; k + 1 < named.length; k++) {
          const i = named[k], j = named[k + 1];
          if (norm(parts[i].series) === norm(parts[j].series)) continue;
          const key = `${i}|${j}`;
          if (!linkMap.has(key)) linkMap.set(key, { from: i, to: j, proven: true, page: t.url });
        }
      }
      for (let i = 0; i + 1 < parts.length; i++) {
        if (norm(parts[i].series) === norm(parts[i + 1].series) || linkMap.has(`${i}|${i + 1}`)) continue;
        if (![...linkMap.values()].some(l => l.from <= i && l.to >= i + 1)) linkMap.set(`${i}|${i + 1}`, { from: i, to: i + 1, proven: false, page: null });
      }
      const links = [...linkMap.values()].sort((a, b) => a.from - b.from || a.to - b.to);
      st.links = links;
      const provenSeries = new Set(links.filter(l => l.proven).length ? ['a', 'b'] : []);
      const inLib = parts.filter(p => p.book);
      let shared = null;
      if (inLib.length >= 2) {
        const sets = inLib.map(p => lib.events.get(p.book.id) || new Map());
        const common = [...sets[0].keys()].filter(id => sets.every(s => s.has(id)));
        if (common.length) shared = sets[0].get(common[0]);
      }
      const status = seriesSet.size < 2 ? 'one series only (not a crossover)'
        : provenSeries.size >= 2 ? (shared ? `proven, already a Timeline (${shared})` : inLib.length >= 2 ? 'proven' : 'proven, not two books in the library')
          : texts.every(t => !t.text) ? 'unproven: no page could be read' : 'unproven: pages do not name the issues';
      out.stories.push({ name: st.name || '', status, parts, links });
    }
    out.result = out.stories.length ? `${out.stories.length} stor${out.stories.length === 1 ? 'y' : 'ies'}` : 'none';
    return out;
  }

  const sweepQuestion = (publisher, ym) => `Which ${publisher} comics released in ${monthName(ym)} continue one story across two or more different ongoing series, with part 1 in one series and the next part in another? Do not count guest appearances, big line-wide events, or stories told within a single series. Name each story and every issue in it with its series, volume year and issue number.`;
  const bookQuestion = b => `Does the story in ${b.series}${b.year ? ` (${b.year})` : ''} #${num(b.issue_number)} (released ${b.store_date || 'recently'}${b.publisher ? `, ${b.publisher}` : ''}) continue in, or continue from, an issue of a different series? If so, name the story and every issue in it with its series, volume year and issue number. Guest appearances and big line-wide events do not count.`;

  return { lib, ask, sweepQuestion, bookQuestion, spent: () => spent, pageStats };
}

// Proven library pairs (consecutive parts in different series), as "idA|idB" sorted.
function provenPairs(answers) {
  const out = new Map();
  for (const a of answers) for (const st of a.stories || []) {
    if (!/^proven/.test(st.status)) continue;
    for (const l of st.links || []) {
      const a = st.parts[l.from].book, b = st.parts[l.to].book;
      if (!l.proven || !a || !b) continue;
      const k = [a.id, b.id].sort().join('|');
      if (!out.has(k)) out.set(k, { story: st.name, status: st.status, a, b, page: l.page });
    }
  }
  return out;
}

async function run(opts, deps) {
  const log = deps.log || console.log;
  const pilot = createPilot({ ...deps, cap: opts.cap, lookupModel: opts.lookupModel });
  const { lib } = pilot;
  const inWindow = lib.books.filter(b => b.store_date && b.store_date >= opts.since && b.store_date <= opts.until);
  const known = KNOWN.map(([label, cvs, expected]) => ({ label, expected, books: cvs.map(c => lib.byCv.get(c)).filter(Boolean) }));
  const knownBooks = [...new Set(known.flatMap(k => k.books))];
  let bookList, sweeps;
  const pubCount = new Map();
  for (const b of inWindow) if (b.publisher) pubCount.set(b.publisher, (pubCount.get(b.publisher) || 0) + 1);
  if (opts.stage === 'smoke') {
    const rest = inWindow.filter(b => !knownBooks.includes(b)).sort((x, y) => x.id.localeCompare(y.id)).filter((_, i) => i % 7 === 0).slice(0, 20 - Math.min(knownBooks.length, 4));
    bookList = [...knownBooks.filter(b => ['1197557', '1198794', '1149795', '1154054'].includes(String(b.cv_issue_id))), ...rest];
    sweeps = [['DC Comics', '2026-10']];
  } else if (opts.stage === 'sample') {
    // A spread of the window's books plus the known cases (First Light, the Absolute pair, two Starbreaker books).
    const keep = ['1197557', '1198794', '1149795', '1154054', '1125381', '1134434'];
    const fixed = knownBooks.filter(b => keep.includes(String(b.cv_issue_id)));
    const rest = inWindow.filter(b => !fixed.includes(b)).sort((x, y) => x.id.localeCompare(y.id));
    const n = Math.max(0, opts.books - fixed.length), step = Math.max(1, Math.floor(rest.length / Math.max(1, n)));
    bookList = [...fixed, ...rest.filter((_, i) => i % step === 0).slice(0, n)];
    sweeps = [];
  } else {
    bookList = [...new Set([...inWindow, ...knownBooks])];
    const months = new Set(inWindow.map(b => b.store_date.slice(0, 7)));
    for (const b of knownBooks) months.add(b.store_date.slice(0, 7));
    const pubs = [...pubCount].filter(([, n]) => n >= 10).map(([p]) => p);
    sweeps = [];
    for (const m of [...months].sort()) for (const p of pubs) {
      const forKnownOnly = !inWindow.some(b => b.store_date.slice(0, 7) === m);
      if (forKnownOnly && !/^DC/i.test(p)) continue;    // months outside the window: only DC (the known cases)
      sweeps.push([p, m]);
    }
  }
  if (!opts.sweep) sweeps = [];
  log(`Window ${opts.since} – ${opts.until}: ${inWindow.length} books; this run: ${bookList.length} per-book questions, ${sweeps.length} sweep questions; cap $${opts.cap}`);

  const sweepAnswers = [];
  for (const [p, m] of sweeps) {
    const a = await pilot.ask(pilot.sweepQuestion(p, m), `${m}-15`, `sweep ${p} ${m}`);
    sweepAnswers.push(a);
    log(`sweep ${p} ${m}: ${a.result || a.skipped} ($${pilot.spent().toFixed(3)} so far)`);
  }
  const bookAnswers = [];
  for (const [i, b] of bookList.entries()) {
    const a = await pilot.ask(pilot.bookQuestion(b), b.store_date, `book ${b.series} (${b.year}) #${b.issue_number}`);
    a.bookId = b.id;
    bookAnswers.push(a);
    if (a.skipped) { log(`stopped at book ${i + 1}: ${a.skipped}`); break; }
    if ((i + 1) % 10 === 0 || a.stories?.some(s => /^proven/.test(s.status))) log(`[${i + 1}/${bookList.length}] ${a.label}: ${a.result} ($${pilot.spent().toFixed(3)} so far)`);
  }

  const S = provenPairs(sweepAnswers), B = provenPairs(bookAnswers);
  const asked = new Set(bookAnswers.filter(a => !a.skipped).map(a => a.bookId));
  const bothAsked = [...B.keys()].filter(k => k.split('|').some(id => asked.has(id)));
  const sweepHits = bothAsked.filter(k => S.has(k)).length;
  const statusCount = (answers) => {
    const c = {};
    for (const a of answers) for (const st of a.stories || []) c[st.status] = (c[st.status] || 0) + 1;
    return c;
  };
  const knownResult = known.map(k => {
    const ids = k.books.map(b => b.id);
    const pairsOf = M => [...M.keys()].filter(key => key.split('|').every(id => ids.includes(id)));
    return { label: k.label, expected: k.expected, inLibrary: k.books.length,
      sweep: pairsOf(S).map(key => S.get(key).status), perBook: pairsOf(B).map(key => B.get(key).status) };
  });
  const report = {
    window: [opts.since, opts.until], stage: opts.stage, cost: pilot.spent(), pages: pilot.pageStats,
    sweep: { questions: sweepAnswers.length, ungrounded: sweepAnswers.filter(a => a.grounded === false).length, stories: statusCount(sweepAnswers), provenPairs: S.size },
    perBook: { questions: bookAnswers.filter(a => !a.skipped).length, ungrounded: bookAnswers.filter(a => a.grounded === false).length, stories: statusCount(bookAnswers), provenPairs: B.size },
    sweepFoundOfPerBook: `${sweepHits} of ${bothAsked.length}`,
    known: knownResult,
    pairs: {
      both: [...B.keys()].filter(k => S.has(k)).map(k => B.get(k)),
      perBookOnly: [...B.keys()].filter(k => !S.has(k)).map(k => B.get(k)),
      sweepOnly: [...S.keys()].filter(k => !B.has(k)).map(k => S.get(k)),
    },
    answers: { sweep: sweepAnswers, perBook: bookAnswers },
  };
  return report;
}

function summary(r) {
  const L = [];
  const pair = p => `${p.a.series} (${p.a.year}) #${p.a.issue} ↔ ${p.b.series} (${p.b.year}) #${p.b.issue}  [${p.story}; ${p.status}; ${p.page}]`;
  L.push(`Crossover pilot, ${r.stage}: ${r.window[0]} – ${r.window[1]}. Cost $${r.cost.toFixed(3)}. Pages read ${r.pages.read}, unreadable ${r.pages.failed}.`);
  L.push(`Sweep: ${r.sweep.questions} questions (${r.sweep.ungrounded} answered without searching), stories ${JSON.stringify(r.sweep.stories)}, proven library pairs ${r.sweep.provenPairs}.`);
  L.push(`Per book: ${r.perBook.questions} questions (${r.perBook.ungrounded} without searching), stories ${JSON.stringify(r.perBook.stories)}, proven library pairs ${r.perBook.provenPairs}.`);
  L.push(`Sweep found ${r.sweepFoundOfPerBook} of the pairs the per-book questions proved.`);
  L.push('', 'Known crossovers:');
  for (const k of r.known) L.push(`  ${k.label} (expected: ${k.expected}; ${k.inLibrary} books in library): sweep ${k.sweep.length ? k.sweep.join(', ') : 'not found'} | per book ${k.perBook.length ? k.perBook.join(', ') : 'not found'}`);
  L.push('', 'Proven by both:'); for (const p of r.pairs.both) L.push(`  ${pair(p)}`);
  L.push('', 'Per book only:'); for (const p of r.pairs.perBookOnly) L.push(`  ${pair(p)}`);
  L.push('', 'Sweep only:'); for (const p of r.pairs.sweepOnly) L.push(`  ${pair(p)}`);
  L.push('', 'Unproven stories (for checking false negatives of the page check):');
  for (const a of [...r.answers.sweep, ...r.answers.perBook]) for (const st of a.stories || []) {
    if (/^proven/.test(st.status) || /one series/.test(st.status)) continue;
    L.push(`  ${a.label}: ${st.name} — ${st.status}: ${st.parts.map(p => `${p.series} #${p.issue}${p.onPage ? '✓' : ''}`).join(' → ')}`);
  }
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
  const aiModels = req('ai/aiModels');
  const catalog = req('modelCatalog');
  const routing = aiModels.createModelRouting(getSetting, { hasProvider: p => !!(keys[p] && keys[p]()) });
  const insert = db.prepare(`INSERT INTO ai_calls (at, day, task, tier, provider, model, source, ok, error, ms, input_tokens, output_tokens, cache_read, cache_write, web_searches, job_id, thinking_tokens, run_id, cost, request_id)
    VALUES (@at, @day, @task, @tier, @provider, @model, @source, @ok, @error, @ms, @input_tokens, @output_tokens, @cache_read, @cache_write, @web_searches, @job_id, @thinking_tokens, @run_id, @cost, NULL)`);
  const onCall = e => {
    const at = Date.now();
    const row = { at, day: new Date(at).toISOString().slice(0, 10), task: e.task || null, tier: null, provider: e.provider || 'anthropic', model: e.model || '',
      source: 'crossover-pilot', ok: e.ok ? 1 : 0, error: e.error || null, ms: e.ms || 0, input_tokens: e.input_tokens || 0, output_tokens: e.output_tokens || 0,
      cache_read: e.cache_read || 0, cache_write: e.cache_write || 0, web_searches: e.web_searches || 0, job_id: e.job_id || null,
      thinking_tokens: typeof e.thinking_tokens === 'number' ? e.thinking_tokens : null, run_id: null, cost: null };
    try { row.cost = catalog.estimateCost(row.model, row); } catch { row.cost = null; }
    try { insert.run(row); } catch { /* logging only */ }
  };
  const ai = req('ai/aiClient').createAiClient({ axios, getAnthropicKey: keys.anthropic, getOpenAIKey: keys.openai, getGeminiKey: keys.gemini,
    modelFor: id => routing.modelFor(id), pick: id => routing.pick(id), logger: null, onCall });
  const webLookup = req('ai/webLookup').createWebLookup({ ai, modelCatalog: catalog, logger: null });
  const { readPage } = req('ai/pageReader');
  const extractModel = keys.anthropic() ? 'claude-haiku-5-5' : routing.modelFor('quick_answer');
  const logCost = x => { const u = x.usage || {}; try { return catalog.estimateCost(x.model, { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0 }) || 0; } catch { return 0; } };
  const stamp = () => new Date().toISOString().slice(11, 19);
  const report = await run(opts, { db, webLookup, ai, extractModel, readPage, axios, logCost, log: m => console.log(`${stamp()} ${m}`) });
  const base = path.join(opts.out, `crossover-pilot-${opts.stage}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 1));
  fs.writeFileSync(`${base}.txt`, summary(report));
  console.log(`\n${summary(report).split('\nProven by both:')[0]}\n\nFull report: ${base}.txt (and .json)`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { createPilot, run, summary, namedOnPage, matchPart, parseJson, provenPairs, loadLibrary };
