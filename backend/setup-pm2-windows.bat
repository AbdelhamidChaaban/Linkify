@echo off
REM PM2 Windows Setup Script (Batch version)
REM This script adds wmic to PATH and configures PM2 to avoid wmic errors

echo.
echo ========================================
echo   PM2 Windows Setup
echo ========================================
echo.

REM Check if wmic exists
set "WMIC_PATH=C:\Windows\System32\wbem\wmic.exe"
if exist "%WMIC_PATH%" (
    echo [OK] Found wmic at: %WMIC_PATH%
    
    REM Add to current session PATH
    set "PATH=%PATH%;C:\Windows\System32\wbem"
    echo [OK] Added wmic to current session PATH
    
    REM Check if already in user PATH
    for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul ^| findstr /i "Path"') do set "USER_PATH=%%B"
    
    if "%USER_PATH%"=="" (
        echo [INFO] No user PATH found, creating new one...
        setx PATH "C:\Windows\System32\wbem" >nul
        echo [OK] Created user PATH with wmic
    ) else (
        echo %USER_PATH% | findstr /i "wbem" >nul
        if errorlevel 1 (
            echo [INFO] wmic not in user PATH. Adding it...
            setx PATH "%USER_PATH%;C:\Windows\System32\wbem" >nul 2>&1
            if errorlevel 1 (
                echo [WARNING] Could not update user PATH (may be too long)
                echo [INFO] You may need to manually add C:\Windows\System32\wbem to PATH
            ) else (
                echo [OK] Added wmic to user PATH (requires restart to take effect)
            )
        ) else (
            echo [OK] wmic already in user PATH
        )
    )
) else (
    echo [ERROR] wmic not found at: %WMIC_PATH%
    echo         This is unusual - wmic should be available on Windows
    pause
    exit /b 1
)

REM Restart PM2 daemon to pick up new PATH
echo.
echo [INFO] Restarting PM2 daemon...
pm2 kill
timeout /t 2 /nobreak >nul
pm2 resurrect

echo.
echo ========================================
echo   Setup Complete!
echo ========================================
echo.
echo If you still see wmic errors, restart your terminal
echo or computer to ensure the PATH changes take effect.
echo.
pause

