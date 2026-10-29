// SignalRGB plugin: WOBKEY Crush 80 (Pro) over VIA.
//
// The stock Crush 80 firmware has no per-key streaming, but its VIA lighting channel takes a
// standard hue (0-255), saturation (0-255) and brightness (0-9), and those changes stay in RAM
// until a VIA "save". So this plugin turns the SignalRGB canvas under the keyboard into one color
// and streams only the changes. Nothing is ever written to flash.
//
// Firmware quirk: if the keyboard's own Fn+Enter color cycle is on its rainbow step, the board
// ignores VIA colors and there is no VIA command to leave it. VIA then reads hue 0 (which this
// plugin never writes), so the plugin detects that and asks for one Fn+Enter press.
//
// Safety: this file only ever sends VIA custom get (0x08) and custom set (0x07) on channel 3.
// It never sends save (0x09), EEPROM reset (0x0A) or bootloader jump (0x0B).

export function Name() { return "WOBKEY Crush 80"; }
export function VendorId() { return 0x320F; }
export function ProductId() { return 0x5055; }
export function Publisher() { return "crush80-control"; }
export function Size() { return [18, 6]; }
export function DefaultPosition() { return [10, 100]; }
export function DefaultScale() { return 8.0; }
export function DeviceType() { return "keyboard"; }
export function ImageUrl() { return "https://assets.signalrgb.com/devices/default/misc/usb-drive-render.png"; }
export function Validate(endpoint) { return endpoint.usage_page === 0xFF60 && endpoint.usage === 0x0061; }

/* global
LightingMode:readonly
forcedColor:readonly
boardAnimation:readonly
animationSpeed:readonly
blendMode:readonly
maxBrightness:readonly
shutdownMode:readonly
shutdownColor:readonly
*/

// The keyboard's own per-key animations (VIA effect IDs from the official Crush 80 JSON). They take
// their color from the same VIA color setting, so SignalRGB can choose the color while the board
// draws the motion. 0 (off) and 6 (solid) are left out: "Solid color" below is effect 6.
const BOARD_ANIMATIONS = {
	"Solid color": 6, "Wave": 1, "Colour Cloud": 2, "Vortex": 3, "Mix Colour": 4, "Breathe": 5,
	"Fade on keypress": 7, "Stone": 8, "Laser": 9, "Starry": 10, "Flowers Open": 11, "Traverse": 12,
	"Wave Bar": 13, "Meteor": 14, "Rain": 15, "Scan": 16, "Trigger Colour": 17, "Center Spread": 18,
};

export function ControllableParameters() {
	return [
		{property:"LightingMode", group:"lighting", label:"Lighting Mode", description:"Canvas follows the active SignalRGB effect; Forced holds one color", type:"combobox", values:["Canvas", "Forced"], default:"Canvas"},
		{property:"forcedColor", group:"lighting", label:"Forced Color", description:"Color used when Lighting Mode is Forced", min:"0", max:"360", type:"color", default:"#009bde"},
		{property:"boardAnimation", group:"lighting", label:"Keyboard Animation", description:"Solid color shows SignalRGB's color on every key. Any other choice runs that animation on the keyboard itself, in SignalRGB's color.", type:"combobox", values:Object.keys(BOARD_ANIMATIONS), default:"Solid color"},
		{property:"animationSpeed", group:"lighting", label:"Animation Speed (0-4)", description:"Speed of the keyboard animation", step:"1", type:"number", min:"0", max:"4", default:"2"},
		{property:"blendMode", group:"lighting", label:"Color Blend", description:"How the effect under the keyboard becomes the board's single color. Smart blend averages single-color effects and follows the center key on multicolor ones.", type:"combobox", values:["Smart blend", "Average", "Center key"], default:"Smart blend"},
		{property:"maxBrightness", group:"lighting", label:"Max Brightness (1-9)", description:"Keyboard brightness used for a full-brightness color", step:"1", type:"number", min:"1", max:"9", default:"8"},
		{property:"shutdownMode", group:"", label:"On SignalRGB exit", description:"What the keyboard shows when SignalRGB closes", type:"combobox", values:["Restore keyboard lighting", "Shutdown color"], default:"Restore keyboard lighting"},
		{property:"shutdownColor", group:"", label:"Shutdown Color", description:"Used when 'On SignalRGB exit' is Shutdown color", min:"0", max:"360", type:"color", default:"#000000"},
	];
}

const vKeyNames = [
	"Esc", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "Print Screen", "Scroll Lock", "Pause",
	"`", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "=", "Backspace", "Insert", "Home", "Page Up",
	"Tab", "Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P", "[", "]", "\\", "Delete", "End", "Page Down",
	"Caps Lock", "A", "S", "D", "F", "G", "H", "J", "K", "L", ";", "'", "Enter",
	"Left Shift", "Z", "X", "C", "V", "B", "N", "M", ",", ".", "/", "Right Shift", "Up Arrow",
	"Left Ctrl", "Left Win", "Left Alt", "Space", "Right Alt", "Fn", "Menu", "Right Ctrl", "Left Arrow", "Down Arrow", "Right Arrow",
];
const vKeyPositions = [
	[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [10, 0], [11, 0], [12, 0], [13, 0], [15, 0], [16, 0], [17, 0],
	[0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1], [11, 1], [12, 1], [13, 1], [15, 1], [16, 1], [17, 1],
	[0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [9, 2], [10, 2], [11, 2], [12, 2], [13, 2], [15, 2], [16, 2], [17, 2],
	[0, 3], [1, 3], [2, 3], [3, 3], [4, 3], [5, 3], [6, 3], [7, 3], [8, 3], [9, 3], [10, 3], [11, 3], [13, 3],
	[0, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [8, 4], [9, 4], [10, 4], [11, 4], [13, 4], [16, 4],
	[0, 5], [1, 5], [2, 5], [6, 5], [10, 5], [11, 5], [12, 5], [13, 5], [15, 5], [16, 5], [17, 5],
];
export function LedNames() { return vKeyNames; }
export function LedPositions() { return vKeyPositions; }

// VIA lighting channel 3 value IDs, as used by the official Crush 80 VIA JSON.
const VIA = { GET: 0x08, SET: 0x07, CHANNEL: 3, BRIGHTNESS: 1, EFFECT: 2, SPEED: 3, COLOR: 4 };
const STATIC_EFFECT = 6;        // "LIGHT_MODE": one solid color
const CENTER_KEY = [8, 3];      // between J and K
const MIN_SEND_MS = 40;         // ~25 updates per second at most
const RAINBOW_CHECK_MS = 3000;

// The board's LEDs aren't color-corrected: warm VIA hues look greener than they should (VIA 22-34
// all look yellow-green). These [wanted hue in degrees, VIA hue] anchors come from watching a real
// Crush 80 Pro sweep through VIA hues, and map a wanted hue to the value that actually looks like it.
const HUE_ANCHORS = [
	[0, 0], [30, 6], [45, 11], [60, 18], [80, 28], [100, 40], [120, 64], [160, 96],
	[195, 128], [240, 160], [275, 192], [320, 224], [345, 250], [360, 256],
];

let original = null;            // lighting found on the board at Initialize, restored on exit
let sent = {};                  // last values written, so only changes are sent
let lastSendTime = 0;
let lastRainbowCheck = 0;
let rainbowWarned = false;
let followCenter = false;

export function Initialize() {
	selectViaEndpoint();
	original = readLighting();
	if (original) {
		device.log(`Board lighting at start: effect ${original.effect}, brightness ${original.brightness}, speed ${original.speed}, hue ${original.hue}, sat ${original.sat}`);
	} else {
		device.log("Could not read the board's lighting; it will not be restored on exit.");
	}
	rainbowWarned = false;
	checkRainbow(original ? original.hue : null);

	sent = {};
}

export function Render() {
	const now = Date.now();

	if (now - lastRainbowCheck > RAINBOW_CHECK_MS) {
		lastRainbowCheck = now;
		const color = getValue(VIA.COLOR);
		checkRainbow(color ? color[0] : null);
	}

	if (now - lastSendTime < MIN_SEND_MS) {
		return;
	}

	const target = LightingMode === "Forced" ? fromHex(forcedColor) : sampleCanvas();
	if (applyColor(target)) {
		lastSendTime = now;
	}
}

export function Shutdown(SystemSuspending) {
	if (SystemSuspending) {
		applyColor({ h: 0, s: 0, v: 0 });
		return;
	}

	if (shutdownMode === "Shutdown color" || !original) {
		applyColor(fromHex(shutdownColor));
		return;
	}

	setValue(VIA.EFFECT, [original.effect]);
	setValue(VIA.COLOR, [original.hue, original.sat]);
	setValue(VIA.SPEED, [original.speed]);
	setValue(VIA.BRIGHTNESS, [original.brightness]);
}

export function onLightingModeChanged() { sent = {}; }
export function onboardAnimationChanged() { sent = {}; }
export function onanimationSpeedChanged() { sent = {}; }
export function onblendModeChanged() { sent = {}; }
export function onmaxBrightnessChanged() { sent = {}; }

// Writes the board effect/color/brightness that best matches `target`. Returns true if anything was sent.
function applyColor(target) {
	const maxBri = clamp(Math.round(Number(maxBrightness) || 8), 1, 9);
	const effect = boardAnimation in BOARD_ANIMATIONS ? BOARD_ANIMATIONS[boardAnimation] : STATIC_EFFECT;
	const hue = hueToVia(target.h);
	const sat = Math.round(target.s * 255);
	let bri = target.v < 0.04 ? 0 : clamp(Math.round(target.v * maxBri), 1, maxBri);
	if (effect !== STATIC_EFFECT && bri > 0) {
		// Brightness only has 10 steps, so following the canvas brightness makes the board's own
		// animation pulse in jumps. Let the animation run at full brightness; only black turns it off.
		bri = maxBri;
	}

	let changed = false;
	if (effect !== sent.effect) {
		setValue(VIA.EFFECT, [effect]);
		sent.effect = effect;
		changed = true;
	}
	const speed = clamp(Math.round(Number(animationSpeed) || 0), 0, 4);
	if (effect !== STATIC_EFFECT && speed !== sent.speed) {
		setValue(VIA.SPEED, [speed]);
		sent.speed = speed;
		changed = true;
	}
	if (bri > 0 && (hue !== sent.hue || sat !== sent.sat)) {
		setValue(VIA.COLOR, [hue, sat]);
		sent.hue = hue;
		sent.sat = sat;
		changed = true;
	}
	if (bri !== sent.brightness) {
		setValue(VIA.BRIGHTNESS, [bri]);
		sent.brightness = bri;
		changed = true;
	}

	return changed;
}

// Turns the canvas under the keyboard into one target color.
function sampleCanvas() {
	if (blendMode === "Center key") {
		return rgbToHsv(...device.color(...CENTER_KEY));
	}

	let sumR = 0, sumG = 0, sumB = 0;
	let vecX = 0, vecY = 0, weight = 0, sumV = 0, sumSV = 0;

	for (const [x, y] of vKeyPositions) {
		const [r, g, b] = device.color(x, y);
		sumR += r; sumG += g; sumB += b;

		const { h, s, v } = rgbToHsv(r, g, b);
		const w = s * v;
		vecX += Math.cos(h * Math.PI / 180) * w;
		vecY += Math.sin(h * Math.PI / 180) * w;
		weight += w;
		sumV += v;
		sumSV += s * v;
	}

	const n = vKeyPositions.length;
	if (blendMode === "Average") {
		return rgbToHsv(sumR / n, sumG / n, sumB / n);
	}

	// Smart blend: hue is the circular mean weighted by how colorful and bright each key is. When the
	// hues point every which way (rainbow waves etc.) that mean is meaningless, so follow the center
	// key instead; hysteresis keeps it from flipping between the two every frame.
	const concentration = weight > 0 ? Math.hypot(vecX, vecY) / weight : 1;
	followCenter = followCenter ? concentration < 0.45 : concentration < 0.3;
	if (followCenter) {
		return rgbToHsv(...device.color(...CENTER_KEY));
	}

	let h = Math.atan2(vecY, vecX) * 180 / Math.PI;
	if (h < 0) { h += 360; }
	return { h, s: sumV > 0 ? sumSV / sumV : 0, v: sumV / n };
}

function checkRainbow(hue) {
	if (hue === 0 && !rainbowWarned) {
		rainbowWarned = true;
		device.log("Keyboard is on its built-in rainbow color, which ignores VIA colors.");
		device.notify("Crush 80 is on rainbow color", "Press Fn + Enter once on the keyboard so SignalRGB can set its color.", 1);
	} else if (hue !== 0) {
		rainbowWarned = false;
	}
}

function selectViaEndpoint() {
	const endpoints = device.getHidEndpoints();
	for (const ep of endpoints) {
		if (ep.usage_page === 0xFF60 && ep.usage === 0x0061) {
			device.set_endpoint(ep.interface, ep.usage, ep.usage_page, ep.collection);
			return;
		}
	}
	device.log("VIA endpoint (FF60:61) not found");
}

function setValue(id, data) {
	device.clearReadBuffer();
	device.write([0x00, VIA.SET, VIA.CHANNEL, id, ...data], 33);
}

function getValue(id) {
	device.clearReadBuffer();
	device.write([0x00, VIA.GET, VIA.CHANNEL, id], 33);
	device.pause(5);

	// Replies echo the request; skip anything else (e.g. a late reply to another app's query).
	for (let attempt = 0; attempt < 3; attempt++) {
		const reply = device.read([0x00], 33, 30);
		if (!reply || reply.length < 6) { continue; }
		for (const offset of [0, 1]) {
			if (reply[offset] === VIA.GET && reply[offset + 1] === VIA.CHANNEL && reply[offset + 2] === id) {
				return reply.slice(offset + 3, offset + 5);
			}
		}
	}
	return null;
}

function readLighting() {
	const brightness = getValue(VIA.BRIGHTNESS);
	const effect = getValue(VIA.EFFECT);
	const speed = getValue(VIA.SPEED);
	const color = getValue(VIA.COLOR);
	if (!brightness || !effect || !speed || !color) {
		return null;
	}
	return { brightness: brightness[0], effect: effect[0], speed: speed[0], hue: color[0], sat: color[1] };
}

// Maps a wanted hue to the VIA hue that looks like it. Never returns 0: hue 0 is how the board
// reports its rainbow state, so writing it would hide that state from checkRainbow.
function hueToVia(degrees) {
	const h = ((degrees % 360) + 360) % 360;
	for (let i = 1; i < HUE_ANCHORS.length; i++) {
		const [h1, v1] = HUE_ANCHORS[i];
		if (h <= h1) {
			const [h0, v0] = HUE_ANCHORS[i - 1];
			const value = Math.round(v0 + (h - h0) / (h1 - h0) * (v1 - v0)) % 256;
			return Math.max(1, value);
		}
	}
	return 1;
}

function fromHex(hex) {
	const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex) || [null, "00", "00", "00"];
	return rgbToHsv(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16));
}

function rgbToHsv(r, g, b) {
	r /= 255; g /= 255; b /= 255;
	const max = Math.max(r, g, b);
	const d = max - Math.min(r, g, b);
	let h = 0;
	if (d > 0) {
		if (max === r) { h = ((g - b) / d) % 6; } else if (max === g) { h = (b - r) / d + 2; } else { h = (r - g) / d + 4; }
		h *= 60;
		if (h < 0) { h += 360; }
	}
	return { h, s: max === 0 ? 0 : d / max, v: max };
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
