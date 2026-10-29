'use strict';

// App updates only. All network, signature, file and installer adapters are
// injected; importing this module never loads Electron or a device controller.
const path = require('node:path');
const STORE_UPDATES_URI = 'ms-windows-store://downloadsandupdates';

function createStoreUpdater({ app, distribution, openStoreUpdates, onChange }) {
  let stopped = false, opening = false, revision = 0;
  const storeTest = distribution?.storeTest === true;
  const message = storeTest
    ? 'This local Store test is not published. Install a newer test package to update it.'
    : 'Microsoft Store manages updates for this app. Open its Downloads page to check for updates.';
  function status() {
    return { phase: stopped ? 'disabled' : 'store-managed', currentVersion: String(app?.getVersion?.() || ''),
      availableVersion: null, releaseNotes: '', percent: null, checkedAt: null, revision,
      message: stopped ? 'The app is closing.' : message, reason: stopped ? 'The app is closing.' : null,
      provider: 'microsoft-store', storeTest, canCheck: false, canDownload: false, canInstall: false,
      canOpenStore: !stopped && !opening && !storeTest && typeof openStoreUpdates === 'function' };
  }
  function publish() { revision++; try { onChange(status()); } catch { /* Observers cannot authorize updates. */ } }
  async function unsupported() { throw new Error(stopped ? 'The app is closing.' : message); }
  async function openStore() {
    if (!status().canOpenStore) throw new Error(stopped ? 'The app is closing.' : 'Microsoft Store updates are unavailable for this build.');
    opening = true; publish();
    try {
      await openStoreUpdates(STORE_UPDATES_URI);
      if (stopped) throw new Error('The app is closing.');
    } finally { opening = false; publish(); }
    return status();
  }
  function stop() { if (!stopped) { stopped = true; publish(); } return status(); }
  return { status, check: unsupported, download: unsupported, install: unsupported, openStore, stop };
}

function createAppUpdater({ app, config, platform = process.platform, loadUpdater,
  fetchManifest, verifyReleaseEnvelope, verifyInstaller, assertUpdateInfo,
  prepareInstall, onChange = () => {}, now = () => new Date(),
  windowsStore = process.windowsStore, distribution, openStoreUpdates } = {}) {
  // Gate before reading direct-update config or touching any adapter. Even a
  // missing staged marker cannot enable an NSIS updater inside a native MSIX.
  if (windowsStore === true || distribution?.isStore === true) {
    return createStoreUpdater({ app, distribution, openStoreUpdates, onChange });
  }
  const currentVersion = String(app?.getVersion?.() || '');
  const trustedConfig = Object.freeze({ ...config });
  const adapters = [loadUpdater, fetchManifest, verifyReleaseEnvelope, verifyInstaller, assertUpdateInfo, prepareInstall];
  let disabledReason = !app?.isPackaged ? 'App updates are available in the installed Windows build.'
    : platform !== 'win32' ? 'App updates are available on Windows.'
    : trustedConfig.enabled !== true ? 'App updates are not configured for this build.'
    : trustedConfig.provider !== 'github' || !/^[\w.-]+$/.test(trustedConfig.owner || '') ||
      !/^[\w.-]+$/.test(trustedConfig.repo || '') || !['beta', 'stable'].includes(trustedConfig.channel) ||
      typeof trustedConfig.publicKey !== 'string' || !trustedConfig.publicKey.trim()
      ? 'The app update configuration is incomplete.'
      : adapters.some(adapter => typeof adapter !== 'function') ? 'The app update service is unavailable.' : null;
  let engine = null, active = null, stopped = false, quiesced = false, sequence = 0;
  let selected = null, downloadedPath = null;
  let state = { phase: disabledReason ? 'disabled' : 'idle', currentVersion,
    availableVersion: null, releaseNotes: '', percent: null, checkedAt: null,
    message: disabledReason || 'Check for a newer app version.', reason: disabledReason, revision: 0 };

  function status() {
    const ready = !disabledReason && !stopped && !quiesced && !active;
    return { ...state,
      canCheck: ready && ['idle', 'available', 'up-to-date', 'error'].includes(state.phase),
      canDownload: ready && state.phase === 'available' && Boolean(selected),
      canInstall: ready && state.phase === 'downloaded' && Boolean(selected && downloadedPath) };
  }
  function publish(patch) {
    state = { ...state, ...patch, revision: state.revision + 1 };
    try { onChange(status()); } catch { /* UI observers cannot authorize or interrupt an update. */ }
  }
  function stamp() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  function clearAuthorization() { selected = null; downloadedPath = null; }
  function assertActive(operation) {
    if (stopped || active !== operation) throw new Error('The app update action was cancelled.');
    if (operation.error) throw operation.error;
  }
  async function waitFor(promise, operation) {
    const result = await Promise.race([Promise.resolve(promise), operation.aborted]);
    assertActive(operation);
    return result;
  }
  function cancel(operation, message) {
    if (!operation || operation.error) return;
    operation.error = new Error(message);
    try { operation.cancellationToken?.cancel(); } catch { /* Invalidated regardless of adapter cancellation. */ }
    operation.reject(operation.error);
  }
  function failureMessage(kind) {
    if (quiesced) return 'The app update could not finish. Quit and reopen Crush Control before trying again.';
    return kind === 'install' ? 'The update could not be installed safely. Check again before retrying.'
      : kind === 'download' ? 'The update download could not be verified. Check again before retrying.'
        : 'The app update check failed. Please try again.';
  }
  function run(kind, allowed, task) {
    if (stopped || disabledReason) return Promise.reject(new Error(disabledReason || 'The app is closing.'));
    if (active) return active.kind === kind ? active.promise : Promise.reject(new Error('Another app update action is in progress.'));
    if (quiesced) return Promise.reject(new Error('Quit and reopen Crush Control before trying the app update again.'));
    if (!allowed.includes(state.phase)) return Promise.reject(new Error('This app update action is not available.'));
    const operation = { id: ++sequence, kind, error: null, cancellationToken: selected?.cancellationToken, downloadedEvent: null };
    operation.aborted = new Promise((_resolve, reject) => { operation.reject = reject; });
    operation.aborted.catch(() => {});
    active = operation;
    publish({ phase: kind === 'check' ? 'checking' : kind === 'download' ? 'downloading' : 'installing',
      message: kind === 'check' ? 'Checking for an app update…' : kind === 'download' ? 'Downloading and verifying the app update…' : 'Preparing to restart and install…',
      reason: null, percent: kind === 'download' ? 0 : state.percent });
    operation.promise = Promise.resolve().then(() => task(operation)).then(patch => {
      assertActive(operation);
      active = null;
      publish(patch);
      return status();
    }).catch(error => {
      // A stopped or superseded operation must never publish stale results.
      if (active === operation) {
        active = null;
        if (!stopped) {
          clearAuthorization();
          const message = failureMessage(kind);
          publish({ phase: 'error', message, reason: message, percent: null });
        }
      }
      const safe = new Error(stopped ? 'The app is closing.' : failureMessage(kind));
      safe.code = stopped ? 'APP_UPDATES_STOPPED' : 'APP_UPDATE_FAILED';
      throw safe;
    });
    return operation.promise;
  }

  async function getEngine(operation) {
    if (engine) return engine;
    const loaded = await waitFor(loadUpdater(), operation);
    if (!loaded || ['on', 'checkForUpdates', 'downloadUpdate', 'quitAndInstall'].some(method => typeof loaded[method] !== 'function')) {
      throw new Error('Invalid app updater adapter.');
    }
    // channel assignment enables downgrades in electron-updater 6.8.11, so
    // explicitly turn them off after selecting the configured release channel.
    loaded.autoDownload = false;
    loaded.autoInstallOnAppQuit = false;
    loaded.autoRunAppAfterInstall = false;
    loaded.forceDevUpdateConfig = false;
    loaded.disableWebInstaller = true;
    loaded.disableDifferentialDownload = true;
    loaded.channel = trustedConfig.channel === 'stable' ? 'latest' : 'beta';
    loaded.allowPrerelease = trustedConfig.channel === 'beta';
    loaded.allowDowngrade = false;
    loaded.on('error', () => {
      if (stopped) return;
      if (active) cancel(active, 'The app updater reported an error.');
      else {
        clearAuthorization();
        const message = quiesced ? failureMessage('install') : 'The app updater reported an error. Check again before retrying.';
        publish({ phase: 'error', message, reason: message, percent: null });
      }
    });
    loaded.on('download-progress', progress => {
      if (stopped || active?.kind !== 'download' || active.error || state.phase !== 'downloading') return;
      if (!Number.isFinite(progress?.percent) || progress.percent < 0 || progress.percent > 100) return;
      const percent = Math.max(state.percent || 0, Math.min(99, Math.floor(progress.percent)));
      if (percent !== state.percent) publish({ percent });
    });
    loaded.on('update-downloaded', event => {
      if (stopped || active?.kind !== 'download' || active.error) return;
      if (active.downloadedEvent) { cancel(active, 'Unexpected duplicate update download.'); return; }
      try { active.downloadedEvent = snapshot(event); }
      catch { cancel(active, 'Invalid downloaded update metadata.'); }
    });
    loaded.on('update-cancelled', () => {
      if (!stopped && active?.kind === 'download') cancel(active, 'The update download was cancelled.');
    });
    engine = loaded;
    return engine;
  }

  function snapshot(value) { return JSON.parse(JSON.stringify(value)); }
  function validVersion(version) {
    // The signature validator performs full semver/current-version checks.
    // Reject unsafe tag input before it reaches the HTTPS manifest adapter.
    if (typeof version !== 'string' || version.length > 80) return false;
    const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
    return Boolean(parts && parts.slice(1, 4).every(value => Number.isSafeInteger(Number(value))) &&
      (!parts[4] || parts[4].split('.').every(value => !/^\d+$/.test(value) || !/^0\d/.test(value))));
  }
  function canonicalFile(file, manifest) {
    if (typeof file !== 'string' || file.includes('\0') || !path.win32.isAbsolute(file) || path.win32.basename(file) !== manifest.installer) {
      throw new Error('Unexpected app installer path.');
    }
    return path.win32.normalize(file).toLowerCase();
  }
  function checkEngineSelection(updater, choice) {
    // Bind the engine's live selected download, not only an earlier UI copy.
    const info = updater.updateInfoAndProvider?.info;
    if (!info) throw new Error('The app updater has no selected release.');
    assertUpdateInfo(info, choice.manifest);
  }
  function checkInstallerPath(updater, choice, file) {
    if (canonicalFile(updater.installerPath, choice.manifest) !== canonicalFile(file, choice.manifest)) {
      throw new Error('The selected installer changed.');
    }
    checkEngineSelection(updater, choice);
  }

  function check() {
    return run('check', ['idle', 'available', 'up-to-date', 'error'], async operation => {
      clearAuthorization();
      publish({ availableVersion: null, releaseNotes: '', percent: null });
      const updater = await getEngine(operation);
      const result = await waitFor(updater.checkForUpdates(), operation);
      if (!result || typeof result.isUpdateAvailable !== 'boolean' || !validVersion(result.updateInfo?.version) || result.downloadPromise) {
        throw new Error('Invalid update check result.');
      }
      if (!result.isUpdateAvailable) return { phase: 'up-to-date', message: 'This app is up to date.', checkedAt: stamp() };
      operation.cancellationToken = result.cancellationToken;
      const info = snapshot(result.updateInfo);
      const envelope = await waitFor(fetchManifest(info.version, trustedConfig), operation);
      const manifest = snapshot(await waitFor(verifyReleaseEnvelope(envelope, trustedConfig, { currentVersion }), operation));
      assertUpdateInfo(info, manifest);
      const choice = { manifest, info, cancellationToken: result.cancellationToken };
      checkEngineSelection(updater, choice);
      assertActive(operation);
      selected = choice;
      return { phase: 'available', availableVersion: manifest.version,
        releaseNotes: typeof manifest.notes === 'string' ? manifest.notes.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 6000) : '',
        message: 'An app update is available.', checkedAt: stamp() };
    });
  }
  function download() {
    return run('download', ['available'], async operation => {
      const choice = selected, updater = engine;
      if (!choice || !updater) throw new Error('Check for an app update first.');
      checkEngineSelection(updater, choice);
      const files = await waitFor(updater.downloadUpdate(choice.cancellationToken), operation);
      if (!Array.isArray(files) || files.length !== 1 || !operation.downloadedEvent) throw new Error('Incomplete app download result.');
      const event = operation.downloadedEvent;
      assertUpdateInfo(event, choice.manifest);
      if (canonicalFile(event.downloadedFile, choice.manifest) !== canonicalFile(files[0], choice.manifest)) {
        throw new Error('The downloaded app installer does not match the event.');
      }
      checkInstallerPath(updater, choice, files[0]);
      await waitFor(verifyInstaller(files[0], choice.manifest), operation);
      checkInstallerPath(updater, choice, files[0]);
      downloadedPath = files[0];
      return { phase: 'downloaded', percent: 100, message: 'The app update is verified and ready to install.' };
    });
  }
  function install() {
    return run('install', ['downloaded'], async operation => {
      const choice = selected, file = downloadedPath, updater = engine;
      if (!choice || !file || !updater) throw new Error('Download and verify an app update first.');
      checkInstallerPath(updater, choice, file);
      // Detect cache changes before releasing the keyboard, then check again
      // after cleanup immediately before the installer handoff.
      await waitFor(verifyInstaller(file, choice.manifest), operation);
      quiesced = true;
      await waitFor(prepareInstall(), operation);
      checkInstallerPath(updater, choice, file);
      await waitFor(verifyInstaller(file, choice.manifest), operation);
      checkInstallerPath(updater, choice, file);
      assertActive(operation);
      updater.quitAndInstall(true, true);
      assertActive(operation); // Synchronous updater error events must fail closed.
      return { phase: 'installing', message: 'Restarting to install the app update…', percent: 100 };
    });
  }
  function stop() {
    if (stopped) return status();
    stopped = true;
    cancel(active, 'The app is closing.');
    try { selected?.cancellationToken?.cancel(); } catch { /* No further updater actions are authorized. */ }
    clearAuthorization();
    disabledReason = 'The app is closing.';
    publish({ phase: 'disabled', message: disabledReason, reason: disabledReason, percent: null });
    return status();
  }
  return { status, check, download, install, stop,
    openStore: async () => { throw new Error('Microsoft Store updates are unavailable for this build.'); } };
}

module.exports = { createAppUpdater };
