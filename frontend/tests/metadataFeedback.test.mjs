import test from 'node:test';
import assert from 'node:assert/strict';
import {updateReceipt,checkResult} from '../src/pages/metadataFeedback.js';
const receipt={id:'a',watching:true,previousCheckedAt:100,requestedAt:200,message:'Requested'};
const book={id:'a',checked_at:300,manual_requested_at:null,state:'queued'};
test('completion is reported even if the filtered list is empty',()=>{
 const result=updateReceipt(receipt,{books:[],trackedBooks:[book]},['a']);
 assert.equal(result.watching,false);assert.equal(result.phase,'done');assert.match(result.message,/kept or updated/);
});
test('old results, missing tracking responses and active writers cannot imply completion',()=>{
 assert.equal(updateReceipt(receipt,{books:[]},['a']),receipt);
 assert.equal(updateReceipt(receipt,{trackedBooks:[book]},[]),receipt);
 assert.equal(updateReceipt(receipt,{trackedBooks:[{...book,checked_at:100}]},['a']).watching,true);
 assert.equal(updateReceipt(receipt,{trackedBooks:[book],runningBookId:'a'},['a']).phase,'running');
 assert.equal(updateReceipt(receipt,{trackedBooks:[book],activeOperations:[{bookId:'a'}]},['a']).watching,true);
});
test('review, provider delay, deletion and recovery are distinct outcomes',()=>{
 assert.equal(updateReceipt(receipt,{trackedBooks:[{...book,state:'review',last_error:'IDENTITY_REVIEW_REQUIRED'}]},['a']).phase,'attention');
 const delayed=updateReceipt(receipt,{trackedBooks:[{...book,state:'budget',last_error:'CV_RATE_LIMIT',due_at:Date.now()+60000}]},['a']);
 assert.equal(delayed.phase,'waiting');assert.equal(delayed.watching,false);assert.match(delayed.message,/Next eligible retry/);
 assert.match(updateReceipt(receipt,{trackedBooks:[]},['a']).message,/no longer in the library/);
 assert.match(updateReceipt(receipt,{trackedBooks:[{...book,checked_at:100}],unfinished:[{}]},['a']).message,/recovery/);
 assert.doesNotMatch(checkResult({completed:1}),/were updated/);
});
