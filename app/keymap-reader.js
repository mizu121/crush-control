'use strict';

// Pure VIA keymap reader. The Crush 80 reads one 256-byte layer at a time;
// crossing that boundary can silently return FFFF for the next layer's keys.
const ROWS = 8, COLS = 16, LAYER_BYTES = ROWS * COLS * 2;

function validReply(reply, echo) {
  if ((!Array.isArray(reply) && !(reply instanceof Uint8Array)) || reply.length !== 32) {
    throw new Error('Keymap read expected exactly 32 VIA reply bytes.');
  }
  const bytes = Array.from(reply);
  if (bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error('Keymap reply contains an invalid byte.');
  }
  if (echo.some((value, index) => bytes[index] !== value)) {
    throw new Error('Keymap reply does not match the requested command, offset, and size.');
  }
  return bytes;
}

async function readKeymap(request, layers) {
  if (typeof request !== 'function') throw new TypeError('Keymap reader requires a request function.');
  if (!Number.isInteger(layers) || layers < 1 || layers > 4) throw new RangeError('Expected 1..4 keymap layers.');
  const map = [];
  for (let layer = 0; layer < layers; layer++) {
    const bytes = [];
    for (let localOffset = 0; localOffset < LAYER_BYTES; localOffset += 28) {
      const size = Math.min(28, LAYER_BYTES - localOffset);
      const offset = layer * LAYER_BYTES + localOffset;
      const query = [0x12, offset >> 8, offset & 0xff, size];
      const reply = validReply(await request(query), query);
      bytes.push(...reply.slice(4, 4 + size));
    }
    map.push(Array.from({ length: ROWS }, (_, row) =>
      Array.from({ length: COLS }, (_, col) => {
        const at = (row * COLS + col) * 2;
        return (bytes[at] << 8) | bytes[at + 1];
      })));
  }
  return map;
}

module.exports = { readKeymap, validReply, ROWS, COLS, LAYER_BYTES };
