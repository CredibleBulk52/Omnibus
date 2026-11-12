'use strict';
// ─── editorAdd.js ─────────────────────────────────────────────────
// Search for the shared editor's Add window (claude/ADMIN_REORG.md step 3,
// part 2; user 2026-10-17): volumes in the library first, then Comic Vine;
// for reading lists also Timeline events and Top Shelf runs. Then one
// volume's issues, each with the library book when it is owned.
//
//   GET /api/editor/add/search?q=&year=&lists=1&cv=1
//     → { volumes: [{ source: 'library', id, name, year, publisher, cv_volume_id, owned, total }],
//         yearMatch: exact|near|none|null, events: [...], runs: [...],
//         cv: [{ source: 'cv', id, name, year, publisher, total, image, in_library }], cvError }
//   GET /api/editor/add/volume?library=<scanned series id>   (or ?cv=<volume id>&name=&year=&publisher=)
//     → { volume, issues: [{ number, title, cv_issue_id, book_id, image, date }], cvError }
//
// Annuals and specials (user 2026-10-26): they are filed in their parent series, so a search
// for "Batman Annual" or "Queen in Black Hela" returns the parent volume with
// focus: { name, year, kind }; in a library volume's issues each annual/special carries
// group ("Batman Annual (2012)"), kind, series_name and volume_year (as published).
const { loadSubIssues, describe } = require('./subIssues');
const { parseQuery, matchSubs } = require('./search');
module.exports = function createEditorAdd({ app, db, requireAuth, cvApiGet, getCVKey, fetchVolumeIssues, IN, logger }) {
  // Dotted initials are one word: "L.E.G.I.O.N." → "legion", "J.L.A." → "jla" (2026-10-29).
  const norm = t => String(t || '').replace(/\b(?:[a-z]\.){2,}/gi, m => m.replace(/\./g, '')).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  const words = t => norm(t).split(' ').filter(w => w.length > 1 && w !== 'the');
  const numOf = n => (n == null || n === '' ? null : (IN.normIssueNumber(String(n)) || String(n)));
  const numKey = n => { const f = parseFloat(numOf(n)); return Number.isFinite(f) ? f : Number.MAX_SAFE_INTEGER; };
  const yearOk = (y, want, slack) => !want || (!!y && Math.abs(Number(y) - want) <= slack);
  const isAdmin = req => req.user && req.user.role === 'admin';
  function meta(row) {
    try { const j = JSON.parse(row.series_json || 'null'); const m = (j && j.metadata) || j || {};
      return { publisher: m.publisher || null, cv: m.comicid ? String(m.comicid) : null, total: m.total_issues || m.issue_count || null };
    } catch { return {}; }
  }
  // Exact name first, then names with more of the words and fewer extra words.
  function score(name, qw) {
    const nw = words(name);
    if (nw.join(' ') === qw.join(' ')) return 1000;
    return qw.filter(w => nw.includes(w)).length * 100 - Math.max(0, nw.length - qw.length) * 10;
  }
  const byScore = qw => (a, b) => score(b.name, qw) - score(a.name, qw) || (a.year || 0) - (b.year || 0);
  // Year exact; nothing that year → the year either side.
  function withYear(list, yr, yearOf = x => x.year) {
    if (!yr) return { list, match: null };
    const exact = list.filter(x => yearOk(yearOf(x), yr, 0));
    if (exact.length) return { list: exact, match: 'exact' };
    const near = list.filter(x => yearOk(yearOf(x), yr, 1));
    return { list: near, match: near.length ? 'near' : 'none' };
  }

  app.get('/api/editor/add/search', requireAuth, async (req, res) => {
    try {
      const qw = words(req.query.q);
      const yr = /^\d{4}$/.test(String(req.query.year || '').trim()) ? Number(String(req.query.year).trim()) : null;
      const out = { volumes: [], yearMatch: null, events: [], runs: [] };
      if (!qw.length) return res.json(out);
      // Names are compared without their dots, so "legion" finds "L.E.G.I.O.N.".
      const like = col => qw.map(() => `REPLACE(LOWER(${col}), '.', '') LIKE ?`).join(' AND '), likeP = qw.map(w => `%${w}%`);
      const lib = db.prepare(`SELECT id, name, year, book_count, series_json FROM scanned_series WHERE ${like('name')}`).all(...likeP);
      const y = withYear(lib, yr);
      out.yearMatch = y.match;
      out.volumes = y.list.map(s => { const m = meta(s);
        return { source: 'library', id: String(s.id), name: s.name, year: s.year ? Number(s.year) : null, publisher: m.publisher, cv_volume_id: m.cv, owned: s.book_count || 0, total: m.total };
      }).sort(byScore(qw)).slice(0, 20);
      // Annuals and specials the search names → their parent volume, focused on them.
      const p = { ...parseQuery(req.query.q), issue: null, year: yr };
      const focus = new Map();
      for (const { x, score } of matchSubs(loadSubIssues(db), p)) if (!focus.has(x.series_id)) focus.set(x.series_id, { name: x.name, year: x.year, kind: x.kind, score });
      if (focus.size) {
        const rows = db.prepare(`SELECT id, name, year, book_count, series_json FROM scanned_series WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...focus.keys()]));
        const parents = rows.map(s => { const m = meta(s), f = focus.get(String(s.id));
          return { source: 'library', id: String(s.id), name: s.name, year: s.year ? Number(s.year) : null, publisher: m.publisher, cv_volume_id: m.cv, owned: s.book_count || 0, total: m.total,
            focus: { name: f.name, year: f.year, kind: f.kind }, _score: f.score };
        }).sort((a, b) => b._score - a._score).slice(0, 12).map(({ _score, ...v }) => v);
        const ids = new Set(parents.map(v => v.id));
        out.volumes = [...parents, ...out.volumes.filter(v => !ids.has(v.id))].slice(0, 24);
        if (out.yearMatch === 'none' || out.yearMatch === 'near') out.yearMatch = 'exact';
      }
      if (req.query.lists) {
        const ev = db.prepare(`SELECT id, name, year, publisher, (SELECT COUNT(*) FROM event_issues ei WHERE ei.event_id = events.id) AS n FROM events WHERE ${require('./eventDrafts').published(db)} AND ${like('name')} LIMIT 40`).all(...likeP);
        out.events = withYear(ev, yr).list.sort(byScore(qw)).slice(0, 6).map(e => ({ id: String(e.id), name: e.name, year: e.year || null, publisher: e.publisher || null, issues: e.n }));
        const runs = db.prepare(`SELECT id, title AS name, parent_series, issue_range_hint, status, (SELECT COUNT(*) FROM canon_run_issues x WHERE x.run_id = canon_runs.id) AS n
          FROM canon_runs WHERE ${like('title')} ${isAdmin(req) ? '' : "AND status = 'approved'"} LIMIT 40`).all(...likeP);
        out.runs = runs.sort(byScore(qw)).slice(0, 6).map(r => ({ id: String(r.id), name: r.name, sub: [r.parent_series, r.issue_range_hint].filter(Boolean).join(' · '), status: r.status, issues: r.n }));
      }
      if (req.query.cv) {
        try {
          const r = await cvApiGet('https://comicvine.gamespot.com/api/search', {
            params: { api_key: getCVKey(), format: 'json', query: /\b(?:[a-z]\.){2,}/i.test(String(req.query.q)) ? String(req.query.q).trim() : qw.join(' '), resources: 'volume', limit: 50, field_list: 'id,name,start_year,publisher,count_of_issues,image' },
            headers: { 'User-Agent': 'Omnibus/1.0' },
          });
          if (r.data.status_code && r.data.status_code !== 1)
            throw new Error(r.data.status_code === 107 ? 'Comic Vine rate limit reached; try again in a few minutes.' : (r.data.error || `Comic Vine error ${r.data.status_code}`));
          const inLib = new Set(lib.map(s => meta(s).cv).filter(Boolean));
          const cv = (r.data.results || []).map(v => ({ source: 'cv', id: String(v.id), name: v.name, year: v.start_year ? Number(v.start_year) : null,
            publisher: (v.publisher && v.publisher.name) || null, total: v.count_of_issues || null, image: (v.image && (v.image.thumb_url || v.image.small_url)) || null, in_library: inLib.has(String(v.id)) }));
          out.cv = withYear(cv, yr).list.sort(byScore(qw)).slice(0, 20);
        } catch (e) { out.cvError = e.message; logger && logger.warn && logger.warn('editor', 'Comic Vine volume search failed', e.message); }
      }
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/editor/add/volume', requireAuth, async (req, res) => {
    try {
      let volume, books = [], volId = null;
      if (req.query.library) {
        const s = db.prepare('SELECT id, name, year, series_json FROM scanned_series WHERE id = ?').get(String(req.query.library));
        if (!s) return res.status(404).json({ error: 'Series not found' });
        const m = meta(s); volId = m.cv;
        volume = { source: 'library', id: String(s.id), name: s.name, year: s.year ? Number(s.year) : null, publisher: m.publisher, cv_volume_id: volId };
        let ci = true;
        try { db.prepare('SELECT 1 FROM book_ci_index LIMIT 1').get(); } catch { ci = false; }
        let sp = true;
        try { db.prepare('SELECT is_special FROM scanned_books LIMIT 1').get(); } catch { sp = false; }
        books = db.prepare(`SELECT sb.id, sb.issue_number, sb.cv_issue_id, sb.title, sb.filename, ${sp ? 'sb.is_special' : '0 AS is_special'}
            ${ci ? ', ci.cv_issue_id AS ci_cv, ci.series_name AS ci_series, ci.volume_year AS ci_year, ci.orig_number AS ci_number' : ', NULL AS ci_cv'}
          FROM scanned_books sb ${ci ? 'LEFT JOIN book_ci_index ci ON ci.book_id = sb.id' : ''} WHERE sb.series_id = ?`).all(s.id);
        for (const b of books) b.sub = describe(b, s.name);   // annual/special filed here, or null
      } else if (req.query.cv) {
        volId = String(req.query.cv).replace(/\D/g, '');
        if (!volId) return res.status(400).json({ error: 'cv volume id required' });
        volume = { source: 'cv', id: volId, name: req.query.name || null, year: /^\d{4}$/.test(String(req.query.year || '')) ? Number(req.query.year) : null,
          publisher: req.query.publisher || null, cv_volume_id: volId };
      } else return res.status(400).json({ error: 'library or cv required' });

      let cvIssues = [], cvError = null;
      if (volId) { try { cvIssues = await fetchVolumeIssues(volId); } catch (e) { cvError = e.message; } }
      // Owned books for these Comic Vine ids, anywhere in the library (folder tag or ComicInfo link).
      const ids = JSON.stringify(cvIssues.map(i => String(i.id)));
      const byCv = new Map();
      if (cvIssues.length) {
        for (const r of db.prepare('SELECT id, cv_issue_id AS cv FROM scanned_books WHERE cv_issue_id IN (SELECT value FROM json_each(?))').all(ids)) if (!byCv.has(String(r.cv))) byCv.set(String(r.cv), r.id);
        try { for (const r of db.prepare('SELECT book_id AS id, cv_issue_id AS cv FROM book_ci_index WHERE cv_issue_id IN (SELECT value FROM json_each(?))').all(ids)) if (!byCv.has(String(r.cv))) byCv.set(String(r.cv), r.id); } catch {}
      }
      // Untagged books in the folder count by number (never annual files).
      const byNum = new Map();
      for (const b of books) {
        if (b.cv_issue_id || b.ci_cv || b.sub || /annual/i.test(b.filename || '')) continue;
        const n = numOf(b.issue_number); if (n && !byNum.has(n)) byNum.set(n, b.id);
      }
      const used = new Set(), issues = [];
      for (const i of cvIssues) {
        const n = numOf(i.issue_number) || '0';
        const bid = byCv.get(String(i.id)) || byNum.get(n) || null;
        if (bid) used.add(bid);
        issues.push({ number: n, title: i.name || null, cv_issue_id: String(i.id), book_id: bid, date: i.cover_date || null,
          image: (i.image && (i.image.thumb_url || i.image.small_url)) || null });
      }
      // Library books Comic Vine does not list (or no Comic Vine volume): as they are.
      // Annuals and specials go after the regular issues, by the name they were published under.
      const subs = [];
      for (const b of books) if (!used.has(b.id)) {
        if (b.sub) { subs.push({ number: numOf(b.sub.number) || '?', title: b.title || null, cv_issue_id: b.cv_issue_id || b.ci_cv || null, book_id: b.id, date: null, image: null,
          group: `${b.sub.name}${b.sub.year ? ` (${b.sub.year})` : ''}`, kind: b.sub.kind, series_name: b.sub.name, volume_year: b.sub.year || null }); continue; }
        issues.push({ number: numOf(b.issue_number) || '?', title: b.title || null, cv_issue_id: b.cv_issue_id || b.ci_cv || null, book_id: b.id, date: null, image: null, extra: cvIssues.length > 0 });
      }
      issues.sort((a, b) => numKey(a.number) - numKey(b.number) || String(a.number).localeCompare(String(b.number)));
      subs.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'annual' ? -1 : 1) || (a.volume_year || 0) - (b.volume_year || 0)
        || a.group.localeCompare(b.group) || numKey(a.number) - numKey(b.number));
      issues.push(...subs);
      res.json({ volume, issues, cvError });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
