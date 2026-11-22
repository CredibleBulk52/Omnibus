'use strict';
// ─── Crossover links: text rules (2026-11-22) ────────────────────────
// Pure helpers shared by crossovers.js: names, issue numbers, ComicInfo summaries ("Continued in
// Superman #17") and the page check for the AI step (a page must name an issue before a link counts).
// claude/CROSSOVERS.md has the design and the measurements behind each rule.

// "The Uncanny X-Men" → "uncannyxmen"; "Batman & Robin" → "batmanandrobin".
const norm = s => String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/&/g, ' and ').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
const num = s => String(s ?? '').trim().replace(/^#/, '').replace(/^0+(?=\d)/, '');
// "Hawkman (1993 3rd Series)" → "Hawkman"
const stripYear = s => String(s || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
const tag = (xml, n) => { const m = new RegExp(`<${n}>([^<]*)</${n}>`).exec(xml || ''); return m ? m[1].trim() : ''; };
const days = (a, b) => (a && b ? Math.abs(Date.parse(a) - Date.parse(b)) / 86400000 : Infinity);

// ComicInfo text is XML-escaped, and Comic Vine summaries often escape again (&amp;#8217;).
function decode(s) {
  let t = String(s || '');
  for (let i = 0; i < 2; i++) {
    t = t.replace(/&#(\d+);?/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);?/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }
  return t.replace(/<[^>]+>/g, ' ').replace(/ /g, ' ');
}

// ── Summary links ─────────────────────────────────────────────────────
// A phrase that says the story goes on in another issue, then that issue:
//   "Continued in SECRET SIX #29", "part 3, continued from VALOR #22", "Crossover with New Teen Titans #24",
//   "Continues in this month's JUSTICE LEAGUE UNITED: FUTURES END #1", "Chapter 5 is in Superman #652".
// The words are matched in any case; the series name must start with a capital, so "continues from the
// previews issue, Firefly #20" does not read "previews issue, Firefly" as a series.
const anyCase = s => s.replace(/[a-z]/g, c => `[${c}${c.toUpperCase()}]`);
const TRIGGER = anyCase("continued|continues|continuing|concluded|concludes|concluding|picks? up|leads? into|flows? into|crossover|crosses over|chapter|part (?:one|two|three|four|five|six|seven|eight|nine|ten|\\d+)") +
  // "Don't miss" only for the story's next chapter, not a preview ("don't miss a free preview of this title in …").
  `|${anyCase("don['’]t miss")}[^.#\\n!?]{0,40}?${anyCase('(?:conclusion|chapter|part|continu|next issue|finale)')}`;
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const LINK_RX = new RegExp(
  `\\b(?:${TRIGGER})\\b[^.#\\n!?]{0,80}?(?:\\b(?:${anyCase('in|from|into|with|on')})\\b|:)\\s*:?\\s*` +
  `(?:${anyCase('the')}\\s+)?(?:${anyCase('pages of')}\\s+)?(?:(?:(?:${anyCase('this|next|last')})\\s+(?:${anyCase('month|week')})|${MONTHS})['’]s\\s+)?` +
  `([A-Z][A-Za-z0-9:'’&.\\-/ ]{1,60}?)\\s*(?:\\([^)]{0,30}\\))?\\s*#\\s?(\\d+(?:\\.\\d+)?)`, 'g');

// "<Summary>…" → [{ series, issue, phrase }]
function summaryMentions(comicinfo) {
  const m = /<Summary>([\s\S]*?)<\/Summary>/.exec(comicinfo || '');
  if (!m) return [];
  const text = decode(m[1]);
  const out = [];
  LINK_RX.lastIndex = 0;
  let h;
  while ((h = LINK_RX.exec(text))) {
    const series = h[1].replace(/^(?:issues? of)\s+/i, '').trim();
    if (series.length < 2) continue;
    // "continues from Aquaman's series in Adventure Comics #478", "continues from Part 6 in Manhunter #14":
    // the name after the last "in"/"from" is tried when the whole name is not a series in the library.
    const tail = /^.*\b(?:in|from|into)\s*:?\s+([A-Z].*)$/.exec(series)?.[1] || null;
    out.push({ series, tail, issue: num(h[2]), phrase: h[0].replace(/\s+/g, ' ').slice(0, 160) });
  }
  return out;
}

// ── Page check (AI step) ──────────────────────────────────────────────
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Does a page's text name this issue ("Green Lantern Corps #22", "Green Lantern Corps (2025) #22",
// "Supergirl Vol 9 16" on fandom wikis)?
function namedOnPage(text, part) {
  const words = stripYear(part.series).toLowerCase().replace(/&/g, 'and').split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length || !text) return false;
  const n = num(part.issue);
  const name = words.map(esc).join('[^a-z0-9]{1,3}');
  const re = new RegExp(`${name}[^a-z0-9]{0,4}(?:(?:vol\\.?|volume)\\s*\\d+[^a-z0-9]{0,3}|\\(?\\d{4}(?:\\s*-\\s*\\d{0,4})?\\)?[^a-z0-9]{0,3})?(?:#|no\\.?\\s*|issue\\s*)0*${esc(n)}(?![0-9])`, 'i');
  const wiki = new RegExp(`${name}[\\s_]+vol[\\s_]+\\d+[\\s_]+0*${esc(n)}(?![0-9])`, 'i');
  const t = String(text).toLowerCase().replace(/&/g, 'and').replace(/[‘’]/g, "'");
  return re.test(t) || wiki.test(t);
}

function parseJson(text) {
  const s = String(text || '').replace(/```(?:json)?/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

module.exports = { norm, num, stripYear, tag, days, decode, summaryMentions, namedOnPage, parseJson, LINK_RX };
