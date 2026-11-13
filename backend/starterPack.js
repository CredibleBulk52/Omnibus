'use strict';
// ─── Starter pack (2026-11-14, claude/STARTER_PACK.md) ────────────
// A new install can start with the maintainer's curated reading orders: Timeline events, Top Shelf
// runs and Essentials, in one file (backend/starter-pack/starter-pack.json) built from a library
// with the curated export (curatedTransfer.js).
//
//   Build (maintainer, on the server):  docker exec omnibus node backend/starterPack.js export /backups/starter-pack.json
//     then copy _backups/db/starter-pack.json to backend/starter-pack/starter-pack.json and deploy.
//   Load (a new admin): "Load the starter pack" in the admin bar of an empty Timeline, Top Shelf or
//     Essentials page (GET /api/starter-pack, POST /api/starter-pack/load). Everything arrives
//     published (user, 2026-11-14); items the library already has (same name) are skipped. Issues are
//     matched to the library in the background.
//
// What the pack leaves out (user decisions, 2026-11-14): hidden draft events, unapproved runs,
// lists that are not Essentials, events still publishing (EXCLUDE_EVENTS), and all notes: event
// tier notes and tier reasons, and the notes on Essentials entries. Three descriptions that shared
// eight or more words with Comic Vine text are replaced (DESCRIPTIONS).
const fs = require('fs');
const path = require('path');

const FORMAT = 'omnibus-starter-pack';
const VERSION = 1;
const PACK_FILE = path.join(__dirname, 'starter-pack', 'starter-pack.json');
const LOADED_KEY = 'starter_pack_loaded';

const EXCLUDE_EVENTS = [{ name: 'Avengers: Armageddon', year: 2026 }, { name: 'Batman: Bad Seeds', year: 2026 }];
// kind + the start of the name (lower case) → description
const DESCRIPTIONS = [
  { kind: 'event', starts: 'realm of kings', text: "The War of Kings leaves a tear in space called the Fault, and on the other side waits the Cancerverse: a universe where nothing dies and life has turned predatory. Nova, the Guardians of the Galaxy and the Inhumans try to hold the line as its forces push through, and the one weapon that might end it is Thanos, brought back and barely under control. Dan Abnett and Andy Lanning's cosmic saga reaches its finale here." },
  { kind: 'run', starts: 'pride of baghdad', text: "Brian K. Vaughan and Niko Henrichon's graphic novel follows a pride of lions loose in Baghdad after bombing wrecks the zoo in 2003. Inspired by real events, it uses their brief freedom to ask what liberation is worth when someone else hands it to you." },
  { kind: 'run', starts: 'we3', text: "Grant Morrison and Frank Quitely's three-issue story of three pets turned into armoured military prototypes, who break out and try to find their way home. Spare in words and inventive in layout, it hits harder than its length suggests." },
];

const lower = s => String(s || '').trim().toLowerCase();
const excluded = (name, year) => EXCLUDE_EVENTS.some(x => lower(x.name) === lower(name) && Number(x.year) === Number(year));
const descriptionFor = (kind, name) => (DESCRIPTIONS.find(d => d.kind === kind && lower(name).startsWith(d.starts)) || {}).text || null;

// One exported item without its notes.
function strip(file) {
  const out = { ...file, item: { ...file.item } };
  const name = file.item.name || file.item.title;
  const own = descriptionFor(file.kind, name);
  if (own) out.item.description = own;
  if (file.kind === 'event') out.issues = (file.issues || []).map(i => { const { tier_reason, ...rest } = i; return { ...rest, tier_note: null }; });
  if (file.kind === 'list') out.entries = (file.entries || []).map(e => ({ ...e, note: null }));
  return out;
}

// Build the pack from this library: events first, then runs (they link to events), then the
// Essentials (they link to both).
function buildPack({ db, curated, appVersion = null }) {
  const items = [];
  const skipped = [];
  for (const e of db.prepare(`SELECT id, name, year FROM events WHERE ${require('./eventDrafts').published(db)} ORDER BY year, name`).all()) {
    if (excluded(e.name, e.year)) { skipped.push(`${e.name} (${e.year})`); continue; }
    items.push(strip(curated.exportFile('event', e.id)));
  }
  for (const r of db.prepare("SELECT id FROM canon_runs WHERE status = 'approved' ORDER BY title").all()) items.push(strip(curated.exportFile('run', r.id)));
  for (const l of db.prepare("SELECT id FROM reading_lists WHERE visibility = 'essential' ORDER BY name").all()) items.push(strip(curated.exportFile('list', l.id)));
  const counts = { events: 0, runs: 0, lists: 0 };
  for (const it of items) counts[`${it.kind}s`]++;
  return { format: FORMAT, version: VERSION, created_at: new Date().toISOString(), ...(appVersion ? { app_version: appVersion } : {}), counts, left_out: skipped, items };
}

function checkPack(pack) {
  if (!pack || pack.format !== FORMAT || !Array.isArray(pack.items)) throw Object.assign(new Error('That is not an Omnibus starter pack.'), { status: 400 });
  if (pack.version > VERSION) throw Object.assign(new Error('This starter pack was made by a newer version of Omnibus.'), { status: 400 });
  return pack;
}
function readPack(file = PACK_FILE) {
  if (!fs.existsSync(file)) return null;
  try { return checkPack(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return null; }
}

function createStarterPack({ app = null, db, curated, requireAdmin, logger = null, getSetting, setSetting, reconcileEvents = async () => {}, reconcileRuns = async () => {}, packFile = PACK_FILE }) {
  const have = () => ({
    events: db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${require('./eventDrafts').published(db)}`).get().n,
    runs: db.prepare("SELECT COUNT(*) AS n FROM canon_runs WHERE status = 'approved'").get().n,
    lists: db.prepare("SELECT COUNT(*) AS n FROM reading_lists WHERE visibility = 'essential'").get().n,
  });
  let cached = null;
  const pack = () => (cached || (cached = readPack(packFile)));
  let loading = false;

  function status() {
    const p = pack();
    return { available: !!p, loaded: getSetting(LOADED_KEY) || null, loading, pack: p ? p.counts : null, have: have() };
  }

  // Already in the library under the same name: skipped, so loading twice adds nothing.
  function exists(it) {
    if (it.kind === 'event') return !!db.prepare('SELECT 1 FROM events WHERE lower(name) = lower(?) AND (year IS ? OR year = ?)').get(it.item.name, it.item.year ?? null, it.item.year ?? null);
    if (it.kind === 'run') return !!db.prepare("SELECT 1 FROM canon_runs WHERE lower(title) = lower(?) AND lower(COALESCE(parent_series, '')) = lower(?)").get(it.item.title, it.item.parent_series || '');
    return !!db.prepare("SELECT 1 FROM reading_lists WHERE lower(name) = lower(?) AND visibility = 'essential'").get(it.item.name);
  }

  async function load(user) {
    const p = pack();
    if (!p) throw Object.assign(new Error('No starter pack in this version of Omnibus.'), { status: 404 });
    if (loading) throw Object.assign(new Error('The starter pack is already loading.'), { status: 409 });
    loading = true;
    const done = { events: 0, runs: 0, lists: 0, skipped: 0, failed: 0 };
    try {
      for (const it of p.items) {
        try {
          if (exists(it)) { done.skipped++; continue; }
          await curated.importFile(it, user, { publish: true, match: false });
          done[`${it.kind}s`]++;
        } catch (e) { done.failed++; logger?.warn?.('starter-pack', 'An item did not load', { kind: it.kind, name: it.item?.name || it.item?.title, error: e.message }); }
      }
      setSetting(LOADED_KEY, new Date().toISOString());
      logger?.info?.('starter-pack', 'Loaded', { ...done, by: user?.username });
    } finally { loading = false; }
    // Match every issue to the library once, in the background (a minute or two on a large library).
    Promise.resolve().then(() => reconcileEvents()).then(() => reconcileRuns())
      .then(() => logger?.info?.('starter-pack', 'Matched to the library'))
      .catch(e => logger?.warn?.('starter-pack', 'Matching failed; the next scan will match', e.message));
    return done;
  }

  if (app) {
    app.get('/api/starter-pack', requireAdmin, (req, res) => res.json(status()));
    app.post('/api/starter-pack/load', requireAdmin, async (req, res) => {
      try { res.json({ ...(await load(req.user)), status: status() }); }
      catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Unable to load the starter pack' }); }
    });
  }
  return { status, load, buildPack: () => buildPack({ db, curated }) };
}

module.exports = { createStarterPack, buildPack, checkPack, readPack, strip, FORMAT, VERSION, PACK_FILE, LOADED_KEY, EXCLUDE_EVENTS };

// ── Command line: build the pack from the running install's database ──
//   node backend/starterPack.js export [file]   (default: backend/starter-pack/starter-pack.json)
if (require.main === module) {
  const [cmd, out = PACK_FILE] = process.argv.slice(2);
  if (cmd !== 'export') { console.log('Usage: node backend/starterPack.js export [file]'); process.exit(1); }
  const Database = require('better-sqlite3');
  // Read-write only because the list module checks its tables at start (CREATE … IF NOT EXISTS); the export writes nothing.
  const db = new Database(process.env.DB_PATH || '/appdata/omnibus.db', { fileMustExist: true });
  const noop = () => {};
  const app = new Proxy({}, { get: () => noop });   // the list module registers routes; none are needed here
  const readingLists = require('./readingLists')({ app, db, requireAuth: noop, cvApiGet: async () => null, getCVKey: () => null, logger: null, IN: require('./issueNumber') });
  const curated = require('./curatedTransfer').createCuratedTransfer({ app: null, db, readingLists, reconcileEvents: async () => {}, reconcileRuns: async () => {} });
  let version = null; try { version = require('./package.json').version; } catch {}
  const p = buildPack({ db, curated, appVersion: version });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(p));
  console.log(`Starter pack: ${p.counts.events} events, ${p.counts.runs} runs, ${p.counts.lists} Essentials → ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
  if (p.left_out.length) console.log(`Left out (still publishing): ${p.left_out.join(', ')}`);
}
