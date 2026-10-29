'use strict';
// One selected VIA interface, one outstanding request. Uncertain I/O retires the
// handle and invalidates its queue, preventing late replies from being reused.
const { EventEmitter } = require('events');
const { createHash } = require('node:crypto');
const { queryFirmwareIdentity } = require('./firmware-identity');
const VID = 0x320f, PID = 0x5055, RECEIVER_PID = 0x5088;
const REPORT_SIZE = 32, TIMEOUT_MS = 700;
const CMD = Object.freeze({ PROTOCOL_VERSION: 1, KEYMAP_SET_KEYCODE: 5, CUSTOM_SET: 7, CUSTOM_GET: 8, CUSTOM_SAVE: 9, MACRO_COUNT: 12, LAYER_COUNT: 17, KEYMAP_GET_BUFFER: 18 });
const ALLOWED = new Set(Object.values(CMD));
const ECHO_LEN = { 1: 1, 12: 1, 17: 1, 5: 4, 18: 4, 9: 2 };
const defaultHid = () => require('node-hid');

function candidate(device) {
  if (device?.vendorId !== VID || ![PID, RECEIVER_PID].includes(device.productId) || device.interface !== 1 || device.usagePage !== 0xff60 || device.usage !== 0x61) return null;
  const internalPath = typeof device.path === 'string' && device.path.length > 0 && device.path.length <= 32768 ? device.path : null;
  const info = {
    connection: device.productId === PID ? 'usb' : 'receiver',
    pathHash: internalPath ? createHash('sha256').update(internalPath, 'utf8').digest('hex') : null,
    vendorId: VID, productId: device.productId, interface: 1, usagePage: 0xff60, usage: 0x61,
    product: typeof device.product === 'string' ? device.product.slice(0, 512) : null,
    manufacturer: typeof device.manufacturer === 'string' ? device.manufacturer.slice(0, 512) : null,
  };
  // Internal open credential, omitted by JSON/stringify/object spread/status.
  Object.defineProperty(info, 'path', { value: internalPath, enumerable: false });
  return Object.freeze(info);
}
function sameCandidate(a, b) { return Boolean(a && b && a.pathHash && a.pathHash === b.pathHash && a.connection === b.connection); }
function commandBytes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > REPORT_SIZE) throw new Error('Invalid VIA command bytes');
  const bytes = Array.from(value);
  if (bytes.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error('Invalid VIA command bytes');
  if (!ALLOWED.has(bytes[0])) throw new Error(`command 0x${bytes[0].toString(16)} is not allowed`);
  return bytes;
}
function validateReceiverRequest(bytes) {
  bytes = commandBytes(bytes);
  const p = Array(REPORT_SIZE).fill(0); bytes.forEach((v, i) => { p[i] = v; });
  const [command, channel, operation] = p;
  const zeros = start => p.slice(start).every(v => v === 0);
  if ([CMD.PROTOCOL_VERSION, CMD.LAYER_COUNT, CMD.MACRO_COUNT].includes(command) && zeros(1)) return;
  if (![CMD.CUSTOM_GET, CMD.CUSTOM_SET].includes(command)) throw new Error('Receiver permits lighting and basic capability requests only');
  if (bytes.length < 3) throw new Error('Receiver lighting requests require channel and operation bytes');
  const set = command === CMD.CUSTOM_SET;
  if (channel === 3 && operation >= 1 && operation <= 4) {
    if (!set && zeros(3)) return;
    const length = operation === 4 ? 2 : 1;
    const limit = { 1: 9, 2: 18, 3: 4, 4: 255 }[operation];
    if (set && bytes.length >= 3 + length && p[3] <= limit && zeros(3 + length)) return;
    throw new Error('Invalid receiver native lighting request');
  }
  if (channel !== 127 || operation > 2 || p[3] !== 0) throw new Error('Receiver PKRG operations are limited to configuration 0, 1 and 2');
  if (operation === 0 && !set && zeros(3)) return;
  if (operation === 1 && ((!set && zeros(3)) || (set && bytes.length >= 5 && p[4] <= 1 && zeros(5)))) return;
  if (operation === 2 && p[5] >= 1 && p[5] <= 8 && p[4] + p[5] <= 92 && bytes.length >= (set ? 6 + p[5] * 3 : 6) && zeros(set ? 6 + p[5] * 3 : 6)) return;
  throw new Error('Invalid receiver PKRG request');
}

class ViaDevice extends EventEmitter {
  constructor({ hid = defaultHid(), timeoutMs = TIMEOUT_MS } = {}) {
    super();
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new TypeError('VIA timeout must be 1..3000 milliseconds');
    this.hid = hid; this.timeoutMs = timeoutMs;
    this.dev = null; this.pending = null; this.chain = Promise.resolve(); this.epoch = 0;
    this._descriptor = null; this._opening = null; this._closingCount = 0;
    this.closeFailure = null; this.closedPromise = Promise.resolve(true);
  }
  static listCandidates(hid = defaultHid()) {
    const devices = hid.devices();
    if (!Array.isArray(devices)) throw new Error('Invalid HID device inventory');
    const result = { usb: [], receiver: [] };
    for (const device of devices) { const info = candidate(device); if (info) result[info.connection].push(info); }
    return result;
  }
  static find(hid = defaultHid()) {
    const all = ViaDevice.listCandidates(hid);
    // Ambiguous/malformed wired candidates block fallback to the receiver.
    if (all.usb.length) return all.usb.length === 1 && all.usb[0].path ? all.usb[0] : null;
    return all.receiver.length === 1 && all.receiver[0].path ? all.receiver[0] : null;
  }
  static identity(info = undefined, hid = defaultHid()) {
    const selected = info === undefined ? ViaDevice.find(hid) : info;
    if (!selected || selected.connection !== 'usb' || !sameCandidate(selected, ViaDevice.find(hid))) throw new Error('Firmware identity queries require the uniquely selected wired keyboard');
    return queryFirmwareIdentity(hid);
  }
  listCandidates() { return ViaDevice.listCandidates(this.hid); }
  find() { return ViaDevice.find(this.hid); }
  identity(info) {
    if (this.connection === 'receiver') throw new Error('Firmware identity queries are prohibited on a receiver connection');
    return ViaDevice.identity(info, this.hid);
  }
  get connected() { return this.dev !== null; }
  get connection() { return this._descriptor?.connection || null; }
  get descriptor() { return this._descriptor ? { ...this._descriptor } : null; }
  matches(info) { return this.connected && sameCandidate(this._descriptor, info); }
  _retire(handle) {
    this._closingCount++;
    this.closedPromise = this.closedPromise.then(async () => {
      try { await handle.close(); return true; }
      catch { this.closeFailure = new Error('Previous VIA handle could not be closed; restart the application before reconnecting'); return false; }
      finally { this._closingCount--; }
    });
    return this.closedPromise;
  }
  async open(info = undefined) {
    const discovered = this.find();
    // Use the fresh enumerated path, never a caller-supplied open credential.
    const selected = info === undefined ? discovered : sameCandidate(info, discovered) ? discovered : null;
    if (this._opening) {
      const opening = this._opening;
      if (opening.epoch === this.epoch && sameCandidate(opening.info, selected)) return opening.promise;
      if (opening.epoch === this.epoch) this.close();
      await opening.promise.catch(() => false);
      return this.open(selected);
    }
    if (this.dev && !sameCandidate(this._descriptor, selected)) await this.close();
    if (this._closingCount) await this.closedPromise;
    if (this.closeFailure) throw this.closeFailure;
    if (!selected || !sameCandidate(selected, this.find())) { if (this.dev) await this.close(); return false; }
    if (this.matches(selected)) return true;
    const epoch = this.epoch;
    const opening = { epoch, info: selected, promise: null };
    this._opening = opening;
    opening.promise = (async () => {
      let opened;
      try { opened = await this.hid.HIDAsync.open(selected.path); }
      catch { throw new Error('Selected VIA interface could not be opened'); }
      let stillSelected = false;
      try { stillSelected = sameCandidate(selected, this.find()); } catch { /* Retire on failed inventory recheck. */ }
      if (epoch !== this.epoch || this.dev || !stillSelected) { await this._retire(opened); return false; }
      this.dev = opened; this._descriptor = selected;
      opened.on('data', buf => { if (this.dev === opened) this.onData(buf); });
      opened.on('error', () => { if (this.dev === opened) this.close(new Error('VIA device I/O failed')); });
      this.emit('open', this.descriptor);
      return true;
    })();
    try { return await opening.promise; }
    finally { if (this._opening === opening) this._opening = null; }
  }
  close(reason = new Error('device disconnected')) {
    this.epoch++;
    const handle = this.dev, opening = this._opening;
    this.dev = null; this._descriptor = null;
    const pending = this.pending; this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(reason); }
    if (handle) this._retire(handle);
    if (handle || pending || opening) this.emit('close');
    // Outstanding opens retire their own returned handle after invalidation.
    return opening?.promise ? opening.promise.catch(() => false).then(() => this.closedPromise) : this.closedPromise;
  }
  _complete(pending) {
    if (this.pending !== pending || !pending.writeVerified || !pending.reply) return;
    clearTimeout(pending.timer); this.pending = null; pending.resolve(pending.reply);
  }
  onData(buf) {
    const pending = this.pending;
    if (!pending) return;
    let reply;
    try { reply = Array.from(buf); } catch { this.close(new Error('Invalid VIA input report')); return; }
    if (reply.length !== REPORT_SIZE || reply.some(v => !Number.isInteger(v) || v < 0 || v > 255)) { this.close(new Error('Expected exactly 32 VIA reply bytes')); return; }
    for (let i = 0; i < pending.echoLen; i++) if (reply[i] !== pending.bytes[i]) return;
    pending.reply = reply; this._complete(pending);
  }
  request(value) {
    let bytes;
    try { bytes = commandBytes(value); if (this.connection === 'receiver') validateReceiverRequest(bytes); }
    catch (error) { return Promise.reject(error); }
    const epoch = this.epoch;
    const run = () => { if (epoch !== this.epoch) throw new Error('Keyboard connection changed; stale request discarded'); return this.send(bytes); };
    const result = this.chain.then(run, run); this.chain = result.catch(() => {}); return result;
  }
  send(value) {
    let bytes;
    try { bytes = commandBytes(value); if (this.connection === 'receiver') validateReceiverRequest(bytes); }
    catch (error) { return Promise.reject(error); }
    if (!this.dev) return Promise.reject(new Error('keyboard not connected'));
    if (this.pending) return Promise.reject(new Error('A VIA request is already in flight'));
    const handle = this.dev, epoch = this.epoch;
    return new Promise((resolve, reject) => {
      const pending = { bytes, echoLen: ECHO_LEN[bytes[0]] || 3, resolve, reject, timer: null, writeVerified: false, reply: null };
      pending.timer = setTimeout(() => { if (this.pending === pending) this.close(new Error(`no reply to command 0x${bytes[0].toString(16)}; VIA handle quarantined`)); }, this.timeoutMs);
      this.pending = pending;
      const out = Array(REPORT_SIZE + 1).fill(0); bytes.forEach((byte, index) => { out[index + 1] = byte; });
      Promise.resolve().then(() => {
        if (this.dev !== handle || epoch !== this.epoch) throw new Error('VIA connection changed before write');
        return handle.write(out);
      }).then(written => {
        if (this.dev !== handle || epoch !== this.epoch) return;
        if (written !== out.length) { this.close(new Error('Incomplete VIA output report; VIA handle quarantined')); return; }
        pending.writeVerified = true; this._complete(pending);
      }, () => { if (this.dev === handle && epoch === this.epoch) this.close(new Error('VIA output report failed; VIA handle quarantined')); });
    });
  }
}
module.exports = { ViaDevice, CMD, VID, PID, RECEIVER_PID, validateReceiverRequest };
