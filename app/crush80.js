// High-level Crush 80 model on top of the VIA transport: lighting, keymap, and connection polling.
const { EventEmitter } = require('events');
const { ViaDevice, CMD } = require('./via');
const { readKeymap: readKeymapLayers } = require('./keymap-reader');
const { RgbController, STOCK_CRC, COMBINED_CRC, validateRgbPreset, validateKeyChanges } = require('./rgb-controller');

const ROWS = 8;
const COLS = 16;
const LIGHTING_CHANNEL = 3; // qmk_rgb_matrix in the official Crush 80 VIA JSON
const VALUE = { BRIGHTNESS: 1, EFFECT: 2, SPEED: 3, COLOR: 4 };

// Effect IDs and their names from the official JSON (friendlier labels where the JSON's are cryptic).
const EFFECTS = [
  { id: 0, name: 'Off' },
  { id: 6, name: 'Solid' },
  { id: 5, name: 'Breathe' },
  { id: 1, name: 'Wave' },
  { id: 13, name: 'Wave Bar' },
  { id: 2, name: 'Colour Cloud' },
  { id: 3, name: 'Vortex' },
  { id: 4, name: 'Mix Colour' },
  { id: 8, name: 'Stone' },
  { id: 9, name: 'Laser' },
  { id: 10, name: 'Starry' },
  { id: 11, name: 'Flowers Open' },
  { id: 12, name: 'Traverse' },
  { id: 14, name: 'Meteor' },
  { id: 15, name: 'Rain' },
  { id: 16, name: 'Scan' },
  { id: 18, name: 'Center Spread' },
  { id: 7, name: 'Fade on Keypress' },
  { id: 17, name: 'Trigger Colour' },
];

const LIMITS = { brightness: 9, speed: 4 };

class Crush80 extends EventEmitter {
  constructor({ via = new ViaDevice(), getReceiverLink = () => null } = {}) {
    super();
    this.via = via;
    this.getReceiverLink = getReceiverLink;
    this.info = null;
    this.operations = Promise.resolve();
    this.epoch = 0;
    this.polling = false;
    this.closing = false;
    this.rgb = null;
    this.lastReceiverProbe = 0;
    this.receiverFailures = 0;
    this.retryAt = 0;
    this.via.on('close', () => {
      this.epoch++;
      this.rgb?.dispose();
      this.rgb = null;
      this.info = null;
      this.emit('status', this.status());
    });
  }

  status() {
    return { connected: this.via.connected, info: this.info && { ...this.info,
      supportsLighting: this.info.connection !== 'receiver' || this.rgb?.metadata().supported === true,
      rgb: this.rgb?.metadata() || null } };
  }

  _run(operation, duringShutdown = false) {
    const epoch = this.epoch;
    const execute = async () => {
      if (epoch !== this.epoch || !this.info) throw new Error('Keyboard connection changed; reconnect before applying controls.');
      if (this.closing && !duringShutdown) throw new Error('Keyboard controls are closing.');
      try { return await operation(); }
      catch (error) {
        if (!(error instanceof TypeError) && !(error instanceof RangeError)) this.rgb?.client.invalidate('Keyboard operation failed; reconnect to verify firmware.');
        throw error;
      }
    };
    const result = this.operations.then(execute, execute);
    this.operations = result.catch(() => {});
    return result;
  }

  // Opens the keyboard if it's plugged in and not open yet. Call it on a timer.
  async poll() {
    if (this.polling || this.closing) return;
    this.polling = true;
    let attemptedConnection = this.info?.connection;
    try {
      const candidate = this.via.find ? this.via.find() : ViaDevice.find();
      attemptedConnection = candidate?.connection || attemptedConnection;
      if (this.via.connected) {
        if (!candidate || (this.via.matches && !this.via.matches(candidate))) await this.via.close();
        else {
          // USB removal is visible to enumeration. A plugged-in receiver can
          // outlive its radio peer; one bounded idle GET detects that loss.
          if (this.info?.connection === 'receiver' && Date.now() - this.lastReceiverProbe >= 15000) {
            this.lastReceiverProbe = Date.now();
            await this._run(async () => {
              const reply = await this.via.request([CMD.PROTOCOL_VERSION]);
              if (((reply[1] << 8) | reply[2]) !== 11) throw new Error('Receiver keyboard is no longer responding with the expected protocol.');
            });
          }
          return;
        }
      }
      if (!candidate) return;
      let identity = null;
      const connection = candidate.connection || 'usb';
      if (connection === 'receiver' && Date.now() < this.retryAt) return;
      if (connection === 'usb') {
        try { identity = this.via.identity ? this.via.identity(candidate) : ViaDevice.identity(); } catch { /* Stock VIA fallback remains available. */ }
      }
      if (!(await this.via.open(candidate))) return;
      const proto = await this.via.request([CMD.PROTOCOL_VERSION]);
      const layers = await this.via.request([CMD.LAYER_COUNT]);
      const macros = await this.via.request([CMD.MACRO_COUNT]);
      this.info = { protocol: (proto[1] << 8) | proto[2], layers: layers[1], macros: macros[1], rows: ROWS, cols: COLS,
        connection, deviceKey: candidate.pathHash || null, supportsKeymap: connection === 'usb' };
      this.rgb = new RgbController({ transport: this.via,
        getLighting: () => this._getLighting(), setLighting: change => this._setLighting(change) });
      if (this.info.protocol === 11 && this.info.layers === 4 && this.info.macros === 16) {
        if (connection === 'receiver') await this.rgb.initializeReceiver(this.getReceiverLink(candidate.pathHash), candidate.pathHash);
        else await this.rgb.initialize(identity);
      } else if (connection === 'receiver') {
        throw new Error('Receiver protocol does not match the tested keyboard.');
      }
      this.info.supportsLighting = connection === 'usb' || this.rgb.metadata().supported;
      this.lastReceiverProbe = Date.now();
      this.receiverFailures = 0;
      this.retryAt = 0;
      this.emit('status', this.status());
    } catch (err) {
      if (attemptedConnection === 'receiver') {
        this.receiverFailures++;
        this.retryAt = Date.now() + Math.min(15000, 1500 * 2 ** Math.min(this.receiverFailures, 4));
      }
      await this.via.close();
      this.emit('error', err);
    } finally { this.polling = false; }
  }

  async getValue(id) {
    const r = await this.via.request([CMD.CUSTOM_GET, LIGHTING_CHANNEL, id]);
    return r.slice(3, 5);
  }

  async setValue(id, data) {
    await this.via.request([CMD.CUSTOM_SET, LIGHTING_CHANNEL, id, ...data]);
    const actual = await this.getValue(id);
    if (!data.every((value, index) => actual[index] === value)) throw new Error('Keyboard did not keep the requested lighting value.');
  }

  async _getLighting() {
    const [brightness] = await this.getValue(VALUE.BRIGHTNESS);
    const [effect] = await this.getValue(VALUE.EFFECT);
    const [speed] = await this.getValue(VALUE.SPEED);
    const [hue, sat] = await this.getValue(VALUE.COLOR);
    // Hue 0 only ever comes from the keyboard's own Fn+Enter cycle (this app never writes it),
    // and on that step the board shows its rainbow and ignores VIA colors.
    return { brightness, effect, speed, hue, sat, rainbowLocked: hue === 0 };
  }

  getLighting() { return this._run(async () => {
    const lighting = await this._getLighting();
    return { ...lighting, rainbowLocked: this.rgb?.metadata().supported ? false : lighting.rainbowLocked };
  }); }

  // Applies any subset of { effect, brightness, speed, hue, sat }. RAM only until saveLighting().
  async _setLighting(change) {
    if (!change || typeof change !== 'object') throw new TypeError('Invalid lighting change.');
    for (const field of ['effect', 'brightness', 'speed', 'hue', 'sat']) {
      if (change[field] !== undefined && !Number.isFinite(change[field])) throw new TypeError(`Invalid ${field}.`);
    }
    if (change.effect !== undefined && (!Number.isInteger(change.effect) || change.effect < 0 || change.effect > 18)) throw new RangeError('Invalid effect.');
    const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(v)));
    if (change.effect !== undefined) await this.setValue(VALUE.EFFECT, [change.effect]);
    if (change.speed !== undefined) await this.setValue(VALUE.SPEED, [clamp(change.speed, LIMITS.speed)]);
    if (change.hue !== undefined || change.sat !== undefined) {
      const current = await this.getValue(VALUE.COLOR);
      const hue = Math.max(1, clamp(change.hue ?? current[0], 255));
      await this.setValue(VALUE.COLOR, [hue, clamp(change.sat ?? current[1], 255)]);
    }
    if (change.brightness !== undefined) await this.setValue(VALUE.BRIGHTNESS, [clamp(change.brightness, LIMITS.brightness)]);
  }

  setLighting(change) {
    const snapshot = { ...change, ...(Array.isArray(change?.rgb) ? { rgb: [...change.rgb] } : {}) };
    return this._run(() => this.rgb ? this.rgb.applyLighting(snapshot) : this._setLighting(snapshot));
  }

  getRgbStatus() { return this._run(() => this.rgb?.status() || { supported: false, colors: null, verifiedKeys: [], volatile: true }); }
  setKeyRgb(change) { return this.setKeysRgb({ changes: [change] }); }
  setKeysRgb(value) {
    let changes;
    try { changes = validateKeyChanges(value); } catch (error) { return Promise.reject(error); }
    return this._run(() => {
    if (!this.rgb) throw new Error('Per-key firmware is not available.');
    return this.rgb.setKeys({ changes });
  }); }
  releaseRgb() { return this._run(() => {
    if (!this.rgb) throw new Error('Per-key firmware is not available.');
    return this.rgb.release();
  }); }

  applyRgbPreset(colors, lighting) {
    // Snapshot immediately so a queued caller cannot mutate its pending frame.
    let preset;
    try { preset = validateRgbPreset(colors, lighting); } catch (error) { return Promise.reject(error); }
    return this._run(async () => {
      if (!this.rgb) throw new Error('Per-key firmware is not available.');
      const rgb = await this.rgb.applyPreset(preset.colors, preset.lighting);
      return { lighting: await this._getLighting(), rgb };
    });
  }

  capturePreset() { return this._run(async () => {
    // One model operation covers both reads; another app edit cannot land
    // between the native settings and the saved per-key frame.
    if (this.rgb?.identity?.crc === COMBINED_CRC || this.info.connection === 'receiver') this.rgb.requireSupport();
    const lighting = await this._getLighting();
    const rgb = this.rgb ? await this.rgb.status() : { supported: false, enabled: false, colors: null };
    return { lighting, rgb };
  }); }

  applyLightingPreset(change) {
    const snapshot = { ...change, ...(Array.isArray(change?.rgb) ? { rgb: [...change.rgb] } : {}) };
    return this._run(async () => {
      if (this.rgb) await this.rgb.applyLighting(snapshot);
      else await this._setLighting(snapshot);
      return { lighting: await this._getLighting(),
        rgb: this.rgb ? await this.rgb.status() : { supported: false, enabled: false, colors: null } };
    });
  }

  // Writes the current lighting to the keyboard's flash so it survives a power cycle.
  saveLighting() { return this._run(async () => {
    this.requireUsb();
    if (this.rgb?.identity?.crc !== STOCK_CRC) throw new RangeError('Save to keyboard requires verified stock firmware. Per-key colors are live only and reset at power-off.');
    await this.via.request([CMD.CUSTOM_SAVE, LIGHTING_CHANNEL]);
  }); }

  // Returns keycodes[layer][row][col]. Uses bulk reads: this firmware answers single-key reads wrongly.
  requireUsb() { if (this.info?.connection === 'receiver') throw new RangeError('Connect by USB for key mapping and saved keyboard settings.'); }
  readKeymap() { return this._run(() => { this.requireUsb(); return readKeymapLayers((query) => this.via.request(query), this.info.layers); }); }

  async _readKeycode(layer, row, col) {
    this.requireUsb();
    const offset = ((layer * ROWS + row) * COLS + col) * 2;
    const r = await this.via.request([CMD.KEYMAP_GET_BUFFER, offset >> 8, offset & 0xff, 2]);
    return (r[4] << 8) | r[5];
  }
  readKeycode(layer, row, col) { return this._run(() => this._readKeycode(layer, row, col)); }

  // Writes one keycode and reads it back; throws if the keyboard didn't keep it.
  setKeycode(layer, row, col, code) { return this._run(async () => {
    this.requireUsb();
    await this.via.request([CMD.KEYMAP_SET_KEYCODE, layer, row, col, code >> 8, code & 0xff]);
    const actual = await this._readKeycode(layer, row, col);
    if (actual !== code) throw new Error(`keyboard kept 0x${actual.toString(16)} instead of 0x${code.toString(16)}`);
  }); }

  async shutdown() {
    this.closing = true;
    try {
      if (this.info && this.rgb?.saved && this.rgb.metadata().supported) await this._run(() => this.rgb.release(), true);
    } finally { await this.via.close(); }
  }
}

module.exports = { Crush80, EFFECTS, LIMITS };
