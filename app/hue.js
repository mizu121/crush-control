// Maps between the hue you want to see and the VIA hue (0-255) that looks like it on the Crush 80.
// Keep HUE_ANCHORS in sync with the copy in signalrgb/Wobkey_Crush80_VIA_Sync.js (SignalRGB plugins
// can't import files).
//
// The board's LEDs aren't color-corrected: warm VIA hues look greener than they should (VIA 22-34
// all look yellow-green). These [wanted hue in degrees, VIA hue] anchors come from watching a real
// Crush 80 Pro sweep through VIA hues.
const HUE_ANCHORS = [
  [0, 0], [30, 6], [45, 11], [60, 18], [80, 28], [100, 40], [120, 64], [160, 96],
  [195, 128], [240, 160], [275, 192], [320, 224], [345, 250], [360, 256],
];

function interpolate(x, pairs) {
  for (let i = 1; i < pairs.length; i++) {
    const [x1, y1] = pairs[i];
    if (x <= x1) {
      const [x0, y0] = pairs[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return pairs[pairs.length - 1][1];
}

// Never returns 0: VIA hue 0 is how the board reports its Fn+Enter rainbow step.
function degreesToVia(degrees) {
  const h = ((degrees % 360) + 360) % 360;
  return Math.max(1, Math.round(interpolate(h, HUE_ANCHORS)) % 256);
}

function viaToDegrees(value) {
  return Math.round(interpolate(value, HUE_ANCHORS.map(([deg, via]) => [via, deg]))) % 360;
}

module.exports = { degreesToVia, viaToDegrees };
