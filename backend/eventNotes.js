'use strict';
// Reader-facing tier notes for event issues (2026-10-22). Written from what Omnibus already has:
// the event generator's tier reasons (admin-only, from reading-order guides), each issue's solicit
// (the ComicInfo Summary, the publisher's pre-release text) and any saved synopsis. No web search.
// Replies are matched by list number and checked against series and issue number: the old
// annotator sent the issue ids in a separate list, and notes ended up on neighbouring issues.

const decode = s => String(s || '')
  .replace(/&lt;[^&]*?&gt;|<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&#8217;|&#8216;|&#39;|&apos;|&rsquo;|&lsquo;/g, '’')
  .replace(/&#8220;|&#8221;|&quot;|&ldquo;|&rdquo;/g, '"')
  .replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—').replace(/&#8230;|&hellip;/g, '…')
  .replace(/&[a-z#0-9]+;/gi, ' ')
  .replace(/\s+/g, ' ').trim();

// The story title from ComicInfo ("Impulse Control, Part 1"); null when there is none.
function titleOf(comicinfo) {
  const m = String(comicinfo || '').match(/<Title>([\s\S]*?)<\/Title>/);
  const t = m ? decode(m[1]) : '';
  return t && t.length <= 200 ? t : null;
}

// The solicit, cleaned and cut; null when there is none worth sending.
function solicitOf(comicinfo, max = 600) {
  const m = String(comicinfo || '').match(/<Summary>([\s\S]*?)<\/Summary>/);
  if (!m) return null;
  let s = decode(m[1]);
  if (s.length < 40) return null;
  if (s.length > max) s = `${s.slice(0, max).replace(/\s+\S*$/, '')}…`;
  return s;
}

const TIER_LABEL = { essential: 'Essential', recommended: 'Recommended', 'tie-in': 'Tie-in', aftermath: 'Aftermath' };
const hasMaterial = i => !!(i.tier_reason || i.solicit || i.synopsis);

function buildPrompt({ event, centralNarrative, items }) {
  const head = `"${event.name}"${event.publisher ? ` (${event.publisher})` : ''}${event.year ? `, ${event.year}` : ''}`;
  const list = items.map(i => [
    `${i.n}. ${i.series_name} #${i.issue_number}${i.volume_year ? ` (${i.volume_year})` : ''}${i.title ? ` “${i.title}”` : ''} — ${TIER_LABEL[i.tier] || i.tier || 'no tier'}${i.phase ? `, phase "${i.phase}"` : ''}`,
    i.tier_reason ? `   Builder's note: ${i.tier_reason}` : null,
    i.solicit ? `   Solicit: ${i.solicit}` : null,
    i.synopsis ? `   Synopsis: ${i.synopsis}` : null,
  ].filter(Boolean).join('\n')).join('\n');
  return `You are writing reader-facing notes for the reading order of the comic event ${head}, in a personal comic library app.
${centralNarrative ? `\nMain story of the event: ${centralNarrative}\n` : ''}${event.description ? `\nEvent description: ${event.description}\n` : ''}
Each issue below has its tier and some of: the builder's note (why the reading-order builder gave that tier, from reading-order guides; written for the app's admin), the solicit (the publisher's marketing text, written before the issue came out: it gives the set-up, not what happens) and a synopsis (what happens).

Write one note per issue: one plain sentence of at most 20 words telling a reader why this issue is worth reading within this event (for a tie-in, honestly whether it is) and what it is about. The reader sees the issue's title (in quotes after the issue number) beside the note, so do not repeat the title; you may build on it ("the Terrific Ten's story begins").
- Use only the material given. Do not add plot details, characters or events that are not in it.
- Light spoilers are fine when they are why the issue matters (a death, a reveal, a turning point), but do not give away how the event ends.
- Do not copy marketing hype ("A fight so explosive…", "Don't miss…") and do not ask questions; say plainly what the issue offers.
- Do not mention tiers, guides, sources, source codes or the builder's notes; write for the reader.
- By tier: essential, why the main story needs it; recommended, what it adds; tie-in, what it is about and who would enjoy it; aftermath, what it follows up.
- If the material says nothing useful about an issue, its note is null.

Issues:
${list}

Reply with only this JSON object, one entry per issue in the same order: {"notes": [{"n": 1, "series_name": "…", "issue_number": "…", "tier_note": "…"}]} (tier_note null when there is nothing to say).`;
}

const NOTES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['notes'],
  properties: { notes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['n', 'series_name', 'issue_number', 'tier_note'],
    properties: { n: { type: 'integer' }, series_name: { type: 'string' }, issue_number: { type: 'string' }, tier_note: { type: ['string', 'null'] } } } } },
};

const seriesKey = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
const numberKey = s => String(s || '').trim().toLowerCase().replace(/^#/, '').replace(/^0+(?=\d)/, '');

function parseReply(text) {
  const s = String(text || '').replace(/```json\s*|```/gi, '').replace(/<cite\b[^>]*>([\s\S]*?)<\/cite>/g, '$1');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b > a) { try { const o = JSON.parse(s.slice(a, b + 1)); if (Array.isArray(o.notes)) return o.notes; } catch {} }
  const c = s.indexOf('['), d = s.lastIndexOf(']');
  if (c !== -1 && d > c) { try { const arr = JSON.parse(s.slice(c, d + 1)); if (Array.isArray(arr)) return arr; } catch {} }
  // A reply cut off at the token limit: keep every complete note object.
  const parts = [];
  for (const m of s.matchAll(/\{\s*"n"\s*:\s*\d+[^{}]*\}/g)) { try { parts.push(JSON.parse(m[0])); } catch {} }
  if (parts.length) return parts;
  throw new Error('No JSON notes in the reply');
}

// → { notes: [{ id, tier_note }], mismatched, missing }. A reply whose series or number does not
// match the issue at its list number is dropped, never placed on another issue.
function matchNotes(items, reply) {
  const byN = new Map(items.map(i => [i.n, i]));
  const out = new Map(); let mismatched = 0;
  for (const r of reply || []) {
    const i = byN.get(Number(r && r.n));
    if (!i) { mismatched++; continue; }
    if (seriesKey(r.series_name) !== seriesKey(i.series_name) || numberKey(r.issue_number) !== numberKey(i.issue_number)) { mismatched++; continue; }
    const note = typeof r.tier_note === 'string' ? r.tier_note.replace(/<cite\b[^>]*>([\s\S]*?)<\/cite>/g, '$1').trim() || null : null;
    if (!out.has(i.id)) out.set(i.id, note);
  }
  return { notes: [...out].map(([id, tier_note]) => ({ id, tier_note })), mismatched, missing: items.filter(i => !out.has(i.id)).length };
}

module.exports = { titleOf, solicitOf, decode, buildPrompt, matchNotes, parseReply, hasMaterial, NOTES_SCHEMA, seriesKey, numberKey };
