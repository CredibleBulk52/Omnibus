'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const archiver = require('archiver');
const sharp = require('sharp');
const { createArchiveTools } = require('./archiveTools');
const { createArchiveToolRunner } = require('./archiveToolRunner');
const { prepareValidatedZip } = require('./archiveStaging');
const { inspectArchiveBuffer, validateCandidateBuffer } = require('./archiveValidationCore');
const { planMetadataMerge } = require('./merge');
const { storedRar } = require('./testFixtures/storedRar');
const code = expected => error => error.code === expected;
const binary = process.env.OMNIBUS_TEST_7Z || '7z';
const available = !spawnSync(binary, [], { windowsHide: true }).error;
const realTool = { skip: !available && 'Set OMNIBUS_TEST_7Z to verify real 7-Zip staging' };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-tools-test-'));
  t.after(() => {
    const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('omnibus-tools-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return root;
}
function zip(entries) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip'), chunks = [];
    archive.on('error', reject); archive.on('data', c => chunks.push(c)); archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, data] of entries) archive.append(data, { name });
    archive.finalize().catch(reject);
  });
}
const page = () => sharp({ create: { width: 4, height: 3, channels: 3, background: '#56789a' } }).png().toBuffer();
const xml = '<ComicInfo><Title>Keep</Title><Pages><Page Image="0" Bookmark="Cover"/></Pages><Extra a="b"/></ComicInfo>';
const metadata = () => ({ bookId: 'one', cvIssueId: '123', plan: planMetadataMerge({ bookId: 'one', decision: { status: 'accepted', bookId: 'one', cvIssueId: '123' }, currentXml: xml, source: { cvIssueId: '123', fields: { Writer: 'Added credit' } } }) });

test('legacy shared builder preserves original XML/Apple cleanup and 7z invocation behavior', async () => {
  const calls = [];
  const tools = createArchiveTools({ run: async (...args) => calls.push(['run', ...args]), fileSystem: {
    writeFileSync: (...args) => calls.push(['write', ...args]),
    readdirSync: () => ['001.png', '._001.png', '__MACOSX', 'notes.txt'],
    unlinkSync: name => { calls.push(['unlink', name]); if (name.endsWith('__MACOSX')) throw Error('directory'); },
  } });
  await tools.createCbzFromDir('/staging/source', '/staging/output.tmp', xml);
  assert.deepEqual(calls, [ ['write', path.join('/staging/source', 'ComicInfo.xml'), xml, 'utf8'],
    ['unlink', path.join('/staging/source', '._001.png')], ['unlink', path.join('/staging/source', '__MACOSX')],
    ['run', '7z', ['a', '-tzip', '-mx=6', '/staging/output.tmp', path.join('/staging/source', '*')], { maxBuffer: 100 * 1024 * 1024 }] ]);
});
for (const [profile, source, expected] of [['download', 'file.cbr', ['unrar', 'bsdtar']], ['retag', 'file.cbr', ['unrar', '7z', 'bsdtar']], ['download', 'file.cbz', ['7z', 'bsdtar']], ['retag', 'file.cbz', ['bsdtar']]]) {
  test(`legacy ${profile} ${source} retains fallback order and flattening flags`, async () => {
    const calls = [], fallback = [];
    const tools = createArchiveTools({ run: async (tool, args, options) => { calls.push({ tool, args, options }); if (tool !== expected.at(-1)) throw Error('fixture tool failed'); } });
    await tools.extractArchive({ profile, source, directory: '/scratch', onFallback: event => fallback.push(event.tool) });
    assert.deepEqual(calls.map(c => c.tool), expected); assert.deepEqual(fallback, expected.slice(0, -1));
    for (const call of calls) {
      assert.equal(call.args[0], call.tool === 'bsdtar' ? '-xf' : 'e');
      if (call.tool === 'bsdtar') {
        assert.equal(call.options.env.LANG, 'C'); assert.equal(call.options.env.LC_ALL, 'C');
        assert.equal(call.options.maxBuffer, source.endsWith('.cbr') ? 50 * 1024 * 1024 : undefined);
      }
    }
  });
}
test('path preservation is explicit; actual ZIP format can override a misleading CBR suffix', async () => {
  const calls = []; const tools = createArchiveTools({ run: async (...args) => calls.push(args) });
  await tools.extractArchive({ profile: 'download', source: 'misnamed.cbr', directory: '/scratch', format: 'zip', preservePaths: true });
  assert.deepEqual(calls[0].slice(0, 2), ['7z', ['x', '-y', '-o/scratch', 'misnamed.cbr']]);
});
test('preserving RAR extraction reuses unrar x and isolated fallback directories', async () => {
  const calls = []; const tools = createArchiveTools({ run: async (tool, args) => { calls.push([tool, args]); if (tool === 'unrar') throw Error('fixture failure'); } });
  const result = await tools.extractArchive({ profile: 'retag', source: 'source.rar', preservePaths: true,
    attemptDirectory: async ({ index }) => `/scratch/attempt-${index}` });
  assert.deepEqual(calls[0], ['unrar', ['x', '-inul', '-y', 'source.rar', '/scratch/attempt-0/']]);
  assert.deepEqual(calls[1], ['7z', ['x', '-y', '-o/scratch/attempt-1', 'source.rar']]);
  assert.equal(result.directory, '/scratch/attempt-1');
});
test('cancellation/timeouts do not invoke another extraction fallback', async () => {
  for (const reason of ['ARCHIVE_CANCELLED', 'ARCHIVE_TIMEOUT', 'ARCHIVE_OUTPUT_LIMIT', 'ABORT_ERR']) {
    let calls = 0; const tools = createArchiveTools({ run: async () => { calls++; throw Object.assign(Error('stopped'), { code: reason }); } });
    await assert.rejects(tools.extractArchive({ profile: 'retag', source: 'source.rar', directory: '/scratch' }), code(reason));
    assert.equal(calls, 1);
  }
});
test('last extraction failure and CBZ builder failure propagate unchanged', async () => {
  const failure = Error('tool failed'); const tools = createArchiveTools({ run: async () => { throw failure; } });
  await assert.rejects(tools.extractArchive({ profile: 'retag', source: 'source.cbz', directory: '/scratch' }), e => e === failure);
  await assert.rejects(tools.buildCbzFromDirectory('/scratch', '/candidate'), e => e === failure);
});
test('archive runner captures output, nonzero exits and missing executables', async () => {
  const run = createArchiveToolRunner({ executables: { '7z': process.execPath } });
  assert.equal((await run('7z', ['-e', 'process.stdout.write("ok")'])).stdout, 'ok');
  await assert.rejects(run('7z', ['-e', 'process.exit(7)']), code('ARCHIVE_TOOL_FAILED'));
  await assert.rejects(createArchiveToolRunner({ executables: { '7z': 'omnibus-nonexistent-test-binary' } })('7z', []), e => e.code === 'ENOENT');
});
test('archive runner kills timed-out/noisy children and waits for close', async () => {
  await assert.rejects(createArchiveToolRunner({ executables: { '7z': process.execPath }, timeoutMs: 150 })('7z', ['-e', 'setInterval(()=>{},1000)']), code('ARCHIVE_TIMEOUT'));
  await assert.rejects(createArchiveToolRunner({ executables: { '7z': process.execPath }, maxOutputBytes: 32 })('7z', ['-e', 'process.stdout.write("x".repeat(1000));setInterval(()=>{},1000)']), code('ARCHIVE_OUTPUT_LIMIT'));
});
test('cancelled converter has stopped writing before the runner rejects', async t => {
  const root = fixture(t), heartbeat = path.join(root, 'heartbeat'); const controller = new AbortController();
  const pending = createArchiveToolRunner({ executables: { '7z': process.execPath }, signal: controller.signal })('7z', ['-e', 'const fs=require("fs");setInterval(()=>fs.appendFileSync(process.argv[1],"x"),10)', heartbeat]);
  const checked = assert.rejects(pending, code('ARCHIVE_CANCELLED'));
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(heartbeat) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort(); await checked;
  assert.ok(fs.existsSync(heartbeat)); const size = fs.statSync(heartbeat).size;
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(fs.statSync(heartbeat).size, size);
});
test('actual shared 7z builder creates a validated CBZ from an existing prepared directory', realTool, async t => {
  const root = fixture(t), source = path.join(root, 'input'), output = path.join(root, 'built.cbz'); fs.mkdirSync(source);
  const image = await page(); fs.writeFileSync(path.join(source, '001.png'), image);
  const expected = await inspectArchiveBuffer({ input: await zip([['001.png', image], ['ComicInfo.xml', xml]]), sourceName: 'source.cbz' });
  await createArchiveTools({ run: createArchiveToolRunner({ executables: { '7z': binary } }) }).createCbzFromDir(source, output, xml);
  await validateCandidateBuffer({ input: fs.readFileSync(output), report: expected });
});
test('real tool staging preserves nested pages, unknown members, Apple files and XML annotations', realTool, async t => {
  const root = fixture(t), image = await page();
  const input = await zip([['z/001.png', image], ['a/001.png', image], ['nested/ComicInfo.xml', xml], ['notes.txt', 'keep'], ['__MACOSX/._001.png', 'resource'], ['empty/', '']]);
  const result = await prepareValidatedZip({ input, sourceName: 'source.cbz', metadata: metadata(), scratchParent: root, executables: { '7z': binary } });
  assert.equal(result.status, 'prepared'); assert.ok(fs.existsSync(result.candidatePath));
  assert.deepEqual(result.report.pages.map(p => p.name), ['a/001.png', 'z/001.png']);
  assert.equal(result.report.comicInfo.xml, xml.replace('</ComicInfo>', '<Writer>Added credit</Writer></ComicInfo>'));
  assert.ok(result.report.expectedMembers.some(m => m.name === '__MACOSX/._001.png'));
  await result.cleanup(); await result.cleanup(); assert.deepEqual(fs.readdirSync(root), []);
});
test('real tool normalizes ZIP-as-CBR without requiring metadata patches or deleting input bytes', realTool, async t => {
  const root = fixture(t), input = await zip([['001.png', await page()], ['ComicInfo.xml', xml]]), original = Buffer.from(input);
  const result = await prepareValidatedZip({ input, sourceName: 'source.cbr', scratchParent: root, executables: { '7z': binary } });
  assert.equal(result.status, 'prepared'); assert.equal(result.report.metadataChanged, false);
  assert.ok(result.candidatePath.endsWith('.cbz')); assert.deepEqual(input, original); await result.cleanup();
});
test('validated ZIP no-op creates no scratch and runs no converter', async t => {
  const root = fixture(t), input = await zip([['001.png', await page()]]);
  const result = await prepareValidatedZip({ input, sourceName: 'source.cbz', scratchParent: root, executables: { '7z': 'nonexistent' } });
  assert.equal(result.status, 'unchanged'); assert.deepEqual(fs.readdirSync(root), []);
});
test('failed converter attempts clean only their owned scratch after process closure', async t => {
  const root = fixture(t); fs.writeFileSync(path.join(root, 'unrelated.txt'), 'keep');
  const input = await zip([['001.png', await page()]]);
  await assert.rejects(prepareValidatedZip({ input, sourceName: 'source.cbr', scratchParent: root,
    executables: { '7z': 'omnibus-missing-7z', bsdtar: 'omnibus-missing-bsdtar' } }), e => e.code === 'ENOENT');
  assert.deepEqual(fs.readdirSync(root), ['unrelated.txt']); assert.equal(fs.readFileSync(path.join(root, 'unrelated.txt'), 'utf8'), 'keep');
});
// 2026-10-22: a download ZIP holding a single .cbr (GetComics' "….zip") is unwrapped and converted
// through the same RAR path as a .cbr download; it used to be held (RAR_TOOL_REQUIRED) and retried forever.
test('nested RAR wrapper in a download is unwrapped and converted through the RAR path', async t => {
  const tar = process.env.OMNIBUS_TEST_BSDTAR || 'bsdtar', sevenZip = process.env.OMNIBUS_TEST_7Z || '7z';
  if (spawnSync(tar, ['--version'], { windowsHide: true }).error || spawnSync(sevenZip, [], { windowsHide: true }).error) return t.skip('7z and bsdtar required');
  const root = fixture(t);
  const outer = await zip([['inside.cbr', storedRar([['001.png', await page()]])]]);
  const result = await prepareValidatedZip({ input: outer, sourceName: 'download.zip', mode: 'download_container', scratchParent: root,
    executables: { unrar: 'omnibus-test-unrar-unavailable', bsdtar: tar, '7z': sevenZip } });
  assert.equal(result.status, 'prepared');
  assert.deepEqual(result.report.pages.map(p => p.name), ['001.png']);
  assert.ok(result.candidatePath.endsWith('.cbz'));
  await result.cleanup(); assert.deepEqual(fs.readdirSync(root), []);
});
test('nested RAR in a library book (not a download) is still held', async t => {
  const root = fixture(t);
  const outer = await zip([['inside.cbr', storedRar([['001.png', await page()]])]]);
  await assert.rejects(prepareValidatedZip({ input: outer, sourceName: 'book.cbz', mode: 'library', scratchParent: root }), e => ['RAR_TOOL_REQUIRED', 'NO_IMAGE_PAGES'].includes(e.code));
});
test('parent directories may be explicit in converter output without changing file/page identity', async () => {
  const image = await page(), report = await inspectArchiveBuffer({ input: await zip([['pages/001.png', image]]), sourceName: 'source.cbz' });
  await validateCandidateBuffer({ input: await zip([['pages/', ''], ['pages/001.png', image]]), report });
});
test('implicit parent paths cannot conceal case or Unicode spelling collisions', async () => {
  const image = await page();
  await assert.rejects(inspectArchiveBuffer({ input: await zip([['Folder/001.png', image], ['folder/002.png', image]]), sourceName: 'source.cbz' }), code('DUPLICATE_MEMBER'));
});
test('implicit folders count toward resource bounds before native extraction', async () => {
  await assert.rejects(inspectArchiveBuffer({ input: await zip([['a/b/c/001.png', await page()]]), sourceName: 'source.cbz', limits: { entries: 3 } }), code('ARCHIVE_LIMIT'));
});

test('nested ZIP downloads stage the exact selected comic through the shared converter', realTool, async t => {
  const root = fixture(t), image = await page();
  const inner = await zip([['z/001.png', image], ['a/001.png', image], ['meta/ComicInfo.xml', xml], ['notes.txt', 'keep']]);
  const middle = await zip([['nested/issue.cbr', inner]]);
  const outer = await zip([['release/inner.zip', middle], ['__MACOSX/._inner.zip', 'wrapper resource']]);
  const original = Buffer.from(outer);
  const result = await prepareValidatedZip({ input: outer, sourceName: 'download.zip', mode: 'download_container', metadata: metadata(), scratchParent: root, executables: { '7z': binary } });
  assert.equal(result.status, 'prepared'); assert.equal(result.report.wrappers.length, 2);
  assert.deepEqual(result.report.selectedArchiveFingerprint, { sha256: require('node:crypto').createHash('sha256').update(inner).digest('hex'), size: inner.length });
  assert.deepEqual(outer, original);
  assert.deepEqual(result.validation.pages.map(p => p.name), ['a/001.png', 'z/001.png']);
  assert.equal(result.report.selectedArchiveBytes, undefined);
  assert.ok(result.report.wrappers[0].members.some(m => m.name === '__MACOSX/._inner.zip'));
  assert.ok(result.report.comicInfo.xml.includes('<Writer>Added credit</Writer>'));
  await result.cleanup(); assert.deepEqual(fs.readdirSync(root), []);
});

test('nested staging rejects ambiguity, outer metadata, library mode and budget excess before scratch', async t => {
  const root = fixture(t), inner = await zip([['001.png', await page()]]);
  const prepare = (input, extra = {}) => prepareValidatedZip({ input, sourceName: 'download.zip', mode: 'download_container', scratchParent: root, executables: { '7z': 'nonexistent' }, ...extra });
  await assert.rejects(prepare(await zip([['a.cbz', inner], ['b.cbz', inner]])), code('NO_IMAGE_PAGES'));
  await assert.rejects(prepare(await zip([['a.cbz', inner], ['ComicInfo.xml', xml]])), code('NO_IMAGE_PAGES'));
  const outer = await zip([['a.cbz', inner]]);
  await assert.rejects(prepare(outer, { mode: 'library' }), code('NO_IMAGE_PAGES'));
  await assert.rejects(prepare(outer, { limits: { expandedBytes: inner.length } }), code('ARCHIVE_LIMIT'));
  await assert.rejects(prepare(await zip([['a.zip', outer]]), { limits: { depth: 1 } }), code('ARCHIVE_LIMIT'));
  await assert.rejects(prepare(await zip([['release/a.cbz', await zip([['pages/001.png', await page()]])]]), { limits: { entries: 3 } }), code('ARCHIVE_LIMIT'));
  assert.deepEqual(fs.readdirSync(root), []);
});

test('nested staging without XML changes still unwraps and normalizes', realTool, async t => {
  const root = fixture(t), inner = await zip([['001.png', await page()], ['ComicInfo.xml', xml]]);
  const input = await zip([['a.zip', await zip([['b.zip', await zip([['issue.cbz', inner]])]])]]);
  const result = await prepareValidatedZip({ input, sourceName: 'download.cbz', mode: 'download_container', scratchParent: root, executables: { '7z': binary } });
  assert.equal(result.report.wrappers.length, 3); assert.equal(result.report.metadataChanged, false);
  assert.equal(result.validation.comicInfo.xml, xml); await result.cleanup();
});

const tarBinary = process.env.OMNIBUS_TEST_BSDTAR || (process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'bsdtar');
const tarAvailable = !spawnSync(tarBinary, ['--version'], { windowsHide: true }).error;
test('real stored RAR5 uses existing bsdtar fallback and shared CBZ builder with exact payload preservation', { skip: (!available || !tarAvailable) && '7z and bsdtar required' }, async t => {
  const root = fixture(t), image = await page();
  const entries = [['z/001.png', image], ['a/001.png', image], ['meta/ComicInfo.xml', xml], ['notes.txt', 'retain'], ['__MACOSX/._001.png', 'resource']];
  const input = storedRar(entries), source = path.join(root, 'fixture.cbr'), output = path.join(root, 'converted.cbz');
  fs.writeFileSync(source, input);
  const tools = createArchiveTools({ run: createArchiveToolRunner({ executables: { unrar: 'omnibus-test-unrar-unavailable', bsdtar: tarBinary, '7z': binary } }) });
  const extraction = await tools.extractArchive({ source, format: 'rar', profile: 'download', preservePaths: true,
    attemptDirectory: async ({ index }) => { const directory = path.join(root, `attempt-${index}`); await fsp.mkdir(directory); return directory; } });
  assert.equal(extraction.tool, 'bsdtar');
  await tools.buildCbzFromDirectory(extraction.directory, output);
  const expected = await inspectArchiveBuffer({ input: await zip(entries), sourceName: 'expected.cbz' });
  const checked = await validateCandidateBuffer({ input: fs.readFileSync(output), report: expected });
  assert.deepEqual(checked.pages.map(p => p.name), ['a/001.png', 'z/001.png']);
  assert.equal(checked.comicInfo.xml, xml); assert.deepEqual(fs.readFileSync(source), input);
});

test('existing converter tags large pages and BMP without changing their bytes or XML annotations',realTool,async t=>{
 const root=fixture(t),large=await sharp({create:{width:5000,height:4000,channels:3,background:'#56789a'}}).png().toBuffer();
 const bmp=Buffer.alloc(70);bmp.write('BM');bmp.writeUInt32LE(70,2);bmp.writeUInt32LE(54,10);bmp.writeUInt32LE(40,14);bmp.writeInt32LE(2,18);bmp.writeInt32LE(2,22);bmp.writeUInt16LE(1,26);bmp.writeUInt16LE(24,28);
 const input=await zip([['001.png',large],['002.bmp',bmp],['ComicInfo.xml',xml]]);
 const result=await prepareValidatedZip({input,sourceName:'Comic.cbz',metadata:metadata(),scratchParent:root,executables:{'7z':binary}});
 assert.equal(result.status,'prepared');assert.match(result.report.comicInfo.xml,/<Writer>Added credit<\/Writer>/);assert.match(result.report.comicInfo.xml,/Bookmark="Cover"/);
 const output=await fsp.readFile(result.candidatePath),checked=await validateCandidateBuffer({input:output,report:result.report});
 assert.deepEqual(checked.pages.map(p=>p.name),['001.png','002.bmp']);await result.cleanup();
});
