'use strict';
const path = require('node:path');
const config = require('./release-config.json');

const APP_ID = 'io.crush80.control';
const USER_DATA_NAME = 'crush80-control';
const STORE_TEST_USER_DATA_NAME = 'crush80-control-store-test';

// The Store packager adds this marker only to the staged, integrity-protected
// ASAR. A native MSIX identity independently disables the direct EXE updater.
function resolveDistribution({ windowsStore = process.windowsStore } = {}, release = config) {
  const marker = release?.distribution;
  const known = marker === 'microsoft-store' || marker === 'microsoft-store-test';
  const invalid = marker !== undefined && !known;
  const isStore = windowsStore === true || known || invalid;
  const storeTest = marker === 'microsoft-store-test' || invalid;
  return Object.freeze({
    kind: isStore ? (storeTest ? 'microsoft-store-test' : 'microsoft-store') : 'direct',
    isStore, storeTest, valid: !invalid,
  });
}

function userDataName(distribution = resolveDistribution()) {
  return distribution.storeTest ? STORE_TEST_USER_DATA_NAME : USER_DATA_NAME;
}

function externalUrl(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError('Support links must be HTTPS URLs.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new TypeError('Support links must be HTTPS URLs without embedded credentials.');
  }
  return url.href;
}

function releaseInfo({ version, packaged, distribution }, release = config) {
  distribution = distribution || resolveDistribution({}, release);
  return {
    name: release.name,
    version,
    developer: release.developer || null,
    donationUrl: externalUrl(release.donationUrl),
    supportUrl: externalUrl(release.supportUrl),
    githubUrl: externalUrl(release.githubUrl),
    channel: distribution.isStore ? (distribution.storeTest ? 'Store test' : 'Microsoft Store') : release.channel,
    distribution: distribution.kind,
    storeTest: distribution.storeTest,
    license: 'Proprietary application; third-party notices apply.',
    packaged: Boolean(packaged),
  };
}

function distributionPaths({ packaged, root, resources, userData }) {
  return {
    backups: path.join(packaged ? userData : root, 'backups'),
    plugin: path.join(packaged ? resources : root, 'signalrgb', 'Wobkey_Crush80_VIA_Sync.js'),
    notices: path.join(packaged ? path.join(resources, 'legal') : root, 'THIRD_PARTY_NOTICES.txt'),
  };
}

function loginLaunch({ packaged, executable, root, systemRoot }) {
  if (packaged) return { path: executable, args: ['--hidden'] };
  return {
    path: path.join(systemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-WindowStyle', 'Hidden', '-File', `"${path.join(root, 'tools', 'run-app.ps1')}"`, '-Hidden'],
  };
}

function loginItemEnabled(settings, launch) {
  if (!Array.isArray(settings?.launchItems) || typeof launch?.path !== 'string' ||
      !Array.isArray(launch.args) || !launch.args.every(arg => typeof arg === 'string')) return false;
  const normalizedPath = value => typeof value === 'string' && value.length
    ? path.win32.normalize(value.replace(/^"(.*)"$/, '$1')).toLowerCase() : null;
  const expectedPath = normalizedPath(launch.path);
  if (!expectedPath) return false;
  // Electron 45 returns Chromium GetArgs(), which omits command-line switches.
  // Keep the remaining arguments exact so another PowerShell script cannot
  // make this app's startup toggle appear enabled.
  const expectedArgs = [];
  let switches = true;
  for (const raw of launch.args) {
    const arg = raw.trim();
    if (switches && arg === '--') { switches = false; continue; }
    if (switches && /^(?:--|-|\/).+/.test(arg)) continue;
    expectedArgs.push(arg);
  }
  return settings.launchItems.some(item => item?.name === 'crush80-control' &&
    item.scope === 'user' && item.enabled === true && normalizedPath(item.path) === expectedPath &&
    Array.isArray(item.args) && item.args.length === expectedArgs.length &&
    item.args.every((arg, index) => arg === expectedArgs[index]));
}

function configuredLink(action, release = config) {
  const fields = { donate: 'donationUrl', support: 'supportUrl', github: 'githubUrl' };
  if (typeof action !== 'string' || !Object.hasOwn(fields, action)) throw new RangeError('Unknown support action.');
  const url = externalUrl(release[fields[action]]);
  if (!url) throw new Error('This link has not been configured by the developer yet.');
  return url;
}

module.exports = { APP_ID, USER_DATA_NAME, STORE_TEST_USER_DATA_NAME, resolveDistribution, userDataName,
  releaseInfo, distributionPaths, loginLaunch, loginItemEnabled, configuredLink, externalUrl };
