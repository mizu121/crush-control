'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { RgbController, COMBINED_CRC, MAPPED_KEYS, hsvToRgb } = require('../app/rgb-controller');
const { queryFirmwareIdentity } = require('../app/firmware-identity');
const { PkrgSimulator } = require('./fixtures/pkrg-simulator.cjs');

function fixture(options) {
  const transport = new PkrgSimulator(options);
  let lighting = { brightness: 7, effect: 6, speed: 1, hue: 160, sat: 255, rainbowLocked: false };
  const native = [];
  const controller = new RgbController({ transport, getLighting: async () => ({ ...lighting }),
    setLighting: async change => { native.push({ ...change }); lighting = { ...lighting, ...change }; } });
  return { transport, native, controller, lighting: () => ({ ...lighting }) };
}

test('OEM identity helper has one fixed report and closes on success and failure', () => {
  for (const fail of [false, true]) {
    let writes = 0, closes = 0, read = 0;
    const device = { write(packet) {
      writes++;
      assert.deepEqual(packet, [5,1,0,0,...Array(29).fill(255),...Array(31).fill(0)]);
      if (fail) throw new Error('write failure');
      return 64;
    }, readTimeout() {
      if (read++ === 0) return [];
      const reply = Buffer.alloc(64); reply.set([5,1,8,0]); reply.writeUInt32LE(COMBINED_CRC,8); return reply;
    }, close() { closes++; } };
    const HID = { devices: () => [{interface:2,usagePage:0xffef,path:'exact'}], HID: function(selected) { assert.equal(selected,'exact');return device; } };
    if (fail) assert.throws(() => queryFirmwareIdentity(HID), /write failure/);
    else assert.deepEqual(queryFirmwareIdentity(HID), {version:0,crc:COMBINED_CRC});
    assert.equal(writes,1);assert.equal(closes,1);
  }
  assert.throws(() => queryFirmwareIdentity({devices:()=>[]}), /Expected one/);
});

test('stock and unknown firmware never send PKRG traffic or enable overrides', async () => {
  for (const identity of [null, {crc:0xa7da1601}, {crc:0x5954ff66}]) {
    const f = fixture();
    await f.controller.initialize(identity);
    await f.controller.applyLighting({hue:6,sat:255,rgb:[255,128,0]});
    const status = await f.controller.status();
    assert.equal(status.supported,false);assert.equal(status.colors,null);
    assert.equal(f.transport.requests.length,0);
    assert.deepEqual(f.native,[{hue:6,sat:255}]);
    await assert.rejects(f.controller.setKey({slot:0,rgb:[1,2,3]}));
    assert.equal(f.transport.requests.length,0);
  }
});

test('exact CRC still requires exact PKRG contract; mismatch fails closed', async () => {
  const f = fixture({supported:false});
  await f.controller.initialize({crc:COMBINED_CRC});
  assert.equal(f.controller.metadata().supported,false);
  await assert.rejects(f.controller.applyLighting({hue:1,sat:255,rgb:[255,0,0]}));
  assert.equal(f.native.length,0);
  assert.equal(f.transport.requests.some(request=>request[0]===7),false);
});

test('startup discovery/status are read-only and distinguish derived mappings from physical observations', async () => {
  const f = fixture();
  await f.controller.initialize({crc:COMBINED_CRC});
  const status = await f.controller.status();
  assert.deepEqual(status.verifiedKeys.map(({name,slot})=>({name,slot})),[{name:'Esc',slot:0},{name:'F1',slot:1},{name:'F2',slot:2},{name:'F3',slot:3},{name:'F4',slot:4}]);
  assert.equal(status.mappedKeys.length,88);
  assert.equal(status.mappedKeys.filter(key=>key.physicallyObserved).length,5);
  assert.equal(status.mappingSource,'stock-table-and-native-cpu-path');
  assert.equal(status.supported,true);assert.equal(status.enabled,false);
  assert.equal(f.native.length,0);assert.equal(f.controller.saved,null);
  assert.equal(f.transport.requests.some(request=>request[0]===7),false);
  await assert.rejects(f.controller.setKey({slot:64,rgb:[255,0,0]}),/mapped physical/);
  assert.equal(f.transport.requests.some(request=>request[0]===7),false);
});

test('canonical physical keys have unique targets and contiguous nonoverlapping LED groups',()=>{
  const used=new Set(), layouts=new Set(), names=new Set();
  for(const key of MAPPED_KEYS) {
    assert(!layouts.has(key.layoutIndex));layouts.add(key.layoutIndex);
    assert(!names.has(key.name));names.add(key.name);
    assert(key.slots.includes(key.slot));assert(key.slots.length>=1&&key.slots.length<=3);
    for(let index=0;index<key.slots.length;index++) {
      const slot=key.slots[index];assert.equal(slot,key.slots[0]+index);
      assert(Number.isInteger(slot)&&slot>=0&&slot<92);assert(!used.has(slot));used.add(slot);
    }
  }
  assert.equal(used.size,91);assert(!used.has(64));
});

test('Caps and Space change all grouped LEDs with one verified range and preserve every neighbor',async()=>{
  for(const [slot,expected] of [[51,[51,52]],[83,[82,83,84]]]) {
    const f=fixture({mode:1});await f.controller.initialize({crc:COMBINED_CRC});
    const original=f.transport.colors.map(rgb=>[...rgb]),color=[91,34,172];
    const status=await f.controller.setKey({slot,rgb:color});
    for(let index=0;index<92;index++) assert.deepEqual(status.colors[index],expected.includes(index)?color:original[index]);
    const writes=f.transport.requests.filter(request=>request[0]===7&&request[2]===2);
    assert.equal(writes.length,1);assert.deepEqual(writes[0].slice(4,6),[expected[0],expected.length]);
    assert.equal(f.transport.maxInFlight,1);
  }
});

test('batch edits coalesce adjacent targets, include grouped black keys, and read one final status',async()=>{
  const f=fixture({mode:1});await f.controller.initialize({crc:COMBINED_CRC});
  const original=f.transport.colors.map(rgb=>[...rgb]);
  const changes=[{slot:83,rgb:[170,0,255]},{slot:51,rgb:[0,0,0]},{slot:1,rgb:[0,255,90]},
    {slot:0,rgb:[255,255,255]},{slot:3,rgb:[255,70,0]}];
  let statuses=0;const status=f.controller.status.bind(f.controller);f.controller.status=async()=>{statuses++;return status();};
  const result=await f.controller.setKeys({changes});
  const expected=original.map(rgb=>[...rgb]);
  for(const change of changes)for(const slot of MAPPED_KEYS.find(key=>key.slot===change.slot).slots)expected[slot]=change.rgb;
  assert.deepEqual(result.colors,expected);assert.equal(statuses,1);assert.equal(f.transport.maxInFlight,1);
  const writes=f.transport.requests.filter(request=>request[0]===7&&request[2]===2);
  assert.deepEqual(writes.map(request=>request.slice(4,6)),[[0,2],[3,1],[51,2],[82,3]]);
  assert.deepEqual(result.colors[64],original[64]);assert.deepEqual(f.native,[{effect:6}]);
  assert(writes.every(request=>request[4]+request[5]<=92));
});

test('every batch item is validated before capture or mutation, including sparse and duplicate targets',async()=>{
  const f=fixture({mode:1});await f.controller.initialize({crc:COMBINED_CRC});
  const requests=f.transport.requests.length, valid={slot:0,rgb:[10,20,30]};
  for(const value of [undefined,{}, {changes:[]},{changes:Array(2)},
    {changes:[valid,{slot:64,rgb:[10,20,30]}]},{changes:[valid,{slot:92,rgb:[10,20,30]}]},
    {changes:[valid,{slot:52,rgb:[10,20,30]}]},{changes:[valid,{slot:1,rgb:Array(3)}]},
    {changes:[valid,{slot:1,rgb:[10,20,NaN]}]},{changes:[valid,valid]},
    {changes:Array.from({length:89},()=>valid)}]) {
    await assert.rejects(f.controller.setKeys(value));
  }
  assert.equal(f.transport.requests.length,requests);assert.equal(f.native.length,0);assert.equal(f.controller.saved,null);
});

test('all 88 selected keys upload in twelve chunks while leaving alternate slot64 and external zones alone',async()=>{
  const f=fixture({mode:1});await f.controller.initialize({crc:COMBINED_CRC});
  const untouched=[...f.transport.colors[64]];
  await f.controller.setKeys({changes:MAPPED_KEYS.map(key=>({slot:key.slot,rgb:[0,0,0]}))});
  assert(f.transport.colors.every((rgb,slot)=>slot===64?rgb.join()===untouched.join():rgb.every(value=>value===0)));
  const writes=f.transport.requests.filter(request=>request[0]===7&&request[2]===2);
  assert.equal(writes.length,12);
  assert(writes.every(request=>request[4]+request[5]<=92&&!(request[4]<=64&&request[4]+request[5]>64)));
  assert.equal(f.transport.requests.filter(request=>request[0]===7&&request[2]===1).length,1);
  assert.deepEqual(f.native,[{effect:6}]);
});

test('first batch seeds once and later edits resume the existing per-key frame after an animation',async()=>{
  const f=fixture();await f.controller.initialize({crc:COMBINED_CRC});
  await f.controller.setKeys({changes:[{slot:0,rgb:[0,0,0]},{slot:51,rgb:[255,20,30]}]});
  assert.deepEqual(f.transport.colors[0],[0,0,0]);assert.deepEqual(f.transport.colors[51],[255,20,30]);
  assert.deepEqual(f.transport.colors[52],[255,20,30]);assert.deepEqual(f.transport.colors[64],[0,0,255]);
  const frame=f.transport.colors.map(rgb=>[...rgb]);
  await f.controller.applyLighting({effect:5});const requests=f.transport.requests.length;
  await f.controller.setKeys({changes:[{slot:1,rgb:[70,80,90]},{slot:2,rgb:[0,0,0]}]});
  for(let slot=0;slot<92;slot++)assert.deepEqual(f.transport.colors[slot],slot===1?[70,80,90]:slot===2?[0,0,0]:frame[slot]);
  const writes=f.transport.requests.slice(requests).filter(request=>request[0]===7&&request[2]===2);
  assert.equal(writes.length,1);assert.deepEqual(writes[0].slice(4,6),[1,2]);
});

test('nonprimary, unassigned and status slots are rejected before any write',async()=>{
  const f=fixture();await f.controller.initialize({crc:COMBINED_CRC});
  for(const slot of [52,82,84,64,92,104,108,-1,0.5,NaN,'0']) {
    await assert.rejects(f.controller.setKey({slot,rgb:[1,2,3]}),/mapped physical/);
  }
  await assert.rejects(f.controller.setKey({slot:0,rgb:Array(3)}),/three integer/);
  assert.equal(f.transport.requests.some(request=>request[0]===7),false);assert.equal(f.native.length,0);
});

test('renderer metadata is a copy and cannot mutate the canonical LED groups',async()=>{
  const f=fixture({mode:1});await f.controller.initialize({crc:COMBINED_CRC});
  const key=f.controller.metadata().mappedKeys.find(key=>key.slot===51);
  key.slots[0]=0;key.matrix[0][0]=7;key.slot=64;
  const metadata=f.controller.metadata().mappedKeys.find(key=>key.slot===51);
  assert.deepEqual(metadata.slots,[51,52]);assert.notEqual(metadata.matrix[0][0],7);
  await f.controller.setKey({slot:51,rgb:[1,2,3]});
  assert.deepEqual(f.transport.colors[51],[1,2,3]);assert.deepEqual(f.transport.colors[52],[1,2,3]);
  assert.notDeepEqual(f.transport.colors[0],[1,2,3]);
});

test('first individual edit seeds untouched keys from current color, then edits only the target', async () => {
  const f=fixture();await f.controller.initialize({crc:COMBINED_CRC});
  const original=f.transport.colors.map(rgb=>[...rgb]);
  await f.controller.setKey({slot:0,rgb:[255,0,0]});
  assert.deepEqual(f.transport.colors[0],[255,0,0]);
  assert(f.transport.colors.slice(1).every(rgb=>rgb.join(',')==='0,0,255'));
  const frame=f.transport.colors.map(rgb=>[...rgb]);
  await f.controller.setKey({slot:1,rgb:[0,255,0]});
  assert.deepEqual(f.transport.colors[1],[0,255,0]);
  assert.deepEqual(f.transport.colors.slice(2),frame.slice(2));
  assert.equal(f.transport.mode,1);assert.equal(f.lighting().effect,6);
  await f.controller.release();
  assert.equal(f.transport.mode,0);assert.deepEqual(f.transport.colors,original);
  assert.equal(f.lighting().brightness,7);assert.equal(f.lighting().hue,160);
});

test('newly observed F2 through F4 mappings edit exactly their verified slots', async () => {
  const f=fixture({mode:1});await f.controller.initialize({crc:COMBINED_CRC});
  const original=f.transport.colors.map(rgb=>[...rgb]);
  for (const slot of [2,3,4]) await f.controller.setKey({slot,rgb:[slot,11,23]});
  for(let slot=0;slot<92;slot++) assert.deepEqual(f.transport.colors[slot],slot>=2&&slot<=4?[slot,11,23]:original[slot]);
});

test('whole-board direct RGB preserves requested color independently of calibrated OEM hue', async () => {
  const f=fixture();await f.controller.initialize({crc:COMBINED_CRC});
  const rgb=hsvToRgb(30,255);
  assert.deepEqual(rgb,[255,128,0]);
  await f.controller.applyLighting({hue:6,sat:255,rgb});
  assert(f.transport.colors.every(color=>color.join(',')===rgb.join(',')));
  assert.deepEqual(f.native.at(-1),{hue:6,sat:255});
  assert.equal(f.transport.mode,1);
});

test('full per-key presets blank during verified upload, preserve black keys, and release the original session', async () => {
  const f=fixture({mode:1});await f.controller.initialize({crc:COMBINED_CRC});
  const original=f.transport.colors.map(rgb=>[...rgb]), beforeLighting=f.lighting();
  const colors=Array.from({length:92},()=>[0,0,0]);
  for(const name of ['W','A','S','D']) for(const slot of MAPPED_KEYS.find(key=>key.name===name).slots) colors[slot]=[0,255,70];
  const sequence=[];const native=f.controller.setNativeLighting;
  f.controller.setNativeLighting=async change=>{sequence.push({native:{...change}});await native(change);};
  f.transport.beforeRequest=async request=>{if(request[0]===7)sequence.push({op:request[2],value:request[4],mode:f.transport.mode,brightness:f.lighting().brightness});};
  const result=await f.controller.applyPreset(colors,{effect:6,brightness:5,speed:2,hue:96,sat:255});
  assert.deepEqual(result.colors,colors);assert.equal(result.enabled,true);
  assert.deepEqual(sequence[0],{native:{brightness:0}});
  const chunks=sequence.filter(item=>item.op===2);
  assert.equal(chunks.length,12);assert(chunks.every(item=>item.mode===0&&item.brightness===0));
  assert.deepEqual(sequence.at(-1),{native:{brightness:5}});
  assert.equal(sequence.filter(item=>item.op===1).at(-1).value,1);
  assert.equal(f.transport.requests.some(request=>request[0]===9),false);
  await f.controller.release();
  assert.equal(f.transport.mode,0);assert.deepEqual(f.transport.colors,original);
  assert.deepEqual(f.lighting(),beforeLighting);
});

test('invalid full-frame preset or unsupported firmware performs no state changes', async () => {
  const frame=Array.from({length:92},()=>[0,0,0]);
  const lighting={effect:6,brightness:7,speed:1,hue:128,sat:255};
  const f=fixture();await f.controller.initialize({crc:COMBINED_CRC});
  const requests=f.transport.requests.length;
  for(const [colors,native] of [[frame.slice(1),lighting],[Array(92),lighting],[frame,{...lighting,effect:5}],
      [frame,{...lighting,brightness:10}],[frame,{...lighting,hue:0}],[frame,{...lighting,sat:NaN}]]) {
    await assert.rejects(f.controller.applyPreset(colors,native));
  }
  assert.equal(f.transport.requests.length,requests);assert.equal(f.native.length,0);assert.equal(f.controller.saved,null);
  const stock=fixture();await stock.controller.initialize({crc:0xa7da1601});
  await assert.rejects(stock.controller.applyPreset(frame,lighting));
  assert.equal(stock.transport.requests.length,0);assert.equal(stock.native.length,0);
});

test('failed preset upload never enables an incomplete frame or restores visible brightness', async () => {
  const f=fixture({mode:1});await f.controller.initialize({crc:COMBINED_CRC});
  f.transport.mutateReply=(request,reply)=>{
    if(request[0]===7&&request[2]===2&&request[4]===16)reply[6]^=1;
    return reply;
  };
  await assert.rejects(f.controller.applyPreset(Array.from({length:92},()=>[10,20,30]),
    {effect:6,brightness:7,speed:1,hue:128,sat:255}),/acknowledgement/);
  assert.equal(f.transport.mode,0);assert.equal(f.lighting().brightness,0);
  assert.equal(f.controller.metadata().supported,false);
  assert.equal(f.transport.requests.some(request=>request[0]===7&&request[2]===1&&request[4]===1),false);
  assert.deepEqual(f.native,[{brightness:0}]);
});

test('native effects disable override; returning to solid retains the chosen per-key frame', async () => {
  const f=fixture();await f.controller.initialize({crc:COMBINED_CRC});
  await f.controller.setKey({slot:0,rgb:[1,2,3]});
  const frame=f.transport.colors.map(rgb=>[...rgb]);
  await f.controller.applyLighting({effect:5,brightness:4});
  assert.equal(f.transport.mode,0);assert.equal(f.lighting().effect,5);
  await f.controller.applyLighting({effect:6});
  assert.equal(f.transport.mode,1);assert.deepEqual(f.transport.colors,frame);
  assert.equal(f.lighting().brightness,4);
});

test('transport failure invalidates combined controls rather than silently sending native fallback', async () => {
  const f=fixture();await f.controller.initialize({crc:COMBINED_CRC});
  f.transport.beforeRequest=async()=>{throw new Error('disconnected');};
  await assert.rejects(f.controller.setKey({slot:0,rgb:[1,2,3]}));
  const nativeCount=f.native.length, requests=f.transport.requests.length;
  await assert.rejects(f.controller.applyLighting({effect:6,hue:1,sat:255,rgb:[255,0,0]}));
  assert.equal(f.native.length,nativeCount);assert.equal(f.transport.requests.length,requests);
});

function loadKeyboard(FakeVia) {
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../app/crush80.js'),'utf8'),{
    module, require(id) {
      if(id==='events') return {EventEmitter};
      if(id==='./via') return {ViaDevice:FakeVia,CMD:{PROTOCOL_VERSION:1,MACRO_COUNT:12,LAYER_COUNT:17,KEYMAP_GET_BUFFER:18,CUSTOM_SET:7,CUSTOM_GET:8,CUSTOM_SAVE:9}};
      if(id==='./keymap-reader') return require('../app/keymap-reader');
      if(id==='./rgb-controller') return require('../app/rgb-controller');
      throw new Error(id);
    },
  });
  return module.exports.Crush80;
}

test('connected-device enumeration failures disconnect cleanly and allow another poll', async () => {
  const failure = new Error('USB enumeration failed');
  class FakeVia extends EventEmitter {
    constructor(){super();this.connected=true;this.closes=0;}
    static finds=0;
    static find(){if(this.finds++===0)throw failure;return null;}
    close(){this.closes++;this.connected=false;this.emit('close');}
    async open(){return false;}
  }
  const keyboard=new (loadKeyboard(FakeVia))();keyboard.info={layers:4};
  const errors=[];keyboard.on('error',error=>errors.push(error));
  await keyboard.poll();
  assert.equal(keyboard.via.closes,1);assert.equal(keyboard.info,null);
  assert.equal(keyboard.polling,false);assert.deepEqual(errors,[failure]);
  await keyboard.poll();
  assert.equal(keyboard.polling,false);assert.equal(errors.length,1);
});

test('app operation queue keeps full lighting transactions together and rejects queued work after disconnect', async () => {
  class FakeVia extends EventEmitter { constructor(){super();this.connected=true;} }
  const Crush80=loadKeyboard(FakeVia), keyboard=new Crush80();keyboard.info={layers:4};
  const calls=[];let resolve;
  keyboard.rgb={applyLighting:async change=>{calls.push('start'+change.effect);if(change.effect===6)await new Promise(r=>{resolve=r;});calls.push('end'+change.effect);},dispose(){},metadata:()=>({supported:false})};
  const first=keyboard.setLighting({effect:6}), second=keyboard.setLighting({effect:5});
  await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['start6']);
  resolve();await Promise.all([first,second]);assert.deepEqual(calls,['start6','end6','start5','end5']);
  const queued=keyboard.setLighting({effect:7});keyboard.via.emit('close');
  await assert.rejects(queued,/connection changed/);
  assert.deepEqual(calls,['start6','end6','start5','end5']);
});

test('preset upload snapshots queued input and capture waits for the complete upload', async()=>{
  class FakeVia extends EventEmitter { constructor(){super();this.connected=true;} }
  const keyboard=new (loadKeyboard(FakeVia))();keyboard.info={layers:4};
  const calls=[];let unblock;
  keyboard._getLighting=async()=>{calls.push('lighting');return {effect:6,brightness:7,speed:1,hue:128,sat:255};};
  keyboard.rgb={applyPreset:async(colors)=>{calls.push(['frame',colors[0][0]]);await new Promise(resolve=>{unblock=resolve;});return {supported:true,enabled:true,colors};},
    status:async()=>{calls.push('rgb');return {supported:true,enabled:true,colors:[]};},metadata:()=>({supported:true})};
  const colors=Array.from({length:92},()=>[11,22,33]);
  const upload=keyboard.applyRgbPreset(colors,{effect:6,brightness:7,speed:1,hue:128,sat:255});
  colors[0][0]=200;
  const capture=keyboard.capturePreset();
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[['frame',11]]);
  unblock();const result=await upload;await capture;
  assert.equal(result.rgb.colors[0][0],11);assert.deepEqual(calls,[['frame',11],'lighting','lighting','rgb']);
});

test('queued batch input is copied deeply and remains one whole operation',async()=>{
  class FakeVia extends EventEmitter { constructor(){super();this.connected=true;} }
  const keyboard=new (loadKeyboard(FakeVia))();keyboard.info={layers:4};
  let release;const calls=[];
  keyboard.rgb={applyLighting:async()=>{calls.push('lighting-start');await new Promise(resolve=>{release=resolve;});calls.push('lighting-end');},
    setKeys:async value=>{calls.push(value);return {supported:true};},metadata:()=>({supported:true})};
  const first=keyboard.setLighting({effect:6});
  const value={changes:[{slot:0,rgb:[10,20,30]},{slot:51,rgb:[0,0,0]}]};
  const batch=keyboard.setKeysRgb(value);value.changes[0].rgb[0]=255;value.changes[1].slot=64;value.changes.push({slot:92,rgb:[0,0,0]});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,['lighting-start']);
  release();await first;await batch;
  assert.equal(calls[1],'lighting-end');assert.deepEqual(JSON.parse(JSON.stringify(calls[2])),{changes:[{slot:0,rgb:[10,20,30]},{slot:51,rgb:[0,0,0]}]});
  const before=calls.length;await assert.rejects(keyboard.setKeysRgb({changes:[{slot:0,rgb:[0,0,0]},{slot:64,rgb:[0,0,0]}]}));
  assert.equal(calls.length,before);
});

test('capture cannot silently downgrade failed combined firmware to a whole-board preset',async()=>{
  class FakeVia extends EventEmitter { constructor(){super();this.connected=true;} }
  const keyboard=new (loadKeyboard(FakeVia))();keyboard.info={layers:4};
  let reads=0;keyboard._getLighting=async()=>{reads++;return {};};
  keyboard.rgb={identity:{crc:COMBINED_CRC},requireSupport(){throw new Error('Reconnect required');},client:{invalidate(){}}};
  await assert.rejects(keyboard.capturePreset(),/Reconnect required/);assert.equal(reads,0);
});

test('combined, unknown, and unavailable identities cannot SAVE or invalidate a valid capability', async () => {
  class FakeVia extends EventEmitter { constructor(){super();this.connected=true;} request(){throw new Error('Must not send SAVE');} }
  for (const identity of [{crc:COMBINED_CRC},{crc:0x5954ff66},null]) {
    const keyboard=new (loadKeyboard(FakeVia))();keyboard.info={layers:4};
    let invalidations=0;
    keyboard.rgb={identity,metadata:()=>({supported:true}),client:{invalidate(){invalidations++;}}};
    await assert.rejects(keyboard.saveLighting(),/verified stock firmware/);
    assert.equal(invalidations,0);
  }
});

test('graceful shutdown restores an acquired session and does not write for an unused app', async () => {
  for(const acquired of [false,true]) {
    let closed=0,released=0;
    class FakeVia extends EventEmitter { close(){closed++;this.emit('close');} }
    const keyboard=new (loadKeyboard(FakeVia))();keyboard.info={layers:4};
    keyboard.rgb={saved:acquired?{}:null,metadata:()=>({supported:true}),release:async()=>{released++;},dispose(){}};
    await keyboard.shutdown();
    assert.equal(closed,1);assert.equal(released,acquired?1:0);
    await assert.rejects(keyboard.getLighting(),/connection changed/);
  }
});

test('VIA transport snapshots queued bytes, rejects stale epochs, and validates exact reply length', async () => {
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../app/via.js'),'utf8'),{
    module,setTimeout,clearTimeout, require(id){
      if(id==='events')return{EventEmitter};
      if(id==='node-hid')return{};
      if(id==='node:crypto')return require('node:crypto');
      if(id==='./firmware-identity')return{queryFirmwareIdentity:()=>{throw new Error('Must not query identity');}};
      throw new Error(id);
    },
  });
  const via=new module.exports.ViaDevice();
  const writes=[];
  via.dev={write:async report=>{writes.push([...report]);return report.length;},close:async()=>{}};
  const command=[8,3,1];
  const first=via.request(command);command[2]=4;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes[0][3],1);
  const rejection=assert.rejects(first,/exactly 32/);
  via.onData(Buffer.from([8,3,1]));await rejection;
  const stale=via.request([8,3,2]);via.close();
  await assert.rejects(stale,/stale request discarded/);
  assert.equal(writes.length,1);
});

test('old HID handles cannot answer or close a new connection; close cancels an outstanding open', async () => {
  class Handle extends EventEmitter {
    constructor(){super();this.closes=0;}
    async write(report){return report.length;}
    async close(){this.closes++;}
  }
  const handles=[new Handle(),new Handle()];let resolveOpen;
  const HID={devices:()=>[{vendorId:0x320f,productId:0x5055,interface:1,usagePage:0xff60,usage:0x61,path:'via'}],HIDAsync:{open:async()=>handles.shift()}};
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../app/via.js'),'utf8'),{
    module,setTimeout,clearTimeout,require(id){
      if(id==='events')return{EventEmitter};if(id==='node-hid')return HID;
      if(id==='node:crypto')return require('node:crypto');
      if(id==='./firmware-identity')return{queryFirmwareIdentity:()=>{throw new Error('No identity here');}};
      throw new Error(id);
    },
  });
  const via=new module.exports.ViaDevice();
  await via.open();const old=via.dev;via.close();await via.open();const current=via.dev;
  const request=via.request([8,3,1]);await new Promise(resolve=>setImmediate(resolve));
  const reply=Buffer.alloc(32);reply.set([8,3,1,7]);
  old.emit('data',reply);old.emit('error',new Error('late old handle error'));
  assert.equal(via.dev,current);assert(via.pending);
  current.emit('data',reply);assert.deepEqual([...await request],[...reply]);
  await via.close();
  HID.HIDAsync.open=()=>new Promise(resolve=>{resolveOpen=resolve;});
  const pendingOpen=via.open();via.close();const canceled=new Handle();resolveOpen(canceled);
  assert.equal(await pendingOpen,false);assert.equal(canceled.closes,1);assert.equal(via.connected,false);
});
