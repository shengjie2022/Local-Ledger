@echo off
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [提示] 没有检测到 Python，直接用浏览器打开 index.html 也能正常使用：
    echo.
    start "" "%~dp0index.html"
    pause
    exit /b 0
)

python "%~dp0启动账本.py" %*
pause
