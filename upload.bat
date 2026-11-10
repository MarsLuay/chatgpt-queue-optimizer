@echo off
setlocal
set "REPO_ROOT=%~dp0"

where py >nul 2>nul
if not errorlevel 1 goto UsePy
where python >nul 2>nul
if not errorlevel 1 goto UsePython

echo Python 3 is required. Install it from https://www.python.org/downloads/windows/
set "UPLOAD_EXIT=1"
goto Finish

:UsePy
py -3 "%REPO_ROOT%Installers\publish_firefox.py" --repo-dir "%REPO_ROOT%"
set "UPLOAD_EXIT=%ERRORLEVEL%"
goto FinishedRun

:UsePython
python "%REPO_ROOT%Installers\publish_firefox.py" --repo-dir "%REPO_ROOT%"
set "UPLOAD_EXIT=%ERRORLEVEL%"
goto FinishedRun

:FinishedRun
if "%UPLOAD_EXIT%"=="0" (
  echo.
  echo AMO update submitted. Version bump committed and pushed to origin/main.
  echo Upload log: %REPO_ROOT%build\logs\upload.log
) else (
  echo.
  echo Release stopped. Check the log and Git status before retrying.
  echo Upload log: %REPO_ROOT%build\logs\upload.log
  echo Firefox status: %REPO_ROOT%build\logs\upload-firefox-test.log
)

:Finish
exit /b %UPLOAD_EXIT%
