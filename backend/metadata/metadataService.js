'use strict';
const {decideIdentity}=require('./identity');
const {planMetadataMerge}=require('./merge');
const {adaptCvSource}=require('./cvSource');
const {parseComicInfoEvidence,filenameEvidence,parseIssueNumberEvidence}=require('./evidence');
function planBookMetadata({bookId,arrival='scanner',filename,folderName=null,currentXml,indexedIssueId=null,explicitIssueId=null,downloadIssueId=null,
  candidate=null,source,previous=null,overrides=null,profile=null}) {
  const decision=decideIdentity({bookId,arrival,filename,folderName,comicInfoXml:currentXml,indexedIssueId,explicitIssueId,downloadIssueId,candidate});
  if(decision.status!=='accepted')throw Object.assign(new Error(decision.reason),{code:'IDENTITY_REVIEW_REQUIRED'});
  const adapted=adaptCvSource({expectedIssueId:decision.cvIssueId,...source});
  if(adapted.status!=='ready')throw Object.assign(new Error(adapted.reason),{code:'SOURCE_UNAVAILABLE'});
  // Preserve the existing manga convention: Volume is its numbered volume,
  // Number is the publication issue, and Manga controls reading direction.
  if(profile==='manga'||parseComicInfoEvidence(currentXml).fields.manga?.some(value=>/^yes/i.test(value))){
    adapted.source.fields.Volume=String(source.issue.issue_number);
    adapted.source.fields.Manga='YesAndRightToLeft';
  }
  const filenameFacts=filenameEvidence(filename);
  // Downloads already know their Comic Vine issue; the filename is only a
  // cross-check for a mislabelled release. Block only on a lettered insert/
  // variant or when no number in the name agrees with the issue.
  const expectedNumber=parseIssueNumberEvidence(source.issue.issue_number).normalized;
  if(downloadIssueId&&(filenameFacts.candidates.some(c=>c.suffix&&c.requiresReview)||(filenameFacts.candidates.length&&!filenameFacts.candidates.some(c=>c.normalized===expectedNumber))))
    throw Object.assign(new Error('Download filename contradicts the intended publication'),{code:'CV_ISSUE_MISMATCH'});
  const plan=planMetadataMerge({bookId,decision,currentXml,source:adapted.source,previous,overrides});
  if(!['ready','unchanged'].includes(plan.status)||plan.review.length)throw Object.assign(new Error(plan.review.length?'Metadata needs review: '+plan.review.map(r=>`${r.field||'Identity'} (${r.reason})`).join(', '):plan.reason||'Metadata requires review'),{code:'METADATA_REVIEW_REQUIRED'});
  return {bookId,cvIssueId:decision.cvIssueId,plan,overrides,publicationDate:adapted.publicationDate,publicationDateSource:adapted.publicationDateSource,publicationDatePrecision:adapted.publicationDatePrecision,identityProvenance:decision.provenance,
    initializeIdentity:!parseComicInfoEvidence(currentXml).identity.ids.length};
}
module.exports={planBookMetadata};
