'use strict';
// The parent owns one VIA transport and serializes whole operations. This
// module is device-free: no discovery, firmware update, reset or SAVE commands.
const { PkrgClient } = require('./pkrg');
const { viaToDegrees } = require('./hue');
const { validLink } = require('./receiver-link');
const keymap = require('./rgb-keymap.json');
const COMBINED_CRC = 0x5566ddf2;
const STOCK_CRC = 0xa7da1601;
if (keymap.firmware.combinedCrc !== COMBINED_CRC) throw new Error('RGB keymap belongs to a different firmware.');
const MAPPED_KEYS = Object.freeze(keymap.keys.map(key => Object.freeze({ ...key,
  slots: Object.freeze([...key.slots]), matrix: Object.freeze(key.matrix.map(position => Object.freeze([...position]))),
})));
const VERIFIED_KEYS = Object.freeze(MAPPED_KEYS.filter(key => key.physicallyObserved));
const keysBySlot = new Map(MAPPED_KEYS.map(key => [key.slot, key]));
const copyKey = key => ({ ...key, slots: [...key.slots], matrix: key.matrix.map(position => [...position]) });

function hsvToRgb(degrees, saturation) {
  if (!Number.isFinite(degrees) || !Number.isFinite(saturation)) throw new TypeError('Invalid color');
  const h = ((degrees % 360) + 360) % 360 / 60;
  const s = Math.max(0, Math.min(255, saturation)) / 255;
  const x = s * (1 - Math.abs(h % 2 - 1)), m = 1 - s;
  const color = h < 1 ? [s, x, 0] : h < 2 ? [x, s, 0] : h < 3 ? [0, s, x]
    : h < 4 ? [0, x, s] : h < 5 ? [x, 0, s] : [s, 0, x];
  return color.map(value => Math.round((value + m) * 255));
}

function rgbValid(value) {
  return Array.isArray(value) && value.length === 3 && Array.from(value).every(x => Number.isInteger(x) && x >= 0 && x <= 255);
}

function validateKeyChanges(value) {
  if (!Array.isArray(value?.changes) || value.changes.length < 1 || value.changes.length > MAPPED_KEYS.length) {
    throw new RangeError('An RGB batch must contain between 1 and 88 key changes.');
  }
  const seen = new Set();
  // Array.from visits sparse entries. Validate every item before any caller
  // enters the operation queue or starts a hardware transaction.
  return Array.from(value.changes, change => {
    if (!change || !keysBySlot.has(change.slot)) throw new RangeError('This slot is not a mapped physical key target.');
    if (seen.has(change.slot)) throw new RangeError('Duplicate key target in RGB batch.');
    if (!rgbValid(change.rgb)) throw new TypeError('RGB must contain three integer values from 0 to 255.');
    seen.add(change.slot);
    return { slot: change.slot, rgb: [...change.rgb] };
  });
}

function validateRgbPreset(colors, lighting) {
  if (!Array.isArray(colors) || colors.length !== 92 || !Array.from(colors).every(rgbValid)) {
    throw new TypeError('A per-key preset must contain exactly 92 RGB colors.');
  }
  if (!lighting || lighting.effect !== 6) throw new RangeError('Per-key presets use the Solid effect.');
  for (const [field, minimum, maximum] of [['brightness', 0, 9], ['speed', 0, 4], ['hue', 1, 255], ['sat', 0, 255]]) {
    const value = lighting[field];
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new RangeError(`Invalid preset ${field}.`);
  }
  return { colors: colors.map(rgb => [...rgb]), lighting: {
    effect: 6, brightness: lighting.brightness, speed: lighting.speed, hue: lighting.hue, sat: lighting.sat,
  } };
}

class RgbController {
  constructor({ transport, getLighting, setLighting }) {
    this.client = new PkrgClient(transport);
    this.getLighting = getLighting;
    this.setNativeLighting = setLighting;
    this.identity = null;
    this.connection = 'usb';
    this.receiverLink = null;
    this.supported = false;
    this.enabled = false;
    this.hasFrame = false;
    this.reason = 'Per-key firmware has not been verified.';
    this.saved = null;
  }

  async initialize(identity) {
    this.identity = identity;
    if (identity?.crc !== COMBINED_CRC) {
      this.reason = identity ? 'This firmware uses whole-board lighting.' : 'Firmware identity unavailable; per-key controls are disabled.';
      return this.metadata();
    }
    const info = await this.client.discover();
    if (!info.supported) { this.reason = info.reason; return this.metadata(); }
    this.supported = true;
    this.enabled = Boolean(info.enabled);
    this.hasFrame = this.enabled;
    this.reason = null;
    return this.metadata();
  }

  async initializeReceiver(link, pathHash) {
    this.connection = 'receiver';
    this.identity = null;
    if (!validLink(link, pathHash)) {
      this.reason = 'Link this dongle to your verified Crush 80 Pro over USB first.';
      return this.metadata();
    }
    const info = await this.client.discover();
    if (!info.supported) { this.reason = info.reason; return this.metadata(); }
    this.receiverLink = { ...link };
    this.supported = true;
    this.enabled = Boolean(info.enabled);
    this.hasFrame = this.enabled;
    this.reason = null;
    return this.metadata();
  }

  metadata() {
    const supported = this.supported && this.client.compatible;
    return { supported, enabled: supported && this.enabled, rearFollowSupported: supported,
      mappedKeys: supported ? MAPPED_KEYS.map(copyKey) : [],
      verifiedKeys: supported ? VERIFIED_KEYS.map(copyKey) : [],
      mappingSource: supported ? 'stock-table-and-native-cpu-path' : null,
      volatile: true, firmwareCrc: this.identity?.crc ?? null, releaseRestoresRear: false,
      identityBasis: this.connection === 'receiver' ? 'linked-receiver' : 'usb-firmware-query',
      linkedFirmwareCrc: this.receiverLink?.keyboardCrc ?? null,
      canSaveLighting: this.identity?.crc === STOCK_CRC,
      reason: supported ? null : this.reason || 'Connection changed; reconnect to verify per-key firmware.' };
  }

  async status() {
    if (!this.metadata().supported) return { ...this.metadata(), colors: null };
    this.enabled = Boolean(await this.client.getMode());
    const colors = await this.client.readFrame();
    return { ...this.metadata(), colors };
  }

  requireSupport() {
    if (!this.metadata().supported) throw new Error(this.metadata().reason);
  }

  async capture() {
    this.requireSupport();
    if (!this.saved) this.saved = { lighting: await this.getLighting(), colors: await this.client.readFrame() };
  }

  async seedIfNeeded() {
    if (this.hasFrame) return;
    const lighting = await this.getLighting();
    const rgb = hsvToRgb(viaToDegrees(lighting.hue), lighting.sat);
    await this.client.writeFrame(Array.from({ length: 92 }, () => [...rgb]));
    this.hasFrame = true;
  }

  setKey(change) { return this.setKeys({ changes: [change] }); }

  async setKeys(value) {
    const changes = validateKeyChanges(value);
    this.requireSupport();
    await this.capture();
    await this.seedIfNeeded();
    // Expand grouped physical keys, then join only adjacent selected slots.
    // Gaps (including alternate slot 64) and rear/status zones are untouched.
    const slots = changes.flatMap(({ slot, rgb }) => keysBySlot.get(slot).slots.map(index => ({ index, rgb })))
      .sort((a, b) => a.index - b.index);
    const ranges = [];
    for (const { index, rgb } of slots) {
      const last = ranges.at(-1);
      if (last && index === last.start + last.colors.length) last.colors.push(rgb);
      else ranges.push({ start: index, colors: [rgb] });
    }
    for (const { start, colors } of ranges) await this.client.writeRange(start, colors);
    await this.client.setMode(1);
    this.enabled = true;
    await this.setNativeLighting({ effect: 6 });
    return this.status();
  }

  async applyPreset(colors, lighting) {
    // Reject the complete input before even capturing state, so malformed
    // saved files can never start a partial preset update.
    const preset = validateRgbPreset(colors, lighting);
    this.requireSupport();
    await this.capture();
    // Static chunk uploads are non-atomic. Blank the main lights for their
    // duration, verify every chunk, and reveal the finished frame last.
    await this.setNativeLighting({ brightness: 0 });
    await this.client.setMode(0);
    this.enabled = false;
    this.hasFrame = false;
    await this.client.writeFrame(preset.colors);
    this.hasFrame = true;
    const { brightness, ...native } = preset.lighting;
    await this.setNativeLighting(native);
    await this.client.setMode(1);
    this.enabled = true;
    await this.setNativeLighting({ brightness });
    return this.status();
  }

  async applyLighting(change) {
    const native = { ...change };
    delete native.rgb;
    if (!this.metadata().supported) {
      if (this.connection === 'receiver') this.requireSupport();
      if (this.identity?.crc === COMBINED_CRC) this.requireSupport();
      await this.setNativeLighting(native); return;
    }
    if (change.rgb !== undefined && !rgbValid(change.rgb)) throw new TypeError('Invalid RGB color.');
    await this.capture();
    const current = await this.getLighting();
    const desiredEffect = change.effect ?? current.effect;
    const colorChanged = change.rgb !== undefined || change.hue !== undefined || change.sat !== undefined;
    if (desiredEffect !== 6 && this.enabled) {
      await this.client.setMode(0);
      this.enabled = false;
    }
    // Native color SET is retained: the reviewed combined firmware uses it
    // to update the independent rear-follow color. Per-key edits never send it.
    await this.setNativeLighting(native);
    if (desiredEffect === 6 && (colorChanged || change.effect === 6)) {
      if (colorChanged) {
        const rgb = change.rgb || hsvToRgb(viaToDegrees(change.hue ?? current.hue), change.sat ?? current.sat);
        await this.client.writeFrame(Array.from({ length: 92 }, () => [...rgb]));
        this.hasFrame = true;
      } else await this.seedIfNeeded();
      await this.client.setMode(1);
      this.enabled = true;
    }
  }

  async release() {
    this.requireSupport();
    await this.client.setMode(0);
    this.enabled = false;
    if (this.saved) {
      await this.client.writeFrame(this.saved.colors);
      const { effect, brightness, speed, hue, sat } = this.saved.lighting;
      await this.setNativeLighting({ effect, brightness, speed, hue, sat });
      this.saved = null;
    }
    this.hasFrame = false;
    return this.status();
  }

  dispose() { this.supported = false; this.client.dispose(); }
}

module.exports = { RgbController, COMBINED_CRC, STOCK_CRC, MAPPED_KEYS, VERIFIED_KEYS, hsvToRgb, rgbValid, validateRgbPreset, validateKeyChanges };
