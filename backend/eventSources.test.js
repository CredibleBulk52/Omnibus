'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanSources, releaseFlags } = require('./eventSources');

test('cleanSources: codes must match a page read (AI always allowed); omitted keeps reasons', () => {
  const parsed = {
    sources_read: [{ code: 'FMC', url: 'https://www.findmecomics.com/reading-lists/dc-ko' }, { code: 'RO', url: 'https://www.readingorders.com/x' }],
    issues: [{ series_name: 'DC K.O.', issue_number: '1', sources: ['FMC', 'RO', 'CBT', 'AI', 'FMC'], order_note: '  ', tier_reason: '  Main series; RO Essential  ' },
      { series_name: 'Superman', issue_number: '34', sources: ['CBT'], order_note: 'Part 3 of 4' }],
    omitted: [{ series_name: 'Justice League Unlimited', issue_number: '1-10', volume_year: null, listed_by: ['RO', 'CBT'], reason: 'Background run' },
      { series_name: 'Justice League Red', issue_number: '4', volume_year: '2025', listed_by: ['HTLC'], reason: '' }],
  };
  const r = cleanSources(parsed);
  assert.deepEqual(parsed.issues[0].sources, ['FMC', 'RO', 'AI']);
  assert.equal(parsed.issues[0].order_note, null);
  assert.equal(parsed.issues[0].tier_reason, 'Main series; RO Essential');
  assert.equal(parsed.issues[1].tier_reason, null);
  assert.deepEqual(parsed.issues[1].sources, []);
  assert.equal(parsed.issues[1].order_note, 'Part 3 of 4');
  assert.equal(r.dropped, 3);
  assert.deepEqual(r.omitted[0].listed_by, ['RO']);
  assert.equal(r.noReason, 1);
  assert.equal(r.sourcesRead.length, 2);
});

const iss = (n, date, extra = {}) => ({ series_name: 'S', issue_number: String(n), release_date: date, release_date_kind: 'store', tier: 'recommended', ...extra });

test('releaseFlags: the moved issue is flagged, not its neighbours', () => {
  // JLU #14 (Dec 24) read after late-January issues — v1's DC K.O. drift.
  const list = [iss(1, '2025-12-10'), iss(2, '2025-12-17'), iss(3, '2026-01-14'), iss(4, '2026-01-28'), iss(14, '2025-12-24'), iss(5, '2026-02-11')];
  assert.equal(releaseFlags(list), 1);
  assert.deepEqual(list.map(i => i.order_flag), [null, null, null, null, 'late', null]);
});

test('releaseFlags: a stated reason, cover dates, aftermath and small moves are not flagged', () => {
  const list = [iss(1, '2026-01-07'), iss(2, '2026-02-25', { order_note: 'Guide: read before #3' }), iss(3, '2026-01-21'),
    iss(4, '2025-11-01', { release_date_kind: 'cover' }), iss(5, '2026-01-28'), iss(6, '2026-01-21'), iss(7, '2025-06-01', { tier: 'aftermath' })];
  assert.equal(releaseFlags(list), 0);
});

test('releaseFlags: an issue read weeks early is flagged early', () => {
  const list = [iss(1, '2026-01-07'), iss(9, '2026-03-04'), iss(2, '2026-01-14'), iss(3, '2026-01-21')];
  releaseFlags(list);
  assert.deepEqual(list.map(i => i.order_flag), [null, 'early', null, null]);
});

test('toolReport: sums every call and sizes each search and page read', () => {
  const { toolReport } = require('./eventSources');
  const r1 = { usage: { input_tokens: 100, output_tokens: 10, server_tool_use: { web_search_requests: 1, web_fetch_requests: 1 } },
    content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'DC K.O. reading order' } },
      { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://a' }, { type: 'web_search_result', url: 'https://b' }] },
      { type: 'server_tool_use', id: 'f1', name: 'web_fetch', input: { url: 'https://www.findmecomics.com/reading-lists/dc-ko' } },
      { type: 'web_fetch_tool_result', tool_use_id: 'f1', content: { type: 'web_fetch_result', url: 'https://www.findmecomics.com/reading-lists/dc-ko', content: { type: 'document', source: { type: 'text', data: 'x'.repeat(1000) } } } }],
    stop_reason: 'pause_turn' };
  const r2 = { usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 7 },
    content: [{ type: 'server_tool_use', id: 'f2', name: 'web_fetch', input: { url: 'https://x' } },
      { type: 'web_fetch_tool_result', tool_use_id: 'f2', content: { type: 'web_fetch_tool_error', error_code: 'url_not_accessible' } }, { type: 'text', text: '{}' }] };
  const rep = toolReport([r1, r2]);
  assert.equal(rep.calls, 2);
  assert.deepEqual(rep.usage, { input: 150, output: 15, cache_read: 7, cache_write: 0, searches: 1, fetches: 1 });
  assert.equal(rep.searches[0].query, 'DC K.O. reading order'); assert.equal(rep.searches[0].results, 2);
  assert.equal(rep.pages.length, 2);
  assert.ok(rep.pages[0].chars > 1000 && !rep.pages[0].failed);
  assert.equal(rep.pages[1].url, 'https://x'); assert.equal(rep.pages[1].failed, true);
});

test('unbrokenPhases: a thread label inside another phase joins it; a returning name joins the current phase', () => {
  const { unbrokenPhases } = require('./eventSources');
  const mk = ph => ph.map((p, k) => ({ sort_order: k + 1, phase: p }));
  const a = mk(['Prelude', 'Arena', 'Arena', 'Evac', 'Arena', 'Final', 'Evac', 'Final', 'Aftermath']);
  assert.equal(unbrokenPhases(a), 2);
  assert.deepEqual(a.map(i => i.phase), ['Prelude', 'Arena', 'Arena', 'Arena', 'Arena', 'Final', 'Final', 'Final', 'Aftermath']);
  const b = mk(['One', 'Two', 'Three', 'One']);
  assert.equal(unbrokenPhases(b), 1);
  assert.equal(b[3].phase, 'Three');
  const c = mk(['Prelude', 'One', 'Prelude', 'Two', 'Aftermath', 'Two', 'Aftermath']);
  unbrokenPhases(c);
  assert.equal(c[2].phase, 'Prelude');                       // Prelude/Aftermath are left alone
  const d = mk(['One', 'One', 'Two', 'Two', null]);
  assert.equal(unbrokenPhases(d), 0);
});

test('cleanSources: a pasted guide page (USER, no address) keeps its codes', () => {
  const parsed = { sources_read: [{ code: 'MET', url: 'https://metron.cloud/api/reading_list/185/' }, { code: 'USER', url: '' }],
    issues: [{ sources: ['MET', 'USER'] }], omitted: [{ series_name: 'Hourman', issue_number: '1', listed_by: ['USER'], reason: 'revisit' }] };
  const r = cleanSources(parsed);
  assert.deepEqual(r.sourcesRead.map(s => s.code), ['MET', 'USER']);
  assert.deepEqual(parsed.issues[0].sources, ['MET', 'USER']);
  assert.deepEqual(r.omitted[0].listed_by, ['USER']);
  assert.equal(r.dropped, 0);
});
