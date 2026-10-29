'use strict';

// Independent implementation of the published PKRG v2 configuration wire format.
// No device discovery, HID access, firmware loading, SAVE, streaming, or OEM effect
// changes happen here. The caller supplies a request/reply transport and owns it.
// Each request/reply is exactly 32 VIA payload bytes, without a HID report-ID byte.
// The transport must reject on timeout/disconnect. If it has no open/close/error
// events, its owner MUST call invalidate() on every disconnect or reconnect.
// Enabling the override does not select the OEM solid effect (6). This low-level
// adapter does not take over or restore the keyboard's effect/brightness/session.
// Chunk uploads change the active buffer and are NON-ATOMIC, including writeFrame.
// A successful readback confirms stored RGB, not physical LED scanout or color.
// Indices are the firmware's 92 key slots, not keycodes; rear/logo LEDs are outside
// this protocol. Discovery metadata is a snapshot, not ongoing session ownership.

const PKRG = Object.freeze({
  REPORT_SIZE: 32, CHANNEL: 0x7f, GET: 0x08, SET: 0x07,
  CAPABILITIES: 0, MODE: 1, CHUNK: 2,
  VERSION: 2, LED_COUNT: 92, CHUNK_LIMIT: 8,
  FRAGMENT_CAPACITY: 9, FRAGMENT_COUNT: 11,
});

class PkrgError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PkrgError';
    this.code = code;
    Object.assign(this, details);
  }
}

// Two clients sharing the same transport also share a whole-operation queue and
// connection epoch. This cannot coordinate a different process or HID handle.
const transports = new WeakMap();
function transportState(transport) {
  if (!transport || typeof transport.request !== 'function') {
    throw new TypeError('PKRG requires a transport with request(bytes).');
  }
  if (!transports.has(transport)) transports.set(transport, { tail: Promise.resolve(), epoch: 0 });
  return transports.get(transport);
}

function validateRange(start, count) {
  if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 ||
      count < 1 || start + count > PKRG.LED_COUNT) {
    throw new RangeError('LED range must contain 1..92 LEDs entirely within indices 0..91.');
  }
}

function copyColors(colors) {
  if (!Array.isArray(colors)) throw new TypeError('Colors must be an array of RGB triplets.');
  // Array.from visits holes, unlike map/every. Sparse arrays are invalid input.
  return Array.from(colors, (rgb) => {
    if (!Array.isArray(rgb) || rgb.length !== 3) {
      throw new TypeError('Every RGB value must contain exactly three integers in 0..255.');
    }
    const copy = Array.from(rgb);
    if (copy.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
      throw new TypeError('Every RGB value must contain exactly three integers in 0..255.');
    }
    return copy;
  });
}

const statusMessages = Object.freeze({
  1: 'unsupported operation', 2: 'invalid LED range', 3: 'invalid mode',
  4: 'incomplete or invalid frame', 5: 'a frame commit or acknowledgement is pending',
});

class PkrgClient {
  #transport;
  #state;
  #capabilities = null;
  #capabilityEpoch = -1;
  #disposed = false;
  #lifecycleHandler = null;

  constructor(transport) {
    this.#state = transportState(transport);
    this.#transport = transport;
    if (typeof transport.on === 'function' &&
        (typeof transport.off === 'function' || typeof transport.removeListener === 'function')) {
      this.#lifecycleHandler = () => this.invalidate('transport lifecycle changed');
      for (const event of ['open', 'close', 'error']) transport.on(event, this.#lifecycleHandler);
    }
  }

  get compatible() {
    return !this.#disposed && this.#capabilities !== null && this.#capabilityEpoch === this.#state.epoch;
  }

  invalidate(reason = 'transport lifecycle changed') {
    this.#state.epoch += 1;
    this.#capabilities = null;
    this.#capabilityEpoch = -1;
    this.lastInvalidation = String(reason);
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.invalidate('client disposed');
    if (this.#lifecycleHandler) {
      const remove = this.#transport.off || this.#transport.removeListener;
      for (const event of ['open', 'close', 'error']) remove.call(this.#transport, event, this.#lifecycleHandler);
    }
    // The injected transport remains open and owned by its caller.
  }

  #assertCurrent(epoch) {
    if (this.#disposed) throw new PkrgError('DISPOSED', 'PKRG client is disposed.');
    if (epoch !== this.#state.epoch) {
      throw new PkrgError('INVALIDATED', 'Transport changed during the operation; discover again.');
    }
  }

  #enqueue(run, needsDiscovery = true) {
    const execute = async () => {
      const epoch = this.#state.epoch;
      this.#assertCurrent(epoch);
      if (needsDiscovery && !this.compatible) {
        throw new PkrgError('NOT_DISCOVERED', 'Compatible PKRG v2 discovery is required before this operation.');
      }
      try {
        return await run(epoch);
      } catch (error) {
        this.invalidate('request or verification failed');
        throw error;
      }
    };
    const result = this.#state.tail.then(execute, execute);
    this.#state.tail = result.catch(() => {});
    return result;
  }

  async #request(epoch, command, operation, payload = []) {
    this.#assertCurrent(epoch);
    const request = Array(PKRG.REPORT_SIZE).fill(0);
    request[0] = command;
    request[1] = PKRG.CHANNEL;
    request[2] = operation;
    payload.forEach((value, index) => { request[index + 4] = value; });
    let received;
    try {
      received = await this.#transport.request(request);
    } catch (cause) {
      throw new PkrgError('TRANSPORT', 'PKRG request failed; discover again before sending changes.', { cause });
    }
    this.#assertCurrent(epoch);
    if ((!Array.isArray(received) && !(received instanceof Uint8Array)) ||
        received.length !== PKRG.REPORT_SIZE) {
      throw new PkrgError('REPLY_LENGTH', 'Expected exactly 32 VIA payload bytes.');
    }
    const reply = Array.from(received);
    if (reply.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new PkrgError('REPLY_BYTES', 'Reply contains an invalid byte.');
    }
    if (reply[0] !== command || reply[1] !== PKRG.CHANNEL || reply[2] !== operation) {
      throw new PkrgError('REPLY_ECHO', 'Reply does not match the requested PKRG command, channel, and operation.');
    }
    if (reply[3] !== 0) {
      throw new PkrgError('DEVICE_STATUS', `PKRG rejected the request: ${statusMessages[reply[3]] || 'unknown status'}.`,
        { status: reply[3], command, operation });
    }
    return reply;
  }

  discover() {
    return this.#enqueue(async (epoch) => {
      this.#capabilities = null;
      this.#capabilityEpoch = -1;
      let reply;
      try {
        reply = await this.#request(epoch, PKRG.GET, PKRG.CAPABILITIES);
      } catch (error) {
        if (error.code === 'DEVICE_STATUS' && error.status === 1) {
          this.invalidate('PKRG capabilities are unsupported');
          return Object.freeze({ supported: false, reason: 'PKRG capability operation is unsupported.' });
        }
        throw error;
      }
      const expected = [80, 75, 82, 71, PKRG.VERSION, PKRG.LED_COUNT, PKRG.CHUNK_LIMIT];
      if (expected.some((byte, index) => reply[index + 4] !== byte) ||
          reply[12] !== PKRG.FRAGMENT_CAPACITY || reply[13] !== PKRG.FRAGMENT_COUNT) {
        this.invalidate('PKRG capabilities are incompatible');
        return Object.freeze({ supported: false, reason: 'Exact PKRG v2 capabilities (92 LEDs, 8/9/11 limits) are required.' });
      }
      if (reply[11] !== 0 && reply[11] !== 1) {
        throw new PkrgError('CAPABILITIES', 'PKRG capability reply contains an invalid enabled flag.');
      }
      if (reply.slice(14).some((byte) => byte !== 0)) {
        throw new PkrgError('CAPABILITIES', 'PKRG capability reply contains unrecognized reserved metadata.');
      }
      this.#capabilities = Object.freeze({
        supported: true, protocolVersion: PKRG.VERSION, ledCount: PKRG.LED_COUNT,
        chunkLimit: PKRG.CHUNK_LIMIT, enabled: reply[11],
        fragmentCapacity: PKRG.FRAGMENT_CAPACITY, fragmentCount: PKRG.FRAGMENT_COUNT,
      });
      this.#capabilityEpoch = epoch;
      return this.#capabilities;
    }, false);
  }

  async #readMode(epoch) {
    const reply = await this.#request(epoch, PKRG.GET, PKRG.MODE);
    if (reply[4] !== 0 && reply[4] !== 1) throw new PkrgError('MODE', 'Firmware returned an invalid enabled flag.');
    return reply[4];
  }

  getMode() { return this.#enqueue((epoch) => this.#readMode(epoch)); }

  async setMode(mode) {
    if (mode !== 0 && mode !== 1) throw new RangeError('Mode must be the integer 0 or 1.');
    return this.#enqueue(async (epoch) => {
      try {
        const reply = await this.#request(epoch, PKRG.SET, PKRG.MODE, [mode]);
        if (reply[4] !== mode) throw new PkrgError('MODE_ACK', 'Mode acknowledgement differs from the requested mode.');
        if (await this.#readMode(epoch) !== mode) throw new PkrgError('VERIFY_MODE', 'Mode readback differs from the requested mode.');
        return mode;
      } catch (error) {
        error.mayHaveChanged = true;
        throw error;
      }
    });
  }

  async #readChunk(epoch, start, count) {
    const reply = await this.#request(epoch, PKRG.GET, PKRG.CHUNK, [start, count]);
    if (reply[4] !== start || reply[5] !== count) throw new PkrgError('RANGE_ECHO', 'RGB reply refers to a different LED range.');
    return Array.from({ length: count }, (_, index) => reply.slice(6 + index * 3, 9 + index * 3));
  }

  async #readRange(epoch, start, count) {
    const result = [];
    for (let offset = 0; offset < count; offset += PKRG.CHUNK_LIMIT) {
      result.push(...await this.#readChunk(epoch, start + offset, Math.min(PKRG.CHUNK_LIMIT, count - offset)));
    }
    return result;
  }

  async readRange(start, count) {
    validateRange(start, count);
    return this.#enqueue((epoch) => this.#readRange(epoch, start, count));
  }

  readFrame() { return this.readRange(0, PKRG.LED_COUNT); }

  async #writeRange(epoch, start, colors) {
    let verifiedCount = 0;
    try {
      for (let offset = 0; offset < colors.length; offset += PKRG.CHUNK_LIMIT) {
        const chunk = colors.slice(offset, offset + PKRG.CHUNK_LIMIT);
        const at = start + offset;
        const bytes = chunk.flat();
        const reply = await this.#request(epoch, PKRG.SET, PKRG.CHUNK, [at, chunk.length, ...bytes]);
        if (reply[4] !== at || reply[5] !== chunk.length) throw new PkrgError('RANGE_ECHO', 'RGB acknowledgement refers to a different LED range.');
        if (bytes.some((byte, index) => reply[index + 6] !== byte)) {
          throw new PkrgError('RGB_ACK', 'RGB acknowledgement differs from the requested colors.');
        }
        const readback = (await this.#readChunk(epoch, at, chunk.length)).flat();
        if (bytes.some((byte, index) => readback[index] !== byte)) {
          throw new PkrgError('VERIFY_RGB', 'RGB readback differs from the requested colors.');
        }
        verifiedCount += chunk.length;
      }
      return Object.freeze({ start, count: colors.length, verified: true, atomic: false });
    } catch (error) {
      Object.assign(error, { start, count: colors.length, verifiedCount, mayHaveChanged: true });
      throw error;
    }
  }

  async writeRange(start, colors) {
    const snapshot = copyColors(colors);
    validateRange(start, snapshot.length);
    return this.#enqueue((epoch) => this.#writeRange(epoch, start, snapshot));
  }

  async writeFrame(colors) {
    const snapshot = copyColors(colors);
    if (snapshot.length !== PKRG.LED_COUNT) throw new RangeError('A frame must contain exactly 92 RGB triplets.');
    return this.#enqueue((epoch) => this.#writeRange(epoch, 0, snapshot));
  }
}

module.exports = { PkrgClient, PkrgError, PKRG };
