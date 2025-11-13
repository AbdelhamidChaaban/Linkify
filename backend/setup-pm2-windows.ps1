# PM2 Windows Setup Script (PowerShell version)
# This script adds wmic to PATH and configures PM2 to avoid wmic errors
# Note: Use setup-pm2-windows.bat if running from cmd.exe

Write-Host "🔧 Setting up PM2 for Windows..." -ForegroundColor Cyan

# Check if wmic exists
$wmicPath = "C:\Windows\System32\wbem\wmic.exe"
if (Test-Path $wmicPath) {
    Write-Host "✅ Found wmic at: $wmicPath" -ForegroundColor Green
    
    # Add to current session PATH
    $env:PATH = "$env:PATH;C:\Windows\System32\wbem"
    Write-Host "✅ Added wmic to current session PATH" -ForegroundColor Green
    
    # Check if already in user PATH
    $userPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*wbem*") {
        Write-Host "⚠️  wmic not in user PATH. Adding it..." -ForegroundColor Yellow
        $newPath = "$userPath;C:\Windows\System32\wbem"
        [System.Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Write-Host "✅ Added wmic to user PATH (requires restart to take effect)" -ForegroundColor Green
    } else {
        Write-Host "✅ wmic already in user PATH" -ForegroundColor Green
    }
} else {
    Write-Host "❌ wmic not found at: $wmicPath" -ForegroundColor Red
    Write-Host "   This is unusual - wmic should be available on Windows" -ForegroundColor Yellow
}

# Restart PM2 daemon to pick up new PATH
Write-Host "`n🔄 Restarting PM2 daemon..." -ForegroundColor Cyan
pm2 kill
Start-Sleep -Seconds 2
pm2 resurrect

Write-Host "`n✅ PM2 setup complete!" -ForegroundColor Green
Write-Host "   If you still see wmic errors, restart your terminal or computer" -ForegroundColor Yellow
Write-Host "   to ensure the PATH changes take effect." -ForegroundColor Yellow

