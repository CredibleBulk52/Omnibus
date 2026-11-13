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
    CREATE TABLE event_issues (id INTEGER PRIMARY KEY, event_id TEXT, scanned_book_id TEXT, tier TEXT, phase TEXT);`);
  let n = 0;
  const series = (id, name, year, issues, { json = true, status = 'Ended', desc = '', books = issues } = {}) => {
    db.prepare('INSERT INTO scanned_series VALUES (?, ?, ?, ?, ?)').run(id, name, year,
      json ? JSON.stringify({ metadata: { name, year, total_issues: issues, status, description_text: desc } }) : null, books);
    const ids = [];
    for (let i = 0; i < books; i++) { const b = `${id}-${i}`; db.prepare('INSERT INTO scanned_books (id, series_id) VALUES (?, ?)').run(b, id); ids.push(b); }
    return ids;
  };
  const inEvent = (event, bookIds, tier = 'tie-in', phase = '') => bookIds.forEach(b =>
    db.prepare('INSERT INTO event_issues (id, event_id, scanned_book_id, tier, phase) VALUES (?, ?, ?, ?, ?)').run(++n, event, b, tier, phase));
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
  assert.equal(g.unlink('cold', 'fp'), true);
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
