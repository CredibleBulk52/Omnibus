import test from 'node:test';
import assert from 'node:assert/strict';
import { selectIssueRange } from '../src/utils/selectIssueRange.mjs';
test('range selects forwards and backwards, preserving other selections', () => {
 const ids=[1,2,3,4,5];
 assert.deepEqual([...selectIssueRange(new Set([5]),ids,3,1,true)],[5,1,2,3]);
 assert.deepEqual([...selectIssueRange(new Set(),ids,1,3,true)],[1,2,3]);
});
test('plain clicks toggle and missing anchors fall back to a single selection', () => {
 const old=new Set([2]);
 assert.deepEqual([...selectIssueRange(old,[1,2,3],2,1,false)],[]);
 assert.deepEqual([...old],[2]);
 assert.deepEqual([...selectIssueRange(old,[1,2,3],3,99,true)],[2,3]);
});
test('ranges follow visible order including annuals, excluding hidden rows', () => {
 assert.deepEqual([...selectIssueRange(new Set(),[3,1,20,21],21,1,true)],[1,20,21]);
 assert.deepEqual([...selectIssueRange(new Set(),[3,1],21,1,true)],[]);
});
