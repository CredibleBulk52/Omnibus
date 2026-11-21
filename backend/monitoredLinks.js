'use strict';
// Book ↔ monitored issue links that contradict the book's own Comic Vine ID (2026-11-21).
//
// An old scanner linked files to monitored issues by folder and issue number, so a special or annual
// in a monitored series' folder was linked to the parent's issue with the same number (Knight Terrors:
// Wonder Woman #1 → Wonder Woman #1). The scanner now links by Comic Vine ID only, but its upsert keeps
// a stored link when a scan brings none (scannerState.js BOOK_UPSERT, COALESCE), so the old links
// stayed: 316 books on 2026-11-21. They gave those books another issue's store date, and matching by
// monitored link (event Timelines, reading lists, the shared matcher) could pick the special instead
// of the real issue.
//
// A tagged book's Comic Vine ID is its identity, so a link to any other monitored issue is cleared.
// Run after the link-by-CV step, which has already pointed every book whose ID is monitored at it.
// Untagged books keep their link (nothing contradicts it).
function clearContradictingMonitoredLinks(db) {
  return db.prepare(`UPDATE scanned_books SET monitored_issue_id = NULL
    WHERE monitored_issue_id IS NOT NULL
      AND cv_issue_id IS NOT NULL AND cv_issue_id != ''
      AND monitored_issue_id != cv_issue_id`).run().changes;
}

module.exports = { clearContradictingMonitoredLinks };
