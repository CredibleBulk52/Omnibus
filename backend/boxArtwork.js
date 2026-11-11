'use strict';
const families = {
 horror: ['Horror','Supernatural','Kaiju'],
 scifi: ['Science Fiction','Cosmic','Cyberpunk','Time Travel','Post-Apocalyptic'],
 fantasy: ['Fantasy','Sword & Sorcery'],
 crime: ['Crime','Mystery','Thriller','Noir','Espionage','Street-Level'],
 comedy: ['Comedy'],
 adventure: ['Pulp','Western','War','Historical','Martial Arts'],
};
const tags = new Map(Object.entries(families).flatMap(([f, ts]) => ts.map(t => [t.toLowerCase(), f])));
const choices = new Set(['auto','default',...Object.keys(families)]);
function selectFamily(series) {
 const seen = new Set(), counts = new Map();
 for (const row of series) {
  if (!row || seen.has(row.id)) continue;
  seen.add(row.id);
  let data = row.series_json;
  try { if (typeof data === 'string') data = JSON.parse(data); } catch { data = null; }
  const genres = data?.metadata?.genres;
  const matches = new Set((Array.isArray(genres) ? genres : []).map(t => typeof t === 'string' ? tags.get(t.trim().toLowerCase()) : null).filter(Boolean));
  for (const f of matches) counts.set(f, (counts.get(f)||0)+1);
 }
 const ranked = [...counts].sort((a,b)=>b[1]-a[1]);
 return !ranked.length || ranked[0][1] === ranked[1]?.[1] ? 'default' : ranked[0][0];
}
const services = new WeakMap();
function create(db) {
 if (services.has(db)) return services.get(db);
 db.exec('CREATE TABLE IF NOT EXISTS box_artwork_preferences (kind TEXT NOT NULL, box_id TEXT NOT NULL, choice TEXT NOT NULL, PRIMARY KEY(kind,box_id))');
 // Prevent a deleted numeric reading-list ID from inheriting an old choice.
 for (const [table,kind] of [['collections','collection'],['reading_lists','order']]) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
   db.exec(`CREATE TRIGGER IF NOT EXISTS box_artwork_delete_${kind} AFTER DELETE ON ${table} BEGIN DELETE FROM box_artwork_preferences WHERE kind='${kind}' AND box_id=CAST(OLD.id AS TEXT); END`);
 }
 const read = db.prepare('SELECT choice FROM box_artwork_preferences WHERE kind=? AND box_id=?');
 const write = db.prepare('INSERT OR REPLACE INTO box_artwork_preferences(kind,box_id,choice) VALUES(?,?,?)');
 const service = {
  describe(kind,id,series) {
   const choice = read.get(kind,String(id))?.choice || 'auto';
   return {choice, family: choice === 'auto' ? selectFamily(series) : choice};
  },
  save(kind,id,choice) {
   if (!choices.has(choice)) throw Object.assign(new Error('Unknown artwork choice'),{status:400});
   write.run(kind,String(id),choice);
  },
  series(ids) {
   const unique=[...new Set(ids.filter(Boolean))], rows=[];
   for(let i=0;i<unique.length;i+=400) {
    const batch=unique.slice(i,i+400);
    rows.push(...db.prepare(`SELECT id,series_json FROM scanned_series WHERE id IN (${batch.map(()=>'?').join(',')})`).all(...batch));
   }
   return rows;
  },
 };
 services.set(db,service); return service;
}
module.exports={selectFamily,create,families};
