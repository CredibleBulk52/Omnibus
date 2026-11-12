'use strict';
// Which Comic Vine volumes are a series' annuals, by name (moved out of server.js 2026-11-10).
//
// annualNameFits (2026-10-26): an annual volume's name, without its years and without "Annual"
// and anything after it, must be the series' name, or its end ("X-Men Annual" for Uncanny X-Men,
// which was X-Men before the rename). The validator used to be asked about any volume sharing a
// word, and linked 5 of 37: X-Men Annual to X-Men United, Uncanny X-Men Annual to X-Men,
// Amazing Spider-Man Annual to Spider-Versity, Green Arrow 2024 Annual to Arcadia, and an Image
// volume named just "Annual" to Spawn Annual.
//
// Yearly annuals (2026-11-10): Marvel's 1995–98 annuals are one-issue volumes named for the year,
// with no "Annual": "Sensational Spider-Man '96", "Uncanny X-Men '97". In 1998 most paired two
// titles, "Uncanny X-Men / Fantastic Four '98", and belong to the first. The finder never found
// them (it kept only names with "Annual"). For these the name must be the series' own name, not
// its end: "Spider-Man '97" is the annual of Spider-Man (1990), not of Sensational Spider-Man.

const YEARLY = /['’‘`](\d\d)\s*$/;   // no leading \s*: it made the match polynomial (CodeQL); callers trim
const YEARLY_FROM = 1995, YEARLY_TO = 1998;

const norm = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ').trim().replace(/^the /, '');

// 1996 for "Sensational Spider-Man '96"; null when the name has no 1990s year tag.
function yearlyTag(name) {
  const m = String(name || '').match(YEARLY);
  if (!m) return null;
  const y = 1900 + Number(m[1]);
  return y >= 1990 ? y : null;
}

const isAnnualName = name => /\bannual\b/i.test(String(name || '')) || !!yearlyTag(name);

function annualNameFits(annualName, seriesName) {
  const p = norm(String(seriesName || '').replace(/\((?:19|20)\d\d\)/g, ' '));
  if (!p) return false;
  if (!/\bannual\b/i.test(String(annualName || '')) && yearlyTag(annualName)) {
    const base = String(annualName).replace(YEARLY, '').trim();
    const names = base.includes('/') ? [base, base.split('/')[0]] : [base];
    return names.some(n => norm(n) === p);
  }
  const a = norm(String(annualName || '').replace(/\bannual\b.*$/i, '').replace(/\b(?:19|20)\d\d\b/g, ' '));
  return !!a && (a === p || p.endsWith(' ' + a));
}

// The years Marvel used yearly annual names that a run covers (an annual may follow the last
// issue by a year). One extra Comic Vine search per year: the "… Annual" search misses them.
function yearlyAnnualYears(runStartYear, runEndYear) {
  if (!Number(runStartYear)) return [];   // run's start unknown: no extra searches
  const from = Math.max(Number(runStartYear), YEARLY_FROM), to = Math.min((Number(runEndYear) || 0) + 1, YEARLY_TO);
  const out = [];
  for (let y = from; y <= to; y++) out.push(y);
  return out;
}

module.exports = { annualNameFits, yearlyTag, isAnnualName, yearlyAnnualYears };
