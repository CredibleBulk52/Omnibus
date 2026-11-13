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
const B = require('./shelfSorterSeries');   // stage B: homeless minis and one-shots

const TASK = 'shelf_sorter';
// "Apply sure answers when I ask" (2026-11-14): no AI call is made without an admin's click (user:
// costs could grow unchecked). With this on, the sure answers about series and events asked about
// for the first time are applied right after the admin's ask; a re-ask never applies on its own.
const AUTO_KEY = 'shelf_sorter_auto';
const PER_CALL = 6;           // events per AI call
const PER_CALL_SERIES = 12;   // series per AI call (stage B)
// Bump when a prompt changes in a way that should offer a re-ask (answers made under an older
// prompt or another model are counted as "outdated" on the panel; nothing re-asks on its own).
const PROMPT_V = { event: 1, series: 1 };
const SCOPES = ['new', 'suggested', 'outdated', 'all'];
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

// aiAvailable(): whether the Shelf Sorter's model has its provider key saved. Without one, "Ask"
// gives Omnibus's own suggestions for minis and one-shots (localSuggest) and leaves events to the rules.
function createShelfSorter({ db, grouping, ai, getSetting, setSetting, modelFor = () => null, logger = null, now = Date.now, setJobOutcome = () => {}, modelName = m => m, seriesTypes = null, aiAvailable = () => true }) {
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
  const putAnswerKind = db.prepare(`INSERT INTO shelf_sorter_answers (kind, item_id, hash, model, answer, asked_at, run_id, applied) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(kind, item_id) DO UPDATE SET hash = excluded.hash, model = excluded.model, answer = excluded.answer, asked_at = excluded.asked_at, run_id = excluded.run_id,
      applied = CASE WHEN shelf_sorter_answers.applied LIKE 'undone:%' OR shelf_sorter_answers.applied = 'declined' THEN shelf_sorter_answers.applied ELSE NULL END`);   // once undone or declined, answers stay advice
  const putAnswer = { run: (...a) => putAnswerKind.run('event', ...a) };
  const rehash = db.prepare("UPDATE shelf_sorter_answers SET hash = ? WHERE kind = 'event' AND item_id = ?");
  const answersMap = (kind = 'event') => new Map(db.prepare('SELECT * FROM shelf_sorter_answers WHERE kind = ?').all(kind).map(r => [r.item_id, r]));
  const parse = row => { try { return row ? JSON.parse(row.answer) : null; } catch { return null; } };
  const currentModel = () => { try { return modelFor(TASK) || null; } catch { return null; } };
  // An answer from another model or an older prompt. Omnibus's own suggestions (no AI) count once an
  // AI key is saved; Metron's rule never does.
  function outdated(row, a, kind, cur) {
    if (!row || row.model === 'metron') return false;
    if (row.model === 'omnibus') return !!aiAvailable();
    return (!!cur && row.model !== cur) || ((a && a.p) || 1) !== PROMPT_V[kind];
  }

  // ── Stage B context (cached briefly: the Library panel reads it twice per load) ──
  let bCache = null;
  const bContext = () => {
    if (bCache && now() - bCache.at < 20000) return bCache.ctx;
    const ctx = B.seriesContext(db, { curated: grouping.curatedSeries ? grouping.curatedSeries() : new Set(), types: seriesTypes ? seriesTypes.all() : new Map() });
    bCache = { at: now(), ctx };
    migrateHashes(ctx);
    return ctx;
  };
  const bForget = () => { bCache = null; };
  // b3 (2026-11-14): an answer depends only on the series' own facts (stableFacts), so a candidate
  // list that shifts as the library grows does not ask again. An answer is out of date when those
  // facts change, or when the home it named is no longer a candidate (bStale).
  const bHash = f => hashOf({ f: B.stableFacts(f), v: 'b3' });
  const bStale = (row, a, f) => !f || bHash(f) !== row.hash || (!!a.homeId && !f.candidates.some(c => c.id === a.homeId));
  // Answers saved under b2 (the whole facts, candidates included) carry over when nothing has changed.
  let migrated = getSetting('shelf_sorter_hash_b3') === '1';
  function migrateHashes(ctx) {
    if (migrated) return;
    migrated = true;
    try {
      const rows = db.prepare("SELECT item_id, hash FROM shelf_sorter_answers WHERE kind = 'series'").all();
      const byId = new Map(ctx.targets.map(t => [t.id, t]));
      const upd = db.prepare("UPDATE shelf_sorter_answers SET hash = ? WHERE kind = 'series' AND item_id = ?");
      let n = 0;
      for (const r of rows) {
        const t = byId.get(r.item_id);
        if (!t) continue;
        const f = B.seriesFacts(t, ctx);
        const { kind, metronType, ...b2 } = f;   // b2 facts had no Metron kind
        if (hashOf({ f: b2, v: 'b2' }) === r.hash) { upd.run(bHash(f), r.item_id); n++; }
      }
      setSetting('shelf_sorter_hash_b3', '1');
      if (n) logger?.info?.('shelf-sorter', `Kept ${n} series answers under the new rule (no re-ask)`);
    } catch (e) { logger?.warn?.('shelf-sorter', 'Answer hash update failed', e.message); }
  }

  // Metron says "ongoing": a series in its own right, decided without the AI (Arkham Manor, Avengers Inc.).
  // Overrides an unapplied AI answer; a series the admin declined or shelved is left alone.
  const METRON_OWN = { verdict: 'own', homeId: null, confidence: 'sure', why: 'Metron lists it as an ongoing series: kept as its own' };
  function typeRule(bctx = bContext()) {
    const saved = answersMap('series');
    let n = 0;
    for (const t of bctx.targets) {
      const k = bctx.kindOf(t);
      if (!k || k.kind !== 'ongoing') continue;
      const row = saved.get(t.id);
      let a = null; try { a = row ? JSON.parse(row.answer) : null; } catch {}
      if (row && (row.applied === 'declined' || (a && a.verdict === 'own'))) continue;
      putAnswerKind.run('series', t.id, bHash(B.seriesFacts(t, bctx)), 'metron', JSON.stringify(METRON_OWN), now(), null);
      n++;
    }
    if (n) logger?.info?.('shelf-sorter', `${n} series kept as their own: Metron lists them as ongoing`);
    return n;
  }
  // Omnibus's own suggestions when no AI key is saved: the strongest local matches only, as "likely"
  // (shown for the admin to Shelve; "Apply sure" never applies them). Answers already given (by an AI
  // earlier, or declined) are kept.
  function localSuggest({ force = false } = {}) {
    const bctx = bContext();
    typeRule(bctx);
    const saved = answersMap('series');
    let n = 0, looked = 0;
    for (const t of bctx.targets) {
      const f = B.seriesFacts(t, bctx);
      if (!f.candidates.length || f.kind === 'ongoing' || B.tooNew(f)) continue;
      const row = saved.get(t.id);
      if (row && !force) continue;
      if (row && (row.applied === 'declined' || row.model !== 'omnibus')) continue;
      looked++;
      const a = B.localSuggestion(t, f, bctx);
      if (!a) continue;
      putAnswerKind.run('series', t.id, bHash(f), 'omnibus', JSON.stringify(a), now(), null);
      n++;
    }
    logger?.info?.('shelf-sorter', `Omnibus suggested ${n} homes without AI (of ${looked} series looked at)`);
    return { asked: n, total: looked, local: true };
  }

  // The Metron lookups for the series the Shelf Sorter may ask about (seriesTypes.js), then the rule.
  // Only the series a type can still change (2026-11-14): open suggestions first, then series not
  // asked about yet. Settled ones (own, landmark, none, declined, shelved) are skipped: at Metron's
  // pace (two requests, about 7 s a series) looking up all 800+ took hours for nothing.
  function typeScope(bctx) {
    const saved = answersMap('series');
    const open = [], unasked = [];
    for (const t of bctx.targets) {
      if (!t.comicid) continue;
      const row = saved.get(t.id);
      if (!row) { if (B.seriesFacts(t, bctx).candidates.length) unasked.push(t); continue; }
      if (row.applied === 'declined') continue;
      let a = null; try { a = JSON.parse(row.answer); } catch {}
      if (a && seriesOpen(a, t.id, bctx)) open.push(t);
    }
    return [...open, ...unasked];
  }
  async function lookUpTypes({ limit = 60 } = {}) {
    if (!seriesTypes) return { skipped: true };
    const bctx = bContext();
    const items = typeScope(bctx).map(t => ({ comicid: t.comicid, name: t.name, year: t.year }));
    const r = await seriesTypes.run(items, { limit });
    bForget(); typeRule();   // also for types saved earlier (a kind can change with kindOf)
    return r;
  }

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

  // What an ask would cover. scope (2026-11-14, claude/SHELF_SORTER.md "Admin-triggered workflow"):
  //   new        series and events not asked about yet, or whose facts changed (✦ Ask the AI)
  //   suggested  the open suggestions only: advice not yet applied, declined or decided by the admin
  //   outdated   the open suggestions made by another model or an older prompt
  //   all        everything the admin has not decided: also answers already applied and series the
  //              AI shelved (a disagreement comes back as advice, never applied on its own)
  // The admin's own choices are never asked about again in a re-ask (declined, shelved with ✓ or kept),
  // and never changed by an answer (remaining()). fresh: the ids with no answer before.
  function plan({ scope = 'new', kinds = ['event', 'series'], eventIds = null, seriesIds = null, limit = Infinity, seriesLimit = Infinity } = {}) {
    if (!SCOPES.includes(scope)) scope = 'new';
    const cur = currentModel();
    const todo = [], bTodo = [];
    const fresh = { events: new Set(), series: new Set() };
    if (kinds.includes('series') && !eventIds) {
      const bctx = bContext();
      typeRule(bctx);
      const bWanted = seriesIds ? new Set(seriesIds) : null;
      const bSaved = answersMap('series');
      const aiHomes = aiHomesOf();
      const shelvedIds = new Set((bctx.aiShelved || []).map(t => t.id));
      const pool = scope === 'new' && !bWanted ? bctx.targets : [...bctx.targets, ...(bctx.aiShelved || [])];
      for (const t of pool) {
        if (bWanted && !bWanted.has(t.id)) continue;
        const f = B.seriesFacts(t, bctx);
        if (!f.candidates.length || f.kind === 'ongoing') continue;   // ongoing: decided by typeRule
        if (!bWanted && B.tooNew(f)) continue;                         // only #1 out: wait for Metron or a second issue
        const hash = bHash(f);
        const row = bSaved.get(t.id);
        const a = parse(row);
        if (!bWanted && row && (row.applied === 'declined' || (scope !== 'new' && row.applied === 'user'))) continue;
        const onShelf = shelvedIds.has(t.id);
        const open = !!(row && a && (onShelf ? rethinks(a, t.id, aiHomes) : seriesOpen(a, t.id, bctx)));
        const again = bWanted ? true
          : scope === 'all' ? true
          : scope === 'suggested' ? open
          : scope === 'outdated' ? open && outdated(row, a, 'series', cur)
          : !onShelf && (!row || !a || bStale(row, a, f));
        if (!again) continue;
        bTodo.push({ f, hash });
        if (!row) fresh.series.add(t.id);
        if (bTodo.length >= seriesLimit) break;
      }
    }
    if (kinds.includes('event') && !seriesIds) {
      const ctx = context();
      const wanted = eventIds ? new Set(eventIds) : null;
      const saved = answersMap();
      for (const e of ctx.events) {
        if (wanted && !wanted.has(e.id)) continue;
        const f = eventFacts(e, ctx);
        if (!wanted && !askable(e, f, ctx)) continue;
        const hash = hashOf({ f, v: 1 });
        const row = saved.get(e.id);
        const a = parse(row);
        const left = a ? remaining(a, e, ctx) : null;
        const open = !!(left && (left.home || left.members.length));
        const again = wanted ? true
          : scope === 'all' ? true
          : scope === 'suggested' ? open
          : scope === 'outdated' ? open && outdated(row, a, 'event', cur)
          : row?.hash !== hash;
        if (!again) continue;
        todo.push({ f, hash });
        if (!row) fresh.events.add(e.id);
        if (todo.length >= limit) break;
      }
    }
    return { todo, bTodo, fresh, scope };
  }
  const callsFor = (events, series) => Math.ceil(events / PER_CALL) + Math.ceil(series / PER_CALL_SERIES);
  // What an ask would cost, shown before it runs. Without an AI key, Omnibus's own suggestions cost nothing.
  function estimate(opts = {}) {
    const { todo, bTodo, scope } = plan(opts);
    const model = currentModel();
    return { scope, events: todo.length, series: bTodo.length, calls: aiAvailable() ? callsFor(todo.length, bTodo.length) : 0,
      local: !aiAvailable(), model: model && aiAvailable() ? modelName(model) : null };
  }

  // Ask the AI (only ever on an admin's click). Saves answers; with "Apply sure answers when I ask"
  // on, a new ask then applies the sure answers about what had no answer before.
  // Older callers: force = scope 'all'; suggested = scope 'suggested'.
  async function ask({ eventIds = null, seriesIds = null, force = false, suggested = false, scope = null, limit = Infinity, seriesLimit = Infinity, mode = 'ask', kinds = ['event', 'series'] } = {}) {
    if (state.running) return { skipped: true, running: true };
    scope = scope || (force ? 'all' : suggested ? 'suggested' : 'new');
    if (!aiAvailable()) return localSuggest({ force: scope === 'all' });
    const { todo, bTodo, fresh } = plan({ scope, kinds, eventIds, seriesIds, limit, seriesLimit });
    if (!todo.length && !bTodo.length) return { asked: 0, runId: null, scope };
    const model = ai.choose ? ai.choose(TASK) : modelFor(TASK);
    const runId = newRun(mode, model);
    Object.assign(state, { running: runId, done: 0, total: todo.length + bTodo.length, stop: false });
    let asked = 0, failed = null, keyFailed = false;
    const what = [todo.length && `${todo.length} event${todo.length === 1 ? '' : 's'}`, bTodo.length && `${bTodo.length} series`].filter(Boolean).join(' and ');
    try {
      await ai.run({ label: `Shelf Sorter: ${what}` }, async () => {
        for (let i = 0; i < todo.length && !state.stop; i += PER_CALL) {
          const batch = todo.slice(i, i + PER_CALL);
          const { text, ids } = render(batch.map(b => b.f));
          let r;
          try {
            r = await ai.complete({ task: TASK, ...(model ? { model } : {}), system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
              prompt: `Events to check (${batch.length}):\n\n${text}\n\nReply with JSON: {"events":[{"event":"E1","home":{"verdict","series","confidence","why"},"members":[...]}]}.`,
              maxTokens: 8000, outputSchema: SCHEMA, timeout: 180000, source: 'live' });
          } catch (e) {
            if (e.code === 'AI_KEY_MISSING' || e.code === 'AI_PROVIDER_UNAVAILABLE' || e.response?.status === 401) { failed = e.message; keyFailed = true; break; }
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
            putAnswer.run(eventId, b.hash, r.model || model, JSON.stringify({ ...resolve(item, b.f, ids), p: PROMPT_V.event }), now(), runId);
            got++; asked++;
          }
          setJobOutcome(r.jobId, got === batch.length ? 'ok' : 'truncated');
          state.done += batch.length;
        }
        // Stage B: minis and one-shots, 12 per call.
        for (let i = 0; i < bTodo.length && !state.stop && !keyFailed; i += PER_CALL_SERIES) {
          const batch = bTodo.slice(i, i + PER_CALL_SERIES);
          const { text, ids } = B.renderSeries(batch.map(b => b.f));
          let r;
          try {
            r = await ai.complete({ task: TASK, ...(model ? { model } : {}), system: [{ type: 'text', text: B.SERIES_SYSTEM, cache_control: { type: 'ephemeral' } }],
              prompt: `Series to check (${batch.length}):\n\n${text}\n\nReply with JSON: {"series":[{"item":"T1","verdict","home","confidence","why"}]}, one entry per T id.`,
              maxTokens: 8000, outputSchema: B.SERIES_SCHEMA, timeout: 180000, source: 'live' });
          } catch (e) {
            if (e.code === 'AI_KEY_MISSING' || e.code === 'AI_PROVIDER_UNAVAILABLE' || e.response?.status === 401) { failed = e.message; break; }
            logger?.warn?.('shelf-sorter', 'AI call failed', e.message);
            failed = e.message; state.done += batch.length; continue;
          }
          const data = parseReply(r.text);
          const items = Array.isArray(data?.series) ? data.series : [];
          if (!items.length) { setJobOutcome(r.jobId, 'bad_json'); state.done += batch.length; continue; }
          let got = 0;
          for (const item of items) {
            const sid = ids.get(item.item);
            const b = batch.find(x => x.f.id === sid);
            if (!b) continue;
            putAnswerKind.run('series', sid, b.hash, r.model || model, JSON.stringify({ ...B.resolveSeries(item, b.f, ids), p: PROMPT_V.series }), now(), runId);
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
    logger?.info?.('shelf-sorter', `Asked about ${asked} of ${todo.length + bTodo.length} (${what})`, { run: runId, model, scope, error: failed });
    const out = { asked, total: todo.length + bTodo.length, runId, scope, error: failed };
    // Only a new ask, by the admin, and only answers about what was never asked before.
    if (asked && scope === 'new' && mode === 'ask' && getSetting(AUTO_KEY) === '1' && (fresh.events.size || fresh.series.size)) {
      bForget();
      const r = apply({ only: fresh, mode: 'ask-apply' });
      Object.assign(out, { applied: r.applied, appliedRun: r.runId });
    }
    return out;
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
  // only: { events: Set, series: Set } limits a sure-only apply to those (after a new ask).
  function apply({ eventIds = null, seriesIds = null, sureOnly = true, mode = 'apply', only = null } = {}) {
    const ctx = context();
    const byId = new Map(ctx.events.map(e => [e.id, e]));
    const wanted = eventIds ? new Set(eventIds) : seriesIds ? new Set() : null;
    let runId = null;
    const rid = () => runId || (runId = newRun(mode));   // a run is recorded only when something changes
    let applied = 0;
    const touched = [];
    const ok = c => !sureOnly || c === 'sure';
    try {
      for (const row of answersMap().values()) {
        if (wanted ? !wanted.has(row.item_id) : String(row.applied || '').startsWith('undone:')) continue;
        if (only && !only.events.has(row.item_id)) continue;
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
      // Stage B: shelve minis and one-shots under the home the AI named.
      if (!eventIds) applied += applySeries({ wanted: seriesIds ? new Set(seriesIds) : null, ok, rid, sureOnly, only: only ? only.series : null });
    } finally {
      if (runId) endRun(runId, { status: 'done', applied });
      if (applied) { grouping.run('shelf sorter'); grouping.changed && grouping.changed(); }
    }
    // The AI's own changes do not make its answers out of date.
    if (touched.length) refreshHashes(touched);
    if (applied) logger?.info?.('shelf-sorter', `Applied ${applied} change${applied === 1 ? '' : 's'}`, { run: runId, mode });
    return { applied, runId };
  }
  const insertLink = db.prepare(`INSERT INTO series_links (series_id, home_id, source, role, hidden, reason, created_at, event_id)
    VALUES (?, ?, 'ai', ?, ?, ?, ?, NULL) ON CONFLICT(series_id, home_id) DO NOTHING`);
  const markSeries = db.prepare("UPDATE shelf_sorter_answers SET applied = ? WHERE kind = 'series' AND item_id = ?");
  // A series answer still applies when: verdict home, the series is still on no shelf, the home is
  // still in the library, and the admin has not removed it from that home.
  function seriesOpen(a, sid, bctx) {
    return (a.verdict === 'home' || a.verdict === 'main') && !!a.homeId && !bctx.linked.has(sid) && bctx.S.has(sid) && bctx.S.has(a.homeId)
      && !db.prepare("SELECT 1 FROM series_link_overrides WHERE series_id = ? AND home_id = ? AND action = 'reject'").get(sid, a.homeId);
  }
  // A series the AI shelved whose latest answer no longer names that home (asked again in a full
  // review): shown on Shelved by the AI for the admin to take off or keep. Never changed on its own.
  const aiHomesOf = () => {
    const m = new Map();
    for (const l of db.prepare("SELECT series_id, home_id FROM series_links WHERE source = 'ai'").all()) { if (!m.has(l.series_id)) m.set(l.series_id, new Set()); m.get(l.series_id).add(l.home_id); }
    return m;
  };
  const rethinks = (a, sid, aiHomes) => !!a && !((a.verdict === 'home' || a.verdict === 'main') && !!aiHomes.get(sid)?.has(a.homeId));
  function applySeries({ wanted, ok, rid, sureOnly, only = null }) {
    const bctx = bContext();
    const targets = new Map(bctx.targets.map(t => [t.id, t]));
    let n = 0;
    for (const row of answersMap('series').values()) {
      const tag = String(row.applied || '');
      if (wanted ? !wanted.has(row.item_id) : (tag.startsWith('undone:') || tag === 'declined')) continue;
      if (only && !only.has(row.item_id)) continue;
      let a; try { a = JSON.parse(row.answer); } catch { continue; }
      if (!ok(a.confidence) || !seriesOpen(a, row.item_id, bctx)) continue;
      const t = targets.get(row.item_id);
      if (!wanted && (!t || bStale(row, a, B.seriesFacts(t, bctx)))) continue;   // changed since: ask again first
      const s = bctx.S.get(row.item_id);
      // Hidden like a tie-in, unless it is part of the main story, still publishing, or in an
      // Essential list or Top Shelf run.
      const main = a.verdict === 'main';
      const hidden = main || s.status === 'Continuing' || bctx.curated.has(row.item_id) ? 0 : 1;
      if (insertLink.run(row.item_id, a.homeId, main ? 'core' : 'special', hidden, `Shelf Sorter: ${a.why}`, now()).changes) {
        record.run(rid(), 'link', null, row.item_id, a.homeId, null); n++;
        bctx.linked.add(row.item_id);
        markSeries.run(sureOnly ? rid() : 'user', row.item_id);
      }
    }
    if (n) bForget();
    return n;
  }
  // "Not this one": the suggestion is set aside and the AI never shelves it there.
  function decline(seriesId) {
    const row = answersMap('series').get(seriesId);
    if (!row) throw Object.assign(new Error('No suggestion for that series'), { status: 404 });
    let a; try { a = JSON.parse(row.answer); } catch { a = {}; }
    if (a.homeId) db.prepare("INSERT OR REPLACE INTO series_link_overrides (series_id, home_id, action, created_at) VALUES (?, ?, 'reject', ?)").run(seriesId, a.homeId, now());
    const previous = row.applied || null;
    markSeries.run('declined', seriesId);
    bForget();
    return { declined: true, previous };
  }
  function undecline(seriesId, previous = null) {
    const row = answersMap('series').get(seriesId);
    if (!row) return { ok: false };
    let a; try { a = JSON.parse(row.answer); } catch { a = {}; }
    if (a.homeId) db.prepare("DELETE FROM series_link_overrides WHERE series_id = ? AND home_id = ? AND action = 'reject'").run(seriesId, a.homeId);
    markSeries.run(previous, seriesId);
    bForget();
    return { ok: true };
  }

  // "Keep it": the admin keeps a series the AI shelved although its latest answer disagrees. A kept
  // series is the admin's decision: not asked about again in a re-ask.
  function keep(seriesId, { undo = false, previous = null } = {}) {
    const row = answersMap('series').get(seriesId);
    if (!row) throw Object.assign(new Error('No answer for that series'), { status: 404 });
    const before = row.applied || null;
    markSeries.run(undo ? previous : 'user', seriesId);
    return { kept: !undo, previous: before };
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
      else if (c.kind === 'link') {
        db.prepare("DELETE FROM series_links WHERE series_id = ? AND home_id = ? AND source = 'ai'").run(c.series_id, c.home_id);
        db.prepare("UPDATE shelf_sorter_answers SET applied = ? WHERE kind = 'series' AND item_id = ?").run(`undone:${runId}`, c.series_id);
      }
    }
    if (changes.some(c => c.kind === 'link')) { bForget(); grouping.changed && grouping.changed(); }
    db.prepare('UPDATE shelf_sorter_runs SET undone_at = ? WHERE id = ?').run(now(), runId);
    const events = [...new Set(changes.map(c => c.event_id).filter(Boolean))];
    const mark = db.prepare("UPDATE shelf_sorter_answers SET applied = ? WHERE kind = 'event' AND item_id = ?");
    for (const id of events) mark.run(`undone:${runId}`, id);
    grouping.run('shelf sorter undo');
    refreshHashes(events);
    return { undone: changes.length };
  }

  // ── For the Library panel ──
  // Adds `ai` to each event of grouping.summary(): the saved answer with names, and whether the
  // event changed since it was asked.
  function annotate(summary) {   // returns how many sure changes are waiting
    const answers = answersMap();
    if (!answers.size) return 0;
    const ctx = context();
    const cur = currentModel();
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
        model: modelName(row.model), askedAt: row.asked_at, undone, stale, outdated: outdated(row, a, 'event', cur) };
    }
    return ready;
  }

  // Library panel › Minis & one-shots: the AI's answers about series (stage B).
  //   suggested: verdict home, still open, not declined or undone (sure ones first)
  //   shelved:   series the Shelf Sorter put on a shelf (source 'ai')
  //   counts of own / landmark / none, and how many series are still to ask about.
  function seriesSummary() {
    const bctx = bContext();
    const label2 = id => label(bctx.S.get(id)) || null;
    const targets = new Map(bctx.targets.map(t => [t.id, t]));
    const counts = { own: 0, landmark: 0, none: 0, declined: 0, ongoing: 0 };
    const suggested = [];
    let ready = 0, toAsk = 0, waiting = 0;
    const saved = answersMap('series');
    const cur = currentModel();
    for (const t of bctx.targets) {
      const row = saved.get(t.id);
      const f = row ? null : B.seriesFacts(t, bctx);
      if (!row && f.candidates.length && f.kind !== 'ongoing') { if (B.tooNew(f)) waiting++; else toAsk++; }
    }
    for (const row of saved.values()) {
      let a; try { a = JSON.parse(row.answer); } catch { continue; }
      const tag = String(row.applied || '');
      if (tag === 'declined') { counts.declined++; continue; }
      if (a.verdict !== 'home' && a.verdict !== 'main') { if (counts[a.verdict] != null) counts[a.verdict]++; if (row.model === 'metron') counts.ongoing++; continue; }
      if (!seriesOpen(a, row.item_id, bctx)) continue;
      const t = targets.get(row.item_id);
      const stale = bStale(row, a, t ? B.seriesFacts(t, bctx) : null);
      const undone = tag.startsWith('undone:');
      if (!stale && !undone && a.confidence === 'sure') ready++;
      const s = bctx.S.get(row.item_id);
      suggested.push({ seriesId: row.item_id, name: label2(row.item_id), issues: s ? s.size : null, homeId: a.homeId, homeName: label2(a.homeId),
        confidence: a.confidence, why: a.why, main: a.verdict === 'main', stale, undone, model: modelName(row.model), outdated: outdated(row, a, 'series', cur) });
    }
    const rank = { sure: 0, likely: 1, unsure: 2 };
    suggested.sort((x, y) => (rank[x.confidence] - rank[y.confidence]) || String(x.homeName).localeCompare(String(y.homeName)) || String(x.name).localeCompare(String(y.name)));
    // Shelved by the AI; a series whose latest answer disagrees (asked again in a full review) comes
    // first with what the AI now says, for the admin to take off or keep.
    const aiHomes = aiHomesOf();
    const shelved = db.prepare("SELECT series_id, home_id, reason, created_at FROM series_links WHERE source = 'ai' ORDER BY created_at DESC").all()
      .map(l => {
        const row = saved.get(l.series_id), a = parse(row);
        const kept = row?.applied === 'user';
        const re = row && a && !kept && rethinks(a, l.series_id, aiHomes)
          ? { verdict: a.verdict, homeName: a.homeId ? label2(a.homeId) : null, confidence: a.confidence, why: a.why, model: modelName(row.model) } : null;
        return { seriesId: l.series_id, name: label2(l.series_id), homeId: l.home_id, homeName: label2(l.home_id), why: String(l.reason || '').replace(/^Shelf Sorter: /, ''), rethink: re };
      })
      .sort((x, y) => (!!y.rethink - !!x.rethink));
    counts.rethink = shelved.filter(x => x.rethink).length;
    const types = seriesTypes ? seriesTypes.all() : new Map();
    const lookable = typeScope(bctx);
    const typesKnown = lookable.filter(t => types.has(t.comicid)).length;
    return { suggested, shelved, counts, ready, toAsk, waiting, asked: saved.size,
      types: seriesTypes ? { known: typesKnown, total: lookable.length, running: seriesTypes.status().running, words: typeWords(types) } : null };
  }
  // Metron's own words for the types saved so far, most common first (shown on hover).
  function typeWords(types) {
    const n = new Map();
    for (const t of types.values()) { const w = t.type || (t.kind === 'unknown' ? 'no match' : t.kind); n.set(w, (n.get(w) || 0) + 1); }
    return [...n].sort((a, b) => b[1] - a[1]).map(([word, count]) => ({ word, count }));
  }
  const seriesReady = () => { try { return seriesSummary().ready; } catch { return 0; } };

  function status() {
    const last = db.prepare("SELECT * FROM shelf_sorter_runs WHERE applied > 0 AND undone_at IS NULL ORDER BY started_at DESC LIMIT 1").get() || null;
    const lastAsk = db.prepare("SELECT * FROM shelf_sorter_runs WHERE mode IN ('ask', 'auto') ORDER BY started_at DESC LIMIT 1").get() || null;
    const asked = db.prepare("SELECT COUNT(*) AS n FROM shelf_sorter_answers WHERE kind = 'event'").get().n;
    const askedSeries = db.prepare("SELECT COUNT(*) AS n FROM shelf_sorter_answers WHERE kind = 'series'").get().n;
    let model = null; try { model = modelFor(TASK); } catch {}
    return { auto: getSetting(AUTO_KEY) === '1', running: state.running ? { done: state.done, total: state.total } : null, asked, askedSeries, aiAvailable: !!aiAvailable(),
      model: model ? modelName(model) : null, lastApplied: last && { id: last.id, at: last.finished_at, applied: last.applied, mode: last.mode },
      lastAsk: lastAsk && { at: lastAsk.finished_at || lastAsk.started_at, status: lastAsk.status, asked: lastAsk.asked, error: lastAsk.error } };
  }
  function setAuto(on) { setSetting(AUTO_KEY, on ? '1' : ''); return status(); }
  function stop() { state.stop = true; return { stopping: !!state.running }; }

  return { ask, plan, estimate, apply, undo, annotate, status, setAuto, stop, eventFacts, render, context, seriesSummary, seriesReady, decline, undecline, keep, lookUpTypes, typeRule, _state: state };
}

module.exports = { createShelfSorter, initShelfSorter, parseReply, SYSTEM, SCHEMA, TASK, AUTO_KEY, PROMPT_V, SCOPES };
