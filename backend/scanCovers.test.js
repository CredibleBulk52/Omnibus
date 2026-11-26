'use strict';
// ─── Scans keep every cover in the cache (2026-11-26) ────────────────────────────────────────
// A library scan makes each book's cover thumbnail (libraryScanner.js warmScannedThumbnail), so
// shelves do not wait for archives to be opened while someone browses. A scan of a series whose
// folder has not changed used to check only an unused series_<id> file, so covers lost after a
// backup restore on a new install, or after "Clear all thumbnails", were made only on demand.
// The test starts the real server on a small library, scans it, empties the cover cache, scans
// again, and checks every book's cover is back and no series_<id> file is made.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

let Database = null, sharp = null, archiver = null;
try { Database = require('better-sqlite3'); sharp = require('sharp'); archiver = require('archiver'); } catch {}
let has7z = false;
try { execFileSync('7z', ['i'], { stdio: 'ignore' }); has7z = true; } catch {}

async function cbz(file, colour) {
  const page = await sharp({ create: { width: 400, height: 600, channels: 3, background: colour } }).jpeg().toBuffer();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file); const zip = archiver('zip');
    out.on('close', resolve); zip.on('error', reject); zip.pipe(out);
    zip.append(page, { name: '001.jpg' }); zip.append(page, { name: '002.jpg' }); zip.finalize();
  });
}

function boot(dir, port) {
  const env = { ...process.env, PORT: String(port), DB_PATH: path.join(dir, 'omnibus.db'), DB_BACKUP_DIR: path.join(dir, 'backups'),
    COMICS_PATH: path.join(dir, 'comics'), JWT_SECRET: 'c3'.repeat(32), OMNIBUS_SECRET: 'd4'.repeat(32), CV_API_KEY: '', ANTHROPIC_API_KEY: '', LOG_LEVEL: 'info' };
  const child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, log: '' };
  child.stdout.on('data', d => { state.log += d; }); child.stderr.on('data', d => { state.log += d; });
  return state;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(check, ms, what) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(250)) if (await check()) return;
  throw new Error(`Timed out: ${what}`);
}

test('a scan makes every missing cover again, also in folders that have not changed', { skip: !Database || !sharp || !archiver || !has7z ? 'needs better-sqlite3, sharp, archiver and 7z' : false, timeout: 120000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-covers-'));
  const lib = path.join(dir, 'comics', 'Lib');
  await cbz(path.join(lib, 'Alpha (2020)', 'Alpha 001.cbz'), '#c03030');
  await cbz(path.join(lib, 'Alpha (2020)', 'Alpha 002.cbz'), '#3050c0');
  await cbz(path.join(lib, 'Beta (2021)', 'Beta 001.cbz'), '#30a050');
  const port = 41000 + Math.floor(Math.random() * 2000);
  const server = boot(dir, port);
  t.after(() => { server.child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  await until(() => /Omnibus running/.test(server.log), 90000, 'server start');

  const base = `http://127.0.0.1:${port}`;
  const login = await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) })).json();
  const H = { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' };
  const made = await (await fetch(`${base}/api/libraries`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'Lib', path: lib }) })).json();
  assert.ok(made.id, JSON.stringify(made));
  const cache = path.join(dir, 'thumbcache');
  const covers = () => fs.readdirSync(cache).filter(f => /\.(jpe?g|png|webp|gif)$/.test(f)).sort();
  const scan = async n => {
    const r = await fetch(`${base}/api/libraries/${made.id}/scan`, { method: 'POST', headers: H });
    assert.equal(r.status, 200);
    await until(() => (server.log.match(/scan complete/g) || []).length >= n, 60000, `scan ${n}`);
  };

  await scan(1);
  const db = new Database(path.join(dir, 'omnibus.db'), { readonly: true });
  const ids = db.prepare('SELECT id FROM scanned_books ORDER BY id').all().map(r => `${r.id}.jpg`);
  db.close();
  assert.equal(ids.length, 3);
  assert.deepEqual(covers(), ids);   // one cover per book, and no unused series_<id> file

  // A restored backup on a new install, or "Clear all thumbnails": the folders have not changed.
  for (const f of covers()) fs.unlinkSync(path.join(cache, f));
  await scan(2);
  assert.deepEqual(covers(), ids);
  assert.match(server.log.split(/scan complete/)[2], /"coversMade":3/);

  // Nothing missing: the next scan makes nothing.
  await scan(3);
  assert.match(server.log.split(/scan complete/)[3], /"coversMade":0/);
});
