// ─── backend/issueNumber.js ──────────────────────────────────────────
// Single source of truth for parsing, normalising, and formatting
// comic-book issue numbers. Pulled out of server.js because the same
// logic was needed in 6+ places and Marvel keeps inventing new
// weirdness (8AU, 1.NOW, 14.MU, etc.). One file, one allow-list,
// one place to update when DC/Marvel pulls the next stunt.
//
// Canonical issue-number form, as produced by everything in here:
//   <signed integer>[.point-one][.SUFFIX]
//
//   "14"      "14.1"      "14.NOW"      "8.AU"      "-1"      "1000000"
//
// Lower-case letters, leading zeros, hashes, commas, and whitespace
// are stripped on the way in. Both no-dot ("8AU") and dotted ("8.AU")
// forms map to the same canonical "8.AU" so downstream comparisons
// can use plain string equality.

const path = require('path');

// ─── Allow-listed multi-letter suffixes ──────────────────────────
// When Marvel/DC invents a new tie-in suffix, add it here and that's
// the *entire* maintenance burden — extractIssueNumber, normIssueNumber,
// the reconciler, the CV arc lookup, and the search-query builder all
// pick it up automatically. Keep the comments so future-self remembers
// what each one was.
const MARVEL_TIE_IN_SUFFIXES = new Set([
  'AU',  // Age of Ultron tie-in (2013) — typically NO-DOT in filenames ("Hulk 8AU")
  'INH', // Inhumanity tie-in (2013-14) — usually dot form
  'NOW', // Marvel NOW! / All-New Marvel NOW! relaunch markers (2012-2014)
  'MU',  // Marvel Universe / Marvel Unlimited variants
  'MCU', // Marvel Cinematic Universe tie-in (rare)
  'AI',  // Avengers AI tie-in (2013-14)
  // Future additions go here. One line each, with a date+context comment.
]);

// ─── normIssueNumber ─────────────────────────────────────────────
// Canonicalise any input. Returns null for unparseable input so
// callers can decide whether to fall back to something else.
//
// Examples:
//   "8AU"      → "8.AU"
//   "8.AU"     → "8.AU"
//   "08AU"     → "8.AU"
//   "8au"      → "8.AU"
//   "14.1"     → "14.1"
//   "014.NOW"  → "14.NOW"
//   "14NOW"    → "14.NOW"
//   "-1"       → "-1"
//   "0-1"      → "-1"     (legacy "double-zero negative" format)
//   "1000000"  → "1000000"
//   "1A"       → "1"      (single-letter trail = variant cover hint, dropped)
//   "1ST"      → "1"      (unknown-to-allow-list suffix, dropped — see note below)
//   "" / null  → null
//
// Suffix policy: only the curated allow-list survives. Unknown 2+
// letter trailers are dropped because the false-positive risk is
// real ("Captain America 1ST Birthday Special.cbz" should not become
// issue "1.ST"). When Marvel ships something new, add to the list.
function normIssueNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/[,\s]/g, '').replace(/^#/, '').trim();
  if (!s) return null;

  // Legacy "0-N" negative format
  if (/^0-\d+$/.test(s)) return String(-parseInt(s.slice(2), 10));

  // <signed int>[.<digits>][[.]<letters>?]
  // The letters group is optional and may be attached directly OR with a dot.
  const m = s.match(/^(-?\d+)(\.\d+)?(?:\.?([A-Za-z]{2,}))?$/);
  if (m) {
    const intPart  = String(parseInt(m[1], 10));   // strips leading zeros
    // Drop ".0" / ".00" — meaningless trailers. Keep real point-ones (.1, .25, etc).
    const fracPart = m[2] && parseFloat(m[2]) > 0 ? m[2] : '';
    const sfx      = m[3] ? m[3].toUpperCase() : '';
    const sfxOut   = sfx && MARVEL_TIE_IN_SUFFIXES.has(sfx) ? `.${sfx}` : '';
    return `${intPart}${fracPart}${sfxOut}`;
  }

  // Last resort — keeps weird inputs (scientific notation, etc.) alive.
  const n = parseFloat(s);
  return isNaN(n) ? null : String(n);
}

// ─── extractIssueNumber ──────────────────────────────────────────
// Parse a comic filename into a canonical issue number, or null.
// Rules in priority order:
//   1. Negative issue numbers (Marvel "Flashback" -1)
//   2. Milestone numbers (5+ digits like 1000000)
//   3. Dot suffix: 014.1 / 014.MU / 001.NOW
//   4. NEW — no-dot Marvel suffix: 8AU / 14AU / 1NOW (allow-list gated)
//   5. ISO cover-date variant: "Series, 1982-11-00 ( 08) (tag).cbz"
//   6. Generic fallbacks: #001 / _001_ / " 001 " / (001) / trailing 001 / "1 of 5"
function extractIssueNumber(filename) {
  const base = path.basename(filename, path.extname(filename));

  // 1. Negative issue numbers
  // Preceded by space/underscore/open-paren so X-Men/Spider-Man hyphens are not eaten.
  const negM = base.match(/(?:^|[\s_(])(-0*[1-9]\d*)(?=[\s_)(]|$)/);
  if (negM) return String(parseInt(negM[1], 10));

  // 2. Milestone numbers (5+ digits) — runs before year patterns
  const milestoneM = base.match(/(?:^|[\s#_])(\d{5,})/);
  if (milestoneM) return String(parseInt(milestoneM[1], 10));

  // 3. Dot suffix: 014.1 / 014.MU / 001.NOW
  const dotM = base.match(/(?:^|[\s#_])(\d{1,4})\.([\dA-Z]+)(?=[\s\(]|$)/i);
  if (dotM) {
    const baseN  = parseInt(dotM[1], 10);
    const suffix = dotM[2].toUpperCase();
    if (!(baseN >= 1900 && baseN <= 2099)) {
      return `${baseN}.${suffix}`;
    }
  }

  // 4. NEW — no-dot suffix: "8AU", "14AU", "1NOW".
  //    Allow-list gated to avoid "Captain America 1ST Birthday Special" → "1.ST".
  const sfxM = base.match(/(?:^|[\s#_])(\d{1,4})([A-Za-z]{2,})(?=[\s\(_)]|$)/);
  if (sfxM) {
    const baseN  = parseInt(sfxM[1], 10);
    const suffix = sfxM[2].toUpperCase();
    if (!(baseN >= 1900 && baseN <= 2099) && MARVEL_TIE_IN_SUFFIXES.has(suffix)) {
      return `${baseN}.${suffix}`;
    }
  }

  // 5. ISO cover-date format
  const dateStripped = base.replace(/\b(19|20)\d{2}-\d{2}-\d{2}\b\s*/g, '');
  const spM = dateStripped.match(/\([\s_]+(\d{1,4})\s*\)/);
  if (spM) {
    const n = parseInt(spM[1], 10);
    if (!(n >= 1900 && n <= 2099)) return String(n);
  }

  // 6. Generic patterns
  const patterns = [
    /#(\d+)/,                 // #001
    /_(\d{2,4})[_\s\(]/,      // _001_
    /\s(\d{1,4})\s/,          // " 001 "
    /\s(\d{1,4})-(?=[A-Za-z])/, // " 283-Superboy, Congorilla" (number joined to the story title; 2026-10-25 packs)
    /\((\d{1,4})\)(?!.*\()/,  // (001) — last paren group, skips year if more follow
    /(\d{2,4})$/,             // trailing digits
    /(\d{1,4})\s*of\s*\d/i,   // "1 of 5"
  ];
  for (const p of patterns) {
    const m = base.match(p);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n >= 1900 && n <= 2099) continue; // year guard
    return String(n);
  }
  return null;
}

// ─── padIssueNumStr ──────────────────────────────────────────────
// Zero-pad just the integer base of an issue number, preserving any
// decimal/suffix part (which keeps a leading dot).
//   "8"        → "008"
//   "648"      → "648"
//   "8.1"      → "008.1"
//   "1.NOW"    → "001.NOW"
//   "1000000"  → "1000000"
function padIssueNumStr(s, width) {
  const raw = String(s || '').trim();
  if (!raw) return ''.padStart(width, '0');
  const dotIdx = raw.indexOf('.');
  if (dotIdx === -1) return raw.padStart(width, '0');
  const intPart = raw.slice(0, dotIdx);
  const suffix  = raw.slice(dotIdx); // includes the leading dot
  return intPart.padStart(width, '0') + suffix;
}


// ─── Relaunch branding fallback ──────────────────────────────────
// Marvel NOW! branding (#23.NOW) marks a regular issue, and Comic Vine often
// lists it as plain #23 (Iron Man 2013: pack 856 failed on "Iron Man 023.NOW").
// When the series has no issue numbered with the suffix but does have the
// plain number, the plain number is the match. Tie-in suffixes (AU, INH, MU…)
// are separate issues beside the plain one, so they stay strict.
const BRANDING_SUFFIXES = new Set(['NOW']);
function brandingFallback(num, knownNums) {
  const n = normIssueNumber(num);
  if (!n) return num;
  const m = n.match(/^(-?\d+(?:\.\d+)?)\.([A-Z]+)$/);
  if (!m || !BRANDING_SUFFIXES.has(m[2])) return num;
  const known = new Set((knownNums || []).map(normIssueNumber).filter(Boolean));
  return !known.has(n) && known.has(m[1]) ? m[1] : num;
}

module.exports = {
  brandingFallback,
  MARVEL_TIE_IN_SUFFIXES,
  normIssueNumber,
  extractIssueNumber,
  padIssueNumStr,
};
