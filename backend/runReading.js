'use strict';

// Progress is personal to the signed-in reader, never inherited from another user.
function getRunIssues(db, runId, userId, parseComicInfo) {
  return db.prepare(`
    SELECT cri.*, sb.id AS owned_book_id, sb.filename AS book_filename,
      sb.path AS book_path, sb.comicinfo, ss.name AS series_name_resolved,
      rp.page AS reading_page, rp.completed AS reading_completed
    FROM canon_run_issues cri
    LEFT JOIN scanned_books sb ON sb.id = CAST(cri.scanned_book_id AS TEXT)   -- column is INTEGER, ids are text: the cast lets the index work (1.3 s → 1 ms)
    LEFT JOIN scanned_series ss ON ss.id = sb.series_id
    LEFT JOIN read_progress rp ON rp.book_id = sb.id AND rp.user_id = ?
    WHERE cri.run_id = ? ORDER BY cri.sort_order ASC, cri.id ASC
  `).all(userId || null, runId).map(({ owned_book_id, comicinfo, reading_page, reading_completed, ...issue }) => ({
    ...issue,
    scanned_book_id: owned_book_id || null,
    media: { pagesCount: comicinfo ? Number(parseComicInfo(comicinfo).pageCount) || null : null },
    readProgress: reading_page != null || reading_completed != null
      ? { page: Number(reading_page) || 0, completed: !!reading_completed } : null,
  }));
}
module.exports = { getRunIssues };
