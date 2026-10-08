# Homebase: prepares a Windows PC. Served once by the panel:  irm http://<laptop>:8801/a/<code> | iex
# 1. Stats agent, no admin needed: %LOCALAPPDATA%\Homebase, started at every logon from the Startup folder.
# 2. Remote Desktop, after one "Yes" in Windows' permission prompt: turned on, allowed through the
#    firewall, and set to sign in on the normal Windows screen (PIN or password). That last part is what
#    lets a Microsoft account sign in from a Linux laptop without any extra steps.
# 3. SSH, in the same elevated step: Windows' own OpenSSH server with Homebase's key, so files, speed
#    tests and restarts work without typing a password anywhere. When Homebase installs it, it accepts
#    only keys (no passwords) and only connections from this home network.
# Plain ASCII on purpose: Windows PowerShell 5.1 can misread other characters when piped through iex.

Write-Host ''
Write-Host '  Homebase is preparing this PC...' -ForegroundColor Cyan

# --- 1. Stats agent ---
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
Write-Host '  [1/3] Stats: done.' -ForegroundColor Green

# Homebase's SSH key for this user (no admin needed). Admin accounts use the shared file set below.
$key = '__HOMEBASE_KEY__'
$sshDir = Join-Path $env:USERPROFILE '.ssh'
New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
$userKeys = Join-Path $sshDir 'authorized_keys'
if (-not (Test-Path $userKeys) -or -not (Select-String -Path $userKeys -SimpleMatch $key -Quiet)) {
    Add-Content -Path $userKeys -Value $key -Encoding ascii
}

# --- 2 + 3. Remote Desktop and SSH (one elevated step) ---
$edition = (Get-CimInstance Win32_OperatingSystem).Caption
$rdpOk = $edition -notmatch 'Home'
# Runs elevated, in its own process; sent encoded so no quoting can break it. Each part reports
# its result in a small file, so one failing doesn't hide how the other went.
$admin = @'
$out = Join-Path $env:TEMP 'homebase-prepare.txt'
Set-Content -Path $out -Value '' -Encoding ascii
function Step($name) { Add-Content $out "step=$name" }   # the window that started us shows these as progress
if ('__RDP__' -eq 'yes') {
    Step 'rdp'
    try {
        $ts = 'HKLM:\System\CurrentControlSet\Control\Terminal Server'
        Set-ItemProperty $ts -Name fDenyTSConnections -Value 0 -ErrorAction Stop
        Set-ItemProperty "$ts\WinStations\RDP-Tcp" -Name UserAuthentication -Value 0 -ErrorAction Stop
        Enable-NetFirewallRule -Group '@FirewallAPI.dll,-28752' -ErrorAction Stop
        Add-Content $out 'rdp=ok'
    } catch { Add-Content $out "rdp=$($_.Exception.Message)" }
}
try {
    Step 'ssh-install'
    $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
    $fresh = $cap.State -ne 'Installed'
    if ($fresh) { Add-WindowsCapability -Online -Name $cap.Name -ErrorAction Stop | Out-Null }
    Step 'ssh-config'
    Set-Service sshd -StartupType Automatic
    Start-Service sshd -ErrorAction Stop   # the first start also creates its config and host keys
    $cfg = Join-Path $env:ProgramData 'ssh\sshd_config'
    if ($fresh -and (Test-Path $cfg)) {
        # Installed just now by Homebase: keys only. sshd uses the first value it reads, so put it on top.
        $lines = Get-Content $cfg | Where-Object { $_ -notmatch '^\s*#?\s*PasswordAuthentication\b' }
        Set-Content -Path $cfg -Value (@('PasswordAuthentication no') + $lines) -Encoding ascii
        Restart-Service sshd
    }
    Step 'ssh-key'
    # Administrators' keys live in one shared file that must allow only Administrators and SYSTEM
    # (by SID: the group names are translated).
    $k = '__HOMEBASE_KEY__'
    $f = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
    if (-not (Test-Path $f) -or -not (Select-String -Path $f -SimpleMatch $k -Quiet)) { Add-Content -Path $f -Value $k -Encoding ascii }
    icacls $f /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null
    if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
    }
    if ($fresh) { Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -RemoteAddress LocalSubnet -Profile Any }
    Add-Content $out 'ssh=ok'
} catch { Add-Content $out "ssh=$($_.Exception.Message)" }
'@
$admin = $admin.Replace('__RDP__', $(if ($rdpOk) { 'yes' } else { 'no' }))
$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($admin))
# Started from "Terminal (Admin)" we already have the rights: no permission window at all.
# From a normal terminal Windows asks, and it often leaves that window as a blinking taskbar icon.
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $elevated) {
    Write-Host '  Choose "Yes" in the permission window.' -ForegroundColor Gray
    Write-Host '  Not showing? Look for a blinking shield icon on the taskbar and click it.' -ForegroundColor Gray
}
$result = Join-Path $env:TEMP 'homebase-prepare.txt'
Remove-Item $result -ErrorAction SilentlyContinue
try {
    $psi = @{ FilePath = 'powershell.exe'; WindowStyle = 'Hidden'; PassThru = $true; ArgumentList = "-NoProfile -EncodedCommand $enc" }
    if (-not $elevated) { $psi.Verb = 'RunAs' }
    $p = Start-Process @psi
    # Progress: the elevated part writes "step=..." lines as it goes; show them as a bar, a spinner and seconds.
    $labels = @{ 'rdp' = 'Turning on Remote Desktop'; 'ssh-install' = 'Installing SSH (can take 1-2 minutes)'
                 'ssh-config' = 'Setting up SSH'; 'ssh-key' = 'Adding the Homebase key' }
    $order = @('rdp', 'ssh-install', 'ssh-config', 'ssh-key')
    $spin = @('|', '/', '-', '\')
    $t0 = Get-Date
    $i = 0
    while (-not $p.HasExited) {
        $step = (Get-Content $result -ErrorAction SilentlyContinue | Where-Object { $_ -like 'step=*' } | Select-Object -Last 1) -replace '^step=', ''
        $n = [array]::IndexOf($order, $step) + 1
        $bar = ('#' * ($n * 5)).PadRight(20, '-')
        $label = if ($labels[$step]) { $labels[$step] } else { 'Starting...' }
        $line = '  [{0}] {1} {2} ({3}s)' -f $bar, $spin[$i % 4], $label, [int]((Get-Date) - $t0).TotalSeconds
        Write-Host -NoNewline ("`r" + $line.PadRight(78))
        $i++
        Start-Sleep -Milliseconds 250
    }
    Write-Host -NoNewline ("`r" + (' ' * 78) + "`r")
    $r = @{}
    if (Test-Path $result) { Get-Content $result | Where-Object { $_ -match '=' } | ForEach-Object { $a = $_ -split '=', 2; $r[$a[0]] = $a[1] } }
    if (-not $rdpOk) { Write-Host "  [2/3] $edition has no Remote Desktop (Pro only)." -ForegroundColor Yellow }
    elseif ($r['rdp'] -eq 'ok') { Write-Host '  [2/3] Remote Desktop: on.' -ForegroundColor Green }
    else { Write-Host "  [2/3] Remote Desktop: couldn't turn it on. $($r['rdp'])" -ForegroundColor Red }
    if ($r['ssh'] -eq 'ok') { Write-Host '  [3/3] SSH: on (Homebase key only, home network only).' -ForegroundColor Green }
    else { Write-Host "  [3/3] SSH: couldn't turn it on. $($r['ssh'])" -ForegroundColor Red }
} catch {
    Write-Host '  [2/3] [3/3] Skipped (you chose No). Stats work; you can run the command again any time.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '  Done! You can close this window.' -ForegroundColor Green
Write-Host ''
