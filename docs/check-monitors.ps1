Add-Type -AssemblyName System.Windows.Forms

Write-Output "=== System.Windows.Forms.Screen ==="
$screens = [System.Windows.Forms.Screen]::AllScreens
Write-Output ("Monitor count: " + $screens.Count)
Write-Output ""

foreach ($s in $screens) {
    Write-Output ("--- " + $s.DeviceName + " ---")
    Write-Output ("  Primary: " + $s.Primary)
    Write-Output ("  Bounds: " + $s.Bounds.X + "," + $s.Bounds.Y + " " + $s.Bounds.Width + "x" + $s.Bounds.Height)
    Write-Output ("  WorkingArea: " + $s.WorkingArea.X + "," + $s.WorkingArea.Y + " " + $s.WorkingArea.Width + "x" + $s.WorkingArea.Height)
    Write-Output ("  BitsPerPixel: " + $s.BitsPerPixel)
}

Write-Output ""
Write-Output "=== Virtual Screen (all monitors combined) ==="
Write-Output ("  X: " + [System.Windows.Forms.SystemInformation]::VirtualScreen.X)
Write-Output ("  Y: " + [System.Windows.Forms.SystemInformation]::VirtualScreen.Y)
Write-Output ("  Width: " + [System.Windows.Forms.SystemInformation]::VirtualScreen.Width)
Write-Output ("  Height: " + [System.Windows.Forms.SystemInformation]::VirtualScreen.Height)

Write-Output ""
Write-Output "=== WMI Win32_DesktopMonitor ==="
Get-CimInstance -ClassName Win32_DesktopMonitor | ForEach-Object {
    Write-Output ("  Name: " + $_.Name + " Status: " + $_.Status)
}

Write-Output ""
Write-Output "=== DPI / Scaling ==="
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DpiHelper {
    [DllImport("user32.dll")]
    public static extern int GetDpiForSystem();
    [DllImport("shcore.dll")]
    public static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);
}
"@
$sysDpi = [DpiHelper]::GetDpiForSystem()
Write-Output ("  System DPI: " + $sysDpi + " (scale: " + [math]::Round($sysDpi / 96 * 100) + "%)")
