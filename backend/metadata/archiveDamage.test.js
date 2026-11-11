'use strict';
// Damaged archives (Excalibur #75, 2026-10-15): one unreadable member stops
// every tool. Omnibus names the damaged members (ARCHIVE_DAMAGED), and only an
// explicit "Convert anyway" (salvage) continues without them. A tool that
// exits 0 but skipped a member is caught by the member list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createArchiveTools } = require('./archiveTools');

const MEMBERS = ['Book/', 'Book/01.jpg', 'Book/02.jpg', 'Book/03.jpg'];
function setup(t, { bad = ['Book/02.jpg'], wholeOk = false, skip = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'in.cbr'); fs.writeFileSync(source, 'not a real rar');
  const write = (dir, name) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), 'x'); };
  const fail = () => Object.assign(new Error('exit 3'), { code: 'ARCHIVE_TOOL_FAILED' });
  const run = async (tool, args) => {
    if (tool === 'unrar' && args[0] === 'lb') return { stdout: MEMBERS.map(m => m.replace(/\/$/, '')).join('\n') + '\n' };
    if (tool === 'bsdtar' && args[0] === '-tf') return { stdout: MEMBERS.join('\n') };
    if (tool === 'unrar' && args[0] === 'x' && args.length === 7) {   // one member: x -inul -y <archive> -- <member> <dir>/
      assert.equal(args[4], '--');
      const name = args[5], dir = args[6];
      if (bad.includes(name)) { write(dir, name); throw fail(); }   // partly written, then fails
      if (MEMBERS.includes(name + '/')) fs.mkdirSync(path.join(dir, name), { recursive: true });   // a folder
      else write(dir, name);
      return { stdout: '' };
    }
    if (wholeOk) {   // whole-archive extraction "succeeds" but skips some members
      const dir = tool === 'unrar' ? args[args.length - 1] : tool === '7z' ? args.find(a => a.startsWith('-o')).slice(2) : args[args.indexOf('-C') + 1];
      for (const m of MEMBERS) if (!m.endsWith('/') && !skip.includes(m)) write(dir, m);
      return { stdout: '' };
    }
    throw fail();
  };
  let n = 0;
  const attemptDirectory = async () => { const d = path.join(root, `attempt-${n++}`); fs.mkdirSync(d); return d; };
  const tools = createArchiveTools({ run });
  const extract = (salvage = false) => tools.extractArchive({ source, profile: 'retag', format: 'rar', preservePaths: true, attemptDirectory, salvage });
  return { extract };
}

test('a damaged member is named instead of "tool exited with 1"', async t => {
  const { extract } = setup(t);
  await assert.rejects(extract(), e => e.code === 'ARCHIVE_DAMAGED' && /1 of 3 files cannot be read \(02\.jpg\)/.test(e.message) && /Convert anyway to keep the 2 readable files/.test(e.message));
});

test('Convert anyway keeps the readable members and drops the damaged one', async t => {
  const { extract } = setup(t);
  const out = await extract(true);
  assert.deepEqual(out.damaged, ['Book/02.jpg']);
  assert.deepEqual(fs.readdirSync(path.join(out.directory, 'Book')).sort(), ['01.jpg', '03.jpg']);   // the partial 02.jpg is removed
});

test('a tool that exits 0 but skipped a member is caught by the member list', async t => {
  const { extract } = setup(t, { wholeOk: true, skip: ['Book/03.jpg'] });
  await assert.rejects(extract(), e => e.code === 'ARCHIVE_DAMAGED' && /\(03\.jpg\)/.test(e.message));
  const ok = setup(t, { wholeOk: true });
  assert.equal((await ok.extract()).damaged, undefined);
});

test('nothing readable is not "damaged pages": the tool error stands', async t => {
  const { extract } = setup(t, { bad: MEMBERS.slice(1) });
  await assert.rejects(extract(true), e => e.code === 'ARCHIVE_TOOL_FAILED');
});

// Old Mac-made RAR files (Fantastic Four #107, 2026-10-16): unrar exits 3 on
// unsupported sub-blocks after extracting every member correctly. Accepted
// only when every member matches the archive's own size and CRC32.
function rar4(members) {
  const zlib = require('node:zlib');
  const parts = [Buffer.from('Rar!\x1a\x07\x00', 'latin1'), Buffer.from([0, 0, 0x73, 0, 0, 13, 0, 0, 0, 0, 0, 0, 0])];
  for (const { name, data } of members) {
    const n = Buffer.from(name, 'latin1'), h = Buffer.alloc(32);
    h.writeUInt16LE(0, 0); h[2] = 0x74; h.writeUInt16LE(0x8000, 3); h.writeUInt16LE(32 + n.length, 5);
    h.writeUInt32LE(data.length, 7); h.writeUInt32LE(data.length, 11); h[15] = 4; h.writeUInt32LE(zlib.crc32(data) >>> 0, 16);
    h[25] = 0x30; h.writeUInt16LE(n.length, 26); h.writeUInt32LE(0x20, 28);
    parts.push(h, n, data);
  }
  return Buffer.concat(parts);
}
function crcSetup(t, written) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pages = [{ name: 'Book\\01.jpg', data: Buffer.from('page one') }, { name: 'Book\\02.jpg', data: Buffer.from('page two') }];
  const source = path.join(root, 'in.cbr'); fs.writeFileSync(source, rar4(pages));
  const run = async (tool, args) => {
    if (tool === 'unrar' && args[0] === 'x' && args.length === 5) {   // whole archive
      const dir = args[4];
      for (const [i, p] of pages.entries()) { const f = path.join(dir, p.name.replace('\\', '/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, written[i]); }
      throw Object.assign(new Error('unrar exited with 3'), { code: 'ARCHIVE_TOOL_FAILED', exitCode: 3 });
    }
    throw Object.assign(new Error('exit 1'), { code: 'ARCHIVE_TOOL_FAILED' });
  };
  const directory = path.join(root, 'out'); fs.mkdirSync(directory);
  return createArchiveTools({ run }).extractArchive({ source, directory, profile: 'retag', format: 'rar', preservePaths: true });
}
test('unrar exit 3 is accepted when every member matches its CRC', async t => {
  const out = await crcSetup(t, [Buffer.from('page one'), Buffer.from('page two')]);
  assert.equal(out.tool, 'unrar'); assert.equal(out.crcVerified, true);
});
test('unrar exit 3 with a member that fails its CRC is not accepted', async t => {
  await assert.rejects(crcSetup(t, [Buffer.from('page one'), Buffer.from('page tw0')]));
});
