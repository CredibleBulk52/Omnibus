'use strict';
// ─── Story arcs and stretch summaries for recaps (RECAPS_DESIGN.md) ───────
// Groups a run of issues into story arcs, cheapest evidence first (user 2026-10-19):
//   1. arc names with part numbers in the issues' titles ("War of the Green Lanterns, Part Three")
//   2. Comic Vine story arcs, for issues the titles leave ungrouped (looked up once, stored; capped per plan)
//   3. writer changes as run boundaries (99% of issues carry a Writer); what is left becomes blocks of up to 6 issues
// A group's summary is free when every issue already has a synopsis; otherwise one
// web search (task recap_web) writes it, stored per exact issue range.

const BLOCK_MAX = 6;
const SEARCH_FEE = 0.01;
const RETRY_MISSING_DAYS = 30;

const WORDNUM = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[0-9]+|[ivxlc]+';
const PART_RE = new RegExp(`^(.*?)(?:^|\\s*[,:;.\\-–—(]\\s*|\\s+)(?:part|chapter|book|act|episode|pt\\.?)\\s+(${WORDNUM})\\b`, 'i');
const OF_RE = /^(.*?)[,:]?\s+(\d+)\s*(?:of|\/)\s*\d+\s*\)?\s*$/i;

const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();

const decode = s => String(s || '').replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// { name, part } from an issue title; name null when the title is only "Part Two".
// Several stories ("The Jury Conclusion; Deb Donovan in …"): the first one counts.
// "… Conclusion" / "… Finale" / "… Prologue" end or open the arc of that name.
function arcFromTitle(title) {
  const t = decode(title).replace(/\s+/g, ' ').trim().split(/\s*;\s*/)[0];
  if (!t) return null;
  let m = t.match(PART_RE);
  if (m) { const name = m[1].replace(/[\s,:;.\-–—(]+$/, '').replace(/^["“']|["”']$/g, '').trim(); return { name: name || null, part: m[2] }; }
  m = t.match(OF_RE);
  if (m && m[1].trim()) return { name: m[1].replace(/[\s,:;(]+$/, '').trim(), part: m[2] };
  m = t.match(/^(.*?)[\s,:\-–—]+(conclusion|finale|epilogue|prologue|begins)\.?$/i);
  if (m && m[1].trim().length >= 3) return { name: m[1].replace(/[\s,:;\-–—]+$/, '').trim(), part: m[2].toLowerCase() };
  return null;
}

const firstWriter = ci => {
  const m = String(ci || '').match(/<Writer>([\s\S]*?)<\/Writer>/);
  return m ? norm(m[1].split(/[,;&]| and /)[0]) : '';
};
const writersOf = ci => {
  const m = String(ci || '').match(/<Writer>([\s\S]*?)<\/Writer>/);
  return m ? m[1].replace(/&amp;/g, '&').split(/[,;]/).map(s => s.trim()).filter(Boolean) : [];
};

// Contiguous stretches by first-listed writer; a 1–2 issue fill-in between the
// same writer's issues stays inside the run.
function writerRuns(books) {
  const segs = [];
  for (const b of books) {
    const w = b.writer_key || '';
    const last = segs[segs.length - 1];
    if (last && last.writer_key === w) last.books.push(b); else segs.push({ writer_key: w, books: [b] });
  }
  for (let k = 1; k < segs.length - 1; k++) {
    if (segs[k].books.length <= 2 && segs[k - 1].writer_key && segs[k - 1].writer_key === segs[k + 1].writer_key) {
      segs[k - 1].books.push(...segs[k].books, ...segs[k + 1].books);
      segs.splice(k, 2); k--;
    }
  }
  return segs;
}

function createArcs({ db, ai, logger, cvApiGet, getCVKey, modelCatalog, axios = null, webLookup = null, readPage = require('../ai/pageReader').readPage, now = () => Date.now() }) {
  // Two-step stretch summaries (2026-10-21), as for single issues: Web Search finds pages, Omnibus
  // downloads them, the Summary Writer writes. One step (the writer searching itself) only when page
  // downloads are not configured: with Gemini as writer it cost 13¢ for three stretches and may answer from memory.
  const finder = webLookup || (axios ? require('../ai/webLookup').createWebLookup({ ai, modelCatalog, logger }) : null);
  db.exec(`CREATE TABLE IF NOT EXISTS issue_story_arcs (
    cv_issue_id TEXT PRIMARY KEY, arcs TEXT, fetched_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS arc_summaries (
    arc_key TEXT PRIMARY KEY,               -- series/context + exact first and last issue
    label TEXT, status TEXT NOT NULL,       -- ok | missing
    summary TEXT, source TEXT, source_url TEXT, model TEXT, confidence TEXT,
    est_cost REAL DEFAULT 0, created_at INTEGER NOT NULL, retry_after INTEGER
  )`);
  const getArcs = db.prepare('SELECT arcs FROM issue_story_arcs WHERE cv_issue_id = ?');
  const putArcs = db.prepare('INSERT OR REPLACE INTO issue_story_arcs (cv_issue_id, arcs, fetched_at) VALUES (?, ?, ?)');
  const getSum = db.prepare('SELECT * FROM arc_summaries WHERE arc_key = ?');
  const putSum = db.prepare(`INSERT INTO arc_summaries (arc_key, label, status, summary, source, source_url, model, confidence, est_cost, created_at, retry_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(arc_key) DO UPDATE SET label = excluded.label, status = excluded.status, summary = excluded.summary,
    source = excluded.source, source_url = excluded.source_url, model = excluded.model, confidence = excluded.confidence,
    est_cost = arc_summaries.est_cost + excluded.est_cost, created_at = excluded.created_at, retry_after = excluded.retry_after`);

  const cachedCvArcs = cv => { if (!cv) return null; const r = getArcs.get(String(cv)); if (!r) return null; try { return JSON.parse(r.arcs) || []; } catch { return []; } };

  // Comic Vine story arcs for up to `budget` issues not looked up before. Free in
  // money, about a second each; results are kept.
  async function lookupCvArcs(books, budget) {
    if (!cvApiGet || !getCVKey || !getCVKey()) return 0;
    let used = 0;
    for (const b of books) {
      if (used >= budget) break;
      if (!b.cv_issue_id || getArcs.get(String(b.cv_issue_id))) continue;
      used++;
      try {
        const r = await cvApiGet(`https://comicvine.gamespot.com/api/issue/4000-${b.cv_issue_id}/`, {
          params: { api_key: getCVKey(), format: 'json', field_list: 'id,story_arc_credits' }, headers: { 'User-Agent': 'Omnibus/1.0' } });
        const arcs = (r.data?.results?.story_arc_credits || []).map(a => ({ id: a.id, name: a.name }));
        putArcs.run(String(b.cv_issue_id), JSON.stringify(arcs), now());
      } catch (e) {
        logger?.warn?.('recaps', 'Comic Vine story arc lookup failed', { cv: b.cv_issue_id, error: e.message });
        break;   // rate limit or outage: group the rest without it
      }
    }
    return used;
  }

  // Ordered books (with title, comicinfo, cv_issue_id, issue_number, series_id) → groups:
  // { kind: 'arc'|'cv_arc'|'block', name, books, writers }
  function group(books) {
    const items = books.map(b => ({ ...b, arc: arcFromTitle(b.title_ci || b.title), writer_key: firstWriter(b.comicinfo) }));
    // "Part Two" with no name takes its neighbour's arc name.
    for (let k = 0; k < items.length; k++) {
      if (items[k].arc && !items[k].arc.name) {
        const nb = (items[k - 1]?.arc?.name && items[k - 1]) || (items[k + 1]?.arc?.name && items[k + 1]);
        if (nb) items[k].arc = { ...items[k].arc, name: nb.arc.name };
      }
    }
    const groups = [];
    let k = 0;
    while (k < items.length) {
      const a = items[k].arc?.name ? norm(items[k].arc.name) : '';
      if (a) {
        const start = k;
        while (k + 1 < items.length && items[k + 1].arc?.name && norm(items[k + 1].arc.name) === a) k++;
        groups.push({ kind: 'arc', name: items[start].arc.name, books: items.slice(start, k + 1) });
        k++; continue;
      }
      // Ungrouped stretch: Comic Vine arcs (cached), else writer runs in blocks.
      const start = k;
      while (k + 1 < items.length && !items[k + 1].arc?.name) k++;
      const stretch = items.slice(start, k + 1);
      let j = 0;
      while (j < stretch.length) {
        const cvA = cachedCvArcs(stretch[j].cv_issue_id) || [];
        const arcId = cvA[0]?.id;
        if (arcId) {
          const s = j;
          while (j + 1 < stretch.length && (cachedCvArcs(stretch[j + 1].cv_issue_id) || []).some(x => x.id === arcId)) j++;
          groups.push({ kind: 'cv_arc', name: cvA[0].name, cv_arc_id: arcId, books: stretch.slice(s, j + 1) });
          j++; continue;
        }
        const s = j;
        while (j + 1 < stretch.length && !((cachedCvArcs(stretch[j + 1].cv_issue_id) || [])[0])) j++;
        for (const run of writerRuns(stretch.slice(s, j + 1)))
          for (let c = 0; c < run.books.length; c += BLOCK_MAX) groups.push({ kind: 'block', name: null, books: run.books.slice(c, c + BLOCK_MAX) });
        j++;
      }
      k++;
    }
    // Neighbouring short blocks join up (to 6 issues) so one-issue stretches do not each cost a lookup.
    const merged = [];
    for (const g of groups) {
      const last = merged[merged.length - 1];
      if (last && last.kind === 'block' && g.kind === 'block' && last.books.length + g.books.length <= BLOCK_MAX) last.books.push(...g.books);
      else merged.push(g);
    }
    for (const g of merged) { g.writers = [...new Set(g.books.flatMap(b => writersOf(b.comicinfo)))].slice(0, 3); if (g.name) g.name = decode(g.name); }
    return merged;
  }

  // Merge adjacent groups into at most `max` larger ones (runs first, then pairs).
  function coarsen(groups, max) {
    if (groups.length <= max) return groups;
    let out = [];
    for (const g of groups) {
      const last = out[out.length - 1];
      const wk = firstWriter(g.books[0].comicinfo);
      if (last && last._w === wk) { last.books.push(...g.books); last.kind = 'run'; last.name = null; }
      else out.push({ kind: g.kind, name: g.name, books: [...g.books], _w: wk });
    }
    while (out.length > max) {
      const next = [];
      for (let k = 0; k < out.length; k += 2) next.push(out[k + 1] ? { kind: 'run', name: null, books: [...out[k].books, ...out[k + 1].books] } : out[k]);
      out = next;
    }
    for (const g of out) { delete g._w; g.writers = [...new Set(g.books.flatMap(b => writersOf(b.comicinfo)))].slice(0, 3); }
    return out;
  }

  const numOf = b => b.number_ci || b.issue_number || '?';
  const rangeLabel = g => {
    const a = g.books[0], z = g.books[g.books.length - 1];
    const sameSeries = g.books.every(b => b.series_id === a.series_id);
    const span = a === z ? `#${numOf(a)}` : sameSeries ? `#${numOf(a)}–${numOf(z)}` : `${a.series_label} #${numOf(a)} to ${z.series_label} #${numOf(z)}`;
    return `${sameSeries ? `${a.series_label} ` : ''}${span}`.trim();
  };
  const keyOf = (scopeKey, g) => `${scopeKey}:${g.books[0].cv_issue_id || g.books[0].id}-${g.books[g.books.length - 1].cv_issue_id || g.books[g.books.length - 1].id}`;

  function storedSummary(scopeKey, g) {
    const r = getSum.get(keyOf(scopeKey, g));
    if (!r) return null;
    if (r.status === 'missing' && (r.retry_after || 0) <= now()) return null;
    return r;
  }

  const stretchDesc = g => {
    const a = g.books[0], z = g.books[g.books.length - 1];
    const years = [a.cover_year, z.cover_year].filter(Boolean);
    return `${rangeLabel(g)}${a.series_year ? ` (the ${a.series_year} volume)` : ''}${g.name ? `, the story arc "${g.name}"` : ''}${g.writers?.length ? `, written by ${g.writers.join(', ')}` : ''}${years.length ? `, published ${[...new Set(years)].join('–')}` : ''}`;
  };
  const summaryPrompt = g => {
    const a = g.books[0], z = g.books[g.books.length - 1];
    const years = [a.cover_year, z.cover_year].filter(Boolean);
    return `Summarize this stretch of a comic series for a reader's recap.

Stretch: ${rangeLabel(g)}${a.series_year ? ` (the ${a.series_year} volume)` : ''}${g.name ? `, the story arc "${g.name}"` : ''}${g.writers?.length ? `, written by ${g.writers.join(', ')}` : ''}${years.length ? `, published ${[...new Set(years)].join('–')}` : ''}.

Search for a full plot summary of these issues, including how the stretch ends: put words such as "plot summary", "spoilers" or "recap" in your searches. Good sources: fan wikis with full synopses (DC Database, Marvel Database and other fandom wikis), spoiler reviews or recaps of the issues or of the collected edition. Skip solicitations and previews (the publisher's blurb written before release): they only describe the set-up. Make sure it is this series and volume.
Search results show only excerpts: open the most promising page (a wiki entry, a recap of these issues or of the collected edition) with web_fetch and write from its full text; if it is vague, you may open one more.
Write 100–180 words: the main events in order, who matters, what changes, and how the stretch ends. Plain prose, past tense, no headings. Nothing from issues after this stretch.
If you cannot find a source that covers these issues, set found to false and synopsis to null. Never invent events.
covers_ending: true only when your source says how the stretch ends.
source_is_this_issue: true only when the page is about these issues (or their collected edition).
Reply with only JSON: {"found": true, "synopsis": "…", "source_url": "https://…", "confidence": "high", "covers_ending": true, "source_is_this_issue": true}`;
  };
  const SCHEMA = require('./synopses').SCHEMA;
  // Step 2 prompt: the writer summarizes from the notes and pages found (no tools).
  const writerPrompt = (g, notes, pages, backed) => `Summarize this stretch of a comic series for a reader's recap, from the search notes and web pages below.

Stretch: ${stretchDesc(g)}.

Write 100–180 words: the main events in order, who matters, what changes, and how the stretch ends. Plain prose, past tense, no headings. Nothing from issues after this stretch.
Use only what the ${backed ? 'notes and pages' : 'pages'} say about these issues (or their collected edition); ignore other issues, solicitations and previews. If they do not cover these issues, set found to false and synopsis to null. Never invent events.
covers_ending: true only when they say how the stretch ends. source_is_this_issue: true when the page you relied on is about these issues. source_url: that page's address, exactly as given below.

${backed ? `SEARCH NOTES (each sentence is backed by a search result; a source like the pages):\n${notes}` : `SEARCH NOTES (may be incomplete or wrong; use them only where a page below agrees):\n${notes || '(none)'}`}

${pages.map((p, k) => `PAGE ${k + 1}: ${p.url}\n${p.text}`).join('\n\n')}

Reply with only JSON: {"found": true, "synopsis": "…", "source_url": "https://…", "confidence": "high", "covers_ending": true, "source_is_this_issue": true}`;
  const dollars = (model, u, searches = 0) => {
    const p = (modelCatalog && modelCatalog.price(model)) || { in: 0, out: 0 };
    return Math.round((((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out) / 1e6 + searches * (modelCatalog && modelCatalog.searchFee ? modelCatalog.searchFee(model) : SEARCH_FEE)) * 10000) / 10000;
  };
  // → { out, model, spent } or null (fall back to one step).
  async function twoStep(g, signal) {
    if (!finder || !axios) return null;
    const blocked = require('./synopses').BLOCKED_DOMAINS;
    const a = g.books[0];
    const question = `${rangeLabel(g)}${a.series_year ? ` (${a.series_year} series)` : ''}${g.name ? ` (the "${g.name}" story arc)` : ''}`;
    let spent = 0, found = await finder.lookup(question, { detail: 'arc', blockedDomains: blocked, source: 'recap', signal });
    if (!found.grounded) { spent += found.cost; found = await finder.lookup(question, { detail: 'retry', blockedDomains: blocked, source: 'recap', signal }); }
    spent += found.cost;
    if (!found.grounded) return { fallback: 'web search answered without searching', spent };
    const ranked = found.sources.map(x => x.url).sort((x, y) => (/fandom\.com|wiki/i.test(y) ? 1 : 0) - (/fandom\.com|wiki/i.test(x) ? 1 : 0));
    const pages = [];
    for (const url of ranked.slice(0, 5)) {
      if (pages.length >= 2) break;
      try { const pg = await readPage(url, { axios, maxChars: 40000, timeout: 15000 }); if (String(pg.text || '').length >= 800) pages.push(pg); } catch { /* next page */ }
    }
    if (!pages.length && !found.backed) return { fallback: 'none of the pages found could be read', spent };
    const r = await ai.complete({ task: 'recap_web', prompt: writerPrompt(g, found.backed || found.notes, pages, !!found.backed), maxTokens: 6000,   // room for thinking
      outputSchema: SCHEMA, schemaInWords: true, timeout: 120000, source: 'recap', signal });
    spent += dollars(r.model, r.usage || {});
    const out = parseJson(r.text) || {};
    const norm = x => String(x || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
    out.source_url = (pages.find(pg => norm(pg.url) === norm(out.source_url)) || pages[0] || { url: found.sources[0]?.url || null }).url;
    return { out, model: r.model, finder: found.model, spent };
  }
  const parseJson = text => { const s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}'); try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; } };

  const inFlight = new Map();
  async function ensureSummary(scopeKey, g, { signal } = {}) {
    const key = keyOf(scopeKey, g);
    const have = storedSummary(scopeKey, g);
    if (have) return { ...have, spent: 0 };
    if (inFlight.has(key)) return inFlight.get(key);
    const job = (async () => {
      let spent = 0;
      try {
        const two = await twoStep(g, signal).catch(e => { if (signal?.aborted) throw e; return { fallback: `two-step failed: ${e.message}`, spent: 0 }; });
        if (two && !two.fallback) {
          spent += two.spent;
          if (two.out.found && two.out.synopsis) {
            putSum.run(key, rangeLabel(g), 'ok', two.out.synopsis, 'web', two.out.source_url || null, two.model, two.out.confidence || null, spent, now(), null);
            logger?.info?.('recaps', `Stretch summary from the web: ${rangeLabel(g)}`, { model: two.model, finder: two.finder, cost: spent, source: two.out.source_url });
            return { ...getSum.get(key), spent };
          }
          logger?.info?.('recaps', `No stretch summary found: ${rangeLabel(g)}`, { cost: spent, finder: two.finder });
          putSum.run(key, rangeLabel(g), 'missing', null, null, null, null, null, spent, now(), now() + RETRY_MISSING_DAYS * 864e5);
          return { ...getSum.get(key), spent };
        }
        // Web Search did not search or found nothing readable: no summary this time (trimmed 2026-10-21;
        // the writer searching itself cost up to 8¢ with Gemini). Tried again after RETRY_MISSING_DAYS.
        if (two) {
          spent += two.spent;
          logger?.info?.('recaps', `No stretch summary found: ${rangeLabel(g)}`, { cost: spent, reason: two.fallback });
          putSum.run(key, rangeLabel(g), 'missing', null, null, null, null, null, spent, now(), now() + RETRY_MISSING_DAYS * 864e5);
          return { ...getSum.get(key), spent };
        }
        const r = await ai.complete({ task: 'recap_web', prompt: summaryPrompt(g), maxTokens: 4000, webSearch: 1, webFetch: 2, webFetchTokens: 15000, blockedDomains: require('./synopses').BLOCKED_DOMAINS, outputSchema: SCHEMA, schemaInWords: true, timeout: 180000, source: 'recap', signal });
        const u = r.usage || {}, p = (modelCatalog && modelCatalog.price(r.model)) || { in: 0, out: 0 };
        spent += Math.round((((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out) / 1e6 + (u.server_tool_use?.web_search_requests || 0) * (modelCatalog && modelCatalog.searchFee ? modelCatalog.searchFee(r.model) : SEARCH_FEE)) * 10000) / 10000;
        const out = parseJson(r.text) || {};
        if (out.found && out.synopsis) {
          putSum.run(key, rangeLabel(g), 'ok', out.synopsis, 'web', out.source_url || null, r.model, out.confidence || null, spent, now(), null);
          logger?.info?.('recaps', `Stretch summary from the web: ${rangeLabel(g)}`, { model: r.model, cost: spent });
          return { ...getSum.get(key), spent };
        }
      } catch (e) {
        if (signal?.aborted) throw e;
        logger?.warn?.('recaps', `Stretch summary failed: ${rangeLabel(g)}`, { error: e.message });
      }
      logger?.info?.('recaps', `No stretch summary found: ${rangeLabel(g)}`, { cost: spent });
      putSum.run(key, rangeLabel(g), 'missing', null, null, null, null, null, spent, now(), now() + RETRY_MISSING_DAYS * 864e5);
      return { ...getSum.get(key), spent };
    })();
    inFlight.set(key, job);
    try { return await job; } finally { inFlight.delete(key); }
  }

  return { group, coarsen, lookupCvArcs, cachedCvArcs, storedSummary, ensureSummary, rangeLabel, summaryPrompt, keyOf };
}

module.exports = { createArcs, arcFromTitle, writerRuns, firstWriter, norm, decode };
