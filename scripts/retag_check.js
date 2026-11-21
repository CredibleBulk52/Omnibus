#!/usr/bin/env node
'use strict';
// Read-only (2026-11-21): runs Omnibus's own retag preparation on CBZ files, without changing them.
// It is the same step a retag runs before it replaces a book (metadata/archiveStaging.js,
// prepareValidatedArchive with forceOutput): Omnibus's ZIP reader lists the members, the archive is
// copied to a scratch folder and extracted with 7-Zip, the extraction must equal that listing (names,
// sizes, sha256: "Extraction/build changed source paths or payloads" otherwise), a new CBZ is built and
// validated. The scratch folder is removed; the source file is only read.
//
// Usage: node retag_check.js [--backend DIR] [--scratch DIR] FILE...   or   paths as JSON on stdin (-)
// Prints one JSON line per file: {"path", "ok", "code"?, "error"?, "ms"}.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  process.argv.splice(i, 2);
  return v;
}
const backend = path.resolve(arg('--backend', process.env.OMNIBUS_BACKEND || path.join(__dirname, '..', 'backend')));
const scratch = path.resolve(arg('--scratch', path.join(os.tmpdir(), 'omnibus-retag-check')));
const { prepareValidatedArchive } = require(path.join(backend, 'metadata', 'archiveStaging.js'));
const crypto = require('node:crypto');

// On a preservation failure: what Omnibus's reader lists against what the extraction step produced
// (the same two lists prepareValidatedArchive compares), and which extractor produced it.
async function explain(file) {
  const { inspectArchiveForStaging } = require(path.join(backend, 'metadata', 'archiveValidation.js'));
  const { applyMetadataReport } = require(path.join(backend, 'metadata', 'archiveValidationCore.js'));
  const { createArchiveTools } = require(path.join(backend, 'metadata', 'archiveTools.js'));
  const { createArchiveToolRunner } = require(path.join(backend, 'metadata', 'archiveToolRunner.js'));
  const dir = fs.mkdtempSync(path.join(scratch, 'explain-'));
  try {
    const facts = await inspectArchiveForStaging({ inputPath: file, sourceName: path.basename(file), mode: 'library' });
    const { selectedArchivePath, selectedArchiveBytes, ...rest } = facts;
    const listed = applyMetadataReport(rest, null).originalMembers.filter(m => !m.directory);
    const copy = path.join(dir, 'input.zip');
    fs.copyFileSync(file, copy);
    let n = 0;
    const tools = createArchiveTools({ run: createArchiveToolRunner({}) });
    const ex = await tools.extractArchive({ source: copy, profile: 'download', format: 'zip', preservePaths: true,
      attemptDirectory: async () => { const d = path.join(dir, 'attempt-' + (n++)); fs.mkdirSync(d); return d; } });
    const got = new Map();
    const walk = (d, pre = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, pre + e.name + '/');
      else { const b = fs.readFileSync(f); got.set(pre + e.name, { size: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') }); }
    } };
    walk(ex.directory);
    const want = new Map(listed.map(m => [m.name, m]));
    const extra = [...got.keys()].filter(k => !want.has(k));
    const missing = [...want.keys()].filter(k => !got.has(k));
    const differ = [...want.keys()].filter(k => got.has(k) && (got.get(k).size !== want.get(k).size || got.get(k).sha256 !== want.get(k).sha256));
    return { extractor: ex.tool, listed: want.size, extracted: got.size, extra: extra.slice(0, 5), missing: missing.slice(0, 5),
      differ: differ.slice(0, 5).map(k => `${k} (listed ${want.get(k).size} B, extracted ${got.get(k).size} B)`) };
  } catch (e) {
    return { explainError: String(e.message || e).slice(0, 200) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function check(file) {
  const t0 = Date.now();
  let result;
  try {
    result = await prepareValidatedArchive({ inputPath: file, sourceName: path.basename(file), forceOutput: true,
      scratchParent: scratch, mode: 'library' });
    if (result.status !== 'prepared') return { path: file, ok: false, code: 'UNEXPECTED_STATUS', error: result.status, ms: Date.now() - t0 };
    return { path: file, ok: true, ms: Date.now() - t0 };
  } catch (e) {
    const out = { path: file, ok: false, code: e.code || 'ERROR', error: String(e.message || e).slice(0, 300), ms: Date.now() - t0 };
    if (out.code === 'ARCHIVE_PRESERVATION_FAILED' && process.env.RETAG_CHECK_EXPLAIN !== '0') out.explain = await explain(file);
    return out;
  } finally {
    if (result && typeof result.cleanup === 'function') { try { await result.cleanup(); } catch {} }
  }
}

(async () => {
  let files = process.argv.slice(2);
  if (files.length === 1 && files[0] === '-') files = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!files.length) { console.error('usage: retag_check.js [--backend DIR] [--scratch DIR] FILE... | -'); process.exit(2); }
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  for (const f of files.map(x => path.resolve(x))) {
    const r = fs.existsSync(f) ? await check(f) : { path: f, ok: false, code: 'MISSING', error: 'file missing', ms: 0 };
    process.stdout.write(JSON.stringify(r) + '\n');
  }
})().catch(e => { console.error(e); process.exit(1); });
