 'use strict';
const fs=require('node:fs'),path=require('node:path');
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
const inside=(parent,child)=>{const rel=path.relative(parent,child);return !!rel&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);};
// Refuse roots, aliases and nested series. Never follow a symlink during deletion.
function validateFolder(folder,root,otherFolders=[]){
 if(!folder||!root)fail('The series folder or library location is missing.');
 const target=path.resolve(folder),base=fs.realpathSync(root);
 if(!inside(base,target)||fs.realpathSync(target)!==target||!fs.statSync(target).isDirectory())fail('The series must have its own folder inside its library.');
 for(const other of otherFolders){const p=path.resolve(other);if(p===target||inside(target,p))fail('This folder is shared with another series or library.');}
 function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const child=path.join(dir,entry.name);if(fs.lstatSync(child).isSymbolicLink())fail('This folder contains a symbolic link. Remove it before deleting the series.');if(entry.isDirectory())walk(child);}}
 walk(target);return target;
}
function deleteSeries(db,id,confirmedName){
 const series=db.prepare('SELECT * FROM scanned_series WHERE id=?').get(id);
 if(!series)fail('Series not found',404);
 if(confirmedName!==series.name)fail('The series name changed. Reload before deleting.',400);
 const library=db.prepare('SELECT * FROM libraries WHERE id=?').get(series.library_id);
 const others=db.prepare('SELECT path FROM scanned_series WHERE id!=?').all(id).map(r=>r.path);
 others.push(...db.prepare('SELECT path FROM libraries WHERE id!=?').all(series.library_id).map(r=>r.path));
 const folder=validateFolder(series.path,library?.path,others);
 const monitors=db.prepare('SELECT id,directory FROM monitored_series').all().filter(r=>path.resolve(r.directory)===folder||r.id===series.monitored_series_id);
 if(monitors.some(m=>path.resolve(m.directory)!==folder))fail('Monitoring points to a different folder. Resolve that link before deleting.');
 for(const m of monitors){
  if(db.prepare('SELECT id FROM scanned_series WHERE monitored_series_id=? AND id!=?').get(m.id,id))fail('Another library series shares this monitoring record. Resolve that link before deleting.');
  if(db.prepare("SELECT 1 FROM monitored_issues WHERE series_id=? AND status IN ('snatched','downloading','downloaded','processing','queued')").get(m.id)||db.prepare("SELECT 1 FROM series_packs WHERE series_id=? AND status IN ('snatched','downloaded','processing','queued')").get(m.id))fail('This series has downloads in progress. Finish or cancel them before deleting.');
 }
 const books=db.prepare('SELECT id,path FROM scanned_books WHERE series_id=?').all(id);
 if(books.some(b=>!inside(folder,path.resolve(b.path))))fail('An issue is outside the series folder. Resolve its location before deleting.');
 db.transaction(()=>{
  // Remove only this monitor, not its separately stored annual series.
  for(const m of monitors){
   db.prepare('DELETE FROM series_annual_links WHERE parent_series_id=? OR annual_series_id=?').run(m.id,m.id);
   db.prepare('UPDATE scanned_books SET monitored_issue_id=NULL WHERE monitored_issue_id IN (SELECT id FROM monitored_issues WHERE series_id=?)').run(m.id);
   db.prepare('DELETE FROM series_packs WHERE series_id=?').run(m.id);
   db.prepare('DELETE FROM monitored_issues WHERE series_id=?').run(m.id);
   db.prepare('DELETE FROM monitored_series WHERE id=?').run(m.id);
  }
  for(const b of books)db.prepare('DELETE FROM read_progress WHERE book_id=?').run(b.id);
  db.prepare('DELETE FROM scanned_books WHERE series_id=?').run(id);
  db.prepare('DELETE FROM collection_series WHERE series_id=?').run(id);
  db.prepare('DELETE FROM series_user_tags WHERE series_id=?').run(id);
  db.prepare('DELETE FROM scanned_series WHERE id=?').run(id);
  // All SQL constraints have succeeded before removing files. An I/O error rolls
  // back the records, and is reported; filesystem removal itself is not atomic.
  fs.rmSync(folder,{recursive:true,force:false});
 })();
 return {ok:true,bookIds:books.map(b=>b.id)};
}
module.exports={deleteSeries,validateFolder};
