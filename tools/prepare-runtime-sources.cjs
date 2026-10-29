#!/usr/bin/env node
'use strict';

// Download source/data only. Never execute upstream code, run a build, or touch HID.
// Run with --verify for an offline integrity check of an already assembled bundle.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '..');
const dest = path.join(root, 'legal/third-party/runtime');
const manifestPath = path.join(dest, 'runtime-source-manifest.json');
const specsPath = path.join(dest, 'source-specs.json');
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const within = relative => {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Unsafe relative path');
  const p = path.resolve(dest, relative);
  if (!p.startsWith(dest + path.sep)) throw new Error('Path escapes source bundle');
  return p;
};
function tarEntries(gz) {
  const tar = zlib.gunzipSync(gz, { maxOutputLength: 1024 * 1024 * 1024 });
  const entries = [];
  let pos = 0, longName = '', paxName = '';
  while (pos + 512 <= tar.length) {
    const header = tar.subarray(pos, pos + 512);
    let name = header.subarray(0, 100).toString().split('\0')[0];
    if (!name) break;
    const prefix = header.subarray(345, 500).toString().split('\0')[0];
    if (prefix) name = prefix + '/' + name;
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0/g, '').trim(), 8) || 0;
    const type = String.fromCharCode(header[156]);
    if (pos + 512 + size > tar.length) throw new Error('Truncated source archive');
    const data = tar.subarray(pos + 512, pos + 512 + size);
    if (type === 'L') longName = data.toString().replace(/\0.*$/s, '');
    else if (type === 'x') paxName = data.toString().match(/\d+ path=([^\n]*)/)?.[1] || '';
    else {
      name = paxName || longName || name;
      longName = paxName = '';
      if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('Unsafe archive entry');
      entries.push({ name, type, size, data });
    }
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
async function download(spec) {
  if (!/^https:\/\/(chromium\.googlesource\.com|codeload\.github\.com|raw\.githubusercontent\.com)\//.test(spec.url)) throw new Error('Unapproved upstream source host');
  const response = await fetch(spec.url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > (spec.maxBytes || 100 * 1024 * 1024)) throw new Error('Source exceeds bounded download size');
    chunks.push(chunk);
  }
  let data = Buffer.concat(chunks);
  if (spec.base64) data = Buffer.from(data.toString(), 'base64');
  return data;
}
function saveManifest(manifest) {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
function finalize(manifest) {
  const expected = {
    'LICENSE.electron.txt': ['LICENSE', '5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d'],
    'LICENSES.chromium.html': ['LICENSES.chromium.html', '7dac8267ac6da8d959cfe88f5f055b18a397f10230380b5329125e167bf5639b'],
  };
  manifest.deliveredRuntimeNotices = [];
  for (const [file, [upstreamFile, expectedHash]] of Object.entries(expected)) {
    const source = path.join(root, 'node_modules/electron/dist', upstreamFile);
    const data = fs.readFileSync(source);
    if (digest(data) !== expectedHash) throw new Error(`Runtime notice version mismatch: ${file}`);
    fs.writeFileSync(path.join(dest, file), data);
    manifest.deliveredRuntimeNotices.push({ path: file, bytes: data.length, sha256: expectedHash,
      provenance: 'Exact Electron 45.1.0 notice, verified identical to audited beta.5 through beta.8' });
  }
  manifest.assemblyChecks.allPlannedSourcesPresent = manifest.allPlannedSourcesPresent;
  manifest.extractedLicenceDocuments = manifest.materials.reduce((sum,item) => sum + (item.licenceFiles?.length || 0), 0);
  const sums = manifest.materials.filter(m => m.status === 'downloaded').map(m => `${m.sha256}  ${m.localPath}`);
  for (const f of manifest.deliveredRuntimeNotices) sums.push(`${f.sha256}  ${f.path}`);
  fs.writeFileSync(path.join(dest, 'SHA256SUMS.txt'), sums.sort().join('\n') + '\n');
  const index = ['# Exact runtime source materials', '',
    `Electron 45.1.0; Chromium 156.0.8078.49 (${manifest.chromiumCommit}). Local assembly only.`, '',
    '| Component | Revision | Local source | Bytes | Licence |',
    '| --- | --- | --- | ---: | --- |'];
  for (const m of manifest.materials) index.push(`| ${m.id} | ${m.revision} | [${path.basename(m.localPath)}](${m.localPath}) | ${m.bytes || 'FAILED'} | ${m.licence || 'Build metadata; see original headers'} |`);
  index.push('', 'Original upstream URLs, exact hashes and every extracted licence file are in runtime-source-manifest.json. Source archives are unmodified snapshots. Electron patch stacks are retained in its full archive, not silently applied to other snapshots.', '',
    'See SOURCE_ACCESS.md for source coverage, publication status and the separate combined-runtime relink limitation. These materials are not claimed to be a self-contained complete Chromium build checkout.');
  fs.writeFileSync(path.join(dest, 'SOURCE_INDEX.md'), index.join('\n') + '\n');
}
async function main() {
  if (process.argv.includes('--verify')) {
    const m = JSON.parse(fs.readFileSync(manifestPath));
    const bad = [];
    for (const item of m.materials) {
      if (item.status !== 'downloaded') { bad.push(`${item.id}: ${item.status}`); continue; }
      const b = fs.readFileSync(within(item.localPath));
      if (b.length !== item.bytes || digest(b) !== item.sha256) bad.push(item.id);
      for (const l of item.licenceFiles || []) if (digest(fs.readFileSync(within(l.localPath))) !== l.sha256) bad.push(l.localPath);
    }
    for (const item of m.deliveredRuntimeNotices || []) if (digest(fs.readFileSync(within(item.path))) !== item.sha256) bad.push(item.path);
    if (bad.length) throw new Error(`Source verification failed: ${bad.join(', ')}`);
    console.log(`Verified ${m.materials.length} exact source/data files and their extracted licence texts. No build or execution performed.`);
    return;
  }
  const plan = JSON.parse(fs.readFileSync(specsPath));
  const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath)) : { materials: [] };
  const old = new Map(previous.materials.map(m => [m.id, m]));
  const manifest = { ...plan.metadata, generatedAt: new Date().toISOString(), materials: [], classification: plan.classification };
  fs.mkdirSync(path.join(dest, 'sources'), { recursive: true });
  const tasks = [...plan.materials];
  async function worker() {
    while (tasks.length) {
      const spec = tasks.shift();
      const item = { ...spec, status: 'pending' };
      delete item.maxBytes;
      try {
        const p = within(spec.localPath), prev = old.get(spec.id);
        let data;
        if (prev?.url === spec.url && prev.status === 'downloaded' && fs.existsSync(p)) {
          data = fs.readFileSync(p);
          if (digest(data) !== prev.sha256) throw new Error('Existing cached source hash mismatch');
        } else if (spec.cachedInput && fs.existsSync(path.resolve(root, spec.cachedInput))) {
          data = fs.readFileSync(path.resolve(root, spec.cachedInput));
          if (digest(data) !== spec.cachedSha256) throw new Error('Prior evidence hash mismatch');
        } else data = await download(spec);
        const entries = spec.format === 'tar.gz' ? tarEntries(data) : [];
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, data);
        item.bytes = data.length;
        item.sha256 = digest(data);
        item.archiveEntries = entries.length || undefined;
        item.licenceFiles = [];
        for (const e of entries) {
          if (!['0', '\0'].includes(e.type) || e.size > 2 * 1024 * 1024) continue;
          if (!/^(licen[cs]e(?:[._-].*)?|copying(?:[._-].*)?|copyright(?:[._-].*)?|notice(?:[._-].*)?)$/i.test(path.posix.basename(e.name))) continue;
          const relative = `LICENSES/${spec.id}/${e.name}`;
          const output = within(relative);
          fs.mkdirSync(path.dirname(output), { recursive: true });
          fs.writeFileSync(output, e.data);
          item.licenceFiles.push({ archivePath: e.name, localPath: relative, sha256: digest(e.data), bytes: e.size });
        }
        item.status = 'downloaded';
        console.log(`${spec.id}: ${data.length} bytes, ${entries.length} source entries`);
      } catch (error) {
        item.status = 'failed';
        item.error = error.message;
        console.log(`${spec.id}: FAILED ${error.message}`);
      }
      manifest.materials.push(item);
      manifest.materials.sort((a,b) => a.id.localeCompare(b.id));
      saveManifest(manifest);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  manifest.downloadedCount = manifest.materials.filter(m => m.status === 'downloaded').length;
  manifest.totalBytes = manifest.materials.reduce((s,m) => s + (m.bytes || 0), 0);
  manifest.allPlannedSourcesPresent = manifest.downloadedCount === manifest.materials.length;
  finalize(manifest);
  saveManifest(manifest);
  if (!manifest.allPlannedSourcesPresent) process.exitCode = 1;
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
