import test from 'node:test';
import assert from 'node:assert/strict';
import {filterWeeklyIssues} from '../src/utils/weeklyIssues.mjs';
const items=[{volume:{name:'Batman',publisher:'DC'},issue_number:'001',monitored:true},{volume:{name:'Flash',publisher:'DC'},issue_number:'20',monitored:true,issue_status:'wanted'},{volume:{name:'Alien',publisher:'Marvel'},issue_number:'1',monitored:false}];
test('wanted is an issue state, not inferred from series monitoring',()=>assert.deepEqual(filterWeeklyIssues(items,'','all','wanted'),[items[1]]));
test('publisher, query and monitoring filters combine',()=>assert.deepEqual(filterWeeklyIssues(items,'bat','DC','monitored'),[items[0]]));
test('first issue recognizes zero-padded numbers',()=>assert.deepEqual(filterWeeklyIssues(items,'','all','first'),[items[0],items[2]]));
test('unmonitored and empty results',()=>{assert.deepEqual(filterWeeklyIssues(items,'','all','unmonitored'),[items[2]]);assert.deepEqual(filterWeeklyIssues(items,'xyz'),[]);});
