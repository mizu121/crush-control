'use strict';
const https = require('node:https');
const { manifestName, validateConfig, MAX_MANIFEST_BYTES } = require('./update-security');
// Only GitHub's release asset redirect hosts. No arbitrary feed URLs or credentials.
const HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
function fetchManifest(version, config, { request = https.get, timeoutMs = 15000 } = {}) {
  validateConfig(config);
  const url = new URL(`https://github.com/${config.owner}/${config.repo}/releases/download/v${version}/${manifestName(version)}`);
  return new Promise((resolve, reject) => {
    let settled = false, active = null;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { active?.destroy(); reject(error); } else resolve(value); };
    const timer = setTimeout(() => finish(new Error('The signed release request timed out.')), timeoutMs);
    function get(target, redirects) {
      if (target.protocol !== 'https:' || target.port && target.port !== '443' || !HOSTS.has(target.hostname) || target.username || target.password || redirects > 4) return finish(new Error('Unexpected signed release redirect.'));
      active = request(target, { headers: { Accept: 'application/json', 'User-Agent': 'Crush-Control-Updater' } }, response => {
        if (settled) { response.resume(); return; }
        const status = response.statusCode;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          try { if (!response.headers.location) throw new Error(); get(new URL(response.headers.location, target), redirects + 1); }
          catch { finish(new Error('Invalid signed release redirect.')); }
          return;
        }
        if (status !== 200) { response.resume(); finish(new Error(status === 404 ? 'The signed release file has not been published yet.' : 'Unable to fetch the signed release file.')); return; }
        if (Number(response.headers['content-length']) > MAX_MANIFEST_BYTES) { response.destroy(); finish(new Error('Signed release file is too large.')); return; }
        let size = 0; const chunks = [];
        response.on('data', chunk => { size += chunk.length; if (size > MAX_MANIFEST_BYTES) { response.destroy(); finish(new Error('Signed release file is too large.')); } else chunks.push(chunk); });
        response.on('end', () => { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(new Error('Invalid signed release file.')); } });
        response.on('error', () => finish(new Error('The signed release download was interrupted.')));
        response.on('aborted', () => finish(new Error('The signed release download was interrupted.')));
      });
      active.on('error', () => finish(new Error('Unable to reach the app update service.')));
    }
    get(url, 0);
  });
}
module.exports = { fetchManifest };
