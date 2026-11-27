@echo off
setlocal EnableExtensions
set "REPO_ROOT=%~dp0"
echo ChatGPT Queue + Optimizer - local browser installation
echo.
set "RESULT=1"
cargo run --release --manifest-path "%REPO_ROOT%Installers\native\Cargo.toml" -- install --repo-dir "%REPO_ROOT%." %*
set "RESULT=%ERRORLEVEL%"
echo.
if "%RESULT%"=="0" (
    echo [SUCCESS] Local installation workflow completed.
) else (
    echo [ERROR] Local installation failed with exit code %RESULT%.
    echo Copy the full installer log printed above when reporting an error.
)
echo Log directory: "%REPO_ROOT%build\logs"
echo.
echo Press any key to close this installer.
pause >nul
exit /b %RESULT%
