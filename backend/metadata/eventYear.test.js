'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {eventYearMatches}=require('./eventYear');
test('event validation and fallback assignment reject stale monitoring year evidence consistently',()=>{
 const book={cv_issue_id:'2',comicinfo:'<ComicInfo><Year>2026</Year></ComicInfo>',syear:2026};
 assert.equal(eventYearMatches({volumeYear:1940,cvIssueId:'1',book}),false);
 assert.equal(eventYearMatches({volumeYear:2024,cvIssueId:'1',book}),true);
 assert.equal(eventYearMatches({volumeYear:null,cvIssueId:'1',book}),true);
});
test('exact publication identity permits long-running series without clear/rematch loops',()=>{
 assert.equal(eventYearMatches({volumeYear:1940,cvIssueId:'1',book:{cv_issue_id:'1',comicinfo:'<ComicInfo><Year>2026</Year></ComicInfo>'}}),true);
 assert.equal(eventYearMatches({volumeYear:1940,cvIssueId:'1',book:{comicinfo:'<ComicInfo><Year>2026</Year><Notes>CVDB1</Notes></ComicInfo>'}}),true);
 assert.equal(eventYearMatches({volumeYear:1940,cvIssueId:'1',book:{comicinfo:'<ComicInfo><Year>2026</Year><Notes>CVDB1 CVDB2</Notes></ComicInfo>'}}),false);
});
