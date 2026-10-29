// Original procedural app/tray artwork. PNGs require no external image assets.
const zlib = require('zlib');
const { nativeImage } = require('electron');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const iconSqrt = Math.sqrt;
function iconRoundBox(x, y, left, top, width, height, radius) {
  const cx = x - left - width / 2, cy = y - top - height / 2;
  const dx = (cx < 0 ? -cx : cx) - width / 2 + radius;
  const dy = (cy < 0 ? -cy : cy) - height / 2 + radius;
  const ax = dx > 0 ? dx : 0, ay = dy > 0 ? dy : 0, inside = dx > dy ? dx : dy;
  return iconSqrt(ax * ax + ay * ay) + (inside < 0 ? inside : 0) - radius;
}

// A single ivory keycap, geometric C and quiet mint activity light. The face,
// short front wall and contact shadow remain distinct at small Windows sizes.
function makeIcon(size = 32) {
  if (!Number.isInteger(size) || size < 8 || size > 512) throw new RangeError('Icon size must be 8..512 pixels.');
  const px = Buffer.alloc(size * size * 4);
  const samples = size <= 64 ? 4 : 2, count = samples * samples;
  for (let py = 0; py < size; py++) for (let pxl = 0; pxl < size; pxl++) {
    let red = 0, green = 0, blue = 0, alpha = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const x = (pxl + (sx + 0.5) / samples) * 64 / size;
      const y = (py + (sy + 0.5) / samples) * 64 / size;
      const tile = iconRoundBox(x, y, 3, 3, 58, 58, 12);
      if (tile > 0) continue;
      let r = 39 - y * 0.25, g = 46 - y * 0.28, b = 44 - y * 0.25;
      const paint = (nr, ng, nb, opacity = 1) => {
        r += (nr - r) * opacity; g += (ng - g) * opacity; b += (nb - b) * opacity;
      };
      // Fine tile edge, more apparent toward the light at the upper left.
      if (tile > -0.65) paint(70, 79, 75, 0.48 - y * 0.003);
      const shadow = iconRoundBox(x, y, 12.5, 18, 39, 34, 7);
      if (shadow < 4.5) paint(6, 11, 10, 0.46 * (1 - (shadow > 0 ? shadow : 0) / 4.5));

      const wall = iconRoundBox(x, y, 12.5, 14, 39, 36, 7);
      if (wall <= 0) {
        const depth = y < 35 ? 0 : y > 50 ? 1 : (y - 35) / 15;
        paint(211 - depth * 54, 216 - depth * 48, 208 - depth * 43);
        if (wall > -0.7) paint(121, 139, 129, 0.32);
      }
      const face = iconRoundBox(x, y, 15, 11.5, 34, 32, 5.5);
      if (face <= 0) {
        const shade = y < 12 ? 0 : y > 44 ? 1 : (y - 12) / 32;
        const side = (x < 32 ? 32 - x : x - 32) / 17;
        paint(246 - shade * 23 - side * 4, 246 - shade * 18 - side * 3, 237 - shade * 16 - side * 3);
        if (face > -0.7) paint(255, 255, 249, y < 26 ? 0.72 : 0.18);
        // Construct the letter as a rounded rectangular ring with an open arm.
        const outside = iconRoundBox(x, y, 22.5, 18, 19, 19, 5.2);
        const inside = iconRoundBox(x, y, 27, 22.5, 10, 10, 2.3);
        const opening = x >= 32 && y >= 22.5 && y <= 32.5;
        if (outside <= 0 && inside > 0 && !opening) paint(46, 64, 57);
      }
      const indicator = iconRoundBox(x, y, 24, 54, 16, 2.2, 1.1);
      if (indicator < 1.6) paint(119, 201, 159, 0.09 * (1 - (indicator > 0 ? indicator : 0) / 1.6));
      if (indicator <= 0) paint(139, 208, 172);
      red += r; green += g; blue += b; alpha++;
    }
    const at = (py * size + pxl) * 4;
    if (alpha) { px[at] = (red / alpha + 0.5) | 0; px[at + 1] = (green / alpha + 0.5) | 0; px[at + 2] = (blue / alpha + 0.5) | 0; }
    px[at + 3] = (255 * alpha / count + 0.5) | 0;
  }
  return nativeImage.createFromBuffer(encodePng(size, px));
}

// Readable battery percentage at tray sizes. Amber dot means last-known data;
// an unknown reading uses a dash, never a fabricated percentage.
function makeBatteryIcon(battery, size = 32) {
  const rgba = Buffer.alloc(size * size * 4), scale = size / 32;
  const fill = (x, y, w, h, color) => {
    for (let yy = Math.round(y * scale); yy < Math.round((y + h) * scale); yy++)
      for (let xx = Math.round(x * scale); xx < Math.round((x + w) * scale); xx++) {
        if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
        const i = (yy * size + xx) * 4;
        rgba[i] = color[0]; rgba[i + 1] = color[1]; rgba[i + 2] = color[2]; rgba[i + 3] = 255;
      }
  };
  const known = Number.isInteger(battery?.percent) && battery.percent >= 0 && battery.percent <= 100;
  const digits = known ? String(battery.percent) : '-';
  const font = {
    '0':['111','101','101','101','111'], '1':['010','110','010','010','111'],
    '2':['111','001','111','100','111'], '3':['111','001','111','001','111'],
    '4':['101','101','111','001','001'], '5':['111','100','111','001','111'],
    '6':['111','100','111','101','111'], '7':['111','001','010','010','010'],
    '8':['111','101','111','101','111'], '9':['111','101','111','001','111'],
    '-':['000','000','111','000','000'],
  };
  fill(1, 4, 30, 24, [34, 38, 39]);
  const width = digits.length * 8 - 2, left = (32 - width) / 2;
  [...digits].forEach((digit, index) => font[digit].forEach((row, y) => [...row].forEach((pixel, x) => {
    if (pixel === '1') fill(left + index * 8 + x * 2, 8 + y * 2, 2, 2, [245, 247, 246]);
  })));
  fill(5, 22, 22, 2, [83, 89, 91]);
  if (known) fill(5, 22, Math.max(1, Math.round(22 * battery.percent / 100)), 2,
    battery.stale ? [187, 150, 91] : battery.percent <= 15 ? [232, 109, 91] : [142, 193, 155]);
  if (battery?.stale && known) fill(27, 2, 4, 4, [207, 163, 83]);
  if (battery?.charging === true && !battery.stale) fill(27, 2, 4, 4, [142, 218, 157]);
  return nativeImage.createFromBuffer(encodePng(size, rgba));
}
module.exports = { makeIcon, makeBatteryIcon };
