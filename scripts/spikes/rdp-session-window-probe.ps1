#requires -Version 5.1
<#
.SYNOPSIS
  Read-only probe for Win32 window APIs across Terminal Services session states.

.DESCRIPTION
  Captures a single-snapshot view of:
    - The process's own session id (ProcessIdToSessionId) and console session id
      (WTSGetActiveConsoleSessionId)
    - All Terminal Services sessions on this host (WTSEnumerateSessions)
    - EnumWindows results (count + top sample with title, class, pid, sessionId
      per HWND via GetWindowThreadProcessId + ProcessIdToSessionId)
    - GetForegroundWindow result (HWND + decoded fields)

  Run this in each scenario that needs to be characterised:
    1. Console session (local interactive logon)
    2. Active RDP session (logged in via mstsc from another PC)
    3. RDP session immediately after Win+L (locked)
    4. (Optional) Console while a second user is logged in via RDP

  The script writes only to its own stdout / a single JSON file. It does NOT
  mutate any window, registry key, file, or session. Safe to run anywhere.

.PARAMETER OutputPath
  Optional JSON file to write the captured snapshot to. If omitted, results
  are printed to stdout as JSON. The path's parent directory must already exist.

.PARAMETER ScenarioTag
  Free-form tag string written into the JSON so multiple runs can be merged
  later (e.g. "console", "rdp-active", "rdp-locked").

.EXAMPLE
  PS> .\rdp-session-window-probe.ps1 -ScenarioTag console -OutputPath C:\Temp\rdp-probe-console.json
#>

[CmdletBinding()]
param(
  [string]$OutputPath = "",
  [string]$ScenarioTag = "unspecified"
)

$ErrorActionPreference = "Stop"

# --- Win32 P/Invoke surface (read-only) ---------------------------------------
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class RdpProbeNative {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ProcessIdToSessionId(uint dwProcessId, out uint pSessionId);

    [DllImport("kernel32.dll")]
    public static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern int WTSEnumerateSessionsW(
        IntPtr hServer, int Reserved, int Version,
        ref IntPtr ppSessionInfo, ref int pCount);

    [DllImport("wtsapi32.dll")]
    public static extern void WTSFreeMemory(IntPtr pMemory);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WTS_SESSION_INFOW {
        public int SessionId;
        [MarshalAs(UnmanagedType.LPWStr)]
        public string pWinStationName;
        public int State;
    }

    public static IntPtr WTS_CURRENT_SERVER_HANDLE { get { return IntPtr.Zero; } }

    public static List<IntPtr> EnumerateAllTopLevel() {
        var result = new List<IntPtr>();
        EnumWindows((hWnd, lParam) => { result.Add(hWnd); return true; }, IntPtr.Zero);
        return result;
    }

    public static string GetTitle(IntPtr hWnd) {
        var sb = new StringBuilder(512);
        int n = GetWindowTextW(hWnd, sb, sb.Capacity);
        return n > 0 ? sb.ToString(0, n) : "";
    }

    public static string GetClass(IntPtr hWnd) {
        var sb = new StringBuilder(256);
        int n = GetClassNameW(hWnd, sb, sb.Capacity);
        return n > 0 ? sb.ToString(0, n) : "";
    }
}
"@

# --- WTS state code → label mapping (winuser.h / wtsapi32.h) -----------------
$WtsStateLabel = @{
  0  = "Active"
  1  = "Connected"
  2  = "ConnectQuery"
  3  = "Shadow"
  4  = "Disconnected"
  5  = "Idle"
  6  = "Listen"
  7  = "Reset"
  8  = "Down"
  9  = "Init"
}

# --- Session enumeration ------------------------------------------------------
function Get-WtsSessions {
  $ppSessionInfo = [IntPtr]::Zero
  $count = 0
  $ok = [RdpProbeNative]::WTSEnumerateSessionsW(
    [RdpProbeNative]::WTS_CURRENT_SERVER_HANDLE, 0, 1,
    [ref]$ppSessionInfo, [ref]$count)
  if (-not $ok) {
    return @{ ok = $false; error = "WTSEnumerateSessionsW failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  }
  try {
    $sessions = @()
    $structSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][RdpProbeNative+WTS_SESSION_INFOW])
    for ($i = 0; $i -lt $count; $i++) {
      $ptr = [IntPtr]::Add($ppSessionInfo, $i * $structSize)
      $info = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][RdpProbeNative+WTS_SESSION_INFOW])
      $stateLabel = if ($WtsStateLabel.ContainsKey($info.State)) { $WtsStateLabel[$info.State] } else { "Unknown($($info.State))" }
      $sessions += [pscustomobject]@{
        sessionId    = $info.SessionId
        winStation   = $info.pWinStationName
        state        = $info.State
        stateLabel   = $stateLabel
      }
    }
    return @{ ok = $true; sessions = $sessions }
  } finally {
    [RdpProbeNative]::WTSFreeMemory($ppSessionInfo)
  }
}

# --- Decorate one HWND with title/class/visibility/pid/sessionId --------------
function Get-HwndInfo([IntPtr]$hwnd) {
  $procId = 0
  [void][RdpProbeNative]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  $sid = 0
  $sidOk = [RdpProbeNative]::ProcessIdToSessionId([uint32]$procId, [ref]$sid)
  return [pscustomobject]@{
    hwnd        = "0x{0:X}" -f ([Int64]$hwnd)
    title       = [RdpProbeNative]::GetTitle($hwnd)
    className   = [RdpProbeNative]::GetClass($hwnd)
    visible     = [RdpProbeNative]::IsWindowVisible($hwnd)
    iconic      = [RdpProbeNative]::IsIconic($hwnd)
    pid         = [int]$procId
    sessionId   = if ($sidOk) { [int]$sid } else { -1 }
  }
}

# --- Build snapshot -----------------------------------------------------------
$ownPid = [System.Diagnostics.Process]::GetCurrentProcess().Id
$ownSid = 0
[void][RdpProbeNative]::ProcessIdToSessionId([uint32]$ownPid, [ref]$ownSid)
$consoleSid = [RdpProbeNative]::WTSGetActiveConsoleSessionId()

$wts = Get-WtsSessions

$allHwnds = [RdpProbeNative]::EnumerateAllTopLevel()
$totalCount = $allHwnds.Count

# Sample: first 20 visible + first 20 by raw order, deduped by hwnd
$sample = @()
$seen = @{}
$visibleAdded = 0
foreach ($h in $allHwnds) {
  if ($visibleAdded -ge 20) { break }
  if (-not [RdpProbeNative]::IsWindowVisible($h)) { continue }
  $key = "0x{0:X}" -f ([Int64]$h)
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = $true
  $sample += Get-HwndInfo $h
  $visibleAdded++
}

$fgHwnd = [RdpProbeNative]::GetForegroundWindow()
$fgInfo = $null
if ($fgHwnd -ne [IntPtr]::Zero) {
  $fgInfo = Get-HwndInfo $fgHwnd
}

$snapshot = [pscustomobject]@{
  capturedAt        = (Get-Date).ToString("o")
  scenarioTag       = $ScenarioTag
  host              = [Environment]::MachineName
  userName          = [Environment]::UserName
  ownProcess        = @{ pid = $ownPid; sessionId = [int]$ownSid }
  consoleSessionId  = [int]$consoleSid
  wtsEnumeration    = $wts
  enumWindows       = @{
    totalCount        = $totalCount
    visibleSampled    = $sample.Count
    sample            = $sample
  }
  foregroundWindow  = @{
    isNull           = ($fgHwnd -eq [IntPtr]::Zero)
    decoded          = $fgInfo
  }
  notes             = @(
    "All Win32 calls run in the calling thread's session/window-station/desktop context.",
    "EnumWindows therefore returns only the windows that this thread's desktop can see.",
    "GetForegroundWindow returns NULL when no window has activation (lock screen, secure desktop, session switch)."
  )
}

$json = $snapshot | ConvertTo-Json -Depth 6
if ($OutputPath -ne "") {
  $json | Out-File -FilePath $OutputPath -Encoding UTF8
  Write-Host "Wrote snapshot to $OutputPath"
} else {
  Write-Output $json
}
