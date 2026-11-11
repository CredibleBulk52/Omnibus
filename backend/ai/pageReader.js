'use strict';
// ─── Page reader (for OpenAI models) ──────────────────────────────
// Claude reads whole pages with its web_fetch server tool. OpenAI has no
// equivalent, so for GPT the generators get a "read_page" function tool and
// Omnibus fetches the page itself (user 2026-10-18). Claude never uses this.
//
// Safety: http(s) only, no credentials in the URL, ports 80/443 only, and the
// host must resolve to public addresses (no localhost, LAN, link-local or
// cloud metadata addresses), re-checked on every redirect. Text-like content
// only, at most 3 MB downloaded, returned as plain text capped at maxChars.
const dns = require('node:dns');
const net = require('node:net');

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    // Only 192.0.0.0/24 and 192.0.2.0/24 are reserved; the rest of 192.0.x.x is public
    // (WordPress.com sites resolve to 192.0.78.x, user 2026-10-29).
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateAddress(mapped[1]);
  return /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

// allowedDomains: when given, only these sites (and their subdomains) are read.
const hostAllowed = (host, allowedDomains) => !allowedDomains || !allowedDomains.length
  || allowedDomains.some(d => { d = String(d).toLowerCase().replace(/^www\./, ''); const h = host.toLowerCase(); return h === d || h.endsWith(`.${d}`); });

async function checkUrl(raw, lookup, allowedDomains) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('not a valid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http and https pages can be read');
  if (u.username || u.password) throw new Error('URLs with credentials are not read');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('only standard web ports are read');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$/i.test(host) || /\.(local|internal|lan|home)$/i.test(host)) throw new Error('local addresses are not read');
  if (!hostAllowed(host, allowedDomains)) throw new Error('that site is not one of the sites this request may read');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length) throw new Error(`${host} did not resolve to any address`);
  const blocked = addrs.find(a => privateAddress(a.address));
  // Name the address: 0.0.0.0 usually means a DNS blocker (Pi-hole, AdGuard), 198.18.x a VPN's fake-IP DNS.
  if (blocked) throw new Error(`local or private addresses are not read (${host} resolved to ${blocked.address}${/^0\.0\.0\.0$|^::$/.test(blocked.address) ? ', which usually means a DNS blocker on your network' : ''})`);
  return u;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
function htmlToText(html) {
  let t = String(html);
  const title = (t.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  t = t.replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|table|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<t[dh][^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v\r]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return (title ? `${title.replace(/\s+/g, ' ').trim()}\n\n` : '') + t;
}

// Fandom wikis (DC Database, Marvel Database…) refuse plain page downloads (403, lookup comparison
// 2026-10-20) but answer their MediaWiki API: read the page's wikitext there, lightly cleaned.
const FANDOM = /(^|\.)fandom\.com$/i;
function cleanWikitext(t) {
  return String(t || '')
    .replace(/<ref[^>]*\/>/gi, '').replace(/<ref[\s\S]*?<\/ref>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[\[(?:File|Image|Category):[^\]]*\]\]/gi, '')
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1').replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/'{2,}/g, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
async function readFandom(u, { axios, maxChars, lookup, timeout }) {
  const m = u.pathname.match(/^\/wiki\/(.+)$/);
  if (!m) throw new Error('not a wiki page');
  const api = new URL(`https://${u.hostname}/api.php`);
  for (const [k, v] of Object.entries({ action: 'parse', page: decodeURIComponent(m[1]), prop: 'wikitext', format: 'json', formatversion: '2', redirects: '1' })) api.searchParams.set(k, v);
  await checkUrl(api.toString(), lookup);
  const r = await axios.get(api.toString(), { timeout, maxRedirects: 0, maxContentLength: MAX_BYTES, responseType: 'text', transformResponse: x => x, validateStatus: () => true,
    headers: { 'User-Agent': 'Omnibus/1.0 (personal comic library; MediaWiki API)', Accept: 'application/json' } });
  if (r.status >= 400) throw new Error(`the wiki answered ${r.status}`);
  let data; try { data = JSON.parse(r.data); } catch { throw new Error('the wiki did not answer with JSON'); }
  if (data.error) throw new Error(`the wiki: ${data.error.info || data.error.code}`);
  let text = `${data.parse?.title || ''}\n\n${cleanWikitext(data.parse?.wikitext)}`.trim();
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n\n[… page cut at ${maxChars} characters]`;
  return { url: u.toString(), text };
}

// → { url, text } or throws with a short reason the model can read.
async function readPage(url, { axios, maxChars = 60000, lookup = (h, o) => dns.promises.lookup(h, o), timeout = 15000, allowedDomains = null } = {}) {
  let current = String(url);
  const first = await checkUrl(current, lookup, allowedDomains);
  if (FANDOM.test(first.hostname) && /^\/wiki\//.test(first.pathname)) return readFandom(first, { axios, maxChars, lookup, timeout });
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await checkUrl(current, lookup, allowedDomains);
    const r = await axios.get(u.toString(), {
      timeout, maxRedirects: 0, maxContentLength: MAX_BYTES, maxBodyLength: MAX_BYTES, responseType: 'text', transformResponse: x => x,
      validateStatus: () => true, headers: { 'User-Agent': 'Omnibus/1.0 (reading-order lookup)', Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' },
    });
    if (r.status >= 300 && r.status < 400 && r.headers?.location) { current = new URL(r.headers.location, u).toString(); continue; }
    if (r.status >= 400) throw new Error(`the page answered ${r.status}`);
    const type = String(r.headers?.['content-type'] || '');
    if (type && !/text\/|json|xml/i.test(type)) throw new Error(`not a text page (${type.split(';')[0]})`);
    let text = /html|xml/i.test(type) || /^\s*</.test(String(r.data)) ? htmlToText(r.data) : String(r.data || '').trim();
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n\n[… page cut at ${maxChars} characters]`;
    return { url: u.toString(), text };
  }
  throw new Error('too many redirects');
}

module.exports = { readPage, htmlToText, checkUrl, privateAddress, hostAllowed, cleanWikitext };
