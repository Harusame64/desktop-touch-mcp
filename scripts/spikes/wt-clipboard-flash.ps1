# wt-clipboard-flash.ps1
#
# Spike: Option E (Clipboard + foreground flash) for issue #185 / ADR-013 alternative.
#
# Goal: foreground を 50-100ms 程度 flash で奪い、Ctrl+V + Enter で WT active pane
#       に sentinel を inject、元 hwnd を復帰。BG ではなく "妥協 BG"、Win11
#       SetForegroundWindow restriction を AllowSetForegroundWindow で回避。
#
# 計測項目 (5 iteration sequential):
#   - flash duration (Stopwatch ms): SetForegroundWindow → 元 hwnd 復帰までの実時間
#   - sentinel observed in WT buffer: UIA TextPattern 読戻しで verify
#   - clipboard restore success: 元 clipboard text が復元されたか
#   - serialize 確認: 並列ではなく sequential であることの単純な検証
#
# Spike scope, 結果は docs/wt-bg-spike-round2-findings.md §4 と統合。

[CmdletBinding()]
param(
    [int]$Iterations = 5,
    [int]$LaunchSettleMs = 1500,
    [int]$ReadbackDelayMs = 800,
    [int]$RestoreFlashAfterMs = 0
)

$ErrorActionPreference = 'Stop'

$signature = @'
using System;
using System.Runtime.InteropServices;

public static class FlashApi {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool AllowSetForegroundWindow(uint dwProcessId);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    // INPUT struct must match Win32 layout (variant union)
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public KEYBDINPUT ki;
        // Pad to 32 bytes total (matches union size on x64; minimum needed for keyboard event)
        public uint pad1;
        public uint pad2;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const ushort VK_CONTROL = 0x11;
    public const ushort VK_V = 0x56;
    public const ushort VK_RETURN = 0x0D;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    public static uint SendCtrlVEnter() {
        var inputs = new INPUT[6];
        inputs[0] = MkKey(VK_CONTROL, false);
        inputs[1] = MkKey(VK_V, false);
        inputs[2] = MkKey(VK_V, true);
        inputs[3] = MkKey(VK_CONTROL, true);
        inputs[4] = MkKey(VK_RETURN, false);
        inputs[5] = MkKey(VK_RETURN, true);
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
    }

    private static INPUT MkKey(ushort vk, bool isUp) {
        return new INPUT {
            type = INPUT_KEYBOARD,
            ki = new KEYBDINPUT {
                wVk = vk,
                wScan = 0,
                dwFlags = isUp ? KEYEVENTF_KEYUP : 0u,
                time = 0,
                dwExtraInfo = IntPtr.Zero
            }
        };
    }
}
'@
Add-Type -TypeDefinition $signature -Language CSharp

Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

# ─────────────────────────────────────────────────────────────────────────────
# Setup: launch controlled WT + notepad
# ─────────────────────────────────────────────────────────────────────────────

$wtName = "spike-flash-$([guid]::NewGuid().ToString('N').Substring(0,6))"
$titleTag = "DTM_FLASH_$([guid]::NewGuid().ToString('N').Substring(0,8))"

Write-Host "[setup-1/3] Launch controlled WT (-w $wtName) ..." -ForegroundColor Cyan
Start-Process wt.exe -ArgumentList @('-w', $wtName, 'new-tab', '--title', $titleTag, '--', 'powershell.exe', '-NoLogo', '-NoExit')
Start-Sleep -Milliseconds $LaunchSettleMs

Write-Host "[setup-2/3] Locate WT window + PID ..." -ForegroundColor Cyan
$root = [System.Windows.Automation.AutomationElement]::RootElement
$trueC = [System.Windows.Automation.Condition]::TrueCondition
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
$wt = $null
foreach ($w in $wins) { if ($w.Current.Name -like "*$titleTag*") { $wt = $w; break } }
if (-not $wt) { Write-Error "WT window not found"; exit 1 }
$wtHwnd = [IntPtr]$wt.Current.NativeWindowHandle
[uint32]$wtPid = 0
[void][FlashApi]::GetWindowThreadProcessId($wtHwnd, [ref]$wtPid)
Write-Host "  WT HWND = 0x$($wtHwnd.ToInt64().ToString('X8'))  PID = $wtPid" -ForegroundColor Gray

Write-Host "[setup-3/3] Open notepad and focus it ..." -ForegroundColor Cyan
$np = Start-Process notepad.exe -PassThru
Start-Sleep -Milliseconds 800

# Save user clipboard text (notes: only text payload supported in spike)
$origClipboard = $null
try { $origClipboard = [System.Windows.Forms.Clipboard]::GetText() } catch {}
Write-Host "  saved original clipboard text length: $($origClipboard.Length)" -ForegroundColor Gray

# ─────────────────────────────────────────────────────────────────────────────
# Iteration loop
# ─────────────────────────────────────────────────────────────────────────────

$results = @()
for ($i = 1; $i -le $Iterations; $i++) {
    Write-Host "`n[iter $i/$Iterations] -----------------------" -ForegroundColor Magenta

    # Re-focus notepad to ensure clean baseline (in case prior iteration left WT focused)
    [void][FlashApi]::SetForegroundWindow($np.MainWindowHandle)
    Start-Sleep -Milliseconds 300

    $sentinel = "__DTM_FLASH_$([guid]::NewGuid().ToString('N').Substring(0,12))__"
    $beforeFg = [FlashApi]::GetForegroundWindow()
    Write-Host "  before flash: foreground hwnd = 0x$($beforeFg.ToInt64().ToString('X8'))" -ForegroundColor Gray

    # Set clipboard
    [System.Windows.Forms.Clipboard]::SetText($sentinel)

    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    # Win11 restriction bypass
    [void][FlashApi]::AllowSetForegroundWindow([uint32]$wtPid)
    # Steal foreground
    $sfwResult = [FlashApi]::SetForegroundWindow($wtHwnd)
    Start-Sleep -Milliseconds 30  # WT が focus を得て input ready になるまで小 sleep
    # Send Ctrl+V Enter
    $sentN = [FlashApi]::SendCtrlVEnter()
    Start-Sleep -Milliseconds $RestoreFlashAfterMs
    # Restore original foreground
    $restoreResult = [FlashApi]::SetForegroundWindow($beforeFg)

    $sw.Stop()
    $flashMs = $sw.Elapsed.TotalMilliseconds

    Start-Sleep -Milliseconds $ReadbackDelayMs

    # Verify sentinel reached WT buffer via UIA TextPattern
    $sentinelFound = $false
    $els = $wt.FindAll([System.Windows.Automation.TreeScope]::Descendants, $trueC)
    foreach ($el in $els) {
        try {
            $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
            if ($null -ne $tp) {
                $txt = ''
                try { $txt = $tp.DocumentRange.GetText(-1) } catch { continue }
                if ($txt -like "*$sentinel*") { $sentinelFound = $true; break }
            }
        } catch {}
    }

    # Verify foreground returned to notepad
    $afterFg = [FlashApi]::GetForegroundWindow()
    $foregroundReturned = ($afterFg -eq $beforeFg)

    # Verify clipboard could be read back (we only wrote sentinel, restoration is end-of-run)
    $clipNow = ''
    try { $clipNow = [System.Windows.Forms.Clipboard]::GetText() } catch {}

    $iterResult = [PSCustomObject]@{
        iter                 = $i
        sentinel             = $sentinel
        sfw_returned_true    = $sfwResult
        sendinput_count      = $sentN
        restore_returned_true= $restoreResult
        flash_duration_ms    = [Math]::Round($flashMs, 1)
        sentinel_found       = $sentinelFound
        foreground_returned  = $foregroundReturned
        clipboard_now_eq_sentinel = ($clipNow -eq $sentinel)
        before_hwnd          = ('0x{0:X8}' -f $beforeFg.ToInt64())
        after_hwnd           = ('0x{0:X8}' -f $afterFg.ToInt64())
    }
    $results += $iterResult
    Write-Host "  flash: $($iterResult.flash_duration_ms) ms  sentinel_found: $($iterResult.sentinel_found)  fg_returned: $($iterResult.foreground_returned)" -ForegroundColor Gray
}

# ─────────────────────────────────────────────────────────────────────────────
# Restore clipboard + cleanup
# ─────────────────────────────────────────────────────────────────────────────

Write-Host "`n[cleanup-1/2] Restore original clipboard ..." -ForegroundColor Cyan
$clipRestoreOk = $false
try {
    if ($origClipboard) { [System.Windows.Forms.Clipboard]::SetText($origClipboard); $clipRestoreOk = $true }
    else { [System.Windows.Forms.Clipboard]::Clear(); $clipRestoreOk = $true }
} catch { Write-Host "  clipboard restore failed: $_" -ForegroundColor Yellow }

Write-Host "[cleanup-2/2] Kill notepad + spike WT ..." -ForegroundColor Cyan
try { Stop-Process -Id $np.Id -Force -ErrorAction SilentlyContinue } catch {}
Get-Process -Name 'WindowsTerminal','OpenConsole','powershell','pwsh' -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
        if ($cmdLine -like "*$wtName*" -or $cmdLine -like "*$titleTag*") {
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────

Write-Host "`n=== Summary ===" -ForegroundColor Magenta
$flashStats = $results.flash_duration_ms | Measure-Object -Average -Maximum -Minimum
$sentinelHits = ($results | Where-Object { $_.sentinel_found }).Count
$fgReturned = ($results | Where-Object { $_.foreground_returned }).Count

[PSCustomObject]@{
    iterations            = $Iterations
    flash_ms_min          = [Math]::Round($flashStats.Minimum, 1)
    flash_ms_avg          = [Math]::Round($flashStats.Average, 1)
    flash_ms_max          = [Math]::Round($flashStats.Maximum, 1)
    sentinel_hit_rate     = "$sentinelHits / $Iterations"
    foreground_return_rate= "$fgReturned / $Iterations"
    clipboard_restore_ok  = $clipRestoreOk
    iterations_detail     = $results
} | ConvertTo-Json -Depth 6
