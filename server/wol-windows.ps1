# Wake-on-LAN check for Windows. The panel pastes this into the agent and the installer.
# Looks at the network adapter this PC is using right now and says whether Windows lets it wake the PC
# from standby: wol = 1 only when it is a wired adapter on Windows' own list of devices that can wake it.
# (Wi-Fi never is, on the PCs we've seen. Whatever the answer, it is only about the connection in use.)
# If Windows won't list its devices to this process (the agent runs without admin rights), it falls back to
# what the installer found when it ran with them, or says "unknown" ($null): never a wrong "no".
function Get-HomebaseWol {
    $r = @{ wol = 0; mac = $null; name = $null; alias = $null; why = 'unknown' }
    try {
        $cfg = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
        if (-not $cfg) { $r.why = 'no network connection'; return $r }
        $a = $cfg.NetAdapter
        $r.mac = ($a.MacAddress -replace '-', ':').ToLower()
        $r.name = $a.InterfaceDescription
        $r.alias = $a.Name
        if ("$($a.MediaType) $($a.PhysicalMediaType)" -match '802\.11') { $r.why = 'wifi'; return $r }
        $list = powercfg /devicequery wake_programmable 2>$null
        if (-not $list) {
            $r.wol = $null; $r.why = 'unknown'
            $f = Join-Path $env:LOCALAPPDATA 'Homebase\wol.txt'
            if (Test-Path $f) { $t = ((Get-Content $f -Raw).Trim() -split '\|'); if ($t.Count -ge 2 -and $t[1] -eq $r.mac) { $r.wol = [int]$t[0]; $r.why = 'from setup' } }
            return $r
        }
        if ($list | Where-Object { $_.Trim() -eq $a.InterfaceDescription }) { $r.wol = 1; $r.why = 'ok' } else { $r.why = 'not wake-capable' }
    } catch { $r.why = $_.Exception.Message }
    return $r
}
