Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$temp = Join-Path ([IO.Path]::GetTempPath()) ("vision-opencode-test-" + [guid]::NewGuid().ToString('N'))
$profile = Join-Path $temp 'profiles\web'
$bin = Join-Path $temp 'bin'
$settings = Join-Path $temp 'settings.yaml'
$install = Join-Path $PSScriptRoot 'install.ps1'
$uninstall = Join-Path $PSScriptRoot 'uninstall.ps1'
$utf8 = [Text.UTF8Encoding]::new($false)

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "Assertion failed: $Message" }
  Write-Host "  OK $Message"
}

try {
  [void](New-Item -ItemType Directory -Force -Path $profile, $bin)
  [IO.File]::WriteAllText((Join-Path $profile 'package.json'), '{"name":"dsh-profile-web","private":true,"dependencies":{"dsh-vision-opencode":"github:poiuyjie/dsh-vision-opencode"}}', $utf8)
  [IO.File]::WriteAllText((Join-Path $profile 'cordis.patch.yml'), "- insert:`n    - id: other-plugin`n      name: 'other-plugin'`n", $utf8)
  [IO.File]::WriteAllText($settings, "agent-default-model:`n  provider: test`n", $utf8)

  if ($env:OS -eq 'Windows_NT') {
    [IO.File]::WriteAllText((Join-Path $bin 'pnpm.cmd'), "@echo off`r`nexit /b 0`r`n", $utf8)
  } else {
    $fakePnpm = Join-Path $bin 'pnpm'
    [IO.File]::WriteAllText($fakePnpm, "#!/usr/bin/env sh`nexit 0`n", $utf8)
    & chmod +x $fakePnpm
  }

  $oldPath = $env:PATH
  $oldDshHome = $env:DSH_HOME
  $env:PATH = $bin + [IO.Path]::PathSeparator + $env:PATH
  $env:DSH_HOME = $temp
  try {
    & $install -ProfileDir $profile -VisionProvider 'provider:#1' -VisionModel 'vision:model #1' -MainProvider 'main-provider' -MainModel @('text-a', 'text-b')
    $installedSettings = [IO.File]::ReadAllText($settings)
    $installedPatch = [IO.File]::ReadAllText((Join-Path $profile 'cordis.patch.yml'))
    Assert-True ($installedSettings -match 'provider: "provider:#1"') 'quotes YAML-sensitive provider values'
    Assert-True ($installedSettings -match 'model: "vision:model #1"') 'quotes YAML-sensitive model values'
    Assert-True ($installedSettings -match '(?m)^  mainModels:$') 'writes valid mainModels indentation'
    Assert-True (([regex]::Matches($installedPatch, '(?m)^\s*- id: vision-opencode\s*$')).Count -eq 1) 'registers one Cordis entry'

    & $install -ProfileDir $profile
    $reinstalledSettings = [IO.File]::ReadAllText($settings)
    Assert-True ($reinstalledSettings -match 'provider: "provider:#1"') 'preserves quoted settings on reinstall'
    Assert-True ($reinstalledSettings -match '    - "text-a"') 'preserves mainModels on reinstall'

    & $uninstall -ProfileDir $profile -Port 1
    $removedSettings = [IO.File]::ReadAllText($settings)
    $removedPatch = [IO.File]::ReadAllText((Join-Path $profile 'cordis.patch.yml'))
    Assert-True ($removedSettings -notmatch '(?m)^vision-opencode:') 'removes plugin settings'
    Assert-True ($removedPatch -notmatch 'id: vision-opencode') 'removes plugin Cordis entry'
    Assert-True ($removedPatch -match 'id: other-plugin') 'preserves unrelated Cordis entries'

    $auto = Join-Path $temp 'auto'
    $autoProfile = Join-Path $auto 'profiles\web'
    [void](New-Item -ItemType Directory -Force -Path $autoProfile)
    [IO.File]::WriteAllText((Join-Path $auto 'settings.yaml'), "agent-default-model:`n  provider: auto-provider`n  model: text-default`nvision-opencode:`n  autoConvert: true`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $autoProfile 'package.json'), '{"dependencies":{}}', $utf8)
    $env:DSH_HOME = $auto
    & $install -ProfileDir $autoProfile
    $autoSettings = [IO.File]::ReadAllText((Join-Path $auto 'settings.yaml'))
    Assert-True ($autoSettings -match 'mainProvider: "auto-provider"' -and $autoSettings -match '    - "text-default"') 'inherits agent-default-model as main route'

    $legacy = Join-Path $temp 'legacy'
    $legacyProfile = Join-Path $legacy 'profiles\web'
    $legacySettingsPath = Join-Path $legacy 'settings.yaml'
    $legacyPatchPath = Join-Path $legacyProfile 'cordis.patch.yml'
    $legacyPackagePath = Join-Path $legacyProfile 'package.json'
    [void](New-Item -ItemType Directory -Force -Path $legacyProfile)
    $legacySettings = "llm-pi-ai:`n  providers:`n    opencode-go:`n      modelOverrides:`n        deepseek-v4-pro:`n          input: [ text, image ]`nvision-opencode:`n  provider: opencode-go`n  model: vision-model`n"
    $legacyPatch = "- insert:`n    - id: vision-opencode`n      name: 'dsh-vision-opencode'`n"
    $legacyPackage = '{"dependencies":{"dsh-vision-opencode":"github:poiuyjie/dsh-vision-opencode"}}'
    [IO.File]::WriteAllText($legacySettingsPath, $legacySettings, $utf8)
    [IO.File]::WriteAllText($legacyPatchPath, $legacyPatch, $utf8)
    [IO.File]::WriteAllText($legacyPackagePath, $legacyPackage, $utf8)

    $env:DSH_HOME = $legacy
    $uninstallStopped = $false
    try {
      & $uninstall -ProfileDir $legacyProfile -Port 1
    } catch {
      $uninstallStopped = $_.Exception.Message -like 'Uninstall stopped:*'
    }
    Assert-True $uninstallStopped 'stops on legacy image gates without gateState'
    Assert-True ([IO.File]::ReadAllText($legacySettingsPath) -eq $legacySettings) 'preserves settings after stopped uninstall'
    Assert-True ([IO.File]::ReadAllText($legacyPatchPath) -eq $legacyPatch) 'preserves Cordis config after stopped uninstall'
    Assert-True ([IO.File]::ReadAllText($legacyPackagePath) -eq $legacyPackage) 'preserves dependency after stopped uninstall'
  } finally {
    $env:PATH = $oldPath
    if ($null -eq $oldDshHome) { Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue } else { $env:DSH_HOME = $oldDshHome }
  }
  Write-Host 'PowerShell selftest: 14 passed, 0 failed'
} finally {
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
