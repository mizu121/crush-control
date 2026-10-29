'use strict';
const { noticeFiles, legalDestination, assertUniqueLegalPaths } = require('./legal-assets.cjs');
const { NOTICE_FILES: INSTALLER_NOTICES } = require('./installer-source-bundle.cjs');
const BUILD_INPUT_FILES = Object.freeze([
  'build/release-plan.cjs', 'build/windows.cjs', 'build/legal-assets.cjs',
  'build/native-prebuild.cjs', 'build/installer.nsh', 'build/installer-process-check.nsh',
  'build/installer-source-bundle.cjs', 'tools/release-build.cjs', 'tools/verify-release.cjs',
  'build/installer-templates.cjs',
  'build/installer-inspection.cjs',
  ...['installSection.nsh', 'installer-app-files.nsh', 'uninstaller.nsh', 'multiUser.nsh', 'LICENSE.electron-builder.txt', 'UPSTREAM.json'].map(file => `build/installer-templates/${file}`),
]);

// Explicit source allowlist. Never copy the project root into a release.
const APP_FILES = Object.freeze([
  'app/entry.js', 'app/main.js', 'app/windows-shortcuts.js', 'app/package-verification.js', 'app/preload.js', 'app/crush80.js', 'app/distribution.js',
  'app/release-config.json', 'app/firmware-identity.js', 'app/firmware-setup.js', 'app/hue.js',
  'app/receiver-link.js', 'app/battery.js', 'app/battery-presentation.js',
  'app/app-updater.js', 'app/update-security.js', 'app/update-feed.js',
  'app/update-lifecycle.js', 'app/update-config.json',
  'app/support-reminder.js', 'app/renderer/support-reminder.js',
  'app/icon.js', 'app/keymap-reader.js', 'app/pkrg.js', 'app/preset-library.js',
  'app/rgb-controller.js', 'app/rgb-keymap.json', 'app/via.js',
  'app/renderer/index.html', 'app/renderer/styles.css', 'app/renderer/app.js',
  'app/renderer/blueprint-selection.js', 'app/renderer/color-wheel.js',
  'app/renderer/keyboard3d.js', 'app/renderer/keycodes.js', 'app/renderer/layout.js',
  'app/renderer/assets/fonts/InterVariable.woff2',
  'app/renderer/assets/fonts/Inter-OFL.txt',
  'app/renderer/assets/fonts/JetBrainsMono-Regular.woff2',
  'app/renderer/assets/fonts/JetBrainsMono-OFL.txt',
  'app/renderer/assets/fonts/SOURCES.txt',
  'app/renderer/assets/model/studio_small_08_1k.hdr',
  'app/renderer/assets/model/LICENSE.txt',
]);
const LEGAL_FILES = Object.freeze([
  'LICENSE.txt', 'LICENSE_SCOPE.md', 'THIRD_PARTY_NOTICES.txt', 'docs/FEATURES.md', 'docs/RELEASE.md', 'docs/APP_UPDATES.md',
  ...noticeFiles('legal/third-party/runtime'), ...noticeFiles('legal/installer'),
]);
assertUniqueLegalPaths(LEGAL_FILES);
for (const file of INSTALLER_NOTICES) if (!LEGAL_FILES.includes(file)) throw new Error(`Required installer notice missing: ${file}`);
// Generated from audited dependencies, never accepted as an unreviewed source file.
const GENERATED_APP_FILES = Object.freeze(['app/vendor/electron-updater.cjs']);
const UPDATE_PUBLISH = Object.freeze({
  provider: 'github', owner: 'mizu121', repo: 'crush-control-releases', private: false, channel: 'beta',
});
const APP_UPDATE_CONFIG = Object.freeze({ ...UPDATE_PUBLISH, updaterCacheDirName: 'crush80-control-updater' });
// Actual bundled JS closure, including electron-updater's nested semver.
// New dependencies, versions and licenses require an audit before packaging.
const UPDATER_PACKAGES = Object.freeze([
  ['electron-updater', '6.8.11', 'MIT', 'LICENSE'],
  ['builder-util-runtime', '9.7.0', 'MIT', 'LICENSE'],
  ['universalify', '2.0.1', 'MIT', 'LICENSE'],
  ['graceful-fs', '4.2.11', 'ISC', 'LICENSE'],
  ['fs-extra', '10.1.0', 'MIT', 'LICENSE'],
  ['jsonfile', '6.2.1', 'MIT', 'LICENSE'],
  ['ms', '2.1.3', 'MIT', 'license.md'],
  ['debug', '4.4.3', 'MIT', 'LICENSE'],
  ['has-flag', '4.0.0', 'MIT', 'license'],
  ['supports-color', '7.2.0', 'MIT', 'license'],
  ['sax', '1.6.1', 'BlueOak-1.0.0', 'LICENSE.md'],
  ['js-yaml', '4.3.2', 'MIT', 'LICENSE'],
  ['lazy-val', '1.0.5', 'MIT', null],
  ['electron-updater/node_modules/semver', '7.7.4', 'ISC', 'LICENSE'],
  ['lodash.isequal', '4.5.0', 'MIT', 'LICENSE'],
  ['lodash.escaperegexp', '4.1.2', 'MIT', 'LICENSE'],
].map(([relative, version, license, licenseFile]) => Object.freeze({
  directory: `node_modules/${relative}`, name: relative.split('/node_modules/').at(-1), version, license, licenseFile,
})));
const PLUGIN_FILE = 'signalrgb/Wobkey_Crush80_VIA_Sync.js';
const NATIVE_MODULES = Object.freeze(['node-hid', 'pkg-prebuilds', 'node-addon-api']);
const THREE_ENTRIES = Object.freeze([
  'build/three.module.js',
  'examples/jsm/postprocessing/EffectComposer.js',
  'examples/jsm/postprocessing/RenderPass.js',
  'examples/jsm/postprocessing/SSAOPass.js',
  'examples/jsm/postprocessing/OutputPass.js',
  'examples/jsm/loaders/HDRLoader.js',
  'examples/jsm/utils/BufferGeometryUtils.js',
]);
const FUSES = Object.freeze({
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  onlyLoadAppFromAsar: true,
  enableEmbeddedAsarIntegrityValidation: true,
});
module.exports = { APP_FILES, GENERATED_APP_FILES, LEGAL_FILES, legalDestination, BUILD_INPUT_FILES, PLUGIN_FILE, NATIVE_MODULES, THREE_ENTRIES, FUSES, UPDATE_PUBLISH, APP_UPDATE_CONFIG, UPDATER_PACKAGES };
