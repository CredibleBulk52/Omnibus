'use strict';
// ─── Achievements (2026-11-10; claude/ACHIEVEMENTS_DESIGN.md) ─────────────────
// Badges for reading, shown on each reader's Achievements page (account menu) with a
// household leaderboard (a simple count, all-time) and a toast when one is earned.
// Everything starts at zero at launch (user): reading counts from the reading log this
// module keeps (issues read to the last page in the reader; "mark as read" never counts),
// and boxes, lists, follows, pulls, requests, reports and questions from after launch.
//
// The list is defined in code (DEFS below, plus one per library and one per genre). Each
// achievement reports progress { have, need } from a reader's facts and is earned when
// have >= need. Hidden ones (the fun one-offs) show "?" and a hint until earned.
//
// Tables: reading_log (one row per issue finished: local day and hour from the reader's
// clock), user_achievements (earned, seen), achievement_completions (events finished, for
// "first in the household"), achievement_baseline (pulls that existed at launch).

const { GENRES } = require('./genres');
const { STORIES } = require('./achievementStories');

const NEEDS = ['app', 'db', 'requireAuth', 'logger', 'orderedBooks'];
const DAY_MS = 864e5;

module.exports.createAchievements = function createAchievements(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createAchievements: missing ${missing.join(', ')}`);
  const { app, db, requireAuth, logger, orderedBooks } = deps;
  const now = deps.now || (() => Date.now());

  db.exec(`
    CREATE TABLE IF NOT EXISTS achievement_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS reading_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, book_id TEXT NOT NULL,
      finished_at TEXT NOT NULL, local_day TEXT NOT NULL, local_hour INTEGER, pages INTEGER, context TEXT);
    CREATE INDEX IF NOT EXISTS idx_reading_log_user ON reading_log(user_id, local_day);
    CREATE INDEX IF NOT EXISTS idx_reading_log_book ON reading_log(book_id, local_day);
    CREATE TABLE IF NOT EXISTS user_achievements (user_id TEXT NOT NULL, achievement_id TEXT NOT NULL, earned_at TEXT NOT NULL,
      seen INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, achievement_id));
    CREATE TABLE IF NOT EXISTS achievement_completions (user_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY (user_id, kind, ref_id));
    CREATE TABLE IF NOT EXISTS achievement_baseline (user_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL, PRIMARY KEY (user_id, kind, ref_id));
    CREATE TABLE IF NOT EXISTS achievement_counts (user_id TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, key));`);
  // seconds: time from opening the issue on its first page to its last page (the reader sends it; null otherwise).
  try { db.prepare('ALTER TABLE reading_log ADD COLUMN seconds INTEGER').run(); } catch {}

  const hasTable = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  const hasColumn = (table, col) => hasTable(table) && db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  const sqlTime = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);   // as datetime('now')

  // Launch: the moment counting starts. Pulls that already exist are set aside.
  let launchedAt = db.prepare("SELECT value FROM achievement_meta WHERE key = 'launched_at'").get()?.value;
  if (!launchedAt) {
    launchedAt = sqlTime(now());
    db.transaction(() => {
      db.prepare("INSERT INTO achievement_meta (key, value) VALUES ('launched_at', ?)").run(launchedAt);
      if (hasTable('collection_series') && hasTable('collections')) {
        db.prepare(`INSERT OR IGNORE INTO achievement_baseline (user_id, kind, ref_id)
          SELECT c.owner_id, 'pull', cs.series_id FROM collection_series cs JOIN collections c ON c.id = cs.collection_id
          WHERE c.purpose = 'pull' AND c.owner_id IS NOT NULL`).run();
      }
    })();
    logger.info('achievements', 'Achievements started: counting from now', { launchedAt });
  }

  // ── The reading log ─────────────────────────────────────────────
  // tz: the reader's getTimezoneOffset() (minutes, UTC minus local), for local day and hour.
  function recordFinish(userId, bookId, { tz = 0, pages = null, context = null, seconds = null } = {}) {
    if (!userId || !bookId || !db.prepare('SELECT 1 FROM scanned_books WHERE id = ?').get(String(bookId))) return [];
    const t = now();
    const off = Number.isFinite(Number(tz)) ? Math.max(-840, Math.min(840, Number(tz))) : 0;
    const local = new Date(t - off * 60000).toISOString();
    const recent = db.prepare(`SELECT 1 FROM reading_log WHERE user_id = ? AND book_id = ? AND finished_at >= ?`)
      .get(String(userId), String(bookId), sqlTime(t - 6 * 3600 * 1000));
    if (recent) return [];   // the same finish sent twice (last page reached again)
    const secs = seconds === null || seconds === undefined || seconds === '' ? null : Number(seconds);
    db.prepare(`INSERT INTO reading_log (user_id, book_id, finished_at, local_day, local_hour, pages, context, seconds) VALUES (?,?,?,?,?,?,?,?)`)
      .run(String(userId), String(bookId), sqlTime(t), local.slice(0, 10), Number(local.slice(11, 13)),
        Number.isFinite(Number(pages)) && Number(pages) > 0 ? Math.round(Number(pages)) : null, context ? String(context).slice(0, 200) : null,
        Number.isFinite(secs) && secs >= 0 ? Math.min(Math.round(secs), 86400) : null);
    cache.delete(String(userId));
    return evaluate(userId);
  }

  // Small per-reader counters for things the app does not otherwise keep (theme changes).
  function bump(userId, key) {
    if (!userId || !key) return;
    db.prepare(`INSERT INTO achievement_counts (user_id, key, n) VALUES (?, ?, 1) ON CONFLICT(user_id, key) DO UPDATE SET n = n + 1`).run(String(userId), String(key));
    cache.delete(String(userId));
  }
  const counted = (userId, key) => db.prepare('SELECT n FROM achievement_counts WHERE user_id = ? AND key = ?').get(String(userId), String(key))?.n || 0;

  // ── Facts about one reader (memoised pieces, built on demand) ───
  const yearOf = ci => { const m = /<Year>\s*(\d{4})\s*<\/Year>/i.exec(ci || ''); return m ? Number(m[1]) : null; };
  const pageCountOf = ci => { const m = /<PageCount>\s*(\d+)\s*<\/PageCount>/i.exec(ci || ''); return m ? Number(m[1]) : null; };
  const isRtl = ci => /<Manga>\s*YesAndRightToLeft\s*<\/Manga>/i.test(ci || '');
  const norm = n => String(n ?? '').trim().replace(/^#/, '');
  const isMarvel = name => /\bmarvel\b/i.test(name || '');
  const isDC = name => /^dc\b|\bdc comics\b/i.test(name || '');
  const lazy = fn => { let v, done = false; return () => (done ? v : (done = true, v = fn())); };

  function facts(userId) {
    userId = String(userId);
    const F = { userId };
    F.log = db.prepare('SELECT book_id, local_day, local_hour, pages, finished_at, seconds FROM reading_log WHERE user_id = ? ORDER BY id').all(userId);
    F.read = new Set(F.log.map(r => String(r.book_id)));
    F.firstDay = new Map();   // book → first local day read
    for (const r of F.log) if (!F.firstDay.has(String(r.book_id))) F.firstDay.set(String(r.book_id), r.local_day);
    const ids = JSON.stringify([...F.read]);
    F.books = new Map(db.prepare(`SELECT sb.id, sb.series_id, sb.issue_number, sb.filename, COALESCE(sb.is_special, 0) AS is_special, sb.comicinfo,
        sb.monitored_issue_id, sb.cv_issue_id, ss.library_id, ss.name AS series_name, ci.volume_year
      FROM scanned_books sb JOIN scanned_series ss ON ss.id = sb.series_id LEFT JOIN book_ci_index ci ON ci.book_id = sb.id
      WHERE sb.id IN (SELECT value FROM json_each(?))`).all(ids).map(b => [String(b.id), b]));
    F.libraries = lazy(() => {
      const rows = db.prepare(`SELECT l.id, l.name, l.color, (SELECT COUNT(*) FROM scanned_series s WHERE s.library_id = l.id) AS series FROM libraries l`).all();
      return new Map(rows.map(r => [String(r.id), r]));
    });
    F.seriesInfo = lazy(() => {
      const sids = [...new Set([...F.books.values()].map(b => String(b.series_id)))];
      const out = new Map();
      for (const s of db.prepare(`SELECT ss.id, ss.name, ss.series_json, ss.library_id, ss.monitored_series_id,
          (SELECT series_type FROM monitored_series m WHERE m.id = ss.monitored_series_id) AS series_type
        FROM scanned_series ss WHERE ss.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(sids))) {
        let m = {}; try { const j = JSON.parse(s.series_json || '{}'); m = j.metadata || j; } catch {}
        out.set(String(s.id), { ...s, genres: Array.isArray(m.genres) ? m.genres : [], comicid: m.comicid ? String(m.comicid) : (s.monitored_series_id ? String(s.monitored_series_id) : null) });
      }
      return out;
    });
    F.isRegular = b => !b.is_special && !/annual/i.test(b.filename || '');
    // Series finished: a series of 4+ regular issues (not specials or annuals), every one read.
    F.finishedSeries = lazy(() => {
      const sids = [...new Set([...F.books.values()].map(b => String(b.series_id)))];
      const out = [];
      const stmt = db.prepare('SELECT id, filename, COALESCE(is_special, 0) AS is_special FROM scanned_books WHERE series_id = ?');
      for (const sid of sids) {
        const regular = stmt.all(sid).filter(F.isRegular);
        if (regular.length >= 4 && regular.every(b => F.read.has(String(b.id)))) out.push({ id: sid, size: regular.length, days: regular.map(b => F.firstDay.get(String(b.id))) });
      }
      return out;
    });
    // A curated path is finished when at least 3 in 4 of its issues are in the library and every one of those is read.
    const done = (matched, total) => matched.length > 0 && matched.length >= Math.ceil(0.75 * total) && matched.every(id => F.read.has(String(id)));
    F.events = lazy(() => {
      if (!hasTable('events') || !hasTable('event_issues')) return [];
      const by = new Map();
      for (const r of db.prepare(`SELECT ei.event_id, ei.tier, ei.scanned_book_id AS b, (SELECT 1 FROM scanned_books sb WHERE sb.id = ei.scanned_book_id) AS have
        FROM event_issues ei`).all()) {
        if (!by.has(String(r.event_id))) by.set(String(r.event_id), []);
        by.get(String(r.event_id)).push(r);
      }
      const out = [];
      for (const e of db.prepare(`SELECT id, name, event_tier FROM events WHERE ${require('./eventDrafts').published(db)}`).all()) {   // not draft events
        const rows = by.get(String(e.id)) || [];
        const ess = rows.filter(r => r.tier === 'essential');
        const essential = done(ess.filter(r => r.have).map(r => r.b), ess.length);
        const every = done(rows.filter(r => r.have).map(r => r.b), rows.length);
        if (essential || every) out.push({ id: String(e.id), name: e.name, tier: Number(e.event_tier) || 2, every });
      }
      return out;
    });
    F.runs = lazy(() => {
      if (!hasTable('canon_runs') || !hasTable('canon_run_issues')) return { done: [], writers: [] };
      const by = new Map();
      for (const r of db.prepare(`SELECT cri.run_id, CAST(cri.scanned_book_id AS TEXT) AS b, (SELECT 1 FROM scanned_books sb WHERE sb.id = CAST(cri.scanned_book_id AS TEXT)) AS have
        FROM canon_run_issues cri JOIN canon_runs r ON r.id = cri.run_id WHERE r.status = 'approved'`).all()) {
        if (!by.has(r.run_id)) by.set(r.run_id, []);
        by.get(r.run_id).push(r);
      }
      const cats = new Map();
      if (hasTable('canon_run_categories')) for (const c of db.prepare('SELECT run_id, category FROM canon_run_categories').all()) {
        if (!cats.has(c.run_id)) cats.set(c.run_id, new Set());
        cats.get(c.run_id).add(c.category);
      }
      const finished = [...by.entries()].filter(([, rows]) => done(rows.filter(r => r.have).map(r => r.b), rows.length)).map(([id]) => ({ id, categories: cats.get(id) || new Set() }));
      const doneIds = new Set(finished.map(r => r.id));
      const writers = [];
      if (hasTable('canon_run_creators')) {
        const w = new Map();
        for (const c of db.prepare(`SELECT DISTINCT cc.person_name AS name, cc.run_id FROM canon_run_creators cc JOIN canon_runs r ON r.id = cc.run_id
          WHERE r.status = 'approved' AND cc.role = 'writer'`).all()) {
          if (!w.has(c.name)) w.set(c.name, []);
          w.get(c.name).push(c.run_id);
        }
        for (const [name, runs] of w) if (runs.length >= 2) writers.push({ name, total: runs.length, done: runs.filter(id => doneIds.has(id)).length });
      }
      return { done: finished, writers };
    });
    F.lists = lazy(() => {
      if (!hasTable('reading_lists')) return [];
      const rows = db.prepare(`SELECT id, visibility, source, owner_id FROM reading_lists WHERE visibility = 'essential' OR owner_id = ?
        OR id IN (SELECT list_id FROM reading_list_follows WHERE user_id = ?)`).all(userId, userId);
      const out = [];
      for (const l of rows) {
        let books = null; try { books = orderedBooks(l.id, { sub: userId }); } catch {}
        if (books && books.length && books.every(id => F.read.has(String(id)))) out.push({ ...l, size: books.length });
      }
      return out;
    });
    F.count = pred => { let n = 0; for (const b of F.books.values()) if (pred(b)) n++; return n; };
    F.days = lazy(() => [...new Set(F.log.map(r => r.local_day))].sort());
    F.since = launchedAt;
    // Order of first finishes (index in the log), and the reader's progress rows (completed any time, marked by hand).
    F.firstIdx = new Map();
    F.log.forEach((r, i) => { if (!F.firstIdx.has(String(r.book_id))) F.firstIdx.set(String(r.book_id), i); });
    F.progress = lazy(() => {
      if (!hasTable('read_progress')) return new Map();
      const cols = ['book_id', 'completed', hasColumn('read_progress', 'marked') ? 'marked' : '0 AS marked', hasColumn('read_progress', 'updated_at') ? 'updated_at' : 'NULL AS updated_at'];
      return new Map(db.prepare(`SELECT ${cols.join(', ')} FROM read_progress WHERE user_id = ?`).all(userId).map(r => [String(r.book_id), r]));
    });
    // A series' regular issues in number order (memoised per series).
    const seriesRegular = new Map();
    F.regularOf = sid => {
      sid = String(sid);
      if (!seriesRegular.has(sid)) seriesRegular.set(sid, db.prepare('SELECT id, issue_number, filename, COALESCE(is_special, 0) AS is_special FROM scanned_books WHERE series_id = ?').all(sid)
        .filter(F.isRegular).map(b => ({ ...b, id: String(b.id), n: parseFloat(norm(b.issue_number)) })).filter(b => Number.isFinite(b.n)).sort((a, b) => a.n - b.n));
      return seriesRegular.get(sid);
    };
    // Read before a given point in the log: finished earlier in the log, or completed outside it (before launch, or marked).
    F.readBefore = (bookId, idx) => { const i = F.firstIdx.get(String(bookId)); return i !== undefined ? i < idx : !!F.progress().get(String(bookId))?.completed; };
    F.seriesRead = lazy(() => [...new Set([...F.books.values()].map(b => String(b.series_id)))]);
    return F;
  }

  // Longest run of consecutive days / ISO weeks.
  const dayNum = d => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS);
  function longestRun(nums) {
    let best = 0, cur = 0, prev = null;
    for (const n of [...new Set(nums)].sort((a, b) => a - b)) { cur = prev !== null && n === prev + 1 ? cur + 1 : 1; best = Math.max(best, cur); prev = n; }
    return best;
  }
  const weekNum = d => Math.floor((dayNum(d) + 3) / 7);   // weeks starting Monday
  const firstSaturdayOfMay = y => { for (let d = 1; d <= 7; d++) if (new Date(Date.UTC(y, 4, d)).getUTCDay() === 6) return `${y}-05-0${d}`; return null; };

  // ── The achievements ────────────────────────────────────────────
  // group: paths | milestones | libraries | eras | genres | habits | household | secret
  // tier: 1 bronze, 2 silver, 3 gold. label: the short text on the badge. icon: a glyph name.
  const DEFS = [];
  const add = d => DEFS.push(d);
  const steps = (base, group, icon, list, value, desc) => list.forEach(([n, name, tier], i) =>
    add({ id: `${base}_${n}`, group, icon, tier: tier || Math.min(3, i + 1), label: String(n), name, desc: desc(n), check: F => ({ have: value(F), need: n }) }));
  const runsIn = (F, cat) => F.runs().done.filter(r => r.categories.has(cat)).length;
  const eventsOf = (F, tier) => F.events().filter(e => e.tier === tier).length;

  // Curated paths
  steps('runs', 'paths', 'shelf', [[1, 'Top Shelf Debut'], [5, 'Shelf Climber'], [10, 'Top Shelf Regular'], [25, 'Top Shelf Legend', 3]],
    F => F.runs().done.length, n => `Finish ${n === 1 ? 'a Top Shelf run' : `${n} Top Shelf runs`}.`);
  steps('award', 'paths', 'trophy', [[1, 'Acceptance Speech'], [5, 'Trophy Cabinet'], [10, 'Hall of Fame']],
    F => runsIn(F, 'award_winning'), n => `Finish ${n === 1 ? 'an award-winning run' : `${n} award-winning runs`}.`);
  steps('adapted', 'paths', 'film', [[1, 'Coming Soon'], [5, 'Now Showing'], [10, 'Box Office Smash']],
    F => runsIn(F, 'adapted_to_screen'), n => `Finish ${n === 1 ? 'a run adapted to the screen' : `${n} runs adapted to the screen`}.`);
  // Critically acclaimed starts at 5 (2026-11-10): 199 of the 224 runs carry it, so "one" was the same badge as Top Shelf Debut.
  steps('acclaimed', 'paths', 'star', [[5, "Critics' Pick"], [10, 'Two Thumbs Up'], [25, 'Certified Classic', 3]],
    F => runsIn(F, 'critically_acclaimed'), n => `Finish ${n === 1 ? 'a critically acclaimed run' : `${n} critically acclaimed runs`}.`);
  add({ id: 'triple_feature', group: 'paths', icon: 'shelf', tier: 2, label: '3', name: 'Triple Feature', desc: 'Finish a Top Shelf run from each category: award winning, adapted, acclaimed.',
    check: F => ({ have: ['award_winning', 'adapted_to_screen', 'critically_acclaimed'].filter(c => runsIn(F, c) > 0).length, need: 3 }) });
  steps('crisis', 'paths', 'burst', [[1, 'Crisis Survivor'], [5, 'Crisis Veteran'], [10, 'Infinite Crises']],
    F => eventsOf(F, 1), n => `Finish ${n === 1 ? 'a Crisis-level event' : `${n} Crisis-level events`} (the Essential path).`);
  steps('major', 'paths', 'bolt', [[1, 'Event Horizon'], [5, 'Event Junkie'], [10, 'Mega-Event Marathoner']],
    F => eventsOf(F, 2), n => `Finish ${n === 1 ? 'a Major event' : `${n} Major events`} (the Essential path).`);
  steps('arc', 'paths', 'link', [[1, 'Crossover Curious'], [5, 'Crossover King'], [10, 'Crossover Connoisseur']],
    F => eventsOf(F, 3), n => `Finish ${n === 1 ? 'a Crossover arc' : `${n} Crossover arcs`} (the Essential path).`);
  add({ id: 'every_tie_in', group: 'paths', icon: 'burst', tier: 3, label: 'ALL', name: 'Every Last Tie-In', desc: 'Finish a Timeline event with every tie-in, not just the Essential path.',
    check: F => ({ have: F.events().some(e => e.every) ? 1 : 0, need: 1 }) });
  const essentials = () => (hasTable('reading_lists') ? db.prepare("SELECT COUNT(*) AS n FROM reading_lists WHERE visibility = 'essential'").get().n : 0);
  steps('essential', 'paths', 'book', [[1, 'Essential Reading'], [3, 'Required Reading']],
    F => F.lists().filter(l => l.visibility === 'essential').length, n => `Finish ${n === 1 ? 'an Essentials list' : `${n} Essentials lists`}.`);
  add({ id: 'essential_all', group: 'paths', icon: 'book', tier: 3, label: 'ALL', name: 'Syllabus Complete', desc: 'Finish every Essentials list.',
    check: F => ({ have: F.lists().filter(l => l.visibility === 'essential').length, need: Math.max(1, essentials()) }) });
  add({ id: 'full_omnibus', group: 'paths', icon: 'stack', tier: 2, label: '3', name: 'The Full Omnibus', desc: 'Finish an Essentials list, a Timeline event and a Top Shelf run.',
    check: F => ({ have: (F.lists().some(l => l.visibility === 'essential') ? 1 : 0) + (F.events().length ? 1 : 0) + (F.runs().done.length ? 1 : 0), need: 3 }) });
  add({ id: 'auteur', group: 'paths', icon: 'pen', tier: 3, label: 'ALL', name: 'Auteur Theory', desc: 'Read every Top Shelf run by one writer (any writer with two or more).',
    check: F => { const w = F.runs().writers.slice().sort((a, b) => (b.done / b.total) - (a.done / a.total) || a.total - b.total)[0]; return w ? { have: w.done, need: w.total, note: w.name } : { have: 0, need: 1 }; } });
  add({ id: 'list_10', group: 'paths', icon: 'list', tier: 1, label: '10+', name: 'Checked Off', desc: 'Finish a reading list of 10 or more issues.',
    check: F => ({ have: F.lists().some(l => l.visibility !== 'essential' && l.size >= 10) ? 1 : 0, need: 1 }) });

  // Milestones
  steps('issues', 'milestones', 'stack', [[10, 'First Stack'], [50, 'Longbox Started'], [100, 'Century Club', 2], [250, 'Bagged and Boarded', 2], [500, 'Longbox Legend', 3], [1000, 'Best. Reader. Ever.', 3]],
    F => F.read.size, n => `Read ${n} issues to the last page.`);
  steps('specials', 'milestones', 'sparkle', [[10, 'Special Edition']],
    F => F.count(b => b.is_special), n => `Read ${n} specials.`);
  steps('annuals', 'milestones', 'calendar', [[10, 'Annual Tradition']],
    F => F.count(b => /annual/i.test(b.filename || '')), n => `Read ${n} annuals.`);
  steps('firsts', 'milestones', 'one', [[25, '#1 Fan'], [50, 'First Issue Fever']],
    F => F.count(b => ['1', '1.0', '01', '001'].includes(norm(b.issue_number))), n => `Read ${n} first issues.`);
  steps('series', 'milestones', 'check', [[1, 'The End'], [5, 'Series Finale'], [10, 'Box Set', 2], [25, 'Completist', 3]],
    F => F.finishedSeries().length, n => `Finish ${n === 1 ? 'a whole series' : `${n} whole series`} (4+ issues, specials and annuals aside).`);
  steps('long', 'milestones', 'mountain', [[50, 'Long Haul', 2], [100, 'Triple Digits', 3]],
    F => (F.finishedSeries().some(s => s.size >= 100) ? 100 : F.finishedSeries().some(s => s.size >= 50) ? 50 : 0), n => `Finish a series of ${n} or more issues.`);
  const pulledSince = userId => (hasTable('collection_series') ? db.prepare(`SELECT COUNT(*) AS n FROM collection_series cs JOIN collections c ON c.id = cs.collection_id
    WHERE c.owner_id = ? AND c.purpose = 'pull' AND cs.series_id NOT IN (SELECT ref_id FROM achievement_baseline WHERE user_id = ? AND kind = 'pull')`).get(userId, userId).n : 0);
  steps('pulls', 'milestones', 'box', [[5, 'Pull List'], [10, 'Standing Order'], [20, 'Subscription Box']],
    F => pulledSince(F.userId), n => `Pull ${n} series into your Pull Box.`);
  add({ id: 'caught_up', group: 'milestones', icon: 'check', tier: 2, label: 'NEW', name: 'Caught Up', desc: 'Read every new issue in a Pull Box of 5 or more series.',
    check: F => {
      if (!hasTable('collection_series') || !hasTable('monitored_issues')) return { have: 0, need: 1 };
      const size = db.prepare(`SELECT COUNT(*) AS n FROM collection_series cs JOIN collections c ON c.id = cs.collection_id WHERE c.owner_id = ? AND c.purpose = 'pull'`).get(F.userId).n;
      if (size < 5) return { have: 0, need: 1 };
      const rel = db.prepare(`SELECT sb.id, COALESCE(rp.completed, 0) AS done FROM scanned_books sb JOIN monitored_issues mi ON mi.id = sb.monitored_issue_id
        LEFT JOIN read_progress rp ON rp.book_id = sb.id AND rp.user_id = ?
        WHERE EXISTS (SELECT 1 FROM collection_series cs JOIN collections c ON c.id = cs.collection_id WHERE cs.series_id = sb.series_id AND c.owner_id = ? AND c.purpose = 'pull')
          AND COALESCE(mi.store_date, mi.release_date) <= date('now') ORDER BY COALESCE(mi.store_date, mi.release_date) DESC LIMIT 30`).all(F.userId, F.userId);
      return { have: rel.length && rel.every(r => r.done) && rel.some(r => F.read.has(String(r.id))) ? 1 : 0, need: 1 };
    } });
  const since = (table, where, ...args) => (hasTable(table) ? db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n : 0);
  add({ id: 'box_builder', group: 'milestones', icon: 'box', tier: 1, label: 'BOX', name: 'Longbox Architect', desc: 'Make a comic box of your own.',
    check: F => ({ have: Math.min(1, since('collections', "owner_id = ? AND COALESCE(purpose, '') <> 'pull' AND created_at >= ?", F.userId, launchedAt)), need: 1 }) });
  add({ id: 'list_maker', group: 'milestones', icon: 'list', tier: 1, label: 'LIST', name: 'The Curator', desc: 'Make a reading list of your own.',
    check: F => ({ have: Math.min(1, since('reading_lists', "owner_id = ? AND COALESCE(source, 'manual') NOT IN ('ai', 'import') AND created_at >= ?", F.userId, launchedAt)), need: 1 }) });
  add({ id: 'trendsetter', group: 'milestones', icon: 'heart', tier: 2, label: 'FOLLOW', name: 'Trendsetter', desc: 'Another reader follows a reading list of yours.',
    check: F => ({ have: hasTable('reading_list_follows') ? Math.min(1, db.prepare(`SELECT COUNT(*) AS n FROM reading_list_follows f JOIN reading_lists l ON l.id = f.list_id
      WHERE l.owner_id = ? AND f.user_id <> ? AND f.followed_at >= ?`).get(F.userId, F.userId, launchedAt).n) : 0, need: 1 }) });

  // Libraries: steps scaled to each library's size, with names of their own (pass 2, 2026-11-10);
  // other libraries get "<name> Reader / Regular / Devotee". short: the badge's ribbon.
  const LIBRARY_NAMES = [
    [/marvel/i, 'MARVEL', ['True Believer', 'Make Mine Marvel', 'Excelsior!']],
    [/^dc\b|\bdc comics\b/i, 'DC', ['Truth and Justice', 'Distinguished Competition', 'Hall of Justice']],
    [/vertigo/i, 'VERTIGO', ['Mature Readers', 'Dizzy Heights']],
    [/dark horse/i, 'DARK HORSE', ['Dark Horse Rider', 'Photo Finish']],
    [/\bimage\b/i, 'IMAGE', ['Creator-Owned', 'Image Conscious']],
    [/dynamite/i, 'DYNAMITE', ['Lit Fuse', 'Big Bang']],
    [/crossover/i, 'CROSSOVER', ['Unlikely Allies', 'When Worlds Collide']],
    [/star wars/i, 'STAR WARS', ['A Long Time Ago…', 'Far, Far Away']],
    [/america'?s best/i, 'ABC', ['Tomorrow Stories', 'Extraordinary Readers']],
    [/boom/i, 'BOOM!', ['Boom!']],
    [/\bviz\b/i, 'VIZ', ['Manga Moment']],
    [/mad cave/i, 'MAD CAVE', ['Into the Cave']],
    [/hakusensha/i, 'HAKUSENSHA', ['Import Edition']],
  ];
  const libraryNames = name => {
    const hit = LIBRARY_NAMES.find(([re]) => re.test(name || ''));
    const short = hit ? hit[1] : String(name || '').split(/\s+/)[0].toUpperCase().slice(0, 10);
    const own = hit ? hit[2] : [];
    const dflt = (n, i) => (own.length === n ? own[i] : null);
    return { short, step: (n, i, fallback) => dflt(n, i) || own[i] || fallback };
  };
  const libraryDefs = () => {
    if (!hasTable('libraries')) return [];
    const out = [];
    for (const l of db.prepare(`SELECT l.id, l.name, l.color, (SELECT COUNT(*) FROM scanned_series s WHERE s.library_id = l.id) AS series FROM libraries l ORDER BY l.name`).all()) {
      const id = String(l.id), name = l.name;
      const issues = F => F.count(b => String(b.library_id) === id);
      const series = F => F.finishedSeries().filter(s => String(F.seriesInfo().get(s.id)?.library_id) === id).length;
      const nm = libraryNames(name);
      const base = { group: 'libraries', icon: 'stamp', label: nm.short, library: { id, name, color: l.color || null } };
      if (l.series >= 500) {
        out.push({ ...base, id: `lib_${id}_25`, tier: 1, name: nm.step(3, 0, `${name} Reader`), desc: `Read 25 issues from ${name}.`, check: F => ({ have: issues(F), need: 25 }) });
        out.push({ ...base, id: `lib_${id}_s5`, tier: 2, name: nm.step(3, 1, `${name} Regular`), desc: `Finish 5 series from ${name}.`, check: F => ({ have: series(F), need: 5 }) });
        out.push({ ...base, id: `lib_${id}_s10`, tier: 3, name: nm.step(3, 2, `${name} Devotee`), desc: `Finish 10 series from ${name}.`, check: F => ({ have: series(F), need: 10 }) });
      } else if (l.series >= 15) {
        out.push({ ...base, id: `lib_${id}_10`, tier: 1, name: nm.step(2, 0, `${name} Reader`), desc: `Read 10 issues from ${name}.`, check: F => ({ have: issues(F), need: 10 }) });
        out.push({ ...base, id: `lib_${id}_s2`, tier: 2, name: nm.step(2, 1, `${name} Regular`), desc: `Finish 2 series from ${name}.`, check: F => ({ have: series(F), need: 2 }) });
      } else if (l.series > 0) {
        out.push({ ...base, id: `lib_${id}_1`, tier: 1, name: nm.step(1, 0, `${name} Discovery`), desc: `Read an issue from ${name}.`, check: F => ({ have: issues(F), need: 1 }) });
      }
    }
    const nonEmpty = () => db.prepare('SELECT COUNT(DISTINCT library_id) AS n FROM scanned_series').get().n;
    const libsRead = F => new Set([...F.books.values()].map(b => String(b.library_id))).size;
    out.push({ id: 'libraries_5', group: 'libraries', icon: 'card', tier: 2, label: '5', name: 'Library Card', desc: 'Read something from 5 different libraries.', check: F => ({ have: libsRead(F), need: 5 }) });
    out.push({ id: 'libraries_all', group: 'libraries', icon: 'globe', tier: 3, label: 'ALL', name: 'Multiverse Tourist', desc: 'Read something from every library.', check: F => ({ have: libsRead(F), need: Math.max(1, nonEmpty()) }) });
    return out;
  };

  // Eras and breadth
  const yearOfBook = b => yearOf(b.comicinfo) || (b.volume_year ? Number(b.volume_year) : null);
  // Modern Age needs 25 (2026-11-10): 84% of the library is from 1986 on, so one issue was a free badge.
  const ages = [['golden', 'Golden Age', 0, 1955, 1, 'Read a comic from the Golden Age (1955 or earlier).'], ['silver', 'Silver Age', 1956, 1969, 1, 'Read a comic from the Silver Age (1956–1969).'],
    ['bronze', 'Bronze Age', 1970, 1985, 1, 'Read a comic from the Bronze Age (1970–1985).'], ['modern', 'Modern Age', 1986, 9999, 25, 'Read 25 comics from the Modern Age (1986 on).']];
  const inAge = (F, lo, hi) => F.count(b => { const y = yearOfBook(b); return y && y >= lo && y <= hi; });
  for (const [key, name, lo, hi, need, desc] of ages) add({ id: `age_${key}`, group: 'eras', icon: 'hourglass', tier: key === 'golden' ? 3 : key === 'silver' ? 2 : 1, label: name.split(' ')[0].toUpperCase(), name, desc,
    check: F => ({ have: inAge(F, lo, hi), need }) });
  add({ id: 'age_all', group: 'eras', icon: 'hourglass', tier: 3, label: 'ALL', name: 'Time Traveller', desc: 'Read a comic from every age: Golden, Silver, Bronze and Modern.',
    check: F => ({ have: ages.filter(([, , lo, hi]) => inAge(F, lo, hi) > 0).length, need: 4 }) });
  const genreCount = (F, g) => F.count(b => (F.seriesInfo().get(String(b.series_id))?.genres || []).includes(g));
  // Superhero needs 25 (2026-11-10): 88% of the library is tagged with it; every other genre needs 3.
  const genreNeed = g => (g === 'Superhero' ? 25 : 3);
  add({ id: 'genres_10', group: 'eras', icon: 'palette', tier: 2, label: '10', name: 'Genre Hopper', desc: 'Earn 10 genre badges.',
    check: F => ({ have: GENRES.filter(g => genreCount(F, g) >= genreNeed(g)).length, need: 10 }) });
  add({ id: 'indie_25', group: 'eras', icon: 'flag', tier: 2, label: '25', name: 'Indie Spirit', desc: 'Read 25 issues from libraries other than Marvel and DC.',
    check: F => ({ have: F.count(b => { const l = F.libraries().get(String(b.library_id)); return l && !isMarvel(l.name) && !isDC(l.name); }), need: 25 }) });
  add({ id: 'manga_3', group: 'eras', icon: 'scroll', tier: 1, label: '3', name: 'Right to Left', desc: 'Read 3 manga volumes.',
    check: F => ({ have: F.count(b => isRtl(b.comicinfo) || F.seriesInfo().get(String(b.series_id))?.series_type === 'manga'), need: 3 }) });
  const eisnerSeries = F => {
    if (!hasTable('award_data')) return 0;
    const won = new Set(db.prepare("SELECT DISTINCT CAST(cv_volume_id AS TEXT) AS v FROM award_data WHERE award = 'eisner' AND winner = 1 AND cv_volume_id IS NOT NULL").all().map(r => r.v));
    return [...F.seriesInfo().values()].filter(s => s.comicid && won.has(s.comicid)).length;
  };
  steps('eisner', 'eras', 'trophy', [[1, 'Eisner Night'], [5, 'Award Season', 3]], eisnerSeries, n => `Read from ${n === 1 ? 'an Eisner-winning series' : `${n} Eisner-winning series`}.`);
  // One badge per genre: read 3 issues of series tagged with it.
  const GENRE_NAMES = { Superhero: 'Cape and Cowl', Crime: 'Rap Sheet', Horror: 'Things That Go Bump', 'Science Fiction': 'Final Frontier', Fantasy: 'Here Be Dragons',
    Mystery: 'Case Closed', Thriller: 'Edge of Your Seat', Comedy: 'Funny Pages', Drama: 'Big Feelings', Romance: 'Love Story', War: 'Front Lines', Western: 'High Noon',
    Noir: 'Rain-Slicked Streets', Espionage: 'Licence to Read', Supernatural: 'Things Unseen', Cosmic: 'Cosmic Awareness', 'Street-Level': 'Street Level', Team: 'Assemble!',
    Teen: 'Teen Titan', 'Martial Arts': 'Kung Fu Fighting', 'Post-Apocalyptic': 'After the End', 'Alternate Reality': 'What If?', 'Anti-Hero': 'Morally Grey',
    'All-Ages': 'Fun for Everyone', 'Sword & Sorcery': 'Sword and Sorcery', Pulp: 'Pulp Adventure', Cyberpunk: 'Jacked In', Kaiju: 'Giant Monster Attack',
    Historical: 'History Buff', 'Time Travel': 'Paradox Proof', Surreal: 'Through the Looking Glass' };
  // Each genre's glyph and ribbon text (pass 2): its own symbol where one fits, the theatre mask otherwise.
  const GENRE_ICONS = { Superhero: 'star', Crime: 'hash', Horror: 'pumpkin', 'Science Fiction': 'globe', Fantasy: 'sparkle', Mystery: 'question', Thriller: 'bolt',
    Romance: 'heart', War: 'flag', Western: 'star', Noir: 'moon', Espionage: 'card', Supernatural: 'sparkle', Cosmic: 'globe', 'Street-Level': 'stamp', Team: 'team',
    Teen: 'one', 'Martial Arts': 'burst', 'Post-Apocalyptic': 'flame', 'Alternate Reality': 'loop', 'Anti-Hero': 'burst', 'All-Ages': 'heart', 'Sword & Sorcery': 'saber',
    Pulp: 'book', Cyberpunk: 'bolt', Kaiju: 'mountain', Historical: 'scroll', 'Time Travel': 'hourglass', Surreal: 'loop' };
  const GENRE_SHORT = { 'Science Fiction': 'SCI-FI', 'Post-Apocalyptic': 'POST-APOC', 'Alternate Reality': 'ALT EARTH', 'Sword & Sorcery': 'SWORD', 'Martial Arts': 'MARTIAL ARTS' };
  GENRES.forEach((g, i) => add({ id: `genre_${g.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, group: 'genres', icon: GENRE_ICONS[g] || 'genre', tier: 1, genre: g, hue: Math.round(i * 360 / GENRES.length),
    label: GENRE_SHORT[g] || g.toUpperCase(),
    name: GENRE_NAMES[g] || `${g} Fan`, desc: `Read ${genreNeed(g)} issues of ${g} series.`, check: F => ({ have: genreCount(F, g), need: genreNeed(g) }) }));

  // Habits
  const releaseDays = F => {
    if (!hasTable('monitored_issues')) return [];
    const out = [];
    const stmt = db.prepare('SELECT COALESCE(store_date, release_date) AS d FROM monitored_issues WHERE id = ?');
    for (const b of F.books.values()) {
      if (!b.monitored_issue_id) continue;
      const d = String(stmt.get(b.monitored_issue_id)?.d || '').slice(0, 10);
      const read = F.firstDay.get(String(b.id));
      if (d && read) out.push(dayNum(read) - dayNum(d));
    }
    return out;
  };
  steps('new_releases', 'habits', 'truck', [[5, 'New Comic Book Day'], [10, 'Wednesday Warrior'], [25, 'Day-and-Date Devotee']],
    F => releaseDays(F).filter(x => x >= 0 && x <= 6).length, n => `Read ${n} new releases in their release week.`);
  steps('streak_days', 'habits', 'flame', [[3, 'On a Roll'], [7, 'Week of Wonders', 3]], F => longestRun(F.days().map(dayNum)), n => `Read on ${n} days in a row.`);
  steps('streak_weeks', 'habits', 'flame', [[4, 'Ongoing Series'], [12, 'Season Pass', 3]], F => longestRun(F.days().map(weekNum)), n => `Read in ${n} weeks in a row.`);
  add({ id: 'one_sitting', group: 'habits', icon: 'clock', tier: 2, label: '1 DAY', name: 'One Sitting', desc: 'Read a whole mini-series (4 to 12 issues) in one day.',
    check: F => ({ have: F.finishedSeries().some(s => s.size <= 12 && new Set(s.days).size === 1) ? 1 : 0, need: 1 }) });
  add({ id: 'weekend_binge', group: 'habits', icon: 'couch', tier: 2, label: '20', name: 'Weekend Binge', desc: 'Read 20 issues over one weekend.',
    check: F => {
      const per = new Map();
      for (const r of F.log) { const dow = new Date(`${r.local_day}T00:00:00Z`).getUTCDay(); if (dow !== 0 && dow !== 6) continue; const k = dow === 6 ? dayNum(r.local_day) : dayNum(r.local_day) - 1; per.set(k, (per.get(k) || 0) + 1); }
      return { have: Math.max(0, ...per.values()), need: 20 };
    } });

  // Household and the app
  add({ id: 'first_finish', group: 'household', icon: 'medal', tier: 3, label: '1ST', name: 'First to the Finish', desc: 'Be the first in the household to finish a Timeline event.',
    check: F => ({ have: db.prepare(`SELECT COUNT(*) AS n FROM achievement_completions c WHERE c.user_id = ? AND c.kind = 'event'
      AND NOT EXISTS (SELECT 1 FROM achievement_completions o WHERE o.kind = 'event' AND o.ref_id = c.ref_id AND o.user_id <> c.user_id AND o.at < c.at)`).get(F.userId).n ? 1 : 0, need: 1 }) });
  add({ id: 'special_order', group: 'household', icon: 'mail', tier: 1, label: 'REQ', name: 'Special Order', desc: 'A request of yours is filled.',
    check: F => ({ have: Math.min(1, since('download_requests', "user_id = ? AND status = 'added' AND handled_at >= ?", F.userId, launchedAt)), need: 1 }) });
  add({ id: 'no_prize', group: 'household', icon: 'wrench', tier: 1, label: 'FIX', name: 'No-Prize', desc: 'A problem you reported is fixed.',
    check: F => ({ have: Math.min(1, since('problem_reports', "user_id = ? AND status IN ('resolved', 'fixed') AND handled_at >= ?", F.userId, launchedAt)), need: 1 }) });
  add({ id: 'previously_on', group: 'household', icon: 'speech', tier: 1, label: 'RECAP', name: 'Previously On…', desc: 'Ask Comic Book Guy for a recap.',
    check: F => ({ have: Math.min(1, since('ai_usage', "user_id = ? AND kind IN ('recap', 'recap_quick') AND created_at >= ?", F.userId, launchedAt)), need: 1 }) });

  // Secret (hidden until earned)
  const secret = (id, name, hint, desc, label, icon, test) => add({ id, group: 'secret', hidden: true, tier: 2, icon, label, name, hint, desc, check: F => ({ have: test(F) ? 1 : 0, need: 1 }) });
  const anyBook = (F, pred) => { for (const b of F.books.values()) if (pred(b)) return true; return false; };
  const onDay = (F, pred) => F.log.some(r => pred(r.local_day, r));
  const bookOnDay = (F, test) => F.log.some(r => { const b = F.books.get(String(r.book_id)); return b && test(b, r.local_day, r); });
  secret('minus_one', 'Minus One', 'Before the beginning.', 'Read a #-1 issue.', '#-1', 'hash', F => anyBook(F, b => norm(b.issue_number) === '-1'));
  secret('zero_hour', 'Zero Hour', 'Some stories start at nothing.', 'Read a #0 issue.', '#0', 'hash', F => anyBook(F, b => ['0', '0.0', '00', '000'].includes(norm(b.issue_number))));
  secret('one_million', 'One Million', 'Look very far ahead.', 'Read a #1,000,000 issue.', '1M', 'hash', F => anyBook(F, b => /^1000000(\.0)?$/.test(norm(b.issue_number))));
  secret('point_one', 'Point One', 'Not quite a whole issue.', 'Read a .1 issue.', '.1', 'hash', F => anyBook(F, b => /^\d+\.1$/.test(norm(b.issue_number))));
  secret('centennial', 'Centennial', 'A nice round number.', 'Read a #100 issue.', '#100', 'hash', F => anyBook(F, b => /^0*100(\.0)?$/.test(norm(b.issue_number))));
  secret('legacy_number', 'Legacy Number', 'Big numbers, long history.', 'Read an issue numbered 500 or higher.', '500+', 'hash', F => anyBook(F, b => { const n = parseFloat(norm(b.issue_number)); return n >= 500 && n < 1000000; }));
  secret('creature_of_the_night', 'Creature of the Night', 'Read while the city sleeps.', 'Finish an issue between midnight and 4 a.m.', '3AM', 'moon', F => F.log.some(r => r.local_hour !== null && r.local_hour < 4));
  secret('day_one', 'Day One', 'Fresh off the truck.', 'Read a new release on its release day.', 'DAY 1', 'truck', F => releaseDays(F).includes(0));
  secret('may_the_fourth', 'May the Fourth', 'A date from a galaxy far, far away.', 'Read a Star Wars comic on May 4.', '5/4', 'saber',
    F => bookOnDay(F, (b, d) => d.slice(5) === '05-04' && (/star wars/i.test(F.libraries().get(String(b.library_id))?.name || '') || /star wars/i.test(b.series_name || ''))));
  secret('trick_or_treat', 'Trick or Treat', 'A scary night to read.', 'Read a Horror comic on Halloween.', '10/31', 'pumpkin',
    F => bookOnDay(F, (b, d) => d.slice(5) === '10-31' && (F.seriesInfo().get(String(b.series_id))?.genres || []).includes('Horror')));
  secret('free_comic_book_day', 'Free Comic Book Day', 'A holiday for comic shops.', 'Read on Free Comic Book Day (the first Saturday of May).', 'FCBD', 'gift',
    F => onDay(F, d => d === firstSaturdayOfMay(Number(d.slice(0, 4)))));
  secret('anniversary_issue', 'Anniversary Issue', 'Celebrate the day you joined.', 'Read on the anniversary of joining Omnibus.', 'ANNV', 'cake', F => {
    const u = db.prepare('SELECT created_at FROM users WHERE id = ?').get(F.userId);
    const joined = String(u?.created_at || '').slice(0, 10);
    return joined.length === 10 && onDay(F, d => d.slice(5) === joined.slice(5) && d.slice(0, 4) > joined.slice(0, 4));
  });
  secret('amalgam', 'Amalgam', 'When publishers collide.', 'Read an intercompany crossover.', 'X', 'link', F => anyBook(F, b => /crossover/i.test(F.libraries().get(String(b.library_id))?.name || '')));
  secret('both_sides', 'Both Sides of the Street', 'Two rival shops in one day.', 'Read Marvel and DC comics on the same day.', 'M+DC', 'split', F => {
    const by = new Map();
    for (const r of F.log) { const b = F.books.get(String(r.book_id)); const n = b && F.libraries().get(String(b.library_id))?.name; if (!n) continue; const s = by.get(r.local_day) || new Set(); if (isMarvel(n)) s.add('m'); if (isDC(n)) s.add('d'); by.set(r.local_day, s); }
    return [...by.values()].some(s => s.size === 2);
  });
  secret('elseworlds', 'Elseworlds', 'Another Earth, start to finish.', 'Finish an Alternate Reality series.', 'E-2', 'globe',
    F => F.finishedSeries().some(s => (F.seriesInfo().get(s.id)?.genres || []).includes('Alternate Reality')));
  secret('giant_size', 'Giant-Size', 'A thick one.', 'Read an issue of 64 pages or more.', '64+', 'stack', F => F.log.some(r => (r.pages || pageCountOf(F.books.get(String(r.book_id))?.comicinfo) || 0) >= 64));
  // Replaces Golden Oldie (2026-11-10), which always came with an age badge.
  secret('happy_birthday', 'Happy Birthday', 'Some issues have a birthday too.', 'Read an issue on the anniversary of its release day.', 'B-DAY', 'calendar', F => {
    if (!hasTable('monitored_issues')) return false;
    const stmt = db.prepare('SELECT COALESCE(store_date, release_date) AS d FROM monitored_issues WHERE id = ?');
    return F.log.some(r => {
      const b = F.books.get(String(r.book_id));
      const d = b?.monitored_issue_id ? String(stmt.get(b.monitored_issue_id)?.d || '').slice(0, 10) : '';
      return d.length === 10 && r.local_day.slice(5) === d.slice(5) && r.local_day.slice(0, 4) > d.slice(0, 4);
    });
  });
  secret('team_up', 'Team-Up', 'Same comic, same day, different reader.', 'Finish the same issue as another reader on the same day.', '2', 'team',
    F => !!db.prepare(`SELECT 1 FROM reading_log a JOIN reading_log b ON b.book_id = a.book_id AND b.local_day = a.local_day AND b.user_id <> a.user_id WHERE a.user_id = ? LIMIT 1`).get(F.userId));
  secret('shopkeepers_advice', "The Shopkeeper's Advice", 'Take the recommendation.', 'Finish a reading list Comic Book Guy built for you.', 'CBG', 'book',
    F => F.lists().some(l => l.source === 'ai' && String(l.owner_id) === F.userId));
  secret('retcon', 'Retcon', 'Some stories deserve a second look.', 'Read an issue again on another day.', 'x2', 'loop', F => {
    const days = new Map();
    for (const r of F.log) { const s = days.get(r.book_id) || new Set(); s.add(r.local_day); days.set(r.book_id, s); }
    return [...days.values()].some(s => s.size > 1);
  });
  secret('worst_question_ever', 'Worst. Question. Ever.', 'Keep the shopkeeper busy.', 'Ask Comic Book Guy 25 questions.', '25?', 'speech',
    F => since('ai_usage', "user_id = ? AND COALESCE(kind, '') NOT IN ('test') AND created_at >= ?", F.userId, launchedAt) >= 25);

  // Sassy ones (2026-11-11, user): teasing the reader's habits rather than rewarding them.
  secret('i_read_it', 'I Read It, I Swear', 'Some reading is more honest than others.', 'Mark 50 issues as read without reading them.', 'SWEAR', 'check',
    F => [...F.progress().values()].filter(r => r.completed && r.marked && (!r.updated_at || String(r.updated_at) >= launchedAt)).length >= 50);
  // A finished series: ended by the weekly status check, or not monitored and its last issue two or more years old.
  const seriesEnded = (F, sid, last) => {
    let st = null;
    if (hasColumn('monitored_series', 'series_status')) st = db.prepare('SELECT m.series_status AS s FROM scanned_series ss JOIN monitored_series m ON m.id = ss.monitored_series_id WHERE ss.id = ?').get(sid)?.s;
    if (st) return st === 'ended';
    const y = yearOf(db.prepare('SELECT comicinfo FROM scanned_books WHERE id = ?').get(last.id)?.comicinfo);
    return !!y && y <= new Date(now()).getUTCFullYear() - 2;
  };
  secret('spoiler_alert', 'Spoiler Alert', 'Some people read the last page first.', 'Read the last issue of a finished series before any other issue of it.', 'END', 'flag',
    F => F.seriesRead().some(sid => {
      const regular = F.regularOf(sid), last = regular[regular.length - 1];
      const idx = last && F.firstIdx.get(last.id);
      return regular.length >= 4 && idx !== undefined && regular.slice(0, -1).every(b => !F.readBefore(b.id, idx)) && seriesEnded(F, sid, last);
    }));
  secret('continuity_error', 'Continuity Error', 'Order matters. Usually.', 'Read an issue, then go back and read the one before it.', '2→1', 'loop',
    F => F.seriesRead().some(sid => F.regularOf(sid).some((b, i, all) => {
      const prev = all[i - 1], idx = F.firstIdx.get(b.id), pIdx = prev && F.firstIdx.get(prev.id);
      return prev && idx !== undefined && pIdx !== undefined && pIdx > idx && !F.readBefore(prev.id, idx);
    })));
  secret('who_starts_at_37', 'Who Starts at #37?', 'Jump on anywhere you like.', 'Start a series in the middle while its first issue sits in the library.', '#37', 'hash',
    F => F.seriesRead().some(sid => {
      const regular = F.regularOf(sid);
      if (regular.length < 3 || regular[0].n > 1) return false;
      const first = regular.map((b, i) => ({ i, idx: F.firstIdx.get(b.id) })).filter(x => x.idx !== undefined).sort((a, b) => a.idx - b.idx)[0];
      return first && first.i >= 2 && regular.slice(0, first.i).every(b => !F.readBefore(b.id, first.idx));
    }));
  secret('commitment_issues', 'Commitment Issues', 'So many first dates.', 'Read #1 of five series and none of their #2s within 30 days.', '#1×5', 'heart',
    F => F.seriesRead().filter(sid => {
      const [one, two] = F.regularOf(sid);
      if (!one || !two || one.n !== 1) return false;
      const r = F.log[F.firstIdx.get(one.id)];
      return r && dayNum(r.local_day) <= dayNum(new Date(now()).toISOString().slice(0, 10)) - 30 && !F.read.has(two.id) && !F.progress().get(two.id)?.completed;
    }).length >= 5);
  secret('called_in_sick', 'Called in Sick', 'Cough, cough.', 'Read 10 issues on a weekday.', '10', 'couch', F => {
    const per = new Map();
    for (const r of F.log) { const dow = new Date(`${r.local_day}T00:00:00Z`).getUTCDay(); if (dow === 0 || dow === 6) continue; per.set(r.local_day, (per.get(r.local_day) || 0) + 1); }
    return Math.max(0, ...per.values()) >= 10;
  });
  secret('older_than_your_dad', 'Older Than Your Dad', 'Respect your elders.', 'Read an issue published 50 or more years before the day you read it.', '50 YRS', 'hourglass',
    F => bookOnDay(F, (b, d) => { const y = yearOfBook(b); return !!y && y <= Number(d.slice(0, 4)) - 50; }));
  secret('touched_grass', 'Touched Grass', 'Welcome back. How was outside?', 'Come back to reading after 30 days away.', '30 DAYS', 'mountain',
    F => F.days().some((d, i, all) => i > 0 && dayNum(d) - dayNum(all[i - 1]) > 30));
  secret('event_fatigue', 'Event Fatigue', 'Too many crises in one day.', 'Read issues from three different Timeline events on the same day.', '3', 'burst', F => {
    if (!hasTable('event_issues')) return false;
    const evOf = new Map();   // book → its events, read once
    for (const e of db.prepare('SELECT DISTINCT scanned_book_id AS b, event_id FROM event_issues WHERE scanned_book_id IS NOT NULL').all()) {
      if (!evOf.has(String(e.b))) evOf.set(String(e.b), []);
      evOf.get(String(e.b)).push(String(e.event_id));
    }
    const per = new Map();
    for (const r of F.log) { const s = per.get(r.local_day) || new Set(); for (const e of evOf.get(String(r.book_id)) || []) s.add(e); per.set(r.local_day, s); }
    return [...per.values()].some(s => s.size >= 3);
  });
  secret('everyones_a_critic', "Everyone's a Critic", 'The shopkeeper is not always right.', "Give 10 of Comic Book Guy's answers a thumbs down.", 'BOO', 'speech',
    F => since('ai_feedback', 'user_id = ? AND rating = -1 AND created_at >= ?', F.userId, launchedAt) >= 10);
  secret('new_costume', 'New Costume, Who Dis?', 'Change is good. Repeatedly.', 'Change your app theme 5 times.', 'x5', 'palette', F => counted(F.userId, 'theme') >= 5);
  secret('pile_of_shame', 'Pile of Shame', 'Your Pull Box is judging you.', 'Have 100 unread issues in your Pull Box.', '100', 'stack', F => {
    if (!hasTable('collection_series') || !hasTable('collections')) return false;
    const rows = db.prepare(`SELECT sb.id FROM scanned_books sb WHERE sb.series_id IN (SELECT cs.series_id FROM collection_series cs JOIN collections c ON c.id = cs.collection_id
      WHERE c.owner_id = ? AND c.purpose = 'pull' AND cs.series_id NOT IN (SELECT ref_id FROM achievement_baseline WHERE user_id = ? AND kind = 'pull'))`).all(F.userId, F.userId);
    return rows.filter(r => !F.read.has(String(r.id)) && !F.progress().get(String(r.id))?.completed).length >= 100;
  });
  secret('only_the_pictures', 'I Only Look at the Pictures', 'Did you even read the words?', 'Read an issue of 16 or more pages, first page to last, in under 2 minutes.', '2 MIN', 'clock',
    F => F.log.some(r => r.seconds !== null && r.seconds !== undefined && r.seconds < 120 && (r.pages || 0) >= 16));

  // Legendary Stories (2026-11-10): hidden, a scavenger hunt; data in achievementStories.js. An
  // issue of a story counts when its Comic Vine id is one listed for it, or when its ComicInfo
  // series, number and cover year match.
  const normName = v => String(v || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '');
  const ciTag = (ci, t) => { const m = new RegExp(`<${t}>([^<]*)</${t}>`, 'i').exec(ci || ''); return m ? m[1].trim() : null; };
  const storyIndex = F => (F._stories ||= (() => {
    const byKey = new Map(), cvRead = new Set();
    for (const b of F.books.values()) {
      if (b.cv_issue_id) cvRead.add(String(b.cv_issue_id));
      const sname = normName(ciTag(b.comicinfo, 'Series')), n = parseFloat(ciTag(b.comicinfo, 'Number') ?? b.issue_number);
      if (!sname || !Number.isFinite(n)) continue;
      const k = `${sname}|${n}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(yearOf(b.comicinfo));
    }
    return { byKey, cvRead };
  })());
  const storyProgress = (F, st) => {
    const { byKey, cvRead } = storyIndex(F);
    let have = 0, need = 0;
    for (const p of st.parts) for (let n = p.issues[0]; n <= p.issues[1]; n++) {
      need++;
      const ids = (p.cv && p.cv[n - p.issues[0]]) || [];
      if (ids.some(id => cvRead.has(String(id))) || p.series.some(sr => (byKey.get(`${normName(sr)}|${n}`) || []).some(y => !y || (y >= p.years[0] && y <= p.years[1])))) have++;
    }
    return { have, need };
  };
  for (const st of STORIES) add({ id: `story_${st.id}`, group: 'legendary', hidden: true, tier: 3, icon: st.icon || 'book', label: st.label, name: st.name,
    hint: st.hint, desc: st.desc, check: F => storyProgress(F, st) });

  const LAST = ['genres', 'legendary', 'secret'];
  const allDefs = () => [...DEFS.filter(d => !LAST.includes(d.group)), ...libraryDefs(), ...LAST.flatMap(g => DEFS.filter(d => d.group === g))];

  // ── Evaluation ──────────────────────────────────────────────────
  const cache = new Map();   // user → { at, progress }
  function progressFor(userId) {
    const hit = cache.get(String(userId));
    if (hit && now() - hit.at < 30000) return hit.progress;
    const F = facts(userId);
    // Events finished are kept with the time first seen, for "first in the household".
    const ins = db.prepare("INSERT OR IGNORE INTO achievement_completions (user_id, kind, ref_id, at) VALUES (?, 'event', ?, ?)");
    for (const e of F.events()) ins.run(F.userId, e.id, sqlTime(now()));
    const progress = new Map();
    for (const d of allDefs()) {
      let p = { have: 0, need: 1 };
      try { p = d.check(F) || p; } catch (e) { logger.warn('achievements', 'Check failed', { id: d.id, error: e.message }); }
      progress.set(d.id, { have: Number(p.have) || 0, need: Number(p.need) || 1, note: p.note || null });
    }
    cache.set(String(userId), { at: now(), progress });
    return progress;
  }
  // Records newly earned achievements; returns them (for the toast).
  function evaluate(userId) {
    userId = String(userId);
    const progress = progressFor(userId);
    const have = new Set(db.prepare('SELECT achievement_id FROM user_achievements WHERE user_id = ?').all(userId).map(r => r.achievement_id));
    const fresh = [];
    const ins = db.prepare('INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, earned_at) VALUES (?, ?, ?)');
    const at = sqlTime(now());
    for (const d of allDefs()) {
      const p = progress.get(d.id);
      if (p && p.have >= p.need && !have.has(d.id)) { ins.run(userId, d.id, at); fresh.push(publicDef(d, true)); }
    }
    if (fresh.length) logger.info('achievements', 'Achievements earned', { user: userId, ids: fresh.map(f => f.id) });
    return fresh;
  }
  function publicDef(d, earned) {
    const masked = d.hidden && !earned;
    return { id: d.id, group: d.group, tier: d.tier, icon: d.icon, label: masked ? '?' : d.label, name: masked ? '???' : d.name,
      desc: masked ? d.hint : d.desc, hidden: !!d.hidden, ...(d.library ? { library: d.library } : {}), ...(d.genre ? { genre: d.genre, hue: d.hue } : {}) };
  }

  // ── Routes ──────────────────────────────────────────────────────
  const GROUPS = [['paths', 'Required Reading', 'Top Shelf runs, Timeline events and Essentials, start to finish.'],
    ['milestones', 'Stacking Up', 'Issues read, series finished and a full Pull Box.'], ['libraries', 'The Spinner Rack', 'Something from every corner of the collection.'],
    ['eras', 'Crisis on Infinite Shelves', 'Every age, every publisher, every kind of comic.'], ['genres', 'Genre Hopper', 'A badge for every genre you read.'],
    ['habits', 'Wednesday Warriors', 'New Comic Book Day, streaks and binges.'], ['household', 'Around the Shop', 'Requests, reports, recaps and being first.'],
    ['legendary', 'Secret Files and Origins', 'Famous stories, hidden until someone reads one to the end. Follow the hints.'],
    ['secret', 'Easter Eggs', 'Hidden surprises. You find these by accident.']]; // titles renamed 2026-11-10; ids unchanged

  app.get('/api/achievements', requireAuth, (req, res) => {
    try {
      const me = String(req.user.sub);
      const who = req.query.user ? String(req.query.user) : me;
      const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(who);
      if (!user) return res.status(404).json({ error: 'Reader not found' });
      if (who === me) evaluate(me);
      const progress = progressFor(who);
      const earned = new Map(db.prepare('SELECT achievement_id, earned_at FROM user_achievements WHERE user_id = ?').all(who).map(r => [r.achievement_id, r.earned_at]));
      const holders = new Map(db.prepare('SELECT achievement_id, COUNT(*) AS n FROM user_achievements GROUP BY achievement_id').all().map(r => [r.achievement_id, r.n]));
      const readers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
      const defs = allDefs();
      const items = defs.map(d => {
        const e = earned.get(d.id), p = progress.get(d.id) || { have: 0, need: 1 };
        return { ...publicDef(d, !!e), earned_at: e || null, have: d.hidden && !e ? null : Math.min(p.have, p.need), need: d.hidden && !e ? null : p.need,
          note: d.hidden && !e ? null : p.note, holders: holders.get(d.id) || 0 };
      });
      const groups = GROUPS.map(([id, title, blurb]) => ({ id, title, blurb, items: items.filter(i => i.group === id) })).filter(g => g.items.length);
      const recent = items.filter(i => i.earned_at).sort((a, b) => String(b.earned_at).localeCompare(String(a.earned_at))).slice(0, 6);
      const closest = items.filter(i => !i.earned_at && !i.hidden && i.need > 1 && i.have > 0).sort((a, b) => (b.have / b.need) - (a.have / a.need)).slice(0, 4);
      const leaderboard = db.prepare(`SELECT u.id, u.username, (SELECT COUNT(*) FROM user_achievements a WHERE a.user_id = u.id) AS count,
        (SELECT MAX(earned_at) FROM user_achievements a WHERE a.user_id = u.id) AS last FROM users u ORDER BY count DESC, last ASC, u.username`).all()
        .map(r => ({ id: String(r.id), username: r.username, count: r.count }));
      res.json({ user: { id: String(user.id), username: user.username }, me: who === me, readers, since: launchedAt,
        earned: earned.size, total: defs.length, groups, recent, closest, leaderboard });
    } catch (e) {
      logger.error('achievements', 'Achievements page failed', { error: e.message });
      res.status(500).json({ error: e.message });
    }
  });
  // New achievements the reader has not been shown yet (the toast); checks state ones too.
  app.get('/api/achievements/unseen', requireAuth, (req, res) => {
    try {
      const me = String(req.user.sub);
      evaluate(me);
      const byId = new Map(allDefs().map(d => [d.id, d]));
      const rows = db.prepare('SELECT achievement_id, earned_at FROM user_achievements WHERE user_id = ? AND seen = 0 ORDER BY earned_at').all(me);
      res.json({ items: rows.map(r => byId.get(r.achievement_id)).filter(Boolean).map(d => publicDef(d, true)) });
    } catch (e) { res.json({ items: [], error: e.message }); }
  });
  app.post('/api/achievements/seen', requireAuth, (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).slice(0, 500);
    const up = db.prepare('UPDATE user_achievements SET seen = 1 WHERE user_id = ? AND achievement_id = ?');
    db.transaction(() => { for (const id of ids) up.run(String(req.user.sub), id); })();
    res.json({ ok: true });
  });

  return { recordFinish, evaluate, progressFor, allDefs, bump, launchedAt: () => launchedAt };
};
