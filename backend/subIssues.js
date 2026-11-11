'use strict';
// ─── subIssues.js ─────────────────────────────────────────────────
// Annuals and specials filed inside a parent series' folder (user 2026-10-26).
// They belong to the parent series, but readers search for them by the name
// they were published under ("Batman Annual 3", "Queen in Black: Hela"). This
// gives each such book its published name, year, number and kind, so the
// search bar and the editor's Add window can find the issue and show the
// parent series it is filed in. They are never listed as series of their own.
//
// Name: the ComicInfo series name (book_ci_index) when it differs from the
// folder; otherwise one made from the file name ("Sinestro Annual 001
// (After 11).cbz" → "Sinestro Annual"); otherwise "<folder> Annual/Special".

const key = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '');

function kindOf(b) {
  if (/annual/i.test(b.filename || '') || /annual/i.test(b.ci_series || '')) return 'annual';
  if (b.is_special) return 'special';
  return null;
}

// "Superman - House of Brainiac Special 001 (2024) (digital).cbz" → "Superman: House of Brainiac Special"
function nameFromFile(filename) {
  let t = String(filename || '').replace(/\.[a-z0-9]{2,4}$/i, '');
  t = t.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/\s#?\d+(?:\.\d+)?[a-z]?$/i, '');            // the issue number at the end
  return t.replace(/\s+-\s+/g, ': ').replace(/\s+/g, ' ').trim();
}

function describe(b, folderName) {
  const kind = kindOf(b);
  if (!kind) return null;
  const folder = key(folderName);
  let name = b.ci_series && key(b.ci_series) !== folder ? b.ci_series : null;
  if (!name) { const f = nameFromFile(b.filename); if (f && key(f) !== folder) name = f; }
  if (!name) name = new RegExp(`\\b${kind}$`).test(folder) ? folderName : `${folderName} ${kind === 'annual' ? 'Annual' : 'Special'}`;
  const fy = String(b.filename || '').match(/\((19[3-9]\d|20[0-4]\d)\)/);
  return { kind, name, year: Number(b.ci_year) || (fy ? Number(fy[1]) : null), number: b.ci_number || b.issue_number || null };
}

// Every annual and special in the library:
// [{ id, series_id, folder_name, folder_year, title, kind, name, year, number }].
function loadSubIssues(db, { libraryId = null } = {}) {
  const sql = ci => `SELECT sb.id, sb.series_id, sb.filename, sb.issue_number, sb.title, sb.is_special, ss.name AS folder_name, ss.year AS folder_year
      ${ci ? ', ci.series_name AS ci_series, ci.volume_year AS ci_year, ci.orig_number AS ci_number' : ''}
    FROM scanned_books sb JOIN scanned_series ss ON ss.id = sb.series_id ${ci ? 'LEFT JOIN book_ci_index ci ON ci.book_id = sb.id' : ''}
    WHERE (sb.is_special = 1 OR lower(sb.filename) LIKE '%annual%') ${libraryId ? 'AND ss.library_id = ?' : ''}`;
  const args = libraryId ? [libraryId] : [];
  let rows;
  try { rows = db.prepare(sql(true)).all(...args); }
  catch { try { rows = db.prepare(sql(false)).all(...args); } catch { return []; } }
  const out = [];
  for (const b of rows) {
    const d = describe(b, b.folder_name);
    if (d) out.push({ id: b.id, series_id: b.series_id, folder_name: b.folder_name, folder_year: b.folder_year || null, title: b.title || null, ...d });
  }
  return out;
}

module.exports = { loadSubIssues, describe, nameFromFile, kindOf, key };
