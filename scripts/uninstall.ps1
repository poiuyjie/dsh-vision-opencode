[CmdletBinding()]
param(
  [string]$ProfileDir,
  [int]$Port = 3080,
  [string]$Proxy
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$dshRoot = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
if (-not $ProfileDir) { $ProfileDir = Join-Path $dshRoot 'profiles\web' }
$settingsFile = Join-Path $dshRoot 'settings.yaml'
$endpoint = "http://127.0.0.1:$Port/vision-opencode"

function Write-Info([string]$Message) { Write-Host "-> $Message" }
function Write-Utf8([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}
function Invoke-Pnpm([string[]]$PnpmArgs) {
  & pnpm @PnpmArgs
  if ($LASTEXITCODE -ne 0) { throw "pnpm $($PnpmArgs -join ' ') failed with exit code $LASTEXITCODE" }
}
function Test-PackageDependency($Package, [string]$Name) {
  foreach ($group in @('dependencies', 'devDependencies')) {
    $property = $Package.PSObject.Properties[$group]
    if ($property -and $property.Value -and $property.Value.PSObject.Properties[$Name]) { return $true }
  }
  return $false
}
function Test-VisionGateState([string]$Text) {
  $inside = $false
  foreach ($line in [regex]::Split($Text, '\r?\n')) {
    if ($line -match '^vision-opencode:') { $inside = $true; continue }
    if ($inside -and $line -match '^\S') { $inside = $false }
    if ($inside -and $line -match '^  gateState:\s*\S') { return $true }
  }
  return $false
}
function Remove-VisionSettings([string]$Text) {
  $lines = @([regex]::Split($Text, '\r?\n'))
  $out = [Collections.Generic.List[string]]::new()
  $skip = $false
  foreach ($line in $lines) {
    if (-not $skip -and $line -match '^vision-opencode:') {
      $skip = $line.Substring('vision-opencode:'.Length).Trim() -eq ''
      continue
    }
    if ($skip) {
      if ($line -match '^\s' -or $line.Trim() -eq '') { continue }
      $skip = $false
    }
    $out.Add($line)
  }
  while ($out.Count -gt 1 -and $out[$out.Count - 1] -eq '' -and $out[$out.Count - 2] -eq '') { $out.RemoveAt($out.Count - 1) }
  return ($out -join "`n")
}
function Remove-CordisEntry([string]$Text) {
  $lines = @([regex]::Split($Text, '\r?\n'))
  $out = [Collections.Generic.List[string]]::new()
  for ($i = 0; $i -lt $lines.Count;) {
    if ($lines[$i] -notmatch '^- insert:\s*$') { $out.Add($lines[$i]); $i++; continue }
    $block = [Collections.Generic.List[string]]::new()
    $block.Add($lines[$i]); $i++
    while ($i -lt $lines.Count -and $lines[$i] -match '^\s') { $block.Add($lines[$i]); $i++ }
    $kept = [Collections.Generic.List[string]]::new()
    for ($j = 0; $j -lt $block.Count;) {
      if ($block[$j] -match '^\s*- id:\s*vision-opencode\s*$') {
        $j++
        while ($j -lt $block.Count -and $block[$j] -match '^\s' -and $block[$j] -notmatch '^\s*- ') { $j++ }
        continue
      }
      $kept.Add($block[$j]); $j++
    }
    if ($kept.Count -gt 1) { foreach ($line in $kept) { $out.Add($line) } }
  }
  $hasYaml = $false
  foreach ($line in $out) {
    if ($line.Trim() -ne '' -and -not $line.Trim().StartsWith('#')) { $hasYaml = $true; break }
  }
  $result = ($out -join "`n").TrimEnd()
  if (-not $hasYaml) { $result = if ($result) { "$result`n`n[]" } else { '[]' } }
  return "$result`n"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Missing required command: node' }
if ($Proxy) {
  $env:http_proxy = $Proxy
  $env:https_proxy = $Proxy
  $env:NO_PROXY = '127.0.0.1,localhost'
  if ($Proxy -match '^socks') { $env:all_proxy = $Proxy }
}

$cleanedByEndpoint = $false
$gateRemoved = $null
$requestOptions = @{ TimeoutSec = 3; ErrorAction = 'Stop' }
try {
  $configResult = Invoke-RestMethod -Uri "$endpoint/config" @requestOptions
  if ($configResult -is [string] -or
      -not $configResult.PSObject.Properties['autoConvert'] -or
      -not $configResult.PSObject.Properties['mainModels']) {
    throw 'The config endpoint did not return vision-opencode JSON'
  }
  Write-Info "DSH is running; calling $endpoint/uninstall"
  $postOptions = @{ Uri = "$endpoint/uninstall"; Method = 'Post'; Headers = @{ 'x-vision-opencode-action' = 'uninstall' }; TimeoutSec = 30; ErrorAction = 'Stop' }
  $result = Invoke-RestMethod @postOptions
  $cleanedByEndpoint = $true
  $gateRemoved = $result.gateOverridesRemoved
  $result | ConvertTo-Json -Compress | Write-Host
} catch {
  Write-Warning 'DSH is not running, the port is wrong, or runtime cleanup failed. Local files will still be removed.'
}

if ((Test-Path -LiteralPath $settingsFile) -and
    (Test-VisionGateState ([IO.File]::ReadAllText($settingsFile)))) {
  throw 'Uninstall stopped: settings.yaml still contains this plugin''s gateState ownership record. Start dsh and retry so the plugin can restore its legacy modelOverrides first.'
}

if (Test-Path -LiteralPath $settingsFile) {
  Write-Utf8 $settingsFile (Remove-VisionSettings ([IO.File]::ReadAllText($settingsFile)))
  Write-Info 'Removed the vision-opencode section from settings.yaml'
}

$patchFile = Join-Path $ProfileDir 'cordis.patch.yml'
if (Test-Path -LiteralPath $patchFile) {
  Write-Utf8 $patchFile (Remove-CordisEntry ([IO.File]::ReadAllText($patchFile)))
  Write-Info 'Removed the vision-opencode Cordis entry'
}

$packageFile = Join-Path $ProfileDir 'package.json'
if (Test-Path -LiteralPath $packageFile) {
  $package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
  $hasDependency = Test-PackageDependency $package 'dsh-vision-opencode'
  if ($hasDependency) {
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'pnpm is required because package.json still contains dsh-vision-opencode' }
    $workspaceArgs = if (Test-Path -LiteralPath (Join-Path $ProfileDir 'pnpm-workspace.yaml')) { @('-w') } else { @() }
    Push-Location $ProfileDir
    try { Invoke-Pnpm (@('remove') + $workspaceArgs + @('dsh-vision-opencode')) } finally { Pop-Location }
  }
}

Write-Host ''
Write-Host 'Uninstall complete. Restart dsh.'
if ($cleanedByEndpoint) {
  $removedCount = if ($null -eq $gateRemoved) { 0 } else { $gateRemoved }
  Write-Host "Runtime cleanup restored $removedCount legacy plugin-owned modelOverrides. User and third-party image settings were preserved."
} else {
  Write-Host 'No plugin ownership record was found; no llm-pi-ai modelOverrides were changed.'
}
