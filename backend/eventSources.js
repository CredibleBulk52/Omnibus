'use strict';
// ─── Event generator: sources, order notes and checks ─────────────
// The v2 event generator (2026-10-20, claude/EVENT_GENERATOR_V3.md) says which sites list each
// issue, why an issue was moved from its release position, which pages it read and which issues
// it left out. These helpers clean that up before the preview and check the order against
// Comic Vine release dates. Shown to the admin only, behind "Show sources".

const DAY = 24 * 60 * 60 * 1000;
const FLAG_DAYS = 21;   // "a few weeks" from its release position

// Keeps only source codes that match a page the generator read (AI always allowed).
// Returns { sourcesRead, omitted, dropped } and fixes issue.sources in place.
function cleanSources(parsed) {
  const sourcesRead = (Array.isArray(parsed.sources_read) ? parsed.sources_read : [])
    .filter(s => s && s.code && (s.url || s.code === 'USER'))   // USER: pasted guide text may have no address
    .map(s => ({ code: String(s.code), url: String(s.url || '') }));
  const readCodes = new Set(sourcesRead.map(s => s.code));
  let dropped = 0;
  for (const i of parsed.issues || []) {
    const raw = Array.isArray(i.sources) ? i.sources.map(String) : [];
    const kept = [...new Set(raw.filter(c => c === 'AI' || readCodes.has(c)))];
    dropped += raw.length - kept.length;
    i.sources = kept;
    i.order_note = i.order_note ? String(i.order_note).trim() || null : null;
    i.tier_reason = i.tier_reason ? String(i.tier_reason).trim().slice(0, 300) || null : null;
  }
  const omitted = (Array.isArray(parsed.omitted) ? parsed.omitted : [])
    .filter(o => o && o.series_name && o.issue_number)
    .map(o => ({ series_name: String(o.series_name), issue_number: String(o.issue_number), volume_year: o.volume_year ? String(o.volume_year) : null,
      listed_by: (Array.isArray(o.listed_by) ? o.listed_by.map(String) : []).filter(c => c === 'AI' || readCodes.has(c)),
      reason: o.reason ? String(o.reason).trim() : '' }));
  return { sourcesRead, omitted, dropped, noReason: omitted.filter(o => !o.reason).length };
}

const time = d => { const t = Date.parse(String(d || '').slice(0, 10)); return Number.isFinite(t) ? t : null; };

// Flags issues read far from their release position without a stated reason. Uses Comic Vine
// store (on-sale) dates only: cover dates run months ahead and differ by publisher.
// issues: in reading order, each with release_date and release_date_kind ('store' | 'cover').
// The longest run of issues already in release order is taken as the backbone; an issue outside
// it is flagged when it sits more than FLAG_DAYS from where its date belongs among the backbone
// issues around it ('late': read after issues out weeks later; 'early': before issues out weeks
// earlier). Moving one issue flags that issue, not its neighbours. Sets issue.order_flag; returns
// the number flagged.
function releaseFlags(issues) {
  for (const i of issues) i.order_flag = null;
  const dated = issues.map(i => ({ i, t: i.release_date_kind === 'store' ? time(i.release_date) : null }))
    .filter(x => x.t != null && x.i.tier !== 'aftermath');
  // Longest non-decreasing subsequence of dates (patience sorting, O(n log n)).
  const tails = [], tailIdx = [], prev = new Array(dated.length).fill(-1);
  dated.forEach((x, k) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] <= x.t) lo = mid + 1; else hi = mid; }
    tails[lo] = x.t; tailIdx[lo] = k; prev[k] = lo > 0 ? tailIdx[lo - 1] : -1;
  });
  const inRun = new Set();
  for (let k = tailIdx[tails.length - 1] ?? -1; k >= 0; k = prev[k]) inRun.add(k);
  let flagged = 0;
  dated.forEach((x, k) => {
    if (inRun.has(k) || x.i.order_note) return;
    let before = null, after = null;
    for (let j = k - 1; j >= 0; j--) if (inRun.has(j)) { before = dated[j].t; break; }
    for (let j = k + 1; j < dated.length; j++) if (inRun.has(j)) { after = dated[j].t; break; }
    if (before != null && x.t < before - FLAG_DAYS * DAY) x.i.order_flag = 'late';
    else if (after != null && x.t > after + FLAG_DAYS * DAY) x.i.order_flag = 'early';
    if (x.i.order_flag) flagged++;
  });
  return flagged;
}

// Cost data for one generator job (2026-10-21): what the searches and page reads were and how big
// each result was, summed over every call of the job (a paused turn is continued in a new call).
// Sizes are characters of the tool result as returned (≈ 4 characters per token; search results
// include encrypted page text). For tuning page and search limits from real runs.
function toolReport(responses) {
  const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, searches: 0, fetches: 0 };
  const uses = new Map(), searches = [], pages = [], other = {};
  for (const r of responses || []) {
    const u = (r && r.usage) || {};
    usage.input += u.input_tokens || 0; usage.output += u.output_tokens || 0;
    usage.cache_read += u.cache_read_input_tokens || 0; usage.cache_write += u.cache_creation_input_tokens || 0;
    usage.searches += (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
    usage.fetches += (u.server_tool_use && u.server_tool_use.web_fetch_requests) || 0;
    for (const b of (r && r.content) || []) {
      if (b.type === 'server_tool_use' || b.type === 'tool_use') uses.set(b.id, b);
      if (!/_tool_result$/.test(b.type || '')) continue;
      const use = uses.get(b.tool_use_id) || {};
      const chars = JSON.stringify(b.content || '').length;
      const failed = !!(b.content && /error/.test(b.content.type || ''));
      if (b.type === 'web_search_tool_result') searches.push({ query: (use.input && use.input.query) || null, results: Array.isArray(b.content) ? b.content.length : 0, chars });
      else if (b.type === 'web_fetch_tool_result') pages.push({ url: (b.content && b.content.url) || (use.input && use.input.url) || null, chars, failed });
      else { const k = use.name || b.type; other[k] = (other[k] || 0) + chars; }
    }
  }
  const total = [...searches, ...pages].reduce((n, x) => n + x.chars, 0) + Object.values(other).reduce((n, c) => n + c, 0);
  return { calls: (responses || []).length, usage, searches, pages, other, toolResultChars: total };
}

// v2.8: a phase is one unbroken block of the reading order. A short run of issues sitting between two runs
// of the same phase (a thread label such as "Evacuation" inside "Arena Rises") joins the phase around it;
// any later return of an earlier phase's name joins the current phase. Prelude/Aftermath runs are left as
// they are. Changes issue.phase in place and returns the number of issues changed.
const FIXED_PHASE = /^(prelude|prologue|aftermath|epilogue)$/i;
function unbrokenPhases(issues) {
  const list = [...(issues || [])].sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  let changed = 0;
  const runsOf = () => {
    const runs = [];
    for (const i of list) {
      const p = i.phase || null;
      if (runs.length && runs[runs.length - 1].phase === p) runs[runs.length - 1].items.push(i);
      else runs.push({ phase: p, items: [i] });
    }
    return runs;
  };
  for (let pass = 0; pass < 20; pass++) {
    const runs = runsOf(); let hit = false;
    for (let k = 1; k < runs.length - 1; k++) {
      const [prev, mid, next] = [runs[k - 1], runs[k], runs[k + 1]];
      if (!prev.phase || prev.phase !== next.phase || !mid.phase || FIXED_PHASE.test(mid.phase) || FIXED_PHASE.test(prev.phase)) continue;
      for (const i of mid.items) { i.phase = prev.phase; changed++; }
      hit = true; break;
    }
    if (!hit) break;
  }
  const closed = new Set(); let current = null;
  for (const i of list) {
    const p = i.phase || null;
    if (p && current && p !== current && closed.has(p) && !FIXED_PHASE.test(p)) { i.phase = current; changed++; continue; }
    if (p !== current) { if (current) closed.add(current); current = p; }
  }
  return changed;
}

module.exports = { unbrokenPhases, cleanSources, releaseFlags, toolReport, FLAG_DAYS };
