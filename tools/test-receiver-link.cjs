'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { validLink, readLinks, makeLink, writeLink } = require('../app/receiver-link.js');
const { batteryLabel } = require('../app/battery-presentation.js');
const CRC = 0x5566ddf2;
const HASH_A = 'a'.repeat(64), HASH_B = 'b'.repeat(64);
const DATE = '2026-10-28T18:00:00.000Z';
const trusted = () => ({ connected: true, info: { connection: 'usb', deviceKey: 'verified-wired', rgb: { firmwareCrc: CRC, supported: true, rearFollowSupported: true } } });
const candidate = hash => ({ connection: 'receiver', pathHash: hash });
const link = (hash = HASH_A, at = DATE) => makeLink(trusted(), candidate(hash), at);
function directory(t) {
  const parent = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(parent, 'crush-links-fake-'));
  t.after(() => {
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('crush-links-fake-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return dir;
}

test('association requires connected USB, exact combined CRC and both verified RGB capabilities', () => {
  const value = link();
  assert.deepEqual(value, { schemaVersion: 1, pathHash: HASH_A, keyboardCrc: CRC, model: 'Crush 80 Pro', linkedAt: DATE });
  assert.equal(validLink(value, HASH_A), true);
  assert.equal(validLink(value, HASH_B), false);
  const cases = [
    null, { connected: false },
    { ...trusted(), connected: false },
    { connected: true, info: { ...trusted().info, connection: 'receiver' } },
    { connected: true, info: { ...trusted().info, connection: 'bluetooth' } },
  ];
  for (const rgb of [
    { ...trusted().info.rgb, firmwareCrc: 0xa7da1601 },
    { ...trusted().info.rgb, firmwareCrc: null },
    { ...trusted().info.rgb, firmwareCrc: String(CRC) },
    { ...trusted().info.rgb, supported: false },
    { ...trusted().info.rgb, supported: 'true' },
    { ...trusted().info.rgb, rearFollowSupported: false },
    { ...trusted().info.rgb, rearFollowSupported: 1 },
  ]) cases.push({ connected: true, info: { ...trusted().info, rgb } });
  for (const status of cases) assert.throws(() => makeLink(status, candidate(HASH_A), DATE), /USB/);
});

test('malformed hashes, non-string hashes, wrong connection and invalid timestamps are rejected', () => {
  for (const hash of [null, undefined, '', 'f'.repeat(63), 'g'.repeat(64), 'A'.repeat(64), [HASH_A], { pathHash: HASH_A }]) {
    assert.throws(() => makeLink(trusted(), candidate(hash), DATE));
    assert.equal(validLink({ ...link(), pathHash: hash }), false);
  }
  assert.throws(() => makeLink(trusted(), { connection: 'usb', pathHash: HASH_A }, DATE));
  assert.throws(() => makeLink(trusted(), candidate(HASH_A), 'invalid date'));
  assert.equal(validLink({ ...link(), schemaVersion: 2 }), false);
  assert.equal(validLink({ ...link(), keyboardCrc: CRC + 1 }), false);
  assert.equal(validLink({ ...link(), model: 'Other keyboard' }), false);
});

test('lookup fails closed for absent/corrupt/oversized/duplicate/untrusted storage', t => {
  const dir = directory(t), file = path.join(dir, 'receiver-links.json');
  assert.deepEqual(readLinks(file), []);
  for (const text of [
    '{bad', '{}', JSON.stringify([link(), link()]),
    JSON.stringify([{ ...link(), keyboardCrc: 0 }]),
    JSON.stringify([{ ...link(), pathHash: [HASH_A] }]),
    JSON.stringify(Array(17).fill(link())), ' '.repeat(16385),
  ]) {
    fs.writeFileSync(file, text);
    assert.deepEqual(readLinks(file), [], text.slice(0, 45));
  }
  assert.deepEqual(readLinks(dir), []);
});

test('successful read returns only trusted link fields and a detached copy', t => {
  const file = path.join(directory(t), 'receiver-links.json');
  fs.writeFileSync(file, JSON.stringify([{ ...link(), rawPath: 'DO-NOT-RETAIN', untrusted: true }]));
  const first = readLinks(file);
  assert.deepEqual(first, [link()]);
  first[0].pathHash = HASH_B;
  assert.equal(readLinks(file)[0].pathHash, HASH_A);
});

test('atomic replacement preserves other links and replaces one association without duplication', t => {
  const file = path.join(directory(t), 'receiver-links.json');
  writeLink(file, link());
  const prior = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  let renames = 0;
  fs.renameSync = (from, to) => {
    renames++;
    assert.equal(to, file);
    assert.equal(fs.readFileSync(file, 'utf8'), prior, 'Original target remains complete until replacement');
    const prepared = JSON.parse(fs.readFileSync(from, 'utf8'));
    assert.deepEqual(prepared, [link(), link(HASH_B)]);
    return rename(from, to);
  };
  try { writeLink(file, link(HASH_B)); } finally { fs.renameSync = rename; }
  assert.equal(renames, 1);
  const replacement = link(HASH_A, '2026-10-29T18:00:00.000Z');
  writeLink(file, replacement);
  const saved = readLinks(file);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.find(item => item.pathHash === HASH_A), replacement);
  assert.deepEqual(saved.find(item => item.pathHash === HASH_B), link(HASH_B));
});

test('failed replacement preserves existing target; corrupt existing storage is never silently replaced', t => {
  const file = path.join(directory(t), 'receiver-links.json');
  writeLink(file, link());
  const before = fs.readFileSync(file, 'utf8'), rename = fs.renameSync;
  fs.renameSync = () => { throw Error('Simulated rename failure'); };
  try { assert.throws(() => writeLink(file, link(HASH_B)), /rename failure/); } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.writeFileSync(file, '{unreadable JSON');
  assert.throws(() => writeLink(file, link(HASH_B)), /corrupt|invalid|read|association/i);
  assert.equal(fs.readFileSync(file, 'utf8'), '{unreadable JSON');
});

test('association count stays bounded while an existing link can still be refreshed', t => {
  const file = path.join(directory(t), 'receiver-links.json');
  const sixteen = Array.from({ length: 16 }, (_, index) => link(index.toString(16).repeat(64)));
  fs.writeFileSync(file, JSON.stringify(sixteen));
  assert.throws(() => writeLink(file, link('0123456789abcdef'.repeat(4))), /Too many/);
  const updated = link(sixteen[0].pathHash, '2026-10-29T18:00:00.000Z');
  writeLink(file, updated);
  assert.equal(readLinks(file).length, 16);
  assert.deepEqual(readLinks(file).find(item => item.pathHash === updated.pathHash), updated);
});

test('battery labels distinguish last-known 61 percent, unknown and a real zero; charging requires true', () => {
  assert.equal(batteryLabel({ percent: 61, stale: true, charging: true }), 'Battery 61% · last known');
  assert.equal(batteryLabel({ percent: 61, stale: false, charging: true }), 'Battery 61% · charging');
  assert.equal(batteryLabel({ percent: 0, stale: false, charging: false }), 'Battery 0%');
  for (const charging of [false, null, undefined, 'true', 1]) {
    assert.equal(batteryLabel({ percent: 61, stale: false, charging }), 'Battery 61%');
  }
  for (const battery of [null, undefined, {}, { percent: null }, { percent: '0' }, { percent: '61' }, { percent: -1 }, { percent: 101 }, { percent: NaN }]) {
    assert.equal(batteryLabel(battery), 'Battery unavailable');
  }
});

test('generated battery and app icons are decodable RGBA PNGs at tray dimensions without Electron', () => {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/icon.js'), 'utf8'), {
    module, Buffer,
    require(name) {
      if (name === 'zlib') return zlib;
      if (name === 'electron') return { nativeImage: { createFromBuffer: buffer => Buffer.from(buffer) } };
      throw Error(`Unexpected dependency ${name}`);
    },
  });
  const images = [module.exports.makeIcon(32), module.exports.makeBatteryIcon({ percent: 61, stale: true }, 32), module.exports.makeBatteryIcon({ percent: null, charging: null }, 16), module.exports.makeBatteryIcon({ percent: 0, stale: false }, 48)];
  for (let i = 0; i < images.length; i++) {
    const png = images[i], size = [32, 32, 16, 48][i];
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
    assert.equal(png[24], 8); assert.equal(png[25], 6);
    const idat = [];
    for (let at = 8; at < png.length;) {
      const length = png.readUInt32BE(at), kind = png.toString('ascii', at + 4, at + 8);
      assert.ok(at + length + 12 <= png.length);
      if (kind === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
      at += length + 12;
    }
    assert.equal(zlib.inflateSync(Buffer.concat(idat)).length, size * (size * 4 + 1));
  }
});
