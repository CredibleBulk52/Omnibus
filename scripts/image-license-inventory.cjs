'use strict';
// Run against a clean release image, without application data or network access.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const NOTICE = /^(?:licen[cs]e|copying|copyright|notice|acknow)(?:[._-].*|s)?$/i;
function text(file) { return fs.readFileSync(file, 'utf8'); }
function notices(dir, depth = 0) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name);
    if (e.isFile() && NOTICE.test(e.name)) out.push({ path: file, text: text(file) });
    else if (e.isDirectory() && depth < 2 && /^(?:licenses?|licences?|legal)$/i.test(e.name)) out.push(...notices(file, depth + 1));
  }
  return out;
}
function npmPackages(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const folder = path.join(dir, e.name);
    if (e.name.startsWith('@')) { out.push(...npmPackages(folder)); continue; }
    const manifest = path.join(folder, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const p = JSON.parse(text(manifest));
    out.push({ name: p.name, version: p.version, path: folder,
      license: p.license || p.licenses || null, repository: p.repository || null,
      notices: notices(folder),
      readmeWhenNoNotice: notices(folder).length ? null : fs.readdirSync(folder).filter(n => /^readme(?:\.[^.]+)?$/i.test(n)).map(n => ({ path: path.join(folder, n), text: text(path.join(folder, n)) })),
      nativeVersions: p.name?.startsWith('@img/sharp-libvips-') && fs.existsSync(path.join(folder, 'versions.json')) ? JSON.parse(text(path.join(folder, 'versions.json'))) : null,
      nativeReadme: p.name?.startsWith('@img/') && fs.existsSync(path.join(folder, 'README.md')) ? text(path.join(folder, 'README.md')) : null });
    out.push(...npmPackages(path.join(folder, 'node_modules')));
  }
  return out;
}
function alpinePackages(raw) {
  return raw.trim().split(/\n\s*\n/).map(block => {
    const fields = {};
    for (const line of block.split('\n')) {
      const match = /^([A-Za-z]):(.*)$/.exec(line);
      if (match && !(match[1] in fields)) fields[match[1]] = match[2];
    }
    return { name: fields.P, version: fields.V, license: fields.L || null,
      origin: fields.o || null, sourceCommit: fields.c || null, homepage: fields.U || null };
  }).filter(p => p.name);
}
function frontendNotices(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => n.endsWith('.LICENSE.txt')).map(n => ({ path: path.join(dir, n), text: text(path.join(dir, n)) }));
}
function inventory() {
  const required = ['/usr/share/doc/omnibus/LICENSE', '/usr/share/doc/omnibus/THIRD_PARTY_NOTICES.md',
    '/app/frontend/build/third-party-licenses.txt',
    '/usr/share/doc/omnibus/native/README.md', '/usr/share/doc/omnibus/native/coverage.json',
    '/usr/share/doc/omnibus/native/review-status.json', '/usr/share/doc/omnibus/native/scope-review.json',
    '/usr/share/doc/omnibus/native/alpine-NOTICES.txt', '/usr/share/doc/omnibus/native/libvips-NOTICES.txt',
    '/usr/share/doc/unrar/license.txt', '/usr/share/doc/unrar/acknow.txt', '/usr/share/doc/unrar/readme.txt'];
  const documents = required.map(file => {
    const contents = text(file); if (!contents.trim()) throw new Error('Empty notice: ' + file);
    return { path: file, text: contents };
  });
  const python = JSON.parse(execFileSync('python3', ['-c',
    'import importlib.metadata as m, json; print(json.dumps([{"name": d.metadata["Name"], "version": d.version, "license": d.metadata.get("License-Expression") or d.metadata.get("License"), "homepage": d.metadata.get("Home-page"), "licenseFiles": d.metadata.get_all("License-File") or []} for d in m.distributions()]))'
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  // Vite (2026-11-03) writes no *.LICENSE.txt beside the bundle; the notices generated at build
  // time (scripts/frontend-license-notices.cjs -> build/third-party-licenses.txt) cover the browser code.
  const browser = [...frontendNotices('/app/frontend/build/static/js'), ...frontendNotices('/app/frontend/build/static')];
  if (!browser.length) browser.push(documents.find(d => d.path === '/app/frontend/build/third-party-licenses.txt'));
  if (!browser.length || !browser.every(n => n && n.text.trim())) throw new Error('No generated frontend license notices found');
  return { schemaVersion: 1, nodeVersion: process.version,
    scope: 'Installed image metadata and selected notices; not a complete SBOM or corresponding-source bundle. Python license file names are metadata only; Alpine license texts and base-image global tools need separate review.',
    documents, alpine: alpinePackages(text('/lib/apk/db/installed')),
    backend: npmPackages('/app/backend/node_modules'), python, frontend: browser };
}
if (require.main === module) process.stdout.write(JSON.stringify(inventory(), null, 2) + '\n');
module.exports = { alpinePackages, npmPackages, frontendNotices };
