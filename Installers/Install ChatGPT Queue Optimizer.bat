@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "INSTALLER_DIR=%~dp0"
for %%I in ("%INSTALLER_DIR%..") do set "REPO_ROOT=%%~fI"
set "BUILD_DIR=%REPO_ROOT%\build"
set "LOG_FILE=%BUILD_DIR%\installer.log"
set "HELP_LINKS_FILE=%BUILD_DIR%\installer-help-links.txt"
set "PYTHON_HELP=https://www.python.org/downloads/windows/"
set "CHROME_HELP=https://www.google.com/chrome/"
set "FIREFOX_HELP=https://www.mozilla.org/firefox/windows/"
set "NODE_HELP=https://nodejs.org/en/download"
set "EXTENSION_HELP=https://github.com/MarsLuay/chatgpt-queue-optimizer"

if not exist "%BUILD_DIR%" mkdir "%BUILD_DIR%" >nul 2>nul
type nul > "%HELP_LINKS_FILE%"

call :Log "Installing ChatGPT Queue Optimizer from %REPO_ROOT%."
call :EnsurePython
if errorlevel 1 goto Failed
call :EnsureChrome
call :EnsureFirefox
call :EnsureNode

"%PYTHON_EXE%" "%INSTALLER_DIR%install_chatgpt_queue_optimizer.py" --repo-dir "%REPO_ROOT%" %* >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
  call :AddHelpLink "ChatGPT Queue Optimizer repository" "%EXTENSION_HELP%"
  call :AddHelpLink "Chrome extension install help" "https://support.google.com/chrome_webstore/answer/2664769"
  call :AddHelpLink "Firefox extension install help" "https://support.mozilla.org/kb/find-and-install-add-ons-add-features-to-firefox"
  goto Failed
)

call :Log "ChatGPT Queue Optimizer install completed."
echo ChatGPT Queue Optimizer install completed.
echo Log: %LOG_FILE%
call :PrintHelpLinks
exit /b 0

:Failed
call :Log "Install finished with something that needs attention."
echo ChatGPT Queue Optimizer install needs attention.
echo Log: %LOG_FILE%
call :PrintHelpLinks
exit /b 1

:Log
set "LOG_LINE=[%DATE% %TIME%] %~1"
echo(!LOG_LINE!
>>"%LOG_FILE%" echo(!LOG_LINE!
exit /b 0

:AddHelpLink
if "%~1"=="" exit /b 0
>>"%HELP_LINKS_FILE%" echo %~1 - %~2
exit /b 0

:PrintHelpLinks
if not exist "%HELP_LINKS_FILE%" exit /b 0
for %%H in ("%HELP_LINKS_FILE%") do if %%~zH GTR 0 (
  echo.
  echo Help links for anything that needs attention:
  type "%HELP_LINKS_FILE%"
)
exit /b 0

:RefreshPath
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links" set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"
if exist "%ProgramFiles%\Git\cmd" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
if exist "%ProgramFiles%\Git\usr\bin" set "PATH=%ProgramFiles%\Git\usr\bin;%PATH%"
if exist "%LOCALAPPDATA%\Programs\Git\cmd" set "PATH=%LOCALAPPDATA%\Programs\Git\cmd;%PATH%"
if exist "%LOCALAPPDATA%\Programs\Git\usr\bin" set "PATH=%LOCALAPPDATA%\Programs\Git\usr\bin;%PATH%"
if exist "%ProgramFiles%\nodejs" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\Python\Launcher" set "PATH=%LOCALAPPDATA%\Programs\Python\Launcher;%PATH%"
if exist "%LOCALAPPDATA%\Programs\Python\Python312" set "PATH=%LOCALAPPDATA%\Programs\Python\Python312;%PATH%"
if exist "%LOCALAPPDATA%\Programs\Python\Python312\Scripts" set "PATH=%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%PATH%"
if exist "%ProgramFiles%\Python312" set "PATH=%ProgramFiles%\Python312;%PATH%"
if exist "%ProgramFiles%\Python312\Scripts" set "PATH=%ProgramFiles%\Python312\Scripts;%PATH%"
exit /b 0

:InstallWinget
set "PKG_ID=%~1"
set "PKG_NAME=%~2"
where winget >nul 2>nul
if errorlevel 1 (
  call :Log "winget was not found; cannot auto-install %PKG_NAME%."
  exit /b 1
)
call :Log "Installing %PKG_NAME% with winget."
winget install --id "%PKG_ID%" --exact --source winget --accept-package-agreements --accept-source-agreements >> "%LOG_FILE%" 2>&1
exit /b %ERRORLEVEL%

:FindPython
set "PYTHON_EXE="
for /f "delims=" %%P in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do set "PYTHON_EXE=%%P"
if defined PYTHON_EXE exit /b 0
for /f "delims=" %%P in ('python -c "import sys; print(sys.executable)" 2^>nul') do set "PYTHON_EXE=%%P"
if defined PYTHON_EXE exit /b 0
exit /b 1

:EnsurePython
call :RefreshPath
call :FindPython
if defined PYTHON_EXE (
  call :Log "Python found: %PYTHON_EXE%"
  exit /b 0
)
call :InstallWinget "Python.Python.3.12" "Python"
call :RefreshPath
call :FindPython
if defined PYTHON_EXE (
  call :Log "Python installed: %PYTHON_EXE%"
  exit /b 0
)
call :Log "Python was not found."
call :AddHelpLink "Install Python for Windows" "%PYTHON_HELP%"
exit /b 1

:FindChrome
set "CHROME_EXE="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if defined CHROME_EXE exit /b 0
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if defined CHROME_EXE exit /b 0
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if defined CHROME_EXE exit /b 0
for /f "delims=" %%P in ('where chrome 2^>nul') do if not defined CHROME_EXE set "CHROME_EXE=%%P"
if defined CHROME_EXE exit /b 0
exit /b 1

:EnsureChrome
call :RefreshPath
call :FindChrome
if defined CHROME_EXE (
  call :Log "Chrome found: %CHROME_EXE%"
  exit /b 0
)
call :InstallWinget "Google.Chrome" "Google Chrome"
call :RefreshPath
call :FindChrome
if not defined CHROME_EXE (
  call :Log "Chrome was not found; Chrome install may be skipped."
  call :AddHelpLink "Install Google Chrome" "%CHROME_HELP%"
)
exit /b 0

:FindFirefox
set "FIREFOX_EXE="
if exist "%ProgramFiles%\Mozilla Firefox\firefox.exe" set "FIREFOX_EXE=%ProgramFiles%\Mozilla Firefox\firefox.exe"
if defined FIREFOX_EXE exit /b 0
if exist "%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe" set "FIREFOX_EXE=%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe"
if defined FIREFOX_EXE exit /b 0
if exist "%LOCALAPPDATA%\Mozilla Firefox\firefox.exe" set "FIREFOX_EXE=%LOCALAPPDATA%\Mozilla Firefox\firefox.exe"
if defined FIREFOX_EXE exit /b 0
if exist "%LOCALAPPDATA%\Programs\Mozilla Firefox\firefox.exe" set "FIREFOX_EXE=%LOCALAPPDATA%\Programs\Mozilla Firefox\firefox.exe"
if defined FIREFOX_EXE exit /b 0
for /f "delims=" %%P in ('where firefox 2^>nul') do if not defined FIREFOX_EXE set "FIREFOX_EXE=%%P"
if defined FIREFOX_EXE exit /b 0
exit /b 1

:EnsureFirefox
call :RefreshPath
call :FindFirefox
if defined FIREFOX_EXE (
  call :Log "Firefox found: %FIREFOX_EXE%"
  exit /b 0
)
call :InstallWinget "Mozilla.Firefox" "Firefox"
call :RefreshPath
call :FindFirefox
if not defined FIREFOX_EXE (
  call :Log "Firefox was not found; Firefox install may be skipped."
  call :AddHelpLink "Install Firefox" "%FIREFOX_HELP%"
)
exit /b 0

:EnsureNode
call :RefreshPath
where npm >nul 2>nul
if not errorlevel 1 (
  call :Log "npm found."
  exit /b 0
)
call :InstallWinget "OpenJS.NodeJS.LTS" "Node.js LTS"
call :RefreshPath
where npm >nul 2>nul
if errorlevel 1 (
  call :Log "npm was not found; Firefox temporary loader may be skipped."
  call :AddHelpLink "Install Node.js" "%NODE_HELP%"
)
exit /b 0
