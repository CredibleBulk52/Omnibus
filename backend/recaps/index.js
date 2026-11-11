'use strict';
const fs = require('fs');
// ─── Recaps ("Previously on…"): wiring and admin tools ────────────────────
// Design: claude/RECAPS_DESIGN.md and the "Recap Architecture" page.
//   synopses.js  one stored synopsis per issue (web, then pages)
//   arcs.js      story arcs from titles / Comic Vine / writer runs; stretch summaries
//   scope.js     what a recap covers, the spoiler line, the limits; gathering the material
// Comic Book Guy's story_so_far tool (assistant.js) calls prepare() → gather() → asText().
//
// Admin (for trying it before Comic Book Guy uses it):
//   GET  /api/admin/recaps/plan?seriesId=|bookId=|listId=|eventId=|runId= &until= &mode= &includeEarlier=1 &cv=0
//        the plan only: no AI, no spending (Comic Vine story-arc lookups unless cv=0)
//   POST /api/admin/recaps/synopsis { book_id, force?, pages? }   one issue's synopsis (may spend ~2–10¢)
//   POST /api/admin/recaps/material { …plan options, storedOnly? } the plan, gathered (spends within the limits)
//   GET  /api/admin/recaps/synopsis/:bookId                        what is stored for one issue

const { createSynopses } = require('./synopses');
const { createArcs } = require('./arcs');
const { createScope, LIMITS } = require('./scope');
const { createSummaryImport } = require('./importSummaries');

module.exports = function createRecaps({ app, db, ai, logger, getPageImage, modelCatalog, cvApiGet, getCVKey, readingLists, bookIndex, requireAdmin, axios = null, webLookup = null }) {
  const synopses = createSynopses({ db, ai, logger, getPageImage, modelCatalog, axios, webLookup });
  const arcs = createArcs({ db, ai, logger, cvApiGet, getCVKey, modelCatalog, axios, webLookup });
  const scope = createScope({ db, synopses, arcs, readingLists, bookIndex, logger });
  const imports = createSummaryImport({ db, logger });
  // New run files are picked up by themselves: shortly after start, then hourly. Nothing
  // happens when the folder does not exist (other people's installs).
  if (app && !process.env.OMNIBUS_NO_SUMMARY_IMPORT) {
    const tick = () => { try { imports.importAll(); } catch (e) { logger?.warn?.('recaps', 'Summary import failed', { error: e.message }); } };
    setTimeout(tick, 2 * 60 * 1000).unref?.();
    setInterval(tick, 60 * 60 * 1000).unref?.();
  }

  // The plan, after looking up Comic Vine story arcs for ungrouped issues in it
  // (newest first, capped; free in money, about a second each, kept for next time).
  async function prepare(opts, { cv = true } = {}) {
    let p = scope.plan(opts);
    if (p.error || !cv) return p;
    const I = p._internal;
    const blocks = [...I.groups, ...I.older, ...I.far].filter(g => g.kind === 'block').reverse();
    const books = blocks.flatMap(g => [...g.books].reverse()).filter(b => b.cv_issue_id && !arcs.cachedCvArcs(b.cv_issue_id));
    if (books.length && (await arcs.lookupCvArcs(books, LIMITS.cvArcLookups)) > 0) p = scope.plan(opts);
    return p;
  }
  const publicPlan = p => { const { _internal, ...rest } = p; return rest; };

  const optsFrom = (q, user) => ({
    userId: user?.sub, bookId: q.bookId || q.book_id || undefined, seriesId: q.seriesId || q.series_id || undefined,
    listId: q.listId || q.list_id || undefined, eventId: q.eventId || q.event_id || undefined, runId: q.runId || q.run_id || undefined,
    until: q.until || undefined, mode: ['auto', 'overview', 'issues'].includes(q.mode) ? q.mode : undefined,
    includeEarlier: q.includeEarlier === true || q.includeEarlier === '1' || q.includeEarlier === 'true',
    issueCount: q.issueCount ? parseInt(q.issueCount, 10) : undefined,
  });

  if (app && requireAdmin) {
    app.get('/api/admin/recaps/plan', requireAdmin, async (req, res) => {
      try {
        const p = await prepare(optsFrom(req.query, req.user), { cv: req.query.cv !== '0' });
        if (p.error) return res.status(400).json(p);
        res.json(publicPlan(p));
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.get('/api/admin/recaps/synopsis/:bookId', requireAdmin, (req, res) => {
      const b = db.prepare('SELECT id, cv_issue_id FROM scanned_books WHERE id = ?').get(String(req.params.bookId));
      if (!b) return res.status(404).json({ error: 'Book not found' });
      res.json({ stored: db.prepare('SELECT * FROM issue_synopses WHERE issue_key = ?').get(synopses.keyOf(b)) || null });
    });
    app.post('/api/admin/recaps/synopsis', requireAdmin, async (req, res) => {
      const { book_id, force, pages } = req.body || {};
      if (!book_id) return res.status(400).json({ error: 'book_id is required' });
      try { res.json(await synopses.ensure(book_id, { force: !!force, allowPages: pages !== false })); }
      catch (e) { res.status(e.message === 'Book not found' ? 404 : 500).json({ error: e.message }); }
    });
    // Trial of the web step alone for one issue: nothing stored (about 2¢).
    app.post('/api/admin/recaps/web-test', requireAdmin, async (req, res) => {
      if (!req.body?.book_id) return res.status(400).json({ error: 'book_id is required' });
      try { res.json(await synopses.tryWeb(req.body.book_id)); }
      catch (e) { res.status(e.message === 'Book not found' ? 404 : 500).json({ error: e.message }); }
    });
    // Summaries written outside Omnibus (ChatGPT run files in <comics>/_summaries_outputs).
    // POST { dryRun?, force? } imports new or changed run files; GET shows what was imported.
    app.post('/api/admin/recaps/import', requireAdmin, (req, res) => {
      try { res.json(imports.importAll({ dryRun: !!req.body?.dryRun, force: !!req.body?.force })); }
      catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.get('/api/admin/recaps/import', requireAdmin, (req, res) => {
      try { res.json({ folder: imports.folder, stored: imports.counts(), files: imports.history() }); }
      catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.post('/api/admin/recaps/material', requireAdmin, async (req, res) => {
      try {
        const p = await prepare(optsFrom(req.body || {}, req.user));
        if (p.error) return res.status(400).json(p);
        const g = await scope.gather(p, { storedOnly: !!req.body?.storedOnly });
        res.json({ plan: publicPlan(p), spentCents: g.spentCents, text: scope.asText(p, g) });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  }

  return { synopses, arcs, scope, imports, prepare, publicPlan, LIMITS };
};
