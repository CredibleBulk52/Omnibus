'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const {planMetadataDryRun}=require('./dryRun'); const {adaptCvSource}=require('./cvSource');
const issue={id:123,issue_number:'1',name:'Title',volume:{id:99,name:'Actual Publication'},cover_date:'2026-10-01',store_date:'2026-09-16'};
const volume={id:99,name:'Actual Publication',start_year:'1963',publisher:{name:'Publisher'}};
const evidence={bookId:'sb_one',arrival:'scanner',filename:'Reading order #443b.cbz',comicInfoXml:'<ComicInfo><Notes>CVDB123</Notes></ComicInfo>',folderMetadata:{metadata:{comicid:'111',year:1999,name:'Wrong Folder'}}};
const run=(extra={})=>planMetadataDryRun({evidence,issue,volume,...extra});
test('all arrival paths produce the same field plan from actual publication data',()=>{
 for(const arrival of ['download','import','scanner']) {const r=run({evidence:{...evidence,arrival}});assert.equal(r.status,'ready');assert.ok(r.merge.patches.some(p=>p.field==='Volume'&&p.after==='1963'));assert.ok(r.merge.patches.some(p=>p.field==='Series'&&p.after==='Actual Publication'));assert.equal(r.merge.originalXml,evidence.comicInfoXml);}
});
test('first download accepts known issue, then fills late credits without rewriting known fields',()=>{
 const r=run({evidence:{bookId:'sb_one',arrival:'download',downloadIssueId:'123'}});assert.equal(r.status,'ready');
 const fields=r.merge.managedFieldsAfterApply;
 const body=Object.entries(fields).map(([k,v])=>`<${k}>${v}</${k}>`).join('');
 const updatedEvidence={...evidence,comicInfoXml:`<ComicInfo><Notes>CVDB123</Notes>${body}</ComicInfo>`};
 const later=run({evidence:updatedEvidence,issue:{...issue,person_credits:[{name:'Writer',role:'writer'}]},previous:{bookId:'sb_one',cvIssueId:'123',fields}});
 assert.deepEqual(later.merge.patches.map(p=>p.field),['Writer']);
});
test('source changes outside mapped metadata cause no rewrite',()=>{
 const local='<ComicInfo><Notes>CVDB123</Notes><Number>1</Number><Title>Title</Title></ComicInfo>';
 const simple={id:123,issue_number:'1',name:'Title',image:{url:'new'}};
 const r=run({evidence:{...evidence,comicInfoXml:local},issue:simple,volume:null});assert.equal(r.status,'unchanged');
});
test('missing volume never borrows folder year or cover year',()=>{
 const r=run({volume:null});assert.equal(r.adapted.needsVolume,true);assert.equal(r.adapted.source.fields.Volume,undefined);assert.equal(r.adapted.source.fields.Publisher,undefined);
});
test('wrong and unlinked volume snapshots block plans',()=>{
 assert.equal(run({volume:{...volume,id:100}}).reason,'source_volume_mismatch');
 assert.equal(run({issue:{...issue,volume:undefined}}).reason,'source_volume_mismatch');
});
test('wrong issue or no source cannot become successful enrichment',()=>{
 assert.equal(run({issue:{...issue,id:456}}).reason,'source_issue_mismatch');assert.equal(run({issue:null}).status,'waiting_for_source');
});
test('sparse records retain good existing metadata and intentional blank overrides',()=>{
 const r=run({evidence:{...evidence,comicInfoXml:'<ComicInfo><Notes>CVDB123</Notes><Writer>Keep</Writer><Summary/></ComicInfo>'},issue:{id:123,description:'New summary'},volume:null,overrides:{bookId:'sb_one',cvIssueId:'123',fields:{Summary:''}}});assert.equal(r.status,'unchanged');assert.equal(r.merge.originalXml.includes('<Writer>Keep</Writer>'),true);
});
test('explicit correction replaces old publication fields rather than silently carrying them forward',()=>{
 const r=run({evidence:{...evidence,explicitIssueId:'456',comicInfoXml:'<ComicInfo><Notes>CVDB123</Notes><Writer>Old issue</Writer></ComicInfo>'},issue:{id:456,name:'New issue'},volume:null});assert.notEqual(r.status,'needs_review');assert.equal(r.merge.identityCorrection,true);
 assert.deepEqual(r.merge.patches.find(p=>p.field==='Writer'),{field:'Writer',before:'Old issue',after:'',reason:'identity_correction_cleared'});
});
test('folder plus number still cannot identify old import',()=>{
 const r=run({evidence:{...evidence,arrival:'import',filename:'Parent 001 (1963).cbz',comicInfoXml:null}});assert.equal(r.status,'needs_identification');assert.equal(r.adapted,null);
});
test('source-supplied publication names, not filename hints, determine Annual format',()=>{
 assert.equal(adaptCvSource({expectedIssueId:'123',issue,volume}).source.fields.Format,undefined);
 assert.equal(adaptCvSource({expectedIssueId:'123',issue,volume:{...volume,name:'Actual Annual'}}).source.fields.Format,'Annual');
});
test('metadata cover date and scheduling store date remain separate; invalid dates are rejected',()=>{
 const a=adaptCvSource({expectedIssueId:'123',issue,volume});assert.equal(a.source.fields.Month,'10');assert.equal(a.publicationDate,'2026-09-16');assert.equal(a.metadataDateSource,'cover_date');
 const b=adaptCvSource({expectedIssueId:'123',issue:{id:123,cover_date:'2026-02-30',store_date:'2026-00-00'}});assert.equal(b.source.fields.Year,undefined);assert.equal(b.publicationDate,null);
});
test('source credits deduplicate within roles and HTML is converted to plain text',()=>{
 const r=adaptCvSource({expectedIssueId:'123',issue:{id:123,description:'<p>A &amp; B</p><p>&#x1F600; &#99999999;</p>',person_credits:[{name:'A',role:'writer, editor'},{name:'A',role:'writer'},null],location_credits:[{name:'Place'}]}});
 assert.equal(r.source.fields.Writer,'A');assert.equal(r.source.fields.Editor,'A');assert.equal(r.source.fields.Locations,'Place');assert.ok(r.source.fields.Summary.includes('A & B'));assert.ok(r.source.fields.Summary.includes('😀'));
});
test('plans are deterministic and leave evidence and user state untouched',()=>{
 const input={evidence:structuredClone(evidence),issue:structuredClone(issue),volume:structuredClone(volume)};const before=structuredClone(input);assert.deepEqual(planMetadataDryRun(input),planMetadataDryRun(input));assert.deepEqual(input,before);
});
test('non-CV applicability and automatic conflicts exit before source adaptation',()=>{
 assert.equal(run({provider:'manga'}).status,'not_applicable');assert.equal(run({evidence:{...evidence,downloadIssueId:'456'}}).adapted,null);
});

test('cover dates have month precision while store-only dates have day precision',()=>{
 const a=adaptCvSource({expectedIssueId:'123',issue});assert.equal(a.source.fields.Day,undefined);assert.deepEqual(a.source.date,{basis:'cover_date',precision:'month',value:'2026-10'});
 const b=adaptCvSource({expectedIssueId:'123',issue:{id:123,store_date:'2026-09-16'}});assert.equal(b.source.fields.Day,'16');assert.equal(b.source.date.precision,'day');assert.equal(b.publicationDatePrecision,'day');
 const c=adaptCvSource({expectedIssueId:'123',issue:{id:123,cover_date:'2026-10-01'}});assert.equal(c.publicationDatePrecision,'month');
});
test('HTML table cells, rows and list items remain separated',()=>{
 const a=adaptCvSource({expectedIssueId:'123',issue:{id:123,description:'<table><tr><th>Cover</th><th>Artist</th></tr><tr><td>A</td><td>B</td></tr></table><ul><li>One</li><li>Two</li></ul>'}});
 assert.match(a.source.fields.Summary,/Cover \| Artist\n+A \| B/);assert.match(a.source.fields.Summary,/• One\n+• Two/);
});
test('unknown partial dates are preserved without mixing cover and store components',()=>{
 const r=run({evidence:{...evidence,comicInfoXml:'<ComicInfo><Notes>CVDB123</Notes><Year>2026</Year><Day>16</Day></ComicInfo>'}});
 assert.ok(!r.merge.patches.some(p=>['Year','Month','Day'].includes(p.field)));assert.ok(r.merge.observations.some(o=>o.reason==='date_group_preserved'));
});
test('date groups refresh only with coherent group ownership of the same basis',()=>{
 const local={...evidence,comicInfoXml:'<ComicInfo><Notes>CVDB123</Notes><Year>2026</Year><Month>09</Month></ComicInfo>'};
 const previous={bookId:'sb_one',cvIssueId:'123',fields:{Year:'2026',Month:'9'},date:{basis:'cover_date',precision:'month',value:'2026-09'}};
 const r=run({evidence:local,previous});assert.ok(r.merge.patches.some(p=>p.field==='Month'&&p.after==='10'));assert.equal(r.merge.managedDateAfterApply.value,'2026-10');
 const changed=run({evidence:local,previous:{...previous,date:{...previous.date,basis:'store_date'}}});assert.ok(!changed.merge.patches.some(p=>p.field==='Month'));
});
