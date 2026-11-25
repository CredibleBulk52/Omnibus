'use strict';
// ─── Timeline events: routes (moved out of server.js 2026-11-24, server.js split, events) ───
// Comic Vine story arcs, the event list and page, creating events (generated or by hand), adding,
// matching, ordering and deleting event issues, generator sources, tier notes (one event, or all in
// the background), the manual re-match and deleting an event. The generator itself is eventGenerator.js;
// matching is eventReconcile.js. Moved unchanged.
const fs = require('fs');
const path = require('path');

const NEEDS = ['ai', 'aiInfo', 'app', 'coverThumb', 'cvApiGet', 'db', 'editorTools', 'EVENT_ADMIN_ONLY', 'filterImages', 'findThumbCache', 'getCVKey', 'listArchiveFiles', 'logger', 'modelCatalog', 'readArchiveMember', 'reconcileEventIssues', 'requireAdmin', 'requireAuth', 'setAiJobOutcome', 'THUMB_CACHE_DIR', 'withThumbSlot'];
module.exports.NEEDS = NEEDS;

module.exports.registerEventRoutes = function registerEventRoutes(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`registerEventRoutes: missing ${missing.join(', ')}`);
  const { ai, aiInfo, app, coverThumb, cvApiGet, db, editorTools, EVENT_ADMIN_ONLY, filterImages, findThumbCache, getCVKey, listArchiveFiles, logger, modelCatalog, readArchiveMember, reconcileEventIssues, requireAdmin, requireAuth, setAiJobOutcome, THUMB_CACHE_DIR, withThumbSlot } = deps;
  // ─── Events System ────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════

  // ─── CV story arc search ──────────────────────────────────────────
  app.get('/api/cv/story-arcs', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    try {
      const r = await cvApiGet('https://comicvine.gamespot.com/api/story_arcs/', {
        params: {
          api_key: getCVKey(), format: 'json',
          filter: `name:${q}`,
          field_list: 'id,name,publisher,count_of_issue_appearances,image,site_detail_url,description',
          limit: 10,
        },
        headers: { 'User-Agent': 'Omnibus/1.0' },
      });
      // Normalise to count_of_issues for frontend consistency
      const results = (r.data.results || []).map(a => ({
        ...a,
        count_of_issues: a.count_of_issue_appearances || 0,
      }));
      res.json({ results });
    } catch (e) {
      logger.error('events', 'CV story arc search failed', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Fetch issues for a CV story arc ─────────────────────────────
  app.get('/api/cv/story-arcs/:id/issues', async (req, res) => {
    try {
      // Step 1: get issue stubs from arc endpoint
      const r = await cvApiGet(`https://comicvine.gamespot.com/api/story_arc/4045-${req.params.id}/`, {
        params: { api_key: getCVKey(), format: 'json', field_list: 'id,name,issues' },
        headers: { 'User-Agent': 'Omnibus/1.0' },
      });
      const arc = r.data.results || {};
      const stubs = arc.issues || [];

      // Step 2: fetch full data including volume, issue_number, cover_date in batches
      const issues = [];
      const batchSize = 25;
      for (let i = 0; i < stubs.length; i += batchSize) {
        const ids = stubs.slice(i, i + batchSize).map(s => s.id).join('|');
        const issData = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
          params: {
            api_key: getCVKey(), format: 'json',
            filter: `id:${ids}`,
            field_list: 'id,issue_number,name,cover_date,volume',
            limit: batchSize,
          },
          headers: { 'User-Agent': 'Omnibus/1.0' },
        });
        for (const iss of (issData.data.results || [])) {
          issues.push({
            id: String(iss.id),
            name: iss.name,
            issue_number: iss.issue_number,
            cover_date: iss.cover_date,
            volume: iss.volume ? { id: String(iss.volume.id), name: iss.volume.name } : null,
          });
        }
        if (i + batchSize < stubs.length) await new Promise(r => setTimeout(r, 300));
      }
      res.json({ id: req.params.id, name: arc.name, issues });
    } catch (e) {
      logger.error('events', 'CV story arc issues fetch failed', e.message);
      res.status(500).json({ error: e.message });
    }
  });



  // ─── List events ──────────────────────────────────────────────────
  // Optional ?publisher= filter (maps to library publisher name)
  app.get('/api/events', (req, res) => {
    const { publisher } = req.query;
    let events;
    // Draft events (imported, not yet published) are listed for admins only, flagged draft: 1.
    const shown = req.user?.role === 'admin' ? '1 = 1' : require('./eventDrafts').published(db);
    if (publisher) {
      events = db.prepare(
        `SELECT * FROM events WHERE (publisher = ? OR publisher IS NULL) AND ${shown} ORDER BY year ASC, sort_order ASC, name ASC`
      ).all(publisher);
    } else {
      events = db.prepare(`SELECT * FROM events WHERE ${shown} ORDER BY year ASC, sort_order ASC, name ASC`).all();
    }
    // Attach owned/total counts per event
    const countStmt = db.prepare(
      "SELECT COUNT(*) as total, SUM(CASE WHEN scanned_book_id IS NOT NULL THEN 1 ELSE 0 END) as owned FROM event_issues WHERE event_id = ?"
    );

    // Thumbnail priority:
    // 1. Issue #1 of the series whose name best matches the event name
    // 2. Any issue #1 with a scanned book
    // 3. First scanned book by sort_order
    const thumbMainStmt = db.prepare(`
    SELECT ei.scanned_book_id FROM event_issues ei
    WHERE ei.event_id = ? AND ei.scanned_book_id IS NOT NULL AND ei.issue_number = '1'
    AND (LOWER(ei.series_name) LIKE LOWER('%' || ? || '%') OR LOWER(?) LIKE LOWER('%' || ei.series_name || '%'))
    ORDER BY ei.sort_order ASC LIMIT 1
  `);
    const thumbIssue1Stmt = db.prepare(`
    SELECT ei.scanned_book_id FROM event_issues ei
    WHERE ei.event_id = ? AND ei.scanned_book_id IS NOT NULL AND ei.issue_number = '1'
    ORDER BY ei.sort_order ASC LIMIT 1
  `);
    const thumbFirstStmt = db.prepare(`
    SELECT ei.scanned_book_id FROM event_issues ei
    WHERE ei.event_id = ? AND ei.scanned_book_id IS NOT NULL
    ORDER BY ei.sort_order ASC LIMIT 1
  `);

    // An issue picked in the editor (⋯ › Use as Timeline cover, 2026-11-10) comes first, while it
    // is still matched to a book; then the image link; then the automatic choice below.
    const pickedStmt = db.prepare(`SELECT ei.scanned_book_id FROM event_issues ei JOIN scanned_books sb ON sb.id = ei.scanned_book_id
    WHERE ei.id = ? AND ei.event_id = ?`);
    const result = events.map(e => {
      const counts = countStmt.get(e.id) || { total: 0, owned: 0 };
      const picked = e.cover_issue_id != null ? pickedStmt.get(e.cover_issue_id, String(e.id)) : null;
      if (picked) return { ...e, total_issues: counts.total, owned_issues: counts.owned, thumbnail_book_id: picked.scanned_book_id };
      // If a cover_image is explicitly set, use it — skip book thumbnail logic
      if (e.cover_image) {
        return { ...e, total_issues: counts.total, owned_issues: counts.owned, thumbnail_book_id: null };
      }
      const thumbMain = thumbMainStmt.get(e.id, e.name, e.name);
      const thumbIssue1 = !thumbMain ? thumbIssue1Stmt.get(e.id) : null;
      const thumbFirst = (!thumbMain && !thumbIssue1) ? thumbFirstStmt.get(e.id) : null;
      const thumbnail_book_id = (thumbMain || thumbIssue1 || thumbFirst)?.scanned_book_id || null;
      return { ...e, total_issues: counts.total, owned_issues: counts.owned, thumbnail_book_id };
    });
    res.json(result);

    // Pre-warm thumbnail cache in background — fires after response is sent.
    // Any book whose thumb isn't cached yet gets extracted so it's ready when
    // the browser requests it, instead of making the user wait on scroll.
    setImmediate(() => {
      const bookIds = result.map(e => e.thumbnail_book_id).filter(Boolean);
      for (const bookId of bookIds) {
        if (findThumbCache(String(bookId))) continue; // already cached, skip
        const book = db.prepare('SELECT * FROM scanned_books WHERE id = ?').get(bookId);
        if (!book) continue;
        // Use withThumbSlot so pre-warm doesn't starve live requests
        withThumbSlot(async () => {
          try {
            const files = await listArchiveFiles(book.path);
            const images = filterImages(files);
            if (!images.length) return;
            const archExt = path.extname(book.path).toLowerCase();
            const stdout = await readArchiveMember(book.path, images[0], 10 * 1024 * 1024);
            const t = await coverThumb(stdout, path.extname(images[0]).toLowerCase() || '.jpg');
            await fs.promises.writeFile(path.join(THUMB_CACHE_DIR, `${bookId}${t.ext}`), t.buf);
          } catch {}
        }).catch(() => {});
      }
    });
  });

  // ─── Create event (AI-generated, issues required) ─────────────────
  app.post('/api/events', requireAdmin, (req, res) => {
    const { name, publisher, year, cv_story_arc_id, description, cover_image, issues, generator } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!issues || !Array.isArray(issues) || issues.length === 0)
      return res.status(400).json({ error: 'issues array required' });

    // Every issue needs a series and a number (NOT NULL). A missing sort_order takes the issue's place in
    // the list. The event and its issues are written in one transaction, so a refused issue no longer
    // leaves an empty event behind (2026-11-25).
    const bad = issues.map((i, n) => (!i || !String(i.series_name ?? '').trim() || !String(i.issue_number ?? '').trim()) ? n + 1 : null).filter(Boolean);
    if (bad.length) return res.status(400).json({ error: `series_name and issue_number required (issue${bad.length > 1 ? 's' : ''} ${bad.slice(0, 10).join(', ')}${bad.length > 10 ? ' …' : ''})` });
    const id = require('crypto').randomUUID();
    try {
      const insertEvent = db.prepare(
        "INSERT INTO events (id, name, publisher, year, cv_story_arc_id, description, cover_image, source, generator_sources) VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?)");
      const insertIssue = db.prepare(`
      INSERT INTO event_issues (event_id, cv_issue_id, sort_order, tier, tier_note, phase, series_name, issue_number, issue_title, volume_year, sources, order_note, order_flag, tier_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
      db.transaction(() => {
        insertEvent.run(id, name, publisher || null, year || null, cv_story_arc_id || null, description || null, cover_image || null,
          generator ? JSON.stringify({ source: generator.source || null, sourceUrl: generator.sourceUrl || null, centralNarrative: generator.centralNarrative || null,
            sourcesRead: Array.isArray(generator.sourcesRead) ? generator.sourcesRead : [], omitted: Array.isArray(generator.omitted) ? generator.omitted : [] }) : null);
        issues.forEach((i, n) => {
          insertIssue.run(id, i.cv_issue_id || null, i.sort_order ?? n + 1, i.tier || 'recommended',
            i.tier_note || null, i.phase || null, i.series_name, i.issue_number, i.issue_title || null,
            i.volume_year ? String(i.volume_year) : null,
            Array.isArray(i.sources) && i.sources.length ? JSON.stringify(i.sources) : null, i.order_note || null, i.order_flag || null, i.tier_reason || null);
        });
      })();

      // The shared matcher first (2026-10-17), then the old background matcher for what is left.
      try { editorTools.fillUnmatched('event', id); } catch (e) { logger.warn('events', 'Shared matcher after create failed', { error: e.message }); }
      setImmediate(reconcileEventIssues);
      res.json({ success: true, id });
    } catch (e) {
      logger.error('events', 'Create event failed', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Create event manually (no issues required) ────────────────────
  app.post('/api/events/manual', requireAdmin, (req, res) => {
    const { name, publisher, year, description, cover_image, event_tier } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const id = crypto.randomUUID();
    try {
      db.prepare(
        "INSERT INTO events (id, name, publisher, year, description, cover_image, event_tier, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')"
      ).run(id, name.trim(), publisher || null, year ? parseInt(year) : null,
        description || null, cover_image || null, event_tier ?? 2);
      res.json({ success: true, id });
    } catch (e) {
      logger.error('events', 'Manual create failed', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Add issue to event manually ──────────────────────────────────
  app.post('/api/events/:id/issues', requireAdmin, (req, res) => {
    const { scanned_book_id, series_name, issue_number, issue_title, volume_year, tier, tier_note, phase } = req.body;
    if (!series_name || !issue_number) return res.status(400).json({ error: 'series_name and issue_number required' });
    try {
      // Get max sort_order
      const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM event_issues WHERE event_id = ?').get(req.params.id)?.m || 0;
      // Look up cv_issue_id from scanned_books if a book is provided
      let cv_issue_id = null;
      if (scanned_book_id) {
        const book = db.prepare('SELECT cv_issue_id FROM scanned_books WHERE id = ?').get(scanned_book_id);
        cv_issue_id = book?.cv_issue_id || null;
      }
      const info = db.prepare(`
      INSERT INTO event_issues (event_id, cv_issue_id, scanned_book_id, sort_order, tier, tier_note, phase, series_name, issue_number, issue_title, volume_year, manually_matched)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(req.params.id, cv_issue_id, scanned_book_id || null, maxOrder + 1,
        tier || 'recommended', tier_note || null, phase || null,
        series_name, issue_number, issue_title || null, volume_year ? String(volume_year) : null);
      res.json({ success: true, id: info.lastInsertRowid });
    } catch (e) {
      logger.error('events', 'Add issue failed', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Get event detail ─────────────────────────────────────────────
  // ─── Manual match: set/clear scanned_book_id on a single event issue ───────
  // The Comic Vine issue id of a library book: its folder tag, else its ComicInfo link.
  function bookCvId(bookId) {
    if (!bookId) return null;
    const r = db.prepare(`SELECT sb.cv_issue_id AS cv, (SELECT ci.cv_issue_id FROM book_ci_index ci WHERE ci.book_id = sb.id) AS ci
    FROM scanned_books sb WHERE sb.id = ?`).get(String(bookId));
    return r ? (r.cv || r.ci || null) : null;
  }
  // syncCv (sent by the shared editor's Confirm match, user 2026-10-17): the
  // issue also takes the chosen comic's Comic Vine id, so downloads and
  // Generate follow the comic that was picked.
  app.put('/api/events/:id/issues/:issueId/match', requireAdmin, (req, res) => {
    const { scanned_book_id, syncCv } = req.body;
    const result = db.prepare(
      "UPDATE event_issues SET scanned_book_id = ?, manually_matched = ? WHERE id = ? AND event_id = ?"
    ).run(scanned_book_id || null, scanned_book_id ? 1 : 0, req.params.issueId, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Issue not found' });
    const cv = syncCv && scanned_book_id ? bookCvId(scanned_book_id) : null;
    if (cv) db.prepare('UPDATE event_issues SET cv_issue_id = ? WHERE id = ? AND event_id = ?').run(String(cv), req.params.issueId, req.params.id);
    res.json({ success: true, scanned_book_id: scanned_book_id || null, cv_issue_id: cv });
  });

  // ─── Book search for manual match picker ─────────────────────────
  // MUST be before GET /api/events/:id or Express treats "book-search" as :id
  // Normalises punctuation so "Firestorm: The Nuclear Man" matches "Firestorm, the Nuclear Man"
  app.get('/api/events/book-search', requireAuth, (req, res) => {
    const { q, issue } = req.query;
    if (!q || !q.trim()) return res.json([]);

    // Dotted initials are one word ("L.E.G.I.O.N." → "legion"); names are compared without dots.
    const plainName = s => String(s || '').replace(/\b(?:[a-z]\.){2,}/gi, m => m.replace(/\./g, '')).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const qNorm  = plainName(q);
    const words  = qNorm.split(/\s+/).filter(w => w.length > 1);
    if (!words.length) return res.json([]);

    try {
      const wordConditions = words.map(() =>
        `(REPLACE(LOWER(ss.name), '.', '') LIKE ? OR REPLACE(LOWER(sb.filename), '.', '') LIKE ?)`
      ).join(' AND ');
      const wordParams = words.flatMap(w => [`%${w}%`, `%${w}%`]);
      const issueFilter = issue ? `AND sb.issue_number = ?` : '';
      // Optional volume year (the series folder's year): only that volume's
      // issues, so "#1" does not bring every #1 of the title. Nothing that
      // year → the year either side (folder years are sometimes off by one);
      // the X-Year-Match header says which (exact | near | none).
      const yr = /^(?:18|19|20)\d{2}$/.test(String(req.query.year || '').trim()) ? Number(String(req.query.year).trim()) : null;
      const find = (yearSql, yearParams) => {
        const sql = `
        SELECT sb.id, sb.filename, sb.issue_number, sb.cv_issue_id,
               ss.name as series_name, ss.year as series_year
        FROM scanned_books sb
        JOIN scanned_series ss ON ss.id = sb.series_id
        WHERE ${wordConditions} ${issueFilter} ${yearSql}
        ORDER BY ss.name ASC, CAST(sb.issue_number AS REAL) ASC
        LIMIT 80
      `;
        let found = db.prepare(sql).all(...wordParams, ...(issue ? [issue] : []), ...yearParams);
        // A year in the number box for an annual ("World's Finest Annual" #2025):
        // year-titled annuals are #1 with the year in their name.
        if (!found.length && issue && /^(?:19|20)\d{2}$/.test(String(issue).trim())) {
          found = db.prepare(sql.replace(issueFilter, `AND (LOWER(ss.name) LIKE ? OR sb.filename LIKE ?)`))
            .all(...wordParams, `%${issue}%`, `%${issue}%`, ...yearParams);
        }
        return found;
      };
      let rows;
      if (yr) {
        rows = find(`AND (CAST(ss.year AS INTEGER) = ? OR (ss.year IS NULL AND sb.filename LIKE ?))`, [yr, `%(${yr})%`]);
        let match = 'exact';
        if (!rows.length) { rows = find(`AND CAST(ss.year AS INTEGER) BETWEEN ? AND ?`, [yr - 1, yr + 1]); match = rows.length ? 'near' : 'none'; }
        res.set('X-Year-Match', match);
      } else rows = find('', []);

      // Score by name similarity — closer match to query floats higher
      const scored = rows.map(row => {
        const sNorm = plainName(row.series_name);
        const sWords = sNorm.split(/\s+/).filter(Boolean);
        // Exact match after normalization
        if (sNorm === qNorm) return { ...row, _score: 1000 };
        // Count query words present in series name
        const matchCount = words.filter(w => sNorm.includes(w)).length;
        // Penalize extra words in series name — tie-ins have more words
        const extraWords = Math.max(0, sWords.length - words.length);
        return { ...row, _score: matchCount * 100 - extraWords * 10 };
      });

      scored.sort((a, b) => b._score - a._score);
      res.json(scored.slice(0, 40));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/events/:id', requireAuth, (req, res) => {
    const event = db.prepare("SELECT * FROM events WHERE id = ?").get(req.params.id);
    if (!event || (event.draft && req.user?.role !== 'admin')) return res.status(404).json({ error: 'Event not found' });   // drafts: admins only

    const userId = req.user?.sub || null;

    const issues = db.prepare(`
    SELECT ei.*,
      sb.path as book_path, sb.filename as book_filename,
      sb.comicinfo as book_comicinfo,
      rp.page as rp_page, rp.completed as rp_completed
    FROM event_issues ei
    LEFT JOIN scanned_books sb ON sb.id = ei.scanned_book_id
    LEFT JOIN read_progress rp ON rp.book_id = ei.scanned_book_id
      AND (rp.user_id = ? OR rp.user_id IS NULL)
    WHERE ei.event_id = ?
    ORDER BY ei.sort_order ASC
  `).all(userId, req.params.id);

    // Attach readProgress in the same shape as series/books endpoints
    // Story titles: the event's own when set, else the file's ComicInfo title ("Impulse Control, Part 1").
    const issuesWithProgress = issues.map(i => ({
      ...i,
      issue_title: i.issue_title || require('./eventNotes').titleOf(i.book_comicinfo),
      solicit: require('./eventNotes').solicitOf(i.book_comicinfo, 1500),   // for the tap card's drop-down
      readProgress: (i.rp_page != null || i.rp_completed != null)
        ? { page: i.rp_page || 0, completed: !!i.rp_completed }
        : null,
    }));

    // Generator sources are admin-only (GET /api/events/:id/sources).
    const { generator_sources, ...eventOut } = event;
    for (const i of issuesWithProgress) for (const k of EVENT_ADMIN_ONLY) delete i[k];
    res.json({ ...eventOut, issues: issuesWithProgress });
  });

  // ─── Generator sources (admin, "Show sources") ────────────────────
  // What the event generator recorded: the pages it read, the issues it left out, and per issue the
  // sites that list it, why it was moved from release order, and a release-position flag.
  app.get('/api/events/:id/sources', requireAdmin, (req, res) => {
    const event = db.prepare("SELECT generator_sources FROM events WHERE id = ?").get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    let gen = null;
    try { gen = event.generator_sources ? JSON.parse(event.generator_sources) : null; } catch {}
    const issues = db.prepare("SELECT id, sources, order_note, order_flag, tier_reason FROM event_issues WHERE event_id = ?").all(req.params.id)
      .map(r => { let src = []; try { src = r.sources ? JSON.parse(r.sources) : []; } catch {} return { id: r.id, sources: src, order_note: r.order_note || null, order_flag: r.order_flag || null, tier_reason: r.tier_reason || null }; });
    res.json({ recorded: !!gen, source: gen?.source || null, sourceUrl: gen?.sourceUrl || null, centralNarrative: gen?.centralNarrative || null,
      sourcesRead: gen?.sourcesRead || [], omitted: gen?.omitted || [], issues });
  });

  // ─── Update event metadata ────────────────────────────────────────
  app.put('/api/events/:id', requireAdmin, (req, res) => {
    // Only the fields sent are changed (2026-11-25): a body without a name failed (events.name is
    // NOT NULL), and every field left out was cleared. Values are converted as before.
    const body = req.body || {};
    const event = db.prepare("SELECT id FROM events WHERE id = ?").get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if ('name' in body && !String(body.name ?? '').trim()) return res.status(400).json({ error: 'name cannot be empty' });
    const FIELDS = {
      name: v => v, publisher: v => v || null, year: v => v || null, description: v => v || null,
      cover_image: v => v || null, event_tier: v => v ?? 2, sort_order: v => v != null ? parseInt(v) : 0,
    };
    const keys = Object.keys(FIELDS).filter(k => k in body);
    if (!keys.length) return res.status(400).json({ error: `nothing to update (fields: ${Object.keys(FIELDS).join(', ')})` });
    db.prepare(`UPDATE events SET ${keys.map(k => `${k}=?`).join(', ')} WHERE id=?`).run(...keys.map(k => FIELDS[k](body[k])), req.params.id);
    res.json({ success: true });
  });

  // ─── Bulk update event issues (sort_order + tier + phase) ────────
  // Body: { issues: [{ id, sort_order, tier, tier_note, phase }] }
  app.put('/api/events/:id/issues', requireAdmin, (req, res) => {
    const { issues } = req.body;
    if (!Array.isArray(issues)) return res.status(400).json({ error: 'issues array required' });
    const upd = db.prepare(
      "UPDATE event_issues SET sort_order=?, tier=?, tier_note=?, phase=? WHERE id=? AND event_id=?"
    );
    db.transaction(() => {
      for (const i of issues) upd.run(i.sort_order, i.tier, i.tier_note || null, i.phase || null, i.id, req.params.id);
    })();
    res.json({ success: true });
  });

  // ─── Delete a single event issue ─────────────────────────────────
  app.delete('/api/events/:id/issues/:issueId', requireAdmin, (req, res) => {
    db.prepare("DELETE FROM event_issues WHERE id=? AND event_id=?").run(req.params.issueId, req.params.id);
    res.json({ success: true });
  });

  // ─── Tier notes for event issues (Event Tier Notes task) ─────────
  // Reader-facing tier_notes written from what Omnibus already has (eventNotes.js, 2026-10-22): the
  // generator's tier reasons, each issue's solicit (ComicInfo Summary) and saved synopses. No web
  // search (about 2¢ an event on Haiku; the old version searched up to 3 times on Sonnet). Issues with
  // none of these get no note. Replies are matched by list number and checked against series and
  // issue number. Does not change tiers, phases or order; never clears an existing note.
  const eventNotes = require('./eventNotes');
  try { db.prepare('ALTER TABLE events ADD COLUMN notes_refreshed_at INTEGER').run(); } catch {}
  const httpError = (status, message) => Object.assign(new Error(message), { status });

  // Writes (or previews) one event's tier notes. → { notes: [{id, tier_note}], written, stats, cents }.
  // Each event's notes are one AI run (several jobs for a long event).
  function writeTierNotes(eventId, opts) {
    let ev = null;
    try { ev = db.prepare('SELECT name, year FROM events WHERE id = ?').get(eventId); } catch {}
    return ai.run({ label: `Tier notes: ${ev ? `${ev.name}${ev.year ? ` (${ev.year})` : ''}` : eventId}` }, () => writeTierNotesNow(eventId, opts));
  }
  async function writeTierNotesNow(eventId, { preview = false } = {}) {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) throw httpError(404, 'Event not found');
    const rows = db.prepare(`SELECT ei.id, ei.series_name, ei.issue_number, ei.volume_year, ei.issue_title, ei.tier, ei.phase, ei.tier_note, ei.tier_reason,
      ei.cv_issue_id, ei.scanned_book_id, sb.comicinfo
    FROM event_issues ei LEFT JOIN scanned_books sb ON sb.id = ei.scanned_book_id WHERE ei.event_id = ? ORDER BY ei.sort_order`).all(eventId);
    if (!rows.length) throw httpError(400, 'No issues to annotate');
    let synopsisOf = () => null;
    try {
      const q = db.prepare("SELECT synopsis FROM issue_synopses WHERE issue_key = ? AND status = 'ok' AND source != 'comicinfo'");
      synopsisOf = r => { const k = r.cv_issue_id ? String(r.cv_issue_id) : r.scanned_book_id ? `book:${r.scanned_book_id}` : null; const x = k && q.get(k); return x && x.synopsis ? String(x.synopsis).slice(0, 900) : null; };
    } catch {}
    let centralNarrative = null;
    try { centralNarrative = JSON.parse(event.generator_sources || 'null')?.centralNarrative || null; } catch {}
    const all = rows.map((r, k) => ({ ...r, n: k + 1, tier_reason: r.tier_reason || null, title: r.issue_title || eventNotes.titleOf(r.comicinfo),
      solicit: eventNotes.solicitOf(r.comicinfo), synopsis: synopsisOf(r) }));
    const items = all.filter(eventNotes.hasMaterial);
    if (!items.length) throw httpError(400, 'None of these issues has a solicit, synopsis or tier reason to write from');

    const job = ai.newJobId();
    const totals = { input: 0, output: 0, mismatched: 0, missing: 0 };
    const notes = [];
    let model = null;
    try {
      // Parts of 40 issues, with room for ~250 tokens a note (the first version allowed 110 and every
      // DC K.O. reply was cut off). Issues a cut-off reply did not reach are asked again once, in halves.
      const BATCH = 40;
      const queue = [];
      for (let k = 0; k < items.length; k += BATCH) queue.push({ part: items.slice(k, k + BATCH), retry: false });
      while (queue.length) {
        const { part: raw, retry } = queue.shift();
        const part = raw.map((i, j) => ({ ...i, n: j + 1 }));
        const prompt = eventNotes.buildPrompt({ event, centralNarrative, items: part });
        const opts = { task: 'event_notes', prompt, maxTokens: Math.min(32000, 1500 + 250 * part.length), timeout: 180000, jobId: job };
        // Thinking off (short writing from supplied material; with it on, Haiku 5.5 used the whole reply
        // budget thinking and wrote nothing). A 400 drops the option, then the schema.
        let data = null, lastErr = null;
        for (const extra of [{ thinking: 'off', outputSchema: eventNotes.NOTES_SCHEMA }, { outputSchema: eventNotes.NOTES_SCHEMA }, {}]) {
          try { ({ data } = await ai.complete({ ...opts, ...extra })); break; }
          catch (e) { lastErr = e; if (e.response?.status !== 400) throw e; logger.warn('events', 'Tier notes: the API refused an option; trying without it', { options: Object.keys(extra), error: e.response?.data?.error?.message }); }
        }
        if (!data) throw lastErr;
        model = data.model || model;
        totals.input += data.usage?.input_tokens || 0; totals.output += data.usage?.output_tokens || 0;
        const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        let reply = [];
        try { reply = eventNotes.parseReply(text); }
        catch (e) {
          logger.warn('events', 'Tier notes: reply could not be read', { stop: data.stop_reason, output: data.usage?.output_tokens, issues: part.length,
            blocks: (data.content || []).map(b => b.type).join(','), tail: text.slice(-300) });
          if (retry || part.length < 2) { totals.missing += part.length; continue; }
        }
        const m = eventNotes.matchNotes(part, reply);
        totals.mismatched += m.mismatched;
        notes.push(...m.notes);
        const done = new Set(m.notes.map(n => n.id));
        const left = raw.filter(i => !done.has(i.id));
        if (left.length && !retry && data.stop_reason === 'max_tokens') {
          logger.warn('events', `Tier notes: reply cut off after ${done.size} of ${part.length}; asking again for the rest`, { output: data.usage?.output_tokens });
          const h = Math.ceil(left.length / 2);
          queue.push({ part: left.slice(0, h), retry: true }); if (left.length > h) queue.push({ part: left.slice(h), retry: true });
        } else totals.missing += left.length;
      }
    } catch (e) {
      setAiJobOutcome(job, /JSON/i.test(e.message) ? 'bad_json' : 'error', e.message);
      throw e;
    }
    const written = notes.filter(n => n.tier_note);
    const pr = modelCatalog.price(model || '');
    const cents = Math.round(((totals.input * pr.in + totals.output * pr.out) / 1e6) * 10000) / 100;
    const stats = { issues: rows.length, sent: items.length, noMaterial: rows.length - items.length, written: written.length,
      empty: notes.length - written.length, mismatched: totals.mismatched, missing: totals.missing, cents, model: model ? modelCatalog.displayName(model) : null };
    logger.info('events', `Tier notes for "${event.name}": ${written.length} written, ${stats.empty} empty, ${stats.noMaterial} with nothing to write from${stats.mismatched ? `, ${stats.mismatched} replies dropped (wrong issue)` : ''}`,
      { model, input: totals.input, output: totals.output, cents, ...stats });
    setAiJobOutcome(job, 'ok', `${written.length} tier notes${preview ? ' (preview)' : ''}`);
    if (!preview) {
      const upd = db.prepare('UPDATE event_issues SET tier_note = ? WHERE id = ? AND event_id = ?');
      db.transaction(() => {
        for (const n of written) upd.run(n.tier_note, n.id, eventId);
        db.prepare('UPDATE events SET notes_refreshed_at = ? WHERE id = ?').run(Date.now(), eventId);
      })();
    }
    return { notes, written, stats, cents, name: event.name };
  }

  app.post('/api/events/:id/reannotate', requireAdmin, async (req, res) => {
    try {
      const preview = !!(req.body && req.body.preview);
      const r = await writeTierNotes(req.params.id, { preview });
      const stats = r.stats ? { ...r.stats, cents: aiInfo.requestTotals(db)?.cents ?? r.stats.cents } : r.stats;   // same total as the ⓘ
      if (preview) return res.json({ preview: true, annotations: r.notes, stats });
      res.json({ success: true, count: r.written.length, annotations: r.written, stats });
    } catch (e) {
      if (!e.status) logger.error('events', 'Tier notes failed', e.message);
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ─── Refresh tier notes for every event (admin; one at a time, in the background) ──
  // Skips events already refreshed unless { all: true }; stoppable; progress at GET.
  const notesRefresh = { running: false, stop: false, total: 0, done: 0, failed: 0, written: 0, cents: 0, current: null, errors: [], startedAt: null, finishedAt: null };
  app.get('/api/events/notes/refresh-all', requireAdmin, (req, res) => {
    const pending = db.prepare('SELECT COUNT(*) AS n FROM events WHERE notes_refreshed_at IS NULL').get().n;
    const all = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
    const t = aiInfo.totals(db, 'request_id', notesRefresh.aiRequest);   // same total as the ⓘ
    res.json({ ...notesRefresh, cents: t ? t.cents : notesRefresh.cents, ai_request: notesRefresh.aiRequest || null, errors: notesRefresh.errors.slice(-10), pending, all });
  });
  app.post('/api/events/notes/refresh-all', requireAdmin, (req, res) => {
    if (notesRefresh.running) return res.status(409).json({ error: 'A refresh is already running' });
    const every = !!(req.body && req.body.all);
    const ids = db.prepare(`SELECT id, name FROM events ${every ? '' : 'WHERE notes_refreshed_at IS NULL'} ORDER BY year, name`).all();
    Object.assign(notesRefresh, { running: true, stop: false, total: ids.length, done: 0, failed: 0, written: 0, cents: 0, current: null, errors: [], startedAt: Date.now(), finishedAt: null, aiRequest: aiInfo.currentRequest() });
    logger.info('events', `Tier notes refresh started for ${ids.length} events${every ? ' (all again)' : ''}`, { by: req.user?.username });
    res.json({ started: true, total: ids.length });
    (async () => {
      for (const ev of ids) {
        if (notesRefresh.stop) break;
        notesRefresh.current = ev.name;
        try {
          const r = await writeTierNotes(ev.id);
          notesRefresh.written += r.written.length; notesRefresh.cents += r.cents;
        } catch (e) {
          notesRefresh.failed++; notesRefresh.errors.push({ event: ev.name, error: e.message });
          if (e.status === 400) { try { db.prepare('UPDATE events SET notes_refreshed_at = ? WHERE id = ?').run(Date.now(), ev.id); } catch {} }   // nothing to write from: don't retry
        }
        notesRefresh.done++;
      }
      notesRefresh.cents = Math.round(notesRefresh.cents * 100) / 100;
      Object.assign(notesRefresh, { running: false, current: null, finishedAt: Date.now() });
      logger.info('events', `Tier notes refresh ${notesRefresh.stop ? 'stopped' : 'finished'}: ${notesRefresh.done} of ${notesRefresh.total} events, ${notesRefresh.written} notes, ${notesRefresh.failed} failed, ~${notesRefresh.cents}¢`);
    })();
  });
  app.post('/api/events/notes/refresh-all/stop', requireAdmin, (req, res) => {
    if (notesRefresh.running) notesRefresh.stop = true;
    res.json({ stopping: notesRefresh.running });
  });


  // ─── Manual reconcile trigger ────────────────────────────────────
  app.post('/api/events/:id/reconcile', requireAdmin, async (req, res) => {
    const event = db.prepare('SELECT id FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    // Top-level try/catch — any uncaught exception inside reconcileEventIssues
    // would otherwise leave the request hanging until the proxy times out, with
    // no logged reason. Better to fail fast and surface the error to the client.
    try {
      // Clear all NON-manually-matched scanned_book_id values for this event
      // before reconciling. This makes Match Owned a "rebuild from scratch"
      // operation, which is the behaviour the user actually wants:
      //   - If a same-name-different-year tie-in (e.g. Siege 2010 vs 2015)
      //     was matched to the wrong book, clearing forces re-evaluation
      //     against current library state with the year guard active.
      //   - If new matching files were downloaded since the last reconcile,
      //     they get picked up without the user having to figure out which
      //     event_issues are stale.
      // Manually-matched rows are preserved — those are explicit user
      // overrides and shouldn't be touched by an automatic operation.
      const cleared = db.prepare(
        `UPDATE event_issues SET scanned_book_id = NULL
       WHERE event_id = ?
         AND (manually_matched IS NULL OR manually_matched = 0)`
      ).run(req.params.id);
      if (cleared.changes > 0) {
        logger.info('events', `Cleared ${cleared.changes} auto-match(es) before reconcile`, { eventId: req.params.id });
      }
      await reconcileEventIssues();
      const counts = db.prepare(
        "SELECT COUNT(*) as total, SUM(CASE WHEN scanned_book_id IS NOT NULL THEN 1 ELSE 0 END) as owned FROM event_issues WHERE event_id = ?"
      ).get(req.params.id);
      res.json({ success: true, total: counts.total, owned: counts.owned, cleared: cleared.changes });
    } catch (e) {
      logger.error('events', `Reconcile endpoint failed`, { eventId: req.params.id, error: e.message, stack: e.stack });
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Delete event ─────────────────────────────────────────────────
  app.delete('/api/events/:id', requireAdmin, (req, res) => {
    db.prepare("DELETE FROM events WHERE id=?").run(req.params.id);
    res.json({ success: true });
  });

  // The manual annual discovery route and the weekly discovery: annuals.js (2026-11-19).
  return { bookCvId };
};
