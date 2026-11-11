'use strict';
// Forgiving title matching for Comic Book Guy's saved-list searches.
// Readers misspell ("blakest nite"), drop or add words ("the new Absolute
// books"), and split or join names ("Spiderman"). The model picks the search
// terms; this scores every saved title against them and reports how close
// each one is, so a near miss still turns up.

// Words that describe the request, not the title.
const FILLER = new Set(['the', 'a', 'an', 'of', 'and', 'vol', 'volume', 'read', 'reading', 'order', 'orders', 'list', 'lists',
  'comic', 'comics', 'book', 'books', 'series', 'event', 'events', 'crossover', 'essential', 'essentials', 'storyline', 'arc',
  'saga', 's', 'run', 'dc', 'marvel', 'runs', 'where', 'start', 'to', 'for', 'in', 'what', 'is', 'new']);
// Words kept in titles even though they are filler in a query.
const TITLE_KEEP = new Set(['run']);
// Common shorthand.
const SPELLINGS = { nite: 'night', tonite: 'tonight', xmen: 'x men', spiderman: 'spider man', spidey: 'spider man', gl: 'green lantern',
  jla: 'justice league', jsa: 'justice society', avengers: 'avengers', bat: 'bat', supes: 'superman', wonderwoman: 'wonder woman' };

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function expand(tokens) {
  return tokens.flatMap(t => (SPELLINGS[t] ? SPELLINGS[t].split(' ') : [t]));
}
function queryTokens(q) {
  const all = expand(norm(q).split(' ').filter(Boolean));
  const kept = all.filter(t => !FILLER.has(t));
  return kept.length ? kept : all;
}
function titleTokens(s) {
  const all = expand(norm(s).split(' ').filter(Boolean));
  const kept = all.filter(t => !FILLER.has(t) || TITLE_KEEP.has(t));
  return kept.length ? kept : all;
}

function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length; if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j), cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}
// 0..1: how well one query word matches one title word.
function wordSim(q, t) {
  if (q === t) return 1;
  if (/^\d+$/.test(q) || /^\d+$/.test(t)) return 0;          // numbers must match exactly
  if (q.length >= 3 && t.startsWith(q)) return 0.9;          // "absol" → "absolute"
  if (t.length >= 3 && q.startsWith(t) && q.length - t.length <= 2) return 0.85;   // plurals: "lanterns"
  if (Math.min(q.length, t.length) < 4) return 0;
  const r = 1 - lev(q, t) / Math.max(q.length, t.length);   // "blakest" → "blackest" 0.88
  return r >= 0.7 ? r * 0.95 : 0;
}
function trigrams(s) {
  const p = ` ${s} `, out = new Map();
  for (let i = 0; i + 3 <= p.length; i++) { const g = p.slice(i, i + 3); out.set(g, (out.get(g) || 0) + 1); }
  return out;
}
function dice(a, b) {
  if (!a || !b) return 0;
  const A = trigrams(a), B = trigrams(b); let both = 0, n = 0;
  for (const [g, c] of A) { n += c; if (B.has(g)) both += Math.min(c, B.get(g)); }
  for (const c of B.values()) n += c;
  return n ? (2 * both) / n : 0;
}

// Score one title against a query. Returns 0..1.
function scoreTitle(query, title) {
  const qAll = queryTokens(query), tAll = titleTokens(title);
  const qYears = qAll.filter(t => /^(19|20)\d\d$/.test(t)), q = qAll.filter(t => !/^(19|20)\d\d$/.test(t));
  const t = tAll.filter(x => !/^(19|20)\d\d$/.test(x));
  if (!q.length || !t.length) return 0;
  // Joined forms catch split or joined names ("spiderman" vs "spider man").
  if (q.join('') === t.join('')) return 1;
  let sum = 0; const used = new Set();
  for (const w of q) {
    let best = 0, at = -1;
    t.forEach((x, i) => { const s = wordSim(w, x); if (s > best) { best = s; at = i; } });
    // Two title words written as one query word, or the reverse.
    for (let i = 0; i + 1 < t.length; i++) if (wordSim(w, t[i] + t[i + 1]) > best) { best = wordSim(w, t[i] + t[i + 1]); at = i; }
    sum += best; if (at >= 0 && best > 0) used.add(at);
  }
  const tokenScore = sum / q.length;
  const coverage = used.size / t.length;
  let score = 0.8 * tokenScore + 0.2 * coverage;
  score = Math.max(score, dice(q.join(' '), t.join(' ')) * 0.9);
  if (qYears.length) score += tAll.some(x => qYears.includes(x)) ? 0.05 : 0;
  return Math.min(1, Math.round(score * 1000) / 1000);
}

// "exact" only when the same words are there (ignoring order and plurals);
// a high score alone ("green lantern war" vs "War of the Green Lanterns") is close.
const stem = w => w.replace(/s$/, '');
const sameWords = (q, t) => { const a = queryTokens(q).map(stem).sort().join(' '), b = titleTokens(t).map(stem).sort().join(' '); return a === b || a.replace(/ /g, '') === b.replace(/ /g, ''); };
function label(score, query, title) {
  if (score >= 0.95 && (query == null || sameWords(query, title))) return 'exact';
  return score >= 0.72 ? 'close' : 'partial';
}

// items: [{ ..., title, also?: [secondary names] }]. Secondary names (the
// series inside an event, a run's parent series) count, but for less.
function rank(query, items, { limit = 6, min = 0.45 } = {}) {
  const out = [];
  for (const it of items) {
    let best = scoreTitle(query, it.title), on = 'title', name = it.title;
    for (const a of it.also || []) { const s = scoreTitle(query, a) * 0.75; if (s > best) { best = s; on = `contains ${a}`; name = a; } }
    if (best >= min) out.push({ item: it, score: best, match: on === 'title' ? label(best, query, name) : 'partial', matched_on: on });
  }
  out.sort((a, b) => b.score - a.score || String(a.item.title).length - String(b.item.title).length);
  return out.slice(0, limit);
}

module.exports = { norm, queryTokens, titleTokens, lev, wordSim, dice, scoreTitle, rank, label };
