'use strict';
const { decideIdentity } = require('./identity');
const { adaptCvSource } = require('./cvSource');
const { planMetadataMerge } = require('./merge');

// Supplied snapshots only: this module never retrieves data, records a successful check, or applies a patch.
function planMetadataDryRun({ evidence, provider = 'comicvine', manualOverride = null, issue = null, volume = null, previous = null, overrides = null } = {}) {
  const decision=decideIdentity(evidence,{provider,manualOverride});
  const result={bookId:decision.bookId,dryRun:true,status:decision.status,reason:decision.reason,decision,adapted:null,merge:null};
  if(decision.status!=='accepted') return result;
  if(!issue) return {...result,status:'waiting_for_source',reason:'issue_snapshot_required'};
  const adapted=adaptCvSource({expectedIssueId:decision.cvIssueId,issue,volume});
  if(adapted.status!=='ready') return {...result,status:'needs_review',reason:adapted.reason,adapted};
  const merge=planMetadataMerge({bookId:decision.bookId,decision,currentXml:evidence.comicInfoXml,source:adapted.source,previous,overrides});
  return {...result,status:merge.status,reason:merge.reason,adapted,merge};
}
module.exports={planMetadataDryRun};
