@echo off
chcp 65001 >nul
title Tắt Máy Chủ Tải Video Chạy Ngầm
cd /d "%~dp0"
echo Đang tắt máy chủ Tải Video chạy ngầm...
taskkill /F /IM node.exe >nul 2>&1
echo ===================================================
echo   ĐÃ TẮT HOÀN TOÀN MÁY CHỦ CHẠY NGẦM THÀNH CÔNG!
echo ===================================================
timeout /t 2 /nobreak >nul
exit
