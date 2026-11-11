@echo off
setlocal EnableExtensions
set "REPO_ROOT=%~dp0"
set "UPLOAD_LOG=%REPO_ROOT%build\logs\upload.log"
set "FIREFOX_LOG=%REPO_ROOT%build\logs\upload-firefox-test.log"
set "UPLOAD_EXIT=1"

echo ChatGPT Queue + Optimizer - Firefox release publisher
echo.

where py >nul 2>nul
if not errorlevel 1 goto UsePy
where python >nul 2>nul
if not errorlevel 1 goto UsePython

echo [ERROR] Python 3 was not found.
echo Install Python 3 from https://www.python.org/downloads/windows/
goto Finish

:UsePy
py -3 "%REPO_ROOT%Installers\publish_firefox.py" --repo-dir "%REPO_ROOT%."
set "UPLOAD_EXIT=%ERRORLEVEL%"
goto ShowResult

:UsePython
python "%REPO_ROOT%Installers\publish_firefox.py" --repo-dir "%REPO_ROOT%."
set "UPLOAD_EXIT=%ERRORLEVEL%"
goto ShowResult

:ShowResult
if "%UPLOAD_EXIT%"=="0" goto Success

echo.
echo [ERROR] Firefox publishing failed. Exit code: %UPLOAD_EXIT%
echo Review the error messages above.
echo.
if exist "%UPLOAD_LOG%" (
  echo ===== Upload log =====
  type "%UPLOAD_LOG%"
  echo ===== End upload log =====
) else (
  echo No upload log was created. The failure may have occurred during startup.
)
echo.
echo Upload log: "%UPLOAD_LOG%"
echo Firefox test log: "%FIREFOX_LOG%"
echo Check git status before retrying, especially if submission already started.
goto Finish

:Success
echo.
echo [SUCCESS] AMO update submitted. Version bump committed and pushed to origin/main.
echo Upload log: "%UPLOAD_LOG%"
echo Mozilla review may still be pending.

:Finish
echo.
echo Press any key to close this window.
pause >nul
exit /b %UPLOAD_EXIT%
