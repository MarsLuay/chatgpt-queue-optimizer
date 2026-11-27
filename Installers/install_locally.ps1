# Compatibility entry point: Rust owns the local installation coordinator.
param(
    [ValidateSet('All','Firefox','Chromium','Chrome')][string]$Browser,
    [string]$FirefoxPath,
    [string]$ChromiumPath,
    [string]$ChromePath,
    [switch]$LegacyUI
)
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$manifest=Join-Path $PSScriptRoot 'native\Cargo.toml'
if (-not (Get-Command cargo -CommandType Application -ErrorAction SilentlyContinue)) {
    Write-Host '[ERROR] Rust/Cargo is required. Install Rust using rustup and retry.'
    exit 1
}
$arguments=@('run','--release','--manifest-path',$manifest,'--','install','--repo-dir',$repo)
if ($Browser) { $arguments+=@('--browser',$Browser) }
if ($FirefoxPath) { $arguments+=@('--firefox-path',$FirefoxPath) }
if ($ChromiumPath) { $arguments+=@('--chromium-path',$ChromiumPath) }
if ($ChromePath) { $arguments+=@('--chrome-path',$ChromePath) }
if ($LegacyUI) { $arguments+=@('--legacy-ui') }
& cargo @arguments
exit $LASTEXITCODE
