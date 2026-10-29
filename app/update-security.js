'use strict';
// Release authentication is independent of transport checksums and Windows signing.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const APP_ID = 'io.crush80.control';
const MAX_MANIFEST_BYTES = 96 * 1024;
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 100) throw new Error('Invalid update version.');
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) throw new Error('Invalid update version.');
  const core = match.slice(1, 4).map(Number);
  if (core.some(n => !Number.isSafeInteger(n))) throw new Error('Invalid update version.');
  const pre = match[4] ? match[4].split('.') : [];
  if (pre.some(s => /^\d+$/.test(s) && (s.length > 1 && s[0] === '0' || !Number.isSafeInteger(Number(s))))) throw new Error('Invalid update version.');
  return { core, pre };
}
function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return !a.pre.length && !b.pre.length ? 0 : !a.pre.length ? 1 : -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === b.pre[i]) continue;
    if (a.pre[i] === undefined || b.pre[i] === undefined) return a.pre[i] === undefined ? -1 : 1;
    const an = /^\d+$/.test(a.pre[i]), bn = /^\d+$/.test(b.pre[i]);
    if (an !== bn) return an ? -1 : 1;
    return (an ? Number(a.pre[i]) > Number(b.pre[i]) : a.pre[i] > b.pre[i]) ? 1 : -1;
  }
  return 0;
}
function validateConfig(config) {
  if (!config || config.provider !== 'github' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(config.owner || '') ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(config.repo || '') || !['stable', 'beta'].includes(config.channel)) throw new Error('Invalid app update configuration.');
  if (typeof config.publicKey !== 'string' || config.publicKey.length > 1024 || !config.publicKey.startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error('Update verification key is missing.');
  const key = crypto.createPublicKey(config.publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 update verification key is required.');
  return key;
}
function decodeBase64(value, max, label) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(`Invalid ${label}.`);
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > max || bytes.toString('base64') !== value) throw new Error(`Invalid ${label}.`);
  return bytes;
}
function installerName(version) { parseVersion(version); return `Crush-Control-${version}-windows-x64-setup.exe`; }
function manifestName(version) { parseVersion(version); return `crush-control-${version}-update.json`; }
function verifyReleaseEnvelope(envelope, config, { currentVersion } = {}) {
  const key = validateConfig(config);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).sort().join(',') !== 'payload,signature') throw new Error('Invalid signed release envelope.');
  const bytes = decodeBase64(envelope.payload, 32 * 1024, 'release payload');
  const signature = decodeBase64(envelope.signature, 64, 'release signature');
  if (signature.length !== 64 || !crypto.verify(null, bytes, key, signature)) throw new Error('The update release signature could not be verified.');
  const value = JSON.parse(bytes.toString('utf8'));
  const fields = ['schemaVersion', 'appId', 'owner', 'repo', 'channel', 'version', 'installer', 'sha512', 'size', 'notes'].sort();
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== fields.join(',') || value.schemaVersion !== 1 || value.appId !== APP_ID || value.owner !== config.owner || value.repo !== config.repo || value.channel !== config.channel) throw new Error('This release does not belong to this app and update channel.');
  const version = parseVersion(value.version);
  if (config.channel === 'stable' && version.pre.length || config.channel === 'beta' && version.pre.length && version.pre[0] !== 'beta') throw new Error('Release channel does not match its version.');
  if (currentVersion && compareVersions(value.version, currentVersion) <= 0) throw new Error('The update is not newer than this app.');
  if (value.installer !== installerName(value.version) || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_INSTALLER_BYTES || decodeBase64(value.sha512, 64, 'installer hash').length !== 64) throw new Error('Invalid signed installer metadata.');
  if (typeof value.notes !== 'string' || value.notes.length > 12000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.notes)) throw new Error('Invalid release notes.');
  return Object.freeze({ ...value });
}
function assertUpdateInfo(info, manifest) {
  if (!info || info.version !== manifest.version || info.packages != null || !Array.isArray(info.files) || info.files.length !== 1) throw new Error('Update feed does not match the signed release.');
  const file = info.files[0];
  // Builder publishes plain asset names. Reject URLs, alternate packages, or path traversal.
  if (!file || file.url !== manifest.installer || file.sha512 !== manifest.sha512 || file.size !== manifest.size || file.blockMapUrl != null) throw new Error('Update installer does not match the signed release.');
  // This app is per-user and deliberately ships no elevation helper. The feed
  // must not change the launch path to elevate.exe using unsigned metadata.
  if (file.isAdminRightsRequired !== undefined && file.isAdminRightsRequired !== false) throw new Error('This app update cannot request administrator installation.');
  if (info.path != null && info.path !== manifest.installer || info.sha512 != null && info.sha512 !== manifest.sha512) throw new Error('Legacy update metadata disagrees with the signed release.');
}
async function verifyInstaller(filename, manifest) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('Invalid downloaded installer path.');
  const stat = await fs.promises.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== manifest.size || stat.size > MAX_INSTALLER_BYTES) throw new Error('Downloaded installer size does not match the signed release.');
  const hash = crypto.createHash('sha512');
  let bytes = 0;
  for await (const block of fs.createReadStream(filename)) { bytes += block.length; if (bytes > manifest.size) throw new Error('Downloaded installer changed during verification.'); hash.update(block); }
  const actual = hash.digest();
  const expected = decodeBase64(manifest.sha512, 64, 'installer hash');
  if (bytes !== manifest.size || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error('Downloaded installer failed release verification.');
  return true;
}
module.exports = { APP_ID, MAX_MANIFEST_BYTES, MAX_INSTALLER_BYTES, parseVersion, compareVersions, validateConfig, installerName, manifestName, verifyReleaseEnvelope, assertUpdateInfo, verifyInstaller };
