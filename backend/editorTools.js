'use strict';
// ─── editorTools.js ───────────────────────────────────────────────
// The shared editor's Tools menu for Timeline events and Top Shelf runs
// (claude/ADMIN_REORG.md step 3, 2b). Every tool shows a preview first;
// nothing changes until the admin applies it. Admin only.
//
//   GET  /api/editor/:kind/:id/rematch   kind event|run → { checked, manual, kept, none, proposals }
//        proposals: [{ id, issue, current: {book_id,label}|null, proposed: {book_id,label}, how, dist, strong, note?, cvFix, cvOnly? }]
//        title: the comic's story title (shown in the window to help check the match).
//        filed: the comic's folder name differs from the issue's series (the filename is shown).
//        cvOnly: the match is right but the stored Comic Vine id points at another volume; only the id changes.
//        handCheck: [{ id, issue, reason, current? }] hand matches that look wrong but have no alternative.
//        Hand matches are checked by name, number and year only; a different confident match is a
//        proposal with manual: true (offered unticked; applying keeps it a hand match).
//        Uses sharedMatcher.js (events: full; runs: exact, as canonMatch.js). Hand matches are never changed
//        touched; a current match is never cleared (no proposal = keep); a book already held by
//        another issue of the same event/run is not proposed.
//   POST /api/editor/:kind/:id/rematch   { items: [{ id, book_id }] } → applies the items that the
//        matcher still proposes (recomputed here). cvFix: the issue's stored Comic Vine id pointed
//        at another volume; it takes the matched comic's id.
//   GET  /api/editor/run/:id/rebuild?volume=   preview of Auto-resolve from Comic Vine (resolveCanonRun
//        dryRun; volume '' searches again) → { cvVolumeId, volume, total, inRange, kept, issues, removed }
//   POST /api/editor/run/:id/rebuild     { volume } → stores the volume and runs the real Auto-resolve
//        (resolveCanonRun with clearExisting: hand-matched issues stay).
// Re-annotate preview is POST /api/events/:id/reannotate { preview: true } (server.js).

module.exports = function createEditorTools({ app, db, requireAdmin, logger, IN, bookIndex, bookCvId, resolveCanonRun, canonResolveResults = new Map() }) {
  const canonResolve = require('./canonResolve');
  const matcher = require('./sharedMatcher')({ db, IN, bookIndex });
  const KINDS = {
    event: { table: 'event_issues', owner: 'event_id', mode: 'full', exists: 'SELECT 1 FROM events WHERE id = ?' },
    run:   { table: 'canon_run_issues', owner: 'run_id', mode: 'exact', exists: 'SELECT 1 FROM canon_runs WHERE id = ?' },
  };
  const issueLabel = r => `${r.series_name}${r.volume_year ? ` (${r.volume_year})` : ''} #${r.issue_number}`;
  // The folder a comic sits in can differ from what it is (minis and annuals filed in a parent
  // folder: "Knight Terrors Catwoman 001" in Catwoman (2023)); then the filename is shown too.
  const normName = t => String(t || '').toLowerCase().replace(/&/g, 'and').replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
  const filed = (b, r) => !!(b && normName(b.sname) !== normName(r.series_name));

  function proposals(kind, id) {
    const k = KINDS[kind];
    const rows = db.prepare(`SELECT id, series_name, issue_number, volume_year, cv_issue_id, CAST(scanned_book_id AS TEXT) AS book,
        COALESCE(manually_matched, 0) AS manual FROM ${k.table} WHERE ${k.owner} = ? ORDER BY sort_order, id`).all(kind === 'run' ? Number(id) : String(id));
    const idx = matcher.buildIndex();
    const out = { checked: rows.length, manual: 0, kept: 0, none: 0, proposals: [], handCheck: [] };
    const wanted = [], hand = [];
    for (const r of rows) {
      if (r.manual) { out.manual++; hand.push(r); continue; }
      const m = matcher.match(r, idx, { mode: k.mode });
      const cur = r.book && idx.byId.has(r.book) ? r.book : null;
      if (!m) { if (cur) out.kept++; else out.none++; continue; }
      if (String(m.id) === cur) {
        // Right match, wrong stored Comic Vine id (the generator's lookup): offer the id fix alone.
        if (m.cvConflict) { const cb = idx.byId.get(cur); out.proposals.push({ id: r.id, issue: issueLabel(r), current: { book_id: cur, label: matcher.label(cb) },
          proposed: { book_id: cur, label: matcher.label(cb), file: cb.filename, filed: filed(cb, r), title: cb.title || null }, how: m.how, dist: m.dist, strong: true, note: m.note, cvFix: true, cvOnly: true }); }
        continue;
      }
      wanted.push({ r, m, cur });
    }
    // One book per issue list: not a book another issue keeps, nor one proposed twice.
    const changing = new Set(wanted.map(w => w.r.id));
    const held = new Set(rows.filter(r => r.book && !changing.has(r.id)).map(r => r.book));
    for (const { r, m, cur } of wanted) {
      const b = String(m.id);
      if (held.has(b)) { if (cur) out.kept++; else out.none++; continue; }
      held.add(b);
      const pb = idx.byId.get(b), cb = cur && idx.byId.get(cur);
      out.proposals.push({ id: r.id, issue: issueLabel(r), current: cb ? { book_id: cur, label: matcher.label(cb), file: cb.filename, filed: filed(cb, r), title: cb.title || null } : (r.book ? { book_id: null, label: 'a comic no longer in the library' } : null),
        proposed: { book_id: b, label: matcher.label(pb), file: pb.filename, filed: filed(pb, r), title: pb.title || null }, how: m.how, dist: m.dist, strong: !!m.strong, note: m.note || null, cvFix: !!m.cvConflict });
    }
    // Hand matches (user, 2026-10-17: "they are suspect as I'm prone to mistakes"): checked by
    // series name, number and year only (their Comic Vine id is usually copied from the chosen
    // comic, so it proves nothing). A different confident match is offered unticked (manual);
    // a hand match with no alternative whose number or volume year looks wrong is listed to look at.
    let folderYears = null;   // series name → folder start years (built when first needed)
    for (const r of hand) {
      const cur = r.book && idx.byId.has(r.book) ? r.book : null;
      const cb = cur && idx.byId.get(cur);
      // A hand match in a folder of that series and volume year, with the right number, is fine as it is
      // (ComicInfo cover years can point elsewhere: Aquaman (2011) #50 says 2016).
      const ry0 = parseInt(r.volume_year, 10) || null;
      if (cb && !filed(cb, r) && ry0 && cb.syear && Math.abs(Number(cb.syear) - ry0) <= 1 && matcher.numbersAgree(cb.issue_number, r.issue_number)) continue;
      const m = matcher.match({ ...r, cv_issue_id: null }, idx, { mode: k.mode });
      if (m && m.strong && m.dist === 0 && String(m.id) !== cur && !held.has(String(m.id))) {   // exact year only: a year either side found Old Man Logan (2016) for (2015)
        const pb = idx.byId.get(String(m.id));
        held.add(String(m.id));
        out.proposals.push({ id: r.id, issue: issueLabel(r), manual: true,
          current: cb ? { book_id: cur, label: matcher.label(cb), file: cb.filename, filed: filed(cb, r), title: cb.title || null } : (r.book ? { book_id: null, label: 'a comic no longer in the library' } : null),
          proposed: { book_id: String(m.id), label: matcher.label(pb), file: pb.filename, filed: filed(pb, r), title: pb.title || null }, how: m.how, dist: m.dist, strong: true, note: null, cvFix: true });
        continue;
      }
      if (!cb) { if (r.book) out.handCheck.push({ id: r.id, issue: issueLabel(r), reason: 'its comic is no longer in the library' }); continue; }
      const num = matcher.normNum(r.issue_number);
      const numOk = matcher.numbersAgree(cb.issue_number, r.issue_number) || (num && idx.ciOrig.get(cur) === num);
      const d = matcher.yearDist(idx, cb, parseInt(r.volume_year, 10) || null);
      // Not worth flagging: the comic carries the issue's own Comic Vine id (two sources agree), or
      // an annual filed in its series folder (folder year differs by design).
      const sameId = !!(r.cv_issue_id && cb.cv_issue_id && String(r.cv_issue_id) === String(cb.cv_issue_id));
      const annualFiled = /annual/i.test(`${r.series_name} ${r.issue_number}`) && /annual/i.test(cb.filename || '');
      // A year off in a folder of the same series is usually naming (Uncanny X-Men (1963) issues in
      // "The Uncanny X-Men (1981)"; legacy numbers): flagged only when the library also has a folder
      // of that series starting within a year of the issue's volume (Batwoman (2011) #3 matched in Batwoman (2017)).
      const ry = parseInt(r.volume_year, 10) || null;
      // Issue #100 and up with the same number: legacy numbering (Detective Comics #1022 in the 2016 volume).
      const legacy = numOk && parseFloat(num) >= 100;
      let yearOff = d != null && d > 1 && !sameId && !annualFiled && !legacy;
      if (yearOff && !filed(cb, r)) {
        if (!folderYears) { folderYears = new Map(); for (const b of idx.byId.values()) { const k = normName(b.sname); if (!folderYears.has(k)) folderYears.set(k, new Set()); if (b.syear) folderYears.get(k).add(Number(b.syear)); } }
        yearOff = [...(folderYears.get(normName(cb.sname)) || [])].some(y => Math.abs(y - ry) <= 1);
      }
      const why = !numOk && !sameId ? `it is #${cb.issue_number}` : yearOff ? `its volume year is ${d} years off` : null;
      if (why) out.handCheck.push({ id: r.id, issue: issueLabel(r), reason: why,
        current: { book_id: cur, label: matcher.label(cb), file: cb.filename, filed: filed(cb, r), title: cb.title || null } });
    }
    const order = new Map(rows.map((r, i) => [r.id, i]));
    out.proposals.sort((a, b) => order.get(a.id) - order.get(b.id));
    out.handCheck.sort((a, b) => order.get(a.id) - order.get(b.id));
    return out;
  }

  app.get('/api/editor/:kind(event|run)/:id/rematch', requireAdmin, (req, res) => {
    const { kind, id } = req.params;
    if (!db.prepare(KINDS[kind].exists).get(id)) return res.status(404).json({ error: 'Not found' });
    try { res.json(proposals(kind, id)); }
    catch (e) { logger.error('editor', 'Re-match preview failed', { error: e.message }); res.status(500).json({ error: e.message }); }
  });

  app.post('/api/editor/:kind(event|run)/:id/rematch', requireAdmin, (req, res) => {
    const { kind, id } = req.params, k = KINDS[kind];
    if (!db.prepare(k.exists).get(id)) return res.status(404).json({ error: 'Not found' });
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'Nothing chosen.' });
    try {
      const now = new Map(proposals(kind, id).proposals.map(p => [String(p.id), p]));
      const setBook = db.prepare(`UPDATE ${k.table} SET scanned_book_id = ? WHERE id = ? AND ${k.owner} = ? AND COALESCE(manually_matched, 0) = 0`);
      // A hand match the admin chose to change stays a hand match (it was confirmed by ticking it).
      const setHand = db.prepare(`UPDATE ${k.table} SET scanned_book_id = ? WHERE id = ? AND ${k.owner} = ? AND manually_matched = 1`);
      const setCv = db.prepare(`UPDATE ${k.table} SET cv_issue_id = ? WHERE id = ? AND ${k.owner} = ?`);
      const owner = kind === 'run' ? Number(id) : String(id);
      const applied = [], stale = [];
      db.transaction(() => {
        for (const it of items) {
          const p = now.get(String(it.id));
          if (!p || String(p.proposed.book_id) !== String(it.book_id)) { stale.push(it.id); continue; }
          if (!(p.manual ? setHand : setBook).run(String(p.proposed.book_id), p.id, owner).changes) { stale.push(it.id); continue; }
          let cv = null;
          if (p.cvFix) { cv = bookCvId(p.proposed.book_id); if (cv) setCv.run(String(cv), p.id, owner); }
          applied.push({ id: p.id, book_id: p.proposed.book_id, cv_issue_id: cv });
        }
      })();
      logger.info('editor', `Re-match: ${applied.length} ${kind} issue match(es) changed`, { id, stale: stale.length });
      res.json({ applied, stale });
    } catch (e) { logger.error('editor', 'Re-match failed', { error: e.message }); res.status(500).json({ error: e.message }); }
  });

  // ── Rebuild a run from Comic Vine (preview, then the real Auto-resolve) ──
  app.get('/api/editor/run/:id/rebuild', requireAdmin, async (req, res) => {
    const run = db.prepare('SELECT id, cv_volume_id FROM canon_runs WHERE id = ?').get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    const volume = req.query.volume === undefined ? undefined : String(req.query.volume).replace(/\D/g, '');
    const plan = await resolveCanonRun(run.id, { clearExisting: true, dryRun: true, volumeId: volume });
    if (plan.error) return res.status(400).json({ error: plan.error });
    if (plan.skipped) return res.json({ skipped: true, reason: plan.reason, cvVolumeId: null });
    const cur = db.prepare(`SELECT id, series_name, issue_number, volume_year, cv_issue_id, CAST(scanned_book_id AS TEXT) AS book, COALESCE(manually_matched, 0) AS manual
      FROM canon_run_issues WHERE run_id = ? ORDER BY sort_order, id`).all(run.id);
    const next = new Set(plan.issues.map(i => i.cv_issue_id));
    const had = new Set(cur.filter(r => !r.manual && r.cv_issue_id).map(r => String(r.cv_issue_id)));
    res.json({ ...plan, storedVolumeId: run.cv_volume_id || null,
      removed: cur.filter(r => !r.manual && !(r.cv_issue_id && next.has(String(r.cv_issue_id)))).map(r => ({ id: r.id, issue: issueLabel(r), owned: !!r.book })),
      handMatched: cur.filter(r => r.manual).map(r => ({ id: r.id, issue: issueLabel(r) })), merged: plan.merged || 0,
      issues: plan.issues.map(i => ({ ...i, isNew: !had.has(i.cv_issue_id) && !i.mergesHand })) });
  });

  app.post('/api/editor/run/:id/rebuild', requireAdmin, async (req, res) => {
    const run = db.prepare('SELECT id FROM canon_runs WHERE id = ?').get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    const volume = String((req.body && req.body.volume) || '').replace(/\D/g, '');
    if (!volume) return res.status(400).json({ error: 'Choose a Comic Vine volume first.' });
    db.prepare('UPDATE canon_runs SET cv_volume_id = ? WHERE id = ?').run(volume, run.id);
    const result = await resolveCanonRun(run.id, { clearExisting: true });
    if (result.error) return res.status(400).json({ error: result.error });
    logger.info('editor', `Rebuilt run ${run.id} from Comic Vine volume ${volume}`, { inserted: result.inserted, matched: result.matched });
    res.json(result);
  });

  // Right after an event is created (POST /api/events): issues with no match take the shared
  // matcher's confident matches (Comic Vine id, same folder, or name/ComicInfo within a year).
  // The old background matcher still runs afterwards for anything left.
  function fillUnmatched(kind, id) {
    const k = KINDS[kind], owner = kind === 'run' ? Number(id) : String(id);
    const items = proposals(kind, id).proposals.filter(p => !p.manual && !p.cvOnly && p.strong && !p.current);
    const setBook = db.prepare(`UPDATE ${k.table} SET scanned_book_id = ? WHERE id = ? AND ${k.owner} = ? AND scanned_book_id IS NULL AND COALESCE(manually_matched, 0) = 0`);
    const setCv = db.prepare(`UPDATE ${k.table} SET cv_issue_id = ? WHERE id = ? AND ${k.owner} = ?`);
    let n = 0;
    db.transaction(() => {
      for (const p of items) {
        if (!setBook.run(String(p.proposed.book_id), p.id, owner).changes) continue;
        n++;
        if (p.cvFix) { const cv = bookCvId(p.proposed.book_id); if (cv) setCv.run(String(cv), p.id, owner); }
      }
    })();
    if (n) logger.info('editor', `Matched ${n} new ${kind} issue(s) to the library`, { id });
    return n;
  }

  // ── Top Shelf Pending review: how Auto-resolve went for each pending run (2026-10-17) ──
  // GET /api/editor/runs/check → [{ id, cv_volume_id, total, owned, expected, result }]
  //   expected: issues the range note names (null when it names none); result: the last
  //   Auto-resolve since the server started ({ error, skipped, inserted }), or null.
  app.get('/api/editor/runs/check', requireAdmin, (req, res) => {
    const rows = db.prepare(`SELECT cr.id, cr.issue_range_hint, cr.cv_volume_id,
        (SELECT COUNT(*) FROM canon_run_issues x WHERE x.run_id = cr.id) AS total,
        (SELECT COUNT(*) FROM canon_run_issues x WHERE x.run_id = cr.id AND x.scanned_book_id IS NOT NULL) AS owned
      FROM canon_runs cr WHERE cr.status = 'pending'`).all();
    res.json(rows.map(r => {
      const spec = canonResolve.parseIssueSpec(r.issue_range_hint);
      let expected = spec.parts.length ? spec.parts.reduce((n, [a, b]) => n + (a === b ? 1 : Math.floor(b) - Math.ceil(a) + 1), 0) : null;
      if (expected == null && /one[- ]?shot|graphic novel/i.test(r.issue_range_hint || '')) expected = 1;
      return { id: r.id, cv_volume_id: r.cv_volume_id || null, total: r.total, owned: r.owned, expected, result: canonResolveResults.get(String(r.id)) || null };
    }));
  });

  return { proposals, matcher, fillUnmatched };
};
