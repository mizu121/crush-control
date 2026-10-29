'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readBatteryStatus, normalizeBatteryReading, FRESHNESS_MS } = require('../app/battery');
const NOW = Date.parse('2026-10-28T18:30:00.000Z');
const valid = extra => ({ state: 'ok', percent: 61, updatedAt: '2026-10-28T18:29:00.000Z', connected: true, ...extra });

test('uses actual percent including zero and marks fresh only for recent connected Bluetooth cache', () => {
  for (const percent of [0, 1, 61, 100]) {
    assert.deepEqual(normalizeBatteryReading(valid({ percent }), NOW), {
      percent, charging: null, source: 'windows-bluetooth', updatedAt: '2026-10-28T18:29:00.000Z', stale: false,
    });
  }
  assert.equal(normalizeBatteryReading(valid({ updatedAt: new Date(NOW - FRESHNESS_MS).toISOString() }), NOW).stale, false);
  assert.equal(normalizeBatteryReading(valid({ updatedAt: new Date(NOW - FRESHNESS_MS - 1).toISOString() }), NOW).stale, true);
});

test('disconnected, unknown connection and stale timestamps retain only explicitly last-known battery', () => {
  for (const connected of [false, null, undefined, 'true', 1]) {
    const result = normalizeBatteryReading(valid({ connected }), NOW);
    assert.equal(result.percent, 61); assert.equal(result.stale, true); assert.equal(result.charging, null);
    assert.match(result.reason, /not confirmed active/);
  }
  const old = normalizeBatteryReading(valid({ updatedAt: '2026-10-28T18:08:18.796Z' }), NOW);
  assert.equal(old.percent, 61); assert.equal(old.stale, true); assert.match(old.reason, /five minutes/);
});

test('timestamp is not replaced with query time; malformed, calendar-invalid and future dates stay stale', () => {
  for (const updatedAt of [null, undefined, '', 123, 'yesterday', '2026-02-30T18:00:00.000Z',
    '2026-10-28T24:00:00.000Z', '2026-10-28T18:31:00.000Z', '2026-10-28T18:29:00',
    '2026-10-28T18:29:00.000Z private-data']) {
    const result = normalizeBatteryReading(valid({ updatedAt }), NOW);
    assert.equal(result.updatedAt, null); assert.equal(result.stale, true); assert.equal(result.percent, 61);
  }
  const invalidClock = normalizeBatteryReading(valid(), NaN);
  assert.equal(invalidClock.updatedAt, null); assert.equal(invalidClock.stale, true);
});

test('ambiguous, missing and invalid percentages never select a device or manufacture a number', () => {
  for (const record of [null, [], {}, { ...valid(), state: 'ambiguous' }, { state: 'missing' },
    ...[-1, 101, 255, 61.2, '61', null, undefined, NaN, Infinity].map(percent => valid({ percent }))]) {
    const result = normalizeBatteryReading(record, NOW);
    assert.equal(result.percent, null); assert.equal(result.source, 'unavailable');
    assert.equal(result.updatedAt, null); assert.equal(result.stale, true); assert.equal(result.charging, null);
  }
});

test('reader uses fixed scoped hidden PowerShell with bounded timeout/output and no caller-controlled script', async () => {
  let calls = 0;
  const result = await readBatteryStatus({ platform: 'win32', windowsRoot: 'C:\\Windows', now: () => NOW,
    execFile(command, args, options, callback) {
      calls++;
      assert.equal(command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
      const script = args[4];
      assert.match(script, /Get-PnpDevice -Class Bluetooth/);
      assert.match(script, /\^Crush \?80-\[1-3\]\$/);
      assert.match(script, /batteryDevices.Count -ne 1/);
      assert.match(script, /0x02000000/);
      assert.match(script, /0x00000008/);
      assert.doesNotMatch(script, /Set-Pnp|Enable-Pnp|Disable-Pnp|Remove-Pnp|Set-Item|New-Item|HID|SendReport|\{104EA319-6EE2-4701-BD47-8DDBF425BBE5\} 3/);
      assert.equal(options.windowsHide, true); assert.equal(options.timeout, 10000);
      assert.equal(options.maxBuffer, 8192); assert.equal(options.encoding, 'utf8');
      callback(null, JSON.stringify(valid()), '');
    },
  });
  assert.equal(calls, 1); assert.equal(result.percent, 61); assert.equal(result.stale, false);
});

test('process errors, invalid output and extra fields cannot leak identifiers or invent status', async () => {
  for (const [error, stdout] of [[new Error('private-path'), 'private-serial'], [null, 'not json private-path'],
    [null, 'x'.repeat(9000)], [null, JSON.stringify([{ state: 'ok' }])]]) {
    const result = await readBatteryStatus({ platform: 'win32', now: () => NOW,
      execFile(_command, _args, _options, callback) { callback(error, stdout); } });
    assert.equal(result.percent, null); assert.equal(result.stale, true);
    assert.doesNotMatch(JSON.stringify(result), /private|serial/);
  }
  const result = await readBatteryStatus({ platform: 'win32', now: () => NOW,
    execFile(_command, _args, _options, callback) { callback(null, JSON.stringify(valid({ serial: 'private', path: 'private', charging: true, reason: 'private' }))); } });
  assert.equal(result.percent, 61); assert.equal(result.charging, null);
  assert.doesNotMatch(JSON.stringify(result), /private|serial|path/);
});

test('unsupported platforms and synchronous executor failures return unknown without hardware access', async () => {
  let calls = 0;
  const linux = await readBatteryStatus({ platform: 'linux', execFile() { calls++; throw Error('Unexpected'); } });
  assert.equal(calls, 0); assert.equal(linux.percent, null);
  const rejected = await readBatteryStatus({ platform: 'win32', execFile() { throw Error('private-error'); } });
  assert.equal(rejected.percent, null); assert.equal(rejected.charging, null);
  assert.doesNotMatch(JSON.stringify(rejected), /private-error/);
});
