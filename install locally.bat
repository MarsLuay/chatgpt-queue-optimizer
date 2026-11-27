@echo off
setlocal EnableExtensions
set "REPO_ROOT=%~dp0"
echo ChatGPT Queue + Optimizer - local browser installation
echo.
set "BROWSER_OPTION="
if not "%~1"=="" goto FindPython
echo 1. Firefox
echo 2. Chromium
choice /C 12 /N /M "Choose a browser [1-2]: "
if errorlevel 255 exit /b 1
if errorlevel 2 goto ChooseChromium
if errorlevel 1 goto ChooseFirefox
exit /b 1

:ChooseChromium
set "BROWSER_OPTION=-Browser Chromium"
goto FindPython

:ChooseFirefox
set "BROWSER_OPTION=-Browser Firefox"

:FindPython
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
powershell.exe -NoProfile -STA -ExecutionPolicy RemoteSigned -File "%REPO_ROOT%Installers\install_locally.ps1" %BROWSER_OPTION% %*
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo [ERROR] Local installation failed. See the browser setup stage above.
exit /b %RESULT%
