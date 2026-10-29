'use strict';
// Local source staging only. Never invoke git, network, app, HID, or a flasher.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { APP_FILES, LEGAL_FILES, BUILD_INPUT_FILES, PLUGIN_FILE } = require('../build/release-plan.cjs');
const { sourceFile } = require('./release-build.cjs');
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'artifacts/license-audit/public-source-candidate');
const SUPPORT = [
  'LICENSE.txt', 'LICENSE_SCOPE.md', 'THIRD_PARTY_NOTICES.txt', '.gitignore',
  'package.json', 'package-lock.json', 'legal/release-status.json',
  'build/legal-assets.cjs', 'build/release-plan.cjs', 'build/windows.cjs',
  'build/native-prebuild.cjs', 'build/installer.nsh', 'build/installer-process-check.nsh',
  'build/store-plan.cjs', 'build/store-windows.cjs',
  'tools/release-build.cjs', 'tools/verify-release.cjs', 'tools/update-release.cjs',
  'tools/prepare-source-release.cjs',
  'tools/store-build.cjs', 'tools/build-ui-icons.cjs',
  'tools/store-install-test.ps1',
  'tools/prepare-runtime-sources.cjs', 'legal/third-party/runtime/source-specs.json',
  'tools/test-release-packaging.cjs', 'tools/test-installer-process-check.cjs',
  'tools/test-installer-templates.cjs',
  'tools/test-installer-inspection.cjs',
  'tools/test-store-packaging.cjs', 'tools/test-store-runtime.cjs',
  'tools/test-pkrg.cjs', 'tools/test-preset-library.cjs', 'tools/test-rgb-controller.cjs',
  'tools/test-windows-shortcuts.cjs',
  'tools/test-app-lifecycle.cjs',
  'tools/fixtures/pkrg-simulator.cjs',
  'tools/test-via-transport.cjs', 'tools/test-battery.cjs', 'tools/test-receiver-link.cjs',
  'tools/test-update-security.cjs', 'tools/test-app-updater.cjs', 'tools/test-support-reminder.cjs',
  'tools/test-signalrgb-plugin.mjs', 'tools/test-legal-assets.cjs',
  'tools/pkrg-emulator-bridge.py', 'tools/test-pkrg-firmware.cjs',
  'tools/per-key-firmware/pkrg_routines.py', 'tools/per-key-firmware/build_v104.py',
  'tools/per-key-firmware/NOTICE.md', 'tools/per-key-firmware/LICENSE-GPL-2.0.txt',
  'tools/per-key-firmware/README.md', 'tools/rear-sync/build_proof.py',
  ...['engine.py', 'sources.py', 'validation.py', 'session.py', 'validate.py',
    'test_validation.py', 'test_stock.py', 'README.md', 'PROVENANCE.md', 'COPYING',
    'requirements.txt', '.gitignore'].map(file => `tools/firmware-validation/${file}`),
];
const scripts = {
  start: 'electron .',
  test: 'node --test tools/test-pkrg.cjs tools/test-preset-library.cjs tools/test-rgb-controller.cjs tools/test-via-transport.cjs tools/test-battery.cjs tools/test-receiver-link.cjs tools/test-update-security.cjs tools/test-app-updater.cjs tools/test-support-reminder.cjs tools/test-windows-shortcuts.cjs',
  'build:icons': 'node tools/build-ui-icons.cjs',
  'test:package': 'node --test tools/test-release-packaging.cjs tools/test-installer-process-check.cjs tools/test-installer-templates.cjs tools/test-legal-assets.cjs',
  'test:store': 'node --test tools/test-store-packaging.cjs tools/test-store-runtime.cjs',
  'test:plugin': 'node tools/test-signalrgb-plugin.mjs',
  'test:pkrg-firmware': 'node --test tools/test-pkrg-firmware.cjs',
  'package:check': 'node tools/release-build.cjs --check',
  'dist:dir': 'node tools/release-build.cjs --dir',
  'dist:win': 'node tools/release-build.cjs --installer',
  'dist:verify': 'node tools/verify-release.cjs',
  'store:check': 'node tools/store-build.cjs --check',
  'store:test': 'node tools/store-build.cjs --test',
};
function main() {
  if (fs.existsSync(OUTPUT)) throw new Error('Source candidate already exists; review it instead of overwriting it.');
  const files = [...new Set([...APP_FILES, ...LEGAL_FILES, ...BUILD_INPUT_FILES, PLUGIN_FILE, ...SUPPORT])].sort();
  const prepared = files.map(file => {
    if (/^(artifacts|backups|dist|node_modules)\/|\.(bin|exe|dll|pem|pfx|p12|map|log|pyc)$/i.test(file)) throw new Error(`Excluded source path: ${file}`);
    let bytes = fs.readFileSync(sourceFile(ROOT, file));
    if (/\.(js|cjs|mjs|py|ps1|json|md|txt|nsh)$/i.test(file)) {
      const text = bytes.toString('utf8');
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/.test(text)) throw new Error(`Possible credential in ${file}`);
      if (text.includes(ROOT) || text.includes(ROOT.replace(/\\/g, '/'))) throw new Error(`Personal workspace path in ${file}`);
    }
    const sourceHash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (file === 'package.json') {
      const pkg = JSON.parse(bytes); pkg.scripts = scripts;
      bytes = Buffer.from(JSON.stringify(pkg, null, 2) + '\n');
    }
    return { file, bytes, sourceHash };
  });
  fs.mkdirSync(OUTPUT, { recursive: true });
  const entries = [];
  for (const { file, bytes, sourceHash } of prepared) {
    const target = path.join(OUTPUT, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx' });
    entries.push({ file, sourceSha256: sourceHash, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
  }
  fs.writeFileSync(path.join(OUTPUT, 'README.md'), `# Crush Control\n\nLocal source review candidate for a Windows app for the Crush 80 Pro. Nothing in this folder has been published.\n\nChoose individual key colours, save presets and use the supported wired or linked 2.4 GHz connection. Per-key RGB requires the exact supported custom firmware and tested hardware revision. The app does not include firmware or flash the keyboard. Bluetooth lighting control is not claimed.\n\n## Build the app\n\nUse Windows x64 and a current Node.js release. Run npm ci, npm test, npm run test:package and npm run package:check. npm run dist:win creates an unsigned local installer in dist/local-license-review. It does not install, launch, or publish. npm start launches the app and may connect to the keyboard; it is not an offline check.\n\nThe lockfile pins dependencies. The source package contains original readable app code and build inputs; npm supplies the third party dependencies. Runtime and installer source archives are a separate local bundle described in legal. No full Chromium rebuild is claimed. Public release remains blocked by legal/release-status.json.\n\n## Licences\n\nOriginal app code is MIT. GPL-2.0-only patch generators and offline validation tools have their own retained notices and copying terms. Read LICENSE_SCOPE.md and THIRD_PARTY_NOTICES.txt. Choosing MIT for the app does not relicense firmware or third party components.\n\n## Offline patch validation\n\nSee tools/firmware-validation/README.md for its isolated Python environment, commands, provenance and coverage limits. Synthetic patch checks do not require OEM firmware; extra stock checks require the exact user-supplied file. No OEM firmware, installer/flasher, retired harness, private signing key, user settings, device dump or development history is included. The package scripts intentionally omit historical live research and release publication commands.\n`);
  const manifest = { schemaVersion: 1, version: require('../package.json').version, published: false,
    licenceScope: 'MIT original app; file-specific GPL and third-party terms retained',
    generatedFiles: ['README.md', 'SOURCE-MANIFEST.json'], modifiedInputs: ['package.json: scripts limited to included tools'],
    credentialScan: 'private-key headers and common GitHub token patterns; not an exhaustive secret/provenance audit', files: entries };
  fs.writeFileSync(path.join(OUTPUT, 'SOURCE-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ directory: OUTPUT, files: entries.length, published: false }, null, 2));
}
if (require.main === module) main();
module.exports = { SUPPORT, scripts };
