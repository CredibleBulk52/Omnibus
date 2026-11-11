'use strict';
const {randomUUID}=require('node:crypto');
function initializePullSchema(db){
 const columns=db.prepare('PRAGMA table_info(collections)').all();
 for(const [name,type] of [['purpose','TEXT'],['card_description','TEXT']])if(!columns.some(c=>c.name===name))db.exec(`ALTER TABLE collections ADD COLUMN ${name} ${type}`);
 db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_pull_box_per_user ON collections(owner_id) WHERE purpose='pull';
 CREATE TABLE IF NOT EXISTS pull_preferences(user_id TEXT PRIMARY KEY, favorites_handled INTEGER NOT NULL DEFAULT 0);`);
}
function createPullService(db){
 const boxFor=user=>db.prepare("SELECT * FROM collections WHERE owner_id=? AND purpose='pull'").get(user)||null;
 const ensure=user=>{let box=boxFor(user);if(box)return box;const id='pull_'+randomUUID();db.prepare(`INSERT INTO collections(id,name,description,collection_type,owner_id,visibility,library_id,purpose) VALUES (?, 'My Pull Box', 'The series you follow, together in one personal box. Find their available releases on Home under My Pulls.', 'manual', ?, 'private', NULL, 'pull')`).run(id,user);return boxFor(user);};
 const series=id=>db.prepare('SELECT id,name,path FROM scanned_series WHERE id=?').get(id);
 const favorites=user=>db.prepare('SELECT ss.id FROM user_favorites uf JOIN scanned_series ss ON ss.id=uf.series_id WHERE uf.user_id=?').all(user).map(s=>s.id);
 const transaction=fn=>db.transaction(fn)();
 const add=(user,id)=>{if(!series(id)){const e=new Error('Series not found');e.status=404;throw e;}return transaction(()=>{const b=ensure(user);db.prepare('INSERT OR IGNORE INTO collection_series(collection_id,series_id,manually_added) VALUES (?,?,1)').run(b.id,id);return b;});};
 const remove=(user,id)=>{const b=boxFor(user);if(b)db.prepare('DELETE FROM collection_series WHERE collection_id=? AND series_id=?').run(b.id,id);};
 const state=(user,id)=>{const box=boxFor(user);const ids=box?db.prepare('SELECT series_id FROM collection_series WHERE collection_id=?').all(box.id).map(r=>r.series_id):[];const handled=db.prepare('SELECT favorites_handled FROM pull_preferences WHERE user_id=?').get(user)?.favorites_handled;let collecting=null;
 if(id){const s=series(id);if(!s){const e=new Error('Series not found');e.status=404;throw e;}const m=db.prepare('SELECT status FROM monitored_series WHERE directory=?').all(s.path);collecting=m.some(r=>r.status==='active');}
 return {box,seriesIds:ids,pulled:id?ids.includes(id):false,collecting,favoritesCount:handled?0:favorites(user).length};};
 const migrate=(user,skip=false)=>transaction(()=>{if(!skip){const ids=favorites(user);if(ids.length){const b=ensure(user);const stmt=db.prepare('INSERT OR IGNORE INTO collection_series(collection_id,series_id,manually_added) VALUES (?,?,1)');ids.forEach(id=>stmt.run(b.id,id));}}db.prepare('INSERT INTO pull_preferences(user_id,favorites_handled) VALUES (?,1) ON CONFLICT(user_id) DO UPDATE SET favorites_handled=1').run(user);return state(user);});
 const releases=user=>db.prepare(`SELECT sb.*, ss.name AS seriesName, ss.id AS seriesId, COALESCE(mi.store_date,mi.release_date) AS effective_date, mi.issue_number AS mi_issue_number,
 COALESCE(rp.completed,0) AS completed
 FROM scanned_books sb JOIN scanned_series ss ON ss.id=sb.series_id
 JOIN monitored_issues mi ON mi.id=sb.monitored_issue_id
 LEFT JOIN read_progress rp ON rp.book_id=sb.id AND rp.user_id=?
 WHERE EXISTS(SELECT 1 FROM collection_series cs JOIN collections c ON c.id=cs.collection_id WHERE cs.series_id=ss.id AND c.owner_id=? AND c.purpose='pull')
 AND COALESCE(mi.store_date,mi.release_date) IS NOT NULL AND COALESCE(mi.store_date,mi.release_date)<=date('now')
 ORDER BY effective_date DESC, sb.id LIMIT 30`).all(user,user);
 return {boxFor,add,remove,state,migrate,releases};
}
function registerPullRoutes(app,{db,requireAuth,getSeriesRating}){
 initializePullSchema(db);const service=createPullService(db);
 const route=fn=>(req,res)=>{res.set('Cache-Control','no-store');try{res.json(fn(req));}catch(e){res.status(e.status||500).json({error:e.status?e.message:'Unable to update your Pull Box. Please try again.'});}};
 app.get('/api/users/me/pull-box',requireAuth,route(req=>service.state(req.user.sub)));
 app.get('/api/users/me/pull-box/releases',requireAuth,route(req=>({...service.state(req.user.sub),items:service.releases(req.user.sub).map(b=>({...b,issue_number:b.mi_issue_number||b.issue_number,rating:getSeriesRating(b.seriesId)}))})));
 app.get('/api/users/me/pull-box/series/:seriesId',requireAuth,route(req=>service.state(req.user.sub,req.params.seriesId)));
 app.post('/api/users/me/pull-box/series/:seriesId',requireAuth,route(req=>{service.add(req.user.sub,req.params.seriesId);return service.state(req.user.sub,req.params.seriesId);}));
 app.delete('/api/users/me/pull-box/series/:seriesId',requireAuth,route(req=>{service.remove(req.user.sub,req.params.seriesId);return service.state(req.user.sub,req.params.seriesId);}));
 app.post('/api/users/me/pull-box/import-favorites',requireAuth,route(req=>service.migrate(req.user.sub)));
 app.post('/api/users/me/pull-box/skip-favorites',requireAuth,route(req=>service.migrate(req.user.sub,true)));
 return service;
}
module.exports={initializePullSchema,createPullService,registerPullRoutes};
