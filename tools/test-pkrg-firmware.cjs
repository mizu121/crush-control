// App protocol -> generated RV32 patch at explicit OEM continuation boundaries.
// Stock is optional; no claim of native hue, brightness derivation, physical USB or hardware validation.
'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const readline = require('node:readline');
const { test } = require('node:test');
const { PkrgClient } = require('../app/pkrg');

const stock = process.env.CRUSH80_STOCK_FIRMWARE;


async function emulator() {
  const windows = process.platform === 'win32';
  const command = process.env.PKRG_PYTHON || path.join(__dirname, 'firmware-validation/.venv', windows ? 'Scripts/python.exe' : 'bin/python');
  const args = [path.join(__dirname, 'pkrg-emulator-bridge.py')];
  if (stock) args.push(stock);
  const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const sent = [];
  let serial = 0;
  let stderr = '';
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const readyTimer = setTimeout(() => rejectReady(new Error('Emulator startup timed out')), 15000);
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
  const lines = readline.createInterface({ input: child.stdout });
  const fail = error => {
    rejectReady(error);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', (code, signal) => fail(new Error(`Emulator exited (${code ?? signal}): ${stderr}`)));
  lines.on('line', line => {
    let response;
    try { response = JSON.parse(line); } catch { fail(new Error(`Unexpected emulator output: ${line}`)); return; }
    if (response.ready) { resolveReady(); return; }
    const item = pending.get(response.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(response.id);
    if (response.error) item.reject(new Error(response.error));
    else item.resolve(response.result);
  });
  try { await ready; } catch (error) { child.kill(); throw error; } finally { clearTimeout(readyTimer); }

  function call(op, data = {}) {
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Emulator operation ${op} timed out`));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, op, ...data }) + '\n', error => {
        if (!error) return;
        clearTimeout(timer); pending.delete(id); reject(error);
      });
    });
  }
  return {
    sent,
    async request(packet) { sent.push([...packet]); return call('request', { packet: [...packet] }); },
    frame(multiplier, native) { return call('frame', { multiplier, native }); },
    rearSource(rgb) { return call('rear_source', { rgb }); },
    async close() {
      if (child.exitCode !== null) return;
      const exit = once(child, 'exit');
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 2000);
      try { await exit; } finally { clearTimeout(timer); lines.close(); }
    },
  };
}


test('actual patch discovers capabilities; unsupported native dispatch fails explicitly', async () => {
  const transport = await emulator();
  const client = new PkrgClient(transport);
  try {
    assert.equal((await client.discover()).supported, true);
    const native = Array(32).fill(0); native[0] = 7; native[1] = 3;
    await assert.rejects(transport.request(native), /channel127 PKRG/);
    await assert.rejects(transport.frame(256), /requires explicit native RGB fixture/);
  } finally { client.dispose(); await transport.close(); }
});

test('app chunk writes all 92 colors and generated store hook scales explicit fixtures', async () => {
  const transport = await emulator();
  const client = new PkrgClient(transport);
  try {
    assert.equal((await client.discover()).supported, true);
    assert.equal(await client.getMode(), 0);
    const colors = Array.from({ length: 92 }, (_, i) => [(i * 31) % 256, (255 - i * 11) & 255, (i * 73 + 17) % 256]);
    await client.writeFrame(colors);
    assert.deepEqual(await client.readFrame(), colors);
    await client.setMode(1);
    assert.equal(await client.getMode(), 1);
    for (const scale of [0, 1, 21, 84, 192, 256]) {
      assert.deepEqual(await transport.frame(scale), colors.flat().map(value => (value * scale) >> 8));
    }
    await client.setMode(0);
    const nativeFixture = Array.from({ length: 276 }, (_, i) => i % 256);
    assert.deepEqual(await transport.frame(192, nativeFixture), nativeFixture);
    assert.deepEqual(await client.readFrame(), colors);
  } finally { client.dispose(); await transport.close(); }
});

test('partial edits preserve other slots; generated rear source selector leaves frame intact', async () => {
  const transport = await emulator();
  const client = new PkrgClient(transport);
  try {
    assert.equal((await client.discover()).supported, true);
    const colors = Array.from({ length: 92 }, () => [0, 0, 0]);
    await client.writeFrame(colors);
    await client.setMode(1);
    await client.writeRange(0, [[255, 0, 0], [0, 255, 0]]);
    await client.writeRange(91, [[0, 0, 255]]);
    colors[0] = [255, 0, 0]; colors[1] = [0, 255, 0]; colors[91] = [0, 0, 255];
    assert.deepEqual(await client.readFrame(), colors);
    assert.deepEqual(await transport.frame(256), colors.flat());
    const rear = await transport.rearSource([29, 147, 251]);
    assert.deepEqual(rear.rgb, [29, 147, 251]);
    assert.deepEqual(await transport.frame(256), colors.flat());
  } finally { client.dispose(); await transport.close(); }
});
