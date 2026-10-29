'use strict';
// Offline preparation from the audited official archives. Never load a DLL.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const EVIDENCE = path.join(ROOT, 'artifacts/license-audit/upstream-evidence');
const LEGAL = path.join(ROOT, 'legal/installer');
const STAGE = path.join(ROOT, 'artifacts/license-audit/installer-source-stage');
const SOURCES = [
  { name: 'StdUtils 1.14', file: 'StdUtils.2018-10-27.zip', sha256: '3ffe893dc7477fdb1cac551a86ae017509e1f2d0ebdc7185fd0fbaf20870688c', url: 'https://github.com/lordmulder/stdutils/releases/download/1.14/StdUtils.2018-10-27.zip' },
  { name: 'Nsis7z 19.00', file: 'Nsis7z_19.00.7z', sha256: '6f2f3730049926f40442ee0c8b7d3e3dee7ace544d82467ff8059ea3f4201c58', url: 'https://nsis.sourceforge.io/mediawiki/images/6/69/Nsis7z_19.00.7z' },
  { name: 'LZMA SDK 19.00', file: 'lzma1900.7z', sha256: '00f569e624b3d9ed89cf8d40136662c4c5207eaceb92a70b1044c77f84234bad', url: 'https://www.7-zip.org/a/lzma1900.7z' },
];
const PLUGINS = Object.freeze({
  'StdUtils.dll': 'b72e9013a6204e9f01076dc38dabbf30870d44dfc66962adbf73619d4331601e',
  'nsis7z.dll': 'b393f05e8ff919ef071181050e1873c9a776e1a0ae8329aefff7007d0cadf592',
});
const NOTICE_FILES = Object.freeze([
  'legal/installer/NOTICE.txt', 'legal/installer/BUILDING.txt',
  'legal/installer/LGPL-2.1.txt', 'legal/installer/StdUtils-LGPL-clarification.txt',
  'legal/installer/Nsis7z-19.00-upstream.txt', 'legal/installer/LZMA-SDK-LICENSE.txt',
  'legal/installer/NSIS-COPYING.txt', 'legal/installer/SOURCE_MANIFEST.json',
  'legal/installer/TEMPLATE_OVERRIDES.txt', 'legal/installer/PROJECT-MIT-LICENSE.txt',
  ...['StdUtils-LGPL-2.1.txt', 'StdUtils-clarification.txt', 'Nsis7z-wrapper.txt',
    'LZMA-SDK-19.txt', 'NSIS-core-System.txt', 'Unicode-NSIS-pluginapi.txt',
    'RHash.txt', 'BLAKE2-CC0.txt', 'electron-builder-MIT.txt'].map(file => `legal/installer/LICENSES/${file}`),
]);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function walk(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw new Error('Source links are not allowed');
    const relative = prefix + entry.name;
    return entry.isDirectory() ? walk(path.join(directory, entry.name), relative + '/') : [relative];
  }).sort();
}
function copy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination) && fs.readFileSync(source).equals(fs.readFileSync(destination))) return;
  fs.copyFileSync(source, destination);
}
function assertPlugin(name, bytes) {
  if (!PLUGINS[name] || sha256(bytes) !== PLUGINS[name]) throw new Error(`Unreviewed installer plugin ${name}`);
}
async function prepare() {
  const seven = await require('app-builder-lib/out/toolsets/7zip').getPath7za();
  for (const input of SOURCES) {
    if (sha256(fs.readFileSync(path.join(EVIDENCE, input.file))) !== input.sha256) throw new Error(`Source archive mismatch: ${input.file}`);
  }
  assertPlugin('StdUtils.dll', fs.readFileSync(path.join(EVIDENCE, 'stdutils-1.14-release/Plugins/Unicode/StdUtils.dll')));
  assertPlugin('nsis7z.dll', fs.readFileSync(path.join(EVIDENCE, 'nsis7z-19.00/Plugins/x86-unicode/nsis7z.dll')));
  // No cleanup/deletion: a stale or contaminated source stage is rejected.
  fs.mkdirSync(STAGE, { recursive: true });
  const files = new Map();
  const add = (from, to) => {
    if (files.has(to)) throw new Error(`Duplicate source destination ${to}`);
    files.set(to, { from, sha256: sha256(fs.readFileSync(from)) });
  };
  const std = path.join(EVIDENCE, 'stdutils-1.14-source');
  for (const file of walk(std)) {
    // Omit compiler binaries, the proprietary Microsoft runtime import library,
    // generated IDE caches and optional upstream packing tools. API C is below.
    if (/\.(?:exe|dll|lib|aps|user)$/i.test(file) || file === '.gitignore') continue;
    add(path.join(std, file), `StdUtils-1.14/${file}`);
  }
  const api = path.join(LEGAL, 'source-additions/nsis-pluginapi');
  for (const file of walk(api)) add(path.join(api, file), `StdUtils-1.14/pluginapi-source/${file}`);
  require('./installer-templates.cjs').assertTemplatesCurrent();
  for (const file of walk(path.join(__dirname, 'installer-templates'))) add(path.join(__dirname, 'installer-templates', file), `Installer-overrides/build/installer-templates/${file}`);
  for (const file of ['installer-templates.cjs', 'installer.nsh', 'installer-process-check.nsh']) add(path.join(__dirname, file), `Installer-overrides/build/${file}`);
  const sdk = path.join(EVIDENCE, 'lzma-19.00');
  for (const file of walk(sdk)) {
    if (!/^(C|CPP|Asm|DOC)\//.test(file) || /\.(?:exe|dll|lib|obj|pdb)$/i.test(file)) continue;
    add(path.join(sdk, file), `Nsis7z-19.00/${file}`);
  }
  const wrapper = path.join(EVIDENCE, 'nsis7z-19.00/Contrib/nsis7z');
  for (const file of walk(wrapper)) {
    if (/\.user$/i.test(file)) continue;
    // Wrapper overlays are the upstream documented assembly step; none of
    // these paths overwrite SDK source in the audited 19.00 archives.
    add(path.join(wrapper, file), `Nsis7z-19.00/${file}`);
  }
  const licenseCopies = [
    ['stdutils-1.14-release/LGPL.txt', 'LGPL-2.1.txt'],
    ['stdutils-1.14-release/LGPL_CLARIFICATION.txt', 'StdUtils-LGPL-clarification.txt'],
    ['nsis7z-19.00/Contrib/nsis7z/DOC/nsis7z.txt', 'Nsis7z-19.00-upstream.txt'],
    ['nsis7z-19.00/Contrib/nsis7z/DOC/License.txt', 'LZMA-SDK-LICENSE.txt'],
  ];
  for (const [input, output] of licenseCopies) copy(path.join(EVIDENCE, input), path.join(LEGAL, output));
  const compilerCopying = path.join(process.env.LOCALAPPDATA, 'electron-builder/Cache/nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/COPYING');
  copy(compilerCopying, path.join(LEGAL, 'NSIS-COPYING.txt'));
  copy(path.join(ROOT, 'node_modules/electron-builder/LICENSE'), path.join(LEGAL, 'LICENSES/electron-builder-MIT.txt'));
  copy(path.join(ROOT, 'LICENSE.txt'), path.join(LEGAL, 'PROJECT-MIT-LICENSE.txt'));
  const nestedLicenses = [
    ['LGPL-2.1.txt', 'StdUtils-LGPL-2.1.txt'],
    ['StdUtils-LGPL-clarification.txt', 'StdUtils-clarification.txt'],
    ['Nsis7z-19.00-upstream.txt', 'Nsis7z-wrapper.txt'],
    ['LZMA-SDK-LICENSE.txt', 'LZMA-SDK-19.txt'],
    ['NSIS-COPYING.txt', 'NSIS-core-System.txt'],
    ['source-additions/nsis-pluginapi/COPYING', 'Unicode-NSIS-pluginapi.txt'],
  ];
  for (const [input, output] of nestedLicenses) copy(path.join(LEGAL, input), path.join(LEGAL, 'LICENSES', output));
  copy(path.join(std, 'Contrib/StdUtils/src/rhash/COPYING.txt'), path.join(LEGAL, 'LICENSES/RHash.txt'));
  copy(path.join(std, 'Contrib/StdUtils/src/blake2/COPYING.txt'), path.join(LEGAL, 'LICENSES/BLAKE2-CC0.txt'));
  for (const file of NOTICE_FILES.filter(name => !name.endsWith('SOURCE_MANIFEST.json'))) add(path.join(ROOT, file), file.replace('legal/installer/', ''));
  for (const [relative, item] of files) copy(item.from, path.join(STAGE, relative));
  const manifest = {
    schema: 1, generatedFor: 'local license remediation; no publication authorization',
    upstreamArchives: SOURCES, binaryPlugins: PLUGINS,
    stdutilsSourceCommit: '4e1117321001e54dcd2c52f72d3c359d5215e426',
    nsisApiSource: {
      repository: 'https://github.com/jimpark/unsis', commit: '6bb3de8754f5c6c1dabf4358c69dca223102a278',
      path: 'unicode-src/Contrib/ExDLL',
      evidence: 'The normalized pluginapi.h matches the header in the official StdUtils source archive. Historical helper object equivalence and a full DLL rebuild have not been verified.',
    },
    sourceFiles: [...files].map(([name, entry]) => ({ name, sha256: entry.sha256 })),
    omitted: ['proprietary msvcrt_vc6.lib: obtain from a licensed Microsoft toolchain', 'NSIS prebuilt .lib files: corresponding API C/header sources supplied', 'Date.exe and Zip.exe: optional upstream release-packing tools', 'generated IDE caches/settings'],
    verificationLimits: ['No native source build or byte-for-byte reconstruction performed.', 'This is an upstream source and build-input package, not a legal opinion.', 'Nsis7z wrapper is conservatively handled under its documented LGPL statement; the SDK public-domain text is not attributed to the whole wrapper.'],
  };
  fs.writeFileSync(path.join(LEGAL, 'SOURCE_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  copy(path.join(LEGAL, 'SOURCE_MANIFEST.json'), path.join(STAGE, 'SOURCE_MANIFEST.json'));
  const expected = [...files.keys(), 'SOURCE_MANIFEST.json'].sort();
  if (JSON.stringify(walk(STAGE)) !== JSON.stringify(expected)) throw new Error('Unlisted file in source stage');
  const output = path.join(LEGAL, 'sources/installer-dependency-sources.zip');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (fs.existsSync(output)) throw new Error('Source archive already exists; do not silently overwrite audited output');
  execFileSync(seven, ['a', '-tzip', '-mx=9', output, '.'], { cwd: STAGE, stdio: 'pipe' });
  const summary = { file: path.relative(ROOT, output).replaceAll('\\', '/'), sha256: sha256(fs.readFileSync(output)), bytes: fs.statSync(output).size, files: expected.length };
  fs.writeFileSync(path.join(LEGAL, 'sources/archive.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}
module.exports = { SOURCES, PLUGINS, NOTICE_FILES, assertPlugin, walk, prepare };
if (require.main === module) prepare().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
