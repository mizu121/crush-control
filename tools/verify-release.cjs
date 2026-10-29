'use strict';
// Inspect bytes only. Never launch the app, enumerate HID, or open a keyboard.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { APP_FILES, GENERATED_APP_FILES, LEGAL_FILES, legalDestination, FUSES, APP_UPDATE_CONFIG, UPDATER_PACKAGES } = require('../build/release-plan.cjs');
const ROOT = path.resolve(__dirname, '..');
const normalized = name => name.replace(/\\/g, '/').replace(/^\/+/, '');
const archivePath = name => name.split('/').join(path.sep);

function isAllowedArchivePath(name, vendors) {
  if (name === 'package.json' || APP_FILES.includes(name) || GENERATED_APP_FILES.includes(name) || vendors.has(name)) return true;
  if (/^node_modules\/node-hid\/(nodehid\.js|binding-options\.js|package\.json|LICENSE[^/]*)$/.test(name)) return true;
  if (/^node_modules\/node-hid\/(prebuilds\/HID-win32-x64\/node-napi-v\d+\.node|build\/Release\/HID\.node)$/.test(name)) return true;
  return /^node_modules\/pkg-prebuilds\/(bindings\.js|lib\/[\w.-]+\.js|package\.json|LICENSE[^/]*)$/.test(name);
}

function assertX64Pe(buffer, label) {
  if (buffer.length < 64 || buffer.toString('ascii', 0, 2) !== 'MZ') throw new Error(`${label} is not a PE binary.`);
  const pe = buffer.readUInt32LE(60);
  if (pe + 6 > buffer.length || buffer.toString('ascii', pe, pe + 4) !== 'PE\0\0' || buffer.readUInt16LE(pe + 4) !== 0x8664) throw new Error(`${label} is not Windows x64.`);
}

function assertAppUpdateMetadata(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 8192) throw new Error('Invalid packaged update metadata.');
  const value = require('js-yaml').load(text, { schema: require('js-yaml').JSON_SCHEMA });
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== Object.keys(APP_UPDATE_CONFIG).sort().join(',') ||
      Object.entries(APP_UPDATE_CONFIG).some(([key, expected]) => value[key] !== expected)) throw new Error('Packaged update metadata differs from the pinned public beta feed.');
  return value;
}

async function verifyPackage(directory = path.join(ROOT, require('../build/windows.cjs').directories.output, 'win-unpacked'), { stageDirectory = path.join(ROOT, 'build/.release-stage') } = {}) {
  const stage = path.resolve(stageDirectory);
  if (![path.join(ROOT, 'build/.release-stage'), path.join(ROOT, 'build/.store-stage')].includes(stage)) throw new Error('Unsafe release verification staging path.');
  const asar = require('@electron/asar');
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
  if (JSON.stringify(manifest.updater?.packages) !== JSON.stringify(UPDATER_PACKAGES) ||
      !Object.keys(manifest.updater?.inputHashes || {}).length || JSON.stringify(manifest.appUpdate) !== JSON.stringify(APP_UPDATE_CONFIG)) throw new Error('Updater staging audit is missing or no longer matches the release plan.');
  for (const [file, hash] of Object.entries(manifest.sourceHashes)) {
    const current = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
    if (current !== hash) throw new Error(`Release source changed since staging; rebuild before distributing: ${file}`);
  }
  const vendors = new Set(manifest.vendorFiles);
  const archive = path.join(directory, 'resources/app.asar');
  const files = asar.listPackage(archive).map(normalized).filter(file => !asar.statFile(archive, archivePath(file)).files);
  const unexpected = files.filter(file => !isAllowedArchivePath(file, vendors));
  if (unexpected.length) throw new Error(`Unexpected packaged files: ${unexpected.join(', ')}`);
  for (const name of [...manifest.appFiles, ...vendors]) if (!files.includes(name)) throw new Error(`Missing packaged file: ${name}`);
  for (const name of files) if (/\.(map|log|pem|key|pfx|p12)$/i.test(name)) throw new Error(`Private or debug material packaged: ${name}`);
  const pkg = JSON.parse(asar.extractFile(archive, 'package.json'));
  if (pkg.version !== manifest.version || pkg.main !== 'app/entry.js' || pkg.license !== 'MIT') throw new Error('Packaged metadata mismatch.');
  for (const name of [...APP_FILES, ...GENERATED_APP_FILES].filter(file => /\.c?js$/.test(file))) {
    const text = asar.extractFile(archive, archivePath(name)).toString();
    if (/sourceMappingURL=/.test(text)) throw new Error(`Source map reference in app source: ${name}`);
    if (text.includes(ROOT) || text.includes(ROOT.replace(/\\/g, '\\\\'))) throw new Error(`Local workspace path in app source: ${name}`);
  }
  for (const name of [...APP_FILES, ...GENERATED_APP_FILES]) {
    if (!asar.extractFile(archive, archivePath(name)).equals(fs.readFileSync(path.join(stage, 'app', name)))) throw new Error(`Packaged application differs from reviewed staging: ${name}`);
  }
  for (const name of GENERATED_APP_FILES) {
    const hash = crypto.createHash('sha256').update(asar.extractFile(archive, archivePath(name))).digest('hex');
    if (hash !== manifest.generatedHashes?.[name]) throw new Error(`Generated runtime differs from audited bytes: ${name}`);
  }
  for (const name of vendors) {
    if (!asar.extractFile(archive, archivePath(name)).equals(fs.readFileSync(path.join(stage, 'vendor-runtime', name.replace(/^node_modules\//, ''))))) throw new Error(`Packaged vendor differs from reviewed staging: ${name}`);
  }
  assertAppUpdateMetadata(fs.readFileSync(path.join(directory, 'resources/app-update.yml'), 'utf8'));
  const native = files.filter(file => file.endsWith('.node'));
  if (!native.length) throw new Error('node-hid native addon is missing.');
  for (const file of native) {
    if (!asar.statFile(archive, archivePath(file)).unpacked) throw new Error(`Native addon must be unpacked: ${file}`);
    assertX64Pe(fs.readFileSync(path.join(directory, 'resources/app.asar.unpacked', file)), file);
  }
  for (const name of LEGAL_FILES) {
    const destination = path.join(directory, 'resources/legal', legalDestination(name));
    if (!fs.readFileSync(destination).equals(fs.readFileSync(path.join(ROOT, name)))) throw new Error(`Legal asset mismatch: ${name}`);
  }
  for (const name of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) if (!fs.statSync(path.join(directory, name)).size) throw new Error(`Missing Electron license: ${name}`);
  require('../build/legal-assets.cjs').validateRuntimeBytes(directory, JSON.parse(fs.readFileSync(path.join(ROOT, 'legal/third-party/runtime/runtime-source-manifest.json'))));
  const plugin = 'signalrgb/Wobkey_Crush80_VIA_Sync.js';
  if (!fs.readFileSync(path.join(directory, 'resources', plugin)).equals(fs.readFileSync(path.join(ROOT, plugin)))) throw new Error('SignalRGB plugin mismatch.');
  const exe = path.join(directory, 'Crush Control.exe');
  assertX64Pe(fs.readFileSync(exe), 'Application executable');
  const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
  const wire = await getCurrentFuseWire(exe);
  const fuseIds = { runAsNode: 'RunAsNode', enableNodeOptionsEnvironmentVariable: 'EnableNodeOptionsEnvironmentVariable', enableNodeCliInspectArguments: 'EnableNodeCliInspectArguments', onlyLoadAppFromAsar: 'OnlyLoadAppFromAsar', enableEmbeddedAsarIntegrityValidation: 'EnableEmbeddedAsarIntegrityValidation' };
  for (const [name, enabled] of Object.entries(FUSES)) if (wire[FuseV1Options[fuseIds[name]]] !== (enabled ? 49 : 48)) throw new Error(`Fuse mismatch: ${name}`);
  return {
    version: pkg.version, archiveFileCount: files.length, nativeAddons: native, fuses: FUSES,
    licenseAssets: LEGAL_FILES.length + 2, updaterPackages: manifest.updater.packages.length,
    updaterInputs: Object.keys(manifest.updater.inputHashes).length, appUpdate: APP_UPDATE_CONFIG,
    installedOrLaunched: false,
  };
}

function walkFiles(directory, base = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Release payload contains an unexpected link.');
    return entry.isDirectory() ? walkFiles(file, base) : [normalized(path.relative(base, file))];
  }).sort();
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const block of fs.createReadStream(file)) hash.update(block);
  return hash.digest('hex');
}
async function verifyInstaller(installer, unpacked, { extractionDirectory } = {}) {
  const compiledScript = require('../build/installer-inspection.cjs').inspectCompiledScript(installer);
  const tool = await require('app-builder-lib/out/toolsets/7zip').getPath7za();
  const execute = promisify(execFile);
  const { stdout } = await execute(tool, ['l', '-slt', installer], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  const body = stdout.split(/\r?\n----------\r?\n/)[1];
  if (!body) throw new Error('Installer payload inventory is missing.');
  const listed = [...body.matchAll(/^Path = (.+)$/gm)].map(match => match[1].trim());
  for (const name of listed) if (path.isAbsolute(name) || name.includes(':') || name.split(/[\\/]/).includes('..')) throw new Error('Unsafe installer payload path.');
  const buildDir = path.join(ROOT, 'build');
  if (fs.realpathSync(buildDir) !== buildDir) throw new Error('Build directory must not be a link.');
  let temporary;
  if (extractionDirectory) {
    temporary = path.resolve(extractionDirectory);
    const allowedParent = path.join(ROOT, 'artifacts', 'release-verification');
    if (path.dirname(temporary) !== allowedParent || fs.existsSync(temporary)) throw new Error('Installer extraction requires a new directory within artifacts/release-verification.');
    fs.mkdirSync(allowedParent, { recursive: true });
    if (fs.realpathSync(allowedParent) !== allowedParent) throw new Error('Installer extraction parent must not be a link.');
    fs.mkdirSync(temporary);
  } else temporary = fs.mkdtempSync(path.join(buildDir, '.installer-check-'));
  try {
    await execute(tool, ['x', '-y', '-bd', `-o${temporary}`, installer], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const expected = walkFiles(unpacked), actual = walkFiles(temporary);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Installer payload differs from unpacked file inventory.');
    for (const file of expected) if (await hashFile(path.join(temporary, file)) !== await hashFile(path.join(unpacked, file))) throw new Error(`Installer payload differs from verified unpacked bytes: ${file}`);
    return { installer: path.basename(installer), sha256: await hashFile(installer), bytes: fs.statSync(installer).size, payloadFileCount: expected.length, exactUnpackedPayload: true, processApis: compiledScript.processApis, forbiddenInstallerOperations: compiledScript.forbiddenOperations, installedOrLaunched: false };
  } finally {
    // Delete only the exact temporary directory created above under build/.
    if (!extractionDirectory) {
      if (path.dirname(path.resolve(temporary)) !== buildDir || !path.basename(temporary).startsWith('.installer-check-') || fs.lstatSync(temporary).isSymbolicLink()) throw new Error('Unsafe installer inspection cleanup path.');
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}

if (require.main === module) verifyPackage(process.argv[2]).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { isAllowedArchivePath, assertX64Pe, assertAppUpdateMetadata, verifyPackage, verifyInstaller };
