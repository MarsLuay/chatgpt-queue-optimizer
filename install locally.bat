@echo off
setlocal EnableExtensions
set "REPO_ROOT=%~dp0"
echo ChatGPT Queue + Optimizer - install locally into Firefox and Chromium
echo.
where py >nul 2>nul
if not errorlevel 1 goto UsePy
where python >nul 2>nul
if not errorlevel 1 goto UsePython
echo [ERROR] Python 3 is required to build the browser packages.
exit /b 1

:UsePy
py -3 "%REPO_ROOT%Installers\package_for_stores.py" --repo-dir "%REPO_ROOT%."
goto CheckBuild

:UsePython
python "%REPO_ROOT%Installers\package_for_stores.py" --repo-dir "%REPO_ROOT%."

:CheckBuild
if errorlevel 1 (
    echo [ERROR] Package generation failed. Browsers were not modified.
    exit /b 1
)
powershell.exe -NoProfile -STA -ExecutionPolicy RemoteSigned -File "%REPO_ROOT%Installers\install_locally.ps1" %*
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo [ERROR] Local installation failed. See the browser setup stage above.
exit /b %RESULT%
