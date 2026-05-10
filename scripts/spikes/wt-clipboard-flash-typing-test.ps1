# wt-clipboard-flash-typing-test.ps1
#
# Spike: Option E (Clipboard + foreground flash) の **user typing 干渉計測**
#
# 前提: docs/wt-bg-spike-round2-findings.md §3.F-3 で Option E light evaluation GO 済。
#       本 spike は production 化前必須の追加検証 (心配 1 = user typing 中干渉)。
#
# 計測内容: flash 50ms 中に user が他 app で typing 中だった場合の挙動。
#   - background runspace で 150ms 間 5ms interval で 'X' を keybd_event burst (= user typing simulation)
#   - 同時に main thread で Option E flash 1 回実行
#   - 計測:
#     1. WT pane buffer に sentinel が届くか
#     2. WT pane に 'X' が紛れ込むか (user data の漏出 = NG)
#     3. notepad に Ctrl+V / Enter / 残りの 'X' が漏れるか (data leak = NG)
#
# Safety: controlled WT + controlled notepad のみ操作、user 既存 process には触らない。
#         keystroke simulation は global SendInput だが flash period のみ controlled
#         scope 内で発火。実行中は user は他 window 操作しないこと推奨。
#
# Spike scope (PR/Opus review skip、commit ベース)。

[CmdletBinding()]
param(
    [int]$Iterations = 5,
    [int]$LaunchSettleMs = 1500,
    [int]$ReadbackDelayMs = 800,
    [int]$TypingDurationMs = 150,
    [int]$TypingIntervalMs = 5
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

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public KEYBDINPUT ki;
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
    public const ushort VK_X = 0x58;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint MapVirtualKey(uint uCode, uint uMapType);

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

    public static uint TypeChar(ushort vk) {
        var inputs = new INPUT[2];
        inputs[0] = MkKey(vk, false);
        inputs[1] = MkKey(vk, true);
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
    }

    private static INPUT MkKey(ushort vk, bool isUp) {
        var scan = MapVirtualKey(vk, 0);
        return new INPUT {
            type = INPUT_KEYBOARD,
            ki = new KEYBDINPUT {
                wVk = vk,
                wScan = (ushort)scan,
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
# Setup
# ─────────────────────────────────────────────────────────────────────────────

$wtName = "spike-typing-$([guid]::NewGuid().ToString('N').Substring(0,6))"
$titleTag = "DTM_TYPING_$([guid]::NewGuid().ToString('N').Substring(0,8))"

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

Write-Host "[setup-3/3] Open notepad + locate UIA edit element ..." -ForegroundColor Cyan
$np = Start-Process notepad.exe -PassThru
Start-Sleep -Milliseconds 1000

# Save user clipboard
$origClipboard = $null
try { $origClipboard = [System.Windows.Forms.Clipboard]::GetText() } catch {}

# Locate notepad window + edit element via UIA
function Get-NotepadEditElement {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($w in $wins) {
        if ($w.Current.Name -match 'メモ帳|Notepad') {
            $els = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($e in $els) {
                try {
                    if ($e.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -or $e.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) {
                        $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                        if ($vp -ne $null) { return @{ window = $w; edit = $e; vp = $vp } }
                    }
                } catch {}
            }
            # fallback: any TextPattern
            foreach ($e in $els) {
                try {
                    $tp = $e.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
                    if ($tp -ne $null -and $e.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) { return @{ window = $w; edit = $e; vp = $null } }
                } catch {}
            }
        }
    }
    return $null
}

$npInfo = Get-NotepadEditElement
if (-not $npInfo) { Write-Host "  Could not locate notepad edit element via UIA" -ForegroundColor Yellow }
else { Write-Host "  notepad edit element ControlType = $($npInfo.edit.Current.ControlType.ProgrammaticName)" -ForegroundColor Gray }

function Get-NotepadText {
    if (-not $npInfo) { return '' }
    try {
        if ($npInfo.vp -ne $null) { return $npInfo.vp.Current.Value }
        $tp = $npInfo.edit.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
        if ($tp -ne $null) { return $tp.DocumentRange.GetText(-1) }
    } catch {}
    return ''
}

# ─────────────────────────────────────────────────────────────────────────────
# Iteration loop — main-thread interleave (flash 中 X burst → 復帰 → flash 後 X burst)
# 計測軸:
#   - WT に X が漏れる = flash 中 user typing が WT に流れる (NG)
#   - notepad に X が入る = flash 後 foreground 復帰 working (= baseline GOOD)
#   - notepad に sentinel/Enter 漏れ = Ctrl+V/Enter が notepad で発火 (NG)
# ─────────────────────────────────────────────────────────────────────────────

$results = @()
$typingDuringFlash = [Math]::Max(1, [Math]::Floor($TypingDurationMs / $TypingIntervalMs / 2))   # flash 期間相当
$typingAfterFlash  = [Math]::Max(1, [Math]::Floor($TypingDurationMs / $TypingIntervalMs / 2))   # flash 後 baseline

for ($i = 1; $i -le $Iterations; $i++) {
    Write-Host "`n[iter $i/$Iterations] ---------" -ForegroundColor Magenta

    # Clear notepad text + focus
    [void][FlashApi]::SetForegroundWindow($np.MainWindowHandle)
    Start-Sleep -Milliseconds 300
    if ($npInfo -and $npInfo.vp) { try { $npInfo.vp.SetValue('') } catch {} }
    Start-Sleep -Milliseconds 200

    $sentinel = "__DTM_TYP_$([guid]::NewGuid().ToString('N').Substring(0,12))__"
    $beforeFg = [FlashApi]::GetForegroundWindow()
    [System.Windows.Forms.Clipboard]::SetText($sentinel)

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    [void][FlashApi]::AllowSetForegroundWindow([uint32]$wtPid)
    [void][FlashApi]::SetForegroundWindow($wtHwnd)
    Start-Sleep -Milliseconds 30   # WT focus ready
    [FlashApi]::SendCtrlVEnter() | Out-Null
    # ── flash 期間中の user typing simulation (foreground = WT のはず) ──
    $xDuringFlash = 0
    $xDuringInjected = 0
    for ($k = 0; $k -lt $typingDuringFlash; $k++) {
        $r = [FlashApi]::TypeChar([FlashApi]::VK_X)
        if ($r -eq 2) { $xDuringInjected++ }
        $xDuringFlash++
        Start-Sleep -Milliseconds $TypingIntervalMs
    }
    # Flush any pending input by pressing Enter (= committed to terminal buffer)
    [FlashApi]::TypeChar([FlashApi]::VK_RETURN) | Out-Null
    [void][FlashApi]::SetForegroundWindow($beforeFg)
    $sw.Stop()
    $flashMs = $sw.Elapsed.TotalMilliseconds

    # ── flash 後 baseline: foreground 復帰したら X が notepad に入るはず ──
    Start-Sleep -Milliseconds 30  # foreground 復帰 settle
    $xAfterFlash = 0
    $xAfterInjected = 0
    for ($k = 0; $k -lt $typingAfterFlash; $k++) {
        $r = [FlashApi]::TypeChar([FlashApi]::VK_X)
        if ($r -eq 2) { $xAfterInjected++ }
        $xAfterFlash++
        Start-Sleep -Milliseconds $TypingIntervalMs
    }
    $typedCount = $xDuringFlash + $xAfterFlash

    Start-Sleep -Milliseconds $ReadbackDelayMs

    # Verify WT buffer
    $wtSentinel = $false
    $wtXCount = 0
    $wtFullText = ''
    $els = $wt.FindAll([System.Windows.Automation.TreeScope]::Descendants, $trueC)
    foreach ($el in $els) {
        try {
            $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
            if ($null -ne $tp) {
                $txt = ''
                try { $txt = $tp.DocumentRange.GetText(-1) } catch { continue }
                if ($txt -like "*$sentinel*") {
                    $wtSentinel = $true
                    $wtFullText = $txt
                    # Count consecutive X{3,} sequences in entire WT buffer (= typing burst signature)
                    $matches = [regex]::Matches($txt, 'X{3,}')
                    foreach ($m in $matches) { $wtXCount += $m.Length }
                    break
                }
            }
        } catch {}
    }

    # Verify notepad text
    Start-Sleep -Milliseconds 200
    $npText = Get-NotepadText
    $npXCount = ([regex]::Matches($npText, 'X')).Count
    $npHasSentinel = ($npText -like "*$sentinel*")
    $npHasNewline = ($npText -match "[\r\n]")

    $results += [PSCustomObject]@{
        iter            = $i
        sentinel        = $sentinel
        flash_ms        = [Math]::Round($flashMs, 1)
        x_during_attempts  = $xDuringFlash
        x_during_injected  = $xDuringInjected
        x_after_attempts   = $xAfterFlash
        x_after_injected   = $xAfterInjected
        wt_sentinel     = $wtSentinel
        wt_x_count      = $wtXCount
        notepad_x_count = $npXCount
        notepad_has_sentinel = $npHasSentinel
        notepad_has_newline = $npHasNewline
        notepad_text_sample = if ($npText.Length -gt 80) { $npText.Substring(0, 80) + '...' } else { $npText }
        wt_text_tail = if ($wtFullText.Length -gt 200) { $wtFullText.Substring($wtFullText.Length - 200) } else { $wtFullText }
    }
    Write-Host "  flash $($results[-1].flash_ms)ms / X_inj during=$xDuringInjected/$xDuringFlash after=$xAfterInjected/$xAfterFlash / WT_sentinel=$wtSentinel / WT_X=$wtXCount / NP_X=$npXCount / NP_paste_leak=$npHasSentinel / NP_newline=$npHasNewline" -ForegroundColor Gray
}

# ─────────────────────────────────────────────────────────────────────────────
# Restore + Cleanup
# ─────────────────────────────────────────────────────────────────────────────

Write-Host "`n[cleanup-1/2] Restore clipboard ..." -ForegroundColor Cyan
try {
    if ($origClipboard) { [System.Windows.Forms.Clipboard]::SetText($origClipboard) }
    else { [System.Windows.Forms.Clipboard]::Clear() }
} catch {}

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
$wtSentinelHit = ($results | Where-Object { $_.wt_sentinel }).Count
$wtXLeak = ($results | Where-Object { $_.wt_x_after_sentinel -gt 0 }).Count
$npPasteLeak = ($results | Where-Object { $_.notepad_has_sentinel }).Count
$npNewlineLeak = ($results | Where-Object { $_.notepad_has_newline }).Count

[PSCustomObject]@{
    iterations             = $Iterations
    wt_sentinel_hit_rate   = "$wtSentinelHit / $Iterations"
    wt_x_leak_iters        = "$wtXLeak / $Iterations (WT に user typing 漏れ)"
    notepad_paste_leak     = "$npPasteLeak / $Iterations (notepad に sentinel 漏れ = data leak)"
    notepad_newline_leak   = "$npNewlineLeak / $Iterations (notepad で Enter 発火)"
    typing_simulation_per_iter = ($results | Measure-Object typed_count -Average).Average
    iterations_detail      = $results
} | ConvertTo-Json -Depth 6
