[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$PackagePath,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedSha256,
  [Parameter(Mandatory=$true)][ValidatePattern('^[1-9][0-9]*\.[0-9]+\.[0-9]+\.0$')][string]$ExpectedVersion,
  [switch]$Install
)
$ErrorActionPreference = 'Stop'
$crushRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$crushReport = [ordered]@{ package=$PackagePath; expectedSha256=$ExpectedSha256.ToLowerInvariant(); version=$ExpectedVersion; action=$(if ($Install) { 'install' } else { 'inspect' }); status='validating'; installationAttempted=$false; installed=$false; certificateTrustChanged=$false; developerModeChanged=$false; firmwareAccess=$false }
try {
$crushOutput = [IO.Path]::GetFullPath((Join-Path $crushRoot 'dist\store-test'))
$crushPackage = (Resolve-Path -LiteralPath $PackagePath).Path
$crushExpectedName = 'mi0ir.CrushControl.StoreTest'
$crushExpectedPublisher = 'CN=Crush Control Local Test, OID.2.25.311729368913984317654407730594956997722=1'
$crushExpectedFile = '{0}_{1}_x64.msix' -f $crushExpectedName,$ExpectedVersion
if ([IO.Path]::GetDirectoryName($crushPackage) -ne $crushOutput -or [IO.Path]::GetFileName($crushPackage) -ne $crushExpectedFile) { throw 'Only the exact local Store test package under dist/store-test can be installed.' }
foreach ($crushCheckedPath in @($crushOutput,$crushPackage)) {
  if ((Get-Item -LiteralPath $crushCheckedPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Test package paths must not be links.' }
}
$crushActualHash = (Get-FileHash -LiteralPath $crushPackage -Algorithm SHA256).Hash.ToLowerInvariant()
if ($crushActualHash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'The test package hash differs from the reviewed build.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$crushZip = [IO.Compression.ZipFile]::OpenRead($crushPackage)
try {
  if ($null -ne $crushZip.GetEntry('AppxSignature.p7x')) { throw 'This helper accepts only the unsigned OID-marked local test build.' }
  $crushManifestEntry = $crushZip.GetEntry('AppxManifest.xml')
  if ($null -eq $crushManifestEntry -or $crushManifestEntry.Length -gt 16384) { throw 'Missing or oversized test manifest.' }
  $crushManifestReader = [IO.StreamReader]::new($crushManifestEntry.Open())
  try { $crushManifestText = $crushManifestReader.ReadToEnd() } finally { $crushManifestReader.Dispose() }
  $crushXmlSettings = [Xml.XmlReaderSettings]::new()
  $crushXmlSettings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
  $crushXmlSettings.XmlResolver = $null
  $crushXmlReader = [Xml.XmlReader]::Create([IO.StringReader]::new($crushManifestText),$crushXmlSettings)
  $crushManifest = [Xml.XmlDocument]::new()
  try { $crushManifest.Load($crushXmlReader) } finally { $crushXmlReader.Dispose() }
  $crushIdentity = $crushManifest.DocumentElement.Identity
  if ($crushIdentity.Name -ne $crushExpectedName -or $crushIdentity.Publisher -ne $crushExpectedPublisher -or $crushIdentity.Version -ne $ExpectedVersion -or $crushIdentity.ProcessorArchitecture -ne 'x64') { throw 'Local test package identity differs from the reviewed build.' }
} finally { $crushZip.Dispose() }
$crushReport.package = $crushPackage
$crushReport.sha256 = $crushActualHash
$crushReport.identity = $crushExpectedName
$crushReport.status = 'validated'
if (-not $Install) { return }
$crushPrincipal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $crushPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Windows requires an elevated PowerShell for this unsigned executable MSIX test. No installation or security settings were changed.' }
if ([Environment]::OSVersion.Version.Build -lt 22000) { throw 'Unsigned MSIX testing requires Windows 11.' }
if (@(Get-CimInstance Win32_Process -Filter "Name='Crush Control.exe'" -ErrorAction Stop).Count -gt 0) { throw 'Quit all Crush Control app processes before testing the separate package.' }
$crushBefore = @(Get-AppxPackage -Name $crushExpectedName)
if ($crushBefore.Count -gt 1) { throw 'Unexpected multiple Store test packages.' }
if ($crushBefore.Count -eq 1 -and [version]$crushBefore[0].Version -ge [version]$ExpectedVersion) { throw 'This test package version is already installed or older; no downgrade or replacement is allowed.' }
$crushReport.status = 'deployment-requested'
$crushReport.installationAttempted = $true
Add-AppxPackage -Path $crushPackage -AllowUnsigned -ErrorAction Stop
$crushAfter = @(Get-AppxPackage -Name $crushExpectedName)
if ($crushAfter.Count -ne 1 -or [string]$crushAfter[0].Version -ne $ExpectedVersion) { throw 'Installation returned without the expected registered version.' }
$crushReport.installed = $true
$crushReport.status = 'installed-and-verified'
$crushReport.packageFullName = $crushAfter[0].PackageFullName
$crushReport.packageFamilyName = $crushAfter[0].PackageFamilyName
$crushReport.installLocation = $crushAfter[0].InstallLocation
$crushReport.previousVersion = if ($crushBefore.Count -eq 1) { [string]$crushBefore[0].Version } else { $null }
$crushReport.launchAumid = $crushAfter[0].PackageFamilyName + '!CrushControl'
} catch {
  $crushReport.failedAt = $crushReport.status
  $crushReport.status = 'failed'
  $crushReport.error = $_.Exception.Message
  $crushReport.hresult = $_.Exception.HResult
  $crushReport.errorId = $_.FullyQualifiedErrorId
  throw
} finally {
  $crushReport.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
  $crushReportDirectory = Join-Path $crushRoot 'artifacts\store-msix'
  try {
    New-Item -ItemType Directory -Path $crushReportDirectory -Force | Out-Null
    $crushReportFile = Join-Path $crushReportDirectory ('{0}-{1}-{2}.json' -f $crushReport.action,$ExpectedVersion,[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
    $crushReport | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $crushReportFile -Encoding utf8
    $crushReport.reportFile = $crushReportFile
  } catch { Write-Warning ('Could not save the local package result: ' + $_.Exception.Message) }
  $crushReport | ConvertTo-Json -Depth 5
}
