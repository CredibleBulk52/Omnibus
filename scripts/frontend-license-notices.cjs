'use strict';
// Copy license texts for the installed frontend runtime dependency graph.
// Build tools are excluded; dependencies are resolved from their installed parent.
const fs = require('node:fs');
const path = require('node:path');
function locate(name, from) {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const file = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(file)) return path.dirname(file);
    if (path.dirname(dir) === dir) return null;
  }
}
function collect(root) {
  const visited = new Set(), sections = [];
  function visit(name, from, optional = false) {
    const dir = locate(name, from);
    if (!dir) { if (optional) return; throw new Error('Missing runtime dependency: ' + name); }
    if (visited.has(dir)) return;
    visited.add(dir);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const files = fs.readdirSync(dir).filter(n => /^(?:licen[cs]e|copying|notice)(?:[._-].*|s)?$/i.test(n) && fs.statSync(path.join(dir, n)).isFile()).sort();
    if (!files.length) throw new Error('No license file found for ' + pkg.name);
    sections.push('=== ' + pkg.name + '@' + pkg.version + ' ===\n' + files.map(n => n + '\n\n' + fs.readFileSync(path.join(dir, n), 'utf8')).join('\n\n'));
    const optionalDeps = pkg.optionalDependencies || {};
    for (const dep of Object.keys({ ...pkg.dependencies, ...optionalDeps }).sort()) visit(dep, dir, dep in optionalDeps);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  // react-scripts is the build tool, although CRA places it in dependencies.
  for (const dep of Object.keys(pkg.dependencies || {}).sort()) if (dep !== 'react-scripts') visit(dep, root);
  return 'Omnibus frontend runtime dependency licenses\n\n' + sections.join('\n\n') + '\n';
}
if (require.main === module) {
  const root = path.resolve(process.argv[2] || 'frontend');
  const destination = path.resolve(process.argv[3] || path.join(root, 'build', 'third-party-licenses.txt'));
  const contents = collect(root);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}
module.exports = { collect };
