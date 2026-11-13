'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const createLibraryHealth = require('./libraryHealth');

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scanned_series(id TEXT PRIMARY KEY, name TEXT, metadata_status TEXT, series_json TEXT);
    CREATE TABLE scanned_books(id TEXT PRIMARY KEY, series_id TEXT, path TEXT, filename TEXT, cv_issue_id TEXT, comicinfo TEXT, file_size INTEGER, file_mtime INTEGER);
    CREATE TABLE read_progress(book_id TEXT, page INTEGER);
    CREATE TABLE metadata_jobs(book_id TEXT PRIMARY KEY, state TEXT, checked_at INTEGER, last_error TEXT);
    CREATE TABLE metadata_worker_state(id INTEGER PRIMARY KEY, provider_retry_at INTEGER);
    CREATE TABLE monitored_series(id TEXT); INSERT INTO monitored_series VALUES ('ms1');
    CREATE TABLE monitored_issues(id TEXT, series_id TEXT, status TEXT, last_fail_reason TEXT); CREATE TABLE series_packs(id TEXT, series_id TEXT, status TEXT, file_path TEXT);
    CREATE TABLE download_requests(id INTEGER, status TEXT);
    INSERT INTO scanned_series VALUES ('s1','Spectacular','none',NULL), ('s2','Peter Parker','ok',NULL);
    INSERT INTO scanned_books VALUES
      ('a','s1','/c/s1/v1 056.cbz','v1 056.cbz','21389','',5,1), ('b','s2','/c/s2/PP 056.cbz','PP 056.cbz','21389','<x/>',6,2),
      ('c','s2','/c/s2/PP 057.cbz','PP 057.cbz','21390','<x/>',6,2), ('d','s1','/c/s1/x.cbz','x.cbz',NULL,NULL,1,1),
      ('e','s1','/c/s1/dmg.cbz','dmg.cbz',NULL,NULL,1,1), ('f','s1','/c/s1/uns.cbz','uns.cbz',NULL,NULL,1,1);
    INSERT INTO read_progress VALUES ('a', 3);
    INSERT INTO metadata_jobs VALUES ('d','review',1,'No corroborated publication match'),
      ('e','review',1,'Damaged archive: 1 of 24 files cannot be read'), ('f','waiting',1,'Unsafe archive member path'),
      ('c','review',NULL,'never checked');
    INSERT INTO metadata_worker_state VALUES (1, 5000);
    INSERT INTO monitored_issues VALUES ('m1','ms1','failed',NULL),('m0','gone','failed',NULL),('m2','ms1','wanted',NULL),('m3','ms1','downloaded','ARCHIVE_DAMAGED: Damaged archive'),('m4','ms1','downloaded','Comic Vine hourly limit');
    INSERT INTO series_packs VALUES ('p1','ms1','failed','/dl/pack.zip'),('p2','ms1','failed','/dl/missing.zip'),('p3','ms1','failed',NULL);
    INSERT INTO download_requests VALUES (1,'open'),(2,'added');`);
  const routes = {};
  const app = { get: (p, ...h) => { routes['GET ' + p] = h.at(-1); }, post: (p, ...h) => { routes['POST ' + p] = h.at(-1); } };
  const health = createLibraryHealth({ app, db, requireAdmin: (q, r, n) => n(), now: () => 1000, fileExists: p => p === '/dl/pack.zip' });
  return { db, health, routes };
}

// Failed downloads count only what Downloads › Queue shows: issues of monitored
// series (not orphans) and failed packs whose file is still on disk.
test('needs-you counts feed the badge; information rows do not', () => {
  const { health } = setup();
  const s = health.summary();
  assert.deepEqual(s.needsYou, { stuck: 1, damaged: 1, unsafe: 1, duplicates: 1, failedDownloads: 2, heldDownloads: 1, requests: 1, seriesLinks: 0 });
  assert.equal(s.badge, 8);
  assert.deepEqual(s.info, { noCvId: 3, seriesWithoutDetails: 1, comicVinePausedUntil: 5000 });
});

test('duplicate groups list every copy; keep-all hides the group', () => {
  const { health, routes } = setup();
  const [g] = health.duplicates();
  assert.equal(g.cvIssueId, '21389');
  assert.deepEqual(g.books.map(b => [b.id, b.tagged, b.has_progress]), [['a', false, true], ['b', true, false]]);
  let sent; routes['POST /api/admin/library-health/duplicates/:cv/keep-all']({ params: { cv: '21389' } }, { json: x => { sent = x; } });
  assert.deepEqual(sent, { ok: true });
  assert.equal(health.duplicates().length, 0);
  assert.equal(health.summary().needsYou.duplicates, 0);
});

// ── Mistag vs duplicate sorting and the bulk jobs (2026-10-16) ──
const ci = (series, number) => `<ComicInfo><Series>${series}</Series><Number>${number}</Number></ComicInfo>`;
test('a file whose name disagrees with its tag is a mistag; agreeing names are duplicates', () => {
  const { health } = setup();
  const j = (filename, xml) => health.judge({ filename, comicinfo: xml });
  assert.equal(j('Green Lantern 010.cbz', ci('Green Lantern', 10)).status, 'ok');
  assert.equal(j('Tales Of The Sinestro Corps - Superman Prime.cbz', ci('Green Lantern', 10)).status, 'mismatch');
  assert.equal(j('Legends Of The Dark Knight Annual 001 (1991).cbz', ci('Legends of the Dark Knight', 1)).status, 'mismatch');
  assert.equal(j('Earth 2 - Society 003.cbz', ci('Earth 2: Society', 2)).status, 'mismatch');
  assert.equal(j('Captain America 001 (2005) (Digital) (Zone-Empire).cbz', ci('Captain America', 1)).status, 'ok');
  assert.equal(j('Superman 2023 Annual 001.cbz', ci('Superman 2023 Annual', 1)).status, 'ok');
  assert.equal(j('The Ray, 1994-03-00 (_01) (digital).cbz', ci('The Ray', 1)).status, 'unknown');
});

test('keep rule: reading progress, then the larger file', () => {
  const { health } = setup();
  const b = (id, size, progress) => ({ id, file_size: size, has_progress: progress, path: '/c/x/' + id + '.cbz', comicinfo: '' });
  assert.equal(health.chooseKeep([b('small', 10, true), b('big', 99, false)]).id, 'small');
  assert.equal(health.chooseKeep([b('small', 10, false), b('big', 99, false)]).id, 'big');
});

test('retag job: fixed, confirmed, needs help; rate limits wait and retry', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scanned_series(id TEXT PRIMARY KEY, name TEXT, metadata_status TEXT, series_json TEXT);
    CREATE TABLE scanned_books(id TEXT PRIMARY KEY, series_id TEXT, path TEXT, filename TEXT, cv_issue_id TEXT, comicinfo TEXT, file_size INTEGER, file_mtime INTEGER);
    CREATE TABLE read_progress(book_id TEXT, page INTEGER);
    CREATE TABLE metadata_jobs(book_id TEXT PRIMARY KEY, arrival TEXT NOT NULL, state TEXT, due_at INTEGER, checked_at INTEGER, last_error TEXT);`);
  const add = db.prepare('INSERT INTO scanned_books VALUES (?,?,?,?,?,?,?,?)');
  add.run('gl', 's', '/c/GL/Green Lantern 010.cbz', 'Green Lantern 010.cbz', '113161', ci('Green Lantern', 10), 1, 1);
  add.run('sp', 's', '/c/GL/Tales Of The Sinestro Corps - Superman Prime.cbz', 'Tales Of The Sinestro Corps - Superman Prime.cbz', '113161', ci('Green Lantern', 10), 1, 1);
  add.run('a1', 's', '/c/L/LOTDK Annual 001 (1991).cbz', 'Legends Of The Dark Knight Annual 001 (1991).cbz', '31892', ci('Legends of the Dark Knight', 1), 1, 1);
  add.run('r1', 's', '/c/L/LOTDK 001 (1989).cbz', 'Legends of the Dark Knight 001 (1989).cbz', '31892', ci('Legends of the Dark Knight', 1), 1, 1);
  const calls = [];
  let limited = false;
  const retag = async ({ bookId, rediscover }) => {
    calls.push([bookId, rediscover]);
    if (bookId === 'sp') { const e = new Error('No corroborated publication match'); e.code = 'IDENTITY_REVIEW_REQUIRED'; throw e; }
    if (bookId === 'a1' && !limited) { limited = true; const e = new Error('limit'); e.code = 'CV_RATE_LIMIT'; e.retryAt = 2000; throw e; }
    return { cvIssueId: '31900' };
  };
  const app = { get() {}, post() {} };
  const health = createLibraryHealth({ app, db, requireAdmin: () => {}, now: () => 1000, retag, sleep: async () => {} });
  await health.retagMismatched();
  const job = health.job();
  assert.deepEqual(calls, [['sp', true], ['a1', true], ['a1', true]]);   // only mismatched files; the rate-limited one retried
  assert.equal(job.needHelp, 1); assert.equal(job.fixed, 1); assert.equal(job.running, false);
  assert.match(db.prepare("SELECT last_error FROM metadata_jobs WHERE book_id='sp'").get().last_error, /Possible mistag/);
});

// Year-named annual volumes (2026-10-16): "batman-2021-annual-1" is Batman 2021 Annual #1, not Batman #2021.
test('annual volumes with a year in the name; extra-title files', () => {
  const { health } = setup();
  const web = (slug, id) => `<ComicInfo><Series>X</Series><Number>1</Number><Web>https://comicvine.gamespot.com/${slug}/4000-${id}/</Web></ComicInfo>`;
  const j = (filename, slug) => health.judge({ filename, cv_issue_id: '9', comicinfo: web(slug, 9).replace('<Series>X</Series>', '') });
  assert.equal(j('Batman 2021 Annual 001.cbz', 'batman-2021-annual-1-the-dark').status, 'ok');
  assert.equal(j('Batman 2021 Annual Annual 001 (2022).cbz', 'batman-2021-annual-1-the-dark').status, 'ok');
  assert.match(j('Batman 2022 Annual Annual 001 (2022).cbz', 'batman-2021-annual-1-the-dark').reason, /2022 Annual; its Comic Vine ID is Batman 2021 Annual #1/);
  assert.match(j('Catwoman 2021 Annual 001 (2021) (digital).cbz', 'catwoman-1-copycats').reason, /an annual/);
  assert.equal(j('Catwoman 80th Anniversary 100-Page Super Spectacular 001 (2020).cbz', 'catwoman-1-copycats').status, 'mismatch');
  assert.equal(j('Catwoman 001.cbz', 'catwoman-1-copycats').status, 'ok');
  assert.equal(j('Star Wars Poe Dameron 016 (2017).cbz', 'poe-dameron-16-x').status, 'ok');
});

// Release-site tags and run-together Comic Vine link names (2026-10-16).
test('GetComics tags and merged link words are not a different title', () => {
  const { health } = setup();
  const web = slug => `<ComicInfo><Web>https://comicvine.gamespot.com/${slug}/4000-9/</Web></ComicInfo>`;
  const j = filename => health.judge({ filename, cv_issue_id: '9', comicinfo: web('legion-of-super-heroesbugs-bunny-special-1-legion-of-super') });
  assert.equal(j('Legion of Super Heroes - Bugs Bunny Special 001 (2017) GetComics.NFO.cbz').status, 'ok');
  assert.equal(j('Legion of Super-Heroes-Bugs Bunny Special 001 (2017).cbz').status, 'ok');
});

// Keep-one job safety (sample review, 2026-10-16): never keep a missing or
// empty copy; rows whose file is gone are only forgotten.
test('keep-one job keeps a readable copy, forgets missing rows, moves the rest', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE libraries(path TEXT); INSERT INTO libraries VALUES ('/c');
    CREATE TABLE scanned_series(id TEXT PRIMARY KEY, name TEXT, metadata_status TEXT, series_json TEXT);
    CREATE TABLE scanned_books(id TEXT PRIMARY KEY, series_id TEXT, path TEXT, filename TEXT, cv_issue_id TEXT, comicinfo TEXT, file_size INTEGER, file_mtime INTEGER);
    CREATE TABLE read_progress(book_id TEXT, page INTEGER);`);
  const ci1 = '<ComicInfo><Series>Justice League Annual</Series><Number>1</Number></ComicInfo>';
  const add = db.prepare('INSERT INTO scanned_books VALUES (?,?,?,?,?,?,?,?)');
  add.run('big-empty', 's', '/c/JL/Justice League Annual Annual 001 (2019).cbz', 'Justice League Annual Annual 001 (2019).cbz', '1', ci1, 900, 1);
  add.run('good', 's', '/c/JL/Justice League Annual 001.cbz', 'Justice League Annual 001.cbz', '1', ci1, 500, 1);
  add.run('gone', 's', '/c/JL/Justice League Annual 001 (digital).cbz', 'Justice League Annual 001 (digital).cbz', '1', ci1, 800, 1);
  const moved = [], forgot = [];
  const fs = require('node:fs');
  const health = createLibraryHealth({ app: { get() {}, post() {} }, db, requireAdmin: () => {}, holdingRoot: '/hold',
    fileExists: p => p !== '/c/JL/Justice League Annual 001 (digital).cbz' && !p.replaceAll('\\', '/').startsWith('/hold'),
    countPages: async p => (p.includes('Annual Annual') ? 0 : 30), measure: async () => null,
    forgetBook: id => { forgot.push(id); db.prepare('DELETE FROM scanned_books WHERE id = ?').run(id); }, sleep: async () => {} });
  const realRename = fs.renameSync, realMkdir = fs.mkdirSync;
  fs.renameSync = (a, b) => moved.push([a, b.replaceAll('\\', '/')]); fs.mkdirSync = () => {};
  try { await health.keepBest(); } finally { fs.renameSync = realRename; fs.mkdirSync = realMkdir; }
  assert.deepEqual(moved, [['/c/JL/Justice League Annual Annual 001 (2019).cbz', '/hold/JL/Justice League Annual Annual 001 (2019).cbz']]);
  assert.deepEqual(forgot.sort(), ['big-empty', 'gone']);
  assert.equal(health.job().forgotten, 1); assert.equal(health.job().moved, 1);
});

test('keep rule: sharper pages beat a bigger file; progress still comes first', () => {
  const { health } = setup();
  const b = (id, size, resolution, progress = false) => ({ id, file_size: size, resolution, has_progress: progress, path: '/c/x/' + id + '.cbz', comicinfo: '' });
  assert.equal(health.chooseKeep([b('scan', 45e6, 4.0e6), b('digital', 25e6, 6.1e6)]).id, 'digital');
  assert.equal(health.chooseKeep([b('a', 45e6, 6.0e6), b('b', 25e6, 6.1e6)]).id, 'a');        // within 5%: larger file
  assert.equal(health.chooseKeep([b('read', 10e6, 2e6, true), b('sharp', 50e6, 6e6)]).id, 'read');
});

// Year evidence and editions (sample of 80, 2026-10-16).
test('different years with the same number are mistags; editions need a person', () => {
  const { health } = setup();
  // judge() is per file; the year rule needs the group (see duplicates()), so
  // these call it the way a conflicting group does.
  health.judge = b => { const y = health.yearProblem(b); return y ? { status: 'mismatch', reason: y } : health.judgeFile(b); };
  const x = (y, v) => `<ComicInfo><Series>Avengers</Series><Number>12</Number>${v ? `<Volume>${v}</Volume>` : ''}<Year>${y}</Year></ComicInfo>`;
  const j = (p, xml) => health.judge({ path: p, filename: p.split('/').pop(), comicinfo: xml });
  assert.match(j('/c/Avengers (2012)/Avengers 012 (2011) (digital).cbz', x(2013, 2012)).reason, /from 2011/);
  assert.equal(j('/c/Avengers (2012)/Avengers 012 (2013).cbz', x(2013)).status, 'ok');
  assert.equal(j('/c/Doctor Strange (1974)/Doctor Strange 051 (1974) (digital).cbz', x(1982, 1974).replace(/Avengers/, 'Doctor Strange').replace('>12<', '>51<')).status, 'ok');
  assert.match(j('/c/The Shadow 2012-2014/The Shadow 002.cbz', x(2015).replace(/Avengers/, 'The Shadow').replace('>12<', '>2<')).reason, /2012–2014/);
  assert.notEqual(j('/c/Iron Man (1968)/Iron Man 249.cbz', x(1989).replace(/Avengers/, 'Iron Man').replace('>12<', '>249<')).status, 'mismatch');   // a series start year is only a lower bound
});

test('the year rule applies only when the copies themselves disagree', () => {
  const { health } = setup();
  const y = p => ({ path: p, filename: p.split('/').pop() });
  assert.equal(health.yearsConflict([y('/c/A (2012)/Avengers 012 (2011) (digital).cbz'), y('/c/A (2012)/Avengers 012 (2013).cbz')]), true);
  assert.equal(health.yearsConflict([y('/c/DS (1974)/Doctor Strange 065 (1984) (Digital).cbz'), y('/c/DS (1974)/Doctor Strange 065 (1984).cbz')]), false);
  assert.equal(health.yearsConflict([y('/c/The Shadow 2012-2014/The Shadow 002.cbz'), y('/c/The Shadow 2015/The Shadow 002.cbz')]), true);
  assert.equal(health.yearsConflict([y('/c/Captain America (2004)/Captain America 008 (2005).cbz'), y('/c/Captain America (2004)/Captain America 008 (2005) (Digital).cbz')]), false);
});

// Approve button (2026-10-16): "Keep current match" ends the review and stops flagging.
test('keep-match records the tag as right and clears the review', () => {
  const { db, routes } = setup();
  db.exec("CREATE TABLE IF NOT EXISTS library_health_dismissed(kind TEXT, key TEXT, PRIMARY KEY(kind, key)); ALTER TABLE metadata_jobs ADD COLUMN due_at INTEGER; INSERT INTO metadata_jobs (book_id, state, checked_at, last_error) VALUES ('b','review',1,'Possible mistag: x')");
  const out = {}; const res = { status(c) { out.code = c; return res; }, json(v) { out.body = v; } };
  routes['POST /api/admin/library-health/books/:id/keep-match']({ params: { id: 'b' } }, res);
  assert.deepEqual(out.body, { ok: true });
  assert.ok(db.prepare("SELECT 1 FROM library_health_dismissed WHERE kind='mistag-confirmed' AND key='b'").get());
  assert.equal(db.prepare("SELECT last_error FROM metadata_jobs WHERE book_id='b'").get().last_error, null);
  routes['POST /api/admin/library-health/books/:id/keep-match']({ params: { id: 'd' } }, res);   // no Comic Vine ID
  assert.equal(out.code, 409);
});

// Earth 2 - Society (2026-10-16): every file in the folder identified again.
test('series re-identify retags every book in the folder, ignoring stored tags', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scanned_series(id TEXT PRIMARY KEY, name TEXT, metadata_status TEXT, series_json TEXT);
    CREATE TABLE scanned_books(id TEXT PRIMARY KEY, series_id TEXT, path TEXT, filename TEXT, cv_issue_id TEXT, comicinfo TEXT, file_size INTEGER, file_mtime INTEGER, sort_order INTEGER);
    CREATE TABLE read_progress(book_id TEXT, page INTEGER);
    CREATE TABLE metadata_jobs(book_id TEXT PRIMARY KEY, arrival TEXT NOT NULL, state TEXT, due_at INTEGER, checked_at INTEGER, last_error TEXT);
    CREATE TABLE library_health_dismissed(kind TEXT, key TEXT, PRIMARY KEY(kind, key));
    INSERT INTO scanned_series VALUES ('e2s','Earth 2: Society','ok',NULL), ('other','Other','ok',NULL);
    INSERT INTO scanned_books VALUES ('b0','e2s','/c/E/Earth 2 - Society 000.cbz','Earth 2 - Society 000.cbz','489856','',1,1,0),
      ('b2','e2s','/c/E/Earth 2 - Society 002.cbz','Earth 2 - Society 002.cbz','494266','',1,1,2),
      ('b3','e2s','/c/E/Earth 2 - Society 003.cbz','Earth 2 - Society 003.cbz','494266','',1,1,3),
      ('x','other','/c/O/Other 001.cbz','Other 001.cbz','1','',1,1,1);
    INSERT INTO library_health_dismissed VALUES ('mistag-confirmed','b3');`);
  const calls = [];
  const retag = async ({ bookId, rediscover }) => {
    calls.push([bookId, rediscover]);
    if (bookId === 'b3') { const e = new Error('No corroborated publication match'); e.code = 'IDENTITY_REVIEW_REQUIRED'; throw e; }
    return { cvIssueId: bookId === 'b0' ? '489856' : '500002' };
  };
  const routes = {};
  const app = { get: (p, ...h) => { routes['GET ' + p] = h.at(-1); }, post: (p, ...h) => { routes['POST ' + p] = h.at(-1); } };
  const health = createLibraryHealth({ app, db, requireAdmin: () => {}, now: () => 1000, retag, sleep: async () => {} });
  const out = {}; const res = { status(c) { out.code = c; return res; }, json(v) { out.body = v; } };
  routes['POST /api/admin/library-health/series/:id/reidentify']({ params: { id: 'missing' } }, res);
  assert.equal(out.code, 404);
  await health.reidentifySeries('e2s', 'Earth 2: Society');
  const job = health.job();
  assert.deepEqual(calls, [['b0', true], ['b2', true], ['b3', true]]);   // only this folder, every file, stored tags ignored
  assert.equal(job.fixed, 1); assert.equal(job.confirmed, 1); assert.equal(job.needHelp, 1); assert.equal(job.series, 'Earth 2: Society');
  assert.ok(!db.prepare("SELECT 1 FROM library_health_dismissed WHERE key='b3'").get());   // an old verdict is cleared
  assert.match(db.prepare("SELECT last_error FROM metadata_jobs WHERE book_id='b3'").get().last_error, /Possible mistag/);
});

// Manual duplicate pass (2026-10-16): books queued offline are re-identified after startup.
test('queued books are re-identified and leave the queue; vanished rows are dropped', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scanned_series(id TEXT PRIMARY KEY, name TEXT, metadata_status TEXT, series_json TEXT);
    CREATE TABLE scanned_books(id TEXT PRIMARY KEY, series_id TEXT, path TEXT, filename TEXT, cv_issue_id TEXT, comicinfo TEXT, file_size INTEGER, file_mtime INTEGER);
    CREATE TABLE metadata_jobs(book_id TEXT PRIMARY KEY, arrival TEXT NOT NULL, state TEXT, due_at INTEGER, checked_at INTEGER, last_error TEXT);
    INSERT INTO scanned_books VALUES ('a','s','/c/A 001.cbz','A 001.cbz','1','',1,1), ('b','s','/c/B 001.cbz','B 001.cbz','1','',1,1);`);
  const calls = [];
  const retag = async ({ bookId, rediscover }) => { calls.push([bookId, rediscover]); if (bookId === 'b') { const e = new Error('no match'); e.code = 'IDENTITY_REVIEW_REQUIRED'; throw e; } return { cvIssueId: '9' }; };
  const health = createLibraryHealth({ app: { get() {}, post() {} }, db, requireAdmin: () => {}, now: () => 1000, retag, sleep: async () => {}, queueDelayMs: null });
  db.exec("INSERT INTO library_health_reidentify (book_id, note) VALUES ('a','x'), ('b','y'), ('gone','z')");
  await health.runQueued();
  assert.deepEqual(calls, [['a', true], ['b', true]]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM library_health_reidentify').get().n, 0);
  assert.equal(health.job().fixed, 1); assert.equal(health.job().needHelp, 1);
  assert.match(db.prepare("SELECT last_error FROM metadata_jobs WHERE book_id='b'").get().last_error, /Possible mistag: y/);
});

// Duplicate checker v2 (2026-10-16): mistagged copies are queued, not listed;
// keeping one copy moves the other to the holding folder and carries progress.
test('v2: mistags are swept to the re-identify queue once; keep moves the rest and carries progress', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE libraries(path TEXT); INSERT INTO libraries VALUES ('/c');
    CREATE TABLE scanned_series(id TEXT PRIMARY KEY, name TEXT, metadata_status TEXT, series_json TEXT);
    CREATE TABLE scanned_books(id TEXT PRIMARY KEY, series_id TEXT, path TEXT, filename TEXT, cv_issue_id TEXT, comicinfo TEXT, file_size INTEGER, file_mtime INTEGER);
    CREATE TABLE read_progress(id INTEGER PRIMARY KEY, book_id TEXT, user_id INTEGER, page INTEGER, completed INTEGER, updated_at TEXT, marked INTEGER);
    CREATE TABLE list_issues(id INTEGER PRIMARY KEY, scanned_book_id TEXT);`);
  const w = s => `<ComicInfo><Series>Old Lady Harley</Series><Number>1</Number><Year>2018</Year><Web>https://comicvine.gamespot.com/${s}/4000-689848/</Web></ComicInfo>`;
  const add = db.prepare('INSERT INTO scanned_books VALUES (?,?,?,?,?,?,?,?)');
  add.run('hq', 'a', '/c/Harley Quinn (2016)/Old Lady Harley 001.cbz', 'Old Lady Harley 001.cbz', '689848', w('old-lady-harley-1'), 34e6, 1);
  add.run('olh', 'b', '/c/Old Landy Harley (2018)/Old Lady Harley 001.cbz', 'Old Lady Harley 001.cbz', '689848', w('old-lady-harley-1'), 34e6, 1);
  add.run('wrong', 'b', '/c/Old Landy Harley (2018)/Harley Quinn Annual 001.cbz', 'Harley Quinn Annual 001.cbz', '689848', w('old-lady-harley-1'), 30e6, 1);
  db.exec("INSERT INTO read_progress (book_id, user_id, page, completed) VALUES ('hq', 1, 27, 1); INSERT INTO list_issues (scanned_book_id) VALUES ('hq');");
  const routes = {}, moved = [];
  const app = { get: (p, ...h) => { routes['GET ' + p] = h.at(-1); }, post: (p, ...h) => { routes['POST ' + p] = h.at(-1); } };
  const health = createLibraryHealth({ app, db, requireAdmin: () => {}, holdingRoot: '/hold', queueDelayMs: null,
    fileExists: p => !p.replaceAll('\\', '/').startsWith('/hold'), forgetBook: id => db.prepare('DELETE FROM scanned_books WHERE id = ?').run(id) });
  // The annual tagged as Old Lady Harley #1 is queued once, and is not listed.
  assert.equal(health.sweepMistags(), 1); assert.equal(health.sweepMistags(), 0);
  const out = {}; const res = { status(c) { out.code = c; return res; }, json(v) { out.body = v; } };
  routes['GET /api/admin/library-health/duplicates']({}, res);
  const [g] = out.body.groups;
  assert.deepEqual(g.books.map(b => b.id).sort(), ['hq', 'olh']);
  assert.equal(g.suggestId, 'olh'); assert.match(g.keepReason, /own series folder/);
  assert.equal(out.body.mistagged, 1); assert.equal(out.body.reidentifying, 1);
  const fs = require('node:fs'); const rn = fs.renameSync, mk = fs.mkdirSync;
  fs.renameSync = (a, b) => moved.push([a, b.replaceAll('\\', '/')]); fs.mkdirSync = () => {};
  try { await routes['POST /api/admin/library-health/duplicates/:cv/keep']({ params: { cv: '689848' }, body: {} }, res); }
  finally { fs.renameSync = rn; fs.mkdirSync = mk; }
  assert.equal(out.body.moved, 1);
  assert.deepEqual(moved, [['/c/Harley Quinn (2016)/Old Lady Harley 001.cbz', '/hold/Harley Quinn (2016)/Old Lady Harley 001.cbz']]);
  assert.equal(db.prepare("SELECT page FROM read_progress WHERE book_id = 'olh'").get().page, 27);
  assert.equal(db.prepare('SELECT scanned_book_id FROM list_issues').get().scanned_book_id, 'olh');
});

// "Not duplicates" with one copy tagged wrong (2026-10-26): that copy is identified
// again instead of the group being hidden with the wrong tag in place.
test('not duplicates, one copy wrong: it is identified again and the group leaves the list', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scanned_series(id TEXT PRIMARY KEY, name TEXT, metadata_status TEXT, series_json TEXT);
    CREATE TABLE scanned_books(id TEXT PRIMARY KEY, series_id TEXT, path TEXT, filename TEXT, cv_issue_id TEXT, comicinfo TEXT, file_size INTEGER, file_mtime INTEGER);
    CREATE TABLE metadata_jobs(book_id TEXT PRIMARY KEY, arrival TEXT NOT NULL, state TEXT, due_at INTEGER, checked_at INTEGER, last_error TEXT);
    CREATE TABLE read_progress(book_id TEXT, page INTEGER);
    INSERT INTO scanned_books VALUES ('r','s','/c/Batman (2016)/Batman 001 (2016).cbz','Batman 001 (2016).cbz','535328','',1,1),
      ('x','s','/c/Batman (2016)/Batman 001 (2016) (2).cbz','Batman 001 (2016) (2).cbz','535328','',1,1);`);
  const calls = []; let release;
  const gate = new Promise(r => { release = r; });
  const retag = async ({ bookId }) => { calls.push(bookId); await gate; db.prepare("UPDATE scanned_books SET cv_issue_id = '999' WHERE id = ?").run(bookId); return { cvIssueId: '999' }; };
  const routes = {};
  const app = { get: (p, ...h) => { routes['GET ' + p] = h.at(-1); }, post: (p, ...h) => { routes['POST ' + p] = h.at(-1); } };
  const health = createLibraryHealth({ app, db, requireAdmin: () => {}, now: () => 1000, retag, sleep: async () => {}, queueDelayMs: null });
  db.exec("INSERT INTO library_health_dismissed (kind, key) VALUES ('mistag-confirmed', 'x')");
  assert.equal(health.duplicates()[0].books.length, 2);
  const call = (cv, bookId) => { let out = {}; const res = { status(c) { out.code = c; return res; }, json(v) { out.body = v; } };
    routes['POST /api/admin/library-health/duplicates/:cv/wrong']({ params: { cv }, body: { bookId } }, res); return out; };
  assert.equal(call('535328', 'nope').code, 400);                     // only a listed copy
  const r = call('535328', 'x');
  assert.deepEqual(r.body, { ok: true, started: true });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM library_health_dismissed WHERE kind = 'mistag-confirmed' AND key = 'x'").get().n, 0);
  const g = health.duplicates()[0];                                   // while it is being identified: not listed
  assert.equal(g.kind, 'reidentifying'); assert.deepEqual(g.mistagged.map(b => b.id), ['x']);
  release(); await new Promise(r2 => setTimeout(r2, 10));
  assert.deepEqual(calls, ['x']);
  assert.equal(health.duplicates().length, 0);                        // new tag: the group is gone
  assert.equal(db.prepare('SELECT COUNT(*) n FROM library_health_reidentify').get().n, 0);
});
