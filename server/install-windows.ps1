# Homebase agent installer, served once by the panel:  irm http://<netbook>:8801/a/<code> | iex
# Puts the agent in %LOCALAPPDATA%\Homebase, adds it to Startup, and starts it now. No admin needed.
$dir = Join-Path $env:LOCALAPPDATA 'Homebase'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$agentPath = Join-Path $dir 'agent.ps1'
Set-Content -Path $agentPath -Encoding UTF8 -Value @'
__AGENT__
'@

$psArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$agentPath`""
$startup = [Environment]::GetFolderPath('Startup')
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path $startup 'Homebase agent.lnk'))
$link.TargetPath = 'powershell.exe'
$link.Arguments = $psArgs
$link.WindowStyle = 7
$link.Save()

# Restart the agent if an older copy is already running.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*Homebase\agent.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Process powershell.exe -ArgumentList $psArgs -WindowStyle Hidden

Write-Host ''
Write-Host '  Gata! PC-ul trimite acum statistici catre Homebase.' -ForegroundColor Green
Write-Host '  Poti inchide fereastra asta.' -ForegroundColor Gray
Write-Host ''
