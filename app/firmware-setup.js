'use strict';

// Assessment only: this module has no imports or device access. Its sole input is
// Crush80.status(). A receiver association cannot identify current firmware:
// receiver connections return unknown and require wired USB for this check.
// Do not pass renderer input or an inventory record here.
// A CRC is an observed firmware identifier, not PCB identity or recovery proof.
const STOCK_CRC = 0xa7da1601;
const COMBINED_CRC = 0x5566ddf2;
const INSTALLATION_REASON = 'Firmware installation is not available in this release. A public installer and recovery process have not been validated.';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function assessFirmwareSetup(status) {
  const result = {
    state: 'unknown', alreadyInstalled: false, installationAvailable: false,
    requiresUsb: true, connection: 'unknown', firmwareCrc: null,
    capabilities: { perKey: false, rearFollow: false },
    reason: 'The current keyboard firmware has not been verified.',
    installationReason: INSTALLATION_REASON,
  };
  if (!record(status) || typeof status.connected !== 'boolean') return result;
  if (!status.connected) {
    result.state = 'disconnected';
    result.connection = 'disconnected';
    result.reason = 'Connect the keyboard in wired USB mode to check its firmware.';
    return result;
  }
  if (status.info?.connection === 'receiver') {
    result.connection = 'receiver';
    result.reason = 'Reconnect by USB to identify the keyboard firmware. Receiver support is based on its saved association, not a firmware identity query.';
    return result;
  }

  // Connected means the existing wired VIA owner is open. No new enumeration,
  // identity query, capability request, or firmware operation occurs here.
  result.connection = 'usb';
  const info = status.info;
  const rgb = record(info) && record(info.rgb) ? info.rgb : null;
  if (!rgb) return result;
  const crc = rgb.firmwareCrc;
  if (Number.isInteger(crc) && crc >= 0 && crc <= 0xffffffff) {
    result.firmwareCrc = crc.toString(16).toUpperCase().padStart(8, '0');
  }
  const layoutMatches = info.protocol === 11 && info.layers === 4 && info.macros === 16 &&
    info.rows === 8 && info.cols === 16;
  if (!layoutMatches) {
    result.reason = 'The keyboard protocol or layout does not match the supported firmware.';
    return result;
  }
  if (crc === COMBINED_CRC) {
    // These booleans come from RgbController.metadata(). supported is true only
    // after exact PKRG discovery on the current connection epoch. Invalidated
    // discovery remains unknown even when the old CRC is still cached.
    if (rgb.supported === true && rgb.rearFollowSupported === true && typeof rgb.enabled === 'boolean') {
      result.state = 'combined';
      result.alreadyInstalled = true;
      result.capabilities = { perKey: true, rearFollow: true };
      result.reason = 'Compatible per-key firmware is already installed. No setup is needed.';
    } else {
      result.reason = 'The firmware identifier matches, but its current per-key capabilities are not verified.';
    }
  } else if (crc === STOCK_CRC && rgb.supported === false && rgb.rearFollowSupported === false && rgb.enabled === false) {
    result.state = 'stock';
    result.reason = 'Recognized stock firmware supports whole-keyboard lighting. This does not verify the board revision or eligibility for a firmware update.';
  } else {
    result.reason = 'This firmware is unknown or does not match the supported per-key build.';
  }
  return result;
}

module.exports = { assessFirmwareSetup };
