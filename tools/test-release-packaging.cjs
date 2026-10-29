'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const config = require('../build/windows.cjs');
const { APP_FILES, GENERATED_APP_FILES, APP_UPDATE_CONFIG, UPDATE_PUBLISH, UPDATER_PACKAGES } = require('../build/release-plan.cjs');
const { isAllowedArchivePath, assertX64Pe, assertAppUpdateMetadata } = require('./verify-release.cjs');
const { sourceFile, vendorFiles, updaterBundle, digest } = require('./release-build.cjs');

test('distribution policy keeps a private per-user unsigned candidate and never auto-runs', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.main, 'app/entry.js');
  assert.equal(config.appId, 'io.crush80.control');
  assert.equal(config.productName, 'Crush Control');
  assert.equal(config.executableName, 'Crush Control');
  assert.equal(config.asar, true);
  assert.equal(config.npmRebuild, true);
  assert.deepEqual(config.publish, UPDATE_PUBLISH);
  assert.equal(config.publish.private, false);
  assert.equal(config.publish.channel, 'beta');
  const build = fs.readFileSync(path.join(__dirname, 'release-build.cjs'), 'utf8');
  assert.match(build, /await build\(\{ projectDir: ROOT, config, publish: 'never'/);
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.oneClick, true);
  assert.equal(config.nsis.allowElevation, false);
  assert.equal(config.nsis.runAfterFinish, false);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.equal(config.win.requestedExecutionLevel, 'asInvoker');
});

test('archive allowlist rejects backups, firmware, helper scripts, personal data and maps', () => {
  const vendors = new Set(['node_modules/three/build/three.module.js']);
  for (const file of [...APP_FILES, ...GENERATED_APP_FILES]) assert.equal(isAllowedArchivePath(file, vendors), true, file);
  for (const file of ['backups/keymap.json', 'tools/flash.js', 'firmware/stock.bin', 'artifacts/diagnostic.json', 'app/presets.json', '.env', 'README.md', 'node_modules/three/examples/jsm/libs/draco/draco_decoder.js', 'node_modules/node-hid/prebuilds/HID-win32-ia32/node-napi-v4.node', 'app/renderer/app.js.map']) assert.equal(isAllowedArchivePath(file, vendors), false, file);
  assert.equal(isAllowedArchivePath('node_modules/node-hid/prebuilds/HID-win32-x64/node-napi-v4.node', vendors), true);
  for (const file of ['app/vendor/unreviewed.cjs', 'app/signing-key.pem', 'app/update-token.json', 'node_modules/electron-updater/out/main.js']) assert.equal(isAllowedArchivePath(file, vendors), false, file);
});

test('release path resolver refuses traversal and missing inputs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crush-release-test-'));
  try {
    fs.writeFileSync(path.join(root, 'allowed.txt'), 'ok');
    assert.equal(sourceFile(root, 'allowed.txt'), path.join(root, 'allowed.txt'));
    assert.throws(() => sourceFile(root, '../outside.txt'), /Invalid release path/);
    assert.throws(() => sourceFile(root, root), /Invalid release path/);
    assert.throws(() => sourceFile(root, 'missing.txt'), /ENOENT/);
  } finally {
    // This exact directory was created by mkdtemp above and remains under tmp.
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Three imports have an exact closure without unrelated vendor examples', async () => {
  const files = await vendorFiles(require('esbuild'));
  assert.ok(files.includes('node_modules/three/build/three.core.js'));
  assert.ok(files.includes('node_modules/three/examples/jsm/shaders/SSAOShader.js'));
  assert.ok(files.includes('node_modules/@tabler/core/dist/css/tabler.min.css'));
  assert.ok(files.length < 30, `Unexpected dependency growth: ${files.length} files`);
  assert.ok(files.every(file => !file.includes('/libs/') && !file.endsWith('.map')));
});

test('installer waits only for an explicit update, with a bounded loop and no process termination', () => {
  const text = fs.readFileSync(path.join(__dirname, '../build/installer.nsh'), 'utf8');
  const checker = fs.readFileSync(path.join(__dirname, '../build/installer-process-check.nsh'), 'utf8');
  assert.match(text, /!macro customCheckAppRunning/);
  assert.match(text, /Call \$\{CC_PROCESS_CHECK\}/);
  assert.match(text, /\$R0 != 603/);
  assert.match(text, /SetErrorLevel 2/);
  assert.match(text, /SetErrorLevel 3/);
  assert.match(text, /StrCpy \$R3 0/);
  assert.match(text, /!ifndef BUILD_UNINSTALLER[\s\S]*\$\{If\} \$\{isUpdated\}[\s\S]*StrCpy \$R3 40[\s\S]*!endif/);
  assert.match(checker, /IntCmp \$9 0 cc_cleanup cc_cleanup/);
  assert.match(checker, /Sleep 250\s+IntOp \$9 \$9 - 1/);
  assert.match(checker, /RmRegisterResources/);
  assert.match(checker, /RmGetList/);
  assert.match(checker, /RmEndSession/);
  const generator = fs.readFileSync(path.join(__dirname, '../node_modules/app-builder-lib/out/targets/nsis/nsisScriptGenerator.js'), 'utf8');
  assert.match(generator, /StdUtils.TestParameter/);
  assert.doesNotMatch(text + checker, /nsProcess::_|_KillProcess|_CloseProcess|taskkill|Stop-Process|ExecShell|RmShutdown|RmRestart/);
});

test('packaged feed metadata rejects credentials, alternate providers and repository drift', () => {
  assert.deepEqual(assertAppUpdateMetadata(JSON.stringify(APP_UPDATE_CONFIG)), APP_UPDATE_CONFIG);
  const variations = [
    { ...APP_UPDATE_CONFIG, token: 'not-a-real-token' },
    { ...APP_UPDATE_CONFIG, private: true }, { ...APP_UPDATE_CONFIG, owner: 'someone-else' },
    { ...APP_UPDATE_CONFIG, repo: 'other' }, { ...APP_UPDATE_CONFIG, channel: 'latest' },
    { ...APP_UPDATE_CONFIG, provider: 'generic', url: 'https://example.invalid' },
    { ...APP_UPDATE_CONFIG, updaterCacheDirName: '../other' },
    { ...APP_UPDATE_CONFIG, publisherName: 'unreviewed' },
  ];
  for (const value of variations) assert.throws(() => assertAppUpdateMetadata(JSON.stringify(value)), /pinned public beta feed/);
  assert.throws(() => assertAppUpdateMetadata('provider: github\nprovider: generic\n'), /duplicated mapping key/);
  assert.throws(() => assertAppUpdateMetadata('x'.repeat(8193)), /Invalid packaged/);
});

test('updater bundle has a reviewed closure, recorded source hashes and full license notices', async () => {
  const bundle = await updaterBundle(require('esbuild'));
  assert.equal(bundle.packages.length, 16);
  assert.deepEqual(bundle.packages, UPDATER_PACKAGES);
  assert.equal(Object.keys(bundle.inputHashes).length, 160);
  assert.ok(bundle.code.length < 350000);
  assert.equal(digest(bundle.code), bundle.sha256);
  for (const [file, expected] of Object.entries(bundle.sourceHashes)) assert.equal(digest(fs.readFileSync(path.join(__dirname, '..', file))), expected, file);
  assert.ok(bundle.externals.includes('electron'));
  assert.ok(bundle.externals.every(name => name === 'electron' || require('node:module').isBuiltin(name)));
  assert.doesNotMatch(Buffer.from(bundle.code).toString(), /sourceMappingURL=/);
  assert.ok(bundle.inputHashes['node_modules/electron-updater/node_modules/semver/index.js']);
});

test('updater version drift is rejected before compilation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crush-updater-audit-'));
  try {
    fs.mkdirSync(path.join(root, 'node_modules/electron-updater'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/electron-updater': { version: '99.0.0' } } }));
    fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.txt'), 'electron-updater 6.8.11');
    fs.writeFileSync(path.join(root, 'node_modules/electron-updater/package.json'), JSON.stringify({ name: 'electron-updater', version: '99.0.0', license: 'MIT' }));
    let compiled = false;
    await assert.rejects(updaterBundle({ build() { compiled = true; } }, root), /Review updater dependency change/);
    assert.equal(compiled, false);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native verification rejects wrong architecture without loading a binary', () => {
  const file = fs.readFileSync(path.join(__dirname, '../node_modules/node-hid/prebuilds/HID-win32-x64/node-napi-v4.node'));
  assert.doesNotThrow(() => assertX64Pe(file, 'node-hid'));
  const bad = Buffer.from(file);
  bad.writeUInt16LE(0x14c, bad.readUInt32LE(60) + 4);
  assert.throws(() => assertX64Pe(bad, 'node-hid'), /not Windows x64/);
});

test('builder configuration validates against the pinned installed builder schema', async () => {
  await require('app-builder-lib/out/util/config/config').validateConfiguration(config, { isEnabled: false });
});

test('native prebuild gate rejects unexpected dependencies before loading any addon', async () => {
  const gate = require('../build/native-prebuild.cjs');
  await assert.rejects(gate({ appDir: path.join(__dirname, '..'), platform: { nodeName: 'linux' }, arch: 'x64' }), /Windows x64 only/);
  await assert.rejects(gate({ appDir: path.join(__dirname, '..'), platform: { nodeName: 'win32' }, arch: 'x64' }), /changed native dependencies/);
});
