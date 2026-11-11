'use strict';

// Facts must come from a trusted synchronous storage adapter while the journal
// holds its write transaction. Missing means a verified absence on a reachable
// filesystem; an I/O/permission/mount error must be reported as unavailable.
const ROLES = ['source', 'destination', 'staged', 'backup', 'replacement'];
function equalFingerprint(a, b) {
  return !!a && !!b && a.sha256 === b.sha256 && a.size === b.size;
}
function validateFacts(facts) {
  for (const role of ROLES) {
    const fact = facts?.[role];
    if (!fact || !['missing', 'file', 'unavailable'].includes(fact.status)) throw new TypeError(`Explicit ${role} observation required`);
    if (fact.status === 'file' && (!/^[a-f0-9]{64}$/.test(fact.sha256) || !Number.isSafeInteger(fact.size) || fact.size < 0)) throw new TypeError(`Invalid ${role} fingerprint`);
  }
  return facts;
}
function fileIs(fact, fingerprint) { return fact.status === 'file' && equalFingerprint(fact, fingerprint); }
function missing(fact) { return fact.status === 'missing'; }

function assessRecovery(operation, execution, observations, samePath) {
  const hold = reason => ({ action: 'hold', reason });
  if (!operation.payload.artifacts) return hold('unsupported_intent');
  const facts = validateFacts(observations), p = operation.payload;
  if (ROLES.some(role => facts[role].status === 'unavailable')) return hold('storage_unavailable');
  if (p.replacement ? !fileIs(facts.replacement, p.replacement) : !missing(facts.replacement)) return hold('replacement_changed');
  const inPlace = samePath(p.source, p.destination);
  if (inPlace && JSON.stringify(facts.source) !== JSON.stringify(facts.destination)
    && !(facts.source.status === facts.destination.status && (missing(facts.source) || equalFingerprint(facts.source, facts.destination)))) return hold('inconsistent_path_observations');
  const original = fact => fileIs(fact, p.sourceFingerprint);
  const prepared = fact => fileIs(fact, execution?.prepared);
  if (!missing(facts.backup) && !execution?.backupStarted) return hold('unexpected_backup');
  if (!execution?.publishStarted && (!inPlace ? !missing(facts.destination) : !original(facts.source))) return hold('destination_collision');
  const backupSafe = missing(facts.backup) || original(facts.backup);
  const stagedSafe = missing(facts.staged) || prepared(facts.staged);
  if (!backupSafe) return hold('backup_changed');
  if (!stagedSafe) return hold('unverified_staging');
  if (!(original(facts.source) || missing(facts.source) || (inPlace && prepared(facts.source)))) return hold('source_changed');
  if (!inPlace && !(missing(facts.destination) || prepared(facts.destination))) return hold('destination_collision');
  if (!original(facts.source) && !original(facts.backup)) return hold('original_unavailable');
  const destinationOriginal = inPlace ? original(facts.destination) : missing(facts.destination);
  if (original(facts.source) && destinationOriginal && missing(facts.staged) && missing(facts.backup)) return { action: 'release', reason: 'original_intact' };
  // A prepared fingerprint is needed for any cleanup of generated content.
  // Interrupted preparation with unknown output is held, never guessed/deleted.
  return { action: 'rollback', reason: 'verified_original_and_owned_artifacts' };
}

function verifyStepFacts(operation, execution, observations, samePath, step, after = false) {
  const facts = validateFacts(observations), p = operation.payload;
  const reject = reason => { const e = new Error(reason); e.code = 'ARCHIVE_FACTS_CHANGED'; throw e; };
  if (ROLES.some(role => facts[role].status === 'unavailable')) reject('Storage is unavailable');
  if (p.replacement ? !fileIs(facts.replacement, p.replacement) : !missing(facts.replacement)) reject('Replacement evidence changed');
  const published = step === 'publish' && after;
  const inPlace = samePath(p.source, p.destination);
  if (!fileIs(facts.source, published && inPlace ? execution.prepared : p.sourceFingerprint)) reject('Source evidence changed');
  if (published ? !fileIs(facts.destination, execution.prepared)
    : inPlace ? !fileIs(facts.destination, p.sourceFingerprint) : !missing(facts.destination)) reject('Destination changed or occupied');
  const needsStaging = step !== 'prepare' || after;
  if (needsStaging ? !fileIs(facts.staged, execution.prepared) : !missing(facts.staged)) reject('Staging evidence changed');
  const needsBackup = step === 'publish' || (step === 'backup' && after);
  if (needsBackup ? !fileIs(facts.backup, p.sourceFingerprint) : !missing(facts.backup)) reject('Backup evidence changed');
}

module.exports = { assessRecovery, verifyStepFacts };
