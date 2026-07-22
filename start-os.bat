@echo off
rem Wing Digital OS auto-start. Safe to run repeatedly: exits if already running.
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if %errorlevel%==0 exit /b 0
cd /d C:\Users\wjack\wing-digital-os
echo [%date% %time%] starting Wing Digital OS >> os-server.log
call npm run dev >> os-server.log 2>&1
