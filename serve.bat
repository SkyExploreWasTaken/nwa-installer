@echo off
rem Serves the installer on http://localhost:8642 (WebUSB needs localhost or https). Chrome or Edge.
cd /d "%~dp0"
if not exist vendor\eadk.o node setup.js
start "" http://localhost:8642/
node server.js
