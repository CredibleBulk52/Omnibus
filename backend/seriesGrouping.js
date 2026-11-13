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
      action     TEXT NOT NULL,            -- reject | keep_visible
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
}

function createSeriesGrouping({ db, logger = null, now = Date.now, onChange = () => {} }) {
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

  // Events with their proposed and effective homes.
  function eventHomes(S, bookSeries, bookEvents) {
    if (!has('events') || !has('event_issues')) return [];
    const byName = new Map();
    for (const s of S.values()) { if (!s.hasJson) continue; const k = norm(s.name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(s); }
    const essential = new Map();   // event → Map(series → n)
    for (const [bookId, list] of bookEvents) for (const x of list) if (x.tier === 'essential') {
      const sid = bookSeries.get(bookId); if (!sid) continue;
      if (!essential.has(x.eventId)) essential.set(x.eventId, new Map());
      const m = essential.get(x.eventId); m.set(sid, (m.get(sid) || 0) + 1);
    }
    return db.prepare('SELECT id, name, year, initiative, home_series_id, home_confirmed FROM events WHERE COALESCE(draft, 0) = 0').all().map(e => {
      let proposed = null, how = 'none';
      const cores = byName.get(norm(e.name));
      const ey = parseInt(e.year, 10) || null;
      if (cores && cores.length) {
        proposed = cores.slice().sort((a, b) => (ey ? Math.abs((a.year || 0) - ey) - Math.abs((b.year || 0) - ey) : 0) || size(b) - size(a))[0].id;
        how = 'name';
      } else if (essential.has(e.id)) {
        proposed = [...essential.get(e.id)].sort((a, b) => b[1] - a[1])[0][0];
        how = 'essential';
      }
      const chosen = e.home_series_id && S.has(e.home_series_id) ? e.home_series_id : null;
      const home = chosen || (e.initiative ? null : proposed);
      return { id: e.id, name: e.name, year: e.year, initiative: !!e.initiative, confirmed: !!e.home_confirmed,
        proposed, how, chosen, home };
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
      for (const r of db.prepare(`SELECT ei.event_id, ei.scanned_book_id, ei.tier, ei.phase FROM event_issues ei
          JOIN events e ON e.id = ei.event_id WHERE ei.scanned_book_id IS NOT NULL AND COALESCE(e.draft, 0) = 0`).all()) {
        if (!bookEvents.has(r.scanned_book_id)) bookEvents.set(r.scanned_book_id, []);
        bookEvents.get(r.scanned_book_id).push({ eventId: r.event_id, tier: r.tier || '', phase: r.phase || '' });
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

  let running = false;
  function run(reason = 'manual') {
    if (running) return { skipped: true };
    running = true;
    try {
      const { links } = computeRuleLinks();
      const rejected = new Set(db.prepare("SELECT series_id || '|' || home_id AS k FROM series_link_overrides WHERE action = 'reject'").all().map(r => r.k));
      const previous = new Map(db.prepare("SELECT series_id || '|' || home_id AS k, created_at FROM series_links WHERE source = 'rule'").all().map(r => [r.k, r.created_at]));
      const manual = new Set(db.prepare("SELECT series_id || '|' || home_id AS k FROM series_links WHERE source = 'manual'").all().map(r => r.k));
      const at = now();
      let added = 0, kept = 0;
      const ins = db.prepare('INSERT INTO series_links (series_id, home_id, source, role, hidden, reason, created_at, event_id) VALUES (?, ?, \'rule\', ?, ?, ?, ?, ?)');
      db.exec('BEGIN');
      try {
        db.prepare("DELETE FROM series_links WHERE source = 'rule'").run();
        for (const l of links) {
          const k = `${l.seriesId}|${l.homeId}`;
          if (rejected.has(k) || manual.has(k)) continue;
          const was = previous.get(k);
          ins.run(l.seriesId, l.homeId, l.role, l.hidden, l.reason, was || at, l.eventId);
          if (was) kept++; else added++;
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      const removed = [...previous.keys()].filter(k => !links.some(l => `${l.seriesId}|${l.homeId}` === k)).length;
      if (added || removed) { logger && logger.info('grouping', `Rules (${reason}): ${added} new, ${removed} gone, ${kept} unchanged`); onChange(); }
      return { added, removed, kept };
    } finally { running = false; }
  }

  // seriesId → { homes: [{ id, name, role, source }], hidden } for the series list.
  function groupMap() {
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
    const keep = new Set(db.prepare("SELECT series_id FROM series_link_overrides WHERE action = 'keep_visible'").all().map(r => r.series_id));
    return db.prepare(`SELECT l.*, s.name, s.year, s.series_json, s.book_count FROM series_links l JOIN scanned_series s ON s.id = l.series_id
      WHERE l.home_id = ? ORDER BY s.year, s.name`).all(homeId).map(r => {
      const m = metaOf(r.series_json) || {};
      return { id: r.series_id, name: m.name || r.name, year: parseInt(m.year, 10) || r.year || null, issues: m.total_issues || r.book_count || 0,
        role: r.role, source: r.source, hidden: !!r.hidden && !keep.has(r.series_id), reason: r.reason };
    });
  }
  function homesOf(seriesId) {
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
    const l = db.prepare('SELECT source FROM series_links WHERE series_id = ? AND home_id = ?').get(seriesId, homeId);
    if (!l) return false;
    db.prepare('DELETE FROM series_links WHERE series_id = ? AND home_id = ?').run(seriesId, homeId);
    if (l.source === 'rule') db.prepare("INSERT OR REPLACE INTO series_link_overrides (series_id, home_id, action, created_at) VALUES (?, ?, 'reject', ?)").run(seriesId, homeId, now());
    onChange();
    return true;
  }
  function keepVisible(seriesId, on) {
    if (on) db.prepare("INSERT OR REPLACE INTO series_link_overrides (series_id, home_id, action, created_at) VALUES (?, '', 'keep_visible', ?)").run(seriesId, now());
    else db.prepare("DELETE FROM series_link_overrides WHERE series_id = ? AND action = 'keep_visible'").run(seriesId);
    onChange();
  }

  function setEvent(eventId, { homeSeriesId, initiative, confirm } = {}) {
    const e = db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
    if (!e) throw Object.assign(new Error('Event not found'), { status: 404 });
    if (homeSeriesId !== undefined) {
      if (homeSeriesId && !db.prepare('SELECT 1 FROM scanned_series WHERE id = ?').get(homeSeriesId)) throw Object.assign(new Error('Series not found'), { status: 404 });
      db.prepare('UPDATE events SET home_series_id = ?, home_confirmed = 1 WHERE id = ?').run(homeSeriesId || null, eventId);
    }
    if (initiative !== undefined) db.prepare('UPDATE events SET initiative = ? WHERE id = ?').run(initiative ? 1 : 0, eventId);
    if (confirm) db.prepare('UPDATE events SET home_confirmed = 1 WHERE id = ?').run(eventId);
    return run('event setting');
  }
  function confirmAll() {
    const n = db.prepare('UPDATE events SET home_confirmed = 1 WHERE COALESCE(home_confirmed, 0) = 0').run().changes;
    return { confirmed: n };
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
        return { id: e.id, name: e.name, year: e.year, initiative: e.initiative, confirmed: e.confirmed, how: e.how,
          proposed: e.proposed, chosen: e.chosen, home: e.home, homeName: nm(e.home), members,
          newMembers: members.filter(m => m.at >= recentSince).length };
      }).sort((a, b) => (a.confirmed - b.confirmed) || (b.members.length - a.members.length) || String(a.name).localeCompare(String(b.name))),
    };
  }

  return { run, groupMap, members, homesOf, link, unlink, keepVisible, setEvent, confirmAll, summary, computeRuleLinks };
}

module.exports = { createSeriesGrouping, initSeriesGrouping, norm, MAX_ISSUES };
