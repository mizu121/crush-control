'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, STORE_STAGE, TEST_IDENTITY, UNSIGNED_OID, validateIdentity, manifestXml, distributionOverride } = require('../build/store-plan.cjs');
const { storeWindowsConfig } = require('../build/store-windows.cjs');
const { stagePath, STAGE } = require('./release-build.cjs');
const { assertPayloadInventory, msixPath } = require('./store-build.cjs');
const { LEGAL_FILES, legalDestination, PLUGIN_FILE } = require('../build/release-plan.cjs');

test('local test identity cannot masquerade as a signed Store identity', () => {
  assert.deepEqual(validateIdentity(TEST_IDENTITY, 'test'), TEST_IDENTITY);
  assert.match(manifestXml(TEST_IDENTITY, 'test'), new RegExp(UNSIGNED_OID.replace(/\./g, '\\.')));
  for (const patch of [{ name: 'Other.App' }, { publisher: 'CN=Microsoft' }, { displayName: 'Crush Control' }]) assert.throws(() => validateIdentity({ ...TEST_IDENTITY, ...patch }, 'test'), /fixed/);
  assert.throws(() => validateIdentity(TEST_IDENTITY, 'store'), /real reserved identity/);
});

test('real Store package requires explicit valid identity and a Store-compatible version', () => {
  const identity = { name: '12345Developer.CrushControl', publisher: 'CN=00000000-1111-2222-3333-444444444444', publisherDisplayName: 'Developer', displayName: 'Crush Control', version: '1.0.1.0' };
  assert.deepEqual(validateIdentity(identity, 'store'), identity);
  assert.doesNotMatch(manifestXml(identity, 'store'), /OID\./);
  for (const version of ['1.0.0-beta.7', '1.0.0.1', '0.1.0.0', '65536.0.0.0', '1.00.0.0']) assert.throws(() => validateIdentity({ ...identity, version }, 'store'), /version/);
  assert.throws(() => validateIdentity({ ...identity, secret: 'not allowed' }, 'store'), /exactly/);
  assert.throws(() => validateIdentity({ ...identity, name: '../App' }, 'store'), /identity name/);
});

test('MSIX manifest uses full trust with limited capabilities and disabled startup', () => {
  const xml = manifestXml(TEST_IDENTITY, 'test');
  assert.match(xml, /EntryPoint="Windows.FullTrustApplication"/);
  assert.match(xml, /TrustLevel="mediumIL"/);
  assert.match(xml, /TaskId="CrushControlStartup" Enabled="false"/);
  assert.match(xml, /uap10:Parameters="--hidden"/);
  assert.match(xml, /<rescap:Capability Name="runFullTrust"/);
  assert.equal((xml.match(/:Capability /g) || []).length, 1);
  assert.doesNotMatch(xml, /allowElevation|broadFileSystemAccess|unvirtualizedResources|DeviceCapability/);
});

test('Store staging and output never replace the NSIS release directories', () => {
  assert.equal(stagePath(), STAGE);
  assert.equal(stagePath(STORE_STAGE), STORE_STAGE);
  assert.notEqual(STORE_STAGE, STAGE);
  for (const unsafe of [ROOT, path.join(ROOT, 'build'), path.join(ROOT, 'dist/private-beta'), path.join(ROOT, 'build/.store-stage/child')]) assert.throws(() => stagePath(unsafe), /Unsafe/);
  const normal = require('../build/windows.cjs');
  for (const mode of ['test', 'store']) {
    const config = storeWindowsConfig(mode);
    assert.notEqual(config.directories.app, normal.directories.app);
    assert.notEqual(config.directories.output, normal.directories.output);
    assert.equal(config.publish, null);
    assert.equal(config.forceCodeSigning, false);
    assert.equal(config.win.target[0].target, 'dir');
    assert(config.extraResources.every(item => !item.from.includes('.release-stage')));
    assert.deepEqual(config.files, normal.files);
  }
});

test('Store directory build validates against the pinned builder schema', async () => {
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
  for (const mode of ['test', 'store']) await validateConfiguration(storeWindowsConfig(mode), { isEnabled: false });
});

test('Store marker override preserves all release fields without altering its source', () => {
  const source = { name: 'Crush Control', channel: 'Private beta', donationUrl: null };
  const testRelease = distributionOverride(source, 'test');
  assert.equal(source.channel, 'Private beta');
  assert.equal(source.distribution, undefined);
  assert.equal(testRelease.distribution, 'microsoft-store-test');
  assert.equal(testRelease.channel, 'store-test');
  assert.equal(distributionOverride(source, 'store').distribution, 'microsoft-store');
  assert.equal(distributionOverride(source, 'store').channel, 'store');
  assert.throws(() => distributionOverride(source, 'github'), /Invalid/);
});

test('outer Electron inventory rejects private files outside ASAR as well', () => {
  const electron = ['electron.exe', 'LICENSE', 'LICENSES.chromium.html', 'locales/en-US.pak', 'version', 'resources/default_app.asar'];
  const valid = ['Crush Control.exe', 'LICENSE.electron.txt', 'LICENSES.chromium.html', 'locales/en-US.pak',
    'resources/app.asar', 'resources/app-update.yml', `resources/${PLUGIN_FILE}`,
    'resources/app.asar.unpacked/node_modules/node-hid/prebuilds/HID-win32-x64/node-napi-v4.node',
    ...LEGAL_FILES.map(file => `resources/legal/${legalDestination(file)}`)].sort();
  assert.deepEqual(assertPayloadInventory(valid, electron), valid);
  for (const secret of ['presets.json', 'resources/signing-key.pem', 'tools/flash.js', 'resources/firmware.bin']) assert.throws(() => assertPayloadInventory([...valid, secret].sort(), electron), /inventory/);
  assert.throws(() => assertPayloadInventory(valid.filter(file => !file.endsWith('.node')), electron), /inventory/);
});

test('OPC names decode literal spaces without permitting encoded path traversal', () => {
  assert.equal(msixPath('app/Crush%20Control.exe'), 'app/Crush Control.exe');
  assert.equal(msixPath('AppxManifest.xml'), 'AppxManifest.xml');
  for (const value of ['../secret', 'app/%2e%2e/secret', 'app%2fsecret', 'app%5csecret', '/absolute', 'C%3a/secret', 'app/%00', 'app/%GG', 'app//secret']) assert.throws(() => msixPath(value), /Unsafe|Invalid/);
});

test('local install helper pins exact hash and test identity without trust or security changes', () => {
  const source = fs.readFileSync(path.join(__dirname, 'store-install-test.ps1'), 'utf8');
  assert.match(source, /Get-FileHash -LiteralPath \$crushPackage -Algorithm SHA256/);
  assert.match(source, /if \(-not \$Install\)/);
  assert.match(source, /Add-AppxPackage -Path \$crushPackage -AllowUnsigned -ErrorAction Stop/);
  assert.match(source, /WindowsBuiltInRole\]::Administrator/);
  assert.match(source, /DeveloperModeChanged|developerModeChanged/);
  assert.doesNotMatch(source, /Import-Certificate|New-SelfSignedCertificate|Set-ItemProperty|ForceApplicationShutdown|Stop-Process|ExecutionPolicy Bypass/);
});
