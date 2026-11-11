'use strict';
// Reading-list intake (design: project doc claude/LIST_INTAKE_DESIGN.md).
// Before the Reading List Generator builds a new list, Quick may ask the reader
// what they want from it. The stock questions live here, so the chips, the
// brief handed to the generator and the "Built for … Also available" row all
// use the same wording. Quick decides WHETHER to ask; this file says WHAT.

const STOCK = {
  character: {
    title: 'What matters most to you?', default: 'journey',
    options: [
      { id: 'best', label: 'Best stories', text: 'Read the greatest {name} stories, even if they skip around. Alternate versions included when they earn it.',
        question: 'What is most worth reading?', continuity: 'Alternate versions (Elseworlds, What If, Earth One and the like) are allowed when they are among the best; not required.',
        structure: 'Order for the best read; group by era or version where it helps. Include setup only when a story cannot be followed without it; a note can bridge the rest.',
        words: ['best', 'greatest', 'great ones', 'top', 'highlights', 'must read'] },
      { id: 'journey', label: 'Character journey', text: "Follow {name}'s defining moments, from beginning to now.",
        question: 'How did this person become who they are?', continuity: 'Main continuity.',
        structure: "Sections are phases of the subject's story (origin, rise, fall, return…), not eras of publication.",
        words: ['journey', 'defining', 'arc', 'evolution', 'development', 'how they became', 'how he became', 'how she became'] },
      { id: 'history', label: 'Comprehensive history', text: 'Follow every major milestone and event, in order.',
        question: 'What happened, and in what order?', continuity: 'Main continuity; milestones and the events they took part in, in order.',
        structure: "Chronological; sections by era of the subject's story.",
        words: ['history', 'comprehensive', 'everything', 'complete', 'milestone', 'chronolog', 'full'] },
    ],
  },
  line: {
    title: 'How do you want to dig in?', default: 'sample',
    options: [
      { id: 'sample', label: 'Try each series', text: 'Read the opening arc of every title and see what grabs you.',
        question: 'Which of these series will I enjoy?', continuity: 'This line only.',
        structure: 'One section per series, in launch order: its opening arc only.',
        words: ['try', 'each series', 'opening', 'first arc', 'sample', 'taste'] },
      { id: 'best', label: 'The best of the line', text: "Read the standout stories, whichever series they're in.",
        question: 'What is most worth reading in this line?', continuity: 'This line only.',
        structure: 'Standout arcs only, grouped by series or theme. Include setup only when a story cannot be followed without it.',
        words: ['best', 'standout', 'highlights', 'greatest'] },
      { id: 'whole', label: 'Follow the whole line', text: 'Read complete arcs across every series, roughly in publication order. Large universes are split into eras.',
        question: 'How did the whole line unfold?', continuity: 'This line only.',
        structure: 'Sections by launch wave or era; complete arcs from every series, interleaved roughly in publication order (arcs, not single issues). For a very large universe, build one era (the first, unless the reader named one) and name the later eras in your answer.',
        words: ['whole', 'follow', 'everything', 'all of it', 'complete', 'publication'] },
    ],
  },
  creator: {
    title: 'What are you after?', default: 'best',
    options: [
      { id: 'best', label: 'Their best work', text: 'The standout stories, across any series or publisher.',
        question: 'What is their best work?', continuity: 'Any series or publisher.',
        structure: 'Standouts, ordered for the best read. Include setup only when a story cannot be followed without it.',
        words: ['best', 'standout', 'greatest', 'highlights'] },
      { id: 'defining', label: 'Their defining work', text: 'The major runs and projects that established their reputation.',
        question: 'What made their reputation?', continuity: 'Any series or publisher.',
        structure: 'The runs and projects that made their name, each complete or by its defining arcs, in publication order.',
        words: ['defining', 'reputation', 'major runs', 'signature', 'known for'] },
      { id: 'career', label: 'Their career', text: 'Follow their major published work in order.',
        question: 'How did their work develop?', continuity: 'Any series or publisher.',
        structure: 'Their major published work in publication order, sections by period.',
        words: ['career', 'everything', 'all of it', 'complete', 'in order', 'chronolog'] },
    ],
  },
  // A theme is a "best stories" request by nature: never asked, one option.
  theme: {
    title: '', default: 'best',
    options: [
      { id: 'best', label: 'Best stories', text: '', question: 'What is most worth reading?', continuity: 'Any series, publisher or version.',
        structure: 'The best fits for the theme, ordered for the best read; sections by sub-genre or tone when it helps.', words: [] },
    ],
  },
};

const KINDS = new Set(['character', 'team', 'line', 'creator', 'theme', 'custom']);
const stockKind = kind => (kind === 'team' ? 'character' : kind);
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const fill = (text, name) => String(text || '').replace(/\{name\}/g, name || 'their');

// The choices for a kind. custom: the labels Quick wrote (2-4).
function optionsFor(kind, subject, customLabels) {
  if (kind === 'custom') {
    const labels = (Array.isArray(customLabels) ? customLabels : []).map(x => clean(typeof x === 'string' ? x : x?.label, 80)).filter(Boolean).slice(0, 4);
    if (labels.length < 2) return null;
    return { title: '', default: 'c1', options: labels.map((label, k) => ({ id: `c${k + 1}`, label, text: '', question: label, continuity: '', structure: '', words: [] })) };
  }
  const st = STOCK[stockKind(kind)];
  if (!st) return null;
  return { title: st.title, default: st.default, options: st.options.map(o => ({ ...o, text: fill(o.text, subject) })) };
}

const cleanSaved = saved => (Array.isArray(saved) ? saved : [])
  .filter(x => x && ['event', 'canon_run', 'reading_list'].includes(x.type) && x.id != null)
  .slice(0, 8).map(x => ({ type: x.type, id: clean(x.id, 80), name: clean(x.name, 80) }));

// What Quick's question becomes in the reply: everything the chips need, and
// what the app sends back with the reader's answer.
function makeIntake({ kind, subject, options, saved }) {
  if (!KINDS.has(kind) || kind === 'theme') return null;
  const name = clean(subject, 120);
  if (!name) return null;
  const set = optionsFor(kind, name, options);
  if (!set) return null;
  return { kind, subject: name, title: set.title, default: set.default,
    options: set.options.map(o => ({ id: o.id, label: o.label, text: o.text })), saved: cleanSaved(saved) };
}

// The question (or the list's brief) the reader is answering, rebuilt from what
// the app sent back. Option wording always comes from STOCK, never the client.
function pendingFrom(prev) {
  if (!prev) return null;
  const src = prev.intake || prev.brief;
  if (!src || typeof src !== 'object' || !KINDS.has(src.kind) || src.kind === 'theme') return null;
  const subject = clean(src.subject, 120);
  if (!subject) return null;
  const set = optionsFor(src.kind, subject, src.options);
  if (!set) return null;
  return { kind: src.kind, subject, ...set, saved: cleanSaved(src.saved), notes: clean(src.notes, 900), fromBrief: !prev.intake };
}

const GO = /^(go|ok(ay)?|sure|yes|yep|yeah|fine|default|do it|build it|sounds good|whatever|you pick|your call|surprise me|the recommended( one)?|recommended)\b[\s.!]*$/i;

// Which option the reader chose: a chip (explicit), "go" (default), or a short
// typed reply naming one option. Anything else is a new message for Quick.
// After a list (fromBrief), only an explicit pick counts (the rebuild buttons).
function matchAnswer(pending, text, explicit) {
  if (!pending) return null;
  const byId = id => pending.options.find(o => o.id === id);
  if (explicit && explicit.option && byId(String(explicit.option))) return { option: String(explicit.option), how: 'asked' };
  if (pending.fromBrief) return null;
  const t = clean(text, 300).toLowerCase();
  if (!t) return null;
  if (GO.test(t)) return { option: pending.default, how: 'default' };
  if (t.split(' ').length > 14) return null;
  // Word starts only ("top" must not match "stop", "arc" not "search"); stems like "chronolog" still match.
  const has = w => new RegExp(`(^|[^a-z])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t);
  const hits = pending.options.filter(o => has(o.label) || (o.words || []).some(has));
  return hits.length === 1 ? { option: hits[0].id, how: 'asked' } : null;
}

// A brief for the generator. how: asked | inferred | default.
function makeBrief({ kind, subject, option, how, saved, notes, options }) {
  const k = KINDS.has(kind) ? kind : null;
  const name = clean(subject, 120);
  if (!k || !name) return null;
  const set = optionsFor(k, name, options);
  if (!set) return null;
  const opt = set.options.find(o => o.id === option) || set.options.find(o => o.id === set.default);
  return { kind: k, subject: name, option: opt, how: ['asked', 'inferred', 'default'].includes(how) ? how : 'inferred',
    saved: cleanSaved(saved), notes: clean(notes, 900), all: set.options, customLabels: k === 'custom' ? set.options.map(o => o.label) : undefined };
}

const KIND_WORD = { character: 'character', team: 'team', line: 'line or universe', creator: 'creator', theme: 'theme', custom: 'request' };
const HOW_WORD = { asked: 'the reader chose it', inferred: 'inferred from the reader\'s wording', default: 'the default (the reader left it to you)' };

// The brief as the generator reads it, next to the question.
function briefText(b, savedLine) {
  if (!b) return '';
  const o = b.option;
  return ['READER\'S BRIEF (build to this):',
    `- Subject: ${b.subject} (${KIND_WORD[b.kind]})`,
    `- Built for: ${o.label}. The reader's question: "${o.question}" Build the list that answers it; its length follows from that, not from a target.`,
    o.continuity ? `- Continuity: ${o.continuity}` : null,
    o.structure ? `- Structure: ${o.structure}` : null,
    `- How chosen: ${HOW_WORD[b.how]}.`,
    savedLine ? `- SAVED READING ORDERS that cover part of this: ${savedLine}.` : null,
    b.notes ? `- Reader notes: ${b.notes}` : null,
  ].filter(Boolean).join('\n');
}

// What the reply carries with the list: the "Built for … Also available" row,
// and what the app sends back when the reader taps an alternative.
function publicBrief(b) {
  if (!b) return null;
  return { kind: b.kind, subject: b.subject, option: { id: b.option.id, label: b.option.label }, how: b.how,
    alternatives: b.kind === 'theme' ? [] : b.all.filter(o => o.id !== b.option.id).map(o => ({ id: o.id, label: o.label })),
    options: b.customLabels, saved: b.saved, notes: b.notes || undefined };
}

module.exports = { STOCK, KINDS, optionsFor, makeIntake, pendingFrom, matchAnswer, makeBrief, briefText, publicBrief };
