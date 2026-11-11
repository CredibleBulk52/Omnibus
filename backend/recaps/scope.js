'use strict';
// ─── Recap scope, limits and gathering (RECAPS_DESIGN.md, user 2026-10-19) ──
// plan(): code only, no AI and no spending. Works out which issues a recap covers,
//   the spoiler line, the depth of each part and what is still to look up.
// gather(): fetches what the plan allows (within the limits) and returns the
//   material the recap is written from, all of it at or before the spoiler line.
//
// Depth: near = the last issues before the line, a synopsis each;
//        middle = the rest of the scope, as story arcs / stretches;
//        far = before the scope (earlier runs), only when asked.

const LIMITS = Object.freeze({
  shortSeries: 12,        // 12 or fewer issues before the line: the whole series is the scope
  nearIssues: 6,          // issues looked up one by one (page reading only for these)
  arcLookups: 8,          // stretch summaries looked up, newest first
  runLookups: 2,          // older runs / eras folded into this many summaries
  paidLookups: 16,        // total paid lookups in one recap
  cvArcLookups: 12,       // Comic Vine story-arc lookups per plan (free, ~1 s each)
  bigAskCents: 25,        // above this, Comic Book Guy offers alternatives instead
  goingIn: 2,             // parent issues before a spin-off
});
const COST = Object.freeze({ web: 2.3, pages: 7.4, stretch: 1.3 });   // cents, from the synopsis tests

function createScope({ db, synopses, arcs, readingLists, bookIndex, logger }) {
  const { decode } = require('./arcs');
  const tag = (ci, t) => { const m = String(ci || '').match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1]).replace(/\s+/g, ' ').trim() : ''; };

  const BOOK_SQL = `SELECT sb.id, sb.series_id, sb.issue_number, sb.title, sb.comicinfo, sb.cv_issue_id, sb.sort_order, ss.name AS series_name, ss.year AS series_year
    FROM scanned_books sb JOIN scanned_series ss ON ss.id = sb.series_id`;
  const bookById = db.prepare(`${BOOK_SQL} WHERE sb.id = ?`);
  const seriesBooks = db.prepare(`${BOOK_SQL} WHERE sb.series_id = ? ORDER BY sb.sort_order, sb.id`);
  const enrich = b => b && ({
    ...b,
    series_label: tag(b.comicinfo, 'Series') || b.series_name,
    series_year: (/^\d{4}$/.test(tag(b.comicinfo, 'Volume')) && tag(b.comicinfo, 'Volume')) || b.series_year,   // volume as published, not the folder
    number_ci: (bookIndex && bookIndex.info && bookIndex.info(b.id)?.orig_number) || tag(b.comicinfo, 'Number') || b.issue_number,
    title_ci: tag(b.comicinfo, 'Title') || b.title || '',
    cover_year: tag(b.comicinfo, 'Year') || null,
  });
  const loadBooks = ids => ids.map(id => enrich(bookById.get(String(id)))).filter(Boolean);
  const labelOf = b => `${b.series_label}${b.series_year ? ` (${b.series_year})` : ''} #${b.number_ci}`;

  // ── Context: the ordered issues the reader is going through ──
  function contextBooks({ listId, eventId, runId, seriesId, userId }) {
    if (listId && readingLists?.orderedBooks) {
      const ids = readingLists.orderedBooks(listId, { sub: userId });
      if (ids) { const l = db.prepare('SELECT name FROM reading_lists WHERE id = ?').get(parseInt(listId, 10)); return { kind: 'list', name: l?.name || 'Reading list', key: `list:${listId}`, books: loadBooks(ids) }; }
    }
    if (eventId) {
      const ev = db.prepare('SELECT id, name FROM events WHERE id = ?').get(String(eventId));
      if (ev) { const ids = db.prepare('SELECT scanned_book_id AS b FROM event_issues WHERE event_id = ? AND scanned_book_id IS NOT NULL ORDER BY sort_order').all(ev.id).map(r => r.b);
        return { kind: 'event', name: ev.name, key: `event:${ev.id}`, books: loadBooks([...new Set(ids)]) }; }
    }
    if (runId) {
      const run = db.prepare('SELECT id, title FROM canon_runs WHERE id = ?').get(parseInt(runId, 10));
      if (run) { const ids = db.prepare('SELECT CAST(scanned_book_id AS TEXT) AS b FROM canon_run_issues WHERE run_id = ? AND scanned_book_id IS NOT NULL ORDER BY sort_order').all(run.id).map(r => r.b);
        return { kind: 'run', name: run.title, key: `run:${run.id}`, books: loadBooks([...new Set(ids)]) }; }
    }
    if (seriesId) {
      const ss = db.prepare('SELECT id, name, year FROM scanned_series WHERE id = ?').get(String(seriesId));
      if (ss) return { kind: 'series', name: `${ss.name}${ss.year ? ` (${ss.year})` : ''}`, key: `series:${ss.id}`, seriesId: ss.id, books: seriesBooks.all(ss.id).map(enrich) };
    }
    return null;
  }

  const finished = db.prepare('SELECT 1 FROM read_progress WHERE user_id = ? AND book_id = ? AND completed = 1');
  const sameNumber = (b, n) => String(b.number_ci).replace(/^0+(?=\d)/, '') === String(n).replace(/^#/, '').replace(/^0+(?=\d)/, '') || String(b.issue_number) === String(n);

  // Spoiler line: the issue before the one open in the reader; else a named
  // issue; else the last issue finished. None (reading false): not reading it.
  function lineFor(ctx, opts, open) {
    const books = ctx.books;
    const openIdx = open ? books.findIndex(b => b.id === open.id) : -1;
    if (opts.until) {
      let stop = books.findIndex(b => sameNumber(b, opts.until));
      if (stop === -1) return { error: `Issue #${String(opts.until).replace(/^#/, '')} is not in ${ctx.name} in the library.` };
      if (openIdx !== -1 && stop >= openIdx) stop = openIdx - 1;     // never past the issue open in the reader
      return { stop, reading: true, why: 'named' };
    }
    if (openIdx !== -1) return { stop: openIdx - 1, reading: true, why: 'open' };
    for (let k = books.length - 1; k >= 0; k--) if (opts.userId && finished.get(opts.userId, books[k].id)) return { stop: k, reading: true, why: 'finished' };
    return { stop: books.length - 1, reading: false, why: 'none' };
  }

  // ── Story notes (user 2026-10-19): what is already stored, for any story question ──
  // Free: no lookups, no AI. Issue synopses (stored, or a real ComicInfo synopsis) and
  // stretch summaries up to the spoiler line. about: a name or word to look for.
  // recent: how many of the latest issues to include when nothing is asked about.
  function storedNotes(opts = {}) {
    const open = opts.bookId ? enrich(bookById.get(String(opts.bookId))) : null;
    const ctx = contextBooks({ ...opts, seriesId: opts.seriesId || open?.series_id });
    if (!ctx || !ctx.books.length) return { error: 'No series, list, event or run with issues in the library.' };
    const line = lineFor(ctx, opts, open);
    if (line.error) return { error: line.error };
    const before = ctx.books.slice(0, line.stop + 1);
    const items = [];
    before.forEach((b, idx) => {
      const r = synopses.stored(b.id);
      const text = r && r.status === 'ok' ? r.synopsis : synopses.comicInfoSynopsis(b.comicinfo);
      // Imported records also carry the issue's characters (with other names) and key events:
      // searched for "who is…" questions, and shown when they are what matched.
      let extra = '';
      if (r && r.source === 'import') { try { const rec = JSON.parse(r.notes || '{}').record || {}; extra = [...(rec.characters || []), ...(rec.key_events || [])].join(' · '); } catch {} }
      if (text) items.push({ idx, label: labelOf(b), title: b.title_ci || null, text, extra });
    });
    // Stretch summaries stored for this context that end at or before the line.
    const pos = new Map(before.map((b, k) => [String(b.cv_issue_id || b.id), k]));
    for (const r of db.prepare("SELECT arc_key, label, summary FROM arc_summaries WHERE status = 'ok' AND arc_key LIKE ?").all(`${ctx.key}:%`)) {
      const m = String(r.arc_key).slice(ctx.key.length + 1).match(/^(.+)-(.+)$/);
      if (!m || !pos.has(m[1]) || !pos.has(m[2])) continue;
      const k1 = pos.get(m[1]), k2 = pos.get(m[2]);
      if (items.some(i => i.idx >= k1 && i.idx <= k2 && !i.stretch) && k2 - k1 + 1 === items.filter(i => i.idx >= k1 && i.idx <= k2 && !i.stretch).length) continue;   // every issue already has its own
      items.push({ idx: k2, label: r.label, text: r.summary, stretch: true });
    }
    items.sort((a, b) => a.idx - b.idx);
    const about = String(opts.about || '').trim();
    let picked = items;
    if (about) {
      // Whole words only ("Ms. Smith" must not match "problems."); short words like "Ms" are ignored.
      const words = about.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(w => w.length > 2);
      const res = words.map(w => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu'));
      const has = t => { t = String(t || ''); return res.length ? res.some(re => re.test(t)) : t.toLowerCase().includes(about.toLowerCase()); };
      picked = items.filter(i => has(i.text) || has(i.extra)).slice(-(opts.max || 10))
        .map(i => (!has(i.text) && i.extra ? { ...i, text: `${i.text} (Also named here: ${i.extra})` } : i));
    } else picked = items.slice(-(opts.recent || 8));
    const head = `STORY NOTES for ${ctx.name}${line.reading ? `, up to and including ${before.length ? labelOf(before[before.length - 1]) : 'nothing yet'}` : ''} (stored summaries; nothing after this point${open ? `; ${labelOf(open)} is open and not covered` : ''}).`;
    if (!picked.length) return { none: true, text: `${head}
${about ? `Nothing stored mentions "${about}".` : 'Nothing stored yet for these issues.'} (${items.length} summaries on file before the line.)` };
    return { count: picked.length, onFile: items.length, text: `${head}
${picked.map(i => `- ${i.label}${i.title ? ` "${i.title}"` : ''}: ${i.text}`).join('\n')}` };
  }

  // ── Quick refresher (user 2026-10-19): no lookups, no spending ──
  // The last `count` issues before the spoiler line, each from its stored synopsis or,
  // failing that, its ComicInfo summary (often a publisher's preview, so marked as one).
  function briefMaterial(opts = {}, count = 12) {
    const open = opts.bookId ? enrich(bookById.get(String(opts.bookId))) : null;
    const ctx = contextBooks({ ...opts, seriesId: opts.seriesId || open?.series_id });
    if (!ctx || !ctx.books.length) return { error: 'No series, list, event or run with issues in the library.' };
    const line = lineFor(ctx, opts, open);
    if (line.error) return { error: line.error };
    const before = ctx.books.slice(0, line.stop + 1);
    const recent = before.slice(-count);
    const clean = t => String(t || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const L = [];
    for (const b of recent) {
      const r = synopses.stored(b.id);
      if (r && r.status === 'ok') { L.push(`- ${labelOf(b)}${b.title_ci ? ` "${b.title_ci}"` : ''} (summary): ${r.synopsis}`); continue; }
      const s = clean(tag(b.comicinfo, 'Summary'));
      const full = synopses.comicInfoSynopsis(b.comicinfo);
      if (full) L.push(`- ${labelOf(b)}${b.title_ci ? ` "${b.title_ci}"` : ''} (summary): ${full}`);
      else if (s) L.push(`- ${labelOf(b)}${b.title_ci ? ` "${b.title_ci}"` : ''} (PREVIEW, written before the issue came out): ${s.slice(0, 700)}`);
      else L.push(`- ${labelOf(b)}${b.title_ci ? ` "${b.title_ci}"` : ''}: (nothing on file)`);
    }
    const earlier = before.length - recent.length;
    return { text: `QUICK REFRESHER MATERIAL for ${ctx.name}${line.reading ? `, up to and including ${before.length ? labelOf(before[before.length - 1]) : 'nothing yet'}` : ''}${open ? `; ${labelOf(open)} is open and not covered` : ''}.
${earlier > 0 ? `(${earlier} earlier issues are not included.)\n` : ''}${L.join('\n')}` };
  }

  // ── The plan ──
  // opts: { userId, bookId (open in the reader), seriesId, listId, eventId, runId,
  //         until (an issue number the reader names), mode: 'auto'|'overview'|'issues',
  //         includeEarlier, issueCount (issue-by-issue: how many issues were asked for) }
  function plan(opts = {}) {
    const open = opts.bookId ? enrich(bookById.get(String(opts.bookId))) : null;
    const ctx = contextBooks({ ...opts, seriesId: opts.seriesId || open?.series_id });
    if (!ctx) return { error: 'No series, list, event or run to recap.' };
    const books = ctx.books;
    if (!books.length) return { error: `Nothing from ${ctx.name} is in the library.` };

    const line = lineFor(ctx, opts, open);
    if (line.error) return { error: line.error };
    const { stop, reading, why: lineWhy } = line;
    const before = books.slice(0, stop + 1);
    const out = { context: { kind: ctx.kind, name: ctx.name }, reading, limits: LIMITS };
    out.spoilerLine = reading ? (before.length ? { book_id: before[before.length - 1].id, label: labelOf(before[before.length - 1]), why: lineWhy } : { book_id: null, label: 'before the first issue', why: lineWhy }) : null;
    out.openIssue = open ? labelOf(open) : null;

    // Scope. Lists, events and runs: everything before the line. A series: the
    // whole series when short, else the current writer's run.
    let scope = before, earlier = [], caseId;
    if (!reading) caseId = 'not_reading';
    else if (ctx.kind !== 'series') caseId = 'context';
    else if (before.length <= LIMITS.shortSeries) caseId = 'short';
    else {
      const runs = require('./arcs').writerRuns(before.map(b => ({ ...b, writer_key: require('./arcs').firstWriter(b.comicinfo) })));
      const cur = runs[runs.length - 1];
      const startIdx = before.length - cur.books.length;
      scope = before.slice(startIdx); earlier = before.slice(0, startIdx);
      if (scope.length < LIMITS.nearIssues && earlier.length) {   // a run just started: take the previous run too
        const prev = runs[runs.length - 2];
        scope = before.slice(startIdx - prev.books.length); earlier = before.slice(0, startIdx - prev.books.length);
      }
      caseId = 'long';
    }
    out.case = caseId;

    // Going in: a short series whose first issue sits in a Timeline event after
    // other series' issues (a spin-off): the 1–2 event issues just before it.
    out.goingIn = [];
    if (ctx.kind === 'series' && books.length <= LIMITS.shortSeries) {
      const first = books[0];
      const ev = db.prepare(`SELECT ei.event_id, ei.sort_order, e.name FROM event_issues ei JOIN events e ON e.id = ei.event_id WHERE ei.scanned_book_id = ? ORDER BY ei.sort_order LIMIT 1`).get(first.id);
      if (ev) {
        const prior = db.prepare(`SELECT scanned_book_id AS b, tier FROM event_issues WHERE event_id = ? AND sort_order < ? AND scanned_book_id IS NOT NULL ORDER BY sort_order DESC LIMIT 12`).all(ev.event_id, ev.sort_order)
          .filter(r => !books.some(b => b.id === r.b));
        const pick = [...prior.filter(r => r.tier === 'essential'), ...prior.filter(r => r.tier !== 'essential')].slice(0, LIMITS.goingIn).map(r => r.b);
        out.goingIn = loadBooks(pick).reverse();
        if (out.goingIn.length) { out.goingInFrom = ev.name; if (caseId === 'short') out.case = 'spin_off'; }
      }
    }

    // Depth.
    const mode = opts.mode || (reading ? 'auto' : 'overview');
    // A reader who is reading always gets the latest issues in detail (that is the point of a
    // recap); "overview" only drops them for a series they are not reading.
    let near = mode === 'overview' && !reading ? [] : scope.slice(-LIMITS.nearIssues);
    const asked = mode === 'issues' ? (opts.issueCount || scope.length) : 0;
    const middleBooks = scope.slice(0, scope.length - near.length);
    let groups = arcs.group(middleBooks);
    let older = [];
    if (groups.length > LIMITS.arcLookups) {
      older = arcs.coarsen(groups.slice(0, groups.length - LIMITS.arcLookups), LIMITS.runLookups);
      groups = groups.slice(-LIMITS.arcLookups);
    }
    const far = opts.includeEarlier && earlier.length ? arcs.coarsen(arcs.group(earlier), LIMITS.runLookups) : [];
    const goingIn = out.goingIn;

    // What is free (stored / ComicInfo) and what would be looked up.
    const synOf = b => synopses.stored(b.id) || null;
    const freeSyn = b => { const s = synOf(b); return s && s.status === 'ok' ? s : (synopses.comicInfoSynopsis(b.comicinfo) ? { status: 'ok', source: 'comicinfo' } : null); };
    const groupFree = g => !!arcs.storedSummary(ctx.key, g) || g.books.every(b => freeSyn(b));
    const nearMissing = [...goingIn, ...near].filter(b => !freeSyn(b) && !(synOf(b)?.status === 'missing'));
    const nearCheck = [...goingIn, ...near].filter(b => synopses.wantsPages(synOf(b)));   // web synopses to check against the pages
    const stretchMissing = [...older, ...groups, ...far].filter(g => !groupFree(g) && arcs.storedSummary(ctx.key, g)?.status !== 'missing');
    const describeGroup = g => ({ label: arcs.rangeLabel(g), name: g.name || null, kind: g.kind, issues: g.books.length, writers: g.writers || [], stored: groupFree(g) });
    out.parts = {
      far: far.map(describeGroup),
      older: older.map(describeGroup),
      arcs: groups.map(describeGroup),
      near: near.map(b => ({ book_id: b.id, label: labelOf(b), title: b.title_ci || null, stored: !!freeSyn(b) })),
      goingIn: goingIn.map(b => ({ book_id: b.id, label: labelOf(b), stored: !!freeSyn(b) })),
    };
    out.earlierIssues = opts.includeEarlier ? 0 : earlier.length;
    const lookups = nearMissing.length + nearCheck.length + stretchMissing.length;
    out.lookups = { issues: nearMissing.length, pageChecks: nearCheck.length, stretches: stretchMissing.length, total: lookups };
    // Fresh recent issues: in the first live recaps (AGL, Detective, Batman, 100 Bullets) most web
    // synopses (16 of 22) came from reviews or solicits and were read again from the pages.
    const C = (synopses.costs && synopses.costs()) || COST;
    out.estimateCents = Math.round(nearMissing.length * (C.web + 0.75 * C.pages) + nearCheck.length * C.pages + stretchMissing.length * C.stretch);
    out.worstCents = Math.round(nearMissing.length * (COST.web + COST.pages) + nearCheck.length * COST.pages + stretchMissing.length * COST.stretch);
    // A big ask: issue by issue beyond the limit, more lookups than allowed, or over 25¢.
    out.bigAsk = (asked > LIMITS.nearIssues) || lookups > LIMITS.paidLookups || out.estimateCents > LIMITS.bigAskCents;
    if (out.bigAsk) out.alternatives = [
      'an overview by story arc instead of issue by issue',
      `just the last ${LIMITS.nearIssues} issues in detail`,
      'a recap from what is already stored (no new lookups)',
    ];
    out._internal = { ctxKey: ctx.key, near, groups, older, far, goingIn, nearMissing, nearCheck, stretchMissing };
    return out;
  }

  // ── Gathering ──
  // Looks up what the plan allows (3 at a time) and returns the material in
  // reading order. storedOnly: no lookups at all. onProgress(done, total, label).
  async function gather(p, { storedOnly = false, signal, onProgress } = {}) {
    const I = p._internal;
    const tasks = [];
    const material = { far: [], older: [], arcs: [], goingIn: [], near: [] };
    let spent = 0, done = 0;
    const total = storedOnly ? 0 : I.nearMissing.length + (I.nearCheck || []).length + I.stretchMissing.length;
    const bump = label => { done++; onProgress && onProgress(done, total, label); };

    const issueText = async (b, allowPages) => {
      let s = synopses.free(b.id);
      if ((!s || (allowPages && synopses.wantsPages(s))) && !storedOnly) { s = await synopses.ensure(b.id, { allowPages, signal }); spent += s.spent || 0; bump(labelOf(b)); }
      return { label: labelOf(b), title: b.title_ci || null, text: s && s.status === 'ok' ? s.synopsis : null, source: s?.source || null };
    };
    const groupText = async g => {
      const label = arcs.rangeLabel(g);
      const stored = arcs.storedSummary(I.ctxKey, g);
      if (stored?.status === 'ok') return { label, name: g.name, text: stored.summary, source: 'stretch' };
      const per = g.books.map(b => synopses.free(b.id));
      if (per.every(s => s && s.status === 'ok')) return { label, name: g.name, issues: g.books.map((b, k) => ({ label: labelOf(b), text: per[k].synopsis })), source: 'issues' };
      if (storedOnly || stored?.status === 'missing') return { label, name: g.name, text: null };
      const r = await arcs.ensureSummary(I.ctxKey, g, { signal }); spent += r.spent || 0; bump(label);
      return { label, name: g.name, text: r.status === 'ok' ? r.summary : null, source: 'stretch' };
    };

    const queue = [];
    I.far.forEach((g, k) => queue.push(async () => { material.far[k] = await groupText(g); }));
    I.older.forEach((g, k) => queue.push(async () => { material.older[k] = await groupText(g); }));
    I.groups.forEach((g, k) => queue.push(async () => { material.arcs[k] = await groupText(g); }));
    I.goingIn.forEach((b, k) => queue.push(async () => { material.goingIn[k] = await issueText(b, true); }));
    I.near.forEach((b, k) => queue.push(async () => { material.near[k] = await issueText(b, true); }));
    let next = 0;
    const worker = async () => { while (next < queue.length) { if (signal?.aborted) throw new Error('Stopped'); const job = queue[next++]; await job(); } };
    await Promise.all([worker(), worker(), worker()]);
    for (const k of Object.keys(material)) material[k] = material[k].filter(Boolean);
    return { material, spentCents: Math.round(spent * 1000) / 10 };
  }

  // The material as text for the recap writer: oldest first, the line stated.
  function asText(p, g) {
    const L = [];
    const m = g.material;
    L.push(`RECAP MATERIAL for ${p.context.name}${p.reading ? `, up to and including ${p.spoilerLine.label}` : ' (the reader is not reading it)'}.`);
    if (p.openIssue) L.push(`The reader has ${p.openIssue} open: do not describe it or anything after it.`);
    const sect = (title, items, fmt) => { if (!items.length) return; L.push(`\n## ${title}`); for (const it of items) L.push(fmt(it)); };
    const grp = it => it.issues ? `### ${it.label}${it.name ? ` — "${it.name}"` : ''}\n${it.issues.map(i => `- ${i.label}: ${i.text}`).join('\n')}` : `### ${it.label}${it.name ? ` — "${it.name}"` : ''}\n${it.text || '(no summary found)'}`;
    const iss = it => `### ${it.label}${it.title ? ` "${it.title}"` : ''}\n${it.text || '(no summary found)'}`;
    sect('Earlier runs (brief)', m.far, grp);
    sect(p.goingInFrom ? `Going in (from ${p.goingInFrom})` : 'Going in', m.goingIn, iss);
    sect('Earlier in this run (older stretches)', m.older, grp);
    sect('Story arcs', m.arcs, grp);
    sect('The most recent issues', m.near, iss);
    if (p.earlierIssues) L.push(`\n(${p.earlierIssues} earlier issues before this run are not covered; the reader can ask for them.)`);
    return L.join('\n');
  }

  return { plan, gather, asText, storedNotes, briefMaterial, contextBooks, labelOf, LIMITS };
}

module.exports = { createScope, LIMITS, COST };
