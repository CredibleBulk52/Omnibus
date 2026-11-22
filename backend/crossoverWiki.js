'use strict';
// ─── Crossover links from the fan wikis (2026-11-22) ────────────────────
// DC Database and Marvel Database (Fandom) issue pages say where a story goes on, free and without AI:
//   DC      Notes: 'This is part two of "Black Circle: Urban Knights". This story continues from
//           {{c|Green Arrow Vol 3 23}}, and continues in {{c|Green Arrow Vol 3 24}}.'  (+ | Event = …)
//   Marvel  | PreviousIssue = (Title) {{cl|Mighty Thor Vol 1 18}}<br>(Story) {{cl|Journey Into Mystery Vol 4 642}}
//           Notes / Synopsis: 'Story continued from {{cl|…}} and continued in {{cl|…}}'
// Pages are read with Fandom's API, 50 to a request. Page names are "<Series> Vol <N> <issue>"; a series'
// volume number is found once by asking for Vol 1–10 of one issue and keeping the page whose date fits.
// Part of the free switch (crossover_code_enabled). Samples: fixtures/wiki-*-sample.json.

const WIKIS = { dc: 'https://dc.fandom.com/api.php', marvel: 'https://marvel.fandom.com/api.php' };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const wikiOf = publisher => (/^dc\b/i.test(publisher || '') ? 'dc' : /^marvel\b/i.test(publisher || '') ? 'marvel' : null);
// "The Amazing Spider-Man (1963)" → "Amazing Spider-Man" (the wikis drop the leading "The").
const wikiName = series => String(series || '').replace(/\s*\([^)]*\)\s*$/, '').replace(/^the\s+/i, '').replace(/\s+:/g, ':').replace(/[#[\]{}|<>]/g, '').trim();
// Other spellings to try when the first finds no volume (wiki test 2026-11-22): DC keeps "The" (The Flash,
// The Brave and the Bold, The Ray), "&" may be "and" (Atom and Hawkman), "/" may be " and ".
function nameVariants(series) {
  const base = wikiName(series);
  const raw = String(series || '').replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+:/g, ':').replace(/[#[\]{}|<>]/g, '').trim();
  const out = new Set([`The ${base}`, /^the\s/i.test(raw) ? raw.replace(/^the\s+/i, 'The ') : null,
    base.replace(/\s*&\s*/g, ' and '), base.replace(/\s*\/\s*/g, ' and '), `The ${base.replace(/\s*&\s*/g, ' and ')}`]);
  out.delete(base); out.delete(null);
  return [...out].filter(n => n && n !== base).slice(0, 4);
}
const pageTitle = (name, vol, issue) => `${name} Vol ${vol} ${String(issue).replace(/^0+(?=\d)/, '')}`;
// "Green Arrow Vol 3 23" → { series, vol, issue }
const parseTitle = t => { const m = /^(.+?) Vol (\d+) ([\w.½-]+)$/.exec(String(t || '').replace(/_/g, ' ').trim()); return m ? { series: m[1], vol: Number(m[2]), issue: m[3] } : null; };

// The template's fields: "| Name = value" up to the next "| Field =" at the start of a line.
function fields(text) {
  const out = {};
  // Keys can hold spaces and hyphens ("Executive Editor", "Editor-in-Chief"; wiki test 2026-11-22).
  const re = /^\|\s*([A-Za-z][\w /-]*?)\s*=([\s\S]*?)(?=^\|\s*[A-Za-z][\w /-]*?\s*=|^\}\}|$(?![\s\S]))/gm;
  let m;
  while ((m = re.exec(text))) out[m[1]] = (out[m[1]] ? `${out[m[1]]}\n` : '') + m[2].trim();
  return out;
}

// The page's date: Marvel's ReleaseDate (on sale) or the cover Month/Year (about two months after sale).
function pageDate(f) {
  const r = Date.parse(f.ReleaseDate || '');
  if (Number.isFinite(r)) return { date: new Date(r).toISOString().slice(0, 10), cover: false };
  const y = Number(f.Year);
  if (!y) return null;
  let mo = Number(f.Month);
  if (!mo) mo = MONTHS.indexOf(String(f.Month || '').trim().toLowerCase()) + 1;
  return { date: `${y}-${String(mo || 6).padStart(2, '0')}-15`, cover: true, monthKnown: !!mo };
}

const LINK = /\{\{\s*cl?\s*\|\s*([^|}]+?)\s*(?:\|[^}]*)?\}\}|\[\[([^|\]]+?)(?:\|[^\]]*)?\]\]/g;
const BEFORE = /(?:continu\w*|concludes?|picks?\s+up|leads?)\s+(from|in|into)\b|\b(follows|following|preceded by|prelude to|leads into)\b/gi;

// The story's issues a page names: [{ dir: 'from' | 'in', series, vol, issue }] plus its Event name.
function parsePage(text) {
  const f = fields(text || '');
  const links = [];
  const add = (dir, title) => {
    const t = parseTitle(title);
    if (t && !links.some(l => l.dir === dir && l.series === t.series && l.issue === t.issue)) links.push({ dir, ...t });
  };
  // Marvel: "(Story) {{cl|…}}" in PreviousIssue / NextIssue.
  for (const [k, dir] of [['PreviousIssue', 'from'], ['NextIssue', 'in']]) {
    const m = /\(Story\)\s*(\{\{[^}]+\}\}|\[\[[^\]]+\]\])/i.exec(f[k] || '');
    if (m) { LINK.lastIndex = 0; const l = LINK.exec(m[1]); if (l) add(dir, l[1] || l[2]); }
  }
  // Notes and synopses: a link counts when "continues from / in", "follows", … comes at most 70 characters
  // before it, with no other link between ("from X, and continues in Y"). "in X and Y" gives both.
  const prose = Object.entries(f).filter(([k]) => /^(Notes|Synopsis\d*)$/.test(k)).map(([, v]) => v).join('\n');
  const marks = [];
  BEFORE.lastIndex = 0;
  let c;
  while ((c = BEFORE.exec(prose))) {
    const dir = c[1] ? (/from/i.test(c[1]) ? 'from' : 'in') : (/follow|preceded/i.test(c[2]) ? 'from' : 'in');
    marks.push({ at: c.index, end: c.index + c[0].length, cue: dir });
  }
  LINK.lastIndex = 0;
  let m;
  while ((m = LINK.exec(prose))) marks.push({ at: m.index, end: m.index + m[0].length, title: m[1] || m[2] });
  marks.sort((x, y) => x.at - y.at);
  let cue = null, carry = null;
  for (const k of marks) {
    if (k.cue) { cue = k; carry = null; continue; }
    if (cue && k.at - cue.end <= 70) { add(cue.cue, k.title); carry = { dir: cue.cue, end: k.end }; cue = null; continue; }
    if (carry && /^[\s,]*(?:and|&|or)?[\s,]*$/i.test(prose.slice(carry.end, k.at))) { add(carry.dir, k.title); carry.end = k.end; continue; }
    cue = null; carry = null;
  }
  // The story: the Event field, else the notes' 'part two of "Black Circle: Urban Knights"' / 'Part II of V in [[The Siege …]]'.
  const named = /\bpart\s+[\w]+(?:\s+of\s+[\w]+)?\s+(?:of|in)\s+(?:the\s+story\s+)?(?:["“]([^"”]{3,80})["”]|\[\[([^|\]]+)(?:\|[^\]]*)?\]\])/i.exec(prose);
  const event = String(f.Event || f.Event1 || (named ? named[1] || named[2] : '') || '').replace(/\[\[([^|\]]+)(?:\|([^\]]*))?\]\]/g, (_, a, b) => b || a).replace(/\s*\(Event\)\s*$/i, '').trim() || null;
  return { links, event, date: pageDate(f), title: f.Title || null };
}

// Does a page's date fit a book's store date? (cover dates run up to ~3 months after sale)
function dateFits(page, storeDate) {
  if (!page?.date || !storeDate) return false;
  const d = (Date.parse(page.date.date) - Date.parse(storeDate)) / 86400000;
  // Marvel's ReleaseDate: within 100 days (older store dates are estimates: Amazing Fantasy #15 is 88 days off).
  return page.date.cover ? d > -75 && d < 150 : Math.abs(d) <= 100;
}

// Each series' wiki volume: one issue as Vol 1–10, five series to a request; the page whose date fits.
// Series not found try other spellings of the name (nameVariants), one series to a request.
// groups: [{ key, name, series, probe: { issue, store_date } }]; left(): requests still allowed.
// → Map(key → { name, vol }) for the series it got to (vol 0: not found).
async function findVolumes(client, wiki, groups, left = () => Infinity) {
  const out = new Map();
  const tryNames = async list => {   // list: [{ g, names }]
    const asks = list.map(({ g, names }) => ({ g, titles: names.flatMap(n => Array.from({ length: 10 }, (_, v) => ({ n, v: v + 1, t: pageTitle(n, v + 1, g.probe.issue) }))) }));
    const got = await client.pages(wiki, asks.flatMap(a => a.titles.map(x => x.t)));
    for (const a of asks) {
      const hit = a.titles.find(x => { const p = got.get(x.t); return p && dateFits(parsePage(p.text), a.g.probe.store_date); });
      out.set(a.g.key, hit ? { name: hit.n, vol: hit.v } : { name: a.g.name, vol: 0 });
    }
  };
  for (let i = 0; i < groups.length && left() > 0; i += 5) await tryNames(groups.slice(i, i + 5).map(g => ({ g, names: [g.name] })));
  for (const g of groups) {
    if (left() <= 0) break;
    if (out.get(g.key)?.vol !== 0) continue;
    const names = nameVariants(g.series || g.name);
    if (!names.length) continue;
    await tryNames([{ g, names }]);
  }
  return out;
}

// ── Fandom API ────────────────────────────────────────────────────────
function createWikiClient({ axios, logger = null, spacingMs = 1100, userAgent = 'Omnibus comic library (self-hosted; crossover links)' }) {
  let last = 0, requests = 0;
  // titles (≤ 50) → Map(requested title → { title, text } | null)
  async function pages(wiki, titles) {
    const wait = last + spacingMs - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
    requests++;
    const r = await axios.get(WIKIS[wiki], { timeout: 30000, headers: { 'User-Agent': userAgent },
      params: { action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', format: 'json', redirects: 1, maxlag: 5, titles: titles.join('|') } });
    // maxlag or another API error: stop the pass (nothing is marked read); the next night goes on.
    if (r.data?.error) throw new Error(`Fandom: ${r.data.error.code || ''} ${r.data.error.info || ''}`.trim());
    const q = r.data?.query || {};
    const alias = new Map();
    for (const n of q.normalized || []) alias.set(n.to, n.from);
    for (const n of q.redirects || []) alias.set(n.to, alias.get(n.from) || n.from);
    const out = new Map(titles.map(t => [t, null]));
    for (const p of Object.values(q.pages || {})) {
      const text = p.revisions?.[0]?.slots?.main?.['*'] ?? p.revisions?.[0]?.['*'];
      if (text == null) continue;
      const asked = titles.includes(p.title) ? p.title : alias.get(p.title) && titles.includes(alias.get(p.title)) ? alias.get(p.title)
        : titles.find(t => t.replace(/_/g, ' ') === p.title) || alias.get(p.title);
      if (asked) out.set(asked, { title: p.title, text });
    }
    return out;
  }
  return { pages, requests: () => requests };
}

module.exports = { WIKIS, wikiOf, wikiName, nameVariants, findVolumes, pageTitle, parseTitle, fields, parsePage, pageDate, dateFits, createWikiClient };
