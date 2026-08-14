[CmdletBinding()]
param(
  [string]$ProfileDir,
  [string]$VisionProvider,
  [string]$VisionModel,
  [string]$MainProvider,
  [string[]]$MainModel = @(),
  [switch]$NoAutoConvert,
  [string]$Proxy
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoSpec = 'github:poiuyjie/dsh-vision-opencode'
$dshRoot = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
if (-not $ProfileDir) { $ProfileDir = Join-Path $dshRoot 'profiles\web' }
$settingsFile = Join-Path $dshRoot 'settings.yaml'

function Write-Info([string]$Message) { Write-Host "-> $Message" }
function Write-Utf8([string]$Path, [string]$Text) {
  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    [void](New-Item -ItemType Directory -Force -Path $parent)
  }
  [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}
function Quote-Yaml([string]$Value) { return ($Value | ConvertTo-Json -Compress) }
function Unquote-Yaml([string]$Value) {
  $value = $Value.Trim()
  if ($value -eq "''" -or $value -eq '""') { return '' }
  if ($value.Length -ge 2 -and $value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') {
    return [string]($value | ConvertFrom-Json)
  }
  if ($value.Length -ge 2 -and $value[0] -eq "'" -and $value[$value.Length - 1] -eq "'") {
    return $value.Substring(1, $value.Length - 2).Replace("''", "'")
  }
  return $value
}
function Get-VisionSection([string[]]$Lines) {
  for ($i = 0; $i -lt $Lines.Count; $i++) {
    if ($Lines[$i] -notmatch '^vision-opencode:') { continue }
    $end = $i + 1
    if ($Lines[$i].Substring('vision-opencode:'.Length).Trim() -eq '') {
      while ($end -lt $Lines.Count -and ($Lines[$end] -match '^\s' -or $Lines[$end].Trim() -eq '')) { $end++ }
    }
    return @{ Start = $i; End = $end; Lines = @($Lines[$i..($end - 1)]) }
  }
  return $null
}
function Get-SectionScalar([string[]]$Lines, [string]$Key) {
  foreach ($line in $Lines) {
    if ($line -match "^  $([regex]::Escape($Key)):\s*(.*?)\s*$") { return Unquote-Yaml $Matches[1] }
  }
  return ''
}
function Get-SectionList([string[]]$Lines, [string]$Key) {
  $values = [Collections.Generic.List[string]]::new()
  $inside = $false
  foreach ($line in $Lines) {
    if ($line -match "^  $([regex]::Escape($Key)):\s*$") { $inside = $true; continue }
    if (-not $inside) { continue }
    if ($line -match '^    -\s+(.*?)\s*$') { $values.Add((Unquote-Yaml $Matches[1])); continue }
    if ($line -match '^  \S') { break }
  }
  return $values.ToArray()
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

foreach ($name in @('node', 'pnpm')) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "Missing required command: $name" }
}
if ($Proxy) {
  $env:http_proxy = $Proxy
  $env:https_proxy = $Proxy
  $env:NO_PROXY = '127.0.0.1,localhost'
  if ($Proxy -match '^socks') { $env:all_proxy = $Proxy }
}

if (-not (Test-Path -LiteralPath $ProfileDir)) { [void](New-Item -ItemType Directory -Force -Path $ProfileDir) }
$packageFile = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $packageFile)) { throw "$ProfileDir is not a DSH profile directory (package.json is missing)" }

$settingsText = if (Test-Path -LiteralPath $settingsFile) { [IO.File]::ReadAllText($settingsFile) } else { '' }
$settingsLines = @([regex]::Split($settingsText, '\r?\n'))
$section = Get-VisionSection $settingsLines
$visionProviderSpecified = $PSBoundParameters.ContainsKey('VisionProvider')
$visionModelSpecified = $PSBoundParameters.ContainsKey('VisionModel')
$autoConvert = if ($NoAutoConvert) { 'false' } else { 'true' }
$gateState = ''
if ($section) {
  if (-not $VisionProvider) { $VisionProvider = Get-SectionScalar $section.Lines 'provider' }
  if (-not $VisionModel) { $VisionModel = Get-SectionScalar $section.Lines 'model' }
  if (-not $NoAutoConvert) {
    $existingAutoConvert = Get-SectionScalar $section.Lines 'autoConvert'
    if ($existingAutoConvert -eq 'false') { $autoConvert = 'false' }
  }
  if (-not $MainProvider) { $MainProvider = Get-SectionScalar $section.Lines 'mainProvider' }
  if ($MainModel.Count -eq 0) { $MainModel = @(Get-SectionList $section.Lines 'mainModels') }
  $gateState = Get-SectionScalar $section.Lines 'gateState'
}
if ((-not $VisionProvider -or -not $VisionModel) -and ($visionProviderSpecified -or $visionModelSpecified)) {
  throw '-VisionProvider and -VisionModel must be provided together (or both omitted)'
}
if ($MainModel.Count -gt 0 -and -not $MainProvider) {
  throw '-MainModel requires -MainProvider (or an existing mainProvider setting)'
}

Push-Location $ProfileDir
try {
  $package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
  $hasDependency = Test-PackageDependency $package 'dsh-vision-opencode'
  $workspaceArgs = if (Test-Path -LiteralPath (Join-Path $ProfileDir 'pnpm-workspace.yaml')) { @('-w') } else { @() }
  if ($hasDependency) {
    Write-Info 'Dependency exists; updating to the latest repository revision'
    Invoke-Pnpm (@('update') + $workspaceArgs + @('dsh-vision-opencode'))
  } else {
    Write-Info "Installing dependency: $repoSpec"
    Invoke-Pnpm (@('add') + $workspaceArgs + @($repoSpec))
  }

  $patchFile = Join-Path $ProfileDir 'cordis.patch.yml'
  $patchText = if (Test-Path -LiteralPath $patchFile) { [IO.File]::ReadAllText($patchFile) } else { '' }
  $patchText = [regex]::Replace($patchText, '(?m)^\s*\[\s*\]\s*\r?\n?', '')
  if ($patchText -notmatch '(?m)^\s*- id: vision-opencode\s*$') {
    $patchText = $patchText.TrimEnd() + "`n`n- insert:`n    - id: vision-opencode`n      name: 'dsh-vision-opencode'`n"
    Write-Info 'Registered vision-opencode in cordis.patch.yml'
  }
  Write-Utf8 $patchFile $patchText
} finally {
  Pop-Location
}

$block = [Collections.Generic.List[string]]::new()
$block.Add('vision-opencode:')
if ($VisionProvider -and $VisionModel) {
  $block.Add("  provider: $(Quote-Yaml $VisionProvider)")
  $block.Add("  model: $(Quote-Yaml $VisionModel)")
}
$block.Add("  autoConvert: $autoConvert")
if ($MainProvider) { $block.Add("  mainProvider: $(Quote-Yaml $MainProvider)") }
if ($MainModel.Count -gt 0) {
  $block.Add('  mainModels:')
  foreach ($model in $MainModel) { $block.Add("    - $(Quote-Yaml $model)") }
}
if ($gateState) { $block.Add("  gateState: $(Quote-Yaml $gateState)") }

$output = [Collections.Generic.List[string]]::new()
for ($i = 0; $i -lt $settingsLines.Count; $i++) {
  if ($section -and $i -ge $section.Start -and $i -lt $section.End) { continue }
  $output.Add($settingsLines[$i])
}
while ($output.Count -gt 0 -and $output[$output.Count - 1].Trim() -eq '') { $output.RemoveAt($output.Count - 1) }
if ($output.Count -gt 0) { $output.Add('') }
foreach ($line in $block) { $output.Add($line) }
Write-Utf8 $settingsFile (($output -join "`n") + "`n")

Write-Host ''
Write-Host 'Installation complete. Restart dsh, refresh the browser page, then choose a vision model from the composer dropdown if one was not specified.'
