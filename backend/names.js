'use strict';
// ─── Name and folder helpers (moved out of server.js 2026-11-19, server.js split) ───
// Shared by the library import, the weekly release list, download routing, Timeline lookups and
// Top Shelf matching. Moved unchanged; nameKey is the rule that was written out ~35 times.

// A name reduced to lower-case letters and digits, for comparing names from different sources
// ("Spider-Man: Blue" = "spidermanblue"). Accented letters are dropped, as before ("Pokémon" →
// "pokmon"): keys are stored in release_cv_map, so changing the rule needs those rows rebuilt.
// An empty or missing name gives '' (some copies used to throw on a missing name).
function nameKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Parse "Series Name (2023)", "Series Name 2023", or "Series Name" from a folder name.
 *  Returns { name, year } */
// "Action Comics (2016)" → { title: 'Action Comics', year: 2016 }; no "(YYYY)" at the end → the
// whole name and null. Anchored at the end only, so it cannot backtrack on long names.
function folderTitleYear(folderName) {
  const s = String(folderName || '').trim();
  const m = /\((\d{4})\)$/.exec(s);
  return m ? { title: s.slice(0, m.index).trim(), year: parseInt(m[1]) } : { title: String(folderName || ''), year: null };
}
function parseFolderName(folderName) {
  // Parenthesised year: "Action Comics (2016)". (The old patterns had lost their backslashes,
  // so they never matched; found by CodeQL code scanning, 2026-11-12.)
  const s = String(folderName || '').trim();
  const { title, year } = folderTitleYear(s);
  if (year) return { name: title, year };
  // Bare trailing year: "Action Comics 2016" — only strip when a letter word precedes it
  // so "2000 AD" is not incorrectly parsed as name="2000", year=NaN.
  const mb = /\s(\d{4})$/.exec(s);
  if (mb && /[a-zA-Z]/.test(s.slice(0, mb.index))) return { name: s.slice(0, mb.index).trim(), year: parseInt(mb[1]) };
  return { name: s, year: null };
}

/** String similarity score 0-1.
 *  Uses word overlap with typo tolerance:
 *  exact word match = 1.0 credit, prefix match (≥4 chars) = 0.85 credit.
 *  This handles common folder-name typos like "Evile" matching "Evil". */
function nameSimilarity(a, b) {
  const tokenise = s => s.replace(/\b(?:[a-z]\.){2,}/gi, m => m.replace(/\./g, '')).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  const wordsA = tokenise(a);
  const wordsB = tokenise(b);
  if (!wordsA.length || !wordsB.length) return 0;
  const setBLen = new Set(wordsB);
  let score = 0;
  for (const wa of wordsA) {
    if (setBLen.has(wa)) {
      score += 1.0; // exact match
    } else {
      // Prefix/typo match: one word starts with the other (min 4 chars overlap)
      const minLen = Math.min(wa.length, 4);
      const fuzzy = wordsB.some(wb => {
        const ol = Math.min(wa.length, wb.length);
        return ol >= minLen && (wa.startsWith(wb.slice(0, ol)) || wb.startsWith(wa.slice(0, ol)));
      });
      if (fuzzy) score += 0.85;
    }
  }
  return score / Math.max(wordsA.length, wordsB.length);
}

module.exports = { nameKey, folderTitleYear, parseFolderName, nameSimilarity };
