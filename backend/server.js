require('dotenv').config();
const authSecurity = require('./authSecurity');
const readerSecurity = require('./readerSecurity');
const JWT_SECRET = authSecurity.validateSecret(process.env.JWT_SECRET);
const express = require('express');
const axios = require('axios');
// Anthropic errors: log the API's own message (status alone hid the cause of
// the 2026 "Request failed with status code 400" generate failures).
axios.interceptors.response.use(r => r, e => {
  try {
    if (String(e.config?.url || '').includes('api.anthropic.com') && e.response) {
      let model = null; try { model = JSON.parse(e.config.data || '{}').model || null; } catch {}
      console.warn(`[anthropic] ${e.response.status} ${e.response.data?.error?.type || ''}: ${e.response.data?.error?.message || ''} (model ${model})`);
    }
  } catch {}
  return Promise.reject(e);
});
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn: nativeSpawn } = require('child_process');
const util = require('util');
const { AsyncResource } = require('node:async_hooks');
const { createLibraryAccess, coordinateLibraryRoutes } = require('./metadata/libraryAccess');
const { GENRE_DEFS, GENRE_VERSION } = require('./genres');
const deploymentGate = require('./metadata/deploymentGate').createDeploymentGate();
const libraryAccess = createLibraryAccess({deploymentGate});
const nativeExecFileAsync = util.promisify(execFile);
const execFileAsync = (file, args, ...rest) => libraryAccess.run(
  /^(?:7z|7za)(?:\.exe)?$/i.test(path.basename(file)) && ['a','d','u'].includes(args?.[0]) ? 'write' : 'read',
  () => nativeExecFileAsync(file, args, ...rest));
// Enricher processes sometimes outlive the HTTP handler (including a closed
// browser). Keep their writer scope until the actual child closes.
function spawn(...args) {
  libraryAccess.assertWrite();
  const proc = nativeSpawn(...args);
  proc.on('error', () => {}); // Existing close handlers report nonzero exits.
  void libraryAccess.track(new Promise(resolve => proc.once('close', resolve)));
  return proc;
}
const { createCbzFromDir, extractArchive } = require('./metadata/archiveTools').createArchiveTools({ run: execFileAsync });
const archiver = require('archiver');
const cron = require('node-cron');
const crypto = require('crypto');
const yaml = require('js-yaml');
const { migrateMonitoredIssuesCanonical, applyIsSpecialSchema, applyReadingListsSchema, applyStableIdsSchema } = require('./schema');
const IN = require('./issueNumber'); // canonical issue-number parsing/normalisation

// ─── Persistent log files ─────────────────────────────────────────
// Everything written to the console (the structured logger, startup messages,
// crash reports) is also appended to a daily file so it survives rebuilds.
// LOG_DIR defaults to /logs, which docker-compose maps to ./logs in the install folder;
// falls back to a logs folder in the data volume. Keeps LOG_KEEP_DAYS (14) days.
const LOG_DIR = process.env.LOG_DIR
  || (fs.existsSync('/logs') ? '/logs' : path.join(path.dirname(process.env.DB_PATH || '/appdata/omnibus.db'), 'logs'));
const LOG_KEEP_DAYS = parseInt(process.env.LOG_KEEP_DAYS || '14', 10) || 14;
const logFile = { day: null, stream: null };

function logFileWrite(line) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== logFile.day) {
      if (logFile.stream) logFile.stream.end();
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logFile.stream = fs.createWriteStream(path.join(LOG_DIR, `omnibus-${day}.log`), { flags: 'a' });
      logFile.stream.on('error', () => { logFile.stream = null; logFile.day = null; });
      logFile.day = day;
      const cutoff = Date.now() - LOG_KEEP_DAYS * 864e5;
      for (const f of fs.readdirSync(LOG_DIR)) {
        const m = f.match(/^omnibus-(\d{4}-\d{2}-\d{2})\.log$/);
        if (m && Date.parse(m[1]) < cutoff) { try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch {} }
      }
    }
    if (logFile.stream) logFile.stream.write(line.endsWith('\n') ? line : line + '\n');
  } catch { /* file logging must never break the app */ }
}

for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    const text = args.map(a => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    // The structured logger already stamps its lines; give the rest a timestamp.
    logFileWrite(/^\[\d{4}-\d{2}-\d{2} /.test(text) ? text : `[${new Date().toISOString().replace('T', ' ').slice(0, 23)}] ${text}`);
  };
}


// ─── Global error safety net ──────────────────────────────────────
// Catch anything that escapes local try/catch blocks.
// Logs to stderr so it appears in `docker logs` even if the structured logger isn't ready.
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
  console.error(`[UNHANDLED REJECTION] ${new Date().toISOString()} ${msg}`);
});
process.on('uncaughtException', (err) => {
  console.error(`[UNCAUGHT EXCEPTION] ${new Date().toISOString()} ${err.message}\n${err.stack}`);
  // Don't exit — let the server keep running
});

const app = express();
coordinateLibraryRoutes(app, libraryAccess, {readScope: (route,req) => {
  // Resolve before admission, then the coordinator rechecks after any wait.
  // Retagging preserves series membership and edits only within that folder.
  if(route==='/api/series/:id/thumbnail')return 'series:'+req.params.id;
  if(route.startsWith('/api/books/:id/')){
    const book=db.prepare('SELECT series_id FROM scanned_books WHERE id=?').get(req.params.id);
    return book?.series_id ? 'series:'+book.series_id : null;
  }
  return null; // Disk covers and unknown archive consumers stay conservative.
}});
app.set('trust proxy', 1); // Trust reverse proxy headers (X-Forwarded-For, X-Forwarded-Proto)
// Security review 2026-11-12: no cross-origin API access (the app and API share one origin;
// the dev server proxies /api), and basic browser protections on every response.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');      // never run an upload or file as a script or page
  res.set('X-Frame-Options', 'SAMEORIGIN');          // no framing by other sites (clickjacking)
  next();
});
// Event generation and the guide-page test may carry a pasted guide page (up to ~60k characters kept).
app.use((req, res, next) => (/^\/api\/events\/(generate|guide-page\/test)$|^\/api\/curated\/import$/.test(req.path) ? express.json({ limit: req.path === '/api/curated/import' ? '5mb' : '1mb' }) : express.json())(req, res, next));
app.use(require('./metadata/requestDiagnostics').metadataRequestDiagnostics({logger:{warn:(...args)=>logger.warn(...args)}}));

// ─── SSE endpoints ────────────────────────────────────────────────

/** Live log stream — sends ring buffer on connect, then pushes new entries. */
app.get('/api/logs/stream', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send existing ring buffer in chronological order
  const ordered = logRingIdx < LOG_RING_SIZE
    ? logRing.slice(0, logRingIdx)
    : [...logRing.slice(logRingIdx % LOG_RING_SIZE), ...logRing.slice(0, logRingIdx % LOG_RING_SIZE)];
  for (const entry of ordered) {
    if (entry) res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  logSseClients.add(res);
  req.on('close', () => logSseClients.delete(res));
});

/** Download progress stream — sends current active downloads on connect, then pushes updates. */
app.get('/api/downloads/progress/stream', requireDownloadAccess, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send current active downloads immediately
  const snapshot = { type: 'snapshot', downloads: [...activeDownloads.values()] };
  res.write(`data: ${JSON.stringify(snapshot)}\n\n`);

  dlSseClients.add(res);
  req.on('close', () => dlSseClients.delete(res));
});

/** Current active downloads (polling fallback). */
app.get('/api/downloads/progress', requireDownloadAccess, (req, res) => {
  res.json([...activeDownloads.values()]);
});

// POST /api/downloads/:id/cancel — user clicked the ✕ on a toast.
// Flags the download as cancelled and aborts any in-flight axios stream
// associated with it. The background worker is responsible for noticing the
// flag (or catching the AbortError from the stream) and doing cleanup —
// deleting partial files, setting status='cancelled', auto-removing.
//
// We intentionally do NOT delete the activeDownloads entry here. The worker
// needs it to check the cancel flag. The worker will remove it after cleanup.
app.post('/api/downloads/:id/cancel', requireDownloadAccess, (req, res) => {
  const entry = activeDownloads.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Download not found or already finished' });
  if (entry.cancel) return res.json({ alreadyCancelling: true });
  entry.cancel = true;
  entry.cancelling = true;
  // If the worker has attached an AbortController (for axios streams),
  // trigger it so the in-flight request terminates immediately rather than
  // waiting for the next chunk-boundary flag check.
  try { entry.abortController?.abort(); } catch (e) { logger.warn('download-cancel', `abort failed for ${req.params.id}`, e.message); }
  pushDownloadUpdate({ ...entry });
  logger.info('download-cancel', `User cancelled ${req.params.id}`, { filename: entry.filename });
  res.json({ cancelling: true });
});

/**
 * Check whether a download has been flagged for cancellation. Used by worker
 * loops (auto-grab, retag-all, folder downloaders) to bail between units of
 * work. Returns true if the entry was removed (defensive) or cancel=true.
 */
function isCancelled(dlId) {
  const e = activeDownloads.get(dlId);
  return !e || e.cancel === true;
}

/**
 * After a worker has detected cancellation, call this to finalize the toast
 * state — sets status='cancelled' with a user-facing message and schedules
 * auto-removal. Does not delete partial files; caller is responsible for that
 * since only the caller knows the paths involved.
 */
function finalizeCancellation(dlEntry, extraMsg) {
  if (!dlEntry) return;
  dlEntry.status = 'cancelled';
  dlEntry.cancelling = false;
  dlEntry.error = extraMsg || 'Cancelled by user';
  pushDownloadUpdate({ ...dlEntry });
  setTimeout(() => {
    activeDownloads.delete(dlEntry.id);
    pushDownloadUpdate({ id: dlEntry.id, status: 'removed' });
  }, 8000);
}

// ─── Structured logger ────────────────────────────────────────────
// Set LOG_LEVEL=debug in environment for verbose output (default: info)
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL  = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;

const RESET_LOG_PATH = '/appdata/reset-audit.log';
function appendResetLog(message, data) {
  try {
    const ts  = new Date().toISOString().replace('T',' ').slice(0,-1);
    const line = `[${ts}] ${message} ${data !== undefined ? JSON.stringify(data) : ''}\n`;
    fs.appendFileSync(RESET_LOG_PATH, line);
  } catch { /* never let logging crash the server */ }
}

function log(level, category, message, data) {
  if ((LOG_LEVELS[level] ?? 99) > LOG_LEVEL) return;
  const ts  = new Date().toISOString().replace('T',' ').slice(0,-1);
  const pfx = `[${ts}] [${level.toUpperCase().padEnd(5)}] [${category}]`;
  const out = data !== undefined ? `${pfx} ${message} ${JSON.stringify(data)}` : `${pfx} ${message}`;
  (level === 'error' ? console.error : console.log)(out);
  // Persist any reset-related events to a file that survives container restarts
  if (category === 'refresh-dir' && (
    message.includes('reset') || message.includes('missing') || message.includes('directory missing')
  )) {
    appendResetLog(`[${category}] ${message}`, data);
  }
}
const logger = {
  error: (cat, msg, d) => log('error', cat, msg, d),
  warn:  (cat, msg, d) => log('warn',  cat, msg, d),
  info:  (cat, msg, d) => log('info',  cat, msg, d),
  debug: (cat, msg, d) => log('debug', cat, msg, d),
};

// ─── SSE infrastructure ───────────────────────────────────────────
// Ring buffer — last 500 log lines, shared across all SSE log clients
const LOG_RING_SIZE = 500;
const logRing = [];
let logRingIdx = 0;

// SSE client sets
const logSseClients    = new Set(); // res objects subscribed to /api/logs/stream
const dlSseClients     = new Set(); // res objects subscribed to /api/downloads/progress/stream

// Active downloads map: downloadId → { id, filename, seriesName, bytesReceived, totalBytes, status, startedAt }
const activeDownloads  = new Map();

function pushLogEntry(entry) {
  logRing[logRingIdx % LOG_RING_SIZE] = entry;
  logRingIdx++;
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of logSseClients) {
    try { client.write(payload); } catch { logSseClients.delete(client); }
  }
}

function pushDownloadUpdate(dl) {
  const payload = `data: ${JSON.stringify({ type: 'download', download: dl })}\n\n`;
  for (const client of dlSseClients) {
    try { client.write(payload); } catch { dlSseClients.delete(client); }
  }
}

// Progress pushes, at most 4 a second per download (2026-10-27). Pushing on
// every network chunk sent thousands of events per pack to each open browser.
const dlLastPush = new WeakMap();
function pushDownloadProgress(dl) {
  const now = Date.now();
  if (now - (dlLastPush.get(dl) || 0) < 250) return;
  dlLastPush.set(dl, now);
  pushDownloadUpdate({ ...dl });
}

function pushSseEvent(obj) {
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  for (const client of dlSseClients) {
    try { client.write(payload); } catch { dlSseClients.delete(client); }
  }
}

// Tap the existing log function to also write to ring buffer
function log(level, category, message, data) {
  if ((LOG_LEVELS[level] ?? 99) > LOG_LEVEL) return;
  const ts  = new Date().toISOString().replace('T',' ').slice(0,-1);
  const pfx = `[${ts}] [${level.toUpperCase().padEnd(5)}] [${category}]`;
  const out = data !== undefined ? `${pfx} ${message} ${JSON.stringify(data)}` : `${pfx} ${message}`;
  (level === 'error' ? console.error : console.log)(out);
  // Push to ring buffer + SSE clients
  const entry = { ts, level, category, message, data: data ?? null };
  pushLogEntry(entry);
}

const COMICS_PATH = process.env.COMICS_PATH || '/comics';
const PORT = process.env.PORT || 9810;
const DB_PATH = process.env.DB_PATH || '/appdata/omnibus.db';
const PROWLARR_URL = process.env.PROWLARR_URL || '';
const PROWLARR_API_KEY = process.env.PROWLARR_API_KEY || '';
// Prowlarr answers only after its slowest indexer; 15 s timed out on a working Prowlarr (2026-11-03).
const PROWLARR_TIMEOUT_MS = 45000;
const SABNZBD_URL = process.env.SABNZBD_URL || '';
const SABNZBD_API_KEY = process.env.SABNZBD_API_KEY || '';
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://flaresolverr:8191';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// ─── Auth / OIDC constants ────────────────────────────────────────
// Generic OIDC — works with Authentik, Keycloak, Authelia, Google, etc.
// OIDC_BASE_URL is the base path to your provider's OIDC endpoints.
//   Authentik example:  https://auth.example.com/application/o
//   Keycloak example:   https://auth.example.com/realms/myrealm/protocol/openid-connect
//   Google example:     https://accounts.google.com
const OIDC_CLIENT_ID     = process.env.OIDC_CLIENT_ID     || '';
const OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET || '';
const OIDC_BASE_URL      = (process.env.OIDC_BASE_URL     || '').replace(/\/$/, '');

const JWT_EXPIRES_DAYS   = 30;
const OMNIBUS_URL        = (process.env.OMNIBUS_URL || 'http://localhost:9810').replace(/\/$/, '');
const OIDC_REDIRECT_URI  = `${OMNIBUS_URL}/api/auth/callback`;

// ─── Database ─────────────────────────────────────────────────────
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
// A restore chosen in Settings › Backups is applied here, before the database opens (backups.js).
const DB_BACKUP_DIR  = process.env.DB_BACKUP_DIR || (fs.existsSync('/backups') ? '/backups' : path.join(path.dirname(DB_PATH), 'backups'));
const restoreResult = require('./backups').applyPendingRestore({ dbPath: DB_PATH, Database, backupDir: DB_BACKUP_DIR,
  log: { warn: m => logger.warn('db-backup', m), error: m => logger.error('db-backup', m) } });
const db = new Database(DB_PATH);

// ─── Thumbnail disk cache ─────────────────────────────────────────
// Caches first-page extractions so bsdtar only runs once per book.
// Files stored as /appdata/thumbcache/{cacheKey}.{ext}
const THUMB_CACHE_DIR = path.join(dbDir, 'thumbcache');
// Cached covers are resized, not the full first page (coverThumb.js, 2026-11-05).
const { coverThumb } = require('./coverThumb');
fs.mkdirSync(THUMB_CACHE_DIR, { recursive: true });

// Incremented whenever all thumbnails are cleared — invalidates browser ETags
let thumbCacheGen = Date.now();

// ─── Thumbnail extraction concurrency limiter ─────────────────────
// Caps simultaneous archive extractions so a page with 30+ thumbnails
// doesn't spawn 30 unrar/7z processes at once and stall the server.
const THUMB_CONCURRENCY = 4;
let _thumbActive = 0;
const _thumbQueue = [];
function withThumbSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = AsyncResource.bind(() => {
      _thumbActive++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        _thumbActive--;
        if (_thumbQueue.length) _thumbQueue.shift()();
      });
    });
    if (_thumbActive < THUMB_CONCURRENCY) run();
    else _thumbQueue.push(run);
  });
}

function findThumbCache(cacheKey) {
  for (const ext of ['.jpg', '.jpeg', '.png', '.webp', '.gif']) {
    const p = path.join(THUMB_CACHE_DIR, `${cacheKey}${ext}`);
    if (fs.existsSync(p)) {
      try { if (fs.statSync(p).size === 0) { fs.unlinkSync(p); continue; } } catch {}
      return { filePath: p, ext };
    }
  }
  return null;
}

function evictThumbCache(cacheKey) {
  // A key is a plain file name (a book id or series_<id>); anything else could reach outside the cache.
  if (!/^[A-Za-z0-9_.-]+$/.test(String(cacheKey || '')) || /^\.+$/.test(String(cacheKey))) return;
  for (const ext of ['.jpg', '.jpeg', '.png', '.webp', '.gif']) {
    const p = path.join(THUMB_CACHE_DIR, `${cacheKey}${ext}`);
    try { fs.unlinkSync(p); } catch {}
  }
}

// ─── Collection cover image store ────────────────────────────────
const COLLECTION_COVERS_DIR = path.join(dbDir, 'collection-covers');
fs.mkdirSync(COLLECTION_COVERS_DIR, { recursive: true });

// Migrate: add cover_image / cover_position columns if they don't exist yet
try { db.prepare('ALTER TABLE collections ADD COLUMN cover_image TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE collections ADD COLUMN sort_order INTEGER DEFAULT 0').run(); } catch {}
try { db.prepare("ALTER TABLE events ADD COLUMN event_tier INTEGER DEFAULT 2").run(); } catch {}
try { db.prepare("ALTER TABLE events ADD COLUMN sort_order INTEGER DEFAULT 0").run(); } catch {}
try { db.prepare("ALTER TABLE monitored_series ADD COLUMN series_type TEXT DEFAULT 'comic'").run(); } catch {}
try { db.prepare("ALTER TABLE event_issues ADD COLUMN phase TEXT").run(); } catch {}
try { db.prepare('ALTER TABLE collections ADD COLUMN cover_position TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE collections ADD COLUMN library_id TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE award_data ADD COLUMN cv_volume_id TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE award_data ADD COLUMN cv_issue_id TEXT').run(); } catch {}
try { db.prepare(`CREATE TABLE IF NOT EXISTS cv_person_cache (
  name       TEXT PRIMARY KEY,
  cv_person_id TEXT,
  image_url  TEXT,
  cached_at  TEXT DEFAULT CURRENT_TIMESTAMP
)`).run(); } catch {}
// One-time: push existing specials with low sort_order above 9000
// so they no longer compete with regular issue #1 for thumbnail source
try {
  db.prepare(`
    UPDATE scanned_books SET sort_order = 9000 + sort_order
    WHERE is_special = 1 AND sort_order < 9000
  `).run();
} catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    era TEXT,
    publisher TEXT,
    cover_series_id TEXT,
    condition_group TEXT,
    collection_type TEXT DEFAULT 'manual',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS collection_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id TEXT NOT NULL,
    rule_type TEXT NOT NULL,
    rule_value TEXT NOT NULL,
    FOREIGN KEY (collection_id) REFERENCES collections(id)
  );
  CREATE TABLE IF NOT EXISTS series_user_tags (
    series_id  TEXT NOT NULL,
    tag        TEXT NOT NULL,
    created_by TEXT,
    PRIMARY KEY (series_id, tag)
  );
  CREATE TABLE IF NOT EXISTS series_ratings (
    series_id   TEXT PRIMARY KEY,
    cbr_score   REAL,
    cbr_count   INTEGER,
    cbr_url     TEXT,
    fetched_at  TEXT
  );
  CREATE TABLE IF NOT EXISTS award_data (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    award       TEXT NOT NULL,
    year        INTEGER NOT NULL,
    category    TEXT NOT NULL,
    series_name TEXT NOT NULL,
    publisher   TEXT,
    winner      INTEGER DEFAULT 0,
    UNIQUE(award, year, category, series_name)
  );
  CREATE TABLE IF NOT EXISTS collection_series (
    collection_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    manually_added INTEGER DEFAULT 0,
    PRIMARY KEY (collection_id, series_id)
  );
  CREATE TABLE IF NOT EXISTS series_json_cache (
    series_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    cached_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS cv_character_cache (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    image_url TEXT,
    cv_id INTEGER,
    cached_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
// award_data columns added after the table first shipped. The ALTERs near the top
// of the file run before this CREATE on a brand-new database (and silently fail),
// so repeat them here — idempotent on existing databases.
try { db.prepare('ALTER TABLE award_data ADD COLUMN cv_volume_id TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE award_data ADD COLUMN cv_issue_id TEXT').run(); } catch {}

// ─── Library scanner schema ───────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS libraries (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL UNIQUE,
    icon       TEXT,
    color      TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS scanned_series (
    id                   TEXT PRIMARY KEY,
    library_id           TEXT NOT NULL,
    path                 TEXT NOT NULL UNIQUE,
    name                 TEXT,
    year                 INTEGER,
    metadata_status      TEXT DEFAULT 'none',
    series_json          TEXT,
    monitored_series_id  TEXT,
    book_count           INTEGER DEFAULT 0,
    last_scanned         DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (library_id) REFERENCES libraries(id)
  );

  CREATE TABLE IF NOT EXISTS scanned_books (
    id                  TEXT PRIMARY KEY,
    series_id           TEXT NOT NULL,
    path                TEXT NOT NULL UNIQUE,
    filename            TEXT NOT NULL,
    issue_number        TEXT,
    title               TEXT,
    comicinfo           TEXT,
    monitored_issue_id  TEXT,
    sort_order          REAL DEFAULT 0,
    last_scanned        DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (series_id) REFERENCES scanned_series(id)
  );

  CREATE TABLE IF NOT EXISTS read_progress (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id     TEXT NOT NULL,
    user_id     TEXT,
    page        INTEGER DEFAULT 0,
    completed   INTEGER DEFAULT 0,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    marked      INTEGER DEFAULT 0
  );
`);

// ─── Auth schema ──────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    username     TEXT UNIQUE NOT NULL,
    email        TEXT UNIQUE,
    password_hash TEXT,
    role         TEXT NOT NULL DEFAULT 'user',
    authentik_id TEXT UNIQUE,
    created_at   TEXT DEFAULT (datetime('now')),
    last_login   TEXT
  );
  CREATE TABLE IF NOT EXISTS user_favorites (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   TEXT NOT NULL,
    series_id TEXT NOT NULL,
    added_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, series_id)
  );
  CREATE TABLE IF NOT EXISTS dismissed_continue_reading (
    user_id      TEXT NOT NULL,
    series_id    TEXT NOT NULL,
    dismissed_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, series_id)
  );
`);

// Add user_id to read_progress (safe migration — ignored if column exists)
try { db.prepare('ALTER TABLE read_progress ADD COLUMN user_id TEXT').run(); } catch {}
// Re-create unique constraint to be per-user (drop old unique index first if exists)
try {
  db.prepare('DROP INDEX IF EXISTS read_progress_book_id').run();
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS rp_user_book ON read_progress(user_id, book_id)');
} catch {}
// marked = 1: marked read in bulk (read history filled in by hand), not read in
// the reader. Continue Reading counts only real reading as activity. Rows the
// bulk endpoints created before this column carry their placeholder page 999.
try { db.prepare('ALTER TABLE read_progress ADD COLUMN marked INTEGER DEFAULT 0').run(); } catch {}
try { db.prepare("UPDATE read_progress SET marked = 1 WHERE completed = 1 AND page = 999 AND COALESCE(marked, 0) = 0").run(); } catch {}
// Fresh installs before 2026-11-11 created read_progress with UNIQUE(book_id), so a second reader
// could not save progress on a book another reader had opened ("UNIQUE constraint failed:
// read_progress.book_id"). Older installs had already been rebuilt without it. Rebuild once, keeping
// every row; progress is unique per reader through rp_user_book.
try {
  const rpSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'read_progress'").get()?.sql || '';
  if (/UNIQUE\s*\(\s*book_id\s*\)/i.test(rpSql)) {
    const have = db.prepare('PRAGMA table_info(read_progress)').all().map(c => c.name);
    const cols = ['id', 'book_id', 'user_id', 'page', 'completed', 'updated_at', 'marked', 'context'].filter(c => have.includes(c));
    db.transaction(() => {
      db.exec('ALTER TABLE read_progress RENAME TO read_progress_rebuild');
      db.exec(`CREATE TABLE read_progress (id INTEGER PRIMARY KEY AUTOINCREMENT, book_id TEXT NOT NULL, user_id TEXT, page INTEGER DEFAULT 0,
        completed INTEGER DEFAULT 0, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, marked INTEGER DEFAULT 0${have.includes('context') ? ', context TEXT' : ''})`);
      db.exec(`INSERT INTO read_progress (${cols.join(', ')}) SELECT ${cols.join(', ')} FROM read_progress_rebuild`);
      db.exec('DROP TABLE read_progress_rebuild');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS rp_user_book ON read_progress(user_id, book_id)');
    })();
    logger.info('schema', 'read_progress rebuilt without the one-reader-per-book limit', { columns: cols });
  }
} catch (e) { logger.error('schema', 'read_progress rebuild failed', e.message); }

// ─── Download retry / blacklist schema ────────────────────────────
// download_url: the URL we actually sent to SABnzbd or DDL — needed to blacklist on failure
// fail_count:   how many sources have been tried and failed (caps at 6)
// last_fail_reason: human-readable reason stored for the Failed tab UI
function applyMonitoredIssueRetryColumns() {
  // Runs here for existing databases and again after monitored_issues is created
  // (on a brand-new database this point comes before that CREATE).
  const hasTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'monitored_issues'").get();
  if (!hasTable) return;
  [
    'ALTER TABLE monitored_issues ADD COLUMN download_url TEXT',
    'ALTER TABLE monitored_issues ADD COLUMN fail_count INTEGER DEFAULT 0',
    'ALTER TABLE monitored_issues ADD COLUMN last_fail_reason TEXT',
    // retry_after:    don't search again before this time (download host rate limit)
    // retry_epoch:    attempts are counted from here (set by the weekly failed-issue retry)
    // weekly_retries: how many weekly retries a failed issue has had
    'ALTER TABLE monitored_issues ADD COLUMN retry_after TEXT',
    'ALTER TABLE monitored_issues ADD COLUMN retry_epoch TEXT',
    'ALTER TABLE monitored_issues ADD COLUMN weekly_retries INTEGER DEFAULT 0',
    // failed_at: when the issue last became failed (set by the trigger below,
    // so every failure path records it). Shown in the Download Manager Queue tab.
    'ALTER TABLE monitored_issues ADD COLUMN failed_at TEXT',
  ].forEach(sql => { try { db.prepare(sql).run(); } catch {} });
  try {
    db.exec(`CREATE TRIGGER IF NOT EXISTS mi_failed_at AFTER UPDATE OF status ON monitored_issues
             WHEN NEW.status = 'failed' AND (OLD.status IS NULL OR OLD.status != 'failed')
             BEGIN UPDATE monitored_issues SET failed_at = datetime('now') WHERE id = NEW.id; END;`);
  } catch (e) { console.error('failed_at trigger', e.message); }
}
applyMonitoredIssueRetryColumns();
// GetComics downloads and their queue live in memory. After a restart, any
// issue still 'snatched' via GetComics has nothing downloading it; put it back
// to wanted so the next scan picks it up (it used to stay stuck).
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'monitored_issues'").get()) try {
  const { changes } = db.prepare(`UPDATE monitored_issues SET status = 'wanted', download_id = NULL, file_path = NULL,
                                  last_fail_reason = 'Server restarted during download' WHERE status = 'snatched' AND download_id = 'ddl'`).run();
  if (changes) console.log(`[startup] ${changes} interrupted GetComics download(s) returned to wanted`);
} catch (e) { console.error('ddl startup recovery', e.message); }

db.exec(`
  CREATE TABLE IF NOT EXISTS download_blacklist (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id   TEXT    NOT NULL,
    url        TEXT    NOT NULL,
    reason     TEXT,
    failed_at  TEXT    DEFAULT (datetime('now')),
    UNIQUE(issue_id, url)
  );
  CREATE INDEX IF NOT EXISTS bl_issue ON download_blacklist(issue_id);
`);

// ─── Auth helpers ─────────────────────────────────────────────────

// JWT — HS256 using built-in crypto (no jsonwebtoken dependency)
authSecurity.initializeAuthSchema(db);
const authTokens = authSecurity.createTokens({ db, secret: JWT_SECRET, expiresDays: JWT_EXPIRES_DAYS });
const oidcState = authSecurity.createOidcState();
function jwtSign(payload) { return authTokens.sign(payload); }
function jwtVerify(token) { return authTokens.verify(token); }

// Password hashing — scrypt using built-in crypto
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await new Promise((res, rej) =>
    crypto.scrypt(password, salt, 64, (err, key) => err ? rej(err) : res(key.toString('hex')))
  );
  return `${salt}:${hash}`;
}

async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const derived = await new Promise((res, rej) =>
    crypto.scrypt(password, salt, 64, (err, key) => err ? rej(err) : res(key.toString('hex')))
  );
  try {
    return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
  } catch { return false; }
}

// Auto-create first admin user if users table is empty
(async () => {
  const count = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  if (count === 0) {
    const id   = crypto.randomUUID();
    const hash = await hashPassword('admin');
    db.prepare(`INSERT INTO users (id, username, email, password_hash, role)
                VALUES (?, 'admin', 'admin@localhost', ?, 'admin')`).run(id, hash);
    logger.info('auth', 'Created default admin user', { username: 'admin', password: 'admin' });
    logger.warn('auth', '⚠️  Change the default admin password immediately via Settings › People');
  }
})();

// ─── Auth middleware ───────────────────────────────────────────────

// EventSource (server-sent event streams) can't send an Authorization header,
// so those requests may pass the token as ?token=. Only accepted for streams.
function requestToken(req) {
  const header = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (header) return header;
  if ((req.headers.accept || '').includes('text/event-stream') && req.query?.token) return String(req.query.token);
  return '';
}

function requireAuth(req, res, next) {
  try {
    const token = requestToken(req);
    req.user = jwtVerify(token);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorised' });
  }
}

function requireAdmin(req, res, next) {
  try {
    const token = requestToken(req);
    const user  = jwtVerify(token);
    if (user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorised' });
  }
}

// Download Manager functions: any logged-in user, unless Settings has
// "download manager admin only" on, in which case admin only.
function requireDownloadAccess(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user?.role === 'admin') return next();
    if (getSetting('download_manager_admin_only') === 'true') return res.status(403).json({ error: 'Downloads are limited to the admin' });
    next();
  });
}

// Apply auth to all /api routes EXCEPT auth endpoints and media routes.
// img src / browser-native requests cannot send Authorization headers.
// Only images (which the browser loads without headers) and the login routes
// are public. Previously whole /series/, /books/, /collections/ and /debug/
// prefixes were public, which exposed editing routes to anyone.
const PUBLIC_API_PREFIXES = ['/auth/', '/health'];
const PUBLIC_MEDIA_GETS = [
  /^\/series\/[^/]+\/thumbnail$/,        // series covers
  /^\/books\/[^/]+\/thumbnail$/,         // issue covers
  /^\/collections\/[^/]+\/cover$/,       // box covers
  /^\/assistant\/avatar$/,               // assistant avatar (img src)
];
const ADMIN_API_PREFIXES = ['/debug/', '/admin/', '/import/'];
app.use('/api', (req, res, next) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && readerSecurity.READER_IMAGE.test(req.path)) return readerSecurity.protectReader(req, res, next, authTokens);
  if (PUBLIC_API_PREFIXES.some(p => req.path.startsWith(p))) return next();
  if ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC_MEDIA_GETS.some(r => r.test(req.path))) return next();
  // Match Express's default case-insensitive routing so mixed-case URLs cannot bypass the admin gate.
  if (ADMIN_API_PREFIXES.some(p => req.path.toLowerCase().startsWith(p))) return requireAdmin(req, res, next);
  requireAuth(req, res, next);
});
db.exec(`
  CREATE TABLE IF NOT EXISTS monitored_series (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    publisher     TEXT,
    year          INTEGER,
    total_issues  INTEGER DEFAULT 0,
    have_issues   INTEGER DEFAULT 0,
    status        TEXT DEFAULT 'active',
    directory     TEXT NOT NULL,
    image_url     TEXT,
    cv_url        TEXT,
    last_cv_check TEXT,
    date_added    TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS monitored_issues (
    id              TEXT PRIMARY KEY,
    series_id       TEXT NOT NULL,
    issue_number    TEXT NOT NULL,
    title           TEXT,
    release_date    TEXT,
    store_date      TEXT,
    status          TEXT DEFAULT 'wanted',
    file_path       TEXT,
    download_id     TEXT,
    cv_data         TEXT,
    date_added      TEXT DEFAULT (datetime('now')),
    date_processed  TEXT,
    FOREIGN KEY (series_id) REFERENCES monitored_series(id)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS series_packs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id   TEXT NOT NULL,
    download_id TEXT,
    file_path   TEXT,
    status      TEXT DEFAULT 'snatched',  -- snatched | downloaded | processing | processed | failed
    grabbed_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (series_id) REFERENCES monitored_series(id)
  );
`);
applyMonitoredIssueRetryColumns();
// fail_reason: why the last processing attempt failed (LIBRARY_RECOVERY_REQUIRED
// packs are re-queued automatically once the metadata hold clears).
// retry_after: a pack paused by the Comic Vine limit waits until then (UTC
// 'YYYY-MM-DD HH:MM:SS', same as monitored_issues.retry_after).
for (const sql of ['ALTER TABLE series_packs ADD COLUMN fail_reason TEXT', 'ALTER TABLE series_packs ADD COLUMN failed_at TEXT',
  'ALTER TABLE series_packs ADD COLUMN retry_after TEXT']) {
  try { db.exec(sql); } catch {}
}
const CV_WAIT_REASON = 'Comic Vine hourly limit';
// Processing a finished download is "arrival" work: its Comic Vine calls get
// the high cap (CV_CAP_ARRIVAL), ahead of backfill.
const asArrival = (caller, fn) => cvCtx.run({ lane: 'arrival', caller }, fn);
const sqlTime = ms => new Date(ms || Date.now() + 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

// A pack still in flight for a series (or for the parent of an annual series).
// Its issues stay 'wanted' until processed, so this is what marks them
// covered: the wanted scan skips them and the Download Manager shows
// SNATCHED (pack downloading) or WAITING (downloaded, not yet processed).
const ACTIVE_PACK_SQL = `SELECT p.status, p.retry_after, p.fail_reason FROM series_packs p
  WHERE p.status IN ('snatched', 'downloaded', 'processing')
    AND (p.series_id = ? OR p.series_id IN (SELECT parent_series_id FROM series_annual_links WHERE annual_series_id = ?))
  ORDER BY CASE p.status WHEN 'processing' THEN 0 WHEN 'downloaded' THEN 1 ELSE 2 END, p.id DESC LIMIT 1`;
function activePackFor(seriesId) {
  try { return db.prepare(ACTIVE_PACK_SQL).get(String(seriesId), String(seriesId)) || null; } catch { return null; }
}
// Issue row → { waiting } / { in_pack } for the Download Manager badges.
function annotateWaiting(issue, pack) {
  if (issue.status === 'downloaded') {
    issue.waiting = { reason: issue.last_fail_reason || 'Downloaded; waiting to be processed', until: issue.retry_after || null };
  } else if ((issue.status === 'wanted' || issue.status === 'snatched') && pack) {
    if (pack.status === 'snatched') issue.in_pack = 'downloading';
    else issue.waiting = { reason: pack.retry_after ? (pack.fail_reason || CV_WAIT_REASON) : 'In a downloaded pack; waiting to be processed',
      until: pack.retry_after || null, pack: true };
  }
  return issue;
}

// ─── Events tables ───────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    publisher    TEXT,
    year         INTEGER,
    cv_story_arc_id TEXT,
    description  TEXT,
    cover_image  TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS event_issues (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    cv_issue_id     TEXT,
    scanned_book_id TEXT,
    sort_order      INTEGER NOT NULL,
    tier            TEXT DEFAULT 'recommended',
    tier_note       TEXT,
    series_name     TEXT NOT NULL,
    issue_number    TEXT NOT NULL,
    issue_title     TEXT
  );
`);
// Safe migrations for any missed columns
['cv_issue_id','scanned_book_id','tier_note','issue_title','volume_year'].forEach(col => {
  try { db.prepare(`ALTER TABLE event_issues ADD COLUMN ${col} TEXT`).run(); } catch {}
});
// manually_matched: set to 1 when admin uses the manual match button — protects from reconciler invalidation
try { db.prepare(`ALTER TABLE event_issues ADD COLUMN manually_matched INTEGER DEFAULT 0`).run(); } catch {}
try { db.prepare(`ALTER TABLE publisher_eras ADD COLUMN folder TEXT`).run(); } catch {}
try { db.prepare(`ALTER TABLE events ADD COLUMN source TEXT DEFAULT 'auto'`).run(); } catch {}
require('./eventDrafts').ensure(db);   // events.draft: imported events stay hidden until published (2026-11-12)
// Event generator v2 (2026-10-20): which sites list each issue (JSON array of codes), why it was
// moved from release order, a release-position flag, and per event the pages read and the issues
// left out (JSON). Admin-only, behind "Show sources"; GET /api/events/:id leaves them out.
['sources', 'order_note', 'order_flag', 'tier_reason'].forEach(col => {
  try { db.prepare(`ALTER TABLE event_issues ADD COLUMN ${col} TEXT`).run(); } catch {}
});
try { db.prepare(`ALTER TABLE events ADD COLUMN generator_sources TEXT`).run(); } catch {}
const EVENT_ADMIN_ONLY = ['sources', 'order_note', 'order_flag', 'tier_reason'];
try { db.prepare(`ALTER TABLE series_ratings ADD COLUMN user_score REAL`).run(); } catch {}
try { db.prepare(`ALTER TABLE series_ratings ADD COLUMN user_count INTEGER`).run(); } catch {}

// Publisher/era/imprint configuration table
db.prepare(`
  CREATE TABLE IF NOT EXISTS publisher_config (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    publisher   TEXT NOT NULL,
    use_folder_detection INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  )
`).run();
db.prepare(`
  CREATE TABLE IF NOT EXISTS publisher_eras (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    publisher_id INTEGER NOT NULL REFERENCES publisher_config(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    start_year   INTEGER,
    end_year     INTEGER,
    sort_order   INTEGER DEFAULT 0
  )
`).run();
db.prepare(`
  CREATE TABLE IF NOT EXISTS publisher_imprints (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    publisher_id INTEGER NOT NULL REFERENCES publisher_config(id) ON DELETE CASCADE,
    pattern      TEXT NOT NULL,
    name         TEXT NOT NULL
  )
`).run();
db.prepare(`
  CREATE TABLE IF NOT EXISTS publisher_skip_patterns (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    publisher_id INTEGER NOT NULL REFERENCES publisher_config(id) ON DELETE CASCADE,
    pattern      TEXT NOT NULL
  )
`).run();

// Default settings (only inserted if not already present)
const defaultSettings = {
  prowlarr_url:               '',
  prowlarr_api_key:           '',
  sabnzbd_url:                '',
  sabnzbd_api_key:            '',
  sabnzbd_category:           'comics',
  sabnzbd_completed_path:     '/downloads',
  qbittorrent_url:            '',
  qbittorrent_username:       'admin',
  qbittorrent_password:       '',
  // Manga torrent settings — used when adding via Nyaa for series_type='manga'.
  qbittorrent_category:       'manga',
  qbittorrent_savepath:       '',   // host path sent to qBittorrent (e.g. D:\Downloads\omnibus-manga)
  torrent_completed_path:     '/downloads/torrents', // container path manga-pp scans
  // Comic torrent settings — used when adding via Prowlarr for series_type='comic'.
  // Symmetric to the manga settings above but routed by series_type at add time
  // so comic torrents land in their own qBit category and can use the same
  // completed_path as SAB if desired (the comic torrent watcher tracks by qBit
  // hash, not by directory scan, so there's no collision risk with SAB jobs).
  qbittorrent_comic_category:       'comics',
  qbittorrent_comic_savepath:       '',   // host path for comic torrents (e.g. D:\Downloads\omnibus)
  qbittorrent_comic_completed_path: '/downloads/omnibus', // container path Omnibus reads completed torrents from
  ddl_download_path:          '/downloads/getcomics', // container path for GetComics DDL files
  downloads_path:             '/downloads',
  cv_poll_interval_days:      '7',
  file_format:                '$Series $Issue ($Year)',
  folder_format:              '$Series ($Year)',
  cv_api_key:                 '',
  metron_api_token:           '',
  anthropic_api_key:          '',
  openai_api_key:             '',
  gemini_api_key:             '',   // Google Gemini: web lookups only (2026-10-20)
  download_manager_admin_only: 'false',
  // Weekly release tab — publishers to hide entirely (JSON array of substrings, case-insensitive)
  weekly_excluded_publishers: JSON.stringify([
    'Panini', 'Webtoon', 'Hachette', 'Editorial Televisa',
    'Planeta DeAgostini', 'Comicraze', 'Japonica Polonica',
  ]),
};
// INSERT OR IGNORE — never overwrite values the user has saved via the Settings UI
const insertSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
Object.entries(defaultSettings).forEach(([k, v]) => insertSetting.run(k, v));

// Helper: get a setting value from DB (falls back to default)
// API keys and passwords are stored encrypted when OMNIBUS_SECRET is set (secrets.js, 2026-11-02).
const secrets = require('./secrets').create({ logger });
try { const n = secrets.sealStored(db); if (n) logger.info('secrets', `Encrypted ${n} stored API key(s)`); }
catch (e) { logger.error('secrets', 'Could not encrypt stored keys', e.message); }
if (!process.env.OMNIBUS_SECRET) logger.warn('secrets', 'OMNIBUS_SECRET is not set: API keys are stored unencrypted. deploy.ps1 adds one to .env.');
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return defaultSettings[key] || null;
  return secrets.isSecret(key) ? secrets.open(row.value, key) : row.value;
}

// ─── Runtime key/model helpers (DB value takes priority over env) ──
function getCVKey()         { return getSetting('cv_api_key')                 || process.env.CV_API_KEY         || ''; }

// ─── Comic Vine gateway (shared rate-limit pool) ──────────────────
// Every Comic Vine request goes through cvApiGet, including the Python
// enricher (scripts/enricher.py reads and writes the same tables). Comic Vine
// allows 200 requests per resource (issue, issues, volume, search …) per hour
// and also blocks clients that send too fast. The gateway:
//   • spaces all requests at least CV_MIN_SPACING_MS apart, and background
//     requests at least CV_BG_SPACING_MS after the previous request;
//   • counts requests per resource the way Comic Vine does: an hour-long
//     window that starts at the first request after the previous window ended
//     and then resets to 0 (cv_windows). Background work stops at
//     CV_CAP_BACKGROUND, processing downloads at CV_CAP_ARRIVAL and clicks
//     at CV_CAP_INTERACTIVE. (Until
//     2026-10-08 this was a rolling 60-minute count, which held back requests
//     Comic Vine would allow right after its reset.)
//   • pauses one resource for 60 min when Comic Vine refuses it (cv_backoff);
//   • records who made each request; the log keeps 2 hours (enough for the
//     rolling hour) and is shown on the Comic Vine admin page.
// "Interactive" = anything started by a web request (a click); scheduled jobs
// and timers are "background". Callers get err.code = 'CV_RATE_LIMIT'.
const { AsyncLocalStorage } = require('async_hooks');
const cvCtx = new AsyncLocalStorage();
const CV_LIMIT_PER_HOUR   = 200;
const CV_CAP_INTERACTIVE  = 195;
// Processing finished downloads ("arrival": single issues and packs) may use
// nearly the whole hour; backfill (retag sweeps, metadata routine, discovery,
// refreshes) stops at 120 so at least 75 calls an hour stay free for arrivals.
const CV_CAP_ARRIVAL      = 195;
const CV_CAP_BACKGROUND   = 120;
const CV_CAP_ROUTINE      = 120;
const CV_MIN_SPACING_MS   = 1000;
// Background jobs go slower: on 2026-10-09 Comic Vine refused /issue (HTTP 420)
// 51 requests into the 05:30 backlog run at ~1 s spacing, well under the hourly
// limit — likely its undocumented speed check. Clicks keep 1 s.
const CV_BG_SPACING_MS    = 2000;
const CV_WINDOW_MS        = 60 * 60 * 1000;
const CV_BACKOFF_MS       = 60 * 60 * 1000;
const CV_LOG_KEEP_MS      = 2 * 60 * 60 * 1000;
db.exec(`
  CREATE TABLE IF NOT EXISTS cv_api_log (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,            -- ms since epoch, when the request was sent
    resource TEXT    NOT NULL,            -- first path segment after /api/
    lane     TEXT    NOT NULL,            -- interactive | background
    caller   TEXT,
    status   TEXT    DEFAULT 'pending',   -- HTTP status, 'refused', 'error'
    ms       INTEGER
  );
  CREATE INDEX IF NOT EXISTS cv_api_log_res_ts ON cv_api_log(resource, ts);
  CREATE TABLE IF NOT EXISTS cv_windows (
    resource TEXT PRIMARY KEY,
    start    INTEGER NOT NULL             -- ms; the window ends at start + 1 hour
  );
  CREATE TABLE IF NOT EXISTS cv_backoff (
    resource TEXT PRIMARY KEY,
    until    INTEGER NOT NULL,
    reason   TEXT
  );
`);
const CV_RATE_STATUSES = new Set([420, 429]);
let cvNextSlot = 0;
const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

function cvResourceOf(url) {
  const m = String(url).match(/comicvine\.gamespot\.com\/api\/([a-z_]+)/i);
  return m ? m[1].toLowerCase() : 'unknown';
}
function cvCallerFromStack() {
  const lines = String(new Error().stack || '').split('\n').slice(1);
  for (const l of lines) {
    const m = l.match(/at (?:async )?([A-Za-z0-9_$.]+) \(/);
    if (!m) continue;
    const fn = m[1];
    if (/^(cvApiGet|cvCallerFromStack|Object\.<anonymous>|process\.|new Promise|Promise\.|Layer\.|next|Route\.|Function\.)/.test(fn)) continue;
    if (fn === 'cvGet' || fn === 'cvFetch') continue;   // local wrappers inside callers
    return fn;
  }
  return null;
}
function cvRateLimitError(message, retryAt) {
  const err = new Error(message || 'Comic Vine rate limit reached');
  err.code = 'CV_RATE_LIMIT';
  if (retryAt) err.retryAt = retryAt;
  return err;
}
function cvSetBackoff(resource, reason) {
  const until = Date.now() + CV_BACKOFF_MS;
  db.prepare(`INSERT INTO cv_backoff (resource, until, reason) VALUES (?, ?, ?)
              ON CONFLICT(resource) DO UPDATE SET until = excluded.until, reason = excluded.reason`).run(resource, until, reason);
  logger.warn('cv', `Comic Vine refused '${resource}' requests (${reason}) — pausing that resource for 60 min`);
}
// Current Comic Vine window for a resource: { start, resetAt, used }.
// Read-only unless open=true, which starts a new window when none is active
// (called just before sending a request, so the window begins at that request).
function cvWindow(resource, now = Date.now(), { open = false } = {}) {
  let row = db.prepare('SELECT start FROM cv_windows WHERE resource = ?').get(resource);
  if (!row) {
    // No record (first run after this change): treat the earliest request in
    // the last hour as the window start.
    const first = db.prepare(`SELECT MIN(ts) AS t FROM cv_api_log WHERE resource = ? AND ts > ?`).get(resource, now - CV_WINDOW_MS)?.t;
    if (first) { db.prepare('INSERT OR REPLACE INTO cv_windows (resource, start) VALUES (?, ?)').run(resource, first); row = { start: first }; }
  }
  if (!row || now >= row.start + CV_WINDOW_MS) {
    if (!open) return { start: null, resetAt: null, used: 0 };
    db.prepare('INSERT OR REPLACE INTO cv_windows (resource, start) VALUES (?, ?)').run(resource, now);
    row = { start: now };
  }
  const used = db.prepare(`SELECT COUNT(*) AS n FROM cv_api_log WHERE resource = ? AND ts >= ?`).get(resource, row.start).n;
  return { start: row.start, resetAt: row.start + CV_WINDOW_MS, used };
}

// Comic Vine's terms suggest caching responses so duplicate requests don't
// count against the limit. Identical GETs (same URL and parameters) within
// CV_CACHE_TTL_MS are answered from memory and not sent or counted.
const CV_CACHE_TTL_MS = 10 * 60 * 1000;
const CV_CACHE_MAX    = 500;
const cvCache = new Map();               // key → { at, response }
const cvCacheStats = { hits: 0, since: Date.now() };
function cvCacheKey(url, params = {}) {
  const p = Object.keys(params).filter(k => k !== 'api_key').sort().map(k => `${k}=${params[k]}`).join('&');
  return `${url}?${p}`;
}

async function cvApiGet(url, config = {}) {
  const resource = cvResourceOf(url);
  const cacheKey = cvCacheKey(url, config.params);
  const cached = cvCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CV_CACHE_TTL_MS) { cvCacheStats.hits++; return structuredClone(cached.response); }   // a copy: callers may modify results
  const ctx = cvCtx.getStore() || {};
  const lane = ctx.lane || 'background';
  const fn = cvCallerFromStack();
  const caller = [ctx.caller || (lane === 'interactive' ? 'request' : lane), fn].filter(Boolean).join(' › ');

  // 1. Resource paused after a refusal?
  const bo = db.prepare('SELECT until, reason FROM cv_backoff WHERE resource = ?').get(resource);
  if (bo && bo.until > Date.now()) {
    const mins = Math.ceil((bo.until - Date.now()) / 60000);
    throw cvRateLimitError(`Comic Vine '${resource}' requests are paused for ${mins} more min after a rate-limit refusal`, bo.until);
  }

  if(ctx.metadataRoutine){
    // All callers spend the same pool. Spread routine requests to each resource
    // over the hour, rather than consuming its allowance in a short burst.
    await require('./metadata/routinePacing').waitForRoutineSlot({readLast:()=>db.prepare('SELECT MAX(ts) AS t FROM cv_api_log WHERE resource=?').get(resource)?.t, sleep:sleepMs});
  }
  // 2. Spacing: take the next 1-second slot (shared with the enricher via the log).
  const lastRow = db.prepare('SELECT MAX(ts) AS t FROM cv_api_log').get();
  const now0 = Date.now();
  const gap = lane === 'interactive' ? CV_MIN_SPACING_MS : CV_BG_SPACING_MS;   // arrivals keep the 2 s background spacing
  const at = Math.max(now0, cvNextSlot, (lastRow?.t || 0) + gap);
  cvNextSlot = at + CV_MIN_SPACING_MS;
  if (at > now0) await sleepMs(at - now0);

  // 3. Hourly budget for this resource (Comic Vine-style window).
  const cap = ctx.metadataRoutine ? CV_CAP_ROUTINE : lane === 'interactive' ? CV_CAP_INTERACTIVE : lane === 'arrival' ? CV_CAP_ARRIVAL : CV_CAP_BACKGROUND;
  const now = Date.now();
  const win = cvWindow(resource, now, { open: true });
  if (win.used >= cap) {
    const mins = Math.max(1, Math.ceil((win.resetAt - now) / 60000));
    throw cvRateLimitError(`Comic Vine hourly limit for '${resource}' reached (${win.used}/${CV_LIMIT_PER_HOUR}, ${lane} cap ${cap}) — resets in ${mins} min`, win.resetAt);
  }

  // 4. Send and record.
  const { lastInsertRowid: logId } = db.prepare(
    'INSERT INTO cv_api_log (ts, resource, lane, caller) VALUES (?, ?, ?, ?)').run(now, resource, lane, caller.slice(0, 200));
  const finish = (status) => {
    try { db.prepare('UPDATE cv_api_log SET status = ?, ms = ? WHERE id = ?').run(String(status), Date.now() - now, logId); } catch {}
  };
  let r;
  try {
    r = await axios.get(url, { headers: { 'User-Agent': 'Omnibus/1.0' }, ...config });
  } catch (e) {
    const st = e.response?.status;
    if (CV_RATE_STATUSES.has(st)) {
      finish('refused');
      cvSetBackoff(resource, `HTTP ${st}`);
      throw cvRateLimitError(`Comic Vine refused '${resource}' requests (HTTP ${st}) — paused for 60 min`, Date.now() + CV_BACKOFF_MS);
    }
    finish(st || 'error');
    throw e;
  }
  if (r.data?.status_code === 107) {
    finish('refused');
    cvSetBackoff(resource, 'status_code 107');
    throw cvRateLimitError(`Comic Vine refused '${resource}' requests (rate limit) — paused for 60 min`, Date.now() + CV_BACKOFF_MS);
  }
  finish(r.status);
  if (r.data?.status_code === 1) {
    cvCache.set(cacheKey, { at: Date.now(), response: structuredClone({ status: r.status, data: r.data }) });
    if (cvCache.size > CV_CACHE_MAX) cvCache.delete(cvCache.keys().next().value);   // drop the oldest
  }
  return r;
}

// Tag every web request so its Comic Vine calls count as interactive.
app.use((req, res, next) => {
  const p = req.path.replace(/\/[0-9a-f]{12,}(?=\/|$)/gi, '/:id').replace(/\/(?:ss_|sb_)?[0-9a-z_-]*\d[0-9a-z_-]*(?=\/|$)/gi, '/:id');
  cvCtx.run({ lane: 'interactive', caller: `${req.method} ${p}` }, next);
});

// Scheduled jobs are background work; name them for the usage panel.
const CRON_JOB_NAMES = {
  '0 3 * * 2': 'cv-poller', '45 3 * * 2': 'annual-discovery', '15 4 * * *': 'retag-recent',
  '30 5 * * *': 'retag-backlog', '45 4 * * *': 'series-json-refresh', '30 9 * * *': 'db-backup',
  '0 */6 * * *': 'wanted-scan', '0 */3 * * *': 'locg-resolve', '0 8 * * *': 'week-refresh',
  '0 4 1 * *': 'series-status', '30 3 1 * *': 'blacklist-cleanup', '20 0-3,7-23 * * *': 'untagged-sweep',
};
{
  const origSchedule = cron.schedule.bind(cron);
  cron.schedule = (expr, fn, opts) => {
    const name = CRON_JOB_NAMES[expr] || (/^50 5 /.test(expr) ? 'failed-retry' : `cron ${expr}`);
    return origSchedule(expr, (...a) => cvCtx.run({ lane: 'background', caller: name }, () => fn(...a)), opts);
  };
}

// Keep 2 hours of log; drop expired pauses.
setInterval(() => {
  try {
    db.prepare('DELETE FROM cv_api_log WHERE ts < ?').run(Date.now() - CV_LOG_KEEP_MS);
    db.prepare('DELETE FROM cv_backoff WHERE until < ?').run(Date.now());
    db.prepare('DELETE FROM cv_windows WHERE start < ?').run(Date.now() - CV_LOG_KEEP_MS);
  } catch (e) { logger.warn('cv', 'cv_api_log prune failed', e.message); }
}, 10 * 60 * 1000);

// Usage panel (Comic Vine admin page).
app.get('/api/admin/cv-usage', requireAdmin, (req, res) => {
  const now = Date.now();
  const since = now - CV_WINDOW_MS;
  // Per resource: the current Comic Vine window (count since it started, when it resets).
  const resNames = db.prepare(`SELECT DISTINCT resource FROM cv_api_log WHERE ts > ?`).all(since).map(r => r.resource);
  const rows = resNames.map(resource => {
    const w = cvWindow(resource, now);
    if (!w.start) return null;
    const r = db.prepare(`SELECT COUNT(*) AS used, SUM(lane = 'interactive') AS interactive, SUM(lane = 'background') AS background, SUM(lane = 'arrival') AS arrival,
                            SUM(status = 'refused') AS refused, SUM(status NOT IN ('200','refused','pending')) AS errors
                          FROM cv_api_log WHERE resource = ? AND ts >= ?`).get(resource, w.start);
    return { resource, ...r, windowStart: w.start, resetAt: w.resetAt };
  }).filter(Boolean).sort((a, b) => b.used - a.used);
  const backoffs = db.prepare('SELECT resource, until, reason FROM cv_backoff WHERE until > ?').all(now);
  const boMap = Object.fromEntries(backoffs.map(b => [b.resource, b]));
  const resources = rows.map(r => ({
    ...r,
    nextFreeAt: r.resetAt,
    pausedUntil: boMap[r.resource]?.until || null, pauseReason: boMap[r.resource]?.reason || null,
  }));
  for (const b of backoffs) if (!rows.find(r => r.resource === b.resource)) {
    resources.push({ resource: b.resource, used: 0, interactive: 0, background: 0, arrival: 0, refused: 0, errors: 0, nextFreeAt: null, pausedUntil: b.until, pauseReason: b.reason });
  }
  const callers = db.prepare(`SELECT caller, resource, lane, COUNT(*) AS n FROM cv_api_log WHERE ts > ?
                              GROUP BY caller, resource, lane ORDER BY n DESC LIMIT 40`).all(since);
  const recent = db.prepare(`SELECT ts, resource, lane, caller, status, ms FROM cv_api_log ORDER BY id DESC LIMIT 25`).all();
  const refusals = db.prepare(`SELECT ts, resource, caller FROM cv_api_log WHERE status = 'refused' ORDER BY id DESC LIMIT 10`).all();
  res.json({
    limits: { perHour: CV_LIMIT_PER_HOUR, interactive: CV_CAP_INTERACTIVE, background: CV_CAP_BACKGROUND, arrival: CV_CAP_ARRIVAL, spacingMs: CV_MIN_SPACING_MS, bgSpacingMs: CV_BG_SPACING_MS },
    totalLastHour: rows.reduce((a, r) => a + r.used, 0),
    cache: { hits: cvCacheStats.hits, sinceMs: cvCacheStats.since, entries: cvCache.size, ttlMin: CV_CACHE_TTL_MS / 60000 },
    resources, callers, recent, refusals, now,
  });
});


// ─── Comic Vine single-issue fetch ───────────────────────────────
// Shared by download tagging, manual retag and the daily retag rotation.
// CV allows ~200 requests/hour per endpoint. When it refuses (HTTP 420/429, or
// status_code 107 in the body) this throws err.code = 'CV_RATE_LIMIT' and sets
// a 60-minute backoff so other callers stop sending requests that would also
// be refused. Returns the issue object, or null if CV has no record.
const CV_ISSUE_FIELDS = 'id,issue_number,name,cover_date,store_date,site_detail_url,description,person_credits,character_credits,team_credits,location_credits,volume';

// Save a freshly fetched CV issue: cv_data plus store/cover dates (CV dates
// win when present, since they fill in and shift as release approaches).
function saveFreshCvIssue(issueId, fresh, freshJson = JSON.stringify(fresh)) {
  db.prepare(`
    UPDATE monitored_issues
    SET cv_data = ?, store_date = COALESCE(?, store_date), release_date = COALESCE(?, release_date)
    WHERE id = ?
  `).run(freshJson, fresh.store_date || null, fresh.cover_date || null, issueId);
  return freshJson;
}

async function fetchCvIssue(issueId, { timeout = 15000 } = {}) {
  // Rate limits (pause, hourly cap, refusals) are handled by cvApiGet.
  const r = await cvApiGet(`https://comicvine.gamespot.com/api/issue/4000-${issueId}/`, {
    params: { api_key: getCVKey(), format: 'json', field_list: CV_ISSUE_FIELDS },
    timeout,
  });
  const results = r.data?.results;
  if (!results || Array.isArray(results)) return null; // CV returns [] for unknown ids
  return results;
}
function getAnthropicKey()  { return getSetting('anthropic_api_key')          || process.env.ANTHROPIC_API_KEY  || ''; }
function getOpenAIKey()     { return getSetting('openai_api_key')             || process.env.OPENAI_API_KEY     || ''; }
function getGeminiKey()     { return getSetting('gemini_api_key')             || process.env.GEMINI_API_KEY     || ''; }
// AI models: each task has its own recommended model, or the one chosen for it
// (backend/ai/aiModels.js). All requests use the shared client.
const aiModels = require('./ai/aiModels');
const runOrder = require('./runOrder');   // Top Shelf run order (stored order is the reading order)
const canonResolve = require('./canonResolve');   // Auto-resolve: range notes and volume year (2026-10-17)
{
  const rows = aiModels.migrationRows(getSetting);
  if (rows.length) {
    const put = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of rows) put.run(k, v);
    console.log('[ai] Moved model settings to Quick/Generation models', Object.fromEntries(rows));
  }
  const upgrade = aiModels.upgradeRows(getSetting, require('./modelCatalog'));
  if (upgrade.length) {
    const put = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of upgrade) put.run(k, v);
    if (upgrade.length > 1) console.log('[ai] Switched to current models', Object.fromEntries(upgrade));
  }
  // The settings the Quick/Generation models replaced: read only by the one-time move above,
  // so once it has run they are orphans (user 2026-10-19: no duplicate or orphaned settings).
  if ((getSetting(aiModels.TIERS.quick.key) || '').trim() || (getSetting('ai_tiers_retired_2026_10') || '').trim()) db.prepare("DELETE FROM settings WHERE key IN ('anthropic_event_model', 'anthropic_validation_model', 'assistant_model', 'assistant_list_model')").run();
}
// Each task picks its recommended model by which provider keys are saved (aiModels.js).
const hasAiProvider = p => !!({ anthropic: getAnthropicKey, openai: getOpenAIKey, gemini: getGeminiKey }[p] || (() => ''))();
// The two top-level default models are retired (2026-10-23): tasks that followed one keep the model
// they were using when it differs from their recommended model; the two settings are removed.
{
  const { rows, remove } = aiModels.retireTierRows(getSetting, { hasProvider: hasAiProvider });
  if (rows.length) {
    const put = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    db.transaction(() => { for (const [k, v] of rows) put.run(k, v); for (const k of remove) db.prepare('DELETE FROM settings WHERE key = ?').run(k); })();
    if (rows.length > 1) console.log('[ai] Top-level models retired; kept as task models', Object.fromEntries(rows.slice(0, -1)));
  }
}
const aiRouting = aiModels.createModelRouting(getSetting, { hasProvider: hasAiProvider });
// Every AI call (server, Comic Book Guy, enricher) lands in ai_calls for
// Settings → AI Models → Usage. Cost is saved with each call at the prices of the day (2026-10-23),
// so a later price change does not alter past spending.
db.exec(`CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, task TEXT, tier TEXT, provider TEXT, model TEXT,
  source TEXT DEFAULT 'live', ok INTEGER DEFAULT 1, error TEXT, ms INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cache_read INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0, web_searches INTEGER DEFAULT 0);
  CREATE INDEX IF NOT EXISTS ai_calls_at ON ai_calls(at);
  CREATE TABLE IF NOT EXISTS ai_jobs (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, day TEXT NOT NULL, task TEXT, tier TEXT, provider TEXT, model TEXT, source TEXT DEFAULT 'live',
  calls INTEGER DEFAULT 0, failed_calls INTEGER DEFAULT 0, ms INTEGER DEFAULT 0, outcome TEXT, detail TEXT);
  CREATE INDEX IF NOT EXISTS ai_jobs_at ON ai_jobs(at);`);
try { db.prepare('ALTER TABLE ai_calls ADD COLUMN job_id TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE ai_calls ADD COLUMN thinking_tokens INTEGER').run(); } catch {}   // NULL: not measured (before 2026-10-22)
// Runs (2026-10-23): one piece of work someone started (a Comic Book Guy question with its lookups and
// recap summaries, an event build), set by ai.run() in aiClient.js. A call outside a run is its own job.
try { db.prepare('ALTER TABLE ai_calls ADD COLUMN run_id TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE ai_calls ADD COLUMN cost REAL').run(); } catch {}   // dollars, at the prices of the day of the call
// The request that caused the call (aiInfo.js, 2026-11-09): the ⓘ details next to what an admin started.
try { db.prepare('ALTER TABLE ai_calls ADD COLUMN request_id TEXT').run(); } catch {}
db.exec('CREATE INDEX IF NOT EXISTS ai_calls_request ON ai_calls(request_id)');
const aiInfo = require('./aiInfo');
db.exec(`CREATE INDEX IF NOT EXISTS ai_calls_run ON ai_calls(run_id);
  CREATE TABLE IF NOT EXISTS ai_runs (id TEXT PRIMARY KEY, at INTEGER NOT NULL, label TEXT, user_id TEXT);`);
const aiPrices = require('./modelCatalog');
const aiCallCost = row => { try { const c = aiPrices.estimateCost(row.model, row); return Number.isFinite(c) ? c : null; } catch { return null; } };
// One-time: calls logged before costs were saved get today's estimate.
if (!getSetting('ai_calls_cost_saved_2026_10')) {
  try {
    const put = db.prepare('UPDATE ai_calls SET cost = ? WHERE id = ?');
    db.transaction(() => { for (const r of db.prepare('SELECT * FROM ai_calls WHERE cost IS NULL').all()) put.run(aiCallCost(r), r.id); })();
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ai_calls_cost_saved_2026_10', '1');
  } catch (e) { console.warn('ai_calls cost backfill failed:', e.message); }
}
// Calls written without a cost (the enricher writes its calls straight into the table; one
// interrupted before the server finished its run): today's estimate, at every start.
try {
  const missing = db.prepare('SELECT * FROM ai_calls WHERE cost IS NULL').all();
  if (missing.length) {
    const put = db.prepare('UPDATE ai_calls SET cost = ? WHERE id = ?');
    db.transaction(() => { for (const r of missing) put.run(aiCallCost(r), r.id); })();
  }
} catch (e) { console.warn('ai_calls cost fill failed:', e.message); }
// "Start fresh": the usage view counts from this moment (older rows stay in the table).
if (!getSetting('ai_usage_since')) db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ai_usage_since', String(Date.now()));
const insertAiCall = db.prepare(`INSERT INTO ai_calls (at, day, task, tier, provider, model, source, ok, error, ms, input_tokens, output_tokens, cache_read, cache_write, web_searches, job_id, thinking_tokens, run_id, cost, request_id)
  VALUES (@at, @day, @task, @tier, @provider, @model, @source, @ok, @error, @ms, @input_tokens, @output_tokens, @cache_read, @cache_write, @web_searches, @job_id, @thinking_tokens, @run_id, @cost, @request_id)`);
const insertAiRun = db.prepare('INSERT OR IGNORE INTO ai_runs (id, at, label, user_id) VALUES (?, ?, ?, ?)');
// One row per job; a job's model/provider are those of its first call.
const upsertAiJob = db.prepare(`INSERT INTO ai_jobs (id, at, day, task, tier, provider, model, source, calls, failed_calls, ms)
  VALUES (@job_id, @at, @day, @task, @tier, @provider, @model, @source, 1, @failed, @ms)
  ON CONFLICT(id) DO UPDATE SET calls = calls + 1, failed_calls = failed_calls + excluded.failed_calls, ms = ms + excluded.ms,
    task = excluded.task, tier = excluded.tier, provider = excluded.provider, model = excluded.model`);
// A job is filed under the task and model of its LAST call: the one that
// produced the result. A Comic Book Guy question Quick Answers hands to the
// Reading List Generator counts as a reading-list job (its cost includes the
// Quick calls before the hand-off). One-time fix for jobs logged before this.
if (!getSetting('ai_jobs_final_task_2026_10')) {
  try {
    db.prepare(`UPDATE ai_jobs SET
        task = (SELECT c.task FROM ai_calls c WHERE c.job_id = ai_jobs.id ORDER BY c.at DESC, c.rowid DESC LIMIT 1),
        tier = (SELECT c.tier FROM ai_calls c WHERE c.job_id = ai_jobs.id ORDER BY c.at DESC, c.rowid DESC LIMIT 1),
        provider = (SELECT c.provider FROM ai_calls c WHERE c.job_id = ai_jobs.id ORDER BY c.at DESC, c.rowid DESC LIMIT 1),
        model = (SELECT c.model FROM ai_calls c WHERE c.job_id = ai_jobs.id ORDER BY c.at DESC, c.rowid DESC LIMIT 1)
      WHERE calls > 1 AND EXISTS (SELECT 1 FROM ai_calls c WHERE c.job_id = ai_jobs.id)`).run();
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ai_jobs_final_task_2026_10', '1');
  } catch (e) { console.warn('ai_jobs final-task fix failed:', e.message); }
}
function recordAiCall(e) {
  const at = Date.now();
  const row = { at, day: new Date(at).toISOString().slice(0, 10), task: e.task || null, tier: aiModels.TASKS.find(t => t.id === e.task)?.tier || null,
    provider: e.provider || 'anthropic', model: e.model || '', source: e.source || 'live', ok: e.ok ? 1 : 0, error: e.error || null, ms: e.ms || 0,
    input_tokens: e.input_tokens || 0, output_tokens: e.output_tokens || 0, cache_read: e.cache_read || 0, cache_write: e.cache_write || 0, web_searches: e.web_searches || 0,
    job_id: e.job_id || null, thinking_tokens: typeof e.thinking_tokens === 'number' ? e.thinking_tokens : null, run_id: e.run?.id || null, cost: null,
    request_id: aiInfo.currentRequest() };
  row.cost = aiCallCost(row);
  insertAiCall.run(row);
  if (row.run_id) insertAiRun.run(row.run_id, at - row.ms, e.run.label || null, e.run.userId || null);
  if (row.job_id) upsertAiJob.run({ ...row, failed: row.ok ? 0 : 1 });
  if (!row.ok) logger.warn('ai', 'AI call failed', { task: aiTaskLabel(row.task), model: aiPrices.displayName(row.model), error: row.error, run: String(row.run_id || row.job_id || '').slice(0, 8) || undefined });
  noteAiRun(row, e.run);
}
// System log (2026-10-23): one line per finished run (no new call for 60 s) instead of one per call.
// Looking runs up later: Settings › AI Models › Usage & results (the live log keeps 500 lines).
const aiTaskLabel = id => aiModels.TASKS.find(t => t.id === id)?.label || (id === 'connection_test' ? 'Connection test' : id || 'Other');
const openAiRuns = new Map();
function noteAiRun(row, run) {
  if (row.task === 'connection_test') return;
  const key = row.run_id || row.job_id;
  if (!key) return;
  let r = openAiRuns.get(key);
  if (!r) openAiRuns.set(key, r = { label: run?.label || null, userId: run?.userId || null, source: row.source, tasks: new Set(), models: new Set(), jobs: new Set(), calls: 0, failed: 0, cost: 0, start: row.at - row.ms, last: row.at });
  r.tasks.add(row.task); r.models.add(row.model); if (row.job_id) r.jobs.add(row.job_id);
  r.calls++; if (!row.ok) r.failed++; r.cost += row.cost || 0; r.last = row.at;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, r] of openAiRuns) {
    if (now - r.last < 60000) continue;
    openAiRuns.delete(key);
    try {
      let problems = [];
      if (r.jobs.size) {
        const ids = [...r.jobs];
        problems = db.prepare(`SELECT outcome FROM ai_jobs WHERE id IN (${ids.map(() => '?').join(',')}) AND outcome IS NOT NULL AND outcome NOT IN ('ok', 'matched', 'written')`).all(...ids).map(x => x.outcome);
      }
      const user = r.userId ? db.prepare('SELECT username FROM users WHERE id = ?').get(r.userId)?.username : null;
      logger.info('ai', 'AI run finished', { what: r.label || undefined, tasks: [...r.tasks].map(aiTaskLabel).join(', '), models: [...r.models].map(m => aiPrices.displayName(m)).join(', '),
        calls: r.calls, failed: r.failed || undefined, problems: problems.length ? problems.join(', ') : undefined, cost: `${Math.round(r.cost * 100 * 100) / 100}¢`,
        secs: Math.round((r.last - r.start) / 100) / 10, user: user || undefined, source: r.source !== 'live' ? r.source : undefined, run: key.slice(0, 8) });
    } catch (e) { logger.warn('ai', 'Run summary failed', { error: e.message }); }
  }
}, 30000).unref();
// What a job achieved, set by the code that used the reply. Good outcomes:
// ok, matched, written. Problems: error, bad_json, truncated, cut_off, no_list,
// unknown (enricher did not recognise the series), no_match.
const setAiJobOutcome = (jobId, outcome, detail = null) => {
  try { if (jobId) db.prepare('UPDATE ai_jobs SET outcome = ?, detail = ? WHERE id = ?').run(outcome, detail ? String(detail).slice(0, 200) : null, jobId); } catch {}
};
// Enricher runs (2026-11-03). scripts/enricher.py writes its AI calls straight into ai_calls.
// Each spawn now gets a run (id in its config, ai_run.id) that its calls carry; when the
// process reports progress or ends, finishEnricherRun gives those calls their cost and the
// run its label, warns about failed calls and feeds the "AI run finished" line, the same as
// calls made here. Before this, enricher calls had no cost (Usage & results counted them as
// free) and never reached the System log.
function startEnricherRun(label, userId = null) { return { id: crypto.randomUUID(), label, userId, requestId: aiInfo.currentRequest() }; }
function finishEnricherRun(run) {
  if (!run) return;
  try {
    // The enricher writes its own rows: give them the request that started it (ⓘ details).
    if (run.requestId) db.prepare('UPDATE ai_calls SET request_id = ? WHERE run_id = ? AND request_id IS NULL').run(run.requestId, run.id);
    const rows = db.prepare('SELECT * FROM ai_calls WHERE run_id = ? AND cost IS NULL ORDER BY id').all(run.id);
    if (!rows.length) return;
    insertAiRun.run(run.id, rows[0].at - (rows[0].ms || 0), run.label || null, run.userId || null);
    const put = db.prepare('UPDATE ai_calls SET cost = ? WHERE id = ?');
    for (const row of rows) {
      row.cost = aiCallCost(row);
      put.run(row.cost, row.id);
      if (!row.ok) logger.warn('ai', 'AI call failed', { task: aiTaskLabel(row.task), model: aiPrices.displayName(row.model), error: row.error, run: String(run.id).slice(0, 8) });
      noteAiRun(row, run);
    }
  } catch (e) { logger.warn('ai', 'Enricher run not recorded', { error: e.message }); }
}
const ai = require('./ai/aiClient').createAiClient({ axios, getAnthropicKey, getOpenAIKey, getGeminiKey, modelFor: id => aiRouting.modelFor(id), pick: id => aiRouting.pick(id), logger, onCall: recordAiCall });
// Routes that start AI work (2026-11-09, aiInfo.js): their AI calls, including background work
// they start, are saved with the request's id, which admins get back (ai_request / X-AI-Request)
// for the ⓘ details. Work started any other way shows in the top-bar AI activity feed.
const AI_ROUTES = ['/api/assistant/chat', '/api/events/generate', '/api/events/guide-page/test', '/api/events/:id/reannotate',
  '/api/events/notes/refresh-all', '/api/canon/generate', '/api/editor/runs/categories/check', '/api/admin/genres/retag',
  '/api/series/:id/enrich', '/api/series/:id/create-json', '/api/monitor/mass-json', '/api/monitor/series/:id/create-series-json',
  '/api/monitor/series/:id/discover-annuals', '/api/monitor/series/:id/link-annual', '/api/monitor/series-json-refresh/run', '/api/admin/recaps'];
app.use(AI_ROUTES, (req, res, next) => (req.method === 'POST' ? aiInfo.track(req, res, next) : next()));
// Express step that makes the rest of a request one AI run (Usage & results, System log).
const aiRunStep = labelOf => (req, res, next) => {
  let label = null;
  try { label = labelOf(req); } catch {}
  ai.run({ label, userId: req.user?.sub || req.user?.id || null }, next);
};
function getEventModel()      { return aiRouting.modelFor('generation'); }
function getValidationModel() { return aiRouting.modelFor('quick'); }

// New databases (2026-11-05): these columns' ALTERs above run before their tables are
// created, so a brand-new install never got them (the wanted list failed with "no such
// column: s.series_type"; saving publisher eras, Timeline tiers and phases too). Existing
// databases already have them; the ALTERs then fail quietly.
for (const sql of [
  "ALTER TABLE monitored_series ADD COLUMN series_type TEXT DEFAULT 'comic'",
  'ALTER TABLE events ADD COLUMN event_tier INTEGER DEFAULT 2',
  'ALTER TABLE events ADD COLUMN sort_order INTEGER DEFAULT 0',
  'ALTER TABLE event_issues ADD COLUMN phase TEXT',
  'ALTER TABLE publisher_eras ADD COLUMN folder TEXT',
]) { try { db.prepare(sql).run(); } catch {} }

// ─── Schema migrations (safe to run on every startup) ────────────
// SQLite has no ALTER TABLE IF NOT EXISTS — just catch duplicate-column errors
[
  "ALTER TABLE collections ADD COLUMN condition_group TEXT",
  "ALTER TABLE collections ADD COLUMN collection_type TEXT DEFAULT 'manual'",
  "ALTER TABLE collections ADD COLUMN owner_id TEXT",
  "ALTER TABLE collections ADD COLUMN visibility TEXT DEFAULT 'public'",
  // Also tried near the top of the file, before the collections table exists on a new install
  // (found 2026-11-03: a fresh database had no sort_order / library_id, so boxes could not be made).
  "ALTER TABLE collections ADD COLUMN cover_image TEXT",
  "ALTER TABLE collections ADD COLUMN sort_order INTEGER DEFAULT 0",
  "ALTER TABLE collections ADD COLUMN cover_position TEXT",
  "ALTER TABLE collections ADD COLUMN library_id TEXT",
  "ALTER TABLE cv_character_cache ADD COLUMN cv_id INTEGER",
  "ALTER TABLE monitored_issues ADD COLUMN is_annual INTEGER DEFAULT 0",
  "ALTER TABLE monitored_issues ADD COLUMN last_retag_cv_hash TEXT",
  // last_cv_check: when the retag rotation (or download tagging) last fetched
  // this issue from CV. Drives least-recently-checked-first ordering.
  "ALTER TABLE monitored_issues ADD COLUMN last_cv_check TEXT",
  // series_json_refreshed_at: when the scheduled series.json refresh last ran for this series.
  "ALTER TABLE monitored_series ADD COLUMN series_json_refreshed_at TEXT",
  // has_comicinfo: NULL = unknown (not yet scanned), 0 = no ComicInfo.xml in archive,
  // 1 = ComicInfo.xml present. Populated asynchronously after refresh-directory.
  "ALTER TABLE monitored_issues ADD COLUMN has_comicinfo INTEGER DEFAULT NULL",
  "ALTER TABLE monitored_series ADD COLUMN series_status TEXT DEFAULT 'unknown'",
  // series_status_source: 'metron' when Metron's status decided it (the 30-minute rescue pass
  // leaves those alone); metron_series_id: the Metron series matched by Comic Vine ID (2026-10-28).
  "ALTER TABLE monitored_series ADD COLUMN series_status_source TEXT",
  "ALTER TABLE monitored_series ADD COLUMN metron_series_id INTEGER",
  "ALTER TABLE scanned_series ADD COLUMN dir_mtime INTEGER DEFAULT 0",
  "ALTER TABLE scanned_series ADD COLUMN dir_file_count INTEGER DEFAULT 0",
  "ALTER TABLE scanned_books ADD COLUMN file_mtime INTEGER DEFAULT 0",
  "ALTER TABLE scanned_books ADD COLUMN file_size INTEGER DEFAULT 0",
  "ALTER TABLE scanned_books ADD COLUMN cv_issue_id TEXT",
  "ALTER TABLE scanned_books ADD COLUMN is_special INTEGER DEFAULT 0",
  "ALTER TABLE libraries ADD COLUMN scan_interval_hours INTEGER DEFAULT 0",
  "ALTER TABLE libraries ADD COLUMN last_scanned_at TEXT",
  "ALTER TABLE monitored_series ADD COLUMN annual_no_match_until TEXT",
  "ALTER TABLE monitored_series ADD COLUMN parent_series_id TEXT DEFAULT NULL",
  // source_name: the exact series name string from the release source (FreshComics,
  // Walksoftly, etc.) that was used when the user added this series from the weekly tab.
  // Stored so weekly matching can do an exact source-name lookup instead of fuzzy CV-name
  // matching — gives Walksoftly-quality matching even for sources that don't provide CV IDs.
  "ALTER TABLE monitored_series ADD COLUMN source_name TEXT DEFAULT NULL",
  // LOCG series page ID and slug — populated lazily by background resolver cron
  "ALTER TABLE monitored_series ADD COLUMN locg_series_id TEXT DEFAULT NULL",
  "ALTER TABLE monitored_series ADD COLUMN locg_series_slug TEXT DEFAULT NULL",
  // Fill missing issues: entry made by Fill (1 = remove from the download
  // manager once no pick is still wanted) and when the fill started.
  "ALTER TABLE monitored_series ADD COLUMN fill_auto_remove INTEGER DEFAULT 0",
  "ALTER TABLE monitored_series ADD COLUMN fill_started_at TEXT",
].forEach(sql => { try { db.exec(sql); } catch (e) { /* column already exists */ } });

// Backfill issue dates from stored CV data. Issues discovered before CV had
// dates were inserted with NULL dates, and refreshes only updated cv_data, so
// those issues fell outside every date-windowed job (including retagging).
try {
  const { changes } = db.prepare(`
    UPDATE monitored_issues
    SET store_date   = COALESCE(store_date,   json_extract(cv_data, '$.store_date')),
        release_date = COALESCE(release_date, json_extract(cv_data, '$.cover_date'))
    WHERE (store_date IS NULL OR release_date IS NULL)
      AND cv_data IS NOT NULL AND json_valid(cv_data)
      AND (json_extract(cv_data, '$.store_date') IS NOT NULL OR json_extract(cv_data, '$.cover_date') IS NOT NULL)
  `).run();
  if (changes > 0) console.log(`[schema] Backfilled dates for ${changes} monitored issues from cv_data`);
} catch (e) { console.warn('[schema] Issue date backfill failed', e.message); }

// One-time repair (2026-10-08): make is_annual match Comic Vine for every issue.
// Retags used to flag a regular issue as an annual when an annual's file had been
// linked to it, which hid the issue (Blue Devil #1). Comic Vine is the authority:
// an issue is an annual when its CV number/name says so or it belongs to an
// "Annual" volume. A regular issue that was wrongly flagged and is linked to an
// annual-named file is set back to wanted, so Refresh links its real file (or it
// shows as missing).
try {
  if (getSetting('annual_flag_reconcile_20261008') !== 'done') {
    const rows = db.prepare(`
      SELECT i.id, i.issue_number, i.is_annual, i.cv_data, i.file_path, s.name AS series_name
      FROM monitored_issues i JOIN monitored_series s ON s.id = i.series_id
      WHERE i.cv_data IS NOT NULL
    `).all();
    const setAnnual  = db.prepare('UPDATE monitored_issues SET is_annual = 1 WHERE id = ?');
    const setRegular = db.prepare('UPDATE monitored_issues SET is_annual = 0 WHERE id = ?');
    const unlink = db.prepare(`UPDATE monitored_issues SET status = 'wanted', file_path = NULL, download_id = NULL,
                               date_processed = NULL, has_comicinfo = NULL WHERE id = ?`);
    let toAnnual = 0; const fixed = [];
    db.transaction(() => {
      for (const r of rows) {
        let cv; try { cv = JSON.parse(r.cv_data); } catch { continue; }
        if (!cv || typeof cv !== 'object') continue;
        const annual = /annual/i.test(`${cv.issue_number || ''} ${cv.name || ''}`) || /annual/i.test(r.series_name || '');
        if (annual && !r.is_annual) { setAnnual.run(r.id); toAnnual++; }
        else if (!annual && r.is_annual) {
          setRegular.run(r.id);
          const wrongFile = r.file_path && /annual/i.test(path.basename(r.file_path));
          if (wrongFile) unlink.run(r.id);
          fixed.push(`${r.series_name} #${r.issue_number}${wrongFile ? ` (unlinked ${path.basename(r.file_path)})` : ''}`);
        }
      }
    })();
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('annual_flag_reconcile_20261008', 'done');
    if (fixed.length || toAnnual) {
      console.log(`[schema] Annual flags reconciled with Comic Vine: ${fixed.length} regular issue(s) un-flagged, ${toAnnual} annual(s) flagged`);
      for (const f of fixed) console.log(`[schema]   now regular: ${f}`);
    }
  }
} catch (e) { console.warn('[schema] Annual flag reconcile failed', e.message); }

// LOCG issue lookup — stores (locg_issue_id, locg_slug) from weekly parses so the
// background resolver can fetch issue pages to extract locg_series_id.
db.exec(`
  CREATE TABLE IF NOT EXISTS locg_issue_lookup (
    locg_issue_id  TEXT PRIMARY KEY,
    locg_slug      TEXT NOT NULL,
    cv_series_id   TEXT,
    created_at     TEXT DEFAULT (datetime('now'))
  )
`);

// ─── release_cv_map — persistent (name+publisher) → CV volume ID lookup ──────
// Bridges FreshComics (name-only) weekly data to CV volume IDs so weekly
// matching is an O(1) table lookup instead of fragile name fuzzy-matching.
// Seeded automatically from monitored_series on every startup; updated when
// series are added or when the user confirms a match from the weekly tab.
db.exec(`
  CREATE TABLE IF NOT EXISTS release_cv_map (
    norm_name      TEXT NOT NULL,
    norm_publisher TEXT NOT NULL DEFAULT '',
    cv_volume_id   TEXT NOT NULL,
    source         TEXT DEFAULT 'auto',
    updated_at     TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (norm_name, norm_publisher)
  )
`);

// Seed / refresh release_cv_map from monitored_series.
// For each (norm_name, norm_publisher) group, prefer the ongoing series;
// fall back to most recent start year. Runs synchronously at startup so the
// map is always current when the first weekly request arrives.
(function seedReleaseCvMap() {
  const series = db.prepare('SELECT id, name, publisher, year, series_status FROM monitored_series').all();
  const groups = new Map(); // `normName||normPub` → series[]
  for (const s of series) {
    const normName = (s.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const normPub  = (s.publisher || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const k = `${normName}||${normPub}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const upsert = db.prepare(`
    INSERT INTO release_cv_map (norm_name, norm_publisher, cv_volume_id, source, updated_at)
    VALUES (?, ?, ?, 'auto', datetime('now'))
    ON CONFLICT(norm_name, norm_publisher) DO UPDATE SET
      cv_volume_id = excluded.cv_volume_id,
      updated_at   = excluded.updated_at
    WHERE source != 'user'
  `);
  const upsertMany = db.transaction(() => {
    for (const [k, candidates] of groups) {
      const [normName, normPub] = k.split('||');
      // Prefer ongoing, then most recent year
      const best = candidates.find(c => c.series_status === 'ongoing')
        || [...candidates].sort((a, b) => (b.year || 0) - (a.year || 0))[0];
      upsert.run(normName, normPub, String(best.id));
    }
  });
  upsertMany();
  logger.info('startup', `release_cv_map seeded`, { entries: groups.size });
})();

// ─── Modular schema migrations (carved out into backend/schema.js) ──
applyIsSpecialSchema(db);
applyReadingListsSchema(db);
applyStableIdsSchema(db);

// One-time canonicalisation of monitored_issues.issue_number. Marker in
// settings table prevents re-runs. Logs what it did so we have a
// breadcrumb in the boot output.
try {
  const result = migrateMonitoredIssuesCanonical(db, (raw) => IN.normIssueNumber(raw));
  if (!result.skipped) {
    logger.info('schema', `migrate_issuenum_v1: scanned ${result.scanned}, rewrote ${result.changed} monitored_issues to canonical form`);
  }
} catch (e) {
  logger.warn('schema', `migrate_issuenum_v1 failed: ${e.message}`);
}

// ─── Backfill cv_url from series.json comicid for monitored series missing it ──
// Fixes series added before cv_url was reliably stored, so weekly CV-ID matching works.
try {
  const missingCvUrl = db.prepare(`SELECT id, directory FROM monitored_series WHERE cv_url IS NULL OR cv_url = ''`).all();
  const updateCvUrl  = db.prepare(`UPDATE monitored_series SET cv_url = ? WHERE id = ?`);
  for (const s of missingCvUrl) {
    try {
      const sjPath = path.join(s.directory, 'series.json');
      if (!fs.existsSync(sjPath)) continue;
      const sj = JSON.parse(fs.readFileSync(sjPath, 'utf8'));
      const comicid = sj?.metadata?.comicid || sj?.comicid;
      if (!comicid) continue;
      const cvUrl = `https://comicvine.gamespot.com/series/4050-${comicid}/`;
      updateCvUrl.run(cvUrl, s.id);
      logger.info('schema', `Backfilled cv_url for series ${s.id} from series.json`, { comicid });
    } catch { /* skip unreadable series.json */ }
  }
} catch (e) { logger.warn('schema', 'cv_url backfill error', e.message); }

// series_annual_links — links a standalone annual CV volume to its parent series
try {
  db.exec(`CREATE TABLE IF NOT EXISTS series_annual_links (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_series_id  TEXT NOT NULL,
    annual_series_id  TEXT NOT NULL,
    UNIQUE(parent_series_id, annual_series_id),
    FOREIGN KEY (parent_series_id) REFERENCES monitored_series(id),
    FOREIGN KEY (annual_series_id) REFERENCES monitored_series(id)
  )`);
} catch (e) { logger.warn('schema', 'series_annual_links table error', e.message); }

// ─── Canon Runs schema ────────────────────────────────────────────
try {
  db.exec(`CREATE TABLE IF NOT EXISTS canon_runs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    title            TEXT NOT NULL,
    parent_series    TEXT,
    cv_volume_id     TEXT,
    issue_range_hint TEXT,
    description      TEXT,
    status           TEXT NOT NULL DEFAULT 'pending',
    event_id         INTEGER REFERENCES events(id) ON DELETE SET NULL,
    created_at       TEXT DEFAULT (datetime('now')),
    updated_at       TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS canon_run_categories (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id           INTEGER NOT NULL REFERENCES canon_runs(id) ON DELETE CASCADE,
    category         TEXT NOT NULL,
    adaptation_notes TEXT,
    UNIQUE(run_id, category)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS canon_run_issues (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id           INTEGER NOT NULL REFERENCES canon_runs(id) ON DELETE CASCADE,
    cv_issue_id      TEXT,
    scanned_book_id  INTEGER REFERENCES scanned_books(id) ON DELETE SET NULL,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    series_name      TEXT,
    issue_number     TEXT,
    volume_year      TEXT,
    manually_matched INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS canon_run_creators (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      INTEGER NOT NULL REFERENCES canon_runs(id) ON DELETE CASCADE,
    person_name TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'writer'
  )`);
} catch (e) { logger.warn('schema', 'canon_runs table error', e.message); }

try { db.exec(`ALTER TABLE canon_runs ADD COLUMN event_id INTEGER REFERENCES events(id) ON DELETE SET NULL`); } catch {}
try { db.exec(`ALTER TABLE canon_runs ADD COLUMN admin_recommended INTEGER DEFAULT 0`); } catch {}

// Backfill is_annual for existing rows
try {
  db.exec(`UPDATE monitored_issues SET is_annual = 1
    WHERE is_annual = 0 AND (
      lower(title) LIKE '%annual%' OR
      lower(issue_number) LIKE '%annual%'
    )`);
} catch (e) { /* best effort */ }

// Auto-detect specials in scanned_books (filename or ComicInfo Format field)
// Only sets to 1 — never clears a manually-toggled 1 back to 0
try {
  db.exec(`UPDATE scanned_books SET is_special = 1
    WHERE is_special = 0 AND (
      lower(filename) LIKE '%special%' OR
      lower(filename) LIKE '%-one-shot%' OR
      lower(filename) LIKE '%oneshot%' OR
      lower(comicinfo) LIKE '%<format>special</format>%' OR
      lower(comicinfo) LIKE '%<format>one-shot</format>%'
    )`);
} catch (e) { /* best effort */ }

// One time (2026-10-26): downloads for series added with "Special of …" were registered without
// the special mark (the arrival step did not check; fixed in registerArrival). Mark the books
// linked to those series' issues once; later unmarking by hand is kept (setting records the run).
try {
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'special_of_backfill_20261026'").get()) {
    const r = db.prepare(`UPDATE scanned_books SET is_special = 1, sort_order = 9000 + COALESCE(CAST(issue_number AS REAL), 0)
      WHERE is_special = 0 AND path IN (SELECT mi.file_path FROM monitored_issues mi JOIN monitored_series ms ON ms.id = mi.series_id
        WHERE mi.file_path IS NOT NULL AND mi.file_path != '' AND (ms.is_special = 1 OR ms.parent_series_id IS NOT NULL))`).run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('special_of_backfill_20261026', ?)").run(String(r.changes));
    if (r.changes) logger.info('specials', `Marked ${r.changes} downloaded issue(s) of "Special of" series as specials`);
  }
} catch (e) { logger.warn('specials', 'Special-of backfill failed', e.message); }

// ─── Award data seed ──────────────────────────────────────────────
(function seedAwards() {
  const insert = db.prepare(`INSERT OR IGNORE INTO award_data (award, year, category, series_name, publisher, winner) VALUES (?, ?, ?, ?, ?, ?)`);
  const seed = db.transaction((rows) => { for (const r of rows) insert.run(...r); });
  seed([
    // ── Eisner – Best Continuing Series ──────────────────────────
    ['eisner',2024,'Best Continuing Series','Saga','Image Comics',1],
    ['eisner',2024,'Best Continuing Series','Groo: Gods Against Groo','Dark Horse',0],
    ['eisner',2024,'Best Continuing Series','Local Man','Image Comics',0],
    ['eisner',2024,'Best Continuing Series','One-Star Squadron','DC Comics',0],
    ['eisner',2023,'Best Continuing Series','Saga','Image Comics',1],
    ['eisner',2023,'Best Continuing Series','Something is Killing the Children','Boom Studios',0],
    ['eisner',2023,'Best Continuing Series','Usagi Yojimbo','IDW Publishing',0],
    ['eisner',2023,'Best Continuing Series','Locke & Key','IDW Publishing',0],
    ['eisner',2022,'Best Continuing Series','Saga','Image Comics',1],
    ['eisner',2022,'Best Continuing Series','Something is Killing the Children','Boom Studios',0],
    ['eisner',2022,'Best Continuing Series','Monstress','Image Comics',0],
    ['eisner',2021,'Best Continuing Series','Something is Killing the Children','Boom Studios',1],
    ['eisner',2021,'Best Continuing Series','Saga','Image Comics',0],
    ['eisner',2021,'Best Continuing Series','Monstress','Image Comics',0],
    ['eisner',2021,'Best Continuing Series','Usagi Yojimbo','IDW Publishing',0],
    ['eisner',2020,'Best Continuing Series','Giant Days','Boom Studios',1],
    ['eisner',2020,'Best Continuing Series','Saga','Image Comics',0],
    ['eisner',2020,'Best Continuing Series','Monstress','Image Comics',0],
    ['eisner',2019,'Best Continuing Series','Saga','Image Comics',1],
    ['eisner',2019,'Best Continuing Series','Giant Days','Boom Studios',0],
    ['eisner',2019,'Best Continuing Series','Monstress','Image Comics',0],
    ['eisner',2019,'Best Continuing Series','Black Hammer','Dark Horse',0],
    ['eisner',2018,'Best Continuing Series','Mister Miracle','DC Comics',1],
    ['eisner',2018,'Best Continuing Series','Saga','Image Comics',0],
    ['eisner',2018,'Best Continuing Series','Monstress','Image Comics',0],
    ['eisner',2018,'Best Continuing Series','Black Hammer','Dark Horse',0],
    ['eisner',2017,'Best Continuing Series','Saga','Image Comics',1],
    ['eisner',2017,'Best Continuing Series','Monstress','Image Comics',0],
    ['eisner',2017,'Best Continuing Series','Black Hammer','Dark Horse',0],
    ['eisner',2016,'Best Continuing Series','Saga','Image Comics',1],
    ['eisner',2016,'Best Continuing Series','Wicked + The Divine','Image Comics',0],
    ['eisner',2016,'Best Continuing Series','Lazarus','Image Comics',0],
    ['eisner',2015,'Best Continuing Series','Saga','Image Comics',1],
    ['eisner',2015,'Best Continuing Series','Wicked + The Divine','Image Comics',0],
    ['eisner',2015,'Best Continuing Series','Manhattan Projects','Image Comics',0],
    ['eisner',2014,'Best Continuing Series','Saga','Image Comics',1],
    ['eisner',2014,'Best Continuing Series','Manhattan Projects','Image Comics',0],
    ['eisner',2014,'Best Continuing Series','Lazarus','Image Comics',0],
    ['eisner',2013,'Best Continuing Series','Saga','Image Comics',1],
    ['eisner',2013,'Best Continuing Series','Fatale','Image Comics',0],
    ['eisner',2013,'Best Continuing Series','Manhattan Projects','Image Comics',0],
    ['eisner',2012,'Best Continuing Series','Locke & Key','IDW Publishing',1],
    ['eisner',2012,'Best Continuing Series','American Vampire','DC Comics',0],
    ['eisner',2012,'Best Continuing Series','Scalped','DC Comics',0],
    ['eisner',2011,'Best Continuing Series','Scalped','DC Comics',1],
    ['eisner',2011,'Best Continuing Series','Locke & Key','IDW Publishing',0],
    ['eisner',2011,'Best Continuing Series','Fables','DC Comics',0],
    ['eisner',2010,'Best Continuing Series','Locke & Key','IDW Publishing',1],
    ['eisner',2010,'Best Continuing Series','Fables','DC Comics',0],
    ['eisner',2009,'Best Continuing Series','Fables','DC Comics',1],
    ['eisner',2009,'Best Continuing Series','Y: The Last Man','DC Comics',0],
    ['eisner',2008,'Best Continuing Series','Y: The Last Man','DC Comics',1],
    ['eisner',2008,'Best Continuing Series','Fables','DC Comics',0],
    ['eisner',2007,'Best Continuing Series','Fables','DC Comics',1],
    ['eisner',2007,'Best Continuing Series','Y: The Last Man','DC Comics',0],
    ['eisner',2006,'Best Continuing Series','Fables','DC Comics',1],
    ['eisner',2006,'Best Continuing Series','Y: The Last Man','DC Comics',0],
    ['eisner',2006,'Best Continuing Series','Preacher','DC Comics',0],
    ['eisner',2005,'Best Continuing Series','Fables','DC Comics',1],
    ['eisner',2005,'Best Continuing Series','Astonishing X-Men','Marvel Comics',0],
    ['eisner',2004,'Best Continuing Series','Fables','DC Comics',1],
    ['eisner',2004,'Best Continuing Series','Powers','Image Comics',0],
    ['eisner',2003,'Best Continuing Series','Powers','Image Comics',1],
    ['eisner',2002,'Best Continuing Series','Daredevil','Marvel Comics',1],
    ['eisner',2001,'Best Continuing Series','Preacher','DC Comics',1],
    ['eisner',2000,'Best Continuing Series','Preacher','DC Comics',1],
    // ── Eisner – Best New Series ──────────────────────────────────
    ['eisner',2024,'Best New Series','Blood Hunt','Marvel Comics',1],
    ['eisner',2023,'Best New Series','Briar','Boom Studios',1],
    ['eisner',2023,'Best New Series','The Nice House on the Lake','DC Comics',0],
    ['eisner',2022,'Best New Series','The Nice House on the Lake','DC Comics',1],
    ['eisner',2022,'Best New Series','Something is Killing the Children','Boom Studios',0],
    ['eisner',2021,'Best New Series','Crossover','Image Comics',1],
    ['eisner',2021,'Best New Series','The Nice House on the Lake','DC Comics',0],
    ['eisner',2020,'Best New Series','Something is Killing the Children','Boom Studios',1],
    ['eisner',2020,'Best New Series','Die','Image Comics',0],
    ['eisner',2019,'Best New Series','Oblivion Song','Image Comics',1],
    ['eisner',2019,'Best New Series','Black Hammer: Age of Doom','Dark Horse',0],
    ['eisner',2018,'Best New Series','Black Hammer','Dark Horse',1],
    ['eisner',2018,'Best New Series','Paper Girls','Image Comics',0],
    ['eisner',2017,'Best New Series','The Vision','Marvel Comics',1],
    ['eisner',2017,'Best New Series','Paper Girls','Image Comics',0],
    ['eisner',2017,'Best New Series','Black Hammer','Dark Horse',0],
    ['eisner',2016,'Best New Series','Paper Girls','Image Comics',1],
    ['eisner',2016,'Best New Series','The Vision','Marvel Comics',0],
    ['eisner',2015,'Best New Series','Ms. Marvel','Marvel Comics',1],
    ['eisner',2015,'Best New Series','Saga','Image Comics',0],
    ['eisner',2014,'Best New Series','Sex Criminals','Image Comics',1],
    ['eisner',2014,'Best New Series','Manhattan Projects','Image Comics',0],
    ['eisner',2013,'Best New Series','Hawkeye','Marvel Comics',1],
    ['eisner',2013,'Best New Series','Saga','Image Comics',0],
    ['eisner',2012,'Best New Series','Saga','Image Comics',1],
    ['eisner',2012,'Best New Series','Manhattan Projects','Image Comics',0],
    ['eisner',2011,'Best New Series','Nonplayer','Image Comics',1],
    ['eisner',2010,'Best New Series','Daytripper','DC Comics',1],
    ['eisner',2009,'Best New Series','Saga of the Swamp Thing','DC Comics',0],
    ['eisner',2008,'Best New Series','Criminal','Marvel Comics',1],
    ['eisner',2007,'Best New Series','The Umbrella Academy','Dark Horse',0],
    // ── Eisner – Best Limited Series or Story Arc ─────────────────
    ['eisner',2024,'Best Limited Series','Godzilla Here There Be Monsters','IDW Publishing',1],
    ['eisner',2023,'Best Limited Series','Strange Adventures','DC Comics',1],
    ['eisner',2023,'Best Limited Series','Wonder Woman Historia: The Amazons','DC Comics',1],
    ['eisner',2023,'Best Limited Series','Department of Truth','Image Comics',0],
    ['eisner',2022,'Best Limited Series','Department of Truth','Image Comics',1],
    ['eisner',2021,'Best Limited Series','Strange Adventures','DC Comics',1],
    ['eisner',2021,'Best Limited Series','Monstress','Image Comics',0],
    ['eisner',2020,'Best Limited Series','Monstress','Image Comics',0],
    ['eisner',2019,'Best Limited Series','Mister Miracle','DC Comics',1],
    ['eisner',2019,'Best Limited Series','Black Hammer: Age of Doom','Dark Horse',0],
    ['eisner',2018,'Best Limited Series','Mister Miracle','DC Comics',1],
    ['eisner',2018,'Best Limited Series','Black Monday Murders','Image Comics',0],
    ['eisner',2017,'Best Limited Series','Vision','Marvel Comics',1],
    ['eisner',2016,'Best Limited Series','Vision','Marvel Comics',1],
    ['eisner',2015,'Best Limited Series','The Fade Out','Image Comics',1],
    ['eisner',2015,'Best Limited Series','East of West','Image Comics',0],
    ['eisner',2014,'Best Limited Series','The Wake','DC Comics',1],
    ['eisner',2013,'Best Limited Series','The Private Eye','Panel Syndicate',1],
    ['eisner',2012,'Best Limited Series','The Underwater Welder','Top Shelf',0],
    ['eisner',2011,'Best Limited Series','Daytripper','DC Comics',1],
    ['eisner',2010,'Best Limited Series','The Marvels Project','Marvel Comics',1],
    ['eisner',2009,'Best Limited Series','Skim','Groundwood Books',1],
    ['eisner',2008,'Best Limited Series','Buffy the Vampire Slayer: Season 8','Dark Horse',0],
    // ── Harvey – Best Continuing or Limited Series ────────────────
    ['harvey',2024,'Best Continuing or Limited Series','Saga','Image Comics',1],
    ['harvey',2023,'Best Continuing or Limited Series','Saga','Image Comics',1],
    ['harvey',2022,'Best Continuing or Limited Series','Monstress','Image Comics',1],
    ['harvey',2022,'Best Continuing or Limited Series','Something is Killing the Children','Boom Studios',0],
    ['harvey',2021,'Best Continuing or Limited Series','Something is Killing the Children','Boom Studios',1],
    ['harvey',2021,'Best Continuing or Limited Series','Saga','Image Comics',0],
    ['harvey',2020,'Best Continuing or Limited Series','Giant Days','Boom Studios',1],
    ['harvey',2020,'Best Continuing or Limited Series','Saga','Image Comics',0],
    ['harvey',2019,'Best Continuing or Limited Series','Saga','Image Comics',1],
    ['harvey',2019,'Best Continuing or Limited Series','Mister Miracle','DC Comics',0],
    ['harvey',2018,'Best Continuing or Limited Series','Mister Miracle','DC Comics',1],
    ['harvey',2018,'Best Continuing or Limited Series','Saga','Image Comics',0],
    ['harvey',2017,'Best Continuing or Limited Series','Saga','Image Comics',1],
    ['harvey',2017,'Best Continuing or Limited Series','Monstress','Image Comics',0],
    ['harvey',2016,'Best Continuing or Limited Series','Saga','Image Comics',1],
    ['harvey',2016,'Best Continuing or Limited Series','Wicked + The Divine','Image Comics',0],
    ['harvey',2015,'Best Continuing or Limited Series','Saga','Image Comics',1],
    ['harvey',2015,'Best Continuing or Limited Series','East of West','Image Comics',0],
    ['harvey',2014,'Best Continuing or Limited Series','Saga','Image Comics',1],
    ['harvey',2013,'Best Continuing or Limited Series','Saga','Image Comics',1],
    ['harvey',2012,'Best Continuing or Limited Series','Locke & Key','IDW Publishing',1],
    ['harvey',2011,'Best Continuing or Limited Series','Scalped','DC Comics',1],
    ['harvey',2011,'Best Continuing or Limited Series','Locke & Key','IDW Publishing',0],
    ['harvey',2010,'Best Continuing or Limited Series','Locke & Key','IDW Publishing',1],
    ['harvey',2009,'Best Continuing or Limited Series','Fables','DC Comics',1],
    ['harvey',2008,'Best Continuing or Limited Series','Y: The Last Man','DC Comics',1],
    ['harvey',2007,'Best Continuing or Limited Series','Fables','DC Comics',1],
    ['harvey',2006,'Best Continuing or Limited Series','Fables','DC Comics',1],
    ['harvey',2005,'Best Continuing or Limited Series','Fables','DC Comics',1],
    ['harvey',2004,'Best Continuing or Limited Series','Powers','Image Comics',1],
    ['harvey',2003,'Best Continuing or Limited Series','Preacher','DC Comics',1],
    ['harvey',2002,'Best Continuing or Limited Series','Preacher','DC Comics',1],
    // ── Harvey – Best New Series ──────────────────────────────────
    ['harvey',2024,'Best New Series','Briar','Boom Studios',1],
    ['harvey',2023,'Best New Series','Briar','Boom Studios',0],
    ['harvey',2022,'Best New Series','Something is Killing the Children','Boom Studios',1],
    ['harvey',2021,'Best New Series','Crossover','Image Comics',1],
    ['harvey',2020,'Best New Series','Something is Killing the Children','Boom Studios',1],
    ['harvey',2019,'Best New Series','Oblivion Song','Image Comics',1],
    ['harvey',2018,'Best New Series','Black Hammer','Dark Horse',1],
    ['harvey',2017,'Best New Series','Black Hammer','Dark Horse',0],
    ['harvey',2016,'Best New Series','Paper Girls','Image Comics',1],
    ['harvey',2015,'Best New Series','Ms. Marvel','Marvel Comics',1],
    ['harvey',2014,'Best New Series','Sex Criminals','Image Comics',1],
    ['harvey',2013,'Best New Series','Hawkeye','Marvel Comics',1],
    ['harvey',2012,'Best New Series','Saga','Image Comics',1],
    ['harvey',2011,'Best New Series','The Unwritten','DC Comics',1],
    ['harvey',2010,'Best New Series','Daytripper','DC Comics',1],
    ['harvey',2009,'Best New Series','Criminal','Marvel Comics',1],
    ['harvey',2008,'Best New Series','The Umbrella Academy','Dark Horse',1],
    ['harvey',2007,'Best New Series','Buffy the Vampire Slayer: Season 8','Dark Horse',1],
  ]);
  console.log('[awards] Seeded award data');
})();

// ─── Comic awards (verified list, user 2026-10-18) ────────────────
// backend/data/comic_awards.json: winners researched from the awards' own records (Eisner, Harvey,
// Kirby, Hugo, Stoker), work awards and creator awards with the works their citations name. It is
// the source of truth for winners: older winner rows for the same award and category (the seed
// above and the old Eisner import, which had wrong years) are kept as nominees only. Runs once per
// file version (setting comic_awards_version). Creator rows store the creator in series_name.
for (const col of ['kind TEXT', 'creator TEXT', 'creators TEXT', 'cited_works TEXT', 'source TEXT']) {
  try { db.prepare(`ALTER TABLE award_data ADD COLUMN ${col}`).run(); } catch {}
}
(function syncComicAwards() {
  try {
    const file = path.join(__dirname, 'data', 'comic_awards.json');
    if (!fs.existsSync(file)) return;
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const have = db.prepare("SELECT value FROM settings WHERE key = 'comic_awards_version'").get();
    if (have && have.value === doc.version) return;
    const norm = s => String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
    const legacyCv = new Map();
    for (const r of db.prepare("SELECT award, series_name, cv_volume_id, cv_issue_id FROM award_data WHERE source IS NULL AND (cv_volume_id IS NOT NULL OR cv_issue_id IS NOT NULL)").all()) {
      legacyCv.set(`${r.award}|${norm(r.series_name)}`, r);
    }
    const cats = new Map();
    for (const r of doc.rows) { if (!cats.has(r.award)) cats.set(r.award, new Set()); cats.get(r.award).add(r.category); }
    const demote = db.prepare('UPDATE award_data SET winner = 0 WHERE award = ? AND category = ? AND source IS NULL AND winner = 1');
    const upsert = db.prepare(`INSERT INTO award_data (award, year, category, series_name, publisher, winner, kind, creator, creators, cited_works, source, cv_volume_id, cv_issue_id)
      VALUES (@award, @year, @category, @series_name, @publisher, 1, @kind, @creator, @creators, @cited_works, @source, @cv_volume_id, @cv_issue_id)
      ON CONFLICT(award, year, category, series_name) DO UPDATE SET winner = 1, kind = excluded.kind, creator = excluded.creator,
        creators = excluded.creators, cited_works = excluded.cited_works, source = excluded.source,
        publisher = COALESCE(excluded.publisher, award_data.publisher),
        cv_volume_id = COALESCE(award_data.cv_volume_id, excluded.cv_volume_id), cv_issue_id = COALESCE(award_data.cv_issue_id, excluded.cv_issue_id)`);
    db.transaction(() => {
      for (const [award, set] of cats) for (const c of set) demote.run(award, c);
      for (const r of doc.rows) {
        const name = r.kind === 'creator' ? r.creator : r.title;
        const cv = r.kind === 'work' ? legacyCv.get(`${r.award}|${norm(name)}`) : null;   // keep Comic Vine links from the old import
        upsert.run({ award: r.award, year: r.year, category: r.category, series_name: name, publisher: r.publisher || null, kind: r.kind,
          creator: r.kind === 'creator' ? r.creator : null, creators: r.creators || null,
          cited_works: r.kind === 'creator' ? JSON.stringify(r.cited_works || []) : null, source: r.source || null,
          cv_volume_id: cv ? cv.cv_volume_id : null, cv_issue_id: cv ? cv.cv_issue_id : null });
      }
      db.prepare("INSERT INTO settings (key, value) VALUES ('comic_awards_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(doc.version);
    })();
    console.log(`[awards] Synced ${doc.rows.length} verified award winners (${doc.version})`);
  } catch (e) { console.error('[awards] Sync failed:', e.message); }
})();

// ─── In-memory caches ─────────────────────────────────────────────
// Stores fetchAllSeries results so tab switches don't re-hit Komga
const seriesCache  = new Map(); // key: libraryId|'' → { data, ts }
const charMapCache = new Map(); // key: libraryId|'' → { data, ts }
const creatorsCache = new Map(); // key: seriesId → { writers: string[], artists: string[] }
const latestReleaseDateCache = new Map(); // key: seriesId → ISO date string | null
const SERIES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getSeriesCacheKey(libraryId) { return libraryId || '__all__'; }

function invalidateSeriesCache() { seriesCache.clear(); charMapCache.clear(); creatorsCache.clear(); latestReleaseDateCache.clear(); }

// In-memory creators cache — built from scanned_books comicinfo in one pass at startup
// Maps seriesId → { writers: string[], artists: string[] }
// "artists" = pencillers + inkers + colorists + cover artists
function warmCreatorsCache() {
  try {
    const rows = db.prepare(
      'SELECT series_id, comicinfo FROM scanned_books WHERE comicinfo IS NOT NULL'
    ).all();
    const tmp = {}; // seriesId → { writers: Set, artists: Set }
    for (const row of rows) {
      const ci = parseComicInfo(row.comicinfo);
      if (!tmp[row.series_id]) tmp[row.series_id] = { writers: new Set(), artists: new Set() };
      const e = tmp[row.series_id];
      const norm = n => n.trim().replace(/\s*\[\d+\]\s*$/, '');
      if (ci.writer)      ci.writer.split(',').map(norm).filter(Boolean).forEach(n => e.writers.add(n));
      if (ci.penciller)   ci.penciller.split(',').map(norm).filter(Boolean).forEach(n => e.artists.add(n));
      if (ci.inker)       ci.inker.split(',').map(norm).filter(Boolean).forEach(n => e.artists.add(n));
      if (ci.colorist)    ci.colorist.split(',').map(norm).filter(Boolean).forEach(n => e.artists.add(n));
      if (ci.coverArtist) ci.coverArtist.split(',').map(norm).filter(Boolean).forEach(n => e.artists.add(n));
    }
    for (const [sid, sets] of Object.entries(tmp)) {
      creatorsCache.set(sid, { writers: [...sets.writers], artists: [...sets.artists] });
    }
    console.log(`[cache] Warmed creators for ${creatorsCache.size} series`);
  } catch (e) {
    console.warn('[cache] Failed to warm creators cache:', e.message);
  }
}

// In-memory series.json cache (survives for process lifetime, warmed on first access)
// Separate from SQLite — we batch-load ALL cached entries into RAM at startup
const jsonMemCache = new Map(); // seriesId → parsed metadata object or null
let jsonMemCacheLoaded = false;

function warmJsonMemCache() {
  if (jsonMemCacheLoaded) return;
  try {
    const rows = db.prepare('SELECT series_id, data FROM series_json_cache').all();
    for (const row of rows) {
      try { jsonMemCache.set(row.series_id, JSON.parse(row.data)); }
      catch {}
    }
    jsonMemCacheLoaded = true;
    console.log(`[cache] Warmed ${jsonMemCache.size} series.json entries from SQLite`);
  } catch (e) {
    console.warn('[cache] Failed to warm json cache:', e.message);
  }
}

// Call once at startup (non-blocking)
setImmediate(warmJsonMemCache);
setImmediate(warmCreatorsCache);
setImmediate(warmLatestReleaseDateCache);
setTimeout(() => runCbrQueue(), 20000); // auto-fetch CBR ratings 20s after startup (cbr.js, created further down)

// ─── One-time CV ID backfill ──────────────────────────────────────
// Extracts CV issue IDs from stored ComicInfo XML for all books that
// don't already have one. Zero API calls — reads local data only.
setImmediate(() => {
  const books = db.prepare(
    'SELECT id, comicinfo FROM scanned_books WHERE cv_issue_id IS NULL AND comicinfo IS NOT NULL'
  ).all();
  if (!books.length) return;
  const upd = db.prepare('UPDATE scanned_books SET cv_issue_id = ? WHERE id = ?');
  let filled = 0;
  db.transaction(() => {
    for (const b of books) {
      const cvId = extractCvIdFromComicInfo(b.comicinfo);
      if (cvId) { upd.run(cvId, b.id); filled++; }
    }
  })();
  if (filled > 0) logger.info('scanner', `CV ID backfill: ${filled} / ${books.length} books matched`);
});

// ─── One-time ComicInfo disk backfill ────────────────────────────
// For books where comicinfo was never stored (scanned before that feature),
// reads each cbz from disk, stores comicinfo + extracts cv_issue_id.
// Runs once in background on startup — subsequent restarts are instant (0 rows).
(async () => {
  const books = db.prepare(
    'SELECT id, path FROM scanned_books WHERE comicinfo IS NULL AND path IS NOT NULL'
  ).all();
  if (!books.length) return;

  logger.info('scanner', `ComicInfo disk backfill: ${books.length} books to process`);
  const updComicinfo = db.prepare('UPDATE scanned_books SET comicinfo = ?, cv_issue_id = ? WHERE id = ?');
  let done = 0, filled = 0;

  for (const b of books) {
    try {
      const ciRaw = await extractComicInfo(b.path);
      // '' = read OK but no ComicInfo.xml: store it so the file isn't re-read on every start.
      if (ciRaw !== null) {
        const cvId = ciRaw ? extractCvIdFromComicInfo(ciRaw) : null;
        updComicinfo.run(ciRaw, cvId || null, b.id);
        if (cvId) filled++;
      }
    } catch { /* file missing or unreadable — skip silently */ }
    done++;
    if (done % 500 === 0) {
      logger.info('scanner', `ComicInfo disk backfill: ${done} / ${books.length} processed, ${filled} CV IDs found`);
    }
    // Yield every 50 books so we don't block the event loop
    if (done % 50 === 0) await new Promise(r => setImmediate(r));
  }
  logger.info('scanner', `ComicInfo disk backfill complete: ${done} processed, ${filled} CV IDs extracted`);
})();

// Prune only stale CV character cache entries (older than 30 days)
// — keeps good results, lets bad ones expire naturally
setImmediate(() => {
  try {
    const { changes } = db.prepare("DELETE FROM cv_character_cache WHERE cached_at < datetime('now', '-30 days')").run();
    if (changes > 0) console.log(`[cache] Pruned ${changes} stale CV character cache entries`);
  } catch(e) { console.warn('[cache] CV prune error:', e.message); }
});

// ─── series.json helpers ──────────────────────────────────────────
// seriesPath is the absolute folder path (e.g. /comics/DC Comics/Batman (2016))
function seriesJsonPath(seriesPath) {
  return path.join(seriesPath, 'series.json');
}

// Legacy compatibility: translate a komga-style /data/... URL to a real path
// Only used if old komga URL references are encountered during transition
function seriesJsonPathFromKomgaUrl(komgaUrl) {
  const stripped = komgaUrl.replace(/^\/data/, '');
  return path.join(COMICS_PATH, stripped, 'series.json');
}

// Copy a just-written series.json into the library row and drop cached copies,
// so the series page shows it without a folder rescan. One small file read.
function syncSeriesJsonRow({ seriesId = null, seriesPath = null } = {}) {
  try {
    const row = seriesId ? db.prepare('SELECT id, path FROM scanned_series WHERE id = ?').get(seriesId)
                         : db.prepare('SELECT id, path FROM scanned_series WHERE path = ?').get(seriesPath);
    if (!row) return false;
    const jsonPath = seriesJsonPath(row.path);
    if (!fs.existsSync(jsonPath)) return false;
    const content = fs.readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(content);
    db.prepare('DELETE FROM series_json_cache WHERE series_id = ?').run(row.id);
    jsonMemCache.delete(row.id);
    db.prepare('UPDATE scanned_series SET metadata_status = ?, series_json = ? WHERE id = ?').run(deriveMetadataStatus(parsed), content, row.id);
    invalidateSeriesCache();
    return true;
  } catch (e) { logger.warn('series.json', 'Library row not refreshed (next scan will)', { seriesId, seriesPath, error: e.message }); return false; }
}

function readSeriesJson(seriesPath) {
  try {
    const jsonPath = seriesJsonPath(seriesPath);
    const exists = fs.existsSync(jsonPath);
    logger.debug('series.json', `path lookup`, { seriesPath, jsonPath, exists });
    if (exists) {
      const raw = fs.readFileSync(jsonPath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    logger.error('series.json', `read error`, { seriesPath, error: e.message });
  }
  return null;
}

function getSeriesJsonCached(seriesId, seriesPath) {
  // 1. In-memory cache (fastest — no I/O)
  if (jsonMemCache.has(seriesId)) {
    const hit = jsonMemCache.get(seriesId);
    logger.debug('cache', `mem-hit`, { seriesId, found: hit !== null });
    return hit;
  }

  // 2. SQLite cache
  const cached = db.prepare('SELECT data, cached_at FROM series_json_cache WHERE series_id = ?').get(seriesId);
  if (cached) {
    const age = Date.now() - new Date(cached.cached_at).getTime();
    if (age < 3600000) {
      const parsed = JSON.parse(cached.data);
      jsonMemCache.set(seriesId, parsed);
      logger.debug('cache', `sqlite-hit`, { seriesId, age: Math.round(age/1000) + 's' });
      return parsed;
    }
    logger.debug('cache', `sqlite-expired`, { seriesId });
  }

  // 3. Disk read
  logger.debug('cache', `disk-read`, { seriesId, seriesPath });
  const data = readSeriesJson(seriesPath);
  jsonMemCache.set(seriesId, data);
  if (data) {
    db.prepare('INSERT OR REPLACE INTO series_json_cache (series_id, data, cached_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
      .run(seriesId, JSON.stringify(data));
    logger.info('cache', `loaded series.json`, { seriesId });
  } else {
    logger.debug('cache', `no series.json found`, { seriesId, seriesPath });
  }
  return data;
}

// ─── Award & rating helpers ───────────────────────────────────────
// Merge two arrays of strings, deduplicating case-insensitively
function mergeUnique(a, b) {
  const seen = new Set();
  const out  = [];
  for (const x of [...(a || []), ...(b || [])]) {
    if (!x) continue;
    const key = x.toLowerCase().trim();
    if (!seen.has(key)) { seen.add(key); out.push(x); }
  }
  return out;
}

// Module-level prepared statements for award lookup — never call db.prepare() inside a per-series function
const awardQueryExact  = db.prepare(`SELECT award, year, category, winner, cv_volume_id, cv_issue_id FROM award_data WHERE lower(series_name) = lower(?) AND COALESCE(kind, 'work') = 'work' AND (winner = 1 OR source IS NOT NULL)`);
const awardQueryStrip  = db.prepare(`SELECT award, year, category, winner, cv_volume_id, cv_issue_id FROM award_data WHERE lower(replace(replace(series_name, 'The ', ''), 'the ', '')) = lower(replace(replace(?, 'The ', ''), 'the ', '')) AND COALESCE(kind, 'work') = 'work' AND (winner = 1 OR source IS NOT NULL)`);

// Work awards for a title. Library screens know only Eisner and Harvey, so by default only those;
// Top Shelf passes { all: true } for Kirby, Hugo and Stoker too.
const LIBRARY_AWARDS = new Set(['eisner', 'harvey']);
function getSeriesAwards(title, opts = {}) {
  const rows = getSeriesAwardsAll(title);
  return opts.all ? rows : rows.filter(a => LIBRARY_AWARDS.has(a.award));
}
function getSeriesAwardsAll(title) {
  if (!title) return [];
  // Strip year suffix e.g. "Sandman (1989)" → "Sandman"
  const cleaned = title.replace(/\s*\(\d{4}(-\d{4}|s?)?\)\s*/g, '').trim();
  if (!cleaned) return [];

  // Try exact lowercase match first
  const exact = awardQueryExact.all(cleaned);
  if (exact.length > 0) return exact;

  // Fall back to stripping leading "The " for series like "The Vision" vs "Vision"
  const stripped = awardQueryStrip.all(cleaned);
  return stripped;
}

const ratingQuery = db.prepare(`SELECT cbr_score, cbr_count, cbr_url, user_score, user_count FROM series_ratings WHERE series_id = ?`);
function getSeriesRating(seriesId) {
  return ratingQuery.get(seriesId) || null;
}

function mergeSeriesWithJson(series) {
  // Support both scanned_series rows (have .path) and legacy Komga objects (have .url)
  const seriesPath = series.path || (series.url ? path.dirname(seriesJsonPathFromKomgaUrl(series.url)) : null);

  // Fast path: series_json column already on the DB row — zero extra I/O
  let jsonData = null;
  if (series.series_json) {
    try {
      jsonData = typeof series.series_json === 'string'
        ? JSON.parse(series.series_json) : series.series_json;
      if (!jsonMemCache.has(series.id)) jsonMemCache.set(series.id, jsonData);
    } catch {}
  } else {
    jsonData = seriesPath ? getSeriesJsonCached(series.id, seriesPath) : null;
  }

  // Derive base title and year from folder name as fallback
  const folderName = seriesPath ? path.basename(seriesPath) : (series.url || series.name || '').split('/').pop().split('\\').pop();
  // "(YYYY)" anchored at the end only: the old /^(.+?)\s*\((\d{4})\)\s*$/ could backtrack (CodeQL, 2026-11-12).
  const folderYearMatch = /\((\d{4})\)$/.exec(folderName.trim());
  const folderTitle = folderYearMatch ? folderName.trim().slice(0, folderYearMatch.index).trim() : folderName;
  const folderYear  = folderYearMatch ? parseInt(folderYearMatch[1]) : null;

  if (!jsonData || !jsonData.metadata) {
    const year = series.year || series.metadata?.year || folderYear;
    const baseTitle = series.name || series.metadata?.title || folderTitle || '';
    const displayTitle = year ? `${baseTitle} (${year})` : baseTitle;
    const creators0 = creatorsCache.get(series.id) || { writers: [], artists: [] };
    const baseTitle0 = series.name || series.metadata?.title || folderTitle || '';
    return { ...series, seriesJson: null, metadataStatus: 'none', displayTitle,
      displayDescription: series.metadata?.summary || '',
      displayEra: null, displayCharacters: [], displayGenres: series.metadata?.genres || [],
      displayStatus: series.metadata?.status || '', displayYear: year || null,
      displayPublicationRun: null, displayTotalIssues: series.book_count || series.booksCount || 0,
      displayWriters: creators0.writers, displayArtists: creators0.artists,
      displayTags: db.prepare('SELECT tag FROM series_user_tags WHERE series_id = ?').all(series.id).map(r => r.tag),
      displayAwards: getSeriesAwards(baseTitle0),
      displayRating: getSeriesRating(series.id),
      latestReleaseDate: latestReleaseDateCache.get(series.id) || null };
  }

  const m = jsonData.metadata;
  const rawTitle = m.name || series.name || series.metadata?.title || folderTitle || '';
  const year = m.year || series.year || series.metadata?.year || folderYear;
  const displayTitle = year ? `${rawTitle} (${year})` : rawTitle;

  const isEnriched = !!(m.comicid && (m.description_text || (Array.isArray(m.characters) && m.characters.length > 0)));
  const metadataStatus = isEnriched ? 'enriched' : 'basic';

  return {
    ...series,
    seriesJson: m,
    metadataStatus,
    displayTitle,
    displayDescription: m.description_text || m.description_formatted || series.metadata?.summary || '',
    displayEra:          m.era || null,
    displayCharacters:   Array.isArray(m.characters) ? m.characters : [],
    displayGenres:       Array.isArray(m.genres) ? m.genres : (series.metadata?.genres || []),
    displayStatus:       m.status || series.metadata?.status || '',
    displayYear:         year || null,
    displayPublicationRun: m.publication_run || null,
    displayTotalIssues:  m.total_issues || series.book_count || series.booksCount || 0,
    displayPublisher:    m.publisher || series.metadata?.publisher || '',
    displayImprint:      m.imprint || null,
    displayWriters:      mergeUnique((creatorsCache.get(series.id) || {}).writers, m.writers),
    displayArtists:      mergeUnique((creatorsCache.get(series.id) || {}).artists, m.artists),
    displayTags:         db.prepare('SELECT tag FROM series_user_tags WHERE series_id = ?').all(series.id).map(r => r.tag),
    displayAwards:       getSeriesAwards(rawTitle),
    displayRating:       getSeriesRating(series.id),
    latestReleaseDate:   latestReleaseDateCache.get(series.id) || null,
  };
}

// ─── Fetch all series from local scanner DB (replaces Komga fetch) ─
function fetchAllSeries(libraryId, search, tag) {
  const cacheKey = getSeriesCacheKey(libraryId);
  if (!search && !tag) {
    const hit = seriesCache.get(cacheKey);
    if (hit && (Date.now() - hit.ts) < SERIES_CACHE_TTL) return hit.data;
  }

  let sql = 'SELECT * FROM scanned_series WHERE 1=1';
  const params = [];
  if (libraryId) { sql += ' AND library_id = ?'; params.push(libraryId); }
  if (search)    { sql += ' AND (name LIKE ? OR path LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  // Sort key:
  //   1. Strip leading "The " (case-insensitive) — "The Sandman" sorts under S
  //   2. Case-insensitive — "watchmen" and "Watchmen" sort as equal
  //   3. Year as tiebreaker — same-named series (Green Lantern 1960, 1990, 2011…)
  //      now appear in chronological order instead of arbitrary insertion order
  // Substr+lower achieves "The "-strip without needing a stored generated column.
  sql += ` ORDER BY
    CASE WHEN lower(substr(name, 1, 4)) = 'the ' THEN lower(substr(name, 5)) ELSE lower(name) END ASC,
    COALESCE(year, 9999) ASC`;

  let rows = db.prepare(sql).all(...params);

  // tag filter: applied post-query via series.json genre/character match
  if (tag) {
    rows = rows.filter(s => {
      const json = getSeriesJsonCached(s.id, s.path);
      const genres = json?.metadata?.genres || [];
      const chars  = json?.metadata?.characters || [];
      return genres.includes(tag) || chars.includes(tag);
    });
  }

  if (!search && !tag) {
    seriesCache.set(cacheKey, { data: rows, ts: Date.now() });
  }
  return rows;
}

// ─── SCANNER INFRASTRUCTURE ───────────────────────────────────────
const COMIC_EXTS = /\.(cbz|cbr|zip|rar|pdf)$/i;

// Extract ComicInfo.xml text from a comic archive using bsdtar
// Read ComicInfo.xml from a comic archive.
// Returns the XML text, '' when the archive was read but has no ComicInfo.xml,
// or null when no tool could open the file (so it's retried later).
//
// The old version asked bsdtar for a top-level "ComicInfo.xml" only, and threw
// away the output whenever bsdtar exited non-zero — which it does on harmless
// warnings about other entries' filenames. On 2026-10-08 that missed the tags in
// 935 of 1,874 files that had them. Now: ZIPs are read directly (yauzl), RARs
// with unrar, matching ComicInfo.xml in any folder and any capitalisation; the
// file's real format is tried even when the extension is wrong (.cbz that's RAR).
const COMICINFO_RE = /(^|[\/\\])comicinfo\.xml$/i;
const COMICINFO_MAX = 4 * 1024 * 1024;

function readZipComicInfo(filePath) {
  return new Promise(resolve => {
    let yauzl;
    try { yauzl = require('yauzl'); } catch { return resolve(null); }
    yauzl.open(filePath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return resolve(null);
      let done = false;
      let result = null;
      // Reading the last XML byte is not the end of the file consumer. The
      // access barrier must also wait for yauzl to release its descriptor.
      zip.once('close', () => { done = true; resolve(result); });
      const finish = v => { if (done) return; done = true; result = v; zip.close(); };
      zip.on('error', () => finish(null));
      // Same rule as the metadata pipeline: the top-level ComicInfo.xml wins;
      // an empty top-level file falls back to the one non-empty nested copy.
      const found = [];
      zip.on('end', () => {
        const root = found.filter(f => !/[\/\\]/.test(f.name)), filled = found.filter(f => f.text.trim());
        if (!found.length) return finish('');
        if (root.length === 1 && root[0].text.trim()) return finish(root[0].text);
        if (filled.length === 1 && root.length <= 1) return finish(filled[0].text);
        finish((root[0] || found[0]).text);
      });
      zip.on('entry', entry => {
        if (/\/$/.test(entry.fileName) || !COMICINFO_RE.test(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (e2, stream) => {
          if (e2 || !stream) return finish(null);
          const chunks = []; let size = 0;
          stream.on('data', c => {
            size += c.length;
            if (size > COMICINFO_MAX) { stream.destroy(); finish(null); } else chunks.push(c);
          });
          stream.on('end', () => { found.push({ name: entry.fileName, text: Buffer.concat(chunks).toString('utf8') }); zip.readEntry(); });
          stream.on('error', () => finish(null));
        });
      });
      zip.readEntry();
    });
  });
}

async function readRarComicInfo(filePath) {
  const opts = { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LANG: 'C', LC_ALL: 'C' } };
  let list;
  try { ({ stdout: list } = await execFileAsync('unrar', ['lb', filePath], opts)); }
  catch (e) { list = e.stdout || ''; }
  if (!list) return null;
  const member = list.split(/\r?\n/).map(l => l.trim()).find(l => COMICINFO_RE.test(l));
  if (!member) return '';
  try {
    const { stdout } = await execFileAsync('unrar', ['p', '-inul', filePath, '--', member], { ...opts, encoding: 'buffer' });
    return stdout.length ? stdout.toString('utf8') : null;
  } catch (e) {
    return e.stdout && e.stdout.length ? Buffer.from(e.stdout).toString('utf8') : null;
  }
}

async function extractComicInfo(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const order = (ext === '.cbr' || ext === '.rar')
    ? [readRarComicInfo, readZipComicInfo]
    : [readZipComicInfo, readRarComicInfo];
  for (const reader of order) {
    try {
      const xml = await reader(filePath);
      if (xml !== null) return xml;        // opened: XML text, or '' for "no ComicInfo"
    } catch { /* try the next reader */ }
  }
  // Last resort for other archive types (7z, tar): the original bsdtar call,
  // keeping its output even when it exits non-zero on warnings.
  try {
    const { stdout } = await execFileAsync('bsdtar', ['-p', '-O', '-xf', filePath, 'ComicInfo.xml'], { maxBuffer: COMICINFO_MAX, env: { ...process.env, LANG: 'C', LC_ALL: 'C' } });
    return stdout || null;
  } catch (e) { return e.stdout || null; }
}

// List all files inside an archive
async function listArchiveFiles(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.cbz' || ext === '.zip') {
      // Use 7z l for CBZ — outputs literal filenames, handles brackets/special chars
      const { stdout } = await execFileAsync('7z', ['l', '-ba', '-slt', filePath]);
      // 7z -slt outputs "Path = filename" lines
      const files = [];
      for (const line of stdout.split('\n')) {
        const m = line.match(/^Path = (.+)$/);
        if (m) files.push(m[1].trim());
      }
      return files;
    } else {
      // CBR/RAR — use unrar (RARLab binary) which handles all RAR variants
      // including older files with non-UTF8 filenames that bsdtar cannot parse
      // unrar lb = list bare filenames only
      // unrar exits 3 on some old Mac-made RARs (unsupported sub-blocks) after
      // listing every member (Fantastic Four #107, 2026-10-16): keep that list.
      let listed = '';
      try { ({ stdout: listed } = await execFileAsync('unrar', ['lb', filePath], { maxBuffer: 16 * 1024 * 1024 })); }
      catch (e) { listed = e.stdout ? String(e.stdout) : ''; }
      const rarFiles = String(listed).split('\n').map(s => s.trim()).filter(Boolean);
      if (rarFiles.length > 0) return rarFiles;
      // unrar returned empty — may be a ZIP misnamed as CBR, fall through
      // Fallback: try as ZIP (some CBRs are actually ZIP archives)
      try {
        const { stdout } = await execFileAsync('7z', ['l', '-ba', '-slt', filePath]);
        const files = [];
        for (const line of stdout.split('\n')) {
          const m = line.match(/^Path = (.+)$/);
          if (m) files.push(m[1].trim());
        }
        if (files.length > 0) {
          logger.debug('thumb', `CBR is actually a ZIP: ${path.basename(filePath)}`);
          return files;
        }
      } catch {}
      try {
        const { stdout } = await execFileAsync('bsdtar', ['-tf', filePath], { maxBuffer: 16 * 1024 * 1024 });
        return stdout.split('\n').map(s => s.replace(/\r$/, '')).filter(Boolean);
      } catch {}
      return [];
    }
  } catch { return []; }
}

// ─── One archive member as a Buffer ───────────────────────────────
// Reader pages, page thumbnails, cover thumbnails and Comic Book Guy's page view.
// - Member names go after "--": "-= cover =-.jpg" was read as a command switch
//   (Fantastic Four #104, 2026-10-16).
// - unrar exits 3 on some old Mac-made RARs (unsupported sub-blocks) after writing
//   the page correctly (Fantastic Four #107): output that is a complete image is kept.
function completeImage(buf) {
  if (!buf || buf.length < 64) return false;
  const b = Buffer.from(buf);
  if (b[0] === 0xFF && b[1] === 0xD8) return b.subarray(Math.max(0, b.length - 2048)).includes(Buffer.from([0xFF, 0xD9]));
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return b.subarray(-16).includes(Buffer.from('IEND'));
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return b.readUInt32LE(4) + 8 <= b.length;
  if (b.subarray(0, 3).toString('latin1') === 'GIF') return b[b.length - 1] === 0x3B;
  return false;
}
async function readArchiveMember(filePath, member, maxBuffer = 30 * 1024 * 1024) {
  const zip = /\.(cbz|zip)$/i.test(filePath);
  const C = { ...process.env, LANG: 'C', LC_ALL: 'C' };
  const unrar = ['unrar', ['p', '-inul', '-y', filePath, '--', member]];
  const sevenZip = ['7z', ['e', '-so', filePath, '--', member]];
  const tar = ['bsdtar', ['-p', '-O', '-xf', filePath, '--', member.replace(/[\\*?[\]]/g, '\\$&')], C];   // bsdtar names are patterns
  let last = null;
  for (const [tool, args, env] of zip ? [sevenZip, tar, unrar] : [unrar, sevenZip, tar]) {
    try {
      const { stdout } = await execFileAsync(tool, args, { maxBuffer, encoding: 'buffer', ...(env ? { env } : {}) });
      if (stdout && stdout.length) return stdout;
    } catch (e) {
      if (e.stdout && completeImage(e.stdout)) return Buffer.from(e.stdout);
      last = e;
    }
  }
  throw last || new Error(`Archive member not found: ${member}`);
}

// Filter an archive file list to real image files only.
// Excludes Apple double files (__MACOSX, ._prefix) and non-image entries.
function filterImages(files) {
  return files.filter(f =>
    /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(f) &&
    !f.includes('__MACOSX') &&
    !path.basename(f).startsWith('._')
  ).sort();
}

// Returns true if the archive at filePath contains a ComicInfo.xml entry at the
// root or anywhere inside. Returns null if the archive can't be read — callers
// should treat null as "unknown" and not flip an existing value.
async function archiveHasComicInfo(filePath) {
  try {
    const files = await listArchiveFiles(filePath);
    if (!files || files.length === 0) return null;
    // Match "ComicInfo.xml" case-insensitively, at root or nested.
    return files.some(f => /(^|[\\/])ComicInfo\.xml$/i.test(f));
  } catch {
    return null;
  }
}

// Parse ComicInfo.xml text into a plain object
function parseComicInfo(xmlText) {
  if (!xmlText) return {};
  try {
    const get = (tag) => { const m = xmlText.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : null; };
    return {
      title:         get('Title'),
      series:        get('Series'),
      number:        get('Number'),
      volume:        get('Volume'),
      year:          get('Year') ? parseInt(get('Year')) : null,
      publisher:     get('Publisher'),
      writer:        get('Writer'),
      penciller:     get('Penciller'),
      inker:         get('Inker'),
      colorist:      get('Colorist'),
      coverArtist:   get('CoverArtist'),
      characters:    get('Characters'),
      summary:       get('Summary'),
      genre:         get('Genre'),
      pageCount:     get('PageCount') ? parseInt(get('PageCount')) : null,
      web:           get('Web'),
    };
  } catch { return {}; }
}

// Extract CV issue ID from ComicInfo XML text
// Checks <Web> URL (4000-NNNNN) then <Notes> field ([Issue ID NNNNN])
function extractCvIdFromComicInfo(xmlText) {
  return require('./metadata/evidence').parseComicInfoEvidence(xmlText).identity.cvIssueId;
}

// Determine metadata_status from a series.json object
// Aggregate creators across all scanned_books ComicInfo.xmls for a series.
// Returns [{ name, role }] sorted by occurrence count desc, deduped.
// Roles: writer, penciller, inker, colorist, coverArtist
function aggregateCreatorsFromBooks(seriesId) {
  const books = db.prepare(
    'SELECT comicinfo FROM scanned_books WHERE series_id = ? AND comicinfo IS NOT NULL'
  ).all(seriesId);

  const counts = {}; // "role::name" -> count
  books.forEach(b => {
    const ci = parseComicInfo(b.comicinfo);
    const roleFields = [
      ['writer',      ci.writer],
      ['penciller',   ci.penciller],
      ['inker',       ci.inker],
      ['colorist',    ci.colorist],
      ['coverArtist', ci.coverArtist],
    ];
    roleFields.forEach(([role, val]) => {
      if (!val) return;
      val.split(',').map(n => n.trim()).filter(Boolean).forEach(name => {
        const key = `${role}::${name}`;
        counts[key] = (counts[key] || 0) + 1;
      });
    });
  });

  // Sort by count desc, then alphabetically
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a || 0)
    .map(([key]) => {
      const sep = key.indexOf('::');
      return { role: key.slice(0, sep), name: key.slice(sep + 2) };
    });
}

// In-memory latest release date cache — most recent issue date per scanned_series.id.
// Two-pass strategy so both monitored and unmonitored (concluded) series sort correctly:
//   Pass 1 — monitored: join scanned_series → monitored_series → monitored_issues for
//             structured store_date/release_date. Keyed by scanned_series.id.
//   Pass 2 — unmonitored: parse Year/Month/Day from ComicInfo XML in scanned_books.
//             Fills gaps for any series without a monitored_series_id.
function warmLatestReleaseDateCache() {
  try {
    latestReleaseDateCache.clear();

    // Pass 1: monitored series — pull dates from monitored_issues via the FK bridge.
    const monitoredRows = db.prepare(`
      SELECT ss.id AS series_id, MAX(COALESCE(mi.store_date, mi.release_date)) AS latest_date
      FROM scanned_series ss
      JOIN monitored_issues mi ON mi.series_id = ss.monitored_series_id
      WHERE ss.monitored_series_id IS NOT NULL
        AND (mi.store_date IS NOT NULL OR mi.release_date IS NOT NULL)
      GROUP BY ss.id
    `).all();
    for (const row of monitoredRows) {
      if (row.latest_date) latestReleaseDateCache.set(row.series_id, row.latest_date);
    }

    // Pass 2: unmonitored series — extract dates from ComicInfo XML stored in scanned_books.
    // Only runs for series not already covered by Pass 1.
    const unmonitoredBooks = db.prepare(`
      SELECT sb.series_id, sb.comicinfo
      FROM scanned_books sb
      JOIN scanned_series ss ON ss.id = sb.series_id
      WHERE ss.monitored_series_id IS NULL
        AND sb.comicinfo IS NOT NULL
    `).all();

    const ciDates = new Map(); // series_id → max ISO date string found in comicinfo
    for (const book of unmonitoredBooks) {
      const ci = book.comicinfo;
      if (!ci) continue;
      const yearM  = ci.match(/<Year>(\d{4})<\/Year>/);
      if (!yearM) continue;
      const monthM = ci.match(/<Month>(\d{1,2})<\/Month>/);
      const dayM   = ci.match(/<Day>(\d{1,2})<\/Day>/);
      const dateStr = `${yearM[1]}-${(monthM ? monthM[1] : '1').padStart(2,'0')}-${(dayM ? dayM[1] : '1').padStart(2,'0')}`;
      const existing = ciDates.get(book.series_id);
      if (!existing || dateStr > existing) ciDates.set(book.series_id, dateStr);
    }
    for (const [sid, date] of ciDates) latestReleaseDateCache.set(sid, date);

    console.log(`[cache] Warmed latest release dates for ${latestReleaseDateCache.size} series`);
  } catch (e) {
    console.warn('[cache] Failed to warm latest release date cache:', e.message);
  }
}

function deriveMetadataStatus(jsonData) {
  if (!jsonData?.metadata) return 'none';
  const m = jsonData.metadata;
  const isEnriched = !!(m.comicid && (m.description_text || (Array.isArray(m.characters) && m.characters.length > 0)));
  return isEnriched ? 'enriched' : 'basic';
}

// Extract issue number from filename (reuses existing extractIssueNumber logic defined later)
// Simple version used during scanning — full version used in download manager
function extractNumberFromFilename(filename) {
  const base = path.basename(filename, path.extname(filename));
  // Manga volume format: v002, v27, Vol.99, Vol 1 — must come first for manga filenames
  const volM = base.match(/v(?:ol(?:ume)?)?\.?\s*0*(\d+)/i);
  if (volM) return String(parseInt(volM[1], 10));
  // Try #NNN pattern first (e.g. "Batman #007")
  let m = base.match(/#(\d+(?:\.\d+)?)/);
  if (m) return m[1];
  // Milestone numbers (5+ digits) e.g. "Legion 1000000 (1998)" — DC One Million etc.
  // Must come before year-stripping to avoid confusing the year for the issue number.
  const milestoneM = base.match(/(?:^|[\s#_])(\d{5,})(?:\s|$|\()/);
  if (milestoneM) return String(parseInt(milestoneM[1], 10));
  // ISO cover-date format: "Series, 1982-11-00 ( 08) (tag) (Group)"
  // Also handles underscore variant: "Series, 1978-06-00 (_01) (digital) (Group)"
  // Used by Glorith/Novus/Empire/Novus-HD scene groups. Strip the date then look for parens.
  const dateStripped = base.replace(/\b(19|20)\d{2}-\d{2}-\d{2}\b\s*/g, '');
  const spM = dateStripped.match(/\([\s_]+(\d{1,4})\s*\)/);
  if (spM) { const n = parseInt(spM[1], 10); if (!(n >= 1900 && n <= 2099)) return String(n); }
  // Strip trailing noise in parens after (YYYY): "Series 002 (2019) (Digital) (Tag)" → "Series 002 (2019)"
  const stripped = base.replace(/\(\d{4}\).*$/, s => s.match(/^\(\d{4}\)/) ? s.match(/^(\(\d{4}\))/)[1] : s);
  // Try "Series NNN (YYYY)" — number before a year in parens
  m = stripped.match(/\s(\d{1,4})\s*\(\d{4}\)\s*$/);
  if (m) return String(parseInt(m[1], 10));
  // Try trailing number
  m = stripped.match(/\s(\d{1,4})\s*$/);
  if (m) return m[1];
  return null;
}

// In-memory scan state
let scanState = {
  running: false,
  libraryId: null,
  progress: 0,
  total: 0,
  currentPath: '',
  startedAt: null,
  completedAt: null,
  errors: [],
};

// A downloaded issue's file is gone (deleted in Omnibus, or missing when the
// scanner looks): its monitored issue goes back to WANTED so the next wanted
// scan fetches it again (user decision 2026-10-15). Only when no other copy of
// that issue is still in the library. A whole series folder disappearing does
// not do this (it may be a mount problem; the scanner already guards that).
function monitoredIssueGone(book, why) {
  try {
    const ids = new Set();
    if (book.monitored_issue_id) ids.add(String(book.monitored_issue_id));
    if (book.cv_issue_id) ids.add(String(book.cv_issue_id));
    if (book.path) for (const r of db.prepare('SELECT id FROM monitored_issues WHERE file_path = ?').all(book.path)) ids.add(String(r.id));
    for (const id of ids) {
      const mi = db.prepare("SELECT id, series_id, issue_number FROM monitored_issues WHERE id = ? AND status = 'processed'").get(id);
      if (!mi) continue;
      const other = db.prepare('SELECT 1 FROM scanned_books WHERE id <> ? AND (cv_issue_id = ? OR monitored_issue_id = ?) LIMIT 1').get(String(book.id), id, id);
      if (other) continue;
      db.prepare(`UPDATE monitored_issues SET status = 'wanted', file_path = NULL, download_id = NULL, date_processed = NULL,
        retry_after = NULL, retry_epoch = NULL, weekly_retries = 0, fail_count = 0, last_fail_reason = NULL WHERE id = ? AND status = 'processed'`).run(id);
      logger.info('monitor', `Issue ${id} back to wanted: file ${why}`, { seriesId: mi.series_id, issue: mi.issue_number, path: book.path });
    }
  } catch (e) { logger.warn('monitor', 'Could not update the monitored issue for a removed file', e.message); }
}

// Core scanner — walks a library's path and upserts scanned_series + scanned_books
// ─── Event Reconciliation ─────────────────────────────────────────
// Runs after every library scan. For each event_issue that has a cv_issue_id
// but no scanned_book_id, tries to match against scanned_books using 5-level hierarchy.
// scanChanged: true if the scan added or removed any books — enables invalidation passes.
// When false (nothing changed on disk), skip the expensive invalidation passes entirely
// since they would just clear and re-match the same issues as last time.
const completeEventReconcile = require('./metadata/completionQueue').createCompletionQueue();
// "X Annual" #2025 (a year where the number should be) → "X 2025 Annual" #1,
// Comic Vine's name for year-titled annuals. null when it is not that shape.
function yearAnnual(seriesName, issueNumber) {
  const name = String(seriesName || ''), num = String(issueNumber ?? '').trim();
  if (!/^(?:19|20)\d{2}$/.test(num) || !/\bannual\b/i.test(name) || /\b(?:19|20)\d{2}\b/.test(name)) return null;
  return { name: name.replace(/\s*\bannual\b/i, ` ${num} Annual`).replace(/\s+/g, ' ').trim(), year: Number(num) };
}
const {eventYearMatches}=require('./metadata/eventYear');
function reconcileEventIssues(scanChanged = true, options = {}) {
  return completeEventReconcile(() => runEventReconcile(scanChanged, options));
}
async function runEventReconcile(scanChanged = true, { strict = false } = {}) {
  const yieldLoop = () => new Promise(r => setImmediate(r));
  // Was the book PUBLISHED under this number? Specials and minis filed in a
  // parent folder carry folder numbers like 0.2 (Rebirth #2); their ComicInfo
  // still says #2. Such a book passes the number checks below.
  const publishedAs = (bookId, num) => { try { return !!bookId && bookIndex.publishedAs(bookId, num); } catch { return false; } };

  if (scanChanged) {
    // Pass 1: clear stale matches where the scanned book no longer exists on disk
    // Skip manually_matched — user chose this intentionally, don't auto-clear it
    db.prepare(`
      UPDATE event_issues SET scanned_book_id = NULL
      WHERE scanned_book_id IS NOT NULL
        AND (manually_matched IS NULL OR manually_matched = 0)
        AND scanned_book_id NOT IN (SELECT id FROM scanned_books)
        AND scanned_book_id NOT IN (SELECT id FROM missing_books)
    `).run();

    await yieldLoop(); // yield between passes so HTTP requests can be served

    // Pass 2: validate existing matches — clear any where the matched book's issue_number
    // differs from the event issue's expected number by more than 1.
    // This catches hallucinated cv_issue_ids that matched the wrong book (e.g. Legends #1
    // being matched to Legends of the Dark Knight #137 via a bad CV ID).
    const existingMatches = db.prepare(`
      SELECT ei.id, ei.issue_number AS ei_num, sb.issue_number AS sb_num, sb.id AS book_id
      FROM event_issues ei
      JOIN scanned_books sb ON sb.id = ei.scanned_book_id
      WHERE ei.scanned_book_id IS NOT NULL
        AND (ei.manually_matched IS NULL OR ei.manually_matched = 0)
    `).all();

    const normN = n => parseFloat(String(n || '0').replace(/,/g, '')) || 0;
    let invalidated = 0;
    for (const row of existingMatches) {
      if (row.sb_num === null || row.sb_num === undefined) continue; // no number — keep
      if (publishedAs(row.book_id, row.ei_num)) continue;             // retag-filed book, published as this number — keep
      if (Math.abs(normN(row.sb_num) - normN(row.ei_num)) > 1) {
        db.prepare('UPDATE event_issues SET scanned_book_id = NULL WHERE id = ?').run(row.id);
        invalidated++;
      }
    }
    if (invalidated > 0) logger.warn('events', `Invalidated ${invalidated} bad event matches (issue number mismatch)`);

    await yieldLoop(); // yield before year-mismatch pass

    // Pass 2b: year mismatch — clear matches where volume_year is known and the matched
    // book's ComicInfo <Year> is more than 4 years away. This catches wrong-volume matches
    // that share the same issue number (e.g. Superman #3 from 1940 matched to a 1986 event).
    // SKIP: matches where the book's cv_issue_id directly matches — these are trusted L1
    // matches and the year guard has no business clearing them (causes the clear-rematch cycle).
    const yearMatches = db.prepare(`
      SELECT ei.id, ei.volume_year, ei.cv_issue_id AS event_cv_issue_id, sb.cv_issue_id, sb.comicinfo, ss.year as syear
      FROM event_issues ei
      JOIN scanned_books sb ON sb.id = ei.scanned_book_id
      JOIN scanned_series ss ON ss.id = sb.series_id
      WHERE ei.scanned_book_id IS NOT NULL AND ei.volume_year IS NOT NULL
        AND (ei.manually_matched IS NULL OR ei.manually_matched = 0)
        AND (ei.cv_issue_id IS NULL OR sb.cv_issue_id != ei.cv_issue_id)
    `).all();

    let yearInvalidated = 0;
    for (const row of yearMatches) {
      if (!eventYearMatches({volumeYear:row.volume_year,cvIssueId:row.event_cv_issue_id,book:row})) {
        db.prepare('UPDATE event_issues SET scanned_book_id = NULL WHERE id = ?').run(row.id);
        yearInvalidated++;
      }
    }
    if (yearInvalidated > 0) logger.warn('events', `Invalidated ${yearInvalidated} bad event matches (year mismatch)`);

    await yieldLoop(); // yield before main matching loop
  }

  const eventIssues = db.prepare(
    // Query ALL unmatched issues — cv_issue_id may be null for AI-generated orders
    "SELECT * FROM event_issues WHERE scanned_book_id IS NULL"
  ).all();
  if (!eventIssues.length) return;

  let matched = 0;
  const update = db.prepare('UPDATE event_issues SET scanned_book_id = ? WHERE id = ? AND scanned_book_id IS NULL AND COALESCE(manually_matched,0)=0');

  // Canonical issue-number form. Delegates to issueNumber module so the
  // reconciler, scanner, search, and CV arc lookup all agree on shape.
  // Returns "0" when input is unparseable (preserves old fallback behaviour).
  const normIssueNum = n => IN.normIssueNumber(n) || '0';

  // Words considered noise — present-or-absent doesn't change series identity.
  // Used by the L4 name matcher to decide if two normalized names that look
  // similar are actually the same series with different filler-word treatment
  // ("Wolverine and the X-Men" vs "Wolverine the X-Men"), or whether one has
  // a meaningful additional word that makes it a different series ("Avengers"
  // vs "New Avengers").
  const SERIES_NOISE_WORDS = new Set(['the', 'and', 'of', 'a', 'an']);

  /**
   * Normalize a series name to a sorted set of significant words.
   * Strips punctuation, lowercases, splits on whitespace, drops noise words.
   * "Wolverine & the X-Men" → ["men", "wolverine", "x"]
   * "Wolverine and the X-Men" → ["men", "wolverine", "x"]
   * "New Avengers" → ["avengers", "new"]
   * "Avengers" → ["avengers"]
   */
  const sigWordSet = (name) => {
    return new Set(
      String(name || '').toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w && !SERIES_NOISE_WORDS.has(w))
    );
  };

  // Extract cover year from stored ComicInfo XML
  const ciYear = (comicinfo) => {
    if (!comicinfo) return null;
    const m = comicinfo.match(/<Year>(\d{4})<\/Year>/i);
    return m ? parseInt(m[1]) : null;
  };

  for (let ei of eventIssues) {
    try {
      const eiNum = normIssueNum(ei.issue_number);

      // Sanity-check helper: reject a candidate book if its issue number differs
      // meaningfully from the event issue's. Guards against AI-hallucinated
      // cv_issue_ids causing cross-series matches.
      //
      // Suffix-aware: "8" and "8.AU" must NOT pass — they're different issues
      // even though parseFloat would call them equal. When both sides are
      // plain-numeric (no allow-listed suffix), keep the original ±1 tolerance
      // so off-by-one parsing artefacts don't reject legitimate matches.
      const passesNumCheck = (bookRow) => {
        if (!bookRow) return false;
        if (!bookRow.issue_number) return true; // no number stored — benefit of the doubt
        if (publishedAs(bookRow.id, ei.issue_number)) return true; // filed under another number, published as this one
        const aCanon = normIssueNum(bookRow.issue_number);
        const bCanon = eiNum;
        if (aCanon === bCanon) return true;
        // If either side carries a suffix (e.g. ".AU"), require strict equality.
        // Different suffixes = different issues, no tolerance allowed.
        if (aCanon.includes('.') || bCanon.includes('.')) return false;
        const diff = Math.abs(parseFloat(aCanon) - parseFloat(bCanon));
        return diff <= 1;
      };

      // Level 1: direct cv_issue_id match — trusted unconditionally.
      // A correct CV ID is an exact DB lookup. Year guards do not belong here —
      // long-running series (Batman 1940, JLA 1960) have volume_year far from their
      // issue cover date, causing false rejections. Only the issue number sanity check applies.
      let book = ei.cv_issue_id
        ? db.prepare("SELECT id, issue_number FROM scanned_books WHERE cv_issue_id = ? LIMIT 1").get(ei.cv_issue_id)
        : null;
      if (book && !passesNumCheck(book)) {
        logger.warn('events', `L1 cv_issue_id match rejected — issue number mismatch (bad AI cv_issue_id, nulling)`, { ei_series: ei.series_name, ei_num: ei.issue_number, book_num: book.issue_number });
        // Null out the bad cv_issue_id so it stops being tried every reconcile cycle.
        // The correct cv_issue_id can be restored by re-generating or manually tagging the event.
        db.prepare('UPDATE event_issues SET cv_issue_id = NULL WHERE id = ?').run(ei.id);
        ei = { ...ei, cv_issue_id: null }; // update local copy for L2/L3
        book = null;
      }

      // Level 2: monitored_issue_id match — same trust level as L1
      if (!book && ei.cv_issue_id) {
        book = db.prepare("SELECT id, issue_number FROM scanned_books WHERE monitored_issue_id = ? LIMIT 1").get(ei.cv_issue_id);
        if (book && !passesNumCheck(book)) {
          logger.warn('events', `L2 monitored_id match rejected — issue number mismatch`, { ei_series: ei.series_name, ei_num: ei.issue_number, book_num: book.issue_number });
          book = null;
        }
      }

      // Level 3: ComicInfo XML LIKE fallback
      if (!book && ei.cv_issue_id) {
        const webPattern   = `%4000-${ei.cv_issue_id}%`;
        const notesPattern = `%[Issue ID ${ei.cv_issue_id}]%`;
        book = db.prepare(`
          SELECT id, issue_number FROM scanned_books
          WHERE comicinfo LIKE ? OR comicinfo LIKE ?
          LIMIT 1
        `).get(webPattern, notesPattern);
        if (book && !passesNumCheck(book)) {
          logger.warn('events', `L3 comicinfo match rejected — issue number mismatch`, { ei_series: ei.series_name, ei_num: ei.issue_number, book_num: book.issue_number });
          book = null;
        }
      }

      // Level 3b: the name and number each book was PUBLISHED under (ComicInfo
      // index). Year-named annuals are their own Comic Vine volumes: an event
      // row "Batman/Superman: World's Finest Annual" #2025 is published as
      // "Batman/Superman: World's Finest 2025 Annual" #1, filed in the parent
      // folder, so the folder-name levels below never find it.
      if (!book && ei.series_name) {
        const ya = yearAnnual(ei.series_name, ei.issue_number);
        const name = ya ? ya.name : ei.series_name, num = ya ? '1' : ei.issue_number, year = ya ? ya.year : ei.volume_year;
        try {
          // A year is required: without one, "Green Lantern" #1 could be any volume's #1.
          const hit = num != null && year ? bookIndex.lookup(name, year).get(normIssueNum(num)) : null;
          if (hit) book = { id: hit.book_id, issue_number: hit.folder_number };
        } catch (e) { logger.warn('events', 'Published-name lookup failed', e.message); }
      }

      // Level 4: series name normalised + issue number
      // Year guard: prefer ComicInfo <Year> (issue cover year) over ss.year (series folder year).
      // When multiple candidates pass the name+year filter, pick the one CLOSEST to volume_year
      // rather than just the first — prevents GL (1990) beating GL (2004) for an IC event issue.
      if (!book) {
        const normName = ei.series_name.toLowerCase().replace(/[^a-z0-9]/g, '');
        const eiYear = ei.volume_year ? parseInt(ei.volume_year) : null;
        const candidates = db.prepare(`
          SELECT sb.id, sb.issue_number, sb.comicinfo, ss.name as sname, ss.year as syear FROM scanned_books sb
          JOIN scanned_series ss ON ss.id = sb.series_id
          WHERE sb.issue_number = ?
        `).all(ei.issue_number);

        const eiIsAnnual = /annual/i.test(ei.series_name);

        // Score each candidate: null = fails filter, otherwise distance from eiYear (lower = better)
        const scoreCand = (cand) => {
          if (!eiIsAnnual && /annual/i.test(cand.sname || '')) return null;
          const cNorm = (cand.sname || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          // Name match — word-set equality after stripping filler words.
          //
          // The strategy: split each name into its set of significant words
          // (dropping "the", "and", "of", etc.). Two names match if their
          // significant-word sets are identical. This cleanly handles:
          //   - "Wolverine and the X-Men" vs "Wolverine & the X-Men"
          //     → both → {wolverine, x, men} → match
          //   - "Avengers" vs "New Avengers"
          //     → {avengers} vs {new, avengers} → DIFFERENT, no match
          //   - "Wolverine" vs "Wolverines"
          //     → {wolverine} vs {wolverines} → DIFFERENT, no match (plural is a different word)
          //   - "The Fantastic Four" vs "Fantastic Four"
          //     → both → {fantastic, four} → match
          //
          // Falls back to exact normalized equality if word-set parsing fails
          // (defensive — shouldn't happen but cheap to keep).
          const eiWords = sigWordSet(ei.series_name);
          const cWords  = sigWordSet(cand.sname || '');
          const wordsMatch =
            eiWords.size === cWords.size
            && eiWords.size > 0
            && [...eiWords].every(w => cWords.has(w));
          const nameMatch = wordsMatch || cNorm === normName;
          if (!nameMatch) return null;
          const bookYear = ciYear(cand.comicinfo) || (cand.syear ? parseInt(cand.syear) : null);
          if (eiYear && bookYear && Math.abs(bookYear - eiYear) > 4) return null; // year too far
          // Distance: if we know both years, use distance; otherwise treat as worst passing score
          const dist = (eiYear && bookYear) ? Math.abs(bookYear - eiYear) : 5;
          return { id: cand.id, dist };
        };

        let best = null;
        for (const cand of candidates) {
          const score = scoreCand(cand);
          if (!score) continue;
          if (!best || score.dist < best.dist) best = score;
        }
        if (best) book = { id: best.id };
      }

      // Level 5: fuzzy filename — series words + issue number in filename
      // The padded LIKE (%001%) is only a pre-filter; we then extract the actual issue
      // number from the filename and verify it matches. This prevents %001% matching
      // inside a year like "2001" in "Batman_-_LOTDK_137_(2001).cbz".
      // We also require the candidate's series name to be similar enough to the event
      // series name — prevents "Legends" matching "Batman: Legends of the Dark Knight".
      // Year guard applied here too when volume_year is known.
      if (!book) {
        const words = ei.series_name.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const eiNorm = ei.series_name.toLowerCase().replace(/[^a-z0-9]/g, '');
        // Preserve dot-decimals (648.1) and suffixes — parseInt would truncate
        // these to the base integer and cause the LIKE search to match the
        // wrong issue (#648 instead of #648.1, which are different stories).
        const eiNumRaw = String(ei.issue_number || '').trim();
        // Numeric form for the post-filter sanity check below — converts "648.1"
        // to 648.1 (keeps decimal) so we can compare against extractNumberFromFilename
        // results. parseInt would lose the decimal here too.
        const eiNumNumeric = parseFloat(eiNumRaw) || 0;
        const eiYear = ei.volume_year ? parseInt(ei.volume_year) : null;
        const numStr = padIssueNumStr(eiNumRaw, 3);
        if (words.length > 0) {
          const candidates = db.prepare(`
            SELECT sb.id, sb.filename, sb.comicinfo, ss.name as sname, ss.year as syear FROM scanned_books sb
            JOIN scanned_series ss ON ss.id = sb.series_id
            WHERE sb.filename LIKE ?
          `).all(`%${numStr}%`);
          const eiIsAnnual_l5 = /annual/i.test(ei.series_name);
          for (const c of candidates) {
            // Annual guard — don't match annual filenames to non-annual event issues
            if (!eiIsAnnual_l5 && /annual/i.test(c.filename)) continue;
            // Year guard — ComicInfo issue year preferred, fall back to series year
            if (eiYear) {
              const bookYear = ciYear(c.comicinfo) || (c.syear ? parseInt(c.syear) : null);
              if (bookYear && Math.abs(bookYear - eiYear) > 4) continue;
            }
            const fn = c.filename.toLowerCase();
            // 1. Verify extracted issue number from filename actually matches (not a year substring).
            //    parseFloat to preserve decimals — extractNumberFromFilename returns "648.1" for
            //    Point One issues; comparing against eiNumNumeric (also float) keeps the match working.
            const fnNum = parseFloat(extractNumberFromFilename(c.filename) || '-1');
            if (Math.abs(fnNum - eiNumNumeric) > 1) continue;
            // 2. Series name word-set match — must share all significant
            //    words (filler words dropped) to avoid "Legends" matching
            //    "Batman Legends of the Dark Knight". This is the same rule
            //    L4 uses; consistency prevents L5 from matching cases L4
            //    would correctly reject as different series.
            const candWords = sigWordSet(c.sname || '');
            const eiWordsL5 = sigWordSet(ei.series_name);
            if (eiWordsL5.size === 0
                || candWords.size !== eiWordsL5.size
                || ![...eiWordsL5].every(w => candWords.has(w))) continue;
            // 3. Word-boundary check on series name words. Escape regex metacharacters in the
            //    word — e.g. "vs." in "Avengers vs. X-Men" would otherwise create an invalid regex
            //    that throws SyntaxError mid-loop.
            const escWord = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const wordMatch = w => new RegExp(`(?<![a-z0-9])${escWord(w)}(?![a-z0-9])`).test(fn);
            if (words.every(wordMatch)) {
              book = { id: c.id };
              break;
            }
          }
        }
      }

      if(book){
        const evidence=db.prepare('SELECT sb.cv_issue_id,sb.comicinfo,ss.year AS syear FROM scanned_books sb JOIN scanned_series ss ON ss.id=sb.series_id WHERE sb.id=?').get(book.id);
        if(!eventYearMatches({volumeYear:ei.volume_year,cvIssueId:ei.cv_issue_id,book:evidence}))book=null;
      }
      if (book) {
        if (ei.scanned_book_id !== book.id) {
          matched += update.run(book.id, ei.id).changes;
        }
      }
    } catch (e) {
      // Per-issue try/catch — one bad issue shouldn't kill the whole reconciler.
      // Without this, a regex SyntaxError or undefined-variable bug halts matching
      // for every event in the system. The fetch hangs forever, the user sees no
      // matches, and the bug is invisible from outside. Logging here makes it
      // diagnosable on the next click.
      logger.error('events', `Reconciler error for event_issue ${ei.id}`,
        { series: ei.series_name, num: ei.issue_number, error: e.message });
      if (strict) throw e;
    }
  }

  if (matched > 0) logger.info('events', `Reconciled ${matched} event issues`);
}

// ─── Monitored issue ↔ book by Comic Vine id ─────────────────────
// A tagged file is the monitored issue with the same CV id. Point the issue at
// it unless the issue already points at a file that exists and is not another
// CV issue. A file carrying the issue's own CV id means it is owned, so a
// 'wanted' or 'skipped' issue becomes 'processed' too.
function linkMonitoredByCv(mi, filePath) {
  if (!mi || mi.file_path === filePath) return false;
  const cur = mi.file_path;
  if (cur && fs.existsSync(cur)) {
    const r = db.prepare('SELECT cv_issue_id FROM scanned_books WHERE path = ?').get(cur);
    if (!r || !r.cv_issue_id || String(r.cv_issue_id) === String(mi.id)) return false;  // current file is fine
  }
  db.prepare(`UPDATE monitored_issues SET file_path = ?, status = 'processed',
      date_processed = COALESCE(date_processed, datetime('now')), has_comicinfo = NULL WHERE id = ?`).run(filePath, mi.id);
  logger.info('scanner', `Monitored issue linked by CV id`, { issue: mi.id, file: filePath, was: cur || null });
  return true;
}
// Link every tagged book to its monitored issue by CV id. Idempotent and cheap:
// runs at boot and after each library scan / folder refresh, so unchanged books
// and newly monitored series get linked too (the scanner skips unchanged books).
function backfillMonitoredLinksByCv(trigger = 'startup') {
  try {
    const n = db.prepare(`UPDATE scanned_books SET monitored_issue_id = cv_issue_id
      WHERE cv_issue_id IS NOT NULL AND cv_issue_id != ''
        AND (monitored_issue_id IS NULL OR monitored_issue_id != cv_issue_id)
        AND cv_issue_id IN (SELECT id FROM monitored_issues)`).run().changes;
    let fixed = 0;
    const rows = db.prepare(`SELECT i.id, i.status, i.file_path, b.path AS book_path
      FROM monitored_issues i JOIN scanned_books b ON b.cv_issue_id = i.id
      WHERE (i.file_path IS NULL OR i.file_path != b.path)
      GROUP BY i.id`).all();
    for (const r of rows) if (linkMonitoredByCv(r, r.book_path)) fixed++;
    if (n || fixed) logger.info('cv-link', `Linked books to monitored issues by CV id`, { trigger, booksLinked: n, issuesRepointed: fixed });
  } catch (e) { logger.warn('cv-link', 'CV-id link backfill failed', e.message); }
}
backfillMonitoredLinksByCv('startup');

// ─── Stable IDs (always on; see stableIds.js) ─────────────────────
const stableIds = require('./stableIds')({ db, logger, fs, path, crypto });
// Automatic purge of missing records (user 2026-10-21): records missing 5+ days (setting
// stable_ids_auto_purge_days; '0' = off), once a day, with stableIds.autoPurge's outage guards.
setInterval(() => {
  try {
    const days = parseInt(getSetting('stable_ids_auto_purge_days') ?? '5', 10);
    if (!(days > 0)) return;
    const today = new Date().toISOString().slice(0, 10);
    if (getSetting('stable_ids_auto_purge_last') === today) return;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('stable_ids_auto_purge_last', today);
    const r = stableIds.autoPurge({ days, comicsRoot: process.env.COMICS_PATH || '/comics' });
    if (r.skipped) logger.warn('stable-ids', 'Automatic purge skipped', { reason: r.reason });
    else if (r.books || r.series) logger.info('stable-ids', 'Automatic purge', { days, ...r });
  } catch (e) { logger.warn('stable-ids', 'Automatic purge failed', { error: e.message }); }
}, 60 * 60 * 1000);
const { createScannerState, BOOK_UPSERT } = require('./metadata/scannerState');
const scannerState = createScannerState({ db, fs });
const decideMetadataIdentity = require('./metadata/identity').decideIdentity;
try { db.prepare("DELETE FROM settings WHERE key = 'stable_ids'").run(); } catch {}

// ─── Shared scanner helpers ───────────────────────────────────────
function makeScanStmts() {
  const upsertSeries = db.prepare(`
    INSERT INTO scanned_series (id, library_id, path, name, year, metadata_status, series_json, monitored_series_id, book_count, last_scanned, dir_mtime, dir_file_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      library_id=excluded.library_id, name=excluded.name, year=excluded.year,
      metadata_status=excluded.metadata_status, series_json=excluded.series_json,
      monitored_series_id=excluded.monitored_series_id, book_count=excluded.book_count,
      last_scanned=CURRENT_TIMESTAMP, dir_mtime=excluded.dir_mtime, dir_file_count=excluded.dir_file_count
  `);
  const upsertBook = db.prepare(BOOK_UPSERT);
  return { upsertSeries, upsertBook };
}

// Keep archive readers and their cache writes inside the scan lifetime. A
// changed file/row invalidates the result before it can populate a stale cover.
async function warmScannedThumbnail(filePath, cacheKeys) {
  const snapshot = scannerState.capture(filePath);
  if (!snapshot) return false;
  try {
    const images = filterImages(await listArchiveFiles(filePath));
    if (!images.length) return false;
    const stdout = await readArchiveMember(filePath, images[0], 10 * 1024 * 1024);
    if (!scannerState.current(snapshot)) return false;
    const t = await coverThumb(stdout, path.extname(images[0]).toLowerCase() || '.jpg');
    if (!scannerState.current(snapshot)) return false;
    for (const key of cacheKeys) fs.writeFileSync(path.join(THUMB_CACHE_DIR, key + t.ext), t.buf);
    return true;
  } catch { return false; } // Thumbnail failure must not make a comic disappear.
}

/** Scan one directory; defer changed evidence without losing existing filing. */
async function scanSeriesDir(seriesDir, libraryId, upsertSeries, upsertBook, arrival = 'scanner') {
  // Held/crashed work retains these reservations until explicit recovery.
  // Do not cache directory freshness when a later retry is required.
  if (scannerState.reserved(seriesDir, null, true) ||
      (!db.prepare('SELECT id FROM scanned_series WHERE path=?').get(seriesDir) && !scannerState.mayRegister())) {
    db.prepare('UPDATE scanned_series SET dir_mtime=-1 WHERE path=?').run(seriesDir);
    return { skipped: true, skippedBooks: 0, changedBooks: 0, deferred: true };
  }
  // Stable ID: the live row at this path, else a reclaimed record (CV volume ID), else a new ID.
  const seriesId = stableIds.resolveSeriesId(seriesDir, () => readSeriesJson(seriesDir));
  const dirStat = fs.statSync(seriesDir);
  const dirMtime = Math.floor(dirStat.mtimeMs);
  const dirEntries = fs.readdirSync(seriesDir, { withFileTypes: true });
  const comicFiles = dirEntries.filter(e => e.isFile() && COMIC_EXTS.test(e.name)).map(e => e.name).sort();
  const dirFileCount = comicFiles.length;

  const existingRow = db.prepare('SELECT dir_mtime, dir_file_count FROM scanned_series WHERE id = ?').get(seriesId);
  const seriesUnchanged = existingRow &&
    existingRow.dir_mtime === dirMtime &&
    existingRow.dir_file_count === dirFileCount;

  // If disk state hasn't changed, only re-run if thumbnails are missing
  if (seriesUnchanged) {
    const seriesThumbMissing = !findThumbCache(`series_${seriesId}`);
    if (!seriesThumbMissing) return { skipped: true, skippedBooks: 0, changedBooks: 0 };
    // Thumb missing but disk unchanged — warm the thumb from the first book only, skip full rescan
    const firstComic = comicFiles[0];
    if (firstComic) {
      const firstPath = path.join(seriesDir, firstComic);
      const seriesCacheKey = `series_${seriesId}`;
      if (!await warmScannedThumbnail(firstPath, [seriesCacheKey])) {
        db.prepare('UPDATE scanned_series SET dir_mtime=-1 WHERE id=?').run(seriesId);
        return { skipped: true, skippedBooks: 0, changedBooks: 0, deferred: true };
      }
    }
    return { skipped: true, skippedBooks: 0, changedBooks: 0 };
  }

  const folderName = path.basename(seriesDir);
  // "(YYYY)" anchored at the end only: the old /^(.+?)\s*\((\d{4})\)\s*$/ could backtrack (CodeQL, 2026-11-12).
  const folderYearMatch = /\((\d{4})\)$/.exec(folderName.trim());
  const folderTitle = folderYearMatch ? folderName.trim().slice(0, folderYearMatch.index).trim() : folderName;
  const folderYear  = folderYearMatch ? parseInt(folderYearMatch[1]) : null;

  const jsonData = readSeriesJson(seriesDir);
  const metaStatus = deriveMetadataStatus(jsonData);
  const jsonTitle = jsonData?.metadata?.name || jsonData?.metadata?.title || null;
  const jsonYear  = jsonData?.metadata?.year  || null;
  const seriesName = jsonTitle || folderTitle;
  const seriesYear = jsonYear  || folderYear;

  // Pull EVERY monitored series at this directory (parent + sibling specials),
  // not just one. The old `.get()` returned an arbitrary row when multiple
  // monitored series cohabited a folder (a parent series with one or more
  // specials), which then drove the per-file miRow lookup against whatever
  // series happened to come back first — wrongly linking, e.g., a regular
  // "Guardians of the Galaxy 001.cbz" to the special "Black Vortex Alpha" #1.
  // The parent (no parent_series_id) becomes the series-level link;
  // specials are kept aside for per-file prefix routing below.
  const monitoredAtDir = db.prepare(
    'SELECT id, name, parent_series_id, is_special FROM monitored_series WHERE directory = ?'
  ).all(seriesDir);
  // "Special" status comes from the explicit flag OR (legacy) parent_series_id.
  // Parent fallback excludes anything flagged as a special.
  const isSpecialRow = s => !!(s.is_special || s.parent_series_id);
  const parentSeries        = monitoredAtDir.find(s => !isSpecialRow(s)) || null;
  const specialSeriesAtDir  = monitoredAtDir.filter(isSpecialRow);
  // Pre-normalise sibling-special prefixes once per directory.
  const specialPrefixes = specialSeriesAtDir
    .map(s => ({ id: s.id, prefix: s.name.toLowerCase().replace(/[^a-z0-9]/g, '') }))
    .filter(s => s.prefix.length > 0);
  // Series-level link: prefer parent; fall back to first row when a dir has
  // only specials and no monitored parent (rare but legal).
  const monitoredId = parentSeries
    ? parentSeries.id
    : (monitoredAtDir[0]?.id || null);

  upsertSeries.run(seriesId, libraryId, seriesDir, seriesName, seriesYear, metaStatus,
    jsonData ? JSON.stringify(jsonData) : null, monitoredId, comicFiles.length, dirMtime, dirFileCount);

  jsonMemCache.delete(seriesId);
  db.prepare('DELETE FROM series_json_cache WHERE series_id = ?').run(seriesId);

  let skippedBooks = 0, changedBooks = 0, deferred = false;

  for (let i = 0; i < comicFiles.length; i++) {
    // Yield every 5 books so HTTP requests can be handled between ComicInfo extractions
    if (i > 0 && i % 5 === 0) await new Promise(r => setImmediate(r));

    const filename = comicFiles[i];
    const filePath = path.join(seriesDir, filename);
    const scanSnapshot = scannerState.capture(filePath);
    if (!scanSnapshot) { deferred = true; skippedBooks++; continue; }
    // Stable ID: the live row at this path; a file at an unknown path gets its
    // ID after ComicInfo is read (reclaimed record or new).
    const pathRow = stableIds.bookAtPath(filePath);
    let bookId = pathRow ? pathRow.id : null;

    const fileStat = fs.statSync(filePath);
    const fileMtime = Math.floor(fileStat.mtimeMs);
    const fileSize  = fileStat.size;
    const existingBook = pathRow;
    const bookUnchanged = existingBook && existingBook.file_mtime === fileMtime && existingBook.file_size === fileSize;

    let bookCacheKey     = bookId;
    const seriesCacheKey = `series_${seriesId}`;
    let bookThumbMissing     = bookId ? !findThumbCache(bookCacheKey) : true;
    const seriesThumbMissing = i === 0 && !findThumbCache(seriesCacheKey);

    // Skip entirely if book unchanged AND thumbnails are present
    if (bookUnchanged && !bookThumbMissing && !seriesThumbMissing) { skippedBooks++; continue; }

    // If book unchanged but only thumb is missing — warm thumb without re-extracting ComicInfo
    if (bookUnchanged && (bookThumbMissing || seriesThumbMissing)) {
      if (!await warmScannedThumbnail(filePath, [bookThumbMissing && bookCacheKey, seriesThumbMissing && seriesCacheKey].filter(Boolean))) deferred = true;
      skippedBooks++;
      continue;
    }

    let ciRaw = null, ci = {}, issueNum = null, title = null;
    if (!bookUnchanged) {
      // A file replaced at the same path keeps its book id: its old cover thumbnail must go too
      // (2026-10-17: a replaced Superman #39 kept showing the Ultimate Spider-Man cover).
      if (existingBook && bookId) { evictThumbCache(bookId); bookThumbMissing = true; }
      if (/\.(cbz|cbr|zip|rar)$/i.test(filename)) {
        ciRaw = await extractComicInfo(filePath);
        ci = parseComicInfo(ciRaw);
        issueNum = ci.number || extractNumberFromFilename(filename);
        title = ci.title || null;
      }
      const isSpecialDetected = /special|one-shot|oneshot/i.test(filename) || /(<format>special<\/format>|<format>one-shot<\/format>)/i.test(ciRaw || '');
      // Specials get sort_order 9000+ so they always sort after regular issues
      // This prevents a "Special 001" from appearing as the series thumbnail source
      const baseSortOrder = issueNum ? (parseFloat(issueNum) || i) : i;
      const sortOrder = isSpecialDetected ? 9000 + baseSortOrder : baseSortOrder;
      const fileIsAnnual = /annual/i.test(filename) || /<format>annual<\/format>/i.test(ciRaw || '');

      // ── Per-file monitored-series routing ─────────────────────────
      // When a directory has a parent series AND one or more sibling specials,
      // we have to pick the right monitored_series PER FILE — longest-prefix
      // sibling special wins, parent is the fallback. Without this, a regular
      // file ("Guardians of the Galaxy 001.cbz") would get matched against the
      // special's monitored_issues just because the special row happened to
      // come first from the directory query above.
      const fileNormForRouting = filename.toLowerCase().replace(/[^a-z0-9]/g, '');
      let chosenMonitoredId = parentSeries ? parentSeries.id : null;
      let longestSpecialMatch = 0;
      let matchedSpecialId = null;
      for (const sp of specialPrefixes) {
        if (fileNormForRouting.startsWith(sp.prefix) && sp.prefix.length > longestSpecialMatch) {
          chosenMonitoredId = sp.id;
          longestSpecialMatch = sp.prefix.length;
          matchedSpecialId = sp.id;
        }
      }

      let miRow = (!fileIsAnnual && !isSpecialDetected && issueNum && chosenMonitoredId)
        ? db.prepare('SELECT id FROM monitored_issues WHERE series_id = ? AND issue_number = ? AND (is_annual = 0 OR is_annual IS NULL)').get(chosenMonitoredId, issueNum)
        : null;
      // The file changed and opened cleanly with no ComicInfo.xml where it had
      // one before: the tags were removed on purpose (2026-10-16, mistagged
      // files cleaned by hand). Forget the stored identity and let the normal
      // identification find it again. '' = archive read, no ComicInfo; null =
      // unreadable, which still defers below.
      const tagsRemoved = !!(existingBook?.comicinfo && ciRaw === '' && !bookUnchanged);
      const identity = decideMetadataIdentity({bookId:bookId || 'scan-observation',arrival:'scanner',filename,comicInfoXml:ciRaw,indexedIssueId:tagsRemoved ? null : existingBook?.cv_issue_id});
      const cvIssueId = identity.status === 'accepted' ? identity.cvIssueId : null;
      miRow = null; // No processed/link decisions from folder + number alone.
      // Identity first: a file tagged with a monitored issue's CV id IS that issue —
      // annuals and specials included, whatever folder or number. A number match
      // that contradicts the tag is dropped (it is another comic).
      const cvMi = cvIssueId
        ? db.prepare('SELECT id, status, file_path FROM monitored_issues WHERE id = ?').get(String(cvIssueId))
        : null;
      if (miRow && cvIssueId && String(miRow.id) !== String(cvIssueId)) miRow = null;
      // ComicInfo extraction yields: the file, stable row, or journal may have
      // changed while it was running. Never commit that stale observation.
      if ((identity.status==='needs_review' && existingBook?.comicinfo && !tagsRemoved) || !scannerState.current(scanSnapshot) ||
          (existingBook?.comicinfo && !ciRaw && !tagsRemoved) ||
          (existingBook?.cv_issue_id && cvIssueId && String(existingBook.cv_issue_id) !== String(cvIssueId) && !tagsRemoved)) {
        deferred = true; skippedBooks++;
        logger.warn('scanner', 'Deferred changed or conflicting book evidence', { path: filePath });
        continue;
      }
      // Unknown path: reclaim the record this file used to be, or a new ID.
      if (!bookId) {
        if (!scannerState.mayRegister()) { deferred = true; skippedBooks++; continue; }
        bookId = stableIds.resolveBookId({ filePath, seriesId, cvIssueId, issueNum, fileSize });
        // A reclaimed record is a different file now (a replacement under a new name): its cached
        // cover may be the old file's, so it is made again from this one.
        if (db.prepare('SELECT 1 FROM scanned_books WHERE id = ?').get(bookId)) evictThumbCache(bookId);
        bookCacheKey = bookId; bookThumbMissing = !findThumbCache(bookId);
      }
      const newPhysicalBook = !stableIds.bookAtPath(filePath); // Reclaimed rows keep their filing flags too.
      upsertBook.run(bookId, seriesId, filePath, filename, issueNum, title, ciRaw, cvIssueId, cvMi ? cvMi.id : (miRow ? miRow.id : null), sortOrder, fileMtime, fileSize);
      if (tagsRemoved) {
        // The upsert keeps a stored Comic Vine ID; clear it so identification starts fresh.
        db.prepare("UPDATE scanned_books SET cv_issue_id = NULL WHERE id = ?").run(bookId);
        try { db.prepare("DELETE FROM library_health_dismissed WHERE kind = 'mistag-confirmed' AND key = ?").run(bookId); } catch {}
        logger.info('scanner', 'ComicInfo removed from file; stored Comic Vine match cleared', { path: filePath, was: existingBook.cv_issue_id || null });
      }
      if (cvMi) linkMonitoredByCv(cvMi, filePath);
      changedBooks++;
      if(typeof metadataMaintenance !== 'undefined') metadataMaintenance.enqueue(bookId, arrival, {initial:newPhysicalBook});
      if (newPhysicalBook && isSpecialDetected) db.prepare('UPDATE scanned_books SET is_special = 1 WHERE id = ? AND is_special = 0').run(bookId);
      // Mark scanned_books.is_special when the file belongs to a sibling-special.
      // Uses the pre-computed prefix list and the routing match above — no extra SQL,
      // and stays consistent with whichever series miRow was linked to.
      if (newPhysicalBook && !isSpecialDetected && matchedSpecialId) {
        db.prepare('UPDATE scanned_books SET is_special = 1 WHERE id = ? AND is_special = 0').run(bookId);
      }
      if (miRow && !cvMi) {
        // Only mark processed if the file is actually inside the resolved series
        // directory. `chosenMonitoredId` is the per-file routed series id
        // (parent or the longest-prefix matching sibling special).
        const monSeries = db.prepare('SELECT directory FROM monitored_series WHERE id = ?').get(chosenMonitoredId);
        const inSeriesDir = monSeries && filePath.startsWith(monSeries.directory + path.sep);
        if (inSeriesDir) {
          db.prepare(`UPDATE monitored_issues SET file_path = ?, status = 'processed' WHERE id = ? AND (file_path IS NULL OR file_path != ?)`)
            .run(filePath, miRow.id, filePath);
        } else {
          logger.warn('scanner', `Skipped cross-directory match`, { file: filePath, monitoredId, expected: monSeries?.directory });
        }
      }
    }

    if (bookThumbMissing || seriesThumbMissing) {
      if (!await warmScannedThumbnail(filePath, [bookThumbMissing && bookCacheKey, seriesThumbMissing && seriesCacheKey].filter(Boolean))) deferred = true;
    }
  }

  // Remove books that no longer exist on disk.
  // Safety guard: if the directory scan returned zero comic files but the DB
  // has books for this series, the mount point may have been temporarily
  // unavailable (common with Windows/Docker volume mounts). Skip the removal
  // pass entirely to avoid mass-resetting all issues to wanted on a bad read.
  const currentPaths = new Set(comicFiles.map(f => path.join(seriesDir, f)));
  const existingBooks = db.prepare('SELECT id, path, monitored_issue_id, cv_issue_id FROM scanned_books WHERE series_id = ?').all(seriesId);
  const mountLooksSuspect = comicFiles.length === 0 && existingBooks.length > 2;
  if (mountLooksSuspect) {
    logger.warn('scanner', `Skipping book removal for "${path.basename(seriesDir)}" — 0 files on disk but ${existingBooks.length} in DB (mount may be temporarily unavailable)`);
  } else {
    for (const book of existingBooks) {
      if (!currentPaths.has(book.path) && scannerState.mayRemoveBook(book, seriesDir)) {
        // Keep the record (and every link to it) so a later scan can reclaim it.
        stableIds.tombstoneBook(book.id);
        changedBooks++;
        logger.info('scanner', `kept missing book`, { path: book.path });
        monitoredIssueGone(book, 'missing from disk');
      }
    }
  }

  const regularCount = db.prepare(
    `SELECT COUNT(*) as cnt FROM scanned_books WHERE series_id = ? AND is_special = 0 AND LOWER(filename) NOT LIKE '%annual%'`
  ).get(seriesId);
  db.prepare('UPDATE scanned_series SET book_count = ? WHERE id = ?').run(regularCount.cnt, seriesId);

  if (scannerState.reserved(seriesDir, null, true)) deferred = true;
  if (deferred) db.prepare('UPDATE scanned_series SET dir_mtime=-1 WHERE id=?').run(seriesId);
  return { skipped: false, skippedBooks, changedBooks, deferred };
}

async function runLibraryScan(library) {
  scanState = { running: true, libraryId: library.id, progress: 0, total: 0, currentPath: '', startedAt: new Date().toISOString(), completedAt: null, errors: [] };
  logger.info('scanner', `starting scan`, { library: library.name, path: library.path });

  try {
    // Collect all series-level directories (subdirs that contain comic files)
    const seriesDirs = [];
    async function walkForSeries(dir, depth) {
      if (depth > 5) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      const files = entries.filter(e => e.isFile() && COMIC_EXTS.test(e.name));
      if (files.length > 0) { seriesDirs.push(dir); return; }
      const subdirs = entries.filter(e => e.isDirectory());
      for (let i = 0; i < subdirs.length; i++) {
        if (i > 0 && i % 10 === 0) await new Promise(r => setImmediate(r));
        await walkForSeries(path.join(dir, subdirs[i].name), depth + 1);
      }
    }
    await walkForSeries(library.path, 0);
    scanState.total = seriesDirs.length;
    logger.info('scanner', `found series dirs`, { count: seriesDirs.length });

    const { upsertSeries, upsertBook } = makeScanStmts();
    let skippedSeries = 0, skippedBooks = 0, changedBooks = 0;

    for (let si = 0; si < seriesDirs.length; si++) {
      const seriesDir = seriesDirs[si];
      scanState.currentPath = seriesDir;
      if (si > 0 && si % 5 === 0) await new Promise(r => setImmediate(r));
      try {
        const result = await scanSeriesDir(seriesDir, library.id, upsertSeries, upsertBook);
        skippedSeries += result.skipped ? 1 : 0;
        skippedBooks  += result.skippedBooks;
        changedBooks  += result.changedBooks;
      } catch (e) {
        logger.error('scanner', `series error`, { path: seriesDir, error: e.message });
        scanState.errors.push({ path: seriesDir, error: e.message });
      }
      scanState.progress++;
    }

    // Remove scanned_series/books for series that no longer exist on disk or have no comic files.
    // Catches: (a) deleted directories, (b) emptied directories (files removed but folder left).
    const COMIC_EXT_RE = /\.(cbz|cbr|zip|rar)$/i;
    const allScanned = db.prepare('SELECT id, path FROM scanned_series WHERE library_id = ?').all(library.id);
    for (const row of allScanned) {
      let shouldRemove = false;
      if (!fs.existsSync(row.path)) {
        shouldRemove = true;
      } else {
        // Directory exists — check if it still has any comic files
        try {
          const entries = fs.readdirSync(row.path, { withFileTypes: true });
          const hasComics = entries.some(e => e.isFile() && COMIC_EXT_RE.test(e.name));
          if (!hasComics) shouldRemove = true;
        } catch {
          shouldRemove = false; // Unreadable is not evidence that a directory was removed.
        }
      }
      if (shouldRemove && scannerState.mayRemoveSeries(row, library.path)) {
        stableIds.tombstoneSeries(row.id);
        changedBooks++;
        logger.info('scanner', `kept missing series`, { path: row.path });
      }
    }

    backfillMonitoredLinksByCv('scan');
    scheduleReconcile(changedBooks > 0);
    invalidateSeriesCache();
    setImmediate(warmCreatorsCache);
    setImmediate(warmLatestReleaseDateCache);
    scanState.running = false;
    scanState.completedAt = new Date().toISOString();
    logger.info('scanner', `scan complete`, { series: seriesDirs.length, skippedSeries, skippedBooks, changedBooks, errors: scanState.errors.length });
    // Record completion time for scheduled rescan logic
    db.prepare("UPDATE libraries SET last_scanned_at = datetime('now') WHERE id = ?").run(library.id);
    // Kick off background CBR rating fetch for any uncached series
    setTimeout(runCbrQueue, 5000);
  } catch (e) {
    scanState.running = false;
    scanState.completedAt = new Date().toISOString();
    logger.error('scanner', `scan failed`, { error: e.message });
  }
}

// ─── LIBRARIES ────────────────────────────────────────────────────
app.get('/api/libraries', (req, res) => {
  try {
    const libs = db.prepare('SELECT * FROM libraries ORDER BY name').all();
    const result = libs.map(l => {
      const seriesCount = db.prepare('SELECT COUNT(*) as n FROM scanned_series WHERE library_id = ?').get(l.id).n;
      return { ...l, seriesCount };
    });
    res.json(Array.isArray(result) ? result : []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/libraries', requireAdmin, (req, res) => {
  try {
    const { name, path: libPath, icon, color } = req.body;
    if (!name || !libPath) return res.status(400).json({ error: 'name and path required' });
    const resolvedPath = path.resolve(libPath);
    if (!fs.existsSync(resolvedPath)) return res.status(400).json({ error: `Path does not exist: ${resolvedPath}` });
    const id = 'lib_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    db.prepare('INSERT INTO libraries (id, name, path, icon, color) VALUES (?, ?, ?, ?, ?)').run(id, name.trim(), resolvedPath, icon || null, color || null);
    res.json({ id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/libraries/:id', requireAdmin, (req, res) => {
  try {
    const { name, icon, color } = req.body;
    db.prepare('UPDATE libraries SET name=?, icon=?, color=? WHERE id=?').run(name, icon || null, color || null, req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH — update scan schedule interval (0=manual, 3/6/12/24/48/168 hours)
app.patch('/api/libraries/:id', requireAdmin, (req, res) => {
  try {
    const { scan_interval_hours } = req.body;
    if (scan_interval_hours !== undefined) {
      db.prepare('UPDATE libraries SET scan_interval_hours=? WHERE id=?')
        .run(Number(scan_interval_hours), req.params.id);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/libraries/:id', requireAdmin, (req, res) => {
  try {
    // Cascade: remove scanned_books then scanned_series for this library
    const series = db.prepare('SELECT id FROM scanned_series WHERE library_id = ?').all(req.params.id);
    for (const s of series) db.prepare('DELETE FROM scanned_books WHERE series_id = ?').run(s.id);
    db.prepare('DELETE FROM scanned_series WHERE library_id = ?').run(req.params.id);
    db.prepare('DELETE FROM libraries WHERE id = ?').run(req.params.id);
    invalidateSeriesCache();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/libraries/:id/scan', requireAdmin, async (req, res) => {
  if (scanState.running) return res.status(409).json({ error: 'Scan already in progress' });
  const lib = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
  if (!lib) return res.status(404).json({ error: 'Library not found' });
  setImmediate(() => runLibraryScan(lib).catch(e => logger.warn('scan', 'Scan deferred', e.message)));
  res.json({ success: true, message: `Scan started for "${lib.name}"` });
});

app.post('/api/libraries/scan-all', requireAdmin, async (req, res) => {
  if (scanState.running) return res.status(409).json({ error: 'Scan already in progress' });
  const libs = db.prepare('SELECT * FROM libraries ORDER BY name').all();
  if (!libs.length) return res.status(400).json({ error: 'No libraries configured' });
  // Scan all libraries sequentially in background
  setImmediate(async () => {
    for (const lib of libs) await runLibraryScan(lib).catch(e => logger.warn('scan', 'Scan deferred', e.message));
  });
  res.json({ success: true, message: `Scanning ${libs.length} libraries` });
});

app.get('/api/scan/status', (req, res) => {
  res.json(scanState);
});



// ─── SERIES ───────────────────────────────────────────────────────
// One series in the list (2026-11-10). The list sent each series.json three times: the raw
// series_json column, the parsed seriesJson and its description as displayDescription (about
// 7 of ~12 MB for 2,300 series). The list pages use the display* fields; seriesJson is only a
// fallback for these keys (ConditionBuilder, comic box rules, shelf search), and nothing on
// them reads the description. A series page loads the full record from /api/series/:id.
// Series grouping (seriesGrouping.js, 2026-11-13): each list item carries its homes and whether it
// is hidden from the browser. Built once per change; any link change clears it and the series cache.
const seriesGrouping = require('./seriesGrouping').createSeriesGrouping({ db, logger,
  onChange: () => { seriesGroupCache = null; invalidateSeriesCache(); } });
let seriesGroupCache = null;
// Run the Specials-shelf rules shortly after a change (several creates in a row run them once).
let groupingTimer = null;
function scheduleGroupingRun(reason) {
  clearTimeout(groupingTimer);
  groupingTimer = setTimeout(() => { try { seriesGrouping.run(reason); } catch (e) { logger.warn('grouping', 'Rules failed', e.message); } }, 10000);
}
function seriesGroupOf(id) {
  if (!seriesGroupCache) { try { seriesGroupCache = seriesGrouping.groupMap(); } catch (e) { logger.warn('grouping', 'Group map failed', e.message); seriesGroupCache = new Map(); } }
  return seriesGroupCache.get(id) || null;
}
const SERIES_LIST_JSON_KEYS = ['name', 'year', 'era', 'publisher', 'imprint', 'genres', 'characters', 'status', 'writers', 'artists'];
function seriesListItem(merged) {
  const item = seriesListItemCore(merged);
  const group = typeof seriesGroupOf === 'function' ? seriesGroupOf(item.id) : null;
  if (group) item.group = group;
  return item;
}
function seriesListItemCore(merged) {
  const { series_json, displayDescription, seriesJson, ...rest } = merged;
  if (!seriesJson || typeof seriesJson !== 'object' || Array.isArray(seriesJson)) return { ...rest, seriesJson: seriesJson || null };   // a few series.json files hold a list: passed on as before
  const slim = {};
  for (const k of SERIES_LIST_JSON_KEYS) if (seriesJson[k] !== undefined) slim[k] = seriesJson[k];
  return { ...rest, seriesJson: slim };
}
app.get('/api/series', (req, res) => {
  try {
    const { libraryId, search, tag, page, size, enrich } = req.query;
    const pageNum  = page !== undefined ? parseInt(page) : 0;
    const pageSize = size !== undefined ? parseInt(size) : 48;

    let series = fetchAllSeries(libraryId, search, tag);
    const totalElements = series.length;

    // The whole enriched list (Series page, comic boxes): built once and kept with the cached
    // rows (2026-11-05). It was rebuilt on every request (~1.1 s, ~12 MB), holding up other
    // requests meanwhile. Kept on the same seriesCache entry, so anything that clears or
    // refreshes the rows (scans, edits, tags, the 5-minute expiry) drops it too.
    const whole = enrich === 'true' && page === undefined && !search && !tag ? seriesCache.get(getSeriesCacheKey(libraryId)) : null;
    if (whole && whole.data === series && whole.enrichedJson) return res.type('application/json').send(whole.enrichedJson);

    // Paginate if page param provided
    if (page !== undefined) {
      const start = pageNum * pageSize;
      series = series.slice(start, start + pageSize);
    }

    if (enrich === 'true') series = series.map(s => {
      try {
        return seriesListItem(mergeSeriesWithJson(s));
      } catch (e) {
        logger.error('series', `mergeSeriesWithJson failed for series ${s.id} (${s.name})`, e.message);
        // Return a minimal safe object so the grid still renders
        return seriesListItem({ ...s, seriesJson: null, metadataStatus: 'none',
          displayTitle: s.name || s.id, displayDescription: '', displayEra: null,
          displayCharacters: [], displayGenres: [], displayStatus: '',
          displayYear: s.year || null, displayPublicationRun: null,
          displayTotalIssues: s.book_count || 0, displayWriters: [], displayArtists: [],
          displayTags: [], displayAwards: [], displayRating: null, latestReleaseDate: null });
      }
    });
    const body = { content: series, totalElements, totalPages: Math.ceil(totalElements / pageSize), number: pageNum };
    if (whole && whole.data === fetchAllSeries(libraryId)) {
      whole.enrichedJson = JSON.stringify(body);
      return res.type('application/json').send(whole.enrichedJson);
    }
    res.json(body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Fixed-path routes MUST come before /api/series/:id ───────────

// GET /api/series/award-winners — series in library with Eisner/Harvey wins
app.get('/api/series/award-winners', requireAuth, (req, res) => {
  try {
    const { award } = req.query; // optional: 'eisner' | 'harvey'
    const validAward = ['eisner','harvey'].includes(award) ? award : null;

    const rows = db.prepare(`
      SELECT ss.id, ss.name, ss.year,
        GROUP_CONCAT(ad.award || ':' || ad.year || ':' || ad.category, '|') as award_list
      FROM scanned_series ss
      JOIN award_data ad
        ON lower(ad.series_name) = lower(ss.name)
        OR lower(ad.series_name) = lower(replace(replace(ss.name, 'The ', ''), ':', ''))
      WHERE ad.winner = 1 AND COALESCE(ad.kind, 'work') = 'work' ${validAward ? `AND ad.award = '${validAward}'` : `AND ad.award IN ('eisner','harvey')`}
      GROUP BY ss.id
      ORDER BY
        CASE WHEN lower(substr(ss.name, 1, 4)) = 'the ' THEN lower(substr(ss.name, 5)) ELSE lower(ss.name) END ASC,
        COALESCE(ss.year, 9999) ASC
    `).all();

    const result = rows.map(r => ({
      id:     r.id,
      name:   r.name,
      year:   r.year,
      awards: r.award_list.split('|').map(a => {
        const [awd, yr, cat] = a.split(':');
        return { award: awd, year: parseInt(yr), category: cat };
      }),
    }));

    res.json({ series: result, total: result.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/series/no-metadata', requireAdmin, (req, res) => {
  try {
    const { libraryId } = req.query;
    let sql = "SELECT * FROM scanned_series WHERE metadata_status = 'none'";
    const params = [];
    if (libraryId) { sql += ' AND library_id = ?'; params.push(libraryId); }
    const rows = db.prepare(sql).all(...params).map(mergeSeriesWithJson);
    res.json({ content: rows, totalElements: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.get('/api/series/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM scanned_series WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Series not found' });
    const merged = mergeSeriesWithJson(row);

    // Pull CV + LOCG links from the linked monitored_series if one exists
    const mon = db.prepare('SELECT id, locg_series_id, locg_series_slug, cv_url FROM monitored_series WHERE directory = ?').get(row.path);
    if (mon) {
      merged.cv_volume_url   = `https://comicvine.gamespot.com/volume/4050-${mon.id}/`;
      merged.locg_series_url = (mon.locg_series_id && mon.locg_series_slug)
        ? `${LOCG_BASE}/comics/series/${mon.locg_series_id}/${mon.locg_series_slug}` : null;
      merged.monitored_series_id = mon.id;
    }

    // Build authors list — prefer stored series.json creators, fall back to ComicInfo aggregation
    const m = merged.seriesJson || {};
    let authors = [];
    const hasStoredCreators = ['writers','pencillers','inkers','colorists','cover_artists']
      .some(k => Array.isArray(m[k]) && m[k].length > 0);

    if (hasStoredCreators) {
      const map = [
        ['writers',      'writer'],
        ['pencillers',   'penciller'],
        ['inkers',       'inker'],
        ['colorists',    'colorist'],
        ['cover_artists','coverArtist'],
      ];
      map.forEach(([jsonKey, role]) => {
        (m[jsonKey] || []).forEach(name => authors.push({ name, role }));
      });
    } else {
      authors = aggregateCreatorsFromBooks(row.id);
    }

    res.json({ ...merged, booksMetadata: { authors } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ─── Debug: inspect enriched series data ─────────────────────────
app.get('/api/debug/series/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM scanned_series WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Series not found in scanner DB' });
    const resolvedPath = seriesJsonPath(row.path);
    const fileExists   = fs.existsSync(resolvedPath);
    const freshJson    = fileExists ? readSeriesJson(row.path) : null;
    const enriched     = mergeSeriesWithJson(row);
    res.json({
      id:                  enriched.id,
      name:                row.name,
      seriesPath:          row.path,
      resolvedJsonPath:    resolvedPath,
      fileExistsOnDisk:    fileExists,
      freshJsonRead:       !!freshJson,
      cachedInMemory:      jsonMemCache.has(row.id),
      displayTitle:        enriched.displayTitle,
      displayYear:         enriched.displayYear,
      displayEra:          enriched.displayEra,
      displayStatus:       enriched.displayStatus,
      displayCharacters:   enriched.displayCharacters,
      displayGenres:       enriched.displayGenres,
      displayPublisher:    enriched.displayPublisher,
      hasSeriesJson:       !!enriched.seriesJson,
      metadataStatus:      enriched.metadataStatus,
      seriesJsonKeys:      enriched.seriesJson ? Object.keys(enriched.seriesJson) : [],
      seriesJsonSample: freshJson ? {
        name:        freshJson.metadata?.name,
        year:        freshJson.metadata?.year,
        era:         freshJson.metadata?.era,
        status:      freshJson.metadata?.status,
        characters:  (freshJson.metadata?.characters || []).slice(0, 5),
        genres:      freshJson.metadata?.genres,
      } : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Debug: check path resolution ────────────────────────────────
app.get('/api/debug/path', (req, res) => {
  const { seriesPath: sp } = req.query;
  if (!sp) return res.status(400).json({ error: 'seriesPath param required' });
  const resolved  = seriesJsonPath(sp);
  const exists    = fs.existsSync(resolved);
  const dirExists = fs.existsSync(sp);
  res.json({ seriesPath: sp, resolved, fileExists: exists, dirExists, COMICS_PATH });
});

// ─── Debug: list all series with/without series.json (summary) ───
app.get('/api/debug/coverage', (req, res) => {
  try {
    const rows = db.prepare('SELECT id, name, path, metadata_status FROM scanned_series LIMIT 200').all();
    const withJson    = rows.filter(r => r.metadata_status !== 'none').length;
    const withoutJson = rows.filter(r => r.metadata_status === 'none').length;
    const missing = rows.filter(r => r.metadata_status === 'none').slice(0, 20).map(r => ({ id: r.id, name: r.name, path: r.path }));
    res.json({ checked: rows.length, withJson, withoutJson, sampleMissing: missing });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// Debug: trace exactly why an event issue is matching what it's matching
// GET /api/debug/event-match/:eventId — shows all event_issues with match trace
app.get('/api/debug/event-match/:eventId', requireAuth, (req, res) => {
  try {
    const getCiYear = (comicinfo) => {
      if (!comicinfo) return null;
      const m = comicinfo.match(/<Year>(\d{4})<\/Year>/i);
      return m ? parseInt(m[1]) : null;
    };

    const issues = db.prepare('SELECT * FROM event_issues WHERE event_id = ? ORDER BY sort_order').all(req.params.eventId);
    const result = issues.map(ei => {
      const matchedBook = ei.scanned_book_id
        ? db.prepare('SELECT id, filename, issue_number, cv_issue_id, monitored_issue_id, series_id, comicinfo FROM scanned_books WHERE id = ?').get(ei.scanned_book_id)
        : null;
      const matchedSeries = matchedBook
        ? db.prepare('SELECT name, year FROM scanned_series WHERE id = ?').get(matchedBook.series_id)
        : null;

      // Trace each level to see what would match
      const l1 = ei.cv_issue_id ? db.prepare('SELECT id, filename, issue_number, cv_issue_id FROM scanned_books WHERE cv_issue_id = ? LIMIT 1').get(ei.cv_issue_id) : null;
      const l2 = ei.cv_issue_id ? db.prepare('SELECT id, filename, issue_number, monitored_issue_id FROM scanned_books WHERE monitored_issue_id = ? LIMIT 1').get(ei.cv_issue_id) : null;

      return {
        ei_id: ei.id,
        series_name: ei.series_name,
        issue_number: ei.issue_number,
        volume_year: ei.volume_year || null,
        cv_issue_id: ei.cv_issue_id || null,
        scanned_book_id: ei.scanned_book_id,
        matched_book: matchedBook ? {
          id: matchedBook.id,
          filename: matchedBook.filename,
          issue_number: matchedBook.issue_number,
          is_annual: /annual/i.test(matchedBook.filename),
          cv_issue_id: matchedBook.cv_issue_id,
          monitored_issue_id: matchedBook.monitored_issue_id,
          series_name: matchedSeries?.name,
          series_year: matchedSeries?.year,
          comicinfo_year: getCiYear(matchedBook.comicinfo),
        } : null,
        level_trace: {
          l1_would_match: l1 ? { filename: l1.filename, issue_number: l1.issue_number, cv_issue_id: l1.cv_issue_id } : null,
          l2_would_match: l2 ? { filename: l2.filename, issue_number: l2.issue_number } : null,
        },
      };
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/series/:id/books', requireAuth, (req, res) => {
  try {
    const userId = req.user?.sub || null;
    const books = db.prepare('SELECT * FROM scanned_books WHERE series_id = ? ORDER BY sort_order ASC, filename ASC').all(req.params.id);

    // Bulk-fetch read progress for this series in one query
    const progressRows = userId
      ? db.prepare('SELECT book_id, page, completed FROM read_progress WHERE book_id IN (SELECT id FROM scanned_books WHERE series_id = ?) AND user_id = ?').all(req.params.id, userId)
      : [];
    const progressMap = Object.fromEntries(progressRows.map(r => [r.book_id, r]));

    const mapped = books
      .filter(b => req.query.includeAll === 'true' || (!/annual/i.test(b.filename) && !b.is_special))
      .map(b => ({
        ...b,
        comicinfo: b.comicinfo ? parseComicInfo(b.comicinfo) : {},
        metadata: { number: b.issue_number, title: b.title, numberSort: b.sort_order },
        media: { pagesCount: b.comicinfo ? (parseComicInfo(b.comicinfo).pageCount || null) : null },
        readProgress: progressMap[b.id] ? { page: progressMap[b.id].page, completed: !!progressMap[b.id].completed } : null,
      }));
    res.json({ content: mapped, totalElements: mapped.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Special books for a scanned series ─────────────────────────
app.get('/api/series/:id/specials', requireAuth, (req, res) => {
  try {
    const userId = req.user?.sub || null;
    const books = db.prepare(
      'SELECT * FROM scanned_books WHERE series_id = ? AND is_special = 1 ORDER BY sort_order ASC, filename ASC'
    ).all(req.params.id);

    const progressRows = userId && books.length
      ? db.prepare(`SELECT book_id, page, completed FROM read_progress WHERE book_id IN (${books.map(() => '?').join(',')}) AND user_id = ?`)
          .all(...books.map(b => b.id), userId)
      : [];
    const progressMap = Object.fromEntries(progressRows.map(r => [r.book_id, r]));

    const mapped = books.map(b => ({
      ...b,
      comicinfo: b.comicinfo ? parseComicInfo(b.comicinfo) : {},
      metadata: { number: b.issue_number, title: b.title, numberSort: b.sort_order },
      media: { pagesCount: b.comicinfo ? (parseComicInfo(b.comicinfo).pageCount || null) : null },
      readProgress: progressMap[b.id] ? { page: progressMap[b.id].page, completed: !!progressMap[b.id].completed } : null,
    }));
    res.json({ books: mapped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/books/:id/toggle-special — flip is_special for a scanned book
app.post('/api/books/:id/toggle-special', requireAuth, requireAdmin, (req, res) => {
  try {
    const book = db.prepare('SELECT id, is_special, sort_order FROM scanned_books WHERE id = ?').get(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    const newVal = book.is_special ? 0 : 1;

    if (newVal === 1 && book.sort_order < 9000) {
      // Marking as special — push sort_order above 9000
      db.prepare('UPDATE scanned_books SET is_special = 1, sort_order = ? WHERE id = ?')
        .run(9000 + book.sort_order, req.params.id);
    } else if (newVal === 0 && book.sort_order >= 9000) {
      // Unmarking as special — restore original sort_order
      db.prepare('UPDATE scanned_books SET is_special = 0, sort_order = ? WHERE id = ?')
        .run(book.sort_order - 9000, req.params.id);
    } else {
      db.prepare('UPDATE scanned_books SET is_special = ? WHERE id = ?').run(newVal, req.params.id);
    }

    res.json({ ok: true, is_special: newVal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Annual books for a scanned series ───────────────────────────
// Primary: files with "annual" in the filename in the same series folder.
// Secondary: separate scanned_series linked via series_annual_links (monitored path).
app.get('/api/series/:id/annuals', (req, res) => {
  try {
    // 1. Annual files in this series folder (filename contains "annual")
    const inFolder = db.prepare(
      "SELECT * FROM scanned_books WHERE series_id = ? AND LOWER(filename) LIKE '%annual%' ORDER BY sort_order ASC, filename ASC"
    ).all(req.params.id);

    // 2. Separate scanned_series linked via series_annual_links (monitored series only)
    let linkedBooks = [];
    const series = db.prepare('SELECT * FROM scanned_series WHERE id = ?').get(req.params.id);
    if (series?.monitored_series_id) {
      const annualLinks = db.prepare(`
        SELECT s.id FROM monitored_series s
        JOIN series_annual_links l ON l.annual_series_id = s.id
        WHERE l.parent_series_id = ?
      `).all(series.monitored_series_id);
      for (const link of annualLinks) {
        const annualScanned = db.prepare(
          'SELECT * FROM scanned_series WHERE monitored_series_id = ?'
        ).get(link.id);
        if (annualScanned) {
          linkedBooks.push(...db.prepare(
            'SELECT * FROM scanned_books WHERE series_id = ? ORDER BY sort_order ASC, filename ASC'
          ).all(annualScanned.id));
        }
      }
    }

    // Merge, deduplicate, map to standard shape
    const userId = req.user?.sub || null;
    const seen = new Set();
    const deduped = [...inFolder, ...linkedBooks].filter(b => {
      if (seen.has(b.id)) return false;
      seen.add(b.id);
      return true;
    });

    // Bulk-fetch read progress
    const annualProgressRows = userId && deduped.length
      ? db.prepare(`SELECT book_id, page, completed FROM read_progress WHERE book_id IN (${deduped.map(() => '?').join(',')}) AND user_id = ?`).all(...deduped.map(b => b.id), userId)
      : [];
    const annualProgressMap = Object.fromEntries(annualProgressRows.map(r => [r.book_id, r]));

    const allAnnuals = deduped.map(b => ({
      ...b,
      comicinfo: b.comicinfo ? parseComicInfo(b.comicinfo) : {},
      metadata: { number: b.issue_number, title: b.title, numberSort: b.sort_order },
      media: { pagesCount: b.comicinfo ? (parseComicInfo(b.comicinfo).pageCount || null) : null },
      readProgress: annualProgressMap[b.id] ? { page: annualProgressMap[b.id].page, completed: !!annualProgressMap[b.id].completed } : null,
    }));

    if (!allAnnuals.length) return res.json(null);
    res.json({ books: allAnnuals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Series thumbnail: extract first page of first book ───────────
app.get('/api/series/:id/thumbnail', async (req, res) => {
  try {
    const book = pickSeriesCoverBook(req.params.id);
    if (!book) return res.status(404).send();
    // Serve the chosen book's own thumbnail, so the series cover follows the
    // pick (and its ETag changes) instead of a separately cached series image.
    await streamArchivePage(book.path, 0, res, book.id);
  } catch (e) { res.status(404).send(); }
});

// Cover = the series' actual issue #1. Reading order (sort_order) is not used
// first because folders often lead with a #0, a prequel mini or an event
// tie-in (e.g. "Green Lantern Corps - Futures End 001"). Ranking:
//   1. books whose ComicInfo <Series> is a different title are pushed back
//   2. issue number exactly 1, then the lowest number above 1, then the rest
//   3. a ComicInfo match, no " - Subtitle" in the filename, reading order
// Annuals and specials are skipped unless nothing else exists.
function pickSeriesCoverBook(seriesId) {
  const books = db.prepare('SELECT id, path, filename, issue_number, sort_order, is_special, comicinfo FROM scanned_books WHERE series_id = ?').all(seriesId);
  if (!books.length) return null;
  const ss = db.prepare('SELECT name FROM scanned_series WHERE id = ?').get(seriesId);
  const norm = t => String(t || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
  const want = norm(ss?.name);
  const wantShort = norm(String(ss?.name || '').split(':')[0]); // "Luke Cage: Marvel Digital Original" -> "Luke Cage"
  const regular = books.filter(b => !b.is_special && !/annual/i.test(b.filename));
  const pool = regular.length ? regular : books;
  const ranked = pool.map(b => {
    const ciSeries = ((b.comicinfo || '').match(/<Series>([^<]*)<\/Series>/i) || [])[1];
    // Title from the filename: drop "1. " prefixes, (tags), [tags], the issue
    // number and anything after it, and a "v2"/"Vol. 2" volume marker.
    const bare = String(b.filename).replace(/\.[^.]+$/, '').replace(/^\d+\.\s*/, '')
      .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').trim();
    const fm = bare.match(/^(.*?)\s*#?(\d+(?:\.\d+)?)(?:\s+-\s+.*)?\s*$/);
    const fileTitle = (fm ? fm[1] : bare).replace(/\b(v\d*|vol\.?|volume)\s*$/i, '');
    const ciOk = ciSeries && norm(ciSeries) === want;
    const fileOk = !!norm(fileTitle) && (norm(fileTitle) === want || norm(fileTitle) === wantShort);
    const match = (ciOk || fileOk) ? 0 : (!ciSeries ? 1 : 2);
    let n = parseFloat(String(b.issue_number ?? '').replace(/^#/, ''));
    if (!Number.isFinite(n) && fm && b.issue_number) n = parseFloat(fm[2]); // e.g. issue_number "HC"
    const tier = n === 1 ? 0 : (Number.isFinite(n) && n > 1 ? 1 : 2);
    const dash = /\s-\s/.test(b.filename) ? 1 : 0;
    return { b, key: [match === 2 ? 1 : 0, tier, Number.isFinite(n) ? n : 1e9, match, dash, b.sort_order ?? 1e9] };
  });
  ranked.sort((x, y) => {
    for (let i = 0; i < x.key.length; i++) if (x.key[i] !== y.key[i]) return x.key[i] - y.key[i];
    return String(x.b.filename).localeCompare(String(y.b.filename));
  });
  return ranked[0].b;
}

// ─── Single book lookup ───────────────────────────────────────────
// GET /api/books/:id
// Returns the scanned_books row plus parsed comicinfo.
// Used by the reader to get title, series_id, and filename.
app.get('/api/books/:id', (req, res) => {
  try {
    const book = db.prepare('SELECT * FROM scanned_books WHERE id = ?').get(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    // Look up series_type from monitored_series via scanned_series link
    const seriesType = (() => {
      if (!book.series_id) return 'comic';
      const ss = db.prepare('SELECT monitored_series_id FROM scanned_series WHERE id = ?').get(book.series_id);
      if (!ss?.monitored_series_id) return 'comic';
      const ms = db.prepare('SELECT series_type FROM monitored_series WHERE id = ?').get(ss.monitored_series_id);
      return ms?.series_type || 'comic';
    })();
    const seriesRow = book.series_id ? db.prepare('SELECT name FROM scanned_series WHERE id = ?').get(book.series_id) : null;
    res.json({ ...book, series_type: seriesType, series_name: seriesRow?.name || null, comicinfo: book.comicinfo ? parseComicInfo(book.comicinfo) : {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Tag a scanned book via Comic Vine ───────────────────────────
// ─── Adjacent books (prev/next in series or event) ───────────────
// GET /api/books/:id/adjacent?eventId=X&canonRunId=Y&minTier=recommended
// Returns { prev, next } in event or canon run context, falls back to series
app.get('/api/books/:id/adjacent', requireAuth, (req, res) => {
  const { eventId, canonRunId, listId, minTier } = req.query;
  const bookId = req.params.id;

  const book = db.prepare('SELECT * FROM scanned_books WHERE id = ?').get(bookId);
  if (!book) return res.status(404).json({ error: 'Not found' });

  // Reading list context (readingLists.js): prev/next owned issue in list order.
  if (listId) {
    try {
      const r = readingLists.adjacent(listId, bookId, req.user);
      if (!r) return res.status(404).json({ error: 'Reading list not found' });
      return res.json(withLabels({ ...r, context: { kind: 'list', id: listId, name: r.listName, position: r.position, total: r.total } }));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (eventId) {
    const { getEventPathIssues, eventReadingPath } = require('./eventReadingPath');
    const issues = getEventPathIssues(db, eventId, req.user?.sub);
    const result = eventReadingPath(issues, bookId, minTier);
    const ev = db.prepare('SELECT name FROM events WHERE id = ?').get(eventId);
    const here = issues.find(i => i.scanned_book_id === bookId);
    const fmt = i => i ? { id: i.scanned_book_id, title: i.display_title || (i.series_name + ' #' + i.issue_number),
      series_name: i.series_name, issue_number: i.issue_number, tier: i.tier, note: i.tier_note || null } : null;
    const { path, position, total, remainingOther } = result;
    return res.json(withLabels({ prev: fmt(result.prev), next: fmt(result.next), nextAll: fmt(result.nextAll),
      nextRecommended: fmt(result.nextRecommended), nextEssential: fmt(result.nextEssential),
      context: { kind: 'event', id: eventId, name: ev?.name || 'Event', path, position, total, remainingOther,
        tier: here?.tier || null, note: here?.tier_note || null } }));
  }

  if (canonRunId) {
    const issues = db.prepare(`
      SELECT cri.sort_order, cri.scanned_book_id,
             cri.series_name, cri.issue_number,
             COALESCE(sb.title, sb.filename) AS display_title
      FROM canon_run_issues cri
      JOIN scanned_books sb ON sb.id = CAST(cri.scanned_book_id AS TEXT)
      WHERE cri.run_id = ? AND cri.scanned_book_id IS NOT NULL
      ORDER BY cri.sort_order
    `).all(canonRunId);

    const idx = issues.findIndex(i => i.scanned_book_id === bookId);
    const run = db.prepare('SELECT title FROM canon_runs WHERE id = ?').get(canonRunId);
    const runAll = db.prepare('SELECT scanned_book_id FROM canon_run_issues WHERE run_id = ? ORDER BY sort_order').all(canonRunId);
    const runStop = runAll.findIndex(i => i.scanned_book_id === bookId);
    const runContext = { kind: 'run', id: canonRunId, name: run?.title || 'Top Shelf run', position: runStop === -1 ? null : runStop + 1, total: runAll.length };
    if (idx === -1) return res.json({ prev: null, next: null, context: runContext });

    const fmt = i => i ? {
      id: i.scanned_book_id,
      title: i.display_title || (i.series_name + ' #' + i.issue_number),
      series_name: i.series_name,
      issue_number: i.issue_number,
    } : null;

    return res.json(withLabels({ prev: fmt(issues[idx - 1]), next: fmt(issues[idx + 1]), context: runContext }));
  }

  // Series context fallback
  const siblings = db.prepare(`
    SELECT id, COALESCE(title, filename) AS display_title, sort_order
    FROM scanned_books WHERE series_id = ? ORDER BY sort_order
  `).all(book.series_id);

  const idx = siblings.findIndex(b => b.id === bookId);
  const ser = db.prepare('SELECT name FROM scanned_series WHERE id = ?').get(book.series_id);
  const serContext = { kind: 'series', id: book.series_id, name: ser?.name || 'Series', position: idx === -1 ? null : idx + 1, total: siblings.length };
  if (idx === -1) return res.json({ prev: null, next: null, context: serContext });

  const fmt = b => b ? { id: b.id, title: b.display_title } : null;
  res.json(withLabels({ prev: fmt(siblings[idx - 1]), next: fmt(siblings[idx + 1]), context: serContext }));
});

// Reader end-of-issue card: series name, issue number and the issue's own
// title (ComicInfo) for each neighbour, so the card can show "#12 · Title".
function readerLabel(bookId) {
  const b = db.prepare(`SELECT sb.issue_number, sb.comicinfo, ss.name AS series_name
    FROM scanned_books sb LEFT JOIN scanned_series ss ON ss.id = sb.series_id WHERE sb.id = ?`).get(bookId);
  if (!b) return {};
  let ci = {};
  try { ci = b.comicinfo ? parseComicInfo(b.comicinfo) : {}; } catch {}
  return { series_name: ci.series || b.series_name || null, issue_number: b.issue_number || ci.number || null, issue_title: (ci.title || '').trim() || null };
}
function withLabels(r) {
  const add = o => {
    if (!o?.id) return o || null;
    const L = readerLabel(o.id);
    return { ...o, series_name: o.series_name || L.series_name, issue_number: o.issue_number || L.issue_number, issue_title: L.issue_title };
  };
  for (const k of ['prev', 'next', 'nextAll', 'nextRecommended', 'nextEssential']) if (k in r) r[k] = add(r[k]);
  // The next issue's solicit, for the end card's "About the next issue".
  if (r.next?.id) {
    const b = db.prepare('SELECT comicinfo FROM scanned_books WHERE id = ?').get(r.next.id);
    r.next = { ...r.next, solicit: require('./eventNotes').solicitOf(b?.comicinfo, 1500) };
  }
  return r;
}

// ─── CV issue search (for manual tagging intervention) ───────────
// GET /api/cv/issues/search?q=  — paste a CV URL or 4000-NNNNN
app.get('/api/cv/issues/search', requireAuth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ results: [] });
    const CV_API_KEY = getCVKey();

    // Parse CV issue ID from URL or bare 4000-NNNNN or just NNNNN
    const urlMatch = q.match(/4000-(\d+)/);
    const bareMatch = !urlMatch && q.trim().match(/^(\d{4,})$/);
    const cvId = urlMatch ? urlMatch[1] : (bareMatch ? bareMatch[1] : null);

    if (!cvId) return res.json({ results: [] });

    const r = await cvApiGet(`https://comicvine.gamespot.com/api/issue/4000-${cvId}/`, {
      params: {
        api_key: getCVKey(), format: 'json',
        field_list: 'id,issue_number,name,cover_date,volume,site_detail_url,image',
      },
      headers: { 'User-Agent': 'Omnibus/1.0' },
    });
    const issue = r.data.results;
    if (!issue || !issue.id) return res.json({ results: [] });
    res.json({ results: [{
      id: issue.id,
      issue_number: issue.issue_number,
      name: issue.name,
      cover_date: issue.cover_date,
      volume_name: issue.volume?.name,
      site_detail_url: issue.site_detail_url,
      cover_url: issue.image?.medium_url || null,
    }]});
  } catch (e) {
    logger.error('tag', 'CV issue search failed', e.message);
    res.json({ results: [] });
  }
});

// Phase 4.1: all existing-book retag controls use the shared runtime.
const retagHandlers = require('./metadata/retagRoutes').createRetagHandlers({getRuntime: () => metadataRuntime, logger,
  prefetch: bookId => { const id = db.prepare('SELECT cv_issue_id FROM scanned_books WHERE id = ?').get(bookId)?.cv_issue_id;
    if (/^\d+$/.test(String(id || ''))) fetchCvIssue(Number(id)).catch(() => null); }});
app.post('/api/books/:id/tag', requireAdmin, retagHandlers.single);


// Shared numbering helper; legacy folder-sweeper selectors and startup writes retired.
function normIssueNum(s) {
  const raw = String(s ?? '').trim();
  if (!raw) return '';
  const dot = raw.indexOf('.');
  if (dot === -1) return String(parseInt(raw, 10) || 0) + (raw.replace(/^\d+/, '').toLowerCase());
  return String(parseInt(raw.slice(0, dot), 10) || 0) + raw.slice(dot).toLowerCase();
}
async function runUntaggedSweep() {
  return cvCtx.run({lane:'background',caller:'library-metadata'},()=>metadataMaintenance.run());
}
// Automatic metadata scheduling is owned by the Central-time maintenance pump.

app.get('/api/admin/untagged-sweep', requireAdmin, (req,res)=>{
  try{res.json(metadataMaintenance.status());}catch(e){res.status(500).json({error:e.message});}
});

// Retired folder-based actions must not restart the legacy selector.
app.post('/api/admin/untagged-sweep/extra-volume', requireAdmin, (req,res)=>res.status(410).json({error:'Folder sweeper controls are retired. Choose the Comic Vine issue for an individual book.'}));
app.delete('/api/admin/untagged-sweep/extra-volume/:seriesId/:volumeId', requireAdmin, (req,res)=>res.status(410).json({error:'Folder sweeper controls are retired.'}));
app.post('/api/admin/untagged-sweep/run', requireAdmin, async(req,res)=>{
  try{const work=cvCtx.run({lane:'background',caller:'library-metadata'},()=>metadataMaintenance.run());await require('./metadata/respondToCheck').respondToCheck({work,res,logger});}catch(e){retagHandlers.errorResponse(res,e);}
});

app.get('/api/books/:id/thumbnail', async (req, res) => {
  try {
    const book = db.prepare('SELECT * FROM scanned_books WHERE id = ?').get(req.params.id);
    if (!book) return res.status(404).send();
    await streamArchivePage(book.path, 0, res, book.id);
  } catch (e) { res.status(404).send(); }
});

// ─── Thumbnail cache eviction ─────────────────────────────────────
// DELETE /api/books/:id/thumbnail/cache — bust a single book's cached thumb
// DELETE /api/series/:id/thumbnail/cache — bust a series thumb cache
// Called automatically by the library scanner when a book's path changes.
app.delete('/api/books/:id/thumbnail/cache', requireAdmin, (req, res) => {
  evictThumbCache(req.params.id);
  res.json({ ok: true });
});
app.delete('/api/series/:id/thumbnail/cache', requireAdmin, (req, res) => {
  evictThumbCache(`series_${req.params.id}`);
  res.json({ ok: true });
});

// DELETE /api/thumbnails/all — clear entire thumb cache
app.delete('/api/thumbnails/all', requireAdmin, (req, res) => {
  try {
    const files = fs.readdirSync(THUMB_CACHE_DIR);
    let count = 0;
    for (const f of files) {
      try { fs.unlinkSync(path.join(THUMB_CACHE_DIR, f)); count++; } catch {}
    }
    try { fs.rmSync(path.join(THUMB_CACHE_DIR, 'pages'), { recursive: true, force: true }); } catch {}   // reader page thumbs
    thumbCacheGen = Date.now(); // invalidate all browser ETags
    logger.info('thumbcache', `Cleared all thumbnails`, { count });
    res.json({ ok: true, cleared: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Right-to-left covers (2026-11-10) ─────────────────────────────
// A manga's wraparound cover has its front on the LEFT; western comics' on the right, which is
// what the app shows by default (components/spreadCovers.js). The books and series read right to
// left: series marked Manga in the Download Manager, and books whose ComicInfo says
// YesAndRightToLeft. A short list (2 series in the Nov 9 library), kept for 10 minutes.
let rtlCovers = null;
app.get('/api/covers/right-to-left', requireAuth, (req, res) => {
  try {
    if (!rtlCovers || Date.now() - rtlCovers.at > 10 * 60 * 1000) {
      const rows = db.prepare(`SELECT sb.id, sb.series_id FROM scanned_books sb JOIN scanned_series ss ON ss.id = sb.series_id
        LEFT JOIN monitored_series ms ON ms.id = ss.monitored_series_id
        WHERE ms.series_type = 'manga' OR sb.comicinfo LIKE '%<Manga>YesAndRightToLeft</Manga>%'`).all();
      rtlCovers = { at: Date.now(), books: rows.map(r => String(r.id)), series: [...new Set(rows.map(r => String(r.series_id)))] };
    }
    res.json({ books: rtlCovers.books, series: rtlCovers.series });
  } catch (e) { res.json({ books: [], series: [] }); }
});

// ─── Container restart ─────────────────────────────────────────────
//
// POST /api/admin/restart
//
// Triggers a graceful container exit; Docker's restart policy brings the
// container back up automatically (assuming `restart: unless-stopped` or
// equivalent in compose). The user-facing flow is:
//   1. UI confirms ("any in-progress downloads will be cancelled — proceed?")
//   2. Backend marks every entry in activeDownloads as cancelled so workers
//      checkpoint and stop cleanly rather than orphaning partial files
//   3. Backend responds 202 immediately so the frontend knows the restart
//      is in motion before the connection drops
//   4. process.exit(0) after a 1-second delay so the response actually
//      flushes back to the client (without the delay, the exit can race
//      the response write and the user sees a connection-reset error)
app.post('/api/admin/restart', requireAdmin, (req, res) => {
  logger.warn('admin', 'Restart requested — cancelling active downloads and exiting');
  // Mark every active download as cancelled. Workers check isCancelled() at
  // their checkpoints and finalize cleanly. AbortControllers fire to abort
  // any in-flight axios streams immediately.
  let cancelled = 0;
  for (const [, entry] of activeDownloads) {
    entry.cancel = true;
    try { entry.abortController?.abort(); } catch {}
    cancelled++;
  }
  res.status(202).json({ ok: true, cancelled, message: 'Restarting…' });
  setTimeout(() => {
    logger.warn('admin', 'Exiting now for restart');
    process.exit(0);
  }, 1000);
});

// ─── Inventory report (for AI gap-analysis) ────────────────────────
//
// GET /api/reports/inventory?format=md|json
//
// Produces a flat dump of three things, grouped by publisher:
//   1. Monitored series (with year + completion status)
//   2. Events (with year + issue counts)
//   3. Top Shelf (canon runs, with year + category tags)
//
// The default format is markdown — designed for the user to copy into an AI
// chat and ask "what major X am I missing?" Series within each publisher are
// sorted alphabetically; events and runs by year then alphabetically. Each
// section starts with a count so the AI can sanity-check coverage at a
// glance. JSON format is provided for any future programmatic use.
//
// Publisher derivation:
//   - monitored_series: direct `publisher` column
//   - events: direct `publisher` column
//   - canon_runs: NO publisher column on the table. Best-effort derivation:
//     parent_series → monitored_series.publisher lookup, fall back to
//     "Unknown" when no monitored series with that name exists. For canon
//     runs that span multiple ongoing series, the parent_series field
//     usually names the principal one, which is good enough for grouping.
app.get('/api/reports/inventory', requireAdmin, (req, res) => {
  try {
    const fmt = (req.query.format || 'md').toLowerCase();

    // ── Series ──────────────────────────────────────────────────────
    // Use scanned_series (actual library) not monitored_series (download tracker).
    // Publisher comes from series_json metadata, falling back to library name.
    const series = db.prepare(`
      SELECT
        ss.name,
        ss.year,
        ss.book_count as have_issues,
        COALESCE(
          json_extract(ss.series_json, '$.metadata.publisher'),
          l.name
        ) as publisher
      FROM scanned_series ss
      JOIN libraries l ON l.id = ss.library_id
      WHERE ss.book_count > 0
      ORDER BY publisher COLLATE NOCASE, ss.name COLLATE NOCASE
    `).all();

    // ── Events ──────────────────────────────────────────────────────
    // Issue count comes from event_issues; some events have zero (manual
    // events the user hasn't populated yet) and we still want them visible.
    const events = db.prepare(`
      SELECT
        e.name,
        e.publisher,
        e.year,
        (SELECT COUNT(*) FROM event_issues ei WHERE ei.event_id = e.id) AS issue_count,
        (SELECT COUNT(*) FROM event_issues ei WHERE ei.event_id = e.id AND ei.scanned_book_id IS NOT NULL) AS owned_count
      FROM events e
      ORDER BY e.publisher COLLATE NOCASE, e.year, e.name COLLATE NOCASE
    `).all();

    // ── Canon runs (Top Shelf) ──────────────────────────────────────
    // Categories are 1:N — concat them so each run renders as one row in
    // the report. parent_series may be null for runs that span series
    // (e.g. crossover collections); we surface that as "—".
    const runs = db.prepare(`
      SELECT
        cr.title,
        cr.parent_series,
        cr.issue_range_hint,
        cr.status,
        (SELECT GROUP_CONCAT(category, ', ') FROM canon_run_categories WHERE run_id = cr.id) AS categories,
        (SELECT COUNT(*) FROM canon_run_issues WHERE run_id = cr.id) AS issue_count,
        (SELECT COUNT(*) FROM canon_run_issues WHERE run_id = cr.id AND scanned_book_id IS NOT NULL) AS owned_count
      FROM canon_runs cr
      ORDER BY cr.parent_series COLLATE NOCASE, cr.title COLLATE NOCASE
    `).all();

    // Build a parent_series → publisher lookup so we can group runs
    // under their parent series' publisher.
    const seriesPublisherLookup = new Map();
    for (const s of series) {
      seriesPublisherLookup.set(s.name.toLowerCase(), s.publisher || 'Unknown');
    }
    const runsWithPublisher = runs.map(r => ({
      ...r,
      publisher: r.parent_series
        ? (seriesPublisherLookup.get(r.parent_series.toLowerCase()) || 'Unknown')
        : 'Unknown',
    }));

    // ── Group helpers ───────────────────────────────────────────────
    const groupByPublisher = (items) => {
      const groups = new Map();
      for (const item of items) {
        const pub = item.publisher || 'Unknown';
        if (!groups.has(pub)) groups.set(pub, []);
        groups.get(pub).push(item);
      }
      // Sort publishers alphabetically, with "Unknown" pushed to the end
      return [...groups.entries()].sort((a, b) => {
        if (a[0] === 'Unknown') return 1;
        if (b[0] === 'Unknown') return -1;
        return a[0].localeCompare(b[0]);
      });
    };

    if (fmt === 'json') {
      return res.json({
        generated_at: new Date().toISOString(),
        series: series,
        events: events,
        canon_runs: runsWithPublisher,
        totals: {
          series: series.length,
          total_issues: series.reduce((a, s) => a + (s.have_issues || 0), 0),
          events: events.length,
          canon_runs: runs.length,
        },
      });
    }

    // ── Markdown rendering ──────────────────────────────────────────
    const lines = [];
    const today = new Date().toISOString().slice(0, 10);
    lines.push(`# Omnibus Inventory Report`);
    lines.push(`*Generated ${today}*`);
    lines.push('');
    const totalIssues = series.reduce((a, s) => a + (s.have_issues || 0), 0);
    lines.push(`Totals: **${series.length}** series · **${totalIssues}** issues owned · **${events.length}** events · **${runs.length}** Top Shelf canon runs`);
    lines.push('');
    lines.push(`---`);
    lines.push('');

    // Series
    lines.push(`## Monitored Series (${series.length})`);
    lines.push('');
    for (const [pub, group] of groupByPublisher(series)) {
      lines.push(`### ${pub} (${group.length})`);
      lines.push('');
      for (const s of group) {
        const yearPart  = s.year ? ` (${s.year})` : '';
        const issuePart = s.have_issues > 0 ? `  — ${s.have_issues} issue${s.have_issues !== 1 ? 's' : ''}` : '';
        lines.push(`- ${s.name}${yearPart}${issuePart}`);
      }
      lines.push('');
    }
    lines.push(`---`);
    lines.push('');

    // Events
    lines.push(`## Events (${events.length})`);
    lines.push('');
    for (const [pub, group] of groupByPublisher(events)) {
      lines.push(`### ${pub} (${group.length})`);
      lines.push('');
      // Within publisher, sort events by year (oldest first) so chronology is visible
      const sorted = [...group].sort((a, b) => (a.year || 9999) - (b.year || 9999) || a.name.localeCompare(b.name));
      for (const e of sorted) {
        const yearPart  = e.year ? ` (${e.year})` : '';
        const issueInfo = (e.issue_count || 0) > 0
          ? `  — ${e.owned_count || 0}/${e.issue_count} owned`
          : '';
        lines.push(`- ${e.name}${yearPart}${issueInfo}`);
      }
      lines.push('');
    }
    lines.push(`---`);
    lines.push('');

    // Top Shelf / canon runs
    lines.push(`## Top Shelf — Canon Runs (${runs.length})`);
    lines.push('');
    for (const [pub, group] of groupByPublisher(runsWithPublisher)) {
      lines.push(`### ${pub} (${group.length})`);
      lines.push('');
      for (const r of group) {
        const parent     = r.parent_series ? ` *(${r.parent_series})*` : '';
        const range      = r.issue_range_hint ? ` ${r.issue_range_hint}` : '';
        const cats       = r.categories ? `  — ${r.categories}` : '';
        const issueInfo  = (r.issue_count || 0) > 0
          ? `  — ${r.owned_count || 0}/${r.issue_count} owned`
          : '';
        lines.push(`- ${r.title}${range}${parent}${cats}${issueInfo}`);
      }
      lines.push('');
    }

    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="omnibus-inventory-${today}.md"`);
    res.send(lines.join('\n'));
  } catch (e) {
    logger.error('reports', 'Inventory report failed', { error: e.message, stack: e.stack });
    res.status(500).json({ error: e.message });
  }
});

// ─── Batch book operations ────────────────────────────────────────

// POST /api/books/batch/mark-read — mark books as read or unread
app.post('/api/books/batch/mark-read', requireAuth, (req, res) => {
  try {
    const { bookIds, completed = true } = req.body;
    if (!Array.isArray(bookIds) || !bookIds.length) return res.status(400).json({ error: 'bookIds required' });
    const userId = req.user?.sub || null;
    const completedVal = completed ? 1 : 0;
    const stmt = db.prepare(`
      INSERT INTO read_progress (book_id, user_id, page, completed, updated_at, marked)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(user_id, book_id) DO UPDATE SET
        page = CASE WHEN excluded.completed = 1 THEN (SELECT COALESCE(MAX(page), 0) FROM read_progress WHERE book_id = excluded.book_id AND user_id IS excluded.user_id) ELSE 0 END,
        -- a book already read or being read in the reader stays real reading
        marked = CASE WHEN excluded.completed = 0 THEN 0
                      WHEN COALESCE(read_progress.marked, 0) = 0 AND (read_progress.completed = 1 OR read_progress.page > 0) THEN 0
                      ELSE 1 END,
        completed = excluded.completed,
        updated_at = CURRENT_TIMESTAMP
    `);
    // Unread clears every trace of reading for the book (page, completion,
    // history mark), so test opens and mistakes leave Continue Reading too.
    const clear = db.prepare('DELETE FROM read_progress WHERE book_id = ? AND user_id IS ?');
    const markMany = db.transaction(() => {
      for (const bookId of bookIds) completedVal ? stmt.run(bookId, userId, 999, 1, 1) : clear.run(bookId, userId);
    });
    markMany();
    res.json({ ok: true, count: bookIds.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/series/batch/mark-read — every issue, special and annual of the
// given series (books in each series folder, plus linked annual volumes),
// read or unread for the signed-in reader.
app.post('/api/series/batch/mark-read', requireAuth, (req, res) => {
  try {
    const { seriesIds, completed = true } = req.body || {};
    if (!Array.isArray(seriesIds) || !seriesIds.length) return res.status(400).json({ error: 'seriesIds required' });
    if (seriesIds.length > 2000) return res.status(400).json({ error: 'Too many series at once' });
    const userId = req.user?.sub || null;
    const ids = new Set();
    const booksOf = db.prepare('SELECT id FROM scanned_books WHERE series_id = ?');
    const annualSeries = db.prepare(`SELECT ss.id FROM scanned_series p
      JOIN series_annual_links l ON l.parent_series_id = p.monitored_series_id
      JOIN scanned_series ss ON ss.monitored_series_id = l.annual_series_id WHERE p.id = ?`);
    for (const sid of seriesIds.map(String)) {
      for (const b of booksOf.all(sid)) ids.add(b.id);
      for (const a of annualSeries.all(sid)) for (const b of booksOf.all(a.id)) ids.add(b.id);
    }
    const completedVal = completed ? 1 : 0;
    const stmt = db.prepare(`
      INSERT INTO read_progress (book_id, user_id, page, completed, updated_at, marked)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(user_id, book_id) DO UPDATE SET
        page = CASE WHEN excluded.completed = 1 THEN (SELECT COALESCE(MAX(page), 0) FROM read_progress WHERE book_id = excluded.book_id AND user_id IS excluded.user_id) ELSE 0 END,
        -- a book already read or being read in the reader stays real reading
        marked = CASE WHEN excluded.completed = 0 THEN 0
                      WHEN COALESCE(read_progress.marked, 0) = 0 AND (read_progress.completed = 1 OR read_progress.page > 0) THEN 0
                      ELSE 1 END,
        completed = excluded.completed,
        updated_at = CURRENT_TIMESTAMP
    `);
    const clear = db.prepare('DELETE FROM read_progress WHERE book_id = ? AND user_id IS ?');   // unread: no trace left
    db.transaction(() => { for (const bookId of ids) completedVal ? stmt.run(bookId, userId, 999, 1, 1) : clear.run(bookId, userId); })();
    res.json({ ok: true, count: ids.size, series: seriesIds.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Series-detail deletion: disk and catalog, serialized with other library work.
app.delete('/api/series/:id', requireAdmin, libraryAccess.route('write', (req,res)=>{
  try {
    if(scanState.running||metadataRuntime.status().length||[...activeDownloads.values()].some(d=>!['completed','failed','cancelled'].includes(d.status)))return res.status(409).json({error:'Finish active library work and downloads before deleting a series.'});
    const result=require('./deleteLibrarySeries').deleteSeries(db,req.params.id,req.body?.confirmName);
    for(const id of result.bookIds)evictThumbCache(id);
    jsonMemCache.delete(req.params.id);invalidateSeriesJsonCache(req.params.id);invalidateDirectoryExistsCache(req.params.id);
    logger.warn('library','Series and files deleted',{seriesId:req.params.id,user:req.user?.sub});
    res.json({ok:true});
  }catch(e){res.status(e.status||500).json({error:e.status?e.message:'Deletion could not finish. Some files may have been removed; the library records were retained. '+e.message});}
}));

// DELETE /api/books/batch — delete book files + DB records
app.delete('/api/books/batch', requireAdmin, (req, res) => {
  try {
    const { bookIds } = req.body;
    if (!Array.isArray(bookIds) || !bookIds.length) return res.status(400).json({ error: 'bookIds required' });
    const deleted = [], errors = [];
    for (const bookId of bookIds) {
      const book = db.prepare('SELECT * FROM scanned_books WHERE id = ?').get(bookId);
      if (!book) { errors.push({ bookId, error: 'Not found' }); continue; }
      try {
        if (book.path && fs.existsSync(book.path)) fs.unlinkSync(book.path);
        monitoredIssueGone(book, 'deleted in Omnibus');
        db.prepare('DELETE FROM read_progress WHERE book_id = ?').run(bookId);
        db.prepare('DELETE FROM scanned_books WHERE id = ?').run(bookId);
        evictThumbCache(bookId);
        deleted.push(bookId);
      } catch (e) { errors.push({ bookId, error: e.message }); }
    }
    res.json({ ok: true, deleted, errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/books/batch/retag — retag multiple books with fresh ComicInfo.xml
app.post('/api/books/batch/retag', requireAdmin, retagHandlers.batch);


// GET /api/books/:id/pages
// Returns { count } — number of image pages in the archive.
// Used by the reader on load to know total pages without fetching images.
app.get('/api/books/:id/pages', async (req, res) => {
  try {
    const book = db.prepare('SELECT * FROM scanned_books WHERE id = ?').get(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    const files = await listArchiveFiles(book.path);
    const images = filterImages(files);
    res.json({ count: images.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Reader: stream a specific page (0-indexed) ───────────────────
// GET /api/books/:id/pages/:page
// Streams the image for page N (0-indexed) from the archive.
// Full pages require a reader session and must not enter shared/browser caches.
// The reader preloads page N+1 by creating an <img> with this URL.
app.get('/api/books/:id/pages/:page', async (req, res) => {
  try {
    const book = db.prepare('SELECT * FROM scanned_books WHERE id = ?').get(req.params.id);
    if (!book) return res.status(404).send();
    const pageIndex = Math.max(0, parseInt(req.params.page, 10) || 0);
    await streamArchivePage(book.path, pageIndex, res);
  } catch (e) {
    logger.error('reader', `Page ${req.params.page} failed for book ${req.params.id}`, e.message);
    res.status(404).send();
  }
});

// ─── Reader: small page thumbnail for the page overview ──────────
// GET /api/books/:id/page-thumbs/:page — 240px-wide JPEG, cached on disk under
// thumbcache/pages/<bookId>_<mtime>/ (a changed file gets fresh thumbs).
const _pageListCache = new Map();   // path|mtime -> sorted image names (overview asks for every page)
async function pageImagesCached(book) {
  const key = `${book.path}|${book.file_mtime || 0}`;
  const hit = _pageListCache.get(key);
  if (hit) return hit;
  const images = filterImages(await listArchiveFiles(book.path));
  _pageListCache.set(key, images);
  if (_pageListCache.size > 50) _pageListCache.delete(_pageListCache.keys().next().value);
  return images;
}
app.get('/api/books/:id/page-thumbs/:page', async (req, res) => {
  try {
    const book = db.prepare('SELECT * FROM scanned_books WHERE id = ?').get(req.params.id);
    if (!book) return res.status(404).send();
    const n = Math.max(0, parseInt(req.params.page, 10) || 0);
    const dir = path.join(THUMB_CACHE_DIR, 'pages', `${book.id}_${book.file_mtime || 0}`);
    const file = path.join(dir, `${n}.jpg`);
    res.set('Cache-Control', 'private, no-store');
    if (fs.existsSync(file)) return res.type('image/jpeg').sendFile(file);
    await withThumbSlot(async () => {
      const images = await pageImagesCached(book);
      if (!images.length || n >= images.length) return res.status(404).send();
      const target = images[n];
      let stdout;
      try { stdout = await readArchiveMember(book.path, target); }
      catch (e) { return res.status(404).send(); }
      const out = await require('sharp')(stdout).resize({ width: 240, withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
      try { await fs.promises.mkdir(dir, { recursive: true }); await fs.promises.writeFile(file, out); } catch {}
      res.type('image/jpeg').send(out);
    });
  } catch (e) {
    logger.error('reader', `Page thumb ${req.params.page} failed for book ${req.params.id}`, e.message);
    if (!res.headersSent) res.status(404).send();
  }
});

// Helper: stream a specific page (0-indexed) from a comic archive
// Pass cacheKey (e.g. book ID) to enable disk caching for thumbnails.
async function streamArchivePage(filePath, pageIndex, res, cacheKey = null) {
  // ── Serve from disk cache if available ──────────────────────────
  if (cacheKey) {
    const hit = findThumbCache(cacheKey);
    if (hit) {
      const mime = hit.ext === '.png' ? 'image/png' : hit.ext === '.gif' ? 'image/gif' : hit.ext === '.webp' ? 'image/webp' : 'image/jpeg';
      // The cached file's time is part of the ETag: a thumbnail made again from a replaced file
      // (same book id) is fetched anew instead of the browser's old copy (2026-10-17).
      let fileTime = 0; try { fileTime = Math.floor(fs.statSync(hit.filePath).mtimeMs); } catch {}
      const etag = `"${cacheKey}-${thumbCacheGen}-${fileTime}"`;
      if (res.req && res.req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }
      res.set('Content-Type', mime);
      res.set('Cache-Control', cacheKey ? 'public, max-age=0, must-revalidate' : 'private, no-store');
      res.set('ETag', etag);
      return res.sendFile(hit.filePath);
    }
  }
  // ── Extract from archive (rate-limited) ─────────────────────────
  await withThumbSlot(async () => {
    try {
      const files = await listArchiveFiles(filePath);
      const images = filterImages(files);
      if (!images.length) return res.status(404).send();
      const target = images[Math.min(pageIndex, images.length - 1)];
      const archExt = path.extname(filePath).toLowerCase();
      let stdout;
      try {
        stdout = await readArchiveMember(filePath, target);
      } catch (extractErr) {
        logger.error('thumb', `extraction failed`, { filePath, target, error: extractErr.message, stderr: extractErr.stderr?.slice(0,200) });
        return res.status(404).send();
      }
      let ext = path.extname(target).toLowerCase() || '.jpg';
      let mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      let fileTime = 0;
      if (cacheKey) {
        // A cover for a shelf: cached and sent resized (coverThumb.js). Reader pages (no cacheKey) stay full size.
        const t = await coverThumb(stdout, ext);
        stdout = t.buf; ext = t.ext; mime = t.mime;
        const cachePath = path.join(THUMB_CACHE_DIR, `${cacheKey}${ext}`);
        await fs.promises.writeFile(cachePath, stdout);
        try { fileTime = Math.floor(fs.statSync(cachePath).mtimeMs); } catch {}
      }
      const etag = cacheKey ? `"${cacheKey}-${thumbCacheGen}-${fileTime}"` : null;
      if (etag && res.req && res.req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }
      res.set('Content-Type', mime);
      res.set('Cache-Control', cacheKey ? 'public, max-age=0, must-revalidate' : 'private, no-store');
      if (etag) res.set('ETag', etag);
      res.send(stdout);
    } catch (e) {
      logger.error('thumb', `streamArchivePage failed`, { filePath, error: e.message });
      if (!res.headersSent) res.status(404).send();
    }
  });
}

// ─── Read progress ────────────────────────────────────────────────
// GET /api/read-progress/:bookId — fetch current page + completed flag
app.get('/api/read-progress/:bookId', requireAuth, (req, res) => {
  try {
    const userId = req.user?.sub || null;
    const row = db.prepare(
      'SELECT page, completed FROM read_progress WHERE book_id = ? AND (user_id = ? OR user_id IS NULL)'
    ).get(req.params.bookId, userId);
    res.json(row || { page: 0, completed: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/read-progress/:bookId — upsert page position and completed flag
// Body: { page: Number, completed: Boolean }
app.put('/api/read-progress/:bookId', requireAuth, (req, res) => {
  try {
    const { bookId } = req.params;
    const { page, completed } = req.body;
    if (page === undefined) return res.status(400).json({ error: 'page is required' });
    const pageNum = Math.max(0, Math.floor(Number(page)));
    const completedVal = completed ? 1 : 0;
    const userId = req.user?.sub || null;

    let earned = [];
    if (userId) {
      // An issue read to its last page goes in the achievements' reading log (the reader sends
      // finished; older readers only the switch to completed). "Mark as read" never counts.
      const prev = db.prepare('SELECT completed FROM read_progress WHERE book_id = ? AND user_id = ?').get(bookId, userId);
      // Authenticated user — upsert on (user_id, book_id) unique index
      db.prepare(`
        INSERT INTO read_progress (book_id, user_id, page, completed, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, book_id) DO UPDATE SET
          page       = excluded.page,
          completed  = excluded.completed,
          marked     = 0,
          updated_at = CURRENT_TIMESTAMP
      `).run(bookId, userId, pageNum, completedVal);
      // The reading context the reader is in (event / run / list), for Continue Reading.
      try { readingContexts?.record(userId, bookId, require('./readingContexts').parse(req.body.context), { page: pageNum, completed: completedVal }); }
      catch (e) { logger.warn('progress', 'Reading context not saved', e.message); }
      if (completedVal && (req.body.finished || !prev?.completed)) {
        try { earned = achievements ? achievements.recordFinish(userId, bookId, { tz: req.body.tz, pages: req.body.pages, seconds: req.body.seconds, context: req.body.context ? JSON.stringify(req.body.context) : null }) : []; }
        catch (e) { logger.warn('achievements', 'Reading log not saved', e.message); }
      }
    } else {
      // No user context — update existing row if present, else insert
      const existing = db.prepare('SELECT id FROM read_progress WHERE book_id = ? AND user_id IS NULL').get(bookId);
      if (existing) {
        db.prepare('UPDATE read_progress SET page=?, completed=?, marked=0, updated_at=CURRENT_TIMESTAMP WHERE book_id=? AND user_id IS NULL')
          .run(pageNum, completedVal, bookId);
      } else {
        db.prepare('INSERT INTO read_progress (book_id, user_id, page, completed) VALUES (?, NULL, ?, ?)')
          .run(bookId, pageNum, completedVal);
      }
    }

    res.json({ ok: true, bookId, page: pageNum, completed: completedVal, ...(earned.length ? { achievements: earned } : {}) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/series/:id/metadata', requireAdmin, (req, res) => {
  // With scanner, metadata lives in series.json — patch name/year on scanned_series row
  try {
    const { name, year } = req.body;
    if (name !== undefined || year !== undefined) {
      const parts = [], vals = [];
      if (name !== undefined) { parts.push('name = ?'); vals.push(name); }
      if (year !== undefined) { parts.push('year = ?'); vals.push(year); }
      vals.push(req.params.id);
      db.prepare(`UPDATE scanned_series SET ${parts.join(', ')} WHERE id = ?`).run(...vals);
      invalidateSeriesCache();
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Write series.json back to disk
app.put('/api/series/:id/series-json', requireAdmin, (req, res) => {
  try {
    const { content } = req.body;
    JSON.parse(content); // validate JSON
    const row = db.prepare('SELECT path FROM scanned_series WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Series not found' });
    if (!fs.existsSync(row.path)) return res.status(404).json({ error: `Series folder not found: ${row.path}` });
    const jsonPath = seriesJsonPath(row.path);
    fs.writeFileSync(jsonPath, content, 'utf8');
    // Invalidate both caches + update metadata_status in DB
    db.prepare('DELETE FROM series_json_cache WHERE series_id = ?').run(req.params.id);
    jsonMemCache.delete(req.params.id);
    const parsed = JSON.parse(content);
    const newStatus = deriveMetadataStatus(parsed);
    db.prepare('UPDATE scanned_series SET metadata_status = ?, series_json = ? WHERE id = ?').run(newStatus, content, req.params.id);
    invalidateSeriesCache();
    scheduleGroupingRun('series.json edited');
    res.json({ success: true, path: jsonPath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/series/:id/scrape-creators
// Aggregates writers/pencillers/etc from all ComicInfo.xmls in the series,
// picks the top contributors (≥10% of issues), and writes them to series.json.
// If no series.json exists yet it creates one with just the creator data.
app.post('/api/series/:id/scrape-creators', requireAdmin, async (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM scanned_series WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Series not found' });

    const totalBooks = db.prepare(
      'SELECT COUNT(*) as n FROM scanned_books WHERE series_id = ?'
    ).get(row.id).n;

    // Minimum threshold: appear in at least 10% of issues (floor 1)
    const threshold = Math.max(1, Math.floor(totalBooks * 0.10));

    // Get per-role counts
    const books = db.prepare(
      'SELECT comicinfo FROM scanned_books WHERE series_id = ? AND comicinfo IS NOT NULL'
    ).all(row.id);

    const roleCounts = {
      writers: {}, pencillers: {}, inkers: {},
      colorists: {}, cover_artists: {},
    };
    const roleFieldMap = {
      writers: 'writer', pencillers: 'penciller', inkers: 'inker',
      colorists: 'colorist', cover_artists: 'coverArtist',
    };

    books.forEach(b => {
      const ci = parseComicInfo(b.comicinfo);
      Object.entries(roleFieldMap).forEach(([jsonKey, ciKey]) => {
        const val = ci[ciKey];
        if (!val) return;
        val.split(',').map(n => n.trim()).filter(Boolean).forEach(name => {
          roleCounts[jsonKey][name] = (roleCounts[jsonKey][name] || 0) + 1;
        });
      });
    });

    // Build sorted, threshold-filtered arrays
    const scraped = {};
    Object.entries(roleCounts).forEach(([jsonKey, counts]) => {
      const filtered = Object.entries(counts)
        .filter(([, n]) => n >= threshold)
        .sort(([, a], [, b]) => b - a)
        .map(([name]) => name);
      if (filtered.length > 0) scraped[jsonKey] = filtered;
    });

    if (Object.keys(scraped).length === 0) {
      return res.json({ ok: true, message: 'No ComicInfo.xml data found in issues — nothing to scrape.', scraped: {} });
    }

    // Read or create series.json
    const jsonPath = seriesJsonPath(row.path);
    let doc = { version: '1.0.2', metadata: {} };
    if (fs.existsSync(jsonPath)) {
      try { doc = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch {}
    }
    if (!doc.metadata) doc.metadata = {};

    // Merge in scraped creators (overwrite role arrays)
    Object.assign(doc.metadata, scraped);

    const newContent = JSON.stringify(doc, null, 2);
    fs.writeFileSync(jsonPath, newContent, 'utf8');

    // Invalidate caches
    db.prepare('DELETE FROM series_json_cache WHERE series_id = ?').run(row.id);
    jsonMemCache.delete(row.id);
    const newStatus = deriveMetadataStatus(doc);
    db.prepare('UPDATE scanned_series SET metadata_status = ?, series_json = ? WHERE id = ?')
      .run(newStatus, newContent, row.id);
    invalidateSeriesCache();

    res.json({ ok: true, scraped, totalBooks, threshold });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ─── AUTHORS ──────────────────────────────────────────────────────
// Aggregate authors from scanned_books ComicInfo.xml data
app.get('/api/authors', (req, res) => {
  try {
    const { libraryId } = req.query;
    let sql = `SELECT sb.comicinfo FROM scanned_books sb
      JOIN scanned_series ss ON ss.id = sb.series_id WHERE sb.comicinfo IS NOT NULL`;
    const params = [];
    if (libraryId) { sql += ' AND ss.library_id = ?'; params.push(libraryId); }
    const books = db.prepare(sql).all(...params);
    const authorMap = {};
    books.forEach(b => {
      const ci = parseComicInfo(b.comicinfo);
      const roles = [['writer', ci.writer], ['penciller', ci.penciller], ['inker', ci.inker], ['colorist', ci.colorist], ['coverArtist', ci.coverArtist]];
      roles.forEach(([role, names]) => {
        if (!names) return;
        names.split(',').map(n => n.trim().replace(/\s*\[\d+\]\s*$/, '')).filter(Boolean).forEach(name => {
          if (!authorMap[name]) authorMap[name] = { name, roles: new Set(), seriesCount: 0 };
          authorMap[name].roles.add(role);
          authorMap[name].seriesCount++;
        });
      });
    });
    const authors = Object.values(authorMap).map(a => ({ ...a, roles: Array.from(a.roles) })).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ content: authors, totalElements: authors.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CHARACTERS ───────────────────────────────────────────────────
// Aggregate characters from series.json across all series
app.get('/api/characters', (req, res) => {
  try {
    const { libraryId } = req.query;
    const series = fetchAllSeries(libraryId);
    const charMap = {};
    series.forEach(s => {
      const json = getSeriesJsonCached(s.id, s.path);
      const chars = json?.metadata?.characters || [];
      chars.forEach(char => {
        if (!charMap[char]) charMap[char] = { name: char, seriesIds: [], seriesCount: 0 };
        charMap[char].seriesIds.push(s.id);
        charMap[char].seriesCount++;
      });
    });
    const characters = Object.values(charMap)
      .filter(c => c.seriesCount >= 3)
      .sort((a, b) => b.seriesCount - a.seriesCount);
    res.json({ content: characters, totalElements: characters.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Series for a specific character
app.get('/api/characters/:name/series', (req, res) => {
  try {
    const { libraryId } = req.query;
    const charName = decodeURIComponent(req.params.name);
    const series = fetchAllSeries(libraryId);
    const matching = series.filter(s => {
      const json = getSeriesJsonCached(s.id, s.path);
      return (json?.metadata?.characters || []).includes(charName);
    }).map(mergeSeriesWithJson);
    res.json({ content: matching, totalElements: matching.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── LIBRARY SEARCH ───────────────────────────────────────────────
// GET /api/search?q=&libraryId= — searches series (name + authors) and books (title/filename)
// Search (backend/search.js, 2026-10-22): forgiving matching and ranking, "Batman 1940" volume pick,
// "Batman 497" issue jump, plus Timeline events, Top Shelf runs and reading lists; suggestions for the top bar.
const librarySearch = require('./search').createSearch({ db, fetchAllSeries, mergeSeriesWithJson, creatorsCache });
app.get('/api/search', (req, res) => {
  try {
    const { q = '', libraryId } = req.query;
    if (!String(q).trim()) return res.json({ series: [], books: [], issues: [], events: [], runs: [], lists: [] });
    res.json(librarySearch.search({ q, libraryId: libraryId || null, user: req.user }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/search/suggest', (req, res) => {
  try {
    const { q = '', libraryId } = req.query;
    if (String(q).trim().length < 2) return res.json({ results: [] });
    res.json({ results: librarySearch.suggest({ q, libraryId: libraryId || null, user: req.user }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ERAS (from series.json) ──────────────────────────────────────
app.get('/api/eras', (req, res) => {
  try {
    const { libraryId } = req.query;
    const series = fetchAllSeries(libraryId);
    const eraMap = {};
    series.forEach(s => {
      const json = getSeriesJsonCached(s.id, s.path);
      const era = json?.metadata?.era;
      if (era) {
        if (!eraMap[era]) eraMap[era] = { name: era, seriesIds: [], seriesCount: 0 };
        eraMap[era].seriesIds.push(s.id);
        eraMap[era].seriesCount++;
      }
    });
    res.json({ content: Object.values(eraMap).sort((a, b) => b.seriesCount - a.seriesCount) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── HOME SHELF DATA ──────────────────────────────────────────────
app.get('/api/home', (req, res) => {
  try {
    const { libraryId } = req.query;
    const libFilter = libraryId ? ' AND ss.library_id = ?' : '';
    const libParams = libraryId ? [libraryId] : [];

    // Recently added books (scanned_books ordered by last_scanned)
    const recentBooks = db.prepare(`
      SELECT sb.*, ss.name as seriesName, ss.id as seriesId FROM scanned_books sb
      JOIN scanned_series ss ON ss.id = sb.series_id
      WHERE 1=1 ${libFilter} ORDER BY sb.last_scanned DESC LIMIT 20
    `).all(...libParams);

    // Recently added series
    const recentSeries = db.prepare(`
      SELECT * FROM scanned_series WHERE 1=1 ${libraryId ? 'AND library_id = ?' : ''}
      ORDER BY last_scanned DESC LIMIT 20
    `).all(...libParams).map(mergeSeriesWithJson);

    // Random discover series
    const allSeries = fetchAllSeries(libraryId);
    const discoverSeries = [...allSeries].sort(() => Math.random() - 0.5).slice(0, 8).map(mergeSeriesWithJson);

    // Characters shelf — top characters with up to 8 series each
    const charMap = {};
    allSeries.forEach(s => {
      const json = getSeriesJsonCached(s.id, s.path);
      (json?.metadata?.characters || []).forEach(char => {
        if (!charMap[char]) charMap[char] = [];
        if (charMap[char].length < 8) charMap[char].push(mergeSeriesWithJson(s));
      });
    });
    const topCharacters = Object.entries(charMap)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 8)
      .map(([name, series]) => ({ name, series }));

    res.json({ recentBooks, recentSeries, discoverSeries, topCharacters });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

require('./pullBox').registerPullRoutes(app, {db, requireAuth, getSeriesRating});

// ─── COLLECTIONS ──────────────────────────────────────────────────
// Sharing and following personal boxes (stage 2 of claude/BOXES_UNIFIED_PLAN.md): boxSharing.js.
const boxSharing = require('./boxSharing').createBoxSharing({ db, collectionSeriesIds, onCopy: (from, to) => boxMissing.copy(from, to) });
require('./boxSharing').registerBoxSharingRoutes(app, { requireAuth, sharing: boxSharing });
// Series a box recommends that the library lacks (Comic Book Guy's boxes): placeholders,
// looked up on Comic Vine in the background through the shared pool (boxMissing.js).
const boxMissing = require('./boxMissing').createBoxMissing({ db, logger,
  searchVolumes: name => cvCtx.run({ lane: 'background', caller: 'box-missing-series' }, async () => {
    if (!getCVKey()) throw new Error('No Comic Vine API key');   // stays pending until one is set
    const query = String(name).replace(/[()\[\]{}#@!$%^&*+=|<>?/\\~`"]/g, ' ').replace(/\s+/g, ' ').trim();
    const r = await cvApiGet('https://comicvine.gamespot.com/api/search', { params: { api_key: getCVKey(), format: 'json', query, resources: 'volume', limit: 10,
      field_list: 'id,name,start_year,publisher,count_of_issues,image' } });
    if (r.data?.status_code && r.data.status_code !== 1) throw new Error(r.data.error || `Comic Vine error ${r.data.status_code}`);
    return r.data?.results || [];
  }) });
require('./boxMissing').registerBoxMissingRoutes(app, { db, requireAuth, boxMissing,
  canView: (col, user) => boxSharing.canView(col, user?.sub || null),
  canEdit: (col, user) => (col.owner_id ? col.owner_id === user?.sub : user?.role === 'admin') });

app.get('/api/collections', requireAuth, (req, res) => {
  const userId = req.user?.sub || null;
  const { libraryId } = req.query;
  // Return collections visible in this library:
  // - library_id IS NULL → shown in all libraries
  // - library_id = ? → shown only in that library
  // Always include user's own collections regardless of library assignment
  const cols = db.prepare(`
    SELECT * FROM collections
    WHERE (owner_id IS NULL OR owner_id = ?)
      AND (? IS NULL OR library_id IS NULL OR library_id = ?)
    ORDER BY owner_id IS NULL DESC, sort_order ASC, name ASC
  `).all(userId || '', libraryId || null, libraryId || null);
  const result = cols.map(c => {
    const rules = db.prepare('SELECT * FROM collection_rules WHERE collection_id = ?').all(c.id);
    let seriesCount = 0;
    try { seriesCount = collectionSeriesIds(c, null).length; }
    catch (e) { logger.warn('collections', 'Could not count collection', { id: c.id, error: e.message }); }
    logger.debug('collections', `fetched`, { id: c.id, name: c.name, type: c.collection_type, seriesCount });
    return { ...c, conditionGroup: c.condition_group, collectionType: c.collection_type, rules, seriesCount };
  });
  res.json(result);
});

app.get('/api/collections/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.sub || null;
    const col = db.prepare('SELECT * FROM collections WHERE id = ?').get(req.params.id);
    if (!col) return res.status(404).json({ error: 'Not found' });
    // Another user's personal box: only when it is shared.
    if (!boxSharing.canView(col, userId)) return res.status(403).json({ error: 'Forbidden' });
    const rules = db.prepare('SELECT * FROM collection_rules WHERE collection_id = ?').all(req.params.id);
    const manualSeries = db.prepare('SELECT series_id FROM collection_series WHERE collection_id = ?').all(req.params.id).map(r => r.series_id);
    res.json({ ...col, conditionGroup: col.condition_group, collectionType: col.collection_type, rules, manualSeries, ...boxSharing.describe(col, userId) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/collections', requireAuth, (req, res) => {
  try {
    const { name, description, era, publisher, cover_series_id, rules = [], conditionGroup, collectionType, sortOrder, libraryId } = req.body;
    if (req.body.cardDescription !== undefined && (typeof req.body.cardDescription !== 'string' || [...req.body.cardDescription].length > 140)) return res.status(400).json({error:'Card description must be 140 characters or fewer.'});
    if (!name || !name.trim()) return res.status(400).json({ error: 'Collection name is required' });
    const id = `col_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const isAdminUser = req.user?.role === 'admin';
    const ownerId = isAdminUser && req.body.personal !== true ? null : req.user.sub;
    const visibility = ownerId ? 'private' : 'public';
    db.prepare('INSERT INTO collections (id, name, description, era, publisher, cover_series_id, condition_group, collection_type, owner_id, visibility, sort_order, library_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name.trim(), description || null, era || null, publisher || null, cover_series_id || null, conditionGroup || null, collectionType || 'manual', ownerId, visibility, sortOrder != null ? parseInt(sortOrder, 10) : 0, libraryId || null);
    if (req.body.cardDescription !== undefined) db.prepare('UPDATE collections SET card_description=? WHERE id=?').run(req.body.cardDescription.trim(),id);
    if (rules && rules.length) {
      const stmt = db.prepare('INSERT INTO collection_rules (collection_id, rule_type, rule_value) VALUES (?, ?, ?)');
      rules.forEach(r => stmt.run(id, r.type || r.field || '', r.value || ''));
    }
    res.json({ id, success: true });
  } catch (e) {
    console.error('[collections] POST error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/collections/:id', requireAuth, (req, res) => {
  const userId = req.user?.sub || null;
  const isAdminUser = req.user?.role === 'admin';
  const col = db.prepare('SELECT owner_id, purpose FROM collections WHERE id = ?').get(req.params.id);
  if (!col) return res.status(404).json({ error: 'Not found' });
  if (col.owner_id ? col.owner_id !== userId : !isAdminUser) return res.status(403).json({ error: 'Forbidden' });
  const { name, description, era, publisher, cover_series_id, rules = [], conditionGroup, collectionType, sortOrder, libraryId } = req.body;
    if (req.body.cardDescription !== undefined && (typeof req.body.cardDescription !== 'string' || [...req.body.cardDescription].length > 140)) return res.status(400).json({error:'Card description must be 140 characters or fewer.'});
  if (col.purpose === 'pull' && ((collectionType && collectionType !== 'manual') || conditionGroup || rules.length || libraryId)) return res.status(400).json({error:'My Pull Box stays manual and available across all libraries.'});
  const memberIds=req.body.memberIds;
  if(memberIds!==undefined){
    const type=db.prepare('SELECT collection_type FROM collections WHERE id=?').get(req.params.id)?.collection_type;
    if(col.purpose==='pull'||type!=='manual'||!Array.isArray(memberIds)||memberIds.some(id=>typeof id!=='string'||!db.prepare('SELECT id FROM scanned_series WHERE id=?').get(id)))return res.status(400).json({error:'Choose existing series for a manual box.'});
  }
  // Fetch current values so we never silently overwrite type/conditionGroup if the edit form omitted them
  const existing = db.prepare('SELECT collection_type, condition_group, sort_order, library_id FROM collections WHERE id = ?').get(req.params.id);
  const resolvedType           = collectionType  !== undefined ? collectionType  : existing.collection_type;
  const resolvedConditionGroup = conditionGroup  !== undefined ? conditionGroup  : existing.condition_group;
  const resolvedSortOrder      = sortOrder       !== undefined ? parseInt(sortOrder, 10) : existing.sort_order;
  const resolvedLibraryId      = libraryId       !== undefined ? (libraryId || null) : existing.library_id;
  db.transaction(()=>{
  db.prepare('UPDATE collections SET name=?, description=?, era=?, publisher=?, cover_series_id=?, condition_group=?, collection_type=?, sort_order=?, library_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(name, description, era, publisher, cover_series_id, resolvedConditionGroup || null, resolvedType || 'manual', resolvedSortOrder, resolvedLibraryId, req.params.id);
  if (req.body.cardDescription !== undefined) db.prepare('UPDATE collections SET card_description=? WHERE id=?').run(req.body.cardDescription.trim(),req.params.id);
  db.prepare('DELETE FROM collection_rules WHERE collection_id = ?').run(req.params.id);
  rules.forEach(r => db.prepare('INSERT INTO collection_rules (collection_id, rule_type, rule_value) VALUES (?, ?, ?)').run(req.params.id, r.type, r.value));
  if(memberIds!==undefined){
    db.prepare('DELETE FROM collection_series WHERE collection_id=?').run(req.params.id);
    for(const seriesId of new Set(memberIds))db.prepare('INSERT INTO collection_series(collection_id,series_id,manually_added) VALUES (?,?,1)').run(req.params.id,seriesId);
  }
  })();
  res.json({ success: true });
});

app.delete('/api/collections/:id', requireAuth, (req, res) => {
  const userId = req.user?.sub || null;
  const isAdminUser = req.user?.role === 'admin';
  const col = db.prepare('SELECT owner_id FROM collections WHERE id = ?').get(req.params.id);
  if (!col) return res.status(404).json({ error: 'Not found' });
  if (col.owner_id ? col.owner_id !== userId : !isAdminUser) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM collection_rules WHERE collection_id = ?').run(req.params.id);
  db.prepare('DELETE FROM collection_series WHERE collection_id = ?').run(req.params.id);
  boxSharing.forgetBox(req.params.id);
  boxMissing.forget(req.params.id);
  db.prepare('DELETE FROM collections WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/collections/:id/series', requireAuth, (req, res) => {
  const userId = req.user?.sub || null;
  const isAdminUser = req.user?.role === 'admin';
  const col = db.prepare('SELECT owner_id FROM collections WHERE id = ?').get(req.params.id);
  if (!col) return res.status(404).json({ error: 'Not found' });
  if (col.owner_id ? col.owner_id !== userId : !isAdminUser) return res.status(403).json({ error: 'Forbidden' });
  if (!db.prepare('SELECT id FROM scanned_series WHERE id=?').get(req.body.seriesId || '')) return res.status(404).json({error:'Series not found'});
  db.prepare('INSERT OR IGNORE INTO collection_series (collection_id, series_id, manually_added) VALUES (?, ?, 1)').run(req.params.id, req.body.seriesId);
  res.json({ success: true });
});

app.delete('/api/collections/:id/series/:seriesId', requireAuth, (req, res) => {
  const userId = req.user?.sub || null;
  const isAdminUser = req.user?.role === 'admin';
  const col = db.prepare('SELECT owner_id FROM collections WHERE id = ?').get(req.params.id);
  if (!col) return res.status(404).json({ error: 'Not found' });
  if (col.owner_id ? col.owner_id !== userId : !isAdminUser) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM collection_series WHERE collection_id = ? AND series_id = ?').run(req.params.id, req.params.seriesId);
  res.json({ success: true });
});

// ─── User tags on series ─────────────────────────────────────────
app.get('/api/tags', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT DISTINCT tag FROM series_user_tags ORDER BY tag ASC').all();
  res.json(rows.map(r => r.tag));
});
app.get('/api/series/:id/tags', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT tag FROM series_user_tags WHERE series_id = ? ORDER BY tag ASC').all(req.params.id).map(r => r.tag));
});
app.post('/api/series/:id/tags', requireAuth, (req, res) => {
  const tag = (req.body.tag || '').trim().toLowerCase().slice(0, 64);
  if (!tag) return res.status(400).json({ error: 'tag required' });
  db.prepare('INSERT OR IGNORE INTO series_user_tags (series_id, tag, created_by) VALUES (?, ?, ?)').run(req.params.id, tag, req.user?.sub || null);
  seriesCache.clear();
  res.json({ success: true, tag });
});
app.delete('/api/series/:id/tags/:tag', requireAuth, (req, res) => {
  db.prepare('DELETE FROM series_user_tags WHERE series_id = ? AND tag = ?').run(req.params.id, decodeURIComponent(req.params.tag));
  seriesCache.clear();
  res.json({ success: true });
});

// Comic Book Roundup ratings: cbr.js (moved 2026-11-10, server.js split).
const { runCbrQueue } = require('./cbr').createCbr({ app, db, FLARESOLVERR_URL, getSeriesAwards, logger, requireAdmin, requireAuth });

// ─── Collection cover image upload ────────────────────────────────────────────i/collections/:id/cover  (raw binary body, Content-Type = image/*)
// GET  /api/collections/:id/cover  → serves the uploaded image
app.post('/api/collections/:id/cover', requireAuth, async (req, res) => {
  const col = db.prepare('SELECT id, owner_id FROM collections WHERE id = ?').get(req.params.id);
  if (!col) return res.status(404).json({ error: 'Collection not found' });
  if ((!col.owner_id && req.user.role !== 'admin') || (col.owner_id && col.owner_id !== req.user.sub)) return res.status(403).json({ error: 'Forbidden' });
  let temporary;
  try {
    const { body, ext } = await require('./coverUpload').readCover(req);
    // Unique filenames preserve the previous cover even if writing or DB update fails.
    const filename = crypto.randomUUID() + ext;
    temporary = path.join(COLLECTION_COVERS_DIR, filename);
    await fs.promises.writeFile(temporary, body, { flag: 'wx' });
    const position = typeof req.query.position === 'string' ? req.query.position.slice(0, 100) : null;
    const previous = db.prepare('SELECT cover_image FROM collections WHERE id = ?').get(req.params.id);
    const updated = db.prepare('UPDATE collections SET cover_image = ?, cover_position = ? WHERE id = ?').run(filename, position, req.params.id);
    if (!updated.changes) throw new Error('Collection no longer exists');
    temporary = null;
    if (previous?.cover_image && path.basename(previous.cover_image) === previous.cover_image &&
        !db.prepare('SELECT id FROM collections WHERE cover_image = ?').get(previous.cover_image)) {
      await fs.promises.unlink(path.join(COLLECTION_COVERS_DIR, previous.cover_image)).catch(() => {});
    }
    res.json({ success: true, filename, position });
  } catch (e) {
    if (temporary) await fs.promises.unlink(temporary).catch(() => {});
    if (!res.destroyed) res.status(e.status || 500).json({ error: e.status ? e.message : 'Unable to save cover' });
  }
});

app.get('/api/collections/:id/cover', requireAuth, (req, res) => {
  const col = db.prepare('SELECT cover_image, owner_id, visibility FROM collections WHERE id = ?').get(req.params.id);
  if (col && !boxSharing.canView(col, req.user.sub)) return res.status(403).send();
  if (!col?.cover_image) return res.status(404).send();
  const filepath = path.join(COLLECTION_COVERS_DIR, col.cover_image);
  if (!fs.existsSync(filepath)) return res.status(404).send();
  res.set('Cache-Control', col.owner_id ? 'private, no-store' : 'public, max-age=3600');
  res.sendFile(filepath);
});

// ─── Reading-order box artwork (2026-11-03) ──────────────────────
// A reading order (reading list) shown as a box on the Comic Box page can have uploaded
// artwork, like a series box. Stored as a file name in reading_lists.cover_image; served
// to whoever can see the list (its owner, or anyone for a shared list or an Essential).
const LIST_COVERS_DIR = path.join(dbDir, 'list-covers');
fs.mkdirSync(LIST_COVERS_DIR, { recursive: true });
const listCoverFile = name => (typeof name === 'string' && /^[0-9a-f-]{36}\.(?:jpg|png|webp|gif)$/.test(name) ? name : null);
app.post('/api/reading-lists/:id/cover', requireAuth, async (req, res) => {
  const list = db.prepare('SELECT id, owner_id, visibility, cover_image FROM reading_lists WHERE id = ?').get(Number(req.params.id));
  if (!list) { req.resume(); return res.status(404).json({ error: 'Reading order not found' }); }
  const mayEdit = list.owner_id === req.user.sub || (list.visibility === 'essential' && req.user.role === 'admin');
  if (!mayEdit) { req.resume(); return res.status(403).json({ error: 'Only the owner can change its artwork.' }); }
  let temporary;
  try {
    const { body, ext } = await require('./coverUpload').readCover(req);
    const filename = crypto.randomUUID() + ext;
    temporary = path.join(LIST_COVERS_DIR, filename);
    await fs.promises.writeFile(temporary, body, { flag: 'wx' });
    if (!db.prepare('UPDATE reading_lists SET cover_image = ? WHERE id = ?').run(filename, list.id).changes) throw new Error('Reading order no longer exists');
    temporary = null;
    // The old file goes unless a copied list still uses it.
    const old = listCoverFile(list.cover_image);
    if (old && !db.prepare('SELECT 1 FROM reading_lists WHERE cover_image = ?').get(old)) await fs.promises.unlink(path.join(LIST_COVERS_DIR, old)).catch(() => {});
    res.json({ success: true, filename });
  } catch (e) {
    if (temporary) await fs.promises.unlink(temporary).catch(() => {});
    if (!res.destroyed) res.status(e.status || 500).json({ error: e.status ? e.message : 'Unable to save artwork' });
  }
});
app.get('/api/reading-lists/:id/cover', requireAuth, (req, res) => {
  const list = db.prepare('SELECT owner_id, visibility, cover_image FROM reading_lists WHERE id = ?').get(Number(req.params.id));
  if (!list || !(list.owner_id === req.user.sub || ['public', 'essential'].includes(list.visibility))) return res.status(404).send();
  const file = listCoverFile(list.cover_image);
  if (!file || !fs.existsSync(path.join(LIST_COVERS_DIR, file))) return res.status(404).send();
  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(path.join(LIST_COVERS_DIR, file));
});

// ─── Collection series list (for thumbnail peek) ──────────────────
// GET /api/collections/:id/series-ids — returns array of series IDs in the collection
// Evaluates condition_group JSON using the same logic as the client-side testSeriesAgainstGroup.

function _collTestRule(s, json, rule) {
  if (rule.field === 'metadata_status') {
    return (s.metadata_status || 'none') === (rule.value || '');
  }
  if (!rule.value && rule.operator !== 'between') return false;
  const val  = (rule.value  || '').toLowerCase().trim();
  const val2 = (rule.value2 || '').toLowerCase().trim();
  const meta = json?.metadata || {};
  const norm = v => v === 'ongoing' ? 'continuing' : v;
  let fieldVals;
  switch (rule.field) {
    case 'era':       fieldVals = [meta.era || ''].map(v => v.toLowerCase()); break;
    case 'publisher': fieldVals = [meta.publisher || ''].map(v => v.toLowerCase()); break;
    case 'imprint':   fieldVals = [meta.imprint   || ''].map(v => v.toLowerCase()); break;
    case 'genre':     fieldVals = (meta.genres || []).map(v => v.toLowerCase()); break;
    case 'character': fieldVals = (meta.characters || []).map(v => v.toLowerCase()); break;
    case 'year':      fieldVals = [String(meta.year || s.year || '')]; break;
    case 'status':    fieldVals = [norm((meta.status || '').toLowerCase())]; break;
    case 'title':     fieldVals = [(meta.name || s.name || '').replace(/\s*\(\d{4}\)\s*$/, '').toLowerCase()]; break;
    case 'writer':    fieldVals = (meta.writers || []).map(v => v.toLowerCase()); break;
    case 'artist':    fieldVals = (meta.artists || []).map(v => v.toLowerCase()); break;
    default:          return false;
  }
  switch (rule.operator) {
    case 'is':           return fieldVals.some(fv => fv === norm(val));
    case 'contains':     return fieldVals.some(fv => fv.includes(val));
    case 'starts_with':  return fieldVals.some(fv => fv.startsWith(val));
    case 'greater_than': return fieldVals.some(fv => parseFloat(fv) > parseFloat(val));
    case 'less_than':    return fieldVals.some(fv => parseFloat(fv) < parseFloat(val));
    case 'between':      return fieldVals.some(fv => { const n = parseFloat(fv); return n >= parseFloat(val) && n <= parseFloat(val2); });
    default:             return false;
  }
}

function _collTestGroup(s, json, group) {
  if (!group || !group.rules || group.rules.length === 0) return true;
  const results = group.rules.map(r =>
    r.type === 'group' ? _collTestGroup(s, json, r) : _collTestRule(s, json, r)
  );
  return group.condition === 'AND' ? results.every(Boolean) : results.some(Boolean);
}

// Series ids in a collection (manual list, or smart rules evaluated server-side).
// Shared by the route below and the assistant's page context.
function collectionSeriesIds(col, libraryId = null) {
  if (col.collection_type === 'auto' && col.condition_group) {
    // Evaluate the condition_group tree — same logic as client testSeriesAgainstGroup
    const condGroup = JSON.parse(col.condition_group);
    return fetchAllSeries(libraryId)
      .filter(s => _collTestGroup(s, getSeriesJsonCached(s.id, s.path), condGroup))
      .map(s => s.id);
  }
  if (col.collection_type === 'auto') {
    // Fallback: old flat rules
    const rules = db.prepare('SELECT * FROM collection_rules WHERE collection_id = ?').all(col.id);
    return fetchAllSeries(libraryId)
      .filter(s => {
        const json = getSeriesJsonCached(s.id, s.path);
        return rules.every(r => {
          const val = (json?.metadata?.[r.rule_type] || s[r.rule_type] || '').toString().toLowerCase();
          return val.includes((r.rule_value || '').toLowerCase());
        });
      })
      .map(s => s.id);
  }
  if (libraryId) {
    return db.prepare(`SELECT DISTINCT cs.series_id FROM collection_series cs
      JOIN scanned_series s ON s.id = cs.series_id
      WHERE cs.collection_id = ? AND s.library_id = ?`).all(col.id, libraryId).map(r => r.series_id);
  }
  return db.prepare('SELECT DISTINCT series_id FROM collection_series WHERE collection_id = ?').all(col.id).map(r => r.series_id);
}

app.get('/api/collections/:id/series-ids', requireAuth, async (req, res) => {
  try {
    const col = db.prepare('SELECT * FROM collections WHERE id = ?').get(req.params.id);
    if (!col) return res.status(404).json({ error: 'Not found' });
    if (!boxSharing.canView(col, req.user.sub)) return res.status(403).json({ error: 'Forbidden' });
    res.json(collectionSeriesIds(col));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/collections/:id/peek?n=8 — the covers sticking out of a box tile: its series,
// topped up with issues from them when there are too few to fill the row (boxPeek.js).
const boxArtwork = require('./boxArtwork').create(db);
app.put('/api/collections/:id/artwork', requireAuth, (req,res) => {
  const col=db.prepare('SELECT * FROM collections WHERE id=?').get(req.params.id);
  if (!col || !boxSharing.canView(col,req.user.sub)) return res.status(404).json({error:'Box not found'});
  if (col.owner_id ? col.owner_id !== req.user.sub : req.user.role !== 'admin') return res.status(403).json({error:'You cannot edit this box'});
  try { boxArtwork.save('collection',col.id,req.body.choice); res.json({artwork:boxArtwork.describe('collection',col.id,boxArtwork.series(collectionSeriesIds(col)))}); }
  catch(e) { res.status(e.status || 500).json({error:e.message}); }
});

app.get('/api/collections/:id/peek', requireAuth, (req, res) => {
  try {
    const col = db.prepare('SELECT * FROM collections WHERE id = ?').get(req.params.id);
    if (!col) return res.status(404).json({ error: 'Not found' });
    if (!boxSharing.canView(col, req.user.sub)) return res.status(403).json({ error: 'Forbidden' });
    const n = Math.min(12, Math.max(1, parseInt(req.query.n, 10) || 8));
    const booksFor = seriesId => {
      const cover = pickSeriesCoverBook(seriesId)?.id;
      return db.prepare('SELECT id FROM scanned_books WHERE series_id = ? ORDER BY sort_order ASC, filename ASC').all(seriesId).map(b => b.id).filter(id => id !== cover);
    };
    const seriesIds = collectionSeriesIds(col);
    res.json({ items: require('./boxPeek').pickPeek(seriesIds, booksFor, n), artwork: boxArtwork.describe('collection', col.id, boxArtwork.series(seriesIds)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Auto-create collections from eras found in series.json
app.post('/api/collections/auto-create-eras', requireAdmin, (req, res) => {
  try {
    const { libraryId } = req.body;
    const series = fetchAllSeries(libraryId);
    const eraMap = {};
    series.forEach(s => {
      const json = getSeriesJsonCached(s.id, s.path);
      const era = json?.metadata?.era;
      const pub = json?.metadata?.publisher || s.name;
      if (era) {
        const key = `${pub}|${era}`;
        if (!eraMap[key]) eraMap[key] = { era, publisher: pub, seriesIds: [] };
        eraMap[key].seriesIds.push(s.id);
      }
    });

    const created = [];
    for (const [key, data] of Object.entries(eraMap)) {
      const existing = db.prepare('SELECT id FROM collections WHERE era = ? AND publisher = ?').get(data.era, data.publisher);
      if (!existing) {
        const id = `col_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const name = data.publisher ? `${data.publisher} — ${data.era}` : data.era;
        db.prepare('INSERT INTO collections (id, name, era, publisher) VALUES (?, ?, ?, ?)').run(id, name, data.era, data.publisher);
        db.prepare('INSERT INTO collection_rules (collection_id, rule_type, rule_value) VALUES (?, ?, ?)').run(id, 'era', data.era);
        created.push({ id, name, era: data.era, publisher: data.publisher, seriesCount: data.seriesIds.length });
      }
    }
    res.json({ created, total: created.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── MYLAR (removed — not in active architecture) ─────────────────
// These routes are stubbed to prevent 404s from any lingering frontend calls

app.get('/api/folders/list', requireAdmin, (req, res) => {
  try {
    const folders = new Set();
    function walk(dir, depth) {
      if (depth > 6) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      const subdirs = entries.filter(e => e.isDirectory());
      if (subdirs.length === 0) return; // leaf series folder, skip
      folders.add(dir.replace(/\\/g, '/'));
      for (const sub of subdirs) walk(path.join(dir, sub.name), depth + 1);
    }
    walk(COMICS_PATH, 0);
    res.json({ folders: Array.from(folders).sort() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const SCRIPTS_PATH = path.join(__dirname, '../scripts');

// ─── Comic Vine proxy ─────────────────────────────────────────────
// Metron's series search, answered as Comic Vine volumes (2026-11-13): for installs without a Comic
// Vine key, and when Comic Vine's search is at its limit. Only series Metron has linked to a Comic Vine
// volume are returned (Omnibus keys everything on Comic Vine IDs). Metron's list has no Comic Vine ID,
// so each candidate's record is read (3.5 s apart): the 8 nearest to the year asked for.
async function metronVolumeSearch(query, year) {
  const r = await metron.get('series/', { name: query });
  const list = (r && r.results) || [];
  const target = parseInt(year, 10) || null;
  const picked = list.slice().sort((a, b) => target ? Math.abs((a.year_began || 0) - target) - Math.abs((b.year_began || 0) - target) : 0).slice(0, 8);
  const out = [];
  for (const x of picked) {
    const d = await metron.get(`series/${x.id}/`).catch(() => null);
    if (!d || !d.cv_id) continue;
    const pub = d.publisher && typeof d.publisher === 'object' ? d.publisher.name : d.publisher;
    out.push({ id: d.cv_id, name: d.name, start_year: d.year_began ? String(d.year_began) : null, publisher: pub ? { name: pub } : null,
      count_of_issues: d.issue_count || 0, image: null, description: d.desc || null, source: 'metron', metron_id: d.id });
  }
  return out;
}

app.get('/api/comicvine/search', async (req, res) => {
  const metronAnswer = async (why) => {
    const cleanQ = String(req.query.q || '').replace(/[()\[\]{}#@!$%^&*+=|<>?/\\~`"]/g, ' ').replace(/\s+/g, ' ').trim();
    const results = await metronVolumeSearch(cleanQ, req.query.year);
    logger.info('cv-search', `Answered from Metron (${why})`, { q: cleanQ, results: results.length });
    return res.json({ status_code: 1, results, source: 'metron',
      notice: why === 'no-key' ? 'Results from Metron (no Comic Vine key set). Only series Metron has linked to Comic Vine are shown.'
        : "Comic Vine's search is at its limit, so these results come from Metron. Only series Metron has linked to Comic Vine are shown." });
  };
  const metronOk = () => !!(getSetting('metron_api_token') || process.env.METRON_API_TOKEN);
  if (!getCVKey()) {
    if (!metronOk()) return res.status(400).json({ error: 'Set a Comic Vine API key or a Metron token first (Settings → Connections)' });
    try { return await metronAnswer('no-key'); } catch (e) { return res.status(502).json({ error: `Metron search failed: ${e.message}` }); }
  }
  try {
    const { q, limit = 100, year, publisher } = req.query;

    // Strip special characters CV's search parser interprets as operators,
    // collapse extra whitespace, trim ends — mirrors what the original script does
    const cleanQuery = (q || '')
      .replace(/[()\[\]{}#@!$%^&*+=|<>?/\\~`"]/g, ' ')  // remove special chars
      .replace(/\s+/g, ' ')                                  // collapse spaces
      .trim();

    const params = {
      api_key: getCVKey(), format: 'json',
      query: cleanQuery,
      resources: 'volume',
      limit,
      field_list: 'id,name,start_year,publisher,count_of_issues,image,description'
    };

    logger.info('cv-search', `query`, { raw: q, clean: cleanQuery, year, publisher });

    const r = await cvApiGet('https://comicvine.gamespot.com/api/search', {
      params,
      headers: { 'User-Agent': 'Omnibus/1.0' }
    });

    // CV can return 200 with an error status_code in the body (e.g. 107 = rate limited)
    if (r.data.status_code && r.data.status_code !== 1) {
      logger.warn('cv-search', `CV returned error in body`, { status_code: r.data.status_code, detail: r.data.error });
      if (r.data.status_code === 107) {
        if (metronOk()) { try { return await metronAnswer('limit'); } catch {} }
        return res.status(429).json({ error: 'Comic Vine rate limit reached — please wait a few minutes before searching again.' });
      }
      return res.status(400).json({ error: r.data.error || `CV error ${r.data.status_code}` });
    }

    let results = r.data.results || [];

    // Comic Vine's search sometimes answers with placeholders for every volume: 0 issues, no publisher and
    // its blank.png image (2026-10-22; the volume lookup was still correct). Then the real details are
    // filled in from one volume-list request by id. Does nothing once search answers properly again.
    const placeholder = v => !v.count_of_issues && /blank\.png$/i.test(v.image?.thumb_url || v.image?.small_url || '');
    if (results.length && results.every(placeholder)) {
      try {
        const ids = results.map(v => v.id).filter(Boolean).slice(0, 100);
        const vr = await cvApiGet('https://comicvine.gamespot.com/api/volumes/', {
          params: { api_key: getCVKey(), format: 'json', filter: `id:${ids.join('|')}`, limit: 100,
            field_list: 'id,name,start_year,publisher,count_of_issues,image' },
          headers: { 'User-Agent': 'Omnibus/1.0' },
        });
        const byId = new Map((vr.data?.results || []).map(v => [v.id, v]));
        results = results.map(v => {
          const d = byId.get(v.id);
          if (!d) return v;
          return { ...v, count_of_issues: d.count_of_issues ?? v.count_of_issues, publisher: v.publisher || d.publisher || null,
            image: d.image && !placeholder({ image: d.image }) ? d.image : v.image };
        });
        const fixed = results.filter(v => !placeholder(v)).length;
        logger.warn('cv-search', `Search returned placeholders for all ${ids.length} volumes; ${fixed} filled from the volume lookup`);
      } catch (e) { logger.warn('cv-search', 'Search returned placeholders; the volume lookup failed too', { error: e.message }); }
    }

    // Sort results so the most relevant volumes surface first.
    // When called from the weekly tab we have publisher + approximate year context,
    // which cuts through the noise of 50+ "Amazing Spider-Man" volumes.
    const normPub = (publisher || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const targetYear = year ? parseInt(year, 10) : null;
    const currentYear = new Date().getFullYear();

    results = results.sort((a, b) => {
      const pubA = (a.publisher?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const pubB = (b.publisher?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const aYr  = parseInt(a.start_year, 10) || 0;
      const bYr  = parseInt(b.start_year, 10) || 0;

      // 1. Publisher match — publisher-matching volumes float to the top
      const aPubMatch = normPub && pubA.includes(normPub) ? 0 : 1;
      const bPubMatch = normPub && pubB.includes(normPub) ? 0 : 1;
      if (aPubMatch !== bPubMatch) return aPubMatch - bPubMatch;

      // 2. If a target year was provided, exact match wins
      if (targetYear) {
        const aYrMatch = aYr === targetYear ? 0 : 1;
        const bYrMatch = bYr === targetYear ? 0 : 1;
        if (aYrMatch !== bYrMatch) return aYrMatch - bYrMatch;
      }

      // 3. Most recent start year first (current ongoing > old runs)
      //    Cap recency bonus at currentYear so future-dated oddities don't win.
      const aRecent = Math.min(aYr, currentYear);
      const bRecent = Math.min(bYr, currentYear);
      if (aRecent !== bRecent) return bRecent - aRecent;

      // 4. More issues as tiebreaker (longer run = more established)
      return (b.count_of_issues || 0) - (a.count_of_issues || 0);
    });

    res.json({ ...r.data, results });
  } catch (e) {
    const status = e.response?.status;
    const cvError = e.response?.data?.error || e.response?.data?.status_detail || null;
    logger.error('cv-search', `CV search failed`, { status, cvError, message: e.message });
    if ((e.code === 'CV_RATE_LIMIT' || status === 420 || status === 429) && metronOk()) {
      try { return await metronAnswer('limit'); } catch (me) { logger.warn('cv-search', 'Metron fallback failed too', me.message); }
    }
    if (e.code === 'CV_RATE_LIMIT') return res.status(429).json({ error: e.message });
    if (status === 420 || status === 429) {
      return res.status(429).json({ error: 'Comic Vine rate limit reached — please wait a few minutes before searching again.' });
    }
    res.status(500).json({ error: cvError || e.message });
  }
});

app.get('/api/comicvine/volume/:id', async (req, res) => {
  try {
    const r = await cvApiGet(`https://comicvine.gamespot.com/api/volume/4050-${req.params.id}`, {
      params: { api_key: getCVKey(), format: 'json',
        field_list: 'id,name,start_year,publisher,count_of_issues,image,description,first_issue,last_issue' },
      headers: { 'User-Agent': 'Omnibus/1.0' }
    });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/comicvine/character/:id', async (req, res) => {
  try {
    const r = await cvApiGet(`https://comicvine.gamespot.com/api/character/4005-${req.params.id}`, {
      params: { api_key: getCVKey(), format: 'json', field_list: 'id,name,image,real_name,aliases,description' },
      headers: { 'User-Agent': 'Omnibus/1.0' }
    });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Search CV characters (for character shelf images) — smart matching
// Known CV character IDs — bypasses search scoring for major characters
// ─── Bundled CV character overrides (ships with app) ─────────────
// Loaded at startup. User overrides in appdata/cv_overrides.json are merged on top.
// Managed via the CV Admin page — changes there write to cv_overrides.json only.
const BUNDLED_CV_PATH = path.join(__dirname, 'cv_character_overrides.json');
let BUNDLED_CV_OVERRIDES = {};
try {
  const raw = JSON.parse(fs.readFileSync(BUNDLED_CV_PATH, 'utf8'));
  BUNDLED_CV_OVERRIDES = raw.overrides || {};
  console.log(`[cv] Loaded ${Object.keys(BUNDLED_CV_OVERRIDES).length} bundled character overrides`);
} catch (e) {
  console.warn('[cv] Could not load bundled overrides:', e.message);
}

// ─── CV Character Admin Endpoints ────────────────────────────────

// GET /api/admin/cv-characters — return all cached entries + both override layers
app.get('/api/admin/cv-characters', (req, res) => {
  const rows = db.prepare('SELECT name, image_url, cv_id, cached_at FROM cv_character_cache ORDER BY name').all();
  const cacheMap = {};
  rows.forEach(r => { cacheMap[r.name.toLowerCase()] = r; });

  // Load user overrides
  const userOverridePath = path.join(path.dirname(DB_PATH), 'cv_overrides.json');
  let userOverrides = {};
  if (fs.existsSync(userOverridePath)) {
    try { userOverrides = JSON.parse(fs.readFileSync(userOverridePath, 'utf8')); } catch {}
  }

  // Build entries: union of all known names
  const allNames = new Set([
    ...Object.keys(cacheMap),
    ...Object.keys(BUNDLED_CV_OVERRIDES),
    ...Object.keys(userOverrides),
  ]);

  const entries = Array.from(allNames).sort().map(name => ({
    name,
    cvId: userOverrides[name] || BUNDLED_CV_OVERRIDES[name] || cacheMap[name]?.cv_id || null,
    hasBundledOverride: !!BUNDLED_CV_OVERRIDES[name],
    hasUserOverride: !!userOverrides[name],
    cached: cacheMap[name] || null,
  }));

  res.json({ entries, cacheMap, userOverrides, bundledOverrides: BUNDLED_CV_OVERRIDES });
});

// POST /api/admin/cv-characters — update a character's CV ID
app.post('/api/admin/cv-characters', express.json(), (req, res) => {
  const { name, cvId } = req.body;
  if (!name || !cvId) return res.status(400).json({ error: 'name and cvId required' });
  // Clear cache so it re-fetches
  db.prepare('DELETE FROM cv_character_cache WHERE name = ?').run(name.toLowerCase());
  res.json({ ok: true, message: `Cleared cache for "${name}", will fetch CV ID ${cvId} on next load` });
});

// GET /api/admin/cv-preview/:cvId — fetch character data from CV
app.get('/api/admin/cv-preview/:cvId', async (req, res) => {
  try {
    const { cvId } = req.params;
    const r = await cvApiGet(`https://comicvine.gamespot.com/api/character/4005-${cvId}/`, {
      params: { api_key: getCVKey(), format: 'json', field_list: 'id,name,real_name,image,publisher,description' },
      headers: { 'User-Agent': 'Omnibus/1.0' }
    });
    res.json(r.data.results || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/cv-search/:query — search CV for a character by name
app.get('/api/admin/cv-search/:query', async (req, res) => {
  try {
    const r = await cvApiGet('https://comicvine.gamespot.com/api/search', {
      params: {
        api_key: getCVKey(), format: 'json',
        query: req.params.query,
        resources: 'character', limit: 8,
        field_list: 'id,name,real_name,image,publisher'
      },
      headers: { 'User-Agent': 'Omnibus/1.0' }
    });
    res.json(r.data.results || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/cv-characters/apply — write updated KNOWN_CV_CHARACTERS to a JSON override file
app.post('/api/admin/cv-characters/apply', express.json(), (req, res) => {
  try {
    const { updates } = req.body; // { name: cvId, ... }
    const overridePath = path.join(path.dirname(DB_PATH), 'cv_overrides.json');
    let existing = {};
    if (fs.existsSync(overridePath)) {
      try { existing = JSON.parse(fs.readFileSync(overridePath, 'utf8')); } catch {}
    }
    // Always lowercase keys so lookup matches cache queries
    const normalised = {};
    Object.entries(updates).forEach(([k, v]) => { if (v) normalised[k.toLowerCase().trim()] = String(v).trim(); });
    const merged = { ...existing, ...normalised };
    fs.writeFileSync(overridePath, JSON.stringify(merged, null, 2));
    // Clear cache so character re-fetches with correct ID
    const stmt = db.prepare('DELETE FROM cv_character_cache WHERE name = ?');
    Object.keys(normalised).forEach(n => stmt.run(n));
    console.log('[cv-admin] Saved overrides:', normalised);
    res.json({ ok: true, count: Object.keys(normalised).length, saved: normalised });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CV character scoring: finds the PRIMARY universe version ────
// Strategy:
//  1. Use CV /characters endpoint with filter=name:X (exact name match only)
//  2. Request count_of_issue_appearances + first_appeared_in_issue — the
//     canonical character has far more appearances and debuted earlier
//  3. Score on appearances (log scale), publisher (DC/Marvel preferred),
//     has image, and no "Earth-" / alternate-universe name signals
//  4. Cache result 7 days — character images rarely change
//
// This works for ANY character name without any hardcoded ID map.
// Manual overrides from cv_overrides.json take highest priority.

// ─── CV character search helper ──────────────────────────────────
// Fetch from CV /characters with a given filter, return parsed results
async function cvCharacterFetch(filter, limit = 25) {
  const r = await cvApiGet('https://comicvine.gamespot.com/api/characters/', {
    params: {
      api_key: getCVKey(), format: 'json',
      filter,
      limit,
      sort: 'count_of_issue_appearances:desc',
      field_list: 'id,name,real_name,image,publisher,count_of_issue_appearances,description'
    },
    headers: { 'User-Agent': 'Omnibus/1.0' }
  });
  return r.data.results || [];
}

function scoreCharacterResult(c, queryLower) {
  const nameLower = (c.name || '').toLowerCase().trim();
  const realNameLower = (c.real_name || '').toLowerCase().trim();
  const pub = (c.publisher?.name || '').toLowerCase();
  const desc = (c.description || '').toLowerCase();
  const appearances = c.count_of_issue_appearances || 0;
  let score = 0;

  // ── Name match — EXACT only gets big boost; partial gets small boost ──
  // This is critical: "filter=name:Storm" returns Stormwatch, Stormfront etc.
  // We post-filter here so non-exact matches score very low.
  if (nameLower === queryLower) score += 500;          // exact superhero name match
  else if (realNameLower === queryLower) score += 400; // query IS the real name (e.g. "dick grayson")
  else if (nameLower.startsWith(queryLower + ' ') || nameLower.startsWith(queryLower + '-')) score += 80;
  else score -= 200; // penalise non-exact name results heavily

  // ── Appearances (log scale) ─────────────────────────────────────
  // Primary hero: thousands. Alternate: dozens. Huge discriminator.
  if (appearances > 0) score += Math.min(250, Math.round(Math.log10(appearances) * 65));

  // ── Publisher ───────────────────────────────────────────────────
  if (pub === 'dc comics' || pub === 'marvel') score += 30;
  else if (pub.includes('dc') || pub.includes('marvel')) score += 10;

  // ── Alternate/evil/clone signals ────────────────────────────────
  const altSignals = /\b(earth-[a-z0-9]|alternate|elseworld|what if|zombie|evil clone|dark mirror|crime syndicate|injustice|amalgam|imposter|robot duplicate|skrull|doppelganger)/i;
  if (altSignals.test(nameLower)) score -= 200;
  if (altSignals.test(desc.slice(0, 400))) score -= 80;
  if (/earth-[a-z0-9]/i.test(desc.slice(0, 200))) score -= 120;

  // ── Image quality ───────────────────────────────────────────────
  const img = c.image?.medium_url || '';
  if (!img) score -= 400;
  if (img.includes('default_image') || img.includes('team_small') || img.includes('generic')) score -= 300;

  return score;
}

// POST /api/admin/cv-characters/clear-all — wipe entire cache
app.post('/api/admin/cv-characters/clear-all', (req, res) => {
  try {
    const { changes } = db.prepare('DELETE FROM cv_character_cache').run();
    res.json({ ok: true, cleared: changes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/comicvine/character-search', async (req, res) => {
  try {
    const query = req.query.q || '';
    const queryLower = query.toLowerCase().trim();

    // 1. Check cache (7-day TTL — character images are stable)
    const cached = db.prepare(
      "SELECT image_url, cv_id FROM cv_character_cache WHERE name = ? AND cached_at > datetime('now', '-7 days')"
    ).get(queryLower);
    if (cached) {
      return res.json({ results: [{ id: cached.cv_id, name: query, image: { medium_url: cached.image_url } }] });
    }

    // 2. Check overrides: user appdata file takes priority, then bundled defaults
    //    This means curated IDs always win over the scoring algorithm.
    const userOverridePath = path.join(path.dirname(DB_PATH), 'cv_overrides.json');
    let userOverrides = {};
    if (fs.existsSync(userOverridePath)) {
      try { userOverrides = JSON.parse(fs.readFileSync(userOverridePath, 'utf8')); } catch {}
    }
    // Merge: bundled first, user overrides on top (user wins)
    const allOverrides = { ...BUNDLED_CV_OVERRIDES, ...userOverrides };
    const ovId = allOverrides[queryLower];
    if (ovId) {
      try {
        const direct = await cvApiGet(`https://comicvine.gamespot.com/api/character/4005-${ovId}/`, {
          params: { api_key: getCVKey(), format: 'json', field_list: 'id,name,image' },
          headers: { 'User-Agent': 'Omnibus/1.0' }
        });
        const char = direct.data.results;
        const imgUrl = char?.image?.medium_url;
        if (imgUrl) {
          db.prepare('INSERT OR REPLACE INTO cv_character_cache (name, image_url, cv_id, cached_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
            .run(queryLower, imgUrl, String(ovId));
          return res.json({ results: [{ id: ovId, name: query, image: { medium_url: imgUrl } }] });
        }
      } catch {}
    }

    // 3. Multi-strategy lookup:
    //    A) filter by name (CV does substring match, so "Storm" returns "Stormwatch" etc)
    //    B) filter by real_name (catches "Dick Grayson" → finds Nightwing entry)
    //    C) full-text search fallback
    //    Scoring gives +500 for exact name match, -200 for non-exact, so
    //    substring noise gets buried even if it has high appearance counts.

    // Strategy A: name filter
    let results = await cvCharacterFetch(`name:${query}`, 25);

    // Strategy B: real_name filter (runs in parallel, deduped by id)
    let realNameResults = [];
    try { realNameResults = await cvCharacterFetch(`real_name:${query}`, 10); } catch {}

    const seen = new Set(results.map(c => c.id));
    realNameResults.forEach(c => { if (!seen.has(c.id)) { seen.add(c.id); results.push(c); } });

    // Strategy C: full-text search if very few results
    if (results.length < 3) {
      try {
        const fb = await cvApiGet('https://comicvine.gamespot.com/api/search', {
          params: { api_key: getCVKey(), format: 'json', query, resources: 'character', limit: 10,
            field_list: 'id,name,real_name,image,publisher,count_of_issue_appearances,description' },
          headers: { 'User-Agent': 'Omnibus/1.0' }
        });
        (fb.data.results || []).forEach(c => { if (!seen.has(c.id)) results.push(c); });
      } catch {}
    }

    // 5. Score and pick best
    const scored = results
      .map(c => ({ ...c, _score: scoreCharacterResult(c, queryLower) }))
      .sort((a, b) => b._score - a._score);

    const best = scored[0];
    if (best?.image?.medium_url) {
      db.prepare('INSERT OR REPLACE INTO cv_character_cache (name, image_url, cv_id, cached_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
        .run(queryLower, best.image.medium_url, String(best.id));
    }

    res.json({ results: scored });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/comicvine/character-search-batch?names=Batman,Superman,...
// Resolves multiple character names in parallel — one round trip instead of N.
// Returns { results: { [name]: imageUrl | null } }
app.get('/api/comicvine/character-search-batch', async (req, res) => {
  try {
    const names = (req.query.names || '').split(',').map(n => n.trim()).filter(Boolean).slice(0, 20);
    if (!names.length) return res.json({ results: {} });

    const userOverridePath = path.join(path.dirname(DB_PATH), 'cv_overrides.json');
    let userOverrides = {};
    if (fs.existsSync(userOverridePath)) {
      try { userOverrides = JSON.parse(fs.readFileSync(userOverridePath, 'utf8')); } catch {}
    }
    const allOverrides = { ...BUNDLED_CV_OVERRIDES, ...userOverrides };

    const resolveOne = async (name) => {
      const nameLower = name.toLowerCase().trim();
      // Cache hit
      const cached = db.prepare(
        "SELECT image_url FROM cv_character_cache WHERE name = ? AND cached_at > datetime('now', '-7 days')"
      ).get(nameLower);
      if (cached) return cached.image_url;

      // Override
      const ovId = allOverrides[nameLower];
      if (ovId) {
        try {
          const r = await cvApiGet(`https://comicvine.gamespot.com/api/character/4005-${ovId}/`, {
            params: { api_key: getCVKey(), format: 'json', field_list: 'id,name,image' },
            headers: { 'User-Agent': 'Omnibus/1.0' }
          });
          const imgUrl = r.data.results?.image?.medium_url;
          if (imgUrl) {
            db.prepare('INSERT OR REPLACE INTO cv_character_cache (name, image_url, cv_id, cached_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
              .run(nameLower, imgUrl, String(ovId));
            return imgUrl;
          }
        } catch {}
      }

      // Search
      try {
        const results = await cvCharacterFetch(`name:${name}`, 10);
        const scored = results.map(c => ({ ...c, _score: scoreCharacterResult(c, nameLower) }))
          .sort((a, b) => b._score - a._score);
        const best = scored[0];
        const imgUrl = best?.image?.medium_url || null;
        if (imgUrl) {
          db.prepare('INSERT OR REPLACE INTO cv_character_cache (name, image_url, cv_id, cached_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
            .run(nameLower, imgUrl, String(best.id));
        }
        return imgUrl;
      } catch { return null; }
    };

    const resolved = await Promise.all(names.map(n => resolveOne(n)));
    const results = {};
    names.forEach((n, i) => { results[n] = resolved[i]; });
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CV Person search (real people / creators) ────────────────────
// GET /api/comicvine/person-search?q=Grant+Morrison
// Mirrors character search but uses CV's person resource type (4040-)
const { usableImage, verifiedPersonPhoto, createPersonPhotos } = require('./personPhotos');
const personPhotos = createPersonPhotos({
  read: name => db.prepare('SELECT image_url, cv_person_id, cached_at FROM cv_person_cache WHERE name = ?').get(name),
  write: (name, photo) => db.prepare('INSERT OR REPLACE INTO cv_person_cache (name, cv_person_id, image_url, cached_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)').run(name, photo.cv_person_id, photo.image_url),
  request: cvApiGet,
  getKey: getCVKey,
});
app.get('/api/comicvine/person-search', async (req, res) => {
  try { res.json(await personPhotos.resolve(req.query.q || '')); }
  catch (e) {
    logger.warn('cv', 'Person search failed', e.message);
    res.json({ image_url: null, cv_person_id: null });
  }
});
let creatorPhotosRunning = false;

// GET /api/canon/creators
// Returns distinct writers/pencilers from approved canon runs,
// with cached CV person images. Triggers background image fetch
// for any creators missing images.
app.get('/api/canon/creators', requireAuth, async (req, res) => {
  try {
    // Get distinct writers and pencilers from approved runs
    const rows = db.prepare(`
      SELECT crc.person_name, crc.role, COUNT(DISTINCT crc.run_id) as run_count
      FROM canon_run_creators crc
      JOIN canon_runs cr ON cr.id = crc.run_id
      JOIN canon_run_categories cat ON cat.run_id = cr.id
      WHERE cr.status = 'approved'
        AND crc.role IN ('writer', 'penciler', 'penciller')
      GROUP BY lower(crc.person_name)
      ORDER BY run_count DESC, crc.person_name ASC
    `).all();

    // Look up cached images
    const withImages = rows.map(r => {
      const cached = db.prepare(
        "SELECT image_url, cv_person_id FROM cv_person_cache WHERE name = ?"
      ).get(r.person_name.toLowerCase());
      return {
        name:        r.person_name,
        role:        r.role,
        run_count:   r.run_count,
        image_url:   usableImage(cached?.image_url) || verifiedPersonPhoto(r.person_name)?.image_url || null,
        cv_person_id: cached?.cv_person_id || verifiedPersonPhoto(r.person_name)?.cv_person_id || null,
      };
    });

    // Respond immediately — don't block on image fetching
    res.json(withImages);

    // One batch at a time; the shared resolver deduplicates lookups and respects
    // negative-cache TTLs, transient-error cooldowns, and the global CV budget.
    const missing = withImages.filter(c => !c.image_url);
    if (missing.length && !creatorPhotosRunning && getCVKey()) {
      creatorPhotosRunning = true;
      setImmediate(async () => {
        try {
          for (const creator of missing) {
            try { await personPhotos.resolve(creator.name); }
            catch (e) { logger.warn('canon', 'Person image fetch failed for ' + creator.name, e.message); }
          }
        } finally { creatorPhotosRunning = false; }
      });
    }
  } catch (e) {
    logger.error('canon', 'Canon creators failed', e.message);
    res.status(500).json({ error: e.message });
  }
});


// Runs create-series-json then optionally enricher for every series
// that is missing a series.json. Progress is polled via GET status.
const massJsonState = {
  running: false,
  queued: 0,
  done: 0,
  created: 0,
  enriched: 0,
  skipped: 0,
  errors: 0,
  currentSeries: null,
  log: [],          // last 50 lines
  lastRun: null,
};

function massLog(msg) {
  massJsonState.log.push(msg);
  if (massJsonState.log.length > 50) massJsonState.log.shift();
  logger.info('mass-json', msg);
}

async function runMassJson({ force = false, enrich = false } = {}) {
  if (massJsonState.running) return;
  massJsonState.running = true;
  massJsonState.done = 0;
  massJsonState.created = 0;
  massJsonState.enriched = 0;
  massJsonState.skipped = 0;
  massJsonState.errors = 0;
  massJsonState.log = [];
  massJsonState.currentSeries = null;

  try {
    const allSeries = db.prepare(`SELECT * FROM monitored_series ORDER BY name`).all();
    const targets = force
      ? allSeries
      : allSeries.filter(s => !fs.existsSync(path.join(s.directory, 'series.json')));

    massJsonState.queued = targets.length;
    massLog(`Starting mass JSON for ${targets.length} series (force=${force}, enrich=${enrich})`);

    // Build config once from DB
    const enricherPath = path.join(SCRIPTS_PATH, 'enricher.py');

    // Write DB-based config to temp file for enricher
    const massConfigPath = path.join(path.dirname(DB_PATH), 'mass_json_config.yaml');
    const aiRun = startEnricherRun(`Mass JSON: ${targets.length} series`);
    fs.writeFileSync(massConfigPath, yaml.dump(buildEnricherConfig(force, aiRun)));

    for (const series of targets) {
      massJsonState.currentSeries = series.name;
      const jsonPath = path.join(series.directory, 'series.json');

      // Skip if directory doesn't exist
      if (!fs.existsSync(series.directory)) {
        massLog(`SKIP ${series.name} — directory missing`);
        massJsonState.skipped++;
        massJsonState.done++;
        continue;
      }

      // Create + enrich in one pass using enricher --create mode
      if (!fs.existsSync(jsonPath) || force) {
        // Rebuild: keep the current file as series.json.bak and restore it if
        // the rebuild fails, so a failed run never leaves a series without one.
        const hadJson = force && fs.existsSync(jsonPath);
        if (hadJson) backupAndRemoveSeriesJson(series.directory);
        try {
          massLog(`Creating + enriching: ${series.name}`);
          await new Promise((resolve, reject) => {
            // `create` takes no --force flag (argparse rejects it); a rebuild is
            // already forced by removing the existing file above.
            const args = [enricherPath, 'create', series.directory, String(series.id),
              '--config', massConfigPath];
            const proc = spawn('python3', args, { env: { ...process.env, PYTHONUNBUFFERED: '1' } });
            proc.stdout.on('data', d => massLog(`  ${d.toString().trim()}`));
            proc.stderr.on('data', d => massLog(`  ${d.toString().trim()}`));
            proc.on('close', code => {
              finishEnricherRun(aiRun);
              if (code !== 0) reject(new Error(`enricher exit ${code}`));
              else resolve();
            });
          });
          invalidateSeriesJsonCache(series.id);
          if (!fs.existsSync(jsonPath)) throw new Error('enricher did not write series.json');
          massJsonState.created++;
          massJsonState.enriched++;
          massLog(`✓ Done: ${series.name}`);
        } catch (e) {
          if (hadJson && restoreSeriesJsonBackup(series.directory)) massLog(`  Restored previous series.json for ${series.name}`);
          massLog(`✗ Error: ${series.name}: ${e.message}`);
          massJsonState.errors++;
          massJsonState.done++;
          continue;
        }
      } else if (enrich) {
        // series.json exists — just enrich
        try {
          massLog(`Enriching: ${series.name}`);
          await new Promise((resolve, reject) => {
            const args = [enricherPath, 'enrich', series.directory,
              '--config', massConfigPath, ...(force ? ['--force'] : [])];
            const proc = spawn('python3', args, { env: { ...process.env, PYTHONUNBUFFERED: '1' } });
            proc.stdout.on('data', d => massLog(`  ${d.toString().trim()}`));
            proc.stderr.on('data', d => massLog(`  ${d.toString().trim()}`));
            proc.on('close', code => {
              finishEnricherRun(aiRun);
              if (code !== 0) reject(new Error(`enricher exit ${code}`));
              else resolve();
            });
          });
          massJsonState.enriched++;
          massLog(`✓ Enriched: ${series.name}`);
        } catch (e) {
          massLog(`✗ Enrich error ${series.name}: ${e.message}`);
          massJsonState.errors++;
        }
      } else {
        massLog(`SKIP ${series.name} — series.json exists`);
        massJsonState.skipped++;
      }

      massJsonState.done++;
      await new Promise(r => setTimeout(r, 300)); // small breathe between series
    }

    massJsonState.lastRun = new Date().toISOString();
    massLog(`Done — created: ${massJsonState.created}, enriched: ${massJsonState.enriched}, skipped: ${massJsonState.skipped}, errors: ${massJsonState.errors}`);
  } catch (e) {
    massLog(`Fatal error: ${e.message}`);
    logger.error('mass-json', 'Mass run failed', e.message);
  } finally {
    massJsonState.running = false;
    massJsonState.currentSeries = null;
  }
}

app.post('/api/monitor/mass-json', requireAdmin, (req, res) => {
  if (massJsonState.running) {
    return res.json({ started: false, reason: 'Already running', state: massJsonState });
  }
  // Create-missing only. Force (rebuild all) and Enrich (re-enrich all) were removed:
  // across the whole library they exceed CV's hourly limit many times over, incur
  // AI cost per series, and wipe manual edits. Use the series page for one series.
  setImmediate(() => runMassJson({ force: false, enrich: false }).catch(e => logger.warn('mass-json', 'Job deferred', e.message)));
  res.json({ started: true, state: massJsonState });
});

app.get('/api/monitor/mass-json/status', requireAdmin, (req, res) => {
  res.json(massJsonState);
});


// ─── Create series.json from a Comic Vine volume (enricher create) ──
// Used by the series page's create / re-link and by "Create from files" (2026-11-13).
// Returns { path, name, comicid } or { status, error }.
async function createSeriesJsonFromVolume(seriesId, volumeId, userId = null) {
    const scanned = db.prepare('SELECT path FROM scanned_series WHERE id = ?').get(seriesId);
    const monitored = !scanned ? db.prepare('SELECT directory as path FROM monitored_series WHERE id = ?').get(seriesId) : null;
    const folderPath = scanned?.path || monitored?.path;
    if (!folderPath) return { status: 404, error: 'Series not found' };
    if (!fs.existsSync(folderPath)) return { status: 404, error: `Series folder not found: ${folderPath}` };

    // One config file per run: a click and the "Create from files" job may overlap.
    const configPath = path.join(path.dirname(DB_PATH), `create_tmp_config_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.yaml`);
    const aiRun = startEnricherRun(`Create series.json: ${path.basename(folderPath)}`, userId);
    fs.writeFileSync(configPath, yaml.dump(buildEnricherConfig(false, aiRun)));

    const enricherPath = path.join(SCRIPTS_PATH, 'enricher.py');
    const args = [enricherPath, 'create', folderPath, String(volumeId), '--config', configPath];

    logger.info('create-json', `spawning enricher create`, { seriesId: seriesId, volumeId, folderPath });

    const output = await new Promise((resolve, reject) => {
      const proc = spawn('python3', args, { env: { ...process.env, PYTHONUNBUFFERED: '1' } });
      let stdout = '', stderr = '';
      proc.stdout.on('data', d => { stdout += d; });
      proc.stderr.on('data', d => { stderr += d; logger.debug('create-json', d.toString().trim()); });
      proc.on('close', code => {
        finishEnricherRun(aiRun);
        try { fs.unlinkSync(configPath); } catch {}
        const lines = stdout.trim().split('\n').filter(l => l.trim().startsWith('{'));
        if (lines.length > 0) return resolve(lines[lines.length - 1].trim());
        if (code !== 0) return reject(new Error(stderr.trim() || `Script exited with code ${code}`));
        resolve(stdout.trim());
      });
    });

    let result;
    try { result = JSON.parse(output); }
    catch (parseErr) {
      console.error('[create-json] stdout:', output);
      return { status: 500, error: 'Script did not return valid JSON. Check server logs.' };
    }

    if (!result.success) return { status: 500, error: result.error || 'Script failed' };

    syncSeriesJsonRow({ seriesId });
    logger.info('create-json', `library row refreshed`, { seriesId });
    scheduleGroupingRun('series.json created');   // a new series.json can put the series on a Specials shelf
    return { path: result.path, name: result.name, comicid: result.comicid };
}

// ─── Create series.json via Python script (fetches full CV data) ──
app.post('/api/series/:id/create-json', requireAdmin, async (req, res) => {
  try {
    const { volumeId } = req.body;
    if (!volumeId) return res.status(400).json({ error: 'volumeId required' });
    // With a Metron token the enricher answers from Metron when Comic Vine is at its limit, so only
    // a Comic Vine-only install is told to wait.
    const busy = (getSetting('metron_api_token') || process.env.METRON_API_TOKEN) ? null : cvBusyUntil();
    if (busy) {
      const at = new Date(busy).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: process.env.TZ || 'UTC' });
      return res.status(429).json({ error: `Comic Vine's hourly limit is used up. Try again after ${at}.`, retryAt: busy });
    }

    const out = await createSeriesJsonFromVolume(req.params.id, volumeId, req.user?.sub || null);
    if (out.status) return res.status(out.status).json({ error: out.error });
    res.json({ success: true, path: out.path, name: out.name, comicid: out.comicid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Force rescan a single series ────────────────────────────────
// Zeroes dir_mtime/dir_file_count so the smart-rescan skip is bypassed,
// then runs a full library scan. Use after enricher updates series.json.
app.post('/api/series/:id/force-rescan', requireAdmin, async (req, res) => {
  const scanned = db.prepare('SELECT id, library_id, path FROM scanned_series WHERE id = ?').get(req.params.id);
  if (!scanned) return res.status(404).json({ error: 'Series not found in library' });
  db.prepare('UPDATE scanned_series SET dir_mtime = 0, dir_file_count = 0 WHERE id = ?').run(scanned.id);
  logger.info('scanner', `Force rescan requested`, { seriesId: scanned.id, path: scanned.path });

  // Optional thumbnail wipe — when ?thumbs=1 (or body.regenerateThumbnails is
  // truthy), evict the series thumb plus every book thumb under this series
  // so they get regenerated on next request. Useful for "I edited the cover
  // images on disk and want to see the changes" without the user also having
  // to clear all thumbnails site-wide. Done before res.json so the user
  // refresh that follows actually pulls fresh thumbs.
  const wantThumbs = req.query.thumbs === '1' || req.body?.regenerateThumbnails;
  let thumbsCleared = 0;
  if (wantThumbs) {
    evictThumbCache(`series_${scanned.id}`);
    const books = db.prepare('SELECT id FROM scanned_books WHERE series_id = ?').all(scanned.id);
    for (const b of books) {
      evictThumbCache(b.id);
      thumbsCleared++;
    }
    // Bump the gen counter so any browser that has the old ETag fetches fresh.
    thumbCacheGen = Date.now();
    logger.info('thumbcache', `Evicted thumbnails for series rescan`, { seriesId: scanned.id, books: thumbsCleared });
  }

  res.json({ success: true, message: 'Force rescan queued', thumbsCleared });
  setImmediate(async () => {
    try {
      const { upsertSeries, upsertBook } = makeScanStmts();
      await scanSeriesDir(scanned.path, scanned.library_id, upsertSeries, upsertBook);
      setImmediate(reconcileEventIssues);
      logger.info('scanner', `Force rescan complete`, { seriesId: scanned.id });
    } catch (e) {
      logger.error('scanner', `Force rescan failed`, { seriesId: scanned.id, error: e.message });
    }
  });
});

// ─── Enrich series.json via Python enricher ───────────────────────
app.post('/api/series/:id/enrich', requireAdmin, async (req, res) => {
  try {
    logger.info('enrich', `starting enrichment`, { seriesId: req.params.id, force: req.body.force });

    // Get folder path from scanned_series (or fall back to monitored_series)
    const scanned = db.prepare('SELECT path FROM scanned_series WHERE id = ?').get(req.params.id);
    const monitored = !scanned ? db.prepare('SELECT directory as path FROM monitored_series WHERE id = ?').get(req.params.id) : null;
    const folderPath = scanned?.path || monitored?.path;
    if (!folderPath) return res.status(404).json({ error: 'Series not found' });
    const jsonPath = seriesJsonPath(folderPath);

    if (!fs.existsSync(jsonPath)) {
      return res.status(404).json({ error: 'No series.json found. Create one first.' });
    }

    const configPath = path.join(path.dirname(DB_PATH), `enrich_config_${req.params.id}.yaml`);
    const aiRun = startEnricherRun(`Enrich: ${path.basename(folderPath)}`, req.user?.sub || null);
    fs.writeFileSync(configPath, yaml.dump(buildEnricherConfig(!!req.body.force, aiRun)));

    // Stream output back to client via SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const enrichArgs = [
      path.join(SCRIPTS_PATH, 'enricher.py'),
      'enrich', folderPath,
      '--config', configPath,
      ...(req.body.force ? ['--force'] : [])
    ];
    logger.info('enrich', `calling enricher`, { seriesFolder: folderPath, jsonPath });

    const py = spawn('python3', enrichArgs, { env: { ...process.env, PYTHONUNBUFFERED: '1' } });

    py.stdout.on('data', d => res.write(`data: ${JSON.stringify({ log: d.toString() })}\n\n`));
    py.stderr.on('data', d => res.write(`data: ${JSON.stringify({ log: d.toString() })}\n\n`));
    py.on('close', code => {
      finishEnricherRun(aiRun);
      syncSeriesJsonRow({ seriesId: req.params.id });
      try { fs.unlinkSync(configPath); } catch {}
      res.write(`data: ${JSON.stringify({ done: true, code })}\n\n`);
      res.end();
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Genre retag (Library › Genres, 2026-11-03) ───────────────────────
// Genres only, for every library series with a series.json whose genres were not chosen
// from the current list (enrichment.genres_version ≠ GENRE_VERSION), so a stopped or
// interrupted run picks up where it left off. "Test" does 30 at random for review first.
// enricher.py retag-genres asks about 20 series per AI call from what each series.json
// already holds (no Comic Vine) and prints the answers; the server writes each series.json
// itself, under the library lock for that one series (a lock for the whole run would hold up
// every page for minutes), changing only the genres. One AI run per job.
const GENRE_TEST_SIZE = 30;
const genreRetag = { running: false, test: false, model: null, again: false, total: 0, done: 0, written: 0, changed: 0, noAnswer: 0, failed: 0,
  startedAt: null, finishedAt: null, stopped: false, error: null, problem: null, runId: null, results: [], proc: null };
// A test can be run again on the same series (e.g. with another model) to compare: the
// last random test's series are kept in settings (2026-11-04).
const GENRE_TEST_KEY = 'genre_retag_last_test';
const GENRE_TEST_MODELS = { sonnet: 'claude-sonnet-5-5' };   // a retag (test or all) may use another model than the Enricher's
function genreLastTestIds() { try { const v = JSON.parse(getSetting(GENRE_TEST_KEY) || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } }
function genreRetagTargets() {
  return db.prepare("SELECT id, name, year, path, series_json FROM scanned_series WHERE series_json IS NOT NULL AND series_json != ''").all()
    .filter(r => {
      try { const m = JSON.parse(r.series_json).metadata; return m && typeof m === 'object' && !Array.isArray(m) && m.enrichment?.genres_version !== GENRE_VERSION; }
      catch { return false; }
    });
}
function genreRetagStatus() {
  const { proc, ...state } = genreRetag;
  const cost = state.runId ? db.prepare('SELECT COALESCE(SUM(cost), 0) AS c FROM ai_calls WHERE run_id = ?').get(state.runId).c : 0;
  return { ...state, cost, pending: genreRetagTargets().length, version: GENRE_VERSION, genres: GENRE_DEFS, estimate: genreRetagEstimate(),
    lastTest: genreLastTestIds().length, testModels: Object.keys(GENRE_TEST_MODELS),
    estimates: Object.fromEntries(Object.keys(GENRE_TEST_MODELS).map(k => [k, genreRetagEstimate(k)])) };
}
// Cost per series for the button's estimate: from the last retag run (its saved call costs over
// its series), else from the Enricher model's prices at ~180 tokens in and ~15 out per series
// (2026-11-03 test on Haiku 5.5: 30 series, 2 calls, 0.1¢).
function genreRetagEstimate(modelKey = null) {
  const chosen = GENRE_TEST_MODELS[modelKey] || null;   // null: the Enricher's model
  try {
    const last = db.prepare(`SELECT r.label, SUM(c.cost) AS cost FROM ai_runs r JOIN ai_calls c ON c.run_id = r.id
      WHERE r.label LIKE 'Genre retag%' AND ${chosen ? 'r.label LIKE ?' : "r.label NOT LIKE '%model %'"} GROUP BY r.id ORDER BY r.at DESC LIMIT 1`)
      .get(...(chosen ? [`%model ${chosen}%`] : []));
    const n = last && Number(String(last.label).match(/([\d,]+) series/)?.[1]?.replace(/,/g, ''));
    if (n && last.cost > 0) return { perSeries: last.cost / n, basis: 'last run' };
  } catch {}
  const model = chosen || aiRouting.modelFor('enricher');
  return { perSeries: aiCallCost({ model, input_tokens: 260, output_tokens: 20 }) || 0, basis: 'prices' };
}
async function runGenreRetag({ test = false, userId = null, model = null, again = false } = {}) {
  let targets;
  if (test && again) {   // the last test's series, whatever list they were tagged from
    const ids = genreLastTestIds();
    targets = ids.map(id => db.prepare('SELECT id, name, year, path FROM scanned_series WHERE id = ?').get(id)).filter(Boolean);
  } else {
    targets = genreRetagTargets();
    if (test) {
      targets = targets.map(t => [Math.random(), t]).sort((a, b) => a[0] - b[0]).slice(0, GENRE_TEST_SIZE).map(([, t]) => t);
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(GENRE_TEST_KEY, JSON.stringify(targets.map(t => t.id)));
    }
  }
  const testModel = GENRE_TEST_MODELS[model] || null;   // test or all
  const names = new Map(targets.map(t => [t.id, t.year ? `${t.name} (${t.year})` : t.name]));
  const run = startEnricherRun(test ? `Genre retag (test, ${targets.length} series${again ? ', again' : ''}${testModel ? `, model ${testModel}` : ''})` : `Genre retag: ${targets.length} series${testModel ? `, model ${testModel}` : ''}`, userId);
  Object.assign(genreRetag, { running: true, test, model: testModel, again: !!(test && again), total: targets.length, done: 0, written: 0, changed: 0, noAnswer: 0, failed: 0,
    startedAt: new Date().toISOString(), finishedAt: null, stopped: false, error: null, problem: null, runId: run.id, results: [] });
  const dir = fs.mkdtempSync(path.join(path.dirname(DB_PATH), 'genre-retag-'));
  const targetsPath = path.join(dir, 'targets.json'), configPath = path.join(dir, 'config.yaml');
  fs.writeFileSync(targetsPath, JSON.stringify(targets.map(t => ({ id: t.id, path: t.path }))));
  const config = buildEnricherConfig(false, run);
  if (testModel) config.anthropic = { ...config.anthropic, model: testModel };
  fs.writeFileSync(configPath, yaml.dump(config));
  logger.info('genres', `Genre retag started${test ? ' (test)' : ''}: ${targets.length} series`);
  const same = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
  let writes = Promise.resolve();
  const writeGenres = (id, genres) => libraryAccess.run('write', async () => {
    const row = db.prepare('SELECT path FROM scanned_series WHERE id = ?').get(id);
    const data = row && readSeriesJson(row.path);
    if (!data || !data.metadata || typeof data.metadata !== 'object' || Array.isArray(data.metadata)) throw new Error('series.json not readable');
    const enr = data.metadata.enrichment && typeof data.metadata.enrichment === 'object' ? data.metadata.enrichment : {};
    data.metadata.genres = genres;
    data.metadata.enrichment = { ...enr, genres_version: GENRE_VERSION, genres_date: new Date().toISOString() };
    writeSeriesJsonSynced(row.path, data);
  }, { scope: 'series:' + id });
  const onLine = line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.fatal) { genreRetag.error = String(msg.fatal); return; }
    if (msg.warning) { genreRetag.problem = String(msg.warning); logger.warn('genres', `Genre retag: ${msg.warning}`); return; }
    if (msg.progress) { genreRetag.done = msg.progress.done; finishEnricherRun(run); return; }
    const r = msg.result; if (!r) return;
    const note = status => { if (test || genreRetag.results.length < 200) genreRetag.results.push({ id: r.id, name: names.get(r.id) || r.id, status, before: r.before || null, after: r.after || null }); };
    const failed = (status, error) => { genreRetag.failed++; note(status); logger.warn('genres', `Genre retag: ${names.get(r.id) || r.id} not changed (${status})`, error ? { error } : undefined); };
    if (r.status === 'answered' && Array.isArray(r.after) && r.after.length) {
      writes = writes.then(() => writeGenres(r.id, r.after)).then(() => {
        genreRetag.written++;
        if (!same(r.before, r.after)) genreRetag.changed++;
        note('written');
      }, e => failed('write_failed', e.message));
    } else if (r.status === 'no_answer') { genreRetag.noAnswer++; note('no_answer'); }
    else failed(r.status, r.error);
  };
  try {
    await new Promise(resolve => {
      // nativeSpawn: the script only reads; the writes above take the lock series by series.
      const proc = nativeSpawn('python3', [path.join(SCRIPTS_PATH, 'enricher.py'), 'retag-genres', targetsPath, '--config', configPath],
        { env: { ...process.env, PYTHONUNBUFFERED: '1' } });
      genreRetag.proc = proc;
      let buf = '';
      proc.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
      proc.stderr.on('data', d => { const t = d.toString().trim(); if (t) logger[/error|traceback/i.test(t) ? 'warn' : 'debug']('genres', t.slice(0, 500)); });
      proc.on('error', e => { genreRetag.error = e.message; resolve(); });
      proc.on('close', code => { if (buf) onLine(buf); if (code && !genreRetag.stopped && !genreRetag.error) genreRetag.error = `enricher exited with code ${code}`; resolve(); });
    });
    await writes;
  } finally {
    finishEnricherRun(run);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    Object.assign(genreRetag, { running: false, proc: null, finishedAt: new Date().toISOString() });
    invalidateSeriesCache();
    const st = genreRetagStatus();
    logger.info('genres', `Genre retag ${genreRetag.stopped ? 'stopped' : genreRetag.error ? 'failed' : 'finished'}${test ? ' (test)' : ''}: ${st.written} of ${st.total} series written (${st.changed} changed), ${st.noAnswer} without an answer, ${st.failed} failed; ${Math.round(st.cost * 10000) / 100}¢`, genreRetag.error ? { error: genreRetag.error } : undefined);
  }
}
app.get('/api/admin/genres/retag', requireAdmin, (req, res) => res.json(genreRetagStatus()));
app.post('/api/admin/genres/retag', requireAdmin, (req, res) => {
  if (genreRetag.running) return res.status(409).json({ error: 'A genre retag is already running.' });
  if (!getAnthropicKey() && !getOpenAIKey()) return res.status(400).json({ error: 'No Anthropic or OpenAI key is set up (Settings › AI Models).' });
  const model = req.body?.model ? String(req.body.model) : null;
  if (model && !GENRE_TEST_MODELS[model]) return res.status(400).json({ error: 'Unknown model for a retag.' });
  if (model && !getAnthropicKey()) return res.status(400).json({ error: 'No Anthropic key is set up (Settings › AI Models).' });
  if (req.body?.again && !genreLastTestIds().length) return res.status(400).json({ error: 'There is no earlier test to run again.' });
  runGenreRetag({ test: !!req.body?.test, userId: req.user?.sub || null, model, again: !!req.body?.again }).catch(e => logger.error('genres', 'Genre retag failed', e.message));
  res.json(genreRetagStatus());
});
app.post('/api/admin/genres/retag/stop', requireAdmin, (req, res) => {
  if (genreRetag.running && genreRetag.proc) { genreRetag.stopped = true; try { genreRetag.proc.kill('SIGTERM'); } catch {} }
  res.json(genreRetagStatus());
});

// ─── Series without metadata ──────────────────────────────────────
// ─── In-progress books (continue reading) ────────────────────────
app.get('/api/books/in-progress', requireAuth, (req, res) => {
  try {
    const { libraryId } = req.query;
    const userId = req.user?.sub || null;
    const libFilter = libraryId ? ' AND ss.library_id = ?' : '';
    const params = [userId, ...(libraryId ? [libraryId] : [])];
    const books = db.prepare(`
      SELECT sb.*, rp.page, ss.name as seriesName, ss.id as seriesId FROM scanned_books sb
      JOIN read_progress rp ON rp.book_id = sb.id
      JOIN scanned_series ss ON ss.id = sb.series_id
      WHERE rp.completed = 0 AND rp.page > 0 AND rp.user_id = ? ${libFilter}
      ORDER BY rp.updated_at DESC LIMIT 20
    `).all(...params);
    res.json({ content: books });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Updated home endpoint ────────────────────────────────────────
app.get('/api/home/v2', requireAuth, (req, res) => {
  try {
    const { libraryId } = req.query;
    const libFilter = libraryId ? ' AND ss.library_id = ?' : '';
    const libParams = libraryId ? [libraryId] : [];
    const userId = req.user?.sub || null;

    // Per-series Continue Reading.
    // A series qualifies if EITHER (a) it has an in-progress issue (page>0, not completed),
    // OR (b) at least one issue is completed AND a later un-started issue exists.
    // Series dismissed by the user are skipped unless new activity has occurred since dismissal.
    const seriesProgress = db.prepare(`
      SELECT
        sb.series_id,
        -- Activity = reading in the reader. Issues marked read in bulk (read
        -- history) still count as read when choosing the next issue below.
        MAX(CASE WHEN COALESCE(rp.marked, 0) = 0 AND (rp.completed = 1 OR rp.page > 0) THEN rp.updated_at ELSE NULL END) AS last_activity,
        MAX(CASE WHEN rp.completed = 0 AND rp.page > 0 THEN 1 ELSE 0 END) AS has_in_progress,
        MAX(CASE WHEN rp.completed = 1 THEN 1 ELSE 0 END) AS has_completed,
        MAX(CASE WHEN rp.completed = 1 THEN sb.sort_order ELSE -1 END) AS max_completed_sort
      FROM read_progress rp
      JOIN scanned_books sb ON sb.id = rp.book_id
      JOIN scanned_series ss ON ss.id = sb.series_id
      WHERE rp.user_id = ? ${libFilter}
      GROUP BY sb.series_id
      HAVING last_activity IS NOT NULL AND (has_in_progress = 1 OR has_completed = 1)
      ORDER BY last_activity DESC
    `).all(userId, ...libParams);
    // No LIMIT, and only series read in the reader: ~6,400 issues marked read
    // as reading history (2026-10-14) were the newest "activity" and filled the
    // old LIMIT 100, pushing real continue-reading series out (1 of 22 shown).
    // The loop below stops at 30 qualifying series.

    const dismissedMap = userId ? new Map(
      db.prepare('SELECT series_id, dismissed_at FROM dismissed_continue_reading WHERE user_id = ?')
        .all(userId).map(r => [r.series_id, r.dismissed_at])
    ) : new Map();

    const pickInProgressBook = db.prepare(`
      SELECT sb.*, rp.page, ss.name as seriesName, ss.id as seriesId
      FROM read_progress rp
      JOIN scanned_books sb ON sb.id = rp.book_id
      JOIN scanned_series ss ON ss.id = sb.series_id
      WHERE rp.user_id = ? AND sb.series_id = ?
        AND rp.completed = 0 AND rp.page > 0
      ORDER BY rp.updated_at DESC LIMIT 1
    `);
    const pickNextUnstartedBook = db.prepare(`
      SELECT sb.*, ss.name as seriesName, ss.id as seriesId, 0 as page
      FROM scanned_books sb
      JOIN scanned_series ss ON ss.id = sb.series_id
      LEFT JOIN read_progress rp ON rp.book_id = sb.id AND rp.user_id = ?
      WHERE sb.series_id = ?
        AND sb.sort_order > ?
        AND (rp.id IS NULL OR (rp.completed = 0 AND rp.page = 0))
      ORDER BY sb.sort_order ASC LIMIT 1
    `);

    // One card per event / run / list being read, with its next issue in that order; a series
    // last read through one of them gets no card of its own (readingContexts.js).
    const contexts = readingContexts ? readingContexts.cards(userId, { libraryId }) : { cards: [], live: new Set() };
    const inProgress = [];
    for (const sp of seriesProgress) {
      const dismissedAt = dismissedMap.get(sp.series_id);
      // If dismissed and no new activity since dismissal, skip.
      if (dismissedAt && (!sp.last_activity || dismissedAt >= sp.last_activity)) continue;
      const viaContext = readingContexts && readingContexts.seriesLastContext(userId, sp.series_id);
      if (viaContext && contexts.live.has(viaContext)) continue;

      let book = null;
      if (sp.has_in_progress) {
        book = pickInProgressBook.get(userId, sp.series_id);
      } else if (sp.has_completed) {
        book = pickNextUnstartedBook.get(userId, sp.series_id, sp.max_completed_sort);
      }
      if (book) inProgress.push({ ...book, _activity: sp.last_activity });
      if (inProgress.length >= 30) break;
    }

    // Post-process: collapse per-series entries into single event entries for crossovers.
    // If 2+ different series from the same event appear in inProgress, replace them all
    // with one event entry (using the most-recently-read book as the visual anchor).
    if (inProgress.length > 0) {
      const bookIds = inProgress.map(b => b.id);
      const placeholders = bookIds.map(() => '?').join(',');
      const eventMatches = db.prepare(`
        SELECT ei.event_id, ei.scanned_book_id, e.name AS event_name
        FROM event_issues ei
        JOIN events e ON e.id = ei.event_id
        WHERE ei.scanned_book_id IN (${placeholders})
      `).all(...bookIds);

      if (eventMatches.length > 0) {
        // book_id → { eventId, eventName }
        const bookEventMap = new Map(
          eventMatches.map(m => [m.scanned_book_id, { eventId: m.event_id, eventName: m.event_name }])
        );

        // Group items by eventId, tracking distinct series per event
        const eventGroups = new Map();
        for (const book of inProgress) {
          const evInfo = bookEventMap.get(book.id);
          if (!evInfo) continue;
          if (!eventGroups.has(evInfo.eventId)) {
            eventGroups.set(evInfo.eventId, { eventId: evInfo.eventId, eventName: evInfo.eventName, items: [], seriesIds: new Set() });
          }
          const g = eventGroups.get(evInfo.eventId);
          g.items.push(book);
          g.seriesIds.add(book.seriesId);
        }

        // Only collapse events where 2+ distinct series are represented
        const collapsedEvents = new Map(); // eventId → synthetic event entry
        for (const [eventId, g] of eventGroups) {
          if (g.seriesIds.size >= 2) {
            const anchor = g.items[0]; // most recently read (inProgress is already DESC by last_activity)
            collapsedEvents.set(eventId, { ...anchor, fromEvent: true, eventId: g.eventId, eventName: g.eventName });
          }
        }

        if (collapsedEvents.size > 0) {
          const seenEvents = new Set();
          const consolidated = [];
          for (const book of inProgress) {
            const evInfo = bookEventMap.get(book.id);
            if (evInfo && collapsedEvents.has(evInfo.eventId)) {
              if (!seenEvents.has(evInfo.eventId)) {
                seenEvents.add(evInfo.eventId);
                consolidated.push(collapsedEvents.get(evInfo.eventId));
              }
              // subsequent books from the same collapsed event are dropped
            } else {
              consolidated.push(book);
            }
          }
          inProgress.length = 0;
          inProgress.push(...consolidated);
        }
      }
    }

    // Context cards in among the series cards, newest reading first. An older-style event card
    // (series cards of one event folded together) gives way to that event's own context card.
    if (contexts.cards.length) {
      const ctxEvents = new Set(contexts.cards.filter(c => c.fromContext.kind === 'event').map(c => String(c.fromContext.id)));
      const merged = [...inProgress.filter(b => !(b.fromEvent && ctxEvents.has(String(b.eventId)))), ...contexts.cards]
        .sort((a, b) => String(b._activity || '').localeCompare(String(a._activity || ''))).slice(0, 30);
      inProgress.length = 0;
      inProgress.push(...merged);
    }
    for (const b of inProgress) delete b._activity;

    const allSeries = fetchAllSeries(libraryId);

    // Recently released — 30 most recent monitored issues by effective date.
    // No per-series dedupe so the shelf shows variety, not the same N series.
    const recentlyReleased = db.prepare(`
      SELECT sb.*, ss.name as seriesName, ss.id as seriesId,
             COALESCE(mi.store_date, mi.release_date) as effective_date,
             mi.issue_number as mi_issue_number
      FROM scanned_books sb
      JOIN scanned_series ss ON ss.id = sb.series_id
      LEFT JOIN monitored_issues mi ON mi.id = sb.monitored_issue_id
      WHERE 1=1 ${libFilter}
        AND COALESCE(mi.store_date, mi.release_date) IS NOT NULL
        AND COALESCE(mi.store_date, mi.release_date) <= date('now')
      ORDER BY COALESCE(mi.store_date, mi.release_date) DESC
      LIMIT 30
    `).all(...libParams);
    const recentlyReleasedDeduped = recentlyReleased
      .map(b => ({ ...b, rating: getSeriesRating(b.seriesId) }));

    // Character map — cached for 5 minutes, expensive to rebuild
    const cacheKey = libraryId || '';
    const charHit = charMapCache.get(cacheKey);
    let topCharacters;
    if (charHit && (Date.now() - charHit.ts) < 5 * 60 * 1000) {
      topCharacters = charHit.data;
    } else {
      // Count first, merge only the 8 characters shown (2026-11-05): merging up to 4 series for
      // every character in the library (thousands, each with its own lookups) took ~4.5 s and
      // held up every other request on the page. Same result: the first 4 series per character.
      const charMap = {};
      allSeries.forEach(s => {
        const json = getSeriesJsonCached(s.id, s.path);
        (json?.metadata?.characters || []).forEach(char => {
          if (!charMap[char]) charMap[char] = { name: char, series: [], count: 0 };
          if (charMap[char].series.length < 4) charMap[char].series.push(s);
          charMap[char].count++;
        });
      });
      topCharacters = Object.values(charMap)
        .filter(c => c.count >= 3)
        .sort((a, b) => b.count - a.count).slice(0, 8)
        .map(c => ({ ...c, series: c.series.map(mergeSeriesWithJson) }));
      charMapCache.set(cacheKey, { data: topCharacters, ts: Date.now() });
    }

    res.set('Cache-Control', 'private, max-age=60');

    // Library stats — fast COUNT queries, library-filtered
    const statsFilter = libraryId ? 'WHERE library_id = ?' : '';
    const statsParams = libraryId ? [libraryId] : [];
    const seriesCount = db.prepare(`SELECT COUNT(*) as n FROM scanned_series ${statsFilter}`).get(...statsParams).n;
    const issuesCount = db.prepare(`SELECT COUNT(*) as n FROM scanned_books sb ${libraryId ? 'JOIN scanned_series ss ON ss.id = sb.series_id WHERE ss.library_id = ?' : ''}`).get(...statsParams).n;
    const readCount   = db.prepare(`SELECT COUNT(*) as n FROM read_progress rp ${libraryId ? 'JOIN scanned_books sb ON sb.id = rp.book_id JOIN scanned_series ss ON ss.id = sb.series_id WHERE rp.completed = 1 AND ss.library_id = ?' : 'WHERE rp.completed = 1'} ${!libraryId && userId ? 'AND rp.user_id = ?' : libraryId && userId ? 'AND rp.user_id = ?' : ''}`).get(...statsParams, ...(userId ? [userId] : [])).n;

    res.json({ inProgress: inProgress.map(book => ({ ...book, pagesCount: book.comicinfo ? (parseComicInfo(book.comicinfo).pageCount || null) : null })), recentlyReleased: recentlyReleasedDeduped, topCharacters, stats: { seriesCount, issuesCount, readCount } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Dismiss / Restore Continue Reading ──────────────────────────
// Body: { seriesId } — adds (or refreshes) a dismissal for the user.
// Series stays hidden until the user logs new reading activity on it.
app.post('/api/home/continue-reading/dismiss', requireAuth, (req, res) => {
  try {
    const userId = req.user?.sub || null;
    const { seriesId, context } = req.body || {};
    if (!userId)   return res.status(401).json({ error: 'Authentication required' });
    // An event / run / list card: hidden until that context is read again.
    if (context) return readingContexts && readingContexts.dismiss(userId, String(context)) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not on Continue Reading' });
    if (!seriesId) return res.status(400).json({ error: 'seriesId required' });
    db.prepare(`
      INSERT INTO dismissed_continue_reading (user_id, series_id, dismissed_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(user_id, series_id) DO UPDATE SET dismissed_at = datetime('now')
    `).run(userId, seriesId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Removes a dismissal so the series can re-appear on Continue Reading immediately.
app.delete('/api/home/continue-reading/dismiss/:seriesId', requireAuth, (req, res) => {
  try {
    const userId = req.user?.sub || null;
    const { seriesId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    db.prepare('DELETE FROM dismissed_continue_reading WHERE user_id = ? AND series_id = ?')
      .run(userId, seriesId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Discover shelf — random shuffle, never cached
app.get('/api/home/discover', (req, res) => {
  try {
    const { libraryId } = req.query;
    const allSeries = fetchAllSeries(libraryId);

    // Random discover series
    const discoverSeries = [...allSeries].sort(() => Math.random() - 0.5).slice(0, 8).map(s => ({
      ...mergeSeriesWithJson(s),
      rating: getSeriesRating(s.id),
    }));

    // Character shelf — pool is all characters in top 3 of any series.json.
    // Cached indefinitely — charMapCache is cleared by invalidateSeriesCache()
    // at the end of every library scan, so the pool rebuilds exactly when new
    // series might have been added and never expires mid-session.
    const cacheKey = (libraryId || '') + ':charpool';
    const poolHit = charMapCache.get(cacheKey);
    let charPool;
    if (poolHit) {
      charPool = poolHit.data;
    } else {
      const poolMap = {};
      allSeries.forEach(s => {
        const json = getSeriesJsonCached(s.id, s.path);
        const chars = json?.metadata?.characters || [];
        // Only consider first 3 positions — the series' primary characters
        chars.slice(0, 3).forEach(char => {
          if (!poolMap[char]) poolMap[char] = { name: char, count: 0 };
          poolMap[char].count++;
        });
      });
      charPool = Object.values(poolMap).filter(c => c.count >= 3).sort((a, b) => b.count - a.count);
      charMapCache.set(cacheKey, { data: charPool });
    }

    // Shuffle pool and pick up to 8 — different every load
    const shuffled = [...charPool].sort(() => Math.random() - 0.5);
    const topCharacters = shuffled.slice(0, 8).map(c => ({ name: c.name, count: c.count }));

    res.set('Cache-Control', 'no-store');
    res.json({ discoverSeries, topCharacters });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SERVE FRONTEND ───────────────────────────────────────────────

// ─── Settings API ────────────────────────────────────────────────
// Settings hold API keys and service passwords, so only the admin sees them.
// Other users get just the flags the app's menus need.
const USER_VISIBLE_SETTINGS = ['download_manager_admin_only', 'catalog_publisher_notes'];   // catalog_publisher_notes: admin text on the Essentials publisher bars (2026-10-28)
//   // legacy_edit_order and legacy_admin_pages retired 2026-10-26 (old Edit Order mode, Events Admin / Canon Admin).
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const isAdminUser = req.user?.role === 'admin';
  const obj = {};
  rows.forEach(r => { if (isAdminUser || USER_VISIBLE_SETTINGS.includes(r.key)) obj[r.key] = secrets.isSecret(r.key) ? secrets.mask(r.value, r.key) : r.value; });
  res.json(obj);
});

app.post('/api/settings', requireAdmin, (req, res) => {
  const updates = req.body;
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  Object.entries(updates).forEach(([k, v]) => {
    if (!secrets.isSecret(k)) return stmt.run(k, v);
    if (secrets.isMask(v)) return;                          // the masked value came back unchanged
    stmt.run(k, secrets.seal(typeof v === 'string' ? v.trim() : v));
  });
  res.json({ success: true });
});

// ─── Publisher config helper ──────────────────────────────────────
function getPublisherConfig() {
  const publishers = db.prepare('SELECT * FROM publisher_config ORDER BY publisher ASC').all();
  return publishers.map(pub => ({
    ...pub,
    use_folder_detection: !!pub.use_folder_detection,
    eras: db.prepare('SELECT * FROM publisher_eras WHERE publisher_id = ? ORDER BY sort_order ASC, start_year ASC').all(pub.id),
    imprints: db.prepare('SELECT * FROM publisher_imprints WHERE publisher_id = ?').all(pub.id),
    skip_patterns: db.prepare('SELECT id, pattern FROM publisher_skip_patterns WHERE publisher_id = ?').all(pub.id),
  }));
}

// Build enricher config from DB — used by all script spawn calls
function buildEnricherConfig(force = false, run = null) {
  const publishers = getPublisherConfig();
  const pubConfig = {};
  for (const pub of publishers) {
    pubConfig[pub.publisher.toLowerCase().replace(/\s+/g, '_')] = {
      display_name: pub.publisher,
      use_folder_detection: pub.use_folder_detection,
      eras: pub.eras.map(e => ({ name: e.name, start_year: e.start_year, end_year: e.end_year, folder: e.folder || null })),
      imprints: pub.imprints.map(i => ({ pattern: i.pattern, name: i.name })),
      skip_patterns: pub.skip_patterns.map(p => p.pattern),
    };
  }
  return {
    api_keys: {
      comicvine: getCVKey(),
      anthropic: getAnthropicKey(),
      openai: getOpenAIKey(),
      // Metron first for series facts and issue dates (enricher.py MetronClient, 2026-11-13).
      metron: getSetting('metron_api_token') || process.env.METRON_API_TOKEN || '',
    },
    anthropic: {
      model: aiRouting.pick('enricher'),   // trial split applies per enricher run
    },
    publishers: pubConfig,
    enrichment: {
      enrich_description: true,
      enrich_characters: true,
      enrich_genre: true,
      enrich_era: true,
      skip_if_enriched_within_days: force ? 0 : 30,
      force_description: force,
    },
    // The genre list and its definitions (genres.js) and the AI run for this process.
    genres: { version: GENRE_VERSION, list: GENRE_DEFS.map(g => ({ name: g.name, definition: g.definition })) },
    ...(run ? { ai_run: { id: run.id } } : {}),
  };
}

require('./branding').registerBranding(app, { db, requireAuth, requireAdmin, express, sharp: require('sharp') });

// ─── Publisher config API ─────────────────────────────────────────
// GET all publishers
app.get('/api/publishers', requireAdmin, (req, res) => {
  res.json(getPublisherConfig());
});

// POST create publisher
app.post('/api/publishers', requireAdmin, (req, res) => {
  const { publisher, use_folder_detection = false } = req.body;
  if (!publisher) return res.status(400).json({ error: 'publisher name required' });
  try {
    const info = db.prepare('INSERT INTO publisher_config (publisher, use_folder_detection) VALUES (?, ?)')
      .run(publisher.trim(), use_folder_detection ? 1 : 0);
    res.json({ id: info.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH update publisher
app.patch('/api/publishers/:id', requireAdmin, (req, res) => {
  const { publisher, use_folder_detection } = req.body;
  try {
    if (publisher !== undefined)
      db.prepare('UPDATE publisher_config SET publisher = ?, updated_at = datetime(\'now\') WHERE id = ?').run(publisher, req.params.id);
    if (use_folder_detection !== undefined)
      db.prepare('UPDATE publisher_config SET use_folder_detection = ?, updated_at = datetime(\'now\') WHERE id = ?').run(use_folder_detection ? 1 : 0, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE publisher (cascades to eras/imprints/skip_patterns)
app.delete('/api/publishers/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM publisher_config WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// POST add era to publisher
app.post('/api/publishers/:id/eras', requireAdmin, (req, res) => {
  const { name, start_year, end_year, sort_order = 0, folder = null } = req.body;
  if (!name) return res.status(400).json({ error: 'era name required' });
  try {
    const info = db.prepare('INSERT INTO publisher_eras (publisher_id, name, start_year, end_year, sort_order, folder) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.params.id, name, start_year || null, end_year || null, sort_order, folder || null);
    res.json({ id: info.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH update era
app.patch('/api/publishers/:id/eras/:eraId', requireAdmin, (req, res) => {
  const { name, start_year, end_year, sort_order, folder = null } = req.body;
  try {
    db.prepare('UPDATE publisher_eras SET name = ?, start_year = ?, end_year = ?, sort_order = ?, folder = ? WHERE id = ? AND publisher_id = ?')
      .run(name, start_year || null, end_year || null, sort_order ?? 0, folder || null, req.params.eraId, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE era
app.delete('/api/publishers/:id/eras/:eraId', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM publisher_eras WHERE id = ? AND publisher_id = ?').run(req.params.eraId, req.params.id);
  res.json({ ok: true });
});

// POST add imprint to publisher
app.post('/api/publishers/:id/imprints', requireAdmin, (req, res) => {
  const { pattern, name } = req.body;
  if (!pattern || !name) return res.status(400).json({ error: 'pattern and name required' });
  try {
    const info = db.prepare('INSERT INTO publisher_imprints (publisher_id, pattern, name) VALUES (?, ?, ?)')
      .run(req.params.id, pattern, name);
    res.json({ id: info.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE imprint
app.delete('/api/publishers/:id/imprints/:imprintId', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM publisher_imprints WHERE id = ? AND publisher_id = ?').run(req.params.imprintId, req.params.id);
  res.json({ ok: true });
});

// POST add skip pattern
app.post('/api/publishers/:id/skip-patterns', requireAdmin, (req, res) => {
  const { pattern } = req.body;
  if (!pattern) return res.status(400).json({ error: 'pattern required' });
  try {
    const info = db.prepare('INSERT INTO publisher_skip_patterns (publisher_id, pattern) VALUES (?, ?)').run(req.params.id, pattern);
    res.json({ id: info.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE skip pattern
app.delete('/api/publishers/:id/skip-patterns/:patternId', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM publisher_skip_patterns WHERE id = ? AND publisher_id = ?').run(req.params.patternId, req.params.id);
  res.json({ ok: true });
});

// ─── Directory suggestion for new monitored series ─────────────────
// Takes publisher name + year, returns a suggested path based on publisher
// config eras (year-range primary, folder field for path construction).
app.get('/api/publishers/suggest-directory', requireAuth, (req, res) => {
  try {
    // A publisher is a folder name, never a path: no "..", slashes or other separators (CodeQL, 2026-11-12).
    const publisher = typeof req.query.publisher === 'string' ? req.query.publisher.replace(/[/\\:*?"<>|\0]/g, '').replace(/^\.+$/, '').trim().slice(0, 120) : '';
    const { year } = req.query;
    const yearNum = year ? parseInt(year) : null;
    const publishers = getPublisherConfig();

    // Match publisher config by name (case-insensitive substring)
    const pubLower = (publisher || '').toLowerCase();
    const pub = publishers.find(p => pubLower.includes(p.publisher.toLowerCase()) || p.publisher.toLowerCase().includes(pubLower));

    if (!pub) {
      // No publisher config — suggest /comics/<publisher name>
      const pubFolder = publisher ? `${COMICS_PATH}/${publisher}` : COMICS_PATH;
      const exists = fs.existsSync(pubFolder);
      return res.json({ suggested: pubFolder, era: null, confidence: 'low', exists, reason: 'No publisher config found' });
    }

    // Find matching era
    let matchedEra = null;
    if (yearNum) {
      for (const era of pub.eras) {
        const start = era.start_year;
        const end = era.end_year;
        if ((start === null || yearNum >= start) && (end === null || yearNum <= end)) {
          matchedEra = era;
          break;
        }
      }
    }

    // Build path
    // Publisher root: COMICS_PATH/<publisher.publisher>
    const pubRoot = `${COMICS_PATH}/${pub.publisher}`;

    let suggestedPath, confidence, reason;
    if (matchedEra && matchedEra.folder) {
      // Best case: era matched and has a folder defined
      suggestedPath = `${pubRoot}/${matchedEra.folder}`;
      confidence = 'high';
      reason = `${pub.publisher} · ${matchedEra.name} era`;
    } else if (matchedEra && !matchedEra.folder) {
      // Era matched but no folder — suggest publisher root
      suggestedPath = pubRoot;
      confidence = 'medium';
      reason = `${pub.publisher} · ${matchedEra.name} era (no folder configured for this era)`;
    } else if (yearNum) {
      // No era matched — suggest publisher root
      suggestedPath = pubRoot;
      confidence = 'low';
      reason = `${pub.publisher} · no era matched for ${yearNum}`;
    } else {
      suggestedPath = pubRoot;
      confidence = 'low';
      reason = `${pub.publisher} · no year provided`;
    }

    const exists = fs.existsSync(suggestedPath);

    // Also return all eras with folders so the UI can offer manual era selection
    const erasWithFolders = pub.eras.filter(e => e.folder).map(e => ({
      id: e.id, name: e.name, folder: e.folder,
      path: `${pubRoot}/${e.folder}`,
      exists: fs.existsSync(`${pubRoot}/${e.folder}`),
    }));

    // Also return imprint folders so the UI can offer them as picker options.
    // Imprints aren't auto-suggested (no reliable signal at series-add time —
    // CV doesn't reliably expose imprint membership) but they should appear
    // alongside era folders so the user can pick "Ultimate Comics" or
    // "Black Label" instead of the year-based era folder when relevant.
    // Once the file is placed under an imprint folder, enricher.py picks it
    // up via path-based detection and writes the imprint into series.json.
    // Pattern field IS the folder name on disk — see PublisherSettings UI
    // which surfaces this as "Folder pattern".
    const imprintsWithFolders = pub.imprints.map(i => ({
      id: i.id, name: i.name, folder: i.pattern,
      path: `${pubRoot}/${i.pattern}`,
      exists: fs.existsSync(`${pubRoot}/${i.pattern}`),
    }));

    res.json({
      suggested: suggestedPath,
      era: matchedEra ? { name: matchedEra.name, folder: matchedEra.folder } : null,
      publisher: pub.publisher,
      pubRoot,
      confidence,
      reason,
      exists,
      erasWithFolders,
      imprintsWithFolders,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Test Prowlarr connection
app.get('/api/settings/test/prowlarr', requireAdmin, async (req, res) => {
  try {
    const url = getSetting('prowlarr_url');
    const key = getSetting('prowlarr_api_key');
    const r = await axios.get(`${url}/api/v1/indexer`, {
      headers: { 'X-Api-Key': key },
      timeout: 5000,
    });
    res.json({ ok: true, indexers: r.data.length });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Test SABnzbd connection
app.get('/api/settings/test/sabnzbd', requireAdmin, async (req, res) => {
  try {
    const url = getSetting('sabnzbd_url');
    const key = getSetting('sabnzbd_api_key');
    const r = await axios.get(`${url}/api`, {
      params: { apikey: key, mode: 'version', output: 'json' },
      timeout: 5000,
    });
    res.json({ ok: true, version: r.data.version });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/settings/test/metron', requireAdmin, async (req, res) => {
  try {
    if (!(getSetting('metron_api_token') || process.env.METRON_API_TOKEN)) return res.json({ ok: false, error: 'No API token set' });
    const r = await metron.test();
    res.json({ ok: true, version: 'Metron API' + (r.lists != null ? ` (reading lists reachable)` : '') });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/settings/test/comicvine', requireAdmin, async (req, res) => {
  try {
    const key = getCVKey();
    if (!key) return res.json({ ok: false, error: 'No API key set' });
    const r = await cvApiGet('https://comicvine.gamespot.com/api/types/', {
      params: { api_key: key, format: 'json' },
      timeout: 8000,
    });
    if (r.data.status_code === 1) res.json({ ok: true, version: 'ComicVine API' });
    else res.json({ ok: false, error: r.data.error || 'Unknown error' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Anthropic models for the Settings menus ─────────────────────
// Lists the models this API key can use (Anthropic Models API), with list
// prices and notes from modelCatalog.js, cheapest first. Falls back to the
// ids already in use when the API can't be reached.
const modelCatalog = require('./modelCatalog');
// Model menus: each connected provider's current models (backend/modelCatalog.js).
const _modelLists = {};
async function providerModels(provider, refresh) {
  const hit = _modelLists[provider];
  if (hit && Date.now() - hit.at < 10 * 60 * 1000 && !refresh) return hit.data;
  let raw = [], source = 'api', error = null;
  const key = provider === 'openai' ? getOpenAIKey() : provider === 'gemini' ? getGeminiKey() : getAnthropicKey();
  if (key) {
    try {
      const r = provider === 'openai'
        ? await axios.get('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` }, timeout: 10000 })
        : provider === 'gemini'
          ? await axios.get('https://generativelanguage.googleapis.com/v1beta/models', { params: { pageSize: 200 }, headers: { 'x-goog-api-key': key }, timeout: 10000 })
          : await axios.get('https://api.anthropic.com/v1/models', { params: { limit: 100 }, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, timeout: 10000 });
      raw = provider === 'gemini' ? (r.data?.models || []) : (r.data?.data || []);
      if (provider === 'gemini') logger.info('ai', 'Gemini models listed', { ids: raw.map(m => String(m.name || '').replace(/^models\//, '')).join(', ').slice(0, 2000) });
    } catch (e) { error = e.response?.data?.error?.message || e.message; }
  } else error = 'No API key set';
  if (!key && provider !== 'anthropic') return { provider, source: 'none', error, models: [] };
  if (!raw.length) { raw = provider === 'openai' ? modelCatalog.OPENAI_FALLBACK : provider === 'gemini' ? modelCatalog.GEMINI_FALLBACK : modelCatalog.FALLBACK; source = 'fallback'; }
  const models = provider === 'openai'
    ? modelCatalog.currentOpenAIModels(raw)
    : provider === 'gemini'
      ? modelCatalog.currentGeminiModels(raw)
      : modelCatalog.currentModels(raw.map(modelCatalog.describe)).map(m => ({ ...m, provider: 'anthropic' }));
  const data = { provider, source, error, models };
  if (source === 'api') _modelLists[provider] = { at: Date.now(), data };
  return data;
}
app.get('/api/settings/anthropic-models', requireAdmin, async (req, res) => {
  try { res.json(await providerModels('anthropic', req.query.refresh === '1')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ai/models', requireAdmin, async (req, res) => {
  try {
    const lists = await Promise.all(['anthropic', 'openai', 'gemini'].map(p => providerModels(p, req.query.refresh === '1')));
    res.json({ models: lists.flatMap(l => l.models), sources: Object.fromEntries(lists.map(l => [l.provider, { source: l.source, error: l.error }])),
      source: lists[0].source, error: lists[0].error });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Settings → AI Models ─────────────────────────────────────────
// Two top-level models and the tasks that follow them, plus provider keys.
app.get('/api/ai/settings', requireAdmin, (req, res) => {
  try {
    res.json({ ...aiRouting.snapshot(), tiers: aiModels.TIERS,
      providers: [
        { id: 'anthropic', label: 'Anthropic (Claude)', keySet: !!getAnthropicKey(), fromEnv: !getSetting('anthropic_api_key') && !!process.env.ANTHROPIC_API_KEY, features: aiModels.PROVIDER_FEATURES.anthropic },
        { id: 'openai', label: 'OpenAI (GPT)', keySet: !!getOpenAIKey(), fromEnv: !getSetting('openai_api_key') && !!process.env.OPENAI_API_KEY, features: aiModels.PROVIDER_FEATURES.openai },
        { id: 'gemini', label: 'Google (Gemini)', keySet: !!getGeminiKey(), fromEnv: !getSetting('gemini_api_key') && !!process.env.GEMINI_API_KEY, features: aiModels.PROVIDER_FEATURES.gemini, lookupOnly: true },
      ] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ai/settings', requireAdmin, (req, res) => {
  try {
    const rows = aiModels.settingsRows(req.body || {});
    for (const k of ['anthropic_api_key', 'openai_api_key', 'gemini_api_key']) if (typeof req.body?.[k] === 'string' && !secrets.isMask(req.body[k])) rows.push([k, req.body[k].trim()]);
    // Refuse a combination that would send a web-search/tool task to a provider that cannot do it.
    const proposed = new Map(rows);
    // Keys saved in this same request count as connected.
    const keyFor = { anthropic: 'anthropic_api_key', openai: 'openai_api_key', gemini: 'gemini_api_key' };
    const problems = aiModels.routingProblems(k => proposed.has(k) ? proposed.get(k) : getSetting(k),
      { hasProvider: p => (proposed.has(keyFor[p]) ? !!proposed.get(keyFor[p]) : false) || hasAiProvider(p) });
    if (problems.length) {
      const needs = problems.filter(p => p.reason !== 'lookup_only'), lookup = problems.filter(p => p.reason === 'lookup_only');
      const parts = [];
      if (needs.length) parts.push(`These tasks need Claude (web search or Comic Book Guy tools): ${needs.map(p => p.label).join(', ')}. Choose a Claude model for them.`);
      if (lookup.length) parts.push(`Gemini runs only lookups and page reading (Web Search, Recap – Summary Writer, Recap – Page Reader, Top Shelf – Category Check), not: ${lookup.map(p => p.label).join(', ')}.`);
      return res.status(400).json({ error: parts.join(' '), problems });
    }
    const put = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    db.transaction(() => { for (const [k, v] of rows) put.run(k, secrets.isSecret(k) ? secrets.seal(v) : v); })();
    res.json({ ok: true, ...aiRouting.snapshot() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── AI usage (Settings → AI Models → Usage) ─────────────────────
// Period: since the last reset, or the last N days. Source: "live" = real use (questions, generators
// and recap lookups), "test" = test runs, "all".
function aiUsageWindow(q) {
  const since = Number(getSetting('ai_usage_since')) || 0;
  const days = parseInt(q.days, 10);
  const from = Math.max(since, days > 0 ? Date.now() - days * 86400000 : 0);
  const source = ['live', 'test'].includes(q.source) ? q.source : null;
  const where = `at >= ?${source === 'live' ? " AND source IN ('live', 'recap')" : source === 'test' ? " AND source = 'test'" : ''}`;
  return { since, from, source, where, args: [from] };
}
const callCost = c => (c.cost != null ? c.cost : modelCatalog.estimateCost(c.model, c));
// ⓘ details and the top-bar AI activity feed (aiInfo.js, 2026-11-09).
aiInfo.registerAiInfo({ app, db, requireAdmin, displayName: m => modelCatalog.displayName(m), taskLabel: aiTaskLabel, callCost });
app.get('/api/ai/usage', requireAdmin, (req, res) => {
  try {
    const { since, from, source, where, args } = aiUsageWindow(req.query);
    const calls = db.prepare(`SELECT id, job_id, task, tier, provider, model, ok, ms, day, input_tokens, output_tokens, cache_read, cache_write, web_searches, thinking_tokens, cost FROM ai_calls WHERE ${where} ORDER BY at, id`).all(...args);
    const jobOutcome = new Map(db.prepare(`SELECT id, task, outcome FROM ai_jobs WHERE ${where}`).all(...args).map(j => [j.id, j]));
    // Each task's own share of a job (2026-10-23): a Comic Book Guy question that used Web Search counts
    // under Quick Answers and under Web Search, each with its own calls and cost, so task totals add up.
    // A job's outcome applies to the task that produced its result; other tasks count a call that
    // worked as good. Calls logged before jobs existed count as one job each.
    const parts = new Map();
    for (const c of calls) {
      const key = `${c.job_id || `call-${c.id}`}|${c.task || ''}`;
      if (!parts.has(key)) parts.set(key, { job_id: c.job_id, task: c.task, tier: c.tier || aiModels.TASKS.find(t => t.id === c.task)?.tier || null, day: c.day, calls: 0, failed_calls: 0, ms: 0, cost: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, web_searches: 0 });
      const j = parts.get(key);
      j.provider = c.provider; j.model = c.model;   // the last call's model (the one that produced the result)
      j.calls++; if (!c.ok) j.failed_calls++; j.ms += c.ms || 0;
      j.cost += callCost(c); j.input_tokens += c.input_tokens; j.output_tokens += c.output_tokens; j.cache_read += c.cache_read; j.web_searches += c.web_searches;
      if (c.thinking_tokens != null) { j.thinking_tokens = (j.thinking_tokens || 0) + c.thinking_tokens; j.output_measured = (j.output_measured || 0) + c.output_tokens; }
    }
    const GOOD = new Set(['ok', 'matched', 'written']);
    const outcomeOf = j => { const job = j.job_id && jobOutcome.get(j.job_id); return (job && job.outcome && job.task === j.task) ? job.outcome : (j.failed_calls >= j.calls ? 'error' : 'ok'); };
    const all = [...parts.values()].map(j => ({ ...j, provider: ['openai', 'gemini'].includes(j.provider) ? j.provider : 'anthropic', outcome: outcomeOf(j) }));
    const tests = all.filter(j => j.task === 'connection_test'), work = all.filter(j => j.task !== 'connection_test');
    const pct = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))] : 0;
    const stats = list => {
      const times = list.map(j => j.ms || 0).sort((a, b) => a - b), cost = list.reduce((a, j) => a + j.cost, 0);
      const problems = {};
      for (const j of list) if (!GOOD.has(j.outcome)) problems[j.outcome] = (problems[j.outcome] || 0) + 1;
      const good = list.filter(j => GOOD.has(j.outcome)).length;
      return { jobs: list.length, calls: list.reduce((a, j) => a + (j.calls || 1), 0), cost: Math.round(cost * 1e6) / 1e6,
        cost_per_job: list.length ? Math.round((cost / list.length) * 1e6) / 1e6 : 0, cost_per_1000: list.length ? Math.round((cost / list.length) * 1000 * 100) / 100 : 0,
        good, good_rate: list.length ? Math.round((good / list.length) * 1000) / 10 : null, problems,
        median_ms: pct(times, 0.5), p90_ms: pct(times, 0.9),
        input_tokens: list.reduce((a, j) => a + j.input_tokens, 0), output_tokens: list.reduce((a, j) => a + j.output_tokens, 0),
        cache_read: list.reduce((a, j) => a + j.cache_read, 0), web_searches: list.reduce((a, j) => a + j.web_searches, 0),
        ...(() => {   // share of output spent thinking, over calls where it was measured (from 2026-10-22)
          const t = list.reduce((a, j) => a + (j.thinking_tokens || 0), 0), o = list.reduce((a, j) => a + (j.output_measured || 0), 0);
          return { thinking_tokens: t, thinking_share: o ? Math.round((t / o) * 1000) / 10 : null };
        })() };
    };
    const split = (keyOf, meta) => {
      const groups = new Map();
      for (const j of work) { const k = keyOf(j) || 'other'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(j); }
      return [...groups].map(([k, list]) => ({ key: k, ...meta(k, list), anthropic: stats(list.filter(j => j.provider === 'anthropic')), openai: stats(list.filter(j => j.provider === 'openai')), gemini: stats(list.filter(j => j.provider === 'gemini')), all: stats(list) }));
    };
    const taskOrder = aiModels.TASKS.map(t => t.id);
    const byTask = split(j => j.task, k => { const t = aiModels.TASKS.find(x => x.id === k); return { label: t?.label || `Other (${k})`, tier: t?.tier || null }; })
      .sort((a, b) => (taskOrder.indexOf(a.key) + 1 || 99) - (taskOrder.indexOf(b.key) + 1 || 99));
    const byTier = split(j => j.tier, k => ({ label: k === 'quick' ? 'Quick model tasks' : k === 'generation' ? 'Generation model tasks' : 'Other' }))
      .sort((a, b) => (a.key === 'quick' ? 0 : a.key === 'generation' ? 1 : 2) - (b.key === 'quick' ? 0 : b.key === 'generation' ? 1 : 2));
    // Short rows for expansions (2026-10-23): a model's tasks, a provider's models.
    const brief = (key, label, list) => { const st = stats(list); return { key, label, jobs: st.jobs, cost: st.cost, good_rate: st.good_rate }; };
    const groupBy = (list, keyOf) => { const m = new Map(); for (const j of list) { const k = keyOf(j) || 'other'; if (!m.has(k)) m.set(k, []); m.get(k).push(j); } return [...m]; };
    const taskName = k => aiModels.TASKS.find(x => x.id === k)?.label || `Other (${k})`;
    const byModel = split(j => j.model, (k, list) => ({ label: modelCatalog.displayName(k), provider: /^(openai|gemini):/.exec(k)?.[1] || 'anthropic', class: modelCatalog.modelClass(k),
      tasks: groupBy(list, j => j.task).map(([t, l]) => brief(t, taskName(t), l)).sort((a, b) => b.cost - a.cost) }))
      .sort((a, b) => b.all.cost - a.all.cost);
    const providerModels = Object.fromEntries(['anthropic', 'openai', 'gemini'].map(p => [p,
      groupBy(work.filter(j => j.provider === p), j => j.model).map(([m, l]) => brief(m, modelCatalog.displayName(m), l)).sort((a, b) => b.cost - a.cost)]));
    // Daily cost per provider (oldest first).
    const daysMap = new Map();
    for (const j of work) { const d = j.day || 'unknown'; if (!daysMap.has(d)) daysMap.set(d, { day: d, anthropic: 0, openai: 0, gemini: 0 }); daysMap.get(d)[j.provider] += j.cost; }
    const daily = [...daysMap.values()].sort((a, b) => a.day.localeCompare(b.day)).map(d => ({ ...d, anthropic: Math.round(d.anthropic * 1e4) / 1e4, openai: Math.round(d.openai * 1e4) / 1e4, gemini: Math.round(d.gemini * 1e4) / 1e4 }));
    const trials = aiModels.TASKS.map(t => ({ id: t.id, label: t.label, trial: aiRouting.trialFor(t.id) })).filter(t => t.trial);
    res.json({ since, from, source: source || 'all', total: stats(work), anthropic: stats(work.filter(j => j.provider === 'anthropic')), openai: stats(work.filter(j => j.provider === 'openai')),
      gemini: stats(work.filter(j => j.provider === 'gemini')), providerModels, byTask, byTier, byModel, daily, trials, connectionTests: { count: tests.length, failed: tests.filter(j => j.outcome === 'error').length } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// A task's runs, newest first (2026-10-23, opened from a row of "By task"). A run is one piece of work
// someone started (see ai.run); calls outside a run are grouped by job. Each run shows this task's
// share and, when it used other tasks too, the whole run's cost. ?task=&days=&source=&offset=&limit=
app.get('/api/ai/usage/runs', requireAdmin, (req, res) => {
  try {
    const task = String(req.query.task || '');
    if (!task) return res.status(400).json({ error: 'task required' });
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0), limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const { where, args } = aiUsageWindow(req.query);
    const calls = db.prepare(`SELECT id, at, ms, task, provider, model, ok, error, job_id, run_id, input_tokens, output_tokens, cache_read, cache_write, web_searches, cost FROM ai_calls WHERE ${where} ORDER BY at, id`).all(...args);
    const runs = new Map();
    for (const c of calls) {
      const key = c.run_id || c.job_id || `call-${c.id}`;
      if (!runs.has(key)) runs.set(key, { key, run_id: c.run_id, start: Infinity, end: 0, calls: 0, cost: 0, tasks: new Set(), jobs: new Set(), mine: { calls: 0, failed: 0, cost: 0, models: new Set(), errors: [] } });
      const r = runs.get(key);
      r.start = Math.min(r.start, c.at - (c.ms || 0)); r.end = Math.max(r.end, c.at);
      r.calls++; r.cost += callCost(c); r.tasks.add(c.task); if (c.job_id) r.jobs.add(c.job_id);
      if (c.task === task) { r.mine.calls++; r.mine.cost += callCost(c); r.mine.models.add(c.model); if (!c.ok) { r.mine.failed++; if (c.error) r.mine.errors.push(c.error); } }
    }
    const list = [...runs.values()].filter(r => r.mine.calls).sort((a, b) => b.start - a.start);
    const page = list.slice(offset, offset + limit);
    const runInfo = db.prepare('SELECT label, user_id FROM ai_runs WHERE id = ?');
    const jobInfo = db.prepare('SELECT task, outcome, detail FROM ai_jobs WHERE id = ?');
    const userName = db.prepare('SELECT username FROM users WHERE id = ?');
    const GOOD = new Set(['ok', 'matched', 'written']);
    const order = aiModels.TASKS.map(t => t.id);
    res.json({ task, total: list.length, offset, runs: page.map(r => {
      const info = r.run_id ? runInfo.get(r.run_id) : null;
      const jobs = [...r.jobs].map(id => jobInfo.get(id)).filter(Boolean);
      const problem = jobs.find(j => j.outcome && !GOOD.has(j.outcome));
      const outcome = problem ? problem.outcome : r.mine.failed >= r.mine.calls ? 'error' : 'ok';
      const detail = (jobs.find(j => j.task === task && j.detail) || jobs.find(j => j.detail) || {}).detail || null;
      const others = [...r.tasks].filter(t => t !== task && t !== 'connection_test').sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
      return { at: r.start, ms: Math.max(0, r.end - r.start), label: info?.label || null, user: info?.user_id ? (userName.get(info.user_id)?.username || null) : null,
        models: [...r.mine.models].map(m => modelCatalog.displayName(m)), calls: r.mine.calls, failed: r.mine.failed, cost: Math.round(r.mine.cost * 1e6) / 1e6,
        run_calls: r.calls, run_cost: Math.round(r.cost * 1e6) / 1e6, other_tasks: others.map(aiTaskLabel), outcome, detail: problem?.detail || detail,
        error: r.mine.errors[0] ? String(r.mine.errors[0]).slice(0, 200) : null };
    }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Every AI call in a recent window, oldest first, with estimated cost (2026-10-21: per-phase cost
// breakdowns of a recap). ?minutes=120 (max 1440). Also written to the backups folder as
// ai-calls-<time>.json so the analysis can be read on the host.
app.get('/api/admin/ai/calls', requireAdmin, (req, res) => {
  try {
    const minutes = Math.min(Math.max(parseInt(req.query.minutes, 10) || 120, 1), 1440);
    const rows = db.prepare('SELECT at, task, provider, model, ok, error, ms, input_tokens, output_tokens, cache_read, cache_write, web_searches, job_id, run_id, source, cost FROM ai_calls WHERE at >= ? ORDER BY at')
      .all(Date.now() - minutes * 60000)
      .map(r => ({ ...r, time: new Date(r.at).toISOString(), cost_cents: Math.round(callCost(r) * 100 * 1000) / 1000 }));
    let file = null;
    try { file = path.join(DB_BACKUP_DIR, `ai-calls-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)}.json`); fs.writeFileSync(file, JSON.stringify(rows, null, 1)); } catch (e) { file = null; }
    res.json({ minutes, calls: rows.length, total_cents: Math.round(rows.reduce((a, r) => a + r.cost_cents, 0) * 100) / 100, file });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ai/usage/reset', requireAdmin, (req, res) => {
  const now = Date.now();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ai_usage_since', String(now));
  res.json({ ok: true, since: now });
});

app.get('/api/settings/test/anthropic', requireAdmin, async (req, res) => {
  try {
    const model = await ai.ping(req.query.model || undefined);   // any provider's model id (each checks its own key)
    res.json({ ok: true, version: model || 'Connected' });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    res.json({ ok: false, error: msg });
  }
});


// ─── qBittorrent helper — login and return session cookie ────────
async function qbtLogin() {
  const url      = getSetting('qbittorrent_url');
  const username = getSetting('qbittorrent_username');
  const password = getSetting('qbittorrent_password');
  // qBittorrent 4.6+ requires Referer and Origin headers to pass Host validation.
  // Without these, requests from non-browser clients get 403.
  const qbtHeaders = {
    'Content-Type':  'application/x-www-form-urlencoded',
    'Referer':       url,
    'Origin':        url,
    'Host':          new URL(url).host,
  };
  const loginRes = await axios.post(
    `${url}/api/v2/auth/login`,
    `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
    { headers: qbtHeaders, timeout: 10000, maxRedirects: 0, validateStatus: s => s < 500 }
  );
  if (loginRes.status === 403) throw new Error('403 Forbidden — add the Omnibus server IP to qBittorrent\'s trusted IP list, or disable "Enable Host header validation" in qBittorrent Web UI settings');
  if (loginRes.data !== 'Ok.') throw new Error(`Login failed (${loginRes.status}): ${loginRes.data}`);
  const cookie = loginRes.headers['set-cookie']?.[0]?.split(';')[0] || '';
  if (!cookie) throw new Error('No session cookie returned — login may have succeeded but cookie was not set');
  return { url, cookie, qbtHeaders: { Cookie: cookie, Referer: url, Origin: url } };
}

/**
 * Resolve the actual btih hash for a torrent we just submitted to qBit.
 *
 * Magnet URIs include the hash inline (urn:btih:...), so for those we just
 * extract it. For HTTP/HTTPS .torrent file URLs (typical of Prowlarr proxy
 * results), qBit only computes the hash after fetching and parsing the file,
 * which takes a few hundred milliseconds. We poll qBit's torrents/info API
 * filtered by category, comparing against a snapshot taken before the add,
 * and return the new hash. Caps at 5s; returns 'qbt' as a placeholder if
 * resolution fails (the watcher will warn on the placeholder so the user
 * knows to re-snatch).
 *
 * Why this matters: download_id is what the watcher uses to match a row in
 * series_packs to a torrent in qBit. If we recorded 'qbt_qbt' for every grab
 * via Prowlarr proxy URL, multiple snatches would collide on the same key
 * and only one would ever progress to 'downloaded'.
 *
 * @param {object} ctx — { url, qbtHeaders } from qbtLogin
 * @param {string} sourceUrl — the URL we just sent to qBit (magnet or HTTPS)
 * @param {string} category — qBit category filter to scope the comparison
 * @param {Set<string>} beforeHashes — hashes present BEFORE the add
 * @returns {Promise<string>} hash (lowercase) or 'qbt' on timeout
 */
async function resolveQbtHash(ctx, sourceUrl, category, beforeHashes) {
  const magnetMatch = sourceUrl.match(/urn:btih:([a-fA-F0-9]+)/i);
  if (magnetMatch) return magnetMatch[1].toLowerCase();
  for (let attempt = 0; attempt < 25; attempt++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const res = await axios.get(`${ctx.url}/api/v2/torrents/info`, {
        headers: ctx.qbtHeaders, timeout: 5000,
        params: { category },
      });
      const newOne = (res.data || []).find(t => !beforeHashes.has(t.hash?.toLowerCase()));
      if (newOne?.hash) return newOne.hash.toLowerCase();
    } catch {}
  }
  logger.warn('qbittorrent', `Could not resolve hash within 5s — watcher matching may fail`, { sourceUrl });
  return 'qbt';
}

app.get('/api/settings/test/qbittorrent', requireAdmin, async (req, res) => {
  // ?which=manga|comic — when specified, additionally verify that:
  //   1. the configured category actually exists in qBittorrent (otherwise
  //      torrents added with that category fall through to qBit's default
  //      save path — silent misroute that's hard to debug later)
  //   2. the configured completed_path is readable from inside our container
  //      (the container path may not match what qBit writes — easy mistake
  //      with Docker volume mounts on Windows hosts)
  // Without ?which, just runs the basic connection check (legacy behaviour).
  const which = (req.query.which || '').toLowerCase();
  try {
    const { url, qbtHeaders } = await qbtLogin();
    const verRes = await axios.get(`${url}/api/v2/app/version`, {
      headers: qbtHeaders, timeout: 5000,
    });
    const result = { ok: true, version: verRes.data };

    if (which === 'manga' || which === 'comic') {
      const expectedCat = which === 'comic'
        ? (getSetting('qbittorrent_comic_category') || 'comics')
        : (getSetting('qbittorrent_category') || 'manga');
      const expectedPath = which === 'comic'
        ? (getSetting('qbittorrent_comic_completed_path') || '')
        : (getSetting('torrent_completed_path') || '');

      // Verify category exists. qBit returns an object keyed by category name.
      try {
        const catRes = await axios.get(`${url}/api/v2/torrents/categories`, {
          headers: qbtHeaders, timeout: 5000,
        });
        const cats = catRes.data || {};
        result.categoryExists = Object.prototype.hasOwnProperty.call(cats, expectedCat);
        result.expectedCategory = expectedCat;
        if (!result.categoryExists) {
          result.ok = false;
          result.error = `Category "${expectedCat}" does not exist in qBittorrent. Add it via qBit's web UI (right-click Categories → Add).`;
        }
      } catch (e) {
        result.categoryCheckError = e.message;
      }

      // Verify completed_path is reachable from the container.
      if (expectedPath) {
        try {
          const stat = fs.statSync(expectedPath);
          result.completedPathExists = stat.isDirectory();
          result.expectedCompletedPath = expectedPath;
          if (!result.completedPathExists) {
            result.ok = false;
            result.error = result.error || `Completed path "${expectedPath}" exists but is not a directory.`;
          }
        } catch (e) {
          result.ok = false;
          result.completedPathExists = false;
          result.expectedCompletedPath = expectedPath;
          result.error = result.error || `Completed path "${expectedPath}" not accessible from container: ${e.message}. Check docker-compose volume mounts.`;
        }
      }

      // Heuristic warning: host save path and container completed path should
      // describe different sides of the same volume mount, so they should
      // virtually never be string-equal. When they are, it's almost always a
      // misconfiguration where the user pasted the container path into both
      // fields — qBit then tries to write to a path that doesn't exist on the
      // host filesystem and torrents fail at start. We don't fail the test
      // outright (some niche all-in-one-container setups could legitimately
      // have equal paths), but we surface a soft warning so the user can
      // double-check. The TestPill renders this as a yellow "ok with caveats"
      // pill rather than a green checkmark.
      const expectedHostPath = which === 'comic'
        ? (getSetting('qbittorrent_comic_savepath') || '')
        : (getSetting('qbittorrent_savepath') || '');
      if (expectedHostPath && expectedPath && expectedHostPath === expectedPath) {
        result.warning = `Host save path and container completed path are identical ("${expectedHostPath}"). These should normally describe different sides of the same volume mount — for example, "D:\\Downloads\\omnibus" on the host and "/downloads/omnibus" inside the container. Identical values usually mean the container path was pasted into both fields, which would cause qBittorrent to fail when starting the torrent.`;
      }
    }

    res.json(result);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Filesystem Browser ──────────────────────────────────────────
// Browse directories under /comics for series directory selection
app.get('/api/filesystem/browse', requireDownloadAccess, (req, res) => {
  try {
    const requestedPath = req.query.path || '/comics';
    // Check directory boundaries and resolve symlinks before listing.
    const safePath = require('./pathSecurity').resolveExistingWithinRoot('/comics', requestedPath);
    const entries = fs.readdirSync(safePath, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({
        name: e.name,
        path: path.join(safePath, e.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ path: safePath, dirs });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Unable to browse directory' });
  }
});

// ─── Monitored Series API ────────────────────────────────────────

// Cache has_series_json results — invalidated when series.json is created/deleted.
// Avoids hitting the filesystem for every series on every 30s poll.
const seriesJsonCache = new Map(); // series_id → boolean
function invalidateSeriesJsonCache(seriesId) { seriesJsonCache.delete(seriesId); }
function getHasSeriesJson(seriesId, directory) {
  if (!seriesJsonCache.has(seriesId)) {
    seriesJsonCache.set(seriesId, fs.existsSync(path.join(directory, 'series.json')));
  }
  return seriesJsonCache.get(seriesId);
}

// Cache directory_exists results — invalidated when the directory is changed
// via PATCH or after refresh-directory might have caused mkdir. Used by the
// frontend to surface a "directory missing" warning state on the series card
// and disable buttons that would create files at the wrong place. Cached
// for the same reason as has_series_json — fs.existsSync per series per
// 30s poll is wasteful at scale.
const directoryExistsCache = new Map(); // series_id → boolean
function invalidateDirectoryExistsCache(seriesId) { directoryExistsCache.delete(seriesId); }
function getDirectoryExists(seriesId, directory) {
  if (!directory) return false;
  if (!directoryExistsCache.has(seriesId)) {
    try {
      directoryExistsCache.set(seriesId, fs.existsSync(directory));
    } catch {
      directoryExistsCache.set(seriesId, false);
    }
  }
  return directoryExistsCache.get(seriesId);
}

// In-series issues flagged as annuals are usually the same real issues as a
// linked annual volume, so they're hidden when one exists. Hide only those that
// actually match a linked annual issue (same number, same cover year); anything
// else stays visible and counted — so a regular issue wrongly flagged as an
// annual still shows, and shows as missing if it has no file (Blue Devil #1).
const annualNumKey = n => {
  const m = String(n ?? '').match(/(\d+(?:\.\d+)?)\s*$/);
  return m ? String(parseFloat(m[1])) : String(n ?? '').trim().toLowerCase();
};
const annualYear = r => String(r.release_date || r.store_date || '').slice(0, 4);
function visibleInSeriesAnnuals(inSeriesAnnuals, linkedAnnualIssues) {
  if (!linkedAnnualIssues.length) return inSeriesAnnuals;
  const keys = new Set(linkedAnnualIssues.map(i => `${annualNumKey(i.issue_number)}|${annualYear(i)}`));
  return inSeriesAnnuals.filter(r => !keys.has(`${annualNumKey(r.issue_number)}|${annualYear(r)}`));
}

app.get('/api/monitor/series', (req, res) => {
  // Exclude linked annual series and child special series — shown inside parent card only
  const linkedAnnualIds = new Set(
    db.prepare('SELECT annual_series_id FROM series_annual_links').all().map(r => r.annual_series_id)
  );

  // Single aggregated query — includes parent name and scanned_series_id for merge/special features
  const rows = db.prepare(`
    SELECT s.*,
      p.name as _parent_name,
      ss.id as scanned_series_id,
      SUM(CASE WHEN i.is_annual = 0 AND i.status != 'skipped' THEN 1 ELSE 0 END) as total_tracked,
      SUM(CASE WHEN i.is_annual = 0 AND i.status = 'wanted'    THEN 1 ELSE 0 END) as wanted_count,
      SUM(CASE WHEN i.is_annual = 0 AND i.status = 'processed' THEN 1 ELSE 0 END) as have_count,
      SUM(CASE WHEN i.is_annual = 0 AND i.status = 'processed' AND i.has_comicinfo = 0 THEN 1 ELSE 0 END) as untagged_count
    FROM monitored_series s
    LEFT JOIN monitored_issues i ON i.series_id = s.id
    LEFT JOIN monitored_series p ON p.id = s.parent_series_id
    LEFT JOIN scanned_series ss ON ss.path = s.directory
    GROUP BY s.id
    ORDER BY s.name
  `).all().filter(s => !linkedAnnualIds.has(s.id));

  // Annual counts — one query for all parents
  const annualTotals = db.prepare(`
    SELECT l.parent_series_id,
      SUM(CASE WHEN i.status != 'skipped' THEN 1 ELSE 0 END) as annual_total,
      SUM(CASE WHEN i.status = 'wanted'    THEN 1 ELSE 0 END) as annual_wanted,
      SUM(CASE WHEN i.status = 'processed' THEN 1 ELSE 0 END) as annual_have,
      SUM(CASE WHEN i.status = 'processed' AND i.has_comicinfo = 0 THEN 1 ELSE 0 END) as annual_untagged
    FROM series_annual_links l
    JOIN monitored_issues i ON i.series_id = l.annual_series_id
    GROUP BY l.parent_series_id
  `).all().reduce((acc, r) => { acc[r.parent_series_id] = r; return acc; }, {});

  // Visible in-series annuals (see visibleInSeriesAnnuals) count toward the totals too.
  const inSeriesBySeries = {};
  for (const r of db.prepare(`SELECT series_id, issue_number, release_date, store_date, status, has_comicinfo
                              FROM monitored_issues WHERE is_annual = 1`).all()) {
    (inSeriesBySeries[r.series_id] ||= []).push(r);
  }
  const linkedIssuesByParent = {};
  for (const r of db.prepare(`SELECT l.parent_series_id, i.issue_number, i.release_date, i.store_date
                              FROM series_annual_links l JOIN monitored_issues i ON i.series_id = l.annual_series_id`).all()) {
    (linkedIssuesByParent[r.parent_series_id] ||= []).push(r);
  }

  const annotated = rows.map(s => {
    const at = annualTotals[s.id] || { annual_total: 0, annual_wanted: 0, annual_have: 0, annual_untagged: 0 };
    const extra = visibleInSeriesAnnuals(inSeriesBySeries[s.id] || [], linkedIssuesByParent[s.id] || []);
    const ex = {
      total:    extra.filter(r => r.status !== 'skipped').length,
      wanted:   extra.filter(r => r.status === 'wanted').length,
      have:     extra.filter(r => r.status === 'processed').length,
      untagged: extra.filter(r => r.status === 'processed' && r.has_comicinfo === 0).length,
    };
    return {
      ...s,
      total_tracked:  (s.total_tracked  || 0) + at.annual_total    + ex.total,
      wanted_count:   (s.wanted_count   || 0) + at.annual_wanted   + ex.wanted,
      have_count:     (s.have_count     || 0) + at.annual_have     + ex.have,
      untagged_count: (s.untagged_count || 0) + at.annual_untagged + ex.untagged,
      has_series_json:   getHasSeriesJson(s.id, s.directory),
      directory_exists:  getDirectoryExists(s.id, s.directory),
      cv_volume_url:     `https://comicvine.gamespot.com/volume/4050-${s.id}/`,
      locg_series_url:   (s.locg_series_id && s.locg_series_slug)
        ? `${LOCG_BASE}/comics/series/${s.locg_series_id}/${s.locg_series_slug}` : null,
    };
  });
  res.json(annotated);
});

app.get('/api/monitor/series/:id/issues', (req, res) => {
  const { id } = req.params;

  // Regular (non-annual) issues from the main series
  const rows = db.prepare(`
    SELECT * FROM monitored_issues WHERE series_id = ? ORDER BY CAST(issue_number AS REAL)
  `).all(id);
  const issues = rows.filter(r => !r.is_annual);

  // Linked annual volumes (standalone CV volumes via series_annual_links)
  const linkedAnnualIds = db.prepare(`
    SELECT annual_series_id FROM series_annual_links WHERE parent_series_id = ?
  `).all(id).map(r => r.annual_series_id);

  // Build annuals list:
  // - If linked volumes exist, use ONLY those — they are the authoritative source.
  //   In-series is_annual=1 rows (set by startup backfill) represent the same real-world
  //   issues and would cause duplicates if mixed in.
  // - If no linked volumes, fall back to in-series is_annual=1 rows (e.g. a series
  //   that mixes annual issues directly into its main CV volume).
  let annuals = [];
  if (linkedAnnualIds.length === 0) {
    annuals = rows.filter(r => r.is_annual);
  } else {
    for (const annualId of linkedAnnualIds) {
      const annualSeries = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(annualId);
      const annualIssues = db.prepare(`
        SELECT * FROM monitored_issues WHERE series_id = ? ORDER BY CAST(issue_number AS REAL)
      `).all(annualId).map(i => ({
        ...i,
        is_annual: 1,
        _annual_series_name: annualSeries?.name || null,
      }));
      annuals = annuals.concat(annualIssues);
    }
    // Keep in-series "annual" rows that don't match a linked annual issue visible.
    const unmatched = visibleInSeriesAnnuals(rows.filter(r => r.is_annual), annuals);
    annuals = annuals.concat(unmatched.map(r => ({ ...r, _in_series_unmatched: true })));
  }

  // Sort annuals by release_date then issue_number
  annuals.sort((a, b) => {
    const da = a.release_date || a.store_date || '9999';
    const db2 = b.release_date || b.store_date || '9999';
    if (da !== db2) return da.localeCompare(db2);
    return (parseFloat(a.issue_number) || 0) - (parseFloat(b.issue_number) || 0);
  });

  // Skipped issues the library already has in ANOTHER folder (era splits,
  // books filed elsewhere), by Comic Vine id: label them "Owned · in <folder>".
  try {
    const dir = db.prepare('SELECT directory FROM monitored_series WHERE id = ?').get(id)?.directory || '';
    const skipped = [...issues, ...annuals].filter(i => i.status === 'skipped');
    if (skipped.length) {
      const ids = JSON.stringify(skipped.map(i => String(i.id)));
      const where = new Map();
      const q = col => db.prepare(`SELECT ${col} AS cv, ss.path, (ss.name || COALESCE(' (' || ss.year || ')', '')) AS folder
        FROM ${col.startsWith('ci.') ? 'book_ci_index ci JOIN scanned_books sb ON sb.id = ci.book_id' : 'scanned_books sb'}
        JOIN scanned_series ss ON ss.id = sb.series_id WHERE ${col} IN (SELECT value FROM json_each(?))`).all(ids);
      for (const r of [...q('sb.cv_issue_id'), ...q('ci.cv_issue_id')]) {
        if (r.path === dir) { where.set(String(r.cv), null); continue; }      // also here: no label
        if (!where.has(String(r.cv))) where.set(String(r.cv), r.folder);
      }
      for (const i of skipped) { const f = where.get(String(i.id)); if (f) i.owned_in = f; }
    }
  } catch (e) { logger.warn('monitor', 'Owned-elsewhere lookup failed', e.message); }

  const pack = activePackFor(id);
  for (const i of issues) annotateWaiting(i, pack);
  for (const i of annuals) annotateWaiting(i, pack);
  // Link only exact indexed files; no archive reads during list browsing.
  const paths = [...new Set([...issues, ...annuals].map(i => i.file_path).filter(Boolean))];
  if (paths.length) {
    const books = db.prepare('SELECT id, path FROM scanned_books WHERE path IN (SELECT value FROM json_each(?))').all(JSON.stringify(paths));
    const byPath = new Map(books.map(book => [book.path, book.id]));
    for (const issue of [...issues, ...annuals]) issue.book_id = byPath.get(issue.file_path) || null;
  }
  res.json({ issues, annuals });
});

// ─── Annual helpers ───────────────────────────────────────────────

/** Fetch CV issues for an annual volume, insert as wanted (is_annual=1), update series row. */
async function fetchAndInsertAnnualIssues(annualCvId, directory) {
  const CV_API_KEY = getCVKey();
  let offset = 0, allIssues = [], total = Infinity;
  while (allIssues.length < total) {
    const r = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
      params: {
        api_key: getCVKey(), format: 'json',
        filter: `volume:${annualCvId}`,
        field_list: 'id,issue_number,name,cover_date,store_date,site_detail_url,description,person_credits,character_credits,team_credits,location_credits',
        offset, limit: 100,
      },
      headers: { 'User-Agent': 'Omnibus/1.0' },
    });
    total = r.data.number_of_total_results || 0;
    const batch = r.data.results || [];
    allIssues = allIssues.concat(batch);
    if (!batch.length) break;
    offset += 100;
    if (allIssues.length < total) await new Promise(r => setTimeout(r, 600));
  }
  const insertIssue = db.prepare(`
    INSERT OR IGNORE INTO monitored_issues
      (id, series_id, issue_number, title, release_date, store_date, cv_data, is_annual)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `);
  db.transaction(issues => {
    for (const i of issues) {
      insertIssue.run(String(i.id), annualCvId, i.issue_number || '0',
        i.name || null, i.cover_date || null, i.store_date || null, JSON.stringify(i));
    }
  })(allIssues);
  db.prepare(`UPDATE monitored_series SET total_issues = ?, last_cv_check = datetime('now') WHERE id = ?`)
    .run(allIssues.length, annualCvId);
  return allIssues.length;
}

/**
 * Auto-discover and link standalone annual volumes for a series.
 * Searches CV for "[Series Name] Annual" (and "[Series Name] '96" for runs in 1995-98),
 * filters to volumes named as annuals (annualNames.js) that share key words with the series name, then
 * auto-links each match.  Fire-and-forget — errors are logged, not thrown.
 */
// Latest year among an annual volume's monitored issues (store date, else cover date).
function annualLastYear(annualId) {
  const r = db.prepare(`SELECT MAX(substr(COALESCE(NULLIF(store_date, ''), release_date), 1, 4)) AS y
    FROM monitored_issues WHERE series_id = ?`).get(String(annualId));
  return parseInt(r?.y, 10) || null;
}
// "Still publishing": an issue dated this year or last (yearly annuals; solicited ones count).
function annualStillPublishing(annualId) {
  const y = annualLastYear(annualId);
  return !!y && y >= new Date().getFullYear() - 1;
}

// Name checks for annual candidates: annualNames.js (moved 2026-11-10; also Marvel's yearly annuals).
const { annualNameFits, yearlyTag, isAnnualName, yearlyAnnualYears } = require('./annualNames');
// One-time: remove the 5 links above (parent id, annual volume id). Files are not touched.
if (!getSetting('annual_links_name_cleanup_2026_10')) {
  try {
    const del = db.prepare('DELETE FROM series_annual_links WHERE parent_series_id = ? AND annual_series_id = ?');
    let n = 0;
    for (const [pid, aid] of [['33615', '104595'], ['158814', '171435'], ['170960', '170792'], ['168718', '160862'], ['171579', '170303']]) n += del.run(pid, aid).changes;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('annual_links_name_cleanup_2026_10', '1');
    if (n) console.log(`[annual-auto] Removed ${n} annual link(s) to series with a different name`);
  } catch (e) { console.warn('annual link cleanup failed:', e.message); }
}

// `alt` (2026-11-10, seriesAnnuals.js): a library series that is not monitored, asked from its
// series page (Manage › Find annuals). It brings the run's details from Comic Vine's issue list
// (parent {year, publisher}, firstDate, lastDate) and its own linking: linkedHere(id), link(c).
// No cooldown and no hand-offs for these; monitored links are never changed by them.
async function autoDiscoverAnnuals(seriesId, seriesName, directory, alt = null) {
  // Skip if Claude recently found no match — 30-day cooldown to avoid burning API calls
  // on series like Supergirl/Venom/Black Cat that repeatedly yield no confident result.
  const cooldownRow = alt ? null : db.prepare('SELECT annual_no_match_until FROM monitored_series WHERE id = ?').get(seriesId);
  if (cooldownRow?.annual_no_match_until && new Date(cooldownRow.annual_no_match_until) > new Date()) {
    logger.debug('annual-auto', `Skipping "${seriesName}" — no-match cooldown until ${cooldownRow.annual_no_match_until}`);
    return;
  }

  // An annual volume never gets annuals of its own: monitoring "Action Comics
  // 2023 Annual" used to link the 2022 and 2021 annual volumes to it.
  if (/\bannual\b/i.test(seriesName || '') || yearlyTag(seriesName)) {
    logger.debug('annual-auto', `Skipping "${seriesName}" — it is an annual volume itself`);
    return;
  }

  const CV_API_KEY = getCVKey();
  const STOPWORDS = new Set(['the','a','an','of','and','or','in','to','for','by']);

  const keyWords = seriesName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));

  // Core words are the most distinctive terms — used for looser matching.
  // For "Uncanny X-Men", core = ["men"] since "x" is too short and "uncanny"
  // may not appear in early-era annual volumes named just "X-Men Annual".
  // We require the candidate to contain at least ONE of the key words
  // AND the word "annual", rather than ALL keywords.
  // Claude does the final validation to reject false matches.
  const coreWords = keyWords.filter(w => w.length >= 3);

  if (!coreWords.length) return;

  const parentSeries = alt ? alt.parent : db.prepare('SELECT year, publisher FROM monitored_series WHERE id = ?').get(seriesId);

  // Derive end year from the latest known issue date for this series. Point issues (#258.1) are
  // left out: Comic Vine files retro issues like Iron Man #258.1–258.4 (2013) in the 1968 volume,
  // which made the run look like it ended in 2013 and let the 2014 annual in (2026-10-21).
  const lastIssueRow = alt ? { last_date: alt.lastDate || null } : db.prepare(
    "SELECT MAX(COALESCE(NULLIF(store_date, ''), release_date)) as last_date FROM monitored_issues WHERE series_id = ? AND is_annual = 0 AND issue_number NOT LIKE '%.%'"
  ).get(seriesId);
  const firstIssueRow = alt ? { first_date: alt.firstDate || null } : db.prepare(
    "SELECT MIN(COALESCE(NULLIF(store_date, ''), release_date)) as first_date FROM monitored_issues WHERE series_id = ? AND is_annual = 0 AND issue_number NOT LIKE '%.%'"
  ).get(seriesId);
  const runFirstDate = firstIssueRow?.first_date ? String(firstIssueRow.first_date).slice(0, 10) : null;
  const runLastDate = lastIssueRow?.last_date ? String(lastIssueRow.last_date).slice(0, 10) : null;
  const parentEndYear = lastIssueRow?.last_date
    ? parseInt(lastIssueRow.last_date.slice(0, 4), 10) || null
    : null;

  try {
    const r = await cvApiGet('https://comicvine.gamespot.com/api/search', {
      params: {
        api_key: getCVKey(), format: 'json',
        query: `${seriesName} Annual`,
        resources: 'volume',
        limit: 25,
        field_list: 'id,name,start_year,publisher,count_of_issues,image,site_detail_url,description',
      },
      headers: { 'User-Agent': 'Omnibus/1.0' },
      timeout: 10000,
    });

    const results = (r.data.results || []).slice();
    // Marvel's 1995–98 annuals are named for the year ("Sensational Spider-Man '96") and the
    // "… Annual" search does not return them: one more search for each such year the run covers.
    const runFromYear = parseInt(String(runFirstDate || '').slice(0, 4), 10) || parseInt(parentSeries?.year, 10) || null;
    for (const y of yearlyAnnualYears(runFromYear, parentEndYear || new Date().getFullYear())) {
      try {
        const yr = await cvApiGet('https://comicvine.gamespot.com/api/search', {
          params: { api_key: getCVKey(), format: 'json', query: `${seriesName} '${String(y).slice(2)}`, resources: 'volume', limit: 10,
            field_list: 'id,name,start_year,publisher,count_of_issues,image,site_detail_url,description' },
          headers: { 'User-Agent': 'Omnibus/1.0' }, timeout: 10000,
        });
        const seen = new Set(results.map(x => String(x.id)));
        const found = (yr.data?.results || []).filter(x => yearlyTag(x.name) && !seen.has(String(x.id)));
        results.push(...found);
        logger.info('annual-auto', `Yearly annual search '${String(y).slice(2)} for "${seriesName}": ${found.length ? found.map(x => `${x.name} (${x.id})`).join(', ') : 'none'}`);
      } catch (e) { logger.warn('annual-auto', `Yearly annual search ${y} failed for "${seriesName}"`, e.message); }
    }

    const candidates = results.filter(c => {
      const cNameLower = (c.name || '').toLowerCase();
      if (!isAnnualName(c.name)) return false;
      // Use OR logic — require at least one core word to match.
      // "ALL words must match" is too strict: "Uncanny X-Men" searching for
      // "X-Men Annual" (the pre-1981 era volume) would fail because "uncanny"
      // isn't in the name. Claude does the precise era validation.
      return coreWords.some(w => cNameLower.includes(w));
    }).filter(c => {
      if (annualNameFits(c.name, seriesName)) return true;
      logger.debug('annual-auto', `"${c.name}" (${c.id}) is named for another series; not a candidate for "${seriesName}"`);
      return false;
    });

    logger.info('annual-auto', `CV search: ${results.length} results, ${candidates.length} passed filter for "${seriesName}"`, {
      coreWords,
      passed: candidates.map(c => `${c.name} (${c.id}, ${c.start_year})`),
    });

    // Era check in code (not only Claude): the annual volume must start inside
    // this run. Start = the year the run's first issue came out (earliest store or
    // cover date) — not the volume's start year minus one, which let 2023 X-Men
    // annuals attach to X-Men (2024). End gets one year of slack (an annual can
    // follow a run's last issue). Unknown years pass through.
    const firstRow = alt ? { s: alt.firstDate ? String(alt.firstDate).slice(0, 4) : null, r: null } : db.prepare(`SELECT MIN(substr(store_date, 1, 4)) AS s, MIN(substr(release_date, 1, 4)) AS r
      FROM monitored_issues WHERE series_id = ? AND is_annual = 0 AND issue_number NOT LIKE '%.%'`).get(seriesId) || {};
    const firstYears = [firstRow.s, firstRow.r].map(v => parseInt(v, 10)).filter(Boolean);
    const runStart = firstYears.length ? Math.min(...firstYears)
      : ((parseInt(parentSeries?.year, 10) || 0) ? parseInt(parentSeries.year, 10) - 1 : null);
    const runEnd = parentEndYear || new Date().getFullYear();
    // A volume we already monitor is judged on its whole span (start to latest
    // issue; still publishing = open-ended), so a long-running annual volume can
    // be handed to the next run. A volume not monitored yet is judged on its start.
    const inEra = c => {
      const y = parseInt(c.start_year, 10);
      if (!y || !runStart) return true;
      const id = String(c.id);
      const last = annualLastYear(id);
      const hi = annualStillPublishing(id) ? Math.max(last, new Date().getFullYear() + 1) : Math.max(y, last || 0);
      return hi >= runStart && y <= runEnd + 1;
    };
    const outOfEra = candidates.filter(c => !inEra(c));
    if (outOfEra.length) {
      logger.info('annual-auto', `Dropped ${outOfEra.length} candidate(s) outside the run ${runStart}-${runEnd}`,
        { dropped: outOfEra.map(c => `${c.name} (${c.id}, ${c.start_year})`) });
    }

    // Separate already-linked from new candidates; never auto-link a volume
    // that already belongs to another series (link it by hand if it really is shared).
    const linkedHere = c => (alt ? alt.linkedHere(String(c.id))
      : !!db.prepare('SELECT 1 FROM series_annual_links WHERE parent_series_id = ? AND annual_series_id = ?').get(seriesId, String(c.id)));
    const newCandidates = candidates.filter(inEra).filter(c => {
      if (linkedHere(c)) return false;
      const others = db.prepare(`SELECT l.parent_series_id AS id, p.name, p.year, p.series_status AS st
        FROM series_annual_links l LEFT JOIN monitored_series p ON p.id = l.parent_series_id
        WHERE l.annual_series_id = ? AND l.parent_series_id != ?`).all(String(c.id), seriesId);
      if (others.length) {
        // Hand-off: a volume that outlived its run (every parent ended) and is
        // still publishing may move to this run, if Claude agrees below.
        if (!alt && others.every(o => o.st === 'ended') && annualStillPublishing(String(c.id))) {
          c._handoffFrom = others;
          c._lastYear = annualLastYear(String(c.id));
          logger.info('annual-auto', `Hand-off candidate: ${c.name} (${c.id}) — previous run(s) ended: ${others.map(o => `${o.name} (${o.year || '?'})`).join(', ')}`);
          return true;
        }
        const o = others[0];
        logger.info('annual-auto', `Skipping ${c.name} (${c.id}) — already linked to ${o.name || 'series'} (${o.id})` + (o.st === 'ended' ? ' (ended; volume no longer publishing)' : ''));
        return false;
      }
      return true;
    });

    // Month check at the run's edges (2026-10-21): an annual volume that starts in the run's first
    // year, or at/after its last year, is checked by its first issue's date. Avengers Annual (2012)
    // came out in early 2012, before Avengers (2012) began that December; it belongs to the run before.
    // One Comic Vine lookup per edge candidate; not for volumes already monitored (hand-offs).
    const dayDiff = (a, b) => (Date.parse(a) - Date.parse(b)) / 864e5;
    for (const c of [...newCandidates]) {
      const y = parseInt(c.start_year, 10);
      if (c._handoffFrom || !y || !runStart || !(y === runStart || y >= runEnd)) continue;
      try {
        const ir = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
          params: { api_key: getCVKey(), format: 'json', filter: `volume:${c.id}`, sort: 'cover_date:asc', limit: 1, field_list: 'issue_number,cover_date,store_date' },
          headers: { 'User-Agent': 'Omnibus/1.0' }, timeout: 10000,
        });
        const first = (ir.data?.results || [])[0];
        const d = first && String(first.store_date || first.cover_date || '').slice(0, 10);
        if (!d || !/^\d{4}-\d{2}/.test(d)) continue;
        c._firstDate = d;
        const before = runFirstDate && dayDiff(runFirstDate, d) > 75;            // came out well before this run began (cover dates run ~2 months after store dates)
        const after = runLastDate && parentEndYear && parentEndYear < new Date().getFullYear() - 1 && dayDiff(d, runLastDate) > 300;   // long after an ended run
        if (before || after) {
          newCandidates.splice(newCandidates.indexOf(c), 1);
          logger.info('annual-auto', `Dropped ${c.name} (${c.id}): first issue ${d} is ${before ? `before this run began (${runFirstDate})` : `long after this run ended (${runLastDate})`}`);
        }
      } catch (e) { logger.debug?.('annual-auto', `First-issue date lookup failed for ${c.name} (${c.id})`, e.message); }
    }

    if (!newCandidates.length) {
      const own = candidates.filter(inEra).filter(linkedHere);
      logger.info('annual-auto', `No new candidates for "${seriesName}"` + (own.length ? ` — already linked here: ${own.map(c => `${c.name} (${c.id})`).join(', ')}` : ''));
      return;
    }

    // ── Validation via Claude ─────────────────────────────────────
    // Always ask Claude to validate candidates — even a single candidate can be wrong
    // (e.g. a 1995 annual matched to a series that ended in 1989).
    // Claude has context on publisher, era, and series run to make the right call.
    logger.info('annual-auto', `${newCandidates.length} candidate(s) for "${seriesName}" — asking Claude to validate`);
    const chosen = await askClaudeForAnnualMatch(seriesId, seriesName, parentSeries, newCandidates, parentEndYear, { firstDate: runFirstDate, lastDate: runLastDate });
    if (chosen === null) {
      logger.info('annual-auto', `Validation unavailable for "${seriesName}" — nothing linked, no cooldown set`);
      return;
    }
    const toLink = [];
    if (chosen && chosen.length > 0) {
      toLink.push(...chosen);
      logger.info('annual-auto', `Claude validated ${chosen.length} volume(s): ${chosen.map(c => `"${c.name}" (${c.id})`).join(', ')}`);
    } else {
      logger.info('annual-auto', `Claude rejected all candidates for "${seriesName}" annuals`);
      // 14-day cooldown so we don't keep burning API calls on this series, while a
      // newly solicited annual is still picked up within two weekly runs.
      if (alt) return;
      const until = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare("UPDATE monitored_series SET annual_no_match_until = ? WHERE id = ?").run(until, seriesId);
      return;
    }

    // ── Link each selected candidate ──────────────────────────────
    for (const c of toLink) {
      const annualId = String(c.id);
      if (alt) { alt.link(c); logger.info('annual-auto', `Linked for the series page: ${c.name} (${annualId}) → ${seriesName}`); continue; }

      if (c._handoffFrom?.length) {
        // Move the whole volume to this run: new downloads land in this folder;
        // owned files stay where they are (their Comic Vine identity is unchanged).
        db.transaction(() => {
          for (const o of c._handoffFrom) {
            db.prepare('DELETE FROM series_annual_links WHERE parent_series_id = ? AND annual_series_id = ?').run(o.id, annualId);
          }
          db.prepare('UPDATE monitored_series SET directory = ? WHERE id = ?').run(directory, annualId);
        })();
        logger.info('annual-auto', `Handed off ${c.name} (${annualId}) from ${c._handoffFrom.map(o => `${o.name} (${o.id})`).join(', ')} to ${seriesName} (${seriesId})`, { directory });
      }

      const existing = db.prepare('SELECT id FROM monitored_series WHERE id = ?').get(annualId);
      if (!existing) {
        db.prepare(`
          INSERT OR IGNORE INTO monitored_series
            (id, name, publisher, year, total_issues, image_url, cv_url, directory, last_cv_check)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(annualId, c.name, c.publisher?.name || null, c.start_year || null,
               c.count_of_issues || 0, c.image?.medium_url || null,
               c.site_detail_url || null, directory);
      }

      try {
        await new Promise(res => setTimeout(res, 700));
        const count = await fetchAndInsertAnnualIssues(annualId, directory);
        logger.info('annual-auto', `${c.name}: ${count} issues fetched`);
      } catch (e) {
        logger.warn('annual-auto', `Issue fetch failed for ${c.name}`, e.message);
      }

      db.prepare(`INSERT OR IGNORE INTO series_annual_links (parent_series_id, annual_series_id) VALUES (?, ?)`)
        .run(seriesId, annualId);
      logger.info('annual-auto', `Auto-linked: ${c.name} → ${seriesName} (${seriesId})`);
      // Clear no-match cooldown — a link was found, future checks remain valid
      db.prepare("UPDATE monitored_series SET annual_no_match_until = NULL WHERE id = ?").run(seriesId);
      // Immediately scan directory so any existing annual files get matched without
      // requiring a manual Refresh button press
      try {
        await runRefreshDirectory(seriesId);
        logger.info('annual-auto', `Directory refresh triggered for "${seriesName}" after annual link`);
      } catch (e) {
        logger.warn('annual-auto', `Post-link directory refresh failed for "${seriesName}"`, e.message);
      }
    }
  } catch (e) {
    logger.warn('annual-auto', `Auto-discover failed for "${seriesName}"`, e.message);
  }
}

/**
 * Ask Claude to pick the correct annual volume from a list of candidates.
 * Returns the matching candidate object, or null if no confident match.
 * Only called when there are 2+ candidates — single candidates bypass this entirely.
 */
async function askClaudeForAnnualMatch(seriesId, seriesName, parentSeries, candidates, parentEndYear = null, runDates = {}) {
  // Any provider's model may run this task (Settings → AI Models → Annual Validator); a missing key
  // fails the call below, which returns null (nothing linked, no cooldown).

  const parentYear = parentSeries?.year || 'unknown';
  const parentPublisher = parentSeries?.publisher || 'unknown';

  const candidateList = candidates.map(c => ({
    id: String(c.id),
    name: c.name,
    start_year: c.start_year || 'unknown',
    publisher: c.publisher?.name || 'unknown',
    issue_count: c.count_of_issues || 0,
    description: (c.description || '').replace(/<[^>]*>/g, '').slice(0, 300),
    ...(c._firstDate ? { first_issue_date: c._firstDate } : {}),
    ...(c._handoffFrom ? {
      latest_issue_year: c._lastYear || 'unknown',
      note: `Still publishing. It was linked to ${c._handoffFrom.map(o => `"${o.name}" (${o.year || '?'})`).join(', ')}, which has ended. Match it only if this parent series is the continuation/relaunch of that title, so the volume's newer annuals belong to this run.`,
    } : {}),
  }));

  const endYearLine = parentEndYear
    ? `- End year: approximately ${parentEndYear} (derived from last known issue)`
    : `- End year: unknown (may still be ongoing)`;
  const datesLine = runDates.firstDate || runDates.lastDate
    ? `\n- First regular issue: ${runDates.firstDate || 'unknown'}; latest regular issue: ${runDates.lastDate || 'unknown'}`
    : '';

  const prompt = `You are a comic book expert validating which annual companion volumes belong to a specific comic series run on Comic Vine.

Parent series:
- Name: "${seriesName}"
- Publisher: ${parentPublisher}
- Start year: ${parentYear}
${endYearLine}${datesLine}

Candidate annual volume(s) from Comic Vine:
${JSON.stringify(candidateList, null, 2)}

Task: Determine which candidates (if any) are genuine annual companions to THIS SPECIFIC run of the series. A series may have multiple legitimate annual volumes covering different eras (e.g. one volume for 1970-1980 annuals and another for 1981-2011 annuals). Apply these rules:
1. Publisher must match (or be a very close imprint match e.g. Marvel/Marvel Comics).
2. The annual volume's era must overlap with this parent series' run. Use start_year and issue_count to estimate the annual volume's coverage era.
3. CRITICAL for split series: Comic Vine sometimes splits a long-running series into multiple volumes at a specific issue number. If this parent series has a start_year that is NOT the original series launch year (e.g. "Uncanny X-Men" starting in 1981 when the original X-Men launched in 1963), link ONLY annual volumes whose era falls within this specific volume's run — NOT annual volumes that belong to the earlier split-off volume.
4. A single series run may legitimately have multiple annual volumes (e.g. original run annuals + a later restarted annual series). Return all that match.
5. If a candidate fails any rule, exclude it even if it is the only candidate.
6. A candidate with a "note" is a long-running annual volume whose earlier run has ended. Judge its era by latest_issue_year (not start_year), and match it only if this parent series is the relaunch of the same title (a relaunch may change its name, e.g. "New Titans" after "Titans") AND the volume's newest annual came out during this parent's run (compare latest_issue_year with this run's first regular issue). A volume whose newest annual came out before this run began still belongs to the earlier run: do not match it.
7. When first_issue_date is given, the annual belongs to the run whose regular issues were coming out at that date: one that came out before this run's first regular issue belongs to the earlier run.
8. Marvel's 1995-1998 annuals are one-issue volumes named for the year without the word "Annual" (e.g. "Uncanny X-Men '96"); in 1998 most paired two titles (e.g. "Uncanny X-Men / Fantastic Four '98") and belong to the first-named title. Treat these as annuals of the series with exactly that name.

Respond with ONLY a JSON object, no explanation, no markdown:
{"matched_ids": ["<cv_volume_id>", "<cv_volume_id>"]}

If no candidates match, respond with:
{"matched_ids": []}`;

  try {
    // Room for models that reason before answering; 200 left them with no text on harder cases.
    var annualJob = ai.newJobId();
    const { data: responseData, text } = await ai.complete({ task: 'annual_validator', prompt, maxTokens: 2048, timeout: 30000, jobId: annualJob });
    const response = { data: responseData };

    const stripped = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start === -1 || end === -1) {
      const blocks = (response.data.content || []).map(b => b.type).join(',') || 'none';
      throw new Error(`No JSON in response (stop_reason ${response.data.stop_reason}, blocks ${blocks}, model ${response.data.model}): ${stripped.slice(0, 200)}`);
    }

    const parsed = JSON.parse(stripped.slice(start, end + 1));

    // Support both old matched_id (single) and new matched_ids (array) for safety
    let matchedIds = [];
    if (Array.isArray(parsed.matched_ids)) {
      matchedIds = parsed.matched_ids.filter(Boolean).map(String);
    } else if (parsed.matched_id) {
      matchedIds = [String(parsed.matched_id)];
    }

    if (!matchedIds.length) { setAiJobOutcome(annualJob, 'no_match'); return []; }

    const matches = matchedIds
      .map(id => candidates.find(c => String(c.id) === id))
      .filter(Boolean);

    if (matches.length < matchedIds.length) {
      logger.warn('annual-auto', `Claude returned ${matchedIds.length} IDs but only ${matches.length} found in candidate list`);
    }

    setAiJobOutcome(annualJob, 'matched', `${matches.length} volume${matches.length === 1 ? '' : 's'}`);
    return matches;
  } catch (e) {
    setAiJobOutcome(typeof annualJob !== 'undefined' ? annualJob : null, /JSON/i.test(e.message) ? 'bad_json' : 'error', e.message);
    // An API/parse failure is not an answer: null tells the caller not to set
    // the 30-day no-match cooldown (failures used to pause discovery for a month).
    logger.warn('annual-auto', `Claude disambiguation failed: ${e.message}`);
    return null;
  }
}

// ─── Annual linking endpoints ─────────────────────────────────────

// Link a standalone annual CV volume to a parent series (manual override endpoint).
// Manual link (Download Manager ⋯ › Link annual volume…, 2026-11-10): the body may carry only a
// Comic Vine volume link or id (annualCvId or url); the volume's details are then looked up.
app.post('/api/monitor/series/:id/link-annual', requireAdmin, async (req, res) => {
  const { id } = req.params;
  let { annualCvId, annualName, annualPublisher, annualYear, annualTotalIssues, annualImageUrl, annualCvUrl, annualDirectory } = req.body || {};
  const given = String(annualCvId || req.body?.url || '').trim();
  annualCvId = (given.match(/4050-(\d+)/) || given.match(/^(\d+)$/) || [])[1] || null;
  if (!annualCvId) return res.status(400).json({ error: 'Paste a Comic Vine volume link (…/4050-12345/) or its number' });

  const parent = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(id);
  if (!parent) return res.status(404).json({ error: 'Parent series not found' });
  if (String(annualCvId) === String(id)) return res.status(400).json({ error: 'That is this series itself' });
  if (!annualName && !db.prepare('SELECT 1 FROM monitored_series WHERE id = ?').get(annualCvId)) {
    try {
      const r = await cvApiGet(`https://comicvine.gamespot.com/api/volume/4050-${annualCvId}/`, {
        params: { api_key: getCVKey(), format: 'json', field_list: 'id,name,start_year,publisher,count_of_issues,image,site_detail_url' },
        headers: { 'User-Agent': 'Omnibus/1.0' }, timeout: 10000 });
      const v = r.data?.results;
      if (!v?.id) return res.status(404).json({ error: `Comic Vine has no volume ${annualCvId}` });
      annualName = v.name; annualPublisher = v.publisher?.name || null; annualYear = v.start_year || null;
      annualTotalIssues = v.count_of_issues || 0; annualImageUrl = v.image?.medium_url || null; annualCvUrl = v.site_detail_url || null;
    } catch (e) { return res.status(502).json({ error: `Comic Vine lookup failed: ${e.message}` }); }
  }

  const annualDir = annualDirectory || parent.directory;
  const existing = db.prepare('SELECT id FROM monitored_series WHERE id = ?').get(annualCvId);
  if (!existing) {
    db.prepare(`
      INSERT OR IGNORE INTO monitored_series
        (id, name, publisher, year, total_issues, image_url, cv_url, directory, last_cv_check)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(annualCvId, annualName || annualCvId, annualPublisher || null,
           annualYear || null, annualTotalIssues || 0,
           annualImageUrl || null, annualCvUrl || null, annualDir);
    try {
      await fetchAndInsertAnnualIssues(annualCvId, annualDir);
    } catch (e) {
      logger.error('annual-link', `CV fetch failed for annual ${annualCvId}`, e.message);
    }
  }

  try {
    db.prepare(`INSERT OR IGNORE INTO series_annual_links (parent_series_id, annual_series_id) VALUES (?, ?)`)
      .run(id, annualCvId);
    logger.info('annual-link', `Manually linked annual ${annualCvId} → parent ${id}`);
    const linked = db.prepare('SELECT id, name, year FROM monitored_series WHERE id = ?').get(annualCvId);
    res.json({ success: true, annual: linked || { id: annualCvId } });
    // Match annual files already in the folder (as the finder does after a link).
    setImmediate(() => runRefreshDirectory(id).catch(e => logger.warn('annual-link', 'Directory refresh after link failed', e.message)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Remove an annual link
app.delete('/api/monitor/series/:id/link-annual/:annualId', requireAdmin, (req, res) => {
  db.prepare(`
    DELETE FROM series_annual_links WHERE parent_series_id = ? AND annual_series_id = ?
  `).run(req.params.id, req.params.annualId);
  res.json({ success: true });
});

// List linked annuals for a series (for UI display)
app.get('/api/monitor/series/:id/linked-annuals', (req, res) => {
  const links = db.prepare(`
    SELECT s.* FROM monitored_series s
    JOIN series_annual_links l ON l.annual_series_id = s.id
    WHERE l.parent_series_id = ?
  `).all(req.params.id);
  res.json(links);
});

// ─── Special Series ──────────────────────────────────────────────────────────
//
// A "special" series is a limited series, one-shot, or tie-in whose files live
// in a parent series' directory and are marked is_special=1 in scanned_books.
// This makes them surface in the parent's SeriesDetail Specials tab.
//
// Three entry points all converge on the same server-side merge operation:
//   1. Add Series modal  — parentScannedSeriesId passed at add time (no folder created)
//   2. Download Manager  — POST /api/specials/merge from series card button
//   3. SeriesDetail page — POST /api/specials/merge from series detail button
//
// The merge operation:
//   - Moves comic files from source scanned_series.path → parent scanned_series.path
//   - Deletes series.json and other metadata from source folder
//   - Deletes empty source folder
//   - Deletes source scanned_series + scanned_books rows
//   - If source is monitored: updates directory + file_paths, sets parent_series_id
//   - Triggers rescan of parent directory
//   - After rescan: marks moved files is_special=1

// GET /api/specials/scanned-series — all scanned series for parent picker
// Returns both monitored and unmonitored series so any can be a parent.
app.get('/api/specials/scanned-series', requireAuth, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  let rows = db.prepare(`
    SELECT ss.id, ss.name, ss.year, ss.path,
           (SELECT ms.id FROM monitored_series ms WHERE ms.directory = ss.path
            AND ms.parent_series_id IS NULL LIMIT 1) as monitored_id
    FROM scanned_series ss
    ORDER BY ss.name ASC
  `).all();
  if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q));
  res.json(rows.slice(0, 50));
});

// POST /api/specials/merge — move a series' files into a parent series directory
// Works for both monitored and unmonitored source series.
// Body: { sourceScannedSeriesId, parentScannedSeriesId }
app.post('/api/specials/merge', requireAdmin, async (req, res) => {
  const { sourceScannedSeriesId, parentScannedSeriesId } = req.body;
  if (!sourceScannedSeriesId || !parentScannedSeriesId)
    return res.status(400).json({ error: 'sourceScannedSeriesId and parentScannedSeriesId required' });
  if (sourceScannedSeriesId === parentScannedSeriesId)
    return res.status(400).json({ error: 'Source and parent cannot be the same series' });

  const source = db.prepare('SELECT * FROM scanned_series WHERE id = ?').get(sourceScannedSeriesId);
  const parent = db.prepare('SELECT * FROM scanned_series WHERE id = ?').get(parentScannedSeriesId);
  if (!source) return res.status(404).json({ error: 'Source series not found in library — the series may not have any files on disk yet. Download some issues first, then try again.' });
  if (!parent) return res.status(404).json({ error: 'Parent series not found' });

  const sourceDir = source.path;
  const destDir   = parent.path;

  if (!fs.existsSync(sourceDir)) return res.status(400).json({ error: `Source directory not found: ${sourceDir}` });
  if (!fs.existsSync(destDir))   return res.status(400).json({ error: `Parent directory not found: ${destDir}` });

  const COMIC_EXTS  = new Set(['.cbz', '.cbr', '.cb7', '.cbt', '.pdf']);
  const META_FILES  = new Set(['series.json', 'series.json.bak', 'cvinfo']);

  try {
    // 1. Collect all files in source directory
    const allFiles = fs.readdirSync(sourceDir);
    const comicFiles = allFiles.filter(f => COMIC_EXTS.has(path.extname(f).toLowerCase()));
    const movedFiles = [];

    // 2. Move comic files to parent directory
    for (const filename of comicFiles) {
      const src  = path.join(sourceDir, filename);
      const dest = path.join(destDir, filename);
      // Don't overwrite existing files in parent
      if (fs.existsSync(dest)) {
        logger.warn('specials', `Skipping — file already exists in parent`, { filename });
        continue;
      }
      fs.renameSync(src, dest);
      movedFiles.push({ filename, dest });
      logger.info('specials', `Moved file to parent`, { filename, destDir });
    }

    // 3. Delete metadata files
    for (const filename of allFiles) {
      if (META_FILES.has(filename.toLowerCase())) {
        try { fs.unlinkSync(path.join(sourceDir, filename)); } catch {}
      }
    }

    // 4. Delete source directory (only if now empty)
    const remaining = fs.readdirSync(sourceDir).filter(f => !f.startsWith('.'));
    if (remaining.length === 0) {
      try { fs.rmdirSync(sourceDir); } catch {}
    } else {
      logger.warn('specials', `Source directory not empty after merge — leaving in place`, { sourceDir, remaining });
    }

    // 5. DB cleanup. Moved books keep their IDs (and every link): re-point them
    // at the parent series and new path. Whatever is left of the source (the
    // series row, books skipped as duplicates) is kept as missing, not deleted.
    db.transaction(() => {
      const repoint = db.prepare('UPDATE scanned_books SET path = ?, series_id = ? WHERE series_id = ? AND path = ?');
      for (const { filename, dest } of movedFiles) {
        repoint.run(dest, parent.id, sourceScannedSeriesId, path.join(sourceDir, filename));
      }
    })();
    stableIds.tombstoneSeries(sourceScannedSeriesId);
    logger.info('specials', `Kept book IDs through merge`, { moved: movedFiles.length, source: sourceDir });

    // 6. If source is a monitored series, update it to point to parent directory
    const monSource = db.prepare('SELECT * FROM monitored_series WHERE directory = ?').get(sourceDir);
    const monParent = db.prepare('SELECT * FROM monitored_series WHERE directory = ?').get(destDir);
    if (monSource) {
      // is_special=1 always — this is a merge-to-special operation by intent,
      // even when monParent isn't a monitored row (so parent_series_id stays null).
      db.prepare('UPDATE monitored_series SET directory = ?, parent_series_id = ?, is_special = 1 WHERE id = ?')
        .run(destDir, monParent?.id || null, monSource.id);
      // Update file_path on all processed issues to reflect new location
      const processedIssues = db.prepare(
        `SELECT id, file_path FROM monitored_issues WHERE series_id = ? AND status = 'processed' AND file_path IS NOT NULL`
      ).all(monSource.id);
      for (const issue of processedIssues) {
        const newPath = path.join(destDir, path.basename(issue.file_path));
        db.prepare('UPDATE monitored_issues SET file_path = ? WHERE id = ?').run(newPath, issue.id);
      }
      invalidateDirectoryExistsCache(monSource.id);
      logger.info('specials', `Updated monitored series directory`, { series: monSource.name, newDir: destDir });
    }

    // 7. Reset parent scanned_series dir_mtime so the scanner always re-reads it,
    // bypassing the mtime optimisation that would otherwise skip unchanged directories.
    // This is critical for Windows/Docker mounts where the directory mtime may not
    // update when files are moved in from another location.
    db.prepare('UPDATE scanned_series SET dir_mtime = 0 WHERE path = ?').run(destDir);

    // Trigger rescan of parent library so new files get scanned_books rows
    const parentLib = db.prepare("SELECT * FROM libraries WHERE ? LIKE (path || '%')").get(destDir);
    if (parentLib) {
      setImmediate(async () => {
        try {
          await runLibraryScan(parentLib, 'postprocess');
          // 8. After rescan, mark the moved files as is_special=1
          for (const { filename } of movedFiles) {
            const destPath = path.join(destDir, filename);
            db.prepare(`
              UPDATE scanned_books SET is_special = 1
              WHERE series_id = ? AND path = ? AND is_special = 0
            `).run(parent.id, destPath);
          }
          // Mark by path — works regardless of series_id or when the book was scanned.
          // This also catches files that were already on disk before this merge ran
          // (e.g. from a previous partial merge or manual file move).
          const movedPaths = movedFiles.map(({ filename }) => path.join(destDir, filename));
          for (const destPath of movedPaths) {
            db.prepare(`UPDATE scanned_books SET is_special = 1 WHERE path = ? AND is_special = 0`).run(destPath);
          }
          logger.info('specials', `Marked ${movedFiles.length} files as is_special after rescan`);
          pushSseEvent({ type: 'series_updated' });
        } catch (e) {
          logger.warn('specials', 'Post-merge rescan failed', e.message);
        }
      });
    }

    res.json({
      ok: true,
      moved: movedFiles.length,
      sourceDir,
      destDir,
      monitoredUpdated: !!monSource,
    });
  } catch (e) {
    logger.error('specials', 'Merge failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Known manga publishers — used to auto-detect series_type on monitor add.
// Dark Horse excluded (too many western comics). Tokyopop included (overwhelmingly manga).
const MANGA_PUBLISHERS = new Set([
  'viz media', 'viz', 'kodansha', 'kodansha comics', 'yen press',
  'seven seas entertainment', 'seven seas', 'shueisha', 'shogakukan',
  'tokyopop', 'j-novel club', 'vertical', 'udon entertainment',
]);

function detectSeriesType(publisher) {
  if (!publisher) return 'comic';
  return MANGA_PUBLISHERS.has(publisher.toLowerCase().trim()) ? 'manga' : 'comic';
}

app.post('/api/monitor/series', requireDownloadAccess, async (req, res) => {
  const { id, name, publisher, year, total_issues, image_url, cv_url, parentDir, parentScannedSeriesId, source_name } = req.body;
  if (!id || !name || !parentDir) return res.status(400).json({ error: 'id, name, parentDir required' });
  if (typeof name !== 'string' || typeof parentDir !== 'string' || (publisher != null && typeof publisher !== 'string')) return res.status(400).json({ error: 'Invalid name, publisher or parent directory' });

  const COMICS_ROOT = process.env.COMICS_PATH || '/comics';
  let directory;
  let parentMonitoredId = null;

  if (parentScannedSeriesId) {
    // Special series — use the parent scanned series' directory directly, no new folder created
    const parentScanned = db.prepare('SELECT * FROM scanned_series WHERE id = ?').get(String(parentScannedSeriesId));
    if (!parentScanned) return res.status(404).json({ error: 'Parent series not found' });
    directory = parentScanned.path;
    const parentMon = db.prepare('SELECT id FROM monitored_series WHERE directory = ?').get(directory);
    parentMonitoredId = parentMon?.id || null;
    logger.info('monitor', `Adding special series "${name}" — using parent directory`, { directory, parentMonitoredId });
  } else {
    // Normal series — create a new folder
    let resolvedParentDir = parentDir;
    if (path.resolve(parentDir) === path.resolve(COMICS_ROOT) && publisher) {
      const safePublisher = publisher.replace(/[/\\:*?"<>|]/g, '').trim();
      resolvedParentDir = path.join(COMICS_ROOT, safePublisher);
    }
    const folderName = `${name} (${year || 'Unknown'})`.replace(/[/\\:*?"<>|]/g, '');
    directory = path.join(resolvedParentDir, folderName);
    try {
      directory = require('./pathSecurity').resolveCreatableWithinRoot(COMICS_ROOT, directory);
      if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not create directory' });
    }
  }

  // Insert series. is_special is set when the user added this via the
  // "Special of …" picker — i.e. they provided parentScannedSeriesId.
  // We record this independently of parent_series_id so the prefix-strict
  // matcher fires even when the scanned parent isn't itself monitored.
  const isSpecial = parentScannedSeriesId ? 1 : 0;
  try {
    const seriesType = detectSeriesType(publisher);
    db.prepare(`
      INSERT OR REPLACE INTO monitored_series (id, name, publisher, year, total_issues, image_url, cv_url, directory, series_type, parent_series_id, is_special, source_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, publisher, year, total_issues || 0, image_url, cv_url, directory, seriesType, parentMonitoredId, isSpecial, source_name || null);
    if (seriesType === 'manga') logger.info('monitor', `Auto-detected manga series: "${name}" (publisher: ${publisher})`);
    if (isSpecial) logger.info('monitor', `Adding "${name}" as a SPECIAL`, { directory, parentMonitoredId, parentScannedSeriesId });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // Fetch all issues from CV and insert as wanted
  try {
    const CV_API_KEY = getCVKey();
    let offset = 0;
    let allIssues = [];
    while (true) {
      const r = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
        params: {
          api_key: getCVKey(), format: 'json',
          filter: `volume:${id}`,
          field_list: 'id,issue_number,name,cover_date,store_date,site_detail_url,description,person_credits,character_credits,team_credits,location_credits',
          offset, limit: 100,
        },
        headers: { 'User-Agent': 'Omnibus/1.0' },
      });
      const results = r.data.results || [];
      allIssues = allIssues.concat(results);
      if (allIssues.length >= r.data.number_of_total_results) break;
      offset += 100;
      await new Promise(resolve => setTimeout(resolve, 500)); // CV rate limit
    }

    const insertIssue = db.prepare(`
      INSERT OR IGNORE INTO monitored_issues (id, series_id, issue_number, title, release_date, store_date, cv_data, is_annual)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const isAnnual = (num, name) => {
      const s = ((num || '') + ' ' + (name || '')).toLowerCase();
      return s.includes('annual') ? 1 : 0;
    };
    const insertMany = db.transaction(issues => {
      for (const i of issues) {
        // Canonicalise CV's raw "8AU" → "8.AU" so all SQL `=` matches
        // (scanner, manga-pp, etc.) compare apples to apples without
        // each call site having to normalise.
        const canonNum = IN.normIssueNumber(i.issue_number) || '0';
        insertIssue.run(
          String(i.id), id, canonNum,
          i.name || null,
          i.cover_date || null,
          i.store_date || null,
          JSON.stringify(i),
          isAnnual(i.issue_number, i.name)
        );
      }
    });
    insertMany(allIssues);

    // Update total_issues count and last_cv_check
    db.prepare('UPDATE monitored_series SET total_issues = ?, last_cv_check = datetime(\'now\') WHERE id = ?').run(allIssues.length, id);

    // Keep release_cv_map in sync — upsert this series so the weekly tab can
    // find it immediately by name+publisher without waiting for next startup.
    // User-confirmed entries (source='user') are not overwritten by auto seeds.
    try {
      const normName = (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const normPub  = (publisher || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      db.prepare(`
        INSERT INTO release_cv_map (norm_name, norm_publisher, cv_volume_id, source, updated_at)
        VALUES (?, ?, ?, 'auto', datetime('now'))
        ON CONFLICT(norm_name, norm_publisher) DO UPDATE SET
          cv_volume_id = excluded.cv_volume_id,
          updated_at   = excluded.updated_at
        WHERE source != 'user'
      `).run(normName, normPub, String(id));
    } catch (e) { logger.warn('monitor', 'release_cv_map upsert failed', e.message); }

    res.json({ success: true, directory, issues_added: allIssues.length });

    // Fire-and-forget post-add setup. Each step is independently wrapped so a
    // failure in one (e.g. CV rate limit during fetchAndSetSeriesStatus) doesn't
    // block the others — series.json creation in particular must always run.
    // NOTE: createSeriesJsonIfMissing runs BEFORE fetchAndSetSeriesStatus so
    // that deriveStatusFromSeriesJson (reading series.json) is tried first.
    // If series.json already has 'Continuing'/'Ended', no CV API call is needed.
    setImmediate(async () => {
      try { await runRefreshDirectory(id); } catch (e) { logger.warn('monitor', 'Post-add refresh failed', e.message); }
      // A new special: refresh the parent too, so it lets go of the special's files now.
      if (parentMonitoredId) { try { await runRefreshDirectory(parentMonitoredId); } catch (e) { logger.warn('monitor', 'Post-add parent refresh failed', e.message); } }
      // Scan immediately after directory refresh so untagged issues are flagged
      // without requiring a manual refresh button press.
      try { await scanSeriesComicInfo(id, { onlyUnknown: true }); } catch (e) { logger.warn('monitor', 'Post-add ComicInfo scan failed', e.message); }
      try { await autoDiscoverAnnuals(id, name, directory); } catch (e) { logger.warn('monitor', 'Post-add annual discovery failed', e.message); }
      // Auto-create series.json + run enricher BEFORE status check so that
      // deriveStatusFromSeriesJson can read the 'Continuing'/'Ended' field
      // written by the enricher, avoiding a redundant CV API call.
      try {
        const created = await createSeriesJsonIfMissing({ id, directory });
        if (created) {
          logger.info('monitor', `Auto-created series.json for new series "${name}"`);
          // Update series_status from the freshly written series.json so
          // fetchAndSetSeriesStatus can skip the CV API call entirely.
          const statusFromJson = deriveStatusFromSeriesJson(directory);
          if (statusFromJson) {
            db.prepare(`UPDATE monitored_series SET series_status = ? WHERE id = ?`).run(statusFromJson, id);
            logger.info('monitor', `Post-add status from series.json: ${statusFromJson}`, { id });
          }
        } else if (fs.existsSync(path.join(directory, 'series.json'))) {
          // Already there (e.g. the folder was in the library before it was
          // monitored): not a failure. Still use it for the status.
          logger.info('monitor', `series.json already present for "${name}" — kept`);
          const statusFromJson = deriveStatusFromSeriesJson(directory);
          if (statusFromJson) {
            db.prepare(`UPDATE monitored_series SET series_status = ? WHERE id = ?`).run(statusFromJson, id);
            logger.info('monitor', `Post-add status from series.json: ${statusFromJson}`, { id });
          }
        } else {
          logger.warn('monitor', `Auto series.json creation returned false for "${name}"`);
        }
      } catch (e) {
        logger.warn('monitor', 'Auto series.json creation failed', e.message);
      }
      // Status check: series.json path will short-circuit if status was just set above.
      // Falls back to CV API for series where the enricher didn't set a status.
      try { await fetchAndSetSeriesStatus(id); } catch (e) { logger.warn('monitor', 'Post-add status fetch failed', e.message); }
    });
  } catch (e) {
    // Series was added but issue fetch failed — not fatal
    logger.error('monitor', 'Failed to fetch CV issues', e.message);
    res.json({ success: true, directory, issues_added: 0, warning: `CV fetch failed: ${e.message}` });

    // Same isolation as above — each step independent, series.json before status check.
    setImmediate(async () => {
      try { await runRefreshDirectory(id); } catch (e) { logger.warn('monitor', 'Post-add refresh failed', e.message); }
      // A new special: refresh the parent too, so it lets go of the special's files now.
      if (parentMonitoredId) { try { await runRefreshDirectory(parentMonitoredId); } catch (e) { logger.warn('monitor', 'Post-add parent refresh failed', e.message); } }
      try { await scanSeriesComicInfo(id, { onlyUnknown: true }); } catch (e) { logger.warn('monitor', 'Post-add ComicInfo scan failed', e.message); }
      try { await autoDiscoverAnnuals(id, name, directory); } catch (e) { logger.warn('monitor', 'Post-add annual discovery failed', e.message); }
      try {
        const created = await createSeriesJsonIfMissing({ id, directory });
        if (created) {
          logger.info('monitor', `Auto-created series.json for new series "${name}"`);
          const statusFromJson = deriveStatusFromSeriesJson(directory);
          if (statusFromJson) {
            db.prepare(`UPDATE monitored_series SET series_status = ? WHERE id = ?`).run(statusFromJson, id);
            logger.info('monitor', `Post-add status from series.json: ${statusFromJson}`, { id });
          }
        }
      } catch (e) {
        logger.warn('monitor', 'Auto series.json creation failed', e.message);
      }
      try { await fetchAndSetSeriesStatus(id); } catch (e) { logger.warn('monitor', 'Post-add status fetch failed', e.message); }
    });
  }
});

// Remove a monitored series from the download manager: its issues, packs and
// linked annual series. Files and the library are not touched. Returns the
// linked annuals ({ id, dir }) so a caller can delete their folders if asked.
function removeMonitoredSeriesRows(id) {
  // Fetch linked annuals before any deletes
  const linkedAnnuals = db.prepare(
    'SELECT annual_series_id FROM series_annual_links WHERE parent_series_id = ?'
  ).all(id);

  // Annuals are often shared (X-Men Annual is linked to X-Men (2024) and to
  // older entries). One still linked to another series stays: only this
  // series' link to it goes.
  const sharedWithOthers = aid => !!db.prepare('SELECT 1 FROM series_annual_links WHERE annual_series_id = ? AND parent_series_id != ?').get(aid, id);
  const annualDirs = linkedAnnuals.filter(link => !sharedWithOthers(link.annual_series_id)).map(link => ({
    id: link.annual_series_id,
    dir: db.prepare('SELECT directory FROM monitored_series WHERE id = ?').get(link.annual_series_id)?.directory,
  }));

  // Single transaction for all DB deletes — order matters for FK constraints:
  // series_annual_links must be deleted before the monitored_series rows they reference
  db.transaction(() => {
    // 1. Drop all annual links where this series is the parent
    db.prepare('DELETE FROM series_annual_links WHERE parent_series_id = ?').run(id);
    // 2. Remove any link where this series was itself an annual child
    db.prepare('DELETE FROM series_annual_links WHERE annual_series_id = ?').run(id);
    // 3. Delete annual series_packs, issues, and series rows
    for (const a of annualDirs) {
      // Clear any annual links the annual series itself may have (as parent or child)
      // before deleting its monitored_series row — prevents FK constraint failure
      db.prepare('DELETE FROM series_annual_links WHERE parent_series_id = ?').run(a.id);
      db.prepare('DELETE FROM series_annual_links WHERE annual_series_id = ?').run(a.id);
      db.prepare('DELETE FROM series_packs WHERE series_id = ?').run(a.id);
      db.prepare('UPDATE scanned_books SET monitored_issue_id=NULL WHERE monitored_issue_id IN (SELECT id FROM monitored_issues WHERE series_id=?)').run(a.id);
      db.prepare('DELETE FROM monitored_issues WHERE series_id = ?').run(a.id);
      db.prepare('DELETE FROM monitored_series WHERE id = ?').run(a.id);
    }
    // 4. Delete parent series_packs, issues, and series row
    db.prepare('DELETE FROM series_packs WHERE series_id = ?').run(id);
    db.prepare('UPDATE scanned_books SET monitored_issue_id=NULL WHERE monitored_issue_id IN (SELECT id FROM monitored_issues WHERE series_id=?)').run(id);
    db.prepare('DELETE FROM monitored_issues WHERE series_id = ?').run(id);
    db.prepare('DELETE FROM monitored_series WHERE id = ?').run(id);
  })();

  return annualDirs;
}

app.delete('/api/monitor/series/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const deleteFiles = req.query.deleteFiles === 'true';

  try {
    // Fetch directory before deleting the row
    const row = db.prepare('SELECT directory, name FROM monitored_series WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Series not found' });

    const annualDirs = removeMonitoredSeriesRows(id);

    logger.info('monitor', `Deleted series "${row.name}" (${id}) and ${annualDirs.length} linked annuals`);

    // File deletion outside transaction (best-effort)
    if (deleteFiles) {
      for (const a of annualDirs) {
        if (a.dir && a.dir !== row.directory) {
          try { fs.rmSync(a.dir, { recursive: true, force: true }); } catch {}
        }
      }
      if (row.directory) {
        try {
          fs.rmSync(row.directory, { recursive: true, force: true });
          logger.info('monitor', `Deleted directory`, { directory: row.directory });
        } catch (e) {
          logger.warn('monitor', `Could not delete directory`, { directory: row.directory, error: e.message });
        }
      }
    }

    res.json({ success: true });
  } catch (e) {
    logger.error('monitor', `Failed to delete series ${id}`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Prune ended series from the download manager (admin) ─────────────
// Ended series keep their files and library entries; only their download
// tracking goes (as with Remove). Linked annual series go with their parent.
// Ticked by default: ended, nothing wanted, and not the annual of a series
// that is still ongoing.
app.get('/api/monitor/prune/candidates', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT ms.id, ms.name, ms.year, ms.publisher, ms.directory, ms.is_special, ms.parent_series_id, ms.last_cv_check,
        SUM(CASE WHEN mi.status = 'processed' THEN 1 ELSE 0 END) AS processed,
        SUM(CASE WHEN mi.status = 'skipped'   THEN 1 ELSE 0 END) AS skipped,
        SUM(CASE WHEN mi.status = 'wanted'    THEN 1 ELSE 0 END) AS wanted,
        COUNT(mi.id) AS issues
      FROM monitored_series ms LEFT JOIN monitored_issues mi ON mi.series_id = ms.id
      WHERE ms.series_status = 'ended'
      GROUP BY ms.id
      ORDER BY ms.name COLLATE NOCASE, ms.year`).all();
    // Every parent of each annual (annuals are often shared between series).
    const parentsOf = new Map();
    for (const r of db.prepare(`SELECT l.annual_series_id AS a, p.id, p.name, p.year, p.series_status AS st
      FROM series_annual_links l JOIN monitored_series p ON p.id = l.parent_series_id`).all()) {
      if (!parentsOf.has(String(r.a))) parentsOf.set(String(r.a), []);
      parentsOf.get(String(r.a)).push(r);
    }
    const annualCount = new Map(db.prepare('SELECT parent_series_id AS p, COUNT(*) AS n FROM series_annual_links GROUP BY parent_series_id').all().map(r => [String(r.p), r.n]));
    // Wanted issues in a parent's linked annuals (they would be removed with it).
    const annualWanted = new Map(db.prepare(`SELECT l.parent_series_id AS p, COUNT(*) AS n FROM series_annual_links l
      JOIN monitored_issues mi ON mi.series_id = l.annual_series_id WHERE mi.status = 'wanted' GROUP BY l.parent_series_id`).all().map(r => [String(r.p), r.n]));
    const out = [];
    for (const r of rows) {
      const parents = parentsOf.get(String(r.id)) || [];
      const liveParent = parents.find(p => p.st !== 'ended');
      // An annual whose parents are all ended goes with them: listed under the parents only.
      if (parents.length && !liveParent) continue;
      const reasons = [];
      if (r.wanted) reasons.push(`${r.wanted} wanted`);
      if (annualWanted.get(String(r.id))) reasons.push(`its annuals have ${annualWanted.get(String(r.id))} wanted`);
      if (liveParent) reasons.push(`annual of ${liveParent.name} (${liveParent.year || '?'}), still ongoing`);
      // Hold back: its annual volume is still publishing and no live run has it yet —
      // pruning now would drop the volume before a new run can take it over.
      for (const a of db.prepare(`SELECT l.annual_series_id AS id, s.name FROM series_annual_links l
          JOIN monitored_series s ON s.id = l.annual_series_id WHERE l.parent_series_id = ?`).all(r.id)) {
        const live = (parentsOf.get(String(a.id)) || []).some(p => p.st !== 'ended' && String(p.id) !== String(r.id));
        if (!live && annualStillPublishing(a.id)) reasons.push(`annual ${a.name} still publishing — waiting for a new run to take it over`);
      }
      if (r.is_special || r.parent_series_id) {
        const host = db.prepare(`SELECT name, year FROM monitored_series WHERE directory = ? AND id != ? AND COALESCE(is_special, 0) = 0
          AND parent_series_id IS NULL AND series_status != 'ended' LIMIT 1`).get(r.directory, r.id);
        if (host) reasons.push(`special filed in ${host.name} (${host.year || '?'}), keeps its files out of that series' matches`);
      }
      out.push({ id: r.id, name: r.name, year: r.year, publisher: r.publisher, directory: r.directory, special: !!(r.is_special || r.parent_series_id),
        issues: r.issues, processed: r.processed || 0, skipped: r.skipped || 0, wanted: r.wanted || 0,
        annuals: annualCount.get(String(r.id)) || 0, last_cv_check: r.last_cv_check, keep_reasons: reasons, suggested: !reasons.length });
    }
    res.json({ candidates: out, total_monitored: db.prepare('SELECT COUNT(*) AS n FROM monitored_series').get().n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/monitor/prune', requireAdmin, (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).slice(0, 5000);
  if (!ids.length) return res.status(400).json({ error: 'No series selected' });
  let removed = 0, annuals = 0; const errors = [];
  for (const id of ids) {
    const row = db.prepare("SELECT id, name, series_status FROM monitored_series WHERE id = ?").get(id);
    if (!row) continue;                                             // already gone (e.g. removed with its parent)
    if (row.series_status !== 'ended') { errors.push({ id, error: 'not ended' }); continue; }
    try { annuals += removeMonitoredSeriesRows(id).length; removed++; }
    catch (e) { errors.push({ id, error: e.message }); }
  }
  logger.info('monitor', `Pruned ${removed} ended series (+${annuals} linked annual series) from the download manager`, { errors: errors.length });
  res.json({ ok: true, removed, annuals, errors });
});

app.patch('/api/monitor/series/:id', requireAdmin, (req, res) => {
  const { status, series_type, directory, locg_series_id } = req.body;
  if (series_type !== undefined) {
    if (!['comic', 'manga'].includes(series_type)) return res.status(400).json({ error: 'series_type must be comic or manga' });
    db.prepare('UPDATE monitored_series SET series_type = ? WHERE id = ?').run(series_type, req.params.id);
  }
  if (status !== undefined) {
    db.prepare('UPDATE monitored_series SET status = ? WHERE id = ?').run(status, req.params.id);
  }
  if (directory !== undefined) {
    // Used to disambiguate same-name same-year series (e.g. two "Old Man
    // Logan (2016)" volumes — V Wars / V2). Validates the path is non-empty
    // and not already taken by another monitored series, but does NOT
    // create the folder on disk or move existing files. The user is
    // responsible for putting files at the new path; clicking Refresh
    // afterwards rescans.
    const trimmed = String(directory).trim();
    if (!trimmed) return res.status(400).json({ error: 'directory cannot be empty' });
    // A series may share its folder with its own linked annual volumes and
    // special series (they're stored in the parent's folder by design). Only an
    // unrelated series in the same folder is a conflict.
    const self = db.prepare('SELECT id, parent_series_id FROM monitored_series WHERE id = ?').get(req.params.id);
    const related = new Set([
      ...db.prepare('SELECT annual_series_id AS id FROM series_annual_links WHERE parent_series_id = ?').all(req.params.id).map(r => String(r.id)),
      ...db.prepare('SELECT parent_series_id AS id FROM series_annual_links WHERE annual_series_id = ?').all(req.params.id).map(r => String(r.id)),
      ...db.prepare('SELECT id FROM monitored_series WHERE parent_series_id = ?').all(req.params.id).map(r => String(r.id)),
      ...(self?.parent_series_id ? [String(self.parent_series_id)] : []),
    ]);
    const collision = db.prepare(
      'SELECT id, name FROM monitored_series WHERE directory = ? AND id != ?'
    ).all(trimmed, req.params.id).find(r => !related.has(String(r.id)));
    if (collision) {
      return res.status(409).json({
        error: `Directory already used by monitored series: ${collision.name}`,
        conflictingId: collision.id,
      });
    }
    db.prepare('UPDATE monitored_series SET directory = ? WHERE id = ?').run(trimmed, req.params.id);
    invalidateDirectoryExistsCache(req.params.id);
    invalidateSeriesJsonCache(req.params.id);  // new dir may or may not have series.json
    logger.info('series', `Series ${req.params.id} directory updated`, { directory: trimmed });
  }
  if (locg_series_id !== undefined) {
    // Manual LOCG series ID override — parse from full URL or bare ID
    // Accepts: "154909", "https://leagueofcomicgeeks.com/comics/series/154909/batman-superman-worlds-finest"
    const urlMatch = String(locg_series_id).match(/\/comics\/series\/(\d+)\/([^/?]+)/);
    const bareId   = String(locg_series_id).match(/^(\d+)$/);
    if (urlMatch) {
      db.prepare('UPDATE monitored_series SET locg_series_id = ?, locg_series_slug = ? WHERE id = ?')
        .run(urlMatch[1], urlMatch[2], req.params.id);
      logger.info('series', `Series ${req.params.id} LOCG series ID set manually`, { locg_series_id: urlMatch[1] });
    } else if (bareId) {
      db.prepare('UPDATE monitored_series SET locg_series_id = ?, locg_series_slug = ? WHERE id = ?')
        .run(bareId[1], null, req.params.id);
    } else if (locg_series_id === '' || locg_series_id === null) {
      db.prepare('UPDATE monitored_series SET locg_series_id = NULL, locg_series_slug = NULL WHERE id = ?')
        .run(req.params.id);
    } else {
      return res.status(400).json({ error: 'locg_series_id must be a numeric ID or full LOCG series URL' });
    }
  }
  res.json({ success: true });
});

// ─── Prowlarr ─────────────────────────────────────────────────────
// Search Prowlarr indexers — returns releases with protocol, title, size, indexer, downloadUrl, guid
app.get('/api/prowlarr/search', requireDownloadAccess, async (req, res) => {
  try {
    const { q } = req.query;
    // Optional protocol filter — when ?protocol=usenet is set, drop torrent
    // results from the response. Used by the Prowlarr search tab on comic
    // series cards, which defaults to NZB-only because torrent coverage for
    // comics is patchy and our auto-grab heuristics aren't tuned for torrent
    // release naming. Pass ?protocol=any (or omit) to see everything.
    const protocolFilter = (req.query.protocol || 'any').toLowerCase();
    const prowlarrUrl = getSetting('prowlarr_url') || PROWLARR_URL;
    const prowlarrKey = getSetting('prowlarr_api_key') || PROWLARR_API_KEY;
    const r = await axios.get(`${prowlarrUrl}/api/v1/search`, {
      params: { query: q, type: 'search', limit: 100, categories: '7030' },
      headers: { 'X-Api-Key': prowlarrKey },
      timeout: PROWLARR_TIMEOUT_MS,
    });
    // Normalize to what frontend expects: protocol, title, size, indexer, grabs, downloadUrl, guid
    let releases = (r.data || []).map(rel => ({
      protocol:    rel.protocol    || '',
      title:       rel.title       || '',
      size:        rel.size        || 0,
      indexer:     rel.indexer     || '',
      grabs:       rel.grabs       ?? null,
      downloadUrl: rel.downloadUrl || rel.magnetUrl || '',
      guid:        rel.guid        || '',
      infoUrl:     rel.infoUrl     || '',
    }));
    if (protocolFilter === 'usenet')  releases = releases.filter(r => r.protocol !== 'torrent');
    if (protocolFilter === 'torrent') releases = releases.filter(r => r.protocol === 'torrent');
    res.json(releases);
  } catch (e) {
    logger.error('prowlarr', 'Search failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── SABnzbd ──────────────────────────────────────────────────────
// Add NZB to SABnzbd queue by URL — also records the download against the issue
app.post('/api/sabnzbd/add', requireDownloadAccess, async (req, res) => {
  try {
    const { url, name, issueId } = req.body;
    const sabUrl  = getSetting('sabnzbd_url')  || SABNZBD_URL;
    const sabKey  = getSetting('sabnzbd_api_key') || SABNZBD_API_KEY;
    const sabCat  = getSetting('sabnzbd_category') || 'comics';

    const r = await axios.get(`${sabUrl}/api`, {
      params: {
        apikey:  sabKey,
        mode:    'addurl',
        name:    url,
        nzbname: name || '',
        cat:     sabCat,
        output:  'json',
      },
    });

    if (r.data.status === true || r.data.nzo_ids?.length) {
      const nzo_id = r.data.nzo_ids?.[0] || null;

      // Record in DB if we have both issueId and nzo_id
      if (issueId && nzo_id) {
        db.prepare(`UPDATE monitored_issues SET status = 'snatched', download_id = ?, download_url = ? WHERE id = ?`)
          .run(nzo_id, url, issueId);
        logger.info('sabnzbd', `Issue ${issueId} snatched`, { nzo_id });
      }

      res.json({ success: true, nzo_id });
    } else {
      res.json({ success: false, error: r.data.error || 'SABnzbd rejected' });
    }
  } catch (e) {
    logger.error('sabnzbd', 'Add failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── qBittorrent — add torrent (magnet or torrent URL) ───────────
app.post('/api/qbittorrent/add', requireDownloadAccess, async (req, res) => {
  try {
    const { magnet, torrentUrl, issueId } = req.body;
    if (!magnet && !torrentUrl) return res.status(400).json({ error: 'magnet or torrentUrl required' });

    // Determine series_type from the issue (if provided) so we can route to
    // the correct qBit category + savepath. Comic torrents and manga torrents
    // need to land in different qBit categories so the manga-pp filesystem
    // poller doesn't try to scan comic torrents (it would fail to match any
    // manga series and start deleting files — see manga-pp guard rationale).
    let seriesType = 'manga'; // safe default — preserves prior behaviour
    if (issueId) {
      const row = db.prepare(`
        SELECT s.series_type FROM monitored_issues i
        JOIN monitored_series s ON s.id = i.series_id
        WHERE i.id = ?
      `).get(issueId);
      if (row?.series_type === 'comic') seriesType = 'comic';
    }

    const { url, qbtHeaders } = await qbtLogin();
    const cat = seriesType === 'comic'
      ? (getSetting('qbittorrent_comic_category') || 'comics')
      : (getSetting('qbittorrent_category') || 'manga');

    const formData = new URLSearchParams();
    const sourceUrl = magnet || torrentUrl;
    formData.append('urls', sourceUrl);
    formData.append('category', cat);
    const qbtSavepath = seriesType === 'comic'
      ? (getSetting('qbittorrent_comic_savepath') || '')
      : (getSetting('qbittorrent_savepath') || process.env.TORRENTS_PATH || '');
    if (qbtSavepath) formData.append('savepath', qbtSavepath);

    // Snapshot existing hashes before add — see resolveQbtHash for rationale.
    const beforeRes = await axios.get(`${url}/api/v2/torrents/info`, {
      headers: qbtHeaders, timeout: 5000,
      params: { category: cat },
    });
    const beforeHashes = new Set((beforeRes.data || []).map(t => t.hash?.toLowerCase()));

    await axios.post(`${url}/api/v2/torrents/add`, formData.toString(), {
      headers: { ...qbtHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });

    if (issueId) {
      const torrentHash = await resolveQbtHash({ url, qbtHeaders }, sourceUrl, cat, beforeHashes);
      db.prepare(`UPDATE monitored_issues SET status='snatched', download_id=?, download_url=? WHERE id=?`)
        .run(`qbt_${torrentHash}`, sourceUrl, issueId);
      logger.info('qbittorrent', `Issue ${issueId} snatched (${seriesType})`, { category: cat, hash: torrentHash });
    }

    res.json({ success: true, category: cat });
  } catch (e) {
    logger.error('qbittorrent', 'Add failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Nyaa.si search — manga volumes (Literature - English-translated, c=3_1) ────
app.get('/api/nyaa/search', requireDownloadAccess, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });

    const rssUrl = `https://nyaa.si/?page=rss&c=3_1&q=${encodeURIComponent(q)}`;
    logger.info('nyaa', `Fetching via FlareSolverr: ${rssUrl}`);

    // Nyaa.si is behind Cloudflare — use FlareSolverr to bypass
    const fs = await axios.post(`${FLARESOLVERR_URL}/v1`, {
      cmd: 'request.get',
      url: rssUrl,
      maxTimeout: 60000,
    }, { timeout: 65000 });

    const solution = fs.data?.solution;
    if (!solution || solution.status !== 200) {
      throw new Error(`FlareSolverr failed: ${fs.data?.message || 'status ' + solution?.status}`);
    }
    const xml = solution.response;
    logger.info('nyaa', `FlareSolverr response length: ${xml?.length}, first 200 chars: ${(xml||'').slice(0,200).replace(/\n/g,' ')}`);
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];
      const get = (tag) => {
        const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`));
        return m ? (m[1] || m[2] || '').trim() : '';
      };
      const getAttr = (tag, attr) => {
        const m = block.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"[^>]*\\/>`));
        return m ? m[1] : '';
      };

      const title    = get('title');
      const link     = get('link') || getAttr('enclosure', 'url');
      const size     = getAttr('nyaa:size', 'nyaa:size') || get('nyaa:size');
      const seeders  = parseInt(get('nyaa:seeders') || '0');
      const leechers = parseInt(get('nyaa:leechers') || '0');
      const infoHash = get('nyaa:infoHash');
      const magnet   = infoHash
        ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce`
        : '';
      const pubDate  = get('pubDate');

      if (!title) continue;

      // Classify: pack, single volume, or chapter (skip chapters for now)
      const isChapter = /(?:ch(?:apter)?\.?\s*\d+(?!\s*-\s*\d+\s*vol)|#\d{3,}(?!\s*vol))/i.test(title) &&
                        !/v(?:ol(?:ume)?)?[\s.]?\d+/i.test(title);
      const isPack    = /v(?:ol(?:ume)?)?[\s.]?\d+\s*[-–]\s*(?:v(?:ol(?:ume)?)?[\s.]?)?\d+/i.test(title) ||
                        /\(v(?:ol)?\.?\d+\s*[-–]\s*v?(?:ol)?\.?\d+\)/i.test(title);
      const type      = isChapter ? 'chapter' : isPack ? 'pack' : 'single';

      // Extract volume number for single volumes
      let volumeNumber = null;
      if (type === 'single') {
        const vm = title.match(/v(?:ol(?:ume)?)?\.?\s*0*(\d+)/i);
        if (vm) volumeNumber = parseInt(vm[1]);
      }

      items.push({ title, link, magnet, size, seeders, leechers, pubDate, type, volumeNumber, infoHash });
    }

    logger.info('nyaa', `Search "${q}": ${items.length} results (${items.filter(i=>i.type==='single').length} single, ${items.filter(i=>i.type==='pack').length} packs, ${items.filter(i=>i.type==='chapter').length} chapters)`);
    res.json({ results: items, query: q });
  } catch (e) {
    logger.error('nyaa', 'Search failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Manga torrent post-processor ────────────────────────────────
// Scans /downloads/torrents for completed CBZ/CBR files, matches them
// to wanted manga volumes, renames, moves to series directory.
const mangaTorrentState = { running: false, lastRun: null, processed: 0, errors: 0 };

async function processMangaTorrents() {
  if (mangaTorrentState.running) return;
  mangaTorrentState.running = true;
  const startTime = Date.now();
  let processed = 0, errors = 0;
  const TORRENT_DOWNLOAD_DIR = getSetting('torrent_completed_path') || '/downloads/torrents';

  try {
    if (!fs.existsSync(TORRENT_DOWNLOAD_DIR)) {
      logger.warn('manga-pp', `Torrent download dir not found: ${TORRENT_DOWNLOAD_DIR}`);
      return;
    }

    // ─── Path-collision guard ────────────────────────────────────
    // The torrent poller must not inspect incomplete DDL files
    // while they are being written. If the torrent completed-path is
    // configured to the same root as the DDL download path, manga-pp will
    // descend into in-progress DDL pack folders (Mega, MediaFire, etc.) and
    // observe partially-downloaded comics while the DDL handler is still
    // writing to them. Refuse to run in that case.
    const DDL_DIR = getSetting('ddl_download_path') || '/downloads/getcomics';
    const norm = p => path.resolve(p).replace(/[/\\]+$/, '');
    if (norm(DDL_DIR) === norm(TORRENT_DOWNLOAD_DIR)
        || norm(DDL_DIR).startsWith(norm(TORRENT_DOWNLOAD_DIR) + path.sep)
        || norm(TORRENT_DOWNLOAD_DIR).startsWith(norm(DDL_DIR) + path.sep)) {
      logger.warn('manga-pp', `Torrent completed-path (${TORRENT_DOWNLOAD_DIR}) overlaps DDL download path (${DDL_DIR}) — skipping. Configure these as separate directories in Settings.`);
      return;
    }

    // ─── Active-DDL guard ────────────────────────────────────────
    // Even with disjoint paths, if there's an active DDL or pack download in
    // flight, skip this poller cycle. Manga-pp runs every 10 minutes and
    // nothing bad happens if we miss one cycle. This is belt-and-suspenders
    // against future misconfiguration and against our own code writing
    // outside the expected directory.
    for (const dl of activeDownloads.values()) {
      if (dl.status === 'downloading') {
        logger.info('manga-pp', `Skipping this cycle — ${activeDownloads.size} active download(s) in progress`);
        return;
      }
    }

    // Find all CBZ/CBR files recursively — qBittorrent may put them in subfolders
    const findFiles = (dir, results = []) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) findFiles(full, results);
          else if (/\.(cbz|cbr|zip)$/i.test(entry.name) && !entry.name.startsWith('.')) {
            // Skip files still being written (.!qB incomplete marker sibling)
            const incompleteMarker = full + '.!qB';
            if (!fs.existsSync(incompleteMarker)) results.push(full);
          }
        }
      } catch {}
      return results;
    };

    const files = findFiles(TORRENT_DOWNLOAD_DIR);
    if (!files.length) { logger.info('manga-pp', 'No completed torrent files found'); return; }
    logger.info('manga-pp', `Found ${files.length} candidate file(s)`);

    // Load all manga series + their wanted issues
    const mangaSeries = db.prepare("SELECT * FROM monitored_series WHERE series_type = 'manga'").all();
    if (!mangaSeries.length) return;

    for (const filePath of files) {
      const filename = path.basename(filePath);
      const volNum = extractVolumeNumber(filename);
      if (!volNum) { logger.info('manga-pp', `Could not extract volume number from: ${filename}`); continue; }

      // Find matching series by name similarity
      const fileNorm = filename.toLowerCase().replace(/[^a-z0-9]/g, '');
      let bestSeries = null, bestScore = 0, tied = false;
      for (const s of mangaSeries) {
        const sNorm = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (fileNorm.includes(sNorm) || sNorm.split('').every((c, i) => fileNorm[i] === c)) {
          const score = sNorm.length;
          if (score > bestScore) { bestScore = score; bestSeries = s; tied = false; }
          else if(score===bestScore)tied=true;
        }
      }
      if (!bestSeries || tied) {
        logger.debug('manga-pp', `No matching manga series for: ${filename} — retained for review`);
        continue;
      }

      // Find matching wanted issue by volume number.
      // CAST(issue_number AS INTEGER) collapsed "8AU" and "8" to the same
      // bucket, false-matching tie-ins. Pull all candidates for the series
      // and filter in JS using the canonical normaliser instead.
      const targetNum = IN.normIssueNumber(volNum);
      const candidates = db.prepare(
        "SELECT * FROM monitored_issues WHERE series_id = ? AND status IN ('wanted','snatched')"
      ).all(bestSeries.id);
      const matches = targetNum ? candidates.filter(c => IN.normIssueNumber(c.issue_number) === targetNum) : [];
      const issue = matches.length===1 ? matches[0] : null;
      if (!issue) {
        logger.debug('manga-pp', `No unique wanted issue v${volNum} for "${bestSeries.name}" — retained for review`);
        continue;
      }

      try {
        const result=await metadataRuntime.arrive({sourcePath:filePath,sourceName:filename,issue,directory:bestSeries.directory,matchedByFilename:true,profile:'manga'});
        logger.info('manga-pp', `Processed: ${filename} → ${path.basename(result.path)}`);
        processed++;
      } catch (e) {
        logger.error('manga-pp', `Failed to process ${filename}`, e.message);
        errors++;
        if(metadataRuntime.status().length || e.code==='CV_RATE_LIMIT')break;
      }
    }
  } catch (e) {
    logger.error('manga-pp', 'Post-processor error', e.message);
  } finally {
    mangaTorrentState.running = false;
    mangaTorrentState.lastRun = new Date().toISOString();
    mangaTorrentState.processed = processed;
    mangaTorrentState.errors = errors;
    logger.info('manga-pp', `Complete: ${processed} processed, ${errors} errors, ${Date.now() - startTime}ms`);
    if (processed > 0) schedulePostProcessScan();
  }
}

// Manual trigger endpoint
app.post('/api/manga/process-torrents', requireAdmin, async (req, res) => {
  if (mangaTorrentState.running) return res.json({ ok: false, message: 'Already running' });
  res.json({ ok: true, message: 'Processing started' });
  setImmediate(() => processMangaTorrents().catch(e=>logger.warn('manga-pp','Job deferred',e.message)));
});

// Status endpoint
app.get('/api/manga/process-torrents/status', requireAuth, (req, res) => {
  res.json(mangaTorrentState);
});

// Background poller — runs every 10 minutes
setInterval(() => {
  processMangaTorrents().catch(e => logger.error('manga-pp', 'Poller error', e.message));
}, 10 * 60 * 1000);

// Get SABnzbd queue/history status for a specific nzo_id
app.get('/api/sabnzbd/history/:nzo_id', requireDownloadAccess, async (req, res) => {
  try {
    const sabUrl = getSetting('sabnzbd_url') || SABNZBD_URL;
    const sabKey = getSetting('sabnzbd_api_key') || SABNZBD_API_KEY;
    const r = await axios.get(`${sabUrl}/api`, {
      params: { apikey: sabKey, mode: 'history', output: 'json', limit: 50 },
    });
    const jobs = r.data.history?.slots || [];
    const job = jobs.find(j => j.nzo_id === req.params.nzo_id) || null;
    res.json({ job });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get all SABnzbd history
app.get('/api/sabnzbd/history/all', requireDownloadAccess, async (req, res) => {
  try {
    const sabUrl = getSetting('sabnzbd_url') || SABNZBD_URL;
    const sabKey = getSetting('sabnzbd_api_key') || SABNZBD_API_KEY;
    const r = await axios.get(`${sabUrl}/api`, {
      params: { apikey: sabKey, mode: 'history', output: 'json', limit: 100 },
    });
    res.json({ slots: r.data.history?.slots || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Post-processor ───────────────────────────────────────────────

/** Build a ComicInfo.xml string from issue + series DB rows */
/** Build the destination filename.
 *  Regular:  "Nightwing 023 (2025).cbz"
 *  Annual:   "Nightwing 2025 Annual 001.cbz"  (year already in CV volume name, no trailing year)
 */
// Year written in a filename: "X-Men 2026 Annual 001", "Thor 015 (2019)". null if none.
function filenameYear(p) {
  const m = path.basename(String(p || '')).match(/(?:^|[^0-9])((?:19|20)[0-9]{2})(?:[^0-9]|$)/);
  return m ? m[1] : null;
}
// Cover / store years of an issue (monitored_issues row or CV issue object).
function issueYearsOf(i) {
  return [i.release_date, i.store_date, i.cover_date].filter(Boolean).map(d => String(d).slice(0, 4));
}

function buildDestFilename(issue, series) {
  // Pad integer part only — "8" → "008", "8.1" → "008.1", "1.NOW" → "001.NOW".
  // The previous padStart on the raw value left "8.1" unpadded because it was
  // already 3 chars, producing inconsistent filenames vs neighbouring "008".
  const num  = padIssueNumStr(issue.issue_number || '0', 3);
  const name = series.name.replace(/[/\\:*?"<>|]/g, '');
  const isAnnual = issue.is_annual || /annual/i.test(series.name);
  if (isAnnual) {
    // If the series name already contains a 4-digit year (e.g. "Nightwing 2025 Annual"),
    // use as-is — year is already baked in.
    if (/\d{4}/.test(name)) {
      // Year-named one-shot volumes ("Avengers 1999") have no "Annual" in the
      // name; keep the word so the file still reads (and is detected) as an annual.
      return /annual/i.test(name) ? `${name} ${num}.cbz` : `${name} Annual ${num}.cbz`;
    }
    // Series name has no year (e.g. "Venom Annual") — inject issue year so multiple
    // annuals with the same issue_number don't collide on disk.
    // Strip trailing "Annual", inject year, re-append: "Venom 2019 Annual 001.cbz"
    const year = (issue.release_date || issue.store_date || '').slice(0, 4) || series.year || '';
    const baseName = name.replace(/\s*Annual\s*$/i, '').trim();
    return year ? `${baseName} ${year} Annual ${num}.cbz` : `${name} ${num}.cbz`;
  }
  const year = (issue.release_date || issue.store_date || '').slice(0, 4) || series.year || '';
  return `${name} ${num} (${year}).cbz`;
}

// Extract volume number from manga filenames.
// Handles: v27, v027, Vol. 99, Vol 1, Volume 3
// Falls back to extractIssueNumber for edge cases.
function extractVolumeNumber(filename) {
  const base = path.basename(filename, path.extname(filename));
  // Primary: v27, v027, Vol.01, Vol 01, Volume 01 (case-insensitive)
  const vm = base.match(/v(?:ol(?:ume)?)?\.?\s*0*(\d+)/i);
  if (vm) return String(parseInt(vm[1], 10));
  // Fallback to issue number extractor
  return extractIssueNumber(filename);
}

// Build destination filename for manga volumes: "Series Name v027 (2021).cbz"
function buildMangaDestFilename(issue, series) {
  const num  = String(issue.issue_number || '0').padStart(3, '0');
  const name = series.name.replace(/[/\\:*?"<>|]/g, '');
  const year = (issue.release_date || issue.store_date || '').slice(0, 4) || series.year || '';
  return year ? `${name} v${num} (${year}).cbz` : `${name} v${num}.cbz`;
}

/** Patch locg_series_id/slug into an existing series.json at the top level.
 *  Non-destructive: reads the file, sets/overwrites locg fields, rewrites it.
 *  Returns true if the file was updated, false if skipped or failed. */
function patchSeriesJsonWithLocg(directory, locgSeriesId, locgSeriesSlug) {
  if (!locgSeriesId) return false;
  const jsonPath = path.join(directory, 'series.json');
  if (!fs.existsSync(jsonPath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    data.locg_series_id  = String(locgSeriesId);
    data.locg_series_slug = locgSeriesSlug || null;
    data.locg_series_url  = `${LOCG_BASE}/comics/series/${locgSeriesId}/${locgSeriesSlug}`;
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    logger.warn('series.json', `Failed to patch LOCG IDs`, { directory, error: e.message });
    return false;
  }
}

/** Main post-processing function for a completed download */
// ─── Create series.json for a monitored series directory ─────────
// Calls enricher.py --create with the series directory + CV volume ID.
// Creates + enriches in one pass. No-ops if series.json already exists.
// Returns true on success, false on skip or failure.
async function createSeriesJsonIfMissing(series) {
  const jsonPath = path.join(series.directory, 'series.json');
  if (fs.existsSync(jsonPath)) {
    logger.debug('series.json', `Already exists, skipping`, { path: jsonPath });
    return false;
  }

  const enricherPath = path.join(SCRIPTS_PATH, 'enricher.py');
  if (!fs.existsSync(enricherPath)) {
    logger.warn('series.json', `Enricher script not found`, { enricherPath });
    return false;
  }

  const stageRoot=fs.mkdtempSync(path.join(path.dirname(DB_PATH),'series-create-'));
  const stageDirectory=path.join(stageRoot,'series');
  const configPath = path.join(stageRoot,'config.yaml');
  const aiRun = startEnricherRun(`Create series.json: ${series.name}`);
  fs.writeFileSync(configPath, yaml.dump(buildEnricherConfig(false, aiRun)));

  try {
    fs.mkdirSync(stageDirectory);

    const output = await new Promise((resolve, reject) => {
      const proc = nativeSpawn('python3',
        [enricherPath, 'create', stageDirectory, String(series.id), '--context-folder', series.directory, '--config', configPath],
        { env: { ...process.env, PYTHONUNBUFFERED: '1' } }
      );
      proc.on('error',reject);
      let stdout = '', stderr = '';
      proc.stdout.on('data', d => { stdout += d; });
      proc.stderr.on('data', d => { stderr += d; logger.debug('series.json', d.toString().trim()); });
      proc.on('close', code => {
        finishEnricherRun(aiRun);
        try { fs.unlinkSync(configPath); } catch {}
        const lines = stdout.trim().split('\n').filter(l => l.trim().startsWith('{'));
        if (lines.length > 0) return resolve(lines[lines.length - 1].trim());
        if (code !== 0) return reject(new Error(stderr.trim() || `Script exited ${code}`));
        resolve(stdout.trim());
      });
    });

    const result = JSON.parse(output);
    if (result.success) {
      return await libraryAccess.run('write',async()=>{
      const current=db.prepare('SELECT directory FROM monitored_series WHERE id=?').get(series.id);
      if(current&&current.directory!==series.directory)throw new Error('Series moved during metadata lookup; retry');
      if(fs.existsSync(jsonPath))return false;
      const staged=path.join(stageDirectory,'series.json');
      JSON.parse(fs.readFileSync(staged,'utf8'));
      fs.mkdirSync(series.directory,{recursive:true});
      fs.copyFileSync(staged,jsonPath,fs.constants.COPYFILE_EXCL);
      invalidateDirectoryExistsCache(series.id);
      result.path=jsonPath;
      logger.info('series.json', `Created + enriched for series ${series.id}`, { path: result.path, name: result.name });
      invalidateSeriesJsonCache(series.id);
      // Patch LOCG series IDs into the freshly created series.json (if already resolved)
      try {
        const locgRow = db.prepare('SELECT locg_series_id, locg_series_slug FROM monitored_series WHERE id = ?').get(series.id);
        if (locgRow?.locg_series_id) {
          const patched = patchSeriesJsonWithLocg(series.directory, locgRow.locg_series_id, locgRow.locg_series_slug);
          if (patched) logger.info('series.json', `Patched LOCG series ID into series.json`, { id: series.id, locg_series_id: locgRow.locg_series_id });
        }
      } catch (e) {
        logger.warn('series.json', `LOCG patch skipped`, { id: series.id, error: e.message });
      }
      syncSeriesJsonRow({ seriesPath: series.directory });
      return true;
      });
    } else {
      logger.warn('series.json', `Script reported failure`, { error: result.error });
      return false;
    }
  } catch (e) {
    logger.error('series.json', `Failed for series ${series.id}`, e.message);
    return false;
  } finally {
    fs.rmSync(stageRoot,{recursive:true,force:true});
  }
}

// ─── Manual series.json creation endpoint (monitored series) ─────
app.post('/api/monitor/series/:id/create-series-json', requireAdmin, async (req, res) => {
  const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(req.params.id);
  if (!series) return res.status(404).json({ error: 'Series not found' });

  const jsonPath = path.join(series.directory, 'series.json');

  // Create only. Rebuilding an existing file (old ?force=true) wiped manual edits
  // and regenerated AI text; the nightly series.json refresh now keeps files current.
  if (fs.existsSync(jsonPath)) {
    return res.json({ success: false, skipped: true, reason: 'series.json already exists', path: jsonPath });
  }

  const ok = await createSeriesJsonIfMissing(series);
  if (ok) {
    // Update series_status from the freshly written series.json
    const status = deriveStatusFromSeriesJson(series.directory);
    if (status) db.prepare(`UPDATE monitored_series SET series_status = ? WHERE id = ?`).run(status, series.id);
    res.json({ success: true, path: jsonPath });
  } else {
    res.status(500).json({ success: false, error: 'Failed to create series.json — check server logs' });
  }
});

// Debounced reconciler — coalesces rapid calls (one per library scan) into a
// single run 2s after the last trigger. Prevents 7× reconciler runs on a
// post-process scan that touches all libraries.
// scanChanged: true if any library scan added/removed books — enables invalidation passes.
let _reconcileTimer = null;
let _reconcileScanChanged = false;
function scheduleReconcile(scanChanged = false) {
  if (scanChanged) _reconcileScanChanged = true; // latch: any change in the batch enables invalidation
  if (_reconcileTimer) clearTimeout(_reconcileTimer);
  _reconcileTimer = setTimeout(() => {
    _reconcileTimer = null;
    const changed = _reconcileScanChanged;
    _reconcileScanChanged = false; // reset for next batch
    // ComicInfo index first (retag-aware checks use it), then Timeline,
    // Top Shelf and reading lists.
    Promise.resolve(changed ? bookIndex.refresh() : null)
      .then(() => reconcileEventIssues(changed))
      .catch(e => logger.error('events', 'Reconcile failed', { error: e.message }))
      .finally(() => Promise.resolve(canonMatch.reconcile(changed))
        .catch(e => logger.error('canon', 'Reconcile failed', { error: e.message }))
        .finally(() => Promise.resolve(readingLists.reconcile(changed))
          .finally(() => { try { seriesGrouping.run('reconcile'); } catch (e) { logger.warn('grouping', 'Rules failed', e.message); } })));
  }, 2000);
}

// On startup, run a full reconcile (with invalidation) once to clear any bad matches.
// Uses scheduleReconcile so it merges with any scan-triggered runs via the debounce.
setTimeout(() => scheduleReconcile(true), 15000);
// Batches rapid completions (e.g. pack) into a single scan 10s after last call.
let postProcessScanTimer = null;
// Phase 6.8: scan only the libraries that received files. Without a known
// destination (packs, manga), fall back to every library as before.
let postProcessScanTargets = new Set(), postProcessScanAll = false;
function schedulePostProcessScan(destPath = null) {
  if (destPath) postProcessScanTargets.add(path.resolve(destPath)); else postProcessScanAll = true;
  if (postProcessScanTimer) clearTimeout(postProcessScanTimer);
  postProcessScanTimer = setTimeout(async () => {
    postProcessScanTimer = null;
    const targets = [...postProcessScanTargets], all = postProcessScanAll;
    postProcessScanTargets = new Set(); postProcessScanAll = false;
    try {
      const every = db.prepare('SELECT * FROM libraries').all();
      const owns = (lib, p) => { const rel = path.relative(path.resolve(lib.path), p); return !rel || (!path.isAbsolute(rel) && !rel.startsWith('..')); };
      const libs = all ? every : every.filter(lib => targets.some(p => owns(lib, p)));
      const scanLibs = libs.length ? libs : every;
      logger.info('scanner', 'Post-process scan triggered — new files incoming', { libraries: scanLibs.map(l => l.name) });
      for (const lib of scanLibs) await runLibraryScan(lib, 'postprocess');
      logger.info('scanner', 'Post-process scan complete');
      // Notify DownloadManager clients to reload monitored series
      pushSseEvent({ type: 'series_updated' });
    } catch (e) {
      logger.warn('scanner', 'Post-process scan failed', e.message);
    }
  }, 10000);
}

async function postProcess(issue, series, storageDir) {
  const tmpDir = path.join(os.tmpdir(), `omnibus-${issue.id}-${Date.now()}`);
  logger.info('postprocess', `Starting for issue ${issue.id}`, { storageDir, tmpDir });

  try {
    // slot.storage may be a file path or a directory depending on SABnzbd version/config
    let srcPath;
    let stat = null;
    let notAnArchive = null;
    try { stat = fs.statSync(storageDir); }
    catch (statErr) {
      // Path doesn't exist or isn't accessible — fall through to parent-dir recovery below.
      logger.warn('postprocess', `storageDir stat failed`, { storageDir, code: statErr.code });
    }
    // Extensionless-file recovery — DDL downloads from URLs that have no
    // extension in the last path segment land here (e.g. `/downloads/omnibus/<token>__`).
    // Probe magic bytes; if it's a known archive, rename in-place so the
    // existing extraction routing works without further special cases.
    if (stat && stat.isFile() && !/\.(cbr|cbz|rar|zip|7z)$/i.test(storageDir)) {
      try {
        const fd = fs.openSync(storageDir, 'r');
        const head = Buffer.alloc(8);
        fs.readSync(fd, head, 0, 8, 0);
        fs.closeSync(fd);
        let detectedExt = null;
        // A file host sometimes returns its web page instead of the comic.
        if (/^\s*</.test(head.toString('latin1'))) notAnArchive = 'Download host returned a web page instead of the comic';
        if (head[0] === 0x50 && head[1] === 0x4B && head[2] === 0x03 && head[3] === 0x04) detectedExt = '.cbz';
        else if (head[0] === 0x52 && head[1] === 0x61 && head[2] === 0x72 && head[3] === 0x21) detectedExt = '.cbr';
        else if (head[0] === 0x37 && head[1] === 0x7A && head[2] === 0xBC && head[3] === 0xAF) detectedExt = '.cbz'; // 7z — extraction handles it
        if (detectedExt) {
          const renamed = storageDir + detectedExt;
          if(fs.existsSync(renamed))throw new Error('Extension recovery destination already exists');
          fs.renameSync(storageDir, renamed);
          logger.info('postprocess', `Extensionless file detected as ${detectedExt}, renamed`, { from: storageDir, to: renamed });
          storageDir = renamed;
          stat = fs.statSync(storageDir); // refresh stat for the path with new name
        }
      } catch (probeErr) {
        logger.warn('postprocess', `Magic-byte probe failed`, { storageDir, error: probeErr.message });
      }
    }
    // The downloaded file isn't a comic (web page, unknown type): fail this
    // source and try the next one. Never substitute another file from the
    // shared downloads folder.
    if (stat && stat.isFile() && !/\.(cbr|cbz|rar|zip|7z)$/i.test(storageDir)) {
      const reason = notAnArchive || 'Downloaded file is not a comic archive';
      logger.warn('postprocess', `Issue ${issue.id}: ${reason}`, { storageDir, bytes: stat.size });
      try { fs.unlinkSync(storageDir); } catch {}
      const failedUrl = issue.download_url || null;
      db.prepare(`UPDATE monitored_issues SET status='wanted', download_id=NULL, file_path=NULL WHERE id=?`).run(issue.id);
      setImmediate(async () => {
        try { await blacklistAndRetry(issue, series, failedUrl, `Post-process: ${reason}`); }
        catch (e) { logger.error('retry', `blacklistAndRetry failed for ${issue.id}`, e.message); }
      });
      return false;
    }
    if (stat && stat.isFile() && /\.(cbr|cbz|rar|zip)$/i.test(storageDir)) {
      // SABnzbd / DDL gave us the file directly
      srcPath = storageDir;
    } else if (stat && stat.isDirectory()) {
      // SABnzbd gave us the containing folder — scan for the comic file
      const files = fs.readdirSync(storageDir);
      const comics = files.filter(f => /\.(cbr|cbz|rar|zip)$/i.test(f));
      if(comics.length>1)throw Object.assign(new Error('Multiple comics in a single-issue download; choose the correct source'),{code:'IDENTITY_REVIEW_REQUIRED'});
      const comicFile = comics[0];
      if (!comicFile) {
        logger.warn('postprocess', `No comic file found in ${storageDir}`, { files });
        // Treat as a failure — blacklist and retry rather than silently staying 'downloaded'
        const failedUrl = issue.download_url || null;
        db.prepare(`UPDATE monitored_issues SET status='wanted', download_id=NULL, file_path=NULL WHERE id=?`).run(issue.id);
        setImmediate(async () => {
          try { await blacklistAndRetry(issue, series, failedUrl, 'Post-process: no comic file in download directory'); }
          catch (e) { logger.error('retry', `blacklistAndRetry failed after no-comic-file for ${issue.id}`, e.message); }
        });
        return false;
      }
      srcPath = path.join(storageDir, comicFile);
    } else {
      // The storage path vanished between download-complete and post-process,
      // or an odd download-client layout. Try the parent dir as a last resort:
      // only when exactly one comic sits alongside (more is ambiguous).
      const parent = path.dirname(storageDir);
      let parentFiles = [];
      try { parentFiles = fs.readdirSync(parent); } catch {}
      const siblings = parentFiles.filter(f => /\.(cbr|cbz|rar|zip)$/i.test(f));
      if(siblings.length>1)throw Object.assign(new Error('Ambiguous download source directory'),{code:'IDENTITY_REVIEW_REQUIRED'});
      const sibling = siblings[0];
      if (sibling) {
        logger.info('postprocess', `Recovered via parent dir`, { storageDir, parent, sibling });
        srcPath = path.join(parent, sibling);
      } else {
        logger.warn('postprocess', `Unrecognised storage path, skipping`, {
          storageDir,
          statType: stat ? (stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : 'other') : 'missing',
          parentFiles: parentFiles.slice(0, 10),
        });
        db.prepare(`UPDATE monitored_issues SET status='wanted', download_id=NULL, file_path=NULL WHERE id=?`).run(issue.id);
        return false;
      }
    }
    logger.info('postprocess', `Source file resolved`, { srcPath });

    const destSeriesDir = series.parent_series_id
      ? (db.prepare('SELECT directory FROM monitored_series WHERE id = ?').get(series.parent_series_id)?.directory || series.directory)
      : series.directory;
    const salvage = !!postProcess.salvage?.has(issue.id);
    const force = !!postProcess.force?.has(issue.id);   // admin: Process anyway (2026-11-09)
    if (force) logger.info('postprocess', `Issue ${issue.id}: processing anyway as this issue (admin)`, { file: path.basename(srcPath) });
    const result = await metadataRuntime.arrive({sourcePath: srcPath, issue, directory: destSeriesDir, salvage, force});
    postProcess.salvage?.delete(issue.id);
    postProcess.force?.delete(issue.id);   // kept after a failure (a Comic Vine wait), like Convert anyway
    const destPath = result.path;
    invalidateDirectoryExistsCache(series.parent_series_id || series.id);
    const fresh = db.prepare('SELECT cv_data FROM monitored_issues WHERE id = ?').get(issue.id);
    const cvHash = crypto.createHash('md5').update(fresh?.cv_data || '').digest('hex');
    db.prepare("UPDATE monitored_issues SET status='processed',file_path=?,date_processed=datetime('now'),has_comicinfo=1,last_retag_cv_hash=? WHERE id=?")
      .run(destPath, cvHash, issue.id);
    try { db.prepare('UPDATE monitored_issues SET retry_after=NULL,last_fail_reason=NULL WHERE id=?').run(issue.id); } catch {}
    logger.info('postprocess', 'Published identified comic', {bookId: result.bookId, destPath});

    // Special series don't get their own series.json — files live in parent's directory
    if (!series.parent_series_id) {
      createSeriesJsonIfMissing(series).catch(e =>
        logger.warn('postprocess', `series.json creation failed (non-fatal)`, e.message)
      );
    }

    // Schedule a library scan to pick up the new file
    schedulePostProcessScan(destPath);

    return true;

  } catch (e) {
    logger.error('postprocess', `Failed for issue ${issue.id}`, e.message);

    // Leave the source and any journal backups intact for retry/review. Provider
    // failures and identity conflicts are not proof that a download is corrupt.
    logger.warn('postprocess', 'Source retained for retry or metadata review', {storageDir, code: e.code, operationId: e.operationId});
    // A review result (identity/filename conflict) won't change on its own.
    // Wait 6 hours instead of repeating the same 8-second failure every poll.
    if (e.code === 'CV_RATE_LIMIT') {
      // Stays 'downloaded' (WAITING) and is tried again when the hour resets.
      try {
        db.prepare("UPDATE monitored_issues SET retry_after = ?, last_fail_reason = ? WHERE id = ? AND status = 'downloaded'")
          .run(sqlTime(e.retryAt), CV_WAIT_REASON, issue.id);
        logger.info('postprocess', `Issue ${issue.id} waiting for the Comic Vine limit`, { until: sqlTime(e.retryAt) });
      } catch {}
    } else if (e.code === 'ARCHIVE_DAMAGED') {
      // The file will not heal: stop retrying every poll (Avengers #253 was
      // tried every 30 s, 2026-10-16). Held for Convert anyway or a new copy.
      try {
        db.prepare("UPDATE monitored_issues SET retry_after = datetime('now', '+30 days'), last_fail_reason = ? WHERE id = ? AND status = 'downloaded'")
          .run(`ARCHIVE_DAMAGED: ${e.message}`.slice(0, 500), issue.id);
        logger.info('postprocess', `Issue ${issue.id} held: damaged download`, {});
      } catch {}
    } else if (e.code === 'LIBRARY_RECOVERY_REQUIRED') {
      try {
        db.prepare("UPDATE monitored_issues SET retry_after = datetime('now', '+5 minutes'), last_fail_reason = ? WHERE id = ? AND status = 'downloaded'")
          .run('Waiting for interrupted metadata work to be recovered', issue.id);
      } catch {}
    } else if (/^(IDENTITY_REVIEW_REQUIRED|CV_ISSUE_MISMATCH|ANNUAL_MISMATCH)$/.test(e.code || '')) {
      // The file names or tags another issue (2026-11-09). The file on disk will not change,
      // so trying again every 6 hours only repeated the failure and a Comic Vine lookup.
      // Held until an admin acts in Download Manager › Queue: Process anyway, Delete file or Resume.
      try {
        db.prepare("UPDATE monitored_issues SET retry_after = datetime('now', '+30 days'), last_fail_reason = ? WHERE id = ? AND status = 'downloaded'")
          .run(`${e.code}: ${e.message}`.slice(0, 500), issue.id);
        logger.info('postprocess', `Issue ${issue.id} held for an admin: the file does not match the issue`, {code: e.code});
      } catch {}
    } else if (/REVIEW|MISMATCH|OCCUPIED|UNSAFE|INVALID/.test(e.code || '')) {
      try {
        db.prepare("UPDATE monitored_issues SET retry_after = datetime('now', '+6 hours'), last_fail_reason = ? WHERE id = ? AND status = 'downloaded'")
          .run(`${e.code}: ${e.message}`.slice(0, 500), issue.id);
        logger.info('postprocess', `Issue ${issue.id} needs review; next automatic attempt in 6 hours`, {code: e.code});
      } catch {}
    } else {
      // Any other failure: wait before trying again instead of every poll (Storm #10/#11 failed
      // 7 times a minute, 2026-10-22). File problems that will not heal wait 6 hours; others 15 minutes.
      const lasting = /^(RAR_TOOL_REQUIRED|UNSUPPORTED_ARCHIVE|NO_IMAGE_PAGES|ARCHIVE_LIMIT|UNSUPPORTED_ENCODING|INVALID_COMICINFO)$/.test(e.code || '');
      try {
        db.prepare(`UPDATE monitored_issues SET retry_after = datetime('now', '${lasting ? '+6 hours' : '+15 minutes'}'), last_fail_reason = ? WHERE id = ? AND status = 'downloaded'`)
          .run(`${e.code || 'ERROR'}: ${e.message}`.slice(0, 500), issue.id);
        logger.info('postprocess', `Issue ${issue.id} failed; next automatic attempt in ${lasting ? '6 hours' : '15 minutes'}`, {code: e.code});
      } catch {}
    }

    return false;
  } finally {
    // Cleanup temp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// "Convert anyway" for a damaged download (Download Manager → Queue): the next
// post-processing of these issues keeps the readable pages (RAR only).
postProcess.salvage = new Set();
postProcess.force = new Set();   // issue ids an admin chose to process anyway (Download Manager › Queue)

// ─── Existing-book reprocessing through the shared metadata lifecycle ───
async function retagIssue(issue, series, { skipCvRefresh = false, preserveFilename = false, signal } = {}) {
  let freshIssue = null;
  if (skipCvRefresh) { try { freshIssue = JSON.parse(issue.cv_data || 'null'); } catch {} }
  const result = await metadataRuntime.retag({issue, freshIssue, preserveFilename, signal});
  // Only the exact monitored path processed by the runtime is acknowledged.
  const fresh = db.prepare('SELECT cv_data FROM monitored_issues WHERE id = ?').get(issue.id);
  if (fresh?.cv_data) db.prepare('UPDATE monitored_issues SET last_retag_cv_hash = ?, has_comicinfo = 1 WHERE id = ? AND file_path = ?')
    .run(crypto.createHash('md5').update(fresh.cv_data).digest('hex'), issue.id, result.path || issue.file_path);
  return result;
}

// Retag a single processed issue
app.post('/api/monitor/series/:id/issues/:issueId/retag', requireAdmin, async (req, res) => {
  const { id, issueId } = req.params;

  // Look up by issue ID only — annual issues belong to their own series_id (the annual CV volume),
  // not the parent series. Verify the issue is reachable from the parent via direct ownership or
  // a series_annual_links entry so we don't expose arbitrary issue retags.
  const issue = db.prepare('SELECT * FROM monitored_issues WHERE id = ?').get(issueId);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });

  const ownedByParent = issue.series_id === id;
  const linkedAsAnnual = !ownedByParent && !!db.prepare(
    'SELECT 1 FROM series_annual_links WHERE parent_series_id = ? AND annual_series_id = ?'
  ).get(id, issue.series_id);
  if (!ownedByParent && !linkedAsAnnual) return res.status(403).json({ error: 'Issue does not belong to this series' });

  if (issue.status !== 'processed') return res.status(400).json({ error: 'Issue is not processed' });

  // Use the issue's own series row (annual series for annuals, parent series for regular issues)
  const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(issue.series_id);
  if (!series) return res.status(404).json({ error: 'Series not found' });

  try {
    await retagIssue(issue, series);
    res.json({ success: true });
  } catch (e) {
    logger.error('retag', `Failed for issue ${issueId}`, e.message);
    retagHandlers.errorResponse(res, e);
  }
});

// POST /api/monitor/series/:id/retag-all — retag every processed issue in a series
// with fresh Comic Vine metadata. Streams progress as SSE so the client can render
// a live counter. Does NOT include linked annual volumes — those must be retagged
// from their own series row. Admin-only.
//
// Optional body: { issueIds: [...] } — restricts retag to a specific subset.
// Non-processed IDs are silently filtered out so the client doesn't have to pre-filter.
app.post('/api/monitor/series/:id/retag-all', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(id);
  if (!series) return res.status(404).json({ error: 'Series not found' });

  const subsetIds = Array.isArray(req.body?.issueIds) ? req.body.issueIds : null;
  const onlyUntagged = req.body?.onlyUntagged === true;
  let issues;
  if (subsetIds && subsetIds.length) {
    // Filter to processed issues that belong to this series and are in the subset.
    // Parameterised IN clause built from the subset length.
    const placeholders = subsetIds.map(() => '?').join(',');
    issues = db.prepare(
      `SELECT * FROM monitored_issues
       WHERE series_id = ? AND status = 'processed' AND id IN (${placeholders})
       ORDER BY CAST(issue_number AS REAL)`
    ).all(id, ...subsetIds);
  } else if (onlyUntagged) {
    // Retag only processed issues whose archive is confirmed missing ComicInfo.xml.
    // has_comicinfo IS NULL means "not yet scanned" — skip those so we don't do
    // needless work; they'll be scanned by the background task.
    issues = db.prepare(
      `SELECT * FROM monitored_issues WHERE series_id = ? AND status = 'processed' AND has_comicinfo = 0 ORDER BY CAST(issue_number AS REAL)`
    ).all(id);
  } else {
    issues = db.prepare(
      `SELECT * FROM monitored_issues WHERE series_id = ? AND status = 'processed' ORDER BY CAST(issue_number AS REAL)`
    ).all(id);
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // Mirror progress to the global download toast so users see activity
  // regardless of which page they're on. Same contract as auto-grab:
  // totalBytes = issue count, bytesReceived = issues completed.
  const scopeLabel = onlyUntagged ? 'Retag Untagged' : 'Retag All';
  const dlId = `retag-all-${id}-${Date.now()}`;
  const dlEntry = {
    id: dlId,
    filename: `${scopeLabel}: ${series.name}`,
    seriesName: series.name,
    bytesReceived: 0,
    totalBytes: issues.length,
    status: 'downloading',
    startedAt: new Date().toISOString(),
  };
  activeDownloads.set(dlId, dlEntry);
  pushDownloadUpdate(dlEntry);

  send({ log: `Retagging ${issues.length} issue${issues.length === 1 ? '' : 's'} in ${series.name}...\n`, progress: { done: 0, total: issues.length } });


  let done = 0, errors = 0, skipped = 0, aborted = false, userCancelled = false, abortReason = '';
  for (let i = 0; i < issues.length; i++) {
    // Cancel check — user clicked ✕ on the toast. Stop the batch; issues
    // already retagged this run stay retagged (not reversible, fine).
    if (isCancelled(dlId)) {
      userCancelled = true;
      const remaining = issues.length - i;
      send({
        log: `\n✕ Cancelled by user after ${done} successful retag${done === 1 ? '' : 's'}.\n` +
             `${remaining} issue${remaining === 1 ? '' : 's'} left unprocessed.\n`,
        progress: { done: done + skipped + errors, total: issues.length },
      });
      logger.info('retag-all', `Series ${id} cancelled by user after ${done} retagged`, { remaining });
      break;
    }
    const issue = issues[i];
    // Update toast with current position before each issue
    dlEntry.bytesReceived = done + skipped + errors;
    dlEntry.filename = `${scopeLabel}: ${series.name} — ${i + 1}/${issues.length} (#${issue.issue_number})`;
    pushDownloadUpdate({ ...dlEntry });

    try {
      send({ log: `#${issue.issue_number}... ` });
      const current = retagIssue(issue, series);
      // Look up the next issue on Comic Vine while this one is being written: the reply is cached
      // (10 min), so the next retag starts with it. Read-only; Comic Vine pacing still applies.
      const next = issues[i + 1];
      if (next && !isCancelled(dlId)) fetchCvIssue(next.id).catch(() => null);
      await current;
      done++;
      send({ log: `✓\n`, progress: { done: done + skipped + errors, total: issues.length } });
    } catch (e) {
      if (e.code === 'CV_RATE_LIMIT') {
        // Stop the whole batch. Continuing would either fall back to stale cv_data
        // or produce empty ComicInfo files for the remaining issues.
        const remaining = issues.length - i;
        send({
          log: `\n⚠ Comic Vine rate limit reached after ${done} successful retag${done === 1 ? '' : 's'}.\n` +
               `Stopping batch — ${remaining} issue${remaining === 1 ? '' : 's'} left untouched.\n` +
               `Try again in an hour, or retag in smaller batches.\n`,
          progress: { done: done + skipped + errors, total: issues.length },
        });
        logger.warn('retag-all', `Rate limited after ${done} issues, ${remaining} not processed`);
        aborted = true;
        break;
      }
      if (e.code === 'LIBRARY_RECOVERY_REQUIRED' || metadataRuntime.status().length) {
        errors++; aborted = true; abortReason = 'metadata recovery required'; send({log: 'Metadata work is held for recovery: ' + e.message + '\n', operationId: e.operationId}); break;
      }
      if (e.code === 'CV_NO_DATA') {
        // Not a true error — the issue simply can't be tagged right now. Leave it
        // alone (has_comicinfo stays 0) so the user can see it's still pending.
        skipped++;
        send({ log: `⊘ skipped (no CV data)\n`, progress: { done: done + skipped + errors, total: issues.length } });
        continue;
      }
      errors++;
      send({ log: `✗ ${e.message}\n`, progress: { done: done + skipped + errors, total: issues.length } });
      logger.error('retag-all', `Failed for issue ${issue.id}`, e.message);
    }
    // No fixed pause between issues (was 700 ms): cvApiGet spaces every Comic Vine request and keeps
    // the hourly budget, so a pause here only added time (2026-10-22).
  }

  // Final toast update with summary, then auto-remove. Three terminal paths:
  //   (1) userCancelled — short auto-remove, 'cancelled' status
  //   (2) aborted       — CV rate limit, 'error' status + explanation
  //   (3) success       — 'complete' status with normal summary
  dlEntry.bytesReceived = issues.length;
  const summary = `${done} retagged${skipped ? `, ${skipped} skipped` : ''}${errors ? `, ${errors} error${errors !== 1 ? 's' : ''}` : ''}`;
  if (userCancelled) {
    // Use finalizeCancellation so the UI gets the same 'cancelled' status
    // treatment as every other cancellable op.
    dlEntry.filename = `${scopeLabel} ${series.name} cancelled: ${summary}`;
    finalizeCancellation(dlEntry, `Cancelled: ${summary}`);
  } else {
    dlEntry.status = aborted ? 'error' : 'complete';
    dlEntry.filename = `${scopeLabel} ${series.name}: ${summary}${aborted ? ' — ' + (abortReason || 'rate limited') : ''}`;
    if (aborted) dlEntry.error = abortReason || 'Comic Vine rate limited — retry later';
    pushDownloadUpdate({ ...dlEntry });
    setTimeout(() => { activeDownloads.delete(dlId); pushDownloadUpdate({ id: dlId, status: 'removed' }); }, 15000);
  }

  send({ done: true, total: issues.length, succeeded: done, errors, skipped, aborted, cancelled: userCancelled });
  res.end();
});

// Reset a stuck issue back to wanted so it can be re-grabbed
// Bulk set issue status — used for multi-select skip/unskip in the UI
// Body: { issueIds: [...], status: 'skipped'|'wanted' }
// Only transitions: wanted→skipped, skipped→wanted (never touches downloaded/processed)
app.post('/api/monitor/series/:id/bulk-status', requireDownloadAccess, (req, res) => {
  const { issueIds, status } = req.body;
  if (!Array.isArray(issueIds) || !issueIds.length) return res.status(400).json({ error: 'issueIds required' });
  if (!['skipped', 'wanted'].includes(status)) return res.status(400).json({ error: 'status must be skipped or wanted' });

  const allowedFrom = status === 'skipped' ? ['wanted'] : ['skipped'];
  const stmt = db.prepare(`UPDATE monitored_issues SET status = ? WHERE id = ? AND status IN (${allowedFrom.map(() => '?').join(',')})`);
  let updated = 0;
  for (const id of issueIds) {
    const { changes } = stmt.run(status, id, ...allowedFrom);
    updated += changes;
  }
  logger.info('bulk-status', `Set ${updated} issues to ${status}`);
  res.json({ success: true, updated });
});

// ─── Fill missing issues (admin) ──────────────────────────────────
// For an old, ended library series: show the Comic Vine volume's issues
// against what the whole library owns (by Comic Vine id, so era-split folders
// and books filed elsewhere count), let the admin pick missing issues, then
// monitor the EXISTING folder (no new folder) with the picks wanted and
// everything else skipped, and auto-grab. Downloads then take the normal path:
// grab → completion watcher → post-processing into that folder.
// fill_auto_remove = 1 entries are removed from the download manager once no
// pick is still wanted or in flight (ended series only; files untouched).
const fillVolumeCache = new Map();   // volume id → { at, issues }
// Slim copies of volume issue lists kept for the series pages' missing issues
// (2026-10-28): every series page can show its gaps, so a volume is asked of
// Comic Vine at most every few days instead of on every visit.
db.exec(`CREATE TABLE IF NOT EXISTS cv_volume_issues_cache (vol_id TEXT PRIMARY KEY, at INTEGER NOT NULL, issues TEXT NOT NULL)`);
const slimIssue = i => ({ id: i.id, issue_number: i.issue_number, name: i.name || null, cover_date: i.cover_date || null, store_date: i.store_date || null,
  image: i.image ? { thumb_url: i.image.thumb_url || null, small_url: i.image.small_url || null } : null });
// once: the stored copy is used for good when the series has ended (series.json
// says so, or its newest issue is over a year old); otherwise it is refreshed
// after a week. Most series are fetched from Comic Vine once only.
const VOLUME_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
async function fetchVolumeIssues(volId, { maxAgeMs = 30 * 60 * 1000, slimOk = false, once = false, ended = false } = {}) {
  const hit = fillVolumeCache.get(volId);
  if (hit && Date.now() - hit.at < (once ? VOLUME_REFRESH_MS : maxAgeMs)) return hit.issues;
  if (slimOk) {
    const row = db.prepare('SELECT at, issues FROM cv_volume_issues_cache WHERE vol_id = ?').get(String(volId));
    if (row) {
      let issues = null; try { issues = JSON.parse(row.issues); } catch {}
      if (issues) {
        const newest = issues.reduce((m, i) => { const d = i.store_date || i.cover_date || ''; return d > m ? d : m; }, '');
        const stale = newest && Date.parse(newest) < Date.now() - 365 * 24 * 60 * 60 * 1000;
        const fresh = once ? (ended || stale || Date.now() - row.at < VOLUME_REFRESH_MS) : Date.now() - row.at < maxAgeMs;
        if (fresh) return issues;
      }
    }
  }
  let offset = 0, all = [];
  while (true) {
    const r = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
      params: {
        api_key: getCVKey(), format: 'json', filter: `volume:${volId}`,
        field_list: 'id,issue_number,name,cover_date,store_date,site_detail_url,description,person_credits,character_credits,team_credits,location_credits,image',
        offset, limit: 100,
      },
      headers: { 'User-Agent': 'Omnibus/1.0' },
    });
    const results = r.data.results || [];
    all = all.concat(results);
    if (!results.length || all.length >= r.data.number_of_total_results) break;
    offset += 100;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  fillVolumeCache.set(volId, { at: Date.now(), issues: all });
  try { db.prepare('INSERT OR REPLACE INTO cv_volume_issues_cache (vol_id, at, issues) VALUES (?, ?, ?)').run(String(volId), Date.now(), JSON.stringify(all.map(slimIssue))); } catch {}
  return all;
}

async function fillContext(scannedId, volumeOpts = {}) {
  const scanned = db.prepare('SELECT * FROM scanned_series WHERE id = ?').get(String(scannedId));
  if (!scanned) return { status: 404, error: 'Series not found' };
  const sj = readSeriesJson(scanned.path);
  const m = sj?.metadata || sj || {};
  const volId = m.comicid ? String(m.comicid) : null;
  if (!volId) return { status: 400, error: 'No Comic Vine ID in series.json. Create metadata first (Enrich tab).' };
  const monitored = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(volId) || null;
  let issues;
  if (monitored) {
    issues = db.prepare('SELECT id, issue_number, title, release_date, store_date, status, file_path, cv_data, is_annual FROM monitored_issues WHERE series_id = ?').all(volId)
      .map(i => { let cv = null; try { cv = JSON.parse(i.cv_data || 'null'); } catch {} return { id: String(i.id), number: i.issue_number, title: i.title, cover_date: i.release_date, store_date: i.store_date, monStatus: i.status, file_path: i.file_path, is_annual: i.is_annual, cv }; });
  } else {
    const opts = volumeOpts.cachedOnce ? { slimOk: true, once: true, ended: deriveStatusFromSeriesJson(scanned.path) === 'ended' } : volumeOpts;
    issues = (await fetchVolumeIssues(volId, opts)).map(i => ({ id: String(i.id), number: IN.normIssueNumber(i.issue_number) || '0', title: i.name || null, cover_date: i.cover_date || null, store_date: i.store_date || null, monStatus: null, cv: i }));
  }
  const ids = JSON.stringify(issues.map(i => i.id));
  // Owned anywhere in the library, by Comic Vine id (folder tag or ComicInfo).
  const owned = new Map();
  const note = (cvId, r) => { if (!owned.has(String(cvId))) owned.set(String(cvId), { book_id: r.book_id, folder: r.folder, here: r.series_id === scanned.id }); };
  for (const r of db.prepare(`SELECT sb.cv_issue_id AS cv, sb.id AS book_id, sb.series_id, (ss.name || COALESCE(' (' || ss.year || ')', '')) AS folder FROM scanned_books sb JOIN scanned_series ss ON ss.id = sb.series_id
      WHERE sb.cv_issue_id IN (SELECT value FROM json_each(?))`).all(ids)) note(r.cv, r);
  for (const r of db.prepare(`SELECT ci.cv_issue_id AS cv, sb.id AS book_id, sb.series_id, (ss.name || COALESCE(' (' || ss.year || ')', '')) AS folder FROM book_ci_index ci JOIN scanned_books sb ON sb.id = ci.book_id JOIN scanned_series ss ON ss.id = sb.series_id
      WHERE ci.cv_issue_id IN (SELECT value FROM json_each(?))`).all(ids)) note(r.cv, r);
  // Untagged books in this folder count by number (never annual files, never
  // books tagged as some other comic).
  const byNum = new Map();
  for (const b of db.prepare(`SELECT sb.id, sb.filename, sb.issue_number, sb.cv_issue_id, ci.cv_issue_id AS ci_cv FROM scanned_books sb LEFT JOIN book_ci_index ci ON ci.book_id = sb.id WHERE sb.series_id = ?`).all(scanned.id)) {
    if (b.cv_issue_id || b.ci_cv || /annual/i.test(b.filename)) continue;
    const n = b.issue_number != null ? IN.normIssueNumber(String(b.issue_number)) : null;
    if (n && !byNum.has(n)) byNum.set(n, b.id);
  }
  // Books whose ComicInfo says they were published as this series (same name,
  // volume year within 1, same number), even when their Comic Vine link points
  // at a different id than Comic Vine's issue list now gives (CV re-ids issues).
  const pub = new Map();
  try {
    const volYear = m.start_year || m.year || scanned.year;
    for (const [n, r] of bookIndex.lookup(m.name || scanned.name, volYear)) {
      const f = db.prepare("SELECT (name || COALESCE(' (' || year || ')', '')) AS folder FROM scanned_series WHERE id = ?").get(r.series_id);
      pub.set(n, { book_id: r.book_id, folder: f?.folder || null, here: r.series_id === scanned.id });
    }
  } catch (e) { logger.warn('fill', 'Published-name lookup failed', e.message); }
  const today = new Date().toISOString().slice(0, 10);
  const rows = issues.filter(i => !i.is_annual).map(i => {
    const o = owned.get(i.id) || pub.get(IN.normIssueNumber(String(i.number)));
    const numHit = !o && byNum.get(IN.normIssueNumber(String(i.number)));
    const state = o || numHit || i.monStatus === 'processed' ? 'owned'
      : (i.monStatus === 'wanted' || i.monStatus === 'snatched' || i.monStatus === 'downloaded' || i.monStatus === 'processing') ? 'wanted' : 'missing';
    const d = i.store_date || i.cover_date;
    return {
      id: i.id, number: i.number, title: i.title, date: i.cover_date || null,
      state, unreleased: !!(d && d > today),
      where: o ? (o.here ? null : o.folder) : null,
      image: i.cv?.image?.thumb_url || i.cv?.image?.small_url || null,
    };
  }).sort((a, b) => (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0) || String(a.number).localeCompare(String(b.number)));
  return { scanned, meta: m, volId, monitored, issues, rows };
}

app.get('/api/series/:id/fill/preview', requireAdmin, async (req, res) => {
  try {
    const c = await fillContext(req.params.id);
    if (c.status) return res.status(c.status).json({ error: c.error });
    const mon = c.monitored;
    res.json({
      volume: { id: c.volId, name: c.meta.name || c.scanned.name, year: c.meta.year || c.scanned.year, publisher: c.meta.publisher || null },
      monitored: mon ? { directory: mon.directory, same_folder: path.resolve(mon.directory || '') === path.resolve(c.scanned.path), series_status: mon.series_status, fill: !!mon.fill_auto_remove } : null,
      status: mon?.series_status || deriveStatusFromSeriesJson(c.scanned.path) || 'unknown',
      issues: c.rows,
      counts: { total: c.rows.length, owned: c.rows.filter(r => r.state === 'owned').length, missing: c.rows.filter(r => r.state === 'missing').length, wanted: c.rows.filter(r => r.state === 'wanted').length },
    });
  } catch (e) {
    logger.error('fill', 'Preview failed', { id: req.params.id, error: e.message });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/series/:id/fill', requireAdmin, async (req, res) => {
  try {
    const r = await fillMissing(req.params.id, Array.isArray(req.body?.issueIds) ? req.body.issueIds : [], req.body?.autoRemove !== false);
    if (r.status) return res.status(r.status).json({ error: r.error });
    res.json(r);
  } catch (e) {
    logger.error('fill', 'Fill failed', { id: req.params.id, error: e.message });
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});
// ─── Missing issues on series pages (2026-10-28, claude/REQUESTS_AND_REPORTS.md) ───
// Every series with a Comic Vine ID shows the issues it is missing as placeholders.
// Users who may download get them (the Fill missing path); other users request them.
// Volume issue lists for these pages are fetched once; only series that may
// still be publishing are refreshed, weekly (user, 2026-10-28). See fetchVolumeIssues.
const GAPS_VOLUME = { cachedOnce: true };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('Comic Vine is slow to answer right now')), ms))]);
app.get('/api/series/:id/gaps', requireAuth, async (req, res) => {
  try {
    const c = await withTimeout(fillContext(req.params.id, GAPS_VOLUME), 20000);
    if (c.status) return res.json({ rows: [], reason: c.status === 400 ? 'no-cv-id' : c.error });
    const canDl = downloadRequests.canDownload(req.user);
    const reqs = canDl ? {} : downloadRequests.mineFor('series', c.scanned.id, req.user.sub);
    const rows = c.rows.filter(r => r.state !== 'owned').map(r => ({ ...r, request: reqs[r.id] || null }));
    res.json({ volume_id: c.volId, monitored: !!c.monitored, can_download: canDl, owned: c.rows.length - rows.length, rows });
  } catch (e) {
    logger.warn('gaps', 'Missing issues lookup failed', { id: req.params.id, error: e.message });
    res.json({ rows: [], reason: e.message });
  }
});
app.post('/api/series/:id/gaps/get', requireDownloadAccess, async (req, res) => {
  try {
    const r = await fillMissing(req.params.id, Array.isArray(req.body?.issueIds) ? req.body.issueIds : [], true);
    if (r.status) return res.status(r.status).json({ error: r.error });
    res.json(r);
  } catch (e) {
    logger.error('gaps', 'Get missing issues failed', { id: req.params.id, error: e.message });
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});


// Fill missing issues into a library folder (also used by the shared
// editor's "Get this issue"): monitor the existing folder with the picks
// wanted and everything else skipped, then auto-grab.
// Returns { ok, created, wanted, directory, auto_remove } or { status, error }.
async function fillMissing(scannedId, pickIds, autoRemove = true) {
  {
    const picks = new Set((pickIds || []).map(String));
    if (!picks.size) return { status: 400, error: 'Pick at least one issue' };
    const c = await fillContext(scannedId);
    if (c.status) return { status: c.status, error: c.error };
    const missing = new Set(c.rows.filter(r => r.state === 'missing').map(r => r.id));
    const chosen = [...picks].filter(id => missing.has(id));
    if (!chosen.length) return { status: 400, error: 'None of the picked issues are missing' };
    const volId = c.volId;
    let created = false, directory;

    if (c.monitored) {
      // Already monitored (maybe in another folder): add the picks to that entry.
      directory = c.monitored.directory;
      const up = db.prepare(`UPDATE monitored_issues SET status = 'wanted', retry_after = NULL WHERE id = ? AND series_id = ? AND status IN ('skipped','failed')`);
      db.transaction(() => { for (const id of chosen) up.run(id, volId); })();
    } else {
      directory = c.scanned.path;
      const m = c.meta;
      const name = m.name || c.scanned.name;
      const publisher = m.publisher || null;
      const status = deriveStatusFromSeriesJson(directory) || 'unknown';
      const chosenSet = new Set(chosen);
      const isAnnual = (num, nm) => (((num || '') + ' ' + (nm || '')).toLowerCase().includes('annual') ? 1 : 0);
      const insIssue = db.prepare(`INSERT OR IGNORE INTO monitored_issues (id, series_id, issue_number, title, release_date, store_date, cv_data, is_annual, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      db.transaction(() => {
        db.prepare(`INSERT INTO monitored_series (id, name, publisher, year, total_issues, image_url, cv_url, directory, series_type, parent_series_id, is_special, series_status, fill_auto_remove, fill_started_at, last_cv_check)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, datetime('now'), datetime('now'))`)
          .run(volId, name, publisher, m.year || c.scanned.year || null, c.issues.length, m.image || m.image_url || null,
            `https://comicvine.gamespot.com/series/4050-${volId}/`, directory, detectSeriesType(publisher), status, autoRemove ? 1 : 0);
        for (const i of c.issues) {
          insIssue.run(i.id, volId, i.number, i.title, i.cover_date, i.store_date, JSON.stringify(i.cv || {}),
            isAnnual(i.cv?.issue_number, i.cv?.name), chosenSet.has(i.id) ? 'wanted' : 'skipped');
        }
      })();
      created = true;
    }
    logger.info('fill', `Fill missing: ${chosen.length} issue(s) wanted for "${c.meta.name || c.scanned.name}"`, { volId, directory, created, autoRemove: created ? autoRemove : false });
    const result = { ok: true, created, wanted: chosen.length, directory, auto_remove: created ? autoRemove : false };

    // Link the files already in the folder, then grab. No annual discovery
    // (old annuals would all become wanted) and no series.json creation
    // (the folder already has one).
    setImmediate(async () => {
      try { await runRefreshDirectory(volId); } catch (e) { logger.warn('fill', 'Refresh failed', e.message); }
      try { await scanSeriesComicInfo(volId, { onlyUnknown: true }); } catch (e) { logger.warn('fill', 'ComicInfo scan failed', e.message); }
      try {
        const r = startAutoGrab(volId);
        if (r.status) logger.warn('fill', `Auto-grab refused: ${r.error}`, { volId });
      } catch (e) { logger.warn('fill', 'Auto-grab failed to start', e.message); }
      if (created) {
        const s = db.prepare('SELECT series_status FROM monitored_series WHERE id = ?').get(volId);
        if (s && (!s.series_status || s.series_status === 'unknown')) { try { await fetchAndSetSeriesStatus(volId); } catch (e) { logger.warn('fill', 'Status fetch failed', e.message); } }
      }
    });
    return result;
  }
}

// ─── Shared editor: get a missing issue (claude/ADMIN_REORG.md) ───
// For an unmatched issue in the editor: a reading-list issue (kind list,
// owner = list id), a Timeline event issue (event) or a Top Shelf run issue
// (run). Admin only.
//   GET  /api/editor/acquire/:kind/:owner/:issue  → plan:
//     owned | monitored {series_id, series_name, issue_id, status}
//     | fill {scanned_id, folder, cv_issue_id} (other issues of the series are in the library)
//     | add {search} (none are: the Download Manager's Add Series)
//   POST same path { action: 'wanted' } (monitored, skipped/failed → wanted, then grab)
//                  { action: 'fill' } (this issue wanted, the rest of the series skipped; user 2026-10-16)
function editorIssueRow(kind, owner, issue) {
  if (kind === 'list') return db.prepare(`SELECT li.id, li.cv_issue_id, li.scanned_book_id, li.scanned_series_id, li.series_name, li.issue_number, li.volume_year
    FROM list_issues li JOIN reading_list_entries e ON e.id = li.owner_id WHERE li.owner_kind = 'reading_list_entry' AND li.id = ? AND e.list_id = ?`).get(Number(issue), Number(owner));
  if (kind === 'event') return db.prepare(`SELECT id, cv_issue_id, scanned_book_id, NULL AS scanned_series_id, series_name, issue_number, volume_year
    FROM event_issues WHERE id = ? AND event_id = ?`).get(Number(issue), String(owner));
  if (kind === 'run') return db.prepare(`SELECT id, cv_issue_id, CAST(scanned_book_id AS TEXT) AS scanned_book_id, NULL AS scanned_series_id, series_name, issue_number, volume_year
    FROM canon_run_issues WHERE id = ? AND run_id = ?`).get(Number(issue), Number(owner));
  return null;
}
async function editorAcquirePlan(row, volumeOpts = {}) {
  if (row.scanned_book_id && db.prepare('SELECT 1 FROM scanned_books WHERE id = ?').get(String(row.scanned_book_id))) return { state: 'owned' };
  const m = downloadRequests.monitoredFor(row);
  if (m) return { state: 'monitored', ...m };
  // Library folders of this series (same name; same volume year when both are known).
  const norm = t => String(t || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
  const want = norm(row.series_name), n = IN.normIssueNumber(String(row.issue_number ?? ''));
  const cands = db.prepare('SELECT id, name, year FROM scanned_series WHERE series_json IS NOT NULL').all()
    .filter(x => String(x.id) === String(row.scanned_series_id || '') || (norm(x.name) === want && (!row.volume_year || !x.year || String(x.year) === String(row.volume_year))))
    .sort((a, b) => (String(b.id) === String(row.scanned_series_id || '')) - (String(a.id) === String(row.scanned_series_id || '')));
  for (const x of cands.slice(0, 4)) {
    let c; try { c = await fillContext(x.id, volumeOpts); } catch (e) { continue; }
    if (c.status) continue;
    const hit = c.rows.find(r => r.state === 'missing' && (row.cv_issue_id ? String(r.id) === String(row.cv_issue_id) : IN.normIssueNumber(String(r.number)) === n));
    if (hit) return { state: 'fill', scanned_id: String(x.id), folder: `${x.name}${x.year ? ` (${x.year})` : ''}`, cv_issue_id: hit.id, series_name: c.meta.name || x.name };
    const has = c.rows.find(r => (row.cv_issue_id ? String(r.id) === String(row.cv_issue_id) : IN.normIssueNumber(String(r.number)) === n));
    if (has && has.state === 'wanted') return { state: 'monitored', series_id: c.volId, series_name: c.meta.name || x.name, issue_id: has.id, status: 'wanted' };
  }
  return { state: 'add', search: row.series_name || '' };
}
app.get('/api/editor/acquire/:kind/:owner/:issue', requireAdmin, async (req, res) => {
  try {
    const row = editorIssueRow(req.params.kind, req.params.owner, req.params.issue);
    if (!row) return res.status(404).json({ error: 'Issue not found' });
    res.json(await editorAcquirePlan(row));
  } catch (e) { logger.error('editor', 'Acquire plan failed', e.message); res.status(500).json({ error: e.message }); }
});
app.post('/api/editor/acquire/:kind/:owner/:issue', requireAdmin, async (req, res) => {
  try {
    const row = editorIssueRow(req.params.kind, req.params.owner, req.params.issue);
    if (!row) return res.status(404).json({ error: 'Issue not found' });
    const plan = await editorAcquirePlan(row), action = req.body?.action;
    if (action === 'wanted' && plan.state === 'monitored') {
      const changed = db.prepare(`UPDATE monitored_issues SET status = 'wanted', retry_after = NULL WHERE id = ? AND series_id = ? AND status IN ('skipped','failed')`).run(plan.issue_id, plan.series_id).changes;
      logger.info('editor', `Marked wanted: ${row.series_name} #${row.issue_number}`, { series: plan.series_id, changed });
      setImmediate(() => { try { const r = startAutoGrab(plan.series_id); if (r && r.status) logger.warn('editor', `Auto-grab refused: ${r.error}`); } catch (e) { logger.warn('editor', 'Auto-grab failed to start', e.message); } });
      return res.json({ ok: true, plan: { ...plan, status: 'wanted' } });
    }
    if (action === 'fill' && plan.state === 'fill') {
      const r = await fillMissing(plan.scanned_id, [plan.cv_issue_id], true);
      if (r.status) return res.status(r.status).json({ error: r.error });
      return res.json({ ok: true, plan: { state: 'monitored', series_id: null, series_name: plan.series_name, status: 'wanted' }, directory: r.directory });
    }
    res.status(409).json({ error: 'That is no longer possible for this issue. Close and reopen it.', plan });
  } catch (e) { logger.error('editor', 'Acquire failed', e.message); res.status(500).json({ error: e.message }); }
});

// Remove Fill-made entries once their picks are done. Only entries Fill
// created (fill_auto_remove = 1), only ended series, not within 30 minutes of
// the fill, and not while any issue is wanted or in flight.
function runFillAutoRemove() {
  const rows = db.prepare(`SELECT id, name FROM monitored_series ms
    WHERE fill_auto_remove = 1 AND series_status = 'ended'
      AND (fill_started_at IS NULL OR fill_started_at <= datetime('now', '-30 minutes'))
      AND NOT EXISTS (SELECT 1 FROM monitored_issues mi WHERE mi.series_id = ms.id AND mi.status IN ('wanted','snatched','downloaded','processing','failed'))`).all();
  for (const r of rows) {
    if ([...activeDownloads.keys()].some(k => String(k).startsWith(`auto-grab-${r.id}-`))) continue;
    try {
      const done = db.prepare(`SELECT COUNT(*) AS n FROM monitored_issues WHERE series_id = ? AND status = 'processed'`).get(r.id).n;
      removeMonitoredSeriesRows(r.id);
      logger.info('fill', `Fill done: removed "${r.name}" from the download manager`, { id: r.id, processed: done });
    } catch (e) { logger.warn('fill', `Auto-remove failed for "${r.name}"`, e.message); }
  }
}
setInterval(() => { try { runFillAutoRemove(); } catch (e) { logger.warn('fill', 'Auto-remove check failed', e.message); } }, 30 * 60 * 1000);


app.post('/api/monitor/series/:id/issues/:issueId/reset', requireDownloadAccess, (req, res) => {
  const { issueId } = req.params;
  const issue = db.prepare('SELECT * FROM monitored_issues WHERE id = ?').get(issueId);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });
  if (['wanted', 'processed'].includes(issue.status)) {
    return res.status(400).json({ error: `Issue is already ${issue.status}` });
  }
  // Clear blacklist so all sources are eligible again
  db.prepare('DELETE FROM download_blacklist WHERE issue_id = ?').run(issueId);
  db.prepare(`
    UPDATE monitored_issues
    SET status = 'wanted', download_id = NULL, file_path = NULL,
        download_url = NULL, fail_count = 0, last_fail_reason = NULL,
        date_processed = NULL, retry_after = NULL, retry_epoch = NULL, weekly_retries = 0
    WHERE id = ?
  `).run(issueId);
  logger.info('reset', `Issue ${issueId} reset to wanted + blacklist cleared (was: ${issue.status})`);
  res.json({ success: true });
});

// ─── SABnzbd completion watcher ───────────────────────────────────
// Two-phase loop every 60s:
//   Phase 1 — check 'snatched' items against SABnzbd history
//             Completed → mark 'downloaded' (stores file path)
//             Failed    → reset to 'wanted' so user can re-grab
//   Phase 2 — run post-processor on all 'downloaded' items
//             Success → mark 'processed'
//             Failure → leave as 'downloaded', retry next tick automatically
// ─── Dead torrent detection (issues and packs) ───────────────────
// A torrent is dead when qBittorrent reports an error, when it has made no
// download progress for QBT_STALL_HOURS (no seeders: state stalledDL, or
// metaDL when it never got metadata), or when it has vanished from qBittorrent
// for QBT_MISSING_GRACE_MS (removed by hand). Paused/stopped and queued
// torrents are never counted as stalled. Dead torrents are removed from
// qBittorrent (partial data kept on disk) and the issue goes through the same
// retry path as GetComics and Usenet failures.
const QBT_STALL_HOURS      = 48;
const QBT_MISSING_GRACE_MS = 30 * 60 * 1000;
const QBT_STALL_STATES     = new Set(['stalledDL', 'metaDL', 'forcedMetaDL']);
const qbtMissingSince      = new Map();   // hash → first time it was not found
function qbtLastProgressMs(t) {
  return Math.max(t?.last_activity || 0, t?.added_on || 0) * 1000;
}
function qbtDeadReason(t, hash) {
  if (!t) {
    const first = qbtMissingSince.get(hash) || Date.now();
    qbtMissingSince.set(hash, first);
    return Date.now() - first > QBT_MISSING_GRACE_MS ? 'Torrent no longer in qBittorrent' : null;
  }
  qbtMissingSince.delete(hash);
  if (t.state === 'error' || t.state === 'missingFiles') return `qBittorrent: ${t.state}`;
  if (QBT_STALL_STATES.has(t.state) && (t.progress || 0) < 1) {
    const last = qbtLastProgressMs(t);
    const hours = last ? (Date.now() - last) / 3600000 : 0;
    if (hours >= QBT_STALL_HOURS) {
      return `qBittorrent: stalled, no download progress for ${Math.floor(hours)} h (${Math.round((t.progress || 0) * 100)}% done)`;
    }
  }
  return null;
}
async function qbtRemoveTorrent(url, qbtHeaders, hash) {
  try {
    await axios.post(`${url}/api/v2/torrents/delete`, `hashes=${encodeURIComponent(hash)}&deleteFiles=false`, {
      headers: { ...qbtHeaders, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000,
    });
    logger.info('watcher', `Removed dead torrent ${hash} from qBittorrent (partial data kept)`);
  } catch (e) {
    logger.warn('watcher', `Could not remove torrent ${hash} from qBittorrent`, e.message);
  }
}

let watcherBusy = false;

// SAB statuses that mean "still working, don't touch". Anything NOT in this set
// and NOT 'Completed' is a real failure. Historically we only whitelisted
// Downloading/Queued/Paused/Checking, which caused 'Extracting' / 'Verifying' /
// 'Repairing' jobs to be wrongly marked as failed mid-unpack.
// Full list cross-referenced with SAB API docs + status filter UI.
const SAB_IN_PROGRESS = new Set([
  'Downloading', 'Queued', 'Paused', 'Checking',
  'Extracting', 'Verifying', 'Repairing', 'Moving',
  'QuickCheck', 'Running', 'Fetching', 'Propagating',
  'Grabbing',
]);

// DDL issues whose download job is post-processing them right now.
const ddlPostProcessing = new Set();

async function runCompletionWatcher() {
  if (watcherBusy) return;
  watcherBusy = true;
  try {

    // ── Phase 1: snatched → downloaded ──────────────────────────────
    const snatched = db.prepare(`
      SELECT i.*, s.name AS series_name, s.publisher, s.year, s.directory
      FROM monitored_issues i
      JOIN monitored_series s ON s.id = i.series_id
      WHERE i.status = 'snatched' AND i.download_id IS NOT NULL
        AND i.download_id != 'ddl'
    `).all();

    // Fetch SABnzbd history once — reused by Phase 1 and Phase 3
    let historySlots = null;

    if (snatched.length) {
      // Split snatched issues by source. download_id starts with 'qbt_' for
      // qBit-routed comic torrents; everything else is a SAB nzo_id.
      const sabSnatched = snatched.filter(i => !String(i.download_id).startsWith('qbt_'));
      const qbtSnatched = snatched.filter(i =>  String(i.download_id).startsWith('qbt_'));

      // ── SAB completion check ──
      if (sabSnatched.length) {
        const sabUrl = getSetting('sabnzbd_url')     || SABNZBD_URL;
        const sabKey = getSetting('sabnzbd_api_key') || SABNZBD_API_KEY;

        const r = await axios.get(`${sabUrl}/api`, {
          params: { apikey: sabKey, mode: 'history', output: 'json', limit: 200 },
          timeout: 10000,
        });
        historySlots = r.data?.history?.slots || [];

        for (const issue of sabSnatched) {
          const slot = historySlots.find(s => s.nzo_id === issue.download_id);
          if (!slot) continue;

          logger.debug('watcher', `Phase1: slot for issue ${issue.id}`, { status: slot.status });

          if (slot.status === 'Completed') {
            // Store the file path from SABnzbd so Phase 2 knows where to find it
            db.prepare(`UPDATE monitored_issues SET status = 'downloaded', file_path = ?, retry_after = NULL WHERE id = ?`)
              .run(slot.storage, issue.id);
            logger.info('watcher', `Issue ${issue.id} downloaded`, { storage: slot.storage });
          } else if (!SAB_IN_PROGRESS.has(slot.status)) {
            // Any status that isn't Completed and isn't an in-progress state is a
            // real failure (Failed, Aborted, etc.). See SAB_IN_PROGRESS for the
            // full list of recognized in-progress states.
            logger.warn('watcher', `SABnzbd job failed for issue ${issue.id}`, { nzo_id: issue.download_id, status: slot.status });
            const failedUrl = issue.download_url || null;
            const seriesForRetry = { id: issue.series_id, name: issue.series_name, publisher: issue.publisher, year: issue.year, directory: issue.directory };
            // Reset first so retry sees clean state
            db.prepare(`UPDATE monitored_issues SET status='wanted', download_id=NULL, file_path=NULL WHERE id=?`).run(issue.id);
            setImmediate(async () => {
              try { await blacklistAndRetry({ ...issue, status: 'wanted' }, seriesForRetry, failedUrl, `SABnzbd: ${slot.status}`); }
              catch (e) { logger.error('retry', `watcher blacklistAndRetry failed for ${issue.id}`, e.message); }
            });
          }
        }
      }

      // ── qBit completion check (single issue) ──
      // Same shape as SAB block above but querying qBit's torrents/info API.
      // Dead torrents (error, stalled 48 h, or removed) are removed from qBit
      // and go through blacklistAndRetry, which tries GetComics/Usenet next.
      // Before 2026-10-08 errors were marked failed with no retry, and stalled
      // torrents stayed 'snatched' forever.
      if (qbtSnatched.length) {
        try {
          const { url, qbtHeaders } = await qbtLogin();
          const r = await axios.get(`${url}/api/v2/torrents/info`, {
            headers: qbtHeaders,
            timeout: 5000,
          });
          const torrents = r.data || [];
          const completedStates = new Set(['uploading', 'pausedUP', 'stalledUP', 'queuedUP', 'forcedUP', 'checkingUP']);
          for (const issue of qbtSnatched) {
            const hash = String(issue.download_id).replace('qbt_', '').toLowerCase();
            const t = torrents.find(x => x.hash?.toLowerCase() === hash);
            const isComplete = t && ((t.progress >= 1) || completedStates.has(t.state));
            const deadReason = isComplete ? null : qbtDeadReason(t, hash);
            if (isComplete) {
              const filePath = t.content_path || t.save_path;
              db.prepare(`UPDATE monitored_issues SET status = 'downloaded', file_path = ?, retry_after = NULL WHERE id = ?`)
                .run(filePath, issue.id);
              logger.info('watcher', `Issue ${issue.id} downloaded (qBit)`, { hash, content_path: filePath });
            } else if (deadReason) {
              logger.warn('watcher', `qBit torrent dead for issue ${issue.id}`, { hash, state: t?.state, reason: deadReason });
              if (t) await qbtRemoveTorrent(url, qbtHeaders, hash);
              qbtMissingSince.delete(hash);
              const failedUrl = issue.download_url || null;
              const seriesForRetry = { id: issue.series_id, name: issue.series_name, publisher: issue.publisher, year: issue.year, directory: issue.directory };
              db.prepare(`UPDATE monitored_issues SET status='wanted', download_id=NULL, file_path=NULL WHERE id=?`).run(issue.id);
              setImmediate(async () => {
                try { await blacklistAndRetry({ ...issue, status: 'wanted' }, seriesForRetry, failedUrl, deadReason); }
                catch (e) { logger.error('retry', `watcher blacklistAndRetry failed for ${issue.id}`, e.message); }
              });
            }
          }
        } catch (e) {
          logger.warn('watcher', 'qBit issue status check failed', e.message);
        }
      }
    }

    // ── Phase 2: downloaded → processed ─────────────────────────────
    // Includes DDL issues stuck as 'downloaded' for >10 minutes (runDdlDownload crashed mid-flight)
    const downloaded = db.prepare(`
      SELECT i.*, s.name AS series_name, s.publisher, s.year, s.directory
      FROM monitored_issues i
      JOIN monitored_series s ON s.id = i.series_id
      WHERE i.status = 'downloaded' AND i.file_path IS NOT NULL
        AND (i.retry_after IS NULL OR i.retry_after <= datetime('now'))
    `).all()
      // A DDL issue is post-processed by its own download job. Skip only while
      // that job is running in this process; after a restart (or a crash of the
      // job) the watcher resumes it. The old date_processed test never matched
      // because DDL downloads leave date_processed NULL.
      .filter(i => i.download_id !== 'ddl' || !ddlPostProcessing.has(i.id));

    for (const issue of downloaded) {
      // Fetch the full series row so parent_series_id and all other fields are available
      const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(issue.series_id) || {
        id:        issue.series_id,
        name:      issue.series_name,
        publisher: issue.publisher,
        year:      issue.year,
        directory: issue.directory,
      };
      await asArrival('postprocess', () => postProcess(issue, series, issue.file_path));
    }

    // ── Phase 3: pack snatched → downloaded ──────────────────────────
    const snatchedPacks = db.prepare(`
      SELECT p.*, s.name, s.publisher, s.year, s.directory
      FROM series_packs p
      JOIN monitored_series s ON s.id = p.series_id
      WHERE p.status = 'snatched' AND p.download_id IS NOT NULL
    `).all();

    if (snatchedPacks.length) {
      // Split packs by source — SAB packs have download_id starting with the
      // SAB nzo_id, qBit packs start with 'qbt_'. The two sources need to be
      // queried independently because their status APIs are different.
      const sabPacks = snatchedPacks.filter(p => !String(p.download_id).startsWith('qbt_'));
      const qbtPacks = snatchedPacks.filter(p =>  String(p.download_id).startsWith('qbt_'));

      // ── SAB pack status check ──
      if (sabPacks.length) {
        // Reuse already-fetched history if available, else fetch
        let packHistory = historySlots;
        if (!packHistory) {
          const sabUrl = getSetting('sabnzbd_url')     || SABNZBD_URL;
          const sabKey = getSetting('sabnzbd_api_key') || SABNZBD_API_KEY;
          const pr = await axios.get(`${sabUrl}/api`, {
            params: { apikey: sabKey, mode: 'history', output: 'json', limit: 200 },
            timeout: 10000,
          });
          packHistory = pr.data?.history?.slots || [];
        }

        for (const pack of sabPacks) {
          const slot = packHistory.find(s => s.nzo_id === pack.download_id);
          if (!slot) continue;
          if (slot.status === 'Completed') {
            db.prepare(`UPDATE series_packs SET status = 'downloaded', file_path = ? WHERE id = ?`)
              .run(slot.storage, pack.id);
            logger.info('watcher', `Pack ${pack.id} downloaded (SAB)`, { storage: slot.storage });
          } else if (!SAB_IN_PROGRESS.has(slot.status)) {
            logger.warn('watcher', `Pack ${pack.id} SABnzbd job failed`, { status: slot.status });
            db.prepare(`UPDATE series_packs SET status = 'failed' WHERE id = ?`).run(pack.id);
          }
        }
      }

      // ── qBit comic torrent pack status check ──
      // Mirrors the SAB completion check but uses qBit's torrents/info API.
      // qBit returns content_path which points to either a single file or
      // the pack directory — pack post-processor handles both shapes.
      if (qbtPacks.length) {
        try {
          const { url, qbtHeaders } = await qbtLogin();
          const r = await axios.get(`${url}/api/v2/torrents/info`, {
            headers: qbtHeaders,
            timeout: 5000,
          });
          const torrents = r.data || [];
          for (const pack of qbtPacks) {
            const hash = String(pack.download_id).replace('qbt_', '').toLowerCase();
            const t = torrents.find(x => x.hash?.toLowerCase() === hash);
            if (!t) {
              const gone = qbtDeadReason(null, hash);
              if (gone) {
                logger.warn('watcher', `Pack ${pack.id} torrent gone from qBit`, { hash });
                qbtMissingSince.delete(hash);
                db.prepare(`UPDATE series_packs SET status = 'failed' WHERE id = ?`).run(pack.id);
              }
              continue;
            }
            // qBit progress is 0..1 — completed = 1.0, or the state is 'pausedUP'/'uploading'/'stalledUP'
            // (i.e. seeding states implying download is done). Don't trip on 'pausedDL' or 'error'.
            const completedStates = new Set(['uploading', 'pausedUP', 'stalledUP', 'queuedUP', 'forcedUP', 'checkingUP']);
            const isComplete = (t.progress >= 1) || completedStates.has(t.state);
            const deadReason = isComplete ? null : qbtDeadReason(t, hash);
            if (isComplete) {
              const filePath = t.content_path || t.save_path;
              db.prepare(`UPDATE series_packs SET status = 'downloaded', file_path = ? WHERE id = ?`)
                .run(filePath, pack.id);
              logger.info('watcher', `Pack ${pack.id} downloaded (qBit)`, { hash, content_path: filePath });
            } else if (deadReason) {
              // Packs have no automatic fallback source; mark failed and clean up.
              logger.warn('watcher', `Pack ${pack.id} qBit torrent dead`, { state: t.state, reason: deadReason });
              await qbtRemoveTorrent(url, qbtHeaders, hash);
              db.prepare(`UPDATE series_packs SET status = 'failed' WHERE id = ?`).run(pack.id);
            }
          }
        } catch (e) {
          logger.warn('watcher', 'qBit pack status check failed', e.message);
        }
      }
    }

    // ── Phase 4: pack downloaded → processed ─────────────────────────
    // Packs that failed only because metadata work was held go back in the
    // queue as soon as the hold is gone.
    if (!metadataRuntime.status().length) {
      const requeued = db.prepare(`UPDATE series_packs SET status = 'downloaded', fail_reason = NULL
        WHERE status = 'failed' AND fail_reason = 'LIBRARY_RECOVERY_REQUIRED' AND file_path IS NOT NULL`).run().changes;
      if (requeued) logger.info('pack-process', `Re-queued ${requeued} pack(s) held by interrupted metadata work`);
    }
    const downloadedPacks = db.prepare(`
      SELECT p.*, s.name, s.publisher, s.year, s.directory
      FROM series_packs p
      JOIN monitored_series s ON s.id = p.series_id
      WHERE p.status = 'downloaded' AND p.file_path IS NOT NULL
        AND (p.retry_after IS NULL OR p.retry_after <= datetime('now'))
    `).all();

    for (const pack of downloadedPacks) {
      const series = {
        id:        pack.series_id,
        name:      pack.name,
        publisher: pack.publisher,
        year:      pack.year,
        directory: pack.directory,
      };
      db.prepare(`UPDATE series_packs SET status = 'processing' WHERE id = ?`).run(pack.id);
      await asArrival('pack-process', () => postProcessPack(pack, series));
    }

  } catch (e) {
    logger.error('watcher', 'Completion check error', e.message);
  } finally {
    watcherBusy = false;
  }
}

// A restart mid-pack leaves it 'processing' forever; put it back in the queue.
try {
  const n = db.prepare(`UPDATE series_packs SET status = 'downloaded' WHERE status = 'processing' AND file_path IS NOT NULL`).run().changes;
  if (n) logger.info('pack-process', `Resuming ${n} pack(s) interrupted by a restart`);
} catch (e) { logger.warn('pack-process', 'Could not resume interrupted packs', e.message); }

// Start watcher after 30s delay (let server fully start), then every 60s
setTimeout(() => {
  runCompletionWatcher();
  setInterval(runCompletionWatcher, 30 * 1000);
}, 30 * 1000);

// ─── Download progress poller ─────────────────────────────────────
// Polls SABnzbd queue and qBittorrent for in-progress downloads every 8s
// and pushes updates to the SSE stream so the frontend toast panel stays live.
async function pollDownloadProgress() {
  // Get all snatched issues so we know what to look for
  const snatched = db.prepare(`
    SELECT i.*, s.name AS series_name
    FROM monitored_issues i
    JOIN monitored_series s ON s.id = i.series_id
    WHERE i.status = 'snatched' AND i.download_id IS NOT NULL AND i.download_id != 'ddl'
  `).all();

  if (!snatched.length) return;

  const sabIssues = snatched.filter(i => !i.download_id.startsWith('qbt_'));
  const qbtIssues = snatched.filter(i => i.download_id.startsWith('qbt_'));

  // ── SABnzbd queue polling ──────────────────────────────────────
  if (sabIssues.length) {
    try {
      const sabUrl = getSetting('sabnzbd_url') || SABNZBD_URL;
      const sabKey = getSetting('sabnzbd_api_key') || SABNZBD_API_KEY;
      const r = await axios.get(`${sabUrl}/api`, {
        params: { apikey: sabKey, mode: 'queue', output: 'json' },
        timeout: 5000,
      });
      const slots = r.data?.queue?.slots || [];
      for (const issue of sabIssues) {
        const slot = slots.find(s => s.nzo_id === issue.download_id);
        if (!slot) continue;
        const pct = parseFloat(slot.percentage) || 0;
        const totalBytes = parseFloat(slot.mb) * 1024 * 1024 || 0;
        const bytesReceived = totalBytes * (pct / 100);
        const dlId = `sab-${issue.download_id}`;
        const entry = {
          id: dlId,
          filename: slot.filename || issue.series_name,
          seriesName: issue.series_name,
          bytesReceived: Math.round(bytesReceived),
          totalBytes: Math.round(totalBytes),
          status: 'downloading',
          source: 'sabnzbd',
          startedAt: activeDownloads.get(dlId)?.startedAt || new Date().toISOString(),
        };
        activeDownloads.set(dlId, entry);
        pushDownloadUpdate({ ...entry });
      }
      // Clean up completed SABnzbd entries no longer in queue
      let anyCompleted = false;
      for (const [id, dl] of activeDownloads) {
        if (dl.source !== 'sabnzbd') continue;
        const nzoId = id.replace('sab-', '');
        if (!slots.find(s => s.nzo_id === nzoId)) {
          // Push 'complete' first so the toast shows a finished state,
          // then remove after a short delay so the user can see it.
          const completedEntry = {
            ...dl,
            status: 'complete',
            bytesReceived: dl.totalBytes || dl.bytesReceived,
            filename: dl.filename || dl.seriesName,
          };
          activeDownloads.set(id, completedEntry);
          pushDownloadUpdate({ ...completedEntry });
          setTimeout(() => {
            activeDownloads.delete(id);
            pushDownloadUpdate({ id, status: 'removed' });
          }, 8000);
          anyCompleted = true;
        }
      }
      // If any SABnzbd job just finished, kick the watcher immediately
      // instead of waiting up to 60 seconds for the next scheduled run
      if (anyCompleted) setImmediate(runCompletionWatcher);
    } catch (e) {
      logger.debug('progress-poll', 'SABnzbd queue poll failed', e.message);
    }
  }

  // ── qBittorrent polling ────────────────────────────────────────
  if (qbtIssues.length) {
    try {
      const { url, cookie, qbtHeaders } = await qbtLogin();
      const r = await axios.get(`${url}/api/v2/torrents/info`, {
        headers: qbtHeaders,
        timeout: 5000,
      });
      const torrents = r.data || [];
      for (const issue of qbtIssues) {
        // qBittorrent hash is stored as 'qbt_HASH'
        const hash = issue.download_id.replace('qbt_', '').toLowerCase();
        const torrent = torrents.find(t => t.hash?.toLowerCase() === hash);
        if (!torrent) continue;
        const dlId = `qbt_${hash}`;
        const entry = {
          id: dlId,
          filename: torrent.name || issue.series_name,
          seriesName: issue.series_name,
          bytesReceived: torrent.completed || 0,
          totalBytes: torrent.size || 0,
          status: 'downloading',
          source: 'qbittorrent',
          qbtState: torrent.state,
          stalledSince: QBT_STALL_STATES.has(torrent.state) ? (qbtLastProgressMs(torrent) || null) : null,
          stallLimitHours: QBT_STALL_HOURS,
          startedAt: activeDownloads.get(dlId)?.startedAt || new Date().toISOString(),
        };
        activeDownloads.set(dlId, entry);
        pushDownloadUpdate({ ...entry });
      }
      // Clean up completed qBittorrent entries
      for (const [id, dl] of activeDownloads) {
        if (dl.source !== 'qbittorrent') continue;
        const hash = id.replace('qbt_', '').toLowerCase();
        const torrent = torrents.find(t => t.hash?.toLowerCase() === hash);
        if (!torrent || torrent.progress >= 1) {
          activeDownloads.delete(id);
          pushDownloadUpdate({ id, status: 'removed' });
        }
      }
    } catch (e) {
      logger.debug('progress-poll', 'qBittorrent poll failed', e.message);
    }
  }
}

// Start progress poller after 35s, then every 8s
setTimeout(() => {
  setInterval(pollDownloadProgress, 8000);
}, 35 * 1000);

// ─── Series status backfill: series.json → DB ────────────────────
// Resolves 'unknown' series_status rows by reading series.json (fast, no API).
// Also rescues mis-stamped 'ended' series that have recent issues.
// Runs at startup and then every 30 minutes so newly added series get
// their status set without requiring a server restart.
function runSeriesStatusBackfill(label = 'Periodic') {
  // Pass 1: resolve unknowns from series.json
  const unknown = db.prepare(`SELECT id, directory FROM monitored_series WHERE series_status = 'unknown' OR series_status IS NULL`).all();
  let updated = 0;
  for (const s of unknown) {
    const status = deriveStatusFromSeriesJson(s.directory);
    if (status) {
      db.prepare(`UPDATE monitored_series SET series_status = ? WHERE id = ?`).run(status, s.id);
      updated++;
    }
  }
  if (unknown.length > 0 && updated > 0) {
    logger.info('series-status', `${label} backfill: ${updated}/${unknown.length} unknown series resolved from series.json`);
  }

  // Pass 2: rescue mis-stamped 'ended' series that have recent issues.
  // A series with an issue dated within the last 120 days cannot credibly be
  // ended — reset it to 'ongoing' so the weekly cron re-evaluates it. Series
  // that Metron confirmed finished are left alone (2026-10-28).
  try {
    const ended = db.prepare(`SELECT id, name FROM monitored_series WHERE series_status = 'ended' AND status = 'active' AND COALESCE(series_status_source, '') <> 'metron'`).all();
    const eighteenMonthsAgo = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let rescued = 0;
    for (const s of ended) {
      const recent = db.prepare(`
        SELECT 1 FROM monitored_issues
        WHERE series_id = ? AND COALESCE(store_date, release_date) >= ?
        LIMIT 1
      `).get(s.id, eighteenMonthsAgo);
      if (recent) {
        db.prepare(`UPDATE monitored_series SET series_status = 'ongoing' WHERE id = ?`).run(s.id);
        rescued++;
        logger.info('series-status', `Rescued mis-stamped series: "${s.name}" ended → ongoing`);
      }
    }
    if (rescued > 0) logger.info('series-status', `${label} rescue: ${rescued} series reset from ended → ongoing`);
  } catch (e) {
    logger.warn('series-status', `${label} rescue pass failed`, e.message);
  }
}

// Run at startup (immediate) then every 30 minutes.
setImmediate(() => runSeriesStatusBackfill('Startup'));
setInterval(() => runSeriesStatusBackfill('Periodic'), 30 * 60 * 1000);

// ─── Library scan scheduler (every 15 minutes) ───────────────────
// Checks all libraries with scan_interval_hours > 0. If enough time
// has elapsed since last_scanned_at, fires a scan for that library.
// One library per tick to avoid stacking scans.
setInterval(() => {
  if (scanState.running) return;
  const libs = db.prepare('SELECT * FROM libraries WHERE scan_interval_hours > 0').all();
  for (const lib of libs) {
    const intervalMs = lib.scan_interval_hours * 60 * 60 * 1000;
    const lastMs = lib.last_scanned_at ? new Date(lib.last_scanned_at).getTime() : 0;
    if (Date.now() - lastMs >= intervalMs) {
      logger.info('scanner', `Scheduled scan triggered for "${lib.name}"`, { interval: `${lib.scan_interval_hours}h` });
      setImmediate(() => runLibraryScan(lib).catch(e => logger.warn('scan', 'Scan deferred', e.message)));
      break; // one library per tick
    }
  }
}, 15 * 60 * 1000);

// ─── CV poller (weekly) ───────────────────────────────────────────
const libraryStatus = require('./libraryStatus');
let cvPollStartedAt = 0;   // while the weekly poll runs, the library status check stands aside
// Every Monday at 03:00, check each active monitored series for new
// CV issues not yet in our DB. Respects the 2 req/sec CV rate limit.
cron.schedule('0 3 * * 2', async () => {
  logger.info('cvpoller', 'Weekly CV poll starting (Tuesday catch-all)');
  const CV_API_KEY = getCVKey();

  // Least recently checked first, and when the hourly allowance runs out the poll waits for it to
  // reset and carries on (2026-11-12): it used to fail the rest of the list, always the same series.
  cvPollStartedAt = Date.now();
  const pollWait = { waits: 0 };
  const activeSeries = db.prepare(`SELECT * FROM monitored_series WHERE status = 'active' AND (series_status = 'ongoing' OR series_status = 'unknown' OR series_status IS NULL)
    ORDER BY last_cv_check IS NOT NULL, last_cv_check ASC`).all();
  logger.info('cvpoller', `Checking ${activeSeries.length} active non-ended series`);
  // Metron is the second opinion on each series' status (seriesStatus.js); off without a token or after it refuses.
  let metronOn = !!(getSetting('metron_api_token') || process.env.METRON_API_TOKEN);

  for (let pi = 0; pi < activeSeries.length; pi++) {
    const series = activeSeries[pi];
    try {
      let offset = 0;
      let fetched = 0;
      let newCount = 0;

      while (true) {
        const r = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
          params: {
            api_key: getCVKey(), format: 'json',
            filter: `volume:${series.id}`,
            field_list: 'id,issue_number,name,cover_date,store_date,site_detail_url,description,person_credits,character_credits,team_credits,location_credits',
            offset, limit: 100,
          },
          headers: { 'User-Agent': 'Omnibus/1.0' },
        });

        const results   = r.data.results || [];
        const total     = r.data.number_of_total_results || 0;
        const isAnnualCV = (num, name) => {
          const s = ((num || '') + ' ' + (name || '')).toLowerCase();
          return s.includes('annual') ? 1 : 0;
        };
        const insertIssue = db.prepare(`
          INSERT OR IGNORE INTO monitored_issues (id, series_id, issue_number, title, release_date, store_date, cv_data, is_annual)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const txn = db.transaction(issues => {
          for (const i of issues) {
            const canonNum = IN.normIssueNumber(i.issue_number) || '0';
            const info = insertIssue.run(
              String(i.id), series.id, canonNum,
              i.name || null, i.cover_date || null, i.store_date || null,
              JSON.stringify(i),
              isAnnualCV(i.issue_number, i.name)
            );
            if (info.changes > 0) newCount++;
          }
        });
        txn(results);

        fetched += results.length;
        if (fetched >= total || results.length === 0) break;
        offset += 100;
        await new Promise(resolve => setTimeout(resolve, 600)); // ~1.6 req/sec within CV limit
      }

      // Update last_cv_check and total_issues
      db.prepare(`
        UPDATE monitored_series
        SET last_cv_check = datetime('now'),
            total_issues  = (SELECT COUNT(*) FROM monitored_issues WHERE series_id = ?)
        WHERE id = ?
      `).run(series.id, series.id);

      if (newCount > 0) logger.info('cvpoller', `${series.name}: +${newCount} new issues`);

      // Re-derive series_status from the freshly synced issues, with Metron as a second
      // opinion (rules in seriesStatus.js; the old "final issue / finale" title test is gone).
      try {
        const held = db.prepare(`SELECT MAX(COALESCE(store_date, release_date)) AS d, COUNT(*) AS n FROM monitored_issues WHERE series_id = ?`).get(series.id);
        let m = null;
        if (metronOn) {
          try {
            m = await metron.seriesStatus(series.id, { name: series.name, year: series.year, knownId: series.metron_series_id });
            if (m && m.id !== series.metron_series_id) db.prepare('UPDATE monitored_series SET metron_series_id = ? WHERE id = ?').run(m.id, series.id);
          } catch (e) {
            logger.warn('cvpoller', `Metron status check failed for "${series.name}"`, e.message);
            if (e.code === 'METRON_AUTH' || e.code === 'METRON_TOKEN_MISSING') metronOn = false;
          }
        }
        const v = seriesStatusLib.decideSeriesStatus({ newCount, latestDate: held?.d || null, issueCount: held?.n || 0, metron: m });
        db.prepare(`UPDATE monitored_series SET series_status = ?, series_status_source = ? WHERE id = ?`)
          .run(v.status, v.source, series.id);
        if (v.status !== series.series_status) {
          logger.info('cvpoller', `${series.name}: series_status ${series.series_status} → ${v.status} (${v.reason})`);
        }
      } catch (e) {
        logger.warn('cvpoller', `Status re-derive failed for "${series.name}"`, e.message);
      }

      // G1 backstop — sync disk state so files that landed since last refresh
      // are marked processed. Catches post-processor failures and user error.
      try {
        const dr = await runRefreshDirectory(series.id);
        if (dr.matched > 0) logger.info('cvpoller', `${series.name}: ${dr.matched} files matched on disk`);
      } catch (e) {
        logger.warn('cvpoller', `Disk refresh failed for "${series.name}"`, e.message);
      }

      // ComicInfo refresh for recent issues now runs in the daily retag rotation
      // (shared metadata maintenance), which checks eligible books within provider limits.

      await new Promise(resolve => setTimeout(resolve, 600)); // rate limit between series
    } catch (e) {
      if (await libraryStatus.waitForCvReset(e, pollWait, { sleep: sleepMs, logger })) { pi--; continue; }
      logger.error('cvpoller', `Failed for series ${series.id} (${series.name})`, e.message);
    }
  }
  // Also poll linked annual volumes
  const annualLinks = db.prepare(`
    SELECT DISTINCT l.annual_series_id, s.name, s.directory
    FROM series_annual_links l
    JOIN monitored_series s ON s.id = l.annual_series_id
    WHERE s.status = 'active' AND (s.series_status = 'ongoing' OR s.series_status = 'unknown' OR s.series_status IS NULL)
  `).all();

  logger.info('cvpoller', `Checking ${annualLinks.length} linked annual volumes`);

  for (let ai = 0; ai < annualLinks.length; ai++) {
    const annual = annualLinks[ai];
    try {
      let offset = 0, fetched = 0, newCount = 0, total = Infinity;
      while (fetched < total) {
        const r = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
          params: {
            api_key: getCVKey(), format: 'json',
            filter: `volume:${annual.annual_series_id}`,
            field_list: 'id,issue_number,name,cover_date,store_date,site_detail_url,description,person_credits,character_credits,team_credits,location_credits',
            offset, limit: 100,
          },
          headers: { 'User-Agent': 'Omnibus/1.0' },
        });
        total = r.data.number_of_total_results || 0;
        const results = r.data.results || [];
        const insertIssue = db.prepare(`
          INSERT OR IGNORE INTO monitored_issues
            (id, series_id, issue_number, title, release_date, store_date, cv_data, is_annual)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        `);
        db.transaction(issues => {
          for (const i of issues) {
            const info = insertIssue.run(String(i.id), annual.annual_series_id,
              i.issue_number || '0', i.name || null,
              i.cover_date || null, i.store_date || null, JSON.stringify(i));
            if (info.changes > 0) newCount++;
          }
        })(results);
        fetched += results.length;
        if (!results.length) break;
        offset += 100;
        await new Promise(r => setTimeout(r, 600));
      }
      db.prepare(`UPDATE monitored_series SET last_cv_check = datetime('now'), total_issues = (SELECT COUNT(*) FROM monitored_issues WHERE series_id = ?) WHERE id = ?`)
        .run(annual.annual_series_id, annual.annual_series_id);
      if (newCount > 0) logger.info('cvpoller', `Annual ${annual.name}: +${newCount} new issues`);
      try {
        const fourMonthsAgo = Date.now() - 120 * 24 * 60 * 60 * 1000;
        let freshStatus = 'unknown';
        if (newCount > 0) {
          freshStatus = 'ongoing';
        } else {
          // Latest issue date only; the "final issue / finale" title test was dropped (2026-10-28).
          const latest = db.prepare(
            `SELECT MAX(COALESCE(store_date, release_date)) AS d FROM monitored_issues WHERE series_id = ?`
          ).get(annual.annual_series_id);
          if (latest?.d) {
            const ms = new Date(latest.d).getTime();
            freshStatus = (!isNaN(ms) && ms >= fourMonthsAgo) ? 'ongoing' : 'ended';
          }
        }
        db.prepare(`UPDATE monitored_series SET series_status = ? WHERE id = ?`)
          .run(freshStatus, annual.annual_series_id);
      } catch (e) {
        logger.warn('cvpoller', `Status re-derive failed for annual "${annual.name}"`, e.message);
      }
      await new Promise(r => setTimeout(r, 600));
    } catch (e) {
      if (await libraryStatus.waitForCvReset(e, pollWait, { sleep: sleepMs, logger })) { ai--; continue; }
      logger.error('cvpoller', `Failed for annual ${annual.annual_series_id}`, e.message);
    }
  }

  cvPollStartedAt = 0;
  logger.info('cvpoller', 'Weekly CV poll complete');
});


// ═══════════════════════════════════════════════════════════════════
// ─── Events System ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

// ─── CV story arc search ──────────────────────────────────────────
app.get('/api/cv/story-arcs', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const r = await cvApiGet('https://comicvine.gamespot.com/api/story_arcs/', {
      params: {
        api_key: getCVKey(), format: 'json',
        filter: `name:${q}`,
        field_list: 'id,name,publisher,count_of_issue_appearances,image,site_detail_url,description',
        limit: 10,
      },
      headers: { 'User-Agent': 'Omnibus/1.0' },
    });
    // Normalise to count_of_issues for frontend consistency
    const results = (r.data.results || []).map(a => ({
      ...a,
      count_of_issues: a.count_of_issue_appearances || 0,
    }));
    res.json({ results });
  } catch (e) {
    logger.error('events', 'CV story arc search failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Fetch issues for a CV story arc ─────────────────────────────
app.get('/api/cv/story-arcs/:id/issues', async (req, res) => {
  try {
    // Step 1: get issue stubs from arc endpoint
    const r = await cvApiGet(`https://comicvine.gamespot.com/api/story_arc/4045-${req.params.id}/`, {
      params: { api_key: getCVKey(), format: 'json', field_list: 'id,name,issues' },
      headers: { 'User-Agent': 'Omnibus/1.0' },
    });
    const arc = r.data.results || {};
    const stubs = arc.issues || [];

    // Step 2: fetch full data including volume, issue_number, cover_date in batches
    const issues = [];
    const batchSize = 25;
    for (let i = 0; i < stubs.length; i += batchSize) {
      const ids = stubs.slice(i, i + batchSize).map(s => s.id).join('|');
      const issData = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
        params: {
          api_key: getCVKey(), format: 'json',
          filter: `id:${ids}`,
          field_list: 'id,issue_number,name,cover_date,volume',
          limit: batchSize,
        },
        headers: { 'User-Agent': 'Omnibus/1.0' },
      });
      for (const iss of (issData.data.results || [])) {
        issues.push({
          id: String(iss.id),
          name: iss.name,
          issue_number: iss.issue_number,
          cover_date: iss.cover_date,
          volume: iss.volume ? { id: String(iss.volume.id), name: iss.volume.name } : null,
        });
      }
      if (i + batchSize < stubs.length) await new Promise(r => setTimeout(r, 300));
    }
    res.json({ id: req.params.id, name: arc.name, issues });
  } catch (e) {
    logger.error('events', 'CV story arc issues fetch failed', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ─── CV API enrichment: look up cv_issue_id for ALL generated event issues ───
// All cv_issue_ids are sourced authoritatively from CV — Claude-supplied IDs are
// nulled out before lookup to prevent hallucinated IDs from being stored.
// arcIssues: optional array from CV story arc endpoint — used as a fast exact-match
//   lookup table before falling back to CV API search. Format: [{id, issue_number, volume: {name}}]
// The event generator's reply (prompt v2, structured outputs).
// OpenAI parity (user 2026-10-18): the v2 generator prompts name Claude's "web fetch" tool. For a GPT
// model the same instruction names Omnibus's read_page tool instead (ai/aiClient.js); Claude's prompt
// is unchanged, word for word.
const forGptPrompt = p => p
  .replace(/you have web search and web fetch/g, 'you have web search and read_page, which reads a whole page')
  .replace(/with web fetch/g, 'with read_page')
  .replace(/cannot be fetched/g, 'cannot be read')
  .replace(/web search and web fetch work only/g, 'web search and read_page (which reads a whole page) work only');
// GPT follows a source page's layout and labels over the prompt's rules (Reign of the Superboys on
// gpt-6.1-sol: copied Comic Book Treasury's series-by-series list and readingorders.com's line-wide
// "Recommended" labels; user 2026-10-18). For OpenAI models only, these rules are added just before
// the reply format. Claude's prompt is unchanged.
const eventSources = require('./eventSources');
const guidePages = require('./guidePages');
const metronLib = require('./metron');
const seriesStatusLib = require('./seriesStatus');
// Metron reading lists (2026-10-21): the event generator's starting list when Metron has the event.
const metron = metronLib.createMetron({ axios, getToken: () => getSetting('metron_api_token') || process.env.METRON_API_TOKEN || '', db, logger });
// Timeline event generation: eventGenerator.js (moved 2026-11-10, server.js split).
require('./eventGenerator').registerEventGenerator({ ai, aiInfo, aiRunStep, app, axios, canonResolve, cvApiGet, db, eventSources, forGptPrompt, getAnthropicKey, getCVKey, getSetting, guidePages, IN, logger, metron, metronLib, modelCatalog, requireAdmin, setAiJobOutcome });

// ─── List events ──────────────────────────────────────────────────
// Optional ?publisher= filter (maps to library publisher name)
app.get('/api/events', (req, res) => {
  const { publisher } = req.query;
  let events;
  // Draft events (imported, not yet published) are listed for admins only, flagged draft: 1.
  const shown = req.user?.role === 'admin' ? '1 = 1' : require('./eventDrafts').published(db);
  if (publisher) {
    events = db.prepare(
      `SELECT * FROM events WHERE (publisher = ? OR publisher IS NULL) AND ${shown} ORDER BY year ASC, sort_order ASC, name ASC`
    ).all(publisher);
  } else {
    events = db.prepare(`SELECT * FROM events WHERE ${shown} ORDER BY year ASC, sort_order ASC, name ASC`).all();
  }
  // Attach owned/total counts per event
  const countStmt = db.prepare(
    "SELECT COUNT(*) as total, SUM(CASE WHEN scanned_book_id IS NOT NULL THEN 1 ELSE 0 END) as owned FROM event_issues WHERE event_id = ?"
  );

  // Thumbnail priority:
  // 1. Issue #1 of the series whose name best matches the event name
  // 2. Any issue #1 with a scanned book
  // 3. First scanned book by sort_order
  const thumbMainStmt = db.prepare(`
    SELECT ei.scanned_book_id FROM event_issues ei
    WHERE ei.event_id = ? AND ei.scanned_book_id IS NOT NULL AND ei.issue_number = '1'
    AND (LOWER(ei.series_name) LIKE LOWER('%' || ? || '%') OR LOWER(?) LIKE LOWER('%' || ei.series_name || '%'))
    ORDER BY ei.sort_order ASC LIMIT 1
  `);
  const thumbIssue1Stmt = db.prepare(`
    SELECT ei.scanned_book_id FROM event_issues ei
    WHERE ei.event_id = ? AND ei.scanned_book_id IS NOT NULL AND ei.issue_number = '1'
    ORDER BY ei.sort_order ASC LIMIT 1
  `);
  const thumbFirstStmt = db.prepare(`
    SELECT ei.scanned_book_id FROM event_issues ei
    WHERE ei.event_id = ? AND ei.scanned_book_id IS NOT NULL
    ORDER BY ei.sort_order ASC LIMIT 1
  `);

  // An issue picked in the editor (⋯ › Use as Timeline cover, 2026-11-10) comes first, while it
  // is still matched to a book; then the image link; then the automatic choice below.
  const pickedStmt = db.prepare(`SELECT ei.scanned_book_id FROM event_issues ei JOIN scanned_books sb ON sb.id = ei.scanned_book_id
    WHERE ei.id = ? AND ei.event_id = ?`);
  const result = events.map(e => {
    const counts = countStmt.get(e.id) || { total: 0, owned: 0 };
    const picked = e.cover_issue_id != null ? pickedStmt.get(e.cover_issue_id, String(e.id)) : null;
    if (picked) return { ...e, total_issues: counts.total, owned_issues: counts.owned, thumbnail_book_id: picked.scanned_book_id };
    // If a cover_image is explicitly set, use it — skip book thumbnail logic
    if (e.cover_image) {
      return { ...e, total_issues: counts.total, owned_issues: counts.owned, thumbnail_book_id: null };
    }
    const thumbMain = thumbMainStmt.get(e.id, e.name, e.name);
    const thumbIssue1 = !thumbMain ? thumbIssue1Stmt.get(e.id) : null;
    const thumbFirst = (!thumbMain && !thumbIssue1) ? thumbFirstStmt.get(e.id) : null;
    const thumbnail_book_id = (thumbMain || thumbIssue1 || thumbFirst)?.scanned_book_id || null;
    return { ...e, total_issues: counts.total, owned_issues: counts.owned, thumbnail_book_id };
  });
  res.json(result);

  // Pre-warm thumbnail cache in background — fires after response is sent.
  // Any book whose thumb isn't cached yet gets extracted so it's ready when
  // the browser requests it, instead of making the user wait on scroll.
  setImmediate(() => {
    const bookIds = result.map(e => e.thumbnail_book_id).filter(Boolean);
    for (const bookId of bookIds) {
      if (findThumbCache(String(bookId))) continue; // already cached, skip
      const book = db.prepare('SELECT * FROM scanned_books WHERE id = ?').get(bookId);
      if (!book) continue;
      // Use withThumbSlot so pre-warm doesn't starve live requests
      withThumbSlot(async () => {
        try {
          const files = await listArchiveFiles(book.path);
          const images = filterImages(files);
          if (!images.length) return;
          const archExt = path.extname(book.path).toLowerCase();
          const stdout = await readArchiveMember(book.path, images[0], 10 * 1024 * 1024);
          const t = await coverThumb(stdout, path.extname(images[0]).toLowerCase() || '.jpg');
          await fs.promises.writeFile(path.join(THUMB_CACHE_DIR, `${bookId}${t.ext}`), t.buf);
        } catch {}
      }).catch(() => {});
    }
  });
});

// ─── Create event (AI-generated, issues required) ─────────────────
app.post('/api/events', requireAdmin, (req, res) => {
  const { name, publisher, year, cv_story_arc_id, description, cover_image, issues, generator } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!issues || !Array.isArray(issues) || issues.length === 0)
    return res.status(400).json({ error: 'issues array required' });

  const id = require('crypto').randomUUID();
  try {
    db.prepare(
      "INSERT INTO events (id, name, publisher, year, cv_story_arc_id, description, cover_image, source, generator_sources) VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?)"
    ).run(id, name, publisher || null, year || null, cv_story_arc_id || null, description || null, cover_image || null,
      generator ? JSON.stringify({ source: generator.source || null, sourceUrl: generator.sourceUrl || null, centralNarrative: generator.centralNarrative || null,
        sourcesRead: Array.isArray(generator.sourcesRead) ? generator.sourcesRead : [], omitted: Array.isArray(generator.omitted) ? generator.omitted : [] }) : null);

    const insertIssue = db.prepare(`
      INSERT INTO event_issues (event_id, cv_issue_id, sort_order, tier, tier_note, phase, series_name, issue_number, issue_title, volume_year, sources, order_note, order_flag, tier_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (const i of issues) {
        insertIssue.run(id, i.cv_issue_id || null, i.sort_order, i.tier || 'recommended',
          i.tier_note || null, i.phase || null, i.series_name, i.issue_number, i.issue_title || null,
          i.volume_year ? String(i.volume_year) : null,
          Array.isArray(i.sources) && i.sources.length ? JSON.stringify(i.sources) : null, i.order_note || null, i.order_flag || null, i.tier_reason || null);
      }
    })();

    // The shared matcher first (2026-10-17), then the old background matcher for what is left.
    try { editorTools.fillUnmatched('event', id); } catch (e) { logger.warn('events', 'Shared matcher after create failed', { error: e.message }); }
    setImmediate(reconcileEventIssues);
    res.json({ success: true, id });
  } catch (e) {
    logger.error('events', 'Create event failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Create event manually (no issues required) ────────────────────
app.post('/api/events/manual', requireAdmin, (req, res) => {
  const { name, publisher, year, description, cover_image, event_tier } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = crypto.randomUUID();
  try {
    db.prepare(
      "INSERT INTO events (id, name, publisher, year, description, cover_image, event_tier, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')"
    ).run(id, name.trim(), publisher || null, year ? parseInt(year) : null,
      description || null, cover_image || null, event_tier ?? 2);
    res.json({ success: true, id });
  } catch (e) {
    logger.error('events', 'Manual create failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Add issue to event manually ──────────────────────────────────
app.post('/api/events/:id/issues', requireAdmin, (req, res) => {
  const { scanned_book_id, series_name, issue_number, issue_title, volume_year, tier, tier_note, phase } = req.body;
  if (!series_name || !issue_number) return res.status(400).json({ error: 'series_name and issue_number required' });
  try {
    // Get max sort_order
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM event_issues WHERE event_id = ?').get(req.params.id)?.m || 0;
    // Look up cv_issue_id from scanned_books if a book is provided
    let cv_issue_id = null;
    if (scanned_book_id) {
      const book = db.prepare('SELECT cv_issue_id FROM scanned_books WHERE id = ?').get(scanned_book_id);
      cv_issue_id = book?.cv_issue_id || null;
    }
    const info = db.prepare(`
      INSERT INTO event_issues (event_id, cv_issue_id, scanned_book_id, sort_order, tier, tier_note, phase, series_name, issue_number, issue_title, volume_year, manually_matched)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(req.params.id, cv_issue_id, scanned_book_id || null, maxOrder + 1,
      tier || 'recommended', tier_note || null, phase || null,
      series_name, issue_number, issue_title || null, volume_year ? String(volume_year) : null);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (e) {
    logger.error('events', 'Add issue failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Get event detail ─────────────────────────────────────────────
// ─── Manual match: set/clear scanned_book_id on a single event issue ───────
// The Comic Vine issue id of a library book: its folder tag, else its ComicInfo link.
function bookCvId(bookId) {
  if (!bookId) return null;
  const r = db.prepare(`SELECT sb.cv_issue_id AS cv, (SELECT ci.cv_issue_id FROM book_ci_index ci WHERE ci.book_id = sb.id) AS ci
    FROM scanned_books sb WHERE sb.id = ?`).get(String(bookId));
  return r ? (r.cv || r.ci || null) : null;
}
// syncCv (sent by the shared editor's Confirm match, user 2026-10-17): the
// issue also takes the chosen comic's Comic Vine id, so downloads and
// Generate follow the comic that was picked.
app.put('/api/events/:id/issues/:issueId/match', requireAdmin, (req, res) => {
  const { scanned_book_id, syncCv } = req.body;
  const result = db.prepare(
    "UPDATE event_issues SET scanned_book_id = ?, manually_matched = ? WHERE id = ? AND event_id = ?"
  ).run(scanned_book_id || null, scanned_book_id ? 1 : 0, req.params.issueId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Issue not found' });
  const cv = syncCv && scanned_book_id ? bookCvId(scanned_book_id) : null;
  if (cv) db.prepare('UPDATE event_issues SET cv_issue_id = ? WHERE id = ? AND event_id = ?').run(String(cv), req.params.issueId, req.params.id);
  res.json({ success: true, scanned_book_id: scanned_book_id || null, cv_issue_id: cv });
});

// ─── Book search for manual match picker ─────────────────────────
// MUST be before GET /api/events/:id or Express treats "book-search" as :id
// Normalises punctuation so "Firestorm: The Nuclear Man" matches "Firestorm, the Nuclear Man"
app.get('/api/events/book-search', requireAuth, (req, res) => {
  const { q, issue } = req.query;
  if (!q || !q.trim()) return res.json([]);

  // Dotted initials are one word ("L.E.G.I.O.N." → "legion"); names are compared without dots.
  const plainName = s => String(s || '').replace(/\b(?:[a-z]\.){2,}/gi, m => m.replace(/\./g, '')).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const qNorm  = plainName(q);
  const words  = qNorm.split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return res.json([]);

  try {
    const wordConditions = words.map(() =>
      `(REPLACE(LOWER(ss.name), '.', '') LIKE ? OR REPLACE(LOWER(sb.filename), '.', '') LIKE ?)`
    ).join(' AND ');
    const wordParams = words.flatMap(w => [`%${w}%`, `%${w}%`]);
    const issueFilter = issue ? `AND sb.issue_number = ?` : '';
    // Optional volume year (the series folder's year): only that volume's
    // issues, so "#1" does not bring every #1 of the title. Nothing that
    // year → the year either side (folder years are sometimes off by one);
    // the X-Year-Match header says which (exact | near | none).
    const yr = /^(?:18|19|20)\d{2}$/.test(String(req.query.year || '').trim()) ? Number(String(req.query.year).trim()) : null;
    const find = (yearSql, yearParams) => {
      const sql = `
        SELECT sb.id, sb.filename, sb.issue_number, sb.cv_issue_id,
               ss.name as series_name, ss.year as series_year
        FROM scanned_books sb
        JOIN scanned_series ss ON ss.id = sb.series_id
        WHERE ${wordConditions} ${issueFilter} ${yearSql}
        ORDER BY ss.name ASC, CAST(sb.issue_number AS REAL) ASC
        LIMIT 80
      `;
      let found = db.prepare(sql).all(...wordParams, ...(issue ? [issue] : []), ...yearParams);
      // A year in the number box for an annual ("World's Finest Annual" #2025):
      // year-titled annuals are #1 with the year in their name.
      if (!found.length && issue && /^(?:19|20)\d{2}$/.test(String(issue).trim())) {
        found = db.prepare(sql.replace(issueFilter, `AND (LOWER(ss.name) LIKE ? OR sb.filename LIKE ?)`))
          .all(...wordParams, `%${issue}%`, `%${issue}%`, ...yearParams);
      }
      return found;
    };
    let rows;
    if (yr) {
      rows = find(`AND (CAST(ss.year AS INTEGER) = ? OR (ss.year IS NULL AND sb.filename LIKE ?))`, [yr, `%(${yr})%`]);
      let match = 'exact';
      if (!rows.length) { rows = find(`AND CAST(ss.year AS INTEGER) BETWEEN ? AND ?`, [yr - 1, yr + 1]); match = rows.length ? 'near' : 'none'; }
      res.set('X-Year-Match', match);
    } else rows = find('', []);

    // Score by name similarity — closer match to query floats higher
    const scored = rows.map(row => {
      const sNorm = plainName(row.series_name);
      const sWords = sNorm.split(/\s+/).filter(Boolean);
      // Exact match after normalization
      if (sNorm === qNorm) return { ...row, _score: 1000 };
      // Count query words present in series name
      const matchCount = words.filter(w => sNorm.includes(w)).length;
      // Penalize extra words in series name — tie-ins have more words
      const extraWords = Math.max(0, sWords.length - words.length);
      return { ...row, _score: matchCount * 100 - extraWords * 10 };
    });

    scored.sort((a, b) => b._score - a._score);
    res.json(scored.slice(0, 40));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/events/:id', requireAuth, (req, res) => {
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(req.params.id);
  if (!event || (event.draft && req.user?.role !== 'admin')) return res.status(404).json({ error: 'Event not found' });   // drafts: admins only

  const userId = req.user?.sub || null;

  const issues = db.prepare(`
    SELECT ei.*,
      sb.path as book_path, sb.filename as book_filename,
      sb.comicinfo as book_comicinfo,
      rp.page as rp_page, rp.completed as rp_completed
    FROM event_issues ei
    LEFT JOIN scanned_books sb ON sb.id = ei.scanned_book_id
    LEFT JOIN read_progress rp ON rp.book_id = ei.scanned_book_id
      AND (rp.user_id = ? OR rp.user_id IS NULL)
    WHERE ei.event_id = ?
    ORDER BY ei.sort_order ASC
  `).all(userId, req.params.id);

  // Attach readProgress in the same shape as series/books endpoints
  // Story titles: the event's own when set, else the file's ComicInfo title ("Impulse Control, Part 1").
  const issuesWithProgress = issues.map(i => ({
    ...i,
    issue_title: i.issue_title || require('./eventNotes').titleOf(i.book_comicinfo),
    solicit: require('./eventNotes').solicitOf(i.book_comicinfo, 1500),   // for the tap card's drop-down
    readProgress: (i.rp_page != null || i.rp_completed != null)
      ? { page: i.rp_page || 0, completed: !!i.rp_completed }
      : null,
  }));

  // Generator sources are admin-only (GET /api/events/:id/sources).
  const { generator_sources, ...eventOut } = event;
  for (const i of issuesWithProgress) for (const k of EVENT_ADMIN_ONLY) delete i[k];
  res.json({ ...eventOut, issues: issuesWithProgress });
});

// ─── Generator sources (admin, "Show sources") ────────────────────
// What the event generator recorded: the pages it read, the issues it left out, and per issue the
// sites that list it, why it was moved from release order, and a release-position flag.
app.get('/api/events/:id/sources', requireAdmin, (req, res) => {
  const event = db.prepare("SELECT generator_sources FROM events WHERE id = ?").get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  let gen = null;
  try { gen = event.generator_sources ? JSON.parse(event.generator_sources) : null; } catch {}
  const issues = db.prepare("SELECT id, sources, order_note, order_flag, tier_reason FROM event_issues WHERE event_id = ?").all(req.params.id)
    .map(r => { let src = []; try { src = r.sources ? JSON.parse(r.sources) : []; } catch {} return { id: r.id, sources: src, order_note: r.order_note || null, order_flag: r.order_flag || null, tier_reason: r.tier_reason || null }; });
  res.json({ recorded: !!gen, source: gen?.source || null, sourceUrl: gen?.sourceUrl || null, centralNarrative: gen?.centralNarrative || null,
    sourcesRead: gen?.sourcesRead || [], omitted: gen?.omitted || [], issues });
});

// ─── Update event metadata ────────────────────────────────────────
app.put('/api/events/:id', requireAdmin, (req, res) => {
  const { name, publisher, year, description, cover_image, event_tier, sort_order } = req.body;
  const event = db.prepare("SELECT id FROM events WHERE id = ?").get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  db.prepare(
    "UPDATE events SET name=?, publisher=?, year=?, description=?, cover_image=?, event_tier=?, sort_order=? WHERE id=?"
  ).run(name, publisher || null, year || null, description || null, cover_image || null, event_tier ?? 2, sort_order != null ? parseInt(sort_order) : 0, req.params.id);
  res.json({ success: true });
});

// ─── Bulk update event issues (sort_order + tier + phase) ────────
// Body: { issues: [{ id, sort_order, tier, tier_note, phase }] }
app.put('/api/events/:id/issues', requireAdmin, (req, res) => {
  const { issues } = req.body;
  if (!Array.isArray(issues)) return res.status(400).json({ error: 'issues array required' });
  const upd = db.prepare(
    "UPDATE event_issues SET sort_order=?, tier=?, tier_note=?, phase=? WHERE id=? AND event_id=?"
  );
  db.transaction(() => {
    for (const i of issues) upd.run(i.sort_order, i.tier, i.tier_note || null, i.phase || null, i.id, req.params.id);
  })();
  res.json({ success: true });
});

// ─── Delete a single event issue ─────────────────────────────────
app.delete('/api/events/:id/issues/:issueId', requireAdmin, (req, res) => {
  db.prepare("DELETE FROM event_issues WHERE id=? AND event_id=?").run(req.params.issueId, req.params.id);
  res.json({ success: true });
});

// ─── Tier notes for event issues (Event Tier Notes task) ─────────
// Reader-facing tier_notes written from what Omnibus already has (eventNotes.js, 2026-10-22): the
// generator's tier reasons, each issue's solicit (ComicInfo Summary) and saved synopses. No web
// search (about 2¢ an event on Haiku; the old version searched up to 3 times on Sonnet). Issues with
// none of these get no note. Replies are matched by list number and checked against series and
// issue number. Does not change tiers, phases or order; never clears an existing note.
const eventNotes = require('./eventNotes');
try { db.prepare('ALTER TABLE events ADD COLUMN notes_refreshed_at INTEGER').run(); } catch {}
const httpError = (status, message) => Object.assign(new Error(message), { status });

// Writes (or previews) one event's tier notes. → { notes: [{id, tier_note}], written, stats, cents }.
// Each event's notes are one AI run (several jobs for a long event).
function writeTierNotes(eventId, opts) {
  let ev = null;
  try { ev = db.prepare('SELECT name, year FROM events WHERE id = ?').get(eventId); } catch {}
  return ai.run({ label: `Tier notes: ${ev ? `${ev.name}${ev.year ? ` (${ev.year})` : ''}` : eventId}` }, () => writeTierNotesNow(eventId, opts));
}
async function writeTierNotesNow(eventId, { preview = false } = {}) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) throw httpError(404, 'Event not found');
  const rows = db.prepare(`SELECT ei.id, ei.series_name, ei.issue_number, ei.volume_year, ei.issue_title, ei.tier, ei.phase, ei.tier_note, ei.tier_reason,
      ei.cv_issue_id, ei.scanned_book_id, sb.comicinfo
    FROM event_issues ei LEFT JOIN scanned_books sb ON sb.id = ei.scanned_book_id WHERE ei.event_id = ? ORDER BY ei.sort_order`).all(eventId);
  if (!rows.length) throw httpError(400, 'No issues to annotate');
  let synopsisOf = () => null;
  try {
    const q = db.prepare("SELECT synopsis FROM issue_synopses WHERE issue_key = ? AND status = 'ok' AND source != 'comicinfo'");
    synopsisOf = r => { const k = r.cv_issue_id ? String(r.cv_issue_id) : r.scanned_book_id ? `book:${r.scanned_book_id}` : null; const x = k && q.get(k); return x && x.synopsis ? String(x.synopsis).slice(0, 900) : null; };
  } catch {}
  let centralNarrative = null;
  try { centralNarrative = JSON.parse(event.generator_sources || 'null')?.centralNarrative || null; } catch {}
  const all = rows.map((r, k) => ({ ...r, n: k + 1, tier_reason: r.tier_reason || null, title: r.issue_title || eventNotes.titleOf(r.comicinfo),
    solicit: eventNotes.solicitOf(r.comicinfo), synopsis: synopsisOf(r) }));
  const items = all.filter(eventNotes.hasMaterial);
  if (!items.length) throw httpError(400, 'None of these issues has a solicit, synopsis or tier reason to write from');

  const job = ai.newJobId();
  const totals = { input: 0, output: 0, mismatched: 0, missing: 0 };
  const notes = [];
  let model = null;
  try {
    // Parts of 40 issues, with room for ~250 tokens a note (the first version allowed 110 and every
    // DC K.O. reply was cut off). Issues a cut-off reply did not reach are asked again once, in halves.
    const BATCH = 40;
    const queue = [];
    for (let k = 0; k < items.length; k += BATCH) queue.push({ part: items.slice(k, k + BATCH), retry: false });
    while (queue.length) {
      const { part: raw, retry } = queue.shift();
      const part = raw.map((i, j) => ({ ...i, n: j + 1 }));
      const prompt = eventNotes.buildPrompt({ event, centralNarrative, items: part });
      const opts = { task: 'event_notes', prompt, maxTokens: Math.min(32000, 1500 + 250 * part.length), timeout: 180000, jobId: job };
      // Thinking off (short writing from supplied material; with it on, Haiku 5.5 used the whole reply
      // budget thinking and wrote nothing). A 400 drops the option, then the schema.
      let data = null, lastErr = null;
      for (const extra of [{ thinking: 'off', outputSchema: eventNotes.NOTES_SCHEMA }, { outputSchema: eventNotes.NOTES_SCHEMA }, {}]) {
        try { ({ data } = await ai.complete({ ...opts, ...extra })); break; }
        catch (e) { lastErr = e; if (e.response?.status !== 400) throw e; logger.warn('events', 'Tier notes: the API refused an option; trying without it', { options: Object.keys(extra), error: e.response?.data?.error?.message }); }
      }
      if (!data) throw lastErr;
      model = data.model || model;
      totals.input += data.usage?.input_tokens || 0; totals.output += data.usage?.output_tokens || 0;
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      let reply = [];
      try { reply = eventNotes.parseReply(text); }
      catch (e) {
        logger.warn('events', 'Tier notes: reply could not be read', { stop: data.stop_reason, output: data.usage?.output_tokens, issues: part.length,
          blocks: (data.content || []).map(b => b.type).join(','), tail: text.slice(-300) });
        if (retry || part.length < 2) { totals.missing += part.length; continue; }
      }
      const m = eventNotes.matchNotes(part, reply);
      totals.mismatched += m.mismatched;
      notes.push(...m.notes);
      const done = new Set(m.notes.map(n => n.id));
      const left = raw.filter(i => !done.has(i.id));
      if (left.length && !retry && data.stop_reason === 'max_tokens') {
        logger.warn('events', `Tier notes: reply cut off after ${done.size} of ${part.length}; asking again for the rest`, { output: data.usage?.output_tokens });
        const h = Math.ceil(left.length / 2);
        queue.push({ part: left.slice(0, h), retry: true }); if (left.length > h) queue.push({ part: left.slice(h), retry: true });
      } else totals.missing += left.length;
    }
  } catch (e) {
    setAiJobOutcome(job, /JSON/i.test(e.message) ? 'bad_json' : 'error', e.message);
    throw e;
  }
  const written = notes.filter(n => n.tier_note);
  const pr = modelCatalog.price(model || '');
  const cents = Math.round(((totals.input * pr.in + totals.output * pr.out) / 1e6) * 10000) / 100;
  const stats = { issues: rows.length, sent: items.length, noMaterial: rows.length - items.length, written: written.length,
    empty: notes.length - written.length, mismatched: totals.mismatched, missing: totals.missing, cents, model: model ? modelCatalog.displayName(model) : null };
  logger.info('events', `Tier notes for "${event.name}": ${written.length} written, ${stats.empty} empty, ${stats.noMaterial} with nothing to write from${stats.mismatched ? `, ${stats.mismatched} replies dropped (wrong issue)` : ''}`,
    { model, input: totals.input, output: totals.output, cents, ...stats });
  setAiJobOutcome(job, 'ok', `${written.length} tier notes${preview ? ' (preview)' : ''}`);
  if (!preview) {
    const upd = db.prepare('UPDATE event_issues SET tier_note = ? WHERE id = ? AND event_id = ?');
    db.transaction(() => {
      for (const n of written) upd.run(n.tier_note, n.id, eventId);
      db.prepare('UPDATE events SET notes_refreshed_at = ? WHERE id = ?').run(Date.now(), eventId);
    })();
  }
  return { notes, written, stats, cents, name: event.name };
}

app.post('/api/events/:id/reannotate', requireAdmin, async (req, res) => {
  try {
    const preview = !!(req.body && req.body.preview);
    const r = await writeTierNotes(req.params.id, { preview });
    const stats = r.stats ? { ...r.stats, cents: aiInfo.requestTotals(db)?.cents ?? r.stats.cents } : r.stats;   // same total as the ⓘ
    if (preview) return res.json({ preview: true, annotations: r.notes, stats });
    res.json({ success: true, count: r.written.length, annotations: r.written, stats });
  } catch (e) {
    if (!e.status) logger.error('events', 'Tier notes failed', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─── Refresh tier notes for every event (admin; one at a time, in the background) ──
// Skips events already refreshed unless { all: true }; stoppable; progress at GET.
const notesRefresh = { running: false, stop: false, total: 0, done: 0, failed: 0, written: 0, cents: 0, current: null, errors: [], startedAt: null, finishedAt: null };
app.get('/api/events/notes/refresh-all', requireAdmin, (req, res) => {
  const pending = db.prepare('SELECT COUNT(*) AS n FROM events WHERE notes_refreshed_at IS NULL').get().n;
  const all = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  const t = aiInfo.totals(db, 'request_id', notesRefresh.aiRequest);   // same total as the ⓘ
  res.json({ ...notesRefresh, cents: t ? t.cents : notesRefresh.cents, ai_request: notesRefresh.aiRequest || null, errors: notesRefresh.errors.slice(-10), pending, all });
});
app.post('/api/events/notes/refresh-all', requireAdmin, (req, res) => {
  if (notesRefresh.running) return res.status(409).json({ error: 'A refresh is already running' });
  const every = !!(req.body && req.body.all);
  const ids = db.prepare(`SELECT id, name FROM events ${every ? '' : 'WHERE notes_refreshed_at IS NULL'} ORDER BY year, name`).all();
  Object.assign(notesRefresh, { running: true, stop: false, total: ids.length, done: 0, failed: 0, written: 0, cents: 0, current: null, errors: [], startedAt: Date.now(), finishedAt: null, aiRequest: aiInfo.currentRequest() });
  logger.info('events', `Tier notes refresh started for ${ids.length} events${every ? ' (all again)' : ''}`, { by: req.user?.username });
  res.json({ started: true, total: ids.length });
  (async () => {
    for (const ev of ids) {
      if (notesRefresh.stop) break;
      notesRefresh.current = ev.name;
      try {
        const r = await writeTierNotes(ev.id);
        notesRefresh.written += r.written.length; notesRefresh.cents += r.cents;
      } catch (e) {
        notesRefresh.failed++; notesRefresh.errors.push({ event: ev.name, error: e.message });
        if (e.status === 400) { try { db.prepare('UPDATE events SET notes_refreshed_at = ? WHERE id = ?').run(Date.now(), ev.id); } catch {} }   // nothing to write from: don't retry
      }
      notesRefresh.done++;
    }
    notesRefresh.cents = Math.round(notesRefresh.cents * 100) / 100;
    Object.assign(notesRefresh, { running: false, current: null, finishedAt: Date.now() });
    logger.info('events', `Tier notes refresh ${notesRefresh.stop ? 'stopped' : 'finished'}: ${notesRefresh.done} of ${notesRefresh.total} events, ${notesRefresh.written} notes, ${notesRefresh.failed} failed, ~${notesRefresh.cents}¢`);
  })();
});
app.post('/api/events/notes/refresh-all/stop', requireAdmin, (req, res) => {
  if (notesRefresh.running) notesRefresh.stop = true;
  res.json({ stopping: notesRefresh.running });
});


// ─── Manual reconcile trigger ────────────────────────────────────
app.post('/api/events/:id/reconcile', requireAdmin, async (req, res) => {
  const event = db.prepare('SELECT id FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  // Top-level try/catch — any uncaught exception inside reconcileEventIssues
  // would otherwise leave the request hanging until the proxy times out, with
  // no logged reason. Better to fail fast and surface the error to the client.
  try {
    // Clear all NON-manually-matched scanned_book_id values for this event
    // before reconciling. This makes Match Owned a "rebuild from scratch"
    // operation, which is the behaviour the user actually wants:
    //   - If a same-name-different-year tie-in (e.g. Siege 2010 vs 2015)
    //     was matched to the wrong book, clearing forces re-evaluation
    //     against current library state with the year guard active.
    //   - If new matching files were downloaded since the last reconcile,
    //     they get picked up without the user having to figure out which
    //     event_issues are stale.
    // Manually-matched rows are preserved — those are explicit user
    // overrides and shouldn't be touched by an automatic operation.
    const cleared = db.prepare(
      `UPDATE event_issues SET scanned_book_id = NULL
       WHERE event_id = ?
         AND (manually_matched IS NULL OR manually_matched = 0)`
    ).run(req.params.id);
    if (cleared.changes > 0) {
      logger.info('events', `Cleared ${cleared.changes} auto-match(es) before reconcile`, { eventId: req.params.id });
    }
    await reconcileEventIssues();
    const counts = db.prepare(
      "SELECT COUNT(*) as total, SUM(CASE WHEN scanned_book_id IS NOT NULL THEN 1 ELSE 0 END) as owned FROM event_issues WHERE event_id = ?"
    ).get(req.params.id);
    res.json({ success: true, total: counts.total, owned: counts.owned, cleared: cleared.changes });
  } catch (e) {
    logger.error('events', `Reconcile endpoint failed`, { eventId: req.params.id, error: e.message, stack: e.stack });
    res.status(500).json({ error: e.message });
  }
});

// ─── Delete event ─────────────────────────────────────────────────
app.delete('/api/events/:id', requireAdmin, (req, res) => {
  db.prepare("DELETE FROM events WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// ─── Manual annual discovery trigger ────────────────────────────
app.post('/api/monitor/series/:id/discover-annuals', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(id);
  if (!series) return res.status(404).json({ error: 'Series not found' });
  // Clear any cooldown so discovery runs immediately
  db.prepare("UPDATE monitored_series SET annual_no_match_until = NULL WHERE id = ?").run(id);
  try {
    await autoDiscoverAnnuals(id, series.name, series.directory);
    const links = db.prepare('SELECT ms.id, ms.name FROM series_annual_links sal JOIN monitored_series ms ON ms.id = sal.annual_series_id WHERE sal.parent_series_id = ?').all(id);
    res.json({ success: true, linked: links });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Weekly annual discovery cron (Tuesday 03:45) ───────────────
// Only runs for ongoing/unknown series — ended series have no new annuals to find.
// On-add and manual button handle one-time discovery for ended series.
cron.schedule('45 3 * * 2', async () => {
  logger.info('annual-cron', 'Weekly annual discovery starting');
  const series = db.prepare(
    `SELECT id, name, directory FROM monitored_series
     WHERE status = 'active'
       AND (series_status = 'ongoing' OR series_status = 'unknown' OR series_status IS NULL)`
  ).all();
  logger.info('annual-cron', `Checking ${series.length} active ongoing series for new annuals`);
  let found = 0;
  for (const s of series) {
    try {
      await autoDiscoverAnnuals(s.id, s.name, s.directory);
      found++;
    } catch (e) {
      logger.warn('annual-cron', `Annual discovery failed for "${s.name}"`, e.message);
    }
  }
  logger.info('annual-cron', `Annual discovery complete (${found}/${series.length} series checked)`);
});

// Compatibility URL: use the same physical-book queue and explicit batch policy.
app.post('/api/monitor/retag-rotation/run', requireAdmin, async (req,res)=>{
  try {
    const work=cvCtx.run({lane:'background',caller:'library-metadata'},()=>metadataMaintenance.run(25,{force:true}));
    await require('./metadata/respondToCheck').respondToCheck({work,res,logger});
  } catch(e){retagHandlers.errorResponse(res,e);}
});

// ─── series.json helpers ─────────────────────────────────────────
// Rebuilds (the Download Manager { } button and Mass JSON with Force) delete
// series.json and let enricher.py recreate it. Keep the previous version as
// series.json.bak first so a failed rebuild can be rolled back.
function backupAndRemoveSeriesJson(directory) {
  const jsonPath = path.join(directory, 'series.json');
  if (!fs.existsSync(jsonPath)) return false;
  fs.copyFileSync(jsonPath, jsonPath + '.bak');
  fs.unlinkSync(jsonPath);
  return true;
}

function restoreSeriesJsonBackup(directory) {
  const jsonPath = path.join(directory, 'series.json');
  const bak = jsonPath + '.bak';
  if (fs.existsSync(jsonPath) || !fs.existsSync(bak)) return false;
  fs.copyFileSync(bak, jsonPath);
  return true;
}

// Write series.json in place and keep the app's cached copies in step.
// Rewriting an existing file doesn't change the folder's mtime, so the library
// scanner would otherwise keep serving the old copy from scanned_series.
function writeSeriesJsonSynced(directory, data) {
  const jsonPath = path.join(directory, 'series.json');
  const bak = jsonPath + '.bak';
  if (fs.existsSync(jsonPath) && !fs.existsSync(bak)) fs.copyFileSync(jsonPath, bak);
  const content = JSON.stringify(data, null, 2);
  fs.writeFileSync(jsonPath, content, 'utf8');
  const ss = db.prepare('SELECT id FROM scanned_series WHERE path = ?').get(directory);
  if (ss) {
    db.prepare('DELETE FROM series_json_cache WHERE series_id = ?').run(ss.id);
    jsonMemCache.delete(ss.id);
    db.prepare('UPDATE scanned_series SET metadata_status = ?, series_json = ?, year = COALESCE(?, year) WHERE id = ?')
      .run(deriveMetadataStatus(data), content, data?.metadata?.year || null, ss.id);
  }
}

// ─── Comic Vine volume fetch (series-level facts) ────────────────
// Separate endpoint (and quota) from single issues. Same rate-limit handling.
async function fetchCvVolumeFacts(volumeId) {
  const r = await cvApiGet(`https://comicvine.gamespot.com/api/volume/4050-${volumeId}/`, {
    params: { api_key: getCVKey(), format: 'json', field_list: 'id,name,start_year,count_of_issues,image' },
    timeout: 15000,
  });
  const v = r.data?.results;
  if (!v || Array.isArray(v)) return null;
  const year = parseInt(v.start_year, 10);
  const count = parseInt(v.count_of_issues, 10);
  return {
    year: Number.isFinite(year) && year > 1800 ? year : null,
    issueCount: Number.isFinite(count) ? count : null,
    image: v.image?.medium_url || null,
  };
}

const SJ_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function sjMonthYear(d) {
  const y = parseInt(String(d || '').slice(0, 4), 10);
  const m = parseInt(String(d || '').slice(5, 7), 10);
  return (y && m >= 1 && m <= 12) ? `${SJ_MONTHS[m - 1]} ${y}` : null;
}

// Publication run + status from data already in the DB (no CV call).
// Status follows monitored_series.series_status, which the CV poller maintains;
// falls back to "an issue dated within ~4 months (or later) = ongoing".
function deriveRunForSeriesJson(series) {
  const row = db.prepare(`
    SELECT MIN(COALESCE(release_date, store_date)) AS first_cover,
           MAX(COALESCE(release_date, store_date)) AS last_cover,
           MAX(COALESCE(store_date, release_date)) AS last_store
    FROM monitored_issues WHERE series_id = ? AND COALESCE(is_annual, 0) = 0
  `).get(series.id);
  if (!row?.first_cover) return null;
  let ongoing;
  if (series.series_status === 'ongoing') ongoing = true;
  else if (series.series_status === 'ended') ongoing = false;
  else ongoing = row.last_store >= new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  const first = sjMonthYear(row.first_cover);
  const last  = sjMonthYear(row.last_cover);
  if (!first) return null;
  const run = ongoing ? `${first} - Present` : (!last || first === last ? first : `${first} - ${last}`);
  return { run, status: ongoing ? 'Continuing' : 'Ended' };
}

// ─── "(Unknown)" folder rename ───────────────────────────────────
// Series added before Comic Vine had a start year got a "Name (Unknown)" folder.
// The rename updates paths in one transaction (IDs are stable, so nothing that
// links to the series or its books changes), and moves the folder back if the
// database update fails.
const FOLDER_RENAME_LOG = path.join(path.dirname(DB_PATH), 'folder_renames.log');

function planUnknownFolderRename(series) {
  const from = series.directory;
  if (!from || !/\(Unknown\)$/.test(path.basename(from))) return null;
  if (series.parent_series_id) return { from, skip: 'special series (lives in parent folder)' };
  let sj = null;
  try { sj = JSON.parse(fs.readFileSync(path.join(from, 'series.json'), 'utf8')); } catch {}
  if (sj && !ownsSeriesJson(series, sj)) return { from, skip: 'folder belongs to another series (e.g. annual in parent folder)' };
  let year = parseInt(series.year, 10) || null;
  if (!year) year = parseInt(sj?.metadata?.year, 10) || null;
  if (!year) return { from, skip: 'start year still unknown on Comic Vine' };
  const to = path.join(path.dirname(from), `${series.name} (${year})`.replace(/[/\\:*?"<>|]/g, ''));
  if (to === from) return null;
  if (!fs.existsSync(from)) return { from, to, year, skip: 'folder not found on disk' };
  if (fs.existsSync(to)) return { from, to, year, skip: 'target folder already exists' };
  if (db.prepare('SELECT 1 FROM monitored_series WHERE directory = ? AND id != ?').get(to, series.id)) {
    return { from, to, year, skip: 'target folder already used by another monitored series' };
  }
  const busy = db.prepare(`SELECT COUNT(*) AS n FROM monitored_issues WHERE series_id = ? AND status IN ('snatched','downloaded','processing')`).get(series.id).n;
  if (busy) return { from, to, year, skip: `${busy} download(s) in progress` };
  return { from, to, year };
}

function remapRenamedFolder(from, to, seriesId, year) {
  // Stable IDs: a renamed folder keeps every series and book ID, so nothing that
  // links to them (progress, events, Top Shelf, lists, favorites, boxes, ratings,
  // tags, offline copies, thumbnails) needs remapping — only paths change.
  const fromSlash = from + '/';
  const tryRun = (sql, ...args) => { try { return db.prepare(sql).run(...args).changes; } catch { return 0; } };
  const counts = { books: 0, series: 0, progress: 0 };

  db.transaction(() => {
    counts.books = db.prepare('UPDATE scanned_books SET path = ? || substr(path, ?) WHERE substr(path, 1, ?) = ?')
      .run(to, from.length + 1, fromSlash.length, fromSlash).changes;
    const seriesRows = db.prepare('SELECT id, path FROM scanned_series WHERE path = ? OR substr(path, 1, ?) = ?').all(from, fromSlash.length, fromSlash);
    for (const r of seriesRows) {
      db.prepare('UPDATE scanned_series SET path = ?, year = CASE WHEN path = ? THEN ? ELSE year END WHERE id = ?')
        .run(to + r.path.slice(from.length), from, year, r.id);
      tryRun('DELETE FROM series_json_cache WHERE series_id = ?', r.id);
      jsonMemCache.delete(r.id);
      counts.series++;
    }
    // Monitored series (parent + any specials sharing the folder) and file paths
    db.prepare('UPDATE monitored_series SET directory = ? WHERE directory = ?').run(to, from);
    db.prepare('UPDATE monitored_series SET year = ? WHERE id = ? AND (year IS NULL OR year = \'\')').run(year, seriesId);
    for (const t of ['monitored_issues', 'series_packs']) {
      tryRun(`UPDATE ${t} SET file_path = ? || substr(file_path, ?) WHERE substr(file_path, 1, ?) = ?`,
        to, from.length + 1, fromSlash.length, fromSlash);
    }
  })();
  return counts;
}

async function renameUnknownFolder(series, plan) {
  if (scanState.running) return { ...plan, skip: 'library scan running — try again later' };
  // The old retag rotation flag no longer existed (ReferenceError on every rename); metadata
  // checks are what now touch files across the library (fixed 2026-10-26).
  if (metadataMaintenance.isRunning()) return { ...plan, skip: 'metadata checks running — try again later' };
  try {
    fs.renameSync(plan.from, plan.to);
  } catch (e) {
    return { ...plan, skip: `rename failed: ${e.code || e.message}` };
  }
  try {
    const counts = remapRenamedFolder(plan.from, plan.to, series.id, plan.year);
    for (const m of db.prepare('SELECT id FROM monitored_series WHERE directory = ?').all(plan.to)) {
      invalidateDirectoryExistsCache(m.id);
      invalidateSeriesJsonCache(m.id);
    }
    invalidateSeriesCache();
    try { fs.appendFileSync(FOLDER_RENAME_LOG, `${new Date().toISOString()}\t${plan.from}\t${plan.to}\n`); } catch {}
    logger.info('folder-rename', `Renamed "${path.basename(plan.from)}" → "${path.basename(plan.to)}"`, counts);
    return { ...plan, renamed: true, ...counts };
  } catch (e) {
    // Database update failed (transaction rolled back) — put the folder back.
    try { fs.renameSync(plan.to, plan.from); } catch {}
    logger.error('folder-rename', `DB remap failed, folder restored`, { from: plan.from, error: e.message });
    return { ...plan, skip: `database update failed (folder restored): ${e.message}` };
  }
}

// Annual volumes (and other linked series) are monitored as their own series but
// share the parent's folder, so the series.json there belongs to the parent.
// A series only owns the file when its comicid matches (or the file has none).
function ownsSeriesJson(series, data) {
  const cid = data?.metadata?.comicid ?? data?.comicid;
  return cid == null || cid === '' || String(cid) === String(series.id);
}

function folderAutoRenameEnabled() {
  return getSetting('series_folder_autorename') === 'true';
}

// ─── Scheduled series.json refresh (daily 04:45) ─────────────────
// Updates only Comic Vine facts in place: issue count, publication run and
// status every time; year and cover image only when missing. Descriptions,
// genres, characters, era, imprint and manual edits are left alone.
// Due: ongoing/unknown series weekly; ended series monthly for 6 months after
// their last issue; series with no year weekly (CV may have added it).
// One CV volume request per series, capped per run, least-recently-refreshed first.
const SJ_REFRESH_CAP = 100;
const SJ_REFRESH_DELAY_MS = 1100;
let sjRefreshRunning = false;

async function runSeriesJsonRefresh(trigger = 'scheduled') {
  if (sjRefreshRunning) { logger.info('sj-refresh', 'Already running — skipped'); return { skipped: true }; }
  sjRefreshRunning = true;
  const stats = { due: 0, updated: 0, unchanged: 0, noJson: 0, notOwner: 0, noData: 0, failed: 0, renamed: 0, rateLimited: false };
  const pause = () => new Promise(r => setTimeout(r, SJ_REFRESH_DELAY_MS));
  try {
    const due = db.prepare(`
      SELECT * FROM (
        SELECT ms.*,
               (SELECT MAX(COALESCE(store_date, release_date)) FROM monitored_issues WHERE series_id = ms.id) AS last_issue_date
        FROM monitored_series ms
        WHERE ms.status = 'active' AND ms.parent_series_id IS NULL
      ) s
      WHERE (s.year IS NULL OR s.year = ''
             OR COALESCE(s.series_status, 'unknown') <> 'ended'
             OR s.last_issue_date >= date('now', '-6 months'))
        AND (s.series_json_refreshed_at IS NULL
             OR s.series_json_refreshed_at < datetime('now',
                  CASE WHEN COALESCE(s.series_status, 'unknown') <> 'ended' OR s.year IS NULL OR s.year = ''
                       THEN '-7 days' ELSE '-30 days' END))
      ORDER BY s.series_json_refreshed_at ASC
      LIMIT ?
    `).all(SJ_REFRESH_CAP);
    stats.due = due.length;
    logger.info('sj-refresh', `Starting (${trigger}) — ${due.length} series due`);
    const markDone = db.prepare(`UPDATE monitored_series SET series_json_refreshed_at = datetime('now') WHERE id = ?`);
    const autoRename = folderAutoRenameEnabled();

    for (const s of due) {
      const jsonPath = path.join(s.directory, 'series.json');
      let data = null;
      if (fs.existsSync(jsonPath)) {
        try { data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) {
          logger.warn('sj-refresh', `Unreadable series.json for "${s.name}" — skipped`, e.message);
          markDone.run(s.id); stats.failed++; continue;
        }
      }

      let facts;
      try {
        facts = await fetchCvVolumeFacts(s.id);
      } catch (e) {
        if (e.code === 'CV_RATE_LIMIT') { stats.rateLimited = true; break; }
        logger.warn('sj-refresh', `CV fetch failed for "${s.name}"`, e.message);
        markDone.run(s.id); stats.failed++; await pause(); continue;
      }
      markDone.run(s.id);

      // Keep the DB year in step even when there's no series.json yet
      if (facts?.year && !s.year) {
        db.prepare('UPDATE monitored_series SET year = ? WHERE id = ?').run(facts.year, s.id);
        s.year = facts.year;
      }

      if (!data) {
        stats.noJson++;
      } else if (!ownsSeriesJson(s, data)) {
        stats.notOwner++;   // e.g. an annual volume sharing its parent's folder
      } else if (!facts) {
        stats.noData++;
      } else {
        const m = data.metadata || (data.metadata = {});
        const changes = [];
        if (facts.year && !m.year) { changes.push(`year → ${facts.year}`); m.year = facts.year; }
        if (facts.year && !m.volume) m.volume = facts.year;
        if (facts.issueCount != null && m.total_issues !== facts.issueCount) {
          changes.push(`issues ${m.total_issues ?? '—'} → ${facts.issueCount}`); m.total_issues = facts.issueCount;
        }
        if (facts.image && !m.comic_image) { changes.push('cover image'); m.comic_image = facts.image; }
        const run = deriveRunForSeriesJson(s);
        if (run) {
          if (m.publication_run !== run.run) { changes.push(`run → ${run.run}`); m.publication_run = run.run; }
          if (m.status !== run.status) { changes.push(`status ${m.status || '—'} → ${run.status}`); m.status = run.status; }
        }
        if (changes.length) {
          try {
            writeSeriesJsonSynced(s.directory, data);
            stats.updated++;
            logger.info('sj-refresh', `${s.name}: ${changes.join(', ')}`);
          } catch (e) {
            stats.failed++;
            logger.warn('sj-refresh', `Write failed for "${s.name}"`, e.message);
          }
        } else {
          stats.unchanged++;
        }
      }

      if (autoRename) {
        const plan = planUnknownFolderRename(s);
        if (plan && !plan.skip) {
          const res = await renameUnknownFolder(s, plan);
          if (res.renamed) stats.renamed++;
          else logger.info('folder-rename', `Skipped "${path.basename(plan.from)}": ${res.skip}`);
        }
      }
      await pause();
    }
    invalidateSeriesCache();
    logger.info('sj-refresh', stats.rateLimited ? 'Stopped early — Comic Vine rate limit reached' : 'Complete', stats);
  } catch (e) {
    logger.error('sj-refresh', 'Run failed', e.message);
  } finally {
    sjRefreshRunning = false;
  }
  return stats;
}

// One-time repair (2026-10-08): the first refresh runs let annual volumes write
// their issue count into the parent's series.json. Mark every series in a shared
// folder as due so the next run restores the parent's own values.
try {
  const done = getSetting('sj_shared_folder_repair_20261008');
  if (done !== 'done') {
    const { changes } = db.prepare(`
      UPDATE monitored_series SET series_json_refreshed_at = NULL
      WHERE directory IN (SELECT directory FROM monitored_series GROUP BY directory HAVING COUNT(*) > 1)
    `).run();
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('sj_shared_folder_repair_20261008', 'done');
    if (changes) console.log(`[sj-refresh] Marked ${changes} series in shared folders for re-refresh`);
  }
} catch (e) { console.warn('[sj-refresh] shared-folder repair mark failed', e.message); }

cron.schedule('45 4 * * *', () => {
  runSeriesJsonRefresh('scheduled').catch(e => logger.error('sj-refresh', 'Run failed', e.message))
    // Then pick up new issues for whole-series / range reading-list entries.
    .finally(() => readingLists.refreshAll('scheduled'));
});

// Manual trigger — background; results go to the server log (sj-refresh).
app.post('/api/monitor/series-json-refresh/run', requireAdmin, (req, res) => {
  if (sjRefreshRunning) return res.json({ ok: false, message: 'Already running' });
  setImmediate(() => runSeriesJsonRefresh('manual').catch(e => logger.error('sj-refresh', 'Run failed', e.message)));
  res.json({ ok: true, message: 'series.json refresh started — see server log (sj-refresh)' });
});

// ─── Library series status check (hourly, 2026-11-12) ────────────
// Unmonitored library series whose series.json still says "Continuing" (libraryStatus.js).
// Metron first when a token is set; one Comic Vine request otherwise. Ended series are not checked.
let libraryMetronOn = true;
async function libraryStatusLookup(comicid, { name, year } = {}) {
  let m = null;
  if (libraryMetronOn && (getSetting('metron_api_token') || process.env.METRON_API_TOKEN)) {
    try { m = await metron.seriesStatus(comicid, { name, year }); }
    catch (e) {
      if (e.code === 'METRON_AUTH' || e.code === 'METRON_TOKEN_MISSING') libraryMetronOn = false;
      logger.warn('library-status', `Metron check failed for "${name}" — using Comic Vine`, e.message);
    }
  }
  if (m && m.status === 'ended') return { metron: m, yearEnd: m.yearEnd || null };
  if (!getCVKey()) return { metron: m, yearEnd: m?.yearEnd || null };   // Metron-only install
  const r = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
    params: { api_key: getCVKey(), format: 'json', filter: `volume:${comicid}`, sort: 'cover_date:desc', limit: 1, field_list: 'id,cover_date,store_date' },
    headers: { 'User-Agent': 'Omnibus/1.0' }, timeout: 15000,
  });
  const i = (r.data?.results || [])[0] || null;
  const dates = i ? [i.store_date, i.cover_date].filter(Boolean).sort() : [];
  const count = parseInt(r.data?.number_of_total_results, 10);
  return { latestDate: dates.length ? dates[dates.length - 1] : null, lastCover: i?.cover_date || null,
    issueCount: Number.isFinite(count) ? count : null, metron: m, yearEnd: m?.yearEnd || null };
}
const runLibraryStatusCheck = libraryStatus.createLibraryStatusCheck({
  db, lookup: libraryStatusLookup, logger,
  readSeriesJson: dir => JSON.parse(fs.readFileSync(path.join(dir, 'series.json'), 'utf8')),
  writeSeriesJson: (dir, data) => writeSeriesJsonSynced(dir, data),
  pause: () => sleepMs(1100),
});
// ─── Series without details: create series.json from the files (2026-11-13) ─
// Library page › Series without details › "Create from files". For each folder without a
// series.json, the Comic Vine volume of its comics (the largest ComicInfo series group; saved
// lookups, the monitored issue lists, Metron, then Comic Vine outside the reserve), then the normal
// create and enrich (Metron first, one Comic Vine volume request). One folder at a time.
const filesJob = { running: false, stop: false, total: 0, done: 0, created: 0, skipped: [], current: null, startedAt: null, finishedAt: null, note: null };
async function volumeForFolder(seriesId) {
  const groups = new Map();
  for (const b of db.prepare('SELECT filename, comicinfo, cv_issue_id FROM scanned_books WHERE series_id = ? AND COALESCE(is_special, 0) = 0').all(seriesId)) {
    if (/annual/i.test(b.filename || '') || !b.cv_issue_id) continue;
    const m = /<Series>([^<]*)<\/Series>/.exec(b.comicinfo || '');
    const key = (m ? m[1] : '').trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(String(b.cv_issue_id));
  }
  const main = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  if (!main) return { reason: 'no Comic Vine IDs in its files' };
  for (const issueId of main.slice(0, 2)) {
    const saved = db.prepare('SELECT volume_id, volume_name FROM cv_issue_volume WHERE issue_id = ?').get(issueId);
    if (saved?.volume_id) return { id: saved.volume_id, name: saved.volume_name };
    const mon = db.prepare('SELECT series_id FROM monitored_issues WHERE id = ?').get(issueId);
    if (mon) return { id: String(mon.series_id), name: null };
    const v = await volumeOfIssueAnySource(issueId);
    db.prepare('INSERT OR REPLACE INTO cv_issue_volume (issue_id, volume_id, volume_name, at) VALUES (?, ?, ?, ?)').run(issueId, v?.id || null, v?.name || null, Date.now());
    if (v?.id) return v;
  }
  return { reason: 'its Comic Vine issue was not found' };
}
async function runCreateFromFiles(libraryId, userId) {
  const rows = db.prepare(`SELECT id, name, path FROM scanned_series WHERE metadata_status = 'none' ${libraryId ? 'AND library_id = ?' : ''} ORDER BY name`).all(...(libraryId ? [libraryId] : []))
    .filter(r => r.path && !fs.existsSync(path.join(r.path, 'series.json')));
  Object.assign(filesJob, { running: true, stop: false, total: rows.length, done: 0, created: 0, skipped: [], current: null, startedAt: Date.now(), finishedAt: null, note: null });
  try {
    for (const r of rows) {
      if (filesJob.stop) { filesJob.note = 'Stopped.'; break; }
      // Created by hand since the list was made: leave it alone.
      if (fs.existsSync(path.join(r.path, 'series.json'))) { filesJob.done++; continue; }
      filesJob.current = r.name;
      try {
        const v = await volumeForFolder(r.id);
        if (!v.id) { filesJob.skipped.push({ id: r.id, name: r.name, reason: v.reason }); continue; }
        // The library writer scope, as the series page's create gets from its route; one folder at a time,
        // so scans and downloads are not held up for the whole run.
        const out = await libraryAccess.run('write', () => createSeriesJsonFromVolume(r.id, v.id, userId));
        if (out.status) filesJob.skipped.push({ id: r.id, name: r.name, reason: out.error });
        else { filesJob.created++; logger.info('create-from-files', `${r.name} → ${out.name} (Comic Vine ${out.comicid})`); }
      } catch (e) {
        if (e.code === 'CV_HEADROOM' || e.code === 'CV_RATE_LIMIT') {
          filesJob.skipped.push({ id: r.id, name: r.name, reason: 'Comic Vine is at its limit; run again later for this one' });
        } else filesJob.skipped.push({ id: r.id, name: r.name, reason: e.message });
      } finally { filesJob.done++; }
    }
  } finally {
    filesJob.running = false; filesJob.current = null; filesJob.finishedAt = Date.now();
    invalidateSeriesCache();
    try { seriesGrouping.run('create from files'); } catch {}
    logger.info('create-from-files', 'Finished', { total: filesJob.total, created: filesJob.created, skipped: filesJob.skipped.length });
  }
}
app.get('/api/series/no-metadata/create-from-files', requireAdmin, (req, res) => res.json(filesJob));
app.post('/api/series/no-metadata/create-from-files', requireAdmin, (req, res) => {
  if (filesJob.running) return res.json(filesJob);
  if (!anyProvider()) return res.status(400).json({ error: 'Set a Comic Vine API key or a Metron token first (Settings → Connections)' });
  setImmediate(() => runCreateFromFiles(req.body?.libraryId || null, req.user?.sub || null).catch(e => logger.error('create-from-files', 'Failed', e.message)));
  filesJob.running = true;
  res.json(filesJob);
});
app.post('/api/series/no-metadata/create-from-files/stop', requireAdmin, (req, res) => { filesJob.stop = true; res.json(filesJob); });

// Manual run (admin): one batch now; results go to the server log (library-status).
app.post('/api/monitor/library-status/run', requireAdmin, (req, res) => {
  if (!anyProvider()) return res.status(400).json({ error: 'Set a Comic Vine API key or a Metron token first (Settings → Connections)' });
  setImmediate(() => runLibraryStatusCheck().catch(e => logger.error('library-status', 'Run failed', e.message)));
  res.json({ ok: true, message: 'Library status check started — see server log (library-status)' });
});
// ─── Series linked to the wrong Comic Vine volume (hourly, 2026-11-13) ─
// seriesLinkCheck.js; listed on the Library page. Which Comic Vine volume an issue belongs to:
// Metron first (it keeps Comic Vine IDs; its own allowance), then one Comic Vine 'issue' request.
// The background check never uses the last CV_LINK_RESERVE 'issue' requests of the hour, so a
// re-link (which needs them) is not left waiting behind it.
const CV_LINK_RESERVE = 40;
let linkMetronOn = true;
const metronSeriesCv = new Map();   // Metron series id → { id, name } (Comic Vine volume)
async function metronVolumeOfIssue(cvIssueId) {
  if (!linkMetronOn || !(getSetting('metron_api_token') || process.env.METRON_API_TOKEN)) return null;
  try {
    const r = await metron.get('issue/', { cv_id: cvIssueId });
    const hit = (r && r.results || [])[0];
    if (!hit) return null;
    let seriesId = hit.series && hit.series.id;
    if (!seriesId) {
      const d = await metron.get(`issue/${hit.id}/`);
      if (!d || String(d.cv_id) !== String(cvIssueId)) return null;
      seriesId = d.series && d.series.id;
    }
    if (!seriesId) return null;
    if (!metronSeriesCv.has(seriesId)) {
      const sr = await metron.get(`series/${seriesId}/`);
      metronSeriesCv.set(seriesId, sr && sr.cv_id ? { id: String(sr.cv_id), name: sr.name || null } : null);
    }
    return metronSeriesCv.get(seriesId);
  } catch (e) {
    if (e.code === 'METRON_AUTH' || e.code === 'METRON_TOKEN_MISSING') linkMetronOn = false;
    logger.warn('series-links', `Metron lookup failed for issue ${cvIssueId} — using Comic Vine`, e.message);
    return null;
  }
}
// The Comic Vine volume of one Comic Vine issue: Metron first, then one Comic Vine request outside
// the reserve kept for clicks (throws CV_HEADROOM inside it). Shared by the link check and
// "Create from files".
async function volumeOfIssueAnySource(issueId) {
  const m = await metronVolumeOfIssue(issueId);
  if (m) return m;
  if (!getCVKey()) return null;   // Metron-only install: unknown for now
  if (cvWindow('issue').used >= CV_CAP_BACKGROUND - CV_LINK_RESERVE)
    throw Object.assign(new Error('Comic Vine allowance kept for clicks'), { code: 'CV_HEADROOM' });
  const r = await cvApiGet(`https://comicvine.gamespot.com/api/issue/4000-${issueId}/`, {
    params: { api_key: getCVKey(), format: 'json', field_list: 'id,volume' }, headers: { 'User-Agent': 'Omnibus/1.0' }, timeout: 10000 });
  const v = r.data?.results?.volume;
  return v?.id ? { id: String(v.id), name: v.name || null } : null;
}
const seriesLinkCheck = require('./seriesLinkCheck').createSeriesLinkCheck({
  db, logger, pause: () => sleepMs(1100), volumeOfIssue: volumeOfIssueAnySource,
});
// A re-link (enricher create) waits up to an hour when Comic Vine is at its limit; say so instead.
// Returns null when Comic Vine can take the re-link's requests now, else the time it can.
function cvBusyUntil() {
  const now = Date.now();
  let until = 0;
  for (const resource of ['volume', 'issue']) {
    const bo = db.prepare('SELECT until FROM cv_backoff WHERE resource = ?').get(resource);
    if (bo && bo.until > now) until = Math.max(until, bo.until);
    const w = cvWindow(resource);
    if (w.resetAt && w.used >= CV_CAP_INTERACTIVE - 5) until = Math.max(until, w.resetAt);
  }
  return until || null;
}
cron.schedule('41 * * * *', () => {
  if (!anyProvider()) return;
  if (cvPollStartedAt && Date.now() - cvPollStartedAt < 6 * 60 * 60 * 1000) return;
  seriesLinkCheck.run().catch(e => logger.error('series-links', 'Run failed', e.message));
});
app.get('/api/admin/library-health/series-links', requireAdmin, (req, res) => {
  try { res.json({ items: seriesLinkCheck.mismatches(), progress: seriesLinkCheck.progress() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/library-health/series-links/run', requireAdmin, (req, res) => {
  if (!anyProvider()) return res.status(400).json({ error: 'Set a Comic Vine API key or a Metron token first (Settings → Connections)' });
  // A larger batch on request: most lookups go to Metron, and Comic Vine's reserve is kept.
  setImmediate(() => seriesLinkCheck.run({ limit: 300 }).catch(e => logger.error('series-links', 'Run failed', e.message)));
  res.json({ ok: true });
});
// "Link is right": the folder's series.json stays as it is.
app.post('/api/admin/library-health/series-links/:id/dismiss', requireAdmin, (req, res) => {
  res.json({ ok: seriesLinkCheck.dismiss(req.params.id) });
});
// Either source is enough: Comic Vine, Metron, or both (an install may have only one key).
const metronToken = () => getSetting('metron_api_token') || process.env.METRON_API_TOKEN || '';
const anyProvider = () => !!(getCVKey() || metronToken());
cron.schedule('23 * * * *', () => {
  if (!anyProvider()) return;
  if (cvPollStartedAt && Date.now() - cvPollStartedAt < 6 * 60 * 60 * 1000) return;
  runLibraryStatusCheck().catch(e => logger.error('library-status', 'Run failed', e.message));
});

// ─── Admin: location on disk ─────────────────────────────────────
// Translates a container path (/comics/...) to the host path from
// COMICS_HOST_PATH (e.g. D:/Comics → D:\Comics\...) so the admin can find
// a series folder or issue file on the server.
function hostPathFor(p) {
  const hostRoot = process.env.COMICS_HOST_PATH || '';
  const root = (process.env.COMICS_PATH || '/comics').replace(/\/+$/, '');
  if (!p || !hostRoot || (p !== root && !p.startsWith(root + '/'))) return p || null;
  let host = hostRoot.replace(/[\\/]+$/, '') + p.slice(root.length);
  if (/^[A-Za-z]:/.test(hostRoot) || hostRoot.includes('\\')) host = host.replace(/\//g, '\\');
  return host;
}

// GET /api/admin/location?seriesId=ss_… | ?bookId=sb_…
app.get('/api/admin/location', requireAdmin, (req, res) => {
  const { seriesId, bookId } = req.query;
  let p = null;
  if (bookId) {
    p = db.prepare('SELECT path FROM scanned_books WHERE id = ?').get(String(bookId))?.path;
  } else if (seriesId) {
    p = db.prepare('SELECT path FROM scanned_series WHERE id = ?').get(String(seriesId))?.path
      || db.prepare('SELECT directory AS path FROM monitored_series WHERE id = ?').get(String(seriesId))?.path;
  }
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json({ path: p, hostPath: hostPathFor(p), exists: fs.existsSync(p) });
});

// ─── Health check ────────────────────────────────────────────────
// Public, no data. Two callers:
//   • deploy.ps1 — GET /api/health: 200 when the server and database work.
//     It also reports whether the comics folder is visible, so a deploy can
//     warn about a dropped drive share without rolling back good code.
//   • Docker HEALTHCHECK (Dockerfile) — GET /api/health?strict=1: 503 when the
//     comics folder is missing or empty as well, so `docker ps` shows the
//     container as unhealthy. Docker only reports this; it does not restart.
// A server too busy to answer within the healthcheck timeout also shows as
// unhealthy after 3 misses.
let comicsCheckCache = { at: 0, ok: true, entries: 0 };
function comicsFolderOk() {
  if (Date.now() - comicsCheckCache.at < 30000) return comicsCheckCache;
  let ok = false, entries = 0;
  try { entries = fs.readdirSync(COMICS_PATH).length; ok = entries > 0; } catch {}
  comicsCheckCache = { at: Date.now(), ok, entries };
  return comicsCheckCache;
}
app.get('/api/health', (req, res) => {
  let dbOk = true, dbError = null;
  try { db.prepare('SELECT 1').get(); } catch (e) { dbOk = false; dbError = e.message; }
  const comics = comicsFolderOk();
  const body = { ok: dbOk, uptime: Math.round(process.uptime()), db: dbOk, comics: comics.ok, ...(dbError ? { error: dbError } : {}) };
  if (!dbOk || (req.query.strict && !comics.ok)) return res.status(503).json({ ...body, ok: false });
  res.json(body);
});

// ─── Database backups (daily 09:30 UTC ≈ 4:30 AM Central) ────────
// backups.js: integrity-checked copies in DB_BACKUP_DIR (/backups, mapped to the
// host by docker-compose; default ./_backups/db in the install folder) plus the small
// files beside the database, the newest DB_BACKUP_KEEP kept; an optional second
// folder set in Settings › Backups; pin; restore applied on restart (user 2026-11-02).
const DB_BACKUP_KEEP = parseInt(process.env.DB_BACKUP_KEEP || '14', 10) || 14;
const backups = require('./backups').createBackups({ db, Database, dbPath: DB_PATH, dir: DB_BACKUP_DIR, keep: DB_BACKUP_KEEP, getSetting,
  setSetting: (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v), logger });
const runDbBackup = trigger => backups.run(trigger);
if (restoreResult) logger[restoreResult.ok ? 'warn' : 'error']('db-backup', restoreResult.ok ? `Restored ${restoreResult.source}` : `Restore failed: ${restoreResult.error}`, restoreResult);

cron.schedule('30 9 * * *', () => { runDbBackup('scheduled'); });

if (DB_BACKUP_DIR.startsWith(path.dirname(DB_PATH))) {
  console.warn(`[db-backup] Backups go to ${DB_BACKUP_DIR}, inside the data volume — map /backups to a host folder in docker-compose so they survive losing the volume`);
}

const backupError = (res, e) => res.status(e.status || 500).json({ error: e.message });
app.post('/api/admin/backup/run', requireAdmin, async (req, res) => {
  const r = await runDbBackup('manual');
  res.status(r.ok ? 200 : 500).json(r);
});
app.get('/api/admin/backup/list', requireAdmin, (req, res) => {
  try { res.json({ ...backups.list(), secrets: secrets.status(db) }); } catch (e) { backupError(res, e); }
});
app.post('/api/admin/backup/pin', requireAdmin, (req, res) => {
  try { res.json(backups.pin(req.body?.where, req.body?.file, !!req.body?.pinned)); } catch (e) { backupError(res, e); }
});
// The second backup folder: tested, then saved ('' turns it off).
app.post('/api/admin/backup/copy-dir', requireAdmin, (req, res) => {
  const dir = String(req.body?.dir || '').trim();
  if (!dir) { db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('backup_copy_dir', '')").run(); return res.json({ ok: true, dir: '' }); }
  const t = backups.testFolder(dir);
  if (!t.ok) return res.status(400).json({ error: t.error });
  if (req.body?.save !== false) db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('backup_copy_dir', ?)").run(t.dir);
  res.json(t);
});
// Restore: check and stage the backup, finish running work, then restart; the
// swap happens at startup (applyPendingRestore). Docker restarts the container.
app.post('/api/admin/backup/restore', requireAdmin, async (req, res) => {
  if (backups.isRunning()) return res.status(409).json({ error: 'A backup is running; try again in a minute' });
  let staged;
  try { staged = backups.stageRestore(req.body?.where, req.body?.file, req.user?.username || req.user?.sub || null); }
  catch (e) { return backupError(res, e); }
  logger.warn('admin', 'Restore requested — finishing running work, then restarting', { file: staged.file });
  let drained = false;
  try { drained = await deploymentGate.drain(); } catch {}
  if (!drained) {
    backups.cancelRestore();
    try { deploymentGate.resume(); } catch {}
    return res.status(409).json({ error: 'Library work is still running (tagging or file changes). Nothing was changed; try again when it has finished.' });
  }
  for (const [, entry] of activeDownloads) { entry.cancel = true; try { entry.abortController?.abort(); } catch {} }
  res.status(202).json({ ok: true, ...staged, message: 'Restoring… Omnibus restarts and will be back in a minute.' });
  setTimeout(() => { logger.warn('admin', 'Exiting now to apply the restore'); process.exit(0); }, 1000);
});

// "(Unknown)" folders: preview (default), apply, and turn automatic renaming on/off.
// Body: { dryRun: true|false, autoRename: true|false (optional) }
app.post('/api/monitor/unknown-folders/rename', requireAdmin, async (req, res) => {
  try {
    const { dryRun = true, autoRename } = req.body || {};
    if (autoRename !== undefined) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('series_folder_autorename', autoRename ? 'true' : 'false');
    }
    const candidates = db.prepare(`SELECT * FROM monitored_series WHERE directory LIKE '%(Unknown)'`).all();
    const results = [];
    for (const s of candidates) {
      const plan = planUnknownFolderRename(s);
      if (!plan) continue;
      if (dryRun || plan.skip) { results.push({ name: s.name, ...plan, willRename: !plan.skip }); continue; }
      results.push({ name: s.name, ...(await renameUnknownFolder(s, plan)) });
    }
    res.json({ dryRun: !!dryRun, autoRename: folderAutoRenameEnabled(), count: results.length, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CV data refresh ─────────────────────────────────────────────
// Re-fetches cv_data for all issues in a series from Comic Vine.
// Use after a series' credits/details have been updated on CV.

// ─── Shared CV issue refresh ──────────────────────────────────────
/**
 * Fetch all issues for a series from CV and INSERT any new ones.
 * Also UPDATEs cv_data/title on existing rows.
 * Returns { inserted, updated } counts.
 * Safe to call any time — INSERT OR IGNORE means no duplicates.
 */
async function refreshSeriesIssuesFromCV(seriesId) {
  const CV_API_KEY = getCVKey();
  let offset = 0, allIssues = [], total = Infinity;

  while (allIssues.length < total) {
    const r = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
      params: {
        api_key: getCVKey(), format: 'json',
        filter: `volume:${seriesId}`,
        field_list: 'id,issue_number,name,cover_date,store_date,site_detail_url,description,person_credits,character_credits,team_credits,location_credits',
        offset, limit: 100,
      },
      headers: { 'User-Agent': 'Omnibus/1.0' },
      timeout: 15000,
    });
    total = r.data.number_of_total_results || 0;
    const results = r.data.results || [];
    allIssues = allIssues.concat(results);
    if (!results.length) break;
    offset += 100;
    if (allIssues.length < total) await new Promise(res => setTimeout(res, 600));
  }

  const isAnnualCV = (num, name) =>
    ((num || '') + ' ' + (name || '')).toLowerCase().includes('annual') ? 1 : 0;

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO monitored_issues
      (id, series_id, issue_number, title, release_date, store_date, cv_data, is_annual)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE monitored_issues
    SET cv_data = ?, title = ?,
        release_date = COALESCE(?, release_date), store_date = COALESCE(?, store_date)
    WHERE id = ? AND series_id = ?
  `);

  let inserted = 0, updated = 0;
  db.transaction(issues => {
    for (const i of issues) {
      const ins = insertStmt.run(
        String(i.id), seriesId, i.issue_number || '0',
        i.name || null, i.cover_date || null, i.store_date || null,
        JSON.stringify(i), isAnnualCV(i.issue_number, i.name)
      );
      if (ins.changes > 0) {
        inserted++;
      } else {
        updateStmt.run(JSON.stringify(i), i.name || null, i.cover_date || null, i.store_date || null, String(i.id), seriesId);
        updated++;
      }
    }
  })(allIssues);

  db.prepare(`
    UPDATE monitored_series
    SET last_cv_check = datetime('now'),
        total_issues  = (SELECT COUNT(*) FROM monitored_issues WHERE series_id = ?)
    WHERE id = ?
  `).run(seriesId, seriesId);

  return { inserted, updated, total: allIssues.length };
}

app.post('/api/monitor/series/:id/refresh-cv', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(id);
  if (!series) return res.status(404).json({ error: 'Series not found' });
  try {
    const { inserted, updated, total } = await refreshSeriesIssuesFromCV(id);
    logger.info('cv-refresh', `Series ${id}: ${total} issues (${inserted} new, ${updated} updated)`);
    fetchAndSetSeriesStatus(id).catch(() => {});
    res.json({ success: true, total, inserted, updated });
  } catch (e) {
    logger.error('cv-refresh', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ─── Series status helpers ─────────────────────────────────────────
/**
 * Derive ongoing/ended from series.json (primary) or CV API (fallback).
 * series.json sets metadata.status = 'Continuing' | 'Ended'
 * and metadata.publication_run containing 'Present' for ongoing.
 */
function deriveStatusFromSeriesJson(directory) {
  try {
    const jsonPath = path.join(directory, 'series.json');
    if (!fs.existsSync(jsonPath)) return null;
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const m = data?.metadata;
    if (!m) return null;
    const status = (m.status || '').toLowerCase();
    const pubRun = (m.publication_run || '').toLowerCase();
    if (status === 'continuing' || pubRun.includes('present')) return 'ongoing';
    if (status === 'ended' || status === 'completed' || status === 'cancelled') return 'ended';
    return null;
  } catch { return null; }
}

async function fetchAndSetSeriesStatus(seriesId) {
  // 1. Try series.json first — it's already on disk, no API call needed
  const series = db.prepare('SELECT directory FROM monitored_series WHERE id = ?').get(String(seriesId));
  if (series) {
    const fromJson = deriveStatusFromSeriesJson(series.directory);
    if (fromJson) {
      db.prepare(`UPDATE monitored_series SET series_status = ? WHERE id = ?`).run(fromJson, String(seriesId));
      logger.info('series-status', `Series ${seriesId} → ${fromJson} (from series.json)`);
      return;
    }
  }
  // 2. Fallback: CV API volume endpoint — use last_issue.cover_date for recency check.
  // Thresholds (from last issue cover_date):
  //   < 12 months  → ongoing  (actively publishing)
  //   12–24 months → unknown  (possible hiatus; keep polling)
  //   > 24 months  → ended    (almost certainly wrapped up; stop polling)
  // NOTE: last_issue being present does NOT mean ended — CV sets it for every volume.
  try {
    const r = await cvApiGet(`https://comicvine.gamespot.com/api/volume/4050-${seriesId}/`, {
      params: { api_key: getCVKey(), format: 'json', field_list: 'id,last_issue,count_of_issues' },
      headers: { 'User-Agent': 'Omnibus/1.0' },
      timeout: 10000,
    });
    const vol = r.data?.results;
    if (!vol) return;

    let status = 'unknown';
    const coverDate = vol.last_issue?.cover_date; // "YYYY-MM-DD" or "YYYY-MM-00"
    if (coverDate) {
      const issueYear  = parseInt(coverDate.slice(0, 4), 10);
      const issueMonth = parseInt(coverDate.slice(5, 7), 10) || 1;
      const issueMs    = Date.UTC(issueYear, issueMonth - 1, 1);
      const now        = Date.now();
      const twelveMonthsAgo     = now - 365 * 24 * 60 * 60 * 1000;
      const twentyFourMonthsAgo = now - 2 * 365 * 24 * 60 * 60 * 1000;
      if      (issueMs >= twelveMonthsAgo)     status = 'ongoing';
      else if (issueMs <= twentyFourMonthsAgo) status = 'ended';
      // 12–24 month gap stays 'unknown' — possible hiatus, keep polling
    }

    // Only downgrade ongoing → ended, never silently flip ended → unknown via this path.
    // (series.json is the authoritative override for confirmed status.)
    const current = db.prepare('SELECT series_status FROM monitored_series WHERE id = ?').get(String(seriesId));
    if (current?.series_status === 'ended' && status !== 'ongoing') {
      // Already ended and no evidence of new activity — leave it alone.
      logger.debug('series-status', `Series ${seriesId} already ended, no change`);
      return;
    }

    db.prepare(`UPDATE monitored_series SET series_status = ? WHERE id = ?`).run(status, String(seriesId));
    logger.info('series-status', `Series ${seriesId} → ${status} (from CV API, last_issue: ${coverDate || 'none'})`);
  } catch (e) {
    logger.warn('series-status', `Could not fetch status for ${seriesId}`, e.message);
  }
}

// ─── Auto-grab + Series pack ─────────────────────────────────────

/** Score a Prowlarr result title against a target issue number.
 *  Returns 0 if no issue number match found (should skip),
 *  higher = better match. Also checks series name words for relevance. */
// ─── Release classification helpers ─────────────────────────────
// Keywords and patterns that indicate a release is a series pack/volume
// rather than a single issue.
const PACK_KEYWORDS = ['vol.', 'vol ', 'volume', 'complete', 'collection',
  'omnibus', 'tpb', 'compendium', 'annual', 'hardcover', ' hc ', 'deluxe',
  'library edition', 'epic collection', 'masterworks'];

const PACK_PATTERNS = [
  /\b\d{3}-\d{3}\b/,          // 001-012
  /#\d+\s*-\s*#?\d+/,         // #1-#12 or #1-12
  /issues?\s+\d+/i,              // issues 1-12
  /\d{4}[-–]\d{4}/,              // year range 2020-2021
  /vol\.?\s*\d+/i,              // vol.01 vol 2
];

/** Returns a score 0-100 indicating how likely this title is a series pack.
 *  Higher = more likely a pack. */
function packScore(title, sizeBytes) {
  const t = title.toLowerCase();
  let score = 0;

  // Keyword hits
  score += PACK_KEYWORDS.filter(k => t.includes(k)).length * 15;

  // Pattern hits
  score += PACK_PATTERNS.filter(p => p.test(t)).length * 20;

  // Large file size bonus (packs typically >150MB)
  if (sizeBytes > 150 * 1024 * 1024) score += 15;
  if (sizeBytes > 500 * 1024 * 1024) score += 15;

  return Math.min(score, 100);
}


/** Strip bracket noise from a result title, preserving bare 4-digit years.
 *  "(2026) (Digital) (Zone-Empire)" -> "2026"
 *  "[2026] [Digital] [Pyrate-DCP]"  -> "2026"
 *  Years are kept so year-based scoring still works. */
function stripBracketNoise(title) {
  return title
    .replace(/\((\d{4})\)/g, ' $1 ')   // (2026) -> 2026
    .replace(/\[(\d{4})\]/g, ' $1 ')   // [2026] -> 2026
    .replace(/\([^)]*\)/g, ' ')          // remove other () content
    .replace(/\[[^\]]*\]/g, ' ')        // remove other [] content
    .replace(/\s+/g, ' ').trim();
}

/** Extract meaningful words from a string for overlap scoring.
 *  Strips punctuation, drops stop words, drops pure numbers (issue#/years),
 *  drops words under 3 chars. */
const SCORE_STOP = new Set(['the','a','an','of','in','on','at','to','for','and','or','vol','issue']);
function sigWords(str) {
  return str.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    // Keep 4-digit years (1960-2040) — they matter for matching.
    // Drop other pure numbers (issue numbers, page counts, etc).
    .filter(w => w.length > 2 && (!(/^\d+$/.test(w)) || /^(19[6-9]\d|20[0-3]\d)$/.test(w)) && !SCORE_STOP.has(w));
}

/** Score a Prowlarr/GetComics result for a specific single issue.
 *  Returns 0 if no issue number match or if it looks like a pack.
 *  Higher = better match.
 *
 *  Scoring:
 *    +15 per issue-number pattern match (base signal)
 *    +3  per series-name word found in cleaned result title (overlap bonus)
 *    penalty for significant words in result that are NOT in the series name:
 *      >= 60% unmatched -> -70% of score  (e.g. Batman-Superman-Worlds Finest vs Batman)
 *      >= 40% unmatched -> -40% of score  (e.g. Absolute Batman vs Batman)
 *      >= 25% unmatched -> -15% of score  (minor mismatch)
 */
/** Score a Prowlarr/GetComics result for a specific single issue.
 *  Returns 0 if no issue-number match or if it looks like a pack.
 *  Higher score = better match. */
// ─── Year check for search results ───────────────────────────────
// scoreResult matches series name and issue number only, so "Batman #1" from
// 2011 scores the same as "Batman #1" from 2026 — the main wrong-issue risk is
// #1 of a relaunched series. Reject a result only when its title names a year
// and none of its years is within 1 of the issue's year (the 1-year slack
// covers cover year vs on-sale year around December/January). If the issue
// has no date yet, or the title has no year, the result is kept: missing data
// never blocks a grab.
function issueYearOf(issue) {
  const y = parseInt(String(issue?.store_date || issue?.release_date || '').slice(0, 4), 10);
  return y >= 1900 && y <= 2100 ? y : null;
}
function titleYears(title) {
  // Only years in parentheses, e.g. "(2026)". Bare numbers are ignored because
  // they are often part of the series name ("2000 AD", "X-Men 1991", "1602").
  return [...String(title || '').matchAll(/\((19\d\d|20\d\d)\)/g)].map(m => +m[1]);
}
function resultYearOk(title, issue) {
  const want = issueYearOf(issue);
  if (!want) return true;
  const ys = titleYears(title);
  if (!ys.length) return true;
  return ys.some(y => Math.abs(y - want) <= 1);
}
// Filter helper used by every automatic grab path; logs what it drops.
function dropWrongYear(candidates, issue, label) {
  const kept = [];
  for (const r of candidates) {
    if (resultYearOk(r.title, issue)) kept.push(r);
    else logger.info('year-check', `Skipped "${r.title}" for ${label} #${issue.issue_number} — year differs from ${issueYearOf(issue)}`);
  }
  return kept;
}

function scoreResult(title, seriesName, issueNumber) {
  const t = title.toLowerCase();

  // Preserve dot-decimals (648.1) and suffixes (1.NOW, 14.MU). Strip leading
  // zeros from the integer part only — so "008.1" normalizes to "8.1" — and
  // escape regex metacharacters from whatever's left. parseInt would discard
  // the suffix entirely, causing 648.1 to match plain 648 releases.
  const raw = String(issueNumber || '0').trim();
  if (!raw || raw === '0') return 0;
  // Split on first dot to separate integer base from suffix (digits or letters)
  const dotIdx = raw.indexOf('.');
  const intPart = dotIdx === -1 ? raw : raw.slice(0, dotIdx);
  const suffix  = dotIdx === -1 ? ''  : raw.slice(dotIdx + 1).toLowerCase();
  const intStripped = String(parseInt(intPart, 10) || 0);
  if (intStripped === '0') return 0;
  // The "e" we look for in titles. For 648.1 → "648\.1"; for 1.NOW → "1\.now"
  // (lowercase because we also lowercased the title).
  const escSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const e = suffix ? `${intStripped}\\.${escSuffix}` : intStripped;

  // Immediately reject packs
  if (packScore(title, 0) >= 20) return 0;

  // Issue-number match patterns. "bound" must NOT include `.` when we're
  // matching a plain integer — otherwise "648" matches "648.1" titles, which
  // is a different issue. When matching a decimal (already includes the dot
  // in `e`), the bound after the suffix can include normal whitespace.
  const sep   = '[\\.\\s_#-]*';
  const zeros = '0*';
  const bound = suffix
    ? '(?:[\\s_#(\\[{]|$)'                 // decimal — any non-letter boundary
    : '(?:[\\s_#(\\[{]|$)';                // plain integer — NO trailing dot

  const patterns = [
    new RegExp(`(?<![\\d])${zeros}${e}${bound}`),
    new RegExp(`#${zeros}${e}${bound}`),
    new RegExp(`\\(${zeros}${e}\\)`),
    new RegExp(`\\[${zeros}${e}\\]`),
    new RegExp(`(?<![\\d])${zeros}${e}${sep}of${sep}\\d`, 'i'),
  ];

  const matchCount = patterns.filter(p => { try { return p.test(t); } catch { return false; } }).length;
  if (matchCount === 0) return 0;

  let score = matchCount * 15;

  // ── Overlap bonus ─────────────────────────────────────────────
  const cleanedTitle = stripBracketNoise(t);
  const seriesWords  = sigWords(seriesName);
  const matched = seriesWords.filter(w => cleanedTitle.includes(w)).length;
  score += matched * 3;

  // ── Extra-word penalty ────────────────────────────────────────
  // Meaningful words in result not in series name → different series
  const resultWords   = sigWords(cleanedTitle);
  const seriesWordSet = new Set(seriesWords);
  const unmatched     = resultWords.filter(w => !seriesWordSet.has(w)).length;
  const total         = resultWords.length;

  if (total > 0 && unmatched >= 1) {
    const ratio = unmatched / total;
    let penaltyPct = 0;
    if      (ratio >= 0.60) penaltyPct = 0.70;
    else if (ratio >= 0.40) penaltyPct = 0.40;
    else if (ratio >= 0.25) penaltyPct = 0.15;
    if (penaltyPct > 0) score = Math.max(1, Math.round(score * (1 - penaltyPct)));
  }

  return score;
}

// ─── Stop-word list (shared by search query builders) ────────────
const STOP_WORDS = new Set(['the','a','an','of','in','on','at','to','for','and','or','new','all']);

function buildLooseSeriesName(seriesName) {
  // Keep dotted initialisms ("G.I.", "S.H.I.E.L.D.") intact — stripping the
  // dots split "G.I. Joe" into one-letter words that were dropped, so the
  // search became just "Joe" and found nothing.
  return seriesName
    .split(/\s+/)
    .map(w => {
      const letters = w.replace(/[^A-Za-z.]/g, '');
      return /^(?:[A-Za-z]\.){2,}$/.test(letters) ? letters : w.replace(/[^a-zA-Z0-9]/g, ' ');
    })
    .join(' ').replace(/\s+/g, ' ').trim()
    .split(' ').filter(w => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, 4).join(' ');
}

// Build a Prowlarr/GetComics search query for a single issue.
// Annuals use: "Series Annual NNN (Year)"  — parens match real file naming
// Builds a Prowlarr (NZB) or GetComics (DDL) search query for a single issue.
//   NZB  (gcStyle=false): "Batman 007 2026"          zero-padded, bare year
//   GC   (gcStyle=true):  "Batman #7 (2026)"          natural #N, year in parens
//   Annual NZB:           "Deadpool Annual 001 (2019)"
//   Annual GC:            "Deadpool Annual #1 (2019)"
// GetComics consistently uses #N for all issues and (Year) in parens.
// Zero-padded "001" returns nothing on GetComics; "#1" or "1" both work.
function buildIssueSearchQuery(issue, seriesName, seriesYear, { gcStyle = false } = {}) {
  const looseName = buildLooseSeriesName(seriesName);
  // Use issue's own store/release date for year — NOT series launch year.
  // Series launch year causes false negatives when issues are tagged with a later year
  // (e.g. series launched 2025 but issue #10 is dated 2026).
  // Only include year in query when we have an actual issue date.
  const issueYear = (issue.store_date || issue.release_date || '').slice(0, 4);

  // Preserve decimals/suffixes (648.1, 1.NOW). parseInt would silently drop
  // them, causing the search to ask for the wrong issue. Format depends on
  // style:
  //   GC:  natural number with `#` prefix          → "Spider-Man #648.1 (2010)"
  //   NZB: zero-padded integer base, decimal kept  → "Spider-Man 648.1 2010"
  //                                                  "Spider-Man 008.1 2010"
  // padIssueNumStr below handles both: integer part gets zero-padded to 3 chars
  // when not gcStyle, suffix preserved as-is.
  const rawNum = String(issue.issue_number || '0').trim();
  const num = gcStyle ? '#' + rawNum : padIssueNumStr(rawNum, 3);

  if (issue.is_annual) {
    const hasAnnualInName = /annual/i.test(seriesName);
    const base = hasAnnualInName ? looseName : `${looseName} Annual`;
    return issueYear ? `${base} ${num} (${issueYear})` : `${base} ${num}`;
  }

  // Regular issues: GC uses parens for year; NZB uses bare year
  // Only append year when we have an actual issue date (not series start year)
  if (gcStyle) {
    return issueYear ? `${looseName} ${num} (${issueYear})` : `${looseName} ${num}`;
  }
  return issueYear ? `${looseName} ${num} ${issueYear}` : `${looseName} ${num}`;
}

// Zero-pad helper now lives in issueNumber.js (single source of truth).
// Re-exported as a local for backwards compat with existing call sites.
const padIssueNumStr = IN.padIssueNumStr;

// ─── Download retry engine ────────────────────────────────────────
// The rules — temporary errors, rate limits, refusing hosts, deploy pauses and
// the two kinds of blocked link — live in downloads/retryPolicy.js (moved
// 2026-11-03, with tests); this part finds the next source for an issue.
const { createRetryPolicy, stallGuard, isTransientDownloadError, MANUAL_ONLY_HOSTS, MAX_DOWNLOAD_ATTEMPTS, COOLDOWN_STEPS_MIN: DDL_COOLDOWN_STEPS_MIN } = require('./downloads/retryPolicy');
const retryPolicy = createRetryPolicy({ db, logger });
const deferForRateLimit = (issue, reason) => retryPolicy.deferForRateLimit(issue, reason);
// One-time (2026-11-03): classify old blocks and release the ones for temporary reasons.
try { retryPolicy.migrate(getSetting('blocklist_kinds_2026_11'), () => db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('blocklist_kinds_2026_11', 'done')").run()); }
catch (e) { logger.error('retry', 'Blocklist cleanup failed', e.message); }

// One-time (2026-11-03): genres the enricher saved together with its commentary
// ("\"Heist\" is not in the list…", "Action\n\nWait"), see genres.js. Runs 30 s after
// start, in the background; repeats at the next start if a library folder was unreachable.
if (!getSetting('genres_repair_2026_11')) setTimeout(() => {
  try {
    const r = require('./genres').repairStoredGenres({ db, readSeriesJson, writeSeriesJson: writeSeriesJsonSynced, logger });
    logger.info('genres', `Genre repair: ${r.changed} series cleaned${r.emptied.length ? `; left with no genre (run Enrich on them): ${r.emptied.join(', ')}` : ''}${r.failed ? `; ${r.failed} could not be read, will retry at next start` : ''}`);
    if (!r.failed) db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('genres_repair_2026_11', 'done')").run();
  } catch (e) { logger.error('genres', 'Genre repair failed', e.message); }
}, 30000).unref?.();

// blacklistAndRetry (record a failed link, try the next source), the GetComics download
// queue, the Queue tab routes and runDdlDownloadNow: downloads/issueDownloads.js (moved
// 2026-11-05, downloads stage 3), created below after the GetComics helpers.

// ─── Pack-aware Prowlarr search ──────────────────────────────────
// Like /api/prowlarr/search but annotates each result with packScore
// and looksLikePack so the UI can show confidence indicators.
// Also accepts an optional ?packMode=1 that biases the query toward packs.
app.get('/api/prowlarr/search-classified', requireDownloadAccess, async (req, res) => {
  try {
    const { q } = req.query;
    const protocolFilter = (req.query.protocol || 'any').toLowerCase();
    const prowlarrUrl = getSetting('prowlarr_url') || PROWLARR_URL;
    const prowlarrKey = getSetting('prowlarr_api_key') || PROWLARR_API_KEY;

    const r = await axios.get(`${prowlarrUrl}/api/v1/search`, {
      params: { query: q, type: 'search', limit: 100, categories: '7030' },
      headers: { 'X-Api-Key': prowlarrKey },
      timeout: PROWLARR_TIMEOUT_MS,
    });

    let releases = (r.data || []).map(rel => {
      const ps = packScore(rel.title || '', rel.size || 0);
      return {
        protocol:     rel.protocol    || '',
        title:        rel.title       || '',
        size:         rel.size        || 0,
        indexer:      rel.indexer     || '',
        grabs:        rel.grabs       ?? null,
        downloadUrl:  rel.downloadUrl || rel.magnetUrl || '',
        guid:         rel.guid        || '',
        packScore:    ps,
        looksLikePack: ps >= 20,
      };
    });
    if (protocolFilter === 'usenet')  releases = releases.filter(r => r.protocol !== 'torrent');
    if (protocolFilter === 'torrent') releases = releases.filter(r => r.protocol === 'torrent');

    res.json(releases);
  } catch (e) {
    logger.error('prowlarr', 'Classified search failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GetComics (DDL) ─────────────────────────────────────────────
// Uses FlareSolverr to bypass Cloudflare, scrapes getcomics.org,
// and streams direct download links through our own downloader.

// FlareSolverr (downloads/flaresolverr.js, 2026-11-03): clearance kept per domain for
// 30 minutes, one solve at a time per domain, challenge pages treated as expired.
// fsCache is shared with downloadSecurity.cachedDownloadHeaders and the LOCG code.
const flareSolverr = require('./downloads/flaresolverr').createFlareSolverr({ url: FLARESOLVERR_URL, axios, logger, useSessions: process.env.FLARESOLVERR_SESSIONS === '1' });
const fsCache = flareSolverr.cache;
// 90 s: GetComics has been slow enough that 60 s returned half-loaded pages (2026-11-03).
const fetchViaFlareSolverr = (url, timeoutMs = 90000) => flareSolverr.fetchPage(url, timeoutMs);

// GetComics scraping and link resolution: downloads/getcomics.js (moved 2026-11-04).
const { scrapeGcResults, saveGcSample, scrapeGcLinks, resolveDldsLink } = require('./downloads/getcomics')
  .createGetComics({ axios, logger, fs, path, LOG_DIR, fsCache, fetchViaFlareSolverr });

// Pixeldrain, MediaFire and MEGA downloads: downloads/hosts.js (moved 2026-11-04).
const { pixeldrainBehind, downloadPixeldrain, downloadMediaFire, downloadMega, sniffDownload, THIRD_PARTY_HOST, downloadThirdParty } = require('./downloads/hosts')
  .createHostDownloaders({ axios, logger, fs, stallGuard, isCancelled, pushDownloadUpdate, pushDownloadProgress });

// ─── Downloads modules (downloads stage 3, 2026-11-05) ─────────────
// Moved out of server.js unchanged: packs (grab route, post-processor), single-issue
// downloads (next-source retry, GetComics queue, Queue tab), GetComics routes, and
// wanted issues (auto-grab, wanted list, wanted scanner, failed-issue retry). Each
// factory refuses to start when something it needs is missing. metadataRuntime is
// created further down, and postProcess / postProcessPack are wrapped further down
// (coordinateDownload), so those are passed as calls made when needed.
const metadataRuntimeCalls = { status: (...a) => metadataRuntime.status(...a), arrive: (...a) => metadataRuntime.arrive(...a) };
let { postProcessPack } = require('./downloads/packs').createPacks({
  app, requireDownloadAccess, db, logger, axios, fs, path, getSetting, IN, DB_PATH,
  SABNZBD_URL, SABNZBD_API_KEY, qbtLogin, resolveQbtHash, sniffDownload, execFileAsync,
  metadataRuntime: metadataRuntimeCalls, filenameYear, issueYearsOf, sqlTime, CV_WAIT_REASON, schedulePostProcessScan,
  // Pack files not filed (2026-11-10): View and File as issue in Download Manager › Queue.
  requireAdmin, asArrival, coverThumb, filterImages, readArchiveMember, listArchiveFiles: (...a) => listArchiveFiles(...a),
});
// One search for a single issue's next source, shared by the next-source retry,
// auto-grab and the wanted scanner (2026-11-05).
const sourceSearch = require('./downloads/sourceSearch').createSourceSearch({
  axios, logger, getSetting, retryPolicy, PROWLARR_URL, PROWLARR_API_KEY, PROWLARR_TIMEOUT_MS, SABNZBD_URL, SABNZBD_API_KEY,
  buildIssueSearchQuery, scoreResult, dropWrongYear, fetchViaFlareSolverr, scrapeGcResults, scrapeGcLinks, resolveDldsLink,
});
const issueDownloads = require('./downloads/issueDownloads').createIssueDownloads({
  requireAdmin, requireDownloadAccess, db, logger, axios, fs, path, getSetting, sourceSearch,
  retryPolicy, deferForRateLimit, MANUAL_ONLY_HOSTS, MAX_DOWNLOAD_ATTEMPTS, DDL_COOLDOWN_STEPS_MIN, stallGuard, isTransientDownloadError,
  fsCache, downloadPixeldrain, downloadThirdParty,
  activeDownloads, pushDownloadUpdate, pushDownloadProgress, isCancelled, finalizeCancellation,
  ddlPostProcessing, asArrival, postProcess: (...a) => postProcess(...a), metadataRuntime: metadataRuntimeCalls,
});
const { blacklistAndRetry, runDdlDownload } = issueDownloads;
require('./downloads/getcomicsRoutes').registerGetComicsRoutes({
  app, requireAdmin, requireDownloadAccess, db, logger, axios, fs, path, getSetting,
  fetchViaFlareSolverr, scrapeGcResults, scrapeGcLinks, resolveDldsLink,
  MANUAL_ONLY_HOSTS, THIRD_PARTY_HOST, pixeldrainBehind, downloadThirdParty, sniffDownload, stallGuard,
  activeDownloads, pushDownloadUpdate, pushDownloadProgress, isCancelled, finalizeCancellation,
  blacklistAndRetry, runDdlDownload, asArrival, postProcessPack: (...a) => postProcessPack(...a),
});
const { startAutoGrab, wantedScanState, FAILED_RETRY_MAX_WEEKS } = require('./downloads/wanted').createWanted({
  app, requireDownloadAccess, db, logger, cron, getSetting, retryPolicy, sourceSearch, runDdlDownload,
  PROWLARR_URL, PROWLARR_API_KEY, SABNZBD_URL, SABNZBD_API_KEY,
  activeDownloads, pushDownloadUpdate, isCancelled, finalizeCancellation,
  activePackFor, annotateWaiting, runFillAutoRemove,
});
issueDownloads.registerQueueRoutes(app, { wantedScanState, FAILED_RETRY_MAX_WEEKS });

// Auto-grab, the wanted list, the wanted scanner and the failed-issue retry:
// downloads/wanted.js (moved 2026-11-05, downloads stage 3).

// ─── Pack post-processor ──────────────────────────────────────────
// The grab-pack route and postProcessPack: downloads/packs.js (moved 2026-11-05,
// downloads stage 3). These two helpers stay here (used by the series refresh too).
// Issue-number normalisation lives in backend/issueNumber.js — single
// source of truth across reconciler, scanner, search, sort, pack-pp.
// These wrappers preserve the existing call shape so the rest of this
// file doesn't need touch-ups.
function normalizeIssueNum(n) {
  return IN.normIssueNumber(n) || '0';
}

// extractIssueNumber lives in backend/issueNumber.js — re-exported as a local
// const so all existing call sites (extractIssueNumber(...)) keep working.
// The module version adds no-dot Marvel suffix handling (8AU, 14AU, 1NOW)
// gated by MARVEL_TIE_IN_SUFFIXES.
const extractIssueNumber = IN.extractIssueNumber;

// ─── Refresh series directory ────────────────────────────────────
// Scans the series folder for comic files, matches them to monitored issues
// by issue number, and reconciles DB state:
//   - File found, issue not processed → mark processed
//   - Issue marked processed, file missing → reset to wanted
// Returns { matched, reset, unmatched, detail }
/**
 * Core refresh logic — scans a series directory and reconciles DB state.
 * Returns { matched, reset, unmatched, total_files, detail } or throws.
 * Safe to call any time (add, import, manual refresh button).
 */
// Scan all processed issues in a series and populate their has_comicinfo flag.
// Async + sequential so we don't thrash the disk or flood the DB.
// If onlyUnknown is true (the default), skips issues that have already been
// scanned — much faster on repeat runs. Set to false to force a full re-scan.
async function scanSeriesComicInfo(seriesId, { onlyUnknown = true } = {}) {
  const whereFlag = onlyUnknown ? 'AND has_comicinfo IS NULL' : '';
  const issues = db.prepare(
    `SELECT id, file_path FROM monitored_issues
     WHERE series_id = ? AND status = 'processed' AND file_path IS NOT NULL ${whereFlag}`
  ).all(seriesId);

  if (!issues.length) return { scanned: 0, tagged: 0, untagged: 0, skipped: 0 };

  const update = db.prepare('UPDATE monitored_issues SET has_comicinfo = ? WHERE id = ?');
  let tagged = 0, untagged = 0, skipped = 0;

  for (const i of issues) {
    if (!fs.existsSync(i.file_path)) { skipped++; continue; }
    const has = await archiveHasComicInfo(i.file_path);
    if (has === null) { skipped++; continue; }
    update.run(has ? 1 : 0, i.id);
    if (has) tagged++; else untagged++;
  }
  logger.info('comicinfo-scan', `Series ${seriesId}`, { total: issues.length, tagged, untagged, skipped });
  return { scanned: issues.length, tagged, untagged, skipped };
}

async function runRefreshDirectory(seriesId) {
  const observedIdentities=new Map();
  const confirmedIdentity=async(file,issue)=>{
    if(!observedIdentities.has(file)){
      const xml=await extractComicInfo(file);
      const decision=decideMetadataIdentity({bookId:'refresh-observation',arrival:'scanner',filename:path.basename(file),comicInfoXml:xml});
      observedIdentities.set(file,decision.status==='accepted'?decision.cvIssueId:null);
    }
    return observedIdentities.get(file)===String(issue.id);
  };
  const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(seriesId);
  if (!series) throw new Error('Series not found');

  // Directory missing: reset every previously-matched issue back to 'wanted'.
  // Bailing without resetting (the previous behaviour) left stale 'processed'
  // rows whose file_path pointed into a directory the series no longer owns,
  // producing misleading card UIs ("5/51 issues" with no directory on disk).
  // The reset matches the same field set Phase 2 below uses when an
  // individual file goes missing — symmetric, predictable, and recoverable
  // (point the directory back at valid files, click Refresh, those issues
  // return to 'processed' via the regular match path).
  if (!fs.existsSync(series.directory)) {
    // Retry after 3 seconds — Windows/Docker volume mounts can be briefly
    // unavailable at startup or after a hiccup. Don't nuke processed state
    // on a transient read failure.
    await new Promise(r => setTimeout(r, 3000));
    if (!fs.existsSync(series.directory)) {
      const stale = db.prepare(`
        SELECT id, issue_number, file_path FROM monitored_issues
        WHERE series_id = ? AND status IN ('processed', 'downloaded') AND is_annual = 0
      `).all(series.id);
      if (stale.length) {
        logger.warn('refresh-dir',
          `Series "${series.name}" directory missing — reset ${stale.length} stale match(es)`,
          { directory: series.directory, caller: new Error().stack.split('\n').slice(1,4).join(' | ') });
        appendResetLog(`Series "${series.name}" directory missing — reset ${stale.length} issues`, { directory: series.directory });
        const reset = db.prepare(`
          UPDATE monitored_issues
          SET status = 'wanted', file_path = NULL, download_id = NULL, date_processed = NULL
          WHERE id = ?
        `);
        for (const issue of stale) {
          reset.run(issue.id);
        }
        return { matched: 0, reset: stale.length, unmatched: 0, total_files: 0, detail: [], directory_missing: true };
      }
      return { matched: 0, reset: 0, unmatched: 0, total_files: 0, detail: [], directory_missing: true };
    }
    logger.info('refresh-dir', `Series "${series.name}" directory appeared on retry — continuing`, { directory: series.directory });
    invalidateDirectoryExistsCache(seriesId);
  }

  const allIssues = db.prepare('SELECT * FROM monitored_issues WHERE series_id = ?').all(series.id);

  let dirFiles;
  try {
    dirFiles = fs.readdirSync(series.directory).filter(f => /\.(cbz|cbr|zip|rar)$/i.test(f));
  } catch (e) {
    throw new Error(`Cannot read directory: ${e.message}`);
  }

  // Build a map: normalized issue number → full file path
  // Keys stored as BOTH integer string AND full extracted string (e.g. "14" AND "14.1")
  // Annual-named files are excluded — they are handled separately in Phase 2
  //
  // For special series (sharing a directory with a parent), require the filename to
  // start with the normalised series name. This is much more reliable than word matching:
  // "Amazing Spider-Man Blood Hunt 001.cbz" starts with "amazingspidermanbloodhunt" ✓
  // "Amazing Spider-Man 001 (2022).cbz" does not                                    ✗
  let specialNamePrefix = null;
  // is_special is the authoritative "I am a special" flag — set on add when
  // the user picked "Special of …". parent_series_id is also accepted for
  // backwards compat (older specials backfilled to is_special=1 at startup,
  // but the OR keeps us safe if the migration ever lags).
  if (series.is_special || series.parent_series_id) {
    specialNamePrefix = series.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    logger.info('refresh-dir', `Special series — filtering files by name prefix`, { series: series.name, prefix: specialNamePrefix });
  }

  // The reverse, for a parent: files that belong to a special sharing this
  // folder ("Knight Terrors Catwoman 001" in Catwoman (2018)) are never matched
  // to the parent's issues by number. Same name-prefix rule the special uses.
  const normFile = f => String(f || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const ownNorm = normFile(series.name);
  const specialPrefixes = specialNamePrefix ? [] : db.prepare(
    `SELECT name FROM monitored_series WHERE directory = ? AND id != ? AND (is_special = 1 OR parent_series_id IS NOT NULL)`
  ).all(series.directory, series.id).map(r => normFile(r.name)).filter(p => p.length >= 4 && p !== ownNorm && !ownNorm.startsWith(p));
  const belongsToSpecial = f => specialPrefixes.some(p => normFile(path.basename(f)).startsWith(p));
  if (specialPrefixes.length) logger.info('refresh-dir', `Parent series — ignoring files of ${specialPrefixes.length} special(s) in this folder`, { series: series.name });

  // Several files can share an issue number ("Superman 001", "Superman House
  // of Brainiac Special 001"). Prefer the one named exactly like the series;
  // the file tagged with the issue's own Comic Vine id wins over both (below).
  const nameScore = f => { const n = normFile(f); return ownNorm && n.startsWith(ownNorm) && /^\d/.test(n.slice(ownNorm.length)) ? 2 : 1; };
  const better = (newF, oldPath, isCbz) => {
    if (!oldPath) return true;
    const a = nameScore(newF), b = nameScore(path.basename(oldPath));
    return a !== b ? a > b : isCbz;   // equal names: the old rule (CBZ wins)
  };
  // Comic Vine id → file, for files in this folder (the scanner's record).
  const cvFile = new Map();
  try {
    for (const r of db.prepare(`SELECT path, cv_issue_id FROM scanned_books WHERE path LIKE ? AND cv_issue_id IS NOT NULL AND cv_issue_id != ''`)
      .all(series.directory.replace(/[\\/]+$/, '') + '/%')) {
      if (path.dirname(r.path) !== series.directory.replace(/[\\/]+$/, '')) continue;
      if (specialPrefixes.length && belongsToSpecial(r.path)) continue;
      if (/annual/i.test(path.basename(r.path))) continue;   // same rule as by-number: annual files never stand in for regular issues
      if (fs.existsSync(r.path)) cvFile.set(String(r.cv_issue_id), r.path);
    }
  } catch (e) { logger.warn('refresh-dir', 'CV file lookup failed', e.message); }

  // Comic Vine id the scanner recorded for every file (annuals included) in the
  // folders this refresh looks at. A file tagged as a DIFFERENT CV issue is never
  // matched to an issue by number — that is how a monitored 2023 annual got
  // linked to the 2026 annual's file (every year's annual is #1).
  const cvOfPath = new Map();
  const cvLoaded = new Set();
  const loadCv = dir => {
    const d = String(dir || '').replace(/[\\/]+$/, '');
    if (!d || cvLoaded.has(d)) return;
    cvLoaded.add(d);
    try {
      for (const r of db.prepare(`SELECT path, cv_issue_id FROM scanned_books WHERE path LIKE ? AND cv_issue_id IS NOT NULL AND cv_issue_id != ''`).all(d + '/%'))
        if (path.dirname(r.path) === d) cvOfPath.set(r.path, String(r.cv_issue_id));
    } catch (e) { logger.warn('refresh-dir', 'CV tag lookup failed', e.message); }
  };
  loadCv(series.directory);
  const taggedAsOther = (p, issue) => { const c = cvOfPath.get(p); return !!c && c !== String(issue.id); };
  const claimedByOther = (p, issue) => !!db.prepare(
    `SELECT 1 FROM monitored_issues WHERE file_path = ? AND id != ? AND status = 'processed' LIMIT 1`).get(p, issue.id);
  const fileYear = p => { const m = path.basename(p).match(/(?:^|[^0-9])((?:19|20)[0-9]{2})(?:[^0-9]|$)/); return m ? m[1] : null; };
  const issueYears = issue => [issue.release_date, issue.store_date].filter(Boolean).map(d => String(d).slice(0, 4));
  const pushNum = (m, k, p) => { if (!m.has(k)) m.set(k, []); if (!m.get(k).includes(p)) m.get(k).push(p); };
  // Pick the file for an annual issue: the file tagged with its own CV id; else
  // by issue number, but only a file that is not tagged as another issue, not
  // already linked to another issue, and whose filename year (if any) is the
  // issue's year. Several still possible → no match (logged), never a guess.
  function pickAnnualFile(issue, byNum, dir, label) {
    const d = String(dir || '').replace(/[\\/]+$/, '');
    loadCv(d);
    const id = String(issue.id);
    for (const [p, c] of cvOfPath) {
      if (c === id && path.dirname(p) === d && /annual/i.test(path.basename(p)) && fs.existsSync(p)) return p;
    }
    const norm = normalizeIssueNum(issue.issue_number);
    if (!norm) return null;
    let cands = byNum.get(norm) || [];
    if (!cands.length && !norm.includes('.')) {
      const intKey = String(parseInt(String(issue.issue_number || '0').replace(/,/g, ''), 10) || 0);
      if (intKey !== norm) cands = byNum.get(intKey) || [];
    }
    const ys = issueYears(issue);
    const ok = cands.filter(p => !taggedAsOther(p, issue) && !claimedByOther(p, issue)
      && (!ys.length || !fileYear(p) || ys.includes(fileYear(p))));
    if (!ok.length) {
      if (cands.length) logger.info('refresh-dir', `Annual #${issue.issue_number} not matched — candidate file(s) are another year, another CV issue, or already linked`,
        { series: label, issueYears: ys, files: cands.map(p => path.basename(p)) });
      return null;
    }
    if (ok.length > 1) {
      const cbz = ok.filter(p => /\.cbz$/i.test(p));
      if (cbz.length === 1) return cbz[0];
      logger.warn('refresh-dir', `Annual #${issue.issue_number} not matched — ${ok.length} possible files`, { series: label, files: ok.map(p => path.basename(p)) });
      return null;
    }
    return ok[0];
  }

  const filesByNum = new Map();
  for (const filename of dirFiles) {
    if (/annual/i.test(filename)) continue; // never match annual files to regular issues
    if (specialPrefixes.length && belongsToSpecial(filename)) continue;  // a special's file, not ours
    // For special series, only match files whose normalised name starts with the series name
    if (specialNamePrefix) {
      const fileNorm = filename.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!fileNorm.startsWith(specialNamePrefix)) continue;
    }
    const extracted = extractIssueNumber(filename);
    if (extracted !== null) {
      const fullPath = path.join(series.directory, filename);
      const isCbz = filename.toLowerCase().endsWith('.cbz');
      // Always store the full extracted key (handles 14.1, 14.MU, 1000000, 8.AU)
      if (better(filename, filesByNum.get(extracted), isCbz)) {
        filesByNum.set(extracted, fullPath);
      }
      // Integer-only alias — ONLY when the extracted form is a pure integer
      // (no dot). Adding the alias for "8.AU" or "14.1" was the bug: it let
      // a regular issue 8 query hit an 8.AU file (or vice versa) via the
      // matching loop's intKey fallback. With canonical extraction, "008"
      // already collapses to "8", so this branch is effectively a no-op for
      // plain integers and is skipped entirely for suffixed/decimal forms.
      if (!extracted.includes('.')) {
        const intKey = String(parseInt(extracted, 10));
        if (intKey !== extracted && better(filename, filesByNum.get(intKey), isCbz)) {
          filesByNum.set(intKey, fullPath);
        }
      }
    }
  }

  const detail = [];
  let matched = 0, reset = 0, unmatched = filesByNum.size; // only non-annual files

  // Phase 1: match files → issues
  for (const issue of allIssues.filter(i => !i.is_annual)) {
    // Linked to a special's file: drop the link and SKIP the issue (do not
    // make it wanted — these are issues the owner chose not to collect here).
    // Clearing the retag state means the retagger never writes this issue's
    // data into the special's file.
    if (specialPrefixes.length && issue.file_path && belongsToSpecial(issue.file_path)) {
      db.prepare(`UPDATE monitored_issues SET status = 'skipped', file_path = NULL, download_id = NULL, date_processed = NULL,
        has_comicinfo = NULL, last_retag_cv_hash = NULL WHERE id = ?`).run(issue.id);
      detail.push({ issue_number: issue.issue_number, action: 'skipped', reason: `file belongs to a special: ${path.basename(issue.file_path)}` });
      logger.info('refresh-dir', `Issue #${issue.issue_number} unlinked from a special's file`, { series: series.name, file: issue.file_path });
      // Fall through to the normal match below: if the real issue's file is
      // also in the folder it gets linked (processed); otherwise it stays skipped.
      issue.status = 'skipped'; issue.file_path = null;
    }
    // normalizeIssueNum produces canonical form: "8.AU", "14.1", "1.NOW", "1000000".
    const norm = normalizeIssueNum(issue.issue_number);
    // Integer fallback ONLY when the canonical form has no dot — i.e. a plain
    // integer issue. For "8.AU" / "14.1" / "1.NOW", the suffix/decimal IS the
    // identity of the issue and the fallback would false-match against a
    // plain-integer file ("8.AU" matching a regular #8 file was the bug).
    let filePath = cvFile.get(String(issue.id)) || filesByNum.get(norm);
    if (!filePath && !norm.includes('.')) {
      const intKey = String(parseInt(String(issue.issue_number || '0').replace(/,/g,''), 10) || 0);
      if (intKey !== norm) filePath = filesByNum.get(intKey);
    }
    // Matched by number only: refuse a file that is tagged as another CV issue.
    if (filePath && cvFile.get(String(issue.id)) !== filePath && taggedAsOther(filePath, issue)) {
      logger.info('refresh-dir', `Issue #${issue.issue_number} not matched — file is tagged as CV issue ${cvOfPath.get(filePath)}`,
        { series: series.name, file: path.basename(filePath) });
      filePath = null;
    }

    if (filePath && await confirmedIdentity(filePath,issue)) {


      unmatched--; // this file was matched
      // Sanity check — file must be inside the series directory
      const inDir = filePath.startsWith(series.directory + path.sep) || filePath.startsWith(series.directory + '/');
      if (inDir && issue.status !== 'processed') {
        // has_comicinfo is set to NULL on a fresh match — the async post-refresh
        // scan will populate it. This avoids claiming "tagged" for files we haven't inspected yet.
        db.prepare(`UPDATE monitored_issues
          SET status = 'processed', file_path = ?, date_processed = datetime('now'), has_comicinfo = NULL
          WHERE id = ?`).run(filePath, issue.id);
        detail.push({ issue_number: issue.issue_number, action: 'matched', file: path.basename(filePath) });
        matched++;
        logger.info('refresh-dir', `Issue #${issue.issue_number} matched to file`, { file: filePath });
      } else if (inDir && issue.status === 'processed' && issue.file_path !== filePath) {
        // Already-processed issue whose file moved/renamed — also invalidate the flag so
        // we re-inspect. Covers the case where someone replaces a file in-place.
        db.prepare(`UPDATE monitored_issues SET file_path = ?, has_comicinfo = NULL WHERE id = ?`)
          .run(filePath, issue.id);
      }
    } else if (issue.status === 'processed') {
      // Check for annual mismatch — file_path points to an annual-named file but issue is not annual
      const filePathIsAnnual = issue.file_path && /annual/i.test(path.basename(issue.file_path));
      if (filePathIsAnnual && !issue.is_annual) {
        db.prepare(`UPDATE monitored_issues
          SET status = 'wanted', file_path = NULL, download_id = NULL, date_processed = NULL
          WHERE id = ?`).run(issue.id);
        detail.push({ issue_number: issue.issue_number, action: 'reset', reason: 'file_path points to annual-named file but issue is not an annual' });
        reset++;
        logger.info('refresh-dir', `Issue #${issue.issue_number} reset — file was renamed to annual`, { was: issue.file_path });
      } else if (issue.file_path && !fs.existsSync(issue.file_path)) {
        // Double-check before resetting — Windows/Docker mounts can have brief
        // hiccups where existsSync returns false even though the file is there.
        // Wait 2 seconds and check again before committing to a reset.
        const stillMissing = await new Promise(resolve => {
          setTimeout(() => resolve(!fs.existsSync(issue.file_path)), 2000);
        });
        if (!stillMissing) {
          logger.info('refresh-dir', `Issue #${issue.issue_number} — file appeared on retry, skipping reset`, { path: issue.file_path });
        } else {
          db.prepare(`UPDATE monitored_issues
            SET status = 'wanted', file_path = NULL, download_id = NULL, date_processed = NULL
            WHERE id = ?`).run(issue.id);
          detail.push({ issue_number: issue.issue_number, action: 'reset', reason: 'file missing' });
          reset++;
          logger.info('refresh-dir', `Issue #${issue.issue_number} reset — file gone`, { was: issue.file_path });
          appendResetLog(`Issue #${issue.issue_number} reset — file gone`, { series: series.name, was: issue.file_path });
        }
      } else if (!issue.file_path) {
        // Processed but no file_path recorded — try to find by expected filename
        const expectedFilename = buildDestFilename(issue, series);
        const expectedPath = path.join(series.directory, expectedFilename);
        if (!fs.existsSync(expectedPath)) {
          db.prepare(`UPDATE monitored_issues
            SET status = 'wanted', file_path = NULL, download_id = NULL, date_processed = NULL
            WHERE id = ?`).run(issue.id);
          detail.push({ issue_number: issue.issue_number, action: 'reset', reason: 'file missing (no path recorded)' });
          reset++;
        }
      }
    }
  }

  // Phase 2: reconcile linked annual series issues (they have their own series_id)
  const linkedAnnualIds = db.prepare(
    `SELECT annual_series_id FROM series_annual_links WHERE parent_series_id = ?`
  ).all(series.id).map(r => r.annual_series_id);

  for (const annualSeriesId of linkedAnnualIds) {
    const annualSeries = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(annualSeriesId);
    if (!annualSeries) continue;

    // Build a map of annual-named files in the directory keyed by extracted issue number.
    // Annual series share the parent directory, so scan the same dirFiles list
    // but restrict to filenames containing "annual" to avoid false matches with regular issues.
    const annualFilesByNum = new Map();
    const annualDir = annualSeries.directory || series.directory;
    let annualDirFiles = dirFiles; // default: same dir as parent
    if (annualDir !== series.directory) {
      try { annualDirFiles = fs.readdirSync(annualDir).filter(f => /\.(cbz|cbr|zip|rar)$/i.test(f)); } catch { annualDirFiles = []; }
    }
    for (const filename of annualDirFiles) {
      if (!/annual/i.test(filename)) continue; // only consider annual-named files
      const extracted = extractIssueNumber(filename);
      if (extracted !== null) {
        const fullPath = path.join(annualDir, filename);
        // Every annual file per number (several years' annuals are all #1);
        // pickAnnualFile chooses among them.
        pushNum(annualFilesByNum, extracted, fullPath);
        // Integer alias only for plain-integer extracts — same suffix-safety
        // gate as the regular-issues map above.
        if (!extracted.includes('.')) {
          const intKey = String(parseInt(extracted, 10));
          if (intKey !== extracted) pushNum(annualFilesByNum, intKey, fullPath);
        }
      }
    }

    const allAnnualIssues = db.prepare(
      `SELECT * FROM monitored_issues WHERE series_id = ?`
    ).all(annualSeriesId);

    for (const issue of allAnnualIssues) {
      if (issue.status === 'processed') {
        // Deletion check — reset if file is gone
        if (issue.file_path && !fs.existsSync(issue.file_path)) {
          db.prepare(`UPDATE monitored_issues
            SET status = 'wanted', file_path = NULL, download_id = NULL, date_processed = NULL
            WHERE id = ?`).run(issue.id);
          detail.push({ issue_number: issue.issue_number, action: 'reset', reason: 'annual file missing', series: annualSeries.name });
          reset++;
          logger.info('refresh-dir', `Annual issue #${issue.issue_number} reset — file gone`, { series: annualSeries.name, was: issue.file_path });
        } else if (!issue.file_path) {
          const expectedFilename = buildDestFilename(issue, annualSeries);
          const expectedPath = path.join(annualDir, expectedFilename);
          if (!fs.existsSync(expectedPath)) {
            db.prepare(`UPDATE monitored_issues
              SET status = 'wanted', file_path = NULL, download_id = NULL, date_processed = NULL
              WHERE id = ?`).run(issue.id);
            detail.push({ issue_number: issue.issue_number, action: 'reset', reason: 'annual file missing (no path)', series: annualSeries.name });
            reset++;
          }
        }
      } else {
        // Forward-match: try to find an existing annual file for this wanted issue.
        // Integer fallback gated on no-dot for the same suffix-safety reason
        // as the regular-issues lookup above.
        const filePath = pickAnnualFile(issue, annualFilesByNum, annualDir, annualSeries.name);
        if (filePath && await confirmedIdentity(filePath,issue)) {
          db.prepare(`UPDATE monitored_issues
            SET status = 'processed', file_path = ?, date_processed = datetime('now')
            WHERE id = ?`).run(filePath, issue.id);
          detail.push({ issue_number: issue.issue_number, action: 'matched', file: path.basename(filePath), series: annualSeries.name });
          matched++;
          logger.info('refresh-dir', `Annual #${issue.issue_number} matched to file`, { file: filePath, series: annualSeries.name });
        }
      }
    }
  }

  // Phase 3: reconcile is_annual=1 issues embedded directly in the parent series.
  // This covers CV volumes that list annuals as issue entries rather than as separate
  // volumes — in that case there are no series_annual_links rows and Phase 2 is a
  // no-op, but Phase 1 also skips them (filter: !i.is_annual), leaving them in a
  // dead zone where Refresh never matched them to files on disk.
  // Only runs when no linked annual volumes exist — consistent with the API endpoint
  // which uses the same guard when deciding what to show in the series card.
  if (linkedAnnualIds.length === 0) {
    const inSeriesAnnuals = allIssues.filter(i => i.is_annual);
    if (inSeriesAnnuals.length > 0) {
      // Build annual-file map from the same dirFiles scan already done above,
      // restricted to filenames that contain "annual" — same logic as Phase 2.
      const annualFilesByNum = new Map();
      for (const filename of dirFiles) {
        if (!/annual/i.test(filename)) continue;
        const extracted = extractIssueNumber(filename);
        if (extracted !== null) {
          const fullPath = path.join(series.directory, filename);
          pushNum(annualFilesByNum, extracted, fullPath);
          if (!extracted.includes('.')) {
            const intKey = String(parseInt(extracted, 10));
            if (intKey !== extracted) pushNum(annualFilesByNum, intKey, fullPath);
          }
        }
      }

      for (const issue of inSeriesAnnuals) {
        if (issue.status === 'processed') {
          // Deletion check — reset if the file is gone
          if (issue.file_path && !fs.existsSync(issue.file_path)) {
            db.prepare(`UPDATE monitored_issues
              SET status = 'wanted', file_path = NULL, download_id = NULL, date_processed = NULL
              WHERE id = ?`).run(issue.id);
            detail.push({ issue_number: issue.issue_number, action: 'reset', reason: 'annual file missing (in-series)' });
            reset++;
            logger.info('refresh-dir', `In-series annual #${issue.issue_number} reset — file gone`, { was: issue.file_path });
          } else if (!issue.file_path) {
            const expectedFilename = buildDestFilename(issue, series);
            const expectedPath = path.join(series.directory, expectedFilename);
            if (!fs.existsSync(expectedPath)) {
              db.prepare(`UPDATE monitored_issues
                SET status = 'wanted', file_path = NULL, download_id = NULL, date_processed = NULL
                WHERE id = ?`).run(issue.id);
              detail.push({ issue_number: issue.issue_number, action: 'reset', reason: 'annual file missing (no path, in-series)' });
              reset++;
            }
          }
        } else {
          // Forward-match: find an annual-named file for this wanted/snatched issue.
          const filePath = pickAnnualFile(issue, annualFilesByNum, series.directory, series.name);
          if (filePath && await confirmedIdentity(filePath,issue)) {
            db.prepare(`UPDATE monitored_issues
              SET status = 'processed', file_path = ?, date_processed = datetime('now')
              WHERE id = ?`).run(filePath, issue.id);
            detail.push({ issue_number: issue.issue_number, action: 'matched', file: path.basename(filePath) });
            matched++;
            logger.info('refresh-dir', `In-series annual #${issue.issue_number} matched to file`, { file: filePath });
          }
        }
      }
    }
  }

  backfillMonitoredLinksByCv('refresh');
  // Update have_count implicitly via the counts query on next series load
  logger.info('refresh-dir', `Series ${series.id} refresh done`, { matched, reset, unmatched });
  return { success: true, matched, reset, unmatched, total_files: dirFiles.length, detail };
}

// Route wrapper — covers all 3 goals in one button press:
//   G1 (disk scan)  — runRefreshDirectory matches files → processed
//   G2+G3 (CV sync) — refreshSeriesIssuesFromCV inserts missing/new issues → wanted
//   Annuals         — autoDiscoverAnnuals fires inside refreshSeriesIssuesFromCV
app.post('/api/monitor/series/:id/refresh-directory', requireAdmin, async (req, res) => {
  // Fetch series row here so it's in scope for the async block below.
  const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(req.params.id);
  if (!series) return res.status(404).json({ error: 'Series not found' });

  // G1: disk scan — synchronous, result returned immediately to UI
  let dirResult;
  try {
    dirResult = await runRefreshDirectory(req.params.id);
    // Invalidate cache so next poll picks up directory existence accurately —
    // directory may have been created between polls (common after first
    // download lands), or may have been deleted manually.
    invalidateDirectoryExistsCache(req.params.id);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // G1b: ComicInfo.xml presence scan — runs before the response so the UI
  // gets accurate has_comicinfo values on the very first refresh, not after
  // a second click. onlyUnknown: true means this is a no-op after the first
  // run for any given issue (repeat refreshes stay cheap).
  try {
    const scanResult = await scanSeriesComicInfo(req.params.id, { onlyUnknown: true });
    if (scanResult.scanned > 0) {
      logger.info('refresh-dir', `ComicInfo scan complete for "${series.name}"`, scanResult);
    }
  } catch (e) {
    logger.warn('refresh-dir', `ComicInfo scan failed for "${series.name}"`, e.message);
  }

  res.json(dirResult);

  // G2+G3+Annuals: CV sync — async, fire-and-forget after response sent.
  // Kept async because CV calls are slow and not needed to display has_comicinfo.
  setImmediate(async () => {
    try {
      // Prune any bad annual links before re-discovery
      const STOPWORDS = new Set(['the','a','an','of','and','or','in','to','for','by']);
      const keyWords = series.name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w));

      const links = db.prepare(`
        SELECT l.annual_series_id, a.name as annual_name, a.year as annual_year
        FROM series_annual_links l
        JOIN monitored_series a ON a.id = l.annual_series_id
        WHERE l.parent_series_id = ?
      `).all(series.id);

      for (const link of links) {
        const aName = link.annual_name.toLowerCase();
        // Use `some` (any keyword matches) rather than `every` (all keywords match).
        // The `every` logic was too aggressive — series with subtitles like
        // "Invincible Iron Man" would prune "Iron Man Annual" because "invincible"
        // wasn't present. Now we only prune when the annual shares zero keywords
        // with the parent series, which catches genuinely unrelated links.
        const failsKeyword = keyWords.length > 0 && !keyWords.some(w => aName.includes(w));
        const failsYearGuard = series.year && link.annual_year
          ? parseInt(link.annual_year) < parseInt(series.year)
          : false;
        if (failsKeyword || failsYearGuard) {
          const reason = failsKeyword ? 'keyword mismatch (no shared keywords)' : `year ${link.annual_year} < series ${series.year}`;
          db.prepare('DELETE FROM series_annual_links WHERE parent_series_id = ? AND annual_series_id = ?')
            .run(series.id, link.annual_series_id);
          // Delete the annual series itself only when nothing else links to it.
          // (Deleting a shared annual failed on the FK after its issues were
          // already gone, leaving it with no issue list.)
          const stillLinked = db.prepare('SELECT 1 FROM series_annual_links WHERE annual_series_id = ? OR parent_series_id = ?')
            .get(link.annual_series_id, link.annual_series_id);
          if (!stillLinked) {
            db.transaction(() => {
              db.prepare('DELETE FROM series_packs WHERE series_id = ?').run(link.annual_series_id);
              db.prepare('DELETE FROM monitored_issues WHERE series_id = ?').run(link.annual_series_id);
              db.prepare('DELETE FROM monitored_series WHERE id = ?').run(link.annual_series_id);
            })();
          }
          logger.info('refresh-dir', `Pruned bad annual link: "${link.annual_name}" from "${series.name}" (${reason})`);
        }
      }

      // CV sync: inserts new/missing issues as wanted + fires autoDiscoverAnnuals internally
      await refreshSeriesIssuesFromCV(series.id);
      logger.info('refresh-dir', `CV sync complete for "${series.name}"`);
    } catch (e) {
      logger.warn('refresh-dir', `Post-refresh CV sync failed for "${series.name}"`, e.message);
    }
  });
});

// ─── Refresh ALL monitored series (bulk) ─────────────────────────
// Streams SSE progress as it iterates every monitored series and runs
// runRefreshDirectory on each. Each per-series call does a fresh
// readdirSync against the series directory and updates monitored_issues
// status based on what files are actually on disk — so this is the
// canonical way to rebuild Download Manager state after any wipe or
// after issue-number canonicalisation.
//
// Bypasses ALL the scanned_books mtime caching that the library
// scanner uses, because runRefreshDirectory does not touch
// scanned_books — it only reads the filesystem and writes
// monitored_issues. That's exactly what we want for recovery.
//
// Single-flight: a global lock prevents concurrent runs.
let _refreshAllRunning = false;
app.post('/api/monitor/refresh-all-directories', requireAdmin, async (req, res) => {
  if (_refreshAllRunning) {
    return res.status(409).json({ error: 'Refresh All already running' });
  }
  _refreshAllRunning = true;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };

  const allSeries = db.prepare(
    'SELECT id, name FROM monitored_series ORDER BY name COLLATE NOCASE'
  ).all();

  // Mirror progress to the global download toast so the user sees activity
  // regardless of which page they're on.
  const dlId = `refresh-all-${Date.now()}`;
  const dlEntry = {
    id: dlId,
    filename: `Refresh All Directories`,
    seriesName: 'All monitored series',
    bytesReceived: 0,
    totalBytes: allSeries.length,
    status: 'downloading',
    startedAt: new Date().toISOString(),
  };
  activeDownloads.set(dlId, dlEntry);
  pushDownloadUpdate(dlEntry);

  send({ start: true, total: allSeries.length });

  let aborted = false;
  req.on('close', () => { aborted = true; });

  let totalMatched = 0, totalReset = 0, errors = 0;
  try {
    for (let i = 0; i < allSeries.length; i++) {
      if (aborted) break;
      const s = allSeries[i];
      try {
        const r = await runRefreshDirectory(s.id);
        totalMatched += r?.matched || 0;
        totalReset   += r?.reset   || 0;
        send({
          index: i + 1, total: allSeries.length,
          seriesId: s.id, seriesName: s.name,
          matched: r?.matched || 0,
          reset:   r?.reset   || 0,
          unmatched: r?.unmatched || 0,
          totalFiles: r?.total_files || 0,
          directoryMissing: !!r?.directory_missing,
        });
      } catch (e) {
        errors++;
        logger.warn('refresh-all', `series ${s.id} (${s.name}) failed: ${e.message}`);
        send({
          index: i + 1, total: allSeries.length,
          seriesId: s.id, seriesName: s.name,
          error: e.message,
        });
      }
      dlEntry.bytesReceived = i + 1;
      pushDownloadUpdate({ ...dlEntry });
      // Yield every series so HTTP requests can be served.
      await new Promise(r => setImmediate(r));
    }
    send({ done: true, total: allSeries.length, totalMatched, totalReset, errors, aborted });
  } finally {
    _refreshAllRunning = false;
    dlEntry.status = aborted ? 'cancelled' : 'complete';
    pushDownloadUpdate({ ...dlEntry });
    setTimeout(() => { activeDownloads.delete(dlId); pushDownloadUpdate({ id: dlId, status: 'removed' }); }, 8000);
    try { res.end(); } catch {}
  }
});

// ─── Diagnostic: processed issue file paths ───────────────────────
// Returns all processed issues with their file_path so the UI can
// surface mismatched / cross-directory files.
app.get('/api/monitor/series/:id/file-paths', requireAdmin, (req, res) => {   // shows disk paths: admin only
  const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(req.params.id);
  if (!series) return res.status(404).json({ error: 'Series not found' });

  const issues = db.prepare(`
    SELECT issue_number, status, file_path, is_annual
    FROM monitored_issues
    WHERE series_id = ? AND status = 'processed' AND file_path IS NOT NULL
    ORDER BY CAST(issue_number AS REAL)
  `).all(req.params.id);

  // Flag any file that lives outside the expected series directory
  const result = issues.map(i => ({
    issue_number: i.issue_number,
    is_annual: i.is_annual,
    file_path: i.file_path,
    filename: path.basename(i.file_path),
    in_series_dir: i.file_path.startsWith(series.directory + path.sep) || i.file_path.startsWith(series.directory + '/'),
  }));

  res.json({ directory: series.directory, issues: result });
});

// ─── Library Import ──────────────────────────────────────────────

/** Parse "Series Name (2023)", "Series Name 2023", or "Series Name" from a folder name.
 *  Returns { name, year } */
// "Action Comics (2016)" → { title: 'Action Comics', year: 2016 }; no "(YYYY)" at the end → the
// whole name and null. Anchored at the end only, so it cannot backtrack on long names.
function folderTitleYear(folderName) {
  const s = String(folderName || '').trim();
  const m = /\((\d{4})\)$/.exec(s);
  return m ? { title: s.slice(0, m.index).trim(), year: parseInt(m[1]) } : { title: String(folderName || ''), year: null };
}
function parseFolderName(folderName) {
  // Parenthesised year: "Action Comics (2016)". (The old patterns had lost their backslashes,
  // so they never matched; found by CodeQL code scanning, 2026-11-12.)
  const s = String(folderName || '').trim();
  const { title, year } = folderTitleYear(s);
  if (year) return { name: title, year };
  // Bare trailing year: "Action Comics 2016" — only strip when a letter word precedes it
  // so "2000 AD" is not incorrectly parsed as name="2000", year=NaN.
  const mb = /\s(\d{4})$/.exec(s);
  if (mb && /[a-zA-Z]/.test(s.slice(0, mb.index))) return { name: s.slice(0, mb.index).trim(), year: parseInt(mb[1]) };
  return { name: s, year: null };
}

/** String similarity score 0-1.
 *  Uses word overlap with typo tolerance:
 *  exact word match = 1.0 credit, prefix match (≥4 chars) = 0.85 credit.
 *  This handles common folder-name typos like "Evile" matching "Evil". */
function nameSimilarity(a, b) {
  const tokenise = s => s.replace(/\b(?:[a-z]\.){2,}/gi, m => m.replace(/\./g, '')).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  const wordsA = tokenise(a);
  const wordsB = tokenise(b);
  if (!wordsA.length || !wordsB.length) return 0;
  const setBLen = new Set(wordsB);
  let score = 0;
  for (const wa of wordsA) {
    if (setBLen.has(wa)) {
      score += 1.0; // exact match
    } else {
      // Prefix/typo match: one word starts with the other (min 4 chars overlap)
      const minLen = Math.min(wa.length, 4);
      const fuzzy = wordsB.some(wb => {
        const ol = Math.min(wa.length, wb.length);
        return ol >= minLen && (wa.startsWith(wb.slice(0, ol)) || wb.startsWith(wa.slice(0, ol)));
      });
      if (fuzzy) score += 0.85;
    }
  }
  return score / Math.max(wordsA.length, wordsB.length);
}

// Known English-language publishers. Anything NOT on this list is treated as a
// potential foreign / republisher and heavily demoted during import scoring.
// Exception: if nameSimilarity >= 0.95 the penalty is skipped — that score means
// the series is essentially unique to that publisher (no English version exists).
const ENGLISH_PUBLISHERS = new Set([
  // Big two
  'dc comics', 'dc', 'marvel comics', 'marvel',
  // Major independents
  'image comics', 'dark horse comics', 'dark horse',
  'idw publishing', 'idw', 'boom! studios', 'boom studios',
  'dynamite entertainment', 'dynamite',
  'oni press', 'fantagraphics books', 'fantagraphics',
  'drawn and quarterly', 'drawn & quarterly',
  'top shelf productions', 'top shelf',
  'archie comics', 'archie comic publications',
  'valiant entertainment', 'valiant',
  'aftershock comics', 'aftershock',
  'vault comics', 'scout comics', 'ahoy comics',
  'titan comics', 'titan publishing group',
  'zenescope entertainment', 'zenescope',
  'avatar press', 'black mask studios',
  'action lab entertainment', 'action lab',
  'alterna comics', 'antarctic press',
  'aspen comics', 'aspen mlt',
  'heavy metal', 'heavy metal magazine',
  'harris comics', 'harris publications',
  'crossgen comics', 'crossgen',
  'wildstorm', 'dc/wildstorm',
  'vertigo', 'dc vertigo',
  'abc comics', "america's best comics",
  'aardvark-vanaheim',
  'kitchen sink press',
  'eclipse comics',
  'first comics',
  'comico',
  'pacific comics',
  'innovation publishing',
  'continuity comics',
  'charlton comics',
  'dell comics',
  'gold key comics', 'gold key',
  'harvey comics',
  'quality comics',
  'fawcett comics',
  'ec comics',
  'atlas comics',
  'prize comics',
  'lev gleason publications',
  'fiction house',
  'ace comics',
  // Imprints commonly listed as publisher on CV
  'focus', 'minx', 'piranha press', 'paradox press',
  'helix', 'mad', 'zuda',
]);

/** Score a CV volume candidate for import matching.
 *  Returns 0–1 float; confidence display = Math.round(score * 100). */
function scoreCvCandidate(candidate, parsedName, parsedYear, fileCount) {
  let nameSim = Math.min(nameSimilarity(parsedName, candidate.name || ''), 1.0);

  // Year scoring — when we have a parsed year, wrong years are penalised not just un-bonused.
  // Asymmetric: a series that started BEFORE the folder year is less bad than one that
  // started after (handles series that ran through a publishing rebranding, e.g. Batman
  // (2016) filed under a "2023" folder when the Dawn of DC era began).
  let yearAdjust = 0;
  if (parsedYear && candidate.start_year) {
    const cvYear = parseInt(candidate.start_year);
    const diff = cvYear - parsedYear; // negative = candidate started before folder year
    const absDiff = Math.abs(diff);
    if (absDiff === 0)       yearAdjust = +0.25; // exact match
    else if (absDiff === 1)  yearAdjust = +0.10; // off by one
    else if (diff < 0 && absDiff <= 10) yearAdjust = -0.10; // started before — lighter penalty
    else if (absDiff <= 3)   yearAdjust = -0.15; // started after, close — moderate penalty
    else                     yearAdjust = -0.35; // started after, far — heavy penalty
  } else if (parsedYear && !candidate.start_year) {
    yearAdjust = -0.10; // CV has no year data — slight skepticism
  }

  let score = nameSim + yearAdjust; // max possible: 1.25

  // Foreign / republisher penalty — whitelist approach.
  // Any publisher not on the known English whitelist gets a heavy 0.15 multiplier.
  // No exemption for name similarity — DC Comics and Panini Comics can both have a
  // series called "Action Comics"; only the publisher check decides the penalty.
  const pub = (candidate.publisher?.name || '').toLowerCase();
  const isKnownEnglish = ENGLISH_PUBLISHERS.has(pub);
  if (!isKnownEnglish) score *= 0.15;

  // Issue count — defined early so TPB check can use it
  const issues = candidate.count_of_issues || 0;

  // TPB / collected edition penalty — only apply when issue count doesn't closely
  // match file count. If CV says 6 issues and we have 6 files, it's almost certainly
  // the right series even if the description mentions a trade paperback.
  const desc = (candidate.description || '').toLowerCase();
  const isTpbDesc = /trade paperback|collected edition|tpb|hardcover collection|omnibus|compendium/.test(desc);
  const issueProximity = (fileCount && issues > 0)
    ? Math.max(0, 1 - Math.abs(issues - fileCount) / Math.max(issues, fileCount))
    : 0;
  if (isTpbDesc && issueProximity < 0.8) score *= 0.50;

  // Issue count proximity bonus — gentle nudge, not a decider.
  if (fileCount && issues > 0) {
    score += issueProximity * 0.10;
  }

  // Normalise to 0–1 (max possible: 1.0 name + 0.25 year + 0.10 proximity = 1.35)
  return Math.max(0, Math.min(score / 1.35, 1.0));
}

// Scan a directory and return series candidates with auto CV match
app.post('/api/import/scan', async (req, res) => {
  const { scanPath } = req.body;
  if (!scanPath) return res.status(400).json({ error: 'scanPath required' });

  // Safety: must be inside the comics folder after resolving symlinks
  let resolved;
  try { resolved = require('./pathSecurity').resolveExistingWithinRoot(COMICS_PATH, scanPath); }
  catch (e) { return res.status(e.status || 500).json({ error: e.status === 403 ? 'Path must be inside the comics folder' : e.status ? e.message : 'Unable to read directory' }); }

  let subdirs;
  try {
    subdirs = fs.readdirSync(resolved, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  if (!subdirs.length) return res.json({ series: [] });

  const CV_API_KEY = getCVKey();
  const alreadyMonitored = new Set(
    db.prepare('SELECT directory FROM monitored_series').all().map(r => r.directory)
  );

  const results = [];

  for (const dirName of subdirs) {
    const fullPath = path.join(resolved, dirName);

    // Count comic files in this dir
    let fileCount = 0;
    try {
      fileCount = fs.readdirSync(fullPath)
        .filter(f => /\.(cbz|cbr|zip|rar|pdf)$/i.test(f)).length;
    } catch {}

    // Skip dirs with no comic files (likely not a series dir)
    if (fileCount === 0) continue;

    const { name: parsedName, year: parsedYear } = parseFolderName(dirName);
    const alreadyAdded = alreadyMonitored.has(fullPath);

    // ── series.json short-circuit ─────────────────────────────────
    // If an enriched series.json already exists with a CV ID, use it directly —
    // no API call needed. This eliminates the majority of CV calls on large
    // libraries that have already been through the enrich pipeline.
    let cvMatch = null;
    const seriesJsonFile = path.join(fullPath, 'series.json');
    if (fs.existsSync(seriesJsonFile)) {
      try {
        const sjData = JSON.parse(fs.readFileSync(seriesJsonFile, 'utf8'));
        const m = sjData.metadata || sjData;
        if (m.comicid) {
          cvMatch = {
            id:           String(m.comicid),
            name:         m.name || parsedName,
            year:         m.year || parsedYear,
            publisher:    m.publisher || null,
            total_issues: m.total_issues || null,
            image_url:    m.image_url || null,
            cv_url:       m.site_detail_url || null,
            description:  (m.description_text || '').substring(0, 200),
            confidence:   99,
            alternatives: [],
            _from_series_json: true,
          };
        }
      } catch (e) {
        logger.warn('import-scan', `series.json read failed for "${dirName}"`, e.message);
      }
    }

    // ── CV search (only when series.json gave us nothing) ─────────
    if (!cvMatch) {
      try {
      const cleanName = parsedName.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
      const cvSearchParams = {
        api_key: getCVKey(), format: 'json',
        resources: 'volume',
        limit: 25,
        field_list: 'id,name,start_year,publisher,count_of_issues,image,site_detail_url,description',
      };
      const r = await cvApiGet('https://comicvine.gamespot.com/api/search', {
        params: { ...cvSearchParams, query: cleanName },
        headers: { 'User-Agent': 'Omnibus/1.0' },
        timeout: 10000,
      });
      let candidates = r.data.results || [];

      // Fallback: if best score is low, retry with typo-corrected query.
      // Strips the trailing character from any word >4 chars ("Evile"->"Evil").
      // Catches the common "extra letter at end" typo. Only fires if top score < 0.65.
      const quickBest = candidates.length
        ? Math.max(...candidates.map(c => scoreCvCandidate(c, parsedName, parsedYear, fileCount)))
        : 0;
      if (quickBest < 0.65) {
        // Only trim the last word — that's almost always where the typo is.
        // Trimming all words corrupts correctly-spelled words (e.g. "Absolute"→"Absolut").
        const words = cleanName.split(/\s+/);
        const lastWord = words[words.length - 1];
        const corrected = lastWord.length > 4
          ? [...words.slice(0, -1), lastWord.slice(0, -1)].join(' ')
          : cleanName;
        if (corrected !== cleanName) {
          await new Promise(res => setTimeout(res, 600));
          const r2 = await cvApiGet('https://comicvine.gamespot.com/api/search', {
            params: { ...cvSearchParams, query: corrected },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 10000,
          });
          const seen = new Set(candidates.map(c => c.id));
          for (const c of r2.data.results || []) {
            if (!seen.has(c.id)) { candidates.push(c); seen.add(c.id); }
          }
        }
      }

      // Score candidates using full scoring function (name, year, publisher, issue count)
      const scored = candidates
        .map(c => ({ ...c, _score: scoreCvCandidate(c, parsedName, parsedYear, fileCount) }))
        .sort((a, b) => b._score - a._score);

      if (scored.length > 0) {
        const top = scored[0];
        cvMatch = {
          id:           String(top.id),
          name:         top.name,
          year:         top.start_year,
          publisher:    top.publisher?.name || null,
          total_issues: top.count_of_issues || 0,
          image_url:    top.image?.medium_url || null,
          cv_url:       top.site_detail_url || null,
          description:  (top.description || '').substring(0, 200),
          confidence:   Math.round(top._score * 100),
          // Include top 10 alternatives for user override
          alternatives: scored.slice(0, 10).map(c => ({
            id: String(c.id), name: c.name, year: c.start_year,
            publisher: c.publisher?.name || null,
            total_issues: c.count_of_issues || 0,
            image_url: c.image?.medium_url || null,
            cv_url: c.site_detail_url || null,
            description: (c.description || '').substring(0, 200),
            confidence: Math.round(c._score * 100),
          })),
        };
      }
    } catch (e) {
      logger.warn('import-scan', `CV search failed for "${parsedName}"`, e.message);
    }
    } // end if (!cvMatch)

    results.push({
      directory:   fullPath,
      folderName:  dirName,
      parsedName,
      parsedYear,
      fileCount,
      alreadyAdded,
      cvMatch,
    });

    // Rate-limit delay only needed when we actually hit CV
    if (!cvMatch?._from_series_json) {
      await new Promise(r => setTimeout(r, 1100));
    }
  }

  res.json({ series: results, scanned: subdirs.length });
});

// Concurrency limiter for disk-cover extractions — mirrors THUMB_CONCURRENCY so
// a full import scan list (40+ rows) doesn't spawn 40 simultaneous 7z processes.
let _diskCoverActive = 0;
const _diskCoverQueue = [];
function acquireDiskCoverSlot() {
  return new Promise(resolve => {
    const attempt = () => {
      if (_diskCoverActive < 4) {
        _diskCoverActive++;
        resolve(() => {
          _diskCoverActive--;
          const next = _diskCoverQueue.shift();
          if (next) next();
        });
      } else {
        _diskCoverQueue.push(attempt);
      }
    };
    attempt();
  });
}

// Extract first image bytes from a comic archive.
// 7z exits with code 1 (warning) on many valid archives — catch and rescue stdout
// when it contains real image data rather than discarding good bytes.
async function extractArchiveImage(filePath, imageName) {
  return readArchiveMember(filePath, imageName, 10 * 1024 * 1024);
}

// Serve the cover image of the first comic file found in a scanned directory.
// Used by the import UI to show the on-disk cover alongside the CV match cover.
app.get('/api/import/disk-cover', async (req, res) => {
  const { directory } = req.query;
  if (!directory) return res.status(400).json({ error: 'directory required' });

  // Safety: must be under the configured comics root
  let resolved;
  try { resolved = require('./pathSecurity').resolveExistingWithinRoot(COMICS_PATH, directory); }
  catch (e) { return res.status(e.status || 500).json({ error: e.status ? e.message : 'Unable to read directory' }); }

  // Find first comic file alphabetically
  let comicFiles;
  try {
    comicFiles = fs.readdirSync(resolved)
      .filter(f => /\.(cbz|cbr|zip|rar|pdf)$/i.test(f))
      .sort();
  } catch {
    return res.status(404).json({ error: 'Directory not found' });
  }
  if (!comicFiles.length) return res.status(404).json({ error: 'No comic files' });

  let firstFile;
  try { firstFile = require('./pathSecurity').resolveExistingWithinRoot(fs.realpathSync(COMICS_PATH), path.join(resolved, comicFiles[0])); }
  catch (e) { return res.status(e.status || 500).json({ error: e.status ? e.message : 'Unable to read comic file' }); }
  const release = await acquireDiskCoverSlot();
  try {
    const archiveFiles = await listArchiveFiles(firstFile);
    const images = filterImages(archiveFiles);
    if (!images.length) return res.status(404).json({ error: 'No images in archive' });

    const imageBuffer = await extractArchiveImage(firstFile, images[0]);

    const imgExt = path.extname(images[0]).toLowerCase();
    const contentType =
      imgExt === '.png'  ? 'image/png'  :
      imgExt === '.gif'  ? 'image/gif'  :
      imgExt === '.webp' ? 'image/webp' :
      'image/jpeg';

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(imageBuffer);
  } catch (e) {
    logger.warn('disk-cover', `Failed to extract cover from ${path.basename(firstFile)}: ${e.message}`);
    res.status(500).json({ error: 'Extraction failed' });
  } finally {
    release();
  }
});

// Re-search CV for a single directory using a custom query string
// Called when user edits the search term in the import UI for a specific row
app.post('/api/import/rescan-one', async (req, res) => {
  const { directory, query } = req.body;
  if (!directory || !query) return res.status(400).json({ error: 'directory and query required' });
  let safeDirectory;
  try { safeDirectory = require('./pathSecurity').resolveCreatableWithinRoot(COMICS_PATH, directory); }
  catch (e) { return res.status(e.status || 500).json({ error: e.status ? e.message : 'Unable to read directory' }); }

  const CV_API_KEY = getCVKey();
  const dirName = path.basename(directory);
  const { name: parsedName, year: parsedYear } = parseFolderName(dirName);

  let fileCount = 0;
  try {
    fileCount = require('fs').readdirSync(safeDirectory)
      .filter(f => /\.(cbz|cbr|zip|rar|pdf)$/i.test(f)).length;
  } catch {}

  // Detect direct CV URL or numeric ID — skip search entirely
  const cvIdMatch = query.trim().match(/(?:4050-)?(\d{4,})/);
  const isDirectId = /comicvine\.gamespot\.com/.test(query) || /^\d{4,}$/.test(query.trim());

  if (isDirectId && cvIdMatch) {
    try {
      const cvId = cvIdMatch[1];
      const r = await cvApiGet(`https://comicvine.gamespot.com/api/volume/4050-${cvId}/`, {
        params: { api_key: getCVKey(), format: 'json', field_list: 'id,name,start_year,publisher,count_of_issues,image,site_detail_url,description' },
        headers: { 'User-Agent': 'Omnibus/1.0' },
        timeout: 10000,
      });
      const v = r.data.results;
      if (!v) return res.json({ cvMatch: null });
      const entry = {
        id: String(v.id), name: v.name, year: v.start_year,
        publisher: v.publisher?.name || null,
        total_issues: v.count_of_issues || 0,
        image_url: v.image?.medium_url || null,
        cv_url: v.site_detail_url || null,
        description: (v.description || '').substring(0, 200),
        confidence: 100,
      };
      return res.json({ cvMatch: { ...entry, alternatives: [entry] } });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  try {
    const FIELD_LIST = 'id,name,start_year,publisher,count_of_issues,image,site_detail_url,description';
    const q = query.trim();

    // Detect "name YYYY" pattern — use CV volumes filter API for precise year+name match
    // e.g. "action comics 2016" → filter=name:action comics,start_year:2016
    const ys = /\s(\d{4})$/.exec(q);   // linear, unlike /^(.+?)\s+(\d{4})$/ (CodeQL polynomial-redos)
    const yearSuffixMatch = ys && q.slice(0, ys.index).trim() ? [q, q.slice(0, ys.index).trim(), ys[1]] : null;
    let candidates = [];

    if (yearSuffixMatch) {
      const namePart = yearSuffixMatch[1].trim();
      const yearPart = yearSuffixMatch[2];
      // Run both in parallel: filtered (exact year) + plain search (fallback)
      const [filteredRes, searchRes] = await Promise.allSettled([
        cvApiGet('https://comicvine.gamespot.com/api/volumes/', {
          params: { api_key: getCVKey(), format: 'json', limit: 10,
            field_list: FIELD_LIST,
            filter: `name:${namePart},start_year:${yearPart}` },
          headers: { 'User-Agent': 'Omnibus/1.0' }, timeout: 10000,
        }),
        cvApiGet('https://comicvine.gamespot.com/api/search', {
          params: { api_key: getCVKey(), format: 'json', resources: 'volume',
            limit: 25, field_list: FIELD_LIST, query: namePart },
          headers: { 'User-Agent': 'Omnibus/1.0' }, timeout: 10000,
        }),
      ]);
      const filtered = filteredRes.status === 'fulfilled' ? (filteredRes.value.data.results || []) : [];
      const searched = searchRes.status === 'fulfilled' ? (searchRes.value.data.results || []) : [];
      // Merge, filtered results first, dedup by id
      const seen = new Set();
      for (const c of [...filtered, ...searched]) {
        if (!seen.has(c.id)) { candidates.push(c); seen.add(c.id); }
      }
    } else {
      const r = await cvApiGet('https://comicvine.gamespot.com/api/search', {
        params: { api_key: getCVKey(), format: 'json', resources: 'volume',
          limit: 50, field_list: FIELD_LIST, query: q },
        headers: { 'User-Agent': 'Omnibus/1.0' }, timeout: 10000,
      });
      candidates = r.data.results || [];
    }

    // If the user typed a year in their query (e.g. "action comics 2016") use that year
    // for scoring — overrides the folder's parsedYear when one wasn't present.
    // This ensures the year the user explicitly asked for actually influences the result.
    const queryYear = yearSuffixMatch ? parseInt(yearSuffixMatch[2]) : null;
    const scoreYear = queryYear || parsedYear;
    logger.debug('import-rescan', `Scoring: parsedName=${parsedName} parsedYear=${parsedYear} queryYear=${queryYear} scoreYear=${scoreYear} candidates=${candidates.length}`);

    const scored = candidates
      .map(c => ({ ...c, _score: scoreCvCandidate(c, parsedName, scoreYear, fileCount) }))
      .sort((a, b) => b._score - a._score);

    const top = scored[0];
    if (!top) return res.json({ cvMatch: null });

    res.json({
      cvMatch: {
        id:           String(top.id),
        name:         top.name,
        year:         top.start_year,
        publisher:    top.publisher?.name || null,
        total_issues: top.count_of_issues || 0,
        image_url:    top.image?.medium_url || null,
        cv_url:       top.site_detail_url || null,
        description:  (top.description || '').substring(0, 200),
        confidence:   Math.round(top._score * 100),
        alternatives: scored.slice(0, 10).map(c => ({
          id: String(c.id), name: c.name, year: c.start_year,
          publisher: c.publisher?.name || null,
          total_issues: c.count_of_issues || 0,
          image_url: c.image?.medium_url || null,
          cv_url: c.site_detail_url || null,
          description: (c.description || '').substring(0, 200),
          confidence: Math.round(c._score * 100),
        })),
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Execute import for confirmed series selections
app.post('/api/import/execute', async (req, res) => {
  const { selections } = req.body;
  // selections: [{ directory, cvId, name, publisher, year, total_issues, image_url, cv_url }]
  if (!Array.isArray(selections) || !selections.length) {
    return res.status(400).json({ error: 'selections array required' });
  }

  const CV_API_KEY = getCVKey();
  const results = [];

  for (const sel of selections) {
    const { directory, cvId, name, publisher, year, total_issues, image_url, cv_url } = sel;
    const result = { directory, name, cvId, status: 'pending' };

    try {
      // Ensure directory exists, inside the comics folder only
      const safeDirectory = require('./pathSecurity').resolveCreatableWithinRoot(COMICS_PATH, directory);
      if (!fs.existsSync(safeDirectory)) fs.mkdirSync(safeDirectory, { recursive: true });

      // Insert or replace series record
      db.prepare(`
        INSERT OR REPLACE INTO monitored_series
          (id, name, publisher, year, total_issues, image_url, cv_url, directory, last_cv_check)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(cvId, name, publisher || null, year || null, total_issues || 0, image_url || null, cv_url || null, directory);

      // Fetch all issues from CV
      let offset = 0, allIssues = [], total = Infinity;
      while (allIssues.length < total) {
        const r = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
          params: {
            api_key: getCVKey(), format: 'json',
            filter: `volume:${cvId}`,
            field_list: 'id,issue_number,name,cover_date,store_date,site_detail_url,description,person_credits,character_credits,team_credits,location_credits',
            offset, limit: 100,
          },
          headers: { 'User-Agent': 'Omnibus/1.0' },
          timeout: 15000,
        });
        total = r.data.number_of_total_results || 0;
        const batch = r.data.results || [];
        allIssues = allIssues.concat(batch);
        if (!batch.length) break;
        offset += 100;
        await new Promise(r => setTimeout(r, 600));
      }

      // Insert issues
      const isAnnual = (num, n) => ((num || '') + ' ' + (n || '')).toLowerCase().includes('annual') ? 1 : 0;
      const insertIssue = db.prepare(`
        INSERT OR IGNORE INTO monitored_issues
          (id, series_id, issue_number, title, release_date, store_date, cv_data, is_annual)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      db.transaction(issues => {
        for (const i of issues) {
          insertIssue.run(String(i.id), cvId, i.issue_number || '0',
            i.name || null, i.cover_date || null, i.store_date || null,
            JSON.stringify(i), isAnnual(i.issue_number, i.name));
        }
      })(allIssues);

      db.prepare(`UPDATE monitored_series SET total_issues = ? WHERE id = ?`).run(allIssues.length, cvId);

      // Run directory refresh to match existing files → mark processed
      let matched = 0;
      try {
        const refreshResult = await runRefreshDirectory(cvId);
        matched = refreshResult.matched || 0;
      } catch (e) {
        logger.warn('import', `Refresh failed for "${name}"`, e.message);
      }

      // Scan ComicInfo.xml presence immediately so the UI shows correct
      // untagged counts without requiring a manual refresh button press.
      try {
        const ciResult = await scanSeriesComicInfo(cvId, { onlyUnknown: true });
        if (ciResult.scanned > 0) {
          logger.info('import', `ComicInfo scan: ${ciResult.scanned} files checked for "${name}"`);
        }
      } catch (e) {
        logger.warn('import', `ComicInfo scan failed for "${name}"`, e.message);
      }

      // Set ongoing/ended status from CV
      await fetchAndSetSeriesStatus(cvId);

      // Discover standalone annual volumes — brings Import to parity with Add Series
      setImmediate(() =>
        autoDiscoverAnnuals(cvId, name, directory)
          .catch(e => logger.warn('import', `Annual discovery failed for "${name}"`, e.message))
      );

      const library=db.prepare('SELECT * FROM libraries').all().filter(l=>{const rel=path.relative(l.path,directory);return !rel||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));}).sort((a,b)=>b.path.length-a.path.length)[0];
      if(library){
        const stmts=makeScanStmts();await scanSeriesDir(directory,library.id,stmts.upsertSeries,stmts.upsertBook,'import');
        for(const book of db.prepare('SELECT id FROM scanned_books WHERE path LIKE ?').all(directory+path.sep+'%'))metadataMaintenance.enqueue(book.id,'import');
      }
      result.status = 'imported';
      result.issues_fetched = allIssues.length;
      result.files_matched = matched;
      logger.info('import', `Imported series "${name}"`, { cvId, issues: allIssues.length, matched });

    } catch (e) {
      result.status = 'error';
      result.error = e.message;
      logger.error('import', `Failed to import "${name}"`, e.message);
    }

    results.push(result);
    // Small delay between series to avoid hammering CV
    await new Promise(r => setTimeout(r, 500));
  }

  res.json({ results });
});


// ─── Weekly releases ──────────────────────────────────────────────
// ALL weeks use Walksoftly/LOCG exclusively (session 13+).
// Walksoftly serves LOCG data as clean JSON — same source Mylar uses.
// Provides: publisher, series, issue, shipdate, comicid (CV volume ID), type
// Pre-filters reprints server-side. CV fallback only if Walksoftly unreachable.

// ─── Walksoftly / LOCG helpers ───────────────────────────────────

// Compute Python-compatible %U week number (Sunday-based, 00–53).
// Pass the Monday date string directly — do NOT add +6 days.
function getLocgWeekNum(dateStr) {
  const d    = new Date(dateStr + 'T12:00:00Z');
  const jan1 = new Date(d.getUTCFullYear() + '-01-01T12:00:00Z');
  const jan1Day   = jan1.getUTCDay(); // 0=Sun
  const dayOfYear = Math.floor((d - jan1) / 86400000);
  return Math.floor((dayOfYear + jan1Day) / 7);
}

const LOCG_TPB_TYPES = new Set(['tpb','hc','gn','sc','omnibus','digest','manga','anthology','hardcover','trade']);

/**
 * Normalize a publisher name for comparison.
 * Strips generic words ("Comics", "Entertainment", "Publishing") and punctuation
 * so "Marvel Comics" and "Marvel" both normalize to "marvel".
 */
function normPublisher(pub) {
  return (pub || '')
    .toLowerCase()
    .replace(/\bcomics?\b/g, '')
    .replace(/\bentertainment\b/g, '')
    .replace(/\bpublishing\b/g, '')
    .replace(/\bpublications?\b/g, '')
    .replace(/\binc\.?\b/g, '')
    .replace(/\bllc\.?\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Returns true if two publisher names are compatible (same root after normalisation).
 * Unknown/empty publishers are always compatible (can't rule out a match).
 */
function publishersCompatible(pubA, pubB) {
  const nA = normPublisher(pubA);
  const nB = normPublisher(pubB);
  if (!nA || !nB || nA === 'unknown' || nB === 'unknown') return true;
  return nA === nB || nA.includes(nB) || nB.includes(nA);
}

function isLocgTpb(item) {
  const type = (item.type || '').toLowerCase().trim();
  if (LOCG_TPB_TYPES.has(type)) return true;
  const issue = String(item.issue || '').trim();
  // Blank or non-numeric start → not a single issue
  if (!issue || !/^\d/.test(issue)) return true;
  return false;
}

// ─── Current-week CV refresh ─────────────────────────────────────
/**
 * Fetches this week's LOCG list, finds monitored series in it,
 * and runs refreshSeriesIssuesFromCV for each.
 * Called by: daily 8am cron + frontend when current week tab loads.
 */
async function refreshCurrentWeekMonitoredSeries() {
  // Get Monday of current week (server local time)
  const today = new Date();
  const dow = today.getDay(); // 0=Sun
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
  const weekStr = monday.toISOString().slice(0, 10);

  logger.info('week-refresh', `Fetching LOCG for week ${weekStr}`);
  let weekData;
  try {
    const result = await fetchWeeklyReleases(weekStr);
    weekData = result.items;
    logger.info('week-refresh', `Release data from ${result.source}: ${weekData.length} items`);
  } catch (e) {
    logger.warn('week-refresh', 'Could not fetch weekly releases', e.message);
    return { refreshed: 0, skipped: 0 };
  }

  if (!weekData || !weekData.length) return { refreshed: 0, skipped: 0 };

  // Match monitored series by CV volume ID (Walksoftly) OR by normalised series name (FreshComics)
  const weekCvIds = new Set(weekData.map(c => String(c.comicid)).filter(id => id && id !== 'undefined' && id !== 'null'));
  const weekNames = new Set(weekData.map(c => (c.series || '').toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean));

  // Find active monitored series whose CV ID or name is in this week's list
  const monitored = db.prepare(`SELECT id, name FROM monitored_series WHERE status = 'active'`).all();
  const toRefresh = monitored.filter(s => {
    if (weekCvIds.has(String(s.id))) return true;
    const key = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return weekNames.has(key);
  });

  logger.info('week-refresh', `${toRefresh.length} monitored series shipping this week`, { ids: toRefresh.map(s => s.id) });

  let refreshed = 0, skipped = 0;
  for (const series of toRefresh) {
    try {
      const { inserted, total } = await refreshSeriesIssuesFromCV(series.id);
      if (inserted > 0) logger.info('week-refresh', `${series.name}: +${inserted} new issues (${total} total on CV)`);
      refreshed++;
      await new Promise(r => setTimeout(r, 700)); // respect CV rate limit
    } catch (e) {
      logger.warn('week-refresh', `Failed for ${series.name}`, e.message);
      skipped++;
    }
  }

  logger.info('week-refresh', `Done — ${refreshed} refreshed, ${skipped} failed`);
  return { refreshed, skipped, series: toRefresh.map(s => s.name) };
}


// Frontend calls this when DownloadManager mounts — fire-and-forget.
// Server-side cooldown: won't re-run within 2 hours to prevent CV hammering
// when the user navigates back and forth between pages.
let _weekRefreshLastRun = 0;
const WEEK_REFRESH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

app.post('/api/monitor/refresh-current-week', requireDownloadAccess, async (req, res) => {
  const now = Date.now();
  if (now - _weekRefreshLastRun < WEEK_REFRESH_COOLDOWN_MS) {
    const waitMins = Math.ceil((WEEK_REFRESH_COOLDOWN_MS - (now - _weekRefreshLastRun)) / 60000);
    logger.info('week-refresh', `Skipping — cooldown active (${waitMins}min remaining)`);
    return res.json({ success: true, skipped: true, cooldownMinsRemaining: waitMins });
  }
  _weekRefreshLastRun = now;
  refreshCurrentWeekMonitoredSeries().catch(e =>
    logger.warn('week-refresh', 'Background refresh error', e.message)
  );
  res.json({ success: true });
});

// ─── LOCG series ID resolver ──────────────────────────────────────────────────
// Fetches the LOCG issue page (full slug URL) for each monitored series that
// has a locg_issue_id in locg_issue_lookup but no locg_series_id yet.
// Extracts /comics/series/{id}/{slug} and stores it in monitored_series.
// Rate-limited to one FlareSolverr call every ~4 seconds.
async function resolveLocgSeriesIds(limit = 20) {
  const toResolve = db.prepare(`
    SELECT DISTINCT ms.id AS series_id, ms.directory, l.locg_issue_id, l.locg_slug
    FROM monitored_series ms
    JOIN locg_issue_lookup l ON l.cv_series_id = CAST(ms.id AS TEXT)
    WHERE ms.locg_series_id IS NULL
      AND l.locg_slug IS NOT NULL
    LIMIT ?
  `).all(limit);

  if (!toResolve.length) {
    logger.info('locg-resolve', 'No series pending LOCG series ID resolution');
    return { resolved: 0, checked: 0 };
  }

  logger.info('locg-resolve', `Resolving LOCG series IDs for ${toResolve.length} series`);
  let resolved = 0;

  const updateSeries = db.prepare(`
    UPDATE monitored_series SET locg_series_id = ?, locg_series_slug = ? WHERE id = ?
  `);

  for (const { series_id, directory, locg_issue_id, locg_slug } of toResolve) {
    try {
      const url = `${LOCG_BASE}/comic/${locg_issue_id}/${locg_slug}`;
      const r = await axios.post(`${FLARESOLVERR_URL}/v1`, {
        cmd: 'request.get', url, maxTimeout: 60000, wait: 5000,
      }, { timeout: 70000 });

      const html = r.data?.solution?.response || '';
      // Extract series link: /comics/series/{id}/{slug}
      const m = html.match(/href="\/comics\/series\/(\d+)\/([^"\/]+)/);
      if (m) {
        updateSeries.run(m[1], m[2], series_id);
        logger.info('locg-resolve', `Series ${series_id} → LOCG series ${m[1]} (${m[2]})`);
        // Write LOCG IDs into series.json on disk if it exists
        if (directory) {
          try {
            const patched = patchSeriesJsonWithLocg(directory, m[1], m[2]);
            if (patched) logger.info('locg-resolve', `Wrote LOCG series ID to series.json`, { series_id, locg_series_id: m[1] });
          } catch (pe) {
            logger.warn('locg-resolve', `series.json patch failed`, { series_id, error: pe.message });
          }
        }
        resolved++;
      } else {
        logger.warn('locg-resolve', `Series ${series_id}: no series link found`, { url, len: html.length });
      }
    } catch (e) {
      logger.warn('locg-resolve', `Series ${series_id}: fetch error`, e.message);
    }
    // 4s between requests — polite rate limit for LOCG
    await new Promise(r => setTimeout(r, 4000));
  }

  logger.info('locg-resolve', `Done — ${resolved}/${toResolve.length} resolved`);
  return { resolved, checked: toResolve.length };
}

// ─── Bidirectional LOCG sync: series.json → DB ───────────────────
// On startup, scan monitored series that have no locg_series_id in the DB
// but do have one written in their series.json (e.g. set manually or by a
// previous install). Writes the ID back to monitored_series so the rest of
// the app can use it without waiting for the resolver cron.
async function syncLocgIdsFromSeriesJson() {
  const pending = db.prepare(
    `SELECT id, directory FROM monitored_series WHERE locg_series_id IS NULL AND directory IS NOT NULL`
  ).all();

  if (!pending.length) return 0;

  const updateLocg = db.prepare(
    `UPDATE monitored_series SET locg_series_id = ?, locg_series_slug = ? WHERE id = ?`
  );

  let synced = 0;
  for (const s of pending) {
    try {
      const jsonPath = path.join(s.directory, 'series.json');
      if (!fs.existsSync(jsonPath)) continue;
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (data.locg_series_id) {
        updateLocg.run(String(data.locg_series_id), data.locg_series_slug || null, s.id);
        synced++;
      }
    } catch { /* skip malformed files */ }
  }

  if (synced > 0) logger.info('locg-sync', `Synced ${synced} LOCG series IDs from series.json → DB`);
  return synced;
}

// Every 3 hours: resolve a batch of 20 monitored series LOCG series IDs.
cron.schedule('0 */3 * * *', async () => {
  logger.info('locg-resolve', 'Scheduled LOCG series ID resolution starting');
  await resolveLocgSeriesIds(20);
});

// On startup (1-minute delay): sync any LOCG IDs already present in series.json files back to DB.
// Then at 3 minutes: resolve a small fresh batch via FlareSolverr.
setTimeout(() => {
  syncLocgIdsFromSeriesJson().catch(e =>
    logger.warn('locg-sync', 'Startup series.json sync error', e.message)
  );
}, 60 * 1000);

setTimeout(() => {
  resolveLocgSeriesIds(10).catch(e =>
    logger.warn('locg-resolve', 'Startup resolution error', e.message)
  );
}, 3 * 60 * 1000);

// Daily cron 8am — refreshes CV issues for series shipping this week only.
// Lightweight: skips all non-shipping series, won't hammer CV.
cron.schedule('0 8 * * *', async () => {
  logger.info('week-refresh', 'Daily current-week CV refresh starting');
  await refreshCurrentWeekMonitoredSeries();
});

// Monthly series status re-check — catches ongoing series that have ended.
// Runs on the 1st of each month at 4:00am. Re-queries CV for every 'ongoing'
// series; fetchAndSetSeriesStatus will now write 'ended' if the last issue
// is more than 24 months old. Rate-limited to ~1 req/2s to be polite to CV.
cron.schedule('0 4 1 * *', async () => {
  logger.info('series-status', 'Monthly ongoing-series status re-check starting');
  const ongoing = db.prepare(`SELECT id, name FROM monitored_series WHERE series_status = 'ongoing' AND status = 'active'`).all();
  logger.info('series-status', `Re-checking ${ongoing.length} ongoing series`);
  let changed = 0;
  for (const s of ongoing) {
    try {
      const before = db.prepare('SELECT series_status FROM monitored_series WHERE id = ?').get(s.id)?.series_status;
      await fetchAndSetSeriesStatus(s.id);
      const after  = db.prepare('SELECT series_status FROM monitored_series WHERE id = ?').get(s.id)?.series_status;
      if (after !== before) {
        logger.info('series-status', `"${s.name}" ${before} → ${after}`);
        changed++;
      }
    } catch (e) {
      logger.warn('series-status', `Re-check failed for "${s.name}"`, e.message);
    }
    // ~2s between requests — polite CV rate limit
    await new Promise(r => setTimeout(r, 2000));
  }
  logger.info('series-status', `Monthly re-check done — ${changed}/${ongoing.length} series changed`);
});

// Monthly blacklist prune — keep the table from growing forever.
// Runs on the 1st of each month at 3:30am.
// Removes entries older than 30 days for issues that are now processed or skipped
// (no point keeping blacklist for issues we no longer need to download).
cron.schedule('30 3 1 * *', () => {
  try {
    const { changes } = db.prepare(`
      DELETE FROM download_blacklist
      WHERE failed_at < datetime('now', '-30 days')
        AND issue_id IN (
          SELECT id FROM monitored_issues WHERE status IN ('processed','skipped')
        )
    `).run();
    logger.info('blacklist-prune', `Pruned ${changes} old blacklist entries`);
  } catch (e) {
    logger.warn('blacklist-prune', 'Prune failed', e.message);
  }
});

async function fetchWalksoftly(dateStr) {
  const week = getLocgWeekNum(dateStr);
  const year = new Date(dateStr + 'T12:00:00Z').getUTCFullYear();
  const weekStr = String(week).padStart(2, '0');
  const url = `https://walksoftly.itsaninja.party/newcomics.php?week=${weekStr}&year=${year}`;
  logger.info('weekly', `Walksoftly fetch: week=${weekStr} year=${year} url=${url}`);
  try {
    const r = await axios.get(url, {
      timeout: 20000,
      headers: { 'User-Agent': 'Omnibus/1.0' },
      // Don't throw on non-2xx — some weeks return non-200 codes
      // when data isn't available yet. Log body for diagnosis.
      validateStatus: () => true,
    });

    if (r.status !== 200) {
      // Log response body snippet so we can see what the server returned
      const bodySnippet = typeof r.data === 'string'
        ? r.data.slice(0, 300)
        : JSON.stringify(r.data).slice(0, 300);
      logger.warn('weekly', `Walksoftly status ${r.status} for week ${weekStr}/${year}`, { body: bodySnippet });
      return [];
    }

    // If response is a valid array, return it directly.
    if (Array.isArray(r.data)) {
      if (r.data.length === 0) {
        logger.info('weekly', `Walksoftly returned empty array for week ${weekStr}/${year}`);
      } else {
        // Log first item's field names so we can spot field renames quickly
        logger.info('weekly', `Walksoftly OK: ${r.data.length} items, fields: [${Object.keys(r.data[0]).join(', ')}]`);
      }
      return r.data;
    }

    // Some response format change — log it so we can diagnose
    const bodySnippet = JSON.stringify(r.data).slice(0, 500);
    logger.warn('weekly', `Walksoftly returned non-array 200 response for week ${weekStr}/${year}`, { body: bodySnippet });

    // Try to salvage common wrapped shapes: { issues: [...] }, { data: [...] }, { comics: [...] }
    for (const key of ['issues', 'data', 'comics', 'results', 'list', 'releases']) {
      if (Array.isArray(r.data?.[key])) {
        logger.info('weekly', `Walksoftly: salvaged array from response.${key} (${r.data[key].length} items)`);
        return r.data[key];
      }
    }

    return [];
  } catch (e) {
    logger.warn('weekly', `Walksoftly fetch failed for week ${weekStr}/${year}: ${e.message}`);
    return [];
  }
}

// ─── Weekly release scrapers ──────────────────────────────────────
// Priority order: LOCG (JSON API) → FreshComics (HTML) → Walksoftly (down, last resort)

/**
 * Returns true if this title is a reprint and should be excluded from weekly results.
 * Catches facsimile editions, Nth printings, director's cuts, etc.
 */
function isReprintTitle(title) {
  return /\b(?:facsimile(?:\s+edition)?|(?:\d+(?:st|nd|rd|th)|second|third|fourth|fifth|sixth|new)\s+printing|director(?:'s|s)\s+cut|remastered\s+edition)\b/i.test(title);
}

/**
 * Shared title-type classifier used by both LOCG and FreshComics parsers.
 * Returns 'tpb' for collected editions, 'issue' for single issues.
 */
function detectReleaseType(title) {
  const t = title.toLowerCase();
  if (/\b(tpb|trade\s+paperback|hardcover|omnibus|compendium|epic\s+collection|complete\s+collection|graphic\s+novel|manga|anthology|digest|deluxe\s+edition|absolute\s+edition|box\s+set)\b/.test(t)) return 'tpb';
  if (/\bvol\.\s*\d/.test(t) && !/\s#\d/.test(t)) return 'tpb'; // "Vol. 5" without issue# → TPB
  if (/\b(hc|gn)\b/.test(t)) return 'tpb';
  return 'issue';
}

// ─── 1. League of Comic Geeks (primary) ──────────────────────────
// JSON API endpoint — no authentication required.
// Discovered via: github.com/pruizlezcano/comicgeeks

/**
 * Parse the HTML fragment returned in LOCG's JSON `list` field.
 * Each <li> is one issue entry.
 */
function parseLOCGHtml(html, fallbackDateStr) {
  const items = [];

  // Split on <li to process each issue card independently
  const parts = html.split(/<li\b/i);

  for (let i = 1; i < parts.length; i++) {
    const chunk = '<li ' + parts[i];

    // Only process issue entries (skip navigation, etc.)
    if (!/class="[^"]*\bissue\b/i.test(chunk)) continue;

    // Skip variants: data-parent must be "0" (variants have data-parent set to parent's data-comic)
    const parentM = chunk.match(/\bdata-parent="(\d+)"/i);
    if (parentM && parentM[1] !== '0') continue;

    // LOCG issue ID (data-comic) and URL slug (from the title <a href>)
    // e.g. data-comic="8193797", href="/comic/8193797/absolute-wonder-woman-20"
    const comicIdM  = chunk.match(/\bdata-comic="(\d+)"/i);
    const locg_id   = comicIdM ? comicIdM[1] : null;
    const hrefM     = chunk.match(/href="\/comic\/\d+\/([^"]+)"/i);
    const locg_slug = hrefM ? hrefM[1] : null;

    // Title: prefer data-sorting attribute — it's the canonical clean title
    // e.g. data-sorting="Absolute Green Arrow #1"
    // Fall back to inner text of .title div
    let titleRaw;
    const sortM = chunk.match(/\bdata-sorting="([^"]+)"/i);
    if (sortM) {
      titleRaw = sortM[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
    } else {
      const titleM = chunk.match(/class="[^"]*\btitle\b[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/(?:div|span|p|h\d)>/i);
      if (!titleM) continue;
      titleRaw = titleM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim();
    }
    if (!titleRaw) continue;

    // Publisher: <div class="publisher color-offset">Marvel Comics</div>
    const pubM = chunk.match(/class="[^"]*\bpublisher\b[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/(?:div|span|p)>/i);
    const publisher = pubM
      ? pubM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim()
      : 'Unknown';

    // Ship date: data-date="<unix timestamp>"
    const dateM = chunk.match(/\bdata-date="(\d+)"/i);
    let shipdate = fallbackDateStr;
    if (dateM) {
      const ts = parseInt(dateM[1], 10) * 1000;
      if (!isNaN(ts)) shipdate = new Date(ts).toISOString().slice(0, 10);
    }

    // Skip reprints (facsimiles, 2nd printings, etc.)
    if (isReprintTitle(titleRaw)) continue;

    // Parse "Series Name #N" or "Series Name #N.1" from title
    const issueM = titleRaw.match(/^(.+?)\s+#(\d[\d.]*)(?:\s*\(.*\))?\s*$/);
    let series, issue, type;
    if (issueM) {
      series = issueM[1].trim();
      issue  = issueM[2];
      type   = detectReleaseType(titleRaw);
    } else {
      series = titleRaw;
      issue  = '';
      type   = 'tpb';
    }

    items.push({ series, issue, publisher, type, shipdate, comicid: null, locg_id, locg_slug });
  }

  return items;
}

/**
 * Fetch this week's new releases from League of Comic Geeks.
 * Uses their internal JSON API; no login needed for public release data.
 *
 * Endpoint discovered from github.com/pruizlezcano/comicgeeks:
 *   GET /comic/get_comics?list=releases&view=thumbs&format[]=1&date_type=week&date=M/D/YYYY&order=pulls
 * Returns: { count: N, list: "<html fragment>" }
 */
// ─── LOCG ─────────────────────────────────────────────────────────────────────
// LOCG is behind Cloudflare bot protection. We bypass it using the existing
// FlareSolverr sidecar (same one used for GetComics/Nyaa). FlareSolverr runs a
// real Chromium instance on the server's own IP, so the resulting cf_clearance
// cookie is valid for subsequent requests from this machine.
//
// The new-comics page renders its list client-side via AJAX, so fetching the
// page HTML directly yields an empty container. Instead we:
//   1. Hit the main page via FlareSolverr to obtain valid CF cookies (fsCache).
//   2. Use those cached cookies to call LOCG's internal JSON API directly.
//      API: GET /comic/get_comics?list=releases&view=thumbs&format[]=1
//                                &date_type=week&date=M/D/YYYY&order=pulls
//      Returns: { count: N, list: "<html fragment of <li> cards>" }
//   3. Parse the list fragment with parseLOCGHtml.

const LOCG_BASE = 'https://leagueofcomicgeeks.com';

/**
 * Fetch this week's new releases from League of Comic Geeks.
 * dateStr = Monday of the week (YYYY-MM-DD); LOCG uses Wednesday → add 2 days.
 * Returns [] if FlareSolverr is unavailable or the API returns nothing useful.
 *
 * Strategy: use FlareSolverr for BOTH requests so real Chromium makes them.
 * Using cached CF cookies via plain axios fails because CF also checks the
 * TLS fingerprint (JA3/JA4) — a direct axios call looks like a bot regardless
 * of whether cf_clearance is present.
 *
 *   Step 1 — Page fetch with `wait: 8000`:
 *     FlareSolverr loads the new-comics page and waits 8s for the AJAX call
 *     that populates the comic list to complete. The fully-rendered HTML is
 *     returned in solution.response and passed to parseLOCGHtml.
 *
 *   Step 2 — API fetch (fallback):
 *     If step 1 yields 0 items (AJAX didn't finish / HTML structure changed),
 *     we ask FlareSolverr to navigate Chromium directly to the JSON API URL.
 *     Chrome renders the JSON as text inside a <pre>; we strip tags and parse.
 */
async function fetchLOCG(dateStr) {
  try {
    const monday = new Date(dateStr + 'T12:00:00Z');
    const wednesday = new Date(monday);
    wednesday.setUTCDate(monday.getUTCDate() + 2);
    const wedStr = wednesday.toISOString().slice(0, 10);
    const [year, month, day] = wedStr.split('-');
    const pageUrl = `${LOCG_BASE}/comics/new-comics/${year}/${month}/${day}`;

    // ── Primary: JSON API via FlareSolverr ────────────────────────────────────
    // The API returns the complete release list (all issues, not just the first
    // AJAX batch). The `list` field contains HTML-entity-encoded markup which
    // we decode before parsing.
    // API date format: M/D/YYYY (no zero-padding)
    const apiDate = `${parseInt(month, 10)}/${parseInt(day, 10)}/${year}`;
    const apiUrl  = `${LOCG_BASE}/comic/get_comics?list=releases&view=thumbs` +
                    `&format[]=1&date_type=week&date=${encodeURIComponent(apiDate)}&order=pulls`;

    logger.info('locg', 'Fetching JSON API via FlareSolverr', { apiUrl });
    const apiFs = await axios.post(`${FLARESOLVERR_URL}/v1`, {
      cmd:        'request.get',
      url:        apiUrl,
      maxTimeout: 60000,
    }, { timeout: 65000 });

    const apiSolution = apiFs.data?.solution;
    if (apiSolution?.status === 200 && apiSolution.response) {
      // Chrome renders JSON endpoints as text inside a <pre>; strip HTML tags.
      const raw = (apiSolution.response || '').replace(/<[^>]+>/g, '').trim();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) data = JSON.parse(m[0]);
      }

      const rawList = data?.list || '';
      if (rawList) {
        // The `list` field contains HTML-entity-encoded markup — decode first.
        const listHtml = rawList
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, '&')
          .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));

        const items = parseLOCGHtml(listHtml, wedStr);
        logger.info('locg', `API parsed ${items.length} releases`, { apiCount: data.count });
        if (items.length > 0) return items;
        logger.warn('locg', 'API returned list but parsed 0 items — falling back to page render');
      } else {
        logger.warn('locg', 'API returned no list HTML', { count: data?.count });
      }
    } else {
      logger.warn('locg', 'API fetch failed', {
        status:  apiSolution?.status,
        message: apiFs.data?.message,
      });
    }

    // ── Fallback: full page render with AJAX wait ─────────────────────────────
    // The page only renders a partial list via AJAX, but is better than nothing.
    logger.info('locg', 'Falling back to page render (wait=8000ms for AJAX)', { url: pageUrl });
    const pageFs = await axios.post(`${FLARESOLVERR_URL}/v1`, {
      cmd:        'request.get',
      url:        pageUrl,
      maxTimeout: 90000,
      wait:       8000,
    }, { timeout: 100000 });

    const pageSolution = pageFs.data?.solution;
    if (pageSolution?.status === 200 && pageSolution.response) {
      fsCache.set('leagueofcomicgeeks.com', {
        cookies:   pageSolution.cookies || [],
        userAgent: pageSolution.userAgent,
        expiry:    Date.now() + 30 * 60 * 1000,
      });
      const pageItems = parseLOCGHtml(pageSolution.response, wedStr);
      logger.info('locg', `Page render parsed ${pageItems.length} releases`);
      return pageItems;
    } else {
      logger.warn('locg', 'Page render fallback also failed', {
        status:  pageSolution?.status,
        message: pageFs.data?.message,
      });
    }

    return [];

  } catch (err) {
    logger.warn('locg', 'Fetch failed — falling back to FreshComics', { error: err.message });
    return [];
  }
}

// ─── 2. FreshComics (fallback) ────────────────────────────────────
// Server-rendered HTML at freshcomics.us/issues/YYYY-MM-DD (Wednesday date).
// Used if LOCG returns nothing (e.g. LOCG is down or week not yet posted).

/**
 * Canonicalize publisher names that FreshComics lists inconsistently.
 * Keeps a single canonical form so the same publisher doesn't appear twice.
 */
const PUBLISHER_ALIASES = {
  // Marvel
  'marvel':                   'Marvel Comics',
  'marvel comics':            'Marvel Comics',
  // BOOM! Studios
  'boom entertainment':       'BOOM! Studios',
  'boom! entertainment':      'BOOM! Studios',
  'boom studios':             'BOOM! Studios',
  'boom! studios':            'BOOM! Studios',
  // DC
  'dc':                       'DC Comics',
  'dc comics':                'DC Comics',
  // Dark Horse
  'dark horse':               'Dark Horse Comics',
  'dark horse comics':        'Dark Horse Comics',
  // IDW
  'idw':                      'IDW Publishing',
  'idw publishing':           'IDW Publishing',
};

function normalizeFreshComicsPublisher(name) {
  return PUBLISHER_ALIASES[name.toLowerCase()] ?? name;
}

/**
 * Parse FreshComics HTML. Publisher sections are delimited by <h2> tags.
 * Deduplicates by (series, issue) to handle publishers that label every
 * cover with "(Artist Name Cover)" rather than having a plain main cover.
 */
function parseFreshComicsHtml(html, shipdate) {
  const items = [];

  // Split on <h2 openings to isolate each publisher section
  const parts = html.split(/<h2(?:\s[^>]*)?>/i);

  // Seen sets keyed by normalized publisher name so that alias sections
  // (e.g. "Marvel" and "Marvel Comics") share the same dedup state.
  const seenByPublisher = new Map();

  for (let i = 1; i < parts.length; i++) {
    const closeH2 = parts[i].indexOf('</h2>');
    if (closeH2 === -1) continue;

    let publisher = parts[i]
      .slice(0, closeH2)
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .trim();

    // Skip non-publisher h2s (site chrome, page headers)
    if (!publisher || publisher.length < 2) continue;
    if (/freshcomics|fresh\s+comics|new\s+release|this\s+week|browse|filter/i.test(publisher)) continue;

    // Normalize known publisher name variants from FreshComics
    publisher = normalizeFreshComicsPublisher(publisher);

    const section = parts[i].slice(closeH2 + 5);

    // Deduplicate: keep only the FIRST listing of each series+issue combo,
    // shared across all sections that normalize to the same publisher name.
    if (!seenByPublisher.has(publisher)) seenByPublisher.set(publisher, new Set());
    const seen = seenByPublisher.get(publisher);

    const smallRe = /<small[^>]*>([\s\S]*?)<\/small>/gi;
    let m;
    while ((m = smallRe.exec(section)) !== null) {
      const titleRaw = m[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .trim();
      if (!titleRaw) continue;

      // Skip reprints (facsimiles, 2nd printings, etc.)
      if (isReprintTitle(titleRaw)) continue;

      // Parse "Series #N" or "Series #N (Artist Cover)" or "Series #N (2nd Printing)"
      const issueM = titleRaw.match(/^(.+?)\s+#(\d[\d.]*)(?:\s*\(.*\))?\s*$/);
      let series, issue, type;
      if (issueM) {
        series = issueM[1].trim();
        issue  = issueM[2];
        type   = detectReleaseType(titleRaw);
      } else {
        // No issue number → assume collected edition
        series = titleRaw.replace(/\s*\(.*?\)\s*$/, '').trim();
        issue  = '';
        type   = 'tpb';
      }

      // First listing of this (series, issue) wins; all subsequent covers skipped
      const key = `${series.toLowerCase()}||${issue}`;
      if (seen.has(key)) continue;
      seen.add(key);

      items.push({ series, issue, publisher, type, shipdate, comicid: null });
    }
  }

  return items;
}

/**
 * Fetch this week's releases from FreshComics.us.
 * dateStr = Monday of the week (YYYY-MM-DD); FreshComics uses Wednesday → add 2 days.
 */
async function fetchFreshComics(dateStr) {
  const monday    = new Date(dateStr + 'T12:00:00Z');
  const wednesday = new Date(monday);
  wednesday.setUTCDate(monday.getUTCDate() + 2);
  const wednesdayStr = wednesday.toISOString().slice(0, 10);
  const url = `https://freshcomics.us/issues/${wednesdayStr}`;

  logger.info('weekly', `FreshComics fetch: ${url}`);
  try {
    const r = await axios.get(url, {
      timeout: 20000,
      responseType: 'text',
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      validateStatus: () => true,
    });

    if (r.status !== 200) {
      logger.warn('weekly', `FreshComics status ${r.status} for ${wednesdayStr}`);
      return [];
    }

    const html = typeof r.data === 'string' ? r.data : String(r.data);
    if (html.length < 500 || !html.includes('<small')) {
      logger.warn('weekly', `FreshComics: thin/empty response for ${wednesdayStr} (${html.length} bytes)`);
      return [];
    }

    const items = parseFreshComicsHtml(html, dateStr);
    logger.info('weekly', `FreshComics OK: ${items.length} items for ${wednesdayStr}`);
    return items;
  } catch (e) {
    logger.warn('weekly', `FreshComics fetch failed for ${wednesdayStr}: ${e.message}`);
    return [];
  }
}

/**
 * Unified weekly releases fetch.
 * Priority: LOCG (if credentials configured) → FreshComics → Walksoftly (legacy).
 * Returns { items, source }.
 */
async function fetchWeeklyReleases(dateStr) {
  // 1. LOCG — richest data, includes pull counts and LOCG IDs for deep links.
  //    Uses FlareSolverr sidecar (same as GetComics) to bypass Cloudflare.
  //    Silently falls back to FreshComics if FlareSolverr is unavailable.
  const locg = await fetchLOCG(dateStr);
  if (locg.length > 0) return { items: locg, source: 'locg' };

  // 2. FreshComics — HTML scrape, full publisher coverage, no auth required
  const fresh = await fetchFreshComics(dateStr);
  if (fresh.length > 0) return { items: fresh, source: 'freshcomics' };

  // 3. Walksoftly — down since May 2026, kept as last resort
  logger.info('weekly', 'FreshComics returned 0 — trying Walksoftly fallback');
  const ws = await fetchWalksoftly(dateStr);
  if (ws.length > 0) return { items: ws, source: 'walksoftly' };

  return { items: [], source: 'none' };
}

app.get('/api/weekly', async (req, res) => {
  const { start } = req.query; // YYYY-MM-DD, Monday of the requested week
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return res.status(400).json({ error: 'start=YYYY-MM-DD required' });
  }

  const startDate = new Date(start + 'T12:00:00Z');
  const endDate   = new Date(startDate);
  endDate.setUTCDate(startDate.getUTCDate() + 6);
  const endStr = endDate.toISOString().slice(0, 10);

  try {
    const { items: rawAll, source: releaseSource } = await fetchWeeklyReleases(start);

    // ── Publisher exclusion ───────────────────────────────────────────
    // Filter out publishers the user has excluded (e.g. Panini, Webtoon).
    // The setting is a JSON array of case-insensitive substrings.
    let excludedPubs = [];
    try { excludedPubs = JSON.parse(getSetting('weekly_excluded_publishers') || '[]'); } catch {}
    const normExcluded = excludedPubs.map(p => (p || '').toLowerCase().trim()).filter(Boolean);
    const raw = normExcluded.length
      ? rawAll.filter(item => {
          const pub = (item.publisher || '').toLowerCase();
          return !normExcluded.some(excl => pub.includes(excl));
        })
      : rawAll;

    const tpbs    = raw.filter(item => isLocgTpb(item));
    const singles = raw.filter(item => !isLocgTpb(item));
    logger.info('weekly', `${releaseSource}: ${raw.length} total, ${singles.length} singles, ${tpbs.length} TPBs filtered for ${start}`);
    if (raw.length > 0 && singles.length === 0) {
      // All items were classified as TPBs — log sample types/issue fields for diagnosis
      const sample = raw.slice(0, 5).map(i => ({ type: i.type, issue: i.issue, series: i.series }));
      logger.warn('weekly', 'All items filtered as TPBs — check type/issue fields', { sample });
    }

    // ── Build monitored series lookup ─────────────────────────────
    const monSeries = db.prepare('SELECT * FROM monitored_series').all();

    // sourceNameMap: exact source name (normalised) → series row.
    // Populated when a series is added from the weekly tab — stores the exact
    // FreshComics/Walksoftly name string so matching is always unambiguous,
    // even when multiple CV volumes share the same title (e.g. 5 ASM runs).
    const sourceNameMap = new Map(); // normalisedSourceName → series
    for (const s of monSeries) {
      if (s.source_name) {
        const key = s.source_name.toLowerCase().replace(/[^a-z0-9]/g, '');
        // Last write wins if two series somehow share a source name —
        // prefer the one with higher (more recent) start year.
        const existing = sourceNameMap.get(key);
        if (!existing || (s.year || 0) > (existing.year || 0)) {
          sourceNameMap.set(key, s);
        }
      }
    }

    // release_cv_map — O(1) (normName+normPub) → cv_volume_id lookup.
    // Pre-seeded from all monitored_series at startup; beats name fuzzy-matching.
    const releaseCvMap = new Map(); // `normName||normPub` → cv_volume_id
    for (const e of db.prepare('SELECT norm_name, norm_publisher, cv_volume_id FROM release_cv_map').all()) {
      releaseCvMap.set(`${e.norm_name}||${e.norm_publisher}`, e.cv_volume_id);
    }

    // nameMap: normalisedName → series[] (array, not single row).
    // Multiple volumes can share the same name (e.g. Amazing Spider-Man 2018
    // and Amazing Spider-Man 2025 both normalise to "amazingspiderman").
    // The old single-value map silently dropped all but the last insert.
    const nameMap = new Map(); // normalisedName → series[]
    for (const s of monSeries) {
      const key = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!nameMap.has(key)) nameMap.set(key, []);
      nameMap.get(key).push(s);
    }

    // Index by CV volume ID — the monitored_series.id IS the Comic Vine volume ID
    const idMap = {}; // cvVolumeId → series row
    for (const s of monSeries) {
      idMap[String(s.id)] = s;
    }

    // Pre-load issue statuses to avoid N+1 queries
    const issuesBySeriesNum = {}; // seriesId → { normNum → status }
    const allMonIssues = db.prepare('SELECT series_id, issue_number, status FROM monitored_issues').all();
    for (const mi of allMonIssues) {
      if (!issuesBySeriesNum[mi.series_id]) issuesBySeriesNum[mi.series_id] = {};
      const norm = String(mi.issue_number || '').replace(/^0+/, '') || '0';
      issuesBySeriesNum[mi.series_id][norm] = mi.status;
    }

    // ── Annotate singles ──────────────────────────────────────────
    const annotated = singles.map(item => {
      const key = (item.series || '').toLowerCase().replace(/[^a-z0-9]/g, '');

      // 1. CV volume ID match (Walksoftly provides comicid; FreshComics leaves it null)
      let mon = (item.comicid ? idMap[String(item.comicid)] : null) || null;

      // 1a. release_cv_map lookup — persistent (normName+normPub) → CV volume ID table
      //     seeded from all monitored_series at startup. This is the primary matching
      //     path for FreshComics data: unambiguous, no fuzzy matching required.
      if (!mon) {
        const normPub = (item.publisher || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const cvId = releaseCvMap.get(`${key}||${normPub}`);
        if (cvId) mon = idMap[cvId] || null;
      }

      // 1b. Source-name exact match — user-confirmed mapping stored when adding
      //     from the weekly tab. Overrides auto seed when user picks a specific volume.
      if (!mon) mon = sourceNameMap.get(key) || null;

      // Helper: given multiple monitored series candidates sharing the same
      // normalised name, pick the best one for this weekly item.
      // Priority:
      //   1. Sole 'ongoing' candidate — a new issue of an ended series won't be
      //      in FreshComics, so if exactly one series is ongoing it must be the one.
      //   2. Among multiple ongoing candidates: the one with this issue in the DB
      //      (but only if status != processed/skipped — otherwise it's a different volume).
      //   3. Among multiple ongoing candidates: most recent start year.
      //   4. No ongoing series: most recent start year as last resort.
      //
      // NOTE: "has the issue in DB" is NOT priority #1 because an ended series that ran
      // 6 issues will have a #2 in monitored_issues, and we'd wrongly pick it over the
      // new ongoing series whose #2 hasn't been fetched from CV yet.
      const pickBest = (candidates) => {
        if (candidates.length === 1) return candidates[0];
        const issNum = String(item.issue || '').replace(/^0+/, '') || '0';

        // 1. Sole ongoing series
        const ongoing = candidates.filter(c => c.series_status === 'ongoing');
        if (ongoing.length === 1) return ongoing[0];

        // 2. Multiple ongoing: prefer one with a non-processed issue match
        if (ongoing.length > 1) {
          const withWanted = ongoing.filter(c => {
            const st = (issuesBySeriesNum[c.id] || {})[issNum];
            return st && st !== 'processed' && st !== 'skipped';
          });
          if (withWanted.length === 1) return withWanted[0];
          // Fall through to most-recent-year among ongoing
          return [...ongoing].sort((a, b) => (b.year || 0) - (a.year || 0))[0];
        }

        // 3. No ongoing series: most recent start year
        return [...candidates].sort((a, b) => (b.year || 0) - (a.year || 0))[0];
      };

      // 2. Exact normalised name match
      if (!mon) {
        const candidates = nameMap.get(key);
        if (candidates?.length) {
          // Filter candidates by publisher compatibility first —
          // prevents Webtoon "Spider-Man" matching Marvel's "Amazing Spider-Man"
          const pubCompatible = candidates.filter(c => publishersCompatible(item.publisher, c.publisher));
          const pool = pubCompatible.length ? pubCompatible : candidates;
          mon = pickBest(pool);
          // Veto the match if publishers are incompatible and no pub-compatible candidate exists
          if (!pubCompatible.length && !publishersCompatible(item.publisher, mon?.publisher)) {
            mon = null;
          }
        }
      }

      // 3. Prefix match with 70% length ratio guard
      if (!mon) {
        for (const [sk, candidates] of nameMap.entries()) {
          if (sk.length > 5 && key.length > 5) {
            const shorter = Math.min(sk.length, key.length);
            const longer  = Math.max(sk.length, key.length);
            if ((key.startsWith(sk) || sk.startsWith(key)) && shorter / longer >= 0.7) {
              const pubCompatible = candidates.filter(c => publishersCompatible(item.publisher, c.publisher));
              const pool = pubCompatible.length ? pubCompatible : candidates;
              const candidate = pickBest(pool);
              // Veto if publishers incompatible
              if (publishersCompatible(item.publisher, candidate?.publisher)) {
                mon = candidate;
              }
              break;
            }
          }
        }
      }

      // Find issue status.
      // Guard against false matches where the same CV volume ID or series name
      // is reused for a new volume (e.g. Zatanna 2025 vs Zatanna 2026).
      // If the weekly item ships more than 6 months after the matched series'
      // last known issue store_date, discard the match.
      let issueStatus = null;
      if (mon) {
        const serIssues = issuesBySeriesNum[mon.id] || {};
        const issNum = String(item.issue || '').replace(/^0+/, '') || '0';
        issueStatus = serIssues[issNum] || null;

        // Date-gap check: only applies to ended series.
        // If a series is ended and the weekly item ships more than 6 months
        // after its last known issue, this is almost certainly a different
        // volume sharing the same name/CV ID. Ongoing series are exempt —
        // they can have legitimate hiatuses longer than 6 months.
        if (item.shipdate && mon.series_status === 'ended') {
          const lastIssueRow = db.prepare(
            `SELECT store_date, release_date FROM monitored_issues
             WHERE series_id = ? AND store_date IS NOT NULL AND store_date != ''
             ORDER BY store_date DESC LIMIT 1`
          ).get(mon.id);
          const lastDate = lastIssueRow?.store_date || lastIssueRow?.release_date;
          if (lastDate) {
            const monthsGap = (new Date(item.shipdate) - new Date(lastDate)) / (1000 * 60 * 60 * 24 * 30);
            if (monthsGap > 6) {
              mon = null;
              issueStatus = null;
            }
          }
        }
      }

      // Build external links
      const locgIssueUrl = (item.locg_id && item.locg_slug)
        ? `${LOCG_BASE}/comic/${item.locg_id}/${item.locg_slug}` : null;
      const cvVolumeUrl = mon
        ? `https://comicvine.gamespot.com/volume/4050-${mon.id}/` : null;
      const locgSeriesUrl = (mon?.locg_series_id && mon?.locg_series_slug)
        ? `${LOCG_BASE}/comics/series/${mon.locg_series_id}/${mon.locg_series_slug}` : null;

      return {
        id:           item.comicid ? String(item.comicid) : null,
        issue_number: item.issue   || '',
        name:         '',
        store_date:   item.shipdate || start,
        cover_date:   '',
        image_url:    mon?.image_url || null,
        cv_url:       cvVolumeUrl,
        locg_url:     locgIssueUrl,
        locg_series_url: locgSeriesUrl,
        volume: {
          id:         item.comicid ? String(item.comicid) : null,
          name:       item.series  || '',
          publisher:  item.publisher || 'Unknown',
          start_year: mon?.year || null,
          image_url:  mon?.image_url || null,
        },
        monitored:    !!mon,
        monitored_id: mon ? String(mon.id) : null,
        issue_status: issueStatus,
        source:       'comicvine',
        // Internal — used below to seed locg_issue_lookup, stripped before response
        _locg_id:     item.locg_id || null,
        _locg_slug:   item.locg_slug || null,
      };
    });

    // ── Batch-fetch CV cover images for unmonitored series ────────
    const CV_API_KEY = getCVKey();
    const unmonIds = [...new Set(
      annotated
        .filter(a => !a.monitored && a.volume.id)
        .map(a => a.volume.id)
    )];

    const coverMap = {};
    for (let i = 0; i < unmonIds.length; i += 100) {
      const batch = unmonIds.slice(i, i + 100);
      try {
        await new Promise(r => setTimeout(r, 400));
        const vr = await cvApiGet('https://comicvine.gamespot.com/api/volumes/', {
          params: {
            api_key: getCVKey(), format: 'json',
            filter: `id:${batch.join('|')}`,
            field_list: 'id,image',
            limit: 100,
          },
          headers: { 'User-Agent': 'Omnibus/1.0' },
          timeout: 15000,
        });
        for (const vol of (vr.data.results || [])) {
          coverMap[String(vol.id)] = vol.image?.medium_url || vol.image?.small_url || null;
        }
      } catch (e) {
        logger.warn('weekly', `Cover batch fetch failed: ${e.message}`);
      }
    }

    // Apply fetched covers
    for (const a of annotated) {
      if (!a.monitored && a.volume.id && coverMap[a.volume.id]) {
        a.image_url        = coverMap[a.volume.id];
        a.volume.image_url = coverMap[a.volume.id];
      }
    }

    // ── Seed locg_issue_lookup from this week's LOCG data ────────────
    // Stores (locg_issue_id, slug, cv_series_id) so the background resolver
    // can later fetch issue pages to extract locg_series_id.
    const locgInsert = db.prepare(`
      INSERT OR IGNORE INTO locg_issue_lookup (locg_issue_id, locg_slug, cv_series_id)
      VALUES (?, ?, ?)
    `);
    const locgInsertMany = db.transaction(() => {
      for (const a of annotated) {
        if (a._locg_id && a._locg_slug) {
          locgInsert.run(a._locg_id, a._locg_slug, a.monitored_id || null);
        }
      }
    });
    locgInsertMany();

    // Strip internal fields before sending to client
    for (const a of annotated) {
      delete a._locg_id;
      delete a._locg_slug;
    }

    annotated.sort((a, b) => {
      const pa = a.volume.publisher || '', pb = b.volume.publisher || '';
      if (pa !== pb) return pa.localeCompare(pb);
      return (a.volume.name || '').localeCompare(b.volume.name || '');
    });

    // ── Gap detection — fire background CV refresh for any monitored series
    // where an issue is shipping this week but isn't in our DB yet (status null).
    // Use mon.id from the DB match, NOT a.volume.id from Walksoftly — Walksoftly's
    // comicid can be null or stale for newer series (e.g. Absolute imprint titles)
    // while the name-match still correctly identifies the monitored series.
    const gapSeriesIds = new Set(
      annotated
        .filter(a => a.monitored && a.issue_status === null && a.monitored_id)
        .map(a => a.monitored_id)  // always the verified DB series ID
    );
    if (gapSeriesIds.size > 0) {
      logger.info('weekly', `Gap detected for ${gapSeriesIds.size} monitored series — triggering background CV refresh`, { ids: [...gapSeriesIds] });
      setImmediate(async () => {
        for (const sid of gapSeriesIds) {
          try {
            const { inserted } = await refreshSeriesIssuesFromCV(sid);
            if (inserted > 0) logger.info('weekly', `Gap-fill: series ${sid} +${inserted} new issues`);
            await new Promise(r => setTimeout(r, 700));
          } catch (e) {
            logger.warn('weekly', `Gap-fill failed for series ${sid}`, e.message);
          }
        }
      });
    }

    res.json({
      start, end: endStr,
      total_fetched:  raw.length,
      total_singles:  annotated.length,
      total_tpbs_filtered: tpbs.length,
      source: 'comicvine',
      issues: annotated,
      // Diagnostic info — useful when the tab shows 0 results so the UI
      // can surface a hint rather than just a blank "No single issues found."
      _debug: {
        release_source: releaseSource,
        locg_url: (() => {
          const d = new Date(start + 'T12:00:00Z');
          return `https://leagueofcomicgeeks.com/comic/get_comics?list=releases&view=thumbs&format[]=1&date_type=week&date=${d.getUTCMonth()+1}/${d.getUTCDate()}/${d.getUTCFullYear()}&order=pulls`;
        })(),
        freshcomics_url: (() => {
          const wed = new Date(start + 'T12:00:00Z');
          wed.setUTCDate(wed.getUTCDate() + 2);
          return `https://freshcomics.us/issues/${wed.toISOString().slice(0, 10)}`;
        })(),
        walksoftly_week: getLocgWeekNum(start),
        walksoftly_url: (() => {
          const wk = getLocgWeekNum(start);
          const yr = new Date(start + 'T12:00:00Z').getUTCFullYear();
          return `https://walksoftly.itsaninja.party/newcomics.php?week=${String(wk).padStart(2,'0')}&year=${yr}`;
        })(),
        raw_count: raw.length,
        singles_count: singles.length,
        tpbs_filtered: tpbs.length,
      },
    });
  } catch (e) {
    logger.error('weekly', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Debug: raw weekly release data from all three sources for a given week.
// Usage: GET /api/weekly/debug-locg?date=2026-05-19
// ─── Release sources compared (admin, 2026-10-26) ─────────────────
// One week from the current weekly source (League of Comic Geeks → FreshComics, as the Weekly tab)
// and from Metron's issue list (official API), each matched to monitored series, against the
// monitored issues Comic Vine dates to that week. Written to the backups folder as
// release-compare-<start>.json for analysis on the host. GET /api/admin/releases/compare?start=YYYY-MM-DD (a Monday).
app.get('/api/admin/releases/compare', requireAdmin, async (req, res) => {
  const start = String(req.query.start || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return res.status(400).json({ error: 'start=YYYY-MM-DD (a Monday) required' });
  const endD = new Date(start + 'T12:00:00Z'); endD.setUTCDate(endD.getUTCDate() + 6);
  const end = endD.toISOString().slice(0, 10);
  const nm = x => String(x || '').toLowerCase().replace(/&/g, ' and ').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
  const nn = x => { const t = String(x ?? '').trim().replace(/^#/, ''); return /^\d+(\.\d+)?$/.test(t) ? String(parseFloat(t)) : t.toLowerCase(); };
  const out = { start, end, at: new Date().toISOString() };
  try {
    // Monitored series and the monitored issues Comic Vine dates to this week (store date, else release date).
    const series = db.prepare("SELECT id, name, year, publisher, status FROM monitored_series").all();
    const byNameYear = new Map(), byName = new Map();
    for (const s of series) { byNameYear.set(`${nm(s.name)}|${s.year}`, s); if (!byName.has(nm(s.name))) byName.set(nm(s.name), []); byName.get(nm(s.name)).push(s); }
    const issueStatus = db.prepare('SELECT id, status FROM monitored_issues WHERE series_id = ? AND issue_number = ?');
    const yours = db.prepare(`SELECT i.id AS cv_issue_id, i.series_id, s.name, s.year, i.issue_number, COALESCE(i.store_date, i.release_date) AS date, i.status
      FROM monitored_issues i JOIN monitored_series s ON s.id = i.series_id
      WHERE COALESCE(i.store_date, i.release_date) BETWEEN ? AND ? AND s.status = 'active'`).all(start, end);
    out.monitored_this_week = yours.map(y => ({ ...y, key: `${y.series_id}|${nn(y.issue_number)}` }));

    // Current weekly source, through the Weekly tab's own route (same matching as the app).
    try {
      const r = await axios.get(`http://127.0.0.1:${PORT}/api/weekly`, { params: { start }, timeout: 300000,
        headers: { ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}), ...(req.headers.cookie ? { Cookie: req.headers.cookie } : {}) } });
      const items = r.data.issues || [];
      out.weekly = { source: r.data._debug?.release_source || r.data.source, fetched: r.data.total_fetched, singles: items.length, tpbs_filtered: r.data.total_tpbs_filtered,
        issues: items.map(a => ({ name: a.volume?.name || a.series_name || a.name || null, number: a.issue_number ?? a.number ?? null, publisher: a.volume?.publisher || a.publisher || null,
          monitored_id: a.monitored_id || null, issue_status: a.issue_status ?? null, pulls: a.pulls ?? a.pull_count ?? null })) };
      out.weekly.monitored = out.weekly.issues.filter(i => i.monitored_id).length;
    } catch (e) { out.weekly = { error: e.message }; }

    // Metron: every issue with a store date in the week (official API; paged, spaced, cached by the client).
    try {
      const list = [];
      let next = 'issue/', params = { store_date_range_after: start, store_date_range_before: end }, pages = 0;
      while (next && pages < 15) {
        const d = await metron.get(next, params);
        pages++; params = null;
        for (const i of (d && d.results) || []) list.push({ id: i.id, name: i.series?.name || '', volume_year: i.series?.year_began || null, number: String(i.number ?? ''),
          store_date: i.store_date || null, cover_date: i.cover_date || null, cv_id: i.cv_id || null, publisher: i.series?.publisher?.name || null });
        next = d && d.next ? d.next : null;
      }
      for (const i of list) {
        const s = byNameYear.get(`${nm(i.name)}|${i.volume_year}`) || ((byName.get(nm(i.name)) || []).length === 1 ? byName.get(nm(i.name))[0] : null);
        i.monitored_id = s ? s.id : null;
        i.match = s ? (byNameYear.has(`${nm(i.name)}|${i.volume_year}`) ? 'name+year' : 'name') : null;
        i.issue_status = s ? (issueStatus.get(s.id, i.number)?.status || null) : null;
      }
      out.metron = { pages, issues: list, monitored: list.filter(i => i.monitored_id).length, with_cv_id: list.filter(i => i.cv_id).length };
    } catch (e) { out.metron = { error: e.message, code: e.code || null }; }

    // Which of your monitored issues each source found.
    const found = list => new Set((list || []).filter(i => i.monitored_id).map(i => `${i.monitored_id}|${nn(i.number)}`));
    const wSet = found(out.weekly.issues), mSet = found(out.metron.issues);
    out.summary = {
      monitored_this_week: out.monitored_this_week.length,
      weekly: out.weekly.error ? { error: out.weekly.error } : { source: out.weekly.source, singles: out.weekly.singles, matched_to_monitored: out.weekly.monitored,
        found_of_yours: out.monitored_this_week.filter(y => wSet.has(y.key)).length },
      metron: out.metron.error ? { error: out.metron.error } : { issues: out.metron.issues.length, matched_to_monitored: out.metron.monitored, with_cv_id: out.metron.with_cv_id,
        found_of_yours: out.monitored_this_week.filter(y => mSet.has(y.key)).length },
    };
    let file = null;
    try { file = path.join(DB_BACKUP_DIR, `release-compare-${start}.json`); fs.writeFileSync(file, JSON.stringify(out, null, 1)); } catch { file = null; }
    res.json({ ...out.summary, file });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/weekly/debug-locg', requireAdmin, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
  try {
    // LOCG
    const ld    = new Date(date + 'T12:00:00Z');
    const locgUrl = `https://leagueofcomicgeeks.com/comic/get_comics?list=releases&view=thumbs&format%5B%5D=1%2C6&date_type=week&date=${encodeURIComponent(`${ld.getUTCMonth()+1}/${ld.getUTCDate()}/${ld.getUTCFullYear()}`)}&order=pulls`;
    const locgData = await fetchLOCG(date);

    // FreshComics
    const wed = new Date(date + 'T12:00:00Z');
    wed.setUTCDate(wed.getUTCDate() + 2);
    const freshUrl  = `https://freshcomics.us/issues/${wed.toISOString().slice(0, 10)}`;
    const freshData = await fetchFreshComics(date);

    // Walksoftly (legacy)
    const week    = getLocgWeekNum(date);
    const year    = new Date(date + 'T12:00:00Z').getUTCFullYear();
    const weekStr = String(week).padStart(2, '0');
    const wsUrl   = `https://walksoftly.itsaninja.party/newcomics.php?week=${weekStr}&year=${year}`;
    const wsData  = await fetchWalksoftly(date);

    // Best available data
    const data   = locgData.length > 0 ? locgData : (freshData.length > 0 ? freshData : wsData);
    const source = locgData.length > 0 ? 'locg' : (freshData.length > 0 ? 'freshcomics' : (wsData.length > 0 ? 'walksoftly' : 'none'));

    const fieldNames = data.length ? Object.keys(data[0]) : [];
    const typeValues = [...new Set(data.map(d => d.type).filter(Boolean))];
    const singles    = data.filter(d => !isLocgTpb(d));
    const tpbs       = data.filter(d => isLocgTpb(d));

    res.json({
      date, source,
      locg:       { url: locgUrl,  count: locgData.length },
      freshcomics: { url: freshUrl, count: freshData.length },
      walksoftly:  { url: wsUrl, week, weekStr, year, count: wsData.length },
      total: data.length,
      singles: singles.length,
      tpbs_filtered: tpbs.length,
      field_names: fieldNames,
      type_values_present: typeValues,
      sample_items: data.slice(0, 5),
      all_data: data,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Debug: show exactly how a FreshComics series name resolves against monitored series.
// Usage: GET /api/debug/weekly-match?name=Zatanna&publisher=DC+Comics&issue=1
app.get('/api/debug/weekly-match', async (req, res) => {
  const { name, publisher, issue } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });

  const key     = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const issNum  = String(issue || '').replace(/^0+/, '') || '0';

  const monSeries = db.prepare('SELECT id, name, publisher, year, series_status, source_name FROM monitored_series').all();

  // Exact match candidates
  const exactCandidates = monSeries.filter(s =>
    s.name.toLowerCase().replace(/[^a-z0-9]/g, '') === key
  );

  // Prefix match candidates
  const prefixCandidates = monSeries.filter(s => {
    const sk = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (sk.length <= 5 || key.length <= 5) return false;
    return key.startsWith(sk) || sk.startsWith(key);
  });

  // Source name match
  const sourceMatch = monSeries.find(s =>
    s.source_name && s.source_name.toLowerCase().replace(/[^a-z0-9]/g, '') === key
  );

  // Issue counts per candidate
  const issueInfo = (id) => {
    const total = db.prepare('SELECT COUNT(*) as c FROM monitored_issues WHERE series_id = ?').get(id);
    const specific = db.prepare('SELECT status FROM monitored_issues WHERE series_id = ? AND issue_number = ?').get(id, issNum);
    return { total_issues_in_db: total?.c, issue_status: specific?.status ?? null };
  };

  res.json({
    query: { name, key, publisher, issue, issNum },
    source_name_match: sourceMatch ? { id: sourceMatch.id, name: sourceMatch.name, year: sourceMatch.year } : null,
    exact_match_candidates: exactCandidates.map(s => ({ id: s.id, name: s.name, year: s.year, series_status: s.series_status, ...issueInfo(s.id) })),
    prefix_match_candidates: prefixCandidates.map(s => ({ id: s.id, name: s.name, year: s.year, series_status: s.series_status, ...issueInfo(s.id) })),
  });
});

// Debug: dump raw FlareSolverr response for the LOCG page and API URL.
// Usage: GET /api/debug/locg-raw?date=2026-05-25
app.get('/api/debug/locg-raw', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
  try {
    const monday = new Date(date + 'T12:00:00Z');
    const wednesday = new Date(monday);
    wednesday.setUTCDate(monday.getUTCDate() + 2);
    const wedStr = wednesday.toISOString().slice(0, 10);
    const [year, month, day] = wedStr.split('-');
    const pageUrl = `${LOCG_BASE}/comics/new-comics/${year}/${month}/${day}`;
    const apiDate = `${parseInt(month, 10)}/${parseInt(day, 10)}/${year}`;
    const apiUrl  = `${LOCG_BASE}/comic/get_comics?list=releases&view=thumbs` +
                    `&format[]=1&date_type=week&date=${encodeURIComponent(apiDate)}&order=pulls`;

    // Fetch page via FS (with wait)
    const pageFs = await axios.post(`${FLARESOLVERR_URL}/v1`, {
      cmd: 'request.get', url: pageUrl, maxTimeout: 90000, wait: 8000,
    }, { timeout: 100000 });
    const pageSol = pageFs.data?.solution;

    // Fetch API via FS
    const apiFs = await axios.post(`${FLARESOLVERR_URL}/v1`, {
      cmd: 'request.get', url: apiUrl, maxTimeout: 60000,
    }, { timeout: 65000 });
    const apiSol = apiFs.data?.solution;

    // Try to parse the API response
    let apiParsed = null;
    let apiParseError = null;
    let apiListPreview = null;
    if (apiSol?.status === 200 && apiSol.response) {
      try {
        const raw = apiSol.response.replace(/<[^>]+>/g, '').trim();
        const data = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
        const decodedList = (data?.list || '')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
          .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
        apiListPreview = decodedList.slice(0, 3000);
        apiParsed = parseLOCGHtml(decodedList, wedStr);
      } catch (pe) {
        apiParseError = pe.message;
      }
    }

    // Try to parse page response
    const pageParsed = (pageSol?.status === 200 && pageSol.response)
      ? parseLOCGHtml(pageSol.response, wedStr)
      : null;

    res.json({
      wednesday: wedStr,
      page: {
        url: pageUrl,
        fs_status: pageFs.data?.status,
        solution_status: pageSol?.status,
        response_length: pageSol?.response?.length,
        response_preview: pageSol?.response?.slice(0, 2000),
        cookies: pageSol?.cookies?.map(c => c.name),
        parsed_count: pageParsed?.length ?? null,
        parsed_sample: pageParsed?.slice(0, 5) ?? null,
      },
      api: {
        url: apiUrl,
        fs_status: apiFs.data?.status,
        solution_status: apiSol?.status,
        response_length: apiSol?.response?.length,
        response_preview: apiSol?.response?.slice(0, 500),
        list_preview: apiListPreview,
        parse_error: apiParseError,
        parsed_count: apiParsed?.length ?? null,
        parsed_sample: apiParsed?.slice(0, 5) ?? null,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message, stack: e.stack }); }
});

// Debug: check if LOCG data-comic IDs exist in monitored_issues (are they CV issue IDs?)
// Usage: GET /api/debug/locg-id-check?ids=1127152,7203519,7972288
app.get('/api/debug/locg-id-check', (req, res) => {
  const { ids } = req.query;
  if (!ids) return res.status(400).json({ error: 'ids=comma,separated,ids required' });
  const idList = ids.split(',').map(s => s.trim()).filter(Boolean);
  const results = idList.map(id => {
    const issue = db.prepare('SELECT id, series_id, issue_number, status FROM monitored_issues WHERE id = ?').get(id);
    let series = null;
    if (issue) {
      series = db.prepare('SELECT id, name, publisher, year, series_status FROM monitored_series WHERE id = ?').get(issue.series_id);
    }
    return { locg_data_comic: id, found: !!issue, issue, series };
  });
  res.json({ checked: idList.length, results });
});

// Debug: probe LOCG series search API and issue page structure.
// Usage: GET /api/debug/locg-series-probe?issue_id=8193797&name=Absolute+Wonder+Woman
app.get('/api/debug/locg-series-probe', async (req, res) => {
  const { issue_id = '8193797', name = 'Absolute Wonder Woman' } = req.query;
  const results = {};

  const htmlDecode = s => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)));

  const extractSeriesHits = html => {
    const hits = [...html.matchAll(/href="\/comics\/series\/(\d+)\/([^"]+)"/g)]
      .map(m => ({ series_id: m[1], slug: m[2] }));
    return [...new Map(hits.map(h => [h.series_id, h])).values()]; // dedupe
  };

  // ── 1. Issue page WITH full slug + wait so AJAX content renders ──────────
  // ID-only URL redirects to homepage. Must include slug.
  const { slug = 'absolute-wonder-woman-20' } = req.query;
  try {
    const issueUrl = `${LOCG_BASE}/comic/${issue_id}/${slug}`;
    const r = await axios.post(`${FLARESOLVERR_URL}/v1`, {
      cmd: 'request.get', url: issueUrl, maxTimeout: 60000, wait: 5000,
    }, { timeout: 70000 });
    const html = r.data?.solution?.response || '';
    const seriesHits = extractSeriesHits(html);
    const idx = html.indexOf('/comics/series/');

    results.issue_page = {
      url: issueUrl,
      status: r.data?.solution?.status,
      response_length: html.length,
      series_links: seriesHits.slice(0, 5),
      series_href_context: idx >= 0 ? html.slice(Math.max(0, idx - 80), idx + 200) : null,
      data_attrs: (html.match(/\bdata-\w+="[^"]+"/g) || [])
        .filter(a => /series|volume|comic/i.test(a)).slice(0, 20),
    };
  } catch (e) {
    results.issue_page = { error: e.message };
  }

  // ── 2. get_comics?list=series — decode entity-encoded list HTML ───────────
  // Try both query param names; also try with series_id from issue URL in case
  // LOCG has a "get series for this issue" mode.
  const apiCandidates = [
    { label: 'query param',  url: `${LOCG_BASE}/comic/get_comics?list=series&query=${encodeURIComponent(name)}&view=list&order=pulls` },
    { label: 'search param', url: `${LOCG_BASE}/comic/get_comics?list=series&search=${encodeURIComponent(name)}&view=list` },
    { label: 'series_id issue lookup', url: `${LOCG_BASE}/comic/get_comics?list=series&comic_id=${issue_id}` },
  ];

  results.api_probes = [];
  for (const { label, url } of apiCandidates) {
    try {
      const r = await axios.post(`${FLARESOLVERR_URL}/v1`, {
        cmd: 'request.get', url, maxTimeout: 30000,
      }, { timeout: 35000 });
      const raw = r.data?.solution?.response || '';
      const stripped = raw.replace(/<[^>]+>/g, '').trim();
      let json = null;
      try { json = JSON.parse(stripped.match(/\{[\s\S]*\}/)?.[0] || stripped); } catch {}

      // Decode the `list` field and look for series IDs
      const rawList = json?.list || '';
      const decodedList = rawList ? htmlDecode(rawList) : '';
      const seriesHits = extractSeriesHits(decodedList);

      // Also look for series IDs directly in raw response (unencoded)
      const rawHits = extractSeriesHits(raw);

      results.api_probes.push({
        label, url,
        status: r.data?.solution?.status,
        response_length: raw.length,
        json_keys: json ? Object.keys(json) : null,
        count: json?.count ?? null,
        configurator: json?.configurator ?? null,
        series_in_decoded_list: seriesHits.slice(0, 10),
        series_in_raw: rawHits.slice(0, 5),
        decoded_list_preview: decodedList.slice(0, 1000),
        json_preview: stripped.slice(0, 300),
      });
    } catch (e) {
      results.api_probes.push({ label, url, error: e.message });
    }
    await new Promise(r => setTimeout(r, 600));
  }

  res.json(results);
});

// ─── Auth routes ──────────────────────────────────────────────────

// POST /api/auth/login — local username/password login
const loginLimiter = authSecurity.createLoginLimiter();
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!authSecurity.validCredentials(username, password)) return res.status(400).json({ error: 'Valid username and password required' });
  // Too many failed attempts: refuse before checking the password (security review 2026-11-12).
  const wait = loginLimiter.retryAfter(username, req.ip);
  if (wait > 0) {
    logger.warn('auth', 'Sign-in refused after repeated failures', { username: String(username).slice(0, 64), ip: req.ip });
    res.set('Retry-After', String(wait));
    return res.status(429).json({ error: `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}.` });
  }
  try {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase().trim());
    if (!user || !user.password_hash || !await verifyPassword(password, user.password_hash)) {
      loginLimiter.fail(username, req.ip);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    loginLimiter.succeed(username);
    // Password verification yields: a concurrent reset/deletion must not mint a fresh session.
    const current = db.prepare('SELECT password_hash, auth_version FROM users WHERE id = ?').get(user.id);
    if (!current || current.password_hash !== user.password_hash || current.auth_version !== user.auth_version) return res.status(401).json({ error: 'Invalid credentials' });
    db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);
    const token = jwtSign({ sub: user.id });
    res.set('Cache-Control', 'no-store');
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
  } catch (e) {
    logger.error('auth', 'Local login failed', { error: e.message });
    res.status(500).json({ error: 'Unable to sign in' });
  }
});

// ─── APPEARANCE (per-user colours, 2026-10-27) ────────────────────
// Four root colours (base, secondary, highlight, text) and whether character /
// cover colours may override them on reading pages. Null colours = Omnibus defaults.
db.exec(`CREATE TABLE IF NOT EXISTS user_appearance (
  user_id    TEXT PRIMARY KEY,
  prefs      TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
)`);
const { cleanAppearance } = require('./appearancePrefs');
app.get('/api/users/me/appearance', requireAuth, (req, res) => {
  try {
    const row = db.prepare('SELECT prefs FROM user_appearance WHERE user_id = ?').get(req.user.sub);
    res.json(row ? (cleanAppearance(JSON.parse(row.prefs)) || { colors: null, pageColors: true }) : { colors: null, pageColors: true });
  } catch (e) { res.status(500).json({ error: 'Unable to load appearance' }); }
});
app.put('/api/users/me/appearance', requireAuth, (req, res) => {
  const prefs = cleanAppearance(req.body);
  if (!prefs) return res.status(400).json({ error: 'Colours must be #rrggbb values for base, secondary, highlight and text' });
  try {
    // A theme switch counts toward the hidden "New Costume, Who Dis?" achievement (2026-11-11).
    let before = null; try { before = JSON.parse(db.prepare('SELECT prefs FROM user_appearance WHERE user_id = ?').get(req.user.sub)?.prefs || 'null'); } catch {}
    if (prefs.themeId !== undefined && (before?.themeId ?? null) !== (prefs.themeId ?? null)) { try { achievements?.bump(req.user.sub, 'theme'); } catch {} }
    db.prepare(`INSERT INTO user_appearance (user_id, prefs, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`).run(req.user.sub, JSON.stringify(prefs));
    res.json(prefs);
  } catch (e) { res.status(500).json({ error: 'Unable to save appearance' }); }
});

// Legacy favorites are retained only for the optional Pull Box import.
// GET /api/auth/me — verify token and return current user
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT id, username, email, role, last_login, password_hash FROM users WHERE id = ?').get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password_hash, ...out } = user;
  // An admin still on the first-run password (admin / admin) is told so on Home (2026-11-11).
  if (out.role === 'admin' && out.username === 'admin' && password_hash) { try { out.default_password = await verifyPassword('admin', password_hash); } catch {} }
  res.json(out);
});

// GET /api/auth/oidc-status — returns whether SSO is configured (safe to call unauthenticated)
app.get('/api/auth/oidc-status', (req, res) => {
  const configured = !!(OIDC_CLIENT_ID && OIDC_CLIENT_SECRET && OIDC_BASE_URL);
  res.json({
    configured,
    // Admin setting: show only the SSO button on the login page. The local
    // form stays reachable at /login?local=1 (admin fallback if SSO is down).
    hide_local_login: configured && getSetting('oidc_hide_local_login') === 'true',
    base_url:   OIDC_BASE_URL  || null,
    client_id:  OIDC_CLIENT_ID ? `${OIDC_CLIENT_ID.slice(0, 6)}…` : null, // partial — never expose full ID
  });
});

// POST /api/auth/logout revokes this session persistently and clears reader access
app.post('/api/auth/logout', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { authTokens.revoke(requestToken(req)); }
  catch (e) {
    if (!(e instanceof authSecurity.SessionError)) return res.status(500).json({ error: 'Unable to revoke session; try again' });
    readerSecurity.clearReaderCookie(req, res);
    return res.status(401).json({ error: 'Session is no longer valid' });
  }
  readerSecurity.clearReaderCookie(req, res);
  res.json({ ok: true });
});

app.post('/api/auth/reader-session', requireAuth, (req, res) => {
  readerSecurity.setReaderCookie(req, res, requestToken(req), req.user);
  res.json({ ok: true });
});

// GET /api/auth/oidc — redirect browser to OIDC provider authorize endpoint
app.get('/api/auth/authentik', (req, res) => {  // keep path for backwards compat with frontend
  if (!OIDC_CLIENT_ID || !OIDC_BASE_URL) return res.status(503).json({ error: 'SSO not configured — set OIDC_BASE_URL, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET in your .env' });
  let state;
  try { state = oidcState.begin(req, res); }
  catch { return res.status(429).json({ error: 'Too many pending sign-ins; try again shortly' }); }
  const params = new URLSearchParams({
    client_id:     OIDC_CLIENT_ID,
    redirect_uri:  OIDC_REDIRECT_URI,
    response_type: 'code',
    scope:         'openid email profile',
    state,
  });
  res.redirect(`${OIDC_BASE_URL}/authorize/?${params}`);
});

// GET /api/auth/callback — OIDC provider posts browser back here after login
app.get('/api/auth/callback', async (req, res) => {
  if (!oidcState.consume(req, res)) return res.redirect('/login?error=invalid_sso_state');
  const { code, error } = req.query;
  if (error) return res.redirect(`/login?error=${encodeURIComponent(error)}`);
  if (typeof code !== 'string' || !code || code.length > 4096) return res.redirect('/login?error=no_code');
  let _step = 'init';
  try {
    _step = 'token_exchange';
    const tokenRes = await axios.post(`${OIDC_BASE_URL}/token/`, new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  OIDC_REDIRECT_URI,
      client_id:     OIDC_CLIENT_ID,
      client_secret: OIDC_CLIENT_SECRET,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });

    _step = 'userinfo_fetch';
    const userRes = await axios.get(`${OIDC_BASE_URL}/userinfo/`, {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }, timeout: 15000,
    });
    _step = 'user_lookup';
    const user = authSecurity.resolveOidcUser(db, userRes.data);
    _step = 'last_login_update';
    db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);
    _step = 'sign_token';
    const token = jwtSign({ sub: user.id, username: user.username, role: user.role });
    _step = 'redirect';
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.redirect(`/auth-callback?token=${encodeURIComponent(token)}`);
  } catch (e) {
    logger.error('auth', 'OIDC callback error', { step: _step, error: e.message, stack: e.stack });
    res.redirect(`/login?error=${encodeURIComponent('Authentication failed — check server logs')}`);
  }
});

// ─── User management routes (admin only) ──────────────────────────

// GET /api/users
app.get('/api/users', requireAdmin, (req, res) => {
  const users = db.prepare(
    'SELECT id, username, email, role, authentik_id, created_at, last_login FROM users ORDER BY created_at ASC'
  ).all();
  res.json(users);
});

// POST /api/users — create local user
app.post('/api/users', requireAdmin, async (req, res) => {
  const { username, email, password, role = 'user' } = req.body || {};
  if (!authSecurity.validCredentials(username, password)) return res.status(400).json({ error: 'Valid username and password required' });
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const id   = crypto.randomUUID();
    const hash = await hashPassword(password);
    db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
      .run(id, username.toLowerCase().trim(), email || null, hash, role);
    res.json({ ok: true, id });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username or email already exists' });
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/users/:id — update role, email, password, username
app.patch('/api/users/:id', requireAdmin, async (req, res) => {
  const { role, email, password, username } = req.body || {};
  if ((role !== undefined && !['admin', 'user'].includes(role)) ||
      (username !== undefined && !authSecurity.validCredentials(username, 'validation')) ||
      (password !== undefined && password !== '' && !authSecurity.validCredentials('validation', password)) ||
      (email !== undefined && (typeof email !== 'string' || email.length > 320))) {
    return res.status(400).json({ error: 'Invalid account fields' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  try {
    const hash = password ? await hashPassword(password) : null;
    db.transaction(() => {
      if (role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
      if (email) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, user.id);
      if (username) db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username.toLowerCase().trim(), user.id);
      if (hash) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
      if (hash || (role && role !== user.role) || (username && username.toLowerCase().trim() !== user.username)) db.prepare('UPDATE users SET auth_version = auth_version + 1 WHERE id = ?').run(user.id);
    })();
    res.json({ ok: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username or email already exists' });
    res.status(500).json({ error: 'Unable to update account' });
  }
});

// DELETE /api/users/:id — cannot delete yourself
app.delete('/api/users/:id', requireAdmin, (req, res) => {
  if (req.params.id === req.user.sub) return res.status(400).json({ error: 'Cannot delete your own account' });
  db.prepare('DELETE FROM user_appearance WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Canon Runs API ───────────────────────────────────────────────

// Helper: attach categories, creators, and issue counts to run rows
function enrichCanonRuns(runs) {
  return runs.map(run => {
    const categories = db.prepare(
      'SELECT category, adaptation_notes FROM canon_run_categories WHERE run_id = ? ORDER BY category'
    ).all(run.id);
    const creators = db.prepare(
      'SELECT person_name, role FROM canon_run_creators WHERE run_id = ? ORDER BY role, person_name'
    ).all(run.id);
    const issueCounts = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN scanned_book_id IS NOT NULL THEN 1 ELSE 0 END) as owned
      FROM canon_run_issues WHERE run_id = ?
    `).get(run.id);
    const coverIssue = db.prepare(
      'SELECT scanned_book_id FROM canon_run_issues WHERE run_id = ? AND scanned_book_id IS NOT NULL ORDER BY sort_order ASC LIMIT 1'
    ).get(run.id);
    const event = run.event_id
      ? db.prepare('SELECT id, name, cover_image FROM events WHERE id = ?').get(run.event_id)
      : null;

    // Award lookup — try title, parent_series, and cv_volume_id match
    let awards = [];
    const titlesToTry = [
      run.title,
      run.parent_series,
      // Strip character prefixes: "Batman: Year One" → "Year One"
      run.title ? run.title.replace(/^[^:]+:\s*/, '') : null,
    ].filter(Boolean);

    const seen = new Set();
    for (const t of titlesToTry) {
      const rows = getSeriesAwards(t, { all: true });
      for (const row of rows) {
        const key = `${row.award}|${row.year}|${row.category}`;
        if (!seen.has(key)) { seen.add(key); awards.push(row); }
      }
    }

    // Also match by cv_volume_id if award_data has one
    if (run.cv_volume_id) {
      const cvRows = db.prepare(
        'SELECT award, year, category, winner, cv_volume_id FROM award_data WHERE cv_volume_id = ? AND winner = 1'
      ).all(run.cv_volume_id);
      for (const row of cvRows) {
        const key = `${row.award}|${row.year}|${row.category}`;
        if (!seen.has(key)) { seen.add(key); awards.push(row); }
      }
    }

    // Only keep winners, sort by year desc
    awards = awards.filter(a => a.winner == 1).sort((a, b) => b.year - a.year);

    // No matched issue of its own: a run linked to a Timeline event borrows the
    // event's first owned issue as its cover.
    let coverBookId = coverIssue?.scanned_book_id || null;
    if (!coverBookId && event) {
      coverBookId = db.prepare(`SELECT scanned_book_id FROM event_issues WHERE event_id = ? AND scanned_book_id IS NOT NULL
        ORDER BY CASE tier WHEN 'essential' THEN 0 WHEN 'recommended' THEN 1 ELSE 2 END, sort_order LIMIT 1`).get(event.id)?.scanned_book_id || null;
    }
    return { ...run, categories, creators, issueCounts, coverBookId, event, awards };
  });
}

// GET /api/canon/runs — list runs (with optional category + status filters)
// category=recommended is a special case — filters by admin_recommended flag
// rather than a canon_run_categories entry.
app.get('/api/canon/runs', requireAuth, (req, res) => {
  try {
    const { category, status } = req.query;
    let sql = 'SELECT DISTINCT cr.* FROM canon_runs cr';
    const params = [];
    if (category === 'recommended') {
      sql += ' WHERE cr.admin_recommended = 1';
      if (status) { sql += ' AND cr.status = ?'; params.push(status); }
      else { sql += " AND cr.status = 'approved'"; }
    } else {
      if (category) {
        sql += ' JOIN canon_run_categories crc ON crc.run_id = cr.id AND crc.category = ?';
        params.push(category);
      }
      sql += ' WHERE 1=1';
      if (status) { sql += ' AND cr.status = ?'; params.push(status); }
      else { sql += " AND cr.status = 'approved'"; }
    }
    sql += ' ORDER BY cr.title ASC';
    const runs = db.prepare(sql).all(...params);
    res.json(enrichCanonRuns(runs));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/canon/runs/shelf — grouped by category for the shelf page
// ─── Page stats — one endpoint serves header stats for many pages ────
// Returns { stats: [{ n, l }, ...] } where n is the value (number or string)
// and l is the label. Caller passes page=collections|canon|events|series|settings.
app.get('/api/stats/page', requireAuth, (req, res) => {
  try {
    const { page, libraryId } = req.query;
    const userId = req.user?.sub || null;
    const libFilter = libraryId ? ' WHERE library_id = ?' : '';
    const libParams = libraryId ? [libraryId] : [];
    const ssLibFilter = libraryId ? ' WHERE ss.library_id = ?' : '';

    const stats = [];
    const libName = libraryId
      ? (db.prepare('SELECT name FROM libraries WHERE id = ?').get(libraryId)?.name || 'Library')
      : 'All Publishers';

    if (page === 'series') {
      const seriesCount = db.prepare(`SELECT COUNT(*) as n FROM scanned_series ${libFilter}`).get(...libParams).n;
      const issuesCount = db.prepare(`SELECT COUNT(*) as n FROM scanned_books sb ${libraryId ? 'JOIN scanned_series ss ON ss.id = sb.series_id WHERE ss.library_id = ?' : ''}`).get(...libParams).n;
      const readSql = libraryId
        ? `SELECT COUNT(*) as n FROM read_progress rp JOIN scanned_books sb ON sb.id = rp.book_id JOIN scanned_series ss ON ss.id = sb.series_id WHERE rp.completed = 1 AND ss.library_id = ?${userId ? ' AND rp.user_id = ?' : ''}`
        : `SELECT COUNT(*) as n FROM read_progress rp WHERE rp.completed = 1${userId ? ' AND rp.user_id = ?' : ''}`;
      const readParams = [...libParams, ...(userId ? [userId] : [])];
      const readCount = db.prepare(readSql).get(...readParams).n;
      stats.push({ n: libName, l: 'Publisher' });
      stats.push({ n: seriesCount, l: 'Series' });
      stats.push({ n: issuesCount, l: 'Issues' });
      stats.push({ n: readCount,   l: 'Read' });
    }
    else if (page === 'collections') {
      const colSql = libraryId
        ? "SELECT COUNT(*) as n FROM collections WHERE library_id = ? OR library_id IS NULL"
        : "SELECT COUNT(*) as n FROM collections";
      const collectionsCount = db.prepare(colSql).get(...libParams).n;
      stats.push({ n: libName, l: 'Publisher' });
      stats.push({ n: collectionsCount, l: 'Collections' });
    }
    else if (page === 'events') {
      const eventsCount = db.prepare(`SELECT COUNT(*) as n FROM events`).get().n;
      // Read events = events where every monitored book is read
      // Simpler: count distinct events that have any read progress
      const readEvents = userId ? db.prepare(`
        SELECT COUNT(DISTINCT eb.event_id) as n
        FROM event_books eb
        JOIN read_progress rp ON rp.book_id = eb.book_id
        WHERE rp.completed = 1 AND rp.user_id = ?
      `).get(userId)?.n || 0 : 0;
      stats.push({ n: libName, l: 'Publisher' });
      stats.push({ n: eventsCount, l: 'Events' });
      stats.push({ n: readEvents,  l: 'Read' });
    }
    else if (page === 'canon') {
      const cats = ['adapted_to_screen', 'award_winning', 'critically_acclaimed'];
      const labels = { adapted_to_screen: 'Adapted', award_winning: 'Award Winners', critically_acclaimed: 'Acclaimed' };
      for (const cat of cats) {
        const n = db.prepare(`
          SELECT COUNT(DISTINCT cr.id) as n FROM canon_runs cr
          JOIN canon_run_categories crc ON crc.run_id = cr.id
          WHERE crc.category = ? AND cr.status = 'approved'
        `).get(cat).n;
        stats.push({ n, l: labels[cat] });
      }
    }
    else if (page === 'settings') {
      const libCount = db.prepare(`SELECT COUNT(*) as n FROM libraries`).get().n;
      const lastScan = db.prepare(`SELECT MAX(last_scanned_at) as t FROM libraries`).get().t;
      const lastScanLabel = lastScan
        ? new Date(lastScan + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : 'Never';
      stats.push({ n: libCount, l: 'Libraries' });
      stats.push({ n: lastScanLabel, l: 'Last Scan' });
    }

    res.json({ stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/canon/runs/shelf', requireAuth, (req, res) => {
  try {
    const categories = ['adapted_to_screen', 'award_winning', 'critically_acclaimed'];
    const shelf = {};
    for (const cat of categories) {
      const runs = db.prepare(`
        SELECT DISTINCT cr.* FROM canon_runs cr
        JOIN canon_run_categories crc ON crc.run_id = cr.id
        WHERE crc.category = ? AND cr.status = 'approved'
        ORDER BY cr.title ASC
      `).all(cat);
      shelf[cat] = enrichCanonRuns(runs);
    }
    // Admin-recommended runs — shown as a dedicated shelf regardless of category
    const recommended = db.prepare(`
      SELECT * FROM canon_runs WHERE admin_recommended = 1 AND status = 'approved' ORDER BY title ASC
    `).all();
    shelf.recommended = enrichCanonRuns(recommended);
    res.json(shelf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/canon/runs/:id — single run with full issue list
app.get('/api/canon/runs/:id', requireAuth, (req, res) => {
  try {
    const run = db.prepare('SELECT * FROM canon_runs WHERE id = ?').get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    const [enriched] = enrichCanonRuns([run]);
    const issues = require('./runReading').getRunIssues(db, req.params.id, req.user?.sub, parseComicInfo);
    const publisher = require('./runPublisher').getRunPublisher(db, run, parseComicInfo);
    res.json({ ...enriched, issues, publisher });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/canon/runs — create a run
app.post('/api/canon/runs', requireAdmin, (req, res) => {
  const { title, parent_series, cv_volume_id, issue_range_hint, description, status, categories, creators } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const info = db.prepare(`
      INSERT INTO canon_runs (title, parent_series, cv_volume_id, issue_range_hint, description, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(title, parent_series || null, cv_volume_id || null, issue_range_hint || null, description || null, status || 'pending');
    const runId = info.lastInsertRowid;
    if (Array.isArray(categories)) {
      for (const { category, adaptation_notes } of categories) {
        if (category) db.prepare('INSERT OR IGNORE INTO canon_run_categories (run_id, category, adaptation_notes) VALUES (?, ?, ?)').run(runId, category, adaptation_notes || null);
      }
    }
    if (Array.isArray(creators)) {
      for (const { person_name, role } of creators) {
        if (person_name) db.prepare('INSERT INTO canon_run_creators (run_id, person_name, role) VALUES (?, ?, ?)').run(runId, person_name, role || 'writer');
      }
    }
    res.json({ success: true, id: runId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/canon/runs/:id — update run metadata + status
app.put('/api/canon/runs/:id', requireAdmin, (req, res) => {
  const { title, parent_series, cv_volume_id, issue_range_hint, description, status, categories, creators } = req.body;
  if (req.body?.event_id && !db.prepare('SELECT 1 FROM events WHERE id = ?').get(String(req.body.event_id))) {
    return res.status(400).json({ error: 'That Timeline event no longer exists' });
  }
  try {
    db.prepare(`
      UPDATE canon_runs SET title=?, parent_series=?, cv_volume_id=?, issue_range_hint=?,
        description=?, status=?, updated_at=datetime('now') WHERE id=?
    `).run(title, parent_series || null, cv_volume_id || null, issue_range_hint || null, description || null, status || 'pending', req.params.id);
    // Linked Timeline event: set, change or clear (null). Only when sent.
    if (Object.prototype.hasOwnProperty.call(req.body, 'event_id')) {
      const eid = req.body.event_id ? String(req.body.event_id) : null;
      db.prepare('UPDATE canon_runs SET event_id = ? WHERE id = ?').run(eid, req.params.id);
    }
    if (Array.isArray(categories)) {
      db.prepare('DELETE FROM canon_run_categories WHERE run_id = ?').run(req.params.id);
      for (const { category, adaptation_notes } of categories) {
        if (category) db.prepare('INSERT OR IGNORE INTO canon_run_categories (run_id, category, adaptation_notes) VALUES (?, ?, ?)').run(req.params.id, category, adaptation_notes || null);
      }
    }
    if (Array.isArray(creators)) {
      db.prepare('DELETE FROM canon_run_creators WHERE run_id = ?').run(req.params.id);
      for (const { person_name, role } of creators) {
        if (person_name) db.prepare('INSERT INTO canon_run_creators (run_id, person_name, role) VALUES (?, ?, ?)').run(req.params.id, person_name, role || 'writer');
      }
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/canon/runs/:id/recommend — toggle admin_recommended on/off
app.patch('/api/canon/runs/:id/recommend', requireAdmin, (req, res) => {
  try {
    const run = db.prepare('SELECT id, admin_recommended FROM canon_runs WHERE id = ?').get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    const newVal = run.admin_recommended ? 0 : 1;
    db.prepare("UPDATE canon_runs SET admin_recommended = ?, updated_at = datetime('now') WHERE id = ?")
      .run(newVal, req.params.id);
    logger.info('canon', `Run ${req.params.id} admin_recommended → ${newVal}`);
    res.json({ success: true, admin_recommended: newVal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/canon/runs/:id
app.delete('/api/canon/runs/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM canon_runs WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/canon/runs/:id/issues/batch — add multiple issues in one transaction
app.post('/api/canon/runs/:id/issues/batch', requireAdmin, (req, res) => {
  const { issues } = req.body || {};
  if (!Array.isArray(issues) || !issues.length) return res.status(400).json({ error: 'issues array required' });
  try {
    const runId = req.params.id;
    let maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM canon_run_issues WHERE run_id = ?').get(runId)?.m || 0;

    const insert = db.prepare(`
      INSERT OR IGNORE INTO canon_run_issues (run_id, cv_issue_id, scanned_book_id, sort_order, series_name, issue_number, volume_year, manually_matched)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // INSERT OR IGNORE needs a unique constraint to work — use cv_issue_id when available,
    // otherwise check manually to avoid duplicate series+issue combos
    const existsByCv   = db.prepare('SELECT 1 FROM canon_run_issues WHERE run_id = ? AND cv_issue_id = ?');
    const existsByNum  = db.prepare('SELECT 1 FROM canon_run_issues WHERE run_id = ? AND series_name = ? AND issue_number = ?');

    let added = 0, skipped = 0;
    const doAll = db.transaction(() => {
      for (const issue of issues) {
        if (!issue.series_name || !issue.issue_number) continue;
        // Resolve CV id from scanned book if not provided
        let cvId = issue.cv_issue_id || null;
        if (issue.scanned_book_id && !cvId) {
          const book = db.prepare('SELECT cv_issue_id FROM scanned_books WHERE id = ?').get(issue.scanned_book_id);
          cvId = book?.cv_issue_id || null;
        }
        // Skip if already in run
        if (cvId && existsByCv.get(runId, cvId)) { skipped++; continue; }
        if (!cvId && existsByNum.get(runId, issue.series_name, issue.issue_number)) { skipped++; continue; }

        const info = insert.run(runId, cvId, issue.scanned_book_id || null, ++maxOrder,
          issue.series_name, issue.issue_number, issue.volume_year || null,
          issue.scanned_book_id ? 1 : 0);
        if (info.changes) newIds.push(Number(info.lastInsertRowid));
        added++;
      }
      runOrder.placeNew(db, Number(runId), newIds);   // in by number, not at the end
    });
    const newIds = [];
    doAll();
    res.json({ success: true, added, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/canon/runs/:id/issues — add an issue to a run
app.post('/api/canon/runs/:id/issues', requireAdmin, (req, res) => {
  const { scanned_book_id, series_name, issue_number, volume_year, cv_issue_id } = req.body;
  if (!series_name || !issue_number) return res.status(400).json({ error: 'series_name and issue_number required' });
  try {
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM canon_run_issues WHERE run_id = ?').get(req.params.id)?.m || 0;
    let resolvedCvId = cv_issue_id || null;
    let resolvedBookId = scanned_book_id || null;
    if (resolvedBookId && !resolvedCvId) {
      const book = db.prepare('SELECT cv_issue_id FROM scanned_books WHERE id = ?').get(resolvedBookId);
      resolvedCvId = book?.cv_issue_id || null;
    }
    const info = db.prepare(`
      INSERT INTO canon_run_issues (run_id, cv_issue_id, scanned_book_id, sort_order, series_name, issue_number, volume_year, manually_matched)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.id, resolvedCvId, resolvedBookId, maxOrder + 1, series_name, issue_number, volume_year || null, resolvedBookId ? 1 : 0);
    runOrder.placeNew(db, Number(req.params.id), [Number(info.lastInsertRowid)]);   // in by number, not at the end
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/canon/runs/:id/issues/:issueId/match — manual match a scanned book to an issue
app.put('/api/canon/runs/:id/issues/:issueId/match', requireAdmin, (req, res) => {
  const { scanned_book_id, syncCv } = req.body;   // syncCv: see the event match route
  try {
    const result = db.prepare(
      'UPDATE canon_run_issues SET scanned_book_id = ?, manually_matched = ? WHERE id = ? AND run_id = ?'
    ).run(scanned_book_id || null, scanned_book_id ? 1 : 0, req.params.issueId, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Issue not found' });
    const cv = syncCv && scanned_book_id ? bookCvId(scanned_book_id) : null;
    if (cv) db.prepare('UPDATE canon_run_issues SET cv_issue_id = ? WHERE id = ? AND run_id = ?').run(String(cv), req.params.issueId, req.params.id);
    res.json({ success: true, cv_issue_id: cv });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/canon/runs/:id/issues/:issueId
app.delete('/api/canon/runs/:id/issues/:issueId', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM canon_run_issues WHERE id = ? AND run_id = ?').run(req.params.issueId, req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Canon: shared CV resolution helpers ─────────────────────────

// Parse the volume start year from an issue range hint.
// "#404-407 (1940 vol)" → 1940
// "#1-13 (1996)"        → 1996
// "One-shot (1988)"     → 1988
// "#16-20 (1991 vol)"   → 1991
function parseYearFromHint(hint) {
  if (!hint) return null;
  // Look for a 4-digit year in parentheses
  const m = hint.match(/\((\d{4})/);
  return m ? parseInt(m[1]) : null;
}

// Parse issue number range from hint.
// Returns { start, end } — both may be null if unparseable.
function parseIssueRange(hint) {
  if (!hint) return { start: null, end: null };
  // Strip year/vol annotations first
  const stripped = hint.replace(/\(\d{4}[^)]*\)/g, '').replace(/\bvol\b/gi, '');
  const nums = stripped.match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
  // Filter out 4-digit numbers that slipped through
  const issueNums = nums.filter(n => n < 2000);
  if (issueNums.length === 0) return { start: null, end: null };
  if (issueNums.length === 1) return { start: issueNums[0], end: issueNums[0] };
  return { start: issueNums[0], end: issueNums[issueNums.length - 1] };
}

// Resolve a single canon run: find CV volume, fetch issues in range, match to library.
// clearExisting: if true, removes non-manually-matched issues before repopulating.
//   Use this when correcting a wrong volume (CV URL override).
//   Leave false for auto-resolve on import (additive, skip if already populated).
// dryRun (editor Rebuild preview, editorTools.js): nothing is written; returns the plan.
// volumeId: use this Comic Vine volume ('' = search again) instead of the stored one.
// The last Auto-resolve result per run since the server started (Top Shelf's Pending review shows it).
const canonResolveResults = new Map();
async function resolveCanonRun(runId, { clearExisting = false, dryRun = false, volumeId } = {}) {
  const run = db.prepare('SELECT * FROM canon_runs WHERE id = ?').get(runId);
  if (!run) return { error: 'Run not found' };

  const CV_API_KEY = getCVKey();
  if (!CV_API_KEY) return { error: 'No CV API key configured' };

  const hintYear  = parseYearFromHint(run.issue_range_hint);
  // Each piece of the note counts ("#1, #3, #5"; "#635-641, #645-650"); start/end
  // (lowest and highest) keep the routing below exactly as before.
  const issueSpec = canonResolve.parseIssueSpec(run.issue_range_hint);
  const rangeStart = issueSpec.start, rangeEnd = issueSpec.end;
  // "(2016 vol)" names the volume's start year: match it within a year, never relaxed.
  const explicitVol = !!issueSpec.volumeYear;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Determine routing
  const hint        = (run.issue_range_hint || '').toLowerCase();
  const isOneShot   = hint.includes('one-shot') || hint.includes('one shot') ||
                      (rangeStart !== null && rangeStart === rangeEnd);
  const isMultiRange = rangeStart !== null && rangeEnd !== null && rangeEnd > rangeStart;
  const hasParentSeries = !!(run.parent_series && run.parent_series.trim() &&
                              run.parent_series.trim().toLowerCase() !== run.title.trim().toLowerCase());

  // Route A: parent series with multi-issue range → skip title search
  const skipTitleSearch = hasParentSeries && isMultiRange;

  try {
    let cvVolumeId     = volumeId !== undefined ? (volumeId ? String(volumeId) : null) : (run.cv_volume_id || null);
    let isLimitedMatch = false;
    let volInfo = null;   // the volume found by a search (for the preview)

    // A library folder of the parent series with that start year already knows
    // its Comic Vine volume (series.json): use it before searching Comic Vine.
    if (!cvVolumeId && hasParentSeries && explicitVol) {
      const libVol = canonResolve.libraryVolume(db, run.parent_series, issueSpec.volumeYear);
      if (libVol) {
        cvVolumeId = libVol;
        volInfo = { source: 'library', name: run.parent_series, start_year: issueSpec.volumeYear };
        if (!dryRun) db.prepare('UPDATE canon_runs SET cv_volume_id = ? WHERE id = ?').run(cvVolumeId, runId);
        logger.info('canon', `resolveCanonRun ${runId}: library folder "${run.parent_series} (${issueSpec.volumeYear})" → CV volume ${cvVolumeId}`);
      }
    }

    if (!cvVolumeId) {
      // ── Title search (routes B and C) ─────────────────────────
      if (!skipTitleSearch) {
        const strippedTitle = (run.title || '')
          .replace(/^(Batman|Superman|Spider-Man|Daredevil|X-Men|Avengers|Wonder Woman|Flash|Green Lantern|Iron Man|Captain America|Thor|Hulk|Wolverine|Black Panther|Aquaman):\s*/i, '')
          .replace(/[^a-z0-9 ]/gi, '').trim();
        const fullTitle = (run.title || '').replace(/[^a-z0-9 ]/gi, '').trim();

        // Search both stripped and full title, combine and deduplicate results
        const titleSearchNames = [...new Set([strippedTitle, fullTitle].filter(s => s.length >= 3))];
        const titleResultMap = new Map();

        for (const searchName of titleSearchNames) {
          await sleep(300);
          const titleData = await cvApiGet('https://comicvine.gamespot.com/api/volumes/', {
            params: {
              api_key: CV_API_KEY, format: 'json',
              filter: `name:${searchName}`,
              field_list: 'id,name,start_year,count_of_issues',
              limit: 10,
            },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 15000,
          });
          for (const v of (titleData.data.results || [])) {
            titleResultMap.set(String(v.id), v);
          }
        }

        const titleResults = [...titleResultMap.values()];
        const normStripped = strippedTitle.toLowerCase();
        const normFull     = fullTitle.toLowerCase();

        // Find all exact name matches, then pick best by issue count
        const exactMatches = titleResults.filter(v => {
          const vNorm = (v.name || '').replace(/[^a-z0-9 ]/gi, '').toLowerCase().trim();
          return vNorm === normStripped || vNorm === normFull;
        });

        // For multi-issue ranges, prefer the volume with the most issues (avoids TPBs).
        // For one-shots, prefer the volume with fewest issues (the original, not a collected run).
        let candidate = null;
        if (exactMatches.length > 0) {
          candidate = isMultiRange
            ? exactMatches.reduce((best, v) => (v.count_of_issues || 0) > (best.count_of_issues || 0) ? v : best)
            : exactMatches.reduce((best, v) => (v.count_of_issues || 0) < (best.count_of_issues || 0) ? v : best);
        }

        if (candidate) {
          const vYear    = candidate.start_year ? parseInt(candidate.start_year) : null;
          const yearOk   = !hintYear || !vYear || Math.abs(vYear - hintYear) <= (explicitVol ? 1 : 10);
          const issCount = candidate.count_of_issues || 0;
          const tpbRejected = isMultiRange && issCount <= 2;

          if (yearOk && !tpbRejected) {
            cvVolumeId     = String(candidate.id);
            isLimitedMatch = true;
            volInfo = { source: 'title', name: candidate.name, start_year: candidate.start_year, count: issCount };
            if (!dryRun) db.prepare('UPDATE canon_runs SET cv_volume_id = ? WHERE id = ?').run(cvVolumeId, runId);
            logger.info('canon', `resolveCanonRun ${runId}: title match "${run.title}" → CV volume ${cvVolumeId} (${candidate.name}, ${candidate.start_year}, ${issCount} issues)`);
          } else if (tpbRejected) {
            logger.info('canon', `resolveCanonRun ${runId}: title match "${candidate.name}" rejected — likely TPB (${issCount} issues, multi-issue range expected)`);
          }
        }
      }

      // ── Parent series search (route A, or fallback from B/C) ───
      if (!cvVolumeId) {
        const seriesName = run.parent_series || run.title;
        if (!seriesName) {
          logger.warn('canon', `resolveCanonRun ${runId}: no series name to search`);
          return { skipped: true, reason: 'no series name', runId };
        }

        // Strip leading character prefixes — but also try full name
        const strippedSeries = seriesName
          .replace(/^(Batman|Superman|Spider-Man|Daredevil|X-Men|Avengers|Wonder Woman|Flash|Green Lantern|Iron Man|Captain America|Thor|Hulk|Wolverine|Black Panther|Aquaman):\s*/i, '')
          .trim();

        // Search both stripped and full name, combine and deduplicate
        const parentSearchNames = [...new Set([strippedSeries, seriesName].filter(s => s.trim().length >= 2))];
        const parentResultMap = new Map();

        for (const name of parentSearchNames) {
          const normSearch = name.replace(/[^a-z0-9 ]/gi, '').trim();
          await sleep(300);
          const volData = await cvApiGet('https://comicvine.gamespot.com/api/volumes/', {
            params: {
              api_key: CV_API_KEY, format: 'json',
              filter: `name:${normSearch}`,
              field_list: 'id,name,start_year,count_of_issues',
              limit: 100,   // was 20: popular names (Wonder Woman) left the right volume out
            },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 15000,
          });
          for (const v of (volData.data.results || [])) {
            parentResultMap.set(String(v.id), v);
          }
        }

        const results = [...parentResultMap.values()];
        if (results.length === 0) {
          logger.info('canon', `resolveCanonRun ${runId}: no CV volumes found for "${seriesName}"`);
          return { skipped: true, reason: 'no volumes found', runId };
        }

        logger.info('canon', `resolveCanonRun ${runId}: parent series search for "${seriesName}" → ${results.length} combined results`);

        const normForScoring = strippedSeries.replace(/[^a-z0-9 ]/gi, '').toLowerCase().trim();

        const normForScoringFull = seriesName.replace(/[^a-z0-9 ]/gi, '').toLowerCase().trim();

        const scoreVolume = (v, strict = true) => {
          const vNorm = (v.name || '').replace(/[^a-z0-9 ]/gi, '').toLowerCase().trim();
          // Check against both stripped and full name — pick the better match
          const matchStripped = vNorm === normForScoring ? 2 : (vNorm.includes(normForScoring) || normForScoring.includes(vNorm) ? 1 : 0);
          const matchFull     = vNorm === normForScoringFull ? 2 : (vNorm.includes(normForScoringFull) || normForScoringFull.includes(vNorm) ? 1 : 0);
          const nameMatch = Math.max(matchStripped, matchFull);
          if (nameMatch === 0) return -Infinity;
          const vYear = v.start_year ? parseInt(v.start_year) : null;
          if (hintYear && vYear) {
            const diff = Math.abs(vYear - hintYear);
            if (explicitVol && diff > 1) return -Infinity;   // "(YYYY vol)": that volume or none
            if (strict && diff > 5) return -Infinity;
            if (!strict && diff > 15) return -Infinity;
            return nameMatch * 100 - diff;
          }
          return nameMatch * 100 + (v.count_of_issues || 0) * 0.01;
        };

        const findBest = (strict) => results.reduce((b, v) => {
          const s = scoreVolume(v, strict);
          return s > scoreVolume(b || { name: '', start_year: null, count_of_issues: 0 }, strict) ? v : b;
        }, null);

        let best = findBest(true);
        if ((!best || scoreVolume(best, true) === -Infinity) && !explicitVol) {
          logger.info('canon', `resolveCanonRun ${runId}: strict year filter found nothing for "${seriesName}" (${hintYear}), relaxing`);
          best = findBest(false);
        }
        if (!best || scoreVolume(best, false) === -Infinity) {
          logger.info('canon', `resolveCanonRun ${runId}: no good volume match for "${seriesName}"`);
          return { skipped: true, reason: 'no matching volume', runId };
        }

        cvVolumeId = String(best.id);
        volInfo = { source: 'series', name: best.name, start_year: best.start_year, count: best.count_of_issues };
        if (!dryRun) db.prepare('UPDATE canon_runs SET cv_volume_id = ? WHERE id = ?').run(cvVolumeId, runId);
        logger.info('canon', `resolveCanonRun ${runId}: series match "${seriesName}" → CV volume ${cvVolumeId} (${best.name}, ${best.start_year})`);
      }
    }

    // ── Fetch all issues for the volume ──────────────────────────
    // If this is a corrective override, wipe non-manual issues first
    if (clearExisting && !dryRun) {
      const cleared = db.prepare(
        'DELETE FROM canon_run_issues WHERE run_id = ? AND manually_matched = 0'
      ).run(runId);
      if (cleared.changes > 0) {
        logger.info('canon', `resolveCanonRun ${runId}: cleared ${cleared.changes} auto-matched issues before re-resolve`);
      }
    }

    await sleep(300);
    let offset = 0, allIssues = [];
    while (true) {
      const r = await cvApiGet('https://comicvine.gamespot.com/api/issues/', {
        params: {
          api_key: CV_API_KEY, format: 'json',
          filter: `volume:${cvVolumeId}`,
          field_list: 'id,issue_number,name,cover_date,volume',
          offset, limit: 100,
        },
        headers: { 'User-Agent': 'Omnibus/1.0' },
        timeout: 15000,
      });
      const batch = r.data.results || [];
      allIssues = allIssues.concat(batch);
      if (allIssues.length >= (r.data.number_of_total_results || 0)) break;
      offset += 100;
      await sleep(500);
    }

    // ── Filter to range ───────────────────────────────────────────
    // Always apply range filter when a numeric multi-issue range is specified.
    // isLimitedMatch only skips filtering for true one-shots (no range) or
    // when the volume IS the complete run (isOneShot). Anthology series like
    // LOTDK still need range filtering even when found via title match.
    let filtered = allIssues;
    if (rangeStart !== null && (!isLimitedMatch || isMultiRange)) {
      // Each piece of the note; ranges take whole numbers (canonResolve.js).
      filtered = allIssues.filter(i => canonResolve.specIncludes(issueSpec, i.issue_number));
    }

    logger.info('canon', `resolveCanonRun ${runId}: ${allIssues.length} total, ${filtered.length} kept, isLimitedMatch=${isLimitedMatch}, route=${skipTitleSearch ? 'A-parent' : isLimitedMatch ? 'B/C-title' : 'B/C-fallback'}`);

    // ── Insert canon_run_issues, match library ────────────────────
    const existing = new Set(
      db.prepare(`SELECT cv_issue_id FROM canon_run_issues WHERE run_id = ? AND cv_issue_id IS NOT NULL${dryRun && clearExisting ? ' AND manually_matched = 1' : ''}`)
        .all(runId).map(r => String(r.cv_issue_id))
    );

    // Rebuild (clearExisting): a hand-matched issue keeps its file, but when the rebuilt list has the same
    // issue number from the (new) volume, the hand-matched row takes that Comic Vine issue instead of a
    // second row being added (user 2026-10-18: Aquaman: The Trench came back with every issue twice).
    const inVolume = new Set(filtered.map(i => String(i.id)));
    const handByNum = new Map();
    if (clearExisting) {
      for (const r of db.prepare('SELECT id, cv_issue_id, issue_number FROM canon_run_issues WHERE run_id = ? AND manually_matched = 1').all(runId)) {
        if (r.cv_issue_id && inVolume.has(String(r.cv_issue_id))) continue;   // already this volume's issue
        const k = IN.normIssueNumber(r.issue_number);
        if (k != null && !handByNum.has(k)) handByNum.set(k, r);
      }
    }

    if (dryRun) {
      const bookOf = db.prepare('SELECT id FROM scanned_books WHERE cv_issue_id = ?');
      let merged = 0;
      const issues = filtered.filter(i => !existing.has(String(i.id))).map(i => {
        const hand = handByNum.get(IN.normIssueNumber(i.issue_number));
        if (hand) merged++;
        return { cv_issue_id: String(i.id), issue_number: i.issue_number || '0', issue_title: i.name || null, cover_date: i.cover_date || null,
          series_name: i.volume?.name || run.parent_series || run.title, book_id: bookOf.get(String(i.id))?.id || null, ...(hand ? { mergesHand: true } : {}) };
      });
      return { dryRun: true, runId, cvVolumeId, volume: volInfo || { source: 'stored', name: allIssues[0]?.volume?.name || null },
        route: skipTitleSearch ? 'parent' : isLimitedMatch ? 'title' : 'fallback', total: allIssues.length, inRange: filtered.length, kept: existing.size - merged, merged, issues };
    }

    const insertIssue = db.prepare(`
      INSERT INTO canon_run_issues (run_id, cv_issue_id, scanned_book_id, sort_order, series_name, issue_number, volume_year, manually_matched)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `);

    let inserted = 0, matched = 0, skipped = 0, mergedHand = 0;
    const newIds = [];
    const mergeHand = db.prepare('UPDATE canon_run_issues SET cv_issue_id = ?, series_name = ?, volume_year = ? WHERE id = ?');
    db.transaction(issues => {
      for (const issue of issues) {
        const cvId = String(issue.id);
        if (existing.has(cvId)) { skipped++; continue; }
        const hand = handByNum.get(IN.normIssueNumber(issue.issue_number));
        if (hand) {   // same number as a hand match: that row takes this issue, keeping its file
          handByNum.delete(IN.normIssueNumber(issue.issue_number));
          mergeHand.run(cvId, issue.volume?.name || run.parent_series || run.title, issue.volume?.start_year ? String(issue.volume.start_year) : (hintYear ? String(hintYear) : null), hand.id);
          mergedHand++; continue;
        }
        const book          = db.prepare('SELECT id FROM scanned_books WHERE cv_issue_id = ?').get(cvId);
        const scannedBookId = book?.id || null;
        if (scannedBookId) matched++;
        const maxOrder   = db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM canon_run_issues WHERE run_id = ?').get(runId)?.m || 0;
        const seriesName = issue.volume?.name || run.parent_series || run.title;
        const volYear    = issue.volume?.start_year ? String(issue.volume.start_year) : (hintYear ? String(hintYear) : null);
        newIds.push(Number(insertIssue.run(runId, cvId, scannedBookId, maxOrder + 1, seriesName, issue.issue_number || '0', volYear).lastInsertRowid));
        inserted++;
      }
      runOrder.placeNew(db, Number(runId), newIds);   // in by number among any hand-matched issues kept
    })(filtered);

    logger.info('canon', `resolveCanonRun ${runId}: done`, { inserted, matched, skipped, mergedHand });
    return { success: true, runId, cvVolumeId, total: allIssues.length, inRange: filtered.length, inserted, matched, skipped, mergedHand };
  } catch (e) {
    logger.error('canon', `resolveCanonRun ${runId} failed`, e.message);
    return { error: e.message, runId };
  }
}

// ─── Canon: CV auto-resolution ────────────────────────────────────
// POST /api/canon/runs/:id/resolve-cv
app.post('/api/canon/runs/:id/resolve-cv', requireAdmin, async (req, res) => {
  const run = db.prepare('SELECT * FROM canon_runs WHERE id = ?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const result = await resolveCanonRun(req.params.id, { clearExisting: true });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// Top Shelf run generation: canonGenerator.js (moved 2026-11-10, server.js split).
// filterRunsByCategory is declared further down, so it is passed as a call.
require('./canonGenerator').registerCanonGenerator({ ai, aiInfo, aiRunStep, app, db, filterRunsByCategory: (...a) => filterRunsByCategory(...a), forGptPrompt, getAnthropicKey, logger, modelCatalog, requireAdmin, setAiJobOutcome });

// ─── Canon: CV URL override — add by volume or issue URL ─────────
// POST /api/canon/runs/:id/cv-url
// Accepts a CV volume URL (4050-XXXXX) or issue URL (4000-XXXXX).
// Volume → triggers full resolve flow for that volume.
// Issue → adds that single issue directly.
app.post('/api/canon/runs/:id/cv-url', requireAdmin, async (req, res) => {
  const { url } = req.body || {};
  if (!url?.trim()) return res.status(400).json({ error: 'url required' });

  const run = db.prepare('SELECT * FROM canon_runs WHERE id = ?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  // Detect volume (4050) vs issue (4000)
  const volumeMatch = url.match(/4050-(\d+)/i);
  const issueMatch  = url.match(/4000-(\d+)/i);

  if (volumeMatch) {
    // Set cv_volume_id and trigger full resolution, clearing any wrong issues first
    const cvVolumeId = volumeMatch[1];
    db.prepare('UPDATE canon_runs SET cv_volume_id = ? WHERE id = ?').run(cvVolumeId, req.params.id);
    const result = await resolveCanonRun(req.params.id, { clearExisting: true });
    if (result.error) return res.status(400).json({ error: result.error });
    return res.json({ type: 'volume', ...result });
  }

  if (issueMatch) {
    // Fetch the single issue from CV and add it
    const cvIssueId = issueMatch[1];
    try {
      const CV_API_KEY = getCVKey();
      const r = await cvApiGet(`https://comicvine.gamespot.com/api/issue/4000-${cvIssueId}/`, {
        params: {
          api_key: CV_API_KEY, format: 'json',
          field_list: 'id,issue_number,name,cover_date,volume',
        },
        headers: { 'User-Agent': 'Omnibus/1.0' },
        timeout: 15000,
      });
      const issue = r.data.results;
      if (!issue?.id) return res.status(404).json({ error: 'Issue not found on Comic Vine' });

      // Check if already added
      const existing = db.prepare('SELECT id FROM canon_run_issues WHERE run_id = ? AND cv_issue_id = ?')
        .get(req.params.id, String(issue.id));
      if (existing) return res.status(409).json({ error: 'This issue is already in the run' });

      // Match to library
      const book = db.prepare('SELECT id FROM scanned_books WHERE cv_issue_id = ?').get(String(issue.id));
      const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM canon_run_issues WHERE run_id = ?')
        .get(req.params.id)?.m || 0;

      const added = db.prepare(`
        INSERT INTO canon_run_issues (run_id, cv_issue_id, scanned_book_id, sort_order, series_name, issue_number, volume_year, manually_matched)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        req.params.id, String(issue.id), book?.id || null, maxOrder + 1,
        issue.volume?.name || run.parent_series || run.title,
        issue.issue_number || '0',
        issue.volume?.start_year ? String(issue.volume.start_year) : null,
      );

      runOrder.placeNew(db, Number(req.params.id), [Number(added.lastInsertRowid)]);   // in by number, not at the end
      logger.info('canon', `CV URL override: added issue ${issue.id} to run ${req.params.id}`, { matched: !!book?.id });
      return res.json({ type: 'issue', success: true, cv_issue_id: String(issue.id), matched: !!book?.id, issue_number: issue.issue_number });
    } catch (e) {
      logger.error('canon', 'CV URL override issue fetch failed', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(400).json({ error: 'Could not parse a CV volume (4050-XXXXX) or issue (4000-XXXXX) ID from the URL' });
});
// ─── Canon: Eisner data import ────────────────────────────────────
// POST /api/canon/eisner-import
// Parses eisner.txt, populates award_data with CV IDs for all series-level
// categories, and tags any matching canon_runs with award_winning.
// Safe to run multiple times — INSERT OR IGNORE prevents duplicates.
app.post('/api/canon/eisner-import', requireAdmin, async (req, res) => {
  // Superseded (2026-10-18): eisner.txt assigns years by position and several are wrong; the verified
  // list in data/comic_awards.json is loaded at startup instead. Kept for reference, not run.
  if (db.prepare("SELECT value FROM settings WHERE key = 'comic_awards_version'").get()) {
    return res.status(409).json({ error: 'Replaced by the verified awards list (backend/data/comic_awards.json), loaded at startup.' });
  }
  try {
    const eisnerPath = path.join(__dirname, 'eisner.txt');
    if (!fs.existsSync(eisnerPath)) return res.status(404).json({ error: 'eisner.txt not found' });

    const text    = fs.readFileSync(eisnerPath, 'utf8');
    const lines   = text.split('\n');

    // ── Parse blocks — each "Category,Winner..." header starts a new year ──
    // 35 blocks covering 1991–2025
    const START_YEAR = 1991;
    const blocks = [];
    let current  = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('Category,Winner')) {
        if (current) blocks.push(current);
        current = { entries: [] };
      } else if (current && trimmed && !trimmed.startsWith('#')) {
        current.entries.push(trimmed);
      }
    }
    if (current) blocks.push(current);

    // Map blocks to years
    blocks.forEach((b, i) => { b.year = START_YEAR + i; });

    // ── Series-level categories to import ─────────────────────────
    const SERIES_CATS = new Set([
      'Best Continuing Series', 'Best Finite Series', 'Best Limited Series',
      'Best Serialized Story', 'Best New Series',
      'Best Graphic Album\u2014New', 'Best Graphic Album\u2014Reprint',
      'Best Graphic Album-New', 'Best Graphic Album-Reprint',
      'Best Humor Publication', 'Best Single Issue', 'Best Single Issue/One-Shot',
    ]);

    // ── Parse CSV line respecting quoted fields ────────────────────
    const parseCSV = (line) => {
      const cols = [];
      let cur = '', inQ = false;
      for (const ch of line) {
        if (ch === '"') { inQ = !inQ; }
        else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
        else { cur += ch; }
      }
      cols.push(cur.trim());
      return cols;
    };

    const insertAward = db.prepare(`
      INSERT OR IGNORE INTO award_data (award, year, category, series_name, publisher, winner, cv_volume_id, cv_issue_id)
      VALUES ('eisner', ?, ?, ?, NULL, ?, ?, ?)
    `);
    const updateCvId = db.prepare(`
      UPDATE award_data SET cv_volume_id = ?, cv_issue_id = ?
      WHERE award = 'eisner' AND year = ? AND category = ? AND series_name = ?
        AND (cv_volume_id IS NULL OR cv_volume_id = '')
    `);
    const insertCat  = db.prepare(`INSERT OR IGNORE INTO canon_run_categories (run_id, category, adaptation_notes) VALUES (?, 'award_winning', NULL)`);

    let awardInserted = 0, awardUpdated = 0, runsTagged = 0;

    const doAll = db.transaction(() => {
      for (const block of blocks) {
        for (const entry of block.entries) {
          const cols = parseCSV(entry);
          if (cols.length < 2) continue;

          const [category, winnerRaw, cvRaw = ''] = cols;
          if (!SERIES_CATS.has(category)) continue;

          // Extract CV IDs from the third column
          const cvStr      = cvRaw.trim();
          const volumeMatch = cvStr.match(/4050-(\d+)/i);
          const issueMatch  = cvStr.match(/4000-(\d+)/i);
          const cvVolumeId  = volumeMatch ? volumeMatch[1] : null;
          const cvIssueId   = issueMatch  ? issueMatch[1]  : null;

          // Extract series name — strip creator credits in parentheses
          // "Sandman (Neil Gaiman & artists, DC)" → "Sandman"
          const seriesName = winnerRaw
            .replace(/\s*\([^)]+\)\s*$/, '')  // strip trailing (...)
            .replace(/^"/, '').replace(/"$/, '') // strip quotes
            .trim();

          if (!seriesName) continue;

          // winner=1 only for rows that don't have losers listed — in eisner.txt
          // every row is a winner (we only list winners, not nominees)
          const isWinner = 1;

          const info = insertAward.run(block.year, category, seriesName, isWinner, cvVolumeId, cvIssueId);
          if (info.changes > 0) {
            awardInserted++;
          } else {
            // Row exists — update CV IDs if missing
            const u = updateCvId.run(cvVolumeId, cvIssueId, block.year, category, seriesName);
            if (u.changes > 0) awardUpdated++;
          }

          // ── Tag matching canon_runs ────────────────────────────
          let matchedRun = null;

          // Match by CV volume ID first (most reliable)
          if (cvVolumeId) {
            matchedRun = db.prepare('SELECT id FROM canon_runs WHERE cv_volume_id = ?').get(cvVolumeId);
          }

          // Fall back to series name match
          if (!matchedRun) {
            const normName = seriesName.toLowerCase().replace(/[^a-z0-9]/g, '');
            const runs = db.prepare('SELECT id, title, parent_series FROM canon_runs').all();
            for (const run of runs) {
              const normTitle  = (run.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              const normParent = (run.parent_series || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              if (normTitle === normName || normParent === normName ||
                  normTitle.includes(normName) || normName.includes(normTitle)) {
                matchedRun = run;
                break;
              }
            }
          }

          if (matchedRun) {
            const r = insertCat.run(matchedRun.id);
            if (r.changes > 0) runsTagged++;
          }
        }
      }
    });

    doAll();

    logger.info('canon', 'Eisner import complete', { awardInserted, awardUpdated, runsTagged });
    res.json({
      success: true,
      award_rows_inserted: awardInserted,
      award_rows_cv_updated: awardUpdated,
      canon_runs_tagged: runsTagged,
      years_covered: `${START_YEAR}–${START_YEAR + blocks.length - 1}`,
      blocks_parsed: blocks.length,
    });
  } catch (e) {
    logger.error('canon', 'Eisner import failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/canon/backfill-award-notes
// For existing award_winning canon runs with no adaptation_notes, looks up
// matching awards in award_data and populates the notes field.
// Safe to run multiple times — only updates rows where notes are currently NULL/empty.
app.post('/api/canon/backfill-award-notes', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT cr.id, cr.title, cr.parent_series, crc.id as cat_id, crc.adaptation_notes
      FROM canon_runs cr
      JOIN canon_run_categories crc ON crc.run_id = cr.id AND crc.category = 'award_winning'
      WHERE (crc.adaptation_notes IS NULL OR crc.adaptation_notes = '')
    `).all();

    let updated = 0;
    const updateNotes = db.prepare('UPDATE canon_run_categories SET adaptation_notes = ? WHERE id = ?');

    for (const run of rows) {
      const awards = getSeriesAwards(run.title);
      const parentAwards = run.parent_series ? getSeriesAwards(run.parent_series) : [];
      const stripped = run.title ? getSeriesAwards(run.title.replace(/^[^:]+:\s*/, '')) : [];

      const seen = new Set();
      const all = [...awards, ...parentAwards, ...stripped].filter(a => {
        if (!a.winner) return false;
        const key = `${a.award}|${a.year}|${a.category}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      }).sort((a, b) => a.year - b.year);

      if (!all.length) continue;

      const notes = all.map(a =>
        `${a.award === 'eisner' ? 'Eisner' : a.award === 'harvey' ? 'Harvey' : a.award} Award — ${a.category} (${a.year})`
      ).join('; ');

      updateNotes.run(notes, run.cat_id);
      updated++;
    }

    res.json({ success: true, checked: rows.length, updated });
  } catch (e) {
    logger.error('canon', 'Award notes backfill failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/canon/dedup
// Scans all canon runs for duplicates by title similarity, merges categories
// from the duplicate into the original (keeping the oldest/approved one),
// then deletes the duplicate. Safe to run multiple times.
app.post('/api/canon/dedup', requireAdmin, (req, res) => {
  try {
    const runs = db.prepare('SELECT id, title, parent_series, status FROM canon_runs ORDER BY id ASC').all();

    const normalise = (s = '') => s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

    const merged = [];
    const deleted = new Set();

    for (let i = 0; i < runs.length; i++) {
      if (deleted.has(runs[i].id)) continue;
      for (let j = i + 1; j < runs.length; j++) {
        if (deleted.has(runs[j].id)) continue;

        const a = normalise(runs[i].title);
        const b = normalise(runs[j].title);

        // Exact normalised title match — definite duplicate
        if (a !== b) continue;

        // Keep the approved one, or the older one if both same status
        const keepId   = (runs[i].status === 'approved' || runs[j].status !== 'approved') ? runs[i].id : runs[j].id;
        const deleteId = keepId === runs[i].id ? runs[j].id : runs[i].id;

        // Merge categories from duplicate into keeper (INSERT OR IGNORE — no overwrites)
        const cats = db.prepare('SELECT category, adaptation_notes FROM canon_run_categories WHERE run_id = ?').all(deleteId);
        for (const cat of cats) {
          db.prepare('INSERT OR IGNORE INTO canon_run_categories (run_id, category, adaptation_notes) VALUES (?, ?, ?)')
            .run(keepId, cat.category, cat.adaptation_notes);
        }

        // Merge creators
        const creators = db.prepare('SELECT person_name, role FROM canon_run_creators WHERE run_id = ?').all(deleteId);
        for (const c of creators) {
          const exists = db.prepare('SELECT 1 FROM canon_run_creators WHERE run_id = ? AND person_name = ? AND role = ?').get(keepId, c.person_name, c.role);
          if (!exists) db.prepare('INSERT INTO canon_run_creators (run_id, person_name, role) VALUES (?, ?, ?)').run(keepId, c.person_name, c.role);
        }

        // Delete the duplicate
        db.prepare('DELETE FROM canon_runs WHERE id = ?').run(deleteId);
        deleted.add(deleteId);
        merged.push({ kept: keepId, deleted: deleteId, title: runs[i].title });
      }
    }

    res.json({ success: true, merged: merged.length, details: merged });
  } catch (e) {
    logger.error('canon', 'Dedup failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/canon/import
// Saves selected AI-generated runs. Handles:
//   - event linking (if matched_event was accepted)
//   - duplicate merging (if duplicate_of exists, adds new categories to existing run)
//   - fresh inserts for new standalone runs
app.post('/api/canon/import', requireAdmin, (req, res) => {
  const { runs } = req.body || {};
  if (!Array.isArray(runs) || runs.length === 0) return res.status(400).json({ error: 'runs array required' });
  try {
    let inserted = 0, merged = 0, eventLinked = 0;
    const newRunIds = []; // track freshly inserted run IDs for auto-resolve

    const insertRun     = db.prepare(`INSERT INTO canon_runs (title, parent_series, issue_range_hint, description, status, event_id) VALUES (?, ?, ?, ?, 'pending', ?)`);
    const insertCat     = db.prepare('INSERT OR IGNORE INTO canon_run_categories (run_id, category, adaptation_notes) VALUES (?, ?, ?)');
    const insertCreator = db.prepare('INSERT INTO canon_run_creators (run_id, person_name, role) VALUES (?, ?, ?)');
    const hasCreator    = db.prepare('SELECT 1 FROM canon_run_creators WHERE run_id = ? AND person_name = ? AND role = ?');

    const importAll = db.transaction((runs) => {
      for (const run of runs) {
        const eventId = run.accepted_event_id || null;
        const dupId   = run.duplicate_of?.id || null;

        if (dupId) {
          if (Array.isArray(run.categories)) {
            for (const cat of run.categories) {
              if (!cat) continue;
              const notes = tidyBadge(cat === 'adapted_to_screen' ? run.adaptation_notes
                          : cat === 'award_winning'     ? run.award_notes
                          : null);   // badge length (canonCategories.tidyNotes)
              insertCat.run(dupId, cat, notes);
            }
          }
          if (eventId) {
            db.prepare('UPDATE canon_runs SET event_id = ? WHERE id = ? AND event_id IS NULL').run(eventId, dupId);
          }
          merged++;
        } else {
          const info = insertRun.run(
            run.title || 'Untitled',
            run.parent_series || null,
            run.issue_range_hint || null,
            run.description || null,
            eventId,
          );
          const runId = info.lastInsertRowid;
          newRunIds.push(runId);
          if (run.categories_checked) db.prepare("UPDATE canon_runs SET categories_checked_at = datetime('now') WHERE id = ?").run(runId);

          if (Array.isArray(run.categories)) {
            for (const cat of run.categories) {
              if (!cat) continue;
              const notes = tidyBadge(cat === 'adapted_to_screen' ? run.adaptation_notes
                          : cat === 'award_winning'     ? run.award_notes
                          : null);   // badge length (canonCategories.tidyNotes)
              insertCat.run(runId, cat, notes);
            }
          }
          if (Array.isArray(run.creators)) {
            for (const c of run.creators) {
              if (c.name && !hasCreator.get(runId, c.name, c.role || 'writer')) {
                insertCreator.run(runId, c.name, c.role || 'writer');
              }
            }
          }
          if (eventId) eventLinked++;
          inserted++;
        }
      }
    });

    importAll(runs);
    logger.info('canon', `Import complete`, { inserted, merged, eventLinked });
    res.json({ success: true, inserted, merged, eventLinked });

    // Fire-and-forget CV resolution for newly inserted runs
    // Runs sequentially with delays to respect CV rate limits
    if (newRunIds.length > 0) {
      setImmediate(async () => {
        logger.info('canon', `Auto-resolve: starting for ${newRunIds.length} new runs`);
        for (const runId of newRunIds) {
          try {
            const result = await resolveCanonRun(runId);
            canonResolveResults.set(String(runId), { at: Date.now(), error: result.error || null, skipped: result.skipped ? (result.reason || 'skipped') : null, inserted: result.inserted ?? null });
            if (result.error) logger.warn('canon', `Auto-resolve failed for run ${runId}`, result.error);
            else logger.info('canon', `Auto-resolve done for run ${runId}`, { inserted: result.inserted, matched: result.matched });
          } catch (e) {
            logger.warn('canon', `Auto-resolve exception for run ${runId}`, e.message);
          }
          // Pause between runs to be kind to the CV API
          await new Promise(r => setTimeout(r, 1000));
        }
        logger.info('canon', `Auto-resolve: all ${newRunIds.length} runs processed`);
      });
    }
  } catch (e) {
    logger.error('canon', 'Import failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── STATIC + CATCH-ALL — MUST BE LAST — NO NEW ROUTES BELOW THIS LINE ───
// Safe to cache those for 1 year — the hash changes when content changes.
// index.html must never be long-cached (it's the SPA entry point, no hash).

// ─── Reading lists (readingLists.js) ──────────────────────────────
// Routes under /api/reading-lists; must be registered before the SPA catch-all.
// ComicInfo index (bookIndex.js): the name, volume and number each book was
// published under. Refreshed in readingLists.reconcile after library scans.
const bookIndex = require('./bookIndex')({ db, logger, IN });
// Top Shelf re-matching after scans (canonMatch.js): exact signals only.
const canonMatch = require('./canonMatch')({ db, logger, IN, bookIndex });
// Missing list issues → Download Manager, or a request to the admin.
const downloadRequests = require('./downloadRequests')({ app, db, requireAuth, requireAdmin, getSetting, logger, IN,
  rowFor: (src, owner, issue) => requestRowFor(src, owner, issue),
  planFor: row => editorAcquirePlan(row, GAPS_VOLUME) });
// Missing annuals on series pages, Manage › Find annuals: seriesAnnuals.js (2026-11-10).
const seriesAnnuals = require('./seriesAnnuals').createSeriesAnnuals({ app, db, requireAuth, requireAdmin, requireDownloadAccess, logger, IN, cvApiGet, getCVKey,
  fillContext, fetchVolumeIssues, withTimeout, canDownload: u => downloadRequests.canDownload(u), mineFor: (...a) => downloadRequests.mineFor(...a),
  autoDiscoverAnnuals, yearlyTag, runRefreshDirectory, scanSeriesComicInfo, startAutoGrab, detectSeriesType });
// Missing issues on Timeline events, Top Shelf runs and series pages use the
// same request service as reading lists (downloadRequests.js).
async function requestRowFor(src, owner, issue) {
  if (src === 'event' || src === 'run') return editorIssueRow(src, owner, issue) || null;
  if (src === 'series') {
    const c = await withTimeout(fillContext(owner, GAPS_VOLUME), 20000);
    if (c.status) return null;
    const g = c.rows.find(r => r.id === String(issue));
    if (!g) return seriesAnnuals.rowFor(owner, issue);   // a missing annual of the series
    return { id: g.id, cv_issue_id: g.id, scanned_book_id: null, scanned_series_id: String(c.scanned.id), series_name: c.meta.name || c.scanned.name,
      issue_number: g.number, volume_year: c.meta.year || c.meta.start_year || c.scanned.year || null };
  }
  return null;
}
// Problem reports from users (problemReports.js); the admin's Reports tab in the Download Manager.
const problemReports = require('./problemReports')({ app, db, requireAuth, requireAdmin, logger });
// ─── Series grouping routes (2026-11-13) ──────────────────────────
const groupingRoute = fn => (req, res) => { try { res.json(fn(req) ?? { ok: true }); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };
app.get('/api/grouping', requireAdmin, groupingRoute(() => seriesGrouping.summary()));
app.post('/api/grouping/run', requireAdmin, groupingRoute(() => seriesGrouping.run('manual')));
app.post('/api/grouping/events/confirm-all', requireAdmin, groupingRoute(() => seriesGrouping.confirmAll()));
app.post('/api/grouping/events/:id', requireAdmin, groupingRoute(req => seriesGrouping.setEvent(req.params.id, {
  homeSeriesId: req.body?.homeSeriesId, initiative: req.body?.initiative, confirm: !!req.body?.confirm })));
// The series page: its own homes and the series on its shelf.
app.get('/api/series/:id/grouping', requireAuth, groupingRoute(req => ({ homes: seriesGrouping.homesOf(req.params.id), members: seriesGrouping.members(req.params.id),
  keepVisible: !!seriesGroupOf(req.params.id)?.keepVisible })));
app.post('/api/series/:id/shelf', requireAdmin, groupingRoute(req => { seriesGrouping.link(req.params.id, String(req.body?.homeId || '')); }));
app.delete('/api/series/:id/shelf/:homeId', requireAdmin, groupingRoute(req => ({ ok: seriesGrouping.unlink(req.params.id, req.params.homeId) })));
app.post('/api/series/:id/keep-visible', requireAdmin, groupingRoute(req => { seriesGrouping.keepVisible(req.params.id, !!req.body?.on); }));
setTimeout(() => { try { seriesGrouping.run('startup'); } catch (e) { logger.warn('grouping', 'Rules failed', e.message); } }, 60000);
cron.schedule('17 * * * *', () => { try { seriesGrouping.run('hourly'); } catch (e) { logger.warn('grouping', 'Rules failed', e.message); } });

const libraryHealth = require('./libraryHealth')({ app, db, requireAdmin, logger,
  seriesLinkMismatches: () => seriesLinkCheck.count(),
  // Bulk duplicate cleanup: retag by filename through the normal retag runtime
  // (Comic Vine background lane) and move extra copies to a holding folder
  // outside the library, which the admin empties when satisfied.
  retag: opts => cvCtx.run({ lane: 'background', caller: 'library-health' }, () => metadataRuntime.retag(opts)),
  withWrite: fn => libraryAccess.run('write', fn),
  holdingRoot: fs.existsSync('/downloads') ? '/downloads/_Removed duplicates' : path.join(path.dirname(DB_PATH), 'removed-duplicates'),
  forgetBook: (bookId, why) => {
    const book = db.prepare('SELECT * FROM scanned_books WHERE id = ?').get(bookId);
    if (!book) return;
    monitoredIssueGone(book, why);
    db.prepare('DELETE FROM read_progress WHERE book_id = ?').run(bookId);
    db.prepare('DELETE FROM scanned_books WHERE id = ?').run(bookId);
    evictThumbCache(bookId);
  },
});
// Shared list editor: Timeline event and Top Shelf run load/save (claude/ADMIN_REORG.md).
require('./curatedEditor')({ app, db, requireAdmin, logger });
require('./editorAdd')({ app, db, requireAuth, cvApiGet, getCVKey, fetchVolumeIssues, IN, logger });   // editor Add window
const editorTools = require('./editorTools')({ app, db, requireAdmin, logger, IN, bookIndex, bookCvId, resolveCanonRun, canonResolveResults });
// Check categories, budget cut 4 (user 2026-10-18): what the app already knows about a run, sent with it
// so the AI does not search for it. Awards from award_data (winners only): a match on the run's own title
// counts as is; a series-level match (parent series or Comic Vine volume) only for award years within the
// run's publication years (+1, awards come the year after). Comic Book Roundup critic score for the
// library series holding the run's issues. Publication years from the owned issues' ComicInfo.
const AWARD_NAME = { eisner: 'Eisner', harvey: 'Harvey', kirby: 'Kirby', hugo: 'Hugo', stoker: 'Bram Stoker' };
const awardNorm = s => String(s || '').toLowerCase().replace(/\s*\(\d{4}\)\s*$/, '').replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
const creatorAwardsAll = db.prepare("SELECT award, year, category, creator, cited_works FROM award_data WHERE kind = 'creator' AND winner = 1 ORDER BY year");
// Creator awards with their cited works normalised, read once (the list only changes at startup).
let creatorAwardCache = null;
const creatorAwardRows = () => creatorAwardCache || (creatorAwardCache = creatorAwardsAll.all().map(a => {
  let works = []; try { works = JSON.parse(a.cited_works || '[]').map(awardNorm); } catch {}
  return { ...a, works };
}));
function categoryHints(run) {
  const out = [];
  const books = db.prepare('SELECT b.series_id, b.comicinfo FROM canon_run_issues i JOIN scanned_books b ON b.id = CAST(i.scanned_book_id AS TEXT) WHERE i.run_id = ?').all(run.id);
  const years = books.map(b => Number((String(b.comicinfo || '').match(/<Year>(\d{4})<\/Year>/) || [])[1])).filter(Boolean);
  const y0 = years.length ? Math.min(...years) : null, y1 = years.length ? Math.max(...years) : null;
  if (y0) out.push(`owned copies dated ${y0 === y1 ? y0 : `${y0}–${y1}`} (a reprint can be later than the original)`);
  const seen = new Set(), wins = [];
  const add = (rows, seriesLevel) => {
    for (const a of rows) {
      if (a.winner != 1) continue;
      if (seriesLevel && (!y0 || a.year < y0 || a.year > y1 + 1)) continue;
      const k = `${a.award}|${a.year}|${a.category}`;
      if (!seen.has(k)) { seen.add(k); wins.push(`${AWARD_NAME[a.award] || a.award}, ${a.category} (${a.year})${seriesLevel ? ' [series]' : ''}`); }
    }
  };
  // A run whose title is its series (a limited series or graphic novel) is the whole work: its awards
  // count at any year (reprint awards come years later). Only a different, longer series (Batman,
  // Daredevil) is series-level and limited to the run's years (fix 2026-10-18: The Long Halloween's
  // 1999 reprint Eisner and The Killing Joke's 1989 awards were filtered out).
  const stripPrefix = t => String(t || '').replace(/^[^:]+:\s*/, '');
  const sameAsSeries = !run.parent_series || [run.parent_series, stripPrefix(run.parent_series)].some(p => [run.title, stripPrefix(run.title)].some(t => awardNorm(p) === awardNorm(t)));
  const titles = [run.title, stripPrefix(run.title), ...(sameAsSeries && run.parent_series ? [run.parent_series] : [])].filter(Boolean);
  for (const t of new Set(titles)) add(getSeriesAwards(t, { all: true }), false);
  if (run.parent_series && !sameAsSeries) add(getSeriesAwards(run.parent_series, { all: true }), true);
  const vol = db.prepare('SELECT cv_volume_id FROM canon_runs WHERE id = ?').get(run.id);
  if (vol && vol.cv_volume_id) add(db.prepare('SELECT award, year, category, winner FROM award_data WHERE cv_volume_id = ? AND (winner = 1 OR source IS NOT NULL)').all(String(vol.cv_volume_id)), true);
  if (wins.length) out.push(`award wins: ${wins.slice(0, 6).join(' · ')}`);
  // Creator awards count when the citation names the run's series and the award year is within the
  // run's publication years +1 (user 2026-10-18).
  // A citation naming the run itself counts at any year; one naming only its longer series counts
  // for award years within the run's years +1.
  {
    const own = new Set([run.title, stripPrefix(run.title), ...(sameAsSeries && run.parent_series ? [run.parent_series, stripPrefix(run.parent_series)] : [])].filter(Boolean).map(awardNorm));
    const series = run.parent_series && !sameAsSeries ? awardNorm(run.parent_series) : null;
    const cr = [];
    for (const a of creatorAwardRows()) {
      const works = a.works;
      const ownHit = works.some(w => own.has(w));
      const seriesHit = series && y0 && a.year >= y0 && a.year <= y1 + 1 && works.includes(series);
      if (ownHit || seriesHit) cr.push(`${AWARD_NAME[a.award] || a.award}, ${a.category} — ${a.creator} (${a.year})`);
    }
    if (cr.length) out.push(`creator awards citing this run: ${cr.slice(0, 3).join(' · ')}`);
  }
  const counts = {};
  for (const b of books) if (b.series_id) counts[b.series_id] = (counts[b.series_id] || 0) + 1;
  const sid = Object.keys(counts).sort((x, y) => counts[y] - counts[x])[0];
  if (sid) {
    const r = db.prepare('SELECT cbr_score, cbr_count FROM series_ratings WHERE series_id = ?').get(sid);
    const ss = db.prepare('SELECT name, year FROM scanned_series WHERE id = ?').get(sid);
    if (r && r.cbr_score && r.cbr_count >= 5) out.push(`Comic Book Roundup critics ${r.cbr_score}/10 from ${r.cbr_count} reviews for the whole ${ss ? `${ss.name}${ss.year ? ` (${ss.year})` : ''}` : ''} series`);
  }
  return out;
}
// Synopsis test (admin only, stores nothing): how well models write one issue's synopsis from the web or the
// pages, and the cost, before building recaps on stored synopses (user 2026-10-18).
require('./synopsisTest')({ app, db, requireAdmin, logger, ai, getPageImage: (...a) => getPageImageForAssistant(...a), modelCatalog });
require('./canonCategories')({ app, db, requireAdmin, logger, ai, setAiJobOutcome, hintsFor: categoryHints });
const { tidyNotes: tidyBadge, filterRunsByCategory } = require('./canonCategories');   // Top Shelf: Check categories (web-checked, reviewed before applying)   // editor Tools: Re-match, Rebuild previews
// Top Shelf run order (runOrder.js): stored order is the reading order.
// One-time: put single-series runs whose stored order was scrambled by
// re-added issues back in number order (user 2026-10-16).
try {
  if (getSetting('run_order_reset_20261016') !== 'done') {
    const changed = db.transaction(() => runOrder.resetNumberOrder(db))();
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('run_order_reset_20261016', 'done');
    logger.info('canon', 'Run order reset to issue-number order', { runs: changed.length, titles: changed.map(r => r.title).slice(0, 50) });
  }
} catch (e) { logger.error('canon', 'Run order reset failed', e.message); }
// One-time (user 2026-10-17): Wonder Woman: The Lies and Year One were
// generated from the 2006 volume (18208). Their issues are now matched to the
// 2016 books; point the runs at the 2016 volume (91774) and each matched
// issue at its comic's Comic Vine id.
try {
  if (getSetting('ww_rebirth_cv_fix_20261017') !== 'done') {
    const fixed = [];
    db.transaction(() => {
      for (const title of ['Wonder Woman: The Lies', 'Wonder Woman: Year One']) {
        const run = db.prepare('SELECT id, cv_volume_id FROM canon_runs WHERE title = ?').get(title);
        if (!run || String(run.cv_volume_id) !== '18208') continue;
        db.prepare("UPDATE canon_runs SET cv_volume_id = '91774', updated_at = datetime('now') WHERE id = ?").run(run.id);
        let n = 0;
        for (const r of db.prepare('SELECT id, scanned_book_id FROM canon_run_issues WHERE run_id = ? AND scanned_book_id IS NOT NULL').all(run.id)) {
          const cv = bookCvId(r.scanned_book_id);
          if (cv) n += db.prepare('UPDATE canon_run_issues SET cv_issue_id = ? WHERE id = ?').run(String(cv), r.id).changes;
        }
        fixed.push(`${title}: ${n} issue ids`);
      }
    })();
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ww_rebirth_cv_fix_20261017', 'done');
    logger.info('canon', 'Wonder Woman Rebirth runs pointed at the 2016 volume', { fixed });
  }
} catch (e) { logger.error('canon', 'Wonder Woman Rebirth id fix failed', e.message); }
// Continue Reading by event / run / list (readingContexts.js, user 2026-10-29). Used by the
// progress save and the home page at request time, so it may be created here.
let readingContexts = null;
let achievements = null;
const readingLists = require('./readingLists')({
  app, db, requireAuth, cvApiGet, getCVKey, logger, IN, bookIndex, acquire: downloadRequests,
  runBackground: (name, fn) => (...a) => cvCtx.run({ lane: 'background', caller: name }, () => fn(...a)),
});
// Export and import of Essentials, Timeline events and Top Shelf runs between installs (2026-11-12).
require('./curatedTransfer').createCuratedTransfer({ app, db, requireAdmin, logger, readingLists,
  reconcileEvents: () => reconcileEventIssues(false), reconcileRuns: () => canonMatch.reconcile(false) });
try { readingContexts = require('./readingContexts').create({ db, readingLists }); }
catch (e) { logger.error('progress', 'Reading contexts unavailable', e.message); }
// Achievements (2026-11-10): reading log, badges, leaderboard, toasts (achievements.js).
try { achievements = require('./achievements').createAchievements({ app, db, requireAuth, logger, orderedBooks: (id, user) => readingLists.orderedBooks(id, user) }); }
catch (e) { logger.error('achievements', 'Achievements unavailable', e.message); }
// Recaps ("Previously on…"): stored issue synopses, story arcs, scope and limits (recaps/; RECAPS_DESIGN.md).
// Web Search (task web_lookup): shared by recap lookups and Comic Book Guy's web_lookup tool.
const webLookup = require('./ai/webLookup').createWebLookup({ ai, modelCatalog, logger });
const recaps = require('./recaps')({ app, db, ai, logger, getPageImage: (...a) => getPageImageForAssistant(...a), modelCatalog, cvApiGet, getCVKey, readingLists, bookIndex, requireAdmin, axios, webLookup });
// Installed synchronously before startup timers or HTTP requests can run.
const metadataRuntime = require('./metadata/retagRuntime').createRetagRuntime({
  db, access: libraryAccess, deploymentGate, stableIds, bookIndex,
  getLibraryRoots: () => db.prepare('SELECT path FROM libraries').all().map(row => row.path),
  scratchParent: path.join(path.dirname(DB_PATH), 'metadata-scratch'),
  logger,
  fetchIssue: fetchCvIssue, saveIssue: saveFreshCvIssue, buildDestFilename, buildMangaDestFilename,
  onManualSuccess: (bookId,outcome) => metadataMaintenance.recordManualSuccess(bookId,outcome),
  // Phase 6.6: per-step timing for every tag, conversion and arrival.
  onTimings: summary => {
    const steps = Object.entries(summary.steps || {}).filter(([, ms]) => ms >= 50).map(([k, ms]) => `${k} ${(ms / 1000).toFixed(1)}s`).join(', ');
    logger.info('metadata-timing', `${summary.kind}${summary.outcome ? ' ' + summary.outcome : ''}: ${(summary.total_ms / 1000).toFixed(1)}s${steps ? ' — ' + steps : ''}`, { file: summary.file, bookId: summary.bookId });
  },
  discoverCandidates: require('./metadata/candidateDiscovery').createCandidateDiscovery({
    apiGet:cvApiGet,getKey:getCVKey,
    readFolder:book=>book.path?readSeriesJson(path.dirname(book.path)):null,
  }),
  // Phase 6.5: annual files (year-named one-shots, crossovers, running numbers).
  // Claude only chooses among real Comic Vine candidates; picks are labelled.
  discoverAnnual: require('./metadata/annualIdentification').createAnnualDiscovery({
    apiGet:cvApiGet,getKey:getCVKey,
    askClaude: async prompt => {
      if (!getAnthropicKey()) return null;
      try {
        const r = await ai.complete({ task: 'annual_match', prompt, maxTokens: 2048, timeout: 60000 });
        // {"issue_id": ...}: an id is a pick, null is "none of these", anything else is unreadable.
        let pickedId; try { const t = r.text, a = t.indexOf('{'), b = t.lastIndexOf('}'); pickedId = JSON.parse(t.slice(a, b + 1)).issue_id; } catch { pickedId = undefined; }
        setAiJobOutcome(r.jobId, pickedId === undefined ? 'bad_json' : pickedId ? 'matched' : 'no_match');
        return r.text;
      } catch (e) { logger.warn('metadata', 'Annual match: Claude request failed', e.response?.data?.error?.message || e.message); return null; }
    },
  }),
  registerArrival: ({connection,operation,prepared,facts}) => {
    const destination=path.normalize(operation.payload.destination),directory=path.dirname(destination);
    const libraries=connection.prepare('SELECT * FROM libraries').all();
    const library=libraries.filter(l=>{const rel=path.relative(l.path,directory);return !rel||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));}).sort((a,b)=>b.path.length-a.path.length)[0];
    if(!library)throw new Error('No library owns the download destination');
    const xml=prepared.validation.comicInfo.xml,ci=parseComicInfo(xml),id=prepared.report.appliedMetadata.cvIssueId;
    const seriesId=stableIds.resolveSeriesId(directory,()=>readSeriesJson(directory));
    const stmts=makeScanStmts();
    const prior=connection.prepare('SELECT id FROM scanned_series WHERE path=?').get(directory);
    if(!prior)stmts.upsertSeries.run(seriesId,library.id,directory,path.basename(directory),null,'none',null,null,0,-1,0);
    const bookId=stableIds.resolveBookId({filePath:destination,seriesId,cvIssueId:id,issueNum:ci.number,fileSize:prepared.validation.fingerprint.size});
    const newBook=!connection.prepare('SELECT 1 FROM scanned_books WHERE id=?').get(bookId);
    stmts.upsertBook.run(bookId,seriesId,destination,path.basename(destination),ci.number||null,ci.title||null,xml,id,null,Number(ci.number)||0,facts.destination.mtimeMs,prepared.validation.fingerprint.size);
    // "Special of …" (user 2026-10-26): a download for a series added as a special is filed as a
    // special (Specials tab, after the regular issues), as the scanner does for new files it routes
    // to a special. Only new books, so an issue unmarked by hand stays unmarked.
    if(newBook&&id&&connection.prepare('SELECT 1 FROM monitored_issues mi JOIN monitored_series ms ON ms.id=mi.series_id WHERE mi.id=? AND (ms.is_special=1 OR ms.parent_series_id IS NOT NULL)').get(String(id)))
      connection.prepare('UPDATE scanned_books SET is_special=1,sort_order=? WHERE id=? AND is_special=0').run(9000+(Number(ci.number)||0),bookId);
    // Arrival status commits with the stable book, not in a later downloader
    // callback that a restart could lose. Existing other-copy links stay put.
    connection.prepare("UPDATE monitored_issues SET status='processed',file_path=?,date_processed=datetime('now'),has_comicinfo=1 WHERE id=? AND (file_path IS NULL OR file_path=?)")
      .run(destination,id,path.normalize(operation.payload.source));
    // Queue success commits with registration, including recovery durability.
    metadataMaintenance.recordSuccess(bookId,prepared.report.appliedMetadata,'download');
    return bookId;
  },
  fetchVolume: async id => {
    const response = await cvApiGet(`https://comicvine.gamespot.com/api/volume/4050-${id}/`, {
      params: {api_key: getCVKey(), format: 'json', field_list: 'id,name,start_year,publisher'}, timeout: 15000,
    });
    return response.data?.results;
  },
  followups: {
    cache_invalidation: async ({bookId}) => {
      // Show the new tag right away: refresh the number/title/sort the series
      // page reads from the saved ComicInfo, instead of waiting for a rescan.
      try {
        const row = db.prepare('SELECT comicinfo, issue_number, sort_order, is_special FROM scanned_books WHERE id = ?').get(bookId);
        if (row?.comicinfo) {
          const ci = parseComicInfo(row.comicinfo), num = ci.number || row.issue_number, n = parseFloat(num);
          const sort = Number.isFinite(n) ? (row.is_special ? 9000 + n : n) : row.sort_order;
          db.prepare('UPDATE scanned_books SET issue_number = ?, title = ?, sort_order = ? WHERE id = ?').run(num, ci.title || null, sort, bookId);
        }
      } catch (e) { logger.warn('retag', 'Could not refresh book row after tagging', { bookId, error: e.message }); }
      invalidateSeriesCache();
      const book = db.prepare('SELECT series_id FROM scanned_books WHERE id = ?').get(bookId);
      if (book) db.prepare('UPDATE scanned_series SET dir_mtime = -1 WHERE id = ?').run(book.series_id);
      const physical=db.prepare('SELECT path,cv_issue_id FROM scanned_books WHERE id=?').get(bookId);
      if(physical?.cv_issue_id){const monitored=db.prepare('SELECT id,status,file_path FROM monitored_issues WHERE id=?').get(physical.cv_issue_id);if(monitored)linkMonitoredByCv(monitored,physical.path);}
      metadataMaintenance.enqueue(bookId,'scanner');
      // Page bytes/order and stable IDs are verified unchanged: offline pages,
      // reading progress and cover images remain valid across this metadata edit.
    },
    // Links (events, Top Shelf runs, reading lists) are re-checked once per batch, not per file: each
    // whole-library re-check took ~3.9 s, 35–50% of every retag and conversion (2026-10-22). The request
    // is saved before this acknowledges, so a crash or restart still runs it (see scheduleLinkReconcile).
    events: async () => scheduleLinkReconcile(),
    canon: async () => {},
    reading_lists: async () => {},
  },
});

// ─── Link re-check after tagging (once per batch) ─────────────────
// Each tagged or converted file asks for it; it runs 5 s after the last request, or at most 60 s
// after the first while a long batch keeps asking. It takes a library read lock, so it waits for the
// file being written and never sees a half-finished one. The request is kept in settings until a run
// that started after it finishes: a restart runs it again.
const LINK_RECHECK = 'link_reconcile_pending';
let linkTimer = null, linkFirstAt = 0, linkRunning = false, linkAgain = false;
function scheduleLinkReconcile() {
  try { db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(LINK_RECHECK, String(Date.now())); } catch {}
  if (linkRunning) { linkAgain = true; return; }
  if (!linkFirstAt) linkFirstAt = Date.now();
  clearTimeout(linkTimer);
  linkTimer = setTimeout(runLinkReconcile, Math.max(0, Math.min(5000, linkFirstAt + 60000 - Date.now())));
}
async function runLinkReconcile() {
  linkTimer = null; linkFirstAt = 0;
  if (linkRunning) { linkAgain = true; return; }
  linkRunning = true;
  const started = Date.now();
  try {
    await libraryAccess.run('read', async () => {
      await reconcileEventIssues(true, { strict: true });
      await canonMatch.reconcile(true, { strict: true });
      await readingLists.reconcile(true, { strict: true });
    });
    const asked = Number(getSetting(LINK_RECHECK) || 0);
    if (asked && asked <= started) db.prepare('DELETE FROM settings WHERE key = ?').run(LINK_RECHECK);
    logger.info('metadata', `Event, Top Shelf and reading-list links re-checked after tagging (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (e) {
    logger.warn('metadata', 'Link re-check after tagging failed; trying again in a minute', { error: e.message, code: e.code });
    setTimeout(scheduleLinkReconcile, 60000);
  } finally {
    linkRunning = false;
    if (linkAgain) { linkAgain = false; scheduleLinkReconcile(); }
  }
}
// A request left over from before a restart.
setTimeout(() => { try { if (getSetting(LINK_RECHECK)) scheduleLinkReconcile(); } catch {} }, 30000);
const metadataDateCacheRead=db.prepare('SELECT cv_data FROM monitored_issues WHERE id=?');
const metadataMaintenance = require('./metadata/maintenance').createMetadataMaintenance({db,runtime:metadataRuntime,logger,
  executionWindow:require('./metadata/maintenanceWindow').maintenanceWindow,
  withTask:({routine},action)=>cvCtx.run({...cvCtx.getStore(),metadataRoutine:routine},action),
  betweenBooks:()=>sleepMs(1000),
  cachedIssue: id => {
    if(!id)return null;
    const memory=cvCache.get(cvCacheKey(`https://comicvine.gamespot.com/api/issue/4000-${id}/`,{format:'json',field_list:CV_ISSUE_FIELDS}))?.response?.data?.results;
    if(memory&&String(memory.id)===String(id))return memory;
    try {const issue=JSON.parse(metadataDateCacheRead.get(String(id))?.cv_data||'null');return issue&&String(issue.id)===String(id)?issue:null;}catch{return null;}
  },
  libraryForBook: book => db.prepare('SELECT library_id FROM scanned_series WHERE id=?').get(book.series_id)?.library_id,
});
const metadataReconciliation = require('./metadata/reconciliation').createMetadataReconciliation({db});
app.get('/api/admin/metadata-status', requireAdmin, (req,res) => {
  try { res.json(metadataMaintenance.status({...req.query,unidentified:req.query.unidentified==='true'})); }
  catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/admin/metadata-books/:id/retry', requireAdmin, async (req,res)=>{
  try{
    const queued=metadataMaintenance.requestCheck(req.params.id);
    const work=cvCtx.run({lane:'background',caller:'library-metadata'},()=>metadataMaintenance.run(1,{bookId:req.params.id}));
    await require('./metadata/respondToCheck').respondToCheck({work,res,queued,logger});
  }catch(e){retagHandlers.errorResponse(res,e);}
});
app.post('/api/admin/metadata-run', requireAdmin, async (req,res) => {
  try {
    const work=cvCtx.run({lane:'background',caller:'library-metadata'},()=>metadataMaintenance.run(25,{force:true}));
    await require('./metadata/respondToCheck').respondToCheck({work,res,logger});
  }catch(e){retagHandlers.errorResponse(res,e);}
});
app.post('/api/admin/metadata-pause', requireAdmin, (req,res)=>{
  if(typeof req.body?.paused!=='boolean')return res.status(400).json({error:'Choose pause or resume.'});
  res.json(metadataMaintenance.setPaused(req.body.paused));
});
app.get('/api/admin/metadata-reconciliation', requireAdmin, (req,res) => {
  try { res.json(metadataReconciliation.report()); } catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/admin/metadata-reconciliation/clear-dangling', requireAdmin, async (req,res) => {
  try { res.json(await libraryAccess.run('write',()=>metadataReconciliation.clearDangling())); }
  catch(e){retagHandlers.errorResponse(res,e);}
});
const runMetadataMaintenance = () => cvCtx.run({lane:'background',caller:'library-metadata'},()=>metadataMaintenance.run()).catch(e=>logger.warn('metadata','Maintenance deferred',e.message));
async function pumpMetadataMaintenance(){
  try{await runMetadataMaintenance();}
  finally{setTimeout(pumpMetadataMaintenance,30000).unref();}
}
setTimeout(()=>metadataMaintenance.seed().catch(e=>logger.warn('metadata','Queue initialization deferred',e.message)).finally(pumpMetadataMaintenance),30000);
// Resume post-processing by hand (Download Manager → Queue, admin only).
// Packs: a failed or stuck pack whose file is still on disk goes back to
// 'downloaded'. Issues: a downloaded issue skips its retry wait. Either way the
// completion watcher is run straight away.
app.post('/api/admin/series-packs/:id/reprocess', requireAdmin, (req, res) => {
  const pack = db.prepare('SELECT id, status, file_path FROM series_packs WHERE id = ?').get(req.params.id);
  if (!pack) return res.status(404).json({ error: 'Pack not found' });
  if (!['failed', 'processing', 'downloaded'].includes(pack.status)) return res.status(409).json({ error: `Pack is '${pack.status}'` });
  if (pack.status === 'processing' && watcherBusy) return res.status(409).json({ error: 'Pack is being processed right now' });
  if (!pack.file_path || !fs.existsSync(pack.file_path)) return res.status(409).json({ error: 'Pack file is missing; download it again', file_path: pack.file_path });
  db.prepare(`UPDATE series_packs SET status = 'downloaded', fail_reason = NULL, retry_after = NULL WHERE id = ?`).run(pack.id);
  logger.info('pack-process', `Pack ${pack.id} queued for reprocessing by ${req.user?.username || 'admin'}`, { file: pack.file_path });
  setImmediate(() => runCompletionWatcher());
  res.json({ ok: true, id: pack.id });
});
app.post('/api/admin/downloads/issues/:id/convert-anyway', requireAdmin, (req, res) => {
  const issue = db.prepare('SELECT id, status, file_path, last_fail_reason FROM monitored_issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });
  if (issue.status !== 'downloaded') return res.status(409).json({ error: `Issue is '${issue.status}', not waiting for post-processing` });
  if (!/^ARCHIVE_DAMAGED/.test(issue.last_fail_reason || '')) return res.status(409).json({ error: 'Convert anyway is only for damaged downloads' });
  if (ddlPostProcessing.has(issue.id)) return res.status(409).json({ error: 'Issue is being processed right now' });
  postProcess.salvage.add(issue.id);
  db.prepare('UPDATE monitored_issues SET retry_after = NULL WHERE id = ?').run(issue.id);
  logger.info('postprocess', `Issue ${issue.id}: convert anyway (keep readable pages) by ${req.user?.username || 'admin'}`);
  setImmediate(() => runCompletionWatcher());
  res.json({ ok: true, id: issue.id });
});
app.post('/api/admin/downloads/issues/:id/resume', requireAdmin, (req, res) => {
  const issue = db.prepare('SELECT id, status, file_path, download_id FROM monitored_issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });
  if (issue.status !== 'downloaded') return res.status(409).json({ error: `Issue is '${issue.status}', not waiting for post-processing` });
  if (ddlPostProcessing.has(issue.id)) return res.status(409).json({ error: 'Issue is being processed right now' });
  if (!issue.file_path || !fs.existsSync(issue.file_path)) return res.status(409).json({ error: 'Downloaded file is missing; reset the issue to wanted', file_path: issue.file_path });
  db.prepare('UPDATE monitored_issues SET retry_after = NULL WHERE id = ?').run(issue.id);
  logger.info('postprocess', `Issue ${issue.id} resumed by ${req.user?.username || 'admin'}`);
  setImmediate(() => runCompletionWatcher());
  res.json({ ok: true, id: issue.id });
});
// View, Process anyway and Delete file for downloads held because the file does not
// match the issue (downloads/heldDownloads.js, 2026-11-09). Calls made when needed:
// postProcess and listArchiveFiles are wrapped further down.
require('./downloads/heldDownloads').registerHeldDownloads({
  app, requireAdmin, db, fs, path, logger, getSetting,
  processAnyway: id => postProcess.force.add(id), isProcessing: id => ddlPostProcessing.has(id),
  runCompletionWatcher: () => runCompletionWatcher(), listArchiveFiles: (...a) => listArchiveFiles(...a),
  filterImages, readArchiveMember, coverThumb,
});
// ─── Automatic recovery of interrupted metadata work ─────────────
// An unfinished operation holds all library writes until it is recovered.
// Recovery itself is the existing fingerprint-checked service: it finishes the
// publication or rolls the book back from its backup. What it needs is proof
// that the worker that started the operation has stopped:
//  - Startup: Omnibus runs as the only process of a single fixed-name container
//    (node is PID 1), so operations left by the previous process have no
//    living worker. Outside a container (PID != 1) that is not proven and those
//    operations still need the admin endpoint.
//  - In-process: operations whose own request already failed are marked stopped
//    by the runtime (canRecoverInThisProcess).
// A rolled-back existing-book retag is queued again so the book starts over.
// Anything recovery refuses (changed bytes, cleanup errors) keeps the hold and
// is logged for review.
const metadataStartupOrphans = new Set(metadataRuntime.status().map(op => op.operationId));
const metadataRecoveryAttempts = new Map();
const METADATA_AUTO_RECOVERY_MAX_ATTEMPTS = 3;
function noteMetadataRestart(bookId) {
  // At most two automatic restarts per book a day, so a book that keeps
  // crashing the app cannot loop forever.
  let map = {};
  try { map = JSON.parse(getSetting('metadata_auto_restarts') || '{}'); } catch {}
  const today = new Date().toISOString().slice(0, 10);
  const rec = map[bookId]?.day === today ? map[bookId] : { day: today, count: 0 };
  if (rec.count >= 2) return false;
  rec.count++; map[bookId] = rec;
  for (const k of Object.keys(map)) if (map[k].day !== today) delete map[k];
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('metadata_auto_restarts', JSON.stringify(map));
  return true;
}
async function autoRecoverMetadataWork(trigger) {
  const containerProcess = process.pid === 1;
  for (const op of metadataRuntime.status()) {
    if (op.active) continue;
    const orphan = metadataStartupOrphans.has(op.operationId) && containerProcess;
    if (!orphan && !op.canRecoverInThisProcess) continue;
    const tries = metadataRecoveryAttempts.get(op.operationId) || 0;
    if (tries >= METADATA_AUTO_RECOVERY_MAX_ATTEMPTS) continue;
    metadataRecoveryAttempts.set(op.operationId, tries + 1);
    try {
      const result = await metadataRuntime.recover({ operationId: op.operationId, previousWorkerStopped: orphan });
      metadataStartupOrphans.delete(op.operationId);
      logger.info('metadata', `Interrupted metadata work recovered automatically (${trigger}): ${result.action || result.status || 'done'}`,
        { operationId: op.operationId, bookId: op.bookId, file: op.source });
      const kind = result.operation?.payload?.context?.kind;
      if (result.action === 'rolled_back' && kind === 'existing_book_reprocess' && op.bookId) {
        if (noteMetadataRestart(op.bookId)) {
          try { metadataMaintenance.requestCheck(op.bookId); logger.info('metadata', 'Book queued to start its metadata update over', { bookId: op.bookId }); }
          catch (e) { logger.warn('metadata', 'Could not queue the book again', { bookId: op.bookId, code: e.code, error: e.message }); }
        } else {
          logger.warn('metadata', 'Book was restarted twice today already; leaving it for the sweeper', { bookId: op.bookId });
        }
      }
    } catch (e) {
      const last = tries + 1 >= METADATA_AUTO_RECOVERY_MAX_ATTEMPTS;
      logger[last ? 'error' : 'warn']('metadata', `Automatic recovery failed${last ? '; needs review at /api/admin/metadata-work' : ', will try again'}`,
        { operationId: op.operationId, bookId: op.bookId, file: op.source, code: e.code, error: e.message });
    }
  }
}
setTimeout(() => {
  if (metadataStartupOrphans.size && process.pid !== 1) {
    logger.warn('metadata', 'Interrupted metadata work found, but Omnibus is not running as a container process; recover it at /api/admin/metadata-work', { count: metadataStartupOrphans.size });
  }
  autoRecoverMetadataWork('startup').catch(e => logger.error('metadata', 'Automatic recovery error', e.message));
  setInterval(() => autoRecoverMetadataWork('in-process').catch(e => logger.error('metadata', 'Automatic recovery error', e.message)), 5 * 60 * 1000);
}, 5000);

app.get('/api/admin/metadata-work', requireAdmin, (req, res) => res.json({unfinished: metadataRuntime.status(),access:libraryAccess.snapshot()}));
app.post('/api/admin/metadata-work/:id/recover', requireAdmin, async (req, res) => {
  try { res.json(await metadataRuntime.recover({operationId: req.params.id, previousWorkerStopped: req.body?.previousWorkerStopped === true})); }
  catch (e) { retagHandlers.errorResponse(res, e); }
});
setTimeout(() => { try { readingLists.resumePending(); } catch (e) { logger.error('reading-lists', 'Resume failed', { error: e.message }); } }, 20000);
// ─── Assistant: Comic Book Guy (assistant.js) ─────────────────────
// Reader mode: one page of a book as a shrunken JPEG for Comic Book Guy
// (about 1,100 x 1,500 at most, ~1.5-2k input tokens). Same extraction as the
// reader's page route, through the thumbnail slot limiter.
async function getPageImageForAssistant(bookId, pageIndex, size) {
  const book = db.prepare('SELECT path FROM scanned_books WHERE id = ?').get(String(bookId));
  if (!book) throw new Error('Book not found');
  const { buffer, ext, count } = await withThumbSlot(async () => {
    const images = filterImages(await listArchiveFiles(book.path));
    if (!images.length) throw new Error('No pages in this file');
    const target = images[Math.max(0, Math.min(pageIndex, images.length - 1))];
    const archExt = path.extname(book.path).toLowerCase();
    const opts = { maxBuffer: 30 * 1024 * 1024, encoding: 'buffer' };
    const stdout = await readArchiveMember(book.path, target, opts.maxBuffer);
    return { buffer: stdout, ext: path.extname(target).toLowerCase(), count: images.length };
  });
  try {
    const sharp = require('sharp');
    const h = Math.max(600, Math.min(1500, Number(size?.height) || 1500));   // smaller pages only for the synopsis test; Comic Book Guy keeps 1100×1500
    const out = await sharp(buffer).resize({ width: Math.round(h * 1100 / 1500), height: h, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    return { data: out.toString('base64'), media_type: 'image/jpeg', count };
  } catch (e) {
    logger.warn('assistant', 'Page resize failed; sending the original', { error: e.message });
    if (buffer.length > 4.5 * 1024 * 1024) throw new Error('Page image too large');
    const media_type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    return { data: buffer.toString('base64'), media_type, count };
  }
}

const assistant = require('./assistant')({
  app, db, express, axios, requireAuth, requireAdmin, getSetting, logger, IN,
  getAnthropicKey, getEventModel, getValidationModel, fetchAllSeries, getSeriesJsonCached, collectionSeriesIds, bookIndex, readingLists,
  modelFor: id => aiRouting.modelFor(id), pick: id => aiRouting.pick(id), aiRequest: (body, opts) => ai.request(body, opts), aiComplete: opts => ai.complete(opts), aiRun: (o, fn) => ai.run(o, fn), webLookup, modelCatalog, getOpenAIKey, setAiJobOutcome,
  getPageImage: (...args) => getPageImageForAssistant(...args),
  dataDir: path.dirname(DB_PATH), recaps,
});

app.post('/api/reading-lists-admin/refresh', requireAdmin, (req, res) => {
  setImmediate(() => cvCtx.run({ lane: 'background', caller: 'reading-list-refresh' }, () => readingLists.refreshAll('manual')));
  res.json({ ok: true, message: 'Reading list refresh started - see server log (reading-lists)' });
});

// ── PWA files — explicit routes before static middleware ──────────
// sw.js MUST be served with no-store so Chrome always checks for updates.
// Service-Worker-Allowed: / grants the SW control over the entire origin.
// These explicit routes prevent the catch-all from intercepting them.
app.get('/sw.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.set('Cache-Control', 'no-store');
  res.set('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, '../frontend/build/sw.js'));
});
app.get('/manifest.json', (req, res) => {
  res.set('Content-Type', 'application/manifest+json');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '../frontend/build/manifest.json'));
});
app.get('/asset-manifest.json', (req, res) => {
  res.set('Content-Type', 'application/json');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '../frontend/build/asset-manifest.json'));
});

app.use('/static', express.static(path.join(__dirname, '../frontend/build/static'), {
  maxAge: '1y', immutable: true
}));
app.use(express.static(path.join(__dirname, '../frontend/build'), {
  maxAge: 0, etag: true
}));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/build/index.html')));


// Long jobs count as background Comic Vine work even when a click starts them
// ("Run now", adding a volume), so they never use the reserve kept for clicks.
{
  const asBackground = (name, fn) => (...a) => cvCtx.run({ lane: 'background', caller: name }, () => fn(...a));
  runUntaggedSweep     = asBackground('untagged-sweep', runUntaggedSweep);
  runSeriesJsonRefresh = asBackground('series-json-refresh', runSeriesJsonRefresh);
}

// Install before the event loop can start startup jobs, timers or requests.
// Keep long network downloads outside the barrier; their publication helpers
// acquire it when they actually access library archives.
const coordinateDownload = fn => async (...args) => {
  try { return await deploymentGate.run(()=>fn(...args)); }
  catch(error){
    if(error.code!=='LIBRARY_RECOVERY_REQUIRED')throw error;
    logger.warn('metadata','Download retained while recovery is pending',error.message);return false;
  }
};
{ const salvage = postProcess.salvage, force = postProcess.force; postProcess = coordinateDownload(postProcess); postProcess.salvage = salvage; postProcess.force = force; }   // keep the Convert anyway / Process anyway sets on the wrapper
postProcessPack = coordinateDownload(postProcessPack);
processMangaTorrents = coordinateDownload(processMangaTorrents);
renameUnknownFolder = libraryAccess.wrap('write', renameUnknownFolder);
runMassJson = libraryAccess.wrap('write', runMassJson);
const createSeriesJsonOriginal=createSeriesJsonIfMissing;
createSeriesJsonIfMissing=(...args)=>deploymentGate.run(()=>createSeriesJsonOriginal(...args));
runLibraryScan = libraryAccess.wrap('read', runLibraryScan);
scanSeriesDir = libraryAccess.wrap('read', scanSeriesDir);
extractComicInfo = libraryAccess.wrap('read', extractComicInfo);
listArchiveFiles = libraryAccess.wrap('read', listArchiveFiles);
streamArchivePage = libraryAccess.wrap('read', streamArchivePage);
withThumbSlot = libraryAccess.wrap('read', withThumbSlot);
extractArchiveImage = libraryAccess.wrap('read', extractArchiveImage);
getPageImageForAssistant = libraryAccess.wrap('read', getPageImageForAssistant);
runRefreshDirectory = libraryAccess.wrap('read', runRefreshDirectory);
scanSeriesComicInfo = libraryAccess.wrap('read', scanSeriesComicInfo);

const httpServer = app.listen(PORT, () => {
  logger.info('startup', `Omnibus running`, { port: PORT, logLevel: process.env.LOG_LEVEL || 'info' });
  logger.info('startup', `Paths`, { comics: COMICS_PATH, db: DB_PATH });

  // ─── Configuration health warnings ───────────────────────────
  if (JWT_SECRET === 'change-me-in-production-use-long-random-string') {
    logger.warn('startup', '⚠️  JWT_SECRET is still the default placeholder — anyone can forge login tokens. Generate a secure value with: openssl rand -hex 32');
  }
  if (!getCVKey()) {
    logger.warn('startup', '⚠️  No ComicVine API key set — metadata enrichment and series sync will not work. Add cv_api_key in Settings → Connections.');
  }
  if (!getAnthropicKey()) {
    logger.warn('startup', '⚠️  No Anthropic API key set — event generation and annual validation will not work. Add anthropic_api_key in Settings → Connections.');
  }
  if (!OIDC_BASE_URL || !OIDC_CLIENT_ID) {
    logger.info('startup', 'SSO not configured — local login only. Set OIDC_BASE_URL, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET in .env to enable SSO.');
  }
});
// Behind the reverse proxy: keep idle connections open longer than the proxy does, so the proxy never
// sends a request on a connection Node is just closing (Node's default is 5 s; that race showed up as
// a 502 on the first click after a few seconds on a page, fixed by a refresh; user 2026-10-18).
httpServer.keepAliveTimeout = 65000;
httpServer.headersTimeout = 66000;
// Comic Book Guy's reading lists can take several model calls of up to 4 min each;
// Node's default 5-minute request cap would cut them off.
httpServer.requestTimeout = 15 * 60 * 1000;

// Stop admitting mutations before Docker replaces this process. Providers and
// converters already owned by a metadata operation are allowed to finish.
const deploymentControl = require('./deployControl').serve(deploymentGate);
let shutdownStarted=false;
async function shutdownForDeployment(signal){
  if(shutdownStarted)return;shutdownStarted=true;
  logger.info('shutdown','Waiting for metadata and library writes to finish',{signal});
  const done=await deploymentGate.drain(120000);
  if(!done){logger.warn('shutdown','Work did not finish before shutdown deadline; recovery journal retained');process.exit(1);}
  deploymentControl?.close();
  httpServer.close(()=>process.exit(0));
  setTimeout(()=>process.exit(0),5000).unref();
}
process.on('SIGTERM',()=>shutdownForDeployment('SIGTERM').catch(e=>{logger.error('shutdown',e.message);process.exit(1);}));
process.on('SIGINT',()=>shutdownForDeployment('SIGINT').catch(e=>{logger.error('shutdown',e.message);process.exit(1);}));
