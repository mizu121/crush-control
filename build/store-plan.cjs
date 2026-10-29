'use strict';
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STORE_STAGE = path.join(ROOT, 'build', '.store-stage');
const UNSIGNED_OID = 'OID.2.25.311729368913984317654407730594956997722=1';
const TEST_IDENTITY = Object.freeze({
  name: 'mi0ir.CrushControl.StoreTest',
  publisher: `CN=Crush Control Local Test, ${UNSIGNED_OID}`,
  publisherDisplayName: 'mi0ir (local test)',
  displayName: 'Crush Control Store Test',
  version: '1.0.0.0',
});
const APP_ID = 'CrushControl';
const STARTUP_TASK_ID = 'CrushControlStartup';
const SDK_VERSION = '10.0.26100.0';
const SDK_TOOL = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin', SDK_VERSION, 'x64', 'makeappx.exe');
const ASSETS = Object.freeze({ 'StoreLogo.png': 50, 'Square44x44Logo.png': 44, 'Square150x150Logo.png': 150 });

function validateIdentity(identity, mode) {
  if (!['test', 'store'].includes(mode)) throw new Error('Choose test or store package mode.');
  if (!identity || Object.keys(identity).sort().join(',') !== 'displayName,name,publisher,publisherDisplayName,version') throw new Error('Store identity must contain exactly name, publisher, publisherDisplayName, displayName and version.');
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$/.test(identity.name)) throw new Error('Invalid MSIX identity name.');
  for (const name of ['publisher', 'publisherDisplayName', 'displayName']) {
    if (typeof identity[name] !== 'string' || !identity[name].trim() || identity[name] !== identity[name].trim() || identity[name].length > 256 || /[\x00-\x1f]/.test(identity[name])) throw new Error(`Invalid MSIX ${name}.`);
  }
  if (!identity.publisher.startsWith('CN=')) throw new Error('Supply the complete CN publisher identity from Partner Center.');
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.0$/.exec(identity.version);
  if (!match || match.slice(1).some(value => Number(value) > 65535) || Number(match[1]) === 0) throw new Error('MSIX version must be major.minor.build.0, with each component in range and major nonzero.');
  if (mode === 'test') {
    for (const key of ['name', 'publisher', 'publisherDisplayName', 'displayName']) if (identity[key] !== TEST_IDENTITY[key]) throw new Error('Local test identity is fixed and must remain distinct from the Store.');
  } else if (identity.publisher.includes('OID.') || identity.name === TEST_IDENTITY.name || /local test|store test/i.test(identity.displayName)) {
    throw new Error('Store packages require the real reserved identity and must exclude the unsigned test OID.');
  }
  return { ...identity };
}

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function manifestXml(identity, mode) {
  const value = validateIdentity(identity, mode);
  const e = escapeXml;
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
 xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
 xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
 xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
 xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
 IgnorableNamespaces="uap uap10 desktop rescap">
 <Identity Name="${e(value.name)}" Publisher="${e(value.publisher)}" Version="${e(value.version)}" ProcessorArchitecture="x64" />
 <Properties><DisplayName>${e(value.displayName)}</DisplayName><PublisherDisplayName>${e(value.publisherDisplayName)}</PublisherDisplayName><Description>Keyboard lighting and presets for the tested WOBKEY Crush 80 Pro.</Description><Logo>Assets\\StoreLogo.png</Logo></Properties>
 <Resources><Resource Language="en-US" /></Resources>
 <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="${SDK_VERSION}" /></Dependencies>
 <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
 <Applications><Application Id="${APP_ID}" Executable="app\\Crush Control.exe" EntryPoint="Windows.FullTrustApplication" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
  <uap:VisualElements DisplayName="${e(value.displayName)}" Description="Keyboard lighting and presets for the tested WOBKEY Crush 80 Pro." BackgroundColor="transparent" Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png" />
  <Extensions><desktop:Extension Category="windows.startupTask" Executable="app\\Crush Control.exe" EntryPoint="Windows.FullTrustApplication" uap10:Parameters="--hidden"><desktop:StartupTask TaskId="${STARTUP_TASK_ID}" Enabled="false" DisplayName="${e(value.displayName)}" /></desktop:Extension></Extensions>
 </Application></Applications>
</Package>
`;
}

function distributionOverride(config, mode) {
  if (!['test', 'store'].includes(mode)) throw new Error('Invalid Store mode.');
  return { ...config, distribution: mode === 'test' ? 'microsoft-store-test' : 'microsoft-store', channel: mode === 'test' ? 'store-test' : 'store' };
}

module.exports = { ROOT, STORE_STAGE, UNSIGNED_OID, TEST_IDENTITY, APP_ID, STARTUP_TASK_ID, SDK_VERSION, SDK_TOOL, ASSETS, validateIdentity, manifestXml, distributionOverride };
