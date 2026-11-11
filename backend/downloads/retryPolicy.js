'use strict';
// ─── Download retry rules (moved out of server.js 2026-11-03) ────────────────
// What a failed download means, and what happens next:
//  • rate limit (429) or a host refusing several issues (403s): pause GetComics
//    downloads with an escalating cooldown, put the issue back to wanted;
//  • a deploy pausing library work: back to wanted in a few minutes, nothing blocked;
//  • a temporary error (dropped connection, stall, 5xx, MEGA busy): back to wanted
//    and try again later, up to TRANSIENT_LIMIT times in a row;
//  • anything else: the link is blocked for that issue and the next source is tried.
// Blocks have a kind (user 2026-11-03: few sources, and hosts fix files later):
//    permanent — the link can never work here (unsupported host, folder link);
//    retry     — everything else; released when the failed-issue retry puts the
//                issue back to wanted (every 2 days), so a fixed source gets
//                another chance.
// Title blocking (blocking every link of a release name) was considered and not
// done: with so few sources it would shut out good mirrors of the same file.

const MAX_DOWNLOAD_ATTEMPTS = 6;     // per round: up to 5 NZB sources + 1 GetComics link
const TRANSIENT_LIMIT = 3;
const COOLDOWN_STEPS_MIN = [10, 20, 40, 60];
const DL_STALL_MS = 90 * 1000;

// Hosts that need a browser session (landing page, button, session token).
const MANUAL_ONLY_HOSTS = /\b(?:rootz\.so|vikingfile\.com|cloud\.mail\.ru|terabox(?:app)?\.com|1024tera(?:box)?\.com|terasharelink\.com|teraboxlink\.com|ufile\.io|we\.tl|wetransfer\.com|userscloud\.com|gofile\.io|sendspace\.com|uploadhaven\.com)\b/i;
const TRANSIENT_DL_ERROR = /\baborted\b|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|socket hang up|stalled|ended early|status code 5\d\d|ETOOMANY|too many concurrent/i;
const PERMANENT_REASON = /not supported for auto-download|unsupported host|Folder URLs are pack-only/i;

const isTransientDownloadError = msg => TRANSIENT_DL_ERROR.test(String(msg || ''));
const isRateLimitReason = reason => /\b429\b|too many requests/i.test(String(reason || ''));
const isDeploymentPause = reason => /paused for deployment|DEPLOYMENT_PAUSED/i.test(String(reason || ''));
const blockKind = reason => (PERMANENT_REASON.test(String(reason || '')) ? 'permanent' : 'retry');

// A stream that delivers no data for `ms` is destroyed; its 'error' handler then
// treats it like any dropped connection.
function stallGuard(stream, ms = DL_STALL_MS) {
  let timer = null;
  const stop = () => { clearTimeout(timer); timer = null; };
  const arm = () => {
    stop();
    timer = setTimeout(() => {
      try { stream.destroy(Object.assign(new Error(`Download stalled: no data for ${Math.round(ms / 1000)}s`), { code: 'STALLED' })); } catch {}
    }, ms);
  };
  stream.on('data', arm);
  stream.once('end', stop); stream.once('close', stop); stream.once('error', stop);
  arm();
  return stream;
}

function applySchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS download_blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id TEXT NOT NULL, url TEXT NOT NULL, reason TEXT,
      failed_at TEXT DEFAULT (datetime('now')), UNIQUE(issue_id, url));
    CREATE INDEX IF NOT EXISTS bl_issue ON download_blacklist(issue_id);`);
  try { db.exec("ALTER TABLE download_blacklist ADD COLUMN kind TEXT DEFAULT 'retry'"); } catch {}
}

function createRetryPolicy({ db, logger = null, now = () => Date.now() }) {
  applySchema(db);
  const transientStrikes = new Map();   // issue id → temporary failures in a row
  const host403 = new Map();            // host → Map(issue id → time)
  let cooldownUntil = 0, rateStrikes = 0;

  const toWanted = db.prepare(`UPDATE monitored_issues SET status = 'wanted', download_id = NULL, file_path = NULL,
      retry_after = datetime('now', ?), last_fail_reason = ? WHERE id = ?`);
  const wantedIn = (issueId, minutes, why) => toWanted.run(`+${minutes} minutes`, String(why).slice(0, 500), issueId);

  // One-time cleanup (2026-11-03): blocks recorded before the kinds existed. Classify
  // them, and drop the retry kind so those links get a fresh try.
  function migrate(markerDone, setMarker) {
    if (markerDone) return null;
    const rows = db.prepare('SELECT id, reason FROM download_blacklist').all();
    const setKind = db.prepare('UPDATE download_blacklist SET kind = ? WHERE id = ?');
    const kinds = rows.map(r => [blockKind(r.reason), r.id]);
    const apply = () => { for (const [k, id] of kinds) setKind.run(k, id); };
    if (db.transaction) db.transaction(apply)(); else apply();
    const permanent = kinds.filter(([k]) => k === 'permanent').length;
    const released = db.prepare("DELETE FROM download_blacklist WHERE kind = 'retry'").run().changes;
    setMarker();
    logger?.info?.('retry', `Blocklist cleanup: ${released} block(s) for temporary reasons released, ${permanent} permanent kept`);
    return { released, permanent };
  }

  function deferTransient(issue, reason) {
    const key = String(issue.id), n = (transientStrikes.get(key) || 0) + 1;
    if (n > TRANSIENT_LIMIT) { transientStrikes.delete(key); return false; }
    transientStrikes.set(key, n);
    const wait = 15 * n;
    wantedIn(issue.id, wait, `Temporary download error — retrying in ${wait} min (${reason})`);
    logger?.info?.('retry', `Issue ${issue.id} back to wanted, retry in ${wait} min (temporary error ${n}/${TRANSIENT_LIMIT})`, { reason });
    return true;
  }

  // HTTP 429 means "slow down", not "bad file": cool down 10 → 20 → 40 → 60 min.
  function deferForRateLimit(issue, reason) {
    const t = now();
    if (t >= cooldownUntil) {
      const minutes = COOLDOWN_STEPS_MIN[Math.min(rateStrikes, COOLDOWN_STEPS_MIN.length - 1)];
      rateStrikes++;
      cooldownUntil = t + minutes * 60000;
      logger?.warn?.('retry', `Download host rate limit — pausing GetComics downloads for ${minutes} min (strike ${rateStrikes})`, { reason });
    }
    const wait = Math.max(1, Math.ceil((cooldownUntil - t) / 60000));
    wantedIn(issue.id, wait, `Rate limited by download host — retrying in ${wait} min (${reason})`);
    logger?.info?.('retry', `Issue ${issue.id} back to wanted, retry in ${wait} min (rate limit)`);
  }

  // A deploy or restore paused library work: nothing is wrong with the file.
  function deferPaused(issue, reason) {
    wantedIn(issue.id, 10, `Paused while Omnibus was updating — retrying in 10 min (${reason})`);
    logger?.info?.('retry', `Issue ${issue.id} back to wanted after a pause for deployment`);
  }

  // A file host that refuses several different issues with 403 within 10 minutes
  // is refusing us, not those files (2026-10-24: fs2.comicfiles.ru).
  function hostRefusing(issue, failedUrl, reason) {
    if (!/\b403\b/.test(String(reason || '')) || !failedUrl) return null;
    let host = null;
    try { host = new URL(failedUrl).host; } catch { return null; }
    if (!host || /getcomics\.org$/i.test(host)) return null;
    const t = now(), seen = host403.get(host) || new Map();
    for (const [id, at] of seen) if (t - at > 10 * 60000) seen.delete(id);
    seen.set(String(issue.id), t); host403.set(host, seen);
    if (seen.size < 3) return null;
    const n = db.prepare("DELETE FROM download_blacklist WHERE url LIKE ? AND reason LIKE '%403%' AND failed_at >= datetime('now', '-1 day')").run(`%://${host}/%`).changes;
    if (n) logger?.info?.('retry', `Cleared ${n} recent 403 blocklist entr${n === 1 ? 'y' : 'ies'} for ${host}`);
    return host;
  }

  // First step of every failure. 'deferred' = handled, nothing blocked; 'block' =
  // the caller records the block (record()) and tries the next source.
  function triage(issue, failedUrl, reason) {
    if (isDeploymentPause(reason)) { deferPaused(issue, reason); return 'deferred'; }
    if (isRateLimitReason(reason)) { deferForRateLimit(issue, reason); return 'deferred'; }
    const refusing = hostRefusing(issue, failedUrl, reason);
    if (refusing) { deferForRateLimit(issue, `${refusing} is refusing downloads (403 for several issues)`); return 'deferred'; }
    if (/^DDL download error:/.test(String(reason || '')) && isTransientDownloadError(reason) && deferTransient(issue, reason)) return 'deferred';
    return 'block';
  }

  function record(issueId, url, reason) {
    if (!url) return null;
    const kind = blockKind(reason);
    db.prepare('INSERT OR IGNORE INTO download_blacklist (issue_id, url, reason, kind) VALUES (?, ?, ?, ?)').run(String(issueId), url, reason || null, kind);
    return kind;
  }
  const blocked = issueId => new Set(db.prepare('SELECT url FROM download_blacklist WHERE issue_id = ?').all(String(issueId)).map(r => r.url));
  // Attempts in this round: since the last failed-issue retry (retry_epoch), else all.
  function attempts(issueId, epoch) {
    return epoch
      ? db.prepare('SELECT COUNT(*) AS n FROM download_blacklist WHERE issue_id = ? AND failed_at >= ?').get(String(issueId), epoch).n
      : db.prepare('SELECT COUNT(*) AS n FROM download_blacklist WHERE issue_id = ?').get(String(issueId)).n;
  }
  // The failed-issue retry: release the retry-kind blocks of the failed issues it requeues.
  function releaseForFailedRetry(maxRetries = 1e9) {
    return db.prepare(`DELETE FROM download_blacklist WHERE kind = 'retry'
      AND issue_id IN (SELECT id FROM monitored_issues WHERE status = 'failed' AND COALESCE(weekly_retries, 0) < ?)`).run(maxRetries).changes;
  }
  function noteSuccess(issueId) { rateStrikes = 0; transientStrikes.delete(String(issueId)); }

  return {
    migrate, triage, record, blocked, attempts, releaseForFailedRetry, noteSuccess,
    deferTransient, deferForRateLimit, deferPaused, hostRefusing,
    cooldownActive: () => now() < cooldownUntil,
    cooldown: () => ({ until: cooldownUntil > now() ? new Date(cooldownUntil).toISOString() : null, strikes: rateStrikes }),
  };
}

module.exports = {
  createRetryPolicy, applySchema, blockKind, stallGuard, isTransientDownloadError, isRateLimitReason, isDeploymentPause,
  MANUAL_ONLY_HOSTS, TRANSIENT_DL_ERROR, MAX_DOWNLOAD_ATTEMPTS, TRANSIENT_LIMIT, DL_STALL_MS, COOLDOWN_STEPS_MIN,
};
