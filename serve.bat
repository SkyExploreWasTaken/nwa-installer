@echo off
rem Starts Nwa Toolkit on http://localhost:8642 and opens it. Use Chrome or Edge (they have WebUSB).
cd /d "%~dp0"
if not exist node_modules\nwlink if not exist ..\numworks\node_modules\nwlink call npm install
if not exist public\vendor\eadk.o node tools\setup.js
start "" http://localhost:8642/
node server.js
