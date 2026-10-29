'use strict';
// Evaluate main-process wiring with fake Electron and keyboard objects. This
// suite cannot load node-hid, create a window, or communicate with a keyboard.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { loginItemEnabled } = require('../app/distribution');

function fixture({ pollError, startupError, shutdownError, logFailure = false, legacyLogin = false, wrapperLogin = false, packaged = false,
  presets = null, writeFailure = false, renameFailure = false, signalRunning = false, keyboardStatus = {connected:false}, captured,
  updateReady = false, shutdownWait, closeFailure } = {}) {
  const logs=[], intervals=new Set(), windows=[], ipc=new Map(), loginWrites=[], loginReads=[], writes=[], applied=[], menus=[], opened=[];
  const files=new Map(), updateCalls=[], sent=[];
  let updateState={phase:updateReady?'downloaded':'disabled',canCheck:false,canDownload:false,canInstall:updateReady};
  const filePath=path.join('/mock-user-data','presets.json');
  if(presets!==null)files.set(filePath,typeof presets==='string'?presets:JSON.stringify(presets));
  const app = new EventEmitter();
  Object.assign(app, {
    requestSingleInstanceLock:()=>true, whenReady:()=>Promise.resolve(),
    getPath:()=>'/mock-user-data', setPath(){}, setAppUserModelId:()=>{}, isPackaged:packaged, getVersion:()=> '1.0.0-beta.1',
    getLoginItemSettings(options){
      loginReads.push(options);
      const enabled=options.path==='/fake-electron'?legacyLogin:wrapperLogin;
      const args=options.path==='/fake-electron'?[]:['Hidden',options.args[4]];
      return {openAtLogin:false,executableWillLaunchAtLogin:enabled,launchItems:enabled
        ? [{name:'crush80-control',scope:'user',enabled:true,path:options.path,args}] : []};
    },
    setLoginItemSettings(options){loginWrites.push(options);},
    getAppPath:()=>'/mock-app', quitCalls:0,
    quit(){this.quitCalls++;},
  });
  let keyboard;
  class Keyboard extends EventEmitter {
    constructor(){super();keyboard=this;this.pollCalls=0;this.shutdownCalls=0;this.via={connected:false,closeFailure};}
    status(){return keyboardStatus;}
    async poll(){this.pollCalls++;if(pollError)throw pollError;}
    async shutdown(){this.shutdownCalls++;if(shutdownWait)await shutdownWait;if(shutdownError)throw shutdownError;}
    async capturePreset(){return captured;}
    async setKeyRgb(change){return this.setKeysRgb({changes:[change]});}
    async setKeysRgb(value){applied.push({kind:'keys',value});return {supported:true,enabled:true,colors:Array.from({length:92},()=>[0,0,0])};}
    async applyRgbPreset(colors,lighting){applied.push({kind:'per-key',colors,lighting});return {lighting,rgb:{supported:true,enabled:true,colors}};}
    async applyLightingPreset(lighting){applied.push({kind:'native',lighting});return {lighting,rgb:{supported:false,enabled:false,colors:null}};}
  }
  class BrowserWindow extends EventEmitter {
    constructor(options){super();if(startupError)throw startupError;this.options=options;windows.push(this);this.showCalls=0;this.webContents=new EventEmitter();this.webContents.send=(channel,data)=>sent.push({channel,data});}
    setMenuBarVisibility(){}
    isDestroyed(){return false;}
    async loadFile(){}
    show(){this.showCalls++;}
    focus(){}
  }
  class Tray extends EventEmitter { setToolTip(){} setImage(){} setContextMenu(menu){menus.push(menu);} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../app/main.js'),'utf8'), {
    __dirname:path.join(__dirname,'../app'),
    process:{argv:[],env:{},execPath:'/fake-electron',resourcesPath:'/mock-resources',exit(){throw new Error('Unexpected exit');}},
    setInterval(callback){const timer={callback};intervals.add(timer);return timer;},
    clearInterval(timer){intervals.delete(timer);},
    require(id) {
      if(id==='electron')return {app,BrowserWindow,Tray,Menu:{buildFromTemplate:items=>items},ipcMain:{handle(channel,handler){ipc.set(channel,handler);}},shell:{openPath:async target=>{opened.push(target);return '';},openExternal:async target=>{opened.push(target);}}};
      if(id==='path')return path;
      if(id==='fs')return {mkdirSync(){},readFileSync(file){if(files.has(file))return files.get(file);const e=new Error('No presets');e.code='ENOENT';throw e;},
        appendFileSync(_path,text){if(logFailure)throw new Error('Log unavailable');logs.push(text);},
        writeFileSync(file,text){if(writeFailure)throw new Error('Disk unavailable');writes.push(file);files.set(file,text);},
        renameSync(from,to){if(renameFailure)throw new Error('Rename unavailable');files.set(to,files.get(from));files.delete(from);}};
      if(id==='child_process')return {execFile(command,args,options,callback){assert.equal(command,'tasklist');callback(null,signalRunning?'SignalRgb.exe':'');}};
      if(id==='./crush80')return {Crush80:Keyboard,EFFECTS:[]};
      if(id==='./hue')return require('../app/hue');
      if(id==='./rgb-controller')return require('../app/rgb-controller');
      if(id==='./preset-library')return require('../app/preset-library');
      if(id==='./firmware-setup')return require('../app/firmware-setup');
      if(id==='./icon')return {makeIcon:()=>null,makeBatteryIcon:()=>null};
      if(id==='./receiver-link')return require('../app/receiver-link');
      if(id==='./battery')return {readBatteryStatus:async()=>({percent:null,charging:null,source:'unavailable',updatedAt:null,stale:true})};
      if(id==='./battery-presentation')return require('../app/battery-presentation');
      if(id==='./app-updater')return {createAppUpdater(options){return {
        status:()=>({...updateState}),
        async check(){updateCalls.push('check');return {...updateState};},
        async download(){updateCalls.push('download');return {...updateState};},
        async install(){
          if(!updateState.canInstall)throw Error('No verified update');
          updateState={...updateState,phase:'installing',canInstall:false};options.onChange({...updateState});
          await options.prepareInstall();updateCalls.push('install-handoff');return {...updateState};
        },
        stop(){updateCalls.push('stop');updateState={phase:'disabled',canCheck:false,canDownload:false,canInstall:false};},
      };}};
      if(id==='./update-lifecycle')return require('../app/update-lifecycle');
      if(id==='./update-security')return require('../app/update-security');
      if(id==='./update-feed')return {fetchManifest(){throw Error('No update network in lifecycle tests');}};
      if(id==='./update-config.json')return {enabled:false};
      if(id==='./distribution')return require('../app/distribution');
      if(id==='./release-config.json')return require('../app/release-config.json');
      if(id==='./support-reminder')return {createSupportReminder:()=>({recordSession:()=>({eligible:false}),claim:()=>({show:false}),dismiss:()=>({show:false})})};
      if(id==='./windows-shortcuts')return require('../app/windows-shortcuts');
      throw new Error(`Unmocked import ${id}`);
    },
  });
  return {app,logs,intervals,windows,loginReads,loginWrites,files,filePath,writes,applied,menus,opened,updateCalls,sent,
    invoke:(channel,...args)=>ipc.get(channel)(null,...args),get keyboard(){return keyboard;}};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('firmware assessment uses cached status only and ignores caller-supplied identities', async()=>{
  const keyboardStatus={connected:false};
  const f=fixture({keyboardStatus});await flush();
  const polls=f.keyboard.pollCalls;
  const forged={connected:true,info:{protocol:11,layers:4,macros:16,rows:8,cols:16,
    rgb:{firmwareCrc:0x5566ddf2,supported:true,rearFollowSupported:true,enabled:true}}};
  const disconnected=await f.invoke('firmware:status',forged);
  assert.equal(disconnected.ok,true,disconnected.error);
  assert.equal(disconnected.data.state,'disconnected');
  Object.assign(keyboardStatus,forged);
  const connected=await f.invoke('firmware:status');
  assert.equal(connected.ok,true,connected.error);
  assert.equal(connected.data.state,'combined');
  assert.equal(connected.data.installationAvailable,false);
  assert.equal(f.keyboard.pollCalls,polls);
  assert.equal(f.applied.length,0);assert.equal(f.writes.length,0);
});

test('packaged startup uses the installed executable and closes developer tools', async()=>{
  const f=fixture({packaged:true});await flush();
  assert.equal(f.windows[0].options.webPreferences.devTools,false);
  const result=await f.invoke('settings:set',{openAtLogin:true});
  assert.equal(result.ok,true,result.error);
  assert.equal(f.loginWrites[0].path,'/fake-electron');
  assert.deepEqual(Array.from(f.loginWrites[0].args),['--hidden']);
});

test('About IPC supplies version and opens only named configured destinations', async()=>{
  const f=fixture({packaged:true});await flush();
  const info=await f.invoke('app:info');assert.equal(info.ok,true,info.error);
  assert.equal(info.data.version,'1.0.0-beta.1');assert.equal(info.data.packaged,true);
  assert.equal((await f.invoke('app:open-link','https://evil.example/')).ok,false);
  assert.equal(f.opened.length,0);
  assert.equal((await f.invoke('app:open-link','notices')).ok,true);
  assert.deepEqual(f.opened,[path.join('/mock-resources','legal','THIRD_PARTY_NOTICES.txt')]);
});

test('window-all-closed has no event parameter and keeps the tray app running', async()=>{
  const f=fixture();await flush();
  assert.doesNotThrow(()=>f.app.emit('window-all-closed'));
  assert.equal(f.app.quitCalls,0);assert.equal(f.windows.length,1);
});

test('Ctrl+Q uses the graceful app quit path, while unrelated shortcuts do not',async()=>{
  const f=fixture();await flush();let prevented=0;
  const event={preventDefault(){prevented++;}};
  const send=input=>f.windows[0].webContents.emit('before-input-event',event,input);
  send({type:'keyUp',control:true,key:'q'});send({type:'keyDown',control:true,shift:true,key:'q'});send({type:'keyDown',key:'q'});
  assert.equal(f.app.quitCalls,0);send({type:'keyDown',control:true,key:'Q'});
  assert.equal(f.app.quitCalls,1);assert.equal(prevented,1);
});

test('rejected initial and interval polls are recorded without unhandled rejections', async()=>{
  const f=fixture({pollError:new Error('Enumeration unavailable')});await flush();
  assert.equal(f.keyboard.pollCalls,1);assert.match(f.logs[0],/keyboard poll: Error: Enumeration unavailable/);
  [...f.intervals][0].callback();await flush();
  assert.equal(f.keyboard.pollCalls,2);assert.equal(f.logs.length,2);assert.equal(f.app.quitCalls,0);
});

test('startup errors are recorded and begin app shutdown', async()=>{
  const f=fixture({startupError:new Error('Window creation failed')});await flush();
  assert.match(f.logs[0],/startup: Error: Window creation failed/);
  assert.equal(f.app.quitCalls,1);assert.equal(f.intervals.size,0);assert.equal(f.keyboard.pollCalls,0);
});

test('quit cancels polling, awaits one keyboard cleanup, and survives logging failure', async()=>{
  const f=fixture({shutdownError:new Error('Device disconnected'),logFailure:true});await flush();
  let prevented=0;const event={preventDefault(){prevented++;}};
  f.app.emit('before-quit',event);f.app.emit('before-quit',event);
  assert.equal(f.intervals.size,0);await flush();
  assert.equal(f.keyboard.shutdownCalls,1);assert.equal(f.app.quitCalls,1);assert.equal(prevented,2);
  f.app.emit('before-quit',event);assert.equal(prevented,2);
  assert.deepEqual(f.updateCalls,['stop']);
});

test('update install IPC awaits keyboard cleanup, closes hardware controls and ignores second-instance activation',async()=>{
  let finish;const shutdownWait=new Promise(resolve=>{finish=resolve;});
  const f=fixture({updateReady:true,shutdownWait,keyboardStatus:{connected:true,info:{rgb:{supported:true}}}});await flush();
  const install=f.invoke('updates:install');await flush();
  assert.equal(f.intervals.size,0);assert.equal(f.keyboard.shutdownCalls,1);assert.deepEqual(f.updateCalls,[]);
  assert.equal((await f.invoke('lighting:set',{brightness:1})).ok,false);
  assert.equal((await f.invoke('rgb:set-keys',{changes:[{slot:0,rgb:[1,2,3]}]})).ok,false);
  assert.equal((await f.invoke('status:get')).data.connected,false);
  assert.equal((await f.invoke('updates:status')).data.phase,'installing');
  f.app.emit('second-instance');assert.equal(f.windows[0].showCalls,0);
  assert.ok(f.sent.some(event=>event.channel==='updates:changed'&&event.data.phase==='installing'));
  finish();const result=await install;assert.equal(result.ok,true,result.error);assert.equal(result.data.phase,'installing');
  assert.deepEqual(f.updateCalls,['install-handoff']);assert.equal(f.app.quitCalls,0);
  let prevented=0;f.app.emit('before-quit',{preventDefault(){prevented++;}});
  assert.equal(prevented,0);assert.equal(f.keyboard.shutdownCalls,1);
});

test('update install refuses a close failure even when keyboard.shutdown resolves',async()=>{
  const f=fixture({updateReady:true,closeFailure:Error('Native close failed')});await flush();
  const result=await f.invoke('updates:install');assert.equal(result.ok,false);assert.match(result.error,/could not be released/);
  assert.deepEqual(f.updateCalls,[]);assert.equal(f.keyboard.shutdownCalls,1);assert.equal(f.intervals.size,0);
  assert.equal((await f.invoke('keymap:read')).ok,false);
});

test('ordinary Quit stops updater actions and waits for shared cleanup without any install handoff',async()=>{
  let finish;const shutdownWait=new Promise(resolve=>{finish=resolve;});
  const f=fixture({updateReady:true,shutdownWait});await flush();let prevented=0;
  const event={preventDefault(){prevented++;}};f.app.emit('before-quit',event);f.app.emit('before-quit',event);await flush();
  assert.equal(f.app.quitCalls,0);assert.equal(f.keyboard.shutdownCalls,1);assert.deepEqual(f.updateCalls,['stop']);
  assert.equal((await f.invoke('updates:install')).ok,false);
  finish();await flush();assert.equal(f.app.quitCalls,1);assert.equal(prevented,2);assert.deepEqual(f.updateCalls,['stop']);
});

test('reading startup preference accepts the legacy entry without changing Windows settings', async()=>{
  for(const options of [{legacyLogin:true},{wrapperLogin:true},{}]) {
    const f=fixture(options);await flush();
    const result=await f.invoke('settings:get');
    assert.equal(result.ok,true);assert.equal(result.data.openAtLogin,Boolean(options.legacyLogin||options.wrapperLogin));
    assert.equal(f.loginWrites.length,0);
  }
});

test('packaged startup UI reflects the custom enabled Run value when Electron openAtLogin is false', async()=>{
  const f=fixture({packaged:true,legacyLogin:true});await flush();
  const result=await f.invoke('settings:get');
  assert.equal(result.ok,true);assert.equal(result.data.openAtLogin,true);
  assert.equal(f.loginReads.length,1);assert.equal(f.loginWrites.length,0);
});

test('startup detection matches custom name, user scope, Windows path, reported arguments and enabled state',()=>{
  const launch={path:'C:\\Users\\Test\\Crush Control.exe',args:['--hidden']};
  // Observed Electron 45.1.0 response for a real Run value ending in --hidden.
  const item={name:'crush80-control',scope:'user',enabled:true,path:launch.path,args:[]};
  const settings=entry=>({openAtLogin:false,executableWillLaunchAtLogin:true,launchItems:[entry]});
  assert.equal(loginItemEnabled(settings(item),launch),true);
  assert.equal(loginItemEnabled(settings({...item,path:'c:/users/test/CRUSH CONTROL.exe'}),launch),true);
  for(const patch of [
    {name:'io.crush80.control'},{name:'unrelated'},{scope:'machine'},{enabled:false},{enabled:1},
    {path:'C:\\Other\\Crush Control.exe'},{args:['another-script.ps1']},{args:['--hidden','extra']},{args:null},
  ]) assert.equal(loginItemEnabled(settings({...item,...patch}),launch),false,JSON.stringify(patch));
  assert.equal(loginItemEnabled({openAtLogin:true,executableWillLaunchAtLogin:true,launchItems:[]},launch),false);
  assert.equal(loginItemEnabled({openAtLogin:true},launch),false);
});

test('PowerShell startup detection never accepts another script using the same executable',()=>{
  const launch={path:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',args:['-NoProfile','-WindowStyle','Hidden','-File','"C:\\Keyboard Project\\tools\\run-app.ps1"','-Hidden']};
  const entry={name:'crush80-control',scope:'user',enabled:true,path:launch.path,args:['Hidden','"C:\\Keyboard Project\\tools\\run-app.ps1"']};
  assert.equal(loginItemEnabled({launchItems:[entry]},launch),true);
  const unrelated={...entry,args:['Hidden','"C:\\Other Project\\run.ps1"']};
  assert.equal(loginItemEnabled({executableWillLaunchAtLogin:true,launchItems:[unrelated]},launch),false);
});

test('startup argument comparison preserves literals after the Chromium switch terminator',()=>{
  const launch={path:'C:\\Apps\\Crush Control.exe',args:['--quiet','--','--literal','file.json']};
  const entry={name:'crush80-control',scope:'user',enabled:true,path:launch.path,args:['--literal','file.json']};
  assert.equal(loginItemEnabled({launchItems:[entry]},launch),true);
  assert.equal(loginItemEnabled({launchItems:[{...entry,args:['file.json']}]},launch),false);
});

test('startup toggle launches the hidden ownership wrapper using quoted script path', async()=>{
  const f=fixture({legacyLogin:true});await flush();
  for(const openAtLogin of [true,false]) {
    assert.equal((await f.invoke('settings:set',{openAtLogin})).ok,true);
    const settings=f.loginWrites.at(-1);
    assert.equal(settings.name,'crush80-control');assert.equal(settings.openAtLogin,openAtLogin);
    assert.equal(settings.path,path.join('C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'));
    assert.deepEqual([...settings.args],['-NoProfile','-WindowStyle','Hidden','-File',`"${path.join(__dirname,'..','tools','run-app.ps1')}"`,'-Hidden']);
  }
  assert.equal(f.loginWrites.length,2);
  assert.equal((await f.invoke('settings:set',{openAtLogin:'true'})).ok,false);
  assert.equal(f.loginWrites.length,2);
});

const nativeLighting={effect:6,brightness:7,speed:1,hueDeg:195,sat:255};
const fullFrame=()=>Array.from({length:92},()=>[0,0,0]);

test('save current captures all actual per-key colors, atomically stores them, and reapplies them',async()=>{
  const colors=fullFrame();colors[36]=[0,255,40];
  const f=fixture({keyboardStatus:{connected:true,info:{rgb:{supported:true}}},
    captured:{lighting:{effect:6,brightness:5,speed:2,hue:128,sat:255},rgb:{supported:true,enabled:true,colors}}});
  await flush();
  const save=await f.invoke('presets:save',{name:' My gaming ',capture:true});assert.equal(save.ok,true,save.error);
  const stored=JSON.parse(f.files.get(f.filePath));
  assert.equal(stored[0].name,'My gaming');assert.equal(stored[0].kind,'per-key');assert.deepEqual(stored[0].colors,colors);
  assert.deepEqual(f.writes,[f.filePath+'.tmp']);assert.equal(f.files.has(f.filePath+'.tmp'),false);
  const apply=await f.invoke('presets:apply','My gaming');assert.equal(apply.ok,true,apply.error);
  assert.deepEqual(f.applied[0].colors,colors);assert.equal(f.applied[0].lighting.effect,6);
  assert.equal(apply.data.lighting.hueDeg,195);assert.deepEqual(apply.data.rgb.colors,colors);
});

test('capturing a native effect ignores an inactive or stale per-key frame',async()=>{
  for(const [enabled,effect] of [[false,6],[true,1]]) {
    const f=fixture({captured:{lighting:{effect,brightness:7,speed:1,hue:128,sat:255},rgb:{supported:true,enabled,colors:fullFrame()}}});
    await flush();const result=await f.invoke('presets:save',{name:'Native',capture:true});assert.equal(result.ok,true,result.error);
    const stored=JSON.parse(f.files.get(f.filePath))[0];assert.equal(stored.kind,'native');assert.equal(stored.colors,undefined);
  }
});

test('legacy native presets remain loadable, applicable, and separate from built-in IDs',async()=>{
  const f=fixture({presets:[{name:'wasd-only',lighting:nativeLighting}]});await flush();
  const list=await f.invoke('presets:list');assert.equal(list.data[0].kind,'native');
  const own=await f.invoke('presets:apply','wasd-only');assert.equal(own.ok,true,own.error);assert.equal(f.applied[0].kind,'native');
  const builtins=await f.invoke('presets:builtins');assert(builtins.data.some(p=>p.id==='wasd-only'));
  const builtin=await f.invoke('presets:apply',{builtinId:'wasd-only'});assert.equal(builtin.ok,true,builtin.error);assert.equal(f.applied[1].kind,'per-key');
  assert.equal((await f.invoke('presets:apply',{builtinId:'missing'})).ok,false);
});

test('malformed presets and corrupt storage never replace existing user presets or apply lighting',async()=>{
  const original=[{name:'Keep me',lighting:nativeLighting}];
  const f=fixture({presets:original});await flush();const before=f.files.get(f.filePath);
  const invalid=await f.invoke('presets:save',{name:'Broken',kind:'per-key',lighting:nativeLighting,colors:[]});
  assert.equal(invalid.ok,false);assert.equal(f.files.get(f.filePath),before);assert.equal(f.writes.length,0);
  const corrupt=fixture({presets:'{broken'});await flush();
  const result=await corrupt.invoke('presets:save',{name:'New',lighting:nativeLighting});assert.equal(result.ok,false);
  assert.equal(corrupt.files.get(corrupt.filePath),'{broken');assert.equal(corrupt.writes.length,0);
  assert.equal((await corrupt.invoke('presets:apply','New')).ok,false);assert.equal(corrupt.applied.length,0);
});

test('failed disk write or rename leaves prior preset JSON intact',async()=>{
  for(const failure of [{writeFailure:true},{renameFailure:true}]) {
    const f=fixture({...failure,presets:[{name:'Keep me',lighting:nativeLighting}]});await flush();const before=f.files.get(f.filePath);
    const result=await f.invoke('presets:save',{name:'New',lighting:nativeLighting});assert.equal(result.ok,false);
    assert.equal(f.files.get(f.filePath),before);
  }
});

test('competing SignalRGB blocks per-key preset apply and capture before keyboard operations',async()=>{
  const f=fixture({signalRunning:true,keyboardStatus:{connected:true,info:{rgb:{supported:true}}}});await flush();
  assert.equal((await f.invoke('presets:apply',{builtinId:'wasd-only'})).ok,false);
  assert.equal((await f.invoke('presets:save',{name:'Blocked',capture:true})).ok,false);
  assert.equal(f.applied.length,0);assert.equal(f.writes.length,0);
});

test('batch RGB IPC shares single-key ownership gate and returns the controller status',async()=>{
  const value={changes:[{slot:0,rgb:[0,0,0]},{slot:51,rgb:[10,20,30]}]};
  const f=fixture({keyboardStatus:{connected:true,info:{rgb:{supported:true}}}});await flush();
  const result=await f.invoke('rgb:set-keys',value);assert.equal(result.ok,true,result.error);
  assert.equal(result.data.colors.length,92);assert.deepEqual(f.applied,[{kind:'keys',value}]);
  const blocked=fixture({signalRunning:true,keyboardStatus:{connected:true,info:{rgb:{supported:true}}}});await flush();
  assert.equal((await blocked.invoke('rgb:set-keys',value)).ok,false);assert.equal(blocked.applied.length,0);
});

test('tray preset uses the same complete per-key apply path',async()=>{
  const colors=fullFrame();colors[36]=[10,20,30];
  const f=fixture({presets:[{name:'Gaming',kind:'per-key',lighting:nativeLighting,colors}]});await flush();
  const menu=f.menus.at(-1).find(item=>item.label==='Lighting presets');menu.submenu[0].click();await flush();
  assert.equal(f.applied.length,1);assert.equal(f.applied[0].kind,'per-key');assert.deepEqual(f.applied[0].colors,colors);
});
