'use strict';
// Library search (2026-10-22): forgiving name matching ("spiderman", "x men", "batman year one"),
// ranking (exact, then starts-with, then contains; series you are reading and bigger runs a little
// higher), "Batman 1940" picks the volume, "Batman 497" / "Batman #497" / "Batman 1940 497" jumps to
// the issue, and Timeline events, Top Shelf runs and reading lists are searched too. No AI.
// Annuals and specials (2026-10-26): found by the name they were published under ("Batman Annual 3",
// "Queen in Black Hela") or by "<series> annual/special", shown as issues of the parent series they
// are filed in (never as series of their own); the parent series is listed with them.

const { loadSubIssues } = require('./subIssues');

const YEAR = /^(19[3-9]\d|20[0-4]\d)$/;
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const noThe = s => s.replace(/^the /, '');
const compact = s => s.replace(/ /g, '');
const numKey = s => String(s ?? '').trim().toLowerCase().replace(/^#/, '').replace(/^0+(?=\d)/, '');
const numSort = s => { const f = parseFloat(s); return Number.isFinite(f) ? f : 1e9; };
const KIND_WORDS = { annual: 'annual', annuals: 'annual', special: 'special', specials: 'special' };

// "Batman 1940 #497" → { full: 'batman 1940 497', title: 'batman', year: 1940, issue: '497' }
function parseQuery(raw) {
  let t = String(raw || '').trim();
  let issue = null, year = null;
  const hash = t.match(/#\s*(\d+(?:\.\d+)?[a-z]?)\s*$/i);
  if (hash) { issue = hash[1]; t = t.slice(0, hash.index).trim(); }
  const words = norm(t).split(' ').filter(Boolean);
  if (!issue && words.length >= 2 && /^\d+$/.test(words[words.length - 1])) {
    const last = words[words.length - 1], prev = words[words.length - 2];
    if (words.length >= 3 && YEAR.test(prev)) { issue = last; year = Number(prev); words.splice(-2); }
    else if (YEAR.test(last)) { year = Number(last); words.pop(); }
    else { issue = last; words.pop(); }
  }
  if (issue && !year && words.length >= 2 && YEAR.test(words[words.length - 1])) year = Number(words.pop());
  return { full: norm(raw), title: words.join(' '), year, issue: issue ? numKey(issue) : null };
}

// How well a name matches a normalized query, 0–100.
function scoreName(name, q) {
  const n = noThe(norm(name)), t = noThe(q || '');
  if (!t || !n) return 0;
  if (n === t) return 100;
  if (compact(n) === compact(t)) return 95;
  if (n.startsWith(t + ' ')) return 82;
  if (n.startsWith(t)) return 75;
  if ((' ' + n + ' ').includes(' ' + t + ' ')) return 65;
  if (t.length >= 3 && compact(n).includes(compact(t))) return 52;
  const nw = n.split(' '), tw = t.split(' ');
  if (tw.every(w => nw.some(x => x === w || (w.length >= 3 && x.startsWith(w))))) return 42;
  return 0;
}

// Name score using both the whole query ("Spider-Man 2099") and the parsed title ("Batman" of "Batman 497").
function bestScore(name, p) {
  return Math.max(scoreName(name, p.full), p.title && p.title !== p.full ? scoreName(name, p.title) : 0);
}

// Annuals and specials the query names: by published name when that matches better than the
// folder they are filed in ("Batman Annual" yes, "Batman" no), or "<folder> annual/special".
// subs: loadSubIssues rows; p: parseQuery result. → [{ x, score }], best first.
function matchSubs(subs, p) {
  const words = p.title.split(' ').filter(Boolean);
  const kindWord = words.map(w => KIND_WORDS[w]).find(Boolean) || null;
  const rest = kindWord ? words.filter(w => !KIND_WORDS[w]).join(' ') : '';
  const hits = [];
  for (const x of subs) {
    if (p.issue && numKey(x.number) !== p.issue) continue;
    let score = bestScore(x.name, p);
    if (score < 60 || score <= bestScore(x.folder_name, p)) score = 0;
    if (!score && kindWord === x.kind && rest) { const f = scoreName(x.folder_name, rest); if (f >= 60) score = f - 5; }
    if (!score) continue;
    if (p.year && x.year) { if (Math.abs(x.year - p.year) > 1) continue; score += 10; }
    hits.push({ x, score });
  }
  return hits.sort((a, b) => b.score - a.score || (a.x.year || 0) - (b.x.year || 0) || numSort(a.x.number) - numSort(b.x.number));
}

function createSearch({ db, fetchAllSeries, mergeSeriesWithJson, creatorsCache }) {
  const tryAll = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch { return []; } };
  // Annuals and specials, kept for a minute (the top bar asks on every keystroke).
  const subCache = new Map();
  function subIssues(libraryId) {
    const k = libraryId || '', c = subCache.get(k);
    if (c && Date.now() - c.at < 60000) return c.rows;
    const rows = loadSubIssues(db, { libraryId });
    subCache.set(k, { at: Date.now(), rows });
    return rows;
  }

  const findSubs = (p, libraryId) => matchSubs(subIssues(libraryId), p);


  function search({ q, libraryId = null, user = null, limit = 40 }) {
    const p = parseQuery(q);
    if (!p.full) return { query: p, series: [], books: [], issues: [], events: [], runs: [], lists: [] };
    const userId = user?.sub ?? null;

    // ── Series ──
    const reading = new Set(tryAll(`SELECT DISTINCT sb.series_id AS id FROM read_progress rp JOIN scanned_books sb ON sb.id = rp.book_id
      WHERE (rp.user_id = ? OR rp.user_id IS NULL) AND (rp.page > 0 OR rp.completed = 1)`, userId).map(r => r.id));
    const scored = [];
    for (const s of fetchAllSeries(libraryId)) {
      let score = bestScore(s.name, p);
      let by = 'name';
      if (!score && p.title.length >= 3) {   // creators (writer / artist names)
        const c = creatorsCache && creatorsCache.get(s.id);
        if (c && [...(c.writers || []), ...(c.artists || [])].some(w => norm(w).includes(p.title))) { score = 30; by = 'creator'; }
      }
      if (!score) continue;
      const yr = parseInt(s.year, 10) || null;
      if (p.year) { if (yr === p.year) score += 25; else if (yr && Math.abs(yr - p.year) > 1) score -= 30; }
      if (reading.has(s.id)) score += 8;
      score += Math.min(6, Math.log2((s.book_count || 0) + 1));
      scored.push({ s, score, by });
    }
    scored.sort((a, b) => b.score - a.score || norm(a.s.name).length - norm(b.s.name).length || (a.s.year || 9999) - (b.s.year || 9999));
    const series = scored.slice(0, limit).map(x => ({ ...mergeSeriesWithJson(x.s), score: Math.round(x.score), matched_by: x.by }));

    // ── Annuals and specials ──
    const subById = new Map(subIssues(libraryId).map(x => [x.id, x]));
    const subHits = findSubs(p, libraryId);
    const subFields = x => ({ sub_name: x.name, sub_year: x.year, kind: x.kind });
    // Their parent series are listed too ("Batman, has Batman Annual").
    const allById = new Map(fetchAllSeries(libraryId).map(s => [s.id, s]));
    for (const { x, score } of subHits) {
      const have = series.find(s => s.id === x.series_id);
      if (have) { if (!have.contains) { have.contains = x.name; have.contains_kind = x.kind; } continue; }
      if (series.length >= limit + 5 || !allById.has(x.series_id)) continue;
      series.push({ ...mergeSeriesWithJson(allById.get(x.series_id)), score: Math.round(score) - 10, matched_by: x.kind, contains: x.name, contains_kind: x.kind });
    }
    series.sort((a, b) => b.score - a.score);

    // ── Issue jump: the number in the best-matching volumes ──
    const issues = [];
    if (p.issue) for (const { x, score } of subHits.slice(0, 6))
      issues.push({ id: x.id, series_id: x.series_id, series_name: x.folder_name, series_year: x.folder_year, issue_number: x.number, title: x.title, score: Math.round(score), ...subFields(x) });
    if (p.issue) {
      let pick = scored.filter(x => x.by === 'name' && x.score >= 60);
      if (p.year) {   // "Green Lantern 2005 1": only that volume when it is there
        const same = pick.filter(x => Math.abs((parseInt(x.s.year, 10) || 0) - p.year) <= 1);
        if (same.length) pick = same;
      }
      pick = pick.slice(0, 4);
      for (const { s, score } of pick) {
        const same = tryAll('SELECT id, title, filename, issue_number, comicinfo FROM scanned_books WHERE series_id = ?', s.id).filter(r => numKey(r.issue_number) === p.issue);
        const b = same.find(r => !subById.has(r.id)) || same[0];   // "Batman 3" is Batman #3, not Batman Annual #3
        if (b) issues.push({ id: b.id, series_id: s.id, series_name: s.name, series_year: s.year || null, issue_number: b.issue_number,
          title: storyTitle(b.comicinfo) || null, score: Math.round(score) });
      }
    }

    // ── Issues by title or file name ──
    const like = `%${String(q).trim().toLowerCase()}%`;
    const subBooks = p.issue ? [] : subHits.slice(0, 60).map(({ x, score }) => ({ id: x.id, title: x.title, filename: null, issue_number: x.number,
      series_id: x.series_id, series_name: x.folder_name, series_year: x.folder_year, score: Math.round(score), ...subFields(x) }));
    const likeBooks = tryAll(`SELECT sb.id, sb.title, sb.filename, sb.issue_number, sb.series_id, ss.name AS series_name, ss.year AS series_year, l.name AS library_name
      FROM scanned_books sb JOIN scanned_series ss ON ss.id = sb.series_id LEFT JOIN libraries l ON l.id = ss.library_id
      WHERE (lower(sb.title) LIKE ? OR lower(sb.filename) LIKE ?) ${libraryId ? 'AND ss.library_id = ?' : ''} LIMIT 80`,
    like, like, ...(libraryId ? [libraryId] : []))
      .map(b => { const x = subById.get(b.id);
        return { ...b, title: b.title ? decodeEntities(b.title) : b.title, score: scoreName(b.title || b.filename, p.full), ...(x ? { ...subFields(x), issue_number: x.number } : {}) }; });
    const seen = new Set(subBooks.map(b => b.id));
    const books = [...subBooks, ...likeBooks.filter(b => !seen.has(b.id)).sort((a, b) => b.score - a.score)].slice(0, Math.max(limit, subBooks.length));

    // ── Timeline events, Top Shelf runs, reading lists ──
    const events = tryAll(`SELECT e.id, e.name, e.year, e.publisher,
        (SELECT COUNT(*) FROM event_issues ei WHERE ei.event_id = e.id) AS total,
        (SELECT ei.scanned_book_id FROM event_issues ei WHERE ei.event_id = e.id AND ei.scanned_book_id IS NOT NULL ORDER BY ei.sort_order LIMIT 1) AS book_id
      FROM events e WHERE ${require('./eventDrafts').published(db, 'e')}`)
      .map(e => ({ ...e, score: bestScore(e.name, p) + (p.year && Number(e.year) === p.year ? 25 : 0) })).filter(e => e.score >= 40)
      .sort((a, b) => b.score - a.score).slice(0, 20);
    const runs = tryAll(`SELECT r.id, r.title, r.parent_series,
        (SELECT ci.scanned_book_id FROM canon_run_issues ci WHERE ci.run_id = r.id AND ci.scanned_book_id IS NOT NULL ORDER BY ci.sort_order LIMIT 1) AS book_id,
        (SELECT COUNT(*) FROM canon_run_issues ci WHERE ci.run_id = r.id) AS total
      FROM canon_runs r WHERE r.status = 'approved'`)
      .map(r => ({ ...r, score: Math.max(bestScore(r.title, p), Math.round(bestScore(r.parent_series, p) * 0.8)) })).filter(r => r.score >= 40)
      .sort((a, b) => b.score - a.score).slice(0, 20);
    const lists = tryAll(`SELECT id, name, visibility, owner_id FROM reading_lists WHERE owner_id = ? OR visibility != 'private'`, userId)
      .map(l => ({ id: l.id, name: l.name, visibility: l.visibility, mine: l.owner_id === userId, score: bestScore(l.name, p) })).filter(l => l.score >= 40)
      .sort((a, b) => b.score - a.score).slice(0, 20);

    return { query: p, series, books, issues, events, runs, lists };
  }

  // The best few hits across every kind, for the top bar's suggestions.
  function suggest({ q, libraryId = null, user = null, limit = 8 }) {
    const r = search({ q, libraryId, user, limit: 12 });
    const out = [];
    const inParent = x => `in ${x.series_name}${x.series_year ? ` (${x.series_year})` : ''}`;
    for (const i of r.issues) out.push(i.sub_name
      ? { type: 'issue', id: i.id, label: `${i.sub_name} #${i.issue_number}`, sub: [i.sub_year && `(${i.sub_year})`, inParent(i), i.title].filter(Boolean).join(' · '), url: `/read/${i.id}`, thumb: `/api/books/${i.id}/thumbnail`, score: 200 + i.score }
      : { type: 'issue', id: i.id, label: `${i.series_name} #${i.issue_number}`, sub: [i.series_year && `(${i.series_year})`, i.title].filter(Boolean).join(' · '), url: `/read/${i.id}`, thumb: `/api/books/${i.id}/thumbnail`, score: 200 + i.score });
    // A parent series found through its annuals/specials goes just above them.
    const topSub = Math.max(0, ...r.books.filter(b => b.sub_name).map(b => b.score));
    for (const s of r.series) out.push({ type: 'series', id: s.id, label: s.name,
      sub: [s.year, `${s.book_count || 0} issues`, s.matched_by === 'creator' ? 'creator match' : null, s.contains ? `has ${s.contains}` : null].filter(Boolean).join(' · '),
      url: `/series/${s.id}${s.matched_by === 'annual' ? '?tab=annuals' : s.matched_by === 'special' ? '?tab=specials' : ''}`, thumb: `/api/series/${s.id}/thumbnail`,
      score: (s.matched_by === 'annual' || s.matched_by === 'special') ? Math.max(s.score, topSub - 1) : s.score + 1 });
    for (const e of r.events) out.push({ type: 'event', id: e.id, label: e.name, sub: ['Timeline event', e.publisher, e.year].filter(Boolean).join(' · '), url: `/events/${e.id}`, thumb: e.book_id ? `/api/books/${e.book_id}/thumbnail` : null, score: e.score });
    for (const x of r.runs) out.push({ type: 'run', id: x.id, label: x.title, sub: ['Top Shelf', x.parent_series].filter(Boolean).join(' · '), url: `/canon/run/${x.id}`, thumb: x.book_id ? `/api/books/${x.book_id}/thumbnail` : null, score: x.score });
    for (const l of r.lists) out.push({ type: 'list', id: l.id, label: l.name, sub: l.visibility === 'essential' ? 'Essentials' : 'Reading list', url: l.visibility === 'essential' ? `/essentials/${l.id}` : `/reading-lists/${l.id}`, thumb: null, score: l.score });
    let subShown = 0;
    for (const b of r.books) {
      if (b.sub_name) { if (subShown++ < 5) out.push({ type: 'book', id: b.id, label: `${b.sub_name} #${b.issue_number ?? '?'}`, sub: [b.sub_year && `(${b.sub_year})`, inParent(b), b.title].filter(Boolean).join(' · '), url: `/read/${b.id}`, thumb: `/api/books/${b.id}/thumbnail`, score: b.score - 5 }); }
      else if (b.score >= 60) out.push({ type: 'book', id: b.id, label: `${b.series_name} #${b.issue_number ?? '?'}`, sub: b.title || b.filename, url: `/read/${b.id}`, thumb: `/api/books/${b.id}/thumbnail`, score: b.score - 5 });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score, ...x }) => x);
  }

  return { search, suggest };
}

function decodeEntities(t) {
  return String(t).replace(/&amp;/g, '&').replace(/&#8217;|&apos;|&#39;|&rsquo;/g, '’').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function storyTitle(ci) {
  const m = String(ci || '').match(/<Title>([\s\S]*?)<\/Title>/);
  return m ? m[1].replace(/&amp;/g, '&').replace(/&#8217;|&apos;|&#39;/g, '’').replace(/&quot;/g, '"').replace(/<[^>]+>|&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim() || null : null;
}

module.exports = { createSearch, parseQuery, scoreName, norm, numKey, matchSubs };
