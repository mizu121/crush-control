'use strict';
// Store isolation tests use fake Electron and keyboard objects only. They do
// not load node-hid, open Windows apps, change startup, or perform network I/O.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { resolveDistribution, userDataName, releaseInfo } = require('../app/distribution');
const { createAppUpdater } = require('../app/app-updater');
const release = require('../app/release-config.json');
const storeConfig = distribution => ({ ...release, distribution });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('native MSIX identity blocks direct updates without a staged marker', () => {
  const distribution = resolveDistribution({ windowsStore: true }, release);
  assert.equal(distribution.isStore, true);
  assert.equal(distribution.kind, 'microsoft-store');
  assert.equal(distribution.storeTest, false);
  assert.equal(Object.isFrozen(distribution), true);
});

test('in-ASAR test marker isolates the profile even outside an installed package', () => {
  const distribution = resolveDistribution({ windowsStore: false }, storeConfig('microsoft-store-test'));
  assert.equal(distribution.isStore, true);
  assert.equal(distribution.storeTest, true);
  assert.equal(userDataName(distribution), 'crush80-control-store-test');
  assert.equal(userDataName(resolveDistribution({ windowsStore: false }, release)), 'crush80-control');
  assert.equal(userDataName(resolveDistribution({ windowsStore: true }, storeConfig('microsoft-store'))), 'crush80-control');
});

test('unknown distribution marker fails closed while missing marker retains direct behavior', () => {
  for (const marker of [null, false, '', 'direct', 'microsoft-store-tset', {}]) {
    const distribution = resolveDistribution({ windowsStore: false }, storeConfig(marker));
    assert.equal(distribution.valid, false);
    assert.equal(distribution.isStore, true);
    assert.equal(distribution.storeTest, true);
  }
  assert.equal(resolveDistribution({ windowsStore: false }, release).kind, 'direct');
});

test('About metadata derives Store channel from staged marker without an explicit override', () => {
  const metadata = releaseInfo({ version: '1.0.0', packaged: true }, storeConfig('microsoft-store-test'));
  assert.equal(metadata.distribution, 'microsoft-store-test');
  assert.equal(metadata.channel, 'Store test');
  assert.equal(metadata.storeTest, true);
  assert.equal(metadata.name, 'Crush Control');
  assert.match(metadata.license, /Proprietary/);
});

function updateFixture({ native = false, marker, opener } = {}) {
  const calls = [], changes = [];
  const forbidden = name => () => { calls.push(name); throw new Error(`Unexpected ${name}`); };
  const updater = createAppUpdater({
    app: { isPackaged: true, getVersion: () => '1.0.0-beta.7' }, platform: 'win32', windowsStore: native,
    distribution: marker === undefined ? undefined : resolveDistribution({ windowsStore: native }, storeConfig(marker)),
    // Merely reading the direct-update config would violate Store isolation.
    config: new Proxy({}, { ownKeys() { throw new Error('Direct config was read'); } }),
    loadUpdater: forbidden('load-engine'), fetchManifest: forbidden('fetch'),
    verifyReleaseEnvelope: forbidden('verify-envelope'), verifyInstaller: forbidden('verify-installer'),
    assertUpdateInfo: forbidden('assert-info'), prepareInstall: forbidden('cleanup-for-installer'),
    openStoreUpdates: async uri => { calls.push(uri); if (opener) await opener(); },
    onChange: value => changes.push(value),
  });
  return { updater, calls, changes };
}

test('native Store and staged test builds never read direct config or call any NSIS adapter', async () => {
  for (const options of [{ native: true }, { marker: 'microsoft-store' }, { marker: 'microsoft-store-test' }]) {
    const f = updateFixture(options), status = f.updater.status();
    assert.equal(status.phase, 'store-managed');
    assert.equal(status.canCheck, false);
    assert.equal(status.canDownload, false);
    assert.equal(status.canInstall, false);
    for (const action of ['check', 'download', 'install']) await assert.rejects(f.updater[action]());
    assert.deepEqual(f.calls, []);
  }
});

test('local Store test does not claim Store publication or open an unrelated Store product', async () => {
  const f = updateFixture({ native: true, marker: 'microsoft-store-test' });
  assert.match(f.updater.status().message, /local Store test is not published/);
  assert.equal(f.updater.status().canOpenStore, false);
  await assert.rejects(f.updater.openStore(), /unavailable/);
  assert.deepEqual(f.calls, []);
});

test('real Store action opens only the fixed Updates page and returns refreshed status', async () => {
  const f = updateFixture({ native: true });
  const state = await f.updater.openStore('https://untrusted.invalid/installer.exe');
  assert.deepEqual(f.calls, ['ms-windows-store://downloadsandupdates']);
  assert.equal(state.phase, 'store-managed');
  assert.equal(state.canOpenStore, true);
  assert.equal(state.revision, 2);
  assert.equal(f.changes[0].canOpenStore, false);
});

test('Store opener failures do not fall back to the direct updater', async () => {
  const f = updateFixture({ native: true, opener: async () => { throw new Error('Store unavailable'); } });
  await assert.rejects(f.updater.openStore(), /Store unavailable/);
  assert.deepEqual(f.calls, ['ms-windows-store://downloadsandupdates']);
  assert.equal(f.updater.status().canOpenStore, true);
  f.updater.stop();
  assert.equal(f.updater.status().canOpenStore, false);
  await assert.rejects(f.updater.openStore(), /closing/);
  for (const action of ['check', 'download', 'install']) await assert.rejects(f.updater[action](), /closing/);
});

test('closing during an open Store request prevents late success', async () => {
  let finish;
  const f = updateFixture({ native: true, opener: () => new Promise(resolve => { finish = resolve; }) });
  const opening = f.updater.openStore();
  await assert.rejects(f.updater.openStore(), /unavailable/);
  f.updater.stop(); finish();
  await assert.rejects(opening, /closing/);
  assert.equal(f.updater.status().phase, 'disabled');
  assert.deepEqual(f.calls, ['ms-windows-store://downloadsandupdates']);
});

function mainFixture({ native = false, marker } = {}) {
  const ipc = new Map(), paths = new Map(), calls = [], intervals = [];
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: true, whenReady: () => Promise.resolve(), requestSingleInstanceLock: () => true,
    getVersion: () => '1.0.0-beta.7', getPath: name => paths.get(name) || `C:\\mock\\${name}`,
    setPath: (name, value) => paths.set(name, value), getAppPath: () => 'C:\\mock\\app', quit() {},
    setAppUserModelId: value => calls.push(['app-id', value]),
    getLoginItemSettings: () => { calls.push(['read-startup']); return { launchItems: [] }; },
    setLoginItemSettings: value => calls.push(['write-startup', value]),
  });
  class Keyboard extends EventEmitter {
    constructor() { super(); this.via = { connected: false }; }
    status() { return { connected: false }; }
    async poll() {}
    async shutdown() {}
  }
  class Window {
    constructor() { this.webContents = new EventEmitter(); this.webContents.send = () => {}; }
    setMenuBarVisibility() {}
    isDestroyed() { return false; }
    async loadFile() {}
    show() {}
    focus() {}
    on() {}
  }
  class Tray extends EventEmitter { setToolTip() {} setImage() {} setContextMenu() {} }
  const context = {
    __dirname: path.join(__dirname, '../app'),
    process: { argv: [], env: {}, platform: 'win32', windowsStore: native, execPath: 'C:\\mock\\Crush Control.exe', resourcesPath: 'C:\\mock\\resources', exit() { throw new Error('Unexpected exit'); } },
    setInterval: (callback, ms) => { const interval = { callback, ms }; intervals.push(interval); return interval; }, clearInterval() {},
    require(id) {
      if (id === 'electron') return { app, BrowserWindow: Window, Tray, Menu: { buildFromTemplate: items => items },
        ipcMain: { handle: (channel, handler) => ipc.set(channel, handler) },
        shell: { openExternal: async uri => calls.push(['open-url', uri]), openPath: async () => '' } };
      if (id === 'path') return path;
      if (id === 'fs') return { mkdirSync() {}, appendFileSync() {}, readFileSync() { const error = new Error('No saved mock profile'); error.code = 'ENOENT'; throw error; } };
      if (id === 'child_process') return { execFile: (_cmd, _args, _options, callback) => callback(null, '') };
      if (id === './crush80') return { Crush80: Keyboard, EFFECTS: [] };
      if (id === './icon') return { makeIcon: () => null, makeBatteryIcon: () => null };
      if (id === './battery') return { readBatteryStatus: async () => ({ percent: null, charging: null }) };
      if (id === './update-config.json') return { enabled: false };
      if (id === './release-config.json') return marker === undefined ? release : storeConfig(marker);
      if (id === './vendor/electron-updater.cjs') throw new Error('NSIS updater was loaded');
      if (id.startsWith('./')) return require(path.join(__dirname, '../app', id.slice(2)));
      throw new Error(`Unmocked import: ${id}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/main.js'), 'utf8'), context);
  return { app, calls, paths, intervals, invoke: (channel, ...args) => ipc.get(channel)(null, ...args) };
}

test('real main wiring prevents Store registry startup access and NSIS update IPC', async () => {
  for (const options of [{ native: true }, { native: true, marker: 'microsoft-store-test' }, { marker: 'microsoft-store-test' }]) {
    const f = mainFixture(options); await flush();
    const settings = await f.invoke('settings:get');
    assert.equal(settings.ok, true);
    assert.equal(settings.data.loginItemSupported, false);
    assert.equal(settings.data.storeTest, options.marker === 'microsoft-store-test');
    assert.match(settings.data.loginItemMessage, /Windows Settings/);
    assert.equal((await f.invoke('settings:set', { openAtLogin: true })).ok, false);
    for (const action of ['check', 'download', 'install']) assert.equal((await f.invoke(`updates:${action}`)).ok, false);
    assert.equal((await f.invoke('updates:status')).data.phase, 'store-managed');
    assert.equal(f.intervals.some(interval => interval.ms === 6 * 60 * 60 * 1000), false);
    assert.deepEqual(f.calls, []);
    const expectedProfile = options.marker ? 'crush80-control-store-test' : 'crush80-control';
    assert.equal(path.basename(f.paths.get('userData')), expectedProfile);
  }
});

test('main IPC ignores caller-supplied Store destination and only opens the fixed Store page', async () => {
  const f = mainFixture({ native: true }); await flush();
  const result = await f.invoke('updates:open-store', 'https://untrusted.invalid/');
  assert.equal(result.ok, true);
  assert.equal(result.data.canOpenStore, true);
  assert.deepEqual(f.calls, [['open-url', 'ms-windows-store://downloadsandupdates']]);
  const info = await f.invoke('app:info');
  assert.equal(info.data.distribution, 'microsoft-store');
});
