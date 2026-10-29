'use strict';
const path = require('node:path');
const { ROOT, STORE_STAGE } = require('./store-plan.cjs');

// The same reviewed runtime closure as the NSIS build, with separate staging
// and output. This config can only create an Electron directory, never publish.
function storeWindowsConfig(mode) {
  if (!['test', 'store'].includes(mode)) throw new Error('Invalid Store mode.');
  const base = require('./windows.cjs');
  const staged = path.relative(ROOT, STORE_STAGE).replace(/\\/g, '/');
  return {
    ...base,
    directories: { app: `${staged}/app`, output: mode === 'test' ? 'dist/store-test' : 'dist/store-private', buildResources: `${staged}/resources` },
    publish: null,
    extraResources: base.extraResources.map(item => ({ ...item, from: item.from.replace('build/.release-stage/', `${staged}/`) })),
    win: { ...base.win, target: [{ target: 'dir', arch: ['x64'] }], icon: path.join(STORE_STAGE, 'resources/icon.ico') },
  };
}
module.exports = { storeWindowsConfig };
