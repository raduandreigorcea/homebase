# Homebase agent for Windows: every few seconds, sends this PC's stats to the
# Homebase panel on the netbook. Runs hidden at logon (shortcut in Startup).
# The push URL below is filled in by the panel when the install command is generated.
$ErrorActionPreference = 'SilentlyContinue'
$url = '__PUSH_URL__'
$cores = [Environment]::ProcessorCount
$cs = Get-CimInstance Win32_ComputerSystem
$model = "$($cs.Manufacturer) $($cs.Model)".Trim()
$rdpKey = 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'

while ($true) {
    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"

    # GPU load from WMI: unlike Get-Counter, its names aren't translated on non-English Windows.
    $gpu = $null
    $eng = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like '*engtype_3D' }
    if ($eng) { $gpu = [math]::Min(100, [math]::Round(($eng | Measure-Object UtilizationPercentage -Sum).Sum, 1)) }

    $net = Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface |
        Measure-Object -Property BytesReceivedPersec, BytesSentPersec -Sum

    # Busiest app right now (percent of the whole CPU, not of one core).
    $top = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |
        Where-Object { $_.Name -notin '_Total', 'Idle', 'System' } |
        Sort-Object PercentProcessorTime -Descending | Select-Object -First 1

    $nla = (Get-ItemProperty $rdpKey -Name UserAuthentication -ErrorAction SilentlyContinue).UserAuthentication
    if ($null -eq $nla) { $nla = -1 }

    $body = @{
        host       = $env:COMPUTERNAME
        os         = $os.Caption
        boot       = ([DateTimeOffset]$os.LastBootUpTime).ToUnixTimeSeconds()
        cpu        = $cpu
        mem_total  = [int64]$os.TotalVisibleMemorySize * 1024
        mem_free   = [int64]$os.FreePhysicalMemory * 1024
        disk_total = [int64]$disk.Size
        disk_free  = [int64]$disk.FreeSpace
        gpu        = $gpu
        net_down   = $net[0].Sum
        net_up     = $net[1].Sum
        top_name   = ($top.Name -replace '#\d+$', '')
        top_cpu    = [math]::Round($top.PercentProcessorTime / $cores, 1)
        model      = $model
        # 0 = Remote Desktop signs in on the Windows screen (set by the installer); -1 = no Remote Desktop (Home)
        nla        = $nla
        # Who's signed in (the SSH user) and whether Homebase can reach this PC over SSH
        user       = $env:USERNAME
        ssh        = [int]((Get-Service sshd -ErrorAction SilentlyContinue).Status -eq 'Running')
    } | ConvertTo-Json -Compress

    try {
        Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 4 | Out-Null
    } catch {}
    Start-Sleep -Seconds 5
}
