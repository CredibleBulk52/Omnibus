 'use strict';
const {randomUUID} = require('node:crypto');
const parse = text => {try{return JSON.parse(text || '{}') || {};}catch{return {};}};
module.exports = function createRegistry(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS essential_collections (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, position INTEGER NOT NULL DEFAULT 0, appearance_json TEXT NOT NULL DEFAULT '{}', pinned_json TEXT NOT NULL DEFAULT '[]', legacy_key TEXT)`);
 const all = () => db.prepare('SELECT * FROM essential_collections ORDER BY position, name').all().map(r=>({id:r.id,name:r.name,appearance:parse(r.appearance_json),pinned:parse(r.pinned_json),legacyKey:r.legacy_key}));
 const find = value => db.prepare('SELECT * FROM essential_collections WHERE id=? OR name=? COLLATE NOCASE').get(value,value);
 function ensure(name) {
  const existing=find(name)||db.prepare('SELECT id FROM essential_collections WHERE legacy_key=?').get(/^(DC|Marvel)( Comics)?$/i.test(name)?(name.toLowerCase().startsWith('dc')?'DC':'Marvel'):'group:'+name.toLowerCase());if(existing)return existing.id;
  const id='ec_'+randomUUID();
  const publisher=/^(DC|Marvel)( Comics)?$/i.test(name),normalized=publisher?(name.toLowerCase().startsWith('dc')?'DC':'Marvel'):name;
  const key=publisher?normalized:'group:'+name.toLowerCase();
  let notes={};if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get())notes=parse(db.prepare("SELECT value FROM settings WHERE key='catalog_publisher_notes'").get()?.value);
  const alias=notes.essentials?.[key],display=typeof alias==='string'&&alias.trim().length<=60&&!find(alias.trim())?alias.trim():name;
  db.prepare('INSERT INTO essential_collections (id,name,position,legacy_key,appearance_json) VALUES (?,?,?,?,?)').run(id,display,all().length,key,JSON.stringify(notes.essentials_styles?.[key]||{}));
  return id;
 }
 function migrate(resolveCatalog) {
  db.transaction(()=>{for(const row of db.prepare("SELECT * FROM reading_lists WHERE visibility='essential'").all()) {
   const saved=parse(row.catalog_json),catalog=resolveCatalog(row);
   const names=Array.isArray(saved.collections)?saved.collections:catalog.by_publisher?catalog.publishers:catalog.group?[catalog.group]:[];
   const ids=[...new Set(names.map(ensure))];
   if(JSON.stringify(ids)!==JSON.stringify(saved.collections)) db.prepare('UPDATE reading_lists SET catalog_json=? WHERE id=?').run(JSON.stringify({...saved,collections:ids}),row.id);
  }})();
 }
 function register(app,auth) {
  app.get('/api/essential-collections',auth,(req,res)=>res.json({collections:all()}));
  app.post('/api/essential-collections',auth,(req,res)=> {
   if(req.user?.role!=='admin')return res.status(403).json({error:'Administrator access required'});
   const b=req.body||{},name=typeof b.name==='string'?b.name.trim():'';
   if(!name||name.length>60)return res.status(400).json({error:'Use a collection name of 1–60 characters'});
   const old=b.id?find(b.id):null,duplicate=find(name);
   if(b.id&&!old)return res.status(404).json({error:'Collection not found'});
   if(duplicate&&duplicate.id!==old?.id)return res.status(409).json({error:'A collection with that name already exists'});
   const a=b.appearance||{},look={};
   for(const k of ['publisher','character'])if(typeof a[k]==='string'&&a[k].length<=100)look[k]=a[k];
   for(const k of ['fill','accent'])if(/^#[0-9a-f]{6}$/i.test(a[k]||''))look[k]=a[k];
   const pinned=Array.isArray(b.pinned)?[...new Set(b.pinned.map(String))].slice(0,100):[];
   const valid=new Set(db.prepare("SELECT id FROM reading_lists WHERE visibility='essential'").all().map(r=>String(r.id)));
   if(pinned.some(id=>!valid.has(id)))return res.status(400).json({error:'A selected journey is no longer available'});
   const members=b.members===undefined?null:Array.isArray(b.members)?[...new Set(b.members.map(String))]:false;
   if(members===false||members?.some(id=>!valid.has(id)))return res.status(400).json({error:'Choose existing Essential reading orders'});
   if(members&&pinned.some(id=>!members.includes(id)))return res.status(400).json({error:'Pinned journeys must belong to this collection'});
   try {
    const id=old?.id||'ec_'+randomUUID();
    db.transaction(()=>{
    if(!old)db.prepare('INSERT INTO essential_collections (id,name,position) VALUES (?,?,?)').run(id,name,all().length);
    db.prepare('UPDATE essential_collections SET name=?,appearance_json=?,pinned_json=? WHERE id=?').run(name,JSON.stringify(look),JSON.stringify(pinned),id);
    if(members)for(const row of db.prepare("SELECT id,catalog_json FROM reading_lists WHERE visibility='essential'").all()){
     const catalog=parse(row.catalog_json),before=Array.isArray(catalog.collections)?catalog.collections:[];
     const kept=before.filter(v=>v!==id&&!(old&&String(v).toLowerCase()===old.name.toLowerCase()));
     if(members.includes(String(row.id)))kept.push(id);
     if(JSON.stringify(before)!==JSON.stringify(kept))db.prepare('UPDATE reading_lists SET catalog_json=? WHERE id=?').run(JSON.stringify({...catalog,collections:kept}),row.id);
    }
    })();
    res.json({ok:true,id,collections:all()});
   }catch(e){res.status(400).json({error:'Unable to save collection'});}
  });
  app.delete('/api/essential-collections/:id',auth,(req,res)=>{
   if(req.user?.role!=='admin')return res.status(403).json({error:'Administrator access required'});
   const record=db.prepare('SELECT * FROM essential_collections WHERE id=?').get(req.params.id);
   if(!record)return res.status(404).json({error:'Collection not found'});
   db.transaction(()=>{
    for(const row of db.prepare('SELECT id,catalog_json FROM reading_lists WHERE catalog_json IS NOT NULL').all()){
     const catalog=parse(row.catalog_json);
     if(!Array.isArray(catalog.collections))continue;
     const kept=catalog.collections.filter(v=>v!==record.id&&String(v).toLowerCase()!==record.name.toLowerCase());
     if(kept.length!==catalog.collections.length)db.prepare('UPDATE reading_lists SET catalog_json=? WHERE id=?').run(JSON.stringify({...catalog,collections:kept}),row.id);
    }
    db.prepare('DELETE FROM essential_collections WHERE id=?').run(record.id);
   })();res.json({ok:true,collections:all()});
  });
  app.post('/api/essential-collections/order',auth,(req,res)=>{
   if(req.user?.role!=='admin')return res.status(403).json({error:'Administrator access required'});
   const ids=req.body?.ids,existing=all().map(c=>c.id);
   if(!Array.isArray(ids)||ids.length!==existing.length||new Set(ids).size!==ids.length||ids.some(id=>!existing.includes(id)))return res.status(400).json({error:'Reload collections before reordering'});
   db.transaction(()=>ids.forEach((id,i)=>db.prepare('UPDATE essential_collections SET position=? WHERE id=?').run(i,id)))();res.json({ok:true,collections:all()});
  });
 }
 return {all,find,ensure,migrate,register,names:values=>values?.map(v=>find(v)?.name||v)};
};
