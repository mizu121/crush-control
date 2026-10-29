'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { inspectCompiledScript } = require('../build/installer-inspection.cjs');

const apis = ['RmStartSession', 'RmRegisterResources', 'RmGetList', 'RmEndSession'];
function fixture(strings, compressed = true) {
  const content = Buffer.from(strings.join('\0') + '\0'.repeat(100), 'utf16le');
  const packed = compressed ? zlib.deflateRawSync(content) : content;
  const preamble = Buffer.alloc(96);
  Buffer.from('efbeadde4e756c6c736f6674496e7374', 'hex').copy(preamble, 68);
  preamble.writeUInt32LE(content.length, 84);
  preamble.writeUInt32LE((compressed ? 0x80000000 : 0) + packed.length, 92);
  return Buffer.concat([preamble, packed]);
}
function withFixture(bytes, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crush-nsis-inspection-'));
  const file = path.join(directory, 'inert-header.bin');
  try {
    fs.writeFileSync(file, bytes);
    return callback(file);
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
}

test('compiled-header inspection reads compressed or plain Unicode strings without execution', () => {
  for (const compressed of [true, false]) withFixture(fixture(apis, compressed), file => {
    const result = inspectCompiledScript(file);
    assert.deepEqual(result.processApis, apis);
    assert.deepEqual(result.forbiddenOperations, []);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
  });
});

test('missing query APIs or any removed/terminating name fails inspection', () => {
  withFixture(fixture(apis.slice(1)), file => assert.throws(() => inspectCompiledScript(file), /lacks expected/));
  for (const name of ['nsProcess', 'SpiderBanner', 'WinShell', 'taskkill', 'Stop-Process', 'TerminateProcess', 'RmShutdown', 'RmRestart']) {
    withFixture(fixture([...apis, name]), file => assert.throws(() => inspectCompiledScript(file), /Removed or terminating/));
  }
});

test('unknown, ambiguous, truncated or size-mismatched headers fail closed', () => {
  withFixture(Buffer.alloc(120), file => assert.throws(() => inspectCompiledScript(file), /Missing or ambiguous/));
  const normal = fixture(apis);
  const duplicate = Buffer.concat([normal, normal]);
  withFixture(duplicate, file => assert.throws(() => inspectCompiledScript(file), /Missing or ambiguous/));
  withFixture(normal.subarray(0, 100), file => assert.throws(() => inspectCompiledScript(file), /bounds/));
  const mismatched = Buffer.from(normal);
  mismatched.writeUInt32LE(mismatched.readUInt32LE(84) + 2, 84);
  withFixture(mismatched, file => assert.throws(() => inspectCompiledScript(file), /Unexpected NSIS header/));
});
