#!/usr/bin/env node
'use strict';
// Fan wiki test (2026-11-22). Read-only: nothing is written to the database. About 50 requests to Fandom.
// Question: across many DC and Marvel series (eras, ongoings, minis, one-shots, annuals), does Omnibus find
// the wiki volume, read the issue pages, and turn their "continues from / in" notes into the right links?
//   node /app/scripts/crossover_wiki_test.js            160 series, up to 5 issues each
//   options: --series 160 --issues 5 --seed 3 --out /logs
const fs = require('node:fs');
const path = require('node:path');

function args(argv) {
  const a = { series: 160, issues: 5, seed: 3, out: '/logs' };
  for (let i = 2; i < argv.length; i++) { const k = argv[i].replace(/^--/, ''); if (k in a) { a[k] = k === 'out' ? argv[i + 1] : Number(argv[i + 1]); i++; } }
  return a;
}
const rng = seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const shuffle = (list, r) => list.map(x => [r(), x]).sort((a, b) => a[0] - b[0]).map(x => x[1]);

async function run(opts, { db, axios, C, T, W, log }) {
  const r = rng(opts.seed);
  const lib = C.loadLibrary(db);
  const pubOf = new Map();
  for (const b of lib.books) if (b.publisher && !pubOf.has(b.series_id)) pubOf.set(b.series_id, b.publisher);
  const groups = new Map();
  for (const b of lib.books) {
    if (!b.store_date || !b.issue_number) continue;
    const w = W.wikiOf(b.publisher || pubOf.get(b.series_id));
    const name = W.wikiName(b.series);
    if (!w || !name) continue;
    const key = `${w}|${b.series_id}|${name.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { key, wiki: w, name, folder: `${b.folder} (${b.year})`, books: [] });
    groups.get(key).books.push(b);
  }
  // Cells: wiki × era × kind (ongoing: 12+ issues; small: 1–3, one-shots, annuals, minis on a shelf).
  const era = g => { const y = Number(g.books[0].store_date.slice(0, 4)); return y < 1990 ? 'pre-1990' : y < 2000 ? '1990s' : y < 2010 ? '2000s' : y < 2020 ? '2010s' : '2020s'; };
  const kind = g => (g.books.length >= 12 ? 'ongoing' : g.books.length <= 3 ? 'small' : 'mid');
  const cells = new Map();
  for (const g of groups.values()) { g.books.sort((a, b) => a.store_date.localeCompare(b.store_date)); const k = `${g.wiki}|${era(g)}|${kind(g)}`; if (!cells.has(k)) cells.set(k, []); cells.get(k).push(g); }
  const per = Math.max(1, Math.round(opts.series / Math.max(1, cells.size)));
  const chosen = [];
  for (const list of cells.values()) chosen.push(...shuffle(list, r).slice(0, per));
  log(`${groups.size} DC/Marvel series groups in ${cells.size} cells; testing ${chosen.length}`);

  const known = db.prepare(`SELECT from_book_id AS a, to_book_id AS b, source FROM crossover_links WHERE from_book_id IS NOT NULL AND to_book_id IS NOT NULL AND source <> 'wiki'`).all();
  const knownBy = new Map();
  for (const k of known) for (const id of [k.a, k.b]) { if (!knownBy.has(id)) knownBy.set(id, []); knownBy.get(id).push(k); }

  const client = W.createWikiClient({ axios });
  // 1. Volumes (the app's own lookup): Vol 1–10, then other spellings of the name.
  for (const w of Object.keys(W.WIKIS)) {
    const list = chosen.filter(g => g.wiki === w).map(g => {
      const probe = g.books.find(b => /^\d+$/.test(T.num(b.issue_number))) || g.books[0];
      g.probe = `#${probe.issue_number} ${probe.store_date}`;
      return { key: g.key, name: g.name, series: g.books[0].series, probe: { issue: T.num(probe.issue_number), store_date: probe.store_date } };
    });
    const found = await W.findVolumes(client, w, list);
    for (const g of chosen.filter(x => x.wiki === w)) { const f = found.get(g.key); g.vol = f?.vol || 0; g.wikiName = f?.name || g.name; g.pagesSeen = []; }
  }
  // 2. Issues: up to `issues` per series, those with a known link first.
  const queue = [];
  for (const g of chosen) {
    if (!g.vol) continue;
    const withK = shuffle(g.books.filter(b => knownBy.has(b.id)), r), rest = shuffle(g.books.filter(b => !knownBy.has(b.id)), r);
    g.asked = [...withK.slice(0, Math.ceil(opts.issues / 2)), ...rest].slice(0, opts.issues);
    for (const b of g.asked) queue.push({ g, b, title: W.pageTitle(g.wikiName, g.vol, T.num(b.issue_number)) });
  }
  const res = [];
  for (const w of Object.keys(W.WIKIS)) {
    const list = queue.filter(q => q.g.wiki === w);
    for (let i = 0; i < list.length; i += 50) {
      const batch = list.slice(i, i + 50);
      const got = await client.pages(w, batch.map(q => q.title));
      for (const q of batch) {
        const page = got.get(q.title);
        const out = { series: q.g.folder, name: q.g.name, issue: q.b.issue_number, date: q.b.store_date, title: q.title, page: !!page, fits: false, refs: [], rows: [], known: (knownBy.get(q.b.id) || []).length, knownFound: 0 };
        if (page) {
          const parsed = W.parsePage(page.text);
          out.fits = W.dateFits(parsed, q.b.store_date);
          out.pageDate = parsed.date?.date || null;
          out.event = parsed.event;
          out.refs = parsed.links.map(l => `${l.dir} ${l.series} Vol ${l.vol} #${l.issue}`);
          if (out.fits) {
            for (const ref of parsed.links) {
              const row = C.wikiRow(lib, q.b, ref, parsed.event, page.title);
              const label = b => (b ? `${b.series} (${b.year}) #${b.issue_number} [${b.store_date}]` : null);
              if (!row) { out.rows.push({ ref: `${ref.dir} ${ref.series} #${ref.issue}`, result: 'dropped (same series, or an owned issue far away)' }); continue; }
              out.rows.push({ ref: `${ref.dir} ${ref.series} #${ref.issue}`, result: row.from && row.to ? 'linked' : 'not owned',
                link: `${label(row.from) || `${row.fromName.series} #${row.fromName.issue}`} → ${label(row.to) || `${row.toName.series} #${row.toName.issue}`}`, story: row.story });
              const pair = row.from && row.to ? [row.from.id, row.to.id].sort().join('|') : null;
              if (pair && (knownBy.get(q.b.id) || []).some(k => [k.a, k.b].sort().join('|') === pair)) out.knownFound++;
            }
          }
        }
        res.push(out);
      }
    }
  }
  const s = {
    series: chosen.length, volFound: chosen.filter(g => g.vol).length, requests: client.requests(),
    issues: res.length, pages: res.filter(x => x.page).length, fits: res.filter(x => x.fits).length,
    withRefs: res.filter(x => x.fits && x.refs.length).length, refs: res.reduce((n, x) => n + (x.fits ? x.refs.length : 0), 0),
    linked: res.reduce((n, x) => n + x.rows.filter(y => y.result === 'linked').length, 0),
    notOwned: res.reduce((n, x) => n + x.rows.filter(y => y.result === 'not owned').length, 0),
    dropped: res.reduce((n, x) => n + x.rows.filter(y => y.result.startsWith('dropped')).length, 0),
    knownOnAsked: res.reduce((n, x) => n + x.known, 0), knownFound: res.reduce((n, x) => n + x.knownFound, 0),
  };
  const byCell = {};
  for (const g of chosen) { const k = `${g.wiki} ${era(g)} ${kind(g)}`; byCell[k] = byCell[k] || [0, 0]; byCell[k][0]++; if (g.vol) byCell[k][1]++; }
  return { summary: s, byCell, notFound: chosen.filter(g => !g.vol).map(g => ({ folder: g.folder, name: g.name, tried: [g.name, ...W.nameVariants(g.books[0].series)], books: g.books.length, probe: g.probe, pagesSeen: [] })),
    renamed: chosen.filter(g => g.vol && g.wikiName !== g.name).map(g => `${g.name} → ${g.wikiName} Vol ${g.vol}`), issues: res };
}

function text(rep) {
  const s = rep.summary, L = [];
  L.push(`Fan wiki test: ${s.series} series, ${s.requests} requests.`);
  L.push(`Wiki volume found: ${s.volFound} of ${s.series}.`);
  L.push(`Issues asked: ${s.issues}; page found ${s.pages}; date fits ${s.fits}; pages with story links ${s.withRefs} (${s.refs} links).`);
  L.push(`Links: ${s.linked} to an owned issue, ${s.notOwned} to an issue not owned, ${s.dropped} dropped.`);
  L.push(`Known links on the asked issues (summary, title, web): ${s.knownOnAsked}; found again by the wiki: ${s.knownFound}.`);
  L.push('', 'Volume found, by cell (series found / tested):');
  for (const [k, [n, f]] of Object.entries(rep.byCell).sort()) L.push(`  ${k}: ${f} / ${n}`);
  L.push('', 'Series whose wiki volume was not found (name, probe issue, pages that exist):');
  for (const g of rep.notFound) L.push(`  ${g.folder}: tried ${g.tried.map(n => `"${n}"`).join(', ')} (${g.books} issues; probe ${g.probe})`);
  L.push('', 'Found under another spelling:');
  for (const r of rep.renamed) L.push(`  ${r}`);
  L.push('', 'Pages not found or with a date that does not fit:');
  for (const x of rep.issues.filter(i => !i.page || !i.fits)) L.push(`  ${x.title} [${x.date}] ${x.page ? `page date ${x.pageDate || 'none'}` : 'no page'}`);
  L.push('', 'Links (check these by hand):');
  for (const x of rep.issues) for (const y of x.rows) L.push(`  [${y.result}] ${x.title}: ${y.link || y.ref}${y.story ? `  — ${y.story}` : ''}`);
  return L.join('\n');
}

async function main() {
  const opts = args(process.argv);
  const backend = process.env.OMNIBUS_BACKEND || path.join(__dirname, '..', 'backend');
  const req = m => require(path.join(backend, m));
  const db = new (req('node_modules/better-sqlite3'))(process.env.DB_PATH || '/appdata/omnibus.db', { readonly: true });
  const stamp = () => new Date().toISOString().slice(11, 19);
  const rep = await run(opts, { db, axios: req('node_modules/axios'), C: req('crossovers'), T: req('crossoverText'), W: req('crossoverWiki'), log: m => console.log(`${stamp()} ${m}`) });
  const base = path.join(opts.out, 'crossover-wiki-test');
  fs.writeFileSync(`${base}.json`, JSON.stringify(rep, null, 1));
  fs.writeFileSync(`${base}.txt`, text(rep));
  console.log(`\n${text(rep).split('\nSeries whose wiki volume')[0]}\n\nFull report: ${base}.txt (and .json)`);
}
if (require.main === module) main().catch(e => { console.error(`Failed: ${e?.message || e}`); process.exit(1); });
module.exports = { run, text };
