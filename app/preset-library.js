'use strict';
// Preset data and validation only. No device access or filesystem writes.
const { keys } = require('./rgb-keymap.json');
const clone = value => JSON.parse(JSON.stringify(value));
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function normalizePreset(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid preset.');
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > 32 || /[\u0000-\u001f\u007f]/.test(name)) throw new TypeError('Use a preset name from 1 to 32 characters.');
  if (value.version !== undefined && value.version !== 2 && value.version !== 1) throw new RangeError('Unsupported preset version.');
  const kind = value.kind ?? (value.colors === undefined ? 'native' : 'per-key');
  if (!['native', 'per-key'].includes(kind)) throw new TypeError('Invalid preset type.');
  const source = value.lighting;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TypeError('Missing preset lighting.');
  const { effect, brightness, speed, hueDeg, sat } = source;
  if (!integer(effect, 0, 18) || !integer(brightness, 0, 9) || !integer(speed, 0, 4)
      || !Number.isFinite(hueDeg) || hueDeg < 0 || hueDeg > 360 || !integer(sat, 0, 255)) {
    throw new RangeError('Invalid preset lighting values.');
  }
  const preset = { version: 2, name, kind, lighting: { effect, brightness, speed, hueDeg: hueDeg % 360, sat } };
  if (kind === 'per-key') {
    if (effect !== 6) throw new RangeError('Per-key presets use the solid effect.');
    if (!Array.isArray(value.colors) || value.colors.length !== 92) throw new TypeError('A per-key preset needs exactly 92 RGB values.');
    preset.colors = Array.from(value.colors, rgb => {
      if (!Array.isArray(rgb) || rgb.length !== 3 || !Array.from(rgb).every(channel => integer(channel, 0, 255))) {
        throw new TypeError('Each preset color needs three integer values from 0 to 255.');
      }
      return [...rgb];
    });
    for (const key of keys) {
      if (key.slots.some(slot => preset.colors[slot].some((channel, index) => channel !== preset.colors[key.slot][index]))) {
        throw new RangeError(`${key.name} must use one color across its grouped LED slots.`);
      }
    }
  } else if (value.colors !== undefined) throw new TypeError('A native preset cannot contain a per-key frame.');
  return preset;
}

const frame = () => Array.from({ length: 92 }, () => [0, 0, 0]);
function paint(colors, names, rgb) {
  for (const name of names) {
    const key = keys.find(item => item.name === name);
    if (!key) throw new Error(`Unknown preset key ${name}`);
    for (const slot of key.slots) colors[slot] = [...rgb];
  }
}
const mix = (a, b, t) => a.map((channel, index) => Math.round(channel + (b[index] - channel) * Math.max(0, Math.min(1, t))));
function paintEach(colors, colorFor) {
  for (const key of keys) for (const slot of key.slots) colors[slot] = colorFor(key);
}
const WASD = ['W', 'A', 'S', 'D'];
const wasd = frame();
paint(wasd, WASD, [85, 255, 25]);
const fps = frame();
paint(fps, WASD, [0, 220, 255]);
paint(fps, ['Q', 'E', 'R', 'F', '1', '2', '3', '4'], [255, 115, 15]);
paint(fps, ['Left Shift', 'Left Ctrl', 'Space'], [160, 90, 255]);
paint(fps, ['Esc', 'Tab'], [90, 110, 130]);
const split = frame();
paintEach(split, key => key.matrix[0][1] < 8 ? [235, 0, 145] : [0, 210, 255]);
paint(split, ['Esc', 'Enter', 'Space'], [220, 225, 255]);
const aurora = frame();
paintEach(aurora, key => {
  const [row, column] = key.matrix[0], t = column / 15;
  const base = t < .5 ? mix([0, 235, 165], [20, 105, 255], t * 2) : mix([20, 105, 255], [180, 30, 255], t * 2 - 1);
  return mix(base, [90, 75, 165], row * .025);
});
const ember = frame();
paintEach(ember, key => {
  const column = key.matrix[0][1];
  return column < 8 ? mix([255, 35, 0], [255, 155, 15], column / 7) : mix([20, 200, 255], [35, 60, 255], (column - 8) / 7);
});

function direct(id, name, description, colors, hueDeg, swatches) {
  return { ...normalizePreset({ name, kind: 'per-key', colors, lighting: { effect: 6, brightness: 7, speed: 1, hueDeg, sat: 255 } }), id, description, swatches };
}
function native(id, name, description, effect, hueDeg, swatches) {
  return { ...normalizePreset({ name, kind: 'native', lighting: { effect, brightness: 7, speed: 2, hueDeg, sat: 255 } }), id, description, swatches };
}
const catalog = [
  direct('wasd-only', 'WASD only', 'Four green keys. Other keys dark.', wasd, 110, ['#55ff19', '#151918']),
  direct('fps-focus', 'FPS focus', 'Movement, actions, and modifiers.', fps, 190, ['#00dcff', '#ff730f', '#a05aff']),
  direct('neon-split', 'Neon split', 'Hot pink meets electric blue.', split, 195, ['#eb0091', '#00d2ff', '#dce1ff']),
  direct('aurora', 'Aurora', 'Mint, blue, and violet across the keys.', aurora, 260, ['#00eba5', '#1469ff', '#b41eff']),
  direct('ember-ice', 'Ember & ice', 'Warm left. Cool right.', ember, 30, ['#ff2300', '#ff9b0f', '#14c8ff', '#233cff']),
  direct('clear-keys', 'Clear keys', 'Dark main keys. Start your own look.', frame(), 195, ['#151918', '#151918']),
  native('spectrum-wave', 'Wave', 'Moving wave from the keyboard.', 1, 275, ['#c935ed', '#3055ff', '#00d2ff']),
  native('color-rain', 'Rain', 'Onboard falling-light animation.', 15, 195, ['#0b2740', '#147aca', '#69dcff']),
];
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const BUILTIN_PRESETS = freeze(catalog);
const listBuiltins = () => clone(BUILTIN_PRESETS);
module.exports = { normalizePreset, listBuiltins, BUILTIN_PRESETS };
