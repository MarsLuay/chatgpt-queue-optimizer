# Local browser installation coordinator. Keep each run's diagnostics on disk.
param(
    [ValidateSet('All','Firefox','Chromium','Chrome')][string]$Browser,
    [string]$FirefoxPath,
    [string]$ChromiumPath,
    [string]$ChromePath
)
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$logPath=$null
$stage='initialize logging'
$result=1
$timer=[Diagnostics.Stopwatch]::StartNew()
function Write-InstallLog([string]$message) {
    $line='[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'),$message
    if ($script:logPath) { Add-Content -LiteralPath $script:logPath -Value $line -Encoding UTF8 -ErrorAction Stop }
    Write-Host $line
}
function Invoke-LoggedNative([string]$executable,[string[]]$arguments) {
    # Windows PowerShell represents native stderr as ErrorRecord objects.
    # Keep both streams visible and recorded without treating every stderr
    # line as a terminating error; the child exit code determines success.
    $ErrorActionPreference='Continue'
    # PowerShell updates the global native exit-code variable. Do not shadow
    # it with a function-local variable, which would remain null.
    $global:LASTEXITCODE=$null
    & $executable @arguments 2>&1 | ForEach-Object {
        $line=[string]$_
        if ($_ -is [System.Management.Automation.ErrorRecord]) { $line='[stderr] '+$line }
        Write-InstallLog $line
    }
    $code=$global:LASTEXITCODE
    if ($null -eq $code) { throw "Child process did not return an exit code: $executable" }
    return [int]$code
}
try {
    $logs=Join-Path $repo 'build\logs'
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $logPath=Join-Path $logs ('install-local-{0}-{1}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'),$PID)
    New-Item -ItemType File -Path $logPath -ErrorAction Stop | Out-Null
    Write-InstallLog 'ChatGPT Queue + Optimizer local installer started.'
    Write-InstallLog ("Log: "+$logPath)
    $stage='select browser'
    if (-not $Browser) {
        Write-Host ''
        Write-Host '1. Firefox'
        Write-Host '2. Chromium'
        do {
            $selection=Read-Host 'Choose a browser [1-2]'
        } until ($selection -in @('1','2'))
        $Browser=if ($selection -eq '1') { 'Firefox' } else { 'Chromium' }
    }
    Write-InstallLog ("Selected browser: "+$Browser)
    $stage='find Python'
    $python=$null
    $pythonArgs=@()
    foreach ($name in @('py.exe','python.exe')) {
        $command=Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $command) { Write-InstallLog "Python candidate not found: $name"; continue }
        Write-InstallLog ("Probing Python: "+$command.Source)
        $prefix=@()
        if ($name -eq 'py.exe') { $prefix=@('-3') }
        $probe=@($prefix)+@('-c','import sys; sys.exit(0 if sys.version_info.major == 3 else 1)')
        try { $code=Invoke-LoggedNative $command.Source $probe }
        catch { Write-InstallLog ("Python candidate could not run: "+$_.Exception.Message); continue }
        if ($code -eq 0) { $python=$command.Source; $pythonArgs=@($prefix); Write-InstallLog ("Python selected: "+$python); break }
        Write-InstallLog ("Python candidate failed with exit code "+$code)
    }
    if (-not $python) { throw 'Python 3 was not found or could not run. Install Python 3 and retry.' }
    $stage='build browser packages'
    Write-InstallLog ("Stage: "+$stage)
    $packageArgs=$pythonArgs+@('-u',(Join-Path $PSScriptRoot 'package_for_stores.py'),'--repo-dir',$repo)
    $code=Invoke-LoggedNative $python $packageArgs
    Write-InstallLog ("Packaging exit code: "+$code)
    if ($code -ne 0) { $result=$code; throw 'Package generation failed. Browsers were not modified.' }

    $targets=if ($Browser -eq 'All') { @('Firefox','Chromium') } else { @($Browser) }
    $failed=$false
    $installed=0
    $firstFailure=0
    foreach ($target in $targets) {
        $stage="install $target"
        Write-InstallLog ("Stage: "+$stage)
        $arguments=@('-NoProfile','-STA','-ExecutionPolicy','RemoteSigned','-File')
        if ($target -eq 'Firefox') {
            $arguments+=(Join-Path $PSScriptRoot 'install_firefox_locally.ps1')
            if ($FirefoxPath) { $arguments+=@('-FirefoxPath',$FirefoxPath) }
        } else {
            $arguments+=(Join-Path $PSScriptRoot 'install_chromium_locally.ps1')
            $product=if ($target -eq 'Chrome') { 'Google Chrome' } else { 'Chromium' }
            $arguments+=@('-ProductName',$product)
            $selectedPath=if ($target -eq 'Chrome') { $ChromePath } else { $ChromiumPath }
            if ($selectedPath) { $arguments+=@('-BrowserPath',$selectedPath) }
        }
        $code=Invoke-LoggedNative (Join-Path $PSHOME 'powershell.exe') $arguments
        Write-InstallLog ("{0} exit code: {1}" -f $target,$code)
        if ($code -eq 0) { $installed++ }
        elseif ($code -eq 2 -and $Browser -eq 'All') { Write-InstallLog "Skipping $target because it is not installed." }
        else {
            $failed=$true
            if ($firstFailure -eq 0) { $firstFailure=$code }
            Write-InstallLog "[ERROR] $target installation failed. See setup stage and diagnostics above."
        }
    }
    if ($failed) { $result=$firstFailure; throw 'One or more browser installations failed.' }
    if ($installed -eq 0) { throw 'No browser installation was completed.' }
    $result=0
    Write-InstallLog ("[SUCCESS] Completed local installation workflow for {0} browser(s)." -f $installed)
} catch {
    $message="[ERROR] Stage: $stage. $($_.Exception.Message)"
    try { Write-InstallLog $message } catch { [Console]::Error.WriteLine($message) }
    if ($result -eq 0) { $result=1 }
} finally {
    $timer.Stop()
    $summary='Finished with exit code {0}; elapsed {1:F1} seconds.' -f $result,$timer.Elapsed.TotalSeconds
    try { Write-InstallLog $summary } catch { [Console]::Error.WriteLine($summary) }
    if ($logPath) {
        Write-Host ("Full diagnostic log: "+$logPath)
        Write-Host ''
        Write-Host '================ BEGIN FULL INSTALLER LOG ================'
        try {
            Get-Content -LiteralPath $logPath -Encoding UTF8 -ErrorAction Stop | ForEach-Object { Write-Host $_ }
        } catch {
            [Console]::Error.WriteLine("Could not display saved log: $($_.Exception.Message)")
        }
        Write-Host '================= END FULL INSTALLER LOG ================='
    }
}
exit $result
