'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decideIdentity } = require('./identity');
const { planMetadataMerge } = require('./merge');
const xml = body => `<ComicInfo><Notes>CVDB123</Notes>${body}</ComicInfo>`;
function plan(body, fields, options = {}) {
  const currentXml = xml(body);
  return planMetadataMerge({ bookId:'sb_test', currentXml, decision:decideIdentity({bookId:'sb_test',arrival:'scanner',comicInfoXml:currentXml}), source:{cvIssueId:'123',fields}, ...options });
}
const record = fields => ({bookId:'sb_test',cvIssueId:'123',fields});
test('fills absent fields and records managed values only for proposed updates',()=>{
 const r=plan('',{Writer:'A',Volume:1963}); assert.equal(r.status,'ready'); assert.equal(r.patches.length,2); assert.deepEqual(r.managedFieldsAfterApply,{Volume:'1963',Writer:'A'});
});
test('source blanks preserve useful values and ownership',()=>{
 const r=plan('<Writer>A</Writer>',{Writer:'  ',Title:null},{previous:record({Writer:'A'})}); assert.equal(r.status,'unchanged'); assert.equal(r.changed,false); assert.deepEqual(r.managedFieldsAfterApply,{Writer:'A'});
});
test('Comic Vine replaces descriptive metadata Omnibus never wrote',()=>{
 const r=plan('<Writer>Original</Writer>',{Writer:'New'}); assert.equal(r.status,'ready'); assert.equal(r.patches[0].after,'New'); assert.equal(r.patches[0].reason,'comic_vine_authority'); assert.deepEqual(r.managedFieldsAfterApply,{Writer:'New'});
});
test('matching managed fields refresh without accumulating obsolete creator credits',()=>{
 const r=plan('<Writer>A, B</Writer>',{Writer:'A, C'},{previous:record({Writer:'A, B'})}); assert.equal(r.patches[0].after,'A, C'); assert.equal(r.patches[0].reason,'refresh_managed_field');
});
test('external metadata edits lose automatic ownership and remain untouched',()=>{
 const r=plan('<Writer>My edit</Writer>',{Writer:'New'},{previous:record({Writer:'Old'})}); assert.equal(r.observations[0].reason,'externally_changed_field'); assert.deepEqual(r.managedFieldsAfterApply,{}); assert.deepEqual(r.patches,[]);
});
test('external clearing of a managed field is also an edit',()=>{
 const r=plan('<Writer/>',{Writer:'New'},{previous:record({Writer:'Old'})}); assert.equal(r.status,'unchanged'); assert.deepEqual(r.patches,[]);
});
test('explicit nonblank overrides win over source and prior metadata',()=>{
 const r=plan('<Writer>Old</Writer>',{Writer:'Source'},{overrides:record({Writer:'Manual'})}); assert.equal(r.patches[0].after,'Manual'); assert.equal(r.patches[0].reason,'manual_override'); assert.deepEqual(r.managedFieldsAfterApply,{});
});
test('intentional blank overrides clear existing values and remain locked',()=>{
 const options={overrides:record({Writer:''})}; const first=plan('<Writer>Old</Writer>',{Writer:'Source'},options); assert.equal(first.patches[0].after,''); const second=plan('<Writer/>',{Writer:'Source'},options); assert.equal(second.status,'unchanged'); assert.deepEqual(second.patches,[]);
});
test('equal imported values are not silently adopted as managed',()=>{
 const r=plan('<Writer>A</Writer>',{Writer:'A'}); assert.equal(r.status,'unchanged'); assert.deepEqual(r.managedFieldsAfterApply,{});
});
test('numeric zero is meaningful; surrounding whitespace alone causes no rewrite',()=>{
 assert.equal(plan('<Number>0</Number>',{Number:0}).changed,false); assert.equal(plan('<Writer> A </Writer>',{Writer:'A'}).changed,false);
});
test('unknown XML, notes and page annotations remain byte-for-byte in original XML',()=>{
 const body='<Custom foo="bar">keep</Custom><Pages><Page Image="0" Bookmark="Start"/></Pages>'; const r=plan(body,{Writer:'A'}); assert.equal(r.originalXml,xml(body)); assert.deepEqual(r.patches.map(p=>p.field),['Writer']);
});
test('structured and repeated managed fields require review',()=>{
 for(const body of ['<Writer>A</Writer><Writer>B</Writer>','<Writer><Name>A</Name></Writer>']) {const r=plan(body,{Writer:'C'},{overrides:record({Writer:'C'})}); assert.equal(r.review[0].reason,'non_scalar_or_repeated_field'); assert.equal(r.patches.length,0);}
});
test('malformed XML stays blocked even under explicit identity correction',()=>{
 const currentXml='<ComicInfo>'; const decision=decideIdentity({bookId:'sb_test',arrival:'scanner',comicInfoXml:currentXml,explicitIssueId:'123'}); const r=planMetadataMerge({bookId:'sb_test',decision,currentXml,source:{cvIssueId:'123',fields:{Writer:'A'}}}); assert.equal(r.reason,'existing_metadata_unreadable'); assert.equal(r.originalXml,currentXml);
});
test('unaccepted identity and wrong source publication block changes',()=>{
 assert.equal(plan('',{Writer:'A'},{decision:{bookId:'sb_test',status:'needs_review'}}).reason,'identity_not_accepted'); assert.equal(plan('',{}, {source:{cvIssueId:'456',fields:{Writer:'A'}}}).reason,'source_identity_mismatch');
});
test('previous fields and overrides cannot leak across physical books or identities',()=>{
 for(const kind of ['previous','overrides']) { assert.equal(plan('',{}, {[kind]:{bookId:'other',cvIssueId:'123',fields:{}}}).reason,'field_record_book_mismatch'); assert.equal(plan('',{}, {[kind]:{bookId:'sb_test',cvIssueId:'456',fields:{}}}).reason,'field_record_identity_mismatch'); }
});
test('automatic identity correction holds every publication field for review, including fields absent at source',()=>{
 const currentXml=xml('<Writer>Wrong issue</Writer><Summary>Old summary</Summary>'); const decision={...decideIdentity({bookId:'sb_test',arrival:'scanner',comicInfoXml:currentXml,downloadIssueId:'456'}),status:'accepted',cvIssueId:'456',reason:'supported_issue_identity'}; const r=planMetadataMerge({bookId:'sb_test',decision,currentXml,source:{cvIssueId:'456',fields:{Writer:'Correct issue'}}}); assert.equal(r.status,'needs_review'); assert.equal(r.changed,false); assert.ok(r.review.some(x=>x.field==='Summary' && x.before==='Old summary')); assert.deepEqual(r.managedFieldsAfterApply,{});
});
test('repeated planning is deterministic and does not mutate its inputs',()=>{
 const previous=record({Writer:'A'}); const overrides=record({Title:'My title'}); const before=structuredClone({previous,overrides}); const a=plan('<Writer>A</Writer>',{Writer:'B'},{previous,overrides}); const b=plan('<Writer>A</Writer>',{Writer:'B'},{previous,overrides}); assert.deepEqual(a,b); assert.deepEqual({previous,overrides},before);
});
test('a successful patch applied to scalar fixture fields makes the next plan unchanged',()=>{
 const first=plan('<Writer>A</Writer>',{Writer:'B'},{previous:record({Writer:'A'})}); const second=plan('<Writer>B</Writer>',{Writer:'B'},{previous:record(first.managedFieldsAfterApply)}); assert.equal(second.status,'unchanged');
});
test('missing source fields do not clear existing managed ownership',()=>{
 const r=plan('<Writer>A</Writer>',{}, {previous:record({Writer:'A'})}); assert.equal(r.status,'unchanged'); assert.deepEqual(r.managedFieldsAfterApply,{Writer:'A'});
});
test('metadata API rejects paths, filing order, identity links and structured values',()=>{
 for(const fields of [{path:'new'},{sort_order:1},{Web:'https://comicvine.com/a/4000-456/'},{Pages:[]},{Writer:['A']},{Writer:true}]) assert.throws(()=>plan('',fields),TypeError);
});

test('numeric date padding does not create conflicts, changes or ownership',()=>{
 const r=plan('<Year>2026</Year><Month>01</Month><Day>09</Day>',{Year:2026,Month:1,Day:9});assert.equal(r.status,'unchanged');assert.deepEqual(r.managedFieldsAfterApply,{});
});
test('numeric equivalence recognizes owned dates while keeping publication-number spelling distinct',()=>{
 const r=plan('<Month>01</Month>',{Month:2},{previous:record({Month:'1'})});assert.equal(r.patches.length,0);assert.equal(plan('<Number>020</Number>',{Number:'20'}).status,'unchanged');assert.equal(plan('<Number>1.10</Number>',{Number:'1.1'}).patches[0].after,'1.1');
});

test('presentation equivalence keeps originals without claiming ownership',()=>{
 const r=plan('<Summary>A\n B</Summary><Writer>A,B</Writer>',{Summary:'A B',Writer:'A, B'});assert.equal(r.status,'unchanged');assert.equal(r.observations.length,0);assert.deepEqual(r.managedFieldsAfterApply,{});
 for(const [before,after] of [['AB','A B'],['A!','A'],['Title','title']]) assert.equal(plan(`<Summary>${before}</Summary>`,{Summary:after}).patches[0].after,after);
});
test('description disagreements and missing credits both take Comic Vine values',()=>{
 const r=plan('<Summary>Keep rich Markdown</Summary>',{Summary:'Other text',Writer:'A'});assert.equal(r.status,'ready');assert.deepEqual(r.patches.map(p=>p.field).sort(),['Summary','Writer']);assert.equal(r.observations.length,0);
});
test('a Number from another source is replaced; one changed after Omnibus wrote it is held',()=>{
 const r=plan('<Number>1035.1</Number>',{Number:'1',Writer:'A'});assert.equal(r.status,'ready');assert.equal(r.patches.find(p=>p.field==='Number').after,'1');
 const held=plan('<Number>1035.1</Number>',{Number:'1'},{previous:record({Number:'2'})});assert.equal(held.status,'needs_review');assert.equal(held.review[0].reason,'externally_changed_field');
});
test('partial date overrides require a complete explicit date choice',()=>{
 const r=plan('<Year>2026</Year><Month>9</Month>',{}, {overrides:record({Month:'10'})});assert.equal(r.status,'needs_review');assert.equal(r.patches.length,0);
 const full=plan('<Year>2026</Year><Month>9</Month><Day>16</Day>',{}, {overrides:record({Year:'2026',Month:'10',Day:''})});assert.equal(full.status,'ready');assert.equal(full.patches.length,2);
});

test('date provenance survives blank source and refuses invalid or mismatched date claims',()=>{
 const fields={Year:'2026',Month:'9'};const previous={...record(fields),date:{basis:'cover_date',precision:'month',value:'2026-09'}};
 const r=plan('<Year>2026</Year><Month>09</Month>',{}, {previous});assert.deepEqual(r.managedDateAfterApply,previous.date);assert.deepEqual(r.managedFieldsAfterApply,fields);
 for(const date of [{basis:'cover_date',precision:'month',value:'2026-13'},{basis:'store_date',precision:'day',value:'2026-02-30'},{basis:'cover_date',precision:'month',value:'2026-08'}]) {
  const bad=plan('',fields,{source:{cvIssueId:'123',fields,date}});assert.equal(bad.patches.length,0);assert.equal(bad.managedDateAfterApply,null);
 }
});
test('a source basis change retains the previous managed date as a whole',()=>{
 const fields={Year:'2026',Month:'9',Day:'16'};const previous={...record(fields),date:{basis:'store_date',precision:'day',value:'2026-09-16'}};
 const r=plan('<Year>2026</Year><Month>9</Month><Day>16</Day>',{}, {previous,source:{cvIssueId:'123',fields:{Year:'2026',Month:'10'},date:{basis:'cover_date',precision:'month',value:'2026-10'}}});
 assert.equal(r.patches.length,0);assert.deepEqual(r.managedFieldsAfterApply,fields);assert.deepEqual(r.managedDateAfterApply,previous.date);
});
