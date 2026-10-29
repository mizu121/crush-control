'use strict';
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mi0ir
const path = require('node:path').win32;
const { APP_ID } = require('./distribution');

// The installer creates ordinary per-user shortcuts with NSIS. Electron's
// documented update operation adds only AUMI metadata after the first launch:
// https://www.electronjs.org/docs/latest/api/shell#shellwriteshortcutlinkshortcutpath-operation-options-windows
function updateShortcutIdentity({ platform, packaged, store, executable, appData, desktop, shell }) {
  if (platform !== 'win32' || !packaged || store || typeof shell?.readShortcutLink !== 'function' || typeof shell?.writeShortcutLink !== 'function') return [];
  const absolute = value => typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value);
  if (![executable, appData, desktop].every(absolute)) return [];
  const target = path.normalize(executable).toLowerCase();
  const links = [path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Crush Control.lnk'), path.join(desktop, 'Crush Control.lnk')];
  return links.map(file => {
    try {
      const link = shell.readShortcutLink(file);
      // Never repoint an existing shortcut, create one, or touch user pins.
      if (!absolute(link.target) || path.normalize(link.target).toLowerCase() !== target) return { status: 'other-target' };
      if (link.appUserModelId === APP_ID) return { status: 'current' };
      return { status: shell.writeShortcutLink(file, 'update', { appUserModelId: APP_ID }) ? 'updated' : 'unavailable' };
    } catch (_) {
      // A missing/deleted/locked shortcut must not prevent app startup.
      return { status: 'unavailable' };
    }
  });
}
module.exports = { updateShortcutIdentity };
