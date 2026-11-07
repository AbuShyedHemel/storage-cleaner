@echo off
rem Double-click to open Storage Cleaner for Windows (runs in the system tray).
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tray.ps1" -Open
