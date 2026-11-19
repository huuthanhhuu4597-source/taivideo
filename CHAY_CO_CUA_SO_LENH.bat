@echo off
chcp 65001 >nul
title Tai Video - Che Do Xem Nhat Ky Lenh
cd /d "%~dp0"
echo ===================================================================
echo   KHOI DONG TAI VIDEO (CHE DO HIEN THI NHAT KY LENH)
echo ===================================================================
start "" cmd /c "timeout /t 1 /nobreak >nul & start http://localhost:4000"
runtime\node.exe server.js
pause
