'use strict';
const { createHash } = require('node:crypto');
const { collectMetadataEvidence, parseCvIssueId } = require('./evidence');
const POLICY_VERSION = 'identity-v2';
const {candidateMatches}=require('./candidate');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}

// Pure decision only. No candidate fetch, persistence, or permission to replace archive metadata.
function decideIdentity(input, { provider = 'comicvine', manualOverride = null } = {}) {
  const evidence = collectMetadataEvidence(input);
  const assertions = [...evidence.identities, ...evidence.embedded.identity.evidence.map(e => ({ source: e.source, cvIssueId: e.cvIssueId }))];
  const invalidOverride = manualOverride != null && (manualOverride.bookId !== evidence.bookId || !parseCvIssueId(manualOverride.cvIssueId));
  if (manualOverride != null && !invalidOverride) assertions.push({ source: 'manual_override', cvIssueId: parseCvIssueId(manualOverride.cvIssueId) });
  const warnings = [...evidence.diagnostics, ...evidence.embedded.diagnostics];
  const finish = (status, reason, id = null, acceptedSources = []) => ({
    bookId: evidence.bookId, status, reason, cvIssueId: id,
    lookup: status === 'accepted' ? { strategy: 'issue_id', cvIssueId: id } : status === 'needs_identification' ? { strategy: 'discover_candidates' } : null,
    // A manual identity correction cannot authorize destroying unreadable existing metadata.
    metadataReviewRequired: evidence.embedded.status === 'invalid' || evidence.embedded.identity.status === 'invalid',
    provenance: {
      policyVersion: POLICY_VERSION, provider, arrival: evidence.arrival,
      evidenceHash: createHash('sha256').update(JSON.stringify(canonical({ evidence, folderName:input.folderName||null, provider, manualOverride, candidate:input.candidate||null }))).digest('hex'),
      assertions, acceptedSources, warnings,
      superseded: id ? assertions.filter(a => a.cvIssueId !== id) : [],
      reason,
    },
  });
  if (evidence.diagnostics.includes('invalid_explicit_identity')) return finish('needs_review', 'invalid_explicit_identity');
  const explicit = evidence.identities.find(a => a.source === 'explicit');
  if (provider !== 'comicvine') return finish(explicit || manualOverride ? 'needs_review' : 'not_applicable', explicit || manualOverride ? 'provider_identity_conflict' : 'provider_not_comicvine');
  if (explicit) return finish('accepted', 'explicit_correction', explicit.cvIssueId, ['explicit']);
  if (invalidOverride) return finish('needs_review', 'invalid_manual_override');
  if (manualOverride) return finish('accepted', 'manual_override', parseCvIssueId(manualOverride.cvIssueId), ['manual_override']);
  if (evidence.embedded.status === 'invalid' || evidence.embedded.identity.status === 'invalid') return finish('needs_review', 'invalid_embedded_metadata');
  if (evidence.diagnostics.length) return finish('needs_review', 'invalid_identity_assertion');
  if (evidence.embedded.identity.status === 'conflict') return finish('needs_review', 'conflicting_embedded_identities');
  const strong = assertions.filter(a => a.source === 'download' || a.source.startsWith('comicinfo.'));
  const ids = [...new Set(strong.map(a => a.cvIssueId))];
  if (ids.length > 1) return finish('needs_review', 'conflicting_automatic_identities');
  const indexed = assertions.find(a => a.source === 'library_index');
  if(!ids.length&&input.candidate&&candidateMatches({...input,...input.candidate})) {
    const proposed=parseCvIssueId(input.candidate.issue.id);
    if(indexed&&indexed.cvIssueId!==proposed)return finish('needs_review','indexed_identity_conflict');
    return finish('accepted','corroborated_publication',proposed,['provider_candidate','publication_evidence']);
  }
  if (ids.length === 1) {
    if (indexed && indexed.cvIssueId !== ids[0]) return finish('needs_review', 'indexed_identity_conflict');
    return finish('accepted', 'supported_issue_identity', ids[0], [...new Set(strong.map(a => a.source))]);
  }
  if (indexed) return finish('needs_review', 'indexed_identity_unverified');
  if (evidence.filename.requiresReview) return finish('needs_review', 'ambiguous_filename');
  // Folder, filename, monitoring and AI suggestions never establish issue identity alone.
  return finish('needs_identification', 'insufficient_issue_evidence');
}

module.exports = { POLICY_VERSION, decideIdentity };
