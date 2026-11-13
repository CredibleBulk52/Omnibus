'use strict';
// ─── Shelf Sorter: AI review of the Specials shelves (2026-11-13) ──
// claude/SERIES_GROUPING_DESIGN.md, "Shelf Sorter". One AI task (aiModels.js 'shelf_sorter',
// Settings › AI Models) that checks what the grouping rules did. Stage A: events. For each event
// it reads a short summary of the reading order (one line per series, not every issue) and answers:
//   home     agree | change (to a series in the order) | none, with a confidence
//   members  only the series on the shelf it would change: remove (not part of this event) or
//            keep_visible (an iconic book readers look for on its own: The Killing Joke)
// Its decisions are ordinary grouping changes (seriesGrouping.js): an approved home, a removal
// (Removed tab), a keep-visible override. Every change records the run that made it, so a run can
// be undone as a whole.
//
// Cost comes from what the model is sent, so: one line per series, local ids (E1, S4), a few
// events per call with the instructions cached, and an answer is saved with a hash of what was
// sent; the event is asked about again only when that changes.
//
// Autonomy: "Ask the AI" only saves answers (shown on each row). "Apply sure ones" applies the
// answers marked sure. With the automatic switch on, the hourly rules run also asks about new or
// changed events and applies sure answers. Homes and series the admin set by hand are never changed.
const crypto = require('crypto');

const TASK = 'shelf_sorter';
const AUTO_KEY = 'shelf_sorter_auto';
const PER_CALL = 6;           // events per AI call
const AUTO_LIMIT = 24;        // events asked about per automatic run
const MAX_ROWS = 40;          // reading-order lines per event
const PRELUDE = /prelude|prologue|lead[- ]?in|road to|countdown/i;
const CONF = ['sure', 'likely', 'unsure'];

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['events'],
  properties: {
    events: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['event', 'home', 'members'],
      properties: {
        event: { type: 'string' },
        home: { type: 'object', additionalProperties: false, required: ['verdict', 'series', 'confidence', 'why'], properties: {
          verdict: { type: 'string', enum: ['agree', 'change', 'none'] },
          series: { type: ['string', 'null'] },
          confidence: { type: 'string', enum: CONF },
          why: { type: 'string' },
        } },
        members: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['series', 'action', 'confidence', 'why'], properties: {
          series: { type: 'string' },
          action: { type: 'string', enum: ['remove', 'keep_visible'] },
          confidence: { type: 'string', enum: CONF },
          why: { type: 'string' },
        } } },
      },
    } },
  },
};

const SYSTEM = `You help organize a personal comic library. Small series (minis and one-shots) that belong to a crossover event are put on the "Specials shelf" of one home series, so the library's series browser is not crowded with dozens of tie-ins. A shelved tie-in is hidden from browsing but is still on the home's Specials tab and in search. Lead-ins, aftermaths and main-story series on a shelf stay visible. The aim is to tie related series together and reduce sprawl, not to hide every one-shot.

For each event you get its reading order, summarized as one line per series in order of first appearance, and the shelf as the rules built it. Ids like S4 are series in the library; only they can be a home or be changed. Lines without an id are not in the library.

Answer for every event:
1. home: is the current home the right series to hold this event's shelf?
   - The best home is the event's own main series (the limited series that carries the story). If the event ran inside ongoing titles with no series of its own, choose the flagship ongoing that carried it (Spider-Island (2011) ran in The Amazing Spider-Man).
   - Never a series from another era that shares the name (Age of Apocalypse (2015) is not the home of the 1995 event), never a lead-in or aftermath.
   - verdict "agree" keeps it; "change" names a better S id from this event's lines; "none" means no series in the library should hold this shelf.
   - When the admin approved the home, answer "agree" and judge only the shelf.
2. members: list only the series on the shelf you would change (leave the rest out):
   - "remove": it does not belong to this event (another story or era, or a series only partly about it).
   - "keep_visible": an iconic or standalone book readers look for on its own, which should not be hidden (Batman: The Killing Joke, Kraven's Last Hunt, a landmark graphic novel). Do not use it for ordinary tie-ins.
Confidence: "sure" only when a well-read comics historian would not dispute it; "likely" when you lean that way; "unsure" when you know little about the event. If you do not recognise an event or series, say unsure rather than guess.
why: at most 15 words, plain language, for the admin.`;

function initShelfSorter(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS shelf_sorter_answers (
      kind TEXT NOT NULL, item_id TEXT NOT NULL,
      hash TEXT NOT NULL,              -- what was sent; asked again only when it changes
      model TEXT, answer TEXT NOT NULL, asked_at INTEGER NOT NULL, run_id TEXT,
      applied TEXT,                    -- run id that applied it, 'undone:<run>' or 'user'
      PRIMARY KEY (kind, item_id));
    CREATE TABLE IF NOT EXISTS shelf_sorter_runs (
      id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER,
      mode TEXT NOT NULL,              -- ask | apply | auto | row
      status TEXT NOT NULL,            -- running | done | failed | stopped
      asked INTEGER NOT NULL DEFAULT 0, applied INTEGER NOT NULL DEFAULT 0, model TEXT, error TEXT, undone_at INTEGER);
    CREATE TABLE IF NOT EXISTS shelf_sorter_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
      kind TEXT NOT NULL,              -- event | reject | keep_visible
      event_id TEXT, series_id TEXT, home_id TEXT, previous TEXT);
    CREATE INDEX IF NOT EXISTS shelf_sorter_changes_run ON shelf_sorter_changes(run_id);`);
}

const hashOf = v => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const label = s => s ? `${s.name}${s.year ? ` (${s.year})` : ''}` : null;
const short = (t, n = 120) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// Parse a model reply: the JSON object, also when wrapped in a code fence or text.
function parseReply(text) {
  const s = String(text || '');
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}

function createShelfSorter({ db, grouping, ai, getSetting, setSetting, modelFor = () => null, logger = null, now = Date.now, setJobOutcome = () => {}, modelName = m => m }) {
  initShelfSorter(db);
  const has = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

  // ── Facts for each event (real ids) ──
  function context() {
    const { events, S } = grouping.computeRuleLinks();
    const bookSeries = new Map(db.prepare('SELECT id, series_id FROM scanned_books').all().map(b => [b.id, b.series_id]));
    const issues = new Map();
    if (has('event_issues')) for (const r of db.prepare('SELECT event_id, scanned_book_id, series_name, volume_year, tier, phase, sort_order FROM event_issues ORDER BY event_id, sort_order').all()) {
      if (!issues.has(r.event_id)) issues.set(r.event_id, []);
      issues.get(r.event_id).push(r);
    }
    const members = new Map();
    for (const l of db.prepare("SELECT series_id, home_id, event_id, role, hidden, source FROM series_links WHERE event_id IS NOT NULL AND source = 'rule'").all()) {
      if (!members.has(l.event_id)) members.set(l.event_id, new Map());
      members.get(l.event_id).set(l.series_id, l);
    }
    const keep = new Set(db.prepare("SELECT series_id FROM series_link_overrides WHERE action = 'keep_visible'").all().map(r => r.series_id));
    const pub = new Map(has('events') ? db.prepare('SELECT id, publisher FROM events').all().map(e => [e.id, e.publisher || '']) : []);
    return { events, S, bookSeries, issues, members, keep, pub };
  }

  // One event's facts: { id, name, year, publisher, home, homeHow, approved, rows: [...], more }.
  function eventFacts(e, ctx) {
    const list = ctx.issues.get(e.id) || [];
    const rows = new Map();
    list.forEach((r, i) => {
      const sid = r.scanned_book_id ? ctx.bookSeries.get(r.scanned_book_id) : null;
      const key = sid ? `id:${sid}` : `name:${String(r.series_name || '').toLowerCase()}|${r.volume_year || ''}`;
      if (!rows.has(key)) {
        const s = sid ? ctx.S.get(sid) : null;
        rows.set(key, { id: sid || null, name: s ? label(s) : `${r.series_name}${r.volume_year ? ` (${r.volume_year})` : ''}`, first: i + 1,
          n: 0, owned: 0, main: 0, tieIn: 0, after: 0, lead: 0, size: s ? (s.total || s.books || null) : null, ongoing: s ? s.status === 'Continuing' : false });
      }
      const row = rows.get(key);
      row.n++; if (sid) row.owned++;
      if (r.tier === 'essential') row.main++; else if (r.tier === 'aftermath') row.after++; else row.tieIn++;
      if (PRELUDE.test(r.phase || '')) row.lead++;
    });
    const shelf = ctx.members.get(e.id) || new Map();
    for (const [sid, l] of shelf) {
      const row = rows.get(`id:${sid}`) || (() => { const s = ctx.S.get(sid); const r = { id: sid, name: label(s) || sid, first: 9999, n: 0, owned: 0, main: 0, tieIn: 0, after: 0, lead: 0, size: s ? (s.total || s.books || null) : null, ongoing: false }; rows.set(`id:${sid}`, r); return r; })();
      row.shelf = { role: l.role, hidden: !!l.hidden && !ctx.keep.has(sid) };
    }
    let all = [...rows.values()].sort((a, b) => a.first - b.first);
    let more = 0;
    if (all.length > MAX_ROWS) {
      const keepRow = r => r.id || r.main > 0;
      const kept = all.filter(keepRow).slice(0, MAX_ROWS);
      more = all.length - kept.length; all = kept;
    }
    if (e.home && !all.some(r => r.id === e.home)) {
      const s = ctx.S.get(e.home);
      all.push({ id: e.home, name: label(s) || e.home, first: 9999, n: 0, owned: 0, main: 0, tieIn: 0, after: 0, lead: 0, size: s ? (s.total || s.books || null) : null, ongoing: s ? s.status === 'Continuing' : false, notInOrder: true });
    }
    return { id: e.id, name: e.name, year: e.year, publisher: ctx.pub.get(e.id) || '', home: e.home, homeWhy: e.why,
      approved: e.confirmed && (e.source === 'chosen' || e.source === 'approved'), initiative: e.initiative, total: list.length, rows: all, more };
  }

  // Render events with local ids (E1, S1…). Returns { text, ids: Map(local → real) }.
  function render(factsList) {
    const ids = new Map(), back = new Map();
    let n = 0;
    const sid = real => { if (!back.has(real)) { const k = `S${++n}`; back.set(real, k); ids.set(k, real); } return back.get(real); };
    const out = [];
    factsList.forEach((f, i) => {
      const ek = `E${i + 1}`; ids.set(ek, f.id);
      const home = f.home ? f.rows.find(r => r.id === f.home) : null;
      out.push(`${ek} ${f.name}${f.year ? ` (${f.year}` : ' ('}${f.publisher ? `${f.year ? ', ' : ''}${f.publisher}` : ''}) · ${f.total} issues in the reading order`);
      out.push(`  Home: ${home ? `${sid(home.id)} ${home.name}` : 'none'}${f.approved ? ' (approved by the admin)' : f.homeWhy ? ` (rule: ${short(f.homeWhy, 80)})` : ''}`);
      for (const r of f.rows) {
        const bits = [];
        if (r.notInOrder) bits.push('not in the reading order');
        else {
          const tiers = [r.main && `main ${r.main}`, r.tieIn && `tie-in ${r.tieIn}`, r.after && `aftermath ${r.after}`, r.lead && `lead-in ${r.lead}`].filter(Boolean).join(', ');
          bits.push(`${r.n} in order${tiers ? ` (${tiers})` : ''}`, `from #${r.first}`);
        }
        if (r.id) bits.push(r.size ? `${r.size}-issue series` : 'in library'); else bits.push('not in library');
        if (r.ongoing) bits.push('still publishing');
        if (r.shelf) bits.push(`ON SHELF: ${r.shelf.role}, ${r.shelf.hidden ? 'hidden' : 'visible'}`);
        out.push(`  ${r.id ? sid(r.id) : '-'} ${r.name} · ${bits.join(' · ')}`);
      }
      if (f.more) out.push(`  (${f.more} more tie-in series, none in the library)`);
    });
    return { text: out.join('\n'), ids };
  }

  // Events worth asking about: something on the shelf (2026-11-13, user: a crossover that ran inside
  // ongoing titles, with no minis or one-shots, needs no home), and not an initiative without a home.
  const shelved = (e, ctx) => (ctx.members.get(e.id)?.size || 0) > 0;
  const askable = (e, f, ctx) => !(e.initiative && !e.chosen) && shelved(e, ctx);

  // ── Saved answers ──
  const getAnswer = db.prepare("SELECT * FROM shelf_sorter_answers WHERE kind = 'event' AND item_id = ?");
  const putAnswer = db.prepare(`INSERT INTO shelf_sorter_answers (kind, item_id, hash, model, answer, asked_at, run_id, applied) VALUES ('event', ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(kind, item_id) DO UPDATE SET hash = excluded.hash, model = excluded.model, answer = excluded.answer, asked_at = excluded.asked_at, run_id = excluded.run_id,
      applied = CASE WHEN shelf_sorter_answers.applied LIKE 'undone:%' THEN shelf_sorter_answers.applied ELSE NULL END`);   // once undone, an event's answers stay advice
  const rehash = db.prepare("UPDATE shelf_sorter_answers SET hash = ? WHERE kind = 'event' AND item_id = ?");
  const answersMap = () => new Map(db.prepare("SELECT * FROM shelf_sorter_answers WHERE kind = 'event'").all().map(r => [r.item_id, r]));

  // Turn one reply item into an answer with real ids; anything not in the event is dropped.
  function resolve(item, facts, ids) {
    const inEvent = new Set(facts.rows.filter(r => r.id).map(r => r.id));
    const onShelf = new Set(facts.rows.filter(r => r.shelf).map(r => r.id));
    const conf = c => (CONF.includes(c) ? c : 'unsure');
    const h = item.home || {};
    let verdict = ['agree', 'change', 'none'].includes(h.verdict) ? h.verdict : 'agree';
    let seriesId = h.series ? ids.get(h.series) || null : null;
    if (verdict === 'change' && (!seriesId || !inEvent.has(seriesId) || seriesId === facts.home)) verdict = seriesId === facts.home ? 'agree' : 'none';
    if (verdict !== 'change') seriesId = null;
    const members = [];
    for (const m of Array.isArray(item.members) ? item.members : []) {
      const id = ids.get(m.series);
      if (!id || !onShelf.has(id) || !['remove', 'keep_visible'].includes(m.action)) continue;
      members.push({ seriesId: id, action: m.action, confidence: conf(m.confidence), why: short(m.why, 140) });
    }
    return { home: { verdict, seriesId, confidence: conf(h.confidence), why: short(h.why, 140) }, members };
  }

  // ── Runs ──
  const state = { running: null, done: 0, total: 0, stop: false };
  const newRun = (mode, model = null) => {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO shelf_sorter_runs (id, started_at, mode, status, model) VALUES (?, ?, ?, 'running', ?)").run(id, now(), mode, model);
    return id;
  };
  const endRun = (id, fields) => db.prepare('UPDATE shelf_sorter_runs SET finished_at = ?, status = ?, asked = ?, applied = ?, error = ? WHERE id = ?')
    .run(now(), fields.status, fields.asked || 0, fields.applied || 0, fields.error || null, id);

  // Ask about events (all askable ones whose facts changed, or the given ids). Saves answers only.
  async function ask({ eventIds = null, force = false, limit = Infinity, mode = 'ask' } = {}) {
    if (state.running) return { skipped: true, running: true };
    const ctx = context();
    const wanted = eventIds ? new Set(eventIds) : null;
    const saved = answersMap();
    const todo = [];
    for (const e of ctx.events) {
      if (wanted && !wanted.has(e.id)) continue;
      const f = eventFacts(e, ctx);
      if (!wanted && !askable(e, f, ctx)) continue;
      const hash = hashOf({ f, v: 1 });
      if (!force && saved.get(e.id)?.hash === hash) continue;
      todo.push({ f, hash });
      if (todo.length >= limit) break;
    }
    if (!todo.length) return { asked: 0, runId: null };
    const model = ai.choose ? ai.choose(TASK) : modelFor(TASK);
    const runId = newRun(mode, model);
    Object.assign(state, { running: runId, done: 0, total: todo.length, stop: false });
    let asked = 0, failed = null;
    try {
      await ai.run({ label: `Shelf Sorter: ${todo.length} event${todo.length === 1 ? '' : 's'}` }, async () => {
        for (let i = 0; i < todo.length && !state.stop; i += PER_CALL) {
          const batch = todo.slice(i, i + PER_CALL);
          const { text, ids } = render(batch.map(b => b.f));
          let r;
          try {
            r = await ai.complete({ task: TASK, ...(model ? { model } : {}), system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
              prompt: `Events to check (${batch.length}):\n\n${text}\n\nReply with JSON: {"events":[{"event":"E1","home":{"verdict","series","confidence","why"},"members":[...]}]}.`,
              maxTokens: 8000, outputSchema: SCHEMA, timeout: 180000, source: 'live' });
          } catch (e) {
            if (e.code === 'AI_KEY_MISSING' || e.code === 'AI_PROVIDER_UNAVAILABLE' || e.response?.status === 401) { failed = e.message; break; }
            logger?.warn?.('shelf-sorter', 'AI call failed', e.message);
            failed = e.message; state.done += batch.length; continue;
          }
          const data = parseReply(r.text);
          const items = Array.isArray(data?.events) ? data.events : [];
          if (!items.length) { setJobOutcome(r.jobId, 'bad_json'); state.done += batch.length; continue; }
          let got = 0;
          for (const item of items) {
            const eventId = ids.get(item.event);
            const b = batch.find(x => x.f.id === eventId);
            if (!b) continue;
            putAnswer.run(eventId, b.hash, r.model || model, JSON.stringify(resolve(item, b.f, ids)), now(), runId);
            got++; asked++;
          }
          setJobOutcome(r.jobId, got === batch.length ? 'ok' : 'truncated');
          state.done += batch.length;
        }
      });
    } finally {
      endRun(runId, { status: state.stop ? 'stopped' : failed && !asked ? 'failed' : 'done', asked, error: failed });
      Object.assign(state, { running: null });
    }
    logger?.info?.('shelf-sorter', `Asked about ${asked} of ${todo.length} events`, { run: runId, model, error: failed });
    return { asked, total: todo.length, runId, error: failed };
  }

  // ── Applying answers ──
  const record = db.prepare('INSERT INTO shelf_sorter_changes (run_id, kind, event_id, series_id, home_id, previous) VALUES (?, ?, ?, ?, ?, ?)');
  const markApplied = db.prepare("UPDATE shelf_sorter_answers SET applied = ? WHERE kind = 'event' AND item_id = ?");
  const userKept = db.prepare("SELECT 1 FROM series_link_overrides WHERE series_id = ? AND home_id IN (?, ?) AND action = 'user_keep'");

  // The parts of an answer that would still change something now: { home: bool, members: [...] }.
  // The admin's own choices are never changed: a home they chose or approved, a series they put back.
  function remaining(a, e, ctx) {
    const userHome = e.confirmed && (e.source === 'chosen' || e.source === 'approved');
    const h = a.home || {};
    const home = !userHome && ((h.verdict === 'agree' && !!e.home && !e.confirmed) || (h.verdict === 'change' && !!h.seriesId && h.seriesId !== e.home));
    const shelf = ctx.members.get(e.id) || new Map();
    const members = (a.members || []).filter(m => {
      const link = shelf.get(m.seriesId);
      if (!link) return false;
      return m.action === 'remove' ? !userKept.get(m.seriesId, link.home_id, `event:${e.id}`) : !ctx.keep.has(m.seriesId);
    });
    return { home, members };
  }

  // Apply saved answers. sureOnly: only the confident parts ("Apply sure ones", automatic runs);
  // a row's "Use the AI's advice" (eventIds) applies all of that event's advice: the admin decided.
  // Applying is idempotent (what is already done is skipped); answers of an event whose AI changes
  // were undone are not applied again except from its row.
  function apply({ eventIds = null, sureOnly = true, mode = 'apply' } = {}) {
    const ctx = context();
    const byId = new Map(ctx.events.map(e => [e.id, e]));
    const wanted = eventIds ? new Set(eventIds) : null;
    let runId = null;
    const rid = () => runId || (runId = newRun(mode));   // a run is recorded only when something changes
    let applied = 0;
    const touched = [];
    const ok = c => !sureOnly || c === 'sure';
    try {
      for (const row of answersMap().values()) {
        if (wanted ? !wanted.has(row.item_id) : String(row.applied || '').startsWith('undone:')) continue;
        const e = byId.get(row.item_id);
        if (!e) continue;
        if (!wanted && hashOf({ f: eventFacts(e, ctx), v: 1 }) !== row.hash) continue;    // changed since: ask again first
        let a; try { a = JSON.parse(row.answer); } catch { continue; }
        if (!wanted && !shelved(e, ctx)) continue;   // an empty shelf needs no home
        const left = remaining(a, e, ctx);
        let n = 0;
        if (left.home && ok(a.home.confidence)) {
          const by = sureOnly ? 'ai' : 'approved';
          // Approving locks the current home, the same as "Looks right" (passing it saves recomputing every event).
          const body = { homeSeriesId: a.home.verdict === 'agree' ? e.home : a.home.seriesId, by };
          const r = grouping.setEvent(e.id, body, { rerun: false });
          record.run(rid(), 'event', e.id, null, null, JSON.stringify(r.previous)); n++;
        }
        for (const m of left.members) {
          if (!ok(m.confidence)) continue;
          const link = ctx.members.get(e.id).get(m.seriesId);
          if (m.action === 'remove') {
            if (grouping.unlink(m.seriesId, link.home_id)) { record.run(rid(), 'reject', e.id, m.seriesId, link.home_id, null); n++; }
          } else {
            grouping.keepVisible(m.seriesId, true); ctx.keep.add(m.seriesId);
            record.run(rid(), 'keep_visible', e.id, m.seriesId, null, null); n++;
          }
        }
        if (wanted) markApplied.run('user', row.item_id);
        if (n) touched.push(row.item_id);
        applied += n;
      }
    } finally {
      if (runId) endRun(runId, { status: 'done', applied });
      if (applied) grouping.run('shelf sorter');
    }
    // The AI's own changes do not make its answers out of date.
    if (touched.length) refreshHashes(touched);
    if (applied) logger?.info?.('shelf-sorter', `Applied ${applied} change${applied === 1 ? '' : 's'}`, { run: runId, mode });
    return { applied, runId };
  }
  function refreshHashes(ids) {
    const ctx = context();
    for (const id of ids) { const e = ctx.events.find(x => x.id === id); if (e) rehash.run(hashOf({ f: eventFacts(e, ctx), v: 1 }), id); }
  }

  // Undo every change one run made, newest first. Its answers are not applied again automatically.
  function undo(runId) {
    const run = db.prepare('SELECT * FROM shelf_sorter_runs WHERE id = ?').get(runId);
    if (!run) throw Object.assign(new Error('Run not found'), { status: 404 });
    if (run.undone_at) return { undone: 0 };
    const changes = db.prepare('SELECT * FROM shelf_sorter_changes WHERE run_id = ? ORDER BY id DESC').all(runId);
    for (const c of changes) {
      if (c.kind === 'event') { try { grouping.setEvent(c.event_id, { restore: JSON.parse(c.previous) }, { rerun: false }); } catch {} }
      else if (c.kind === 'reject') db.prepare("DELETE FROM series_link_overrides WHERE series_id = ? AND home_id IN (?, ?) AND action = 'reject'").run(c.series_id, c.home_id, `event:${c.event_id}`);
      else if (c.kind === 'keep_visible') db.prepare("DELETE FROM series_link_overrides WHERE series_id = ? AND action = 'keep_visible'").run(c.series_id);
    }
    db.prepare('UPDATE shelf_sorter_runs SET undone_at = ? WHERE id = ?').run(now(), runId);
    const events = [...new Set(changes.map(c => c.event_id).filter(Boolean))];
    const mark = db.prepare("UPDATE shelf_sorter_answers SET applied = ? WHERE kind = 'event' AND item_id = ?");
    for (const id of events) mark.run(`undone:${runId}`, id);
    grouping.run('shelf sorter undo');
    refreshHashes(events);
    return { undone: changes.length };
  }

  // The hourly rules run: with the switch on, ask about new or changed events, then apply sure answers.
  async function auto() {
    if (getSetting(AUTO_KEY) !== '1' || state.running) return { skipped: true };
    const r = await ask({ limit: AUTO_LIMIT, mode: 'auto' });
    if (r.error && !r.asked) return r;
    return { ...r, ...apply({ mode: 'auto' }) };
  }

  // ── For the Library panel ──
  // Adds `ai` to each event of grouping.summary(): the saved answer with names, and whether the
  // event changed since it was asked.
  function annotate(summary) {   // returns how many sure changes are waiting
    const answers = answersMap();
    if (!answers.size) return 0;
    const ctx = context();
    const byId = new Map(ctx.events.map(e => [e.id, e]));
    const name = id => label(ctx.S.get(id)) || null;
    let ready = 0;
    for (const e of summary.events) {
      const row = answers.get(e.id);
      const ev = byId.get(e.id);
      if (!row || !ev) continue;
      let a; try { a = JSON.parse(row.answer); } catch { continue; }
      const stale = hashOf({ f: eventFacts(ev, ctx), v: 1 }) !== row.hash;
      const undone = String(row.applied || '').startsWith('undone:');
      const left = remaining(a, ev, ctx);
      if (!stale && !undone && shelved(ev, ctx)) ready += (left.home && a.home.confidence === 'sure' ? 1 : 0) + left.members.filter(m => m.confidence === 'sure').length;
      e.ai = { home: { ...a.home, name: a.home.seriesId ? name(a.home.seriesId) : null, open: left.home },
        members: left.members.map(m => ({ ...m, name: name(m.seriesId) })),
        model: modelName(row.model), askedAt: row.asked_at, undone, stale };
    }
    return ready;
  }

  function status() {
    const last = db.prepare("SELECT * FROM shelf_sorter_runs WHERE applied > 0 AND undone_at IS NULL ORDER BY started_at DESC LIMIT 1").get() || null;
    const lastAsk = db.prepare("SELECT * FROM shelf_sorter_runs WHERE mode IN ('ask', 'auto') ORDER BY started_at DESC LIMIT 1").get() || null;
    const asked = db.prepare("SELECT COUNT(*) AS n FROM shelf_sorter_answers WHERE kind = 'event'").get().n;
    let model = null; try { model = modelFor(TASK); } catch {}
    return { auto: getSetting(AUTO_KEY) === '1', running: state.running ? { done: state.done, total: state.total } : null, asked,
      model: model ? modelName(model) : null, lastApplied: last && { id: last.id, at: last.finished_at, applied: last.applied, mode: last.mode },
      lastAsk: lastAsk && { at: lastAsk.finished_at || lastAsk.started_at, status: lastAsk.status, asked: lastAsk.asked, error: lastAsk.error } };
  }
  function setAuto(on) { setSetting(AUTO_KEY, on ? '1' : ''); return status(); }
  function stop() { state.stop = true; return { stopping: !!state.running }; }

  return { ask, apply, undo, auto, annotate, status, setAuto, stop, eventFacts, render, context, _state: state };
}

module.exports = { createShelfSorter, initShelfSorter, parseReply, SYSTEM, SCHEMA, TASK, AUTO_KEY };
