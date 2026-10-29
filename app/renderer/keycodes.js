// Keycodes this board understands: QMK "v12" numbering (what VIA protocol 11 uses), plus the
// Crush 80's own functions at 0x7F00+ (order from the official VIA JSON, confirmed on the Fn layer:
// Fn+Win is 0x7F05 = Win lock, Fn+1..3 are 0x7F01..03 = Bluetooth 1-3).

const entry = (code, label, short = label, desc = '') => ({ code, label, short, desc });

const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c, i) => entry(0x04 + i, c));
const digits = '1234567890'.split('').map((c, i) => entry(0x1e + i, c));
const fkeys = Array.from({ length: 12 }, (_, i) => entry(0x3a + i, `F${i + 1}`))
  .concat(Array.from({ length: 12 }, (_, i) => entry(0x68 + i, `F${i + 13}`)));

export const CATEGORIES = [
  {
    name: 'Basic',
    keys: [
      ...letters, ...digits,
      entry(0x28, 'Enter', '⏎'), entry(0x29, 'Esc'), entry(0x2a, 'Backspace', '⌫'), entry(0x2b, 'Tab'),
      entry(0x2c, 'Space', '␣'), entry(0x39, 'Caps Lock', 'Caps'),
      entry(0x2d, '-'), entry(0x2e, '='), entry(0x2f, '['), entry(0x30, ']'), entry(0x31, '\\'),
      entry(0x33, ';'), entry(0x34, "'"), entry(0x35, '`'), entry(0x36, ','), entry(0x37, '.'), entry(0x38, '/'),
      entry(0x32, 'ISO #', '#', 'Non-US # key'), entry(0x64, 'ISO \\', 'ISO\\', 'Non-US backslash key'),
    ],
  },
  { name: 'F-keys', keys: fkeys },
  {
    name: 'Navigation',
    keys: [
      entry(0x52, 'Up', '↑'), entry(0x51, 'Down', '↓'), entry(0x50, 'Left', '←'), entry(0x4f, 'Right', '→'),
      entry(0x49, 'Insert', 'Ins'), entry(0x4c, 'Delete', 'Del'), entry(0x4a, 'Home'), entry(0x4d, 'End'),
      entry(0x4b, 'Page Up', 'PgUp'), entry(0x4e, 'Page Down', 'PgDn'),
      entry(0x46, 'Print Screen', 'PrtSc'), entry(0x47, 'Scroll Lock', 'ScrLk'), entry(0x48, 'Pause'),
      entry(0x65, 'Menu', '☰', 'Application / context menu key'),
    ],
  },
  {
    name: 'Modifiers',
    keys: [
      entry(0xe0, 'Left Ctrl', 'Ctrl'), entry(0xe1, 'Left Shift', 'Shift'), entry(0xe2, 'Left Alt', 'Alt'), entry(0xe3, 'Left Win', 'Win'),
      entry(0xe4, 'Right Ctrl', 'RCtrl'), entry(0xe5, 'Right Shift', 'RShift'), entry(0xe6, 'Right Alt', 'RAlt'), entry(0xe7, 'Right Win', 'RWin'),
    ],
  },
  {
    name: 'Media',
    keys: [
      entry(0xa8, 'Mute', '🔇'), entry(0xa9, 'Volume Up', '🔊'), entry(0xaa, 'Volume Down', '🔉'),
      entry(0xae, 'Play / Pause', '⏯'), entry(0xab, 'Next Track', '⏭'), entry(0xac, 'Previous Track', '⏮'), entry(0xad, 'Stop', '⏹'),
      entry(0xbd, 'Screen Brighter', '☀+'), entry(0xbe, 'Screen Dimmer', '☀−'),
      entry(0xb2, 'Calculator', 'Calc'), entry(0xb1, 'Mail'), entry(0xb3, 'My Computer', 'PC'),
      entry(0xb5, 'Browser Home', 'Web'), entry(0xb4, 'Browser Search', 'Srch'), entry(0xb6, 'Browser Back', 'Back'),
      entry(0xb7, 'Browser Forward', 'Fwd'), entry(0xb9, 'Browser Refresh', 'Rfsh'),
      entry(0xa6, 'Sleep'), entry(0xa5, 'Power'),
    ],
  },
  {
    name: 'Numpad',
    keys: [
      ...'1234567890'.split('').map((c, i) => entry(0x59 + i, `Numpad ${c}`, `N${c}`)),
      entry(0x53, 'Num Lock', 'NumLk'), entry(0x54, 'Numpad /', 'N/'), entry(0x55, 'Numpad *', 'N*'),
      entry(0x56, 'Numpad -', 'N-'), entry(0x57, 'Numpad +', 'N+'), entry(0x58, 'Numpad Enter', 'NEnt'), entry(0x63, 'Numpad .', 'N.'),
    ],
  },
  {
    name: 'Lighting',
    keys: [
      entry(0x7820, 'Lighting On/Off', 'RGB', 'Toggle the backlight'),
      entry(0x7821, 'Next Effect', 'Mode+'), entry(0x7822, 'Previous Effect', 'Mode−'),
      entry(0x7823, 'Next Color', 'Hue+', 'Cycles the color; one step is the rainbow'), entry(0x7824, 'Previous Color', 'Hue−'),
      entry(0x7825, 'Saturation Up', 'Sat+'), entry(0x7826, 'Saturation Down', 'Sat−'),
      entry(0x7827, 'Brightness Up', 'Bri+'), entry(0x7828, 'Brightness Down', 'Bri−'),
      entry(0x7829, 'Effect Faster', 'Spd+'), entry(0x782a, 'Effect Slower', 'Spd−'),
    ],
  },
  {
    name: 'Layers',
    keys: [
      ...[0, 1, 2, 3].map((n) => entry(0x5220 + n, `Hold Layer ${n}`, `MO(${n})`, `Layer ${n} while held`)),
      ...[0, 1, 2, 3].map((n) => entry(0x5260 + n, `Toggle Layer ${n}`, `TG(${n})`, `Turn layer ${n} on/off`)),
      ...[0, 1, 2, 3].map((n) => entry(0x5200 + n, `Go to Layer ${n}`, `TO(${n})`, `Switch to layer ${n}`)),
    ],
  },
  {
    name: 'Crush 80',
    keys: [
      entry(0x7f00, '2.4G Mode', '2.4G', 'Switch to the 2.4 GHz dongle'),
      entry(0x7f01, 'Bluetooth 1', 'BT1'), entry(0x7f02, 'Bluetooth 2', 'BT2'), entry(0x7f03, 'Bluetooth 3', 'BT3'),
      entry(0x7f04, 'Cycle Connection', 'Mode', 'BLE / 2.4G / USB'),
      entry(0x7f05, 'Win Key Lock', 'WinLk'), entry(0x7f06, 'Mac / Win Switch', 'Mac/W'),
      entry(0x7f07, 'Logo LED Mode', 'Logo'), entry(0x7f08, 'Logo LED Color', 'LogoC'), entry(0x7f09, 'Logo LED Power', 'LogoP'),
      entry(0x7f0a, 'Side LED Mode', 'Side'), entry(0x7f0b, 'Side LED Color', 'SideC'), entry(0x7f0c, 'Side LED Power', 'SideP'),
      entry(0x7f0d, 'Key Scan Delay', 'Scan', 'Debounce setting'),
      entry(0x7f0e, 'All LEDs Power', 'LEDs'), entry(0x7f0f, 'Battery Status', 'Batt', 'Show battery level on the keys'),
    ],
  },
  {
    name: 'Special',
    keys: [entry(0x0000, 'None', '', 'Key does nothing'), entry(0x0001, 'Transparent', '▽', 'Falls through to the layer below')],
  },
];

const BY_CODE = new Map(CATEGORIES.flatMap((c) => c.keys.map((key) => [key.code, key])));

export const FIRMWARE_RESERVED = 0xffff;

const MOD_NAMES = [[0x01, 'Ctrl'], [0x02, 'Shift'], [0x04, 'Alt'], [0x08, 'Win']];

// Returns { label, short, desc } for any keycode, including modded keys like Ctrl+C.
export function describe(code) {
  if (code === FIRMWARE_RESERVED) {
    return { label: 'Built-in function', short: '⚙', desc: 'Handled inside the firmware (media/system keys on the Fn layer). Locked.' };
  }
  const known = BY_CODE.get(code);
  if (known) return known;

  if (code >= 0x0100 && code <= 0x1fff) {
    const mods = (code >> 8) & 0x1f;
    const base = BY_CODE.get(code & 0xff);
    const names = MOD_NAMES.filter(([bit]) => mods & bit).map(([, n]) => (mods & 0x10 ? 'R' : '') + n);
    if (base && names.length) {
      const label = `${names.join('+')}+${base.label}`;
      return { label, short: `${names.map((n) => n[0]).join('')}+${base.short}`, desc: label };
    }
  }
  const hex = '0x' + code.toString(16).padStart(4, '0').toUpperCase();
  return { label: hex, short: hex.slice(2), desc: 'Unrecognized keycode' };
}

export function hex(code) {
  return '0x' + code.toString(16).padStart(4, '0').toUpperCase();
}
