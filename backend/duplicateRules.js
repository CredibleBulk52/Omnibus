'use strict';
// ─── duplicateRules.js ────────────────────────────────────────────
// Which books that share one Comic Vine issue ID are really the same comic,
// and which copy to keep (claude/LIBRARY_HEALTH.md, "Duplicate checker v2").
// Built from the manual pass of 511 groups (2026-10-16), where the first
// checker called different comics duplicates:
//   "Justice League Aquaman Drowned Earth" vs "Aquaman Justice League …"  (word order)
//   "Aquaman - Futures End" vs "Aquaman and the Others - Futures End"     (words in the middle)
//   "Even More Secret Origins" vs Secret Origins                          (words in front)
// Per book: same | look (a person decides: subtitle, edition) | mismatch (another comic).
const path = require('node:path');
const { parseComicInfoEvidence, parseIssueNumberEvidence, filenameEvidence } = require('./metadata/evidence');

const tagOf = (xml, key) => { const f = parseComicInfoEvidence(xml).fields[key]; return f && f.length === 1 ? f[0] : null; };
const num = v => (v == null ? null : parseIssueNumberEvidence(v).normalized);

// Words of a title: lower case, "&" = and, volume markers and years dropped,
// a leading "The" ignored.
function titleWords(t) {
  const s = String(t || '').normalize('NFKC').toLowerCase().replace(/&amp;/g, '&').replace(/&/g, ' and ').replace(/['’]/g, '')
    .replace(/\bv(?:ol(?:ume)?)?\.?\s*\d{1,2}\b/g, ' ').replace(/\b(?:19|20)\d{2}\b/g, ' ').replace(/\bannual\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  if (s[0] === 'the') s.shift();
  return s;
}
// Words a file name or tag may add or leave off in front ("Batman Legends of
// the Dark Knight", "Star Wars Poe Dameron", "Marvel Knights …" is NOT one).
const FRONT = [['star', 'wars'], ['batman'], ['dc'], ['marvel']];
const dropFront = w => { for (const f of FRONT) if (f.every((x, i) => w[i] === x) && w.length > f.length) return w.slice(f.length); return w; };
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
// Comic Vine link names drop "&" and "/" and run words together
// ("harley-quinnpower-girl" for Harley Quinn and Power Girl).
const compact = w => w.filter(x => x !== 'and').join('');
// One or two typing slips in a long title ("Intersteller", "Landy").
function nearlySame(a, b) {
  if (Math.min(a.length, b.length) < 12 || Math.abs(a.length - b.length) > 2) return false;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length] <= 2;
}
const startsWith = (a, b) => b.length < a.length && b.every((x, i) => a[i] === x);
// Edition and partial-copy words in a file name.
const EDITION = /director'?s cut|special edition|replica edition|double feature|2nd printing|second printing|facsimile|new material|sketch|ashcan|preview|day special/i;
const PARTIAL = /\bincomplete\b|\binc\)|\(inc\b|covers? only|\bnocover\b|\bonly\)|\bonly\b(?!.*\d)|variant\)|figure variant|\bcover\b(?! date)/i;

// file title vs the title it is tagged with:
//   same      equal, run-together letters, a shortened title ("Power Man" for
//             Power Man and Iron Fist), a franchise word in front
//   subtitle  the tagged title plus " - Something" (story title or another
//             comic: "Ghost Rider - Vengeance Unbound", "Batman - Rebirth")
//   different anything else
function titleRelation(fileTitle, tagTitle, rawFileTitle = fileTitle) {
  const f = titleWords(fileTitle), t = titleWords(tagTitle);
  if (!f.length || !t.length) return 'unknown';
  const fs = [f, dropFront(f)], ts = [t, dropFront(t)];
  for (const a of fs) for (const b of ts) if (eq(a, b) || compact(a) === compact(b) || nearlySame(compact(a), compact(b))) return 'same';
  // A shortened name drops a partner: "Power Man" for Power Man and Iron Fist
  // (not "Superman" for Superman Special, "Aquaman" for Aquaman and the Others… those differ).
  for (const a of fs) for (const b of ts) if (startsWith(b, a) && b[a.length] === 'and' && b.length - a.length >= 3) return 'same';
  // Comic Vine adds "Special" / "One-Shot" to some volume names.
  for (const a of fs) for (const b of ts) if (a.length >= 3 && ['special', 'oneshot'].some(x => compact(b) === compact(a) + x)) return 'same';
  for (const a of fs) for (const b of ts) if (a.length >= 3 && startsWith(b, a) && b.slice(a.length).every(x => ['special', 'one', 'shot'].includes(x))) return 'same';
  // Tagged title then " - extra" in the file name.
  const dash = /^(.*?\S)\s+[-–—:]\s+(.+)$/.exec(String(rawFileTitle || ''));
  if (dash) { const head = titleWords(dash[1]); for (const b of ts) if (eq(head, b) || eq(dropFront(head), b)) return 'subtitle'; }
  return 'different';
}

function fileView(filename) {
  const candidates = filenameEvidence(filename).candidates;
  const base = String(filename || '').replace(/\.(cbz|cbr|zip|rar)$/i, '').replace(/\s*\bGetComics(?:\.[A-Z]+)?\b/ig, '')
    .replace(/^\d+\.\s+/, '')                                     // reading-order prefix "0. Batman - Rebirth"
    .replace(/^(.+?),?\s+((?:19|20)\d{2})-\d{2}-\d{2}\s*\((?:_|#)(\d+)\)/, '$1 $3 ($2)')   // "The Ray, 1994-08-00 (_00)"
    .replace(/\s*\([^)]*\)|\s*\[[^\]]*\]/g, '').trim();
  // The issue number is the last number in the name ("Spider-Man 2099 005",
  // "Superman v2 190 Double Feature Issue").
  const m = /^(.*\S)\s+#?(\d*½|\d[\d.]*[a-z]?)(?![\d])([^\d]*)$/i.exec(base);
  const title = (m ? m[1] : base).trim();
  const after = m ? m[3].replace(/^[\s-]+/, '').trim() : '';    // "Director's Cut", "Double Feature Issue"
  const namedYear = (/\b((?:19|20)\d{2})\s+annual\b/i.exec(base) || [])[1] || null;
  const number = candidates.length === 1 ? candidates[0].normalized : (m ? num(m[2]) : null);
  // The same title keeping words in parentheses that are not years or release
  // tags: "Free Comic Book Day 2015 (Secret Wars) 000".
  const raw = String(filename || '').replace(/\.(cbz|cbr|zip|rar)$/i, '').replace(/^\d+\.\s+/, '')
    .replace(/\s*\((?:(?:19|20)\d{2}|[^)]*(?:digital|scan|c2c|empire|dcp|minutemen|novus|hd|webrip|covers?|f)[^)]*)\)/gi, '').replace(/\s*\[[^\]]*\]/g, '');
  const rm = /^(.*\S)\s+#?(\d*½|\d[\d.]*[a-z]?)(?![\d])([^\d]*)$/i.exec(raw.trim());
  const fullTitle = (rm ? rm[1] : raw).replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  return { number, annual: /\bannual\b/i.test(filename || ''), title, fullTitle, after, namedYear };
}
// Title and number of the Comic Vine page the stored ID points to (ComicInfo <Web>).
function webTarget(book) {
  const m = /comicvine\.gamespot\.com\/([a-z0-9-]+)\/4000-(\d+)/i.exec(tagOf(book.comicinfo, 'web') || '');
  if (!m || m[1] === 'issue' || String(m[2]) !== String(book.cv_issue_id)) return null;
  const parts = m[1].split('-');
  const numeric = parts.map((p, i) => /^\d+[a-z]*$/i.test(p) ? i : -1).filter(i => i >= 1);
  if (!numeric.length) return null;
  let i = numeric[0];
  if (/^(19|20)\d{2}$/.test(parts[i]) && numeric.length > 1) i = numeric[1];
  // Titles hold numbers ("earth-2-society-2", "season-11-9", "the-new-52-…-1"):
  // each number may be the issue; the one equal to the file's number wins.
  // The issue number is often repeated in the story title ("captain-america-1-
  // out-of-time-part-1"): of the numbers equal to the file's, take the one
  // whose title before it fits the file name best, else the first.
  const fv = fileView(book.filename);
  const hits = numeric.filter(k => fv.number != null && num(parts[k]) === fv.number);
  if (hits.length) {
    const rank = { same: 3, subtitle: 2, unknown: 1, different: 0 };
    i = hits.map(k => ({ k, r: rank[titleRelation(fv.title, parts.slice(0, k).join(' '), fv.title)] })).sort((a, b) => b.r - a.r || a.k - b.k)[0].k;
  }
  const title = parts.slice(0, i).join(' ');
  return { title, number: num(parts[i]), numbers: numeric.map(k => num(parts[k])), annual: /\bannual\b/.test(title), namedYear: (/\b((?:19|20)\d{2})\s+annual\b/.exec(title) || [])[1] || null };
}
// What the stored ID says this book is.
function tagged(book) {
  const web = webTarget(book);
  if (web) return { ...web, label: `${web.title.replace(/\b\w/g, c => c.toUpperCase())} #${web.number}` };
  const series = tagOf(book.comicinfo, 'series') || '', number = num(tagOf(book.comicinfo, 'number'));
  if (!series) return null;
  return { title: series, number, numbers: number ? [number] : [], annual: /\bannual\b/i.test(series), namedYear: (/\b((?:19|20)\d{2})\s+annual\b/i.exec(series) || [])[1] || null,
    label: `${series}${number ? ' #' + number : ''}` };
}

// { status: 'same' | 'look' | 'mismatch' | 'unknown', reason, partial, edition }
function checkBook(book) {
  const f = fileView(book.filename), t = tagged(book);
  const partial = PARTIAL.test(book.filename || '');
  const edition = !partial && (EDITION.test(book.filename || '') || (f.after && /[a-z]{3}/i.test(f.after) && !/^of\s+\d/i.test(f.after)));
  const out = (status, reason) => ({ status, reason, partial, edition: !!edition });
  if (!t) return out('unknown', 'No tag to compare');
  if (f.annual !== t.annual) return out('mismatch', `File is ${f.annual ? '' : 'not '}an annual; tagged as ${t.label}`);
  if (f.namedYear && t.namedYear && f.namedYear !== t.namedYear) return out('mismatch', `File is the ${f.namedYear} Annual; tagged as ${t.label}`);
  if (f.number && t.number && !t.numbers.includes(f.number)) return out('mismatch', `File says #${f.number}; tagged as ${t.label}`);
  let rel = titleRelation(f.title.replace(/\bannual\b/ig, ''), t.title, f.title);
  if (rel === 'different' && f.fullTitle && f.fullTitle !== f.title) rel = titleRelation(f.fullTitle, t.title, f.fullTitle);
  if (rel === 'different') return out('mismatch', `File is titled "${f.title}"; tagged as ${t.label}`);
  if (edition) return out('look', `"${f.after || (EDITION.exec(book.filename) || [])[0]}" may be a separate edition of ${t.label}`);
  if (rel === 'subtitle') return out('look', `File adds a subtitle to ${t.label}: "${f.title}"`);
  if (!f.number && !partial) return out('unknown', 'File name has no issue number');
  return out('same', null);
}

// How well a copy's folder fits the comic: 2 = folder named exactly for the
// tagged series, 1 = loosely (shortened, a franchise word, a typo), 0 = another
// series ("Supergirl (2016)" holding a Batgirl annual).
function folderName(book) { return path.basename(path.dirname(book.path || '')).replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+(?:19|20)\d{2}(?:\s*-\s*(?:19|20)\d{2})?$/, '').trim(); }
function folderFit(book) {
  const t = tagged(book);
  if (!t) return 0;
  const tw = titleWords(tagOf(book.comicinfo, 'series') || t.title);
  let best = 0;
  for (const name of [folderName(book), book.folder_series_name].filter(Boolean)) {
    const fw = titleWords(name);
    if (eq(fw, tw) || compact(fw) === compact(tw)) return 2;
    if (titleRelation(name, t.title) === 'same' || titleRelation(t.title, name) === 'same') best = 1;
  }
  return best;
}
// Era folders of one run ("Detective Comics (2016)", "Detective Comics (2023)"):
// the folder whose years hold the issue's cover year; with several, the one
// that starts latest. Returns a sortable number (higher is better).
function eraFit(book) {
  const year = Number(tagOf(book.comicinfo, 'year')) || Number((/\(((?:19|20)\d{2})\)/.exec(book.filename || '') || [])[1]) || null;
  const folder = path.basename(path.dirname(book.path || ''));
  const range = /\b((?:19|20)\d{2})\s*-\s*((?:19|20)\d{2})?\b/.exec(folder);
  const start = range ? Number(range[1]) : Number((/\b((?:19|20)\d{2})\b/.exec(folder) || [])[1]) || null;
  if (!year || !start) return 0;
  const end = range && range[2] ? Number(range[2]) + 1 : Infinity;
  if (year > end) return -1;
  if (year < start) return year === start - 1 ? -0.5 : -1;   // a year early: cover dates run ahead
  return start / 10000;   // inside: later start is a closer fit
}
const ownFolder = b => folderFit(b) === 2;

// Recommended copy and the plain reason. Order (user, 2026-10-16): a complete
// copy; in its own series folder, then the folder whose years hold the issue;
// with reading progress (carried over to the kept copy); sharper pages (when
// measured); larger file; a digital release; the plainer name.
function recommend(books) {
  const pages = b => Number(b.pages || tagOf(b.comicinfo, 'pagecount')) || 0;
  const maxPages = Math.max(0, ...books.map(pages)), maxSize = Math.max(0, ...books.map(b => b.file_size || 0));
  // Size and page count only point to a partial copy when no copy is a
  // different edition (a Director's Cut is longer than the regular issue).
  const editions = books.some(b => b.check?.edition);
  const complete = b => !b.check?.partial && (editions || (!(maxSize && (b.file_size || 0) < maxSize * 0.25) && !(maxPages && pages(b) && pages(b) < maxPages * 0.6)));
  const sharper = (a, b) => (!a.resolution || !b.resolution) ? 0 : b.resolution / a.resolution > 1.05 ? 1 : a.resolution / b.resolution > 1.05 ? -1 : 0;
  const sizeCmp = (a, b) => { const x = a.file_size || 0, y = b.file_size || 0; return Math.abs(x - y) <= Math.max(x, y) * 0.01 ? 0 : y - x; };
  const digital = b => /digital|webrip/i.test(b.filename || '') ? 1 : 0;
  const plain = b => /\d[a-z]\b|variant/i.test(fileView(b.filename).title + ' ' + (b.filename || '')) ? 0 : 1;
  const details = b => b.folder_series_name ? 1 : 0;   // folder has series details (series.json)
  const sorted = [...books].sort((a, b) => (complete(b) - complete(a)) || (folderFit(b) - folderFit(a)) || (eraFit(b) - eraFit(a)) || (details(b) - details(a))
    || (!!b.has_progress - !!a.has_progress) || sharper(a, b) || sizeCmp(a, b) || (digital(b) - digital(a)) || (plain(b) - plain(a)) || ((b.file_size || 0) - (a.file_size || 0)));
  const k = sorted[0], others = sorted.slice(1);
  const why = [];
  if (complete(k) && others.some(o => !complete(o))) why.push(others.length === 1 ? 'the other copy is partial' : 'complete copy');
  else if (others.some(o => folderFit(o) < folderFit(k))) why.push('in its own series folder');
  else if (others.some(o => eraFit(o) < eraFit(k))) why.push("in the folder for the issue's years");
  if (k.has_progress && others.some(o => !o.has_progress)) why.push('has your reading progress');
  if (!why.length || why.length === 1 && !k.has_progress) {
    if (k.resolution && others.some(o => sharper(o, k) > 0)) why.push('sharper pages');
    else if (others.every(o => sizeCmp(o, k) > 0)) why.push('larger file');
    else if (digital(k) && others.some(o => !digital(o))) why.push('digital release');
  }
  if (!why.length) why.push('the copies look the same');
  return { keepId: k.id, reason: why.join('; '), progressElsewhere: others.some(o => o.has_progress) && !k.has_progress };
}

// Year evidence: copies whose own years cannot be the same issue ("Avengers
// 012 (2011)" vs the 2013 issue; "The Shadow 2012-2014/The Shadow 002" vs a
// 2015 issue). A copy's own year is its "(YYYY)", else its folder's years.
function ownYears(book) {
  const fileYear = Number((/\(((?:19|20)\d{2})\)/.exec(String(book.filename || '')) || [])[1]) || null;
  if (fileYear) return { lo: fileYear, hi: fileYear, exact: true };
  const folder = path.basename(path.dirname(book.path || ''));
  const range = /\b((?:19|20)\d{2})\s*-\s*((?:19|20)\d{2})\b/.exec(folder);
  if (range) return { lo: Number(range[1]), hi: Number(range[2]) };
  const start = Number((/\b((?:19|20)\d{2})\b/.exec(folder) || [])[1]) || null;
  return start ? { lo: start, hi: Infinity } : null;
}
function yearsConflict(books) {
  const spans = books.map(ownYears).filter(Boolean);
  for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) {
    const a = spans[i], b = spans[j], slack = a.exact && b.exact ? 1 : 0;
    if (a.lo > b.hi + slack || b.lo > a.hi + slack) return true;
  }
  return false;
}
function yearProblem(book) {
  const tagYear = Number(tagOf(book.comicinfo, 'year')) || null;
  if (!tagYear) return null;
  const volumeYear = Number(tagOf(book.comicinfo, 'volume')) || null;
  const folder = path.basename(path.dirname(book.path || ''));
  const range = /\b((?:19|20)\d{2})\s*-\s*((?:19|20)\d{2})\b/.exec(folder);
  const start = range ? Number(range[1]) : Number((/\b((?:19|20)\d{2})\b/.exec(folder) || [])[1]) || null;
  const fileYear = Number((/\(((?:19|20)\d{2})\)/.exec(String(book.filename || '')) || [])[1]) || null;
  const namedYear = Number((/\b((?:19|20)\d{2})\s+annual\b/i.exec(book.filename || '') || [])[1]) || null;
  // The name itself carries the tagged year ("Harley Quinn 2021 Annual" in
  // "Harley Quinn (2023)"): the right comic in the wrong era folder.
  if ([fileYear, namedYear].some(y => y && Math.abs(y - tagYear) <= 1)) return null;
  if (fileYear && Math.abs(fileYear - tagYear) > 1 && fileYear !== volumeYear && fileYear !== start)
    return `File is from ${fileYear}; the tagged issue is from ${tagYear}`;
  if (range && (tagYear < Number(range[1]) - 1 || tagYear > Number(range[2])))
    return `Folder covers ${range[1]}–${range[2]}; the tagged issue is from ${tagYear}`;
  if (!range && start && tagYear < start - 1) return `Folder starts in ${start}; the tagged issue is from ${tagYear}`;
  return null;
}

// A group's verdict. Mistagged books leave the checker (they are re-identified);
// what remains is either a duplicate (a recommendation) or needs a look.
function classify(books) {
  const checked = books.map(b => ({ ...b, check: b.check || checkBook(b) }));
  if (yearsConflict(checked)) for (const b of checked) {
    const why = b.check.status !== 'mismatch' && !b.confirmed && yearProblem(b);
    if (why) b.check = { ...b.check, status: 'mismatch', reason: why };
  }
  const mistagged = checked.filter(b => b.check.status === 'mismatch');
  const rest = checked.filter(b => b.check.status !== 'mismatch');
  if (rest.length < 2) return { kind: 'none', mistagged, books: rest };
  // Copies whose titles differ from each other (both fit the tag loosely).
  const titles = rest.map(b => titleWords(fileView(b.filename).title).join(' '));
  const look = rest.filter(b => b.check.status === 'look');
  const partialOnly = rest.filter(b => !b.check.partial).length <= 1;
  let kind = 'duplicate', reason = null;
  if (look.length && !partialOnly) { kind = 'look'; reason = look[0].check.reason; }
  else if (rest.some(b => b.check.status === 'unknown') && !partialOnly && new Set(titles).size > 1) { kind = 'look'; reason = 'A file name has no issue number to compare'; }
  const rec = recommend(rest);
  return { kind, reason, mistagged, books: rest, keepId: kind === 'duplicate' ? rec.keepId : null, suggestId: rec.keepId, keepReason: rec.reason };
}

module.exports = { yearProblem, yearsConflict, ownYears, titleWords, titleRelation, fileView, webTarget, tagged, checkBook, ownFolder, folderFit, eraFit, recommend, classify, EDITION, PARTIAL };
