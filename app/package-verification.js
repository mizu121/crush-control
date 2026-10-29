'use strict';

// Explicit --verify-package mode is separate from the production controller.
// This module never imports main.js, via.js or crush80.js and all renderer IPC
// is mocked. The native addon is loaded but no device API is ever invoked.
function run(outputPath) {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const checks = [], errors = [], calls = [], requests = [];
  let win, finished = false, profile;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const result = { mode:'offline-package-verification', packaged:app.isPackaged,
    version:app.getVersion(), executable:process.execPath, hardwareCalls:0, checks, errors, calls };

  // Suppress Electron's default uncaught-error popup even if setup fails.
  const finish = error => {
    if (finished) return;
    finished = true;
    if (error) result.failure = error.stack || String(error);
    result.passed = !error;
    result.profile = profile || null;
    try { fs.writeFileSync(outputPath, JSON.stringify(result,null,2)); }
    catch (_) { /* An invalid output path is still a failed verification. */ }
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(error ? 1 : 0);
  };
  process.on('uncaughtException', finish);
  process.on('unhandledRejection', finish);
  try {
    if (typeof outputPath!=='string' || !path.isAbsolute(outputPath)) throw Error('Package verification requires an absolute JSON output path.');
    fs.mkdirSync(path.dirname(outputPath),{recursive:true});
    profile=fs.mkdtempSync(path.join(os.tmpdir(),'crush80-package-verify-'));
    app.setPath('userData',profile);
    app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  } catch (error) { finish(error); return; }
  const timeout = setTimeout(()=>finish(Error('Package verification timed out.')),45000);
  timeout.unref();

  const mock = (channel, handler) => ipcMain.handle(channel, async (_event,...args) => {
    calls.push({channel,args});
    try { return {ok:true,data:await handler(...args)}; }
    catch (error) { return {ok:false,error:error.message}; }
  });
  const { releaseInfo, distributionPaths } = require('./distribution');
  const metadata=releaseInfo({version:app.getVersion(),packaged:app.isPackaged});
  const storeBuild = ['microsoft-store', 'microsoft-store-test'].includes(metadata.distribution);
  result.distribution = metadata.distribution || 'standalone';
  mock('effects:list',()=>[[0,'Off'],[6,'Solid'],[5,'Breathe'],[1,'Wave'],[15,'Rain']].map(([id,name])=>({id,name})));
  mock('presets:list',()=>[]);
  mock('presets:builtins',()=>[]);
  mock('settings:get',()=>({openAtLogin:false,loginItemSupported:!storeBuild,storeTest:metadata.distribution==='microsoft-store-test',loginItemMessage:storeBuild?'Manage startup in Windows Settings.':''}));
  mock('status:get',()=>({connected:false,info:null}));
  mock('signalrgb:status',()=>({running:false,installed:false,current:false}));
  mock('receiver:status',()=>({linked:false,canLink:false,reason:'Connect this Crush 80 Pro by USB and insert its paired dongle once.'}));
  mock('updates:status',()=>({phase:storeBuild?'store-managed':'disabled',revision:0,currentVersion:app.getVersion(),availableVersion:null,releaseNotes:'',percent:null,message:storeBuild?'Microsoft Store package: local offline verification.':'App updates are disabled in this offline verification.',checkedAt:null,canCheck:false,canDownload:false,canInstall:false,canOpenStore:metadata.distribution==='microsoft-store',reason:'offline-verification'}));
  mock('app:info',()=>metadata);
  mock('app:open-link',kind=>{assert.equal(kind,'notices');return {opened:true,mocked:true};});

  const check = async (name, action) => { await action(); checks.push(name); };
  app.whenReady().then(async()=>{
    await check('Native HID addon loads without enumeration or opening a device',()=>{
      const hidRoot=path.dirname(require.resolve('node-hid'));
      const options={...require(path.join(hidRoot,'binding-options'))};
      if(process.platform==='linux')options.name='HID_hidraw';
      const binding=require('pkg-prebuilds/bindings')(hidRoot,options);
      assert.equal(typeof binding.HID,'function');
      assert.equal(typeof binding.devices,'function');
      result.nativeAddon={loaded:true,napi:process.versions.napi,electron:process.versions.electron,architecture:process.arch};
    });
    await check('Renderer, fonts, studio environment and notices are bundled',()=>{
      const assets=['renderer/index.html','renderer/app.js','renderer/styles.css','renderer/keyboard3d.js',
        'renderer/assets/fonts/InterVariable.woff2','renderer/assets/fonts/JetBrainsMono-Regular.woff2',
        'renderer/assets/model/studio_small_08_1k.hdr'];
      for(const asset of assets)assert.ok(fs.statSync(path.join(__dirname,asset)).size>0,asset);
      const locations=distributionPaths({packaged:app.isPackaged,root:path.dirname(__dirname),resources:process.resourcesPath,userData:profile});
      assert.ok(fs.statSync(locations.notices).size>100,'Bundled third-party notices');
      result.notices=locations.notices;
    });
    win=new BrowserWindow({width:1000,height:700,useContentSize:true,show:false,
      webPreferences:{preload:path.join(__dirname,'preload.js'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
    win.webContents.session.webRequest.onBeforeRequest((details,callback)=>{
      requests.push(details.url);
      const remote=/^https?:/.test(details.url);
      if(remote)errors.push(`Unexpected network request: ${details.url}`);
      callback({cancel:remote});
    });
    win.webContents.on('console-message',event=>{if(event.level==='error'||event.level===3)errors.push(event.message);});
    win.webContents.on('render-process-gone',(_event,details)=>errors.push(`Renderer exited: ${details.reason}`));
    const evaluate=source=>win.webContents.executeJavaScript(source);
    const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await win.loadFile(path.join(__dirname,'renderer','index.html'));await wait(500);
    await check('Packaged renderer starts offline with a 2D keyboard and local fonts',async()=>{
      assert.doesNotMatch(await evaluate(`document.querySelector('#toast').textContent`),/Couldn't load keyboard controls/);
      assert.equal(await evaluate(`document.querySelector('#keyboard-3d canvas')!==null`),false);
      assert.equal(requests.some(url=>url.includes('keyboard3d.js')||url.includes('/node_modules/three/')),false);
      await evaluate(`Promise.all([document.fonts.load('14px Inter'),document.fonts.load('12px "JetBrains Mono"')]).then(()=>document.fonts.ready).then(()=>true)`);
      assert.equal(await evaluate(`document.fonts.check('14px Inter')`),true);
      assert.equal(await evaluate(`document.fonts.check('12px "JetBrains Mono"')`),true);
      assert.ok(requests.some(url=>url.includes('styles.css')),'Renderer stylesheet loaded');
      await click('#tabs [data-view="settings"]');await click('#btn-about');await wait(100);
    });
    await check('About metadata, local notices action and compact layout work',async()=>{
      assert.equal(await evaluate(`document.querySelector('#about-title').textContent`),metadata.name);
      assert.equal(await evaluate(`document.querySelector('#about-version').textContent.includes(${JSON.stringify(app.getVersion())})`),true);
      assert.equal(await evaluate(`document.querySelector('#btn-about-donate').disabled`),!metadata.donationUrl);
      assert.equal(await evaluate(`document.querySelector('#btn-about-support').hidden`),!metadata.supportUrl);
      assert.equal(await evaluate(`document.querySelector('#btn-about-github').hidden`),!metadata.githubUrl);
      assert.equal(await evaluate(`document.querySelector('#about-error').hidden`),true);
      const fit=await evaluate(`(()=>{const d=document.querySelector('#about-dialog'),r=d.getBoundingClientRect();return {viewport:[innerWidth,innerHeight],dialog:[r.left,r.top,r.right,r.bottom],overflow:[d.scrollWidth-d.clientWidth,d.scrollHeight-d.clientHeight],page:[document.documentElement.scrollWidth,document.documentElement.scrollHeight]};})()`);
      assert.ok(fit.dialog[0]>=0&&fit.dialog[1]>=0&&fit.dialog[2]<=fit.viewport[0]&&fit.dialog[3]<=fit.viewport[1],JSON.stringify(fit));
      assert.ok(fit.overflow.every(value=>value<=1),JSON.stringify(fit));
      assert.ok(fit.page[0]<=fit.viewport[0]&&fit.page[1]<=fit.viewport[1],JSON.stringify(fit));
      await click('#btn-about-notices');await wait(30);
      assert.deepEqual(calls.filter(call=>call.channel==='app:open-link').map(call=>call.args),[['notices']]);
      win.webContents.invalidate();await wait(150);
      const screenshotPath=outputPath.replace(/\.json$/i,'')+'.png';
      fs.writeFileSync(screenshotPath,(await win.webContents.capturePage()).toPNG());
      result.screenshot=screenshotPath;
    });
    await check('Optional 3D module and Three.js dependencies resolve from the package',async()=>{
      assert.equal(await evaluate(`import(new URL('./keyboard3d.js',location.href).href).then(module=>typeof module.createKeyboardPreview)`),'function');
    });
    await check('Receiver linking is unavailable offline and battery never fabricates a reading',async()=>{
      assert.equal(await evaluate(`document.querySelector('#btn-link-receiver').disabled`),true);
      assert.equal(await evaluate(`document.querySelector('#battery-label').textContent`),'Battery —');
      win.webContents.send('status',{connected:false,info:null,battery:{percent:61,charging:null,source:'windows-bluetooth',updatedAt:'2026-10-28T18:08:18.796Z',stale:true}});
      await wait(40);
      assert.equal(await evaluate(`document.querySelector('#battery-label').textContent`),'61% · last known');
      assert.equal(await evaluate(`document.querySelector('#battery-status').title.includes('via Bluetooth')`),true);
      assert.equal(await evaluate(`document.querySelector('#battery-status').dataset.charging`),'false');
      assert.equal(calls.some(call=>call.channel==='receiver:link'),false);
    });
    await check('App update UI loads without network checks, downloads or installation',async()=>{
      assert.equal(calls.some(call=>call.channel.startsWith('updates:')),false);
      await click('#btn-about-done');await click('#btn-app-updates');await wait(60);
      assert.equal(await evaluate(`document.querySelector('#updates-current').dataset.state`),storeBuild?'store-managed':'disabled');
      assert.equal(await evaluate(`document.querySelector('#updates-version').textContent.includes(${JSON.stringify(app.getVersion())})`),true);
      assert.equal(await evaluate(`document.querySelector('#btn-updates-check').disabled`),true);
      assert.equal(await evaluate(`document.querySelector('#btn-updates-download').hidden && document.querySelector('#btn-updates-install').hidden`),true);
      assert.equal(await evaluate(`document.querySelector('#btn-updates-open-store').hidden`),metadata.distribution!=='microsoft-store');
      if(storeBuild) {
        assert.equal(await evaluate(`document.querySelector('#btn-updates-check').hidden`),true);
        assert.equal(await evaluate(`document.querySelector('#login-toggle').disabled`),true);
        assert.equal(await evaluate(`document.querySelector('#login-support-note').textContent`),'Manage startup in Windows Settings.');
        if(metadata.distribution==='microsoft-store-test') assert.equal(await evaluate('document.title'),'Crush Control · Store test');
      }
      assert.equal(await evaluate(`document.querySelector('#updates-state-detail').textContent.includes('offline verification')`),true);
      assert.equal(await evaluate(`(()=>{const d=document.querySelector('#updates-dialog'),r=d.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&d.scrollHeight<=d.clientHeight+1;})()`),true);
      assert.equal(calls.some(call=>/^updates:(check|download|install)$/.test(call.channel)),false);
    });
    await check('No renderer errors, external calls, controller imports or visible window',()=>{
      assert.deepEqual(errors,[]);
      assert.equal(win.isVisible(),false);
      assert.equal(calls.some(call=>/lighting:set|rgb:set|keymap:set/.test(call.channel)),false);
      assert.equal(calls.some(call=>call.channel.startsWith('support:')),false);
      assert.equal(fs.existsSync(path.join(profile,'support-reminder.json')),false);
      assert.equal(Object.keys(require.cache).some(filename=>/[\\/]app[\\/](?:main|via|crush80)\.js$/.test(filename)),false);
    });
    clearTimeout(timeout);finish();
  }).catch(finish);
}

module.exports={run};
