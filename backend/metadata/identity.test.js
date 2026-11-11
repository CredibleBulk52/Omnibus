'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decideIdentity } = require('./identity');
const base = { bookId: 'sb_example', arrival: 'scanner', filename: 'Example 001 (2026).cbz' };
const tagged = id => `<ComicInfo><Series>Publication</Series><Notes>CVDB${id}</Notes></ComicInfo>`;
const cases = [
  ['embedded identity accepted', {comicInfoXml:tagged('123')}, {}, 'accepted','123','supported_issue_identity'],
  ['known download accepted', {arrival:'download',downloadIssueId:'123'}, {}, 'accepted','123','supported_issue_identity'],
  ['matching download and embedded accepted', {downloadIssueId:'123',comicInfoXml:tagged('123')}, {}, 'accepted','123','supported_issue_identity'],
  ['download conflicts with embedded', {downloadIssueId:'456',comicInfoXml:tagged('123')}, {}, 'needs_review',null,'conflicting_automatic_identities'],
  ['conflicting notes blocked', {comicInfoXml:'<ComicInfo><Notes>CVDB123 CVDB456</Notes></ComicInfo>'}, {}, 'needs_review',null,'conflicting_embedded_identities'],
  ['malformed XML blocks download fallback', {comicInfoXml:'<ComicInfo>',downloadIssueId:'123'}, {}, 'needs_review',null,'invalid_embedded_metadata'],
  ['invalid explicit ID blocks embedded fallback', {explicitIssueId:'bad',comicInfoXml:tagged('123')}, {}, 'needs_review',null,'invalid_explicit_identity'],
  ['explicit correction overrides conflicting assertions', {explicitIssueId:'789',downloadIssueId:'456',comicInfoXml:tagged('123'),indexedIssueId:'456'}, {}, 'accepted','789','explicit_correction'],
  ['stored manual override survives automatic disagreement', {comicInfoXml:tagged('123')}, {manualOverride:{bookId:'sb_example',cvIssueId:'456'}}, 'accepted','456','manual_override'],
  ['new correction supersedes stored override', {explicitIssueId:'789'}, {manualOverride:{bookId:'sb_example',cvIssueId:'456'}}, 'accepted','789','explicit_correction'],
  ['override for another physical book blocked', {}, {manualOverride:{bookId:'sb_other',cvIssueId:'456'}}, 'needs_review',null,'invalid_manual_override'],
  ['indexed ID alone is unverified', {indexedIssueId:'123'}, {}, 'needs_review',null,'indexed_identity_unverified'],
  ['indexed disagreement must be reviewed', {indexedIssueId:'456',comicInfoXml:tagged('123')}, {}, 'needs_review',null,'indexed_identity_conflict'],
  ['folder plus number insufficient', {folderMetadata:{metadata:{comicid:'123',name:'Example'}}}, {}, 'needs_identification',null,'insufficient_issue_evidence'],
  ['lettered insert not a parent issue', {filename:'Example #443b (Other #8).cbz'}, {}, 'needs_review',null,'ambiguous_filename'],
  ['embedded identity beats folder and filename clues', {filename:'Example #443b (Other #8).cbz',comicInfoXml:tagged('123'),folderMetadata:{comicid:'999'}}, {}, 'accepted','123','supported_issue_identity'],
  ['annual number plus folder insufficient', {filename:'Example 2026 Annual 001.cbz',folderMetadata:{comicid:'123'}}, {}, 'needs_identification',null,'insufficient_issue_evidence'],
  ['non-CV provider excluded explicitly', {}, {provider:'manga'}, 'not_applicable',null,'provider_not_comicvine'],
  ['explicit CV selection on non-CV provider needs review', {explicitIssueId:'123'}, {provider:'manga'}, 'needs_review',null,'provider_identity_conflict'],
  ['invalid download ID cannot silently fall through', {downloadIssueId:'bad',comicInfoXml:tagged('123')}, {}, 'needs_review',null,'invalid_identity_assertion'],
];
for (const [name, input, options, status, id, reason] of cases) test(name, () => {
  const result = decideIdentity({...base,...input}, options);
  assert.equal(result.status,status); assert.equal(result.cvIssueId,id); assert.equal(result.reason,reason);
  assert.equal(result.bookId,base.bookId);
  assert.equal(result.provenance.reason,reason);
  if (status==='accepted') assert.deepEqual(result.lookup,{strategy:'issue_id',cvIssueId:id});
  if (status==='needs_review' || status==='not_applicable') assert.equal(result.lookup,null);
});
test('manual identity acceptance does not authorize discarding malformed XML', () => {
  const result=decideIdentity({...base,explicitIssueId:'123',comicInfoXml:'<ComicInfo>'});
  assert.equal(result.status,'accepted'); assert.equal(result.metadataReviewRequired,true);
});
test('provenance captures superseded IDs and the exact accepted source', () => {
  const result=decideIdentity({...base,explicitIssueId:'123',comicInfoXml:tagged('456')});
  assert.deepEqual(result.provenance.acceptedSources,['explicit']);
  assert.deepEqual(result.provenance.superseded,[{source:'comicinfo.notes',cvIssueId:'456'}]);
});
test('provenance hash is deterministic across property ordering and changes when evidence changes', () => {
  const first=decideIdentity({...base,folderMetadata:{name:'A',year:2000}});
  const second=decideIdentity({...base,folderMetadata:{year:2000,name:'A'}});
  assert.equal(first.provenance.evidenceHash,second.provenance.evidenceHash);
  assert.notEqual(first.provenance.evidenceHash,decideIdentity({...base,folderMetadata:{name:'B',year:2000}}).provenance.evidenceHash);
});
test('input stays unchanged and provenance is JSON serializable', () => {
  const input={...base,comicInfoXml:tagged('123'),folderMetadata:{metadata:{comicid:'999'}}};
  const before=structuredClone(input); const result=decideIdentity(input);
  result.provenance.assertions[0].cvIssueId='changed';
  assert.deepEqual(input,before); assert.doesNotThrow(()=>JSON.stringify(result));
});
test('all three arrival paths yield the same publication decision', () => {
  for(const arrival of ['download','import','scanner']) assert.equal(decideIdentity({...base,arrival,comicInfoXml:tagged('123')}).cvIssueId,'123');
});
test('copies share publication identity but retain distinct work identity and provenance', () => {
  const a=decideIdentity({...base,comicInfoXml:tagged('123')});
  const b=decideIdentity({...base,bookId:'sb_second',comicInfoXml:tagged('123')});
  assert.equal(a.cvIssueId,b.cvIssueId); assert.notEqual(a.bookId,b.bookId);
  assert.notEqual(a.provenance.evidenceHash,b.provenance.evidenceHash);
});
test('monitoring IDs and AI candidates cannot act as supported identity evidence', () => {
  const result=decideIdentity({...base,monitoredIssueId:'123',aiCandidate:{cvIssueId:'123',confidence:1}});
  assert.equal(result.status,'needs_identification'); assert.equal(result.cvIssueId,null);
});
