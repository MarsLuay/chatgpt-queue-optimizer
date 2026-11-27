# Route local installs independently so one browser failure does not prevent the other.
param(
    [ValidateSet('All','Firefox','Chromium','Chrome')][string]$Browser,
    [string]$FirefoxPath,
    [string]$ChromiumPath,
    [string]$ChromePath
)
$ErrorActionPreference='Stop'
if (-not $Browser) {
    Write-Host '1. Firefox'
    Write-Host '2. Chromium'
    do {
        $selection=Read-Host 'Choose a browser [1-2]'
    } until ($selection -in @('1','2'))
    $Browser=if ($selection -eq '1') { 'Firefox' } else { 'Chromium' }
}
$targets=if ($Browser -eq 'All') { @('Firefox','Chromium') } else { @($Browser) }
$failed=$false
$installed=0
foreach ($target in $targets) {
    Write-Host ("=== Local install: "+$target+" ===")
    $arguments=@('-NoProfile','-STA','-ExecutionPolicy','RemoteSigned','-File')
    if ($target -eq 'Firefox') {
        $arguments+=Join-Path $PSScriptRoot 'install_firefox_locally.ps1'
        if ($FirefoxPath) { $arguments+=@('-FirefoxPath',$FirefoxPath) }
    } else {
        $arguments+=Join-Path $PSScriptRoot 'install_chromium_locally.ps1'
        $product=if ($target -eq 'Chrome') { 'Google Chrome' } else { 'Chromium' }
        $arguments+=@('-ProductName',$product)
        $selectedPath=if ($target -eq 'Chrome') { $ChromePath } else { $ChromiumPath }
        if ($selectedPath) { $arguments+=@('-BrowserPath',$selectedPath) }
    }
    & powershell.exe @arguments
    $code=$LASTEXITCODE
    if ($code -eq 0) { $installed++ }
    elseif ($code -eq 2 -and $Browser -eq 'All') { Write-Host "Skipping $target because it is not installed." }
    else { $failed=$true; Write-Warning "$target installation failed (exit $code)." }
}
if ($installed -eq 0) { Write-Warning 'No browser installation was completed.'; exit 1 }
if ($failed) { exit 1 }
exit 0
