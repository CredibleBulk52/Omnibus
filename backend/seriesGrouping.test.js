'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createSeriesGrouping } = require('./seriesGrouping');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER, series_json TEXT, book_count INTEGER);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, is_special INTEGER DEFAULT 0);
    CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT, year INTEGER, draft INTEGER DEFAULT 0);
    CREATE TABLE event_issues (id INTEGER PRIMARY KEY, event_id TEXT, scanned_book_id TEXT, tier TEXT, phase TEXT, sort_order INTEGER);`);
  let n = 0;
  const series = (id, name, year, issues, { json = true, status = 'Ended', desc = '', books = issues } = {}) => {
    db.prepare('INSERT INTO scanned_series VALUES (?, ?, ?, ?, ?)').run(id, name, year,
      json ? JSON.stringify({ metadata: { name, year, total_issues: issues, status, description_text: desc } }) : null, books);
    const ids = [];
    for (let i = 0; i < books; i++) { const b = `${id}-${i}`; db.prepare('INSERT INTO scanned_books (id, series_id) VALUES (?, ?)').run(b, id); ids.push(b); }
    return ids;
  };
  const inEvent = (event, bookIds, tier = 'tie-in', phase = '') => bookIds.forEach(b =>
    db.prepare('INSERT INTO event_issues (id, event_id, scanned_book_id, tier, phase, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(++n, event, b, tier, phase, n));
  return { db, series, inEvent };
}

test('event tie-ins are shelved under the event core and hidden; preludes, core minis and landmarks stay visible', () => {
  const { db, series, inEvent } = fixture();
  db.prepare("INSERT INTO events (id, name, year) VALUES ('cw', 'Civil War', 2006), ('nml', 'No Man''s Land', 1999)").run();
  inEvent('cw', series('core', 'Civil War', 2006, 7), 'essential');
  inEvent('cw', series('front', 'Civil War: Front Line', 2006, 11));
  inEvent('cw', series('conf', 'Civil War: The Confession', 2007, 1), 'aftermath');
  inEvent('cw', series('road', 'Road to Civil War', 2006, 1), 'recommended', 'Prelude');
  inEvent('cw', series('elseworld', 'Civil War: What If', 2007, 1, { desc: 'An Elseworlds tale' }));
  inEvent('cw', series('ongoing', 'Civil War: Battle Damage', 2006, 1, { status: 'Continuing' }));
  inEvent('cw', series('nojson', 'Folder Name', null, 1, { json: false }));
  inEvent('cw', series('long', 'Amazing Spider-Man', 1999, 60).slice(0, 3));   // only 3 of 60 in the event
  // No Man's Land: no series of that name, so the series with the most essential issues is home.
  inEvent('nml', series('sotb', 'Batman: Shadow of the Bat', 1992, 12).slice(0, 8), 'essential');
  inEvent('nml', series('blackgate', 'Batman: Blackgate, Isle of Men', 1998, 1));
  const g = createSeriesGrouping({ db });
  g.run();
  const m = g.groupMap();
  assert.deepEqual([m.get('front').homes[0].id, m.get('front').hidden, m.get('front').homes[0].role], ['core', true, 'tie-in']);
  assert.deepEqual([m.get('conf').homes[0].role, m.get('conf').hidden], ['epilogue', false]);
  assert.deepEqual([m.get('road').homes[0].role, m.get('road').hidden], ['prelude', false]);
  assert.equal(m.get('elseworld').hidden, false);
  assert.equal(m.get('ongoing').hidden, false);
  assert.equal(m.has('nojson'), false);
  assert.equal(m.has('long'), false);
  assert.equal(m.has('core'), false);
  assert.deepEqual([m.get('blackgate').homes[0].id, m.get('blackgate').hidden], ['sotb', true]);
  assert.deepEqual(g.members('core').map(x => x.id).sort(), ['conf', 'elseworld', 'front', 'ongoing', 'road']);
});

test('an initiative keeps no home unless chosen; the admin can choose another home', () => {
  const { db, series, inEvent } = fixture();
  db.prepare("INSERT INTO events (id, name, year) VALUES ('reb', 'DC Rebirth', 2016)").run();
  const g0 = createSeriesGrouping({ db });   // adds the columns and marks DC Rebirth an initiative
  inEvent('reb', series('bat', 'Batman', 2016, 150).slice(0, 2), 'essential');
  inEvent('reb', series('titans', 'Titans Hunt', 2015, 8));
  g0.run();
  assert.equal(g0.groupMap().has('titans'), false);
  series('hub', 'DC Universe: Rebirth', 2016, 1);
  g0.setEvent('reb', { homeSeriesId: 'hub' });
  const t = g0.groupMap().get('titans');
  assert.deepEqual([t.homes[0].id, t.homes[0].role, t.hidden], ['hub', 'initiative', false]);
});

test('by-hand shelving, removal that sticks, and keep visible', () => {
  const { db, series, inEvent } = fixture();
  db.prepare("INSERT INTO events (id, name, year) VALUES ('fp', 'Flashpoint', 2011)").run();
  inEvent('fp', series('fp', 'Flashpoint', 2011, 5), 'essential');
  inEvent('fp', series('cold', 'Flashpoint: Citizen Cold', 2011, 3));
  series('lobo', 'Lobo the Duck', 1997, 1);
  series('amalgam', 'Amalgam Comics', 1996, 1);
  let changes = 0;
  const g = createSeriesGrouping({ db, onChange: () => changes++ });
  g.run();
  g.link('lobo', 'amalgam');
  assert.deepEqual([g.groupMap().get('lobo').homes[0].role, g.groupMap().get('lobo').hidden], ['special', true]);
  assert.throws(() => g.link('amalgam', 'lobo'), /already on this one's shelf/);
  // Removing a rule's link is remembered: the next run does not bring it back.
  assert.equal(g.unlink('cold', 'fp'), 'rule');
  g.run();
  assert.equal(g.groupMap().has('cold'), false);
  // Putting it back by hand clears that.
  g.link('cold', 'fp');
  g.run();
  assert.equal(g.groupMap().get('cold').homes[0].source, 'manual');
  g.keepVisible('cold', true);
  assert.equal(g.groupMap().get('cold').hidden, false);
  assert.ok(changes >= 4);
});

test('a home named like the event must start within 3 years of it; ties go to the series read first', () => {
  const { db, series, inEvent } = fixture();
  db.prepare("INSERT INTO events (id, name, year) VALUES ('aoa', 'Age of Apocalypse', 1995)").run();
  series('aoa2015', 'Age of Apocalypse', 2015, 5);                   // Secret Wars, 20 years later
  inEvent('aoa', series('gen', 'Generation Next', 1995, 4), 'essential');
  inEvent('aoa', series('ast', 'Astonishing X-Men', 1995, 4), 'essential');
  inEvent('aoa', series('omega', 'X-Men: Omega', 1995, 1));
  const g = createSeriesGrouping({ db });
  g.run();
  const e = g.summary().events[0];
  assert.deepEqual([e.home, e.how], ['gen', 'essential']);
  assert.match(e.why, /Most main-story issues \(4, tied with 1 more; read first\)/);
  assert.equal(g.groupMap().get('omega').homes[0].id, 'gen');
  assert.equal(g.groupMap().has('aoa2015'), false);
});

test('a series whose title has the event name and starts the main story comes before the most-issues series', () => {
  const { db, series, inEvent } = fixture();
  db.prepare("INSERT INTO events (id, name, year) VALUES ('aor', 'Age of Revelation', 2025), ('nml', 'No Man''s Land', 1999)").run();
  inEvent('aor', series('road', 'Road to Age of Revelation', 2025, 1), 'essential', 'Prelude');   // a lead-in: never the home
  inEvent('aor', series('ovt', 'X-Men: Age of Revelation Overture', 2025, 1), 'essential');
  inEvent('aor', series('amz', 'Amazing X-Men', 2025, 3), 'essential');
  inEvent('aor', series('book', 'X-Men: Book of Revelation', 2025, 3), 'essential');
  inEvent('nml', series('sotb', 'Batman: Shadow of the Bat', 1992, 30).slice(0, 22), 'essential');
  inEvent('nml', series('bnml', "Batman: No Man's Land", 1999, 2), 'essential');
  const g = createSeriesGrouping({ db });
  g.run();
  const ev = Object.fromEntries(g.summary().events.map(e => [e.id, e]));
  assert.deepEqual([ev.aor.home, ev.aor.how], ['ovt', 'title']);
  assert.deepEqual([ev.nml.home, ev.nml.how], ['bnml', 'title']);
  assert.equal(g.groupMap().get('amz').homes[0].id, 'ovt');
});

test('Looks right locks the home; Not right, Change home and Undo', () => {
  const { db, series, inEvent } = fixture();
  db.prepare("INSERT INTO events (id, name, year) VALUES ('si', 'Siege', 2010)").run();
  inEvent('si', series('a', 'Siege: Embedded', 2010, 4), 'essential');
  inEvent('si', series('t', 'Siege: Loki', 2010, 1));
  const g = createSeriesGrouping({ db });
  g.run();
  const r = g.setEvent('si', { confirm: true });
  assert.deepEqual(r.previous, { id: 'si', chosen: null, confirmed: false, source: null, initiative: false });
  // A series named like the event arrives later: the approved home stays, with a hint.
  inEvent('si', series('core', 'Siege', 2010, 4), 'essential');
  g.run();
  let e = g.summary().events[0];
  assert.deepEqual([e.home, e.source, e.suggest && e.suggest.id], ['a', 'approved', 'core']);
  assert.equal(g.groupMap().get('t').homes[0].id, 'a');
  // Not right: back to the rule's guess, waiting to be checked.
  const back = g.setEvent('si', { reset: true }).previous;
  e = g.summary().events[0];
  assert.deepEqual([e.home, e.confirmed, e.suggest], ['core', false, null]);
  // Undo puts the approved state back exactly.
  g.setEvent('si', { restore: back });
  e = g.summary().events[0];
  assert.deepEqual([e.home, e.confirmed, e.source], ['a', true, 'approved']);
  // Change home, then back to the rule's guess.
  g.setEvent('si', { homeSeriesId: 't' });
  assert.deepEqual([g.summary().events[0].home, g.summary().events[0].why], ['t', 'Chosen by you']);
  g.setEvent('si', { homeSeriesId: null });
  assert.deepEqual([g.summary().events[0].home, g.summary().events[0].confirmed], ['core', false]);
});

test('All look right locks every waiting event, and Undo restores them', () => {
  const { db, series, inEvent } = fixture();
  db.prepare("INSERT INTO events (id, name, year) VALUES ('x', 'Fear Itself', 2011), ('y', 'Shadowland', 2010)").run();
  inEvent('x', series('fi', 'Fear Itself', 2011, 7), 'essential');
  inEvent('y', series('sl', 'Shadowland', 2010, 5), 'essential');
  inEvent('x', series('fit', 'Fear Itself: The Fearless', 2011, 3));
  inEvent('y', series('slt', 'Shadowland: Blood on the Streets', 2010, 4));
  db.prepare("INSERT INTO events (id, name, year) VALUES ('z', 'Empty Crossover', 1990)").run();
  inEvent('z', series('ong', 'Some Ongoing', 1980, 100).slice(0, 2), 'essential');   // nothing on its shelf: not approved
  const g = createSeriesGrouping({ db });
  g.run();
  const r = g.confirmAll();
  assert.equal(r.confirmed, 2);
  assert.deepEqual(db.prepare("SELECT id, home_series_id, home_source FROM events ORDER BY id").all().map(x => ({ ...x })),
    [{ id: 'x', home_series_id: 'fi', home_source: 'approved' }, { id: 'y', home_series_id: 'sl', home_source: 'approved' }, { id: 'z', home_series_id: null, home_source: null }]);
  g.restoreEvents(r.previous);
  assert.deepEqual({ ...db.prepare('SELECT SUM(home_confirmed) AS c, COUNT(home_series_id) AS h FROM events').get() }, { c: 0, h: 0 });
});

test('Removed list, Restore, and Empty this shelf', () => {
  const { db, series, inEvent } = fixture();
  db.prepare("INSERT INTO events (id, name, year) VALUES ('fp', 'Flashpoint', 2011)").run();
  inEvent('fp', series('fp', 'Flashpoint', 2011, 5), 'essential');
  inEvent('fp', series('cold', 'Flashpoint: Citizen Cold', 2011, 3));
  inEvent('fp', series('abin', 'Flashpoint: Abin Sur', 2011, 3));
  const g = createSeriesGrouping({ db });
  g.run();
  g.unlink('cold', 'fp');
  assert.deepEqual(g.removed().map(r => [r.seriesId, r.homeName]), [['cold', 'Flashpoint (2011)']]);
  g.restore([{ seriesId: 'cold', homeId: 'fp' }]);
  assert.equal(g.groupMap().get('cold').homes[0].id, 'fp');
  assert.equal(g.removed().length, 0);
  const out = g.emptyEvent('fp');
  assert.equal(out.removed.length, 2);
  g.run();
  assert.equal(g.groupMap().size, 0);
  g.restore(out.removed);
  assert.equal(g.groupMap().size, 2);
});

test('homes approved before locking existed are locked to the home their shelf has now', () => {
  const { db, series, inEvent } = fixture();
  db.exec(`ALTER TABLE events ADD COLUMN initiative INTEGER NOT NULL DEFAULT 0; ALTER TABLE events ADD COLUMN home_series_id TEXT;
    ALTER TABLE events ADD COLUMN home_confirmed INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE series_links (series_id TEXT NOT NULL, home_id TEXT NOT NULL, source TEXT NOT NULL, role TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0,
      reason TEXT, created_at INTEGER NOT NULL, event_id TEXT, PRIMARY KEY (series_id, home_id));`);
  db.prepare("INSERT INTO events (id, name, year, home_confirmed) VALUES ('aoa', 'Age of Apocalypse', 1995, 1), ('w', 'Waiting', 2000, 0)").run();
  series('aoa2015', 'Age of Apocalypse', 2015, 5);
  inEvent('aoa', series('gen', 'Generation Next', 1995, 4), 'essential');
  db.prepare("INSERT INTO series_links VALUES ('gen', 'aoa2015', 'rule', 'core', 0, 'x', 1, 'aoa')").run();
  createSeriesGrouping({ db });
  assert.deepEqual({ ...db.prepare("SELECT home_series_id, home_source FROM events WHERE id = 'aoa'").get() }, { home_series_id: 'aoa2015', home_source: 'approved' });
  assert.deepEqual({ ...db.prepare("SELECT home_series_id, home_source FROM events WHERE id = 'w'").get() }, { home_series_id: null, home_source: null });
});
