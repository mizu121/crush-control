'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { updateShortcutIdentity } = require('../app/windows-shortcuts');
const { APP_ID } = require('../app/distribution');
const base = { platform: 'win32', packaged: true, store: false, executable: 'C:\\Users\\Test\\AppData\\Local\\Programs\\Crush Control\\Crush Control.exe', appData: 'C:\\Users\\Test\\AppData\\Roaming', desktop: 'C:\\Users\\Test\\Desktop' };

test('updates only identity metadata on existing shortcuts pointing to this exact app', () => {
  const writes = [], reads = [];
  const shell = {
    readShortcutLink(file) { reads.push(file); return { target: base.executable.toUpperCase(), args: '--hidden', description: 'Keep this' }; },
    writeShortcutLink(...args) { writes.push(args); return true; },
  };
  assert.deepEqual(updateShortcutIdentity({ ...base, shell }).map(x => x.status), ['updated', 'updated']);
  assert.equal(reads.length, 2);
  assert.ok(reads[0].endsWith('Start Menu\\Programs\\Crush Control.lnk'));
  assert.ok(reads[1].endsWith('Desktop\\Crush Control.lnk'));
  for (const [, operation, options] of writes) {
    assert.equal(operation, 'update'); assert.deepEqual(options, { appUserModelId: APP_ID });
  }
});
test('never creates, repoints or modifies another app shortcut and never writes current identity', () => {
  let count = 0;
  const shell = { readShortcutLink() { return ++count === 1 ? { target: base.executable + '.other' } : { target: base.executable, appUserModelId: APP_ID }; }, writeShortcutLink() { throw new Error('Must not write'); } };
  assert.deepEqual(updateShortcutIdentity({ ...base, shell }).map(x => x.status), ['other-target', 'current']);
});
test('absent and inaccessible shortcuts are nonfatal; Store/development/invalid-path runs do no shell I/O', () => {
  let calls = 0;
  const shell = { readShortcutLink() { calls++; throw new Error('Unavailable'); }, writeShortcutLink() { throw new Error('Unexpected write'); } };
  assert.deepEqual(updateShortcutIdentity({ ...base, shell }).map(x => x.status), ['unavailable', 'unavailable']);
  assert.equal(calls, 2);
  for (const change of [{ store: true }, { packaged: false }, { platform: 'linux' }, { executable: 'relative.exe' }]) assert.deepEqual(updateShortcutIdentity({ ...base, ...change, shell }), []);
  assert.equal(calls, 2);
});
