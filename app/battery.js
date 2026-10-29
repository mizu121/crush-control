'use strict';

// Windows property-cache reader only. No HID handles/reports, GATT requests,
// pairing changes, registry writes, or receiver/vendor battery guesses.
const { execFile: runFile } = require('node:child_process');
const path = require('node:path');
const FRESHNESS_MS = 5 * 60 * 1000;
const QUERY_TIMEOUT_MS = 10000;
const MAX_OUTPUT_BYTES = 8192;

// Fixed script: no renderer/device strings are interpolated into executable code.
// InstanceId stays inside PowerShell and never appears in stdout or errors.
const POWERSHELL_QUERY = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  $batteryDevices = @(Get-PnpDevice -Class Bluetooth -ErrorAction Stop | Where-Object {
    $_.FriendlyName -match '^Crush ?80-[1-3]$' -and $_.InstanceId -match '^BTH(?:LE|ENUM)\\'
  })
  if ($batteryDevices.Count -eq 0) {
    @{ state = 'missing' } | ConvertTo-Json -Compress
  } elseif ($batteryDevices.Count -ne 1) {
    @{ state = 'ambiguous' } | ConvertTo-Json -Compress
  } else {
    $wantedBatteryKeys = @(
      '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2',
      '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 7',
      'DEVPKEY_Device_DevNodeStatus'
    )
    $batteryProperties = @(Get-PnpDeviceProperty -InstanceId $batteryDevices[0].InstanceId -KeyName $wantedBatteryKeys -ErrorAction SilentlyContinue)
    $level = @($batteryProperties | Where-Object { $_.KeyName -eq '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2' })
    $stamp = @($batteryProperties | Where-Object { $_.KeyName -eq '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 7' })
    $node = @($batteryProperties | Where-Object { $_.KeyName -eq 'DEVPKEY_Device_DevNodeStatus' })
    $percent = $null
    if ($level.Count -eq 1 -and [int]$level[0].Type -eq 3 -and $level[0].Data -is [byte]) {
      $percent = [int]$level[0].Data
    }
    $updatedAt = $null
    if ($stamp.Count -eq 1 -and [int]$stamp[0].Type -eq 16 -and $stamp[0].Data -is [datetime]) {
      $updatedAt = $stamp[0].Data.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
    }
    $connected = $null
    if ($node.Count -eq 1 -and [int]$node[0].Type -eq 7 -and $node[0].Data -is [uint32]) {
      $flags = [uint32]$node[0].Data
      $connected = (($flags -band 0x02000000) -eq 0 -and ($flags -band 0x00000008) -ne 0)
    }
    @{ state = 'ok'; percent = $percent; updatedAt = $updatedAt; connected = $connected } | ConvertTo-Json -Compress
  }
} catch {
  @{ state = 'failed' } | ConvertTo-Json -Compress
}
`;

const unavailable = reason => ({ percent: null, charging: null, source: 'unavailable', updatedAt: null, stale: true, reason });

function normalizeBatteryReading(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable('Battery status is unavailable.');
  if (value.state === 'ambiguous') return unavailable('More than one paired Crush 80 was found.');
  if (value.state === 'missing') return unavailable('No paired Crush 80 Bluetooth battery was found.');
  if (value.state !== 'ok') return unavailable('Windows battery status is unavailable.');
  if (!Number.isInteger(value.percent) || value.percent < 0 || value.percent > 100) {
    return unavailable('Windows has not reported a valid battery percentage.');
  }
  let updatedAt = null;
  if (typeof value.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.updatedAt)) {
    const parsed = Date.parse(value.updatedAt);
    if (Number.isFinite(parsed) && new Date(parsed).toISOString() === value.updatedAt && Number.isFinite(now) && parsed <= now) {
      updatedAt = value.updatedAt;
    }
  }
  const recent = updatedAt !== null && now - Date.parse(updatedAt) <= FRESHNESS_MS;
  const stale = value.connected !== true || !recent;
  let reason;
  if (value.connected !== true) reason = 'Last-known Windows Bluetooth reading; the Bluetooth connection is not confirmed active.';
  else if (!updatedAt) reason = 'Windows did not provide a valid battery update time.';
  else if (!recent) reason = 'Last-known Windows Bluetooth reading; it is more than five minutes old.';
  return { percent: value.percent, charging: null, source: 'windows-bluetooth', updatedAt, stale, ...(reason ? { reason } : {}) };
}

async function readBatteryStatus({ execFile = runFile, platform = process.platform, now = Date.now,
  windowsRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
  if (platform !== 'win32') return unavailable('Windows Bluetooth battery information is unavailable on this platform.');
  try {
    const result = await new Promise(resolve => {
      execFile(path.win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_QUERY],
        { windowsHide: true, timeout: QUERY_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
        (error, stdout) => resolve({ error, stdout }));
    });
    if (result.error || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout, 'utf8') > MAX_OUTPUT_BYTES) {
      return unavailable('Windows battery status could not be read.');
    }
    return normalizeBatteryReading(JSON.parse(result.stdout.trim()), now());
  } catch {
    return unavailable('Windows battery status could not be read.');
  }
}

module.exports = { readBatteryStatus, normalizeBatteryReading, FRESHNESS_MS };
