@echo off
setlocal
set "UV_THREADPOOL_SIZE=64"
set "SCRIPT=%~dp0dirtree.js"

set "TARGET=%~1"
if not defined TARGET (
  echo.
  echo   dirtree - folder tree generator
  echo   -------------------------------------------------
  echo   Drag a drive ^(like D:^) or a folder onto this file,
  echo   or type a path below.
  echo.
  set /p TARGET=  Path: 
)

if not defined TARGET (
  echo.
  echo   No path given. Bye.
  pause
  exit /b 1
)

echo.
node "%SCRIPT%" "%TARGET%"
echo.
pause
