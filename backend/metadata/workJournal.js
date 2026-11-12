'use strict';
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { assessRecovery, verifyStepFacts } = require('./workRecovery');

const SCHEMA_VERSION = 5;
const INTENTS = Object.freeze(['initial_arrival', 'metadata_refresh', 'reprocess', 'convert', 'replace_content', 'delete_book', 'move_directory', 'delete_directory']);
const DIRECTORY_INTENTS = new Set(['move_directory', 'delete_directory']);
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function string(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /\0/.test(value)) throw new TypeError(`${name} must be nonempty text`);
  return value;
}
function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer`);
  return value;
}
// Stable serialization rejects data that JSON would silently discard (including undefined).
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  throw new TypeError('Context must contain only JSON data');
}
function json(value) {
  const result = canonical(value);
  if (Buffer.byteLength(result) > 1024 * 1024) throw new TypeError('Journal context exceeds 1 MiB');
  return result;
}
function fingerprint(value, name) {
  if (!value || !/^[a-f0-9]{64}$/i.test(value.sha256)) throw new TypeError(`${name} requires an archive SHA-256`);
  return { sha256: value.sha256.toLowerCase(), size: integer(value.size, `${name}.size`) };
}
function normalizer(policy) {
  if (!policy || !['posix', 'win32'].includes(policy.style) || typeof policy.caseSensitive !== 'boolean') throw new TypeError('Explicit filesystem path policy required');
  const impl = path[policy.style];
  return value => {
    string(value, 'path');
    if (!impl.isAbsolute(value) || (policy.style === 'win32' && !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(value))
      || (policy.style === 'posix' && value.includes('\\')) || /^[\\/]{2}[?.][\\/]/.test(value)) throw new TypeError('Use absolute paths in one filesystem namespace');
    let result = impl.normalize(value).replace(/\\/g, '/');
    if (policy.style === 'win32') {
      const tail = result.replace(/^[a-z]:\//i, '').replace(/^\/\/[^/]+\/[^/]+\/?/, '');
      if (tail.split('/').some(part => /[ .]$|:/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new TypeError('Ambiguous Windows path aliases are not supported');
    }
    if (result.length > 1) result = result.replace(/\/$/, '');
    return policy.caseSensitive ? result : result.toLowerCase();
  };
}
function overlaps(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.key === b.key) return true;
  if (a.kind !== 'path') return false;
  const inside = (parent, child) => child.startsWith(parent.endsWith('/') ? parent : parent + '/');
  return (a.scope === 'tree' && inside(a.key, b.key)) || (b.scope === 'tree' && inside(b.key, a.key));
}
function atomic(db, action) {
  if (db.inTransaction || db.isTransaction) fail('NESTED_TRANSACTION', 'Use a dedicated connection outside caller transactions');
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

// Explicit schema installation only. Importing this module never opens or changes a database.
function initializeWorkJournal(db, pathPolicy) {
  normalizer(pathPolicy);
  const policy = json({ style: pathPolicy.style, caseSensitive: pathPolicy.caseSensitive });
  atomic(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS metadata_work_config (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL,
        path_policy TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS metadata_work_books (
        book_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata_work_operations (
        id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
        intent TEXT NOT NULL, book_id TEXT, book_generation INTEGER, owner_id TEXT NOT NULL,
        fence INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('reserved','recovery_required','released')),
        lease_until INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        payload TEXT NOT NULL, release_reason TEXT);
      CREATE TABLE IF NOT EXISTS metadata_work_resources (
        operation_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('book','path')),
        resource_key TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('exact','file','tree')),
        PRIMARY KEY(operation_id,kind,resource_key,scope));
      CREATE INDEX IF NOT EXISTS metadata_work_resource_owner ON metadata_work_resources(operation_id);
      CREATE TABLE IF NOT EXISTS metadata_work_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL,
        at INTEGER NOT NULL, event TEXT NOT NULL, details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata_work_execution (
        operation_id TEXT PRIMARY KEY,
        checkpoint TEXT NOT NULL CHECK(checkpoint IN ('prepare_intent','prepared','backup_intent','backed_up','publish_intent','published','rollback_intent','rolled_back')),
        prepared TEXT, backup_started INTEGER NOT NULL DEFAULT 0,
        publish_started INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS metadata_work_scratch (
        operation_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, fence INTEGER NOT NULL,
        root TEXT NOT NULL UNIQUE, parent TEXT NOT NULL,
        root_created INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL CHECK(state IN ('active','ready','stopped','cleaning','cleaned')),
        candidate TEXT);
      CREATE TABLE IF NOT EXISTS metadata_work_finalization (
        operation_id TEXT PRIMARY KEY, book_id TEXT NOT NULL,
        receipt TEXT NOT NULL, finalized_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata_work_completion (
        operation_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('cleanup_intent','complete')));
    `);
    const config = db.prepare('SELECT * FROM metadata_work_config WHERE singleton=1').get();
    if (config && (![1, 2, 3, 4, SCHEMA_VERSION].includes(config.schema_version) || config.path_policy !== policy)) fail('JOURNAL_CONFIG_MISMATCH', 'Journal schema/path policy differs');
    if (!config) db.prepare('INSERT INTO metadata_work_config(singleton,schema_version,path_policy) VALUES(1,?,?)').run(SCHEMA_VERSION, policy);
    else if (config.schema_version !== SCHEMA_VERSION) db.prepare('UPDATE metadata_work_config SET schema_version=? WHERE singleton=1').run(SCHEMA_VERSION);
  });
}

// readBook is a trusted synchronous adapter to the existing scanned/stable-ID records.
// This module reserves IDs supplied by that authority; it does not allocate/reclaim library IDs.
// Working copies sit beside the file they belong to. A long download name plus the suffix can pass
// the 255-byte file name limit (2026-11-12: a 215-character name failed as "Storage is unavailable"),
// so a name that would not fit drops to the short form in the same folder.
function artifactPath(file, id, kind) {
  const suffix = `.omnibus-${id}.${kind}`;
  if (Buffer.byteLength(file.split(/[\\/]/).pop() + suffix) <= 255) return file + suffix;
  return file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1) + suffix.slice(1);
}
function createWorkJournal({ db, ownerId, pathPolicy, readBook, now = Date.now, leaseMs = 60000 }) {
  string(ownerId, 'ownerId');
  const normalize = normalizer(pathPolicy);
  const spellPath = normalizer({ ...pathPolicy, caseSensitive: true });
  if (typeof readBook !== 'function') throw new TypeError('A trusted readBook adapter is required');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 900000) throw new TypeError('Lease must be 1–900000 milliseconds');
  const config = db.prepare('SELECT * FROM metadata_work_config WHERE singleton=1').get();
  if (!config || config.schema_version !== SCHEMA_VERSION || config.path_policy !== json({ style: pathPolicy.style, caseSensitive: pathPolicy.caseSensitive })) fail('JOURNAL_CONFIG_MISMATCH', 'Initialize this journal with the same path policy first');
  const clock = () => integer(now(), 'clock');
  const epoch = () => db.prepare('SELECT epoch FROM metadata_work_config WHERE singleton=1').get().epoch;
  const advance = () => { db.prepare('UPDATE metadata_work_config SET epoch=epoch+1 WHERE singleton=1').run(); return epoch(); };
  const generation = bookId => bookId ? db.prepare('SELECT generation FROM metadata_work_books WHERE book_id=?').get(bookId)?.generation || 0 : null;
  const bumpBook = bookId => {
    db.prepare('INSERT INTO metadata_work_books(book_id,generation) VALUES(?,1) ON CONFLICT(book_id) DO UPDATE SET generation=generation+1').run(bookId);
    return generation(bookId);
  };
  const event = (id, name, details, at) => db.prepare('INSERT INTO metadata_work_events(operation_id,at,event,details) VALUES(?,?,?,?)').run(id, at, name, json(details));
  const decode = row => row ? { ...row, payload: JSON.parse(row.payload) } : null;
  const get = id => decode(db.prepare('SELECT * FROM metadata_work_operations WHERE id=?').get(id));
  const paths = values => {
    if (!Array.isArray(values) || !values.length) throw new TypeError('At least one path reservation is required');
    return values.map(v => {
      if (!['file', 'tree'].includes(v.scope)) throw new TypeError('Path scope must be file or tree');
      return { kind: 'path', key: normalize(v.path), scope: v.scope };
    });
  };
  const reserve = (id, resources) => {
    const insert = db.prepare('INSERT OR IGNORE INTO metadata_work_resources(operation_id,kind,resource_key,scope) VALUES(?,?,?,?)');
    for (const r of resources) insert.run(id, r.kind, r.key, r.scope);
  };
  const checkFree = (resources, except = null) => {
    const held = db.prepare('SELECT operation_id,kind,resource_key AS key,scope FROM metadata_work_resources').all();
    for (const wanted of resources) for (const existing of held) if (existing.operation_id !== except && overlaps(wanted, existing)) fail('WORK_CONFLICT', `Reserved by operation ${existing.operation_id}`);
  };
  const checkBook = (bookId, expectedGeneration, expectedPath) => {
    string(bookId, 'bookId'); integer(expectedGeneration, 'expectedGeneration');
    const book = readBook(bookId);
    if (!book || book.id !== bookId || !book.path) fail('BOOK_UNAVAILABLE', 'Resolve the target through the existing stable-ID system first');
    if (normalize(book.path) !== normalize(expectedPath)) fail('BOOK_PATH_CHANGED', 'Book path changed; replan against its current location');
    if (generation(bookId) !== expectedGeneration) fail('BOOK_GENERATION_CHANGED', 'Book work generation changed');
  };
  const owned = handle => {
    if (!handle || typeof handle.operationId !== 'string' || !Number.isSafeInteger(handle.fence)) fail('STALE_WORK_HANDLE', 'Invalid work handle');
    const row = get(handle.operationId);
    if (!row || row.state !== 'reserved' || row.owner_id !== ownerId || handle.ownerId !== ownerId || row.fence !== handle.fence) fail('STALE_WORK_HANDLE', 'Operation ownership no longer matches');
    if (row.lease_until <= clock()) fail('LEASE_EXPIRED', 'Expired work requires recovery; it cannot be renewed or released');
    return row;
  };
  const handleFor = row => ({ operationId: row.id, ownerId, fence: row.fence });
  const execution = id => {
    const row = db.prepare('SELECT * FROM metadata_work_execution WHERE operation_id=?').get(id);
    return row ? { checkpoint: row.checkpoint, prepared: row.prepared ? JSON.parse(row.prepared) : null,
      backupStarted: !!row.backup_started, publishStarted: !!row.publish_started } : { checkpoint: 'reserved', prepared: null, backupStarted: false, publishStarted: false };
  };
  const checkpoint = (id, name, prepared = execution(id).prepared) => {
    db.prepare(`INSERT INTO metadata_work_execution(operation_id,checkpoint,prepared,backup_started,publish_started) VALUES(?,?,?,?,?)
      ON CONFLICT(operation_id) DO UPDATE SET checkpoint=excluded.checkpoint,prepared=excluded.prepared,
      backup_started=MAX(backup_started,excluded.backup_started),publish_started=MAX(publish_started,excluded.publish_started)`)
      .run(id, name, prepared ? json(prepared) : null, name === 'backup_intent' ? 1 : 0, name === 'publish_intent' ? 1 : 0);
    event(id, name, { prepared }, clock()); advance();
  };
  const samePath = (a, b) => normalize(a) === normalize(b);
  const scratch = id => {
    const row = db.prepare('SELECT * FROM metadata_work_scratch WHERE operation_id=?').get(id);
    return row ? { ...row, candidate: row.candidate ? JSON.parse(row.candidate) : null } : null;
  };
  const scratchPending = id => { const row = scratch(id); return row && row.state !== 'cleaned'; };
  const bookStillCurrent = row => {
    if (!row.book_id) return;
    checkBook(row.book_id, row.book_generation, row.intent === 'initial_arrival' ? row.payload.destination : row.payload.source);
  };
  const synchronous = (fn, name) => {
    if (typeof fn !== 'function' || fn.constructor.name === 'AsyncFunction' || fn.constructor.name === 'AsyncGeneratorFunction' || fn.constructor.name === 'GeneratorFunction') throw new TypeError(`${name} must be synchronous`);
  };
  const callSync = (fn, ...args) => {
    const result = fn(...args);
    if (result && typeof result.then === 'function') throw new TypeError('Storage adapters must not return promises');
    return result;
  };
  const inspect = (adapter, row) => callSync(adapter.inspect, row);
  const quarantine = (row, reason) => {
    const fence = advance();
    db.prepare("UPDATE metadata_work_operations SET state='recovery_required',fence=?,updated_at=? WHERE id=?").run(fence, clock(), row.id);
    event(row.id, 'recovery_required', { reason, fence }, clock());
  };
  const release = (row, reason) => {
    db.prepare("UPDATE metadata_work_operations SET state='released',release_reason=?,updated_at=? WHERE id=?").run(reason, clock(), row.id);
    db.prepare('DELETE FROM metadata_work_resources WHERE operation_id=?').run(row.id);
    advance(); event(row.id, 'released', { reason }, clock()); return get(row.id);
  };

  function begin(input) {
    const { intent, requestKey, actor, bookId = null, expectedGeneration = null, sourcePath, destinationPath = null, context = null } = input;
    if (!INTENTS.includes(intent)) throw new TypeError('Unsupported work intent');
    string(requestKey, 'requestKey'); string(actor, 'actor');
    const directory = DIRECTORY_INTENTS.has(intent);
    if ((directory && bookId !== null) || (!directory && intent !== 'initial_arrival' && !bookId)) throw new TypeError('Existing-book intents require a stable book; directory intents reserve subtrees');
    if (intent === 'initial_arrival' && bookId !== null) throw new TypeError('Use replacement/reprocess for an existing book; bind an initial arrival after ID resolution');
    if (bookId === null && expectedGeneration !== null) throw new TypeError('An unbound operation has no book generation');
    // Canonical keys are for reservations only. Retain spelling for future filesystem work.
    const source = spellPath(sourcePath);
    const destination = destinationPath === null ? null : spellPath(destinationPath);
    if (!['delete_book', 'delete_directory'].includes(intent) && !destination) throw new TypeError('Destination required');
    if (!directory && destination && !/\.cbz$/i.test(destination)) throw new TypeError('Processed destination must use .cbz');
    if (['delete_book', 'delete_directory'].includes(intent) && destination) throw new TypeError('Deletion has no destination');
    if (['metadata_refresh', 'convert'].includes(intent)
      && normalize(destination) !== normalize(source.replace(/\.(cbz|cbr|zip|rar)$/i, '.cbz'))) throw new TypeError('Automatic work may only normalize the extension, not rename or move');
    const sourceFingerprint = directory ? null : fingerprint(input.sourceFingerprint, 'sourceFingerprint');
    let replacement = null;
    if (intent === 'replace_content') {
      replacement = { path: spellPath(input.replacement?.path), ...fingerprint(input.replacement, 'replacement') };
      if ([source, destination].some(p => normalize(p) === normalize(replacement.path))) throw new TypeError('Replacement input must be a separate staged source');
    } else if (input.replacement != null) throw new TypeError('Replacement evidence requires replace_content intent');
    const request = { intent, actor, bookId, expectedGeneration, source, destination, sourceFingerprint, replacement, context };
    const serialized = json(request);
    const requestHash = createHash('sha256').update(serialized).digest('hex');
    return atomic(db, () => {
      const previous = db.prepare('SELECT * FROM metadata_work_operations WHERE request_key=?').get(requestKey);
      if (previous) {
        if (previous.request_hash !== requestHash) fail('REQUEST_KEY_REUSED', 'Request key belongs to a different plan');
        // A repeat request reports the existing work, never hands a second worker its handle.
        return { reused: true, operation: decode(previous), handle: null };
      }
      if (bookId) checkBook(bookId, expectedGeneration, source);
      const id = randomUUID();
      const artifacts = !directory && destination ? { staged: artifactPath(destination, id, 'staged'), backup: artifactPath(source, id, 'backup') } : null;
      const resources = paths([{ path: source, scope: directory ? 'tree' : 'file' },
        ...(destination ? [{ path: destination, scope: directory ? 'tree' : 'file' }] : []),
        ...(replacement ? [{ path: replacement.path, scope: 'file' }] : []),
        ...(artifacts ? Object.values(artifacts).map(p => ({ path: p, scope: 'file' })) : [])]);
      if (bookId) resources.push({ kind: 'book', key: bookId, scope: 'exact' });
      checkFree(resources);
      const at = clock(), fence = advance(), bookGeneration = bookId ? bumpBook(bookId) : null;
      db.prepare(`INSERT INTO metadata_work_operations(id,request_key,request_hash,intent,book_id,book_generation,owner_id,fence,state,lease_until,created_at,updated_at,payload)
        VALUES(?,?,?,?,?,?,?,?,'reserved',?,?,?,?)`).run(id, requestKey, requestHash, intent, bookId, bookGeneration, ownerId, fence, at + leaseMs, at, at, json({ ...request, artifacts }));
      reserve(id, resources); event(id, 'reserved', { ownerId, fence, bookGeneration }, at);
      const operation = get(id);
      return { reused: false, operation, handle: handleFor(operation) };
    });
  }
  function bindInitialBook(handle, { bookId, expectedGeneration }) {
    return atomic(db, () => {
      const row = owned(handle);
      if (row.intent !== 'initial_arrival' || row.book_id) fail('BIND_NOT_ALLOWED', 'Only an unbound initial arrival can receive a stable book');
      checkBook(bookId, expectedGeneration, row.payload.destination);
      const resource = { kind: 'book', key: bookId, scope: 'exact' }; checkFree([resource], row.id);
      const version = bumpBook(bookId); advance();
      db.prepare('UPDATE metadata_work_operations SET book_id=?,book_generation=?,updated_at=? WHERE id=?').run(bookId, version, clock(), row.id);
      reserve(row.id, [resource]); event(row.id, 'book_bound', { bookId, generation: version }, clock());
      return get(row.id);
    });
  }
  function heartbeat(handle) {
    return atomic(db, () => {
      const row = owned(handle), at = clock();
      const until = Math.max(row.lease_until, at + leaseMs);
      db.prepare('UPDATE metadata_work_operations SET lease_until=?,updated_at=? WHERE id=?').run(until, at, row.id);
      return until;
    });
  }
  // Never release work once an effect may have started, or a provisional ID exists.
  function releaseUnstarted(handle, reason) {
    if (!['cancelled_before_write', 'no_work', 'validation_failed'].includes(reason)) throw new TypeError('Explicit pre-write release reason required');
    return atomic(db, () => {
      const row = owned(handle);
      if (execution(row.id).checkpoint !== 'reserved' || scratchPending(row.id) || (row.intent === 'initial_arrival' && row.book_id)) fail('RECOVERY_REQUIRED', 'Started work or provisional registration requires reconciliation');
      return release(row, reason);
    });
  }
  function quarantineExpired() {
    return atomic(db, () => {
      const at = clock();
      const expired = db.prepare("SELECT id FROM metadata_work_operations WHERE state='reserved' AND lease_until<=?").all(at);
      for (const row of expired) {
        const fence = advance();
        db.prepare("UPDATE metadata_work_operations SET state='recovery_required',fence=?,updated_at=? WHERE id=?").run(fence, at, row.id);
        event(row.id, 'recovery_required', { reason: 'lease_expired', fence }, at);
      }
      return expired.map(row => get(row.id));
    });
  }
  // Internal trusted adapters only. Every effect stays inside BEGIN IMMEDIATE:
  // another cooperating connection cannot recover/steal work during an effect.
  // The intent commits BEFORE the effect; SQLite rollback cannot undo file I/O.
  // No async I/O, detached work or nested journal/registry transaction is allowed.
  function executeArchiveStep(handle, step, adapter) {
    const steps = { prepare: ['reserved', 'prepare_intent', 'prepared'], backup: ['prepared', 'backup_intent', 'backed_up'], publish: ['backed_up', 'publish_intent', 'published'] };
    if (!Object.hasOwn(steps, step)) throw new TypeError('Unsupported archive step');
    synchronous(adapter?.inspect, 'inspect'); synchronous(adapter?.[step], step);
    const [before, pending, after] = steps[step];
    atomic(db, () => {
      const row = owned(handle);
      if (!row.payload.artifacts) fail('UNSUPPORTED_EXECUTION', 'Directory/deletion execution is not implemented');
      if (['active', 'cleaning'].includes(scratch(row.id)?.state)) fail('SCRATCH_ACTIVE', 'Preparation or cleanup is still running');
      if (execution(row.id).checkpoint !== before) fail('CHECKPOINT_MISMATCH', 'Do not replay an interrupted or completed effect');
      bookStillCurrent(row);
      verifyStepFacts(row, execution(row.id), inspect(adapter, row), samePath, step);
      checkpoint(row.id, pending);
    });
    try {
      return atomic(db, () => {
        const row = owned(handle), previous = execution(row.id);
        if (['active', 'cleaning'].includes(scratch(row.id)?.state)) fail('SCRATCH_ACTIVE', 'Preparation or cleanup is still running');
        if (previous.checkpoint !== pending) fail('CHECKPOINT_MISMATCH', 'Execution checkpoint changed');
        bookStillCurrent(row);
        verifyStepFacts(row, previous, inspect(adapter, row), samePath, step);
        const result = callSync(adapter[step], row);
        const prepared = step === 'prepare' ? fingerprint(result, 'prepared') : previous.prepared;
        verifyStepFacts(row, { prepared }, inspect(adapter, row), samePath, step, true);
        checkpoint(row.id, after, prepared);
        return { operation: get(row.id), execution: execution(row.id) };
      });
    } catch (error) {
      // If this fails (e.g. DB unavailable), the durable intent still blocks work.
      // Do not overwrite a newer recovery owner's fence.
      atomic(db, () => {
        const row = get(handle.operationId);
        if (row?.state === 'reserved' && row.owner_id === ownerId && row.fence === handle.fence) quarantine(row, 'effect_interrupted');
      });
      throw error;
    }
  }
  function recoveryAssessment(row, adapter) {
    if (finalization(row.id)) return { action: 'hold', reason: 'finalized_book_requires_forward_completion' };
    if (scratchPending(row.id)) return { action: 'hold', reason: 'scratch_requires_quiescent_cleanup' };
    if (!row.payload.artifacts) return { action: 'hold', reason: 'unsupported_intent' };
    // Step 3.3 must reconcile provisional stableIds registration atomically.
    if (row.intent === 'initial_arrival' && row.book_id) return { action: 'hold', reason: 'provisional_book_requires_finalization' };
    try { bookStillCurrent(row); }
    catch (error) { return { action: 'hold', reason: error.code || 'book_unavailable' }; }
    return assessRecovery(row, execution(row.id), inspect(adapter, row), samePath);
  }
  function inspectRecovery(id, adapter) {
    synchronous(adapter?.inspect, 'inspect');
    return atomic(db, () => {
      const row = get(id);
      if (!row) fail('WORK_NOT_FOUND', 'Unknown operation');
      if (row.state === 'released') return { action: 'none', reason: 'already_released' };
      if (row.state !== 'recovery_required') return { action: 'hold', reason: 'quarantine_required' };
      return recoveryAssessment(row, adapter);
    });
  }
  function recoverOperation(id, adapter) {
    synchronous(adapter?.inspect, 'inspect');
    // Claim only after evidence assessment under the same connection lock that
    // fences all effects. Expiry alone never authorizes filesystem cleanup.
    const claim = atomic(db, () => {
      const row = get(id);
      if (!row) fail('WORK_NOT_FOUND', 'Unknown operation');
      if (row.state === 'released') return { action: 'none', operation: row };
      if (row.state !== 'recovery_required') return { action: 'hold', reason: 'quarantine_required' };
      const assessment = recoveryAssessment(row, adapter);
      if (assessment.action === 'hold') return assessment;
      if (assessment.action === 'release') return { action: 'released', operation: release(row, 'recovered_original_intact') };
      synchronous(adapter?.rollback, 'rollback');
      const at = clock(), fence = advance();
      db.prepare("UPDATE metadata_work_operations SET state='reserved',owner_id=?,fence=?,lease_until=?,updated_at=? WHERE id=?").run(ownerId, fence, at + leaseMs, at, row.id);
      checkpoint(row.id, 'rollback_intent');
      event(row.id, 'recovery_claimed', { ownerId, fence }, at);
      return { action: 'rollback', handle: handleFor(get(id)) };
    });
    if (claim.action !== 'rollback') return claim;
    try {
      return atomic(db, () => {
        const row = owned(claim.handle);
        const assessment = recoveryAssessment(row, adapter);
        if (!['rollback', 'release'].includes(assessment.action)) fail('RECOVERY_EVIDENCE_CHANGED', assessment.reason);
        if (assessment.action === 'rollback') callSync(adapter.rollback, row, execution(row.id));
        const final = recoveryAssessment(row, adapter);
        if (final.action !== 'release') fail('ROLLBACK_NOT_VERIFIED', final.reason);
        checkpoint(row.id, 'rolled_back');
        return { action: 'rolled_back', operation: release(row, 'recovered_rollback') };
      });
    } catch (error) {
      atomic(db, () => {
        const row = get(id);
        if (row?.state === 'reserved' && row.owner_id === ownerId && row.fence === claim.handle.fence) quarantine(row, 'recovery_interrupted');
      });
      throw error;
    }
  }
  // Asynchronous preparation never runs inside a database transaction. Only
  // its ownership checkpoints do. The original worker may report close after
  // lease expiry, but may not acquire new work or publish with an expired fence.
  function registerScratch(handle, { root, parent, sourceFingerprint }) {
    return atomic(db, () => {
      const row = owned(handle), impl = path[pathPolicy.style];
      bookStillCurrent(row);
      if (!row.payload.artifacts || execution(row.id).checkpoint !== 'reserved' || scratch(row.id)) fail('CHECKPOINT_MISMATCH', 'Scratch can be registered once before preparation');
      if (!samePath(impl.dirname(root), parent) || !/^omnibus-archive-[a-f0-9-]{36}$/.test(impl.basename(root))) throw new TypeError('Private direct scratch child required');
      const actual = fingerprint(sourceFingerprint, 'scratch source'), expected = row.payload.replacement || row.payload.sourceFingerprint;
      if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) fail('ARCHIVE_FACTS_CHANGED', 'Input differs from reserved source');
      const resource = { kind: 'path', key: normalize(root), scope: 'tree' };
      for (const value of [row.payload.source, row.payload.destination, ...Object.values(row.payload.artifacts), row.payload.replacement?.path].filter(Boolean)) {
        if (overlaps(resource, { kind: 'path', key: normalize(value), scope: 'file' })) fail('UNSAFE_SCRATCH', 'Scratch overlaps library artifacts');
      }
      checkFree([resource]); reserve(row.id, [resource]);
      db.prepare("INSERT INTO metadata_work_scratch(operation_id,owner_id,fence,root,parent,state) VALUES(?,?,?,?,?,'active')")
        .run(row.id, ownerId, handle.fence, spellPath(root), spellPath(parent));
      event(row.id, 'scratch_registered', { root: spellPath(root) }, clock()); advance();
      return scratch(row.id);
    });
  }
  const scratchOwned = handle => {
    const row = scratch(handle?.operationId), operation = get(handle?.operationId);
    if (!row || !operation || operation.state === 'released' || row.owner_id !== ownerId || handle.ownerId !== ownerId || row.fence !== handle.fence) fail('STALE_WORK_HANDLE', 'Scratch ownership changed');
    return row;
  };
  function settleScratch(handle, candidate) {
    return atomic(db, () => {
      const row = scratchOwned(handle);
      if (row.state !== 'active') fail('CHECKPOINT_MISMATCH', 'Scratch is not active');
      let value = null;
      if (candidate) {
        if (!samePath(candidate.path, path[pathPolicy.style].join(row.root, 'candidate.cbz'))) fail('UNSAFE_SCRATCH', 'Candidate outside owned scratch');
        value = { path: spellPath(candidate.path), fingerprint: fingerprint(candidate.fingerprint, 'candidate') };
      }
      db.prepare('UPDATE metadata_work_scratch SET state=?,candidate=? WHERE operation_id=?').run(value ? 'ready' : 'stopped', value ? json(value) : null, row.operation_id);
      event(row.operation_id, 'scratch_settled', { candidate: value }, clock()); advance();
    });
  }
  function markScratchCreated(handle) {
    return atomic(db, () => {
      const row = scratchOwned(handle);
      if (row.state !== 'active' || row.root_created) fail('CHECKPOINT_MISMATCH', 'Scratch creation already recorded or stopped');
      db.prepare('UPDATE metadata_work_scratch SET root_created=1 WHERE operation_id=?').run(row.operation_id);
      event(row.operation_id, 'scratch_created', {}, clock()); advance();
    });
  }
  function beginScratchCleanup(handle) {
    return atomic(db, () => {
      const row = scratchOwned(handle);
      if (!row.root_created) fail('SCRATCH_OWNERSHIP_UNKNOWN', 'Scratch creation was not recorded; retain for review');
      if (!['ready', 'stopped'].includes(row.state)) fail('SCRATCH_ACTIVE', 'Cleanup requires a stopped worker and no cleanup already in progress');
      db.prepare("UPDATE metadata_work_scratch SET state='cleaning' WHERE operation_id=?").run(row.operation_id);
      event(row.operation_id, 'scratch_cleanup_intent', {}, clock()); advance();
    });
  }
  function finishScratchCleanup(handle) {
    return atomic(db, () => {
      const row = scratchOwned(handle);
      if (row.state !== 'cleaning') fail('CHECKPOINT_MISMATCH', 'Cleanup was not started');
      db.prepare("UPDATE metadata_work_scratch SET state='cleaned',candidate=NULL WHERE operation_id=?").run(row.operation_id);
      event(row.operation_id, 'scratch_cleaned', {}, clock()); advance();
    });
  }
  // Trusted recovery adapter proves the old job AND any consumer/cleanup are
  // stopped. PID absence or lease expiry alone is not that proof. Keep unknown
  // jobs reserved; never recursively delete arbitrary or unregistered paths.
  function recoverScratch(id, adapter) {
    synchronous(adapter?.isQuiescent, 'isQuiescent'); synchronous(adapter?.remove, 'remove'); synchronous(adapter?.isAbsent, 'isAbsent');
    return atomic(db, () => {
      const operation = get(id), row = scratch(id);
      if (!row || row.state === 'cleaned') return { action: 'none' };
      if (operation?.state !== 'recovery_required') return { action: 'hold', reason: 'quarantine_required' };
      if (callSync(adapter.isQuiescent, row) !== true) return { action: 'hold', reason: 'worker_quiescence_unknown' };
      if (!row.root_created && callSync(adapter.isAbsent, row) !== true) return { action: 'hold', reason: 'scratch_creation_unverified' };
      // Synchronous removal under the coordination lock prevents the old
      // worker from authorizing cleanup or a consumer concurrently.
      if (row.root_created) callSync(adapter.remove, row);
      if (callSync(adapter.isAbsent, row) !== true) fail('SCRATCH_CLEANUP_UNVERIFIED', 'Scratch removal not verified');
      db.prepare("UPDATE metadata_work_scratch SET state='cleaned',candidate=NULL,fence=? WHERE operation_id=?").run(advance(), id);
      event(id, 'scratch_recovered', { root: row.root }, clock());
      return { action: 'cleaned' };
    });
  }
  const finalization = id => {
    const row = db.prepare('SELECT * FROM metadata_work_finalization WHERE operation_id=?').get(id);
    return row ? { ...row, receipt: JSON.parse(row.receipt) } : null;
  };
  function finalizePublishedBook(handle, adapter) {
    synchronous(adapter?.inspect, 'inspect'); synchronous(adapter?.finalize, 'finalize');
    return atomic(db, () => {
      const previous = finalization(handle?.operationId);
      if (previous) return { reused: true, finalization: previous };
      let row = owned(handle); const executed = execution(row.id);
      const initial=row.intent==='initial_arrival'&&!row.book_id&&typeof adapter.register==='function';
      if ((!row.book_id&&!initial) || row.intent==='replace_content' || (row.intent==='initial_arrival'&&!initial)) fail('FINALIZATION_UNSUPPORTED', 'Initial registration requires an atomic stable-ID adapter; replacement needs page mapping');
      if (executed.checkpoint !== 'published') fail('CHECKPOINT_MISMATCH', 'Only verified published work can finalize');
      if (scratchPending(row.id)) fail('SCRATCH_ACTIVE', 'Finish private preparation cleanup before finalizing');
      bookStillCurrent(row);
      const facts = inspect(adapter, row);
      verifyStepFacts(row, executed, facts, samePath, 'publish', true);
      if(initial){
        const bookId=callSync(adapter.register,db,row,executed,facts);
        checkBook(bookId,generation(bookId),row.payload.destination);
        const resource={kind:'book',key:bookId,scope:'exact'};checkFree([resource],row.id);
        const version=bumpBook(bookId);reserve(row.id,[resource]);
        db.prepare('UPDATE metadata_work_operations SET book_id=?,book_generation=?,updated_at=? WHERE id=?').run(bookId,version,clock(),row.id);
        event(row.id,'book_bound',{bookId,generation:version},clock());row=get(row.id);
      }
      // Database-only callback, on this exact connection. A failure rolls back
      // book/index/revision/outbox and receipt together, retaining published
      // files plus backups for the existing recovery protocol.
      const receipt = callSync(adapter.finalize, db, row, executed, facts);
      const current = readBook(row.book_id);
      if (!current || current.id !== row.book_id || !samePath(current.path, row.payload.destination)) fail('FINALIZATION_UNVERIFIED', 'Stable book was not updated to published destination');
      db.prepare('INSERT INTO metadata_work_finalization VALUES(?,?,?,?)').run(row.id, row.book_id, json(receipt), clock());
      event(row.id, 'book_finalized', { bookId: row.book_id }, clock()); advance();
      // Do not release reservations or delete backups until follow-up work and
      // original-path retirement are durably completed by the next step.
      return { reused: false, finalization: finalization(row.id) };
    });
  }
  function finalizedTransaction(handle, apply) {
    synchronous(apply, 'finalized database update');
    return atomic(db, () => {
      const row = owned(handle);
      if (!finalization(row.id)) fail('CHECKPOINT_MISMATCH', 'Book is not finalized');
      checkBook(row.book_id, row.book_generation, row.payload.destination);
      return callSync(apply, db, row);
    });
  }
  function claimFinalized(id, isQuiescent) {
    synchronous(isQuiescent, 'isQuiescent');
    return atomic(db, () => {
      const row = get(id);
      if (!row || !finalization(id) || row.state !== 'recovery_required') fail('RECOVERY_REQUIRED', 'Quarantined finalized work required');
      if (callSync(isQuiescent, row) !== true) fail('WORKER_ACTIVE', 'Prior job/consumers must be stopped before recovery');
      if (scratchPending(id)) fail('SCRATCH_ACTIVE', 'Recover private scratch first');
      checkBook(row.book_id, row.book_generation, row.payload.destination);
      const at = clock(), fence = advance();
      db.prepare("UPDATE metadata_work_operations SET state='reserved',owner_id=?,fence=?,lease_until=?,updated_at=? WHERE id=?").run(ownerId,fence,at+leaseMs,at,id);
      event(id,'forward_recovery_claimed',{ownerId,fence},at);
      return handleFor(get(id));
    });
  }
  function holdOperation(handle, reason) {
    return atomic(db, () => {
      const row = get(handle.operationId);
      if (row?.state === 'reserved' && row.owner_id === ownerId && row.fence === handle.fence) quarantine(row, String(reason));
    });
  }
  function finishPublishedBook(handle, adapter) {
    synchronous(adapter?.inspect, 'inspect'); synchronous(adapter?.cleanup, 'cleanup');
    const completed = id => db.prepare('SELECT state FROM metadata_work_completion WHERE operation_id=?').get(id)?.state;
    const verify = (row, after = false) => {
      const facts = inspect(adapter,row), p = row.payload, prepared = execution(row.id).prepared;
      const isFile = (fact, wanted) => fact?.status === 'file' && fact.sha256 === wanted.sha256 && fact.size === wanted.size;
      const missing = fact => fact?.status === 'missing';
      const started = !!completed(row.id);
      if (!isFile(facts.destination,prepared) || !missing(facts.replacement)) fail('ARCHIVE_FACTS_CHANGED','Published destination/replacement changed');
      const checkArtifact = (fact,wanted) => after ? missing(fact) : isFile(fact,wanted) || (started && missing(fact));
      if (!(samePath(p.source,p.destination) ? isFile(facts.source,prepared) : checkArtifact(facts.source,p.sourceFingerprint))
        || !checkArtifact(facts.staged,prepared) || !checkArtifact(facts.backup,p.sourceFingerprint)) fail('ARCHIVE_FACTS_CHANGED','Retirement artifacts changed');
    };
    const prior = atomic(db, () => {
      if (completed(handle.operationId) === 'complete') return true;
      const row = owned(handle);
      if (!finalization(row.id) || scratchPending(row.id)) fail('CHECKPOINT_MISMATCH','Finalized, quiescent book required');
      checkBook(row.book_id,row.book_generation,row.payload.destination);
      if (db.prepare('SELECT state FROM metadata_book_followups WHERE operation_id=?').get(row.id)?.state !== 'complete') fail('FOLLOWUPS_PENDING','Follow-ups must complete before artifact retirement');
      verify(row);
      db.prepare("INSERT OR IGNORE INTO metadata_work_completion VALUES(?,'cleanup_intent')").run(row.id);
      event(row.id,'retirement_intent',{},clock()); advance(); return false;
    });
    if (prior) return { reused:true, operation:get(handle.operationId) };
    try {
      return atomic(db, () => {
        const row = owned(handle); checkBook(row.book_id,row.book_generation,row.payload.destination); verify(row);
        callSync(adapter.cleanup,row,execution(row.id)); verify(row,true);
        db.prepare("UPDATE metadata_work_completion SET state='complete' WHERE operation_id=?").run(row.id);
        return { reused:false, operation:release(row,'completed') };
      });
    } catch (error) { holdOperation(handle,'retirement_interrupted'); throw error; }
  }
  function captureScan({ bookId = null, paths: scanPaths }) {
    const resources = paths(scanPaths);
    if (bookId) resources.push({ kind: 'book', key: string(bookId, 'bookId'), scope: 'exact' });
    return atomic(db, () => { checkFree(resources); return { epoch: epoch(), bookId, generation: generation(bookId), resources }; });
  }
  function commitScan(token, apply) {
    if (typeof apply !== 'function' || apply.constructor.name === 'AsyncFunction') throw new TypeError('Scan commit must be a synchronous database-only callback');
    return atomic(db, () => {
      if (!token || token.epoch !== epoch() || token.generation !== generation(token.bookId)) fail('STALE_SCAN', 'Coordinated work changed since the scan read');
      checkFree(token.resources);
      const result = apply(db);
      if (result && typeof result.then === 'function') throw new TypeError('Scan commit must not return a promise');
      if (token.bookId) bumpBook(token.bookId);
      advance(); return result;
    });
  }
  return {
    begin, bindInitialBook, heartbeat, releaseUnstarted, quarantineExpired, captureScan, commitScan, get,
    executeArchiveStep, inspectRecovery, recoverOperation, execution,
    registerScratch, markScratchCreated, settleScratch, beginScratchCleanup, finishScratchCleanup, recoverScratch, scratch,
    finalizePublishedBook, finalization,
    finalizedTransaction, claimFinalized, holdOperation, finishPublishedBook,
    findRequest: key => decode(db.prepare('SELECT * FROM metadata_work_operations WHERE request_key=?').get(key)),
    bookGeneration: generation,
    assertOwned: handle => atomic(db, () => owned(handle)),
    listUnfinished: () => db.prepare("SELECT * FROM metadata_work_operations WHERE state!='released' ORDER BY created_at,id").all().map(decode),
    events: id => db.prepare('SELECT * FROM metadata_work_events WHERE operation_id=? ORDER BY sequence').all(id).map(row => ({ ...row, details: JSON.parse(row.details) })),
  };
}
module.exports = { SCHEMA_VERSION, INTENTS, initializeWorkJournal, createWorkJournal };
