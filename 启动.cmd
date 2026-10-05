@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   启动 herdr-hub（Ctrl+C 停止）
echo.
node hub.mjs
echo.
echo   hub 已退出。
pause
