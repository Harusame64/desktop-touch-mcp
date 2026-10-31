// internal #334 — type text into a classic console window's input buffer as key-down / key-up pairs.
//
// The server's background send used to post WM_CHAR to the console window with a repeat count of 0. conhost
// merges an unread key event into the next identical one and adds their repeat counts, so a run of the same
// character reached PSReadLine and .NET ReadKey as one (`ssh -p 2222` ran as `ssh -p 2`). A key-up between two
// key-downs is never merged: win2 measured 200 characters with the reader stalled, through pwsh + PSReadLine
// 2.4.5, PS 5.1 + 2.0.0, cmd and an ssh session's bash, exact every time (PR #889 spike 2). Writing Enter as a
// VK_RETURN pair here also needs no pause after it (the #882 pause was for WM_KEYDOWN translation).
//
// A control character U+0001..U+001A (but Tab and Backspace) is Ctrl + its letter; U+0003 is the signal or the
// key by the console's input mode at that point (internal #340).
//
// Usage: console-input.exe <pid of a process on the target console>, the text as UTF-8 on stdin (never on the
// command line: a background send can carry a secret). Prints the number of UTF-16 units written.
// Exit codes: 0 all written; 2 bad arguments; 3 AttachConsole failed; 4 CONIN$ could not be opened;
// 5 the write stopped short (the count printed is what went in).
//
// Secret-free: it holds the text only while writing it, and keeps nothing. It is a separate process because
// AttachConsole applies to the whole process — the server must not leave its own console to do this.

using System.Runtime.InteropServices;
using System.Text;

internal static class Program
{
    [StructLayout(LayoutKind.Explicit)]
    private struct INPUT_RECORD
    {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct KEY_EVENT_RECORD
    {
        public int bKeyDown;
        public ushort wRepeatCount;
        public ushort wVirtualKeyCode;
        public ushort wVirtualScanCode;
        public char UnicodeChar;
        public uint dwControlKeyState;
    }

    private const ushort KEY_EVENT = 0x0001;
    private const ushort VK_RETURN = 0x0D;
    private const uint SHIFT_PRESSED = 0x0010;
    private const uint LEFT_CTRL_PRESSED = 0x0008;
    private const uint ENABLE_PROCESSED_INPUT = 0x0001;
    private const uint CTRL_C_EVENT = 0;
    private const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x1, FILE_SHARE_WRITE = 0x2, OPEN_EXISTING = 3;
    private static readonly nint INVALID_HANDLE = -1;

    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AttachConsole(uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern nint CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, nint lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, nint hTemplateFile);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool WriteConsoleInputW(nint hConsoleInput, [In] INPUT_RECORD[] lpBuffer, uint nLength, out uint lpNumberOfEventsWritten);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(nint hObject);
    [DllImport("kernel32.dll")] private static extern bool GetConsoleMode(nint hConsoleHandle, out uint lpMode);
    [DllImport("kernel32.dll")] private static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern short VkKeyScanW(char ch);
    [DllImport("user32.dll")] private static extern uint MapVirtualKeyW(uint uCode, uint uMapType);
    private delegate bool ConsoleCtrlHandler(uint ctrlType);
    [DllImport("kernel32.dll")] private static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler? handler, bool add);
    // Attached, this process is one of the console's clients: Ctrl+C / Ctrl+Break there would end it mid-write.
    private static readonly ConsoleCtrlHandler IgnoreCtrl = _ => true;

    private static int Main(string[] args)
    {
        if (args.Length != 1 || !uint.TryParse(args[0], out var pid) || pid == 0) return 2;
        string text;
        using (var stdin = Console.OpenStandardInput())
        using (var ms = new MemoryStream())
        {
            stdin.CopyTo(ms);
            text = new UTF8Encoding(false, true).GetString(ms.ToArray());
        }
        var (records, unitsAt, ctrlC) = Build(text);
        // Taken before attaching: AttachConsole may point the std handles at the target console.
        using var result = Console.OpenStandardOutput();

        FreeConsole();
        if (!AttachConsole(pid)) return 3;
        SetConsoleCtrlHandler(IgnoreCtrl, true);
        var conin = CreateFileW("CONIN$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, 0, OPEN_EXISTING, 0, 0);
        if (conin == INVALID_HANDLE) return 4;
        var written = 0;
        try
        {
            // One call per slice; a slice never splits a down / up pair, and stops at a Ctrl+C (internal #340).
            const int slice = 4096;
            var stops = new Queue<int>(ctrlC);
            while (written < records.Length)
            {
                if (stops.Count > 0 && stops.Peek() == written)
                {
                    stops.Dequeue();
                    // Everything before it is in; now the console's mode says what Ctrl+C means there. With
                    // processed input (a shell, cmd, a running command) it is a signal: send CTRL_C_EVENT, as the
                    // real key does (this process ignores it). Without (ssh, PSReadLine at its prompt) it is a
                    // key the reader takes: write the Ctrl+C key pair. win2's spike (#340): the key alone did not
                    // stop a running command; the signal alone did not cancel a PSReadLine line and closed ssh.
                    if (GetConsoleMode(conin, out var mode) && (mode & ENABLE_PROCESSED_INPUT) != 0 &&
                        GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0))
                    {
                        written += 2;
                        continue;
                    }
                }
                var end = stops.Count > 0 ? stops.Peek() : records.Length;
                if (end == written) end = written + 2; // the Ctrl+C pair itself, written as keys
                var n = Math.Min(slice, end - written);
                var part = new INPUT_RECORD[n];
                Array.Copy(records, written, part, 0, n);
                if (!WriteConsoleInputW(conin, part, (uint)n, out var w) || w != n)
                {
                    written += (int)w;
                    break;
                }
                written += n;
            }
        }
        finally { CloseHandle(conin); }
        // A key whose down went in counts (conhost types on the down), even if its up did not.
        var count = Encoding.ASCII.GetBytes(unitsAt[(written + 1) / 2].ToString());
        result.Write(count, 0, count.Length);
        return written == records.Length ? 0 : 5;
    }

    /// Two records per key (down, up) and, for each key count k, how many UTF-16 units of `text` the first k
    /// keys cover — a line break (`\r\n`, `\r` or `\n`) is one Enter key for one or two units. `ctrlC` lists
    /// the record index of each Ctrl+C's down (Main decides there whether it is a signal or a key).
    private static (INPUT_RECORD[] records, int[] unitsAt, int[] ctrlC) Build(string text)
    {
        var records = new List<INPUT_RECORD>(text.Length * 2);
        var unitsAt = new List<int> { 0 };
        var ctrlC = new List<int>();
        for (var i = 0; i < text.Length; i++)
        {
            var ch = text[i];
            if (ch == '\r' || ch == '\n')
            {
                if (ch == '\r' && i + 1 < text.Length && text[i + 1] == '\n') i++;
                AddKey(records, VK_RETURN, '\r', 0);
            }
            else if (ch >= '\u0001' && ch <= '\u001A' && ch != '\t' && ch != '\b')
            {
                // internal #340: a control character is Ctrl + its letter. VkKeyScan answers VK_CANCEL with no
                // Ctrl for U+0003 (win2), and the server used to drop the Ctrl bit of the others, so U+0003 typed
                // "c". The key is 'A' + n - 1 with Ctrl held, and the character itself.
                if (ch == '\u0003') ctrlC.Add(records.Count);
                AddKey(records, (ushort)('A' + ch - 1), ch, LEFT_CTRL_PRESSED);
            }
            else
            {
                var scan = char.IsSurrogate(ch) ? (short)-1 : VkKeyScanW(ch);
                var vk = (scan & 0xFF) == 0xFF ? (ushort)0 : (ushort)(scan & 0xFF);
                var state = vk != 0 && (scan & 0x0100) != 0 ? SHIFT_PRESSED : 0;
                AddKey(records, vk, ch, state);
            }
            unitsAt.Add(i + 1);
        }
        return (records.ToArray(), unitsAt.ToArray(), ctrlC.ToArray());
    }

    private static void AddKey(List<INPUT_RECORD> records, ushort vk, char ch, uint state)
    {
        var scan = vk == 0 ? (ushort)0 : (ushort)MapVirtualKeyW(vk, 0);
        foreach (var down in new[] { true, false })
            records.Add(new INPUT_RECORD
            {
                EventType = KEY_EVENT,
                KeyEvent = new KEY_EVENT_RECORD
                {
                    bKeyDown = down ? 1 : 0, wRepeatCount = 1, wVirtualKeyCode = vk, wVirtualScanCode = scan,
                    UnicodeChar = ch, dwControlKeyState = state,
                },
            });
    }
}
