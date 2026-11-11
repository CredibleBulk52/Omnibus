'use strict';
// Downloads stage 3 (2026-11-05): issueDownloads.js, getcomicsRoutes.js, wanted.js, packs.js.
// The code was moved unchanged; these tests cover the wiring (server.js passes everything
// each module needs), the GetComics queue and Queue tab routes, and the failed-issue retry.
// postProcessPack itself: metadata/packPause.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createIssueDownloads } = require('./issueDownloads');
const { createWanted } = require('./wanted');
const { createPacks } = require('./packs');
const { registerGetComicsRoutes } = require('./getcomicsRoutes');
const { createSourceSearch } = require('./sourceSearch');

const noop = () => {};
const logger = { info: noop, warn: noop, error: noop, debug: noop };
const needs = file => {
  const m = /const missing = \[([^\]]*)\]/.exec(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  return m[1].split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean);
};

// A stand-in Express app that keeps each route's last handler.
function fakeApp() {
  const routes = {};
  const add = method => (p, ...h) => { routes[`${method} ${p}`] = h[h.length - 1]; };
  return { routes, get: add('GET'), post: add('POST'), put: add('PUT') };
}
function call(handler, { params = {}, body = {}, user = { role: 'admin', username: 'a' } } = {}) {
  return new Promise(resolve => {
    const res = { code: 200, status(n) { this.code = n; return this; }, json(v) { resolve({ code: this.code, body: v }); } };
    handler({ params, body, user, query: {} }, res);
  });
}

test('server.js passes every name each downloads module needs', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8').replace(/\r\n/g, '\n');
  const calls = {
    'packs.js': 'createPacks', 'issueDownloads.js': 'createIssueDownloads',
    'getcomicsRoutes.js': 'registerGetComicsRoutes', 'wanted.js': 'createWanted',
    'sourceSearch.js': 'createSourceSearch',
  };
  for (const [file, fn] of Object.entries(calls)) {
    const a = src.indexOf(`.${fn}({`);
    assert.ok(a > 0, `${fn} is called in server.js`);
    const block = src.slice(a + fn.length + 3, src.indexOf('\n});', a));
    const given = new Set(block.split(/[,\n]/).map(s => s.trim().split(':')[0].trim()).filter(Boolean));
    const missing = needs(file).filter(n => !given.has(n));
    assert.deepEqual(missing, [], `${fn} is not given ${missing.join(', ')}`);
  }
});

test('each module refuses to start when something it needs is missing', () => {
  assert.throws(() => createIssueDownloads({ logger }), /createIssueDownloads: missing .*retryPolicy/);
  assert.throws(() => createWanted({ logger }), /createWanted: missing .*runDdlDownload/);
  assert.throws(() => createPacks({ logger }), /createPacks: missing .*metadataRuntime/);
  assert.throws(() => registerGetComicsRoutes({ logger }), /registerGetComicsRoutes: missing .*postProcessPack/);
  assert.throws(() => createSourceSearch({ logger }), /createSourceSearch: missing .*dropWrongYear/);
});

function queueDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE monitored_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER, series_type TEXT);
    CREATE TABLE monitored_issues (id TEXT PRIMARY KEY, series_id TEXT, issue_number TEXT, status TEXT, download_id TEXT, download_url TEXT, file_path TEXT,
      retry_after TEXT, last_fail_reason TEXT, fail_count INTEGER, weekly_retries INTEGER, failed_at TEXT, retry_epoch TEXT);
    CREATE TABLE series_packs (id INTEGER PRIMARY KEY, series_id TEXT, status TEXT, file_path TEXT, fail_reason TEXT, failed_at TEXT, grabbed_at TEXT, retry_after TEXT);
    CREATE TABLE download_blacklist (issue_id TEXT, url TEXT, failed_at TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  db.exec(`INSERT INTO monitored_series VALUES ('s1', 'Hulk', 2016, NULL);`);
  for (let n = 1; n <= 3; n++) db.prepare("INSERT INTO monitored_issues (id, series_id, issue_number, status) VALUES (?, 's1', ?, 'snatched')").run(`i${n}`, String(n));
  return db;
}
function issueDownloads(db, over = {}) {
  const deps = Object.fromEntries(needs('issueDownloads.js').map(n => [n, noop]));
  const app = fakeApp();
  const settings = {};
  Object.assign(deps, {
    db, logger, fs, path, activeDownloads: new Map(), ddlPostProcessing: new Set(),
    getSetting: k => (k in settings ? settings[k] : null),
    retryPolicy: { cooldownActive: () => false, cooldown: () => ({ until: null, strikes: 0 }) },
    metadataRuntime: { status: () => [] }, MANUAL_ONLY_HOSTS: /nope/, DDL_COOLDOWN_STEPS_MIN: [5, 15],
  }, over);
  const mod = createIssueDownloads(deps);
  mod.registerQueueRoutes(app, { wantedScanState: { running: false, done: 0, total: 0 }, FAILED_RETRY_MAX_WEEKS: 4 });
  return { mod, app, settings, deps };
}

test('queue: during a rate-limit cooldown, new downloads go back to wanted instead of starting', async () => {
  const db = queueDb();
  const handedBack = [];
  const { mod } = issueDownloads(db, {
    retryPolicy: { cooldownActive: () => true, cooldown: () => ({ until: null, strikes: 1 }) },
    deferForRateLimit: (issue, why) => handedBack.push([issue.id, why]),
  });
  await mod.runDdlDownload({ id: 'i1' }, { id: 's1' }, 'https://example.test/a.cbz', null);   // resolves without downloading
  assert.deepEqual(handedBack, [['i1', 'cooldown active']]);
});

test('Queue tab: limits from settings, waiting jobs, move to top and remove', async () => {
  const db = queueDb();
  // The first download never finishes (its host downloader never returns), so with one
  // download at a time the other two stay waiting.
  const { mod, app, settings } = issueDownloads(db, { getSetting: k => settings[k] ?? null, downloadThirdParty: () => new Promise(noop) });
  settings.ddl_concurrency = '1'; settings.ddl_start_gap_sec = '0'; settings.ddl_download_path = require('os').tmpdir();
  mod.runDdlDownload({ id: 'i1', issue_number: '1' }, { id: 's1', name: 'Hulk' }, 'https://pixeldrain.com/u/abc');
  mod.runDdlDownload({ id: 'i2', issue_number: '2' }, { id: 's1', name: 'Hulk' }, 'https://h.test/2.cbz');
  mod.runDdlDownload({ id: 'i3', issue_number: '3' }, { id: 's1', name: 'Hulk' }, 'https://h.test/3.cbz');
  await new Promise(r => setTimeout(r, 30));
  let q = (await call(app.routes['GET /api/downloads/queue'])).body;
  assert.equal(q.settings.concurrency, 1);
  assert.equal(q.settings.startGapSec, 0);
  assert.equal(q.limiter.running, 1);
  assert.equal(q.active.length, 1);
  assert.equal(q.settings.failedRetryMaxWeeks, 4);
  assert.deepEqual(q.queued.map(j => j.issueId), ['i2', 'i3']);
  assert.equal(q.queued[0].host, 'h.test');

  assert.equal((await call(app.routes['POST /api/downloads/queue/:jobId/top'], { params: { jobId: q.queued[1].jobId } })).code, 200);
  q = (await call(app.routes['GET /api/downloads/queue'])).body;
  assert.deepEqual(q.queued.map(j => j.issueId), ['i3', 'i2']);

  assert.equal((await call(app.routes['POST /api/downloads/queue/:jobId/remove'], { params: { jobId: q.queued[1].jobId } })).code, 200);
  assert.equal(db.prepare("SELECT status FROM monitored_issues WHERE id = 'i2'").get().status, 'wanted');
  q = (await call(app.routes['GET /api/downloads/queue'])).body;
  assert.deepEqual(q.queued.map(j => j.issueId), ['i3']);
  assert.equal((await call(app.routes['POST /api/downloads/queue/:jobId/remove'], { params: { jobId: 'nope' } })).code, 404);

  const bad = await call(app.routes['PUT /api/downloads/queue/settings'], { body: { concurrency: 99 } });
  assert.equal(bad.code, 400);
});

test('wanted: routes and both schedules are set up; failed issues go back to wanted up to 4 times', () => {
  const db = queueDb();
  db.exec("UPDATE monitored_issues SET status = 'failed'; UPDATE monitored_issues SET weekly_retries = 4 WHERE id = 'i3';");
  const app = fakeApp();
  const schedules = [];
  const deps = Object.fromEntries(needs('wanted.js').map(n => [n, noop]));
  let released = null;
  Object.assign(deps, { app, db, logger, cron: { schedule: (expr, fn) => schedules.push([expr, fn]) },
    retryPolicy: { releaseForFailedRetry: n => { released = n; return 0; } } });
  const w = createWanted(deps);
  assert.ok(app.routes['POST /api/monitor/wanted/scan'] && app.routes['GET /api/monitor/wanted/scan/status']
    && app.routes['GET /api/monitor/wanted'] && app.routes['POST /api/monitor/series/:id/auto-grab']);
  assert.deepEqual(schedules.map(s => s[0]).sort(), ['0 */6 * * *', '50 5 2,4,6,8,10,12,14,16,18,20,22,24,26,28,30 * *']);
  assert.equal(w.requeueFailedIssues('test'), 2);
  assert.equal(released, 4);
  const st = Object.fromEntries(db.prepare('SELECT id, status, weekly_retries FROM monitored_issues').all().map(r => [r.id, `${r.status}/${r.weekly_retries}`]));
  assert.deepEqual(st, { i1: 'wanted/1', i2: 'wanted/1', i3: 'failed/4' });
  assert.equal(w.FAILED_RETRY_MAX_WEEKS, 4);
  assert.equal(w.wantedScanState.running, false);
});

test('GetComics routes are registered', () => {
  const app = fakeApp();
  const deps = Object.fromEntries(needs('getcomicsRoutes.js').map(n => [n, noop]));
  registerGetComicsRoutes({ ...deps, app });
  assert.deepEqual(Object.keys(app.routes).sort(), ['GET /api/getcomics/debug', 'GET /api/getcomics/links', 'GET /api/getcomics/search', 'POST /api/getcomics/download']);
});

// ── Shared source search (2026-11-05) ───────────────────────────────────────
// Stand-ins: Prowlarr answers with `nzb`, a GetComics search page with `gc`, a post page
// with `links`; /dlds/ links resolve through `resolve`. Year rule and scoring are simple
// versions of server.js's (year in brackets must match; score from the title's number).
function search({ nzb = [], gc = [], links = [], resolve = {}, blocked = [], sab = { status: true, nzo_ids: ['nzo1'] } } = {}) {
  const calls = { sab: [] };
  const deps = {
    logger, getSetting: () => null, PROWLARR_URL: 'http://prowlarr', PROWLARR_API_KEY: 'k', PROWLARR_TIMEOUT_MS: 1000, SABNZBD_URL: 'http://sab', SABNZBD_API_KEY: 'k',
    retryPolicy: { blocked: () => new Set(blocked) },
    buildIssueSearchQuery: (i, n, y, o) => (o?.gcStyle ? `${n} #${i.issue_number}` : `${n} ${i.issue_number} ${y}`),
    scoreResult: (title, name, num) => (title.includes(`#${num}`) || title.includes(` ${num} `) ? 30 : title.includes(name) ? 10 : 0),
    dropWrongYear: (cands, issue) => cands.filter(c => !/\((\d{4})\)/.test(c.title) || c.title.includes(`(${issue.store_date.slice(0, 4)})`)),
    axios: { get: async (url, o) => (url.includes('prowlarr') ? { data: nzb } : (calls.sab.push(o.params), { data: sab })) },
    fetchViaFlareSolverr: async url => url,
    scrapeGcResults: () => gc, scrapeGcLinks: () => links,
    resolveDldsLink: async u => resolve[u] ?? null,
  };
  return { s: createSourceSearch(deps), calls };
}
const ISSUE = { id: 'i1', issue_number: '5', store_date: '2016-03-01' };

test('source search: thresholds, wrong year and blocked results are dropped; best first', async () => {
  const { s } = search({
    nzb: [{ title: 'Hulk 5 (2016)', downloadUrl: 'n1', grabs: 1 }, { title: 'Hulk 5 (2016)', downloadUrl: 'n2', grabs: 9 },
          { title: 'Hulk (2016)', downloadUrl: 'n3' }, { title: 'Hulk 5 (1999)', downloadUrl: 'n4' }, { title: 'Hulk 5 (2016)', downloadUrl: 'bad' }],
    gc: [{ title: 'Hulk (2016)', url: 'g1' }, { title: 'Hulk #5 (2016)', url: 'g2' }, { title: 'Hulk #5 (2016)', url: 'gbad' }, { title: 'Thor', url: 'g0' }],
    blocked: ['bad', 'gbad'],
  });
  const r = await s.findSources(ISSUE, 'Hulk', 2016);
  assert.deepEqual(r.nzb.map(c => c.downloadUrl), ['n2', 'n1']);          // 25+ only, more grabs first
  assert.deepEqual(r.ddl.map(c => c.url), ['g2', 'g1']);                   // any score above 0
  assert.equal(r.q, 'Hulk 5 2016'); assert.equal(r.qGc, 'Hulk #5');
});

test('source search: GetComics links in order /dlds/, direct, then Pixeldrain/MediaFire/MEGA; failed files skipped', async () => {
  const links = [
    { url: 'https://mega.nz/file/x', label: 'MEGA' }, { url: 'https://host.test/a.cbz', label: 'Main' },
    { url: 'https://getcomics.org/dlds/1', label: 'DL1', isDlds: true }, { url: 'https://getcomics.org/dlds/2', label: 'DL2', isDlds: true },
  ];
  let { s } = search({ links, resolve: { 'https://getcomics.org/dlds/1': 'https://f.test/old.cbz', 'https://getcomics.org/dlds/2': 'https://f.test/new.cbz' } });
  assert.deepEqual(await s.pickDdlLink(ISSUE, 'post', new Set(['https://f.test/old.cbz'])), { url: 'https://f.test/new.cbz', label: 'DL2' });
  ({ s } = search({ links }));                                              // /dlds/ lead nowhere: the direct link
  assert.equal((await s.pickDdlLink(ISSUE, 'post', new Set())).url, 'https://host.test/a.cbz');
  assert.equal((await s.pickDdlLink(ISSUE, 'post', new Set(['https://host.test/a.cbz']))).url, 'https://mega.nz/file/x');
  assert.equal(await s.pickDdlLink(ISSUE, 'post', new Set(['https://host.test/a.cbz', 'https://mega.nz/file/x'])), null);
  ({ s } = search({ links: [] }));
  await assert.rejects(s.pickDdlLink(ISSUE, 'post', new Set()), /No download links/);
});

test('source search: SABnzbd hand-off', async () => {
  let { s, calls } = search();
  assert.deepEqual(await s.sendToSab({ downloadUrl: 'n1', title: 'Hulk 5' }), { ok: true, nzo_id: 'nzo1' });
  assert.equal(calls.sab[0].name, 'n1'); assert.equal(calls.sab[0].cat, 'comics');
  ({ s } = search({ sab: { status: false, error: 'full' } }));
  assert.deepEqual(await s.sendToSab({ downloadUrl: 'n1' }), { ok: false, error: 'full' });
});

test('auto-grab now skips a GetComics post that already failed and takes the NZB', async () => {
  const db = queueDb();
  db.exec("UPDATE monitored_issues SET status = 'wanted'; DELETE FROM monitored_issues WHERE id <> 'i1';");
  const { s } = search({ nzb: [{ title: 'Hulk 1 (2016)', downloadUrl: 'n1' }], gc: [{ title: 'Hulk #1 (2016)', url: 'gfailed' }], blocked: ['gfailed'] });
  s.findSources = (orig => (i, n, y) => orig({ ...i, store_date: '2016-01-01' }, n, y))(s.findSources);
  const deps = Object.fromEntries(needs('wanted.js').map(n => [n, noop]));
  const ddl = [];
  Object.assign(deps, { app: fakeApp(), db, logger, cron: { schedule: noop }, getSetting: () => 'x', sourceSearch: s,
    activeDownloads: new Map(), isCancelled: () => false, runDdlDownload: (...a) => ddl.push(a) });
  const r = createWanted(deps).startAutoGrab('s1');
  assert.equal(r.total, 1);
  await new Promise(res => setTimeout(res, 1200));                         // one issue, then the 800 ms pause
  const row = db.prepare("SELECT status, download_id, download_url FROM monitored_issues WHERE id = 'i1'").get();
  assert.deepEqual({ ...row }, { status: 'snatched', download_id: 'nzo1', download_url: 'n1' });
  assert.equal(ddl.length, 0);
});

test('next-source retry: a GetComics post with no usable link is blocked and the NZB is tried next', async () => {
  const db = queueDb();
  const blockedUrls = new Set();
  const ss = {
    findSources: async () => ({
      ddl: blockedUrls.has('post1') ? [] : [{ _source: 'ddl', url: 'post1', title: 'Hulk #1' }],
      nzb: [{ _source: 'nzb', downloadUrl: 'n1', title: 'Hulk 1' }], blocked: blockedUrls,
    }),
    pickDdlLink: async () => null,
    sendToSab: async () => ({ ok: true, nzo_id: 'nzo9' }),
  };
  const { mod } = issueDownloads(db, {
    sourceSearch: ss, MAX_DOWNLOAD_ATTEMPTS: 5,
    retryPolicy: { triage: () => 'block', record: (id, url) => blockedUrls.add(url), attempts: () => blockedUrls.size,
      cooldownActive: () => false, cooldown: () => ({ until: null, strikes: 0 }) },
  });
  await mod.blacklistAndRetry({ id: 'i1', issue_number: '1' }, { id: 's1', name: 'Hulk' }, 'https://f.test/broken.cbz', 'bad file');
  assert.deepEqual([...blockedUrls], ['https://f.test/broken.cbz', 'post1']);
  const row = db.prepare("SELECT status, download_id, download_url, fail_count FROM monitored_issues WHERE id = 'i1'").get();
  assert.deepEqual({ ...row }, { status: 'snatched', download_id: 'nzo9', download_url: 'n1', fail_count: 2 });
});
