@echo off
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" supervisor.js --log-file supervisor.log
