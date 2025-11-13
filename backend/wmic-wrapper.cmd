@echo off
REM WMIC Wrapper for PM2/pidusage on Windows
REM This script redirects wmic calls to tasklist to avoid ENOENT errors
REM Place this in a directory that's in your PATH, or add it to PATH

REM Check if wmic exists
where wmic >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    REM Use real wmic if available
    wmic %*
    exit /b %ERRORLEVEL%
)

REM Fallback to tasklist for process info
REM pidusage typically calls: wmic process where ProcessId=1234 get ...
REM We'll use tasklist /FI "PID eq 1234" instead
if "%1"=="process" (
    REM Extract PID from the query
    set "query=%*"
    set "query=%query:where ProcessId=%=%"
    set "query=%query: get%=%"
    set "query=%query: =%"
    
    REM Use tasklist to get process info
    tasklist /FI "PID eq %query%" /FO CSV /NH
    exit /b 0
)

REM For other wmic commands, just return empty (pidusage will handle gracefully)
exit /b 0

