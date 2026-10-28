param(
    [Parameter(Mandatory = $true)][ValidateSet('Visible', 'CloseWindow', 'Click', 'InspectMenu', 'Open', 'Quit')][string]$Action,
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$RootProcessId,
    [long]$WindowHandle,
    [string]$ScreenshotPath,
    [switch]$AllowMouseFallback
)

$ErrorActionPreference = 'Stop'
$process = Get-Process -Id $RootProcessId
$expectedPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src-tauri/target/release/maestro-prototype.exe'))
if ($process.Path -ne $expectedPath) {
    throw 'The target process is not this checkout''s release app'
}
$others = @(Get-Process -Name 'maestro-prototype' -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $RootProcessId })
if ($others.Count -ne 0) {
    throw "Close other Maestro windows before the tray check. Extra PID(s): $($others.Id -join ', ')"
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class TrayPointer {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr handle, uint flags);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr handle, System.Text.StringBuilder name, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
}
'@
# Physical screen coordinates must match the DPI-scaled bounds reported by UI Automation.
$null = [TrayPointer]::SetProcessDpiAwarenessContext([IntPtr](-4))

$root = [System.Windows.Automation.AutomationElement]::RootElement
$children = [System.Windows.Automation.TreeScope]::Children
$descendants = [System.Windows.Automation.TreeScope]::Descendants
$nameProperty = [System.Windows.Automation.AutomationElement]::NameProperty
$classProperty = [System.Windows.Automation.AutomationElement]::ClassNameProperty
$pidProperty = [System.Windows.Automation.AutomationElement]::ProcessIdProperty
$gaRoot = 2
$script:desktopIdle = $false
$script:screenshotTaken = $false

function Wait-Control($Parent, $Scope, $Condition, [string]$Description) {
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $element = $Parent.FindFirst($Scope, $Condition)
        if ($null -ne $element -and -not $element.Current.IsOffscreen) {
            return $element
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "The $Description did not become visible within five seconds"
}

function Get-LastInputTick {
    $info = [TrayPointer+LASTINPUTINFO]::new()
    $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][TrayPointer+LASTINPUTINFO])
    if (-not [TrayPointer]::GetLastInputInfo([ref]$info)) {
        return $null
    }
    return [uint32]$info.dwTime
}

function Wait-DesktopIdle([int]$QuietMilliseconds = 800, [int]$TimeoutSeconds = 6) {
    # Comparing the tick before and after avoids 49-day wraparound math.
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $before = Get-LastInputTick
        Start-Sleep -Milliseconds $QuietMilliseconds
        $after = Get-LastInputTick
        if ($null -ne $before -and $before -eq $after) {
            return $true
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Get-ForegroundInfo {
    $handle = [TrayPointer]::GetForegroundWindow()
    $ownerProcessId = [uint32]0
    $null = [TrayPointer]::GetWindowThreadProcessId($handle, [ref]$ownerProcessId)
    $className = [System.Text.StringBuilder]::new(256)
    $null = [TrayPointer]::GetClassName($handle, $className, 256)
    return @{
        handle = $handle
        processId = [int]$ownerProcessId
        className = $className.ToString()
    }
}

function Test-ContainerForeground([long]$ContainerHandle) {
    $foreground = Get-ForegroundInfo
    if ($foreground.handle.ToInt64() -eq $ContainerHandle) {
        return $true
    }
    $rootHandle = [TrayPointer]::GetAncestor($foreground.handle, $gaRoot)
    return $rootHandle.ToInt64() -eq $ContainerHandle
}

function Test-MenuKeyTarget($Menu) {
    if ($null -eq $Menu) {
        return $false
    }
    try {
        if ($Menu.Current.IsOffscreen) {
            return $false
        }
        if (-not [TrayPointer]::IsWindow([IntPtr]$Menu.Current.NativeWindowHandle)) {
            return $false
        }
    } catch {
        return $false
    }
    # Win32 popup menus run a modal loop without becoming the foreground window.
    # Keys are safe only while the shell flyout or our own app owns the foreground.
    $foreground = Get-ForegroundInfo
    if ($foreground.processId -eq $RootProcessId) {
        return $true
    }
    return $foreground.className -eq 'Shell_TrayWnd' -or $foreground.className -eq 'TopLevelWindowForOverflowXamlIsland'
}

function Send-Key([byte]$Key) {
    [TrayPointer]::keybd_event($Key, 0, 0, [UIntPtr]::Zero)
    [TrayPointer]::keybd_event($Key, 0, 0x0002, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 120
}

function Wait-IconFocus($Icon, [int]$TimeoutMilliseconds = 600) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    do {
        if ($Icon.Current.HasKeyboardFocus) {
            return $true
        }
        try {
            $Icon.SetFocus()
        } catch {
            # A shell surface may reject programmatic focus; retry until the deadline.
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Get-TrayIcon {
    $taskbar = Wait-Control $root $children ([System.Windows.Automation.PropertyCondition]::new($classProperty, 'Shell_TrayWnd')) 'Windows taskbar'
    $iconCondition = [System.Windows.Automation.PropertyCondition]::new($nameProperty, 'Maestro')
    $icon = $taskbar.FindFirst($descendants, $iconCondition)
    if ($null -ne $icon -and -not $icon.Current.IsOffscreen) {
        return @{ icon = $icon; container = $taskbar.Current.NativeWindowHandle }
    }
    $overflowCondition = [System.Windows.Automation.PropertyCondition]::new($classProperty, 'TopLevelWindowForOverflowXamlIsland')
    $overflow = $root.FindFirst($children, $overflowCondition)
    if ($null -eq $overflow -or $overflow.Current.IsOffscreen -or -not [TrayPointer]::IsWindowVisible([IntPtr]$overflow.Current.NativeWindowHandle)) {
        $chevron = Wait-Control $taskbar $descendants ([System.Windows.Automation.PropertyCondition]::new($nameProperty, 'Show Hidden Icons')) 'tray overflow button'
        $chevron.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $overflow = Wait-Control $root $children $overflowCondition 'tray overflow window'
    }
    $overflowHandle = [IntPtr]$overflow.Current.NativeWindowHandle
    $null = [TrayPointer]::SetForegroundWindow($overflowHandle)
    $icon = Wait-Control $overflow $descendants $iconCondition 'Maestro tray icon'
    $null = Wait-IconFocus $icon
    # The flyout animates and reflows; interacting before it settles misses the icon.
    Start-Sleep -Milliseconds 400
    return @{ icon = $icon; container = $overflowHandle.ToInt64() }
}

function Wait-IconBounds($Icon) {
    $deadline = [DateTime]::UtcNow.AddSeconds(3)
    do {
        $bounds = $Icon.Current.BoundingRectangle
        if ($bounds.Width -gt 0 -and $bounds.Height -gt 0) {
            return $bounds
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Maestro tray icon has no visible bounds'
}

function Click-Icon($Icon, [string]$Button, [long]$ContainerHandle) {
    if (-not (Test-ContainerForeground $ContainerHandle)) {
        $null = [TrayPointer]::SetForegroundWindow([IntPtr]$ContainerHandle)
        Start-Sleep -Milliseconds 300
        if (-not (Test-ContainerForeground $ContainerHandle)) {
            throw 'The tray surface does not own focus; refusing to click blindly'
        }
    }
    # Bounds are briefly empty while the overflow flyout lays out.
    $bounds = Wait-IconBounds $Icon
    $cursor = [TrayPointer+Point]::new()
    $null = [TrayPointer]::GetCursorPos([ref]$cursor)
    $null = [TrayPointer]::SetCursorPos([int]($bounds.X + $bounds.Width / 2), [int]($bounds.Y + $bounds.Height / 2))
    Start-Sleep -Milliseconds 150
    if (-not (Test-ContainerForeground $ContainerHandle)) {
        $null = [TrayPointer]::SetCursorPos($cursor.X, $cursor.Y)
        throw 'The tray surface lost focus before the click'
    }
    if ($Button -eq 'Left') {
        [TrayPointer]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [TrayPointer]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    } else {
        [TrayPointer]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
        [TrayPointer]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
    }
    Start-Sleep -Milliseconds 200
    return $cursor
}

function Restore-Cursor($Cursor) {
    if ($null -ne $Cursor) {
        $null = [TrayPointer]::SetCursorPos($Cursor.X, $Cursor.Y)
    }
}

function Get-MenuCondition {
    return [System.Windows.Automation.AndCondition]::new(
        [System.Windows.Automation.PropertyCondition]::new($classProperty, '#32768'),
        [System.Windows.Automation.PropertyCondition]::new($pidProperty, $RootProcessId)
    )
}

function Wait-Menu {
    $menuCondition = Get-MenuCondition
    $deadline = [DateTime]::UtcNow.AddSeconds(2)
    do {
        $menu = $root.FindFirst($children, $menuCondition)
        if ($null -ne $menu -and -not $menu.Current.IsOffscreen) {
            return $menu
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    return $null
}

function Open-TrayMenu {
    $script:desktopIdle = Wait-DesktopIdle
    $attempt = 0
    $lastSafe = $false
    while ($attempt -lt 4) {
        $attempt += 1
        try {
            $surface = Get-TrayIcon
        } catch {
            # The shell can replace the overflow element between lookups.
            Start-Sleep -Milliseconds 300
            continue
        }
        # UIA does not report keyboard focus for these shell icons, but the
        # flyout tracks the last focused icon itself. Gate keys on the shell
        # surface owning the foreground so input can never reach another app.
        $null = Wait-IconFocus $surface.icon
        $lastSafe = Test-ContainerForeground $surface.container
        if ($lastSafe) {
            Send-Key 0x5D
            $menu = Wait-Menu
            if ($null -ne $menu) {
                return @{ menu = $menu; cursor = $null; method = 'keyboard'; attempts = $attempt }
            }
        }
        if ($AllowMouseFallback) {
            $cursor = $null
            try {
                $cursor = Click-Icon $surface.icon 'Right' $surface.container
                $menu = Wait-Menu
                if ($null -ne $menu) {
                    return @{ menu = $menu; cursor = $cursor; method = 'mouse'; attempts = $attempt }
                }
            } catch {
                # A stale element or lost focus is recoverable by retrying a fresh lookup.
            } finally {
                Restore-Cursor $cursor
            }
        }
        Start-Sleep -Milliseconds 300
    }
    $foreground = Get-ForegroundInfo
    throw "The Maestro tray menu did not open after four attempts. Foreground=$($foreground.className)($($foreground.processId)) ShellForeground=$lastSafe Idle=$($script:desktopIdle)"
}

function Select-MenuItem($Menu, [int]$Index) {
    # Owner-drawn popups expose no accessible items; keyboard selection is the native path.
    for ($step = 0; $step -lt $Index; $step += 1) {
        if (-not (Test-MenuKeyTarget $Menu)) {
            $foreground = Get-ForegroundInfo
            throw "The tray menu lost focus before selection. Foreground=$($foreground.className)($($foreground.processId))"
        }
        Send-Key 0x28
    }
    if (-not (Test-MenuKeyTarget $Menu)) {
        $foreground = Get-ForegroundInfo
        throw "The tray menu lost focus before selection. Foreground=$($foreground.className)($($foreground.processId))"
    }
    Send-Key 0x0D
}

function Dismiss-OurMenu($Menu) {
    if (Test-MenuKeyTarget $Menu) {
        Send-Key 0x1B
    }
}

function Wait-MainWindow {
    $windowCondition = [System.Windows.Automation.AndCondition]::new(
        [System.Windows.Automation.PropertyCondition]::new($nameProperty, 'Maestro'),
        [System.Windows.Automation.PropertyCondition]::new($pidProperty, $RootProcessId)
    )
    return Wait-Control $root $children $windowCondition 'Maestro window'
}

function Wait-WindowVisible([bool]$Expected) {
    $deadline = [DateTime]::UtcNow.AddSeconds(3)
    do {
        if ([TrayPointer]::IsWindowVisible([IntPtr]$WindowHandle) -eq $Expected) {
            return $true
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Save-MenuScreenshot($Menu) {
    if (-not $ScreenshotPath) {
        return
    }
    $bounds = $Menu.Current.BoundingRectangle
    $image = [System.Drawing.Bitmap]::new([int]$bounds.Width, [int]$bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($image)
    try {
        $graphics.CopyFromScreen([int]$bounds.X, [int]$bounds.Y, 0, 0, $image.Size)
        $image.Save([System.IO.Path]::GetFullPath($ScreenshotPath), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $image.Dispose()
    }
}

if ($Action -eq 'Visible') {
    if ($WindowHandle -le 0) {
        throw 'Pass the Maestro window handle'
    }
    @{ visible = [TrayPointer]::IsWindowVisible([IntPtr]$WindowHandle) } | ConvertTo-Json -Compress
    return
}

if ($Action -eq 'CloseWindow') {
    $window = Wait-MainWindow
    try {
        $close = $window.FindFirst($descendants, [System.Windows.Automation.PropertyCondition]::new($nameProperty, 'Close'))
        if ($null -eq $close) {
            throw 'No close button'
        }
        $close.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $method = 'close button'
    } catch {
        # WM_CLOSE is the same message the close button sends.
        $null = [TrayPointer]::PostMessage([IntPtr]$window.Current.NativeWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
        $method = 'WM_CLOSE'
    }
    @{ action = 'CloseWindow'; method = $method } | ConvertTo-Json -Compress
    return
}

if ($Action -eq 'Click') {
    $script:desktopIdle = Wait-DesktopIdle
    $surface = Get-TrayIcon
    $method = 'InvokePattern'
    try {
        $surface.icon.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    } catch {
        if (-not $AllowMouseFallback) {
            throw 'The tray icon Invoke pattern failed. Enable -AllowMouseFallback for an attended run.'
        }
        $method = 'mouse'
        $cursor = Click-Icon $surface.icon 'Left' $surface.container
        Start-Sleep -Milliseconds 200
        Restore-Cursor $cursor
    }
    if ($WindowHandle -gt 0 -and -not (Wait-WindowVisible $true)) {
        if (-not $AllowMouseFallback) {
            throw 'The tray icon activation did not show the Maestro window'
        }
        $method = 'mouse'
        $cursor = Click-Icon $surface.icon 'Left' $surface.container
        Start-Sleep -Milliseconds 200
        Restore-Cursor $cursor
        if (-not (Wait-WindowVisible $true)) {
            throw 'The tray icon click did not show the Maestro window'
        }
    }
    @{ action = 'Click'; invoked = $true; method = $method; idle = $script:desktopIdle } | ConvertTo-Json -Compress
    return
}

if ($Action -eq 'InspectMenu') {
    $opened = Open-TrayMenu
    try {
        $items = $opened.menu.FindAll($descendants, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object {
            @{
                name = $_.Current.Name
                controlType = $_.Current.ControlType.ProgrammaticName
                automationId = $_.Current.AutomationId
                offscreen = $_.Current.IsOffscreen
            }
        }
        @{ bounds = $opened.menu.Current.BoundingRectangle; items = @($items); method = $opened.method; idle = $script:desktopIdle } | ConvertTo-Json -Depth 4 -Compress
    } finally {
        Dismiss-OurMenu $opened.menu
        Restore-Cursor $opened.cursor
    }
    return
}

$selection = if ($Action -eq 'Open') { 1 } else { 0 }
$opened = $null
$attempt = 0
$lastError = $null
while ($attempt -lt 3 -and $null -eq $opened) {
    $attempt += 1
    $candidate = Open-TrayMenu
    try {
        if ($ScreenshotPath -and -not $script:screenshotTaken) {
            Save-MenuScreenshot $candidate.menu
            $script:screenshotTaken = $true
        }
        if ($selection -gt 0) {
            Select-MenuItem $candidate.menu $selection
        } else {
            # The &Quit mnemonic activates the item regardless of the recent-file count.
            if (-not (Test-MenuKeyTarget $candidate.menu)) {
                throw 'The tray menu lost focus before selecting Quit'
            }
            Send-Key 0x51
        }
        $opened = $candidate
    } catch {
        $lastError = $_
        Dismiss-OurMenu $candidate.menu
        Restore-Cursor $candidate.cursor
        Start-Sleep -Milliseconds 300
    }
}
if ($null -eq $opened) {
    throw "The tray menu selection failed after three attempts: $lastError"
}
if ($Action -eq 'Open' -and $WindowHandle -gt 0) {
    if (Wait-WindowVisible $true) {
        @{ action = $Action; invoked = $true; selection = $selection; method = $opened.method; attempts = $attempt; idle = $script:desktopIdle } | ConvertTo-Json -Compress
        return
    }
    throw 'The tray Open item did not show the Maestro window'
}
@{ action = $Action; invoked = $true; selection = $selection; method = $opened.method; attempts = $attempt; idle = $script:desktopIdle } | ConvertTo-Json -Compress
