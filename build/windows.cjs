'use strict';
const path = require('node:path');
const { APP_FILES, GENERATED_APP_FILES, LEGAL_FILES, legalDestination, FUSES, UPDATE_PUBLISH } = require('./release-plan.cjs');
const root = path.resolve(__dirname, '..');

module.exports = {
  appId: 'io.crush80.control',
  productName: 'Crush Control',
  executableName: 'Crush Control',
  copyright: 'Copyright 2026 mi0ir',
  directories: {
    app: 'build/.release-stage/app',
    output: 'dist/local-license-review',
    buildResources: 'build/.release-stage/resources',
  },
  electronVersion: require('../node_modules/electron/package.json').version,
  asar: true,
  asarUnpack: ['node_modules/node-hid/**/*.node'],
  npmRebuild: true,
  buildDependenciesFromSource: false,
  nodeGypRebuild: false,
  nativeRebuilder: 'sequential',
  beforeBuild: path.join(root, 'build/native-prebuild.cjs'),
  allowMissingDependencies: false,
  files: [
    'package.json', ...APP_FILES, ...GENERATED_APP_FILES,
    '!**/*.map', '!**/.env*',
    '!node_modules/node-addon-api/**/*',
    '!node_modules/node-hid/src/**/*', '!node_modules/node-hid/hidapi/**/*',
    '!node_modules/node-hid/prebuilds/HID-{darwin,linux,win32-arm64,win32-ia32}*/**/*',
    '!node_modules/node-hid/prebuilds/HID_hidraw*/**/*',
    '!node_modules/node-hid/build/Release/obj/**/*',
    '!node_modules/node-hid/build/**/*.pdb',
    '!node_modules/node-hid/build/**/*.lib',
    '!node_modules/pkg-prebuilds/bin/**/*',
    { from: '../vendor-runtime', to: 'node_modules', filter: ['**/*'] },
    // beforeBuild handles native dependencies externally, so copy this exact
    // runtime explicitly instead of relying on builder's dependency collector.
    { from: 'node_modules/node-hid', to: 'node_modules/node-hid', filter: [
      'nodehid.js', 'binding-options.js', 'package.json', 'LICENSE*',
      'prebuilds/HID-win32-x64/node-napi-v4.node',
    ] },
    { from: 'node_modules/pkg-prebuilds', to: 'node_modules/pkg-prebuilds', filter: [
      'bindings.js', 'lib/prebuild.js', 'package.json', 'LICENSE*',
    ] },
  ],
  extraResources: [
    { from: 'build/.release-stage/resources/legal', to: 'legal', filter: LEGAL_FILES.map(legalDestination) },
    // Directory builds need this too. NSIS writes the same pinned configuration.
    { from: 'build/.release-stage/resources/app-update.yml', to: 'app-update.yml' },
    { from: 'build/.release-stage/resources/signalrgb', to: 'signalrgb', filter: ['Wobkey_Crush80_VIA_Sync.js'] },
  ],
  electronFuses: { ...FUSES },
  forceCodeSigning: false,
  // Metadata only. release-build always supplies publish: 'never'.
  publish: { ...UPDATE_PUBLISH },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: path.join(root, 'build/.release-stage/resources/icon.ico'),
    artifactName: 'Crush-Control-${version}-windows-${arch}-setup.${ext}',
    requestedExecutionLevel: 'asInvoker',
    signAndEditExecutable: true,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowElevation: false,
    packElevateHelper: false,
    runAfterFinish: false,
    createDesktopShortcut: false,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    include: path.join(root, 'build/installer.nsh'),
    warningsAsErrors: true,
  },
};
