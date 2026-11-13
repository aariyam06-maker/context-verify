@echo off
REM Double-click to start ContextTrace (web :3000, API :8000, dev console :3751)
python "%~dp0start.py" %*
if errorlevel 1 pause
