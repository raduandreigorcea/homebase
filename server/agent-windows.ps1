# Homebase agent for Windows: every few seconds, sends this PC's stats to the
# Homebase panel on the netbook. Runs hidden at logon (shortcut in Startup).
# The push URL below is filled in by the panel when the install command is generated.
$ErrorActionPreference = 'SilentlyContinue'
$url = '__PUSH_URL__'
$cores = [Environment]::ProcessorCount

while ($true) {
    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"

    $gpu = $null
    try {
        $samples = (Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage' -ErrorAction Stop).CounterSamples
        $gpu = [math]::Min(100, [math]::Round(($samples | Measure-Object CookedValue -Sum).Sum, 1))
    } catch {}

    $net = Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface |
        Measure-Object -Property BytesReceivedPersec, BytesSentPersec -Sum

    # Busiest app right now (percent of the whole CPU, not of one core).
    $top = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |
        Where-Object { $_.Name -notin '_Total', 'Idle', 'System' } |
        Sort-Object PercentProcessorTime -Descending | Select-Object -First 1

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
    } | ConvertTo-Json -Compress

    try {
        Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 4 | Out-Null
    } catch {}
    Start-Sleep -Seconds 5
}
