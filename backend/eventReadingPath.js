const validPath = value => ['essential', 'recommended', 'all'].includes(value) ? value : 'all';
const includes = (i, p) => p === 'all' || i.tier === 'essential' || (p === 'recommended' && i.tier === 'recommended');
function eventReadingPath(rows, bookId, requested) {
  const path = validPath(requested);
  const index = rows.findIndex(i => i.scanned_book_id === bookId);
  const selected = rows.filter(i => includes(i, path));
  const owned = i => !!i.scanned_book_id;
  const after = index < 0 ? [] : rows.slice(index + 1);
  const before = index < 0 ? [] : rows.slice(0, index);
  return {
    path, total: selected.length,
    position: index < 0 || !includes(rows[index], path) ? null : rows.slice(0, index + 1).filter(i => includes(i, path)).length,
    remainingOther: selected.filter(i => i.scanned_book_id !== bookId && !i.completed).length,
    prev: before.filter(i => owned(i) && includes(i, path)).at(-1) || null,
    next: after.find(i => owned(i) && includes(i, path)) || null,
    nextAll: after.find(owned) || null,
    nextRecommended: after.find(i => owned(i) && includes(i, 'recommended')) || null,
    nextEssential: after.find(i => owned(i) && includes(i, 'essential')) || null,
  };
}
module.exports = { eventReadingPath };

function getEventPathIssues(db, eventId, userId) {
    return db.prepare(`
      SELECT ei.sort_order, sb.id AS scanned_book_id, ei.tier, ei.tier_note,
             COALESCE(sb.title, ei.issue_title, sb.filename) AS display_title,
             ei.series_name, ei.issue_number, rp.completed
      FROM event_issues ei
      LEFT JOIN scanned_books sb ON sb.id = ei.scanned_book_id
      LEFT JOIN read_progress rp ON rp.book_id = sb.id AND rp.user_id = ?
      WHERE ei.event_id = ? ORDER BY ei.sort_order
    `).all(userId || null, eventId);
}
module.exports.getEventPathIssues = getEventPathIssues;
