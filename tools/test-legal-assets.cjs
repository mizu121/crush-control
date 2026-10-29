'use strict';
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { LEGAL_FILES, legalDestination } = require('../build/release-plan.cjs');
const { assertUniqueLegalPaths, validateRuntimeNotices } = require('../build/legal-assets.cjs');

test('nested licence texts remain distinct and source archives cannot enter the app legal allowlist', () => {
  assert.equal(legalDestination('legal/third-party/runtime/LICENSES/LGPL-2.1.txt'), 'third-party/runtime/LICENSES/LGPL-2.1.txt');
  assert.equal(legalDestination('legal/installer/LICENSES/LGPL-2.1.txt'), 'installer/LICENSES/LGPL-2.1.txt');
  assert.throws(() => assertUniqueLegalPaths(['a/NOTICE.txt', 'b/notice.txt']), /colliding/);
  assert.ok(LEGAL_FILES.some(file => file.startsWith('legal/third-party/runtime/')));
  assert.ok(LEGAL_FILES.some(file => file.startsWith('legal/installer/')));
  for (const file of LEGAL_FILES) assert.doesNotMatch(file, /\/sources\/|\.(7z|zip|gz|exe|dll|bin)$/i);
});

test('local remediation candidate cannot sign or upload a release', async () => {
  const status = JSON.parse(fs.readFileSync(path.join(__dirname, '../legal/release-status.json')));
  assert.equal(status.publicReleaseApproved, false);
  await assert.rejects(require('./update-release.cjs').signRelease(), /Release remains local/);
});

test('deleting an extensionless upstream licence cannot silently shrink the packaged inventory', () => {
  const required = LEGAL_FILES.find(file => /\/LICENSES\/.*\/LICENSE$/.test(file));
  assert.ok(required);
  assert.throws(() => validateRuntimeNotices(path.join(__dirname, '..'), LEGAL_FILES.filter(file => file !== required)), /Required runtime licence is missing/);
});
