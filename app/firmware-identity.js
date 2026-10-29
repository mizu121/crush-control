'use strict';
// Exact OEM command1 only. No caller-provided packets, OTA, SET or RESET path.
// Called once before VIA opens; each query owns and closes a fresh HID handle.
function queryFirmwareIdentity(HID) {
  const matches = HID.devices(0x320f, 0x5055).filter(device => device.interface === 2 && device.usagePage === 0xffef);
  if (matches.length !== 1) throw new Error('Expected one Crush80 identity interface.');
  const device = new HID.HID(matches[0].path);
  try {
    let empty = false;
    for (let i = 0; i < 32; i++) if (!device.readTimeout(15).length) { empty = true; break; }
    if (!empty) throw new Error('Keyboard identity queue is busy.');
    const packet = [5, 1, 0, 0, ...Array(29).fill(255), ...Array(31).fill(0)];
    if (device.write(packet) !== 64) throw new Error('Incomplete identity report.');
    const deadline = Date.now() + 1500;
    for (let i = 0; i < 32 && Date.now() < deadline; i++) {
      const reply = device.readTimeout(Math.max(1, deadline - Date.now()));
      if (!reply.length) break;
      if (![5, 1, 8, 0].every((byte, index) => reply[index] === byte)) continue;
      if (reply.length !== 64) throw new Error('Invalid identity response length.');
      const bytes = Buffer.from(reply);
      return { version: bytes.readUInt32LE(4), crc: bytes.readUInt32LE(8) };
    }
    throw new Error('No matching firmware identity response.');
  } finally { device.close(); }
}
module.exports = { queryFirmwareIdentity };
