'use strict';
// ─── Crossover links (2026-11-22) ────────────────────────────────────
// Small crossovers: one story continuing across two series, e.g. Green Lantern #40 → Green Lantern
// Corps #22 ("First Light") or Absolute Wonder Woman #15 → Absolute Batman #16. Large crossovers stay
// Timeline events; reading order and shelves do not change. Readers see the link on the reader's end
// card ("Story continues in …", series reading only) and on the issue page. Design, measurements and
// costs: claude/CROSSOVERS.md.
//
// Two sources, one table (crossover_links):
//   summary  free. A ComicInfo summary that names the other issue ("Continued in SECRET SIX #29").
//            Covers most of the back catalog (older Comic Vine summaries); rebuilt every night.
//   web      paid, off unless the admin turns it on (Settings › AI & Comic Book Guy › Crossover links:
//            weekly, monthly or "Check now"). One Web Search question per new issue, a cheap model
//            lists the stories in the notes, and code keeps a link only when ONE source page names
//            both issues. About 0.11¢ an issue (pilot, 2026-11-21).
// Rules (pilot findings):
//   - a library book is found by its own ComicInfo series name (else its folder), so a one-shot filed
//     on a series shelf ("Batman: Bad Seeds – Sunset #1" in Batman (2025)) is not "Batman #1";
//   - the two books of a link came out at most 120 days apart;
//   - each issue keeps only its nearest link each way (a page about a collection names issues that
//     are not neighbours in the story);
//   - links between books that share a Timeline event, or that the series' reading order already
//     puts together, are not shown.
// Two switches (user, 2026-11-22: admins who install from GitHub choose how the app finds links):
//   code (crossover_code_enabled, on unless '0'): the free nightly pass over issue text and its links
//   AI   (crossover_ai_enabled, off unless '1'): the web check, its schedule and spend, and its links
// A switch that is off hides its source's links too (user's choice); they are kept, so switching back on
// shows them at once. Both off: no crossover links anywhere. Before the switches there was one,
// crossover_links_enabled: '0' there still turns both off, and an install that already scheduled or ran
// web checks counts as AI on until the admin chooses.
const T = require('./crossoverText');
const W = require('./crossoverWiki');

const NEEDS = ['app', 'db', 'ai', 'webLookup', 'readPage', 'axios', 'cron', 'getSetting', 'setSetting', 'logger', 'requireAuth', 'requireAdmin', 'sequence', 'modelCatalog'];
const MAX_GAP_DAYS = 120;          // the two books of a link
const MATCH_DAYS = 150;            // a part named by the AI → a library book released this near the asked issue
const LOOKBACK_DAYS = 180;         // web check: issues released this recently
const COST_PER_BOOK = 0.0011;      // USD, the pilot's average; replaced by the measured average once there are runs
// Daily (2026-11-22): each issue is still asked once, so it costs the same as weekly and checks sooner.
const FREQUENCIES = { off: null, daily: 1, weekly: 7, monthly: 30 };
const RECENT_DAYS = 90;            // fan wikis: issues this recent are read again weekly

function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS crossover_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    from_book_id TEXT, from_series TEXT NOT NULL, from_issue TEXT NOT NULL, from_year INTEGER,
    to_book_id TEXT, to_series TEXT NOT NULL, to_issue TEXT NOT NULL, to_year INTEGER,
    story TEXT, source TEXT NOT NULL, proof TEXT, found_at INTEGER NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_crossover_links_from ON crossover_links(from_book_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_crossover_links_to ON crossover_links(to_book_id)');
  db.exec(`CREATE TABLE IF NOT EXISTS crossover_wiki_pairs (
    book_id TEXT NOT NULL, first_key TEXT NOT NULL, second_key TEXT NOT NULL,
    PRIMARY KEY (book_id, first_key, second_key))`);
  db.exec(`CREATE TABLE IF NOT EXISTS crossover_checks (
    book_id TEXT PRIMARY KEY, checked_at INTEGER NOT NULL, result TEXT, cost REAL)`);
  // Fan wikis (crossoverWiki.js): each series' wiki volume (vol 0 = not found) and each issue read.
  db.exec(`CREATE TABLE IF NOT EXISTS crossover_wiki_series (
    key TEXT PRIMARY KEY, wiki TEXT NOT NULL, name TEXT NOT NULL, vol INTEGER NOT NULL, checked_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS crossover_wiki_books (
    book_id TEXT PRIMARY KEY, checked_at INTEGER NOT NULL, page TEXT, links INTEGER NOT NULL DEFAULT 0,
    story_reviewed INTEGER NOT NULL DEFAULT 0)`);
  if (!db.prepare('PRAGMA table_info(crossover_wiki_books)').all().some(c => c.name === 'story_reviewed')) {
    db.exec('ALTER TABLE crossover_wiki_books ADD COLUMN story_reviewed INTEGER NOT NULL DEFAULT 0');
  }
}

// ── The library ───────────────────────────────────────────────────────
const CI_FIELD = f => `CASE WHEN instr(b.comicinfo, '<${f}>') > 0 THEN substr(b.comicinfo, instr(b.comicinfo, '<${f}>') + ${f.length + 2},
  instr(b.comicinfo, '</${f}>') - instr(b.comicinfo, '<${f}>') - ${f.length + 2}) END`;
const loose = s => T.norm(String(s || '').replace(/\b(?:the|and)\b/gi, ' '));

function loadLibrary(db) {
  const books = db.prepare(`SELECT b.id, b.series_id, s.name AS folder, s.year, b.issue_number, b.store_date, b.cv_issue_id,
      ${CI_FIELD('Series')} AS ci_series, ${CI_FIELD('Publisher')} AS publisher, b.title, ${CI_FIELD('Title')} AS ci_title
    FROM scanned_books b JOIN scanned_series s ON s.id = b.series_id`).all();
  const byKey = new Map();
  const put = (k, b) => { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(b); };
  const byId = new Map();
  for (const b of books) {
    b.ci_series = b.ci_series ? T.decode(b.ci_series).trim() : '';
    b.publisher = b.publisher ? T.decode(b.publisher).trim() : '';
    // A book's own series name; its folder's only when it has none (pilot: one-shots on a series shelf).
    b.series = T.stripYear(b.ci_series || b.folder);
    const n = T.num(b.issue_number);
    put(`${T.norm(b.series)}|${n}`, b);
    const l = loose(b.series);
    if (l !== T.norm(b.series)) put(`~${l}|${n}`, b);
    byId.set(b.id, b);
  }
  const find = (series, issue) => {
    const n = T.num(issue), name = T.stripYear(series);
    return byKey.get(`${T.norm(name)}|${n}`) || byKey.get(`~${loose(name)}|${n}`) || [];
  };
  return { books, byId, find };
}

// Full title variants seen in crossover sources. Keep qualifiers such as Annual and Special.
const crossoverAliases = new Map([
  ['Trinity of Sin: The Phantom Stranger', 'The Phantom Stranger'],
  ['DCU: Rebirth', 'DC Universe: Rebirth'],
  ['Justice Society of America Kingdom Come Special Superman', 'JSA Kingdom Come Special: Superman'],
  ['Emperor Joker', 'Superman: Emperor Joker'],
  ['Comics Giveaway Day 2026: Armageddon / X-Men', 'Armageddon/X-Men CGD 2026'],
  ['Wonder Woman Annual: Wonder War - The Matriarch', 'Wonder Woman 2026 Annual: Wonder War - The Matriarch Special'],
].map(([source, catalog]) => [T.norm(source), catalog]));
const publishedKey = name => T.norm(String(name).replace(/\bthe\b/gi, ' '));

function publishedMatcher(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='book_ci_index'").get()) return () => null;
  const lookup = db.prepare('SELECT book_id, series_name, volume_year, cv_issue_id FROM book_ci_index WHERE orig_number = ?');
  const dates = db.prepare(`SELECT b.store_date, ${CI_FIELD('Year')} AS pub_year FROM scanned_books b WHERE b.id = ?`);
  return (name, number, year, anchor) => {
    const catalog = crossoverAliases.get(T.norm(name)) || name;
    const key = publishedKey(catalog);
    const candidates = lookup.all(T.num(number)).filter(b => b.series_name && publishedKey(b.series_name) === key
      && (!year || Number(b.volume_year) === Number(year)));
    const matches = candidates.filter(b => {
      const date = dates.get(b.book_id);
      if (!date || b.book_id === anchor.id) return false;
      if (date.store_date) return T.days(date.store_date, anchor.store_date) <= MAX_GAP_DAYS;
      return candidates.length === 1 && /\bannual\b/i.test(name) && b.cv_issue_id
        && T.norm(name) === T.norm(b.series_name) && date.pub_year === anchor.store_date.slice(0, 4);
    });
    return matches.length === 1 ? matches[0].book_id : null;
  };
}

// The library book for a named issue, released nearest `anchor` and at most `maxDays` from it.
function nearest(cands, anchor, maxDays) {
  const best = cands.filter(b => b.store_date).sort((x, y) => T.days(x.store_date, anchor) - T.days(y.store_date, anchor))[0];
  return best && T.days(best.store_date, anchor) <= maxDays ? best : null;
}

// ── Links from issue text (free) ───────────────────────────────────────
// Two clues, one pass (user, 2026-11-22: fold titles into the code matcher rather than a new tool):
//   summary  the summary names the other issue ("Continued in SECRET SIX #29"): ordered by release date,
//            the wording only breaking a tie ("continued from X" puts X first)
//   title    the same story title with part numbers in two series: "First Light, Part 1" (Green Lantern
//            #40) and "First Light, Part Two" (Green Lantern Corps #22); also a summary's quoted
//            '"Black Circle: Urban Knights" Part 2 of 6'. Same publisher; the next part 1–3 numbers on
//            and at most 60 days apart, so two series' own arcs that share a name ("Rebirth, Part 1" in
//            each) are not linked; ordered by part number (Cable #75 Part 1 came out after Uncanny X-Men
//            #376 Part 2).
const TITLE_GAP_DAYS = 60;
function textLinks(db, lib = loadLibrary(db)) {
  const rows = db.prepare(`SELECT b.id, b.comicinfo FROM scanned_books b WHERE b.comicinfo LIKE '%<Summary>%' AND (
      b.comicinfo LIKE '%continu%' OR b.comicinfo LIKE '%conclud%' OR b.comicinfo LIKE '%crossover%' OR b.comicinfo LIKE '%crosses over%'
      OR b.comicinfo LIKE '%chapter%' OR b.comicinfo LIKE '%part %' OR b.comicinfo LIKE '%pick% up%' OR b.comicinfo LIKE '%into%' OR b.comicinfo LIKE '%miss%')`).iterate();
  const out = new Map();
  const summaryParts = new Map();
  for (const r of rows) {
    const a = lib.byId.get(r.id);
    if (!a?.store_date) continue;
    for (const m of T.summaryMentions(r.comicinfo)) {
      let cands = lib.find(m.series, m.issue);
      if (!cands.length && m.tail) cands = lib.find(m.tail, m.issue);
      cands = cands.filter(b => b.id !== a.id && b.series_id !== a.series_id);
      const b = nearest(cands, a.store_date, MAX_GAP_DAYS);
      if (!b) continue;
      const fromWording = /\b(?:from|picks? up)\b/i.test(m.phrase);
      const aFirst = a.store_date !== b.store_date ? a.store_date < b.store_date : !fromWording;
      const [x, y] = aFirst ? [a, b] : [b, a];
      const key = `s:${x.id}>${y.id}`;
      if (!out.has(key)) out.set(key, { key, from: x, to: y, story: null, source: 'summary', proof: m.phrase });
    }
    const sm = /<Summary>([\s\S]*?)<\/Summary>/.exec(r.comicinfo || '');
    const parts = sm ? T.summaryParts(sm[1]) : [];
    if (parts.length) summaryParts.set(r.id, parts);
  }
  for (const l of titleLinks(lib, summaryParts)) if (!out.has(l.key)) out.set(l.key, l);
  return [...out.values()];
}
const summaryLinks = textLinks;   // the earlier name (tests, scripts)

function titleLinks(lib, summaryParts = new Map()) {
  // Publisher: the book's, else its series' most common (Green Lantern (1990) #96 has none).
  const seriesPub = new Map();
  for (const b of lib.books) if (b.publisher) {
    const m = seriesPub.get(b.series_id) || new Map();
    m.set(b.publisher, (m.get(b.publisher) || 0) + 1);
    seriesPub.set(b.series_id, m);
  }
  const pubOf = sid => [...(seriesPub.get(sid) || new Map())].sort((x, y) => y[1] - x[1])[0]?.[0] || '';
  const pubKey = b => T.norm(b.publisher || pubOf(b.series_id)).slice(0, 5);
  const groups = new Map();
  for (const b of lib.books) {
    if (!b.store_date) continue;
    const parts = [...T.storyParts(b.ci_title || ''), ...T.storyParts(b.title || ''), ...(summaryParts.get(b.id) || [])];
    for (const p of parts) for (const k of p.keys) {
      const g = `${k}|${pubKey(b)}`;
      if (!groups.has(g)) groups.set(g, new Map());
      if (!groups.get(g).has(b.id)) groups.get(g).set(b.id, { b, part: p.part, story: p.story });
    }
  }
  const out = [];
  for (const g of groups.values()) {
    const items = [...g.values()];
    if (new Set(items.map(x => x.b.series_id)).size < 2) continue;
    // Story names come back years later: one run of the story = releases no more than 120 days apart.
    items.sort((x, y) => x.b.store_date.localeCompare(y.b.store_date));
    const runs = [[items[0]]];
    for (let i = 1; i < items.length; i++) {
      if (T.days(items[i - 1].b.store_date, items[i].b.store_date) > 120) runs.push([]);
      runs.at(-1).push(items[i]);
    }
    for (const run of runs) {
      run.sort((x, y) => (x.part - y.part) || x.b.store_date.localeCompare(y.b.store_date));
      // A part number two series both have means two stories with one name, not one story across them:
      // Green Lantern (1990) #83–85 "Retribution, Part 1–3" and The Spectre #52 "Retribution, Part 1" (user,
      // 2026-11-22), or an event's tie-ins numbered in each series (Fear Itself in New Avengers and Secret
      // Avengers). Such parts are not linked (32 of 903 title links on the 2026-11-21 database).
      const holders = new Map();
      for (const x of run) { const h = holders.get(x.part) || new Set(); h.add(x.b.series_id); holders.set(x.part, h); }
      const shared = x => holders.get(x.part).size > 1;
      for (let i = 0; i + 1 < run.length; i++) {
        const a = run[i], c = run[i + 1], step = c.part - a.part;
        if (a.b.series_id === c.b.series_id || step < 1 || step > 3 || T.days(a.b.store_date, c.b.store_date) > TITLE_GAP_DAYS) continue;
        if (shared(a) || shared(c)) continue;
        // The next part released well before this one: not one story (The Spectre #52 "Part 1" came out eight
        // weeks after Green Lantern #84 "Part 2"). Up to 30 days is allowed: parts do ship out of order
        // (Cable #75 Part 1 three weeks after Uncanny X-Men #376 Part 2). On 2026-11-21: 1 of 875 removed.
        if (Date.parse(c.b.store_date) - Date.parse(a.b.store_date) < -30 * 86400000) continue;
        out.push({ key: `t:${a.b.id}>${c.b.id}`, from: a.b, to: c.b, story: [a.story, c.story].sort((x, y) => x.length - y.length)[0], source: 'title',
          proof: `"${a.story}" part ${a.part} → part ${c.part}` });
      }
    }
  }
  return out;
}

// ── Web check (per issue) ─────────────────────────────────────────────
// What counts (user, 2026-11-22: "crossover" means many things to a model, so spell it out). The search
// question stays a plain question (Gemini skips searching when asked for a reply format); the extraction
// prompt carries the full definition and examples, since it decides what is kept.
const NOT_CROSSOVERS = 'Guest appearances, one-issue team-ups, tie-ins to big line-wide events, and stories told within a single series do not count.';
const EXTRACT = notes => `Below are notes from a web search about a comic book issue or series. List only CROSSOVER STORIES, as defined here.

A crossover story is ONE plot whose chapters are published in issues of two or more DIFFERENT series and are read in order: the story starts in one series and continues in another. Sources usually say so: "continued in", "continued from", "part 2 of 4", "concludes in", "a crossover between X and Y". Examples:
- "First Light": Green Lantern #40 → Green Lantern Corps #22 → Green Lantern #41 → Green Lantern Corps #23
- "The Mark of Hecate": Absolute Wonder Woman #15 → Absolute Batman #16
- "Big Guns": Wade Wilson: Deadpool #8 → The Punisher #8 → Wade Wilson: Deadpool #9 → The Punisher #9

NOT crossover stories (leave these out):
- a guest appearance: a character appears in another series, but the plot does not continue there
- a team-up told complete in one issue
- tie-ins to a large line-wide event with many titles and its own event series (e.g. Infinite Crisis, Secret Wars)
- a story told in one series only, even when it is called "Part 3"
- an issue that refers back to older stories ("as seen in Swamp Thing #87")
- a series that continues under a new title or in a new volume (relaunch or renumbering)
- reprints, collected editions, connecting or variant covers, previews and backup stories advertising another title
- anything the notes are unsure about

Reply with JSON only, no other text:
{"stories":[{"name":"story name","parts":[{"series":"series name without the year","year":2025,"issue":"22","part":2}]}]}
"year" is the volume year (the year that series started, which can be long before the issue came out). List every part in reading order, including parts in the series the notes are about. Use "stories":[] when there are none.

Notes:
${notes}`;

const bookQuestion = b => `Is the story in ${b.series}${b.year ? ` (${b.year})` : ''} #${T.num(b.issue_number)} (released ${b.store_date}${b.publisher ? `, ${b.publisher}` : ''}) part of a crossover: one story whose chapters run across issues of two or more different series, such as part 1 in one series and part 2 in another? If so, name the story and list every chapter in reading order with its series, volume year and issue number. ${NOT_CROSSOVERS}`;

// One question for a whole volume (backfill test, 2026-11-22).
const volumeQuestion = v => `Which stories in ${v.name} (${v.year}), published by ${v.publisher} from ${v.first.slice(0, 7)} to ${v.last.slice(0, 7)}, were crossovers: one story whose chapters ran across issues of ${v.name} and a different series, such as part 1 in ${v.name} and part 2 in another title? Name each such story and list every chapter in reading order with its series, volume year and issue number. Guest appearances, one-issue team-ups, tie-ins to big line-wide events, and stories told within ${v.name} alone do not count.`;

// The proven links in one answer: neighbouring parts in different series that ONE page names together
// (each page on its own, so a wrongly added part does not hide a link a page proves). Pure, for tests.
function provenLinks(stories, pages) {
  const out = [];
  for (const st of stories || []) {
    const parts = (st.parts || []).filter(p => p && p.series && p.issue != null && p.issue !== '');
    const seen = new Set();
    for (const page of pages) {
      if (!page?.text) continue;
      const named = parts.map((p, i) => (T.namedOnPage(page.text, p) ? i : -1)).filter(i => i >= 0);
      for (let k = 0; k + 1 < named.length; k++) {
        const a = parts[named[k]], b = parts[named[k + 1]];
        if (T.norm(T.stripYear(a.series)) === T.norm(T.stripYear(b.series))) continue;
        const key = `${named[k]}|${named[k + 1]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ story: String(st.name || '').slice(0, 120) || null, from: a, to: b, page: page.url });
      }
    }
  }
  return out;
}

// Library books of the volume a part names: its volume year within 5 of the AI's (folder years and
// Comic Vine's differ: Swamp Thing (1982) is filed as 1986). No year given: any.
const sameVolume = (cands, year) => cands.filter(c => !year || !c.year || Math.abs(Number(c.year) - Number(year)) <= 5);

// A proven link → a row: each end matched to the library (near the asked issue's date), both ends'
// dates no more than MAX_GAP_DAYS apart, at least one end in the library.
function linkRow(lib, link, anchor) {
  const end = p => {
    const cands = lib.find(p.series, p.issue);
    const book = nearest(cands, anchor, MATCH_DAYS);
    const year = Number(p.year) || null;
    // The library has this issue, but from another time: the page named an old issue the story looks
    // back to (first web run: "Time Upon a Once" → Swamp Thing #80 and #87 from 1988–89), not a missing part.
    // Only when the named volume is the one owned: Green Lantern (2023) #41 is still a missing part when
    // Green Lantern (1990) #41 is in the library.
    return { book, old: !book && sameVolume(cands, year).length > 0, series: T.stripYear(p.series), issue: T.num(p.issue), year };
  };
  const a = end(link.from), b = end(link.to);
  if (!a.book && !b.book) return null;
  if (a.old || b.old) return null;
  if (a.book && b.book && (a.book.id === b.book.id || a.book.series_id === b.book.series_id && T.norm(a.series) === T.norm(b.series))) return null;
  if (a.book && b.book && T.days(a.book.store_date, b.book.store_date) > MAX_GAP_DAYS) return null;
  const k = e => e.book ? e.book.id : `${T.norm(e.series)}#${e.issue}`;
  return { key: `w:${k(a)}>${k(b)}`, from: a.book, to: b.book, fromName: a, toName: b, story: link.story, source: 'web', proof: link.page };
}

// One wiki reference → a row: the named issue matched near the page's book (120 days); an owned issue of
// that name far away is an old story the page looks back to, not a part (as for the web check).
function wikiRow(lib, book, ref, event, proof) {
  // The same series' next issue ("continues in Green Lantern Vol 3 66") is not a crossover, owned or not.
  if ([book.series, book.folder].some(n => n && T.norm(W.wikiName(n)) === T.norm(ref.series))) return null;
  const cands = lib.find(ref.series, ref.issue).filter(x => x.id !== book.id);
  const other = nearest(cands, book.store_date, MAX_GAP_DAYS);
  if (!other && cands.some(x => x.store_date)) return null;
  if (other && other.series_id === book.series_id && T.norm(other.series) === T.norm(book.series)) return null;   // same series: not a crossover
  // An issue not owned: only a next part ("continues in"). "Continued from" an issue not in the library was
  // mostly a story looked back to (Giant-Size Avengers #4 for Fantastic Four #325; wiki test 2026-11-22).
  if (!other && ref.dir !== 'in') return null;
  // A next part released well before (or an earlier part well after): the wiki's wording, not reading order.
  if (other && (ref.dir === 'in' ? 1 : -1) * (Date.parse(other.store_date) - Date.parse(book.store_date)) < -45 * 86400000) return null;
  const name = { series: ref.series, issue: T.num(ref.issue), year: null };
  const [from, to, fromName, toName] = ref.dir === 'in' ? [book, other, null, name] : [other, book, name, null];
  const k = (b, n) => (b ? b.id : `${T.norm(n.series)}#${n.issue}`);
  return { key: `k:${k(from, fromName)}>${k(to, toName)}`, from, to, fromName, toName, story: event, source: 'wiki', proof };
}

function createCrossovers(deps = {}) {
  const missing = NEEDS.filter(n => !deps[n]);
  if (missing.length) throw new Error(`createCrossovers: missing ${missing.join(', ')}`);
  const { app, db, ai, webLookup, readPage, axios, cron, getSetting, setSetting, logger, requireAuth, requireAdmin, sequence, modelCatalog } = deps;
  schema(db);

  const insert = db.prepare(`INSERT INTO crossover_links (key, from_book_id, from_series, from_issue, from_year, to_book_id, to_series, to_issue, to_year, story, source, proof, found_at)
    VALUES (@key, @from_book_id, @from_series, @from_issue, @from_year, @to_book_id, @to_series, @to_issue, @to_year, @story, @source, @proof, @found_at)
    ON CONFLICT(key) DO UPDATE SET story = COALESCE(crossover_links.story, excluded.story), proof = COALESCE(crossover_links.proof, excluded.proof),
      from_book_id = COALESCE(crossover_links.from_book_id, excluded.from_book_id), to_book_id = COALESCE(crossover_links.to_book_id, excluded.to_book_id)`);
  const rowOf = l => ({
    key: l.key, story: l.story || null, source: l.source, proof: l.proof ? String(l.proof).slice(0, 300) : null, found_at: Date.now(),
    from_book_id: l.from?.id || null, from_series: l.from ? l.from.series : l.fromName.series, from_issue: l.from ? T.num(l.from.issue_number) : l.fromName.issue,
    from_year: l.from ? Number(l.from.year) || null : l.fromName?.year || null,
    to_book_id: l.to?.id || null, to_series: l.to ? l.to.series : l.toName.series, to_issue: l.to ? T.num(l.to.issue_number) : l.toName.issue,
    to_year: l.to ? Number(l.to.year) || null : l.toName?.year || null,
  });

  const published = publishedMatcher(db);
  function matchPublished(row, anchor) {
    if (!anchor?.store_date || !!row.from_book_id === !!row.to_book_id) return;
    const side = row.from_book_id ? 'to' : 'from';
    row[`${side}_book_id`] = published(row[`${side}_series`], row[`${side}_issue`], row[`${side}_year`], anchor);
  }
  function saveExternal(link) {
    const row = rowOf(link);
    matchPublished(row, link.from || link.to);
    return insert.run(row);
  }

  // Nightly, free: rebuild the links from issue text; give web links whose other issue has since arrived its book.
  function refreshFree() {
    const t0 = Date.now();
    const lib = loadLibrary(db);
    const links = textLinks(db, lib);
    const keep = new Set(links.map(l => l.key));
    const old = db.prepare(`SELECT key FROM crossover_links WHERE source IN ('summary', 'title')`).all().map(r => r.key);
    let added = 0, removed = 0, resolved = 0;
    db.transaction(() => {
      for (const l of links) if (insert.run(rowOf(l)).changes && !old.includes(l.key)) added++;
      const del = db.prepare('DELETE FROM crossover_links WHERE key = ?');
      for (const k of old) if (!keep.has(k)) { del.run(k); removed++; }
      resolved = resolvePending(lib);
      // A web link whose book was removed from the library: forget the book (its names stay).
      db.prepare(`UPDATE crossover_links SET from_book_id = NULL WHERE from_book_id IS NOT NULL AND from_book_id NOT IN (SELECT id FROM scanned_books)`).run();
      db.prepare(`UPDATE crossover_links SET to_book_id = NULL WHERE to_book_id IS NOT NULL AND to_book_id NOT IN (SELECT id FROM scanned_books)`).run();
    })();
    const r = { summary: links.filter(l => l.source === 'summary').length, title: links.filter(l => l.source === 'title').length, added, removed, resolved, ms: Date.now() - t0 };
    logger.info('crossovers', 'Links from issue text refreshed', r);
    return r;
  }

  // Web links with an issue that was not in the library: match it now (near the other end's date).
  function resolvePending(lib) {
    const rows = db.prepare(`SELECT * FROM crossover_links WHERE source IN ('web', 'wiki') AND (from_book_id IS NULL OR to_book_id IS NULL)`).all();
    const set = db.prepare('UPDATE crossover_links SET from_book_id = ?, to_book_id = ? WHERE id = ?');
    const drop = db.prepare('DELETE FROM crossover_links WHERE id = ?');
    let n = 0;
    for (const r of rows) {
      const other = lib.byId.get(r.from_book_id || r.to_book_id);
      if (!other?.store_date) continue;
      const side = r.from_book_id ? 'to' : 'from';
      const cands = lib.find(r[`${side}_series`], r[`${side}_issue`]).filter(b => b.id !== other.id);
      const b = nearest(cands, other.store_date, MAX_GAP_DAYS)
        || lib.byId.get(published(r[`${side}_series`], r[`${side}_issue`], r[`${side}_year`], other));
      // Owned, but released far from the other issue: an old issue the story looks back to (see linkRow).
      if (!b && sameVolume(cands, r[`${side}_year`]).some(c => c.store_date && T.days(c.store_date, other.store_date) > MATCH_DAYS)) { drop.run(r.id); continue; }
      if (!b) continue;
      set.run(side === 'from' ? b.id : r.from_book_id, side === 'to' ? b.id : r.to_book_id, r.id);
      n++;
    }
    return n;
  }

  // ── What readers see ──────────────────────────────────────────────
  const bookInfo = db.prepare(`SELECT b.id, b.series_id, b.issue_number, b.store_date, s.name AS folder, ${CI_FIELD('Series')} AS ci_series
    FROM scanned_books b JOIN scanned_series s ON s.id = b.series_id WHERE b.id = ?`);
  const linksOut = db.prepare('SELECT * FROM crossover_links WHERE from_book_id = ? AND hidden = 0');
  const linksIn = db.prepare('SELECT * FROM crossover_links WHERE to_book_id = ? AND hidden = 0');
  const pairedNext = db.prepare(`SELECT b.* FROM crossover_wiki_pairs p
    JOIN crossover_links a ON a.key = p.first_key AND a.hidden = 0
    JOIN crossover_links b ON b.key = p.second_key AND b.hidden = 0
    WHERE p.book_id = ? AND a.to_book_id = ? AND a.from_book_id = p.book_id AND b.from_book_id = p.book_id`);
  const sharedEvent = db.prepare(`SELECT 1 FROM event_issues a JOIN event_issues b ON b.event_id = a.event_id JOIN events e ON e.id = a.event_id
    WHERE a.scanned_book_id = ? AND b.scanned_book_id = ? AND COALESCE(e.draft, 0) = 0 LIMIT 1`);
  const dateOf = id => (id ? bookInfo.get(id)?.store_date : null);

  // Is this link the nearest one for both of its books (out of its first book, into its second)?
  function nearestBothWays(l) {
    const gap = r => T.days(dateOf(r.from_book_id), dateOf(r.to_book_id));
    const g = gap(l);
    const beats = (others) => others.every(o => o.id === l.id || samePair(o, l) || gap(o) > g || (gap(o) === g && o.id > l.id));
    if (l.from_book_id && !beats(linksOut.all(l.from_book_id).filter(o => o.to_book_id && sourceOn(o.source)))) return false;
    if (l.to_book_id && !beats(linksIn.all(l.to_book_id).filter(o => o.from_book_id && sourceOn(o.source)))) return false;
    return true;
  }
  const samePair = (a, b) => a.from_book_id === b.from_book_id && a.to_book_id === b.to_book_id;

  // The Timeline events a book is in, with every issue they list (owned or not).
  const eventsOf = db.prepare(`SELECT e.id, e.name, x.series_name, x.issue_number FROM event_issues a JOIN events e ON e.id = a.event_id
    JOIN event_issues x ON x.event_id = e.id WHERE a.scanned_book_id = ? AND COALESCE(e.draft, 0) = 0`);
  // A link to an issue not in the library is a Timeline's when the owned book's event lists that issue
  // or has the story's name (pilot: Poison Ivy #49 → Batman: Bad Seeds – Sunrise #1).
  function inOwnersEvent(ownedId, series, issue, story) {
    let rows;
    try { rows = eventsOf.all(ownedId); } catch { return false; }
    const s = T.norm(T.stripYear(series)), n = T.num(issue), st = T.norm(story);
    return rows.some(r => (T.norm(T.stripYear(r.series_name)) === s && T.num(r.issue_number) === n)
      || (st && st === T.norm(r.name))   // short names ("DNX") only when equal
      || (st.length >= 5 && T.norm(r.name).length >= 5 && (T.norm(r.name).includes(st) || st.includes(T.norm(r.name)))));
  }

  function shown(l) {
    if (!sourceOn(l.source)) return false;
    if (!l.from_book_id || !l.to_book_id) {
      const side = l.from_book_id ? 'to' : 'from';
      return !inOwnersEvent(l.from_book_id || l.to_book_id, l[`${side}_series`], l[`${side}_issue`], l.story);
    }
    {
      if (!nearestBothWays(l)) return false;
      try { if (sharedEvent.get(l.from_book_id, l.to_book_id)) return false; } catch { /* no events table */ }
      const a = bookInfo.get(l.from_book_id), b = bookInfo.get(l.to_book_id);
      if (!a || !b) return false;
      try {
        if ((sequence(a.series_id) || []).includes(b.id) || (sequence(b.series_id) || []).includes(a.id)) return false;
      } catch { /* placement unavailable: show */ }
    }
    return true;
  }

  const label = (bookId, series, issue) => {
    const b = bookId ? bookInfo.get(bookId) : null;
    if (b) return { id: b.id, series_name: T.stripYear(b.ci_series ? T.decode(b.ci_series) : b.folder), issue_number: b.issue_number, owned: true };
    return { id: null, series_name: series, issue_number: issue, owned: false };
  };

  const legacyOff = () => getSetting('crossover_links_enabled') === '0';
  const codeOn = () => !legacyOff() && getSetting('crossover_code_enabled') !== '0';
  const aiOn = () => {
    const v = getSetting('crossover_ai_enabled');
    if (v === '1' || v === '0') return v === '1';
    if (legacyOff()) return false;
    try { return (getSetting('crossover_check_frequency') || 'off') !== 'off' || !!db.prepare('SELECT 1 FROM crossover_checks LIMIT 1').get(); } catch { return false; }
  };
  const sourceOn = src => (src === 'web' ? aiOn() : codeOn());   // summary, title and wiki are the free sources
  const enabled = () => codeOn() || aiOn();

  // { continuesIn: [...], continuedFrom: [...] } for one book; owned issues first, one entry per issue.
  function forBook(bookId) {
    if (!enabled()) return { continuesIn: [], continuedFrom: [] };
    const pick = (rows, side) => {
      const seen = new Map();
      for (const l of rows) {
        if (!shown(l)) continue;
        const other = label(l[`${side}_book_id`], l[`${side}_series`], l[`${side}_issue`]);
        const k = other.id || `${T.norm(other.series_name)}#${T.num(other.issue_number)}`;
        const cur = seen.get(k);
        if (!cur) seen.set(k, { ...other, story: l.story || null, source: l.source, linkIds: [l.id] });
        else { cur.story = cur.story || l.story || null; cur.linkIds.push(l.id); if (l.source === 'web') cur.source = 'web'; }
      }
      const list = [...seen.values()];
      // An unowned issue is listed only when no owned one is (nearest-link rule for issues not in the library).
      return list.some(x => x.owned) ? list.filter(x => x.owned) : list.slice(0, 1);
    };
    return { continuesIn: pick(linksOut.all(bookId), 'to'), continuedFrom: pick(linksIn.all(bookId), 'from') };
  }
  // The end card's "Story continues in …" (series reading): the first next part.
  const nextFor = bookId => forBook(bookId).continuesIn[0] || null;

  // For the Reading order view (seriesPlacement.js): owned issues of other series linked to this series'
  // books — the next part goes after its issue, an earlier part before its issue. The same rules as the
  // end card (`sequence` is the order without crossovers, so a series does not hide its own links).
  const linksOfSeries = db.prepare(`SELECT l.* FROM crossover_links l JOIN scanned_books a ON a.id = l.from_book_id JOIN scanned_books b ON b.id = l.to_book_id
    WHERE l.hidden = 0 AND (a.series_id = ? OR b.series_id = ?) AND a.series_id <> b.series_id`);
  const linksHalfOfSeries = db.prepare(`SELECT l.* FROM crossover_links l JOIN scanned_books b ON b.id = COALESCE(l.from_book_id, l.to_book_id)
    WHERE l.hidden = 0 AND (l.from_book_id IS NULL OR l.to_book_id IS NULL) AND b.series_id IN (?, ?)`);
  function placementFor(seriesId) {
    if (!enabled()) return [];
    const series = id => bookInfo.get(id)?.series_id;
    // The whole story, not just the neighbouring parts (user, 2026-11-22: Green Lantern #65 and The Siege of
    // the Zi Charam): from an issue of this series, follow the next part through other series until the
    // story ends or comes back to this series (and back the same way). At most 20 parts; each step is a
    // link the rules show (Timeline-covered links are not, so a long crossover in a Timeline stops here).
    // A part not in the library ends the walk; it is shown as a missing issue (user, 2026-11-22: "the way we
    // do other missing issues in a series"), with Get / Request (downloadRequests 'crossover').
    const stepOf = (id, dir) => {
      const list = dir === 'in' ? forBook(id).continuesIn : forBook(id).continuedFrom;
      return list.find(x => x.owned && x.id) || (list[0] && !list[0].owned ? list[0] : null);
    };
    const out = [], seen = new Set();
    const walk = (anchor, dir) => {
      const chain = [], visited = new Set([anchor]);
      let cur = anchor;
      while (chain.length < 20) {
        const n = stepOf(cur, dir);
        if (!n) break;
        if (!n.owned) {   // not this series' own next issue (its missing issues show already)
          const own = bookInfo.get(anchor);
          const ownName = own ? T.norm(T.stripYear(own.ci_series ? T.decode(own.ci_series) : own.folder)) : null;
          if (T.norm(T.stripYear(n.series_name)) !== ownName) chain.push(n);
          break;
        }
        if (visited.has(n.id) || series(n.id) === seriesId) break;
        visited.add(n.id);
        chain.push(n);
        if (dir === 'in' && codeOn() && chain.length < 20) {
          const pairs = pairedNext.all(cur, n.id);
          const pair = pairs.length === 1 && pairs[0];
          const id = pair?.to_book_id;
          if (id && !visited.has(id) && series(id) === series(n.id) && series(id) !== seriesId
            && !sharedEvent.get(cur, id) && !sharedEvent.get(n.id, id)
            && !(sequence(seriesId) || []).includes(id)) {
            chain.push({ ...label(id, pair.to_series, pair.to_issue), story: pair.story, linkIds: [pair.id] });
            visited.add(id);
            cur = id;
            continue;
          }
        }
        cur = n.id;
      }
      if (dir === 'from') chain.reverse();
      const story = chain.find(x => x.story)?.story || null;
      const firstOwned = chain.find(x => x.owned);
      const first = firstOwned ? bookInfo.get(firstOwned.id)?.store_date || null : bookInfo.get(anchor)?.store_date || null;
      chain.forEach((x, i) => {
        const k = x.owned ? `${x.id}|${dir === 'in' ? 'a' : 'b'}` : `m:${T.norm(x.series_name)}#${T.num(x.issue_number)}`;
        if (seen.has(k)) return;
        seen.add(k);
        const where = dir === 'in' ? { afterBookId: anchor } : { beforeBookId: anchor };
        if (x.owned) out.push({ bookId: x.id, ...where, story: x.story || story, chainDate: first, seq: i });
        else {
          const w = missingWhere(x.series_name, x.issue_number, bookInfo.get(anchor)?.store_date);
          out.push({ missing: { series_name: x.series_name, issue_number: x.issue_number, story: x.story || story, linkId: x.linkIds[0],
            status: w.status, date: w.date }, ...where, chainDate: first, seq: i });
        }
      });
    };
    const anchors = new Set();
    // Links with a part not in the library: the owned side is an anchor too.
    for (const l of linksHalfOfSeries.all(seriesId, seriesId)) {
      if (!shown(l)) continue;
      const own = l.from_book_id || l.to_book_id, dir = l.from_book_id ? 'in' : 'from';
      if (series(own) !== seriesId || anchors.has(`${own}|${dir}`)) continue;
      anchors.add(`${own}|${dir}`);
      walk(own, dir);
    }
    for (const l of linksOfSeries.all(seriesId, seriesId)) {
      if (!shown(l)) continue;
      const mine = series(l.from_book_id) === seriesId;
      const k = `${mine ? l.from_book_id : l.to_book_id}|${mine ? 'in' : 'from'}`;
      if (anchors.has(k)) continue;
      anchors.add(k);
      walk(mine ? l.from_book_id : l.to_book_id, mine ? 'in' : 'from');
    }
    // Outgoing first: a book that both follows one issue and leads into the next sits after the first.
    return out.sort((a, b) => (a.afterBookId ? 0 : 1) - (b.afterBookId ? 0 : 1));
  }

  // A crossover part not in the library, as a request row (downloadRequests 'crossover', server.js
  // requestRowFor): the missing side of link `id`, or null when the link is gone, hidden or both owned.
  function missingRow(id) {
    const l = db.prepare('SELECT * FROM crossover_links WHERE id = ? AND hidden = 0').get(id);
    if (!l || (l.from_book_id && l.to_book_id) || !sourceOn(l.source)) return null;
    const side = l.to_book_id ? 'from' : 'to';
    const owned = bookInfo.get(l.from_book_id || l.to_book_id);
    const where = missingWhere(l[`${side}_series`], l[`${side}_issue`], owned?.store_date);
    // The library folder of that series (when there is one) lets the Get box find its monitored issue.
    return { id: l.id, cv_issue_id: where.cv_issue_id, scanned_book_id: null, scanned_series_id: where.scanned_series_id,
      series_name: l[`${side}_series`], issue_number: l[`${side}_issue`], volume_year: where.volume_year || l[`${side}_year`] || null };
  }

  // A missing part's library folder and Download Manager state (user, 2026-11-22: Green Lantern #41 showed
  // "not monitored" though its series is). The folder of that series name whose issues came out nearest the
  // owned part; its monitored issue of that number: { scanned_series_id, volume_year, cv_issue_id, status, date }.
  let folderCache = null;
  const folders = () => {
    if (folderCache && Date.now() - folderCache.at < 600000) return folderCache.map;
    const map = new Map();
    for (const r of db.prepare(`SELECT s.id, s.name, s.year, s.monitored_series_id, MIN(b.store_date) AS first, MAX(b.store_date) AS last
      FROM scanned_series s LEFT JOIN scanned_books b ON b.series_id = s.id GROUP BY s.id`).all()) {
      const k = T.norm(T.stripYear(r.name));
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    folderCache = { at: Date.now(), map };
    return map;
  };
  function missingWhere(series, issue, near) {
    const none = { scanned_series_id: null, volume_year: null, cv_issue_id: null, status: null, date: null };
    try {
      const list = folders().get(T.norm(T.stripYear(series))) || [];
      if (!list.length) return none;
      const dist = f => (!near || !f.first ? 1e9 : near < f.first ? T.days(near, f.first) : near > f.last ? T.days(near, f.last) : 0);
      const f = list.slice().sort((a, b) => dist(a) - dist(b))[0];
      if (dist(f) > 365) return none;
      const out = { ...none, scanned_series_id: f.id, volume_year: f.year || null };
      if (f.monitored_series_id) {
        const n = T.num(issue);
        const mi = db.prepare('SELECT id, issue_number, status, store_date, release_date, is_annual FROM monitored_issues WHERE series_id = ?')
          .all(String(f.monitored_series_id)).find(i => !i.is_annual && T.num(i.issue_number) === n);
        if (mi) Object.assign(out, { cv_issue_id: String(mi.id), status: mi.status || null, date: mi.store_date || mi.release_date || null });
      }
      return out;
    } catch { return none; }
  }

  // ── Fan wikis (free; part of the code switch) ─────────────────────────
  // Reads DC and Marvel issue pages 50 at a time (crossoverWiki.js), at most `maxRequests` a night, so the
  // first pass over a library spreads over a few nights; later nights read only new issues.
  const wiki = W.createWikiClient({ axios, logger });
  const wikiState = { running: false, requests: 0, books: 0, links: 0, startedAt: null, finishedAt: null, error: null };
  async function wikiPass({ maxRequests = 1500 } = {}) {
    if (wikiState.running || !codeOn()) return wikiState;
    Object.assign(wikiState, { running: true, requests: 0, books: 0, links: 0, startedAt: Date.now(), finishedAt: null, error: null });
    const start = wiki.requests();
    const left = () => maxRequests - (wiki.requests() - start);
    try {
      const lib = loadLibrary(db);
      // Read once, except issues out in the last 90 days: read again after a week, because a new issue's page
      // and its "continues in" notes are often added to the wiki weeks after release (user, 2026-11-22).
      // Series with no wiki volume cost no requests (their issues are only marked again).
      const since = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString().slice(0, 10);
      const done = new Set(db.prepare(`SELECT w.book_id FROM crossover_wiki_books w LEFT JOIN scanned_books b ON b.id = w.book_id
        WHERE (w.story_reviewed >= 2 OR w.links = 0) AND NOT (b.store_date >= ? AND w.checked_at < ?)`).all(since, Date.now() - 7 * 86400000).map(r => r.book_id));
      const review = new Map(db.prepare('SELECT book_id, page FROM crossover_wiki_books WHERE story_reviewed < 2 AND links > 0 AND page IS NOT NULL')
        .all().map(r => [r.book_id, r.page]));
      const pubOf = new Map();
      for (const b of lib.books) if (b.publisher && !pubOf.has(b.series_id)) pubOf.set(b.series_id, b.publisher);
      // Groups: one wiki series = folder + the book's own series name (one-shots on a shelf have their own).
      const groups = new Map();
      const queue = [];
      for (const b of lib.books) {
        if (done.has(b.id) || !b.store_date || !b.issue_number) continue;
        const w = W.wikiOf(b.publisher || pubOf.get(b.series_id));
        const name = W.wikiName(b.series);
        if (!w || !name) continue;
        if (review.has(b.id)) {
          queue.push({ w, b, title: review.get(b.id) });
          continue;
        }
        const key = `${w}|${b.series_id}|${name.toLowerCase()}`;
        if (!groups.has(key)) groups.set(key, { key, wiki: w, name, books: [] });
        groups.get(key).books.push(b);
      }
      const getVol = db.prepare('SELECT name, vol FROM crossover_wiki_series WHERE key = ?');
      const putVol = db.prepare('INSERT OR REPLACE INTO crossover_wiki_series (key, wiki, name, vol, checked_at) VALUES (?, ?, ?, ?, ?)');
      const mark = db.prepare('INSERT OR REPLACE INTO crossover_wiki_books (book_id, checked_at, page, links, story_reviewed) VALUES (?, ?, ?, ?, 2)');
      const clearPairs = db.prepare('DELETE FROM crossover_wiki_pairs WHERE book_id = ?');
      const addPair = db.prepare('INSERT OR IGNORE INTO crossover_wiki_pairs VALUES (?, ?, ?)');
      const retire = db.prepare("DELETE FROM crossover_links WHERE key = ? AND source = 'wiki' AND proof = ? AND hidden = 0");
      // 1. Volumes not known yet (crossoverWiki.findVolumes: Vol 1–10, then other spellings of the name).
      const unknown = [...groups.values()].filter(g => getVol.get(g.key) == null);
      for (const w of Object.keys(W.WIKIS)) {
        if (left() <= 0 || !codeOn()) break;
        const list = unknown.filter(g => g.wiki === w).map(g => {
          const probe = g.books.find(b => /^\d+$/.test(T.num(b.issue_number))) || g.books[0];
          return { key: g.key, name: g.name, series: g.books[0].series, probe: { issue: T.num(probe.issue_number), store_date: probe.store_date } };
        });
        const found = await W.findVolumes(wiki, w, list, left);
        for (const [key, v] of found) putVol.run(key, w, v.name, v.vol, Date.now());
      }
      // 2. Issue pages of series with a volume, 50 to a request; series without one are marked read.
      for (const g of groups.values()) {
        const found = getVol.get(g.key);
        if (!found) continue;                              // not probed yet (request limit): next night
        if (!found.vol) { db.transaction(() => { for (const b of g.books) mark.run(b.id, Date.now(), null, 0); })(); continue; }
        for (const b of g.books) queue.push({ w: g.wiki, b, title: W.pageTitle(found.name, found.vol, T.num(b.issue_number)) });
      }
      for (const w of Object.keys(W.WIKIS)) {
        const list = queue.filter(q => q.w === w);
        for (let i = 0; i < list.length && left() > 0 && codeOn(); i += 50) {
          const batch = list.slice(i, i + 50);
          const got = await wiki.pages(w, batch.map(q => q.title));
          db.transaction(() => {
            for (const q of batch) {
              const page = got.get(q.title);
              let n = 0;
              // Keep the old evidence queued if its original page could not be verified.
              if (!page && review.has(q.b.id)) continue;
              if (page) {
                const parsed = W.parsePage(page.text);
                if (review.has(q.b.id) && !W.dateFits(parsed, q.b.store_date)) continue;
                if (W.dateFits(parsed, q.b.store_date)) {
                  const proof = `${w} wiki: ${page.title}`;
                  // Only retract the named character reference. A page can contain both types
                  // of evidence, and a pending link can keep its original key after being matched.
                  for (const ref of parsed.characterLinks) {
                    if (parsed.links.some(l => l.dir === ref.dir && l.series === ref.series && l.issue === ref.issue)) continue;
                    const named = `${T.norm(ref.series)}#${T.num(ref.issue)}`;
                    const pendingKey = ref.dir === 'in' ? `k:${q.b.id}>${named}` : `k:${named}>${q.b.id}`;
                    const row = wikiRow(lib, q.b, ref, parsed.event, proof);
                    for (const key of new Set([pendingKey, row?.key].filter(Boolean))) {
                      retire.run(key, proof);
                      if (q.title !== page.title) retire.run(key, `${w} wiki: ${q.title}`);
                    }
                  }
                  for (const ref of parsed.links) {
                    const row = wikiRow(lib, q.b, ref, parsed.event, proof);
                    if (row && saveExternal(row).changes) n++;
                  }
                  clearPairs.run(q.b.id);
                  for (const pair of parsed.pairs) {
                    const [first, second] = pair.map(ref => wikiRow(lib, q.b, ref, parsed.event, proof));
                    if (first && second) addPair.run(q.b.id, first.key, second.key);
                  }
                }
              }
              mark.run(q.b.id, Date.now(), page?.title || null, n);
              wikiState.books++; wikiState.links += n;
            }
          })();
        }
      }
    } catch (e) {
      wikiState.error = e.message;
      logger.warn('crossovers', 'Fan wiki pass stopped', { error: e.message });
    } finally {
      Object.assign(wikiState, { running: false, finishedAt: Date.now(), requests: wiki.requests() - start });
      logger.info('crossovers', 'Fan wiki pass', { requests: wikiState.requests, issues: wikiState.books, links: wikiState.links });
    }
    return wikiState;
  }


  // ── Web check runs ────────────────────────────────────────────────
  const state = { running: false, stop: false, done: 0, total: 0, found: 0, cost: 0, current: null, startedAt: null, finishedAt: null, trigger: null, errors: [] };
  const frequency = () => (Object.hasOwn(FREQUENCIES, getSetting('crossover_check_frequency') || '') ? getSetting('crossover_check_frequency') : 'off');
  const lastRun = () => Number(getSetting('crossover_check_last_run') || 0) || null;

  function candidates() {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
    return db.prepare(`SELECT b.id FROM scanned_books b WHERE b.store_date >= ? AND b.cv_issue_id IS NOT NULL
      AND b.id NOT IN (SELECT book_id FROM crossover_checks) ORDER BY b.store_date`).all(since).map(r => r.id);
  }
  function costPerBook() {
    const r = db.prepare(`SELECT AVG(cost) AS c, COUNT(*) AS n FROM (SELECT cost FROM crossover_checks WHERE cost > 0 ORDER BY checked_at DESC LIMIT 200)`).get();
    return r?.n >= 20 ? r.c : COST_PER_BOOK;
  }
  const callCost = x => { const u = x?.usage || {}; try { return modelCatalog.estimateCost(x.model, { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0 }) || 0; } catch { return 0; } };

  async function checkBook(lib, book, pageCache) {
    let cost = 0;
    const r = await webLookup.lookup(bookQuestion(book), { detail: 'short', source: 'crossovers', maxSources: 6 });
    cost += r.cost || 0;
    if (!r.grounded) return { result: 'no search', cost, links: [] };
    const x = await ai.complete({ task: 'crossover_check', prompt: EXTRACT(r.notes), maxTokens: 1500, thinking: 'off', source: 'crossovers' });
    cost += callCost(x);
    const parsed = T.parseJson(x.text);
    if (!parsed) return { result: 'unreadable reply', cost, links: [] };
    if (!parsed.stories?.length) return { result: 'none', cost, links: [] };
    const pages = [];
    for (const s of r.sources.slice(0, 6)) {
      if (!pageCache.has(s.url)) {
        let p;
        try { p = await readPage(s.url, { axios, maxChars: 80000 }); } catch { p = { url: s.url, text: null }; }
        pageCache.set(s.url, { url: s.url, text: p?.text || null });
      }
      pages.push(pageCache.get(s.url));
    }
    const links = provenLinks(parsed.stories, pages).map(l => linkRow(lib, l, book.store_date)).filter(Boolean);
    return { result: links.length ? `${links.length} link${links.length === 1 ? '' : 's'}` : 'not proven', cost, links };
  }

  async function run(trigger = 'manual', { limit = null } = {}) {
    if (state.running) throw Object.assign(new Error('A crossover check is already running'), { status: 409 });
    if (!aiOn()) throw Object.assign(new Error('The AI web check is switched off'), { status: 409 });
    const ids = limit > 0 ? candidates().slice(-limit) : candidates();   // a trial run: the newest issues
    Object.assign(state, { running: true, stop: false, done: 0, total: ids.length, found: 0, cost: 0, current: null, startedAt: Date.now(), finishedAt: null, trigger, errors: [] });
    setSetting('crossover_check_last_run', String(Date.now()));
    (async () => {
      try {
        if (codeOn()) refreshFree();
        const lib = loadLibrary(db);
        const pageCache = new Map();
        const mark = db.prepare('INSERT OR REPLACE INTO crossover_checks (book_id, checked_at, result, cost) VALUES (?, ?, ?, ?)');
        for (const id of ids) {
          if (state.stop) break;
          const book = lib.byId.get(id);
          state.current = book ? `${book.series} #${book.issue_number}` : id;
          if (!book) { state.done++; continue; }
          try {
            const r = await checkBook(lib, book, pageCache);
            state.cost += r.cost;
            db.transaction(() => { for (const l of r.links) if (saveExternal(l).changes) state.found++; mark.run(id, Date.now(), r.result, r.cost); })();
          } catch (e) {
            // Not marked: asked again next run. A missing key stops the run.
            state.errors.push({ book: state.current, error: e.message });
            if (e.code === 'AI_KEY_MISSING' || state.errors.length >= 10) { state.stop = true; }
          }
          state.done++;
        }
      } catch (e) {
        state.errors.push({ book: null, error: e.message });
        logger.error('crossovers', 'Crossover check failed', e.message);
      } finally {
        Object.assign(state, { running: false, current: null, finishedAt: Date.now() });
        logger.info('crossovers', 'Crossover check finished', { trigger, checked: state.done, of: state.total, links: state.found, cost: `${Math.round(state.cost * 10000) / 100}¢`, errors: state.errors.length || undefined });
      }
    })();
    return status();
  }

  function status() {
    const n = candidates().length, per = costPerBook(), f = frequency(), last = lastRun();
    const counts = db.prepare(`SELECT SUM(source = 'summary') AS summary, SUM(source = 'title') AS title, SUM(source = 'wiki') AS wiki, SUM(source = 'web') AS web,
      SUM(source = 'web' AND (from_book_id IS NULL OR to_book_id IS NULL)) AS waiting, SUM(hidden) AS hidden FROM crossover_links`).get();
    const checked = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(cost), 0) AS cost FROM crossover_checks').get();
    return { code: codeOn(), ai: aiOn(), frequency: f, frequencies: Object.keys(FREQUENCIES), lastRun: last, nextRun: nextRun(),
      pending: n, perBook: per, estimate: n * per, lookbackDays: LOOKBACK_DAYS,
      wiki: { ...wikiState, read: db.prepare('SELECT COUNT(*) AS n FROM crossover_wiki_books').get().n },
      links: { summary: counts.summary || 0, title: counts.title || 0, wiki: counts.wiki || 0, web: counts.web || 0, waiting: counts.waiting || 0, hidden: counts.hidden || 0 },
      checked: checked.n, spent: checked.cost, run: { ...state, errors: state.errors.slice(-10) } };
  }
  // The scheduled check, when it is due (called daily).
  // The schedule runs at 4:35 each night: a check is due there when its interval, less 20 hours, has passed,
  // so Daily after an evening "Check now" still runs the next night (2026-11-22: the settings page said
  // "next: tomorrow" while the old one-hour slack waited two nights).
  const SLACK = 20 * 3600000;
  function due(now = Date.now()) {
    const days = FREQUENCIES[frequency()];
    return aiOn() && !!days && (!lastRun() || now - lastRun() >= days * 86400000 - SLACK);
  }
  // The first 4:35 (server time) at which due() holds.
  function nextRun() {
    const days = FREQUENCIES[frequency()], last = lastRun();
    if (!aiOn() || !days || !last) return null;
    const from = Math.max(Date.now(), last + days * 86400000 - SLACK);
    const d = new Date(from);
    d.setHours(4, 35, 0, 0);
    if (d.getTime() < from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  // ── Routes ─────────────────────────────────────────────────────────
  app.get('/api/books/:id/crossovers', requireAuth, (req, res) => {
    try { res.json(forBook(String(req.params.id))); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/admin/crossovers', requireAdmin, (req, res) => res.json(status()));
  app.post('/api/admin/crossovers/settings', requireAdmin, (req, res) => {
    const f = String(req.body?.frequency || '');
    if (!Object.hasOwn(FREQUENCIES, f)) return res.status(400).json({ error: 'frequency must be off, daily, weekly or monthly' });
    setSetting('crossover_check_frequency', f);
    // Turning it on counts from now, so the first scheduled run is a week or month away; "Check now" runs at once.
    if (f !== 'off' && !lastRun()) setSetting('crossover_check_last_run', String(Date.now()));
    res.json(status());
  });
  app.post('/api/admin/crossovers/run', requireAdmin, async (req, res) => {
    const limit = Number(req.body?.limit) || null;
    try { res.json(await run('manual', { limit: limit > 0 ? Math.min(limit, 1000) : null })); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  // The two switches: { code?: boolean, ai?: boolean }. Off hides that source's links and stops its work
  // (AI off stops a running check). Switching code on builds its links at once if there are none.
  app.post('/api/admin/crossovers/switches', requireAdmin, (req, res) => {
    const { code, ai: aiSwitch } = req.body || {};
    if ((code !== undefined && typeof code !== 'boolean') || (aiSwitch !== undefined && typeof aiSwitch !== 'boolean')) return res.status(400).json({ error: 'code and ai must be true or false' });
    if (legacyOff()) setSetting('crossover_links_enabled', '1');   // the old single switch gives way to these two
    if (code !== undefined) setSetting('crossover_code_enabled', code ? '1' : '0');
    if (aiSwitch !== undefined) { setSetting('crossover_ai_enabled', aiSwitch ? '1' : '0'); if (!aiSwitch) state.stop = true; }
    try { if (code && !db.prepare(`SELECT 1 FROM crossover_links WHERE source IN ('summary', 'title') LIMIT 1`).get()) refreshFree(); } catch (e) { logger.error('crossovers', 'Links from issue text failed', e.message); }
    res.json(status());
  });
  app.post('/api/admin/crossovers/stop', requireAdmin, (req, res) => { state.stop = true; res.json(status()); });
  app.post('/api/admin/crossovers/refresh', requireAdmin, (req, res) => {
    try { res.json({ ...refreshFree(), status: status() }); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // A wrong link (issue page, admins): hidden for good; the nightly rebuild keeps it hidden.
  app.post('/api/admin/crossovers/hide', requireAdmin, (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 20);
    if (!ids.length) return res.status(400).json({ error: 'ids required' });
    const r = db.prepare(`UPDATE crossover_links SET hidden = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    res.json({ hidden: r.changes });
  });

  // Nightly at 4:35: the free summary links, then the web check when it is due.
  cron.schedule('35 4 * * *', () => {
    try {
      if (codeOn()) refreshFree();
      else if (aiOn()) db.transaction(() => resolvePending(loadLibrary(db)))();
    } catch (e) { logger.error('crossovers', 'Links from issue text failed', e.message); }
    if (codeOn()) wikiPass().catch(e => logger.error('crossovers', 'Fan wiki pass failed', e.message));
    if (due() && !state.running) run('scheduled').catch(e => logger.error('crossovers', 'Scheduled check failed', e.message));
  });
  // Existing installs may already have summary links and never run a startup refresh.
  // Reconcile saved missing endpoints against the local catalog before serving the first grid.
  if (enabled()) db.transaction(() => {
    const pending = db.prepare(`SELECT l.*, b.id AS anchor_id, b.store_date FROM crossover_links l
      JOIN scanned_books b ON b.id = COALESCE(l.from_book_id, l.to_book_id)
      WHERE l.source IN ('wiki','web') AND l.hidden = 0 AND (l.from_book_id IS NULL OR l.to_book_id IS NULL)`).all();
    const update = db.prepare('UPDATE crossover_links SET from_book_id = ?, to_book_id = ? WHERE id = ?');
    for (const row of pending) {
      matchPublished(row, { id: row.anchor_id, store_date: row.store_date });
      if (row.from_book_id && row.to_book_id) update.run(row.from_book_id, row.to_book_id, row.id);
    }
  })();
  // First start after deploy: build the summary links once (a few seconds), off the startup path.
  // The same when the title clue arrives (2026-11-22): no title links yet.
  if (codeOn() && !db.prepare(`SELECT 1 FROM crossover_links WHERE source = 'title' LIMIT 1`).get()) {
    setTimeout(() => { try { refreshFree(); } catch (e) { logger.error('crossovers', 'Summary links failed', e.message); } }, 90000).unref?.();
  }
  // The fan wikis' first pass starts soon after deploy (then nightly): about 1,500 requests a night.
  if (codeOn() && !db.prepare('SELECT 1 FROM crossover_wiki_books LIMIT 1').get()) {
    setTimeout(() => wikiPass().catch(e => logger.error('crossovers', 'Fan wiki pass failed', e.message)), 150000).unref?.();
  }

  return { forBook, nextFor, placementFor, missingRow, refreshFree, wikiPass, wikiState, run, status, due, candidates, state, codeOn, aiOn };
}

module.exports = { createCrossovers, schema, loadLibrary, nearest, wikiRow, summaryLinks, textLinks, titleLinks, provenLinks, linkRow, bookQuestion, volumeQuestion, EXTRACT, MAX_GAP_DAYS };
