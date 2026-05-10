# wt-attachconsole-helper.ps1
#
# Child-PS helper that performs the AttachConsole + WriteConsoleInputW spike
# step in isolation from the calling Claude/orchestrator PS host. After
# AttachConsole() the helper's stdout/stderr would route to the target's
# console — we therefore communicate results via a JSON result file passed
# as -ResultFile.
#
# Pipeline per docs/wt-attachconsole-spike-prompt.md "Suggested Spike Shape":
#   1. Add-Type with P/Invoke definitions for Win32 console APIs
#   2. FreeConsole (detach helper's own freshly-allocated console)
#   3. AttachConsole(TargetPid) — capture GetLastError on failure
#   4. GetConsoleProcessList — diagnostic, log all PIDs sharing target's console
#   5. CreateFileW("CONIN$", GENERIC_RW, FILE_SHARE_RW, NULL, OPEN_EXISTING, 0, NULL)
#   6. Build INPUT_RECORD[] for each Sentinel character + Enter (VK_RETURN)
#   7. WriteConsoleInputW — capture written count + GetLastError on failure
#   8. CloseHandle + FreeConsole
#   9. Write JSON result to -ResultFile
#
# Safety: helper does NOT send anything but the user-supplied Sentinel +
# Enter. Caller is responsible for sentinel uniqueness + non-destructive content.
#
# Exit codes: 0 on success, 1 on any Win32 step failure (details in JSON).

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$TargetPid,
    [Parameter(Mandatory = $true)][string]$Sentinel,
    [Parameter(Mandatory = $true)][string]$ResultFile,
    [ValidateSet('keydown', 'keydown_keyup')]
    [string]$KeyEncoding = 'keydown_keyup'
)

$ErrorActionPreference = 'Stop'

$signature = @'
using System;
using System.Runtime.InteropServices;

public static class ConsoleApi {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint GetConsoleProcessList(uint[] lpdwProcessList, uint dwProcessCount);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateFileW(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    // Round 2: proper VK + scan code encoding
    [DllImport("user32.dll", SetLastError = true)]
    public static extern short VkKeyScanW(char ch);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint MapVirtualKeyW(uint uCode, uint uMapType);

    public const uint MAPVK_VK_TO_VSC = 0;

    // Win32 KEY_EVENT_RECORD: 16 bytes total
    //   BOOL bKeyDown            (4 bytes, 4-byte BOOL via MarshalAs(UnmanagedType.Bool))
    //   WORD wRepeatCount        (2)
    //   WORD wVirtualKeyCode     (2)
    //   WORD wVirtualScanCode    (2)
    //   WCHAR UnicodeChar        (2)
    //   DWORD dwControlKeyState  (4)
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct KEY_EVENT_RECORD {
        [MarshalAs(UnmanagedType.Bool)] public bool KeyDown;
        public ushort RepeatCount;
        public ushort VirtualKeyCode;
        public ushort VirtualScanCode;
        public ushort UnicodeChar;
        public uint ControlKeyState;
    }

    // Win32 INPUT_RECORD: 20 bytes (WORD EventType + 2 bytes pad + 16 bytes union)
    // We only ever use the KEY_EVENT branch in this spike.
    [StructLayout(LayoutKind.Explicit, Size = 20)]
    public struct INPUT_RECORD {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
    }

    public const ushort KEY_EVENT = 0x0001;

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "WriteConsoleInputW")]
    public static extern bool WriteConsoleInputW(
        IntPtr hConsoleInput,
        INPUT_RECORD[] lpBuffer,
        uint nLength,
        out uint lpNumberOfEventsWritten);

    // Round 3 diagnostic (Opus-mandated, vestigial-buffer hypothesis verification):
    // PeekConsoleInputW reads without removing — distinguishes between
    //   (A) records live in CONIN$ (read-back returns our records)
    //   (B) records were drained immediately (read-back returns 0)
    //   (C) handle is decoupled from real input source (ReadFile-style failure)
    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "PeekConsoleInputW")]
    public static extern bool PeekConsoleInputW(
        IntPtr hConsoleInput,
        [Out] INPUT_RECORD[] lpBuffer,
        uint nLength,
        out uint lpNumberOfEventsRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetNumberOfConsoleInputEvents(
        IntPtr hConsoleInput,
        out uint lpcNumberOfEvents);

    public const uint GENERIC_READ = 0x80000000;
    public const uint GENERIC_WRITE = 0x40000000;
    public const uint FILE_SHARE_READ = 0x00000001;
    public const uint FILE_SHARE_WRITE = 0x00000002;
    public const uint OPEN_EXISTING = 3;
}
'@

Add-Type -TypeDefinition $signature -Language CSharp

function Write-Result {
    param([hashtable]$Data, [int]$ExitCode)
    $Data | ConvertTo-Json -Compress | Out-File -FilePath $ResultFile -Encoding utf8 -NoNewline
    exit $ExitCode
}

# Step 2: detach from helper's own console (Start-Process -WindowStyle Hidden gives us one).
# We ignore FreeConsole's return — if the helper has no console, FreeConsole returns FALSE
# but that is not an error condition for our use case.
[ConsoleApi]::FreeConsole() | Out-Null

# Step 3: attach to target's console
$attached = [ConsoleApi]::AttachConsole([uint32]$TargetPid)
if (-not $attached) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Result @{
        ok = $false
        step = 'AttachConsole'
        win32_error = $err
        win32_error_hex = ('0x{0:X8}' -f $err)
        target_pid = $TargetPid
    } -ExitCode 1
}

# Step 4: enumerate attached console process list (diagnostic)
$processList = New-Object 'uint32[]' 64
[uint32]$count = [ConsoleApi]::GetConsoleProcessList($processList, [uint32]64)
$attachedPids = @()
if ($count -gt 0) {
    for ($i = 0; $i -lt [Math]::Min($count, 64); $i++) {
        $attachedPids += [int]$processList[$i]
    }
}

# Step 5: open CONIN$
$hConin = [ConsoleApi]::CreateFileW(
    'CONIN$',
    [ConsoleApi]::GENERIC_READ -bor [ConsoleApi]::GENERIC_WRITE,
    [ConsoleApi]::FILE_SHARE_READ -bor [ConsoleApi]::FILE_SHARE_WRITE,
    [System.IntPtr]::Zero,
    [ConsoleApi]::OPEN_EXISTING,
    0,
    [System.IntPtr]::Zero)

if ($hConin.ToInt64() -eq -1) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    [ConsoleApi]::FreeConsole() | Out-Null
    Write-Result @{
        ok = $false
        step = 'CreateFileW(CONIN$)'
        win32_error = $err
        win32_error_hex = ('0x{0:X8}' -f $err)
        target_pid = $TargetPid
        attached_pids = $attachedPids
    } -ExitCode 1
}

# Step 6: build INPUT_RECORD[] for sentinel chars + Enter
$records = New-Object 'System.Collections.Generic.List[ConsoleApi+INPUT_RECORD]'

function New-FullKeyRecord {
    # Round 2: proper VirtualKeyCode + scan code + ControlKeyState. For ASCII
    # characters this resolves to the same VK an OS keyboard event would
    # produce; the input subsystem (cooked-mode line reader in cmd / PSReadLine
    # in PowerShell) typically requires VK metadata, not just UnicodeChar.
    param(
        [bool]$KeyDown,
        [ushort]$VK,
        [ushort]$ScanCode,
        [ushort]$Char,
        [uint32]$ControlKeyState
    )
    $rec = New-Object 'ConsoleApi+INPUT_RECORD'
    $rec.EventType = [ConsoleApi]::KEY_EVENT
    $rec.KeyEvent.KeyDown = $KeyDown
    $rec.KeyEvent.RepeatCount = [ushort]1
    $rec.KeyEvent.VirtualKeyCode = $VK
    $rec.KeyEvent.VirtualScanCode = $ScanCode
    $rec.KeyEvent.UnicodeChar = $Char
    $rec.KeyEvent.ControlKeyState = $ControlKeyState
    return $rec
}

# ControlKeyState flags (winuser.h)
$SHIFT_PRESSED = [uint32]0x10
$VK_SHIFT = [ushort]0x10
$VK_RETURN = [ushort]0x0D

# Pre-compute SHIFT scan code (used for shifted chars)
$shiftScan = [ushort][ConsoleApi]::MapVirtualKeyW([uint32]$VK_SHIFT, [ConsoleApi]::MAPVK_VK_TO_VSC)
$enterScan = [ushort][ConsoleApi]::MapVirtualKeyW([uint32]$VK_RETURN, [ConsoleApi]::MAPVK_VK_TO_VSC)

foreach ($ch in $Sentinel.ToCharArray()) {
    $cInt = [ushort][int]$ch
    $vkScan = [int][ConsoleApi]::VkKeyScanW([char]$ch)
    if ($vkScan -eq -1) {
        # Char not on default keyboard layout — fall back to UnicodeChar-only
        $vk = [ushort]0
        $scanCode = [ushort]0
        $needShift = $false
    } else {
        $vk = [ushort]($vkScan -band 0xFF)
        $shiftState = ($vkScan -shr 8) -band 0xFF
        $needShift = ($shiftState -band 0x01) -ne 0
        $scanCode = [ushort][ConsoleApi]::MapVirtualKeyW([uint32]$vk, [ConsoleApi]::MAPVK_VK_TO_VSC)
    }

    $cks = if ($needShift) { $SHIFT_PRESSED } else { [uint32]0 }

    if ($needShift) {
        # SHIFT key down before the char
        $records.Add((New-FullKeyRecord -KeyDown $true -VK $VK_SHIFT -ScanCode $shiftScan -Char ([ushort]0) -ControlKeyState $SHIFT_PRESSED))
    }

    if ($KeyEncoding -eq 'keydown_keyup') {
        $records.Add((New-FullKeyRecord -KeyDown $true -VK $vk -ScanCode $scanCode -Char $cInt -ControlKeyState $cks))
        $records.Add((New-FullKeyRecord -KeyDown $false -VK $vk -ScanCode $scanCode -Char $cInt -ControlKeyState $cks))
    } else {
        $records.Add((New-FullKeyRecord -KeyDown $true -VK $vk -ScanCode $scanCode -Char $cInt -ControlKeyState $cks))
    }

    if ($needShift) {
        # SHIFT key up after the char
        $records.Add((New-FullKeyRecord -KeyDown $false -VK $VK_SHIFT -ScanCode $shiftScan -Char ([ushort]0) -ControlKeyState ([uint32]0)))
    }
}

# Append Enter (VK_RETURN = 0x0D)
$CR = [ushort]0x0D
if ($KeyEncoding -eq 'keydown_keyup') {
    $records.Add((New-FullKeyRecord -KeyDown $true -VK $VK_RETURN -ScanCode $enterScan -Char $CR -ControlKeyState ([uint32]0)))
    $records.Add((New-FullKeyRecord -KeyDown $false -VK $VK_RETURN -ScanCode $enterScan -Char $CR -ControlKeyState ([uint32]0)))
} else {
    $records.Add((New-FullKeyRecord -KeyDown $true -VK $VK_RETURN -ScanCode $enterScan -Char $CR -ControlKeyState ([uint32]0)))
}

$arr = $records.ToArray()

# Step 7: write input
[uint32]$written = 0
$writeOk = [ConsoleApi]::WriteConsoleInputW($hConin, $arr, [uint32]$arr.Length, [ref]$written)
$writeErr = if (-not $writeOk) { [System.Runtime.InteropServices.Marshal]::GetLastWin32Error() } else { 0 }

# Step 7.5 (Round 3 diagnostic): peek the input buffer immediately after write
# to verify whether the records actually land in CONIN$. Three outcomes:
#   live  — records still in buffer (vestigial / not consumed)
#   drained — buffer empty / fewer (consumer drained, but consumer != shell)
#   peek_failed — handle is decoupled from real input source
$peekErr = 0
$pendingCount = 0
$peekOk = $false
$peekedRecords = 0
$pendingOk = [ConsoleApi]::GetNumberOfConsoleInputEvents($hConin, [ref]$pendingCount)
if (-not $pendingOk) {
    $peekErr = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
}
$peekBuf = New-Object 'ConsoleApi+INPUT_RECORD[]' 256
[uint32]$peeked = 0
$peekOk = [ConsoleApi]::PeekConsoleInputW($hConin, $peekBuf, [uint32]256, [ref]$peeked)
if (-not $peekOk -and $peekErr -eq 0) {
    $peekErr = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
}
$peekedRecords = [int]$peeked

# Capture first few peeked records' EventType + UnicodeChar for evidence
$peekedSummary = @()
$dumpN = [Math]::Min($peekedRecords, 8)
for ($i = 0; $i -lt $dumpN; $i++) {
    $r = $peekBuf[$i]
    $et = [int]$r.EventType
    $kd = $false
    $vk = 0
    $ch = 0
    if ($et -eq [int][ConsoleApi]::KEY_EVENT) {
        $kd = $r.KeyEvent.KeyDown
        $vk = [int]$r.KeyEvent.VirtualKeyCode
        $ch = [int]$r.KeyEvent.UnicodeChar
    }
    $peekedSummary += @{
        idx = $i
        event_type = $et
        key_down = $kd
        vk = $vk
        unicode_char = $ch
    }
}

# Step 8: cleanup
[ConsoleApi]::CloseHandle($hConin) | Out-Null
[ConsoleApi]::FreeConsole() | Out-Null

# Step 9: report
$resultExit = if ($writeOk) { 0 } else { 1 }
$resultStep = if ($writeOk) { 'WriteConsoleInputW success' } else { 'WriteConsoleInputW failed' }
Write-Result @{
    ok = $writeOk
    step = $resultStep
    win32_error = $writeErr
    win32_error_hex = ('0x{0:X8}' -f $writeErr)
    records_attempted = $arr.Length
    records_written = [int]$written
    attached_pids = $attachedPids
    target_pid = $TargetPid
    sentinel = $Sentinel
    key_encoding = $KeyEncoding
    # Round 3 diagnostic
    peek_ok = $peekOk
    pending_events = [int]$pendingCount
    peeked_records = $peekedRecords
    peek_win32_error = $peekErr
    peek_win32_error_hex = ('0x{0:X8}' -f $peekErr)
    peeked_summary = $peekedSummary
} -ExitCode $resultExit
