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

if (Test-Path -LiteralPath $settingsFile) {
  $preflightSettings = [IO.File]::ReadAllText($settingsFile)
  if ($preflightSettings -match '(?ms)modelOverrides:.*?input:.*?image' -and
      $preflightSettings -notmatch '(?m)^  gateState:\s*\S') {
    throw 'Uninstall stopped: settings.yaml contains image modelOverrides without a gateState ownership record. Restore the affected input values manually, or reinstall the current plugin before uninstalling again.'
  }
}

$cleanedByEndpoint = $false
$gateRemoved = $null
$requestOptions = @{ TimeoutSec = 3; ErrorAction = 'Stop' }
try {
  [void](Invoke-RestMethod -Uri "$endpoint/config" @requestOptions)
  Write-Info "DSH is running; calling $endpoint/uninstall"
  $postOptions = @{ Uri = "$endpoint/uninstall"; Method = 'Post'; Headers = @{ 'x-vision-opencode-action' = 'uninstall' }; TimeoutSec = 30; ErrorAction = 'Stop' }
  $result = Invoke-RestMethod @postOptions
  $cleanedByEndpoint = $true
  $gateRemoved = $result.gateOverridesRemoved
  $result | ConvertTo-Json -Compress | Write-Host
  $removedCount = if ($null -eq $gateRemoved) { 0 } else { [int]$gateRemoved }
  if ($removedCount -eq 0 -and (Test-Path -LiteralPath $settingsFile)) {
    $residualSettings = [IO.File]::ReadAllText($settingsFile)
    if ($residualSettings -match '(?ms)modelOverrides:.*?input:.*?image') {
      throw 'Uninstall stopped: settings.yaml contains image modelOverrides whose ownership cannot be proven. Restore the affected input values manually, then retry.'
    }
  }
} catch {
  if ($_.Exception.Message -like 'Uninstall stopped:*') { throw }
  Write-Warning 'DSH is not running, the port is wrong, or runtime cleanup failed. Local files will still be removed.'
  Write-Warning 'Any plugin-owned llm-pi-ai modelOverrides must be restored manually, or rerun this script while DSH is running.'
}

if (-not $cleanedByEndpoint -and (Test-Path -LiteralPath $settingsFile)) {
  $residualSettings = [IO.File]::ReadAllText($settingsFile)
  if ($residualSettings -match '(?ms)modelOverrides:.*?input:.*?image') {
    throw 'Uninstall stopped: runtime cleanup did not run and settings.yaml may contain image modelOverrides. Start dsh, let the plugin clean itself, then retry.'
  }
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
  Write-Host "Runtime cleanup restored $removedCount plugin-owned modelOverrides."
} else {
  Write-Host 'Verify that no plugin-added llm-pi-ai modelOverrides remain before sending images.'
}
