'use strict';
// ─── Metron (metron.cloud) reading lists ──────────────────────────
// The event generator's starting list (2026-10-21, claude/EVENT_GENERATOR_V3.md): Metron keeps
// League of Comic Geeks' event lists with exact issues, roles (Core / Tie-In / Prologue /
// Epilogue), on-sale dates and Comic Vine IDs. Lists can be generous (long lead-in runs,
// sketchbooks) or incomplete, and their order is that site's own, so the AI still applies the
// rules; Omnibus uses the Comic Vine IDs and dates directly when matching.
//
// Courtesy to Metron's maintainer (he asked us in Feb 2026): every address ends in "/" before its
// query, paging follows the API's own "next" links, requests are spaced (Metron allows 20 a
// minute; we stay well under), Metron's limit headers and Retry-After are obeyed (see below), and
// results are cached for a day.
const BASE = 'https://metron.cloud/api/';
const SHORT_WAIT_MS = 65 * 1000;   // longest refusal waited out in place (the per-minute window)
const LIMITS_TABLE = `CREATE TABLE IF NOT EXISTS metron_limits (id INTEGER PRIMARY KEY CHECK (id = 1),
  burst_remaining INTEGER, burst_reset INTEGER, sustained_remaining INTEGER, sustained_reset INTEGER,
  blocked_until INTEGER NOT NULL DEFAULT 0, reason TEXT, updated_at INTEGER)`;
const header = (headers, name) => {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') { const v = headers.get(name); if (v != null) return v; }
  const key = Object.keys(headers).find(k => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
};
// X-RateLimit-{Burst,Sustained}-{Remaining,Reset} → { burst_remaining, burst_reset (ms), … }; absent headers are left out.
function parseLimitHeaders(headers) {
  const out = {};
  for (const scope of ['burst', 'sustained']) {
    const rem = parseInt(header(headers, `x-ratelimit-${scope}-remaining`), 10);
    const reset = parseInt(header(headers, `x-ratelimit-${scope}-reset`), 10);
    if (Number.isFinite(rem)) out[`${scope}_remaining`] = rem;
    if (Number.isFinite(reset)) out[`${scope}_reset`] = reset * 1000;
  }
  return out;
}
const SPACING_MS = 3500;
const CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_PAGES = 12;
const USER_AGENT = 'Omnibus/1.0 (personal comic library app; event reading orders)';

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'reading', 'order', 'event']);
const norm = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, ' ')
  .split(' ').filter(w => w && !STOP.has(w)).join(' ');
// Forms of an event name to match: the name, the part before a colon, and for a two-part name
// ("House of X / Powers of X", "Avengers vs. X-Men") the parts joined with "and", so a list or page
// titled "House of X and Powers of X" still matches. searchForms adds each part on its own, for
// searching only: "Avengers" alone would match far too much (2026-10-22).
const nameParts = name => String(name || '').split(/\s*\/\s*|\s*&\s*|\s+(?:vs\.?|versus)\s+/i).map(x => x.trim()).filter(Boolean);
const nameForms = name => {
  const s = String(name || ''), parts = nameParts(s);
  return [...new Set([s, s.split(':')[0], ...(parts.length > 1 ? [parts.join(' and ')] : [])].map(x => String(x).trim()).filter(x => norm(x).length >= 2))];
};
const searchForms = name => { const parts = nameParts(name); return [...new Set([...nameForms(name), ...(parts.length > 1 ? parts : [])].filter(x => norm(x).length >= 2))]; };
const normNum = n => { const s = String(n ?? '').trim().replace(/^#/, ''); return /^\d+(\.\d+)?$/.test(s) ? String(parseFloat(s)) : s.toLowerCase(); };
// The key Omnibus uses to find a Metron issue again from the AI's reply: series name and number.
const issueKey = (series, number) => `${norm(series)}|${normNum(number)}`;

const { metronStatusOf: seriesStatusOf } = require('./seriesStatus');

function createMetron({ axios, getToken, db, logger, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now() }) {
  let last = 0;
  let scheme = 'Bearer';   // Metron's client sends a Bearer token; "Token" is tried once if refused
  if (db) db.exec(`CREATE TABLE IF NOT EXISTS metron_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS metron_pace (id INTEGER PRIMARY KEY CHECK (id = 1), last INTEGER NOT NULL);
    ${LIMITS_TABLE}`);
  // One pace for every Metron caller (2026-11-13): this process and the enricher (enricher.py
  // MetronClient) reserve their request time in metron_pace, so together they stay under the limit.
  const takeSlot = () => {
    let shared = 0;
    if (db) { try { shared = db.prepare('SELECT last FROM metron_pace WHERE id = 1').get()?.last || 0; } catch {} }
    const at = Math.max(now(), last + SPACING_MS, shared + SPACING_MS);
    last = at;
    if (db) { try { db.prepare('INSERT INTO metron_pace (id, last) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last = excluded.last').run(at); } catch {} }
    return at - now();
  };
  const cacheGet = key => {
    if (!db) return null;
    const r = db.prepare('SELECT value, at FROM metron_cache WHERE key = ?').get(key);
    if (!r || now() - r.at > CACHE_MS) return null;
    try { return JSON.parse(r.value); } catch { return null; }
  };
  const cachePut = (key, value) => { if (db) db.prepare('INSERT OR REPLACE INTO metron_cache (key, value, at) VALUES (?, ?, ?)').run(key, JSON.stringify(value), now()); };

  // ─── Metron's rate limits (2026-11-20, after Metron's warning about 164 refused requests) ───
  // Metron counts every request against a burst limit (20 a minute) and a sustained limit (5,000 a
  // day, more for donors), reports both in X-RateLimit-{Burst,Sustained}-{Limit,Remaining,Reset}
  // (Reset = Unix seconds) and answers 429 with Retry-After (seconds) when either is exceeded
  // (metron.cloud/wiki/api/handling-rate-limits). The latest counts and any block are kept in
  // metron_limits, shared with enricher.py and scripts/store_dates.py, so no caller sends a request
  // Metron would refuse: a block or a used-up daily count stops all of them until the reset.
  let warnedUntil = 0;
  const readLimits = () => {
    if (!db) return memLimits;
    try { return db.prepare('SELECT * FROM metron_limits WHERE id = 1').get() || {}; } catch { return {}; }
  };
  let memLimits = {};
  const writeLimits = patch => {
    const next = { ...readLimits(), ...patch, id: 1, updated_at: now() };
    if (!db) { memLimits = next; return; }
    try {
      db.prepare(`INSERT INTO metron_limits (id, burst_remaining, burst_reset, sustained_remaining, sustained_reset, blocked_until, reason, updated_at)
        VALUES (1, @burst_remaining, @burst_reset, @sustained_remaining, @sustained_reset, @blocked_until, @reason, @updated_at)
        ON CONFLICT(id) DO UPDATE SET burst_remaining = excluded.burst_remaining, burst_reset = excluded.burst_reset,
          sustained_remaining = excluded.sustained_remaining, sustained_reset = excluded.sustained_reset,
          blocked_until = excluded.blocked_until, reason = excluded.reason, updated_at = excluded.updated_at`)
        .run({ burst_remaining: null, burst_reset: null, sustained_remaining: null, sustained_reset: null, blocked_until: 0, reason: null, ...next });
    } catch {}
  };
  function noteLimits(headers) {
    const counts = parseLimitHeaders(headers);
    if (Object.keys(counts).length) writeLimits(counts);
  }
  function refusedFor(headers) {
    const ra = parseInt(header(headers, 'retry-after'), 10);
    if (Number.isFinite(ra) && ra >= 0) return Math.max(1000, ra * 1000);
    const c = parseLimitHeaders(headers);
    const resets = [['sustained', c.sustained_remaining, c.sustained_reset], ['burst', c.burst_remaining, c.burst_reset]]
      .filter(([, rem, reset]) => rem === 0 && reset > now()).map(([, , reset]) => reset - now());
    return resets.length ? Math.max(...resets) : 60 * 60 * 1000;   // no guidance: an hour
  }
  function block(ms, headers) {
    const until = now() + ms;
    const c = parseLimitHeaders(headers);
    const scope = c.sustained_remaining === 0 ? 'daily' : c.burst_remaining === 0 ? 'per-minute' : 'rate';
    writeLimits({ blocked_until: Math.max(until, readLimits().blocked_until || 0), reason: `Metron ${scope} limit` });
    if (ms > SHORT_WAIT_MS && until > warnedUntil) {
      warnedUntil = until;
      logger?.warn?.('metron', `Metron's ${scope} limit reached; no Metron requests until ${new Date(until).toISOString()}`);
    }
  }
  function limitedError() {
    const until = readLimits().blocked_until || 0;
    return Object.assign(new Error(`Metron's request limit is used up until ${new Date(until).toISOString()}`), { code: 'METRON_LIMITED', until });
  }
  // Before a request: nothing while blocked or while the daily count is used up; a used-up minute is waited out.
  async function respectLimits() {
    const l = readLimits(), t = now();
    if ((l.blocked_until || 0) > t + SHORT_WAIT_MS) throw limitedError();
    if (l.sustained_remaining === 0 && (l.sustained_reset || 0) > t) {
      writeLimits({ blocked_until: l.sustained_reset, reason: 'Metron daily limit' });
      throw limitedError();
    }
    let wait = Math.max((l.blocked_until || 0) - t, 0);
    if (l.burst_remaining === 0 && (l.burst_reset || 0) > t) wait = Math.max(wait, l.burst_reset - t);
    if (wait > 0) await sleep(Math.min(wait, SHORT_WAIT_MS) + 250);
  }
  // The latest counts and block, for status pages and callers that want to skip Metron early.
  const limits = () => readLimits();

  // url: a path under /api/ ("reading_list/") or a "next" link from Metron itself.
  async function get(url, params) {
    const token = getToken();
    if (!token) throw Object.assign(new Error('No Metron API token set (Settings → Connections)'), { code: 'METRON_TOKEN_MISSING' });
    let full = /^https:\/\//.test(url) ? url : BASE + String(url).replace(/^\/+/, '');
    const u = new URL(full);
    if (!u.href.startsWith(BASE)) throw new Error(`not a Metron API address: ${u.href}`);
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    for (const [k, v] of Object.entries(params || {})) if (v != null) u.searchParams.set(k, String(v));
    let refusedOnce = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      await respectLimits();
      const wait = takeSlot();
      if (wait > 0) await sleep(wait);
      const r = await axios.get(u.href, { timeout: 20000, validateStatus: () => true,
        headers: { Authorization: `${scheme} ${token}`, Accept: 'application/json', 'User-Agent': USER_AGENT } });
      noteLimits(r.headers);
      if (r.status === 401 && scheme === 'Bearer' && attempt === 0) { scheme = 'Token'; continue; }
      if (r.status === 429) {
        // Metron's rule: wait exactly Retry-After. A short wait (the per-minute limit) is waited out
        // and the request tried once more; a long one (the daily limit) blocks every Metron caller
        // until it passes, with no retry.
        const ms = refusedFor(r.headers);
        block(ms, r.headers);
        if (ms <= SHORT_WAIT_MS && !refusedOnce) { refusedOnce = true; await sleep(ms); continue; }
        throw limitedError();
      }
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Metron refused the API token'), { code: 'METRON_AUTH' });
      if (r.status >= 400) throw new Error(`Metron answered ${r.status}`);
      return r.data;
    }
    throw new Error('Metron did not answer');
  }

  async function test() {
    const d = await get('reading_list/', { name: 'DC K.O.' });
    return { ok: true, lists: d && typeof d.count === 'number' ? d.count : null };
  }

  async function items(listId) {
    const key = `items:${listId}`;
    const cached = cacheGet(key);
    if (cached) return cached;
    const all = [];
    let next = `reading_list/${listId}/items/`, pages = 0;
    while (next && pages < MAX_PAGES) {
      const d = await get(next);
      pages++;
      for (const x of (d && d.results) || []) {
        const i = x.issue || {};
        all.push({ order: x.order, issue_type: x.issue_type || null, series: i.series?.name || '', volume_year: i.series?.year_began || null,
          number: String(i.number ?? ''), store_date: i.store_date || null, cover_date: i.cover_date || null, cv_id: i.cv_id || null });
      }
      next = d && d.next ? d.next : null;
    }
    all.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    cachePut(key, all);
    return all;
  }

  async function search(name) {
    const key = `search:${norm(name)}`;
    const cached = cacheGet(key);
    if (cached) return cached;
    const out = [];
    let next = 'reading_list/', params = { name }, pages = 0;
    while (next && pages < 3) {
      const d = await get(next, params);
      pages++; params = null;
      for (const l of (d && d.results) || []) out.push({ id: l.id, name: l.name, list_type: l.list_type, attribution_source: l.attribution_source || null,
        owner: l.user?.username || null, is_private: !!l.is_private });
      next = d && d.next ? d.next : null;
    }
    cachePut(key, out);
    return out;
  }

  // The event's list: Event type, public, its name the event's name (or its short form, or, failing
  // that, containing it), most issues from within two years of the event's year when it is known;
  // Metron's own lists before users' lists. At most three candidates' items are read.
  async function findEventList(name, year) {
    const yr = parseInt(year, 10) || null;
    const found = new Map();
    for (const form of searchForms(name)) for (const l of await search(form)) found.set(l.id, l);
    const forms = nameForms(name).map(norm);
    const cands = [...found.values()].filter(l => /event/i.test(l.list_type || '') && !l.is_private).map(l => {
      const n = norm(l.name);
      // A longer name counts ("Marvel Super Heroes Secret Wars"), but not a sequel ("Secret Wars II", "Civil War 2").
      const sequel = f => n.replace(f, ' ').split(' ').some(w => /^(ii|iii|iv|v|vi|[2-9]|part|returns|reborn)$/.test(w));
      const exact = forms.includes(n) ? 2 : forms.some(f => ` ${n} `.includes(` ${f} `) && !sequel(f)) ? 1 : 0;
      return { ...l, score: exact * 10 + (l.owner === 'Metron' ? 3 : 0) + (l.attribution_source ? 1 : 0) };
    }).filter(l => l.score >= 10).sort((a, b) => b.score - a.score).slice(0, 3);
    const tried = [];
    for (const c of cands) {
      const list = await items(c.id);
      const years = list.map(x => parseInt(String(x.store_date || x.cover_date || '').slice(0, 4), 10)).filter(Boolean).sort((a, b) => a - b);
      const mid = years.length ? years[Math.floor(years.length / 2)] : null;
      if (!list.length) { tried.push({ id: c.id, name: c.name, why: 'empty' }); continue; }
      if (yr && mid && Math.abs(mid - yr) > 2) { tried.push({ id: c.id, name: c.name, why: `issues are from ${mid}` }); continue; }
      return { list: { id: c.id, name: c.name, attribution_source: c.attribution_source, owner: c.owner, url: `https://metron.cloud/api/reading_list/${c.id}/` }, items: list, tried };
    }
    return { list: null, items: [], tried };
  }

  // A series' status by its Comic Vine volume ID (2026-10-28): the weekly series-status check's
  // second opinion (seriesStatus.js). Tries the series Omnibus found last time, then Metron's
  // cv_id filter, then a name + start-year search; every match is confirmed on the series' own
  // record (its cv_id must equal ours). Returns { id, status, raw, issueCount, yearEnd } or null.
  // Cached for a day like everything else here.
  async function seriesStatus(cvId, { name, year, knownId } = {}) {
    const key = `series-status:${cvId}`;
    const cached = cacheGet(key);
    // An answer cached before series types were kept (2026-11-14) has no seriesType: ask again.
    if (cached && (!cached.found || 'seriesType' in cached.found)) return cached.found || null;
    const confirm = async id => { const d = await get(`series/${id}/`); return d && String(d.cv_id) === String(cvId) ? d : null; };
    let d = knownId ? await confirm(knownId) : null;
    if (!d) {
      const r = await get('series/', { cv_id: cvId });
      for (const x of ((r && r.results) || []).slice(0, 2)) { d = await confirm(x.id); if (d) break; }
    }
    if (!d && name) {
      const r = await get('series/', { name, year_began: year || null });
      for (const x of ((r && r.results) || []).slice(0, 3)) { d = await confirm(x.id); if (d) break; }
    }
    const raw = d ? String((d.status && typeof d.status === 'object' ? d.status.name : d.status) || '') : '';
    // seriesType: Metron's own kind of series ("Ongoing Series", "Limited Series", "One-Shot", …), used by
    // the Shelf Sorter to tell an ongoing cut short from a planned mini (2026-11-14).
    const type = d && d.series_type ? String((typeof d.series_type === 'object' ? d.series_type.name : d.series_type) || '') : '';
    const found = d ? { id: d.id, status: seriesStatusOf(raw), raw, issueCount: Number(d.issue_count) || 0, yearEnd: d.year_end || null, seriesType: type || null } : null;
    cachePut(key, { found });
    return found;
  }

  // One issue's store date by its Comic Vine issue ID (2026-11-19, store dates in ComicInfo): the
  // metadata writer's second source when Comic Vine has no store date. Only an unambiguous answer
  // counts (exactly one Metron issue for the ID). Returns 'YYYY-MM-DD' or null; cached for a day,
  // misses too, like everything else here.
  async function storeDateOfCvIssue(cvIssueId) {
    const id = String(cvIssueId || '').trim();
    if (!/^\d+$/.test(id)) return null;
    const key = `store-date:${id}`;
    const cached = cacheGet(key);
    if (cached) return cached.date || null;
    const r = await get('issue/', { cv_id: id });
    const rows = (r && Array.isArray(r.results)) ? r.results : [];
    const one = rows.length === 1 && (r.count == null || Number(r.count) === 1) ? rows[0] : null;
    const value = one && typeof one.store_date === 'string' ? one.store_date.slice(0, 10) : '';
    const stamp = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + 'T00:00:00Z') : null;
    const valid = !!stamp && Number.isFinite(stamp.getTime()) && stamp.toISOString().slice(0, 10) === value;
    cachePut(key, { date: valid ? value : null });
    return valid ? value : null;
  }

  return { test, search, items, findEventList, get, seriesStatus, storeDateOfCvIssue, limits };
}

// The prompt block: the list as a compact table, and how to use it.
function metronPrompt(found) {
  if (!found || !found.list || !found.items.length) return '';
  const rows = found.items.map(x => `${x.order} | ${x.series} (${x.volume_year || '?'}) #${x.number} | ${x.store_date || (x.cover_date ? `cover ${String(x.cover_date).slice(0, 7)}` : '?')} | ${x.issue_type || '-'}`);
  const src = found.list.attribution_source === 'LOCG' ? "League of Comic Geeks' list" : found.list.attribution_source ? `${found.list.attribution_source}'s list` : `a list by Metron user ${found.list.owner}`;
  return `\n\nMETRON LIST FOR THIS EVENT (${src}, via Metron; source code MET, already counted in "sources_read"):
order | issue (volume began) | on sale | role
${rows.join('\n')}
How to use it: it is your starting list of candidates. Its issues are real and correctly numbered: use these series names, numbers and volume years. Its dates are on-sale dates ("cover 1998-11" where only the cover month is known). Its roles are that site's labels, not tiers: "Core Issue" is usually the main series, and "Tie-In" covers every other issue whatever its importance; "Epilogue" there counts for aftermath only on an issue released after the finale (see the aftermath rule). Its order is that site's own; build the reading order by the Order rules. Lists can be generous (long lead-in runs, sketchbooks, What If? stories) or incomplete (lead-ins or tie-ins missing): decide every issue by What belongs, and add issues the guide page lists for the event.
With this list, one guide page is usually enough: read the guide page below for editorial judgement (what matters, what is skippable, lead-ins); search once more only if a need is still unmet.`;
}

module.exports = { parseLimitHeaders, LIMITS_TABLE, createMetron, metronPrompt, issueKey, norm, nameForms, searchForms };
