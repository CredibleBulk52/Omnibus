'use strict';
// ─── Sharing and following boxes (2026-11-03, claude/BOXES_UNIFIED_PLAN.md stage 2) ──
// Any personal series box can be shared; other users follow it (a live link: they see the
// owner's changes) or copy it into an editable box of their own. Reading orders are reading
// lists and keep their own sharing ('public' visibility) and follows (reading_list_follows).
//
// visibility on collections:
//   library box (owner_id NULL)  'public'  — the admin's boxes, unchanged
//   personal box                 'private' (default) | 'shared'
// A shared personal box never appears among the library boxes: those are owner_id NULL.

function applyBoxSharingSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS collection_follows (
    user_id TEXT NOT NULL, collection_id TEXT NOT NULL, followed_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, collection_id));
  CREATE INDEX IF NOT EXISTS idx_collection_follows_box ON collection_follows(collection_id);`);
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

function createBoxSharing({ db, collectionSeriesIds = null, onCopy = null }) {
  applyBoxSharingSchema(db);
  const getBox = id => db.prepare('SELECT * FROM collections WHERE id = ?').get(String(id));
  // Who may see a box: library boxes everyone, personal boxes their owner, shared boxes everyone.
  const canView = (col, userId) => !!col && (!col.owner_id || col.owner_id === userId || col.visibility === 'shared');
  const ownerName = col => (col?.owner_id ? db.prepare('SELECT username FROM users WHERE id = ?').get(col.owner_id)?.username || null : null);
  const followRow = (userId, id) => db.prepare('SELECT followed_at FROM collection_follows WHERE user_id = ? AND collection_id = ?').get(userId, String(id));
  const followers = id => db.prepare('SELECT COUNT(*) AS n FROM collection_follows WHERE collection_id = ?').get(String(id)).n;
  const countOf = col => { try { return collectionSeriesIds ? collectionSeriesIds(col, null).length : null; } catch { return null; } };

  // Extra fields for one box as seen by userId.
  function describe(col, userId) {
    const f = followRow(userId, col.id);
    return { owner_name: ownerName(col), is_owner: !!col.owner_id && col.owner_id === userId, shared: col.visibility === 'shared',
      following: !!f, followed_at: f?.followed_at || null, follower_count: col.owner_id ? followers(col.id) : 0 };
  }

  // Other users' shared boxes, followed ones flagged.
  function sharedWith(userId) {
    return db.prepare("SELECT * FROM collections WHERE visibility = 'shared' AND owner_id IS NOT NULL AND owner_id != ? ORDER BY updated_at DESC").all(userId || '')
      .map(c => ({ ...c, conditionGroup: c.condition_group, collectionType: c.collection_type, seriesCount: countOf(c), ...describe(c, userId) }));
  }

  function share(userId, id, on) {
    const col = getBox(id);
    if (!col) throw httpError(404, 'Not found');
    if (!col.owner_id || col.owner_id !== userId) throw httpError(403, 'Only the owner can share this box.');
    db.prepare("UPDATE collections SET visibility = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(on ? 'shared' : 'private', col.id);
    // No longer shared: it leaves its followers' boxes.
    if (!on) db.prepare('DELETE FROM collection_follows WHERE collection_id = ?').run(col.id);
    return { ...getBox(col.id), ...describe(getBox(col.id), userId) };
  }

  function follow(userId, id, on) {
    const col = getBox(id);
    if (!col) throw httpError(404, 'Not found');
    if (on) {
      if (col.visibility !== 'shared' || !col.owner_id) throw httpError(400, 'Only a shared box can be followed.');
      if (col.owner_id === userId) throw httpError(400, 'This is your own box.');
      db.prepare('INSERT OR IGNORE INTO collection_follows (user_id, collection_id) VALUES (?, ?)').run(userId, col.id);
    } else db.prepare('DELETE FROM collection_follows WHERE user_id = ? AND collection_id = ?').run(userId, col.id);
    return describe(col, userId);
  }

  // An editable copy in the user's own boxes: same kind, rules, series, text and artwork.
  function copy(userId, id) {
    const col = getBox(id);
    if (!col || !canView(col, userId)) throw httpError(404, 'Not found');
    const newId = `col_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const name = col.purpose === 'pull' ? `${ownerName(col) || 'Shared'}'s pulls` : col.name;
    db.transaction(() => {
      db.prepare(`INSERT INTO collections (id, name, description, era, publisher, cover_series_id, condition_group, collection_type, owner_id, visibility, sort_order, library_id, cover_image, cover_position, card_description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', 0, NULL, ?, ?, ?)`)
        .run(newId, name, col.description, col.era, col.publisher, col.cover_series_id, col.condition_group, col.collection_type || 'manual', userId,
          col.cover_image, col.cover_position, col.card_description ?? null);
      for (const r of db.prepare('SELECT rule_type, rule_value FROM collection_rules WHERE collection_id = ?').all(col.id))
        db.prepare('INSERT INTO collection_rules (collection_id, rule_type, rule_value) VALUES (?, ?, ?)').run(newId, r.rule_type, r.rule_value);
      for (const r of db.prepare('SELECT series_id, manually_added FROM collection_series WHERE collection_id = ?').all(col.id))
        db.prepare('INSERT OR IGNORE INTO collection_series (collection_id, series_id, manually_added) VALUES (?, ?, ?)').run(newId, r.series_id, r.manually_added);
      if (onCopy) onCopy(col.id, newId);   // e.g. its missing-series placeholders
    })();
    return { id: newId, name };
  }

  const forgetBox = id => db.prepare('DELETE FROM collection_follows WHERE collection_id = ?').run(String(id));

  return { canView, describe, sharedWith, share, follow, copy, forgetBox };
}

function registerBoxSharingRoutes(app, { requireAuth, sharing }) {
  const route = fn => (req, res) => {
    try { res.json(fn(req)); }
    catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Unable to update the box.' }); }
  };
  const me = req => req.user?.sub || null;
  app.get('/api/boxes/shared', requireAuth, route(req => ({ boxes: sharing.sharedWith(me(req)) })));
  app.post('/api/collections/:id/share', requireAuth, route(req => sharing.share(me(req), req.params.id, req.body?.shared !== false)));
  app.post('/api/collections/:id/follow', requireAuth, route(req => sharing.follow(me(req), req.params.id, true)));
  app.delete('/api/collections/:id/follow', requireAuth, route(req => sharing.follow(me(req), req.params.id, false)));
  app.post('/api/collections/:id/copy', requireAuth, route(req => sharing.copy(me(req), req.params.id)));
}

module.exports = { applyBoxSharingSchema, createBoxSharing, registerBoxSharingRoutes };
