'use strict';
// Device-free updater tests: the engine, HTTPS, file verification and install
// handoff are fakes. Real Ed25519 verification below uses an ephemeral key only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createAppUpdater } = require('../app/app-updater');
const security = require('../app/update-security');
const { createUpdateLifecycle } = require('../app/update-lifecycle');

const version = '1.0.0-beta.4';
const keys = crypto.generateKeyPairSync('ed25519');
const config = { enabled: true, provider: 'github', owner: 'mizu121', repo: 'crush-control-releases', channel: 'beta',
  publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
const manifest = { schemaVersion: 1, appId: 'io.crush80.control', owner: config.owner, repo: config.repo,
  channel: 'beta', version, installer: security.installerName(version),
  sha512: crypto.createHash('sha512').update('fake installer bytes').digest('base64'), size: 20,
  notes: 'A signed app release. Keyboard firmware is unchanged.' };
const copy = value => JSON.parse(JSON.stringify(value));
const releaseInfo = () => ({ version, files: [{ url: manifest.installer, sha512: manifest.sha512, size: manifest.size }] });
const sign = value => {
  const bytes = Buffer.from(JSON.stringify(value));
  return { payload: bytes.toString('base64'), signature: crypto.sign(null, bytes, keys.privateKey).toString('base64') };
};
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const calls = [], changes = [];
  const token = { cancel() { calls.push('cancel'); } };
  class Engine extends EventEmitter {
    constructor() { super(); this.info = releaseInfo(); this.installerPath = null; }
    set channel(value) { this._channel = value; this.allowDowngrade = true; }
    get channel() { return this._channel; }
    async checkForUpdates() {
      calls.push('engine-check');
      if (options.check) return options.check(this, token);
      this.updateInfoAndProvider = { info: this.info };
      return { isUpdateAvailable: true, updateInfo: this.info, cancellationToken: token, downloadPromise: null };
    }
    async downloadUpdate(cancellationToken) {
      assert.equal(cancellationToken, token); calls.push('engine-download');
      if (options.download) return options.download(this);
      this.installerPath = `C:\\app-update-cache\\${manifest.installer}`;
      this.emit('download-progress', { percent: 45.9 });
      this.emit('update-downloaded', { ...this.info, downloadedFile: this.installerPath });
      return [this.installerPath];
    }
    quitAndInstall(silent, forceRun) {
      calls.push('engine-install'); assert.equal(silent, true); assert.equal(forceRun, true);
      if (options.handoff) return options.handoff(this);
    }
  }
  const engine = new Engine();
  let verifyCount = 0;
  const updater = createAppUpdater({
    app: { isPackaged: options.packaged ?? true, getVersion: () => '1.0.0-beta.3' },
    platform: options.platform || 'win32', config: options.config || config,
    loadUpdater: async () => { calls.push('load'); return options.load ? options.load(engine) : engine; },
    fetchManifest: async (requested, trusted) => {
      calls.push('fetch-manifest'); assert.equal(requested, version); assert.equal(trusted.owner, config.owner);
      return options.envelope ? options.envelope() : sign(options.manifest || manifest);
    },
    verifyReleaseEnvelope: security.verifyReleaseEnvelope,
    assertUpdateInfo: security.assertUpdateInfo,
    verifyInstaller: async (file, value) => {
      calls.push('verify-file'); verifyCount++;
      assert.equal(path.win32.basename(file), value.installer);
      if (options.verify) return options.verify(file, value, verifyCount);
      return true;
    },
    prepareInstall: async () => { calls.push('prepare-install'); if (options.prepare) await options.prepare(); },
    onChange(value) { changes.push(value); options.onChange?.(value); },
    now: () => new Date('2026-10-29T01:00:00.000Z'),
  });
  return { updater, engine, calls, changes, token };
}
async function downloaded(f) { await f.updater.check(); return f.updater.download(); }

test('module import is pure and disabled builds never load the engine or call adapters', async () => {
  const exports = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/app-updater.js'), 'utf8'), {
    module: exports, require(name) { assert.equal(name, 'node:path'); return path; },
  });
  assert.equal(typeof exports.exports.createAppUpdater, 'function');
  for (const options of [{ packaged: false }, { platform: 'linux' }, { config: { ...config, enabled: false } },
    { config: { ...config, provider: 'generic' } }, { config: { ...config, publicKey: '' } }]) {
    const f = fixture(options);
    assert.equal(f.updater.status().phase, 'disabled');
    await assert.rejects(f.updater.check()); await assert.rejects(f.updater.download()); await assert.rejects(f.updater.install());
    assert.deepEqual(f.calls, []);
  }
});

test('a signed newer release becomes available without downloading and sets restrictive engine options', async () => {
  const f = fixture(); assert.equal(f.updater.status().phase, 'idle'); assert.deepEqual(f.calls, []);
  const result = await f.updater.check();
  assert.equal(result.phase, 'available'); assert.equal(result.availableVersion, version);
  assert.equal(result.currentVersion, '1.0.0-beta.3'); assert.equal(result.checkedAt, '2026-10-29T01:00:00.000Z');
  assert.equal(result.canDownload, true); assert.equal(result.canInstall, false);
  assert.deepEqual(f.calls, ['load', 'engine-check', 'fetch-manifest']);
  for (const key of ['autoDownload', 'autoInstallOnAppQuit', 'autoRunAppAfterInstall', 'forceDevUpdateConfig', 'allowDowngrade']) assert.equal(f.engine[key], false, key);
  for (const key of ['allowPrerelease', 'disableWebInstaller', 'disableDifferentialDownload']) assert.equal(f.engine[key], true, key);
  assert.equal(f.engine.channel, 'beta');
  const external = f.updater.status(); external.canInstall = true; assert.equal(f.updater.status().canInstall, false);
  assert.ok(f.changes.every((item, i) => i === 0 || item.revision > f.changes[i - 1].revision));
});

test('stable maps to latest and a no-update result does not fetch a manifest or download', async () => {
  const f = fixture({ config: { ...config, channel: 'stable' }, check: async () => ({ isUpdateAvailable: false, updateInfo: { version: '1.0.0-beta.3' } }) });
  assert.equal((await f.updater.check()).phase, 'up-to-date');
  assert.equal(f.engine.channel, 'latest'); assert.equal(f.engine.allowPrerelease, false); assert.equal(f.engine.allowDowngrade, false);
  assert.deepEqual(f.calls, ['load', 'engine-check']);
});

test('invalid versions and an automatic download result are rejected before manifest fetch', async () => {
  for (const value of ['../evil', 'v1.0.0', '01.0.0', '1.0.0-beta.01', '1.0.0\n', '9'.repeat(90)]) {
    const f = fixture({ check: async () => ({ isUpdateAvailable: true, updateInfo: { version: value } }) });
    await assert.rejects(f.updater.check()); assert.equal(f.calls.includes('fetch-manifest'), false);
  }
  const f = fixture({ check: async () => ({ isUpdateAvailable: true, updateInfo: releaseInfo(), downloadPromise: Promise.resolve([]) }) });
  await assert.rejects(f.updater.check()); assert.equal(f.updater.status().canInstall, false);
});

test('tampered signature, wrong app/channel, rollback and metadata substitutions never authorize download', async () => {
  const variants = [
    { envelope: () => ({ ...sign(manifest), signature: Buffer.alloc(64).toString('base64') }) },
    { manifest: { ...manifest, appId: 'wrong.app' } }, { manifest: { ...manifest, channel: 'stable' } },
    { manifest: { ...manifest, version: '1.0.0-beta.2', installer: security.installerName('1.0.0-beta.2') } },
    { manifest: { ...manifest, sha512: Buffer.alloc(64).toString('base64') } },
  ];
  for (const options of variants) {
    const f = fixture(options); await assert.rejects(f.updater.check());
    assert.equal(f.updater.status().phase, 'error'); assert.equal(f.updater.status().canCheck, true);
    await assert.rejects(f.updater.download()); assert.equal(f.calls.includes('engine-download'), false);
  }
});

test('mutated live engine selection is checked again before any download', async () => {
  const f = fixture(); await f.updater.check(); f.engine.info.files[0].size++;
  await assert.rejects(f.updater.download()); assert.equal(f.calls.includes('engine-download'), false);
});

test('download requires one matching engine file and event plus authenticated file verification', async () => {
  const f = fixture(); const result = await downloaded(f);
  assert.equal(result.phase, 'downloaded'); assert.equal(result.percent, 100); assert.equal(result.canInstall, true);
  assert.equal(f.calls.filter(x => x === 'verify-file').length, 1);
  assert.equal(f.calls.includes('engine-install'), false);
  assert.ok(f.changes.some(x => x.percent === 45));
});

test('missing event, extra payload, changed event path and failed file hash all fail closed', async () => {
  const scenarios = [
    engine => { engine.installerPath = `C:\\cache\\${manifest.installer}`; return [engine.installerPath]; },
    engine => { engine.installerPath = `C:\\cache\\${manifest.installer}`; engine.emit('update-downloaded', { ...engine.info, downloadedFile: engine.installerPath }); return [engine.installerPath, 'C:\\package.7z']; },
    engine => { engine.installerPath = `C:\\cache\\${manifest.installer}`; engine.emit('update-downloaded', { ...engine.info, downloadedFile: `C:\\different\\${manifest.installer}` }); return [engine.installerPath]; },
    engine => { engine.installerPath = `C:\\cache\\${manifest.installer}`; engine.emit('update-downloaded', { ...engine.info, packages: {}, downloadedFile: engine.installerPath }); return [engine.installerPath]; },
  ];
  for (const download of scenarios) {
    const f = fixture({ download }); await f.updater.check(); await assert.rejects(f.updater.download());
    assert.equal(f.updater.status().canInstall, false); assert.equal(f.calls.includes('verify-file'), false);
  }
  const f = fixture({ verify() { throw Error('hash mismatch C:\\private-cache'); } });
  await f.updater.check(); await assert.rejects(f.updater.download(), error => !error.message.includes('private-cache'));
  assert.equal(f.updater.status().canInstall, false); assert.equal(f.calls.includes('prepare-install'), false);
});

test('downloaded events alone cannot authorize an install; progress is bounded and monotonic', async () => {
  const pending = deferred();
  const f = fixture({ download: () => pending.promise });
  f.engine.emit('update-downloaded', { ...releaseInfo(), downloadedFile: 'C:\\fake.exe' });
  await assert.rejects(f.updater.install()); await f.updater.check();
  const action = f.updater.download(); await flush();
  for (const percent of [70, 20, NaN, Infinity, -1, 110]) f.engine.emit('download-progress', { percent });
  assert.equal(f.updater.status().percent, 70);
  assert.equal(f.updater.status().canInstall, false);
  f.updater.stop(); await assert.rejects(action); pending.resolve([]);
});

test('duplicate actions coalesce and other actions cannot overlap a pending check', async () => {
  const pending = deferred();
  const f = fixture({ check: async engine => { engine.updateInfoAndProvider = { info: engine.info }; await pending.promise; return { isUpdateAvailable: true, updateInfo: engine.info, cancellationToken: f.token }; } });
  const first = f.updater.check(), second = f.updater.check(); assert.equal(first, second);
  await assert.rejects(f.updater.download()); pending.resolve(); await first;
  assert.equal(f.calls.filter(x => x === 'engine-check').length, 1);
});

test('install waits for cleanup, rehashes afterward and hands off once with explicit restart', async () => {
  const cleanup = deferred(); const f = fixture({ prepare: () => cleanup.promise }); await downloaded(f);
  const first = f.updater.install(), second = f.updater.install(); assert.equal(first, second); await flush();
  assert.equal(f.calls.includes('engine-install'), false); assert.equal(f.updater.status().phase, 'installing');
  assert.equal(f.updater.status().canCheck, false); cleanup.resolve();
  assert.equal((await first).phase, 'installing');
  assert.deepEqual(f.calls.slice(-5), ['verify-file', 'verify-file', 'prepare-install', 'verify-file', 'engine-install']);
  await assert.rejects(f.updater.install()); assert.equal(f.calls.filter(x => x === 'engine-install').length, 1);
});

test('cleanup failure, changed engine path and post-cleanup cache tampering prevent installer handoff', async () => {
  for (const scenario of ['cleanup', 'path', 'bytes']) {
    let f;
    f = fixture({
      prepare() { if (scenario === 'cleanup') throw Error('HID could not close'); if (scenario === 'path') f.engine.installerPath = 'C:\\other.exe'; },
      verify(_file, _value, count) { if (scenario === 'bytes' && count === 3) throw Error('cache changed'); },
    });
    await downloaded(f); await assert.rejects(f.updater.install());
    assert.equal(f.updater.status().phase, 'error'); assert.equal(f.updater.status().canInstall, false);
    assert.equal(f.updater.status().canCheck, false); assert.match(f.updater.status().message, /Quit and reopen/);
    await assert.rejects(f.updater.check(), /Quit and reopen/);
    assert.equal(f.calls.includes('engine-install'), false);
  }
});

test('stop during signature verification, download or cleanup invalidates all late completions', async () => {
  for (const stage of ['manifest', 'download', 'cleanup']) {
    const pending = deferred();
    const f = fixture(stage === 'manifest' ? { envelope: () => pending.promise }
      : stage === 'download' ? { download: () => pending.promise } : { prepare: () => pending.promise });
    let action;
    if (stage === 'manifest') action = f.updater.check();
    else { await f.updater.check(); if (stage === 'cleanup') await f.updater.download(); action = stage === 'download' ? f.updater.download() : f.updater.install(); }
    await flush(); f.updater.stop(); const revision = f.updater.status().revision;
    await assert.rejects(action, /closing/); pending.resolve(stage === 'manifest' ? sign(manifest) : []); await flush();
    assert.equal(f.updater.status().phase, 'disabled'); assert.equal(f.updater.status().revision, revision);
    assert.equal(f.calls.includes('engine-install'), false);
    f.engine.emit('update-downloaded', { ...releaseInfo(), downloadedFile: 'C:\\late.exe' });
    f.engine.emit('error', Error('late error')); assert.equal(f.updater.status().revision, revision);
  }
});

test('engine errors reject a hung action promptly and synchronous handoff errors are recorded', async () => {
  const f = fixture({ download: () => new Promise(() => {}) }); await f.updater.check();
  const action = f.updater.download(); await flush(); f.engine.emit('error', Error('private-path-and-url'));
  await assert.rejects(action); assert.equal(f.updater.status().phase, 'error');
  assert.doesNotMatch(JSON.stringify(f.updater.status()), /private-path-and-url/);
  const handoff = fixture({ handoff(engine) { engine.emit('error', Error('Installer spawn failed')); } });
  await downloaded(handoff); await assert.rejects(handoff.updater.install()); assert.equal(handoff.updater.status().phase, 'error');
});

test('shared lifecycle blocks install on hidden close failure and runs cleanup once', async () => {
  for (const via of [{ connected: false, closeFailure: Error('close failed') }, { connected: true }]) {
    let stopped = 0, closed = 0;
    const lifecycle = createUpdateLifecycle({ keyboard: { via, async shutdown() { closed++; } }, stopPolling() { stopped++; } });
    const f = fixture({ prepare: () => lifecycle.shutdown() }); await downloaded(f); await assert.rejects(f.updater.install());
    await assert.rejects(lifecycle.shutdown()); assert.equal(stopped, 1); assert.equal(closed, 1); assert.equal(lifecycle.complete, false);
    assert.equal(f.calls.includes('engine-install'), false);
  }
});

test('observer failures cannot bypass signature checks or abort a valid explicit update', async () => {
  const f = fixture({ onChange() { throw Error('renderer unavailable'); } }); await downloaded(f); await f.updater.install();
  assert.equal(f.calls.filter(x => x === 'engine-install').length, 1);
});
