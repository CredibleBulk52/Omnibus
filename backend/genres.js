'use strict';
// ─── Series genres (2026-11-03) ──────────────────────────────────────────────
// The allowed genres, each with the one-line definition the AI is given. This is the one
// place the list is kept: the server sends it to scripts/enricher.py in every run's config.
// 31 genres (user, 2026-11-03; Time Travel and Surreal added 2026-11-04): story types plus the kinds of superhero book that divide a
// library that is mostly Marvel and DC. Adventure was dropped (on half the library, it
// narrowed nothing). Changing the list or a definition: bump GENRE_VERSION, then Library ›
// Genres retags the series chosen from an older list.
const GENRE_DEFS = Object.freeze([
  ['Superhero', 'Costumed or super-powered heroes and villains.'],
  ['Crime', 'Criminals, heists, gangs, or police and detectives at work.'],
  ['Horror', 'Meant to frighten: monsters, dread, the grotesque.'],
  ['Science Fiction', 'Future technology, aliens, space travel or science as the driver of the story.'],
  ['Fantasy', 'Magic worlds, mythic quests, gods and legends.'],
  ['Mystery', 'Built around a puzzle or an investigation.'],
  ['Thriller', 'Political or conspiracy suspense; a race against a plot.'],
  ['Comedy', 'Played mainly for laughs, parody or satire.'],
  ['Drama', 'Character-driven with little action: relationships and personal struggles.'],
  ['Romance', 'A love story at the centre.'],
  ['War', 'Soldiers and battle in a real or invented war.'],
  ['Western', 'The American frontier: cowboys, outlaws, gunfighters.'],
  ['Noir', 'Dark, cynical, morally grey crime in the hard-boiled style.'],
  ['Espionage', 'Spies, secret agents and intelligence agencies.'],
  ['Supernatural', 'Magic, demons, ghosts and the occult (Doctor Strange, Constantine).'],
  ['Cosmic', 'Space-faring heroes, galactic empires, stakes on the scale of the universe.'],
  ['Street-Level', 'Heroes fighting crime at street scale in one city (Daredevil, Spider-Man, Jessica Jones), not world-level threats.'],
  ['Team', 'A regular ensemble shares the lead (Avengers, X-Men Unlimited). Not a solo hero with a supporting cast or family.'],
  ['Teen', 'Teenage heroes; coming of age.'],
  ['Martial Arts', 'Fighting skill and martial-arts masters at the centre.'],
  ['Post-Apocalyptic', 'After the collapse of civilisation.'],
  ['Alternate Reality', 'The whole series is set outside the main continuity: Elseworlds, What If, Amalgam, the Ultimate or Absolute lines, possible futures. The Ultimate line means Marvel’s Ultimate imprint (Ultimate Spider-Man, The Ultimates 2002), not the main-continuity Ultimates team book (2015). Not for main-continuity stories that visit other worlds or timelines (Infinite Crisis, Forever Evil).'],
  ['Anti-Hero', 'The lead acts as a criminal, killer, mercenary or villain (Punisher, Deadpool, Venom). Not a hero who is only angry, feared or on the run (Hulk), and not a team with one rough member.'],
  ['All-Ages', 'Written for children. Not just because it is funny or has cartoon characters.'],
  ['Sword & Sorcery', 'Barbarians, swords and ancient magic (Conan, Red Sonja).'],
  ['Pulp', '1930s–40s style masked adventurers and their revivals (The Shadow, Doc Savage).'],
  ['Cyberpunk', 'High tech and low life: hackers, corporations, augmented bodies.'],
  ['Kaiju', 'Giant monsters.'],
  ['Historical', 'Set in a real historical period (other than a war story).'],
  ['Time Travel', 'Travel through time drives the story: visiting other eras, changing the past, time loops.'],
  ['Surreal', 'Dreamlike, absurd or reality-bending storytelling that ignores ordinary logic (Doom Patrol, The Invisibles).'],
].map(([name, definition]) => Object.freeze({ name, definition })));
const GENRES = Object.freeze(GENRE_DEFS.map(g => g.name));
// 2026-11b (after the first test): Alternate Reality and All-Ages definitions tightened; fewer filler genres.
// 2026-11c (after the third test): Time Travel and Surreal added; the AI tags every genre a reader would expect.
// 2026-11d (spot check): Team tightened; the AI also gets the imprint and uses its own knowledge.
// 2026-11e (Sonnet comparison): Street-Level, Anti-Hero and Alternate Reality (Ultimate line) reworded.
const GENRE_VERSION = '2026-11e';
const keyOf = v => String(v ?? '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
const BY_KEY = new Map(GENRES.map(g => [keyOf(g), g]));
const MAX_GENRES = 4;
// The list before 2026-11-03 (with Adventure, without the superhero kinds). The one-time
// repair below keeps judging by it, so it never strips a genre that was valid when written;
// the Library › Genres retag moves series to the new list.
const REPAIR_GENRES = Object.freeze(['Superhero', 'Crime', 'Horror', 'Science Fiction', 'Fantasy', 'Mystery',
  'Thriller', 'Comedy', 'Drama', 'Romance', 'War', 'Western', 'Adventure', 'Noir', 'Espionage', 'Supernatural']);

// Stored genres reduced to the allowed list: each value's first line ("Thriller\n\nWait…"
// → Thriller), matched ignoring case, spaces, hyphens and '&'/'and'; anything else (the AI's
// commentary, "Action") is dropped. No repeats, at most MAX_GENRES, original order.
function cleanGenres(list, allowed = GENRES, max = MAX_GENRES) {
  const byKey = allowed === GENRES ? BY_KEY : new Map(allowed.map(g => [keyOf(g), g]));
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const g = byKey.get(keyOf(String(v ?? '').trim().split('\n')[0]));
    if (g && !out.includes(g)) out.push(g);
  }
  return out.slice(0, max);
}
const allAllowed = list => Array.isArray(list) && list.every(v => REPAIR_GENRES.includes(v));

// One-time repair (2026-11-03): 101 series had the enricher's commentary saved as genres
// ("\"Heist\" is not in the list. Let me choose…", "Action\n\nWait"). Candidates come
// from the library rows' copy of series.json; each file is then read from disk, cleaned
// and written back (writeSeriesJson keeps the cached copies in step). A series left with
// no genre loses its enrichment date, so the next Enrich asks the AI again.
function repairStoredGenres({ db, readSeriesJson, writeSeriesJson, logger = null }) {
  const rows = db.prepare("SELECT id, name, path, series_json FROM scanned_series WHERE series_json LIKE '%genres%'").all();
  const result = { checked: rows.length, changed: 0, emptied: [], failed: 0 };
  for (const row of rows) {
    let cached;
    try { cached = JSON.parse(row.series_json); } catch { continue; }
    const m = cached && cached.metadata;
    // genres_version: already chosen from the current list (Library › Genres); not this repair's business.
    if (!m || typeof m !== 'object' || Array.isArray(m) || !Array.isArray(m.genres) || allAllowed(m.genres) || m.enrichment?.genres_version) continue;
    try {
      const data = readSeriesJson(row.path);
      if (!data) { result.failed++; continue; }        // library folder unreachable: try again next start
      const meta = data.metadata;
      if (!meta || typeof meta !== 'object' || Array.isArray(meta) || !Array.isArray(meta.genres) || allAllowed(meta.genres) || meta.enrichment?.genres_version) continue;
      const before = meta.genres;
      meta.genres = cleanGenres(before, REPAIR_GENRES, 3);
      if (!meta.genres.length) {
        if (meta.enrichment && typeof meta.enrichment === 'object') delete meta.enrichment.date;
        result.emptied.push(row.name || row.id);
      }
      writeSeriesJson(row.path, data);
      result.changed++;
      logger?.info?.('genres', `Cleaned genres for ${row.name || row.id}`, { before, after: meta.genres });
    } catch (e) {
      result.failed++;
      logger?.warn?.('genres', `Could not clean genres for ${row.name || row.id}`, { error: e.message });
    }
  }
  return result;
}

module.exports = { GENRES, GENRE_DEFS, GENRE_VERSION, MAX_GENRES, cleanGenres, repairStoredGenres };
