'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const Module = require('node:module');
const { ViaDevice, validateReceiverRequest } = require('../app/via.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const desc = (connection, name = connection) => ({ vendorId: 0x320f, productId: connection === 'usb' ? 0x5055 : 0x5088, interface: 1, usagePage: 0xff60, usage: 0x61, path: `PRIVATE-${name}`, product: 'Crush', serialNumber: 'SECRET' });
const reply = bytes => { const result = Array(32).fill(0); bytes.forEach((v, i) => { result[i] = v; }); return Buffer.from(result); };
class Handle extends EventEmitter {
  constructor({ auto = false, close, write } = {}) { super(); this.writes = []; this.closes = 0; this.auto = auto; this.closeHook = close; this.writeHook = write; }
  async write(report) {
    this.writes.push([...report]);
    if (this.writeHook) return this.writeHook(report, this);
    if (this.auto) queueMicrotask(() => this.emit('data', Buffer.from(report.slice(1))));
    return 33;
  }
  async close() { this.closes++; if (this.closeHook) return this.closeHook(); }
}
function fixture(devices = [desc('receiver')], handles = [new Handle()]) {
  const trace = { devices, opened: [], identityOpens: 0 };
  const hid = {
    devices: () => trace.devices,
    HID: class { constructor() { trace.identityOpens++; throw Error('Identity constructor must not be reached'); } },
    HIDAsync: { open: async path => { trace.opened.push(path); return handles.shift(); } },
  };
  return { hid, trace, via: new ViaDevice({ hid, timeoutMs: 60 }) };
}

test('module import does not load native HID', () => {
  const original = Module._load;
  delete require.cache[require.resolve('../app/via.js')];
  Module._load = function (name, ...rest) { assert.notEqual(name, 'node-hid'); return original.call(this, name, ...rest); };
  try { require('../app/via.js'); } finally { Module._load = original; }
});

test('discovery prefers unique wired, blocks ambiguous wired and ignores other interfaces/Bluetooth', () => {
  const x = fixture([desc('receiver'), desc('usb')]);
  assert.equal(x.via.find().connection, 'usb');
  assert.equal(x.via.listCandidates().receiver.length, 1);
  x.trace.devices.push(desc('usb', 'second'));
  assert.equal(x.via.find(), null, 'Never fall through ambiguous wired devices');
  x.trace.devices = [desc('receiver'), { ...desc('usb'), path: undefined }];
  assert.equal(x.via.find(), null);
  x.trace.devices = [desc('receiver'), { ...desc('receiver', 'ota'), interface: 2, usagePage: 0xffef }, { vendorId: 0x245a, productId: 0x8276, interface: -1, usagePage: 1, usage: 6, path: 'BLE' }];
  assert.equal(x.via.find().connection, 'receiver');
  assert.equal(x.via.listCandidates().receiver.length, 1);
  x.trace.devices.push(desc('receiver', 'second'));
  assert.equal(x.via.find(), null);
});

test('candidate paths are internal, metadata exposes hash only, and open pins fresh enumerated path', async () => {
  const x = fixture();
  const selected = x.via.find();
  assert.equal(selected.path, 'PRIVATE-receiver');
  assert.equal(selected.pathHash, createHash('sha256').update(selected.path).digest('hex'));
  assert.doesNotMatch(JSON.stringify(selected), /PRIVATE|SECRET|serialNumber/);
  let emitted;
  x.via.on('open', metadata => { emitted = metadata; });
  assert.equal(await x.via.open({ ...selected, path: 'FORGED-FFEF-PATH' }), true);
  assert.deepEqual(x.trace.opened, ['PRIVATE-receiver']);
  assert.equal(x.via.connection, 'receiver');
  assert.equal(x.via.matches(selected), true);
  assert.equal(x.via.descriptor.path, undefined);
  assert.doesNotMatch(JSON.stringify(emitted), /PRIVATE|SECRET|serialNumber/);
  await x.via.close();
});

test('receiver identity is rejected before accessing any updater handle', async () => {
  const x = fixture([desc('receiver'), { ...desc('receiver', 'update'), interface: 2, usagePage: 0xffef }]);
  assert.throws(() => ViaDevice.identity(undefined, x.hid), /wired/);
  assert.throws(() => x.via.identity(x.via.find()), /wired/);
  await x.via.open();
  assert.throws(() => x.via.identity(), /prohibited/);
  assert.equal(x.trace.identityOpens, 0);
  await x.via.close();
});

test('receiver packet allowlist accepts only bounded lighting and basic GET operations', async () => {
  const handle = new Handle({ auto: true }), x = fixture(undefined, [handle]);
  await x.via.open();
  const allowed = [[1], [12], [17], [8, 3, 1], [8, 3, 4], [7, 3, 1, 9], [7, 3, 2, 18], [7, 3, 3, 4], [7, 3, 4, 0, 255], [8, 127, 0], [8, 127, 1], [7, 127, 1, 0, 1], [8, 127, 2, 0, 88, 4], [7, 127, 2, 0, 91, 1, 1, 2, 3]];
  for (const bytes of allowed) await x.via.request(bytes);
  const count = handle.writes.length;
  const denied = [[9, 3], [5, 0, 0, 0, 4], [18, 0, 0, 28], [10], [11], [13], [1, 1], [7, 3, 5, 0], [8, 4, 1], [7, 3, 1, 10], [7, 3, 2, 19], [7, 3, 3, 5], [7, 3, 4, 5], [7, 3, 1, 1, 1], [8, 127], [7, 127, 0], [7, 127, 3], [7, 127, 4], [7, 127, 1, 1, 1], [7, 127, 1, 0, 2], [7, 127, 1, 0], [8, 127, 2, 0, 91, 2], [8, 127, 2, 0, 0, 9], [7, 127, 2, 0, 0, 1], [8, 127, 2, 0, 0, 1, 1]];
  for (const bytes of denied) await assert.rejects(x.via.request(bytes), undefined, JSON.stringify(bytes));
  assert.equal(handle.writes.length, count);
  assert.throws(() => validateReceiverRequest(Array(4)), /Invalid/);
  await x.via.close();
});

test('switching selection invalidates queued work and waits for old asynchronous close before opening new handle', async () => {
  let finishClose;
  const old = new Handle({ close: () => new Promise(resolve => { finishClose = resolve; }) }), next = new Handle();
  const x = fixture(undefined, [old, next]);
  await x.via.open();
  const first = x.via.request([8, 3, 1]), queued = x.via.request([8, 3, 2]);
  const firstRejected = assert.rejects(first, /disconnected/), queuedRejected = assert.rejects(queued, /stale request/);
  await tick();
  x.trace.devices.push(desc('usb'));
  const switching = x.via.open(x.via.find());
  await tick();
  assert.equal(x.trace.opened.length, 1);
  assert.equal(x.via.connected, false);
  finishClose();
  assert.equal(await switching, true);
  await firstRejected; await queuedRejected;
  assert.equal(x.via.connection, 'usb');
  assert.equal(old.writes.length, 1);
  await x.via.close();
});

test('timeout quarantines the handle, rejects queued work and ignores late old data/errors after reconnect', async () => {
  const old = new Handle(), next = new Handle();
  const x = fixture(undefined, [old, next]);
  await x.via.open();
  const first = x.via.request([8, 3, 1]), second = x.via.request([8, 3, 2]);
  await Promise.all([assert.rejects(first, /quarantined/), assert.rejects(second, /stale request/)]);
  await x.via.closedPromise;
  assert.equal(old.closes, 1); assert.equal(old.writes.length, 1); assert.equal(x.via.connected, false);
  await x.via.open();
  const current = x.via.request([8, 3, 1]);
  await tick();
  old.emit('data', reply([8, 3, 1, 2])); old.emit('error', Error('stale'));
  assert.equal(x.via.dev, next); assert.ok(x.via.pending);
  next.emit('data', reply([8, 3, 1, 7]));
  assert.equal((await current)[3], 7);
  await x.via.close();
});

test('malformed input, I/O error and incomplete output all quarantine and close', async () => {
  for (const kind of ['malformed', 'error', 'partial', 'write-reject']) {
    const handle = new Handle({ write: kind === 'partial' ? async () => 32 : kind === 'write-reject' ? async () => { throw Error('native path'); } : undefined });
    const x = fixture(undefined, [handle]);
    await x.via.open();
    const pending = x.via.request([8, 3, 1]);
    const rejected = assert.rejects(pending);
    await tick();
    if (kind === 'malformed') handle.emit('data', Buffer.from([8, 3, 1]));
    if (kind === 'error') handle.emit('error', Error('native path'));
    await rejected; await x.via.closedPromise;
    assert.equal(x.via.connected, false); assert.equal(handle.closes, 1);
  }
});

test('a reply cannot resolve a request before its complete output write is verified', async () => {
  let finishWrite;
  const handle = new Handle({ write: (_report, device) => {
    device.emit('data', reply([8, 3, 1, 7]));
    return new Promise(resolve => { finishWrite = resolve; });
  } });
  const x = fixture(undefined, [handle]);
  await x.via.open();
  let resolved = false;
  const pending = x.via.request([8, 3, 1]).then(value => { resolved = true; return value; });
  const rejected = assert.rejects(pending, /Incomplete/);
  await tick(); assert.equal(resolved, false);
  finishWrite(32);
  await rejected; await x.via.closedPromise;
  assert.equal(handle.closes, 1);
});

test('outstanding open is cancelled on close and its returned handle retires before another open', async () => {
  const x = fixture();
  let finishOpen;
  x.hid.HIDAsync.open = () => new Promise(resolve => { finishOpen = resolve; });
  const opening = x.via.open();
  const closing = x.via.close();
  const canceled = new Handle();
  finishOpen(canceled);
  assert.equal(await opening, false); await closing;
  assert.equal(canceled.closes, 1); assert.equal(x.via.connected, false);
  x.hid.HIDAsync.open = async () => new Handle();
  assert.equal(await x.via.open(), true);
  await x.via.close();
});

test('selection changing during asynchronous open retires obsolete handle without announcing it', async () => {
  const x = fixture(); let finishOpen, opens = 0;
  x.via.on('open', () => { opens++; });
  x.hid.HIDAsync.open = () => new Promise(resolve => { finishOpen = resolve; });
  const opening = x.via.open();
  x.trace.devices.push(desc('usb'));
  const stale = new Handle(); finishOpen(stale);
  assert.equal(await opening, false); assert.equal(stale.closes, 1); assert.equal(opens, 0);
});

test('failed handle close blocks a second active handle and request input arrays are snapshotted', async () => {
  const handle = new Handle({ close: async () => { throw Error('close failed'); } });
  const x = fixture(undefined, [handle]);
  await x.via.open();
  const bytes = [8, 3, 1], pending = x.via.request(bytes); bytes[2] = 4;
  await tick(); assert.equal(handle.writes[0][3], 1);
  handle.emit('data', reply([8, 3, 1, 7])); await pending;
  await x.via.close();
  await assert.rejects(x.via.open(), /could not be closed/);
  assert.equal(x.trace.opened.length, 1);
});
