'use strict';
// ─── Registering a filed download (moved out of server.js 2026-11-19, server.js split step 6b) ───
// The shared metadata runtime's registerArrival: once a download is tagged and published into a
// library folder, record the series (if new) and the book with its stable ids, file a "Special of"
// download as a special, mark the monitored issue processed, and record the success for the
// metadata queue, all in the runtime's own transaction (connection). Moved unchanged.
const path = require('path');

module.exports.createRegisterArrival = function createRegisterArrival(deps) {
  const missing = ['makeScanStmts', 'metadataMaintenance', 'parseComicInfo', 'readSeriesJson', 'stableIds'].filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`createRegisterArrival: missing ${missing.join(', ')}`);
  const { makeScanStmts, metadataMaintenance, parseComicInfo, readSeriesJson, stableIds } = deps;
  return ({connection,operation,prepared,facts}) => {
  const destination=path.normalize(operation.payload.destination),directory=path.dirname(destination);
  const libraries=connection.prepare('SELECT * FROM libraries').all();
  const library=libraries.filter(l=>{const rel=path.relative(l.path,directory);return !rel||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));}).sort((a,b)=>b.path.length-a.path.length)[0];
  if(!library)throw new Error('No library owns the download destination');
  const xml=prepared.validation.comicInfo.xml,ci=parseComicInfo(xml),id=prepared.report.appliedMetadata.cvIssueId;
  const seriesId=stableIds.resolveSeriesId(directory,()=>readSeriesJson(directory));
  const stmts=makeScanStmts();
  const prior=connection.prepare('SELECT id FROM scanned_series WHERE path=?').get(directory);
  if(!prior)stmts.upsertSeries.run(seriesId,library.id,directory,path.basename(directory),null,'none',null,null,0,-1,0);
  const bookId=stableIds.resolveBookId({filePath:destination,seriesId,cvIssueId:id,issueNum:ci.number,fileSize:prepared.validation.fingerprint.size});
  const newBook=!connection.prepare('SELECT 1 FROM scanned_books WHERE id=?').get(bookId);
  stmts.upsertBook.run(bookId,seriesId,destination,path.basename(destination),ci.number||null,ci.title||null,xml,id,null,Number(ci.number)||0,facts.destination.mtimeMs,prepared.validation.fingerprint.size);
  // "Special of …" (user 2026-10-26): a download for a series added as a special is filed as a
  // special (Specials tab, after the regular issues), as the scanner does for new files it routes
  // to a special. Only new books, so an issue unmarked by hand stays unmarked.
  if(newBook&&id&&connection.prepare('SELECT 1 FROM monitored_issues mi JOIN monitored_series ms ON ms.id=mi.series_id WHERE mi.id=? AND (ms.is_special=1 OR ms.parent_series_id IS NOT NULL)').get(String(id)))
    connection.prepare('UPDATE scanned_books SET is_special=1,sort_order=? WHERE id=? AND is_special=0').run(9000+(Number(ci.number)||0),bookId);
  // Arrival status commits with the stable book, not in a later downloader
  // callback that a restart could lose. Existing other-copy links stay put.
  connection.prepare("UPDATE monitored_issues SET status='processed',file_path=?,date_processed=datetime('now'),has_comicinfo=1 WHERE id=? AND (file_path IS NULL OR file_path=?)")
    .run(destination,id,path.normalize(operation.payload.source));
  // Queue success commits with registration, including recovery durability.
  metadataMaintenance.recordSuccess(bookId,prepared.report.appliedMetadata,'download');
  return bookId;
};
};
