'use strict';
// A local association with the user's paired receiver, not radio firmware
// attestation. The receiver's own FFEF identity is never used as keyboard identity.
const fs = require('node:fs');
const path = require('node:path');
const COMBINED_CRC = 0x5566ddf2;
function validLink(value, hash) {
  return Boolean(value && value.schemaVersion === 1 && typeof value.pathHash === 'string' && /^[0-9a-f]{64}$/.test(value.pathHash) &&
    (!hash || value.pathHash === hash) && value.keyboardCrc === COMBINED_CRC &&
    value.model === 'Crush 80 Pro' && typeof value.linkedAt === 'string' && Number.isFinite(Date.parse(value.linkedAt)));
}
function readLinks(filename, strict = false) {
  try {
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > 16384) throw new Error('Invalid receiver association storage.');
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!Array.isArray(value) || value.length > 16 || value.some(link => !validLink(link))) throw new Error('Invalid receiver association storage.');
    if (new Set(value.map(link => link.pathHash)).size !== value.length) throw new Error('Duplicate receiver association.');
    return value.map(({ schemaVersion, pathHash, keyboardCrc, model, linkedAt }) => ({ schemaVersion, pathHash, keyboardCrc, model, linkedAt }));
  } catch (error) {
    if (strict && error.code !== 'ENOENT') throw new Error('Receiver association storage could not be read. The existing file was left unchanged.');
    return [];
  }
}
function makeLink(status, candidate, now = new Date().toISOString()) {
  const info = status?.info, rgb = info?.rgb;
  if (!status?.connected || info?.connection !== 'usb' || rgb?.firmwareCrc !== COMBINED_CRC ||
    rgb?.supported !== true || rgb?.rearFollowSupported !== true) throw new Error('Connect the tested Crush 80 Pro by USB and verify its per-key firmware first.');
  if (candidate?.connection !== 'receiver' || typeof candidate.pathHash !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.pathHash)) throw new Error('Insert exactly one paired Crush 80 dongle.');
  const link = { schemaVersion: 1, pathHash: candidate.pathHash, keyboardCrc: COMBINED_CRC, model: 'Crush 80 Pro', linkedAt: now };
  if (!validLink(link)) throw new Error('Invalid receiver association.');
  return link;
}
function writeLink(filename, link) {
  if (!validLink(link)) throw new Error('Invalid receiver association.');
  const links = readLinks(filename, true).filter(item => item.pathHash !== link.pathHash);
  if (links.length >= 16) throw new Error('Too many linked receivers.');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = filename + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify([...links, link], null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, filename);
}
module.exports = { validLink, readLinks, makeLink, writeLink };
