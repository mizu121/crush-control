'use strict';
// Local packaging only: no package installation, certificate access, HID or publication.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { ROOT, STORE_STAGE, TEST_IDENTITY, SDK_TOOL, ASSETS, validateIdentity, manifestXml, distributionOverride } = require('../build/store-plan.cjs');
const { storeWindowsConfig } = require('../build/store-windows.cjs');
const { prepareStage, validateInputs, digest } = require('./release-build.cjs');
const { verifyPackage } = require('./verify-release.cjs');
const { LEGAL_FILES, legalDestination, PLUGIN_FILE } = require('../build/release-plan.cjs');
const slash = value => value.replace(/\\/g, '/');

function walkFiles(directory, base = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Store payload must not contain links.');
    if (entry.isDirectory()) return walkFiles(file, base);
    if (!entry.isFile()) throw new Error('Store payload must contain regular files.');
    return [slash(path.relative(base, file))];
  }).sort();
}

function assertPayloadInventory(files, electronFiles) {
  const allowed = new Set(electronFiles.filter(file => file !== 'version' && !file.startsWith('resources/')).map(file => file === 'electron.exe' ? 'Crush Control.exe' : file === 'LICENSE' ? 'LICENSE.electron.txt' : file));
  for (const file of ['resources/app.asar', 'resources/app-update.yml', `resources/${PLUGIN_FILE}`,
    'resources/app.asar.unpacked/node_modules/node-hid/prebuilds/HID-win32-x64/node-napi-v4.node',
    ...LEGAL_FILES.map(file => `resources/legal/${legalDestination(file)}`)]) allowed.add(file);
  const expected = [...allowed].sort();
  if (JSON.stringify(files) !== JSON.stringify(expected)) throw new Error('Electron payload inventory differs from the reviewed Store allowlist.');
  for (const file of files) if (/(^|\/)(backups|artifacts|tools|firmware|\.git)(\/|$)|\.(pem|key|pfx|p12|map|log)$/i.test(file)) throw new Error(`Private material in Store payload: ${file}`);
  return expected;
}

function iconAssets(destination) {
  const context = { module: { exports: {} }, Buffer, require(name) {
    if (name === 'zlib') return require('node:zlib');
    if (name === 'electron') return { nativeImage: { createFromBuffer: buffer => ({ toPNG: () => buffer }) } };
    throw new Error(`Unexpected icon dependency: ${name}`);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'app/icon.js'), 'utf8'), context, { timeout: 1000 });
  fs.mkdirSync(destination, { recursive: true });
  for (const [name, size] of Object.entries(ASSETS)) fs.writeFileSync(path.join(destination, name), context.module.exports.makeIcon(size).toPNG());
}

// OPC part names encode spaces, while 7-Zip preserves those encoded names on
// extraction. Decode one path segment at a time, never an encoded separator.
function msixPath(value) {
  return slash(value).split('/').map(segment => {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch (_) { throw new Error('Invalid MSIX part encoding.'); }
    if (!decoded || decoded === '.' || decoded === '..' || /[\\/:\x00-\x1f]/.test(decoded)) throw new Error('Unsafe MSIX archive entry.');
    return decoded;
  }).join('/');
}

async function verifyMsix(packageFile, layout, identity, mode) {
  validateIdentity(identity, mode);
  const sevenZip = await require('app-builder-lib/out/toolsets/7zip').getPath7za();
  const { stdout } = await execute(sevenZip, ['l', '-slt', packageFile], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  const body = stdout.split(/\r?\n----------\r?\n/)[1];
  if (!body) throw new Error('MSIX file inventory is missing.');
  const entries = [...body.matchAll(/^Path = (.+)$/gm)].map(match => slash(match[1].trim()));
  const normalizedEntries = entries.map(msixPath);
  if (new Set(normalizedEntries.map(name => name.toLowerCase())).size !== entries.length) throw new Error('Duplicate MSIX archive entry.');
  const verifyDir = fs.mkdtempSync(path.join(STORE_STAGE, '.msix-check-'));
  try {
    await execute(sevenZip, ['x', '-y', '-bd', `-o${verifyDir}`, packageFile], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const extracted = walkFiles(verifyDir);
    const sourceNames = new Map(extracted.map(file => [msixPath(file), file]));
    const actual = [...sourceNames.keys()], expected = walkFiles(layout);
    if (sourceNames.size !== extracted.length) throw new Error('Duplicate extracted MSIX entry.');
    const extra = actual.filter(file => !expected.includes(file));
    if (extra.some(file => !['AppxBlockMap.xml', '[Content_Types].xml'].includes(file)) || expected.some(file => !actual.includes(file))) throw new Error('MSIX includes missing or unexpected payload files.');
    for (const file of expected) if (digest(fs.readFileSync(path.join(verifyDir, sourceNames.get(file)))) !== digest(fs.readFileSync(path.join(layout, file)))) throw new Error(`MSIX payload bytes changed: ${file}`);
    if (fs.readFileSync(path.join(verifyDir, 'AppxManifest.xml'), 'utf8') !== manifestXml(identity, mode)) throw new Error('MSIX manifest differs from reviewed identity.');
    return { payloadFiles: expected.length, exactPayload: true, signed: false, mode, identity, filename: path.basename(packageFile), sha256: digest(fs.readFileSync(packageFile)), bytes: fs.statSync(packageFile).size };
  } finally {
    if (path.dirname(path.resolve(verifyDir)) !== STORE_STAGE || !path.basename(verifyDir).startsWith('.msix-check-') || fs.lstatSync(verifyDir).isSymbolicLink()) throw new Error('Unsafe MSIX inspection cleanup.');
    fs.rmSync(verifyDir, { recursive: true, force: true });
  }
}

async function verifyStoreCandidate({ mode, identity }) {
  identity = validateIdentity(identity, mode);
  const output = path.join(ROOT, storeWindowsConfig(mode).directories.output);
  const unpacked = path.join(output, 'win-unpacked');
  const layout = path.join(STORE_STAGE, 'msix-layout');
  const stage = JSON.parse(fs.readFileSync(path.join(STORE_STAGE, 'manifest.json'), 'utf8'));
  if (!stage.store || stage.store.mode !== mode || JSON.stringify(stage.store.identity) !== JSON.stringify(identity)) throw new Error('Staged Store identity differs from the candidate.');
  const release = distributionOverride(JSON.parse(fs.readFileSync(path.join(ROOT, 'app/release-config.json'), 'utf8')), mode);
  const releaseBytes = JSON.stringify(release, null, 2) + '\n';
  if (digest(releaseBytes) !== stage.store.distributionSha256) throw new Error('Store marker no longer matches the reviewed source override.');
  const packageReport = await verifyPackage(unpacked, { stageDirectory: STORE_STAGE });
  const asar = require('@electron/asar');
  if (digest(asar.extractFile(path.join(unpacked, 'resources/app.asar'), 'app/release-config.json')) !== stage.store.distributionSha256) throw new Error('Store distribution override not packaged exactly.');
  const files = assertPayloadInventory(walkFiles(unpacked), walkFiles(path.join(ROOT, 'node_modules/electron/dist')));
  const expectedLayout = [...files.map(file => `app/${file}`), ...Object.keys(ASSETS).map(file => `Assets/${file}`), 'AppxManifest.xml'].sort();
  if (JSON.stringify(walkFiles(layout)) !== JSON.stringify(expectedLayout)) throw new Error('Store layout includes missing or unexpected files.');
  for (const file of files) if (digest(fs.readFileSync(path.join(unpacked, file))) !== digest(fs.readFileSync(path.join(layout, 'app', file)))) throw new Error(`Store layout differs from the verified Electron payload: ${file}`);
  const packageFile = path.join(output, `${identity.name}_${identity.version}_x64.msix`);
  const report = await verifyMsix(packageFile, layout, identity, mode);
  const fullReport = { ...report, sourceAppVersion: stage.version, packageReport, distribution: release.distribution, appPayloadFiles: files.length, sourcePublished: false, installedOrLaunched: false, signaturePurpose: mode === 'test' ? 'Unsigned Windows 11 local test with special OID; not for public distribution.' : 'Unsigned Partner Center submission; Microsoft signs only after certification.' };
  fs.writeFileSync(path.join(output, `VERIFICATION-${identity.version}.json`), JSON.stringify(fullReport, null, 2) + '\n');
  fs.writeFileSync(path.join(output, `${path.basename(packageFile)}.sha256`), `${report.sha256}  ${path.basename(packageFile)}\n`);
  return fullReport;
}

async function buildStore({ mode, identity }) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Store candidate requires Windows x64.');
  identity = validateIdentity(identity, mode);
  if (!fs.statSync(SDK_TOOL).isFile()) throw new Error('Reviewed Windows SDK MakeAppx is unavailable.');
  const stage = await prepareStage({ stageDirectory: STORE_STAGE });
  const releaseFile = path.join(STORE_STAGE, 'app/app/release-config.json');
  const release = distributionOverride(JSON.parse(fs.readFileSync(releaseFile, 'utf8')), mode);
  const releaseBytes = JSON.stringify(release, null, 2) + '\n';
  fs.writeFileSync(releaseFile, releaseBytes);
  stage.store = { mode, identity, distributionOverride: release, distributionSha256: digest(releaseBytes) };
  fs.writeFileSync(path.join(STORE_STAGE, 'manifest.json'), JSON.stringify(stage, null, 2) + '\n');
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) delete process.env[name];
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  const config = storeWindowsConfig(mode);
  const { build, Platform, Arch } = require('electron-builder');
  await build({ projectDir: ROOT, config, publish: 'never', targets: Platform.WINDOWS.createTarget('dir', Arch.x64) });
  const output = path.join(ROOT, config.directories.output);
  const unpacked = path.join(output, 'win-unpacked');
  const packageReport = await verifyPackage(unpacked, { stageDirectory: STORE_STAGE });
  const asar = require('@electron/asar');
  if (digest(asar.extractFile(path.join(unpacked, 'resources/app.asar'), 'app/release-config.json')) !== stage.store.distributionSha256) throw new Error('Store distribution override not packaged exactly.');
  const files = assertPayloadInventory(walkFiles(unpacked), walkFiles(path.join(ROOT, 'node_modules/electron/dist')));
  const layout = path.join(STORE_STAGE, 'msix-layout');
  fs.mkdirSync(layout);
  for (const file of files) {
    const target = path.join(layout, 'app', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(unpacked, file), target);
  }
  iconAssets(path.join(layout, 'Assets'));
  fs.writeFileSync(path.join(layout, 'AppxManifest.xml'), manifestXml(identity, mode));
  const packageFile = path.join(output, `${identity.name}_${identity.version}_x64.msix`);
  if (fs.existsSync(packageFile)) throw new Error('MSIX candidate already exists; use a new package version instead of replacing bytes.');
  await execute(SDK_TOOL, ['pack', '/d', layout, '/p', packageFile, '/h', 'SHA256'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return verifyStoreCandidate({ mode, identity });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--check')) {
    const pkg = validateInputs();
    if (!fs.existsSync(SDK_TOOL)) throw new Error('Reviewed Windows SDK MakeAppx is unavailable.');
    console.log(JSON.stringify({ version: pkg.version, sdk: SDK_TOOL, testIdentity: validateIdentity(TEST_IDENTITY, 'test'), stage: STORE_STAGE, buildsOrInstalls: false }, null, 2));
    return;
  }
  let mode, identity;
  if (argv[0] === '--test' && (argv.length === 1 || (argv.length === 3 && argv[1] === '--version'))) {
    mode = 'test'; identity = { ...TEST_IDENTITY, ...(argv[2] ? { version: argv[2] } : {}) };
  } else if (argv[0] === '--store' && argv.length === 2) {
    mode = 'store'; identity = JSON.parse(fs.readFileSync(path.resolve(argv[1]), 'utf8'));
  } else throw new Error('Use --check, --test [--version 1.0.0.0], or --store <Partner-Center-identity.json>.');
  console.log(JSON.stringify(await buildStore({ mode, identity }), null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { walkFiles, assertPayloadInventory, msixPath, verifyMsix, verifyStoreCandidate, buildStore };
