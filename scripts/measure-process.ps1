param([Parameter(Mandatory = $true)][int]$RootProcessId, [switch]$AssertHidden, [switch]$AssertVisible, [long]$WindowHandle)

$ErrorActionPreference = 'Stop'
if ($AssertHidden -or $AssertVisible) {
    Get-Process -Id $RootProcessId | Out-Null
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PrototypeWindow {
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
}
'@
    if (-not [PrototypeWindow]::IsWindow([IntPtr]$WindowHandle)) {
        throw 'Prototype window was destroyed instead of hidden'
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $visible = [PrototypeWindow]::IsWindowVisible([IntPtr]$WindowHandle)
        if ($visible -eq [bool]$AssertVisible) {
            @{ hidden = -not $visible; visible = $visible } | ConvertTo-Json -Compress
            return
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Prototype window visibility did not become $([bool]$AssertVisible)"

}
$processes = Get-CimInstance Win32_Process
$ids = [System.Collections.Generic.HashSet[int]]::new()
$null = $ids.Add($RootProcessId)
do {
    $added = $false
    foreach ($entry in $processes) {
        if ($ids.Contains([int]$entry.ParentProcessId) -and $ids.Add([int]$entry.ProcessId)) {
            $added = $true
        }
    }
} while ($added)

Get-Process -Id $RootProcessId | Out-Null
$metrics = @(Get-Process -Id @($ids) -ErrorAction SilentlyContinue | Select-Object ProcessName, @{ Name = 'workingSetKiB'; Expression = { [math]::Round($_.WorkingSet64 / 1KB) } })
@{
    windowHandle = (Get-Process -Id $RootProcessId).MainWindowHandle.ToInt64()
    workingSetKiB = ($metrics | Measure-Object workingSetKiB -Sum).Sum
    processes = $metrics
} | ConvertTo-Json -Depth 3
