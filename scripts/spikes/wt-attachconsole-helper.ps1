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

function New-CharRecord {
    param([bool]$KeyDown, [ushort]$Char)
    $rec = New-Object 'ConsoleApi+INPUT_RECORD'
    $rec.EventType = [ConsoleApi]::KEY_EVENT
    $rec.KeyEvent.KeyDown = $KeyDown
    $rec.KeyEvent.RepeatCount = [ushort]1
    $rec.KeyEvent.VirtualKeyCode = [ushort]0
    $rec.KeyEvent.VirtualScanCode = [ushort]0
    $rec.KeyEvent.UnicodeChar = $Char
    $rec.KeyEvent.ControlKeyState = [uint32]0
    return $rec
}

function New-VkRecord {
    param([bool]$KeyDown, [ushort]$VK, [ushort]$Char)
    $rec = New-Object 'ConsoleApi+INPUT_RECORD'
    $rec.EventType = [ConsoleApi]::KEY_EVENT
    $rec.KeyEvent.KeyDown = $KeyDown
    $rec.KeyEvent.RepeatCount = [ushort]1
    $rec.KeyEvent.VirtualKeyCode = $VK
    $rec.KeyEvent.VirtualScanCode = [ushort]0
    $rec.KeyEvent.UnicodeChar = $Char
    $rec.KeyEvent.ControlKeyState = [uint32]0
    return $rec
}

foreach ($ch in $Sentinel.ToCharArray()) {
    $cInt = [ushort][int]$ch
    if ($KeyEncoding -eq 'keydown_keyup') {
        $records.Add((New-CharRecord -KeyDown $true -Char $cInt))
        $records.Add((New-CharRecord -KeyDown $false -Char $cInt))
    } else {
        $records.Add((New-CharRecord -KeyDown $true -Char $cInt))
    }
}

# Append Enter (VK_RETURN = 0x0D) so the shell processes the sentinel as a command
$VK_RETURN = [ushort]0x0D
$CR = [ushort]0x0D
if ($KeyEncoding -eq 'keydown_keyup') {
    $records.Add((New-VkRecord -KeyDown $true -VK $VK_RETURN -Char $CR))
    $records.Add((New-VkRecord -KeyDown $false -VK $VK_RETURN -Char $CR))
} else {
    $records.Add((New-VkRecord -KeyDown $true -VK $VK_RETURN -Char $CR))
}

$arr = $records.ToArray()

# Step 7: write input
[uint32]$written = 0
$writeOk = [ConsoleApi]::WriteConsoleInputW($hConin, $arr, [uint32]$arr.Length, [ref]$written)
$writeErr = if (-not $writeOk) { [System.Runtime.InteropServices.Marshal]::GetLastWin32Error() } else { 0 }

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
} -ExitCode $resultExit
