import test from 'node:test';
import assert from 'node:assert/strict';
import { browseIssues } from '../src/utils/browseIssues.mjs';
const issues=[{id:1,issue_number:'001',title:'Beginning',status:'processed',has_comicinfo:1},{id:2,issue_number:'2',title:'Return',status:'processed',has_comicinfo:0},{id:3,issue_number:'3',status:'wanted',waiting:{}},{id:4,issue_number:'4',status:'wanted',in_pack:true}];
test('number and title search including hash and padded numbers',()=>{
 assert.deepEqual(browseIssues(issues,'#1').map(i=>i.id),[1]);
 assert.deepEqual(browseIssues(issues,'RETURN').map(i=>i.id),[2]);
});
test('filters reflect displayed processing states',()=>{
 for(const [status,id] of [['processed',1],['untagged',2],['waiting',3],['snatched',4]]) assert.deepEqual(browseIssues(issues,'',status).map(i=>i.id),[id]);
});
test('reverse order does not mutate input, empty matches stay empty',()=>{
 assert.deepEqual(browseIssues(issues,'','all','newest').map(i=>i.id),[4,3,2,1]);
 assert.equal(issues[0].id,1); assert.equal(browseIssues(issues,'xyz').length,0);
});
