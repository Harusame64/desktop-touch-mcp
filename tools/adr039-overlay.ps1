# ADR-039 spike fixture — a transparent full-screen overlay in its OWN process.
#
# Reproduces the DDPM `EAWorkWindow` observation without the Dell hardware
# (ADR-039 §12.0 M-10): the window covers every rectangle on screen, yet the
# input stack looks straight through it.
#
#   WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST   (no WS_EX_TRANSPARENT —
#   the bit is deliberately absent, because the real overlay does not set it
#   either and filtering on it was already falsified, ADR-039 §3)
#   SetLayeredWindowAttributes(alpha = 0, LWA_ALPHA)
#
# Stays up until the file named by -StopFile appears, so the harness can take
# it down without killing a process by name.
param(
    [Parameter(Mandatory = $true)][string]$StopFile,
    [string]$Title = "SyntheticOverlay"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Ov {
  [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int index, int val);
}
'@

$GWL_EXSTYLE       = -20
$WS_EX_LAYERED     = 0x00080000
$WS_EX_TOOLWINDOW  = 0x00000080
$WS_EX_TOPMOST     = 0x00000008
# WS_EX_NOACTIVATE: the overlay must not take the foreground. A real monitor
# overlay does not steal focus, and if the fixture does, the first click under
# it only re-activates the window below and the menu never opens — which reads
# as "the click did not land" when the truth is "the fixture stole the focus".
$WS_EX_NOACTIVATE  = 0x08000000
$LWA_ALPHA         = 0x00000002

$form                 = New-Object System.Windows.Forms.Form
$form.Text            = $Title
$form.FormBorderStyle = 'None'
$form.ShowInTaskbar   = $false
$form.TopMost         = $true
$form.StartPosition   = 'Manual'
$area                 = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$form.Location        = New-Object System.Drawing.Point($area.X, $area.Y)
$form.Size            = New-Object System.Drawing.Size($area.Width, $area.Height)
$form.BackColor       = [System.Drawing.Color]::Black

$form.Add_Shown({
    $h = $form.Handle
    $ex = [Ov]::GetWindowLong($h, $GWL_EXSTYLE)
    [void][Ov]::SetWindowLong($h, $GWL_EXSTYLE, $ex -bor $WS_EX_LAYERED -bor $WS_EX_TOOLWINDOW -bor $WS_EX_TOPMOST -bor $WS_EX_NOACTIVATE)
    [void][Ov]::SetLayeredWindowAttributes($h, 0, 0, $LWA_ALPHA)   # alpha 0 = fully transparent
    Write-Host ("OVERLAY_HWND={0}" -f $h.ToInt64())
    Write-Host ("OVERLAY_RECT={0},{1},{2},{3}" -f $area.X, $area.Y, $area.Width, $area.Height)
})

# StopFile が現れたら畳む
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 300
$timer.Add_Tick({ if (Test-Path $StopFile) { $timer.Stop(); $form.Close() } })
$timer.Start()

[void]$form.ShowDialog()
