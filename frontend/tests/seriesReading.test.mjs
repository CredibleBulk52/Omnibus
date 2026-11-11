import test from 'node:test';
import assert from 'node:assert/strict';
import { markSeriesRead } from '../src/pages/seriesReading.mjs';
const ok = content => ({ ok: true, json: async () => ({content}) });
test('marks all owned books, including special categories, once after confirmation', async () => {
  const calls = [];
  const count = await markSeriesRead('series/1', 'Green Lantern', async (...args) => {
    calls.push(args);
    return calls.length === 1 ? ok([{id:'regular'}, {id:'annual'}, {id:'special'}, {id:'annual'}]) : {ok:true};
  }, message => { assert.match(message, /all 3 owned issues/); assert.match(message, /only your reading progress/); return true; });
  assert.equal(count, 3);
  assert.match(calls[0][0], /series%2F1\/books\?includeAll=true/);
  assert.deepEqual(JSON.parse(calls[1][1].body), {bookIds:['regular','annual','special'],completed:true});
});
test('cancellation never sends an update', async () => {
  let calls = 0;
  assert.equal(await markSeriesRead('s', 'Title', async () => { calls++; return ok([{id:'1'}]); }, () => false), null);
  assert.equal(calls, 1);
});
test('empty series requires no confirmation or update', async () => {
  assert.equal(await markSeriesRead('s', 'Title', async () => ok([]), () => { throw Error('Unexpected confirmation'); }), 0);
});
test('load and update failures are reported rather than treated as success', async () => {
  await assert.rejects(markSeriesRead('s', 'Title', async () => ({ok:false}), () => true), /Unable to load/);
  let calls = 0;
  await assert.rejects(markSeriesRead('s', 'Title', async () => ++calls === 1 ? ok([{id:'1'}]) : {ok:false}, () => true), /update failed/);
  await assert.rejects(markSeriesRead('s', 'Title', async () => ok(null), () => true), /Unexpected issue list/);
});
test('mark series unread sends completed:false after its own confirmation', async () => {
  const calls = [];
  const count = await markSeriesRead('s', 'Showcase', async (...args) => { calls.push(args); return calls.length === 1 ? ok([{id:'1'},{id:'2'}]) : {ok:true}; },
    message => { assert.match(message, /as unread/); assert.match(message, /clears your reading progress/); return true; }, false);
  assert.equal(count, 2);
  assert.deepEqual(JSON.parse(calls[1][1].body), {bookIds:['1','2'],completed:false});
});
