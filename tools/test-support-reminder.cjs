'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSupportReminder } = require('../app/support-reminder');

// This suite exercises only its own temporary JSON files. It never loads the
// controller, Electron, native HID, the user's profile, or network services.
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crush-support-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'support-reminder.json') };
}
const active = { visible: true, ready: true };
function session(file) {
  const reminder = createSupportReminder({ file });
  reminder.recordSession(active);
  return reminder;
}
function thirdSession(file) {
  session(file);
  session(file);
  return session(file);
}

test('only a visible, ready production use counts, once per process instance', t => {
  const { file } = fixture(t);
  const reminder = createSupportReminder({ file });
  assert.equal(reminder.status().eligible, false);
  reminder.recordSession({ visible: false, ready: true });
  reminder.recordSession({ visible: true, ready: false });
  assert.equal(reminder.status().counted, false);
  reminder.recordSession(active);
  assert.equal(reminder.status().counted, true);
  for (let i = 0; i < 6; i++) {
    reminder.recordSession(active);
    reminder.status();
  }
  assert.equal(reminder.status().eligible, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessions, 1);
  assert.equal(session(file).status().eligible, false);
  assert.equal(session(file).status().eligible, true);
  session(file);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessions, 3);
});

test('hidden/unready claims are deferred; a displayed reminder is consumed permanently', t => {
  const { file } = fixture(t);
  const reminder = thirdSession(file);
  assert.equal(reminder.claim({ visible: false, ready: true }).show, false);
  assert.equal(reminder.claim({ visible: true, ready: false }).show, false);
  assert.equal(reminder.status().eligible, true);
  assert.equal(reminder.claim(active).show, true);
  assert.equal(reminder.status().presented, true);
  assert.equal(reminder.status().eligible, false);
  assert.equal(reminder.claim(active).show, false);
  // Simulate closing without pressing any footer action, then restarting.
  const restarted = session(file);
  assert.equal(restarted.status().presented, true);
  assert.equal(restarted.status().eligible, false);
  assert.equal(restarted.claim(active).show, false);
});

test('dismissal persists across instances without altering presets or receiver links', t => {
  const { directory, file } = fixture(t);
  const sentinels = ['presets.json', 'receiver-links.json'].map(name => path.join(directory, name));
  for (const target of sentinels) fs.writeFileSync(target, '{"keep":"exact original bytes"}\n');
  const before = sentinels.map(target => fs.readFileSync(target));
  const reminder = thirdSession(file);
  reminder.claim(active);
  reminder.dismiss();
  assert.equal(reminder.status().dismissed, true);
  const restarted = session(file);
  assert.equal(restarted.status().dismissed, true);
  assert.equal(restarted.status().eligible, false);
  assert.equal(restarted.claim(active).show, false);
  sentinels.forEach((target, i) => assert.deepEqual(fs.readFileSync(target), before[i]));
});

test('disabled development or verification use does not create reminder storage', t => {
  const { file } = fixture(t);
  const reminder = createSupportReminder({ file, enabled: false });
  reminder.recordSession(active);
  assert.equal(reminder.status().eligible, false);
  assert.equal(reminder.claim(active).show, false);
  reminder.dismiss();
  assert.equal(fs.existsSync(file), false);
});

test('corrupt or unknown state fails closed and preserves the original bytes', t => {
  const { directory } = fixture(t);
  const invalid = [
    '{not valid JSON',
    'null',
    '[]',
    '{"version":999,"sessions":3,"presented":false,"dismissed":false}',
    '{"version":1,"sessions":-1,"presented":false,"dismissed":false}',
    '{"version":1,"sessions":3,"presented":"false","dismissed":false}',
  ];
  invalid.forEach((contents, index) => {
    const file = path.join(directory, `invalid-${index}.json`);
    fs.writeFileSync(file, contents);
    const reminder = createSupportReminder({ file });
    reminder.recordSession(active);
    assert.equal(reminder.status().eligible, false);
    assert.equal(reminder.claim(active).show, false);
    reminder.dismiss();
    assert.equal(fs.readFileSync(file, 'utf8'), contents);
  });
});

test('unwritable storage fails closed without creating a repeat reminder', t => {
  const { directory } = fixture(t);
  // A regular file in the parent position fails on Windows as well as POSIX;
  // chmod-based read-only tests would not reliably constrain a Windows user.
  const blockedParent = path.join(directory, 'not-a-directory');
  fs.writeFileSync(blockedParent, 'leave me unchanged');
  const file = path.join(blockedParent, 'support-reminder.json');
  const reminder = createSupportReminder({ file });
  assert.doesNotThrow(() => reminder.recordSession(active));
  assert.equal(reminder.status().eligible, false);
  assert.equal(reminder.claim(active).show, false);
  assert.doesNotThrow(() => reminder.dismiss());
  assert.equal(fs.readFileSync(blockedParent, 'utf8'), 'leave me unchanged');
});
