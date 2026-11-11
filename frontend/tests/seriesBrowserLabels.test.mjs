import test from 'node:test';
import assert from 'node:assert/strict';
import { seriesLabel } from '../src/components/seriesBrowserLabels.mjs';
test('keeps distinct volume years without duplicating them',()=>{
  assert.deepEqual(seriesLabel({displayTitle:'Green Lantern (1990)',displayYear:2005}),{title:'Green Lantern',year:'1990',fullTitle:'Green Lantern (1990)'});
  assert.equal(seriesLabel({displayTitle:'Green Lantern',displayYear:2005}).fullTitle,'Green Lantern (2005)');
});
test('preserves meaningful parentheses and unknown years',()=>{
  assert.deepEqual(seriesLabel({name:'Batman (Deluxe Edition)'}),{title:'Batman (Deluxe Edition)',year:'',fullTitle:'Batman (Deluxe Edition)'});
  assert.equal(seriesLabel({name:'The 100 (2016)',displayYear:'unknown'}).title,'The 100');
});
