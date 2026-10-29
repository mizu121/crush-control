import { LAYOUT, LAYOUT_WIDTH } from './layout.js';
import { CATEGORIES, describe, hex, FIRMWARE_RESERVED } from './keycodes.js';
import { createColorWheel } from './color-wheel.js';
import { attachBlueprintSelection } from './blueprint-selection.js';
import { attachSupportReminder } from './support-reminder.js';

const api = window.crush;
const $ = (sel) => document.querySelector(sel);

const FN_KEY = 0x5221; // MO(1)
const LAYER_NAMES = ['Base', 'Fn', 'Layer 2', 'Layer 3'];
const SWATCHES = [
  ['Red', 0, 255], ['Orange', 30, 255], ['Amber', 45, 255], ['Gold', 60, 255], ['Citrine', 80, 255], ['Lime', 100, 255], ['Green', 120, 255],
  ['Mint', 160, 255], ['Sky', 195, 255], ['Blue', 240, 255], ['Violet', 275, 255], ['Hot pink', 320, 255], ['Neon pink', 345, 255], ['White', 0, 0],
];
const COLOR_NAMES = [[15, 'Red'], [40, 'Orange'], [52, 'Amber'], [70, 'Gold'], [90, 'Citrine'], [110, 'Lime'], [150, 'Green'], [180, 'Mint'], [215, 'Sky blue'], [255, 'Blue'], [290, 'Violet'], [335, 'Hot pink'], [355, 'Neon pink'], [360, 'Red']];
let keyboardPreview = null;
let previewMode = '2d';
let previewLoading = null;
const colorWheel = createColorWheel($('#color-wheel'), change => queueLighting(change));

// How the preview animates each board effect (effect id -> [animation class, delay pattern]).
const PREVIEW = {
  0: ['fx-off'], 6: [''], 5: ['fx-pulse', 'none'],
  1: ['fx-pulse', 'sweep'], 13: ['fx-pulse', 'sweep'], 12: ['fx-pulse', 'sweep'], 16: ['fx-pulse', 'sweep'], 9: ['fx-pulse', 'sweep'],
  3: ['fx-pulse', 'radial'], 18: ['fx-pulse', 'radial'], 11: ['fx-pulse', 'radial'],
  2: ['fx-pulse', 'diagonal'], 4: ['fx-pulse', 'diagonal'],
  8: ['fx-sparkle', 'random'], 10: ['fx-sparkle', 'random'], 14: ['fx-sparkle', 'random'], 15: ['fx-sparkle', 'random'],
  7: ['fx-sparkle', 'sparse'], 17: ['fx-sparkle', 'sparse'],
};

const state = {
  view: 'lighting',
  status: { connected: false, info: null },
  effects: [],
  lastOnEffect: 6,
  lighting: { effect: 6, hueDeg: 30, sat: 255, brightness: 7, speed: 2, rainbowLocked: false },
  loaded: null,       // lighting when the app connected, for Revert
  dirty: false,
  saved: false,
  saving: false,
  applyError: null,
  connectionEpoch: 0,
  inputRevision: 0,
  ready: false,
  rgbReady: false,
  lastInput: 0,
  presets: [],
  builtinPresets: [],
  presetError: null,
  presetBusy: null,
  keymap: null,
  layer: 0,
  selected: null,     // index into LAYOUT
  changed: new Set(), // "layer:row:col" written this session
  category: 'Basic',
  search: '',
  keyPage: 0,
  signal: null,
  rgb: { supported: false, enabled: false, colors: null, rearFollowSupported: false },
  rgbTarget: 'all',
  rgbSelection: new Set(),
  rearFollowColor: null,
};

function connectionKind(status = state.status) { return status?.info?.connection === 'receiver' ? 'receiver' : 'usb'; }
function connectionKey(status) { return status?.connected ? `${connectionKind(status)}:${status.info?.deviceKey || ''}` : 'disconnected'; }
function lightingAvailable() {
  return state.status.connected && (connectionKind() === 'receiver' ? state.status.info?.supportsLighting === true : state.status.info?.supportsLighting !== false);
}
function keymapAvailable() {
  return state.status.connected && (connectionKind() === 'receiver' ? state.status.info?.supportsKeymap === true : state.status.info?.supportsKeymap !== false);
}

// ---------- helpers ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c);
  if (tag === 'button' && !node.classList.contains('key')) node.classList.add('btn');
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

// Like replaceChildren, but skips null/undefined/false (replaceChildren would print them as text).
function fill(node, ...kids) {
  node.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
}

async function call(channel, ...args) {
  const r = await api.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

let toastTimer = null;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), isError ? 4200 : 2200);
}

function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)].map((x) => Math.round(x * 255));
}

function colorName(hueDeg, sat) {
  if (sat < 40) return 'White';
  return COLOR_NAMES.find(([max]) => hueDeg < max)[1];
}

function rgbToHsv(rgb) {
  const [r, g, b] = rgb.map(value => value / 255);
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), delta = hi - lo;
  let hue = delta === 0 ? 0 : hi === r ? ((g - b) / delta) % 6 : hi === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { hueDeg: Math.round((hue * 60 + 360) % 360) % 360, sat: hi ? Math.round(delta / hi * 255) : 0, value: hi };
}

function verifiedRgbKeys() {
  if (!state.rgb.supported) return [];
  // The main process supplies the exact-firmware map. Cross-check the layout
  // identity before applying a hardware slot's color to a preview position.
  return (state.rgb.mappedKeys || state.rgb.verifiedKeys || []).filter(key => {
    const layout = LAYOUT[key.layoutIndex];
    return layout && layout.name === key.layoutName && JSON.stringify(layout.m) === JSON.stringify(key.matrix)
      && Number.isInteger(key.slot) && key.slot >= 0 && key.slot < 92
      && Array.isArray(key.slots) && key.slots.includes(key.slot)
      && key.slots.every(slot => Number.isInteger(slot) && slot >= 0 && slot < 92);
  });
}
function targetKeys() { return verifiedRgbKeys().filter(key => state.rgbSelection.has(key.slot)); }
function targetKey() { return targetKeys()[0]; }
function setRgbSelection(slots, repaint = true) {
  const allowed = new Set(verifiedRgbKeys().map(key => key.slot));
  state.rgbSelection = new Set([...slots].filter(slot => allowed.has(slot)));
  state.rgbTarget = state.rgbSelection.size === 0 ? 'all' : state.rgbSelection.size === 1 ? String([...state.rgbSelection][0]) : 'selection';
  if (repaint) renderLighting();
}
function selectRgbKey(layoutIndex, modifiers = {}) {
  if (!lightingAvailable() || !state.ready || !state.rgbReady || state.saving) return;
  const key = verifiedRgbKeys().find(key => key.layoutIndex === layoutIndex);
  if (!key) return;
  const selected = modifiers.shiftKey || modifiers.ctrlKey || modifiers.metaKey ? new Set(state.rgbSelection) : new Set();
  if (selected.has(key.slot)) selected.delete(key.slot);
  else selected.add(key.slot);
  setRgbSelection(selected);
}
function previewKeyColor(slot, rgb) {
  const key = verifiedRgbKeys().find(key => key.slot === slot);
  for (const mappedSlot of key?.slots || [slot]) state.rgb.colors[mappedSlot] = [...rgb];
}

function pickerLighting() {
  const key = targetKey();
  const rgb = key && state.rgb.enabled && state.rgb.colors?.[key.slot];
  return rgb ? { ...state.lighting, ...rgbToHsv(rgb), rainbowLocked: false }
    : state.rgb.supported && state.rgb.enabled ? { ...state.lighting, rainbowLocked: false } : state.lighting;
}

function acceptRgb(next) {
  const supported = next?.supported === true && Array.isArray(next.colors) && next.colors.length === 92
    && next.colors.every(rgb => Array.isArray(rgb) && rgb.length === 3 && rgb.every(v => Number.isInteger(v) && v >= 0 && v <= 255));
  state.rgb = supported ? { ...next, colors: next.colors.map(rgb => [...rgb]) }
    : { ...next, supported: false, enabled: false, colors: null, rearFollowSupported: false };
  if (!supported) { setRgbSelection([], false); state.rearFollowColor = null; }
  else for (const [slot, rgb] of pendingKeyColors) previewKeyColor(slot, rgb);
}

async function refreshRgb() {
  const epoch = state.connectionEpoch, revision = state.inputRevision;
  try {
    const next = await call('rgb:status');
    if (epoch !== state.connectionEpoch || revision !== state.inputRevision || !state.status.connected) return;
    acceptRgb(next);
  } catch {
    if (epoch === state.connectionEpoch) acceptRgb({ canSaveLighting: state.rgb.canSaveLighting });
  }
}

function renderRgbControls() {
  const supported = state.status.connected && state.rgb.supported;
  $('#rgb-target-control').hidden = !supported;
  $('.color-panel').classList.toggle('has-direct-rgb', supported);
  const select = $('#rgb-target');
  const keys = verifiedRgbKeys();
  const multi = state.rgbSelection.size > 1;
  const signature = `${keys.length}:${state.rgbSelection.size}`;
  if (select.dataset.signature !== signature) {
    fill(select, el('option', { value: 'all' }, 'All keys'), multi ? el('option', { value: 'selection', disabled: true }, `${state.rgbSelection.size} keys selected`) : null,
      keys.length ? el('optgroup', { label: 'Individual keys' }, keys.map(key => el('option', { value: key.slot }, key.name))) : null);
    select.dataset.signature = signature;
  }
  select.title = 'Choose a key here or click it in the preview. Key positions are mapped from the firmware.';
  select.value = state.rgbTarget;
  $('#preview-gesture').textContent = previewMode === '3d' ? 'Click a key · Drag to rotate' : supported ? 'Drag to select · Shift-click to add' : 'Keyboard layout';
  $('#selection-actions').hidden = !supported;
  $('#selection-count').textContent = state.rgbSelection.size ? `${state.rgbSelection.size} selected` : 'All keys';
  $('#btn-clear-selection').hidden = state.rgbSelection.size === 0;
  $('#btn-save').hidden = supported;
  $('#btn-save').title = !supported && state.rgb.canSaveLighting === false ? 'Firmware verification required before saving' : '';
  $('#rgb-live-note').hidden = !supported;
  $('#btn-revert').title = supported ? 'Return to onboard lighting' : 'Revert';
  $('#btn-revert').setAttribute('aria-label', supported ? 'Return to onboard lighting' : 'Revert lighting changes');
  const body = $('#rear-dialog .modal-body');
  const follow = supported && state.rgb.rearFollowSupported;
  body.querySelector('p').textContent = follow ? 'The rear lights follow the All keys color picker.' : 'These lights have their own controls on the keyboard.';
  body.querySelector('.rear-shortcuts').hidden = follow;
  body.querySelector('.rear-tip').textContent = follow ? 'Caps, Fn and other status indicators keep their normal behavior.' : 'Cycle the effect to a steady light, then choose a color.';
  body.querySelector('.rear-limit').textContent = follow
    ? 'Rear brightness and power stay at their keyboard settings. Individual key colors do not change the rear lights.'
    : 'The app cannot read or change this zone over VIA. The rear preview shows rainbow independently of the key lighting.';
}

function setFill(input) {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--fill', pct + '%');
}

// ---------- keyboard drawing ----------

function sizeBoards() {
  const stage = $('.keymap-stage');
  if (stage.clientWidth && stage.clientHeight) {
    const u = Math.min(48, (stage.clientWidth - 38) / (LAYOUT_WIDTH + .6), (stage.clientHeight - 36) / 6.85);
    $('#key-board').style.setProperty('--u', Math.max(14, u) + 'px');
  }
  const fallback = $('#board-fallback');
  if (fallback.clientWidth && fallback.clientHeight) {
    const u = Math.min((fallback.clientWidth - 28) / 18.85, (fallback.clientHeight - 20) / 6.85);
    $('#light-board').style.setProperty('--u', Math.max(14, u) + 'px');
  }
}

function drawBoard(board, { onClick } = {}) {
  fill(board);
  LAYOUT.forEach((key, i) => {
    const node = el(onClick ? 'button' : 'div', {
      class: 'key',
      'data-i': i,
      'aria-label': onClick ? key.name : undefined,
      style: {
        left: `calc(var(--u) * ${key.x + 0.3} + 2px)`,
        top: `calc(var(--u) * ${key.y + 0.3} + 2px)`,
        width: `calc(var(--u) * ${key.w} - 4px)`,
      },
      onclick: onClick ? event => onClick(i, event) : undefined,
    });
    board.append(node);
  });
}

// ---------- lighting ----------

function paintLightBoard() {
  const l = state.lighting;
  const board = $('#light-board');
  if (!l) return;
  const mappedKeys = verifiedRgbKeys();
  const selectedIndices = new Set(targetKeys().map(key => key.layoutIndex));
  keyboardPreview?.setLighting(l);
  const overrides = {};
  if (state.rgb.supported && state.rgb.enabled && l.effect === 6) {
    for (const key of mappedKeys) if (state.rgb.colors?.[key.slot]) overrides[key.layoutIndex] = state.rgb.colors[key.slot];
  }
  keyboardPreview?.setKeyColors(overrides);
  keyboardPreview?.setSelectedKey(selectedIndices.size === 1 ? [...selectedIndices][0] : -1);
  keyboardPreview?.setRearLighting(state.rgb.rearFollowSupported && state.rearFollowColor
    ? { mode: 'solid', ...state.rearFollowColor, brightness: .8 }
    : { mode: 'rainbow', brightness: .8 });
  const [cls, pattern] = PREVIEW[l.effect] || [''];
  board.className = 'board light ' + cls;
  board.style.setProperty('--dur', (3.6 - l.speed * 0.6).toFixed(2) + 's');

  const bri = l.brightness / 9;
  const [r, g, b] = hsvToRgb(l.hueDeg, l.sat / 255, 1);
  board.querySelectorAll('.key').forEach((node) => {
    const key = LAYOUT[node.dataset.i];
    const mapped = mappedKeys.find(item => item.layoutIndex === +node.dataset.i);
    node.disabled = !mapped || !state.ready || !state.rgbReady || state.saving;
    node.classList.toggle('selected', selectedIndices.has(+node.dataset.i));
    node.setAttribute('aria-pressed', String(selectedIndices.has(+node.dataset.i)));
    node.setAttribute('aria-label', mapped?.name || key.name);
    node.textContent = ({ Backspace: '⌫', Left: '←', Right: '→', Up: '↑', Down: '↓', Space: 'Space' })[key.name] || key.name;
    const cx = key.x + key.w / 2;
    const color = overrides[+node.dataset.i] || (l.rainbowLocked ? hsvToRgb((cx / LAYOUT_WIDTH) * 360, 1, 1) : [r, g, b]);
    node.style.setProperty('--r', color[0]);
    node.style.setProperty('--g', color[1]);
    node.style.setProperty('--b', color[2]);
    node.style.setProperty('--bri', bri);
    node.classList.toggle('unlit', l.effect === 0 || bri === 0 || color.every(value => value === 0));
    let delay = 0;
    if (pattern === 'sweep') delay = cx * 0.09;
    if (pattern === 'radial') delay = Math.hypot(cx - 9, (key.y - 3) * 1.4) * 0.14;
    if (pattern === 'diagonal') delay = (cx + key.y * 2) * 0.07;
    if (pattern === 'random' || pattern === 'sparse') delay = (Math.sin(+node.dataset.i * 91.7) + 1) * 2.7; // stable pseudo-random
    if (pattern === 'sparse') node.style.setProperty('--dur', '5.5s');
    else node.style.removeProperty('--dur');
    node.style.setProperty('--delay', `-${delay.toFixed(2)}s`);
  });

  document.documentElement.style.setProperty('--light-color', `rgb(${r} ${g} ${b})`);
}

function renderLighting() {
  const l = state.lighting;
  if (!l) return;
  const displayed = pickerLighting();
  const selectedKeys = targetKeys(), selectedKey = selectedKeys[0];
  const selectedOff = selectedKeys.length > 0 && state.rgb.enabled && selectedKeys.every(key => state.rgb.colors?.[key.slot]?.every(value => value === 0));
  const selectionMixed = selectedKeys.length > 1 && state.rgb.enabled && selectedKeys.some(key => state.rgb.colors[key.slot].some((value, channel) => value !== state.rgb.colors[selectedKey.slot][channel]));
  const fullFrame = !selectedKeys.length && state.rgb.supported && state.rgb.enabled && l.effect === 6 ? state.rgb.colors : null;
  const keysOff = fullFrame?.every(rgb => rgb.every(value => value === 0));
  const multicolor = fullFrame?.some(rgb => rgb.some((value, channel) => value !== fullFrame[0][channel]));
  renderRgbControls();
  const effect = state.effects.find((e) => e.id === l.effect);

  document.querySelectorAll('#effects .chip, #quick-effects .chip').forEach((c) => {
    c.classList.toggle('active', +c.dataset.id === l.effect);
    c.setAttribute('aria-pressed', String(+c.dataset.id === l.effect));
  });
  $('#fx-name').textContent = effect ? effect.name : `Effect ${l.effect}`;
  if (l.effect !== 0) state.lastOnEffect = l.effect;
  const commonEffect = [6, 5, 1, 15].includes(l.effect);
  $('#btn-all-effects span').textContent = commonEffect || l.effect === 0 ? 'All effects' : effect?.name || 'All effects';
  $('#btn-all-effects').classList.toggle('active', !commonEffect && l.effect !== 0);
  $('#btn-power').classList.toggle('active', l.effect !== 0);
  $('#btn-power').setAttribute('aria-pressed', String(l.effect !== 0));
  $('#btn-power').setAttribute('aria-label', l.effect === 0 ? 'Turn lights on' : 'Turn lights off');
  $('#btn-power').title = l.effect === 0 ? 'Turn lights on' : 'Turn lights off';
  if (selectedKey) {
    const targetName = selectedKeys.length > 1 ? `${selectedKeys.length} selected keys` : selectedKey.name;
    $('#btn-power').classList.toggle('active', !selectedOff);
    $('#btn-power').setAttribute('aria-pressed', String(!selectedOff));
    $('#btn-power').setAttribute('aria-label', `Turn ${targetName} ${selectedOff ? 'on' : 'off'}`);
    $('#btn-power').title = `Turn ${targetName} ${selectedOff ? 'on' : 'off'}`;
  }
  $('#fx-detail').textContent = l.effect === 0 ? 'lights off' : l.rainbowLocked ? 'rainbow (Fn + Enter cycle)' : `${colorName(l.hueDeg, l.sat)} · brightness ${l.brightness}/9`;

  const [r, g, b] = selectedKey && state.rgb.enabled ? state.rgb.colors[selectedKey.slot] : hsvToRgb(displayed.hueDeg, displayed.sat / 255, 1);
  const swatch = $('#color-swatch');
  swatch.style.background = selectionMixed ? 'linear-gradient(135deg,#99c8da 0 50%,#a59acb 50%)' : displayed.rainbowLocked ? 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' : `rgb(${r} ${g} ${b})`;
  swatch.style.boxShadow = `0 0 22px rgb(${r} ${g} ${b} / .12)`;
  $('#color-name').textContent = selectionMixed ? 'Mixed colors' : selectedOff ? 'Off' : keysOff ? 'Keys off' : multicolor ? 'Custom colors' : displayed.rainbowLocked ? 'Rainbow' : colorName(displayed.hueDeg, displayed.sat);
  $('#color-sub').textContent = displayed.rainbowLocked ? 'Locked by the Fn + Enter color cycle' : `Hue ${displayed.hueDeg}° · saturation ${Math.round((displayed.sat / 255) * 100)}%`;
  $('#color-hex').textContent = displayed.rainbowLocked ? 'FN + ENTER TO UNLOCK' : '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  $('#hue-val').textContent = `${displayed.hueDeg}°`;
  $('#sat-val').textContent = `${Math.round(displayed.sat / 255 * 100)}%`;
  $('#swatches').querySelectorAll('button').forEach((b) => {
    const active = !selectionMixed && !selectedOff && !displayed.rainbowLocked && +b.dataset.hue === displayed.hueDeg && +b.dataset.sat === displayed.sat;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });

  const hue = $('#hue'), sat = $('#sat'), bri = $('#bri'), spd = $('#spd');
  if (document.activeElement !== hue) hue.value = displayed.hueDeg;
  if (document.activeElement !== sat) sat.value = displayed.sat;
  if (document.activeElement !== bri) bri.value = l.brightness;
  if (document.activeElement !== spd) spd.value = l.speed;
  sat.style.setProperty('--hue-color', `hsl(${displayed.hueDeg} 100% 50%)`);
  [bri, spd].forEach(setFill);
  $('#bri-val').textContent = `${Math.round(l.brightness / 9 * 100)}%`;
  $('#spd-val').textContent = `${l.speed + 1} / 5`;
  $('#speed-field').classList.toggle('disabled', l.effect === 0 || l.effect === 6);
  $('#speed-field').hidden = l.effect === 0 || l.effect === 6;

  const s = $('#save-state');
  s.className = 'save-state ' + (state.status.connected ? state.dirty ? 'dirty' : 'clean' : 'offline');
  s.hidden = state.status.connected && state.ready && !state.dirty && !state.saved && !state.applyError;
  $('#save-label').textContent = !state.status.connected ? 'Preview mode' : !state.ready ? 'Connecting…' : state.saving ? 'Saving…' : state.applyError ? 'Update failed' : state.dirty ? 'Unsaved changes' : state.saved ? 'Saved to keyboard' : 'Lighting in sync';
  $('#save-help').textContent = !state.status.connected ? 'Connect your keyboard to apply lighting.' : state.applyError ? 'Try your change again before saving.' : state.dirty ? 'Live on your board. Save to keep it after power-off.' : state.saved ? 'Your look will stay after power-off.' : 'Save this look to keep it after power-off.';
  $('#preview-status').textContent = state.status.connected ? 'Visual approximation' : 'Offline preview';
  if (state.rgb.supported) {
    s.hidden = !state.applyError;
    $('#save-label').textContent = state.applyError ? 'Update failed' : 'Live colors';
    $('#save-help').textContent = 'Per-key colors are temporary and reset at power-off.';
    $('#preview-status').textContent = 'Key positions follow the firmware map. Preview colors are approximate.';
  } else if (state.status.connected && state.rgb.canSaveLighting === false) {
    s.hidden = false;
    $('#save-label').textContent = state.applyError ? 'Update failed' : 'Firmware verification required';
    $('#save-help').textContent = 'Saving is unavailable until the connected firmware is verified.';
  }
  if (state.status.connected && !lightingAvailable()) {
    s.hidden = false;
    $('#save-label').textContent = connectionKind() === 'receiver' ? 'Link receiver in Settings' : 'Lighting unavailable';
    $('#save-help').textContent = 'A compatible linked receiver is required for wireless lighting.';
  }
  updateControls();

  paintLightBoard();
  renderBanners();
}

// Batches slider movement into one write every ~45 ms.
const pending = {};
const pendingKeyColors = new Map();
let flushTimer = null;
let writing = false;
let activeWrite = Promise.resolve();

function updateControls() {
  const unavailable = !lightingAvailable() || !state.ready || !state.rgbReady || state.saving;
  const keymapUnavailable = !keymapAvailable() || !state.ready || state.saving;
  document.querySelectorAll('#effects button, #quick-effects button, #btn-power, #hue, #sat, #bri, #spd, #btn-save, #btn-revert, #btn-backup, #btn-restore, #hex-form button, #hex-input, #kc-search').forEach(n => n.disabled = unavailable);
  $('#starter-looks').querySelectorAll('button').forEach(button => {
    const needsPerKey = button.dataset.kind === 'per-key' && !state.rgb.supported;
    button.disabled = unavailable || needsPerKey;
    button.title = needsPerKey ? 'Requires per-key firmware' : button.dataset.description;
  });
  const colorLocked = unavailable || (!state.rgb.supported && state.lighting?.rainbowLocked);
  document.querySelectorAll('#hue, #sat, #swatches button').forEach(n => n.disabled = colorLocked);
  colorWheel.update(pickerLighting(), colorLocked);
  $('#rgb-target').disabled = unavailable;
  $('#spd').disabled = unavailable || state.lighting?.effect === 0 || state.lighting?.effect === 6;
  $('#btn-revert').disabled = unavailable || !state.loaded || !state.dirty;
  $('#btn-revert').hidden = !state.dirty;
  $('#btn-save').disabled = unavailable || connectionKind() === 'receiver' || !!state.applyError || state.rgb.supported || state.rgb.canSaveLighting === false;
  document.querySelectorAll('#btn-backup, #btn-restore, #backup-list, #hex-form button, #hex-input, #kc-search, #layers button, #key-board button').forEach(n => n.disabled = keymapUnavailable);
  $('.picker').inert = keymapUnavailable || !state.keymap || state.selected === null || keyCode(state.selected) === FIRMWARE_RESERVED;
  $('.picker').classList.toggle('disabled', $('.picker').inert);
  if (keymapUnavailable) { $('#kc-prev').disabled = true; $('#kc-next').disabled = true; }
  $('#layers').hidden = !state.keymap;
  $('#keymap-connection-note').hidden = !state.status.connected || keymapAvailable();
  $('#keymap-connection-note').textContent = `Use USB to edit, back up or restore keys.${lightingAvailable() ? ' Lighting controls work over the linked dongle.' : ''}`;
  $('#view-keymap .heading-note').textContent = state.status.connected && !keymapAvailable() ? 'USB required' : 'Choose a key to edit its function';
  $('#view-keymap').classList.toggle('keymap-unavailable', state.status.connected && !keymapAvailable());
  const savedPreset = state.presets.find(preset => preset.name === $('#presets').value);
  $('#btn-apply-preset').disabled = unavailable || !savedPreset || (savedPreset.kind === 'per-key' && !state.rgb.supported);
  $('#btn-apply-preset').title = savedPreset?.kind === 'per-key' && !state.rgb.supported ? 'Requires per-key firmware' : 'Apply saved preset';
  $('#btn-delete-preset').disabled = state.saving || !savedPreset;
  $('#presets').disabled = state.saving;
  $('#btn-new-preset').disabled = unavailable;
  $('#preset-form button[type="submit"]').disabled = unavailable;
  $('#preset-name').disabled = state.saving;
  $('#btn-close-preset').disabled = state.saving;
  $('#btn-cancel-preset').disabled = state.saving;
  $('#btn-close-looks').disabled = state.saving;
  $('#preset-form button[type="submit"]').textContent = state.presetBusy === 'save' ? 'Saving…' : 'Save preset';
  $('#preset-message').textContent = state.presetError || (state.presetBusy === 'apply' ? 'Applying preset…' : state.rgb.supported ? 'Choose a look, then click any key to make it yours.' : 'Per-key looks require the custom firmware.');
  $('#preset-message').classList.toggle('error', Boolean(state.presetError));
  $('#preset-save-error').textContent = state.presetError || '';
  $('#preset-save-error').hidden = !state.presetError;
  $('#preset-storage-note').textContent = state.rgb.supported ? 'Saves your key colors and brightness on this PC.' : 'Saves your lighting settings on this PC.';
  $('#preview-mode').textContent = previewMode === '3d' ? '3D preview' : '2D keyboard layout';
  $('#btn-select-all-keys').disabled = unavailable || !state.rgb.supported;
  $('#btn-clear-selection').disabled = unavailable;
}

function queueLighting(change) {
  if (!lightingAvailable() || !state.ready || !state.rgbReady || state.saving) return;
  if (targetKey() && Object.keys(change).every(key => key === 'hueDeg' || key === 'sat')) {
    const next = { ...pickerLighting(), ...change };
    queueKeyRgb(hsvToRgb(next.hueDeg, next.sat / 255, 1));
    return;
  }
  // Effects and presets apply to the board. A selected key only scopes color
  // and its power button; brightness/speed remain board-wide controls.
  if ('effect' in change) setRgbSelection([], false);
  if (!state.rgb.supported && state.lighting.rainbowLocked && ('hueDeg' in change || 'sat' in change)) {
    toast('Press Fn + Enter once to leave rainbow mode, then choose your color.');
    return;
  }
  Object.assign(state.lighting, change);
  if ('hueDeg' in change || 'sat' in change || ('effect' in change && change.effect !== 6)) pendingKeyColors.clear();
  if ('hueDeg' in change || 'sat' in change) {
    change = { ...change, hueDeg: state.lighting.hueDeg, sat: state.lighting.sat };
  }
  Object.assign(pending, change);
  state.dirty = true;
  state.saved = false;
  state.lastInput = Date.now();
  state.inputRevision++;
  renderLighting();
  if (!flushTimer) flushTimer = setTimeout(() => flushLighting().catch(() => {}), 45);
}

function queueKeyRgb(rgb) {
  const keys = targetKeys();
  if (!keys.length || !lightingAvailable() || !state.ready || !state.rgbReady || state.saving) return;
  for (const key of keys) {
    pendingKeyColors.set(key.slot, [...rgb]);
    previewKeyColor(key.slot, rgb);
  }
  state.rgb.enabled = true;
  state.lighting.effect = 6;
  state.dirty = true; state.saved = false;
  state.lastInput = Date.now(); state.inputRevision++;
  renderLighting();
  if (!flushTimer) flushTimer = setTimeout(() => flushLighting().catch(() => {}), 45);
}

async function flushLighting() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (writing) {
    await activeWrite;
    if (Object.keys(pending).length || pendingKeyColors.size) return flushLighting();
    return;
  }
  const change = { ...pending };
  const keyChanges = [...pendingKeyColors].map(([slot, rgb]) => [slot, [...rgb]]);
  pendingKeyColors.clear();
  for (const k of Object.keys(pending)) delete pending[k];
  if (!Object.keys(change).length && !keyChanges.length) return;
  if (!state.status.connected) return;
  const epoch = state.connectionEpoch;
  writing = true;
  activeWrite = (async () => {
    try {
      if (Object.keys(change).length) {
        await call('lighting:set', change);
        if (epoch === state.connectionEpoch && state.rgb.rearFollowSupported && ('hueDeg' in change || 'sat' in change)) {
          state.rearFollowColor = { hueDeg: change.hueDeg, sat: change.sat };
        }
      }
      if (keyChanges.length) {
        if (epoch !== state.connectionEpoch || !state.status.connected) return;
        const next = await call('rgb:set-keys', { changes: keyChanges.map(([slot, rgb]) => ({ slot, rgb })) });
        if (epoch === state.connectionEpoch) acceptRgb(next);
      }
      if (state.rgb.supported && !keyChanges.length && epoch === state.connectionEpoch) await refreshRgb();
      if (epoch === state.connectionEpoch) state.applyError = null;
    } catch (err) {
      if (epoch === state.connectionEpoch && state.status.connected) {
        state.applyError = err.message;
        // Preserve failed fields so the next user edit retries the complete look.
        const newer = { ...pending };
        Object.assign(pending, change, newer);
        const boardSupersedesKeys = 'hueDeg' in newer || 'sat' in newer || ('effect' in newer && newer.effect !== 6);
        if (!boardSupersedesKeys) for (const [slot, rgb] of keyChanges) if (!pendingKeyColors.has(slot)) pendingKeyColors.set(slot, rgb);
        toast(err.message, true);
      }
      throw err;
    } finally {
      writing = false;
      renderLighting();
    }
  })();
  await activeWrite;
}

async function refreshLighting() {
  if (!state.status.connected || state.saving || writing || flushTimer || state.applyError || Date.now() - state.lastInput < 1500) return;
  const epoch = state.connectionEpoch;
  const revision = state.inputRevision;
  try {
    const l = await call('lighting:get');
    if (epoch !== state.connectionEpoch || revision !== state.inputRevision || !state.status.connected || state.saving) return;
    if (state.saved && ['effect', 'brightness', 'speed', 'hueDeg', 'sat', 'rainbowLocked'].some(k => l[k] !== state.loaded?.[k])) state.saved = false;
    state.lighting = l;
    state.ready = true;
    if (!state.loaded) state.loaded = { ...l };
    renderLighting();
  } catch {}
}

function setupLighting() {
  const glyphs = { 0:'power',6:'solid',5:'breathe',1:'wave',13:'bar',2:'cloud',3:'vortex',4:'mix',8:'stone',9:'laser',10:'starry',11:'flowers',12:'traverse',14:'meteor',15:'rain',16:'scan',18:'spread',7:'keyboard',17:'trigger' };
  fill($('#effects'), 
    ...state.effects.map((e) => el('button', { class: 'chip', 'data-id': e.id, title: e.name, 'aria-label': e.name, onclick: () => { queueLighting({ effect: e.id }); $('#effects-dialog').close(); } }, icon(glyphs[e.id] || 'solid'), el('span', {}, e.name))),
  );
  fill($('#quick-effects'), ...[6, 5, 1, 15].map(id => {
    const e = state.effects.find(effect => effect.id === id);
    return el('button', { class: 'chip', 'data-id': id, 'aria-label': e.name, onclick: () => queueLighting({ effect: id }) }, icon(glyphs[id]), el('span', {}, e.name));
  }));
  fill($('#swatches'), 
    ...SWATCHES.filter(([name]) => ['Red', 'Orange', 'Green', 'Sky', 'Violet', 'White'].includes(name)).map(([name, hue, sat]) => {
      const [r, g, b] = hsvToRgb(hue, sat / 255, 1);
      return el('button', { title: name, 'aria-label': name, 'data-hue': hue, 'data-sat': sat, style: { background: `rgb(${r} ${g} ${b})` }, onclick: () => queueLighting({ hueDeg: hue, sat }) });
    }),
  );
}

$('#hue').addEventListener('input', (e) => queueLighting({ hueDeg: +e.target.value }));
$('#rgb-target').addEventListener('change', e => {
  const key = verifiedRgbKeys().find(key => String(key.slot) === e.target.value);
  setRgbSelection(key ? [key.slot] : []);
});
$('#sat').addEventListener('input', (e) => queueLighting({ sat: +e.target.value }));
$('#bri').addEventListener('input', (e) => queueLighting({ brightness: +e.target.value }));
$('#spd').addEventListener('input', (e) => queueLighting({ speed: +e.target.value }));
$('#btn-power').addEventListener('click', () => {
  const keys = targetKeys();
  if (keys.length) {
    const allOff = state.rgb.enabled && keys.every(key => state.rgb.colors[key.slot].every(value => value === 0));
    queueKeyRgb(allOff ? [255, 255, 255] : [0, 0, 0]);
  }
  else queueLighting({ effect: state.lighting.effect === 0 ? state.lastOnEffect : 0 });
});
$('#btn-all-effects').addEventListener('click', () => $('#effects-dialog').showModal());
$('#btn-close-effects').addEventListener('click', () => $('#effects-dialog').close());
$('#btn-open-looks').addEventListener('click', () => $('#looks-dialog').showModal());
$('#btn-close-looks').addEventListener('click', () => $('#looks-dialog').close());

$('#btn-save').addEventListener('click', async () => {
  if (!lightingAvailable() || connectionKind() === 'receiver' || !state.ready || !state.rgbReady || state.saving || state.applyError || state.rgb.supported || state.rgb.canSaveLighting === false) return;
  const epoch = state.connectionEpoch;
  state.saving = true;
  renderLighting();
  try {
    await flushLighting();
    if (state.applyError) throw new Error(state.applyError);
    if (!state.status.connected || epoch !== state.connectionEpoch) throw new Error('Keyboard disconnected before saving.');
    await call('lighting:save');
    if (!state.status.connected || epoch !== state.connectionEpoch) throw new Error('Keyboard disconnected. Reconnect and check the saved lighting.');
    state.loaded = { ...state.lighting };
    state.dirty = false;
    state.saved = true;
    toast('Saved to the keyboard. It will keep this lighting after power-off.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.saving = false;
    renderLighting();
  }
});

$('#btn-revert').addEventListener('click', async () => {
  if (!lightingAvailable() || state.saving || !state.loaded) return;
  if (state.rgb.supported) {
    const epoch = state.connectionEpoch;
    state.saving = true;
    renderLighting();
    try {
      await flushLighting();
      if (epoch !== state.connectionEpoch || !state.status.connected) return;
      const next = await call('rgb:release');
      if (epoch !== state.connectionEpoch || !state.status.connected) return;
      acceptRgb(next);
      setRgbSelection([], false);
      const lighting = await call('lighting:get');
      if (epoch !== state.connectionEpoch || !state.status.connected) return;
      state.lighting = lighting;
      if (state.rearFollowColor) state.rearFollowColor = { hueDeg: state.lighting.hueDeg, sat: state.lighting.sat };
      state.dirty = false; state.saved = false; state.applyError = null;
      toast('Onboard lighting restored.');
    } catch (err) { if (epoch === state.connectionEpoch) state.applyError = err.message; toast(err.message, true); }
    finally { state.saving = false; await recoverAfterPresetReconnect(epoch); renderLighting(); }
    return;
  }
  const { effect, brightness, speed, hueDeg, sat } = state.loaded;
  if (state.lighting.rainbowLocked || state.loaded.rainbowLocked) {
    queueLighting({ effect, brightness, speed });
    if (!state.lighting.rainbowLocked) toast('Effect and intensity restored. Use Fn + Enter on the keyboard to restore its rainbow color.');
  } else queueLighting({ effect, brightness, speed, hueDeg, sat });
});

// ---------- presets ----------

function renderPresets() {
  $('.saved-presets').hidden = !state.presets.length;
  const selected = $('#presets').value;
  fill($('#starter-looks'), ...state.builtinPresets.map(p => {
    const swatches = Array.isArray(p.swatches) && p.swatches.length ? p.swatches : ['#444b50'];
    return el('button', { class: 'preset', 'data-builtin-id': p.id, 'data-kind': p.kind, 'data-description': p.description,
      title: p.description, 'aria-label': `Apply ${p.name}`, onclick: () => applyPreset({ builtinId: p.id }, p.name) },
      el('span', { class: 'preset-strip', 'aria-hidden': 'true' }, swatches.map(color => el('i', { style: { background: color } }))),
      el('span', { class: 'preset-card-name' }, p.name),
      el('span', { class: 'preset-card-detail' }, p.description));
  }));
  fill($('#presets'), el('option', { value: '' }, state.presets.length ? 'Saved presets' : 'No presets'),
    ...state.presets.map(p => el('option', { value: p.name }, p.name + (p.kind === 'per-key' ? ' · per key' : ''))));
  if (state.presets.some(p => p.name === selected)) $('#presets').value = selected;
  else if (state.presets.length) $('#presets').value = state.presets.at(-1).name;
  updateControls();
}

async function applyPreset(reference, name) {
  if (!lightingAvailable() || !state.ready || !state.rgbReady || state.saving) return;
  const epoch = state.connectionEpoch;
  state.saving = true;
  state.presetBusy = 'apply';
  state.presetError = null;
  state.inputRevision++;
  updateControls();
  try {
    // Finish an already queued edit before replacing the full look. New edits
    // are blocked until the backend's whole-frame upload and readback finish.
    await flushLighting();
    if (epoch !== state.connectionEpoch || !state.status.connected) throw new Error('Keyboard connection changed. Reconnect before applying a preset.');
    const result = await call('presets:apply', reference);
    if (epoch !== state.connectionEpoch || !state.status.connected) throw new Error('Keyboard connection changed while applying the preset.');
    state.lighting = result.lighting;
    acceptRgb(result.rgb);
    setRgbSelection([], false);
    state.rearFollowColor = state.rgb.rearFollowSupported ? { hueDeg: result.lighting.hueDeg, sat: result.lighting.sat } : null;
    state.dirty = true;
    state.saved = false;
    state.applyError = null;
    state.lastInput = Date.now();
    $('#looks-dialog').close();
    toast(`${name} applied.`);
  } catch (err) {
    if (epoch === state.connectionEpoch) {
      state.presetError = err.message;
      state.applyError = err.message;
    }
    toast(err.message, true);
  } finally {
    state.saving = false;
    state.presetBusy = null;
    await recoverAfterPresetReconnect(epoch);
    renderLighting();
  }
}

async function recoverAfterPresetReconnect(epoch) {
  if (epoch === state.connectionEpoch || !state.status.connected) return;
  // The reconnect may have arrived while the preset lock suppressed polling.
  // Resume reads for the new connection without carrying an old failure over.
  state.applyError = null;
  state.presetError = null;
  await refreshLighting();
  await refreshRgb();
  state.rgbReady = state.status.connected;
}

$('#presets').addEventListener('change', updateControls);
$('#btn-new-preset').addEventListener('click', () => {
  if (!lightingAvailable() || !state.ready || !state.rgbReady || state.saving) return;
  state.presetError = null;
  updateControls();
  $('#looks-dialog').close();
  $('#preset-dialog').showModal();
  $('#preset-name').focus();
});
$('#btn-close-preset').addEventListener('click', () => $('#preset-dialog').close());
$('#btn-cancel-preset').addEventListener('click', () => $('#preset-dialog').close());
$('#preset-dialog').addEventListener('close', () => {
  $('#looks-dialog').showModal();
  $('#btn-new-preset').focus();
});
for (const dialog of [$('#looks-dialog'), $('#preset-dialog')]) dialog.addEventListener('cancel', event => {
  if (state.saving) event.preventDefault();
});
$('#btn-apply-preset').addEventListener('click', () => {
  const preset = state.presets.find(p => p.name === $('#presets').value);
  if (preset) applyPreset(preset.name, preset.name);
});
$('#btn-delete-preset').addEventListener('click', () => {
  if ($('#presets').value) deletePreset($('#presets').value);
});

async function deletePreset(name) {
  if (state.saving) return;
  try {
    await call('presets:delete', name);
  } catch (err) {
    toast(err.message, true);
  }
}

$('#preset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#preset-name').value.trim();
  if (!name || !state.lighting || !lightingAvailable() || !state.ready || !state.rgbReady || state.saving) return;
  const epoch = state.connectionEpoch;
  state.saving = true;
  state.presetBusy = 'save';
  state.presetError = null;
  state.inputRevision++;
  updateControls();
  try {
    await flushLighting();
    if (epoch !== state.connectionEpoch || !state.status.connected) throw new Error('Keyboard connection changed. Reconnect before saving.');
    // Capture the verified hardware state, not the optimistic preview or a
    // single native hue that would discard individual key colors.
    await call('presets:save', { name, capture: true });
    $('#preset-name').value = '';
    $('#preset-dialog').close();
    toast(`“${name}” saved on this PC.`);
  } catch (err) {
    if (epoch === state.connectionEpoch) state.presetError = err.message;
    toast(err.message, true);
  } finally {
    state.saving = false;
    state.presetBusy = null;
    await recoverAfterPresetReconnect(epoch);
    updateControls();
  }
});

api.on('presets', (list) => {
  state.presets = list;
  renderPresets();
});
api.on('lighting:changed', result => {
  // Tray presets use the same backend path. Never let an external response
  // replace a newer local color input or the direct response we're awaiting.
  if (!state.status.connected || state.saving || writing || flushTimer || Object.keys(pending).length || pendingKeyColors.size) return;
  state.inputRevision++;
  state.lighting = result.lighting;
  acceptRgb(result.rgb);
  setRgbSelection([], false);
  state.rearFollowColor = state.rgb.rearFollowSupported ? { hueDeg: result.lighting.hueDeg, sat: result.lighting.sat } : null;
  state.dirty = true;
  state.saved = false;
  state.applyError = null;
  state.lastInput = Date.now();
  renderLighting();
});

// ---------- keymap ----------

function keyCode(i, layer = state.layer) {
  const [row, col] = LAYOUT[i].m[0];
  return state.keymap[layer][row][col];
}

function renderKeymap() {
  if (!state.keymap) return;
  const layers = state.keymap.length;
  fill($('#layers'), 
    ...Array.from({ length: layers }, (_, l) => el('button', {
      class: l === state.layer ? 'active' : '',
      onclick: () => { state.layer = l; renderKeymap(); },
    }, `${l} · ${LAYER_NAMES[l] || 'Layer ' + l}`)),
  );

  $('#key-board').querySelectorAll('.key').forEach((node) => {
    const i = +node.dataset.i;
    const key = LAYOUT[i];
    const code = keyCode(i);
    const d = describe(code);
    const changed = key.m.some(([r, c]) => state.changed.has(`${state.layer}:${r}:${c}`));
    node.className = 'key'
      + (['Esc', 'Enter', 'Space'].includes(key.name) ? ' accent-key' : '')
      + (i === state.selected ? ' selected' : '')
      + (code === FIRMWARE_RESERVED ? ' locked' : '')
      + (code <= 1 ? ' dim' : '')
      + (changed ? ' changed' : '');
    node.title = `${key.name}: ${d.label}`;
    node.setAttribute('aria-label', `${key.name}: ${d.label}`);
    node.setAttribute('aria-pressed', String(i === state.selected));
    fill(node, el('span', {}, d.short), d.short !== key.name && key.w >= 1 ? el('span', { class: 'sub' }, key.name) : null);
  });

  renderKeyInfo();
  renderPicker();
  updateControls();
}

function renderKeyInfo() {
  const box = $('#key-info');
  if (!keymapAvailable()) {
    fill(box, el('h3', {}, 'Key mapping'), el('p', { class: 'muted' }, 'Connect by USB to edit your keys.'));
    return;
  }
  if (state.selected === null || !state.keymap) {
    fill(box, el('h3', {}, 'Key'), el('p', { class: 'muted' }, 'Click a key on the keyboard to change what it does on this layer.'));
    return;
  }
  const key = LAYOUT[state.selected];
  const code = keyCode(state.selected);
  const d = describe(code);
  fill(box, 
    el('h3', {}, `${key.name} · layer ${state.layer}`),
    el('div', { class: 'big' }, d.label),
    d.desc ? el('div', { class: 'muted small' }, d.desc) : null,
    el('dl', {},
      el('dt', {}, 'Keycode'), el('dd', {}, hex(code)),
      el('dt', {}, 'Matrix'), el('dd', {}, key.m.map(([r, c]) => `r${r} c${c}`).join(', '))),
    code === FIRMWARE_RESERVED ? el('div', { class: 'warn' }, 'This key is a built-in firmware function on this layer, so it stays locked.') : null,
    state.layer === 0 && code === FN_KEY ? el('div', { class: 'warn' }, "This is your Fn key. Remapping it cuts off the Fn layer (Bluetooth, lighting and media shortcuts).") : null,
  );
}

function renderPicker() {
  const picker = $('.picker');
  if (!state.keymap || !keymapAvailable()) { picker.inert = true; return; }
  const locked = state.selected === null || keyCode(state.selected) === FIRMWARE_RESERVED;
  picker.classList.toggle('disabled', locked);

  fill($('#kc-cats'), 
    ...CATEGORIES.map((c) => el('button', {
      class: c.name === state.category && !state.search ? 'active' : '',
      onclick: () => { state.category = c.name; state.search = ''; state.keyPage = 0; $('#kc-search').value = ''; renderPicker(); },
    }, c.name)),
  );

  const q = state.search.toLowerCase();
  const keys = q
    ? CATEGORIES.flatMap((c) => c.keys).filter((k) => [k.label, k.short, k.desc, hex(k.code)].some((s) => s.toLowerCase().includes(q)))
    : CATEGORIES.find((c) => c.name === state.category).keys;
  const current = state.selected === null ? null : keyCode(state.selected);
  const grid = $('#kc-grid');
  const cols = Math.max(1, Math.floor((grid.clientWidth - 1) / 87));
  const rows = Math.max(1, Math.floor((grid.clientHeight - 1) / 53));
  const pageSize = cols * rows;
  const pages = Math.max(1, Math.ceil(keys.length / pageSize));
  state.keyPage = Math.min(state.keyPage, pages - 1);
  const start = state.keyPage * pageSize;

  fill(grid, 
    ...keys.slice(start, start + pageSize).map((k) => el('button', {
      class: 'kc' + (k.code === current ? ' current' : ''),
      title: k.desc || k.label,
      onclick: () => assign(k.code),
    }, el('span', { class: 's' }, k.short || '∅'), el('span', { class: 'l' }, k.label))),
  );
  $('#kc-page-info').textContent = keys.length ? `${start + 1}–${Math.min(start + pageSize, keys.length)} of ${keys.length}` : 'No matching functions';
  $('#kc-prev').disabled = state.keyPage === 0;
  $('#kc-next').disabled = state.keyPage >= pages - 1;
}

$('#kc-prev').addEventListener('click', () => { state.keyPage = Math.max(0, state.keyPage - 1); renderPicker(); });
$('#kc-next').addEventListener('click', () => { state.keyPage++; renderPicker(); });
const pickerResizeObserver = new ResizeObserver(() => { if (state.keymap && state.view === 'keymap') renderPicker(); });
pickerResizeObserver.observe($('#kc-grid'));

async function assign(code) {
  if (!keymapAvailable() || state.saving || state.selected === null || !state.keymap) return;
  const i = state.selected;
  const key = LAYOUT[i];
  const layer = state.layer;
  const epoch = state.connectionEpoch;
  const before = keyCode(i);
  if (before === FIRMWARE_RESERVED || before === code) return;
  if (state.layer === 0 && before === FN_KEY && !confirm('This is your Fn key. Without it you lose the Fn layer (Bluetooth, lighting, media). Remap it anyway?')) return;
  try {
    await call('keymap:set', { layer, positions: key.m, code });
    if (epoch !== state.connectionEpoch || !keymapAvailable() || !state.keymap) return;
    for (const [r, c] of key.m) {
      state.keymap[layer][r][c] = code;
      state.changed.add(`${layer}:${r}:${c}`);
    }
    toast(`${key.name} on layer ${layer} is now ${describe(code).label}`);
    renderKeymap();
  } catch (err) {
    if (epoch === state.connectionEpoch) toast(`Couldn't remap: ${err.message}`, true);
  }
}

$('#kc-search').addEventListener('input', (e) => {
  state.search = e.target.value.trim();
  state.keyPage = 0;
  renderPicker();
});

$('#hex-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const m = /^(0x)?([0-9a-f]{1,4})$/i.exec($('#hex-input').value.trim());
  const code = m ? parseInt(m[2], 16) : NaN;
  if (Number.isNaN(code) || code === FIRMWARE_RESERVED) return toast('Enter a hex keycode like 0x0029', true);
  assign(code);
});

async function loadKeymap() {
  if (!keymapAvailable()) return;
  const epoch = state.connectionEpoch;
  try {
    const map = await call('keymap:read');
    if (epoch !== state.connectionEpoch || !keymapAvailable()) return;
    state.keymap = map;
    renderKeymap();
    loadBackups();
  } catch (err) {
    if (epoch === state.connectionEpoch) toast(`Couldn't read the keymap: ${err.message}`, true);
  }
}

async function loadBackups() {
  const list = await call('keymap:backups');
  fill($('#backup-list'), 
    ...(list.length
      ? list.map((b) => el('option', { value: b.name }, new Date(b.time).toLocaleString()))
      : [el('option', { value: '' }, 'No backups yet')]),
  );
}

$('#btn-backup').addEventListener('click', async () => {
  if (!keymapAvailable() || state.saving) return;
  try {
    await call('keymap:backup');
    await loadBackups();
    toast('Keymap backed up.');
  } catch (err) {
    toast(err.message, true);
  }
});

$('#btn-restore').addEventListener('click', async () => {
  if (!keymapAvailable() || state.saving) return;
  const name = $('#backup-list').value;
  if (!name || !confirm('Restore this keymap backup? Keys that differ from it will be rewritten.')) return;
  try {
    const changed = await call('keymap:restore', name);
    state.changed.clear();
    await loadKeymap();
    toast(changed ? `Restored: ${changed} key positions rewritten.` : 'Already matches that backup.');
  } catch (err) {
    toast(err.message, true);
  }
});

$('#btn-open-backups').addEventListener('click', () => call('backups:open'));

// ---------- SignalRGB ----------

async function loadSignal() {
  try {
    state.signal = await call('signalrgb:status');
  } catch {
    state.signal = null;
  }
  renderSignal();
  renderBanners();
}

function renderSignal() {
  const s = state.signal;
  if (!s) return;
  const item = (ok, text, detail) => el('li', { class: ok ? 'ok' : 'bad' }, el('span', { class: 'dot' }), text, el('span', { class: 'muted' }, detail));
  fill($('#srgb-checks'), 
    item(s.running, 'SignalRGB', s.running ? 'running' : 'not running'),
    item(s.installed, 'Crush 80 plugin', s.installed ? 'installed' : 'not installed'),
    item(s.installed && s.current, 'Plugin version', !s.installed ? '—' : s.current ? 'up to date' : 'older copy installed'),
  );
}

$('#btn-srgb-refresh').addEventListener('click', loadSignal);
$('#btn-install').addEventListener('click', async () => {
  const notice = $('#srgb-notice');
  try {
    const r = await call('signalrgb:install');
    notice.hidden = false;
    notice.textContent = r.copied
      ? 'Installed. Restart SignalRGB (tray icon → Exit, then open it again) to load the plugin.'
      : 'Windows blocked the copy (Controlled Folder Access protects Documents), so two Explorer windows were opened. Drag Wobkey_Crush80_VIA_Sync.js into the Plugins folder, then restart SignalRGB.';
    loadSignal();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- banners / settings / status ----------

function renderBanners() {
  const out = [];
  const s = state.signal;
  if (state.view === 'lighting' && state.status.connected) {
    if (!lightingAvailable()) out.push(el('div', { class: 'banner info' }, el('b', {}, connectionKind() === 'receiver' ? 'Link your dongle.' : 'Lighting unavailable.'), state.status.info?.rgb?.reason || 'Connect by USB and link your paired receiver in Settings to enable lighting.'));
    if (s && s.running && s.installed) {
      out.push(el('div', { class: 'banner info' }, el('b', {}, 'SignalRGB is active.'), 'Quit SignalRGB to control lighting here.'));
    }
    if (state.lighting && state.lighting.rainbowLocked && !state.rgb.supported) {
      out.push(el('div', { class: 'banner' }, el('b', {}, 'Rainbow lock.'), 'Press Fn + Enter once to enable color changes.'));
    }
  }
  fill($('#banners'), ...out);
}

function renderSettings() {
  const info = state.status.info;
  const rows = info
    ? [['Connection', connectionKind() === 'receiver' ? '2.4 GHz · experimental' : 'USB'], ['USB ID', connectionKind() === 'receiver' ? '320F:5088' : '320F:5055'], ['VIA protocol', info.protocol ?? '—'], ['Layers', info.layers ?? '—'], ['Macro slots', info.macros ?? '—'], ['Matrix', Number.isInteger(info.rows) && Number.isInteger(info.cols) ? `${info.rows} × ${info.cols}` : '—']]
    : [['Status', 'Not connected']];
  fill($('#device-info'), ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))]));
}

function renderBattery() {
  const battery = state.status.battery;
  const known = battery?.source === 'windows-bluetooth' && Number.isInteger(battery.percent) && battery.percent >= 0 && battery.percent <= 100;
  const timestamp = battery?.updatedAt ? new Date(battery.updatedAt) : null;
  const validTime = timestamp && Number.isFinite(timestamp.getTime());
  // RGB connectivity and Bluetooth telemetry are independent. A live Bluetooth
  // battery report can remain fresh while USB/receiver lighting is offline.
  const stale = battery?.stale !== false || !validTime;
  const node = $('#battery-status');
  node.dataset.state = known ? stale ? 'stale' : 'fresh' : state.status.connected ? 'unknown' : 'offline';
  node.dataset.low = String(Boolean(known && !stale && battery.percent <= 20));
  node.dataset.charging = String(Boolean(known && !stale && battery.charging === true));
  $('#battery-label').textContent = known ? `${battery.percent}%${stale ? ' · last known' : ''}` : 'Battery —';
  $('#battery-fill').setAttribute('width', known ? String(13 * battery.percent / 100) : '0');
  $('.battery-clock').toggleAttribute('hidden', !known || !stale);
  const detail = known
    ? `Last reported ${battery.percent}% via Bluetooth; updated ${validTime ? timestamp.toLocaleString() : 'time unavailable'}${battery.charging === true ? '; charging when reported' : ''}`
    : 'Battery level unavailable. No verified battery report has been received.';
  node.title = detail;
  node.setAttribute('aria-label', detail);
}

let receiverLink = null, receiverRequest = 0, receiverLoading = false, receiverLinking = false, receiverError = '';
function renderReceiverLink() {
  $('#receiver-link-state').textContent = receiverLinking ? 'Linking…' : receiverLoading ? 'Checking…' : receiverLink?.linked ? 'Linked on this PC' : receiverLink ? 'Not linked' : 'Unavailable';
  $('#receiver-link-reason').textContent = receiverLink?.linked
    ? 'Experimental lighting over your linked receiver. The link is saved on this PC.'
    : receiverLink?.reason || 'Connect this Crush 80 Pro by USB and insert its paired dongle once.';
  $('#btn-link-receiver').disabled = receiverLoading || receiverLinking || !receiverLink?.canLink || Boolean(receiverLink?.linked);
  $('#btn-link-receiver').textContent = receiverLinking ? 'Linking…' : receiverLink?.linked ? 'Linked' : 'Link your dongle';
  $('#btn-refresh-receiver').disabled = receiverLoading || receiverLinking;
  $('#receiver-link-error').hidden = !receiverError;
  $('#receiver-link-error').textContent = receiverError;
}
async function refreshReceiverLink() {
  if (state.view !== 'settings') return;
  const request = ++receiverRequest;
  receiverLoading = true;
  receiverError = '';
  renderReceiverLink();
  try {
    const result = await call('receiver:status');
    if (request === receiverRequest && state.view === 'settings') receiverLink = result;
  } catch (error) {
    if (request === receiverRequest && state.view === 'settings') { receiverLink = null; receiverError = error.message; }
  } finally {
    if (request === receiverRequest) { receiverLoading = false; if (state.view === 'settings') renderReceiverLink(); }
  }
}
$('#btn-refresh-receiver').addEventListener('click', refreshReceiverLink);
$('#btn-link-receiver').addEventListener('click', async () => {
  if (receiverLoading || receiverLinking || !receiverLink?.canLink || receiverLink.linked) return;
  const epoch = state.connectionEpoch;
  receiverLinking = true;
  receiverError = '';
  renderReceiverLink();
  try { await call('receiver:link'); }
  catch (error) {
    if (epoch === state.connectionEpoch && state.view === 'settings') receiverError = error.message;
  } finally {
    receiverLinking = false;
    if (state.view === 'settings') {
      if (receiverError) renderReceiverLink();
      else await refreshReceiverLink();
    }
  }
});

$('#login-toggle').addEventListener('change', (e) => call('settings:set', { openAtLogin: e.target.checked }).catch((err) => toast(err.message, true)));

// App updates never change keyboard firmware. Only explicit button actions can
// check, download or restart; notifications update the UI without opening it.
const UPDATE_PHASES = new Set(['disabled', 'store-managed', 'idle', 'checking', 'available', 'up-to-date', 'downloading', 'downloaded', 'installing', 'error']);
let appUpdate = null, updateRevision = -1, updateEvent = 0, updateRequest = 0;
let updateReading = false, updateAction = null, updateError = '', updateStatusError = false;
let updateOpener = null;
function acceptUpdate(value) {
  if (!value || !UPDATE_PHASES.has(value.phase)) return false;
  const revision = Number.isSafeInteger(value.revision) ? value.revision : null;
  if (revision !== null && revision < updateRevision) return false;
  if (revision !== null && revision === updateRevision && appUpdate) return true;
  if (revision !== null) updateRevision = revision;
  appUpdate = { ...value, canCheck: value.canCheck === true, canDownload: value.canDownload === true, canInstall: value.canInstall === true, canOpenStore: value.canOpenStore === true };
  return true;
}
function renderAppUpdates() {
  const phase = appUpdate?.phase || 'idle';
  const busy = updateReading || Boolean(updateAction);
  const labels = {
    disabled: ['Updates unavailable', 'Unavailable in this build'],
    'store-managed': ['Microsoft Store updates', 'Microsoft Store'],
    idle: ['Check for a new version', 'Not checked'],
    checking: ['Checking for updates…', 'Checking…'],
    available: ['An update is available', 'Update available'],
    'up-to-date': ['You’re up to date', 'Up to date'],
    downloading: ['Downloading update…', 'Downloading…'],
    downloaded: ['Ready to install', 'Ready to install'],
    installing: ['Restarting to install…', 'Installing…'],
    error: ['Couldn’t update the app', 'Check failed'],
  };
  $('#updates-settings-state').textContent = labels[phase][1];
  $('#updates-settings-state').dataset.attention = String(phase === 'available' || phase === 'downloaded');
  $('#btn-header-updates').hidden = phase !== 'available' && phase !== 'downloaded';
  $('#btn-header-updates').textContent = phase === 'downloaded' ? 'Update ready' : 'Update available';
  $('#updates-current').dataset.state = updateError ? 'error' : phase;
  $('#updates-current').setAttribute('aria-busy', String(busy || ['checking', 'downloading', 'installing'].includes(phase)));
  $('#updates-version').textContent = appUpdate?.currentVersion ? `Version ${appUpdate.currentVersion} · Windows app` : 'Windows app only';
  $('#updates-state-title').textContent = updateReading && !appUpdate ? 'Reading update status…' : updateError && phase !== 'error' ? 'Update status unavailable' : labels[phase][0];
  $('#updates-state-detail').textContent = updateError || appUpdate?.message || appUpdate?.reason || (updateReading ? 'Reading this installation’s update settings.' : 'Check when you’re ready. Downloads and installation are your choice.');
  $('#updates-available-version').hidden = !appUpdate?.availableVersion;
  $('#updates-available-version').textContent = appUpdate?.availableVersion ? `Version ${appUpdate.availableVersion}` : '';
  const notes = typeof appUpdate?.releaseNotes === 'string' ? appUpdate.releaseNotes : '';
  $('#updates-notes-section').hidden = !notes;
  $('#updates-notes').textContent = notes;
  const percent = typeof appUpdate?.percent === 'number' && Number.isFinite(appUpdate.percent) && appUpdate.percent >= 0 && appUpdate.percent <= 100 ? appUpdate.percent : null;
  const progress = $('#updates-progress');
  $('#updates-progress-section').hidden = phase !== 'downloading';
  if (percent === null) progress.removeAttribute('value');
  else progress.value = percent;
  $('#updates-progress-label').textContent = percent === null ? 'Downloading…' : `${Math.round(percent)}% downloaded`;
  const checked = appUpdate?.checkedAt ? new Date(appUpdate.checkedAt) : null;
  $('#updates-checked').hidden = !checked || !Number.isFinite(checked.getTime());
  $('#updates-checked').textContent = checked && Number.isFinite(checked.getTime()) ? `Last checked ${checked.toLocaleString()}` : '';
  $('#updates-install-note').hidden = !(appUpdate?.canInstall || phase === 'downloaded' || phase === 'installing');
  $('#btn-updates-check').disabled = busy || !appUpdate?.canCheck;
  $('#btn-updates-check').textContent = phase === 'checking' || updateAction === 'check' ? 'Checking…' : phase === 'error' || updateError ? 'Try again' : 'Check for updates';
  $('#btn-updates-check').hidden = phase === 'downloaded' || phase === 'installing' || phase === 'store-managed';
  $('#btn-updates-open-store').hidden = !appUpdate?.canOpenStore;
  $('#btn-updates-open-store').disabled = busy || !appUpdate?.canOpenStore;
  $('#btn-updates-download').hidden = !(appUpdate?.canDownload || phase === 'downloading');
  $('#btn-updates-download').disabled = busy || !appUpdate?.canDownload;
  $('#btn-updates-download').textContent = phase === 'downloading' || updateAction === 'download' ? 'Downloading…' : 'Download update';
  $('#btn-updates-install').hidden = !(appUpdate?.canInstall || phase === 'downloaded' || phase === 'installing');
  $('#btn-updates-install').disabled = busy || !appUpdate?.canInstall;
  $('#btn-updates-install').textContent = phase === 'installing' || updateAction === 'install' ? 'Restarting…' : 'Restart and install';
  $('#btn-updates-refresh').hidden = !updateError || !updateStatusError;
  $('#btn-updates-refresh').disabled = busy;
}
async function readAppUpdateStatus() {
  if (!$('#updates-dialog').open) return;
  const request = ++updateRequest, event = updateEvent;
  updateReading = true;
  updateError = '';
  updateStatusError = false;
  renderAppUpdates();
  try {
    const result = await call('updates:status');
    if (request === updateRequest && $('#updates-dialog').open && event === updateEvent) {
      if (!UPDATE_PHASES.has(result?.phase)) throw Error('The app returned an invalid update status.');
      acceptUpdate(result);
    }
  } catch (error) {
    if (request === updateRequest && $('#updates-dialog').open && event === updateEvent) { updateError = error.message; updateStatusError = true; }
  } finally {
    if (request === updateRequest) { updateReading = false; renderAppUpdates(); }
  }
}
async function runAppUpdate(action) {
  const capability = { check: 'canCheck', download: 'canDownload', install: 'canInstall', 'open-store': 'canOpenStore' }[action];
  if (!capability || updateReading || updateAction || !appUpdate?.[capability]) return;
  const event = updateEvent;
  updateAction = action;
  updateError = '';
  updateStatusError = false;
  renderAppUpdates();
  try {
    const result = await call(`updates:${action}`);
    if (event === updateEvent) {
      if (!UPDATE_PHASES.has(result?.phase)) throw Error('The app returned an invalid update status.');
      acceptUpdate(result);
    } else if (Number.isSafeInteger(result?.revision) && result.revision > updateRevision) acceptUpdate(result);
  } catch (error) {
    if (event === updateEvent || appUpdate?.phase === 'error') updateError = error.message;
  } finally {
    updateAction = null;
    renderAppUpdates();
  }
}
api.on('updates:changed', value => {
  if (!acceptUpdate(value)) return;
  updateEvent++;
  updateError = '';
  updateStatusError = false;
  renderAppUpdates();
});
function openAppUpdates(opener) {
  if ($('#updates-dialog').open) return;
  updateOpener = opener;
  $('#updates-dialog').showModal();
  readAppUpdateStatus();
}
for (const id of ['#btn-app-updates', '#btn-header-updates']) $(id).addEventListener('click', event => openAppUpdates(event.currentTarget));
for (const action of ['check', 'download', 'install', 'open-store']) $(`#btn-updates-${action}`).addEventListener('click', () => runAppUpdate(action));
$('#btn-updates-refresh').addEventListener('click', readAppUpdateStatus);
function invalidateUpdateRead() { updateRequest++; updateReading = false; }
function closeAppUpdates() { invalidateUpdateRead(); $('#updates-dialog').close(); }
for (const id of ['#btn-close-updates', '#btn-updates-done']) $(id).addEventListener('click', closeAppUpdates);
$('#updates-dialog').addEventListener('cancel', invalidateUpdateRead);
$('#updates-dialog').addEventListener('close', () => {
  if ($('#updates-dialog').open) return;
  invalidateUpdateRead();
  (updateOpener?.getClientRects().length ? updateOpener : $('#tabs button.active')).focus();
});

// This stage reads the main process's validated connection snapshot only.
// Installation is deliberately absent; closing invalidates in-flight reads.
let firmwareSetup = null, firmwareRequest = 0, firmwareLoading = false, firmwareError = '';
const FIRMWARE_STATES = {
  combined: ['Per-key support already enabled', 'Compatible firmware is installed for per-key colors and rear-light sync. No setup is needed.'],
  stock: ['Per-key setup needed', 'Stock firmware is active. Whole-board lighting and key mapping are available.'],
  unknown: ['Firmware not recognized', 'This firmware has not been verified for per-key colors or rear-light sync.'],
  disconnected: ['Connect your keyboard', 'Connect the Crush 80 Pro by USB to check its firmware compatibility.'],
};
function firmwareConnectionKey(status) {
  const info = status?.info, rgb = info?.rgb;
  return JSON.stringify([status?.connected, info?.connection, info?.deviceKey, info?.protocol, info?.layers, info?.macros, info?.rows, info?.cols,
    rgb?.firmwareCrc, rgb?.supported, rgb?.rearFollowSupported, rgb?.enabled]);
}
function renderFirmwareSetup() {
  const key = firmwareLoading ? 'checking' : firmwareError ? 'error' : firmwareSetup?.connection === 'receiver' ? 'receiver' : Object.hasOwn(FIRMWARE_STATES, firmwareSetup?.state) ? firmwareSetup.state : 'unknown';
  const [title, detail] = key === 'checking'
    ? ['Checking compatibility…', 'Reading the current connection.']
    : key === 'error' ? ['Compatibility unavailable', 'The current firmware status could not be read. Try refreshing.']
    : key === 'receiver' ? ['Connect by USB to check firmware', 'The receiver connection cannot identify the keyboard firmware for setup.'] : FIRMWARE_STATES[key];
  $('#firmware-current').dataset.state = key;
  $('#firmware-current').setAttribute('aria-busy', String(firmwareLoading));
  $('#firmware-state-title').textContent = title;
  $('#firmware-state-detail').textContent = detail;
  $('#firmware-install-reason').textContent = firmwareSetup?.installationReason || 'A verified installer and recovery flow are not included in this build.';
  $('#firmware-error').hidden = !firmwareError;
  $('#firmware-error').textContent = firmwareError;
  $('#btn-refresh-firmware').disabled = firmwareLoading;
  $('#btn-refresh-firmware').textContent = firmwareLoading ? 'Checking…' : 'Refresh';
}
async function refreshFirmwareSetup() {
  if (!$('#firmware-dialog').open) return;
  const request = ++firmwareRequest;
  const isCurrent = () => request === firmwareRequest && $('#firmware-dialog').open;
  firmwareSetup = null;
  firmwareLoading = true;
  firmwareError = '';
  renderFirmwareSetup();
  try {
    const result = await call('firmware:status');
    if (isCurrent()) firmwareSetup = result;
  } catch (error) {
    if (isCurrent()) firmwareError = error.message;
  } finally {
    if (isCurrent()) { firmwareLoading = false; renderFirmwareSetup(); }
  }
}
function invalidateFirmwareRead() { firmwareRequest++; firmwareLoading = false; }
function closeFirmwareSetup() { invalidateFirmwareRead(); $('#firmware-dialog').close(); }
$('#btn-firmware-setup').addEventListener('click', () => {
  if ($('#firmware-dialog').open) return;
  $('#firmware-dialog').showModal();
  refreshFirmwareSetup();
});
$('#btn-refresh-firmware').addEventListener('click', refreshFirmwareSetup);
for (const id of ['#btn-close-firmware', '#btn-firmware-done']) $(id).addEventListener('click', closeFirmwareSetup);
$('#firmware-dialog').addEventListener('cancel', invalidateFirmwareRead);
$('#firmware-dialog').addEventListener('close', () => {
  // A queued close event must not cancel an immediately reopened dialog.
  if ($('#firmware-dialog').open) return;
  invalidateFirmwareRead();
  $('#btn-firmware-setup').focus();
});

// About metadata and outbound destinations belong to the main process. The
// renderer passes only a fixed action name, never a URL supplied by the page.
let appInfo = null, appInfoRequest = 0, aboutLoading = false, aboutLinkBusy = false, aboutError = '';
function renderAbout() {
  $('#about-title').textContent = appInfo?.name || 'Crush Control';
  $('#about-version').textContent = appInfo
    ? [appInfo.version ? `Version ${appInfo.version}` : null, appInfo.channel].filter(Boolean).join(' · ')
    : aboutLoading ? 'Loading app information…' : 'App information unavailable';
  $('#about-developer').hidden = !appInfo?.developer;
  $('#about-developer').textContent = appInfo?.developer ? `Developed by ${appInfo.developer}` : '';
  $('#about-license').textContent = appInfo?.license || 'Third-party software notices are available below.';
  $('#btn-about-support').hidden = !appInfo?.supportUrl;
  $('#btn-about-support').disabled = aboutLoading || aboutLinkBusy;
  $('#btn-about-github').hidden = !appInfo?.githubUrl;
  $('#btn-about-github').disabled = aboutLoading || aboutLinkBusy;
  $('#btn-about-donate').disabled = !appInfo?.donationUrl || aboutLoading || aboutLinkBusy;
  $('#about-donation-note').hidden = Boolean(appInfo?.donationUrl);
  $('#about-donation-note').textContent = aboutLoading ? 'Loading…' : 'Link not configured';
  $('#btn-about-notices').disabled = aboutLinkBusy;
  $('#about-error').hidden = !aboutError;
  $('#about-error').textContent = aboutError;
}
$('#btn-about').addEventListener('click', async () => {
  const request = ++appInfoRequest;
  aboutLoading = true;
  aboutError = '';
  renderAbout();
  $('#about-dialog').showModal();
  try {
    const info = await call('app:info');
    if (request === appInfoRequest) appInfo = info;
  } catch (error) {
    if (request === appInfoRequest) aboutError = `Couldn't load app information: ${error.message}`;
  } finally {
    if (request === appInfoRequest) { aboutLoading = false; renderAbout(); }
  }
});
for (const id of ['#btn-close-about', '#btn-about-done']) $(id).addEventListener('click', () => $('#about-dialog').close());
$('#about-dialog').addEventListener('close', () => $('#btn-about').focus());
async function openAboutLink(kind) {
  if (aboutLinkBusy || (aboutLoading && kind !== 'notices')) return;
  if ((kind === 'donate' && !appInfo?.donationUrl) || (kind === 'support' && !appInfo?.supportUrl) ||
      (kind === 'github' && !appInfo?.githubUrl)) return;
  aboutLinkBusy = true;
  aboutError = '';
  renderAbout();
  try { await call('app:open-link', kind); }
  catch (error) { aboutError = error.message; }
  finally { aboutLinkBusy = false; renderAbout(); }
}
$('#btn-about-support').addEventListener('click', () => openAboutLink('support'));
$('#btn-about-github').addEventListener('click', () => openAboutLink('github'));
$('#btn-about-donate').addEventListener('click', () => openAboutLink('donate'));
$('#btn-about-notices').addEventListener('click', () => openAboutLink('notices'));

function showView(view) {
  state.view = view;
  document.querySelectorAll('#tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${view}`));
  $('#empty').hidden = state.status.connected || view === 'signalrgb' || view === 'settings';
  if (view === 'keymap' && keymapAvailable() && !state.keymap) loadKeymap();
  if (view === 'signalrgb') loadSignal();
  if (view === 'settings') { renderSettings(); refreshReceiverLink(); }
  keyboardPreview?.setVisible(previewMode === '3d' && view === 'lighting');
  sizeBoards();
  updateControls();
  renderBanners();
}

document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

async function onStatus(status) {
  const wasConnected = state.status.connected;
  const transportChanged = connectionKey(state.status) !== connectionKey(status);
  const permissionsChanged = wasConnected && status.connected &&
    (state.status.info?.supportsLighting !== status.info?.supportsLighting || state.status.info?.supportsKeymap !== status.info?.supportsKeymap);
  const previousFirmware = firmwareConnectionKey(state.status);
  if (transportChanged || permissionsChanged) state.connectionEpoch++;
  state.status = status;
  if ($('#firmware-dialog').open && previousFirmware !== firmwareConnectionKey(status)) refreshFirmwareSetup();
  const conn = $('#conn');
  document.body.classList.toggle('connected', status.connected);
  conn.classList.toggle('on', status.connected);
  conn.querySelector('.conn-text').textContent = status.connected ? connectionKind(status) === 'receiver' ? '2.4 GHz' : 'USB' : 'Disconnected';
  conn.title = status.connected && connectionKind(status) === 'receiver' ? lightingAvailable() ? 'Linked receiver lighting · experimental' : '2.4 GHz receiver · link required' : status.connected ? 'Connected by USB' : 'Keyboard disconnected';
  renderBattery();
  $('#empty').hidden = status.connected || state.view === 'signalrgb' || state.view === 'settings';

  if (status.connected && (!wasConnected || transportChanged || permissionsChanged)) {
    clearTimeout(flushTimer);
    flushTimer = null;
    for (const key of Object.keys(pending)) delete pending[key];
    pendingKeyColors.clear();
    acceptRgb(null);
    state.ready = false;
    state.rgbReady = false;
    state.lastInput = 0;
    state.loaded = null;
    state.dirty = false;
    state.saved = false;
    state.applyError = null;
    state.keymap = null;
    state.selected = null;
    state.layer = 0;
    state.changed.clear();
    fill($('#layers'));
    fill($('#kc-grid'));
    $('#key-board').querySelectorAll('.key').forEach((node, i) => { node.textContent = LAYOUT[i].name; node.className = 'key'; node.title = LAYOUT[i].name; });
    renderKeyInfo();
    const epoch = state.connectionEpoch;
    updateControls();
    if (writing) await activeWrite.catch(() => {});
    if (epoch !== state.connectionEpoch || !state.status.connected) return;
    await refreshLighting();
    await refreshRgb();
    if (epoch !== state.connectionEpoch || !state.status.connected) return;
    state.rgbReady = true;
    if (state.view === 'keymap' && keymapAvailable()) loadKeymap();
  }
  if (!status.connected) {
    state.ready = false;
    state.rgbReady = false;
    clearTimeout(flushTimer);
    flushTimer = null;
    for (const key of Object.keys(pending)) delete pending[key];
    pendingKeyColors.clear();
    acceptRgb(null);
    state.saved = false;
  }
  renderLighting();
  renderSettings();
  renderBanners();
  if ((transportChanged || permissionsChanged) && state.view === 'settings') refreshReceiverLink();
}

api.on('status', onStatus);

// ---------- start ----------

window.addEventListener('resize', sizeBoards);
const boardSizeObserver = new ResizeObserver(sizeBoards);
boardSizeObserver.observe($('.keymap-stage'));
boardSizeObserver.observe($('#board-fallback'));

function renderCamera(view) {
  for (const [id, mode] of [['#btn-view-perspective', 'perspective'], ['#btn-view-top', 'top'], ['#btn-view-bottom', 'bottom']]) {
    $(id).classList.toggle('active', mode === view);
    $(id).setAttribute('aria-pressed', String(mode === view));
  }
}
async function setCamera(view) {
  await setPreviewMode('3d');
  keyboardPreview?.setView(view);
  renderCamera(view);
}
$('#keyboard-3d').addEventListener('preview-view-change', event => renderCamera(event.detail.view));

let previewTheme = 'dark';
try { previewTheme = localStorage.getItem('crush-preview-theme') === 'light' ? 'light' : 'dark'; } catch { /* Private storage can be unavailable. */ }
function setPreviewTheme(theme) {
  previewTheme = theme;
  const dark = theme === 'dark';
  $('#preview-panel').dataset.theme = theme;
  const button = $('#btn-preview-theme');
  button.setAttribute('aria-pressed', String(dark));
  button.title = `Switch to ${dark ? 'light' : 'dark'} preview`;
  button.querySelector('use').setAttribute('href', dark ? '#i-moon' : '#i-sun');
  button.querySelector('span').textContent = dark ? 'Dark' : 'Light';
  keyboardPreview?.setTheme(theme);
  try { localStorage.setItem('crush-preview-theme', theme); } catch { /* Preview still works without persistence. */ }
}
$('#btn-preview-theme').addEventListener('click', () => setPreviewTheme(previewTheme === 'dark' ? 'light' : 'dark'));
setPreviewTheme(previewTheme);
$('#btn-rear-lights').addEventListener('click', () => $('#rear-dialog').showModal());
$('#btn-close-rear').addEventListener('click', () => $('#rear-dialog').close());
$('#btn-rear-done').addEventListener('click', () => $('#rear-dialog').close());
$('#btn-rear-view').addEventListener('click', () => { $('#rear-dialog').close(); setCamera('bottom'); });
$('#btn-view-perspective').addEventListener('click', () => setCamera('perspective'));
$('#btn-view-top').addEventListener('click', () => setCamera('top'));
$('#btn-view-bottom').addEventListener('click', () => setCamera('bottom'));
$('#btn-view-reset').addEventListener('click', () => { keyboardPreview?.reset(); setCamera('perspective'); });

function renderPreviewMode() {
  const three = previewMode === '3d';
  $('#preview-panel').dataset.preview = previewMode;
  $('#keyboard-3d').hidden = !three;
  $('#board-fallback').hidden = three;
  $('#camera-controls').hidden = !three;
  $('#btn-preview-2d').classList.toggle('active', !three);
  $('#btn-preview-3d').classList.toggle('active', three);
  $('#btn-preview-2d').setAttribute('aria-pressed', String(!three));
  $('#btn-preview-3d').setAttribute('aria-pressed', String(three));
  keyboardPreview?.setVisible(three && state.view === 'lighting');
  sizeBoards();
  renderRgbControls();
  updateControls();
}
async function setPreviewMode(mode) {
  previewMode = mode === '3d' ? '3d' : '2d';
  renderPreviewMode();
  if (previewMode === '3d' && !keyboardPreview) {
    if (!previewLoading) previewLoading = setupPreview().finally(() => {
      previewLoading = null;
      $('#btn-preview-3d').textContent = '3D';
      $('#btn-preview-3d').disabled = false;
    });
    $('#btn-preview-3d').textContent = 'Loading…';
    $('#btn-preview-3d').disabled = true;
    await previewLoading;
    renderPreviewMode();
  }
}
$('#btn-preview-2d').addEventListener('click', () => setPreviewMode('2d'));
$('#btn-preview-3d').addEventListener('click', () => setPreviewMode('3d'));
$('#btn-select-all-keys').addEventListener('click', () => {
  if (!lightingAvailable() || !state.ready || !state.rgbReady || state.saving) return;
  setRgbSelection(verifiedRgbKeys().map(key => key.slot));
});
$('#btn-clear-selection').addEventListener('click', () => setRgbSelection([]));

function previewUnavailable() {
  keyboardPreview?.dispose();
  keyboardPreview = null;
  previewMode = '2d';
  renderPreviewMode();
  toast('3D is unavailable. The 2D keyboard is ready to use.');
}
$('#keyboard-3d').addEventListener('preview-error', previewUnavailable);

async function setupPreview() {
  const container = $('#keyboard-3d');
  try {
    // No Three.js module, texture or WebGL context is created until the user
    // explicitly requests 3D. The default editing surface is ordinary HTML.
    const { createKeyboardPreview } = await import('./keyboard3d.js');
    keyboardPreview = createKeyboardPreview(container, { onSelect: selectRgbKey });
    keyboardPreview.setTheme(previewTheme);
    keyboardPreview.setLighting(state.lighting);
    keyboardPreview.setVisible(previewMode === '3d' && state.view === 'lighting');
    paintLightBoard();
  } catch (err) {
    console.warn('3D preview unavailable:', err.message);
    previewUnavailable();
  }
}
window.addEventListener('beforeunload', () => keyboardPreview?.dispose());

(async function start() {
  sizeBoards();
  drawBoard($('#light-board'), { onClick: (index, event) => {
    // Pointer clicks are completed by the marquee controller. Browser keyboard
    // activation (and assistive technology) generates a detail-zero click.
    if (event.detail === 0) selectRgbKey(index, event);
  } });
  drawBoard($('#key-board'), { onClick: (i) => { state.selected = i; renderKeymap(); } });
  $('#key-board').querySelectorAll('.key').forEach((n, i) => n.textContent = LAYOUT[i].name);
  renderKeyInfo();
  renderPreviewMode();
  const disposeSelection = attachBlueprintSelection({
    surface: $('#board-fallback'), board: $('#light-board'), marquee: $('#selection-marquee'),
    canSelect: () => previewMode === '2d' && state.view === 'lighting' && lightingAvailable() && state.ready && state.rgbReady && state.rgb.supported && !state.saving,
    getSelection: () => state.rgbSelection, getKeys: verifiedRgbKeys, setSelection: setRgbSelection,
  });
  window.addEventListener('beforeunload', disposeSelection, { once: true });
  state.effects = await call('effects:list');
  setupLighting();
  state.presets = await call('presets:list');
  try { state.builtinPresets = await call('presets:builtins'); }
  catch (err) { state.presetError = `Couldn't load presets: ${err.message}`; }
  renderPresets();
  renderLighting();
  const loginSettings = await call('settings:get');
  if (loginSettings.storeTest === true) {
    $('.brand span:last-child').textContent = 'Crush Control · Store test';
    document.title = 'Crush Control · Store test';
  }
  $('#login-toggle').checked = loginSettings.openAtLogin === true;
  $('#login-toggle').disabled = loginSettings.loginItemSupported === false;
  $('#login-support-note').hidden = loginSettings.loginItemSupported !== false;
  $('#login-support-note').textContent = loginSettings.loginItemSupported === false
    ? loginSettings.loginItemMessage || 'Manage startup in Windows Settings.' : '';
  await onStatus(await call('status:get'));
  const supportReminder = attachSupportReminder({
    node: $('#support-reminder'), invoke: call,
    canShow: () => document.hasFocus() && !document.hidden && state.view === 'lighting' &&
      lightingAvailable() && state.ready && state.rgbReady && !state.saving && !state.applyError &&
      !state.presetError && !state.presetBusy && !writing && !flushTimer &&
      Object.keys(pending).length === 0 && pendingKeyColors.size === 0 &&
      !document.querySelector('dialog[open]') && !$('#toast').classList.contains('show') &&
      !$('#banners').children.length,
  });
  window.addEventListener('beforeunload', supportReminder.dispose, { once: true });
  loadSignal();
  setInterval(() => { if (state.view === 'lighting') refreshLighting(); }, 1200);
  setInterval(loadSignal, 8000);
})().catch(err => { toast(`Couldn't load keyboard controls: ${err.message}`, true); updateControls(); });
