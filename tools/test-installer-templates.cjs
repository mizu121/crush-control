'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generate, readInputs, assertTemplatesCurrent, replaceExactly, OUTPUT } = require('../build/installer-templates.cjs');
const commands = text => text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith(';') && !line.startsWith('#'));

test('vendored templates equal deterministic reviewed edits of pinned upstream input', () => {
  assert.equal(assertTemplatesCurrent(), true);
  const result = generate();
  assert.equal(Object.keys(result).length, 6);
  assert.throws(() => replaceExactly('new template', 'old operation', 'replacement'), /replacement count/);
  assert.throws(() => replaceExactly('old old', 'old', 'replacement'), /replacement count/);
  for (const [name, text] of Object.entries(result)) assert.equal(fs.readFileSync(path.join(OUTPUT, name), 'utf8'), text);
});

test('only external shortcut calls change; all original create, rename and delete commands remain', () => {
  const input = readInputs(), output = generate();
  for (const [from, to] of [['include/installer.nsh', 'installer-app-files.nsh'], ['uninstaller.nsh', 'uninstaller.nsh']]) {
    const expected = commands(input[from]).filter(line => !line.startsWith('WinShell::'));
    assert.deepEqual(commands(output[to]), expected);
  }
  assert.doesNotMatch(Object.values(output).join('\n'), /WinShell::|SpiderBanner::|nsProcess::_/);
  assert.match(output['installer-app-files.nsh'], /CreateShortCut "\$newStartMenuLink" "\$appExe"/);
  assert.match(output['uninstaller.nsh'], /Delete "\$oldStartMenuLink"/);
});

test('default two-pass entry is retained and cwd selects both owned phase templates', () => {
  const input = readInputs(), output = generate();
  assert.match(input['installer.nsi'], /!include "installSection.nsh"/);
  assert.match(input['installer.nsi'], /!include "uninstaller.nsh"/);
  const include = fs.readFileSync(path.resolve(__dirname, '../build/installer.nsh'), 'utf8');
  assert.match(include, /!cd "\$\{PROJECT_DIR\}\\build\\installer-templates"/);
  assert.match(include, /!addincludedir "\$\{PROJECT_DIR\}\\node_modules\\app-builder-lib\\templates\\nsis"/);
  assert.doesNotMatch(include, /\/PREPEND/, 'the pinned NSIS compiler lacks this newer option');
  assert.equal(output['multiUser.nsh'], input['multiUser.nsh'], 'cwd must select unchanged builder multiUser, not compiler MultiUser');
  const section = output['installSection.nsh'];
  const afterCheck = text => text.slice(text.indexOf('  !insertmacro CHECK_APP_RUNNING'));
  assert.equal(afterCheck(section), afterCheck(input['installSection.nsh']));
  assert.match(section, /installer-app-files\.nsh/);
  assert.match(section, /ShutdownBlockReasonCreate/);
  assert.doesNotMatch(section, /FindWindow|SpiderBanner/);
  const config = require('../build/windows.cjs');
  assert.equal(config.nsis.script, undefined, 'custom entry would skip builder uninstaller generation');
  assert.equal(config.nsis.oneClick, true);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.equal(config.nsis.runAfterFinish, false);
});

test('the standard MUI progress page and exact template license remain available', () => {
  const upstream = path.resolve(__dirname, '../node_modules/app-builder-lib/templates/nsis/oneClick.nsh');
  assert.match(fs.readFileSync(upstream, 'utf8'), /!insertmacro MUI_PAGE_INSTFILES/);
  assert.match(generate()['LICENSE.electron-builder.txt'], /The MIT License/);
  const notice = fs.readFileSync(path.resolve(__dirname, '../legal/installer/TEMPLATE_OVERRIDES.txt'), 'utf8');
  assert.match(notice, /Uninstall no longer automatically unpins/);
  assert.match(notice, /after the first packaged app launch, not before/);
});
