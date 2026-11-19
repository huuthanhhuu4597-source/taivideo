@echo off
chcp 65001 >nul
title Khoi Dong Tai Video (Chay Ngam)
cd /d "%~dp0"
echo ===================================================================
echo   DANG KHOI DONG TAI VIDEO - CHAY AN DUOI NEN HE THONG
echo ===================================================================
echo   - May chu tu dong chay ngam (Khong so bi tat nham cua so)
echo   - Dong tab web thi Chrome van tiep tuc tai video 100% ve may
echo   - Khi muon tat may chu hoan toan, nhap dup file: TAT_MAY_CHU.bat
echo ===================================================================
wscript.exe "%~dp0CHAY_AN.vbs"
timeout /t 2 /nobreak >nul
exit
