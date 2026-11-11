'use strict';
// Selection setup (claude/BOXES_UNIFIED_PLAN.md stage 3): the reader's required
// choices before Comic Book Guy builds anything new. Quick decides WHETHER to ask
// (ask_reader, or a hand_off to the generator without a brief); this file says WHAT.
//   1. A series box or a reading order.
//   2. Box: only series in Omnibus, or missing ones too; then a short stack (~10) or a full box (~25).
//      Order: the stock "what matters most" options (ai/intake.js), then where to begin.
// No defaults: every shown question needs an answer. Notes are optional.
const intake = require('./intake');

const clean = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const FORMAT = { key: 'format', title: 'What should I make?', choices: [['box', 'A box of series', 'Series worth reading, to browse or save as a box.'], ['order', 'A reading order', 'Issues and arcs in the order to read them.']] };
const AVAILABILITY = { key: 'availability', title: 'Which series?', only: 'box', choices: [['library', 'Only series in Omnibus', ''], ['missing', 'Include series Omnibus doesn’t have yet', '']] };
const SIZE = { key: 'size', title: 'How big a box?', only: 'box', choices: [['short', 'A short stack', 'About 10 series.'], ['full', 'A full box', 'About 25 series.']] };
const START = { key: 'start', title: 'Where should it begin?', only: 'order', choices: [['origins', 'From the beginning', ''], ['modern', 'A modern jumping-on point', ''], ['specific', 'A particular era or story', '']] };
const START_KINDS = new Set(['character', 'team', 'creator', 'custom']);

// The questions for one request. Priority comes from the stock options for its kind;
// a kind with one option (theme) skips it.
function fieldsFor(kind, subject, customLabels) {
  const set = intake.optionsFor(kind, subject, customLabels);
  const fields = [FORMAT, AVAILABILITY, SIZE];
  if (set && set.options.length > 1)
    fields.push({ key: 'priority', title: set.title || 'What matters most to you?', only: 'order', choices: set.options.map(o => [o.id, o.label, o.text || '']) });
  if (START_KINDS.has(kind)) fields.push(START);
  return fields;
}

// The request itself: what it is about, which saved orders cover part of it, and
// custom options. Rebuilt on the server from what the app sends back.
function subjectOf(v) {
  if (!v || typeof v !== 'object' || !intake.KINDS.has(v.kind)) return null;
  const subject = clean(v.subject, 120);
  if (!subject) return null;
  const options = v.kind === 'custom' ? (Array.isArray(v.options) ? v.options : []).map(x => clean(typeof x === 'string' ? x : x?.label, 80)).filter(Boolean).slice(0, 4) : undefined;
  if (v.kind === 'custom' && options.length < 2) return null;
  const saved = (Array.isArray(v.saved) ? v.saved : []).filter(x => x && ['event', 'canon_run', 'reading_list'].includes(x.type) && x.id != null)
    .slice(0, 8).map(x => ({ type: x.type, id: clean(String(x.id), 80), name: clean(x.name, 80) }));
  return { kind: v.kind, subject, options, saved };
}

// The form shown under his message. format: what the reader already asked for, if anything.
function form(v) {
  const s = subjectOf(v);
  if (!s) return null;
  const format = ['box', 'order'].includes(v.format) ? v.format : undefined;
  return { version: 2, ...s, fields: fieldsFor(s.kind, s.subject, s.options), values: format ? { format } : {} };
}

// The reader's confirmed choices, or null when any shown question is unanswered.
function validate(v) {
  const s = subjectOf(v);
  if (!s) return null;
  const b = { ...s, notes: clean(v.notes, 600) };
  for (const f of fieldsFor(s.kind, s.subject, s.options)) {
    if (f.only && v.format !== f.only) continue;
    if (!f.choices.some(([id]) => id === v[f.key])) return null;
    b[f.key] = v[f.key];
  }
  if (b.start === 'specific') { b.startDetail = clean(v.startDetail, 200); if (!b.startDetail) return null; }
  return b;
}

const titleCase = s => s.replace(/(^|\s)([a-z])/g, (m, sp, ch) => sp + ch.toUpperCase());
const boxName = b => clean(titleCase(b.subject), 100);

// The reading-order brief's extra notes: where to begin and the reader's own notes.
function orderNotes(b) {
  const start = b.start === 'origins' ? 'Begin at the beginning.' : b.start === 'modern' ? 'Begin at a modern jumping-on point; earlier material only as notes.'
    : b.start === 'specific' ? `Begin at: ${b.startDetail}.` : '';
  return [start, b.notes].filter(Boolean).join(' ');
}

// What Long Answers is told when building a series box.
function boxBrief(b) {
  return ["READER'S CONFIRMED CHOICES (build to this):",
    `- A box of series about: ${b.subject}.`,
    `- Size: ${b.size === 'full' ? 'a full box, about 25 series' : 'a short stack, about 10 series'}. Search widely enough to reach it (several searches: sub-genres, creators, related themes). If there are not that many good fits, give fewer and say so; never pad. One line per series; the length guide for long answers does not cap the number of series.`,
    b.availability === 'library'
      ? '- Only series in Omnibus: search the library and recommend only series you found there.'
      : '- Series in Omnibus first; series it does not have are welcome too. Put them in missing_series (title, start year, publisher, one-line reason); the app finds them on Comic Vine and the reader can request them.',
    '- Put every Omnibus series in box_series, with the ids from your searches (never invented). The app shows the whole box under your answer, so the answer names only a few highlights and why the box hangs together. Do not build an issue order or a proposed_list.',
    '- The reader saves the box themselves (a private box). Never say it has been saved.',
    b.notes ? `- Reader notes: ${b.notes}` : null,
  ].filter(Boolean).join('\n');
}

module.exports = { fieldsFor, form, validate, boxName, boxBrief, orderNotes };
