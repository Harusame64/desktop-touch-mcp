# wt-attachconsole-orchestrator.ps1
#
# Spike orchestrator for issue #185 / Phase 0 m13v community proposal.
# Pipeline:
#   1. Mode selection (conhost-baseline | wt-controlled)
#   2. Launch a controlled target shell + assign unique sentinel
#   3. Resolve candidate PIDs (target shell PID + descendants)
#   4. For each candidate PID + KeyEncoding, invoke helper as a child PS
#      process (Start-Process so its console state is isolated)
#   5. Read helper's JSON result file
#   6. Read the target shell's visible buffer via UIA TextPattern,
#      check whether the sentinel substring landed
#   7. Stop-Process the controlled launch (Spike Safety §"Always cleanup")
#   8. Print a single-line summary table row + machine-readable JSON tail
#
# This script does NOT modify production code. It only orchestrates the
# helper script + target shell. Designed to be re-runnable.
#
# Usage:
#   .\scripts\spikes\wt-attachconsole-orchestrator.ps1 -Mode conhost-baseline
#   .\scripts\spikes\wt-attachconsole-orchestrator.ps1 -Mode wt-controlled
#   .\scripts\spikes\wt-attachconsole-orchestrator.ps1 -Mode conhost-baseline -KeyEncoding keydown
#
# Output:
#   - Human-readable progress to stdout
#   - JSON summary block at end (parseable for the docs/wt-attachconsole-spike-results.md test matrix)
#
# Safety: only launches its own controlled processes; never targets a
# user's pre-existing terminal. Cleanup is best-effort.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('conhost-baseline', 'wt-controlled')]
    [string]$Mode,

    [ValidateSet('keydown', 'keydown_keyup')]
    [string]$KeyEncoding = 'keydown_keyup',

    [int]$ReadbackDelayMs = 600,

    [int]$LaunchSettleMs = 800
)

$ErrorActionPreference = 'Stop'

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$helperPath = Join-Path $scriptRoot 'wt-attachconsole-helper.ps1'

if (-not (Test-Path -LiteralPath $helperPath)) {
    Write-Error "Helper not found at: $helperPath"
    exit 2
}

function New-Sentinel {
    $guid = [guid]::NewGuid().ToString('N').Substring(0, 12)
    return "__DTM_SPIKE_${guid}__"
}

function Get-WindowTextViaUia {
    param([string]$WindowTitleSubstring)
    Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue

    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $trueC = [System.Windows.Automation.Condition]::TrueCondition
    $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
    $target = $null
    foreach ($w in $children) {
        if ($w.Current.Name -like "*$WindowTitleSubstring*") { $target = $w; break }
    }
    if (-not $target) { return @{ ok = $false; error = 'window not found'; text = '' } }

    $desc = [System.Windows.Automation.TreeScope]::Descendants
    $all = $target.FindAll($desc, $trueC)

    $bestText = ''
    $bestLen = -1
    foreach ($el in $all) {
        try {
            $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
            if ($null -ne $tp) {
                $txt = ''
                try { $txt = $tp.DocumentRange.GetText(-1) } catch { continue }
                if ($null -eq $txt) { $txt = '' }
                if ($txt.Length -gt $bestLen) {
                    $bestText = $txt
                    $bestLen = $txt.Length
                }
            }
        } catch {}
    }
    return @{ ok = $true; text = $bestText; length = $bestLen }
}

function Invoke-Helper {
    param(
        [int]$TargetPid,
        [string]$Sentinel,
        [string]$KeyEncoding
    )
    $resultFile = [System.IO.Path]::GetTempFileName()
    Remove-Item -LiteralPath $resultFile -ErrorAction SilentlyContinue
    $stdoutFile = [System.IO.Path]::GetTempFileName()
    $stderrFile = [System.IO.Path]::GetTempFileName()
    # Spawn helper as child PS so its console state is isolated.
    # -WindowStyle Hidden gives the child a fresh hidden console; FreeConsole()
    # in the helper detaches that, AttachConsole(target) attaches to target's.
    #
    # Use ProcessStartInfo.ArgumentList (per-arg list with proper escaping)
    # instead of Start-Process -ArgumentList @(...) which joins with spaces
    # and breaks args containing spaces (e.g. "echo __DTM_SPIKE_xxx__"). The
    # earlier failure mode was: helper received `-Sentinel echo` + positional
    # `__DTM_SPIKE_xxx__` and bombed with "positional parameter cannot be found".
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = 'pwsh.exe'
    foreach ($a in @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', $helperPath,
        '-TargetPid', "$TargetPid",
        '-Sentinel', $Sentinel,
        '-ResultFile', $resultFile,
        '-KeyEncoding', $KeyEncoding
    )) { $psi.ArgumentList.Add($a) }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdoutContent = $proc.StandardOutput.ReadToEnd()
    $stderrContent = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    $exit = $proc.ExitCode
    # stdout/stderr already captured directly via ReadToEnd above.
    if (-not $stdoutContent) { $stdoutContent = '' }
    if (-not $stderrContent) { $stderrContent = '' }
    Remove-Item -LiteralPath $stdoutFile, $stderrFile -ErrorAction SilentlyContinue

    if (-not (Test-Path -LiteralPath $resultFile)) {
        return @{
            ok = $false
            step = 'helper did not write result file'
            helper_exit = $exit
            helper_stdout = $stdoutContent
            helper_stderr = $stderrContent
        }
    }
    $json = Get-Content -LiteralPath $resultFile -Raw -Encoding utf8
    Remove-Item -LiteralPath $resultFile -ErrorAction SilentlyContinue
    try {
        $obj = $json | ConvertFrom-Json -AsHashtable
        $obj.helper_exit = $exit
        if ($stderrContent) { $obj.helper_stderr = $stderrContent }
        return $obj
    } catch {
        return @{
            ok = $false
            step = 'helper JSON parse failed'
            helper_exit = $exit
            raw = $json
            helper_stdout = $stdoutContent
            helper_stderr = $stderrContent
        }
    }
}

function Stop-ProcessTreeSafe {
    param([int]$Id)
    try {
        Stop-Process -Id $Id -Force -ErrorAction SilentlyContinue
    } catch {}
}

# ─────────────────────────────────────────────────────────────────────────────
# Mode: conhost-baseline
# Launch `conhost.exe cmd.exe /K title DTM_SPIKE_BASELINE_<guid>` to FORCE
# legacy conhost host (Win11 default may otherwise route cmd.exe into WT).
# Send sentinel via helper, verify via UIA TextPattern read-back of the
# conhost window.
# ─────────────────────────────────────────────────────────────────────────────

function Invoke-ConhostBaseline {
    $sentinel = New-Sentinel
    $titleTag = "DTM_SPIKE_BASELINE_$([guid]::NewGuid().ToString('N').Substring(0,8))"

    Write-Host "[1/6] Launching controlled cmd.exe in conhost (title=$titleTag) ..." -ForegroundColor Cyan
    # Force legacy conhost by invoking conhost.exe directly. On Win11 cmd.exe
    # typically routes to WT when Start-Process'd plain — conhost.exe wraps it
    # explicitly in legacy conhost.
    $proc = Start-Process -FilePath 'conhost.exe' -ArgumentList @(
        'cmd.exe', '/K', "title $titleTag"
    ) -PassThru -WindowStyle Normal
    Start-Sleep -Milliseconds $LaunchSettleMs

    if ($proc.HasExited) {
        Write-Host "  Launch failed: process exited immediately (code=$($proc.ExitCode))" -ForegroundColor Red
        return @{ mode = 'conhost-baseline'; ok = $false; step = 'launch'; helper_exit = -1 }
    }

    # The cmd.exe we want is a CHILD of the launched conhost.exe (not the conhost itself)
    Write-Host "[2/6] Resolving candidate cmd.exe PID under conhost(pid=$($proc.Id)) ..." -ForegroundColor Cyan
    $cmdProc = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($proc.Id) AND Name='cmd.exe'" -ErrorAction SilentlyContinue
    if (-not $cmdProc) {
        # Fallback: maybe Start-Process wrapped differently — find any cmd.exe with our title
        Start-Sleep -Milliseconds 300
        $allCmd = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue
        $cmdProc = $allCmd | Where-Object { $_.CommandLine -like "*$titleTag*" } | Select-Object -First 1
    }
    if (-not $cmdProc) {
        Stop-ProcessTreeSafe -Id $proc.Id
        Write-Host "  Could not resolve cmd.exe PID for $titleTag" -ForegroundColor Red
        return @{ mode = 'conhost-baseline'; ok = $false; step = 'pid_resolve'; helper_exit = -1 }
    }
    $targetPid = [int]$cmdProc.ProcessId
    Write-Host "  cmd.exe PID = $targetPid (parent conhost = $($proc.Id))" -ForegroundColor Gray

    Write-Host "[3/6] Invoking helper (sentinel='$sentinel', encoding=$KeyEncoding) ..." -ForegroundColor Cyan
    $sentinelCmd = "echo $sentinel"
    $helperResult = Invoke-Helper -TargetPid $targetPid -Sentinel $sentinelCmd -KeyEncoding $KeyEncoding

    Write-Host "  helper.ok      = $($helperResult.ok)" -ForegroundColor Gray
    Write-Host "  helper.step    = $($helperResult.step)" -ForegroundColor Gray
    Write-Host "  win32_error    = $($helperResult.win32_error_hex)" -ForegroundColor Gray
    Write-Host "  records w/a    = $($helperResult.records_written) / $($helperResult.records_attempted)" -ForegroundColor Gray
    Write-Host "  attached_pids  = $($helperResult.attached_pids -join ',')" -ForegroundColor Gray

    Write-Host "[4/6] Sleeping ${ReadbackDelayMs}ms for shell to render echo output ..." -ForegroundColor Cyan
    Start-Sleep -Milliseconds $ReadbackDelayMs

    Write-Host "[5/6] Reading conhost window buffer via UIA TextPattern ..." -ForegroundColor Cyan
    $readback = Get-WindowTextViaUia -WindowTitleSubstring $titleTag
    $observed = $false
    $sentinelFound = $false
    if ($readback.ok) {
        $observed = $true
        $sentinelFound = $readback.text -like "*$sentinel*"
        Write-Host "  buffer length  = $($readback.length)" -ForegroundColor Gray
        $sentinelColor = if ($sentinelFound) { 'Green' } else { 'Yellow' }
        Write-Host "  sentinel hit   = $sentinelFound" -ForegroundColor $sentinelColor
        # Dump tail of buffer for debugging when sentinel missing.
        if (-not $sentinelFound -and $readback.length -gt 0) {
            $tail = $readback.text.Substring([Math]::Max(0, $readback.text.Length - 400))
            Write-Host "  --- buffer tail (last 400 chars) ---" -ForegroundColor DarkGray
            Write-Host $tail -ForegroundColor DarkGray
            Write-Host "  --- end tail ---" -ForegroundColor DarkGray
        }
    } else {
        Write-Host "  Read-back failed: $($readback.error)" -ForegroundColor Yellow
    }

    Write-Host "[6/6] Cleanup (Stop-Process conhost pid=$($proc.Id)) ..." -ForegroundColor Cyan
    Stop-ProcessTreeSafe -Id $proc.Id
    if ($cmdProc) { Stop-ProcessTreeSafe -Id $targetPid }

    return @{
        mode = 'conhost-baseline'
        ok = ($helperResult.ok -and $sentinelFound)
        helper = $helperResult
        readback_observed = $observed
        sentinel_found = $sentinelFound
        target_pid = $targetPid
        title_tag = $titleTag
        sentinel = $sentinel
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# Mode: wt-controlled
# Launch wt.exe with a unique tab title, find the actual shell (pwsh.exe)
# under the WT process tree, send sentinel, verify via UIA read-back of
# the WT window with our unique title.
# ─────────────────────────────────────────────────────────────────────────────

function Invoke-WtControlled {
    if (-not (Get-Command 'wt.exe' -ErrorAction SilentlyContinue)) {
        Write-Host "wt.exe not found in PATH — skipping WT mode" -ForegroundColor Yellow
        return @{ mode = 'wt-controlled'; ok = $false; step = 'wt_not_installed'; helper_exit = -1 }
    }

    $sentinel = New-Sentinel
    $titleTag = "DTM-ATTACHCONSOLE-SPIKE-$([guid]::NewGuid().ToString('N').Substring(0,8))"

    Write-Host "[1/7] Launching controlled WT tab (title=$titleTag) ..." -ForegroundColor Cyan
    # Use -w <unique> so this WT window is isolated from the user's existing WT.
    $wtWindowName = "spike-$([guid]::NewGuid().ToString('N').Substring(0,6))"
    Start-Process -FilePath 'wt.exe' -ArgumentList @(
        '-w', $wtWindowName,
        'new-tab', '--title', $titleTag,
        '--', 'powershell.exe', '-NoLogo', '-NoExit'
    ) -WindowStyle Normal
    Start-Sleep -Milliseconds $LaunchSettleMs

    Write-Host "[2/7] Locating WT window by title=$titleTag ..." -ForegroundColor Cyan
    Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $trueC = [System.Windows.Automation.Condition]::TrueCondition
    $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueC)
    $wtWin = $null
    foreach ($w in $children) {
        if ($w.Current.Name -like "*$titleTag*") { $wtWin = $w; break }
    }
    if (-not $wtWin) {
        Write-Host "  WT window with title '$titleTag' not found in UIA tree" -ForegroundColor Red
        return @{ mode = 'wt-controlled'; ok = $false; step = 'wt_window_not_found'; helper_exit = -1 }
    }
    $wtHwnd = $wtWin.Current.NativeWindowHandle
    Write-Host "  WT HWND = 0x$($wtHwnd.ToString('X8'))" -ForegroundColor Gray

    Write-Host "[3/7] Enumerating candidate shell PIDs in WT process tree ..." -ForegroundColor Cyan
    # WT model: WindowsTerminal.exe spawns OpenConsole.exe, OpenConsole.exe
    # parents the actual shell (pwsh.exe / cmd.exe / wsl.exe). We enumerate
    # all WindowsTerminal.exe + OpenConsole.exe + shells with our title-tag
    # in their PowerShell window title (set via $Host.UI.RawUI.WindowTitle above).
    $allShells = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe' OR Name='cmd.exe'" -ErrorAction SilentlyContinue
    # Heuristic: filter shells whose grand-parent is WindowsTerminal.exe
    $wtPids = (Get-Process -Name WindowsTerminal -ErrorAction SilentlyContinue).Id
    $candidates = @()
    foreach ($s in $allShells) {
        try {
            $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($s.ParentProcessId)" -ErrorAction SilentlyContinue
            if ($parent -and ($parent.Name -in @('OpenConsole.exe', 'WindowsTerminal.exe'))) {
                $gp = if ($parent.Name -eq 'WindowsTerminal.exe') { $parent } else {
                    Get-CimInstance Win32_Process -Filter "ProcessId=$($parent.ParentProcessId)" -ErrorAction SilentlyContinue
                }
                if ($gp -and $gp.Name -eq 'WindowsTerminal.exe' -and $wtPids -contains $gp.ProcessId) {
                    $candidates += @{ Pid = [int]$s.ProcessId; Name = $s.Name; Started = $s.CreationDate }
                }
            }
        } catch {}
    }
    # Prefer the most recently started candidate (our spike's launch is newest)
    $candidates = $candidates | Sort-Object -Property Started -Descending
    Write-Host "  candidates (most recent first):" -ForegroundColor Gray
    foreach ($c in $candidates) {
        Write-Host "    pid=$($c.Pid) name=$($c.Name) started=$($c.Started)" -ForegroundColor Gray
    }

    if (-not $candidates -or $candidates.Count -eq 0) {
        Write-Host "  No WT-hosted shell candidates found" -ForegroundColor Red
        return @{ mode = 'wt-controlled'; ok = $false; step = 'no_candidates'; helper_exit = -1 }
    }

    # Try each candidate in order, stop on first success
    $sentinelCmd = "Write-Output `"$sentinel`""
    $attempts = @()
    $finalOk = $false
    foreach ($c in $candidates) {
        Write-Host "[4/7] Trying candidate pid=$($c.Pid) ($($c.Name)) ..." -ForegroundColor Cyan
        $helperResult = Invoke-Helper -TargetPid $c.Pid -Sentinel $sentinelCmd -KeyEncoding $KeyEncoding
        Write-Host "  helper.ok=$($helperResult.ok) win32_error=$($helperResult.win32_error_hex) attached_pids=$($helperResult.attached_pids -join ',')" -ForegroundColor Gray

        Start-Sleep -Milliseconds $ReadbackDelayMs

        # Re-read WT buffer for sentinel
        $readback = Get-WindowTextViaUia -WindowTitleSubstring $titleTag
        $sentinelFound = $false
        if ($readback.ok) {
            $sentinelFound = $readback.text -like "*$sentinel*"
        }
        $attempts += @{
            candidate_pid = $c.Pid
            candidate_name = $c.Name
            helper = $helperResult
            sentinel_found = $sentinelFound
        }
        if ($helperResult.ok -and $sentinelFound) {
            Write-Host "  [hit] sentinel observed in WT buffer" -ForegroundColor Green
            $finalOk = $true
            break
        }
    }

    Write-Host "[7/7] Cleanup ..." -ForegroundColor Cyan
    foreach ($c in $candidates) { Stop-ProcessTreeSafe -Id $c.Pid }

    return @{
        mode = 'wt-controlled'
        ok = $finalOk
        title_tag = $titleTag
        sentinel = $sentinel
        attempts = $attempts
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "=== AttachConsole spike orchestrator ===" -ForegroundColor Magenta
Write-Host "Mode = $Mode   KeyEncoding = $KeyEncoding" -ForegroundColor Magenta
Write-Host ""

$result = if ($Mode -eq 'conhost-baseline') {
    Invoke-ConhostBaseline
} else {
    Invoke-WtControlled
}

Write-Host ""
Write-Host "=== Result ===" -ForegroundColor Magenta
$json = $result | ConvertTo-Json -Depth 10
Write-Host $json
Write-Host ""

if ($result.ok) {
    Write-Host "GO: spike succeeded for mode=$Mode encoding=$KeyEncoding" -ForegroundColor Green
    exit 0
} else {
    Write-Host "NO-GO (this run): spike failed for mode=$Mode encoding=$KeyEncoding" -ForegroundColor Yellow
    exit 1
}
