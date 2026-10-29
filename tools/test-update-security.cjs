'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const security = require('../app/update-security');
const { fetchManifest } = require('../app/update-feed');
const { createUpdateLifecycle } = require('../app/update-lifecycle');
const keys = crypto.generateKeyPairSync('ed25519');
const config = { enabled: true, provider: 'github', owner: 'test-owner', repo: 'test-releases', channel: 'beta', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
const installer = Buffer.from('test installer bytes, never executed');
const payload = { schemaVersion: 1, appId: security.APP_ID, owner: config.owner, repo: config.repo, channel: 'beta', version: '1.0.0-beta.5', installer: security.installerName('1.0.0-beta.5'), sha512: crypto.createHash('sha512').update(installer).digest('base64'), size: installer.length, notes: 'New app features\n<not rendered as HTML>' };
function sign(value, key = keys.privateKey) { const bytes = Buffer.from(JSON.stringify(value)); return { payload: bytes.toString('base64'), signature: crypto.sign(null, bytes, key).toString('base64') }; }
function info(value = payload) { return { version: value.version, files: [{ url: value.installer, sha512: value.sha512, size: value.size }], path: value.installer, sha512: value.sha512 }; }
test('release signature authenticates exact bytes and pins app, repository, channel and newer version', () => {
  assert.deepEqual(security.verifyReleaseEnvelope(sign(payload), config, { currentVersion: '1.0.0-beta.4' }), payload);
  for (const change of [{ appId: 'other' }, { owner: 'other' }, { repo: 'other' }, { channel: 'stable' }, { schemaVersion: 2 }, { version: '1.0.0-beta.3' }, { version: '1.0.0-beta.4' }, { extra: true }]) {
    assert.throws(() => security.verifyReleaseEnvelope(sign({ ...payload, ...change }), config, { currentVersion: '1.0.0-beta.4' }));
  }
});
test('tampering, an unknown signing key, malformed signatures and oversized payloads fail closed', () => {
  const envelope = sign(payload), other = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => security.verifyReleaseEnvelope({ ...envelope, payload: Buffer.from(JSON.stringify({ ...payload, notes: 'tampered' })).toString('base64') }, config));
  assert.throws(() => security.verifyReleaseEnvelope(sign(payload, other.privateKey), config));
  for (const signature of ['', '!!!!', 'A'.repeat(88), envelope.signature + '\n']) assert.throws(() => security.verifyReleaseEnvelope({ ...envelope, signature }, config));
  assert.throws(() => security.verifyReleaseEnvelope(sign({ ...payload, notes: 'x'.repeat(40000) }), config));
});
test('signed filenames, size, digest, text and version are constrained even with a valid signature', () => {
  for (const change of [{ installer: '../other.exe' }, { installer: 'https://evil.example/install.exe' }, { size: 0 }, { size: 1.5 }, { size: 999999999 }, { sha512: 'AAAA' }, { notes: '\0' }, { notes: 5 }, { version: '../../tag' }, { version: '1.0.0-alpha.5' }, { version: '1.0.0-beta.05' }]) {
    assert.throws(() => security.verifyReleaseEnvelope(sign({ ...payload, ...change }), config));
  }
});
test('version ordering handles numeric prereleases and rejects noncanonical and unsafe versions', () => {
  assert.equal(security.compareVersions('1.0.0-beta.10', '1.0.0-beta.9'), 1);
  assert.equal(security.compareVersions('1.0.0', '1.0.0-beta.99'), 1);
  assert.equal(security.compareVersions('1.0.0-beta.2', '1.0.0-beta.2'), 0);
  for (const version of ['01.0.0', '1.0.0-beta.01', '1.0.0+unapproved', '1.0.0/evil', '9007199254740992.0.0']) assert.throws(() => security.parseVersion(version));
});
test('feed metadata must match exactly; alternate URLs, web packages and multiple installers are refused', () => {
  assert.doesNotThrow(() => security.assertUpdateInfo(info(), payload));
  for (const modify of [v => { v.version = '2.0.0'; }, v => { v.files[0].url = 'https://evil.example/a.exe'; }, v => { v.files[0].size++; }, v => { v.files[0].sha512 = 'other'; }, v => { v.files.push({ ...v.files[0] }); }, v => { v.packages = {}; }, v => { v.path = 'other.exe'; }, v => { v.files[0].blockMapUrl = 'https://evil.example'; }]) {
    const value = info(); modify(value); assert.throws(() => security.assertUpdateInfo(value, payload));
  }
});
test('unsigned feed metadata cannot switch the per-user installer to the elevation helper', () => {
  for (const flag of [undefined, false]) {
    const value = info(); if (flag !== undefined) value.files[0].isAdminRightsRequired = flag;
    assert.doesNotThrow(() => security.assertUpdateInfo(value, payload));
  }
  for (const flag of [true, null, 1, 'true', {}, []]) {
    const value = info(); value.files[0].isAdminRightsRequired = flag;
    assert.throws(() => security.assertUpdateInfo(value, payload), /administrator/);
  }
});
test('cached installer bytes are hashed afresh; same-size tampering and truncation are rejected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crush-update-hash-')), file = path.join(dir, payload.installer);
  try {
    fs.writeFileSync(file, installer); assert.equal(await security.verifyInstaller(file, payload), true);
    const changed = Buffer.from(installer); changed[0] ^= 1; fs.writeFileSync(file, changed);
    await assert.rejects(security.verifyInstaller(file, payload), /verification/);
    fs.writeFileSync(file, installer.subarray(0, 5)); await assert.rejects(security.verifyInstaller(file, payload), /size/);
  } finally { fs.unlinkSync(file); fs.rmdirSync(dir); }
});
function requestFixture(responses) {
  const seen = [];
  const request = (url, options, callback) => {
    const req = new EventEmitter(); req.destroy = () => { req.destroyed = true; };
    seen.push({ url: String(url), headers: options.headers });
    const item = responses.shift();
    if (item) setImmediate(() => { const body = typeof item.body === 'string' ? item.body : JSON.stringify(item.body || {}); const response = Readable.from([Buffer.from(body)]); response.statusCode = item.status || 200; response.headers = item.headers || {}; callback(response); });
    return req;
  };
  return { request, seen };
}
test('manifest fetch only follows bounded HTTPS GitHub asset redirects, with no credentials', async () => {
  const f = requestFixture([{ status: 302, headers: { location: 'https://release-assets.githubusercontent.com/release' } }, { body: sign(payload) }]);
  assert.deepEqual(await fetchManifest(payload.version, config, { request: f.request }), sign(payload));
  assert.match(f.seen[0].url, /\/releases\/download\/v1.0.0-beta.5\/crush-control-1.0.0-beta.5-update.json$/);
  assert.equal(f.seen.length, 2); assert.equal(f.seen[0].headers.Authorization, undefined);
  for (const location of ['http://github.com/asset', 'https://evil.example/a', 'https://user:secret@github.com/a', 'https://github.com:444/a']) {
    const bad = requestFixture([{ status: 302, headers: { location } }]);
    await assert.rejects(fetchManifest(payload.version, config, { request: bad.request }), /redirect/); assert.equal(bad.seen.length, 1);
  }
});
test('manifest fetch bounds size/time and distinguishes a missing release file', async () => {
  for (const item of [{ status: 404 }, { body: 'not json' }, { body: 'x'.repeat(security.MAX_MANIFEST_BYTES + 1) }, { headers: { 'content-length': '99999999' } }]) {
    const f = requestFixture([item]); await assert.rejects(fetchManifest(payload.version, config, { request: f.request }));
  }
  const f = requestFixture([]); await assert.rejects(fetchManifest(payload.version, config, { request: f.request, timeoutMs: 10 }), /timed out/);
});
test('cleanup is shared, waits for HID release, and blocks a failed close', async () => {
  let release, calls = 0, stopped = 0;
  const keyboard = { via: { connected: true }, shutdown: () => { calls++; return new Promise(resolve => { release = resolve; }); } };
  const lifecycle = createUpdateLifecycle({ keyboard, stopPolling: () => stopped++ });
  const a = lifecycle.shutdown(), b = lifecycle.shutdown(); assert.equal(a, b); assert.equal(lifecycle.started, true); assert.equal(stopped, 1);
  await Promise.resolve(); assert.equal(calls, 1); assert.equal(lifecycle.complete, false);
  keyboard.via.connected = false; release(); await a; assert.equal(lifecycle.complete, true);
  for (const via of [{ connected: true }, { closeFailure: new Error('failed') }]) {
    const bad = createUpdateLifecycle({ keyboard: { via, shutdown: async () => {} }, stopPolling() {} });
    await assert.rejects(bad.shutdown(), /could not be released/); assert.equal(bad.complete, false);
  }
});
test('restoration failure never authorizes install', async () => {
  const lifecycle = createUpdateLifecycle({ keyboard: { shutdown: async () => { throw new Error('restore failed'); } }, stopPolling() {} });
  await assert.rejects(lifecycle.shutdown(), /restore failed/); assert.equal(lifecycle.complete, false);
});
test('throwing or reentrant shutdown observers cannot skip HID cleanup or escape the promise barrier', async () => {
  for (const failure of ['stop', 'notify']) {
    let calls = 0, reentered;
    const lifecycle = createUpdateLifecycle({ keyboard: { via: { connected: false }, shutdown: async () => { calls++; } },
      stopPolling() { if (failure === 'stop') throw new Error('timer failure'); },
      onQuiesce() { reentered = lifecycle.shutdown(); if (failure === 'notify') throw new Error('renderer gone'); } });
    const result = lifecycle.shutdown();
    assert.equal(reentered, result);
    await assert.rejects(result, /timer failure|renderer gone/);
    assert.equal(calls, 1); assert.equal(lifecycle.complete, false);
  }
});
