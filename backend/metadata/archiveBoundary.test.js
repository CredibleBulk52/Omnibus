'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const { createArchiveTools } = require('./archiveTools');
const { storedRar } = require('./testFixtures/storedRar');
const exec = promisify(execFile);
const binary = process.platform === 'win32' ? 'tar.exe' : 'bsdtar';
const probe = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true });
const skip = probe.error ? 'libarchive tar is not installed' : false;

// Real RAR extraction, with all possible escape destinations inside our owned
// temporary root. No production database or comic files are opened.
for (const member of ['../outside.txt', '..\\outside.txt', 'nested/../../outside.txt']) {
  test('RAR libarchive fallback cannot overwrite parent file via ' + member, { skip }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-rar-boundary-'));
    t.after(() => {
      const resolved = path.resolve(root);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('omnibus-rar-boundary-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    });
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'sentinel');
    const source = path.join(root, 'malicious.rar');
    fs.writeFileSync(source, storedRar([['safe.txt', 'safe payload'], [member, 'overwrite']]));
    let extractionCalls = 0;
    const tools = createArchiveTools({ run: async (tool, args, options) => {
      if (tool !== 'bsdtar') throw Object.assign(new Error('Force libarchive fallback'), { code: 'ENOENT' });
      if (args.includes('-xf')) extractionCalls++;
      return exec(binary, args, { ...options, timeout: 5000, windowsHide: true });
    }});
    let error;
    try {
      await tools.extractArchive({ source, profile: 'retag', preservePaths: true,
        attemptDirectory: async ({ index }) => {
          const directory = path.join(root, 'attempt-' + index);
          fs.mkdirSync(directory); return directory;
        }
      });
    } catch (caught) { error = caught; }
    assert.ok(extractionCalls > 0, 'must exercise actual extraction');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'sentinel');
    const attempts = fs.readdirSync(root).filter(n => n.startsWith('attempt-'));
    assert.ok(attempts.some(n => fs.existsSync(path.join(root, n, 'safe.txt'))), 'valid member must extract; a broken fixture is not a security pass');
    t.diagnostic('libarchive: ' + probe.stdout.trim() + '; result: ' + (error?.code || 'completed'));
  });
}

for (const kind of ['symlink', 'hardlink']) {
  test('RAR libarchive fallback cannot overwrite through an escaping ' + kind, { skip }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-rar-boundary-'));
    t.after(() => {
      const resolved = path.resolve(root);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('omnibus-rar-boundary-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(root, 'outside'));
    const victim = path.join(root, 'outside', 'victim.txt');
    fs.writeFileSync(victim, 'sentinel');
    const name = kind === 'symlink' ? 'redirect/victim.txt' : 'redirect';
    const link = kind === 'symlink'
      ? {type:1, target:'../outside', directory:true}
      : {type:4, target:'../outside/victim.txt'};
    const source = path.join(root, 'malicious.rar');
    fs.writeFileSync(source, storedRar([['safe.txt','safe payload'], ['redirect',{link}], [name,'overwrite']]));
    const listing = (await exec(binary, ['-tvf',source], {timeout:5000, windowsHide:true})).stdout;
    assert.match(listing, kind === 'symlink' ? /redirect -> \.\.\/outside/ : /redirect link to \.\.\/outside\/victim\.txt/,
      'tool must recognize the fixture as a link');
    const diagnostics = [];
    const tools = createArchiveTools({run:async(tool,args,options)=>{
      if(tool !== 'bsdtar') throw Object.assign(new Error('Force libarchive fallback'),{code:'ENOENT'});
      try {return await exec(binary,args,{...options,timeout:5000,windowsHide:true});}
      catch(error){diagnostics.push(String(error.stderr || '').slice(0,600));throw error;}
    }});
    let error;
    try {
      await tools.extractArchive({source,profile:'retag',preservePaths:true,attemptDirectory:async({index})=>{
        const directory=path.join(root,'attempt-'+index);fs.mkdirSync(directory);return directory;
      }});
    } catch(caught){error=caught;}
    assert.equal(fs.readFileSync(victim,'utf8'),'sentinel');
    assert.ok(fs.readdirSync(root).filter(n=>n.startsWith('attempt-')).some(n=>fs.existsSync(path.join(root,n,'safe.txt'))),
      'valid archive member must extract');
    t.diagnostic('Result: '+(error?.code || 'completed')+'; '+diagnostics.join(' | '));
  });
}
