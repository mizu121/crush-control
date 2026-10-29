'use strict';
// Inspect a compiled NSIS-3 Unicode/Deflate header as bytes. Never execute it.
const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const signature = Buffer.from('efbeadde4e756c6c736f6674496e7374', 'hex');
const expectedApis = ['RmStartSession', 'RmRegisterResources', 'RmGetList', 'RmEndSession'];
const forbidden = ['nsProcess', 'SpiderBanner', 'WinShell', 'taskkill', 'Stop-Process', 'TerminateProcess', 'RmShutdown', 'RmRestart'];
function inspectCompiledScript(file) {
  const data = fs.readFileSync(file);
  const signatureOffset = data.indexOf(signature);
  if (signatureOffset < 4 || data.indexOf(signature, signatureOffset + 1) !== -1) throw new Error('Missing or ambiguous NSIS first header');
  const offset = signatureOffset - 4;
  const headerSize = data.readUInt32LE(offset + 20);
  const block = data.readUInt32LE(offset + 28);
  const packedSize = block & 0x7fffffff;
  if (headerSize < 100 || headerSize > 16 * 1024 * 1024 || packedSize > data.length - offset - 32) throw new Error('Invalid NSIS header bounds');
  const encoded = data.subarray(offset + 32, offset + 32 + packedSize);
  const decoded = block & 0x80000000 ? zlib.inflateRawSync(encoded, { maxOutputLength: 16 * 1024 * 1024 }) : encoded;
  if (decoded.length !== headerSize) throw new Error('Unexpected NSIS header length or compressor');
  const contains = text => decoded.includes(Buffer.from(text, 'utf16le'));
  const foundApis = expectedApis.filter(contains);
  const foundForbidden = forbidden.filter(contains);
  if (foundApis.length !== expectedApis.length) throw new Error('Compiled installer lacks expected query-only process check');
  if (foundForbidden.length) throw new Error(`Removed or terminating operation in compiled installer: ${foundForbidden.join(', ')}`);
  return {
    file, sha256: crypto.createHash('sha256').update(data).digest('hex'),
    headerSize, headerSha256: crypto.createHash('sha256').update(decoded).digest('hex'),
    processApis: foundApis, forbiddenOperations: foundForbidden,
    method: 'read NSIS first header and inflate its Deflate script/string block; no execution',
  };
}
module.exports = { inspectCompiledScript };
if (require.main === module) console.log(JSON.stringify(inspectCompiledScript(process.argv[2]), null, 2));
