'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertX64Pe } = require('../tools/verify-release.cjs');

// node-hid 3.4.0 uses ABI-stable Node-API v4, not a V8-version-specific addon.
// electron-rebuild does not recognize pkg-prebuilds. Recompiling it would need
// MSVC unnecessarily; use only this reviewed, exact Windows x64 npm prebuild.
const PREBUILD_SHA256 = 'b8501067ca825b48b13a69523b2b8e7e65583a458618521e79135abcaa48d2a4';
async function verifyNativePrebuild({ appDir, platform, arch }) {
  if (platform.nodeName !== 'win32' || arch !== 'x64') throw new Error('The native prebuild gate supports Windows x64 only.');
  const appPackage = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  if (JSON.stringify(appPackage.dependencies) !== JSON.stringify({ 'node-hid': '3.4.0' })) throw new Error('Review changed native dependencies before packaging.');
  const hid = JSON.parse(fs.readFileSync(path.join(appDir, 'node_modules/node-hid/package.json'), 'utf8'));
  if (hid.version !== '3.4.0' || JSON.stringify(hid.binary?.napi_versions) !== '[4]') throw new Error('Expected node-hid 3.4.0 with Node-API v4.');
  const file = path.join(appDir, 'node_modules/node-hid/prebuilds/HID-win32-x64/node-napi-v4.node');
  const bytes = fs.readFileSync(file);
  assertX64Pe(bytes, 'node-hid prebuild');
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== PREBUILD_SHA256) throw new Error('node-hid prebuild differs from the reviewed npm binary.');
  if (fs.existsSync(path.join(appDir, 'node_modules/node-hid/build'))) throw new Error('A local node-hid build must not override the reviewed prebuild.');
  console.log('Verified node-hid 3.4.0 Windows x64 Node-API v4 prebuild; no recompilation needed.');
  return false; // Native dependency handling is complete, per builder beforeBuild API.
}
module.exports = verifyNativePrebuild;
module.exports.PREBUILD_SHA256 = PREBUILD_SHA256;
