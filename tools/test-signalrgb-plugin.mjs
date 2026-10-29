// Runs the SignalRGB plugin outside SignalRGB with a fake `device`, to check what it would send.
//   node tools/test-signalrgb-plugin.mjs          dry run, prints packets
//   node tools/test-signalrgb-plugin.mjs --live   also forwards the packets to the real keyboard
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const live = process.argv.includes('--live');
const here = path.dirname(fileURLToPath(import.meta.url));

let hid = null;
if (live) {
  const HID = require('node-hid');
  const info = HID.devices(0x320f, 0x5055).find((d) => d.usagePage === 0xff60 && d.usage === 0x61);
  hid = new HID.HID(info.path);
}

let canvas = () => [0, 0, 0];
const log = [];
// Dry-run board state: starts on the Fn+Enter rainbow step (hue 0) so the warning path runs.
const fakeBoard = { 1: [8, 0], 2: [8, 0], 3: [0, 0], 4: [0, 255] };
let lastGet = null;
globalThis.device = {
  getHidEndpoints: () => [{ interface: 1, usage: 0x61, usage_page: 0xff60, collection: 0 }],
  set_endpoint: () => {},
  clearReadBuffer: () => { if (hid) while (hid.readTimeout(1).length) {} },
  write: (data) => {
    if (data[1] === 0x08) lastGet = data[3];
    else log.push(data.slice(1, 6));
    if (hid) hid.write([...data, ...new Array(33 - data.length).fill(0)]);
  },
  read: () => {
    if (hid) return [0, ...hid.readTimeout(50)];
    return [0x08, 0x03, lastGet, ...fakeBoard[lastGet], 0];
  },
  pause: () => {},
  log: (m) => console.log('  [plugin log]', m),
  notify: (title, msg) => console.log('  [plugin notify]', title, '-', msg),
  color: (x, y) => canvas(x, y),
};
Object.assign(globalThis, {
  LightingMode: 'Canvas', forcedColor: '#009bde', blendMode: 'Smart blend',
  boardAnimation: process.env.ANIMATION || 'Solid color', animationSpeed: 2,
  maxBrightness: 8, shutdownMode: 'Restore keyboard lighting', shutdownColor: '#000000',
});

const plugin = await import(pathToFileURL(path.join(here, '..', 'signalrgb', 'Wobkey_Crush80_VIA_Sync.js')).href + '?t=' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (p) => p.map((b) => b.toString(16).padStart(2, '0')).join(' ');

async function frame(label, fn, holdMs = live ? +(process.env.HOLD_MS || 2500) : 0) {
  canvas = fn;
  log.length = 0;
  await sleep(80); // let the plugin's rate limiter pass
  plugin.Render();
  console.log(label.padEnd(30), log.length ? log.map(fmt).join(' | ') : '(no change)');
  if (holdMs) await sleep(holdMs);
}

plugin.Initialize();
console.log('init writes:', log.map(fmt).join(' | '));
if (live) await frame('lead-in (dark)', () => [0, 0, 0], 3000);
await frame('solid red', () => [255, 0, 0]);
await frame('solid red again', () => [255, 0, 0]);
await frame('solid green', () => [0, 255, 0]);
await frame('solid blue', () => [0, 0, 255]);
await frame('purple', () => [160, 0, 255]);
await frame('white', () => [255, 255, 255]);
await frame('dim orange (25%)', () => [64, 32, 0]);
await frame('mostly orange, a bit of red', (x) => (x < 3 ? [255, 0, 0] : [255, 128, 0]));
await frame('rainbow across keys', (x) => {
  const h = (x / 18) * 360, c = 255, X = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const [r, g, b] = h < 60 ? [c, X, 0] : h < 120 ? [X, c, 0] : h < 180 ? [0, c, X] : h < 240 ? [0, X, c] : h < 300 ? [X, 0, c] : [c, 0, X];
  return [r, g, b];
});
await frame('black', () => [0, 0, 0]);
log.length = 0;
plugin.Shutdown(false);
console.log('shutdown writes:', log.map(fmt).join(' | '));
if (hid) hid.close();
