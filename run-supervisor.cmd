@echo off
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" supervisor.js >> supervisor.log 2>&1
