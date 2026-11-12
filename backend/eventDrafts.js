'use strict';
// Draft Timeline events (2026-11-12): an imported event stays hidden from readers until an admin
// turns off "Hidden draft" in the editor. events.draft = 1 marks one. Older databases and test
// fixtures may lack the column, so every check asks first instead of assuming it.
const known = new WeakMap();

function hasDraft(db) {
  if (!known.has(db)) {
    let v = false;
    try { v = db.prepare('PRAGMA table_info(events)').all().some(c => c.name === 'draft'); } catch {}
    known.set(db, v);
  }
  return known.get(db);
}

function ensure(db) {
  try { if (!hasDraft(db)) db.exec('ALTER TABLE events ADD COLUMN draft INTEGER DEFAULT 0'); } catch {}
  known.delete(db);
  return hasDraft(db);
}

// SQL condition for "published" events; `alias` is the events table alias, if any.
function published(db, alias = '') {
  return hasDraft(db) ? `COALESCE(${alias ? alias + '.' : ''}draft, 0) = 0` : '1 = 1';
}

module.exports = { hasDraft, ensure, published };
