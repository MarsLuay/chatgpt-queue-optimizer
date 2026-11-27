@echo off
setlocal
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
where cargo.exe >nul 2>nul
if not errorlevel 1 goto Run
where winget.exe >nul 2>nul
if errorlevel 1 goto Missing
winget install --id Rustlang.Rustup --exact --source winget --accept-package-agreements --accept-source-agreements
where cargo.exe >nul 2>nul
if errorlevel 1 goto Missing
:Run
cargo run --release --manifest-path "%~dp0native\Cargo.toml" -- install-auto --repo-dir "%~dp0.." %*
exit /b %ERRORLEVEL%
:Missing
echo Rust/Cargo is required. Install from https://rustup.rs/ then rerun.
exit /b 1
