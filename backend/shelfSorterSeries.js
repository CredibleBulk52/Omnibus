'use strict';
// ─── Shelf Sorter stage B: homeless minis and one-shots (2026-11-13) ──
// claude/SHELF_SORTER_STAGE_B.md. A series with a series.json, 12 issues or fewer (Comic Vine's
// count), on no shelf and not a home, is offered a few candidate homes picked here without AI:
// same publisher, and a series named like its title prefix ("Black Panther: World of Wakanda" →
// Black Panther) or like one of its main characters or its team (ComicInfo), at least as large.
// Sequels, continuations and renames stay series of their own (2026-11-13, user: Opus shelved
// Gotham Academy: Second Semester and Justice League International): the prompt says so, and the
// book's own run dates are sent beside its candidates'. (Marking "ended just before" was tried and
// dropped: title families like Star Trek: … made it fire on satellites too.)
// Ranked: prefix match, running when it came out, then size. Only series with a candidate are
// asked about (743 of 1,330 on the 08:14 backup). The AI answers per series:
//   home      a satellite of one candidate: shelved there (hidden, like a tie-in)
//   main      part of a candidate's main story published as its own mini (Captain America: Reborn):
//             shelved there but kept visible, like an event's main-story minis (2026-11-14)
//   own       a series in its own right (a character's own title, a new volume): left alone
//   landmark  an iconic story read on its own (The Killing Joke, Marvels): left alone
//   none      no candidate fits
// The local judgement is coarse on purpose; the AI's main job is satellite or not.

const MAX_ISSUES = 12;
const MAX_CANDIDATES = 6;
const CONF = ['sure', 'likely', 'unsure'];

const SERIES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['series'],
  properties: {
    series: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['item', 'verdict', 'home', 'confidence', 'why'],
      properties: {
        item: { type: 'string' },
        verdict: { type: 'string', enum: ['home', 'main', 'own', 'landmark', 'none'] },
        home: { type: ['string', 'null'] },
        confidence: { type: 'string', enum: CONF },
        why: { type: 'string' },
      },
    } },
  },
};

const SERIES_SYSTEM = `You help organize a personal comic library. A small series (a mini or a one-shot) that is a satellite of a larger series is put on that series' "Specials shelf": it leaves the main series list but stays on the larger series' Specials tab and in search. The aim is to tie related series together and reduce sprawl, not to hide every short series.

The Specials shelf is for side material: books read alongside a series or in addition to it. It is never for the next chapter of a series: a sequel, continuation or new volume is read in its own right and must stay visible.

Each item is a short series now on its own, with facts from the library and up to six candidate series (C ids) picked by title and main characters. Decide:
- "home": it is a satellite of one candidate: a spin-off, companion, special, one-shot or mini published alongside that series or its run (Black Panther: World of Wakanda → Black Panther (2016); Uncanny X-Men: Winter's End → Uncanny X-Men (2018); Dark Knights of Steel: Heir to the Sea → Dark Knights of Steel). Choose the candidate of the right era and line; name it in "home".
- "main": a chapter of one candidate's main story that was published as a separate mini (Captain America: Reborn → Captain America (2004), between issues of Brubaker's run). It goes on that series' shelf but stays visible. Name the candidate in "home".
- "own": a series in its own right. This includes:
  - a character's own title, a new volume of a title, a new ongoing cut short, or a mini readers follow on its own (America (2017), New Avengers (2025), Wonder Twins (2019), Black Panther (2023), Arkham Manor, Avengers Inc.). When Metron's kind of series is given, "limited series" and "one-shot" were planned as short; an ongoing is never side material;
  - a sequel, continuation or second season of a candidate, even under a new subtitle (Gotham Academy: Second Semester continues Gotham Academy; a "Season Two", "Book Two", "Volume 2" or relaunch);
  - a series renamed or continued under another title (Justice League International continues Justice League (1987)).
  Compare the run dates: a book that starts right after a candidate of the same title ended, or that such a candidate picks up right after, is usually its next chapter, not side material.
  Sharing a character with a candidate is not enough to shelve it.
- "landmark": an iconic or standalone story readers seek out on its own (Batman: The Killing Joke, Marvels, Kingdom Come, a celebrated Elseworlds or Black Label book). It is never shelved.
- "none": it is a satellite of something, but none of the candidates (for example it belongs to a line that is not listed: an Ultimate Comics mini whose candidates are mainstream series). If the series your reason would name is not among the candidates, answer "none"; never pick a different candidate in its place.
Confidence: "sure" only when a well-read comics historian would not dispute it; "likely" when you lean that way; "unsure" when you know little about the book. If you do not recognise it, say unsure rather than guess.
why: at most 15 words, plain language, for the admin.`;

const norm = t => String(t || '').toLowerCase().replace(/&amp;/g, '&').replace(/&/g, ' and ').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const prefixOf = name => { const m = /^(.+?)(?::\s| - |\s–\s)/.exec(String(name || '')); return m ? m[1].trim() : null; };
const pubKey = p => norm(p).split(' ')[0] || '';
const short = (t, n = 160) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const unescape = s => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'");
const metaOf = json => {
  try { const d = JSON.parse(json); const m = d && typeof d === 'object' && !Array.isArray(d) ? d.metadata : null; return m && typeof m === 'object' ? m : null; }
  catch { return null; }
};

// Library facts for stage B: { S: Map(id → series), targets: [...], candidatesOf(s), linked, homes }.
// types: Map(comicid → { kind, type }) from seriesTypes.js (Metron's kind of series), when known.
function seriesContext(db, { curated = new Set(), types = new Map() } = {}) {
  const has = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const S = new Map();
  for (const r of db.prepare('SELECT id, name, year, path, series_json, book_count FROM scanned_series').all()) {
    const m = metaOf(r.series_json);
    const total = m && Number.isInteger(m.total_issues) && m.total_issues > 0 ? m.total_issues : null;
    const y = parseInt(String((m && m.year) || r.year || '').slice(0, 4), 10) || 0;
    const run = String((m && m.publication_run) || '');
    const years = run.match(/\d{4}/g) || [];
    const size = total || r.book_count || 0;
    const end = /present/i.test(run) ? 9999 : years.length ? parseInt(years[years.length - 1], 10) : y + Math.floor(size / 12);
    const parts = String(r.path || '').split(/[\\/]/).filter(Boolean);
    S.set(r.id, { id: r.id, comicid: m && /^\d+$/.test(String(m.comicid ?? '')) ? String(m.comicid) : null, name: (m && m.name) || r.name || '', year: y, end, size, hasJson: !!m, publisher: (m && m.publisher) || '',
      status: (m && m.status) || '', run, desc: short(m && (m.description_text || m.description), 600), folder: parts.length > 1 ? parts[parts.length - 2] : '' });
  }
  const linked = new Set(db.prepare('SELECT DISTINCT series_id FROM series_links').all().map(r => r.series_id));
  const homes = new Set(db.prepare('SELECT DISTINCT home_id FROM series_links').all().map(r => r.home_id));
  if (has('events')) { try { for (const r of db.prepare('SELECT home_series_id FROM events WHERE home_series_id IS NOT NULL').all()) homes.add(r.home_series_id); } catch {} }
  const rejected = new Set(db.prepare("SELECT series_id || '|' || home_id AS k FROM series_link_overrides WHERE action = 'reject'").all().map(r => r.k));
  const byName = new Map();
  for (const s of S.values()) { if (!s.hasJson) continue; const k = norm(s.name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(s); }
  const targets = [...S.values()].filter(s => s.hasJson && !linked.has(s.id) && !homes.has(s.id) && s.size > 0 && s.size <= MAX_ISSUES);
  // Main characters and team (ComicInfo), for the targets only. Only the tag text is read.
  const want = new Set(targets.map(s => s.id));
  const chars = new Map(), teams = new Map();
  const add = (map, sid, list) => {
    if (!map.has(sid)) map.set(sid, new Map());
    const m = map.get(sid);
    for (const x of unescape(list).split(',').map(v => v.trim()).filter(Boolean)) m.set(x, (m.get(x) || 0) + 1);
  };
  for (const b of db.prepare(`SELECT series_id,
      substr(comicinfo, instr(comicinfo, '<Characters>') + 12, 400) AS c, instr(comicinfo, '<Characters>') AS hc,
      substr(comicinfo, instr(comicinfo, '<Teams>') + 7, 200) AS t, instr(comicinfo, '<Teams>') AS ht
      FROM scanned_books WHERE COALESCE(is_special, 0) = 0 AND comicinfo IS NOT NULL
        AND series_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...want]))) {
    if (b.hc) add(chars, b.series_id, String(b.c).split('<')[0]);
    if (b.ht) add(teams, b.series_id, String(b.t).split('<')[0]);
  }
  const top = (map, sid, n) => [...(map.get(sid) || new Map())].sort((a, b) => b[1] - a[1]).slice(0, n).map(x => x[0]);
  const running = (h, y) => !!h.year && !!y && h.year - 1 <= y && y <= h.end + 1;
  function candidatesOf(s) {
    const p = prefixOf(s.name);
    const keys = [...(p ? [norm(p)] : []), ...top(chars, s.id, 3).map(norm), ...top(teams, s.id, 1).map(norm)];
    const out = new Map();
    for (const k of keys) for (const h of byName.get(k) || []) {
      // As large or larger (Agents of Atlas (2019, 5) is the home of Atlantis Attacks (2020, 5)).
      if (h.id === s.id || pubKey(h.publisher) !== pubKey(s.publisher) || h.size < s.size || rejected.has(`${s.id}|${h.id}`)) continue;
      out.set(h.id, h);
    }
    const pk = p ? norm(p) : null;
    return [...out.values()].sort((a, b) => ((norm(a.name) !== pk) - (norm(b.name) !== pk)) || (running(b, s.year) - running(a, s.year)) || b.size - a.size)
      .slice(0, MAX_CANDIDATES);
  }
  const kindOf = s => (s && s.comicid && types.get(s.comicid)) || null;
  return { S, targets, candidatesOf, linked, homes, curated, kindOf, chars: sid => top(chars, sid, 5), teams: sid => top(teams, sid, 2), running };
}

// One series' facts (real ids): what is sent, and what its saved answer is checked against.
function seriesFacts(s, ctx) {
  const cands = ctx.candidatesOf(s);
  const k = ctx.kindOf ? ctx.kindOf(s) : null;
  return { id: s.id, name: s.name, year: s.year, issues: s.size, publisher: s.publisher, folder: s.folder, status: s.status, run: s.run,
    kind: k && k.kind !== 'unknown' ? k.kind : undefined, metronType: k && k.type ? k.type : undefined,
    characters: ctx.chars(s.id).slice(0, 4), teams: ctx.teams(s.id).slice(0, 1), about: short(s.desc, 160),
    candidates: cands.map(h => ({ id: h.id, name: h.name, year: h.year, issues: h.size, run: h.run, running: ctx.running(h, s.year) })) };
}

function renderSeries(list) {
  const ids = new Map();
  let c = 0;
  const out = [];
  list.forEach((f, i) => {
    const t = `T${i + 1}`; ids.set(t, f.id);
    out.push(`${t} ${f.name}${f.year ? ` (${f.year})` : ''} · ${f.publisher || 'publisher unknown'} · ${f.issues} issue${f.issues === 1 ? '' : 's'}${f.run ? ` · ${f.run}` : ''}${f.metronType ? ` · Metron: ${f.metronType.toLowerCase()}` : ''}${f.folder ? ` · folder "${f.folder}"` : ''}${f.status === 'Continuing' ? ' · still publishing' : ''}`);
    if (f.characters.length || f.teams.length) out.push(`  characters: ${[...f.characters, ...f.teams.map(x => `${x} (team)`)].join(', ')}`);
    if (f.about) out.push(`  about: ${f.about}`);
    for (const h of f.candidates) {
      const k = `C${++c}`; ids.set(k, h.id);
      out.push(`  ${k} ${h.name}${h.year ? ` (${h.year})` : ''} · ${h.issues} issues${h.run ? ` · ${h.run}` : ''}`);   // no "running then" label: by year it misled (2026-11-13); the run dates speak for themselves
    }
  });
  return { text: out.join('\n'), ids };
}

// A reply item → { verdict, homeId, confidence, why }; a home outside the candidates becomes "none".
function resolveSeries(item, facts, ids) {
  const conf = CONF.includes(item.confidence) ? item.confidence : 'unsure';
  let verdict = ['home', 'main', 'own', 'landmark', 'none'].includes(item.verdict) ? item.verdict : 'none';
  let homeId = item.home ? ids.get(item.home) || null : null;
  const shelves = verdict === 'home' || verdict === 'main';
  if (shelves && (!homeId || !facts.candidates.some(h => h.id === homeId))) verdict = 'none';
  if (verdict !== 'home' && verdict !== 'main') homeId = null;
  return { verdict, homeId, confidence: conf, why: short(item.why, 140) };
}

// Without an AI key (2026-11-14): Omnibus suggests only its strongest local matches, never applied
// on their own ("likely"): the title prefix names a series published while the book came out
// ("Black Panther: World of Wakanda" → Black Panther (2016)). Left out: Metron ongoings, landmark
// folders and names (Elseworlds, Black Label, …), and titles that read like a sequel or an origin.
const LOCAL_LANDMARK = /elseworld|black label|prestige|graphic novel|earth one/i;
const LOCAL_OWN = /\b(second|third|season|semester|volume|vol\.|book (two|2|ii)|part (two|2|ii)|returns|reborn|year one)\b/i;
// The month a run starts and ends ("November 2016 - October 2017"; "Present" → open-ended).
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function runMonths(run) {
  const parts = String(run || '').split(/\s+-\s+/);
  const at = (txt, last) => {
    const m = /([a-z]+)?\s*(\d{4})/i.exec(txt || '');
    if (!m) return null;
    const mi = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
    return parseInt(m[2], 10) * 12 + (mi >= 0 ? mi : last ? 11 : 0);
  };
  return { start: at(parts[0], false), end: /present/i.test(run || '') ? Infinity : at(parts[parts.length - 1], true) };
}
function localSuggestion(s, f, ctx) {
  const p = prefixOf(s.name);
  const h = f.candidates[0];
  if (!p || !h || f.kind === 'ongoing') return null;
  if (norm(h.name) !== norm(p) || !h.running) return null;
  // Running in the month the book began, not just that year: a series that picks up after the
  // other ended (Spider-Gwen: Ghost-Spider, Green Lantern: Blackstars) is its next chapter.
  const b = runMonths(s.run), r = runMonths(h.run);
  if (b.start == null || r.start == null || r.end == null || b.start < r.start || b.start > r.end) return null;
  if (LOCAL_LANDMARK.test(`${s.name} ${s.folder}`) || LOCAL_OWN.test(s.name)) return null;
  return { verdict: 'home', homeId: h.id, confidence: 'likely', why: `Same title as ${h.name}${h.year ? ` (${h.year})` : ''}, published while it ran (Omnibus, no AI)` };
}

// What an answer depends on (2026-11-14): only the series' own facts. A candidate list that shifts as the
// library grows does not ask again; a home that is no longer a candidate does (checked by the caller).
const stableFacts = f => ({ id: f.id, name: f.name, year: f.year, issues: f.issues, run: f.run || '', status: f.status || '' });

module.exports = { SERIES_SCHEMA, SERIES_SYSTEM, seriesContext, seriesFacts, renderSeries, resolveSeries, stableFacts, localSuggestion, prefixOf, MAX_ISSUES };
