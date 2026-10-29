'use strict';

// This suite has no live option. It imports only the protocol adapter and a fake.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PkrgClient, PkrgError, PKRG } = require('../app/pkrg.js');
const { PkrgSimulator } = require('./fixtures/pkrg-simulator.cjs');

async function ready(options) {
  const transport = new PkrgSimulator(options);
  const client = new PkrgClient(transport);
  assert.equal((await client.discover()).supported, true);
  transport.requests.length = 0;
  return { client, transport };
}
const rgb = (count, color = [1, 128, 255]) => Array.from({ length: count }, () => [...color]);
const code = (expected) => (error) => error instanceof PkrgError && error.code === expected;

test('construction and import are inert; every operation requires discovery', async () => {
  const transport = new PkrgSimulator();
  const client = new PkrgClient(transport);
  assert.equal(transport.requests.length, 0);
  assert.equal(client.compatible, false);
  await assert.rejects(client.getMode(), code('NOT_DISCOVERED'));
  await assert.rejects(client.setMode(1), code('NOT_DISCOVERED'));
  await assert.rejects(client.writeRange(0, rgb(1)), code('NOT_DISCOVERED'));
  assert.equal(transport.requests.length, 0);
  assert.throws(() => new PkrgClient({}), TypeError);
});

test('discovery sends one zero-padded GET and exposes exact v2 capabilities', async () => {
  const transport = new PkrgSimulator({ mode: 1 });
  const client = new PkrgClient(transport);
  assert.deepEqual(await client.discover(), {
    supported: true, protocolVersion: 2, ledCount: 92, chunkLimit: 8,
    enabled: 1, fragmentCapacity: 9, fragmentCount: 11,
  });
  assert.deepEqual(transport.requests, [[8, 127, 0, ...Array(29).fill(0)]]);
  assert.equal(client.compatible, true);
});

test('stock echo and unsupported capability status fail closed without any SET', async () => {
  for (const explicitStatus of [false, true]) {
    const transport = new PkrgSimulator({ supported: false });
    if (explicitStatus) transport.mutateReply = (_, reply) => { reply[3] = 1; return reply; };
    const client = new PkrgClient(transport);
    assert.equal((await client.discover()).supported, false);
    await assert.rejects(client.setMode(1), code('NOT_DISCOVERED'));
    await assert.rejects(client.writeFrame(rgb(92)), code('NOT_DISCOVERED'));
    assert.equal(transport.requests.length, 1);
    assert.equal(transport.requests[0][0], 8);
  }
});

test('every signature, version, count, and chunk/stream metadata byte is required', async () => {
  for (const field of [4, 5, 6, 7, 8, 9, 10, 12, 13]) {
    const transport = new PkrgSimulator();
    transport.mutateReply = (_, reply) => { reply[field] ^= 1; return reply; };
    const client = new PkrgClient(transport);
    assert.equal((await client.discover()).supported, false, `byte ${field}`);
    await assert.rejects(client.writeRange(0, rgb(1)), code('NOT_DISCOVERED'));
    assert.equal(transport.requests.length, 1);
  }
});

test('invalid enable flags and unknown reserved capability metadata are rejected', async () => {
  for (const field of [11, 14, 31]) {
    const transport = new PkrgSimulator();
    transport.mutateReply = (_, reply) => { reply[field] = 2; return reply; };
    const client = new PkrgClient(transport);
    await assert.rejects(client.discover(), code('CAPABILITIES'));
    assert.equal(client.compatible, false);
  }
});

test('reply length, byte types, and all three echoed fields are validated', async () => {
  const cases = [
    [() => null, 'REPLY_LENGTH'], [(_, r) => r.slice(0, 31), 'REPLY_LENGTH'],
    [(_, r) => [0, ...r], 'REPLY_LENGTH'], [(_, r) => r.join(','), 'REPLY_LENGTH'],
    [(_, r) => { r[25] = NaN; return r; }, 'REPLY_BYTES'],
    [(_, r) => { r[25] = 256; return r; }, 'REPLY_BYTES'],
    [(_, r) => { r[25] = true; return r; }, 'REPLY_BYTES'],
    ...[0, 1, 2].map((i) => [(_, r) => { r[i] ^= 1; return r; }, 'REPLY_ECHO']),
  ];
  for (const [mutate, expected] of cases) {
    const { client, transport } = await ready();
    transport.mutateReply = mutate;
    await assert.rejects(client.getMode(), code(expected));
    assert.equal(client.compatible, false);
    await assert.rejects(client.setMode(1), code('NOT_DISCOVERED'));
    assert.equal(transport.requests.length, 1);
  }
});

test('Buffer and Uint8Array replies are accepted without HID report IDs', async () => {
  for (const wrap of [Buffer.from, (r) => new Uint8Array(r)]) {
    const { client, transport } = await ready();
    transport.mutateReply = (_, reply) => wrap(reply);
    assert.equal(await client.getMode(), 0);
  }
});

test('mode SET requires matching ACK and separate GET readback', async () => {
  const { client, transport } = await ready();
  assert.equal(await client.setMode(1), 1);
  assert.deepEqual(transport.requests.map((r) => r.slice(0, 5)), [[7, 127, 1, 0, 1], [8, 127, 1, 0, 0]]);
  assert.equal(await client.setMode(0), 0);
});

test('mode ACK/readback mismatches and invalid flags invalidate discovery', async () => {
  for (const [command, value, expected] of [[7, 0, 'MODE_ACK'], [8, 0, 'VERIFY_MODE'], [8, 2, 'MODE']]) {
    const { client, transport } = await ready();
    transport.mutateReply = (request, reply) => { if (request[0] === command) reply[4] = value; return reply; };
    await assert.rejects(client.setMode(1), (e) => code(expected)(e) && e.mayHaveChanged);
    assert.equal(client.compatible, false);
  }
});

test('one-key and upper-bound writes preserve surrounding LEDs and verify RGB', async () => {
  for (const start of [0, 91]) {
    const { client, transport } = await ready();
    const before = structuredClone(transport.colors);
    const result = await client.writeRange(start, [[0, 255, 17]]);
    before[start] = [0, 255, 17];
    assert.deepEqual(transport.colors, before);
    assert.deepEqual(result, { start, count: 1, verified: true, atomic: false });
    assert.deepEqual(transport.requests.map((r) => r.slice(0, 6)), [[7, 127, 2, 0, start, 1], [8, 127, 2, 0, start, 1]]);
  }
});

test('full-frame upload uses twelve acknowledged chunks and twelve verification GETs', async () => {
  const { client, transport } = await ready();
  const colors = Array.from({ length: 92 }, (_, i) => [255 - i, i, i % 2 ? 0 : 255]);
  assert.equal((await client.writeFrame(colors)).atomic, false);
  assert.deepEqual(transport.colors, colors);
  assert.equal(transport.requests.length, 24);
  transport.requests.forEach((request, i) => {
    assert.deepEqual(request.slice(0, 6), [i % 2 ? 8 : 7, 127, 2, 0, Math.floor(i / 2) * 8, i >= 22 ? 4 : 8]);
    assert.equal(request.length, 32);
  });
  assert.deepEqual(await client.readFrame(), colors);
});

test('range reads split at eight LEDs and return independent RGB arrays', async () => {
  const { client, transport } = await ready();
  const read = await client.readRange(7, 17);
  assert.deepEqual(read, transport.colors.slice(7, 24));
  assert.deepEqual(transport.requests.map((r) => r.slice(4, 6)), [[7, 8], [15, 8], [23, 1]]);
  read[0][0] = 255;
  assert.equal(transport.colors[7][0], 7);
});

test('RGB ACK, RGB readback, and range mismatches stop further writes', async () => {
  for (const [command, field, expected] of [[7, 6, 'RGB_ACK'], [8, 6, 'VERIFY_RGB'], [7, 4, 'RANGE_ECHO'], [8, 5, 'RANGE_ECHO']]) {
    const { client, transport } = await ready();
    transport.mutateReply = (request, reply) => { if (request[0] === command) reply[field] ^= 1; return reply; };
    await assert.rejects(client.writeRange(0, rgb(16)), (e) => code(expected)(e) && e.verifiedCount === 0 && e.mayHaveChanged);
    assert.equal(transport.requests.filter((r) => r[0] === 7).length, 1);
    assert.equal(client.compatible, false);
  }
});

test('all device error statuses, including busy and unknown, stop with no retry', async () => {
  for (const status of [1, 2, 3, 4, 5, 255]) {
    const { client, transport } = await ready();
    transport.mutateReply = (_, reply) => { reply[3] = status; return reply; };
    await assert.rejects(client.writeFrame(rgb(92)), (e) => code('DEVICE_STATUS')(e) && e.status === status);
    assert.equal(transport.requests.length, 1);
    assert.equal(client.compatible, false);
  }
});

test('partial failure reports verified prefix and does not silently roll back', async () => {
  const { client, transport } = await ready();
  transport.beforeRequest = (request) => { if (request[0] === 7 && request[4] === 8) throw new Error('disconnected'); };
  await assert.rejects(client.writeFrame(rgb(92)), (e) => code('TRANSPORT')(e) && e.verifiedCount === 8 && e.count === 92 && e.mayHaveChanged);
  assert.equal(transport.requests.length, 3);
  assert.deepEqual(transport.colors.slice(0, 8), rgb(8));
  await assert.rejects(client.writeRange(1, rgb(1)), code('NOT_DISCOVERED'));
});

test('all input validation happens before any request, including late invalid colors', async () => {
  const { client, transport } = await ready();
  for (const mode of [false, true, '1', 2, -1, 0.5, null, NaN]) await assert.rejects(client.setMode(mode), RangeError);
  for (const [start, count] of [[-1, 1], [92, 1], [90, 3], [0, 0], [0, 93], ['0', 1], [0, NaN], [1.5, 1]]) {
    await assert.rejects(client.readRange(start, count), RangeError);
  }
  for (const value of [-1, 256, 1.2, NaN, Infinity, '3', true, null, undefined]) {
    const colors = rgb(92); colors[91][2] = value;
    await assert.rejects(client.writeFrame(colors), TypeError);
  }
  for (const colors of [null, {}, [[1, 2]], [[1, 2, 3, 4]], Array(92), [Array(3)]]) {
    await assert.rejects(client.writeRange(0, colors), TypeError);
  }
  for (const count of [0, 91, 93]) await assert.rejects(client.writeFrame(rgb(count)), RangeError);
  await assert.rejects(client.writeRange(91, rgb(2)), RangeError);
  assert.equal(transport.requests.length, 0);
  assert.equal(client.compatible, true);
});

test('queued writes use an immutable snapshot of caller input', async () => {
  const { client, transport } = await ready();
  const colors = rgb(9);
  const operation = client.writeRange(0, colors);
  colors[0][0] = 250; colors[8] = [0, 0, 0]; colors.push([9, 9, 9]);
  await operation;
  assert.deepEqual(transport.colors.slice(0, 9), rgb(9));
});

test('complete operations are serialized across two clients sharing a transport', async () => {
  const { client, transport } = await ready();
  const other = new PkrgClient(transport);
  await other.discover(); transport.requests.length = 0;
  await Promise.all([client.writeRange(0, rgb(16)), other.writeRange(32, rgb(16, [4, 5, 6])), client.getMode()]);
  assert.deepEqual(transport.requests.map((r) => [r[0], r[2], r[4]]), [
    [7, 2, 0], [8, 2, 0], [7, 2, 8], [8, 2, 8],
    [7, 2, 32], [8, 2, 32], [7, 2, 40], [8, 2, 40], [8, 1, 0],
  ]);
  assert.equal(transport.maxInFlight, 1);
});

test('a failed operation prevents already queued mutations until fresh discovery', async () => {
  const { client, transport } = await ready();
  transport.beforeRequest = () => { throw new Error('timeout'); };
  const results = await Promise.allSettled([client.getMode(), client.writeRange(0, rgb(1))]);
  assert.equal(results[0].reason.code, 'TRANSPORT');
  assert.equal(results[1].reason.code, 'NOT_DISCOVERED');
  assert.equal(transport.requests.length, 1);
  transport.beforeRequest = null;
  await client.discover();
  await client.writeRange(0, rgb(1));
});

test('open, close, and error events invalidate discovery for every shared client', async () => {
  for (const event of ['open', 'close', 'error']) {
    const { client, transport } = await ready();
    const other = new PkrgClient(transport); await other.discover(); transport.requests.length = 0;
    transport.emit(event, new Error('test lifecycle'));
    assert.equal(client.compatible, false); assert.equal(other.compatible, false);
    await assert.rejects(client.setMode(1), code('NOT_DISCOVERED'));
    await assert.rejects(other.getMode(), code('NOT_DISCOVERED'));
    assert.equal(transport.requests.length, 0);
  }
});

test('disconnect during a reply rejects that reply and aborts remaining chunks', async () => {
  const { client, transport } = await ready();
  transport.mutateReply = (_, reply) => { transport.emit('close'); return reply; };
  await assert.rejects(client.writeFrame(rgb(92)), code('INVALIDATED'));
  assert.equal(transport.requests.length, 1);
  assert.equal(client.compatible, false);
});

test('request-only transports support explicit invalidation and fresh discovery', async () => {
  const simulator = new PkrgSimulator();
  const transport = { request: (bytes) => simulator.request(bytes) };
  const client = new PkrgClient(transport);
  await client.discover(); client.invalidate('reconnect');
  await assert.rejects(client.setMode(1), code('NOT_DISCOVERED'));
  await client.discover(); assert.equal(await client.setMode(1), 1);
});

test('rediscovery on stock invalidates prior authorization on shared clients', async () => {
  const { client, transport } = await ready();
  const other = new PkrgClient(transport); await other.discover();
  transport.supported = false;
  assert.equal((await client.discover()).supported, false);
  assert.equal(other.compatible, false);
});

test('dispose removes listeners, leaves transport owned by caller, and prevents requests', async () => {
  const { client, transport } = await ready();
  let closed = false; transport.close = () => { closed = true; };
  assert.equal(transport.listenerCount('close'), 1);
  client.dispose(); client.dispose();
  assert.equal(closed, false);
  assert.equal(transport.listenerCount('close'), 0);
  await assert.rejects(client.discover(), code('DISPOSED'));
  await assert.rejects(client.writeRange(0, rgb(1)), code('DISPOSED'));
  assert.equal(transport.requests.length, 0);
});

test('public protocol constants expose no streaming, SAVE, or flash operation', () => {
  assert.equal(PKRG.LED_COUNT, 92);
  assert.equal(PKRG.CHUNK_LIMIT, 8);
  assert.equal(Object.isFrozen(PKRG), true);
  assert.equal(PKRG.COMMIT, undefined);
  assert.equal(PKRG.SAVE, undefined);
});
