'use strict';
// ─── Store dates in ComicInfo (2026-11-19) ───────────────────────────
// ComicInfo has no store-date field: Year/Month/Day are the cover date (other readers treat them so,
// and Comic Vine's cover dates always fall on the 1st). Omnibus writes the on-sale day as its own
// element, <StoreDate>YYYY-MM-DD</StoreDate> (the name MetronInfo.xml uses), from Comic Vine or, when
// Comic Vine has none, Metron. Readers that do not know the element ignore it.
// scanned_books.store_date is computed from comicinfo by SQLite with STORE_DATE_SQL, so every path
// that saves ComicInfo keeps it current. See claude/SERIES_READING_ORDER.md (store-date plan).

const OPEN = '<StoreDate>', CLOSE = '</StoreDate>';

// SQL expression over scanned_books.comicinfo: the first <StoreDate> holding exactly a YYYY-MM-DD
// value, else NULL. Calendar validity is checked in JS (validStoreDate); SQL only checks the shape.
const at = `instr(comicinfo, '${OPEN}')`;
const value = `substr(comicinfo, ${at} + ${OPEN.length}, 10)`;
const STORE_DATE_SQL = `CASE WHEN ${at} > 0
  AND ${value} GLOB '[12][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'
  AND substr(comicinfo, ${at} + ${OPEN.length + 10}, ${CLOSE.length}) = '${CLOSE}'
  THEN ${value} END`.replace(/\s+/g, ' ');

function validStoreDate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const d = new Date(text + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === text ? text : null;
}

// The same rule in JS, for code that has the XML text but not the row.
function storeDateFromComicInfo(xml) {
  if (typeof xml !== 'string') return null;
  const i = xml.indexOf(OPEN);
  if (i < 0 || xml.slice(i + OPEN.length + 10, i + OPEN.length + 10 + CLOSE.length) !== CLOSE) return null;
  return validStoreDate(xml.slice(i + OPEN.length, i + OPEN.length + 10));
}

// MetronInfo.xml's <StoreDate> (MetronTagger writes it; Omnibus does not write MetronInfo).
function storeDateFromMetronInfo(xml) {
  if (typeof xml !== 'string') return null;
  const m = /<StoreDate>\s*(\d{4}-\d{2}-\d{2})\s*<\/StoreDate>/.exec(xml);
  return m ? validStoreDate(m[1]) : null;
}

module.exports = { STORE_DATE_SQL, validStoreDate, storeDateFromComicInfo, storeDateFromMetronInfo };
