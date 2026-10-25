@echo off
setlocal
chcp 65001 >nul
set "UV_THREADPOOL_SIZE=64"
set "SCRIPT=%~dp0dirtree.js"

set "TARGET=%~1"
if not defined TARGET (
  echo.
  echo   dirtree - 目录树生成工具
  echo   -------------------------------------------------
  echo   把盘符（如 D:）或文件夹拖到本文件上，
  echo   或在下面输入路径。
  echo.
  set /p TARGET=  路径:
)

if not defined TARGET (
  echo.
  echo   没有给定路径，退出。
  pause
  exit /b 1
)

echo.
node "%SCRIPT%" "%TARGET%"
echo.
pause
