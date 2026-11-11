'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
let Database;
try { Database = require('better-sqlite3'); } catch { Database = null; }
const { createBoxSharing } = require('./boxSharing');

function setup() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT);
    CREATE TABLE collections (id TEXT PRIMARY KEY, name TEXT, description TEXT, era TEXT, publisher TEXT, cover_series_id TEXT, condition_group TEXT,
      collection_type TEXT DEFAULT 'manual', owner_id TEXT, visibility TEXT DEFAULT 'public', sort_order INTEGER, library_id TEXT, cover_image TEXT,
      cover_position TEXT, card_description TEXT, purpose TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE collection_rules (id INTEGER PRIMARY KEY, collection_id TEXT, rule_type TEXT, rule_value TEXT);
    CREATE TABLE collection_series (collection_id TEXT, series_id TEXT, manually_added INTEGER, PRIMARY KEY (collection_id, series_id));
    INSERT INTO users VALUES ('ann', 'Ann'), ('bob', 'Bob');
    INSERT INTO collections (id, name, owner_id, visibility, cover_image) VALUES ('lib', 'Library box', NULL, 'public', NULL),
      ('a1', 'Cosmic favourites', 'ann', 'private', 'art.png'), ('pull', 'My Pull Box', 'ann', 'private', NULL);
    UPDATE collections SET purpose = 'pull' WHERE id = 'pull';
    INSERT INTO collection_series VALUES ('a1', 's1', 1), ('a1', 's2', 1);`);
  const sharing = createBoxSharing({ db, collectionSeriesIds: col => db.prepare('SELECT series_id FROM collection_series WHERE collection_id = ?').all(col.id).map(r => r.series_id) });
  return { db, sharing };
}
const box = (db, id) => db.prepare('SELECT * FROM collections WHERE id = ?').get(id);

test('box sharing: only the owner shares; others see, follow and copy a shared box', { skip: !Database }, () => {
  const { db, sharing } = setup();
  assert.equal(sharing.canView(box(db, 'a1'), 'bob'), false);              // private
  assert.throws(() => sharing.follow('bob', 'a1', true), /Only a shared box/);
  assert.throws(() => sharing.share('bob', 'a1', true), /Only the owner/);
  assert.throws(() => sharing.share('ann', 'lib', true), /Only the owner/);   // library boxes are not personal
  const s = sharing.share('ann', 'a1', true);
  assert.equal(s.shared, true);
  assert.equal(sharing.canView(box(db, 'a1'), 'bob'), true);
  assert.equal(box(db, 'lib').visibility, 'public');                          // library boxes untouched
  // Bob sees it among shared boxes, follows it; Ann does not see her own there.
  assert.deepEqual(sharing.sharedWith('bob').map(b => [b.id, b.owner_name, b.following, b.seriesCount]), [['a1', 'Ann', false, 2]]);
  assert.deepEqual(sharing.sharedWith('ann'), []);
  assert.throws(() => sharing.follow('ann', 'a1', true), /your own box/);
  assert.equal(sharing.follow('bob', 'a1', true).following, true);
  assert.equal(sharing.describe(box(db, 'a1'), 'ann').follower_count, 1);
  // Copy: an editable private box of Bob's with the same series and artwork.
  const c = sharing.copy('bob', 'a1');
  const copied = box(db, c.id);
  assert.equal(copied.owner_id, 'bob'); assert.equal(copied.visibility, 'private'); assert.equal(copied.cover_image, 'art.png');
  assert.deepEqual(db.prepare('SELECT series_id FROM collection_series WHERE collection_id = ? ORDER BY series_id').all(c.id).map(r => r.series_id), ['s1', 's2']);
  // Unsharing removes it from followers.
  sharing.share('ann', 'a1', false);
  assert.equal(sharing.describe(box(db, 'a1'), 'bob').following, false);
  assert.equal(sharing.canView(box(db, 'a1'), 'bob'), false);
  assert.throws(() => sharing.copy('bob', 'a1'), /Not found/);
});

test('box sharing: My Pull Box can be shared; its copy is named after its owner', { skip: !Database }, () => {
  const { db, sharing } = setup();
  sharing.share('ann', 'pull', true);
  const c = sharing.copy('bob', 'pull');
  assert.equal(c.name, "Ann's pulls");
  assert.equal(box(db, c.id).purpose, null);                                  // a copy is an ordinary box, not Bob's Pull Box
});
