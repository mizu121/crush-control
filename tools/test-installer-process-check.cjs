'use strict';

// Execute the actual NSIS instruction body against mocked Windows APIs. This is
// a narrow instruction interpreter, not a second implementation of the checker.
// No installer, DLL, process API, app or keyboard is executed by these tests.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'build/installer-process-check.nsh'), 'utf8');
const wrapper = fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8');
const normalize = value => path.win32.normalize(value).toLowerCase();
const appName = 'Crush Control.exe';

function run(options = {}) {
  const instructions = source.split(/Function \$\{CC_PROCESS_CHECK\}\r?\n/)[1]
    .split(/FunctionEnd/)[0].split(/\r?\n/)
    .map(line => line.trim()).filter(line => line && !line.startsWith(';'));
  const labels = new Map(instructions.flatMap((line, index) => line.endsWith(':') ? [[line.slice(0, -1), index]] : []));
  const vars = Object.fromEntries([...Array(10)].flatMap((_, i) => [[`$${i}`, `saved-${i}`], [`$R${i}`, `saved-R${i}`]]));
  const originals = { ...vars };
  vars.$INSTDIR = options.installDir ?? 'C:\\Users\\Test\\AppData\\Local\\Programs\\Crush Control';
  vars.$SYSDIR = 'C:\\Windows\\SysWOW64';
  const stack = [String(options.waits ?? 0)];
  const heap = new Map();
  const calls = [];
  let allocation = 0;
  let nextAddress = options.pointerBytes === 8 ? 0x1_0000_0000 : 0x30000;
  let steps = 0, pc = 0, error = false, sleeps = 0, polls = 0, registered;
  const value = token => token?.replace(/\$\{APP_EXECUTABLE_FILENAME\}/g, appName)
    .replace(/\$\{PRODUCT_FILENAME\}/g, appName.slice(0, -4))
    .replace(/\$\{NSIS_MAX_STRLEN\}/g, '1024')
    .replace(/\$(?:R\d|\d|INSTDIR|SYSDIR)\b/g, name => String(vars[name] ?? '')) ?? '';
  const go = label => {
    if (!label || label === '0') return;
    assert.ok(labels.has(label), `Unknown jump ${label}`);
    pc = labels.get(label);
  };
  const alloc = object => {
    allocation++;
    if (options.failAllocation === allocation) return '0';
    const address = String(nextAddress);
    nextAddress += 0x1000;
    heap.set(address, object);
    return address;
  };
  const native = raw => {
    const call = value(raw);
    calls.push(call);
    if (call === '*(&w1024 R0) p.r2') {
      vars.$2 = alloc({ text: vars.$R0, bytes: 2048 });
    } else if (call === '*(p r2) p.r3') {
      vars.$3 = alloc({ pointer: vars.$2, bytes: options.pointerBytes ?? 4 });
    } else if (/\\Rstrtmgr\.dll"::RmStartSession\(\*i \.r0, i 0, p r1\) i\.r4$/.test(call)) {
      assert.equal(heap.get(vars.$1)?.bytes, 66, '33 WCHAR session key');
      vars.$0 = 42;
      vars.$4 = options.startResult ?? 0;
    } else if (/\\Rstrtmgr\.dll"::RmRegisterResources\(i r0, i 1, p r3, i 0, p 0, i 0, p 0\) i\.r4$/.test(call)) {
      assert.equal(vars.$0, 42);
      registered = heap.get(heap.get(vars.$3)?.pointer)?.text;
      assert.ok(registered && path.win32.isAbsolute(registered));
      vars.$4 = options.registerResult ?? 0;
    } else if (/\\Rstrtmgr\.dll"::RmGetList\(i r0, \*i \.r5, \*i r6 r6, p 0, \*i \.r7\) i\.r4$/.test(call)) {
      assert.equal(Number(vars.$6), 0, 'zero capacity for the query-only call');
      const busy = (options.processes ?? []).some(process => normalize(process.path) === normalize(registered));
      const defaultResult = { result: busy ? 234 : 0, needed: busy ? 1 : 0, count: 0, reboot: 0 };
      const response = options.query?.[Math.min(polls, options.query.length - 1)] ?? defaultResult;
      polls++;
      vars.$4 = response.result;
      vars.$5 = response.needed ?? 0;
      vars.$6 = response.count ?? 0;
      vars.$7 = response.reboot ?? 0;
    } else if (/\\Rstrtmgr\.dll"::RmEndSession\(i r0\) i\.r4$/.test(call)) {
      assert.equal(vars.$0, 42);
      vars.$4 = options.endResult ?? 0;
    } else {
      assert.fail(`Unexpected or malformed System call: ${call}`);
    }
  };
  while (pc < instructions.length) {
    assert.ok(++steps < 5000, 'bounded interpreter execution');
    const line = instructions[pc++];
    if (line.endsWith(':')) continue;
    const parts = [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
    const [op, ...args] = parts;
    switch (op) {
      case 'Push': stack.push(value(args[0])); break;
      case 'Pop': assert.ok(stack.length); vars[args[0]] = stack.pop(); break;
      case 'Exch': { const old = vars[args[0]]; vars[args[0]] = stack.pop(); stack.push(old); break; }
      case 'StrCpy': vars[args[0]] = value(args[1]); break;
      case 'StrCmp': go(value(args[0]).toLowerCase() === value(args[1]).toLowerCase() ? args[2] : args[3]); break;
      case 'IntCmp': case 'IntCmpU': {
        const a = Number(value(args[0])), b = Number(value(args[1]));
        go(a === b ? args[2] : a < b ? args[3] : args[4]); break;
      }
      case 'IntOp': assert.equal(args[2], '-'); vars[args[0]] = Number(value(args[1])) - Number(value(args[3])); break;
      case 'Goto': go(args[0]); break;
      case 'ClearErrors': error = false; break;
      case 'IfErrors': go(error ? args[0] : args[1]); break;
      case 'GetFullPathName': {
        error = !!options.pathError;
        vars[args[0]] = error ? '' : path.win32.normalize(value(args[1])); break;
      }
      case 'Sleep': assert.equal(Number(value(args[0])), 250); sleeps++; break;
      case 'System::Alloc': stack.push(alloc({ bytes: Number(value(args[0])) })); break;
      case 'System::Free': assert.ok(heap.delete(value(args[0])), 'free exactly one owned buffer'); break;
      case 'System::Call': native(args[0]); break;
      default: assert.fail(`Unsupported instruction: ${line}`);
    }
  }
  assert.equal(stack.length, 1, 'balanced stack plus one result');
  for (const [key, old] of Object.entries(originals)) assert.equal(String(vars[key]), String(old), `preserved ${key}`);
  assert.equal(heap.size, 0, 'all allocated buffers freed');
  const endCalls = calls.filter(call => call.includes('::RmEndSession(')).length;
  const startSucceeded = calls.some(call => call.includes('::RmStartSession(')) && (options.startResult ?? 0) === 0;
  assert.equal(endCalls, startSucceeded ? 1 : 0, 'one cleanup per successful session');
  return { result: Number(stack[0]), sleeps, polls, registered, calls };
}

test('only the exact installed executable resource blocks setup, including an x64 process', () => {
  const target = 'C:\\Users\\Test\\AppData\\Local\\Programs\\Crush Control\\Crush Control.exe';
  assert.equal(run().result, 603);
  assert.equal(run({ processes: [{ path: target, bitness: 64 }] }).result, 0);
  assert.equal(run({ processes: [{ path: target.toUpperCase(), bitness: 32 }] }).result, 0);
  assert.equal(run({ processes: [{ path: 'D:\\Other\\Crush Control.exe' }] }).result, 603);
  assert.equal(run({ processes: [{ path: target + '.bak' }] }).result, 603);
  assert.equal(run({ processes: [{ path: target.replace('Programs\\', 'Programs-copy\\') }] }).result, 603);
});

test('Unicode paths and path normalization are retained without narrowing pointers', () => {
  for (const pointerBytes of [4, 8]) {
    const actual = run({ pointerBytes, installDir: 'D:\\Mihir कुमार\\old\\..\\Crush Control' });
    assert.equal(actual.registered, 'D:\\Mihir कुमार\\Crush Control\\Crush Control.exe');
    assert.equal(actual.result, 603);
  }
  assert.match(source, /RmStartSession\(\*i \.r0/);
  assert.match(source, /RmRegisterResources\(i r0, i 1, p r3/);
  assert.doesNotMatch(source, /PROCESSENTRY32|ReadProcessMemory|PROCESS_ALL_ACCESS/);
});

test('allocation, session, registration, query and cleanup errors all refuse setup', () => {
  const scenarios = [
    { pathError: true }, ...[1, 2, 3].map(failAllocation => ({ failAllocation })),
    { startResult: 353 }, { startResult: 'error' }, { registerResult: 5 },
    { query: [{ result: 121 }] }, { query: [{ result: 'error' }] },
    { query: [{ result: 234, needed: 0 }] },
    { query: [{ result: 0, needed: 1 }] },
    { query: [{ result: 0, count: 1 }] },
    { query: [{ result: 0, reboot: 1 }] },
    { query: [{ result: 234, needed: 1, reboot: 2 }] },
    { endResult: 6 },
  ];
  for (const scenario of scenarios) assert.equal(run(scenario).result, 1, JSON.stringify(scenario));
});

test('ordinary install/uninstall never wait; an update only waits the bounded allowance', () => {
  const busy = { result: 234, needed: 1 };
  assert.deepEqual([run({ query: [busy] }).result, run({ query: [busy] }).sleeps], [0, 0]);
  const timeout = run({ waits: 40, query: [busy] });
  assert.equal(timeout.result, 0);
  assert.equal(timeout.sleeps, 40);
  assert.equal(timeout.polls, 41);
  const graceful = run({ waits: 40, query: [busy, busy, { result: 0 }] });
  assert.equal(graceful.result, 603);
  assert.equal(graceful.sleeps, 2);
  assert.equal(run({ waits: 40, query: [busy, { result: 5 }] }).result, 1);
  assert.match(wrapper, /!ifndef BUILD_UNINSTALLER[\s\S]*\$\{If\} \$\{isUpdated\}[\s\S]*StrCpy \$R3 40[\s\S]*!endif/);
  assert.match(wrapper, /StrCpy \$R3 0/);
});

test('builder selects the custom query path and no terminating API or process plugin is called', () => {
  const template = fs.readFileSync(path.join(root, 'node_modules/app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh'), 'utf8');
  assert.match(wrapper, /!define nsProcess::FindProcess CC_NS_PROCESS_REMOVED_DO_NOT_USE/);
  assert.match(template, /!ifndef nsProcess::FindProcess\s+!include "nsProcess.nsh"\s+!endif/);
  assert.match(template, /!ifmacrodef customCheckAppRunning\s+!insertmacro customCheckAppRunning\s+!else[\s\S]*!insertmacro _CHECK_APP_RUNNING\s+!endif/);
  const common = fs.readFileSync(path.join(root, 'node_modules/app-builder-lib/templates/nsis/common.nsh'), 'utf8');
  assert.match(common, /!define APP_EXECUTABLE_FILENAME "\$\{PRODUCT_FILENAME\}\.exe"/);
  assert.doesNotMatch(source + wrapper, /nsProcess::_|RmShutdown|RmRestart|TerminateProcess|taskkill|Stop-Process|WM_CLOSE/);
  const apis = [...source.matchAll(/Rstrtmgr\.dll"::(\w+)/g)].map(match => match[1]);
  assert.deepEqual(apis, ['RmStartSession', 'RmRegisterResources', 'RmGetList', 'RmEndSession']);
});
