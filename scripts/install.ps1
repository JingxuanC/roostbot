# Roost CLI installer for Windows (requires Node >= 22.18).
#   irm https://www.roostbots.com/downloads/cli/v0.1.0/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$Version = if ($env:ROOST_CLI_VERSION) { $env:ROOST_CLI_VERSION } else { '__VERSION__' }
$BaseUrl = if ($env:ROOST_CLI_BASE_URL) { $env:ROOST_CLI_BASE_URL } else { "https://www.roostbots.com/downloads/cli/v$Version" }
$InstallDir = if ($env:ROOST_INSTALL_DIR) { $env:ROOST_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Roost\bin' }
$Node = (Get-Command node -ErrorAction Stop).Source
$NodeVersion = (& $Node -p 'process.versions.node').Trim()
$parts = $NodeVersion.Split('.')
if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 18)) {
  throw "Node >= 22.18 is required (found $NodeVersion)"
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("roost-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
try {
  Invoke-WebRequest -UseBasicParsing "$BaseUrl/roost.mjs" -OutFile (Join-Path $Tmp 'roost.mjs')
  Invoke-WebRequest -UseBasicParsing "$BaseUrl/checksums.txt" -OutFile (Join-Path $Tmp 'checksums.txt')
  $expected = (Get-Content (Join-Path $Tmp 'checksums.txt') | Select-String '  roost.mjs$').Line.Split(' ')[0]
  $actual = (Get-FileHash (Join-Path $Tmp 'roost.mjs') -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw 'checksum mismatch' }
  Copy-Item (Join-Path $Tmp 'roost.mjs') (Join-Path $InstallDir 'roost.mjs') -Force
  $cmd = "@echo off`r`n`"$Node`" `"$InstallDir\roost.mjs`" %*`r`n"
  Set-Content -Path (Join-Path $InstallDir 'roost.cmd') -Value $cmd -Encoding ASCII
  Write-Host "roost installer: installed $InstallDir\roost.mjs"
  Write-Host "roost installer: add $InstallDir to PATH, then run 'roost setup'"
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
