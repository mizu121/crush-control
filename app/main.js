const { app, BrowserWindow, Tray, Menu, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { Crush80, EFFECTS } = require('./crush80');
const { degreesToVia, viaToDegrees } = require('./hue');
const { hsvToRgb } = require('./rgb-controller');
const { normalizePreset, listBuiltins } = require('./preset-library');
const { assessFirmwareSetup } = require('./firmware-setup');
const { makeIcon, makeBatteryIcon } = require('./icon');
const { readLinks, makeLink, writeLink } = require('./receiver-link');
const { readBatteryStatus } = require('./battery');
const { batteryLabel } = require('./battery-presentation');
const { createAppUpdater } = require('./app-updater');
const { createUpdateLifecycle } = require('./update-lifecycle');
const updateSecurity = require('./update-security');
const { fetchManifest } = require('./update-feed');
const updateConfig = require('./update-config.json');
const { APP_ID, resolveDistribution, userDataName, releaseInfo, distributionPaths, loginLaunch: distributionLoginLaunch, loginItemEnabled, configuredLink } = require('./distribution');
const releaseConfig = require('./release-config.json');
const { createSupportReminder } = require('./support-reminder');
const { updateShortcutIdentity } = require('./windows-shortcuts');
const APP_NAME = releaseConfig.name;
const distribution = resolveDistribution({ windowsStore: process.windowsStore }, releaseConfig);

const ROOT = path.join(__dirname, '..');
// Keep updates and the installed app on the existing per-user data directory.
// Packaged resources are read-only; backups must never be written into ASAR.
if (app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), userDataName(distribution)));
const paths = distributionPaths({ packaged: app.isPackaged, root: ROOT, resources: process.resourcesPath, userData: app.getPath('userData') });
const BACKUP_DIR = paths.backups;
const PLUGIN_SRC = paths.plugin;
const pluginDest = () => path.join(app.getPath('documents'), 'WhirlwindFX', 'Plugins', path.basename(PLUGIN_SRC));
const presetsFile = () => path.join(app.getPath('userData'), 'presets.json');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const supportReminder = createSupportReminder({
  file: path.join(app.getPath('userData'), 'support-reminder.json'),
  enabled: app.isPackaged && !distribution.storeTest && !process.env.CRUSH_SHOTS &&
    Boolean(releaseConfig.githubUrl || releaseConfig.donationUrl),
});
function supportReminderContext() {
  const status = kb.status();
  return { visible: Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()),
    ready: !shutdownStarted && status.connected && status.info?.supportsLighting !== false };
}

const receiverFile = () => path.join(app.getPath('userData'), 'receiver-links.json');
const kb = new Crush80({ getReceiverLink: hash => readLinks(receiverFile()).find(link => link.pathHash === hash) || null });
let win = null;
let tray = null;
let quitting = false;
let shutdownStarted = false;
let shutdownComplete = false;
let pollTimer = null;
let updateTimer = null;
let appUpdater = null;
let batteryTimer = null, batteryPolling = false;
let batteryStatus = { percent: null, charging: null, source: 'unavailable', updatedAt: null, stale: true };
function uiStatus() { return { ...kb.status(), ...(shutdownStarted ? { connected: false } : {}), battery: { ...batteryStatus } }; }
const lifecycle = createUpdateLifecycle({
  keyboard: kb,
  stopPolling() { clearInterval(pollTimer); clearInterval(batteryTimer); clearInterval(updateTimer); },
  onQuiesce() { shutdownStarted = true; quitting = true; send('status', uiStatus()); buildTrayMenu(); },
});
appUpdater = createAppUpdater({
  app, platform: process.platform, config: updateConfig,
  distribution, windowsStore: process.windowsStore,
  openStoreUpdates: uri => shell.openExternal(uri),
  loadUpdater: () => require('./vendor/electron-updater.cjs').autoUpdater,
  fetchManifest, ...updateSecurity,
  prepareInstall: async () => { await lifecycle.shutdown(); shutdownComplete = true; },
  onChange: status => send('updates:changed', status),
});
async function pollBattery() {
  if (batteryPolling || shutdownStarted) return;
  batteryPolling = true;
  try {
    const reading = await readBatteryStatus();
    if (shutdownStarted) return;
    batteryStatus = reading;
    send('status', uiStatus());
    buildTrayMenu();
  } catch { batteryStatus = { ...batteryStatus, charging: null, stale: true }; }
  finally { batteryPolling = false; }
}

function receiverStatus() {
  const candidates = kb.via?.listCandidates?.().receiver || [];
  const candidate = candidates.length === 1 ? candidates[0] : null;
  const linked = Boolean(candidate && readLinks(receiverFile()).some(link => link.pathHash === candidate.pathHash));
  const status = kb.status();
  let canLink = false, reason = 'Connect your tested Crush 80 Pro by USB and insert its paired dongle.';
  if (candidate) {
    try { makeLink(status, candidate); canLink = true; } catch (error) { reason = error.message; }
  } else if (candidates.length > 1) reason = 'Leave exactly one Crush 80 dongle connected.';
  if (linked) reason = 'This receiver is linked. Unplug the keyboard cable and select 2.4 GHz to use lighting controls.';
  return { linked, canLink, reason };
}

// The desktop launcher may outlive its parent's console. Keep diagnostics in a
// file so a closed stdout/stderr pipe cannot produce a second JavaScript error.
function logError(context, error) {
  try {
    const directory = app.getPath('userData');
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, 'crush80.log'),
      `${new Date().toISOString()} ${context}: ${error?.stack || error?.message || error}\n`);
  } catch { /* A logging failure must not interrupt device cleanup. */ }
}

function pollKeyboard() {
  if (shutdownStarted) return;
  kb.poll().catch(error => logError('keyboard poll', error));
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function showWindow() {
  if (!win || shutdownStarted) return;
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    show: !process.argv.includes('--hidden'),
    title: APP_NAME,
    backgroundColor: '#f5f5f3',
    icon: makeIcon(256),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#626d5c', height: 44 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged },
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && !input.alt && !input.shift && input.key?.toLowerCase() === 'q') {
      event.preventDefault();
      quitting = true;
      app.quit();
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch(error => logError('renderer load', error));
  if (process.env.CRUSH_SHOTS) {
    win.webContents.on('console-message', (e) => logError(`renderer ${e.level}`, `${e.message} (${path.basename(e.sourceId || '')}:${e.lineNumber})`));
    win.webContents.once('did-finish-load', () => captureScreenshots(process.env.CRUSH_SHOTS).catch(error => {
      logError('screenshots', error);
      quitting = true;
      app.quit();
    }));
  }
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

// Dev aid: CRUSH_SHOTS=<dir> captures each tab to <dir>/<tab>.png, then quits. Read-only: it only
// switches tabs and selects a key, it never changes lighting or the keymap.
async function captureScreenshots(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(dir, { recursive: true });
  await wait(3500);
  for (const view of ['lighting', 'keymap', 'signalrgb', 'settings']) {
    await win.webContents.executeJavaScript(`document.querySelector('#tabs [data-view="${view}"]').click()`);
    if (view === 'keymap') {
      await wait(1200);
      await win.webContents.executeJavaScript(`document.querySelector('#key-board .key[data-i="61"]')?.click()`);
    }
    await wait(1500);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `${view}.png`), img.toPNG());
  }
  quitting = true;
  app.quit();
}

// ---------- presets ----------

function readPresets(strict = false) {
  try {
    const list = JSON.parse(fs.readFileSync(presetsFile(), 'utf8'));
    if (!Array.isArray(list)) throw new TypeError('Invalid preset collection.');
    return list.map(normalizePreset);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logError('preset read', error);
      if (strict) throw new Error('The saved preset file could not be read. It has been left unchanged.');
    }
    return [];
  }
}

function writePresets(list) {
  const clean = list.map(normalizePreset);
  fs.mkdirSync(path.dirname(presetsFile()), { recursive: true });
  const temporary = presetsFile() + '.tmp';
  // Rename only after the complete JSON is written; preserve the prior file
  // if validation or writing fails.
  fs.writeFileSync(temporary, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, presetsFile());
  send('presets', clean);
  buildTrayMenu();
  return clean;
}

function lightingForUi(lighting, rgb) {
  return { ...lighting, hueDeg: viaToDegrees(lighting.hue),
    rainbowLocked: rgb?.supported ? false : lighting.rainbowLocked };
}

async function applyPreset(value) {
  const preset = normalizePreset(value);
  const assertTarget = await checkLightingOwnership();
  const { hueDeg, ...native } = preset.lighting;
  native.hue = degreesToVia(hueDeg);
  assertTarget();
  const result = preset.kind === 'per-key'
    ? await kb.applyRgbPreset(preset.colors, native)
    : await kb.applyLightingPreset({ ...native, rgb: hsvToRgb(hueDeg, native.sat) });
  const response = { lighting: lightingForUi(result.lighting, result.rgb), rgb: result.rgb };
  assertTarget();
  send('lighting:changed', response);
  return response;
}

async function savePreset(value) {
  let preset;
  if (value?.capture === true) {
    const assertTarget = await checkLightingOwnership();
    assertTarget();
    const snapshot = await kb.capturePreset();
    assertTarget();
    const { effect, brightness, speed, hue, sat } = snapshot.lighting;
    const perKey = snapshot.rgb?.supported && snapshot.rgb.enabled && effect === 6;
    preset = normalizePreset({ name: value.name, kind: perKey ? 'per-key' : 'native',
      lighting: { effect, brightness, speed, hueDeg: viaToDegrees(hue), sat },
      ...(perKey ? { colors: snapshot.rgb.colors } : {}) });
  } else preset = normalizePreset(value);
  return writePresets([...readPresets(true).filter(p => p.name !== preset.name), preset]);
}

async function applyLighting(change) {
  const assertTarget = await checkLightingOwnership();
  const via = { ...change };
  if (via.hueDeg !== undefined) {
    // Direct PKRG uses the requested RGB. Calibration applies only to the
    // separate OEM hue channel that drives native effects and rear follow.
    const saturation = via.sat ?? (await kb.getLighting()).sat;
    via.rgb = hsvToRgb(via.hueDeg, saturation);
    via.hue = degreesToVia(via.hueDeg);
    via.sat = saturation;
  }
  delete via.hueDeg;
  assertTarget();
  await kb.setLighting(via);
}

async function checkLightingOwnership() {
  if (shutdownStarted) throw new Error('Crush Control is closing. Reopen it before changing the keyboard.');
  const initial = kb.status(), epoch = kb.epoch;
  const connected = initial.connected;
  const deviceKey = initial.info?.deviceKey, connection = initial.info?.connection;
  const assertTarget = () => {
    if (shutdownStarted) throw new Error('Crush Control is closing; the pending edit was discarded.');
    const current = kb.status();
    if (kb.epoch !== epoch || current.connected !== connected ||
      current.info?.deviceKey !== deviceKey || current.info?.connection !== connection) {
      throw new Error('Keyboard connection changed; the pending edit was discarded.');
    }
  };
  if (initial.info?.rgb?.supported && await signalRgbRunning()) {
    throw new Error('Quit SignalRGB before using per-key controls in this app.');
  }
  assertTarget();
  return assertTarget;
}

// ---------- SignalRGB ----------

function signalRgbRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq SignalRgb.exe', '/NH'], { windowsHide: true }, (err, out) => {
      resolve(!err && /SignalRgb\.exe/i.test(out));
    });
  });
}

async function signalRgbStatus() {
  let installed = false;
  let current = false;
  try {
    const installedCopy = fs.readFileSync(pluginDest());
    installed = true;
    current = installedCopy.equals(fs.readFileSync(PLUGIN_SRC));
  } catch {}
  return { running: await signalRgbRunning(), installed, current, pluginPath: pluginDest(), sourcePath: PLUGIN_SRC };
}

// ---------- keymap backups ----------

function flatten(map) {
  return map.flat(2);
}

async function backupKeymap() {
  const map = await kb.readKeymap();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `keymap-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const { layers, rows, cols } = kb.info;
  fs.writeFileSync(path.join(BACKUP_DIR, name), JSON.stringify({ layers, rows, cols, keycodes: flatten(map) }, null, 1));
  return name;
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^keymap-.*\.json$/.test(f))
      .map((f) => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
  } catch {
    return [];
  }
}

async function restoreKeymap(name) {
  const file = path.join(BACKUP_DIR, path.basename(name));
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { layers, rows, cols } = kb.info;
  if (data.layers !== layers || data.rows !== rows || data.cols !== cols || data.keycodes.length !== layers * rows * cols) {
    throw new Error('That backup is from a different keyboard layout');
  }
  const current = flatten(await kb.readKeymap());
  let changed = 0;
  for (let i = 0; i < current.length; i++) {
    if (current[i] === data.keycodes[i]) continue;
    const layer = Math.floor(i / (rows * cols));
    const row = Math.floor((i % (rows * cols)) / cols);
    const col = i % cols;
    await kb.setKeycode(layer, row, col, data.keycodes[i]);
    changed++;
  }
  return changed;
}

// ---------- tray ----------

function buildTrayMenu() {
  if (!tray) return;
  const presets = readPresets();
  const status = kb.status();
  const connection = status.connected ? status.info?.connection === 'receiver' ? '2.4 GHz' : 'USB' : 'Disconnected';
  tray.setToolTip(`${APP_NAME} · ${connection}\n${batteryLabel(batteryStatus)}`);
  tray.setImage(makeBatteryIcon(batteryStatus));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Open ${APP_NAME}`, click: showWindow },
    { label: status.connected ? `Keyboard connected · ${connection}` : 'Keyboard not connected', enabled: false },
    { label: batteryLabel(batteryStatus), enabled: false },
    { type: 'separator' },
    {
      label: 'Lighting presets',
      enabled: !shutdownStarted && status.connected && status.info?.supportsLighting !== false,
      submenu: presets.length
        ? presets.map((p) => ({ label: p.name, click: () => applyPreset(p).catch(error => logError('tray preset', error)) }))
        : [{ label: 'No presets yet. Save one in the app.', enabled: false }],
    },
    { label: 'Lights off', enabled: !shutdownStarted && status.connected && status.info?.supportsLighting !== false, click: () => applyLighting({ brightness: 0 }).catch(() => {}) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------- IPC ----------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      if (shutdownStarted && !['status:get', 'updates:status', 'app:info'].includes(channel)) throw new Error('Crush Control is closing. Reopen it to continue.');
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

handle('status:get', () => uiStatus());
handle('updates:status', () => appUpdater.status());
handle('updates:check', () => appUpdater.check());
handle('updates:download', () => appUpdater.download());
handle('updates:install', () => appUpdater.install());
handle('updates:open-store', () => appUpdater.openStore());
handle('receiver:status', () => receiverStatus());
handle('receiver:link', () => {
  const before = kb.status();
  const candidates = kb.via?.listCandidates?.().receiver || [];
  if (candidates.length !== 1) throw new Error('Insert exactly one paired Crush 80 dongle.');
  const link = makeLink(before, candidates[0]);
  const after = kb.status();
  if (!after.connected || after.info?.deviceKey !== before.info?.deviceKey) throw new Error('Keyboard connection changed. Try again over USB.');
  writeLink(receiverFile(), link);
  return receiverStatus();
});
handle('firmware:status', () => assessFirmwareSetup(kb.status()));
handle('app:info', () => releaseInfo({ version: app.getVersion(), packaged: app.isPackaged, distribution }));
handle('support:status', () => ({ ...supportReminder.recordSession(supportReminderContext()),
  canStar: Boolean(releaseConfig.githubUrl), canDonate: Boolean(releaseConfig.donationUrl) }));
handle('support:shown', () => supportReminder.claim(supportReminderContext()));
handle('support:dismiss', () => supportReminder.dismiss());
handle('app:open-link', async action => {
  if (action === 'notices') {
    const error = await shell.openPath(paths.notices);
    if (error) throw new Error(error);
    return;
  }
  // Accept a named action, never a URL from renderer-controlled input.
  await shell.openExternal(configuredLink(action));
});
handle('effects:list', () => EFFECTS);
handle('lighting:get', async () => {
  const l = await kb.getLighting();
  return { ...l, hueDeg: viaToDegrees(l.hue) };
});
handle('lighting:set', (change) => applyLighting(change));
handle('lighting:save', () => kb.saveLighting());
handle('rgb:status', () => kb.getRgbStatus());
handle('rgb:set-key', async (change) => { const assertTarget = await checkLightingOwnership(); assertTarget(); return kb.setKeyRgb(change); });
handle('rgb:set-keys', async (change) => { const assertTarget = await checkLightingOwnership(); assertTarget(); return kb.setKeysRgb(change); });
handle('rgb:release', async () => { const assertTarget = await checkLightingOwnership(); assertTarget(); return kb.releaseRgb(); });
handle('keymap:read', () => kb.readKeymap());
handle('keymap:set', ({ layer, positions, code }) => Promise.all(positions.map(([row, col]) => kb.setKeycode(layer, row, col, code))));
handle('keymap:backup', () => backupKeymap());
handle('keymap:backups', () => listBackups());
handle('keymap:restore', (name) => restoreKeymap(name));
handle('backups:open', () => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return shell.openPath(BACKUP_DIR);
});
handle('presets:list', () => readPresets());
handle('presets:builtins', () => listBuiltins());
handle('presets:save', (preset) => savePreset(preset));
handle('presets:delete', (name) => writePresets(readPresets(true).filter((p) => p.name !== name)));
handle('presets:apply', (selection) => {
  const preset = typeof selection === 'string'
    ? readPresets().find(p => p.name === selection)
    : typeof selection?.builtinId === 'string' ? listBuiltins().find(p => p.id === selection.builtinId) : null;
  if (!preset) throw new Error('preset not found');
  return applyPreset(preset);
});
handle('signalrgb:status', () => signalRgbStatus());
handle('signalrgb:install', () => {
  try {
    fs.mkdirSync(path.dirname(pluginDest()), { recursive: true });
    fs.copyFileSync(PLUGIN_SRC, pluginDest());
    return { copied: true };
  } catch (err) {
    // Usually Windows Controlled Folder Access protecting Documents. Explorer is allowed, so show
    // both folders and let the user drag the file across.
    shell.showItemInFolder(PLUGIN_SRC);
    shell.openPath(path.dirname(pluginDest()));
    return { copied: false, reason: err.code || err.message };
  }
});
function loginLaunch() {
  return distributionLoginLaunch({ packaged: app.isPackaged, executable: process.execPath, root: ROOT, systemRoot: process.env.SystemRoot });
}
function loginLaunchEnabled(launch) {
  // Electron's openAtLogin only looks up AppUserModelID. Our saved Run value
  // uses a custom name; inspect that exact enabled launch item instead.
  return loginItemEnabled(app.getLoginItemSettings(launch), launch);
}

handle('settings:get', () => distribution.isStore ? {
  openAtLogin: false, loginItemSupported: false, storeTest: distribution.storeTest,
  loginItemMessage: 'Manage startup in Windows Settings.',
} : ({
  // Reading settings preserves the old Electron startup preference. Only an
  // explicit toggle replaces that same app registry entry with the wrapper.
  openAtLogin: loginLaunchEnabled(loginLaunch()) || (!app.isPackaged &&
    loginLaunchEnabled({ path: process.execPath, args: [app.getAppPath(), '--hidden'] })),
  loginItemSupported: true, loginItemMessage: '',
}));
handle('settings:set', ({ openAtLogin }) => {
  if (typeof openAtLogin !== 'boolean') throw new TypeError('Invalid startup preference.');
  if (distribution.isStore) throw new Error('Manage startup in Windows Settings.');
  app.setLoginItemSettings({ ...loginLaunch(), name: 'crush80-control', openAtLogin });
});

// ---------- lifecycle ----------

kb.on('status', (s) => {
  send('status', { ...s, ...(shutdownStarted ? { connected: false } : {}), battery: { ...batteryStatus } });
  buildTrayMenu();
});
kb.on('error', (err) => logError('keyboard', err));

app.on('second-instance', showWindow);
app.on('before-quit', (event) => {
  quitting = true;
  if (shutdownComplete) return;
  event.preventDefault();
  if (ordinaryQuitPending) return;
  ordinaryQuitPending = true;
  appUpdater.stop();
  lifecycle.shutdown().catch(error => logError('keyboard restoration', error)).finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
let ordinaryQuitPending = false;
// Subscribing keeps the tray app alive. Electron passes no event argument here.
app.on('window-all-closed', () => {});

app.whenReady().then(() => {
  // MSIX supplies its manifest identity. A hard-coded desktop ID would break
  // the Store package's taskbar and activation association.
  if (!distribution.isStore) app.setAppUserModelId(APP_ID);
  if (process.platform === 'win32' && app.isPackaged && !distribution.isStore) {
    try {
      updateShortcutIdentity({ platform: process.platform, packaged: true, store: false,
        executable: app.getPath('exe'), appData: app.getPath('appData'), desktop: app.getPath('desktop'), shell });
    } catch (error) { logError('shortcut identity', error); }
  }
  createWindow();
  tray = new Tray(makeIcon(32));
  tray.on('click', showWindow);
  buildTrayMenu();
  pollKeyboard();
  pollTimer = setInterval(pollKeyboard, 1500);
  pollBattery();
  batteryTimer = setInterval(pollBattery, 60000);
  if (appUpdater.status().canCheck) {
    // Checking only: downloads and installation always require an explicit click.
    appUpdater.check().catch(error => logError('app update check', error));
    updateTimer = setInterval(() => {
      if (!shutdownStarted && appUpdater.status().canCheck) appUpdater.check().catch(error => logError('app update check', error));
    }, 6 * 60 * 60 * 1000);
  }
}).catch(error => {
  logError('startup', error);
  quitting = true;
  app.quit();
});
