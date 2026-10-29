'use strict';
// Local signing and an explicit, allowlisted draft upload. Never upload source.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { APP_ID, installerName, manifestName, verifyReleaseEnvelope, assertUpdateInfo } = require('../app/update-security');
const ROOT = path.resolve(__dirname, '..');
const configFile = path.join(ROOT, 'app/update-config.json');
function keyPath() {
  const file = process.env.CRUSH_UPDATE_SIGNING_KEY || (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'CrushControl', 'signing', 'release-ed25519.pem'));
  if (!file || !path.isAbsolute(file) || path.resolve(file).toLowerCase().startsWith(ROOT.toLowerCase() + path.sep)) throw new Error('Keep the release signing key outside the project; set CRUSH_UPDATE_SIGNING_KEY to its absolute path.');
  return file;
}
function initializeKey() {
  const file = keyPath();
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  let key;
  if (fs.existsSync(file)) key = crypto.createPrivateKey(fs.readFileSync(file));
  else {
    if (config.publicKey) throw new Error('A public key is already configured. Restore its matching private key instead of rotating it silently.');
    key = crypto.generateKeyPairSync('ed25519').privateKey;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The release signing key must be Ed25519.');
  const publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
  if (config.publicKey && config.publicKey !== publicKey) throw new Error('The existing signing key does not match the pinned public key.');
  fs.writeFileSync(configFile, JSON.stringify({ ...config, publicKey }, null, 2) + '\n');
  return { publicKeyConfigured: true, privateKeyKeptOutsideProject: true, publicKeyFingerprint: crypto.createHash('sha256').update(publicKey).digest('hex') };
}
async function signRelease() {
  const status = JSON.parse(fs.readFileSync(path.join(ROOT, 'legal/release-status.json'), 'utf8'));
  if (status.publicReleaseApproved !== true || status.version !== require('../package.json').version) throw new Error(`Release remains local: ${status.reason || 'licensing review is incomplete'}`);
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const { verifyPackage, verifyInstaller } = require('./verify-release.cjs');
  const directory = path.join(ROOT, require('../build/windows.cjs').directories.output);
  const exe = path.join(directory, installerName(version));
  await verifyPackage(path.join(directory, 'win-unpacked'));
  await verifyInstaller(exe, path.join(directory, 'win-unpacked'));
  const notes = fs.readFileSync(path.join(ROOT, 'docs/releases', version + '.md'), 'utf8').trim();
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(exe)) hash.update(chunk);
  const payload = { schemaVersion: 1, appId: APP_ID, owner: config.owner, repo: config.repo, channel: config.channel, version, installer: installerName(version), sha512: hash.digest('base64'), size: fs.statSync(exe).size, notes };
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const key = crypto.createPrivateKey(fs.readFileSync(keyPath()));
  const envelope = { payload: bytes.toString('base64'), signature: crypto.sign(null, bytes, key).toString('base64') };
  verifyReleaseEnvelope(envelope, config);
  const yaml = require('js-yaml');
  const feedFile = path.join(directory, config.channel === 'beta' ? 'beta.yml' : 'latest.yml');
  assertUpdateInfo(yaml.load(fs.readFileSync(feedFile, 'utf8')), payload);
  const output = path.join(directory, manifestName(version));
  if (fs.existsSync(output)) {
    const existing = fs.readFileSync(output, 'utf8');
    if (existing !== JSON.stringify(envelope, null, 2) + '\n') throw new Error('A different signed release already exists for this version. Bump the version before publishing changed bytes.');
  } else fs.writeFileSync(output, JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx' });
  return { version, repository: `${config.owner}/${config.repo}`, tag: `v${version}`, channel: config.channel, files: [exe, exe + '.blockmap', feedFile, output], notesFile: path.join(ROOT, 'docs/releases', version + '.md') };
}
async function draftRelease() {
  const release = await signRelease();
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 }).trim();
  const repo = JSON.parse(gh(['api', `repos/${release.repository}`]));
  if (repo.full_name !== release.repository || repo.private || repo.archived || !repo.permissions?.push) throw new Error('Expected an owned public release repository with push permission.');
  // Creation deliberately fails if the tag exists; never replace a published release.
  const args = ['release', 'create', release.tag, ...release.files, '--repo', release.repository, '--draft', '--title', `Crush Control ${release.version}`, '--notes-file', release.notesFile];
  if (release.channel === 'beta') args.push('--prerelease');
  return { draftUrl: gh(args), published: false, uploadedFiles: release.files.map(file => path.basename(file)) };
}
async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['--init-key', '--sign', '--draft'].includes(mode)) throw new Error('Use --init-key, --sign, or --draft. --draft uploads only reviewed release assets to a private draft in the public release repository.');
  const result = mode === '--init-key' ? initializeKey() : mode === '--sign' ? await signRelease() : await draftRelease();
  console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { initializeKey, signRelease, draftRelease };
