'use strict';
// ─── Series grouping: homes on a Specials shelf (2026-11-13) ───────
// claude/SERIES_GROUPING_PLAN.md and SERIES_GROUPING_DESIGN.md. Display only: no files move.
// A link puts a small series on a home series' Specials shelf; a hidden link also keeps it out
// of the series browser and smart comic boxes (the filter row shows it again).
//
// Stage 1 rules (automatic, source 'rule'):
//   • Every owned issue of a series with 12 issues or fewer (by series.json's Comic Vine count)
//     is in one Timeline event's reading order → linked to that event's home series.
//     Role by the majority of its issues there: tier 'aftermath' → epilogue; a prelude-style
//     phase name → prelude; tier 'essential' → core; otherwise → tie-in. Only tie-ins are hidden.
//   • Event home: a series named like the event (nearest the event's year), else the series with
//     the most essential issues in the event; or the admin's choice (events.home_series_id).
//     An event marked initiative has no home unless the admin chose one; its series stay visible.
//   • Not grouped: folders without a series.json; the home itself; landmark books (Elseworlds,
//     Black Label, Earth One, prestige, graphic novel, deluxe, or in an Essential / Top Shelf run)
//     are linked but never hidden; a series still publishing ("Continuing") is linked, not hidden.
// Manual links (source 'manual', "Put on a Specials shelf…") and overrides (reject, keep visible)
// always win; the rules never redo what the admin undid.
const MAX_ISSUES = 12;
const YEAR_WINDOW = 3;            // a home named like the event started within 3 years of it
const RECENT_DAYS = 7;
const LANDMARK = /elseworld|prestige|black label|graphic novel|deluxe|earth one/i;
const PRELUDE = /prelude|prologue|lead[- ]?in|road to|countdown/i;
const DEFAULT_INITIATIVES = ['DC Rebirth', 'Infinite Frontier', 'The New Golden Age', 'Dawn of DC'];

const norm = t => String(t || '').toLowerCase().replace(/&amp;/g, '&').replace(/&/g, ' and ').replace(/^the\s+/, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const metaOf = json => {
  try { const d = JSON.parse(json); const m = d && typeof d === 'object' && !Array.isArray(d) ? d.metadata : null; return m && typeof m === 'object' ? m : null; }
  catch { return null; }
};

function initSeriesGrouping(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS series_links (
      series_id  TEXT NOT NULL,
      home_id    TEXT NOT NULL,
      source     TEXT NOT NULL,            -- rule | manual
      role       TEXT NOT NULL,            -- tie-in | core | prelude | epilogue | initiative | special
      hidden     INTEGER NOT NULL DEFAULT 0,
      reason     TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (series_id, home_id));
    CREATE INDEX IF NOT EXISTS series_links_home ON series_links(home_id);
    CREATE TABLE IF NOT EXISTS series_link_overrides (
      series_id  TEXT NOT NULL,
      home_id    TEXT NOT NULL DEFAULT '', -- '' for keep_visible (the whole series)
      action     TEXT NOT NULL,            -- reject | keep_visible | user_keep (put back by the admin; the Shelf Sorter leaves it)
                                           -- reject/user_keep of an event shelf use home_id 'event:<id>', so they hold when the event's home changes
      created_at INTEGER NOT NULL,
      PRIMARY KEY (series_id, home_id, action));`);
  if (!db.prepare('PRAGMA table_info(series_links)').all().some(c => c.name === 'event_id')) db.exec('ALTER TABLE series_links ADD COLUMN event_id TEXT');
  const cols = new Set(db.prepare('PRAGMA table_info(events)').all().map(c => c.name));
  if (!cols.size) return;   // no events table (tests)
  if (!cols.has('initiative')) {
    db.exec('ALTER TABLE events ADD COLUMN initiative INTEGER NOT NULL DEFAULT 0');
    const set = db.prepare('UPDATE events SET initiative = 1 WHERE lower(name) = lower(?)');
    for (const n of DEFAULT_INITIATIVES) set.run(n);
  }
  if (!cols.has('home_series_id')) db.exec('ALTER TABLE events ADD COLUMN home_series_id TEXT');
  if (!cols.has('home_confirmed')) db.exec('ALTER TABLE events ADD COLUMN home_confirmed INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('home_source')) {
    // home_source: 'chosen' (Change home) or 'approved' (Looks right locks the rule's home).
    // Homes approved before locking existed are locked to the home their shelf has now.
    db.exec('ALTER TABLE events ADD COLUMN home_source TEXT');
    db.exec("UPDATE events SET home_source = 'chosen' WHERE home_series_id IS NOT NULL");
    db.exec(`UPDATE events SET home_source = 'approved', home_series_id = (SELECT l.home_id FROM series_links l WHERE l.event_id = events.id AND l.source = 'rule'
        GROUP BY l.home_id ORDER BY COUNT(*) DESC LIMIT 1)
      WHERE home_confirmed = 1 AND home_series_id IS NULL AND COALESCE(initiative, 0) = 0
        AND EXISTS (SELECT 1 FROM series_links l WHERE l.event_id = events.id AND l.source = 'rule')`);
  }
}

// enabled(): whether Specials shelves are on (setting shelves_enabled, 2026-11-14; off on a new install).
// When off, the rules do not run and nothing is grouped or hidden; the links stay stored for later.
function createSeriesGrouping({ db, logger = null, now = Date.now, onChange = () => {}, enabled = () => true }) {
  initSeriesGrouping(db);
  const has = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

  function loadSeries() {
    const S = new Map();
    for (const r of db.prepare('SELECT id, name, year, series_json, book_count FROM scanned_series').all()) {
      const m = metaOf(r.series_json);
      const total = m && Number.isInteger(m.total_issues) && m.total_issues > 0 ? m.total_issues : null;
      const year = parseInt(m && m.year, 10) || parseInt(r.year, 10) || null;
      S.set(r.id, { id: r.id, name: (m && m.name) || r.name || '', year, total, books: r.book_count || 0, hasJson: !!m,
        status: (m && m.status) || '', desc: String((m && m.description_text) || '').slice(0, 1000) });
    }
    return S;
  }
  const size = s => s.total || s.books;
  const label = s => s ? `${s.name}${s.year ? ` (${s.year})` : ''}` : null;

  // Series in an Essential reading list or a Top Shelf run: curated, so never hidden.
  function curatedSeries() {
    const out = new Set();
    const add = sql => { try { for (const r of db.prepare(sql).all()) if (r.id) out.add(r.id); } catch {} };
    add(`SELECT DISTINCT COALESCE(i.scanned_series_id, b.series_id) AS id FROM list_issues i
      JOIN reading_lists l ON l.id = i.owner_id LEFT JOIN scanned_books b ON b.id = i.scanned_book_id
      WHERE i.owner_kind = 'list' AND l.visibility = 'essential'`);
    add(`SELECT DISTINCT e.scanned_series_id AS id FROM reading_list_entries e JOIN reading_lists l ON l.id = e.list_id WHERE l.visibility = 'essential'`);
    add('SELECT DISTINCT b.series_id AS id FROM canon_run_issues r JOIN scanned_books b ON b.id = r.scanned_book_id');
    return out;
  }

  // Events with their proposed and effective homes (2026-11-13 rules):
  //   1. name   a series named like the event, started within YEAR_WINDOW years of it (Age of
  //             Apocalypse (2015) is not the home of the 1995 event).
  //   2. title  a series whose title contains the event's name, with main-story issues that are
  //             not lead-ins; earliest in the reading order (X-Men: Age of Revelation Overture,
  //             Batman: No Man's Land).
  //   3. most   the series with the most main-story issues; ties go to the one read first.
  // A home the admin chose or approved (events.home_series_id) is never moved by the rules.
  function eventHomes(S, bookSeries, bookEvents) {
    if (!has('events') || !has('event_issues')) return [];
    const byName = new Map();
    for (const s of S.values()) { if (!s.hasJson) continue; const k = norm(s.name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(s); }
    const essential = new Map();   // event → Map(series → { n, first, lead })
    for (const [bookId, list] of bookEvents) for (const x of list) if (x.tier === 'essential') {
      const sid = bookSeries.get(bookId); if (!sid) continue;
      if (!essential.has(x.eventId)) essential.set(x.eventId, new Map());
      const m = essential.get(x.eventId);
      const c = m.get(sid) || { n: 0, first: Infinity, lead: 0 };
      c.n++; c.first = Math.min(c.first, x.order ?? Infinity); if (PRELUDE.test(x.phase)) c.lead++;
      m.set(sid, c);
    }
    const near = (s, ey) => !ey || !s.year || Math.abs(s.year - ey) <= YEAR_WINDOW;
    return db.prepare('SELECT id, name, year, initiative, home_series_id, home_confirmed, home_source FROM events WHERE COALESCE(draft, 0) = 0').all().map(e => {
      let proposed = null, how = 'none', why = 'No series in the library fits';
      const ey = parseInt(e.year, 10) || null;
      const en = norm(e.name);
      const cores = (byName.get(en) || []).filter(s => near(s, ey));
      const ess = essential.get(e.id);
      if (cores.length) {
        const s = cores.slice().sort((a, b) => (ey ? Math.abs((a.year || ey) - ey) - Math.abs((b.year || ey) - ey) : 0) || size(b) - size(a))[0];
        proposed = s.id; how = 'name'; why = `Named like the event${s.year ? ` · ${s.year}` : ''}`;
      } else if (ess) {
        const titled = en ? [...ess].filter(([sid, c]) => {
          const s = S.get(sid);
          return s && c.n > c.lead && near(s, ey) && ` ${norm(s.name)} `.includes(` ${en} `);
        }) : [];
        if (titled.length) {
          const [sid] = titled.sort((a, b) => a[1].first - b[1].first || b[1].n - a[1].n)[0];
          proposed = sid; how = 'title'; why = 'Its title has the event\'s name and it starts the main story';
        } else {
          const [sid, c] = [...ess].sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first)[0];
          const tied = [...ess.values()].filter(x => x.n === c.n).length;
          proposed = sid; how = 'essential';
          why = tied > 1 ? `Most main-story issues (${c.n}, tied with ${tied - 1} more; read first)` : `Most main-story issues (${c.n})`;
        }
      }
      const chosen = e.home_series_id && S.has(e.home_series_id) ? e.home_series_id : null;
      const home = chosen || (e.initiative ? null : proposed);
      if (e.initiative && !chosen) why = 'Initiative: its series stay on their own';
      else if (chosen && chosen !== proposed) why = e.home_source === 'approved' ? 'Approved by you' : e.home_source === 'ai' ? 'Chosen by the AI' : 'Chosen by you';
      else if (chosen) why = `${why} · ${e.home_source === 'ai' ? 'approved by the AI' : 'approved'}`;
      return { id: e.id, name: e.name, year: e.year, initiative: !!e.initiative, confirmed: !!e.home_confirmed,
        proposed, how, why, chosen, source: chosen ? (e.home_source || 'chosen') : null, home };
    });
  }

  function computeRuleLinks() {
    const S = loadSeries();
    const books = new Map(), bookSeries = new Map();
    for (const b of db.prepare('SELECT id, series_id FROM scanned_books WHERE COALESCE(is_special, 0) = 0').all()) {
      if (!books.has(b.series_id)) books.set(b.series_id, []);
      books.get(b.series_id).push(b.id); bookSeries.set(b.id, b.series_id);
    }
    const bookEvents = new Map();
    if (has('event_issues') && has('events')) {
      for (const r of db.prepare(`SELECT ei.event_id, ei.scanned_book_id, ei.tier, ei.phase, ei.sort_order FROM event_issues ei
          JOIN events e ON e.id = ei.event_id WHERE ei.scanned_book_id IS NOT NULL AND COALESCE(e.draft, 0) = 0`).all()) {
        if (!bookEvents.has(r.scanned_book_id)) bookEvents.set(r.scanned_book_id, []);
        bookEvents.get(r.scanned_book_id).push({ eventId: r.event_id, tier: r.tier || '', phase: r.phase || '', order: r.sort_order });
      }
    }
    const events = eventHomes(S, bookSeries, bookEvents);
    const evById = new Map(events.map(e => [e.id, e]));
    const curated = curatedSeries();
    const links = [];
    for (const s of S.values()) {
      if (!s.hasJson || !(size(s) > 0 && size(s) <= MAX_ISSUES)) continue;
      const bl = books.get(s.id) || [];
      if (!bl.length) continue;
      const count = new Map(), roles = new Map();
      for (const b of bl) for (const x of bookEvents.get(b) || []) {
        count.set(x.eventId, (count.get(x.eventId) || 0) + 1);
        const role = x.tier === 'aftermath' ? 'epilogue' : PRELUDE.test(x.phase) ? 'prelude' : x.tier === 'essential' ? 'core' : 'tie-in';
        if (!roles.has(x.eventId)) roles.set(x.eventId, new Map());
        const r = roles.get(x.eventId); r.set(role, (r.get(role) || 0) + 1);
      }
      if (!count.size) continue;
      const [eventId, n] = [...count].sort((a, b) => b[1] - a[1])[0];
      const e = evById.get(eventId);
      if (!e || n < bl.length || !e.home || e.home === s.id || norm(s.name) === norm(e.name)) continue;
      const role = e.initiative ? 'initiative' : [...roles.get(eventId)].sort((a, b) => b[1] - a[1])[0][0];
      const landmark = LANDMARK.test(`${s.name} ${s.desc}`) || curated.has(s.id);
      const hidden = role === 'tie-in' && !landmark && s.status !== 'Continuing';
      const why = `${e.name}${landmark && role === 'tie-in' ? ' (landmark: kept visible)' : ''}${s.status === 'Continuing' && role === 'tie-in' ? ' (still publishing: kept visible)' : ''}`;
      links.push({ seriesId: s.id, homeId: e.home, eventId: e.id, role, hidden: hidden ? 1 : 0, reason: why });
    }
    return { links, events, S };
  }

  // Specials added with "Special of …" in the download manager (2026-11-14): their own folder, put on
  // the chosen series' shelf (monitored_series.shelf_home_id) once the folder has been scanned.
  // Source 'monitor': hidden like a tie-in; a removal is remembered like the rules' and the AI's.
  function linkMonitoredSpecials() {
    if (!has('monitored_series')) return 0;
    let rows;
    try {
      rows = db.prepare(`SELECT ss.id AS series_id, ms.shelf_home_id AS home_id, h.name AS home_name FROM monitored_series ms
        JOIN scanned_series ss ON ss.path = ms.directory JOIN scanned_series h ON h.id = ms.shelf_home_id
        WHERE ms.shelf_home_id IS NOT NULL AND ss.id <> ms.shelf_home_id`).all();
    } catch { return 0; }   // no shelf_home_id column yet
    const exists = db.prepare('SELECT 1 FROM series_links WHERE series_id = ? AND home_id = ?');
    const rejected = db.prepare("SELECT 1 FROM series_link_overrides WHERE series_id = ? AND home_id = ? AND action = 'reject'");
    const ins = db.prepare(`INSERT INTO series_links (series_id, home_id, source, role, hidden, reason, created_at) VALUES (?, ?, 'monitor', 'special', 1, ?, ?)
      ON CONFLICT(series_id, home_id) DO NOTHING`);
    let n = 0;
    for (const r of rows) {
      if (exists.get(r.series_id, r.home_id) || rejected.get(r.series_id, r.home_id)) continue;
      n += ins.run(r.series_id, r.home_id, `Special of ${r.home_name} (added in the download manager)`, now()).changes;
    }
    if (n) logger && logger.info('grouping', `${n} special${n === 1 ? '' : 's'} put on their series' shelf`);
    return n;
  }

  let running = false;
  function run(reason = 'manual') {
    if (!enabled()) return { skipped: true, off: true };
    if (running) return { skipped: true };
    running = true;
    try {
      const monitorAdded = linkMonitoredSpecials();
      const { links } = computeRuleLinks();
      const rejected = new Set(db.prepare("SELECT series_id || '|' || home_id AS k FROM series_link_overrides WHERE action = 'reject'").all().map(r => r.k));
      const previous = new Map(db.prepare("SELECT series_id || '|' || home_id AS k, created_at FROM series_links WHERE source = 'rule'").all().map(r => [r.k, r.created_at]));
      // Links made by hand or by the Shelf Sorter (source 'ai') are not the rules' to replace.
      const manual = new Set(db.prepare("SELECT series_id || '|' || home_id AS k FROM series_links WHERE source <> 'rule'").all().map(r => r.k));
      const at = now();
      let added = 0, kept = 0;
      const ins = db.prepare('INSERT INTO series_links (series_id, home_id, source, role, hidden, reason, created_at, event_id) VALUES (?, ?, \'rule\', ?, ?, ?, ?, ?)');
      db.exec('BEGIN');
      try {
        db.prepare("DELETE FROM series_links WHERE source = 'rule'").run();
        for (const l of links) {
          const k = `${l.seriesId}|${l.homeId}`;
          if (rejected.has(k) || rejected.has(`${l.seriesId}|event:${l.eventId}`) || manual.has(k)) continue;
          const was = previous.get(k);
          ins.run(l.seriesId, l.homeId, l.role, l.hidden, l.reason, was || at, l.eventId);
          if (was) kept++; else added++;
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      const removed = [...previous.keys()].filter(k => !links.some(l => `${l.seriesId}|${l.homeId}` === k)).length;
      if (added || removed) { logger && logger.info('grouping', `Rules (${reason}): ${added} new, ${removed} gone, ${kept} unchanged`); onChange(); }
      else if (monitorAdded) onChange();
      return { added, removed, kept, specials: monitorAdded };
    } finally { running = false; }
  }

  // seriesId → { homes: [{ id, name, role, source }], hidden } for the series list.
  function groupMap() {
    if (!enabled()) return new Map();
    const names = new Map();
    for (const r of db.prepare('SELECT id, name, year, series_json FROM scanned_series').all()) {
      const m = metaOf(r.series_json); const y = parseInt(m && m.year, 10) || parseInt(r.year, 10) || null;
      names.set(r.id, `${(m && m.name) || r.name}${y ? ` (${y})` : ''}`);
    }
    const keep = new Set(db.prepare("SELECT series_id FROM series_link_overrides WHERE action = 'keep_visible'").all().map(r => r.series_id));
    const out = new Map();
    for (const l of db.prepare('SELECT * FROM series_links ORDER BY source DESC, created_at').all()) {
      if (!names.has(l.home_id)) continue;
      if (!out.has(l.series_id)) out.set(l.series_id, { homes: [], hidden: false });
      const g = out.get(l.series_id);
      g.homes.push({ id: l.home_id, name: names.get(l.home_id), role: l.role, source: l.source });
      if (l.hidden && !keep.has(l.series_id)) g.hidden = true;
    }
    for (const [id, g] of out) { g.homeName = g.homes[0].name; g.keepVisible = keep.has(id); }
    return out;
  }

  // The home's shelf: series linked to it.
  function members(homeId) {
    if (!enabled()) return [];
    const keep = new Set(db.prepare("SELECT series_id FROM series_link_overrides WHERE action = 'keep_visible'").all().map(r => r.series_id));
    return db.prepare(`SELECT l.*, s.name, s.year, s.series_json, s.book_count FROM series_links l JOIN scanned_series s ON s.id = l.series_id
      WHERE l.home_id = ? ORDER BY s.year, s.name`).all(homeId).map(r => {
      const m = metaOf(r.series_json) || {};
      return { id: r.series_id, name: m.name || r.name, year: parseInt(m.year, 10) || r.year || null, issues: m.total_issues || r.book_count || 0,
        role: r.role, source: r.source, hidden: !!r.hidden && !keep.has(r.series_id), reason: r.reason };
    });
  }
  function homesOf(seriesId) {
    if (!enabled()) return [];
    const g = groupMap().get(seriesId);
    return g ? g.homes : [];
  }

  function link(seriesId, homeId) {
    if (!seriesId || !homeId || seriesId === homeId) throw Object.assign(new Error('Choose a different series as the home'), { status: 400 });
    const exists = db.prepare('SELECT 1 FROM scanned_series WHERE id = ?');
    if (!exists.get(seriesId) || !exists.get(homeId)) throw Object.assign(new Error('Series not found'), { status: 404 });
    if (db.prepare('SELECT 1 FROM series_links WHERE series_id = ? AND home_id = ?').get(homeId, seriesId))
      throw Object.assign(new Error('That series is already on this one\'s shelf'), { status: 400 });
    db.prepare("DELETE FROM series_link_overrides WHERE series_id = ? AND home_id = ? AND action = 'reject'").run(seriesId, homeId);
    db.prepare(`INSERT INTO series_links (series_id, home_id, source, role, hidden, reason, created_at) VALUES (?, ?, 'manual', 'special', 1, 'added by hand', ?)
      ON CONFLICT(series_id, home_id) DO UPDATE SET source = 'manual', role = 'special', hidden = 1, reason = 'added by hand'`).run(seriesId, homeId, now());
    onChange();
  }
  // Remove from a shelf. A rule's link is remembered as rejected so the rules do not bring it back.
  function unlink(seriesId, homeId) {
    const l = db.prepare('SELECT source, event_id FROM series_links WHERE series_id = ? AND home_id = ?').get(seriesId, homeId);
    if (!l) return false;
    db.prepare('DELETE FROM series_links WHERE series_id = ? AND home_id = ?').run(seriesId, homeId);
    // A series taken off an event's shelf stays off that event's shelf, whichever series is its home.
    if (l.source === 'rule' || l.source === 'ai' || l.source === 'monitor') db.prepare("INSERT OR REPLACE INTO series_link_overrides (series_id, home_id, action, created_at) VALUES (?, ?, 'reject', ?)")
      .run(seriesId, l.event_id ? `event:${l.event_id}` : homeId, now());
    db.prepare("DELETE FROM series_link_overrides WHERE series_id = ? AND action = 'user_keep' AND home_id IN (?, ?)").run(seriesId, homeId, `event:${l.event_id || ''}`);
    // A special made with "Special of" / "Make Special of" stops being one when taken off its shelf.
    if (has('monitored_series')) {
      try { db.prepare('UPDATE monitored_series SET shelf_home_id = NULL WHERE shelf_home_id = ? AND directory = (SELECT path FROM scanned_series WHERE id = ?)').run(homeId, seriesId); } catch {}
    }
    onChange();
    return l.source;   // 'rule' | 'ai' | 'monitor' | 'manual' (Undo: restore a rule link, link a manual one again)
  }

  // ── Undo (2026-11-13) ──
  // Series the admin took off a rule's shelf, newest first. Restore lets the rules put them back.
  // homeId is the removal's key (a home, or 'event:<id>'); shelfHomeId the shelf it goes back to.
  function removed() {
    const S = loadSeries();
    const ev = new Map();
    if (has('events')) { try { for (const e of computeRuleLinks().events) ev.set(e.id, e); } catch {} }
    return db.prepare("SELECT series_id, home_id, created_at FROM series_link_overrides WHERE action = 'reject' ORDER BY created_at DESC").all()
      .filter(r => S.has(r.series_id))
      .map(r => {
        const e = r.home_id.startsWith('event:') ? ev.get(r.home_id.slice(6)) : null;
        const shelfHomeId = e ? e.home : r.home_id;
        return { seriesId: r.series_id, name: label(S.get(r.series_id)), homeId: r.home_id, eventId: e ? e.id : null, shelfHomeId,
          homeName: label(S.get(shelfHomeId)) || (e ? `the ${e.name} shelf` : 'a series no longer in the library'), at: r.created_at };
      });
  }
  function restore(items = []) {
    // items: [{ seriesId, homeId, eventId? }]; homeId may be a removal key ('event:<id>').
    const del = db.prepare("DELETE FROM series_link_overrides WHERE series_id = ? AND home_id IN (?, ?) AND action = 'reject'");
    // user_keep: the admin put it back, so the Shelf Sorter never takes it off again.
    const keep = db.prepare("INSERT OR REPLACE INTO series_link_overrides (series_id, home_id, action, created_at) VALUES (?, ?, 'user_keep', ?)");
    let n = 0, homeEvents = null;
    const homeRestores = [];
    // Without an event id, a removal from a home's shelf may be keyed to an event that home holds.
    const eventsOfHome = home => {
      if (!homeEvents) {
        homeEvents = new Map();
        try { for (const e of computeRuleLinks().events) if (e.home) { if (!homeEvents.has(e.home)) homeEvents.set(e.home, []); homeEvents.get(e.home).push(`event:${e.id}`); } } catch {}
      }
      return homeEvents.get(home) || [];
    };
    for (const it of items) {
      if (!it || !it.seriesId || !it.homeId) continue;
      const sid = String(it.seriesId), home = String(it.homeId);
      const events = it.eventId ? [`event:${it.eventId}`] : home.startsWith('event:') ? [home] : eventsOfHome(home);
      let found = null;
      for (const key of [home, ...events]) if (del.run(sid, key, key).changes) { n++; found = found || key; }
      keep.run(sid, found || events[0] || home, now());
      if (found && !found.startsWith('event:')) homeRestores.push([sid, found]);
    }
    const r = run('restore');
    // A series the rules do not shelve (put there by the Shelf Sorter or by hand) goes back as a
    // hand-made link, so Restore always puts it back.
    const exists = db.prepare('SELECT 1 FROM series_links WHERE series_id = ? AND home_id = ?');
    const relink = db.prepare(`INSERT INTO series_links (series_id, home_id, source, role, hidden, reason, created_at) VALUES (?, ?, 'manual', 'special', 1, 'put back by hand', ?)
      ON CONFLICT(series_id, home_id) DO NOTHING`);
    for (const [sid, home] of homeRestores) if (!exists.get(sid, home) && db.prepare('SELECT 1 FROM scanned_series WHERE id = ?').get(home)) relink.run(sid, home, now());
    if (!(r.added || r.removed)) onChange();
    return { restored: n };
  }
  // Take every series the rules put on an event's shelf off it (they go to Removed).
  function emptyEvent(eventId) {
    const rows = db.prepare("SELECT series_id, home_id FROM series_links WHERE event_id = ? AND source = 'rule'").all(eventId);
    const out = [];
    for (const r of rows) if (unlink(r.series_id, r.home_id)) out.push({ seriesId: r.series_id, homeId: r.home_id, eventId });
    return { removed: out };
  }
  function keepVisible(seriesId, on) {
    if (on) db.prepare("INSERT OR REPLACE INTO series_link_overrides (series_id, home_id, action, created_at) VALUES (?, '', 'keep_visible', ?)").run(seriesId, now());
    else db.prepare("DELETE FROM series_link_overrides WHERE series_id = ? AND action = 'keep_visible'").run(seriesId);
    onChange();
  }

  const eventState = id => {
    const r = db.prepare('SELECT id, home_series_id, home_confirmed, home_source, initiative FROM events WHERE id = ?').get(id);
    return r && { id: r.id, chosen: r.home_series_id || null, confirmed: !!r.home_confirmed, source: r.home_source || null, initiative: !!r.initiative };
  };
  let writeEventStmt = null;   // prepared on first use: a library without a Timeline has no events table
  const writeEvent = { run: (...a) => (writeEventStmt || (writeEventStmt = db.prepare('UPDATE events SET home_series_id = ?, home_confirmed = ?, home_source = ?, initiative = ? WHERE id = ?'))).run(...a) };
  const putState = st => writeEvent.run(st.chosen || null, st.confirmed ? 1 : 0, st.chosen ? (st.source || 'chosen') : null, st.initiative ? 1 : 0, st.id);

  // One event's home. Every call returns `previous`, the state before it, for Undo.
  //   confirm     Looks right: locks the rule's current home so later rule changes never move it.
  //   homeSeriesId  Change home (null: back to the rule's guess, unconfirmed).
  //   reset       Not right: back to the rule's guess, waiting in To check.
  //   restore     Undo: put back a previous state exactly.
  //   by          who decided: 'ai' for the Shelf Sorter (shelfSorter.js); otherwise the admin.
  function setEvent(eventId, { homeSeriesId, initiative, confirm, reset, restore: back, by = null } = {}, { rerun = true } = {}) {
    const previous = eventState(eventId);
    if (!previous) throw Object.assign(new Error('Event not found'), { status: 404 });
    const next = { ...previous };
    if (back) Object.assign(next, { chosen: back.chosen || null, confirmed: !!back.confirmed, source: back.source || null, initiative: !!back.initiative });
    if (reset) Object.assign(next, { chosen: null, confirmed: false, source: null });
    if (homeSeriesId !== undefined) {
      if (homeSeriesId && !db.prepare('SELECT 1 FROM scanned_series WHERE id = ?').get(homeSeriesId)) throw Object.assign(new Error('Series not found'), { status: 404 });
      Object.assign(next, homeSeriesId ? { chosen: homeSeriesId, confirmed: true, source: by || 'chosen' } : { chosen: null, confirmed: false, source: null });
    }
    if (initiative !== undefined) next.initiative = !!initiative;
    if (confirm) {
      next.confirmed = true;
      if (!next.chosen && !next.initiative) {
        const e = computeRuleLinks().events.find(x => x.id === eventId);
        if (e && e.proposed) Object.assign(next, { chosen: e.proposed, source: by || 'approved' });
      }
    }
    putState(next);
    if (!rerun) return { previous };
    return { ...run('event setting'), previous };
  }
  // "All look right": approve and lock every event still waiting that has a shelf.
  function confirmAll() {
    const previous = [];
    // Only events with something on their shelf: an empty shelf needs no home (2026-11-13).
    const withShelf = new Set(db.prepare("SELECT DISTINCT event_id FROM series_links WHERE event_id IS NOT NULL").all().map(r => r.event_id));
    const events = computeRuleLinks().events.filter(e => !e.confirmed && withShelf.has(e.id));
    db.exec('BEGIN');
    try {
      for (const e of events) {
        const st = eventState(e.id); previous.push(st);
        putState(!st.chosen && !st.initiative && e.proposed ? { ...st, confirmed: true, chosen: e.proposed, source: 'approved' } : { ...st, confirmed: true });
      }
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    run('confirm all');
    return { confirmed: events.length, previous };
  }
  // Undo of "All look right".
  function restoreEvents(states = []) {
    for (const st of states) if (st && st.id && eventState(st.id)) putState({ id: st.id, chosen: st.chosen, confirmed: st.confirmed, source: st.source, initiative: st.initiative });
    return run('undo');
  }

  // Library page: counts and every event with its home and the series on its shelf.
  function summary() {
    const { events, S } = computeRuleLinks();
    const nm = id => label(S.get(id));
    const counts = db.prepare('SELECT source, SUM(hidden) AS hidden, COUNT(*) AS n FROM series_links GROUP BY source').all();
    const keep = new Set(db.prepare("SELECT series_id FROM series_link_overrides WHERE action = 'keep_visible'").all().map(r => r.series_id));
    const byEvent = new Map();
    for (const l of db.prepare("SELECT series_id, home_id, event_id, role, hidden, created_at FROM series_links WHERE source = 'rule' AND event_id IS NOT NULL").all()) {
      if (!byEvent.has(l.event_id)) byEvent.set(l.event_id, []);
      byEvent.get(l.event_id).push({ id: l.series_id, name: nm(l.series_id), role: l.role, hidden: !!l.hidden && !keep.has(l.series_id), at: l.created_at });
    }
    const recentSince = now() - RECENT_DAYS * 864e5;
    return {
      counts: Object.fromEntries(counts.map(c => [c.source, { links: c.n, hidden: c.hidden || 0 }])),
      events: events.map(e => {
        const members = (byEvent.get(e.id) || []).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        // An approved home the rules would now place elsewhere: shown as a one-line hint.
        const suggest = (e.source === 'approved' || e.source === 'ai') && e.proposed && e.proposed !== e.home ? { id: e.proposed, name: nm(e.proposed) } : null;
        return { id: e.id, name: e.name, year: e.year, initiative: e.initiative, confirmed: e.confirmed, how: e.how, why: e.why,
          proposed: e.proposed, proposedName: nm(e.proposed), chosen: e.chosen, source: e.source, suggest, home: e.home, homeName: nm(e.home), members,
          newMembers: members.filter(m => m.at >= recentSince).length };
      }).sort((a, b) => (a.confirmed - b.confirmed) || (b.members.length - a.members.length) || String(a.name).localeCompare(String(b.name))),
    };
  }

  return { run, groupMap, members, homesOf, link, unlink, keepVisible, setEvent, confirmAll, restoreEvents, removed, restore, emptyEvent, summary, computeRuleLinks,
    curatedSeries, changed: () => onChange(), enabled };
}

module.exports = { createSeriesGrouping, initSeriesGrouping, norm, MAX_ISSUES, YEAR_WINDOW };
