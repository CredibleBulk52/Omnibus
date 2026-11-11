const {assetKey}=require('./branding');
function resolvePublisher(values,assets=[]) {
 const aliases=new Map();
 for(const asset of assets){const key=assetKey('publisher',asset.key);aliases.set(key,key);let names=asset.aliases;try{if(typeof names==='string')names=JSON.parse(names);}catch{names=[];}for(const alias of names||[])aliases.set(assetKey('publisher',alias),key);}
 const found=new Map();
 for(const value of values){const name=typeof value==='string'?value.trim():'';const key=assetKey('publisher',name);if(!key||['unknown','unknown publisher','none','n a'].includes(key))continue;const canonical=aliases.get(key)||key;if(!found.has(canonical))found.set(canonical,name);}
 return found.size===1?[...found.values()][0]:null;
}
function getRunPublisher(db,run,parseComicInfo){
 const values=[];
 if(run.publisher)values.push(run.publisher);
 if(run.cv_volume_id){const linked=db.prepare('SELECT publisher FROM monitored_series WHERE id=?').get(String(run.cv_volume_id));if(linked)values.push(linked.publisher);}
 const rows=db.prepare('SELECT sb.comicinfo,ss.series_json,ms.publisher AS monitored_publisher FROM canon_run_issues cri JOIN scanned_books sb ON sb.id=CAST(cri.scanned_book_id AS TEXT) LEFT JOIN scanned_series ss ON ss.id=sb.series_id LEFT JOIN monitored_series ms ON ms.id=ss.monitored_series_id WHERE cri.run_id=?').all(run.id);
 for(const row of rows){try{values.push(parseComicInfo(row.comicinfo)?.publisher);}catch{}try{const series=JSON.parse(row.series_json||'{}');values.push(series.metadata?.publisher||series.publisher);}catch{}values.push(row.monitored_publisher);}
 const assets=db.prepare("SELECT key,aliases FROM branding_assets WHERE kind='publisher'").all();
 return resolvePublisher(values,assets);
}
module.exports={resolvePublisher,getRunPublisher};
