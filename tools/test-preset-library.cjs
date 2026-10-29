'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizePreset, listBuiltins } = require('../app/preset-library');
const { keys } = require('../app/rgb-keymap.json');

test('WASD-only lights exactly the four mapped movement keys', () => {
  const preset = listBuiltins().find(p => p.id === 'wasd-only');
  const expected = keys.filter(key => ['W','A','S','D'].includes(key.name)).flatMap(key => key.slots).sort((a,b)=>a-b);
  assert.deepEqual(preset.colors.flatMap((rgb, slot) => rgb.some(Boolean) ? [slot] : []), expected);
  assert.ok(preset.lighting.brightness > 0);
});
test('clear keys preserves usable brightness and every main slot is black', () => {
  const preset = listBuiltins().find(p => p.id === 'clear-keys');
  assert.equal(preset.lighting.effect, 6); assert.ok(preset.lighting.brightness > 0);
  assert.ok(preset.colors.every(rgb => rgb.every(channel=>channel===0)));
});
test('every builtin round-trips validation and keeps grouped keys equal', () => {
  const presets = listBuiltins(); assert.equal(new Set(presets.map(p=>p.id)).size,8);
  assert.equal(presets.filter(p=>p.kind==='per-key').length,6);
  for(const p of presets) {
    const clean=normalizePreset(p); assert.equal(clean.name,p.name);
    if(p.kind==='per-key') for(const key of keys) for(const slot of key.slots) assert.deepEqual(clean.colors[slot],clean.colors[key.slot]);
  }
});
test('native legacy presets remain readable and fields are sanitized',()=>{
  const p={name:' Evening ',lighting:{effect:5,brightness:7,speed:1,hueDeg:360,sat:180},unexpected:true};
  assert.deepEqual(normalizePreset(p),{version:2,name:'Evening',kind:'native',lighting:{effect:5,brightness:7,speed:1,hueDeg:0,sat:180}});
});
test('invalid or sparse frames, split Caps/Space, names and effects are rejected',()=>{
  const source=listBuiltins()[0];
  for(const mutate of [
    p=>p.colors.length=91, p=>delete p.colors[10], p=>delete p.colors[10][1],
    p=>p.colors[1]=[0,256,0], p=>p.colors[52]=[2,3,4], p=>p.colors[84]=[2,3,4],
    p=>p.lighting.effect=1, p=>p.lighting.brightness=-1, p=>p.lighting.hueDeg=NaN,
    p=>p.name='', p=>p.name='x'.repeat(33), p=>p.version=999,
  ]) {const p=structuredClone(source);mutate(p);assert.throws(()=>normalizePreset(p));}
});
test('editing returned preset colors never mutates the saved catalog or input',()=>{
  const a=listBuiltins(), b=listBuiltins(); a[0].colors[0][0]=123;
  assert.notEqual(a[0].colors[0][0],b[0].colors[0][0]);
  const saved=normalizePreset(b[0]);saved.colors[0][0]=198;assert.equal(b[0].colors[0][0],0);
});
