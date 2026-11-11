'use strict';
const path = require('node:path');
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal = (a, b) => a?.sha256 === b?.sha256 && a?.size === b?.size;

// Explicit installation only; no production DB is opened by this module.
function initializeBookFinalization(db) {
  if (db.inTransaction || db.isTransaction) throw new Error('Initialize outside caller transactions');
  db.exec('BEGIN IMMEDIATE');
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS metadata_book_revisions (
      book_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL,
      archive_revision TEXT NOT NULL, metadata_revision TEXT NOT NULL, page_revision TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metadata_book_followups (
      operation_id TEXT PRIMARY KEY, book_id TEXT NOT NULL, payload TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete')));
    CREATE TABLE IF NOT EXISTS metadata_book_managed (
      book_id TEXT PRIMARY KEY, cv_issue_id TEXT NOT NULL, operation_id TEXT NOT NULL,
      record TEXT NOT NULL);
    `); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

// Only internal, validated preparation results belong here. This is not an
// endpoint accepting reports from a browser/client. Existing stableIds remains
// the authority; this path never allocates/reclaims or identifies by CV ID.
function createBookFinalizer({ stableIds, bookIndex, prepared }) {
  if (prepared?.status !== 'prepared' || !prepared.report || !prepared.validation) throw new TypeError('Validated prepared candidate required');
  // Snapshot so callers cannot alter the accepted plan while publication runs.
  const report = JSON.parse(JSON.stringify(prepared.report));
  const validation = JSON.parse(JSON.stringify(prepared.validation));
  if (JSON.stringify(report.pages) !== JSON.stringify(validation.pages)
    || JSON.stringify(report.comicInfo) !== JSON.stringify(validation.comicInfo)) throw new TypeError('Candidate readback differs from preparation');
  return (db, operation, execution, facts) => {
    if (!(db.inTransaction || db.isTransaction)) throw new Error('Finalization requires the journal transaction');
    if (!equal(report.sourceFingerprint, operation.payload.sourceFingerprint) || !equal(validation.fingerprint, execution.prepared)) throw new Error('Finalization candidate is not this published operation');
    const book = db.prepare('SELECT * FROM scanned_books WHERE id=?').get(operation.book_id);
    if (!book) throw new Error('Stable book is unavailable');
    const destination = path.normalize(operation.payload.destination);
    const updated = stableIds.updatePublishedBook({ bookId: book.id, expectedPath: book.path, destination,
      comicinfo: validation.comicInfo.xml, fileSize: validation.fingerprint.size, fileMtime: facts.destination.mtimeMs });
    bookIndex.updateBook(updated.id);
    if (report.appliedMetadata) {
      const { bookId, cvIssueId, plan } = report.appliedMetadata;
      if (bookId !== book.id || plan.bookId !== book.id || plan.cvIssueId !== cvIssueId || !['ready','unchanged'].includes(plan.status) || plan.review.length) throw new Error('Invalid applied metadata ownership');
      const record = { bookId, cvIssueId, fields: plan.managedFieldsAfterApply, date: plan.managedDateAfterApply,
        appliedOverrides: report.appliedMetadata.overrides || null, identityProvenance: report.appliedMetadata.identityProvenance || null };
      db.prepare(`INSERT INTO metadata_book_managed VALUES(?,?,?,?) ON CONFLICT(book_id) DO UPDATE SET
        cv_issue_id=excluded.cv_issue_id,operation_id=excluded.operation_id,record=excluded.record`)
        .run(bookId, cvIssueId, operation.id, JSON.stringify(record));
      // First identification fills an empty library ID; conflicting existing
      // identities were held by the shared planner, never overwritten here.
      db.prepare("UPDATE scanned_books SET cv_issue_id=? WHERE id=? AND (cv_issue_id IS NULL OR cv_issue_id='')").run(cvIssueId,bookId);
      // An explicit correction (manual Tag) replaces the saved library ID.
      if (plan.identityCorrection === true) db.prepare('UPDATE scanned_books SET cv_issue_id=? WHERE id=?').run(cvIssueId, bookId);
    }
    const revision = { archive: validation.fingerprint.sha256, metadata: hash(validation.comicInfo.xml), pages: hash(validation.pages) };
    db.prepare(`INSERT INTO metadata_book_revisions VALUES(?,?,?,?,?) ON CONFLICT(book_id) DO UPDATE SET
      operation_id=excluded.operation_id,archive_revision=excluded.archive_revision,metadata_revision=excluded.metadata_revision,page_revision=excluded.page_revision`)
      .run(book.id, operation.id, revision.archive, revision.metadata, revision.pages);
    const followups = { bookId: book.id, revision, order: ['cache_invalidation', 'events', 'canon', 'reading_lists'], preserveManualLinks: true };
    db.prepare('INSERT INTO metadata_book_followups(operation_id,book_id,payload) VALUES(?,?,?)').run(operation.id, book.id, JSON.stringify(followups));
    return { bookId: book.id, source: book.path, destination: updated.path, revision, followups: 'pending' };
  };
}
module.exports = { initializeBookFinalization, createBookFinalizer };
