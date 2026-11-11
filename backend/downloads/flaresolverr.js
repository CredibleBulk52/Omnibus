'use strict';
// ─── FlareSolverr client (moved out of server.js 2026-11-03) ─────────────────
// getcomics.org (and League of Comic Geeks) sit behind Cloudflare.
//  • Sessions (2026-11-03): one FlareSolverr browser session per domain, kept for
//    30 minutes (session_ttl_minutes), and every page fetched through it. A fresh
//    solve took 19–28 s for each GetComics page, because Cloudflare no longer
//    accepts the clearance cookies when a plain HTTP client presents them (it
//    checks the client too). In the session the browser keeps its clearance, so
//    pages after the first take a few seconds. Requests in one session go one at a
//    time. If FlareSolverr cannot make sessions, a one-off solve is used.
//  • The cookies and User-Agent of each answer are still kept per domain (`cache`):
//    downloadSecurity.cachedDownloadHeaders and the LOCG code read them, and a
//    plain request with them is tried first, since it costs nothing when it works.
//  • A cached-cookie answer that is Cloudflare's challenge page counts as expired.

const CLEARANCE_MS = 30 * 60 * 1000;
const SESSION_TTL_MIN = 30;
// The challenge page's own title. Not its scripts: normal pages can carry Cloudflare's challenge-platform script too.
const CHALLENGE = /<title>\s*(?:Just a moment\.\.\.|Attention Required! \| Cloudflare)/i;
const looksChallenged = body => typeof body === 'string' && CHALLENGE.test(body.slice(0, 8000));
const cookieHeader = c => (c.cookies || []).map(k => `${k.name}=${k.value}`).join('; ');
// When FlareSolverr's time runs out mid-load it returns what the browser had: the
// head and an empty body (2026-11-03: GetComics search after 58.6 s, 2,288 bytes,
// results missing). That is an unfinished page, not an empty one.
const unfinished = body => typeof body === 'string' && /<body[^>]*>\s*<\/body>/i.test(body);
// Cloudflare's own error page for a site whose server failed (520–530), e.g.
// "getcomics.org | 520: Web server is returning an unknown error" (2026-11-03).
// FlareSolverr reports such a page as a success, so it is checked here.
function cloudflareError(body) {
  if (typeof body !== 'string') return null;
  const m = body.slice(0, 4000).match(/<title>[^<]*?\b(5[2-3]\d):\s*([^<|]+)<\/title>/i);
  return m ? { code: Number(m[1]), text: m[2].trim() } : null;
}

// Sessions are off unless asked for (FLARESOLVERR_SESSIONS=1): on 2026-11-03 FlareSolverr
// slowed down through the evening (GetComics 2 s → 90 s and a 500) and a session keeps
// one more Chrome open, so one-off solves, as before, are the default.
function createFlareSolverr({ url, axios, logger = null, now = () => Date.now(), category = 'getcomics', useSessions = false }) {
  const cache = new Map();       // domain → { cookies, userAgent, expiry }
  const queues = new Map();      // domain → tail of the request chain (one at a time per session)
  const sessions = new Map();    // domain → session id once created; false = sessions unavailable
  let solves = 0;

  async function withCookies(target, domain) {
    const c = cache.get(domain);
    if (!c || c.expiry <= now()) return null;
    try {
      const r = await axios.get(target, { headers: { 'User-Agent': c.userAgent, Cookie: cookieHeader(c) }, timeout: 15000 });
      if (r.status === 200 && !looksChallenged(r.data)) { logger?.debug?.(category, 'Used cached FlareSolverr cookies', { url: target }); return { body: r.data }; }
    } catch {}
    cache.delete(domain);
    return null;
  }

  const post = (body, timeoutMs) => axios.post(`${url}/v1`, body, { timeout: timeoutMs + 5000 });
  async function ensureSession(domain, timeoutMs) {
    if (sessions.has(domain)) return sessions.get(domain);
    const id = `omnibus-${domain}`;
    try {
      const r = await post({ cmd: 'sessions.create', session: id }, Math.min(timeoutMs, 30000));
      const ok = r.data?.status === 'ok' || /already exists/i.test(r.data?.message || '');
      sessions.set(domain, ok ? id : false);
      if (!ok) logger?.warn?.(category, 'FlareSolverr sessions unavailable; using one-off solves', { message: r.data?.message });
    } catch (e) {
      const msg = e.response?.data?.message || e.message;
      if (/already exists/i.test(msg)) sessions.set(domain, id);
      else { sessions.set(domain, false); logger?.warn?.(category, 'FlareSolverr sessions unavailable; using one-off solves', { message: msg }); }
    }
    return sessions.get(domain);
  }

  async function solve(target, timeoutMs, domain, { oneOff = false } = {}) {
    solves++;
    const session = oneOff || !useSessions ? false : await ensureSession(domain, timeoutMs);
    const started = now();
    // disableMedia: skip images, fonts and stylesheets — only the HTML is used, and waiting for
    // a page's ads and images kept FlareSolverr on GetComics pages for 60–90 s (2026-11-03).
    const body = { cmd: 'request.get', url: target, maxTimeout: timeoutMs, disableMedia: true, ...(session ? { session, session_ttl_minutes: SESSION_TTL_MIN } : {}) };
    let fs;
    try { fs = await post(body, timeoutMs); }
    catch (e) {
      const msg = e.response?.data?.message || '';
      if (session && /session.*(not exist|not found)/i.test(msg)) { sessions.delete(domain); return solve(target, timeoutMs, domain); }   // FlareSolverr restarted
      // FlareSolverr answers errors as HTTP 500 with its reason in the body; say the reason.
      if (msg) throw new Error(`FlareSolverr: ${String(msg).replace(/^Error:\s*/i, '').slice(0, 160)}`);
      if (e.code === 'ECONNABORTED') throw new Error(`FlareSolverr did not answer within ${Math.round((timeoutMs + 5000) / 1000)} s`);
      if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') throw new Error(`FlareSolverr is not reachable (${e.code})`);
      throw e;
    }
    const solution = fs.data?.solution;
    if (!solution || solution.status !== 200) {
      if (session && /session.*(not exist|not found)/i.test(fs.data?.message || '')) { sessions.delete(domain); return solve(target, timeoutMs, domain); }
      throw new Error(`FlareSolverr: ${String(fs.data?.message || 'unknown error').replace(/^Error:\s*/i, '').slice(0, 160)}`);
    }
    cache.set(domain, { cookies: solution.cookies || [], userAgent: solution.userAgent, expiry: now() + CLEARANCE_MS });
    logger?.info?.(category, `FlareSolverr ${session ? 'session' : 'solve'} answered in ${((now() - started) / 1000).toFixed(1)} s`, { url: target });
    return solution.response;
  }

  // The page body for `target`. Requests for one domain run one at a time. An
  // unfinished page is fetched once more with 30 s more; still unfinished is an error.
  function fetchPage(target, timeoutMs = 90000) {
    const domain = new URL(target).hostname;
    const run = async () => {
      const hit = await withCookies(target, domain);
      if (hit && !unfinished(hit.body)) return hit.body;
      logger?.info?.(category, 'Requesting FlareSolverr page', { url: target });
      let body = await solve(target, timeoutMs, domain);
      const cf = cloudflareError(body);
      if (cf) throw new Error(`${domain} is having trouble: Cloudflare ${cf.code} (${cf.text}). Try again later.`);
      if (!unfinished(body)) return body;
      // Once more with 30 s more, as a one-off solve: if the session browser is the slow part, this avoids it.
      logger?.warn?.(category, 'Page did not finish loading; trying once more (one-off solve, more time)', { url: target });
      body = await solve(target, timeoutMs + 30000, domain, { oneOff: true });
      if (!unfinished(body)) return body;
      throw new Error(`${domain} page didn't finish loading (site slow)`);
    };
    const prev = queues.get(domain) || Promise.resolve();
    const p = prev.catch(() => {}).then(run);
    queues.set(domain, p);
    p.finally(() => { if (queues.get(domain) === p) queues.delete(domain); }).catch(() => {});
    return p;
  }

  return { fetchPage, cache, stats: () => ({ solves, domains: [...cache.keys()], sessions: Object.fromEntries(sessions) }) };
}

module.exports = { createFlareSolverr, looksChallenged, unfinished, cloudflareError, CLEARANCE_MS };
