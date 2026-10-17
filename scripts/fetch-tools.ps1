<#
  Downloads yt-dlp and FFmpeg (ffmpeg, ffprobe and their DLLs) into bin/.
  Versions are pinned and every download is checked against its SHA-256,
  so CI and new installs get exactly the binaries the tests were run with.

  Files already in bin/ are kept (the app updates yt-dlp by itself); pass
  -Force to replace them with the pinned versions.

  Works on Windows PowerShell 5.1 and PowerShell 7.
#>
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # The progress bar makes Invoke-WebRequest very slow.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$YtDlpVersion = '2026.08.19'
$YtDlpSha256 = '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a'
$FfmpegRelease = 'autobuild-2026-10-13-20-20'
$FfmpegAsset = 'ffmpeg-N-127511-g01cf1a5396-win64-gpl-shared'
$FfmpegSha256 = 'cd2b62a29d12b3a462716ab888edd58d6d65bdde532a45fd58267d5ef60d1f37'

$Root = Split-Path -Parent $PSScriptRoot
$Bin = Join-Path $Root 'bin'
New-Item -ItemType Directory -Force -Path $Bin | Out-Null

# Hashing and unzipping go through .NET instead of Get-FileHash and Expand-Archive.
# Windows PowerShell started by a program running under PowerShell 7 (yarn/npm in
# a pwsh terminal, or GitHub Actions) inherits PowerShell 7's PSModulePath and
# loses those script-module cmdlets ("Get-FileHash is not recognized").
function Get-Sha256([string]$Path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try {
    return -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

function Get-Verified([string]$Url, [string]$Destination, [string]$Sha256) {
  Write-Host "Baixando $Url"
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
  $actual = Get-Sha256 $Destination
  if ($actual -ne $Sha256) {
    Remove-Item -Force $Destination
    throw "SHA-256 inesperado para $Url`n  esperado: $Sha256`n  obtido:   $actual"
  }
}

$YtDlp = Join-Path $Bin 'yt-dlp.exe'
if ($Force -or -not (Test-Path $YtDlp)) {
  Get-Verified "https://github.com/yt-dlp/yt-dlp/releases/download/$YtDlpVersion/yt-dlp.exe" $YtDlp $YtDlpSha256
} else {
  Write-Host 'yt-dlp.exe já existe em bin/ (use -Force para substituir)'
}

$Ffmpeg = Join-Path $Bin 'ffmpeg.exe'
if ($Force -or -not (Test-Path $Ffmpeg) -or -not (Test-Path (Join-Path $Bin 'ffprobe.exe'))) {
  $temp = Join-Path ([IO.Path]::GetTempPath()) "md-ffmpeg-$([Guid]::NewGuid())"
  New-Item -ItemType Directory -Path $temp | Out-Null
  try {
    $zip = Join-Path $temp 'ffmpeg.zip'
    Get-Verified "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/$FfmpegRelease/$FfmpegAsset.zip" $zip $FfmpegSha256
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $temp)
    $extracted = Join-Path $temp $FfmpegAsset
    # ffplay is not used by the app.
    Get-ChildItem (Join-Path $extracted 'bin') | Where-Object { $_.Name -ne 'ffplay.exe' } |
      Copy-Item -Destination $Bin -Force
    Copy-Item (Join-Path $extracted 'LICENSE.txt') (Join-Path $Bin 'ffmpeg-LICENSE.txt') -Force
  } finally {
    Remove-Item -Recurse -Force $temp
  }
} else {
  Write-Host 'ffmpeg.exe e ffprobe.exe já existem em bin/ (use -Force para substituir)'
}

& $YtDlp --version
& $Ffmpeg -hide_banner -version | Select-Object -First 1
