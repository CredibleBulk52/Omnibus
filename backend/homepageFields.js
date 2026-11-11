'use strict';
const tables = new Set(['events','canon_runs','reading_lists']);
function ensure(db, names) {
  for (const table of names) {
    if (!tables.has(table)) throw new Error('Invalid homepage table');
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    for (const name of ['home_tagline','home_description']) if (!cols.some(c=>c.name===name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} TEXT`);
  }
}
function changes(body) {
  const next={};
  for (const [name,max] of [['home_tagline',120],['home_description',400]]) if (Object.prototype.hasOwnProperty.call(body,name)) {
    if (body[name] != null && (typeof body[name] !== 'string' || body[name].length > max)) { const e=new Error(`Invalid ${name}: use at most ${max} characters`);e.status=400;throw e; }
    next[name]=body[name]?.trim() || null;
  }
  return next;
}
function write(db, table, id, details) {
  if(!tables.has(table))throw new Error('Invalid homepage table');
  db.prepare(`UPDATE ${table} SET home_tagline=?, home_description=? WHERE id=?`).run(details.home_tagline || null,details.home_description || null,id);
}
module.exports={ensure,changes,write};
