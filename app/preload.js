const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'app:info', 'app:open-link',
  'support:status', 'support:shown', 'support:dismiss',
  'updates:status', 'updates:check', 'updates:download', 'updates:install', 'updates:open-store',
  'status:get', 'firmware:status', 'lighting:get', 'lighting:set', 'lighting:save', 'effects:list',
  'receiver:status', 'receiver:link',
  'rgb:status', 'rgb:set-key', 'rgb:set-keys', 'rgb:release',
  'keymap:read', 'keymap:set', 'keymap:backup', 'keymap:backups', 'keymap:restore', 'backups:open',
  'presets:list', 'presets:builtins', 'presets:save', 'presets:delete', 'presets:apply',
  'signalrgb:status', 'signalrgb:install', 'settings:get', 'settings:set',
]);
const EVENTS = new Set(['status', 'presets', 'lighting:changed', 'updates:changed']);

contextBridge.exposeInMainWorld('crush', {
  invoke: (channel, ...args) => {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`unknown channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, fn) => {
    if (EVENTS.has(channel)) ipcRenderer.on(channel, (_event, data) => fn(data));
  },
});
