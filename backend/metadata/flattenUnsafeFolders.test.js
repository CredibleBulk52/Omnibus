'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const archiver = require('archiver');
const yauzl = require('yauzl');
const { flattenUnsafeFolders } = require('./flattenUnsafeFolders');

function makeZip(file, members) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file), zip = archiver('zip', { store: true });
    out.on('close', resolve); zip.on('error', reject); zip.pipe(out);
    for (const [name, data] of members) zip.append(Buffer.from(data), { name });
    zip.finalize();
  });
}
const names = file => new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (e, z) => {
  if (e) return reject(e); const n = []; z.on('entry', en => { n.push(en.fileName); z.readEntry(); }); z.on('end', () => resolve(n.sort())); z.readEntry();
}));
function dir(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }

test('pages in a folder with a colon are moved to the top level, original kept', async t => {
  const d = dir(t), f = path.join(d, 'Wolverine 00.5.cbz');
  await makeZip(f, [['Wizard Wolverine 1:2/p01.jpg', 'one'], ['Wizard Wolverine 1:2/p02.jpg', 'two']]);
  const r = await flattenUnsafeFolders(f, { backupDir: path.join(d, 'backups') });
  assert.equal(r.changed, true); assert.equal(r.files, 2); assert.deepEqual(r.folders, ['Wizard Wolverine 1:2']);
  assert.deepEqual(await names(f), ['p01.jpg', 'p02.jpg']);
  assert.ok(fs.existsSync(r.backup));
  assert.deepEqual(fs.readdirSync(d).filter(n => n.endsWith('.tmp')), []);
});
test('safe archives are left alone', async t => {
  const d = dir(t), f = path.join(d, 'ok.cbz');
  await makeZip(f, [['Folder/p01.jpg', 'one']]);
  const before = fs.readFileSync(f);
  assert.equal((await flattenUnsafeFolders(f, {})).changed, false);
  assert.deepEqual(fs.readFileSync(f), before);
});
test('an unsafe page name itself, or clashing names, are not changed', async t => {
  const d = dir(t), a = path.join(d, 'a.cbz'), b = path.join(d, 'b.cbz');
  await makeZip(a, [['Pages/Cover: variant.jpg', 'x'], ['Pages/p01.jpg', 'y']]);
  await makeZip(b, [['Issue 1:2/p01.jpg', 'x'], ['Other:/P01.JPG', 'y']]);
  assert.equal((await flattenUnsafeFolders(a, {})).changed, false);
  assert.equal((await flattenUnsafeFolders(b, {})).changed, false);
});
