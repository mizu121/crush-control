'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// This file is deliberately separate from keyboard profiles and receiver links.
// A failed read/write disables the optional reminder rather than repeating it.
function createSupportReminder({ file, enabled = true }) {
  let blocked = !enabled, counted = false;
  let state = { version: 1, sessions: 0, presented: false, dismissed: false };
  if (!blocked) {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw Error('Invalid reminder state.');
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value?.version !== 1 || !Number.isInteger(value.sessions) || value.sessions < 0 || value.sessions > 3 ||
          typeof value.presented !== 'boolean' || typeof value.dismissed !== 'boolean') throw Error('Invalid reminder state.');
      state = { version: 1, sessions: value.sessions, presented: value.presented, dismissed: value.dismissed };
    } catch (error) { if (error.code !== 'ENOENT') blocked = true; }
  }
  function save(next) {
    if (blocked) return false;
    const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
      state = next;
      return true;
    } catch {
      blocked = true;
      try { fs.unlinkSync(temporary); } catch { /* No profile data is touched. */ }
      return false;
    }
  }
  const ready = context => context?.visible === true && context?.ready === true;
  function status() {
    return { eligible: !blocked && counted && state.sessions >= 3 && !state.presented && !state.dismissed,
      counted, presented: state.presented, dismissed: state.dismissed, disabled: blocked };
  }
  return {
    status,
    recordSession(context) {
      if (!blocked && !counted && ready(context) && !state.presented && !state.dismissed) {
        counted = save({ ...state, sessions: Math.min(3, state.sessions + 1) });
      }
      return status();
    },
    claim(context) {
      // Persist before display: even closing the app without clicking never nags.
      return { show: ready(context) && status().eligible && save({ ...state, presented: true }) };
    },
    dismiss() {
      if (!state.dismissed) save({ ...state, presented: true, dismissed: true });
      return status();
    },
  };
}

module.exports = { createSupportReminder };
