const crypto = require('crypto');
function assetKey(kind, name) {
  let key = String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (kind === 'publisher') key = key.replace(/ comics$/, '').trim();
  return key;
}
function registerBranding(app, { db, requireAuth, requireAdmin, express, sharp }) {
  db.exec('CREATE TABLE IF NOT EXISTS branding_assets (kind TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, image BLOB NOT NULL, version TEXT NOT NULL, scale REAL NOT NULL DEFAULT 1, aliases TEXT NOT NULL DEFAULT \'[]\', PRIMARY KEY(kind,key))');
  const valid = (req, res, next) => {
    if (!['publisher','character'].includes(req.params.kind) || !req.params.key || req.params.key.length > 120 || assetKey(req.params.kind, req.params.key) !== req.params.key) return res.status(400).json({error:'Invalid artwork identity.'});
    next();
  };
  app.get('/api/branding', requireAuth, (req,res) => res.json(db.prepare('SELECT kind,key,name,version,scale,aliases FROM branding_assets').all().map(row=>({...row, aliases:JSON.parse(row.aliases)}))));
  app.get('/api/branding/:kind/:key/image', requireAuth, valid, (req,res)=>{
    const row=db.prepare('SELECT image FROM branding_assets WHERE kind=? AND key=?').get(req.params.kind,req.params.key);
    if(!row)return res.sendStatus(404);
    res.set('Cache-Control','private, max-age=0, must-revalidate').type('png').send(row.image);
  });
  app.put('/api/branding/:kind/:key/image', requireAdmin, valid, express.raw({type:['image/png','image/jpeg'],limit:'5mb'}), async(req,res)=>{
    if(!Buffer.isBuffer(req.body)||!req.body.length)return res.status(400).json({error:'Choose a PNG or JPEG image (up to 5 MB).'});
    try {
      const crop=req.query.crop === undefined ? undefined : JSON.parse(req.query.crop);
      const image=await require('./brandingImage').prepareBrandingImage(sharp,req.body,crop);
      const conflicts=db.prepare('SELECT key,aliases FROM branding_assets WHERE kind=? AND key<>?').all(req.params.kind,req.params.key);
      if(conflicts.some(other=>JSON.parse(other.aliases).includes(req.params.key)))return res.status(409).json({error:'This name is already an alias of another upload.'});
      const version=crypto.randomUUID();
      db.prepare('INSERT INTO branding_assets(kind,key,name,image,version) VALUES (?,?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET image=excluded.image, version=excluded.version').run(req.params.kind,req.params.key,req.params.key,image,version);
      res.json({version});
    } catch(error) { res.status(400).json({error:'Unable to save this image. Use a valid PNG or JPEG under 16 megapixels and a crop containing visible artwork.'}); }
  });
  app.patch('/api/branding/:kind/:key',requireAdmin,valid,(req,res)=>{
    const {kind,key}=req.params; const row=db.prepare('SELECT key FROM branding_assets WHERE kind=? AND key=?').get(kind,key);if(!row)return res.sendStatus(404);
    const scale=Number(req.body.scale);const aliases=req.body.aliases;
    if(!Number.isFinite(scale)||scale<0.5||scale>1||!Array.isArray(aliases)||aliases.length>30||aliases.some(a=>typeof a!=='string'||a.length>120))return res.status(400).json({error:'Invalid size or aliases.'});
    const normalized=[...new Set(aliases.map(a=>assetKey(kind,a)).filter(a=>a&&a!==key))];
    const others=db.prepare('SELECT key,aliases FROM branding_assets WHERE kind=? AND key<>?').all(kind,key);
    if(others.some(other=>[other.key,...JSON.parse(other.aliases)].some(a=>[key,...normalized].includes(a))))return res.status(409).json({error:'An alias is already assigned to another upload.'});
    db.prepare('UPDATE branding_assets SET scale=?,aliases=?,version=? WHERE kind=? AND key=?').run(scale,JSON.stringify(normalized),crypto.randomUUID(),kind,key);res.json({ok:true});
  });
  app.delete('/api/branding/:kind/:key',requireAdmin,valid,(req,res)=>{db.prepare('DELETE FROM branding_assets WHERE kind=? AND key=?').run(req.params.kind,req.params.key);res.json({ok:true});});
  app.use('/api/branding', (error,req,res,next)=>{if(error.type==='entity.too.large')return res.status(413).json({error:'Image must be 5 MB or smaller.'});next(error);});
}
module.exports={registerBranding,assetKey};
