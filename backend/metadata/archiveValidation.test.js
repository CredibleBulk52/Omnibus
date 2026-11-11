'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const archiver = require('archiver');
const sharp = require('sharp');
const { inspectArchiveBuffer, validateCandidateBuffer, DEFAULT_LIMITS } = require('./archiveValidationCore');
const { inspectArchive, validateArchiveCandidate } = require('./archiveValidation');
const { planMetadataMerge } = require('./merge');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const code = expected => error => error.code === expected;
// Test-only ZIP generator. Omnibus's existing converter still uses its original
// 7z/unrar/bsdtar commands; archiver here creates synthetic fixtures only.
function zip(entries, { store = false } = {}) {
  return new Promise((resolve, reject) => {
    const output = archiver('zip', { store }); const chunks = [];
    output.on('error', reject); output.on('data', chunk => chunks.push(chunk));
    output.on('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, data] of entries) output.append(data, { name, date: new Date('2000-01-01T00:00:00Z') });
    output.finalize().catch(reject);
  });
}
const png = () => sharp({ create: { width: 3, height: 2, channels: 3, background: '#4080c0' } }).png().toBuffer();
const inspect = (input, extra = {}) => inspectArchiveBuffer({ input, sourceName: 'Comic.cbz', ...extra });
const originalXml = '\uFEFF<?xml version="1.0" encoding="UTF-8"?><ComicInfo><Title>Imported</Title><Pages><Page Image="0" Bookmark="Cover"/><Page Image="1" DoublePage="True"/></Pages><Unknown keep="yes"/></ComicInfo>';
const metadata = xml => ({ bookId: 'copy-a', cvIssueId: '123', plan: planMetadataMerge({ bookId: 'copy-a',
  decision: { bookId: 'copy-a', cvIssueId: '123', status: 'accepted' }, currentXml: xml, source: { cvIssueId: '123', fields: { Writer: 'New credit' } } }) });

test('real ZIP fixture retains reader order, nested filenames, XML annotations and unknown members', async () => {
  const page = await png();
  const input = await zip([['z/001.png', page], ['a/002.png', page], ['ComicInfo.xml', originalXml], ['notes.txt', 'keep me'], ['empty/', '']]);
  const before = hash(input), report = await inspect(input);
  assert.deepEqual(report.pages.map(p => p.name), ['a/002.png', 'z/001.png']);
  assert.ok(report.pages.every(p => p.sha256 === hash(page) && p.size === page.length));
  assert.equal(report.comicInfo.xml, originalXml);
  assert.equal(report.requiresOutput, false); assert.equal(hash(input), before);
  const checked = await validateCandidateBuffer({ input, report }); assert.equal(checked.fingerprint.sha256, before);
});
test('ZIP bytes mislabeled CBR require CBZ normalization even with no metadata change', async () => {
  const input = await zip([['001.png', await png()]]);
  const report = await inspect(input, { sourceName: 'Comic.cbr' });
  assert.equal(report.needsNormalization, true); assert.equal(report.metadataChanged, false); assert.equal(report.requiresOutput, true);
  assert.equal((await validateCandidateBuffer({ input, report })).fingerprint.sha256, hash(input));
});
test('approved XML update round-trips through independent ZIP fixtures with every other payload intact', async () => {
  const page = await png(); const entries = [['nested/001.png', page], ['nested/ComicInfo.xml', originalXml], ['credit.txt', 'external credits']];
  const input = await zip(entries), report = await inspect(input, { metadata: metadata(originalXml) });
  assert.equal(report.comicInfo.name, 'nested/ComicInfo.xml');
  assert.equal(report.comicInfo.xml, originalXml.replace('</ComicInfo>', '<Writer>New credit</Writer></ComicInfo>'));
  const candidate = await zip(entries.map(([name, data]) => [name, name.endsWith('ComicInfo.xml') ? report.comicInfo.xml : data]));
  assert.equal((await validateCandidateBuffer({ input: candidate, report })).fingerprint.sha256, hash(candidate));
  assert.equal(hash(input), report.sourceFingerprint.sha256);
});
test('a missing ComicInfo is inserted only when an actual merge plan supplies changes', async () => {
  const page = await png(), input = await zip([['001.png', page]]);
  const report = await inspect(input, { metadata: metadata(null) });
  const candidate = await zip([['001.png', page], ['ComicInfo.xml', report.comicInfo.xml]]);
  assert.equal(report.metadataChanged, true); await validateCandidateBuffer({ input: candidate, report });
});
test('same-length stale XML plan is refused before any candidate is accepted', async () => {
  const input = await zip([['001.png', await png()], ['ComicInfo.xml', originalXml.replace('Imported', 'Modified')]]);
  await assert.rejects(inspect(input, { metadata: metadata(originalXml) }), code('STALE_XML'));
});
for (const change of ['flatten', 'page bytes', 'unknown member', 'annotations']) {
  test(`candidate changing ${change} is rejected even when it is a readable ZIP`, async () => {
    const page = await png(), entries = [['folder/001.png', page], ['ComicInfo.xml', originalXml], ['notes.txt', 'keep']];
    const report = await inspect(await zip(entries));
    const changed = entries.map(([name, data]) => {
      if (change === 'flatten' && name.endsWith('.png')) return ['001.png', data];
      if (change === 'page bytes' && name.endsWith('.png')) return [name, Buffer.concat([page, Buffer.from('changed')])];
      if (change === 'unknown member' && name === 'notes.txt') return [name, 'lost'];
      if (change === 'annotations' && name === 'ComicInfo.xml') return [name, originalXml.replace('Bookmark="Cover"', 'Bookmark="Changed"')];
      return [name, data];
    });
    await assert.rejects(validateCandidateBuffer({ input: await zip(changed), report }), code('ARCHIVE_PRESERVATION_FAILED'));
  });
}
test('ZIP physical entry order can differ while reader page order and payloads stay identical', async () => {
  const page = await png(), entries = [['10.png', page], ['2.png', page], ['001.png', page]];
  const report = await inspect(await zip(entries));
  assert.deepEqual(report.pages.map(p => p.name), ['001.png', '10.png', '2.png']);
  await validateCandidateBuffer({ input: await zip([...entries].reverse()), report });
});
test('zero-page and metadata-only archives cannot be considered repaired', async () => {
  for (const entries of [[], [['ComicInfo.xml', originalXml]], [['notes.txt', 'not an image']]]) await assert.rejects(inspect(await zip(entries)), code('NO_IMAGE_PAGES'));
});
test('Apple resource forks are preserved but do not count as image pages', async () => {
  await assert.rejects(inspect(await zip([['__MACOSX/001.png', 'not a page'], ['._001.png', 'resource']])), code('NO_IMAGE_PAGES'));
  const report = await inspect(await zip([['001.png', await png()], ['__MACOSX/._001.png', 'resource']]));
  assert.equal(report.pages.length, 1); assert.equal(report.expectedMembers.filter(m => !m.directory).length, 2);
});
test('metadata edits preserve opaque page bytes without diagnosing image health', async () => {
  const page = await png();
  for (const data of [Buffer.from('not image bytes'), page.subarray(0, 36)]) {
    const input = await zip([['001.png', data]]), report = await inspect(input, { metadata: metadata(null) });
    const candidate = await zip([['001.png', data], ['ComicInfo.xml', report.comicInfo.xml]]);
    assert.equal(report.pages[0].sha256, hash(data));
    await validateCandidateBuffer({ input: candidate, report });
  }
});

test('large readable pages and filename/format differences do not block metadata', async () => {
  const large = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: '#4080c0' } }).png().toBuffer();
  assert.equal((await sharp(large).metadata()).width, 5000);
  for (const name of ['001.png', '001.jpg']) {
    const input = await zip([[name, large]]), report = await inspect(input, { limits: { imagePixels: 2 }, metadata: metadata(null) });
    assert.equal(report.pages[0].sha256, hash(large));
    await validateCandidateBuffer({ input: await zip([[name, large], ['ComicInfo.xml', report.comicInfo.xml]]), report });
  }
});

test('top-level ComicInfo wins over a nested copy; nested copies alone stay ambiguous', async () => {
  const page = await png();
  const report = await inspect(await zip([['001.png', page], ['ComicInfo.xml', originalXml], ['nested/ComicInfo.xml', '<ComicInfo><Title>Other</Title></ComicInfo>']]));
  assert.equal(report.comicInfo.name, 'ComicInfo.xml'); assert.equal(report.comicInfo.xml, originalXml); assert.equal(report.requiresOutput, false);
  await assert.rejects(inspect(await zip([['001.png', page], ['a/ComicInfo.xml', originalXml], ['b/ComicInfo.xml', originalXml]])), code('AMBIGUOUS_COMICINFO'));
  await assert.rejects(inspect(await zip([['001.png', page], ['ComicInfo.xml', ''], ['a/ComicInfo.xml', originalXml], ['b/ComicInfo.xml', originalXml]])), code('AMBIGUOUS_COMICINFO'));
});
test('an empty top-level ComicInfo is replaced by the single nested copy', async () => {
  const page = await png(), nested = '<ComicInfo><Title>Nested</Title><Notes>CVDB123</Notes></ComicInfo>';
  const report = await inspect(await zip([['001.png', page], ['ComicInfo.xml', ''], ['Book/ComicInfo.xml', nested]]));
  assert.equal(report.comicInfo.name, 'ComicInfo.xml'); assert.equal(report.comicInfo.xml, nested); assert.equal(report.requiresOutput, true); assert.equal(report.metadataChanged, true);
  await validateCandidateBuffer({ input: await zip([['001.png', page], ['Book/ComicInfo.xml', nested], ['ComicInfo.xml', nested]]), report });
});
test('invalid UTF-8 or malformed XML remains blocked', async () => {
  for (const data of [Buffer.from([0xff, 0xfe, 0x61]), Buffer.from('<ComicInfo>'), Buffer.from('<?xml version="1.0" encoding="UTF-16"?><ComicInfo/>')]) {
    await assert.rejects(inspect(await zip([['001.png', await png()], ['ComicInfo.xml', data]])), error => ['UNSUPPORTED_ENCODING', 'INVALID_COMICINFO'].includes(error.code));
  }
});
for (const names of [['001.png', '001.png'], ['001.png', '001.PNG'], ['é.png', 'e\u0301.png']]) {
  test(`duplicate/case/Unicode member collision: ${names.join(' / ')}`, async () => {
    const page = await png(); await assert.rejects(inspect(await zip(names.map(name => [name, page]))), code('DUPLICATE_MEMBER'));
  });
}
test('file/directory aliasing and Windows reserved/stream paths are refused', async () => {
  for (const entries of [[['folder', 'file'], ['folder/001.png', await png()]], [['NUL.png', await png()]]]) {
    await assert.rejects(inspect(await zip(entries)), error => ['DUPLICATE_MEMBER', 'UNSAFE_MEMBER'].includes(error.code));
  }
  // archiver sanitizes drive-like prefixes, so alter the synthetic ZIP names.
  const stream = await zip([['safe.png', await png()]]);
  for (let start = 0; (start = stream.indexOf('safe.png', start)) >= 0; start += 8) stream.write('x:01.png', start);
  await assert.rejects(inspect(stream), error => error.code === 'UNSAFE_MEMBER' || /absolute path/.test(error.message));
});
test('traversal in ZIP names is rejected before reading its payload', async () => {
  const input = await zip([['safe.png', await png()]]);
  const tampered = Buffer.from(input);
  for (let start = 0; (start = tampered.indexOf('safe.png', start)) >= 0; start += 8) tampered.write('../x.png', start);
  await assert.rejects(inspect(tampered), /invalid relative path|Unsafe|Ambiguous/);
});
test('symlink/special members and encrypted flags are refused', async () => {
  const input = await zip([['001.png', await png()]]);
  const central = input.indexOf(Buffer.from('504b0102', 'hex'));
  const link = Buffer.from(input); link.writeUInt32LE(0xa1ff0000, central + 38);
  await assert.rejects(inspect(link), code('UNSAFE_MEMBER'));
  const encrypted = Buffer.from(input); encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
  await assert.rejects(inspect(encrypted), code('ENCRYPTED_ARCHIVE'));
});
test('corrupt member bytes fail CRC rather than passing on entry presence', async () => {
  const page = await png(), input = await zip([['001.png', page]], { store: true });
  const tampered = Buffer.from(input), offset = tampered.indexOf(page); assert.ok(offset >= 0); tampered[offset + 10] ^= 1;
  await assert.rejects(inspect(tampered), code('ARCHIVE_INTEGRITY'));
});
test('truncated ZIP directory cannot become a successful validation', async () => {
  const input = await zip([['001.png', await png()]]);
  await assert.rejects(inspect(input.subarray(0, input.length - 16)));
});
test('entry, member, expansion, input and ratio budgets are enforced', async () => {
  const input = await zip([['001.png', await png()], ['notes.txt', 'a'.repeat(10000)]]);
  for (const limits of [{ entries: 1 }, { memberBytes: 10 }, { expandedBytes: 100 }, { inputBytes: 10 }, { ratio: 2 }]) {
    await assert.rejects(inspect(input, { limits }), code('ARCHIVE_LIMIT'));
  }
  await assert.rejects(inspect(input, { limits: { inputBytes: DEFAULT_LIMITS.inputBytes + 1 } }), TypeError);
});
test('nested download ZIP is unwrapped for inspection only under explicit download mode', async () => {
  const inner = await zip([['folder/001.png', await png()], ['ComicInfo.xml', originalXml]]), outer = await zip([['Comic.cbr', inner]]);
  await assert.rejects(inspect(outer), code('NO_IMAGE_PAGES'));
  const report = await inspect(outer, { mode: 'download_container' });
  assert.equal(report.wrappers.length, 1); assert.equal(report.selectedArchiveFingerprint.sha256, hash(inner));
  assert.equal(report.sourceFingerprint.sha256, hash(outer)); assert.equal(report.requiresOutput, true);
  await validateCandidateBuffer({ input: inner, report });
});
test('ambiguous nested archives/outer metadata cannot be silently discarded', async () => {
  const inner = await zip([['001.png', await png()]]);
  for (const entries of [[['a.cbz', inner], ['b.cbz', inner]], [['a.cbz', inner], ['ComicInfo.xml', originalXml]]]) {
    await assert.rejects(inspect(await zip(entries), { mode: 'download_container' }), code('NO_IMAGE_PAGES'));
  }
});
test('nested depth and cumulative expansion are bounded across wrappers', async () => {
  let input = await zip([['001.png', await png()]]); input = await zip([['one.cbz', input]]); input = await zip([['two.cbz', input]]);
  await assert.rejects(inspect(input, { mode: 'download_container', limits: { depth: 1 } }), code('ARCHIVE_LIMIT'));
  await assert.rejects(inspect(input, { mode: 'download_container', limits: { expandedBytes: 100 } }), code('ARCHIVE_LIMIT'));
});
test('actual RAR signature is recognized without pretending it is a corrupt ZIP or converted CBZ', async () => {
  await assert.rejects(inspect(Buffer.from('526172211a070100000000', 'hex'), { sourceName: 'Comic.cbr' }), code('RAR_TOOL_REQUIRED'));
  const report = await inspect(await zip([['001.png', await png()]]));
  await assert.rejects(validateCandidateBuffer({ input: Buffer.from('526172211a07010000', 'hex'), report }), code('CBZ_REQUIRED'));
});
test('worker validates a real archive and a preservation-safe candidate without file paths', async () => {
  const input = await zip([['001.png', await png()], ['ComicInfo.xml', originalXml]]);
  const report = await inspectArchive({ input, sourceName: 'Comic.cbz' });
  assert.equal(report.requiresOutput, false);
  const candidate = await validateArchiveCandidate({ input, report }); assert.equal(candidate.fingerprint.sha256, hash(input));
});
test('worker reports integrity failures and exits before returning them', async () => {
  await assert.rejects(inspectArchive({ input: Buffer.from('not a ZIP'), sourceName: 'Comic.cbz' }), code('UNSUPPORTED_ARCHIVE'));
});
test('worker timeout and cancellation reject without leaving writable artifacts', async () => {
  const input = await zip([['001.png', await png()]]);
  await assert.rejects(inspectArchive({ input, sourceName: 'Comic.cbz' }, { timeoutMs: 1 }), code('ARCHIVE_TIMEOUT'));
  const controller = new AbortController();
  const pending = inspectArchive({ input, sourceName: 'Comic.cbz' }, { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, code('ARCHIVE_CANCELLED'));
  await assert.rejects(inspectArchive({ input, sourceName: 'Comic.cbz' }, { signal: controller.signal }), code('ARCHIVE_CANCELLED'));
});
test('JPEG, GIF and WebP page payloads are preserved without decoding', async () => {
  for (const format of ['jpeg', 'gif', 'webp']) {
    const page = await sharp(await png()).toFormat(format).toBuffer();
    const report = await inspect(await zip([[`001.${format}`, page]]));
    assert.equal(report.pages[0].sha256, hash(page)); assert.equal(report.pages[0].size, page.length);
  }
});
test('BMP pages retain their bytes without a metadata-specific decoder', async () => {
  const bmp = Buffer.alloc(70); bmp.write('BM'); bmp.writeUInt32LE(70, 2); bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(2, 18); bmp.writeInt32LE(2, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
  const input = await zip([['001.bmp', bmp]]), report = await inspect(input);
  assert.equal(report.pages[0].sha256, hash(bmp));
  await validateCandidateBuffer({ input, report });
});
test('a candidate cannot lose an image even while retaining valid ComicInfo', async () => {
  const page = await png();
  const report = await inspect(await zip([['001.png', page], ['002.png', page], ['ComicInfo.xml', originalXml]]));
  await assert.rejects(validateCandidateBuffer({ input: await zip([['001.png', page], ['ComicInfo.xml', originalXml]]), report }), code('ARCHIVE_PRESERVATION_FAILED'));
});
test('unsupported ZIP compression is held instead of reaching the decoder', async () => {
  const input = await zip([['001.png', await png()]]), central = input.indexOf(Buffer.from('504b0102', 'hex'));
  input.writeUInt16LE(99, central + 10);
  await assert.rejects(inspect(input), code('UNSUPPORTED_COMPRESSION'));
});
