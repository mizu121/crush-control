'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const FFMPEG_SHA256 = '06c7fb1de78d22e4a5a6195c5c748789f509c81e5efd669d70ee16e00732f436';

// Only notice/source-index documents enter the installer. Source archives are
// delivered separately; never sweep research artifacts into the application.
function noticeFiles(relative) {
  const directory = path.join(ROOT, relative);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw new Error(`Linked legal asset: ${relative}/${entry.name}`);
    const name = `${relative}/${entry.name}`;
    if (entry.name === 'source-specs.json') return [];
    if (entry.isDirectory()) return ['sources', 'source-additions', '.git', 'node_modules'].includes(entry.name) ? [] : noticeFiles(name);
    return entry.isFile() && (name.includes('/LICENSES/') || /\.(txt|md|json|html)$/i.test(entry.name)) ? [name] : [];
  }).sort();
}
function legalDestination(file) {
  if (file.startsWith('legal/')) return file.slice(6);
  return path.basename(file);
}
function assertUniqueLegalPaths(files) {
  const targets = files.map(file => legalDestination(file).toLowerCase());
  if (new Set(targets).size !== files.length) throw new Error('Legal assets have colliding destinations.');
}
function validateRuntimeNotices(root, files) {
  const base = 'legal/third-party/runtime/';
  for (const required of ['NOTICE.txt', 'SOURCE_ACCESS.md', 'SOURCE_INDEX.md', 'runtime-source-manifest.json']) {
    if (!files.includes(base + required)) throw new Error(`Required runtime notice is missing: ${required}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, base, 'runtime-source-manifest.json')));
  const version = /^Electron([^ ]+) \/ Chromium/.exec(manifest.runtimeVersion || '')?.[1];
  if (version !== '45.1.0' || version !== require(path.join(root, 'node_modules/electron/package.json')).version) throw new Error('Runtime licence inventory does not match audited Electron version.');
  const expected = [...manifest.materials.flatMap(item => item.licenceFiles || []),
    ...manifest.deliveredRuntimeNotices.map(item => ({ ...item, localPath: item.path }))];
  if (!expected.length) throw new Error('Runtime licence manifest is empty.');
  for (const item of expected) {
    const name = base + item.localPath;
    if (!files.includes(name) || /(^|\/)\.\.(\/|$)/.test(item.localPath)) throw new Error(`Required runtime licence is missing: ${name}`);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
    if (hash !== item.sha256) throw new Error(`Runtime licence hash differs: ${name}`);
  }
  validateRuntimeBytes(path.join(root, 'node_modules/electron/dist'), manifest);
}
function validateRuntimeBytes(directory, manifest) {
  const files = [{ path: 'ffmpeg.dll', sha256: FFMPEG_SHA256 }, ...manifest.deliveredRuntimeNotices];
  for (const item of files) {
    let file = path.join(directory, item.path);
    if (item.path === 'LICENSE.electron.txt' && !fs.existsSync(file)) file = path.join(directory, 'LICENSE');
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (actual !== item.sha256) throw new Error(`Runtime bytes differ from licensing audit: ${item.path}`);
  }
}
module.exports = { noticeFiles, legalDestination, assertUniqueLegalPaths, validateRuntimeNotices, validateRuntimeBytes };
