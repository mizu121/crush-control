'use strict';
// Device-free packaging: this module never imports app/main or node-hid.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { builtinModules } = require('node:module');
const { APP_FILES, GENERATED_APP_FILES, LEGAL_FILES, legalDestination, BUILD_INPUT_FILES, PLUGIN_FILE, NATIVE_MODULES, THREE_ENTRIES, APP_UPDATE_CONFIG, UPDATER_PACKAGES } = require('../build/release-plan.cjs');
const ROOT = path.resolve(__dirname, '..');
const STAGE = path.join(ROOT, 'build', '.release-stage');
const slash = value => value.split(path.sep).join('/');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function sourceFile(root, name) {
  if (path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error(`Invalid release path: ${name}`);
  const file = path.join(root, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Release input must be a regular file: ${name}`);
  const real = fs.realpathSync(file);
  if (!real.startsWith(fs.realpathSync(root) + path.sep)) throw new Error(`Release input escapes its root: ${name}`);
  return file;
}

function validateInputs(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(sourceFile(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(sourceFile(root, 'package-lock.json'), 'utf8'));
  if (!pkg.private || pkg.license !== 'MIT' || lock.packages[''].license !== 'MIT') throw new Error('MIT app metadata and npm publication protection are required.');
  if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version) throw new Error('Package and lockfile versions differ.');
  for (const file of [...APP_FILES, ...LEGAL_FILES, ...BUILD_INPUT_FILES, PLUGIN_FILE]) sourceFile(root, file);
  require('../build/legal-assets.cjs').validateRuntimeNotices(root, LEGAL_FILES);
  require('../build/installer-templates.cjs').assertTemplatesCurrent();
  const update = JSON.parse(fs.readFileSync(sourceFile(root, 'app/update-config.json'), 'utf8'));
  if (Object.keys(update).sort().join(',') !== 'channel,enabled,owner,provider,publicKey,repo' || update.enabled !== true ||
      ['provider', 'owner', 'repo', 'channel'].some(key => update[key] !== APP_UPDATE_CONFIG[key])) throw new Error('App update feed must match the reviewed public beta feed.');
  if (typeof update.publicKey !== 'string' || update.publicKey.length > 1024 ||
      !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(update.publicKey) ||
      crypto.createPublicKey(update.publicKey).asymmetricKeyType !== 'ed25519') throw new Error('Only an Ed25519 public verification key may ship.');
  for (const name of [...NATIVE_MODULES, '@tabler/core', 'three', 'electron']) {
    const relative = `node_modules/${name}/package.json`;
    const installed = JSON.parse(fs.readFileSync(sourceFile(root, relative), 'utf8'));
    if (installed.version !== lock.packages[`node_modules/${name}`]?.version) throw new Error(`Lockfile mismatch: ${name}`);
    if (NATIVE_MODULES.includes(name)) {
      for (const dependency of Object.keys(installed.dependencies || {})) {
        if (!NATIVE_MODULES.includes(dependency)) throw new Error(`Review new native runtime dependency: ${dependency}`);
      }
    }
  }
  return pkg;
}

function stagePath(stageDirectory = STAGE) {
  const stage = path.resolve(stageDirectory);
  const allowed = [STAGE, path.join(ROOT, 'build', '.store-stage')];
  if (!allowed.includes(stage)) throw new Error('Unsafe release staging path.');
  return stage;
}

function resetStage(stageDirectory = STAGE) {
  const stage = stagePath(stageDirectory);
  // The only recursive deletion is this exact disposable child of build/.
  if (fs.realpathSync(path.dirname(stage)) !== path.dirname(stage)) throw new Error('Staging parent must not be a link.');
  if (fs.existsSync(stage) && fs.lstatSync(stage).isSymbolicLink()) throw new Error('Staging path must not be a link.');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'app'), { recursive: true });
}

function copy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function writeIcon(stage = STAGE) {
  const context = { module: { exports: {} }, Buffer, require(name) {
    if (name === 'zlib') return require('node:zlib');
    if (name === 'electron') return { nativeImage: { createFromBuffer: buffer => ({ toPNG: () => buffer }) } };
    throw new Error(`Unexpected icon dependency: ${name}`);
  } };
  // Evaluate only the pure icon generator with a stub; Electron is not loaded.
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'app/icon.js'), 'utf8'), context, { timeout: 1000 });
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = sizes.map(size => context.module.exports.makeIcon(size).toPNG());
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (let i = 0; i < sizes.length; i++) {
    const base = 6 + i * 16;
    header[base] = sizes[i] % 256; header[base + 1] = sizes[i] % 256;
    header.writeUInt16LE(1, base + 4); header.writeUInt16LE(32, base + 6);
    header.writeUInt32LE(images[i].length, base + 8); header.writeUInt32LE(offset, base + 12);
    offset += images[i].length;
  }
  fs.writeFileSync(path.join(stage, 'resources', 'icon.ico'), Buffer.concat([header, ...images]));
}

async function vendorFiles(esbuild, root = ROOT) {
  // Let the JS parser determine Three's exact static dependency closure.
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: THREE_ENTRIES.map(file => `node_modules/three/${file}`),
    bundle: true, write: false, metafile: true, outdir: 'unused-release-analysis',
    platform: 'browser', format: 'esm', external: ['three'], logLevel: 'silent',
  });
  const files = Object.keys(result.metafile.inputs).map(slash);
  if (files.some(file => !file.startsWith('node_modules/three/') || !file.endsWith('.js'))) throw new Error('Unexpected Three dependency.');
  return [...new Set([
    ...files, 'node_modules/three/LICENSE', 'node_modules/three/package.json',
    'node_modules/@tabler/core/dist/css/tabler.min.css', 'node_modules/@tabler/core/package.json',
  ])].sort();
}

async function updaterBundle(esbuild, root = ROOT) {
  const lock = JSON.parse(fs.readFileSync(sourceFile(root, 'package-lock.json'), 'utf8'));
  const notices = fs.readFileSync(sourceFile(root, 'THIRD_PARTY_NOTICES.txt'), 'utf8').replace(/\r\n/g, '\n');
  const sourceHashes = {}, inputHashes = {}, seen = new Set();
  const packages = UPDATER_PACKAGES.map(reviewed => {
    const relative = `${reviewed.directory}/package.json`;
    const data = fs.readFileSync(sourceFile(root, relative));
    const pkg = JSON.parse(data);
    if (pkg.name !== reviewed.name || pkg.version !== reviewed.version || pkg.license !== reviewed.license || lock.packages[reviewed.directory]?.version !== reviewed.version) throw new Error(`Review updater dependency change: ${reviewed.directory}`);
    sourceHashes[relative] = digest(data);
    if (!notices.includes(`${reviewed.name} ${reviewed.version}`)) throw new Error(`Missing updater notice: ${reviewed.name}`);
    if (reviewed.licenseFile) {
      const file = `${reviewed.directory}/${reviewed.licenseFile}`;
      const license = fs.readFileSync(sourceFile(root, file));
      sourceHashes[file] = digest(license);
      if (!notices.includes(license.toString('utf8').replace(/\r\n/g, '\n').trim())) throw new Error(`Full license text missing for ${reviewed.name}`);
    }
    return { ...reviewed };
  });
  const result = await esbuild.build({
    absWorkingDir: root, entryPoints: ['node_modules/electron-updater/out/main.js'],
    bundle: true, write: false, metafile: true, platform: 'node', format: 'cjs',
    target: 'node22', minify: true, legalComments: 'inline', sourcemap: false,
    external: ['electron'], logLevel: 'silent',
    plugins: [{ name: 'audit-updater-inputs', setup(build) {
      build.onLoad({ filter: /\.js$/ }, args => {
        const relative = slash(path.relative(root, args.path));
        const reviewed = [...UPDATER_PACKAGES].sort((a, b) => b.directory.length - a.directory.length).find(item => relative.startsWith(item.directory + '/'));
        if (!reviewed) throw new Error(`Unreviewed updater input: ${relative}`);
        const contents = fs.readFileSync(sourceFile(root, relative));
        inputHashes[relative] = digest(contents);
        seen.add(reviewed.directory);
        return { contents, loader: 'js', resolveDir: path.dirname(args.path) };
      });
    } }],
  });
  const inputs = Object.keys(result.metafile.inputs).map(slash).sort();
  if (inputs.some(file => !inputHashes[file]) || inputs.length !== Object.keys(inputHashes).length || seen.size !== UPDATER_PACKAGES.length) throw new Error('Updater dependency closure changed; review its inputs and notices.');
  const externals = [...new Set(Object.values(result.metafile.outputs).flatMap(output => output.imports.filter(item => item.external).map(item => item.path)))].sort();
  const allowed = new Set(['electron', ...builtinModules, ...builtinModules.map(name => `node:${name}`)]);
  if (externals.some(name => !allowed.has(name))) throw new Error('Updater bundle has an unreviewed external dependency.');
  const code = result.outputFiles[0].contents;
  if (code.length > 1024 * 1024) throw new Error('Unexpected updater bundle size; review dependency growth.');
  return { code, sha256: digest(code), inputHashes, sourceHashes: { ...sourceHashes, ...inputHashes }, packages, externals };
}

async function prepareStage({ stageDirectory = STAGE } = {}) {
  const stage = stagePath(stageDirectory);
  const pkg = validateInputs();
  const esbuild = require('esbuild');
  const vendors = await vendorFiles(esbuild);
  const updater = await updaterBundle(esbuild);
  const sources = [...APP_FILES, ...LEGAL_FILES, ...BUILD_INPUT_FILES, PLUGIN_FILE, ...vendors, 'package.json', 'package-lock.json'];
  const before = new Map(sources.map(file => [file, digest(fs.readFileSync(path.join(ROOT, file)))]));
  for (const [file, hash] of Object.entries(updater.sourceHashes)) before.set(file, hash);
  resetStage(stage);
  for (const file of APP_FILES) {
    const source = sourceFile(ROOT, file), destination = path.join(stage, 'app', file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (file.endsWith('.js')) {
      const output = await esbuild.transform(fs.readFileSync(source, 'utf8'), {
        loader: 'js', target: 'es2022', minify: true, legalComments: 'inline', sourcemap: false,
      });
      fs.writeFileSync(destination, output.code);
    } else copy(source, destination);
  }
  for (const file of LEGAL_FILES) copy(sourceFile(ROOT, file), path.join(stage, 'resources', 'legal', legalDestination(file)));
  const generated = GENERATED_APP_FILES[0];
  fs.mkdirSync(path.dirname(path.join(stage, 'app', generated)), { recursive: true });
  fs.writeFileSync(path.join(stage, 'app', generated), updater.code);
  fs.writeFileSync(path.join(stage, 'resources/app-update.yml'), Object.entries(APP_UPDATE_CONFIG).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n');
  copy(sourceFile(ROOT, PLUGIN_FILE), path.join(stage, 'resources', PLUGIN_FILE));
  for (const file of vendors) copy(sourceFile(ROOT, file), path.join(stage, 'vendor-runtime', file.replace(/^node_modules\//, '')));
  for (const name of NATIVE_MODULES) {
    fs.cpSync(path.join(ROOT, 'node_modules', name), path.join(stage, 'app/node_modules', name), {
      recursive: true, filter(file) {
        if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Unexpected dependency link: ${file}`);
        // The loader prefers local builds over prebuilds; do not copy one.
        if (name === 'node-hid' && path.relative(path.join(ROOT, 'node_modules', name), file).split(path.sep)[0] === 'build') return false;
        return true;
      },
    });
  }
  const hidVersion = require(path.join(ROOT, 'node_modules/node-hid/package.json')).version;
  const stagedPackage = {
    name: pkg.name, version: pkg.version, description: pkg.description,
    private: true, license: pkg.license, main: pkg.main, author: pkg.author,
    dependencies: { 'node-hid': hidVersion },
    bundledUiVersions: { three: require(path.join(ROOT, 'node_modules/three/package.json')).version, '@tabler/core': require(path.join(ROOT, 'node_modules/@tabler/core/package.json')).version },
  };
  fs.writeFileSync(path.join(stage, 'app/package.json'), JSON.stringify(stagedPackage, null, 2) + '\n');
  writeIcon(stage);
  for (const [file, hash] of before) if (digest(fs.readFileSync(path.join(ROOT, file))) !== hash) throw new Error(`Source changed while preparing release: ${file}`);
  const manifest = {
    version: pkg.version, appFiles: ['package.json', ...APP_FILES, ...GENERATED_APP_FILES],
    vendorFiles: vendors, legalFiles: LEGAL_FILES.map(legalDestination), sourceHashes: Object.fromEntries(before),
    generatedHashes: { [generated]: updater.sha256 }, appUpdate: APP_UPDATE_CONFIG,
    updater: { packages: updater.packages, inputHashes: updater.inputHashes, externals: updater.externals },
  };
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

async function main() {
  const mode = process.argv[2] || '--check';
  if (mode === '--check') {
    const pkg = validateInputs();
    const updater = await updaterBundle(require('esbuild'));
    console.log(`Release inputs verified: ${pkg.version}; ${APP_FILES.length} source app files; updater ${updater.packages.length} packages / ${Object.keys(updater.inputHashes).length} inputs; no device access.`);
    return;
  }
  if (!['--dir', '--installer', '--installer-existing'].includes(mode)) throw new Error('Use --check, --dir, --installer, or --installer-existing.');
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build this candidate on Windows x64.');
  const reuse = mode === '--installer-existing';
  if (!reuse) await prepareStage();
  // This candidate is always unsigned and never published, even on a signing machine.
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) delete process.env[name];
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  const { build, Platform, Arch } = require('electron-builder');
  const config = require('../build/windows.cjs');
  const { verifyPackage, verifyInstaller } = require('./verify-release.cjs');
  const unpacked = path.join(ROOT, config.directories.output, 'win-unpacked');
  if (reuse) await verifyPackage(unpacked);
  const output = await build({ projectDir: ROOT, config, publish: 'never', ...(reuse ? { prepackaged: unpacked } : {}), targets: Platform.WINDOWS.createTarget(mode === '--dir' ? 'dir' : 'nsis', Arch.x64) });
  const report = await verifyPackage(unpacked);
  const files = output.filter(file => fs.existsSync(file) && fs.statSync(file).isFile());
  const sums = files.map(file => `${digest(fs.readFileSync(file))}  ${path.basename(file)}`).join('\n');
  fs.writeFileSync(path.join(ROOT, config.directories.output, 'SHA256SUMS.txt'), sums + '\n');
  fs.writeFileSync(path.join(ROOT, config.directories.output, 'PACKAGE-VERIFICATION.json'), JSON.stringify(report, null, 2) + '\n');
  const installer = files.find(file => file.endsWith('-setup.exe'));
  if (installer) {
    const checked = await verifyInstaller(installer, unpacked);
    fs.writeFileSync(path.join(ROOT, config.directories.output, 'INSTALLER-VERIFICATION.json'), JSON.stringify(checked, null, 2) + '\n');
    console.log(JSON.stringify(checked, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
  console.log('Private unsigned build created. Nothing was installed, launched, or published.');
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { ROOT, STAGE, stagePath, sourceFile, validateInputs, vendorFiles, updaterBundle, prepareStage, digest };
