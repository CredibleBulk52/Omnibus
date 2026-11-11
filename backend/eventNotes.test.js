'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const en = require('./eventNotes');

test('solicitOf: decodes entities and markup, cuts long text, skips empty ones', () => {
  assert.equal(en.solicitOf('<Summary>A special oversize prologue to DC&#8217;s biggest event of the year. &lt;p&gt;Everything builds here.</Summary>'),
    'A special oversize prologue to DC’s biggest event of the year. Everything builds here.');
  assert.equal(en.solicitOf('<Summary>Short.</Summary>'), null);
  assert.equal(en.solicitOf(null), null);
  const long = en.solicitOf(`<Summary>${'word '.repeat(300)}</Summary>`, 100);
  assert.ok(long.length <= 101 && long.endsWith('…'));
});

test('buildPrompt: numbers issues and carries tier reasons, solicits and synopses', () => {
  const p = en.buildPrompt({ event: { name: 'DC K.O.', publisher: 'DC Comics', year: 2025 }, centralNarrative: 'Darkseid’s tournament.',
    items: [{ n: 1, series_name: 'DC K.O.', issue_number: '1', tier: 'essential', phase: 'Arena', tier_reason: 'necessary: opener; MET', solicit: 'The arena rises.' },
      { n: 2, series_name: 'Titans', issue_number: '28', tier: 'tie-in', synopsis: 'The Titans evacuate Earth.' }] });
  assert.ok(p.includes('1. DC K.O. #1 — Essential, phase "Arena"'));
  assert.ok(p.includes("Builder's note: necessary: opener; MET") && p.includes('Solicit: The arena rises.') && p.includes('Synopsis: The Titans evacuate Earth.'));
  assert.ok(p.includes('Main story of the event: Darkseid’s tournament.'));
});

test('matchNotes: matches by number and checks series and issue; a misplaced reply is dropped', () => {
  const items = [{ n: 1, id: 384, series_name: 'DC K.O.: Knightfight', issue_number: '2' }, { n: 2, id: 385, series_name: 'DC K.O.: Superman vs. Captain Atom', issue_number: '1' }, { n: 3, id: 386, series_name: 'The Flash', issue_number: '28' }];
  const r = en.matchNotes(items, [
    { n: 1, series_name: 'DC K.O.: Superman vs. Captain Atom', issue_number: '1', tier_note: 'wrong issue' },
    { n: 2, series_name: 'DC K.O.: Superman vs. Captain Atom', issue_number: '01', tier_note: 'Round one: Superman fights Captain Atom.' },
    { n: 3, series_name: 'Flash', issue_number: '28', tier_note: null },
  ]);
  assert.deepEqual(r.notes, [{ id: 385, tier_note: 'Round one: Superman fights Captain Atom.' }, { id: 386, tier_note: null }]);
  assert.equal(r.mismatched, 1);
  assert.equal(r.missing, 1);
});

test('parseReply: object or bare array, fenced or not', () => {
  assert.equal(en.parseReply('```json\n{"notes":[{"n":1,"tier_note":"x"}]}\n```').length, 1);
  assert.equal(en.parseReply('[{"n":1}]').length, 1);
  assert.throws(() => en.parseReply('nothing'));
});

test('parseReply: a reply cut off at the token limit keeps its complete notes', () => {
  const cut = '{"notes": [{"n": 1, "series_name": "DC K.O.", "issue_number": "1", "tier_note": "The arena rises."}, {"n": 2, "series_name": "Titans", "issue_number": "28", "tier_note": "The Titans evac';
  const r = en.parseReply(cut);
  assert.equal(r.length, 1);
  assert.equal(r[0].tier_note, 'The arena rises.');
});

test('titleOf: the ComicInfo story title; the prompt shows it and asks for one short sentence', () => {
  assert.equal(en.titleOf('<ComicInfo><Title>Impulse Control, Part 1</Title></ComicInfo>'), 'Impulse Control, Part 1');
  assert.equal(en.titleOf('<ComicInfo><Title></Title></ComicInfo>'), null);
  const p = en.buildPrompt({ event: { name: 'DC K.O.' }, items: [{ n: 1, series_name: 'The Flash', issue_number: '26', title: 'Impulse Control, Part 1', tier: 'tie-in', solicit: 'Wally and Bart.' }] });
  assert.ok(p.includes('1. The Flash #26 “Impulse Control, Part 1” — Tie-in'));
  assert.ok(p.includes('at most 20 words') && p.includes('do not repeat the title'));
});
