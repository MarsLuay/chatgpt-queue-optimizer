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
py -3 "%REPO_ROOT%Installers\upload_extension.py" --repo-dir "%REPO_ROOT%"
set "UPLOAD_EXIT=%ERRORLEVEL%"
goto FinishedRun

:UsePython
python "%REPO_ROOT%Installers\upload_extension.py" --repo-dir "%REPO_ROOT%"
set "UPLOAD_EXIT=%ERRORLEVEL%"
goto FinishedRun

:FinishedRun
if "%UPLOAD_EXIT%"=="0" (
  echo.
  echo AMO submission requested and local Firefox test launched.
  echo Upload log: %REPO_ROOT%build\logs\upload.log
) else (
  echo.
  echo Upload workflow needs attention. The local Firefox test may still be running.
  echo Upload log: %REPO_ROOT%build\logs\upload.log
  echo Firefox status: %REPO_ROOT%build\logs\upload-firefox-test.log
)

:Finish
exit /b %UPLOAD_EXIT%
