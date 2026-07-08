// ADR-014 v2 R3 Key Locker — L2 injection (C# side): the console-buffer injector with injection-instant
// identity re-verify, and the askpass serving path (single-use ticket + per-injection serving pipe).
//
// Plan: desktop-touch-mcp-internal@<plan>:docs/adr-014-v2-r3-l2-injection-plan.md (§2, §3);
//       DF-5 fix: desktop-touch-mcp-internal@<plan>:docs/adr-014-v2-r3-df5-writeconsoleinput-impl-plan.md
//
// The secret NEVER crosses the control pipe and never reaches Node: the keystroke write happens HERE (the
// locker holds the plaintext); the askpass helper fetches it over a SEPARATE serving pipe this file
// creates. Plaintext is decrypted transiently (LockerStore.WithDecrypted) and zeroized after use.
//
// DF-5 (2026-07-08): injection is `AttachConsole` + `WriteConsoleInputW` into the target console's input
// buffer (foreground/UIPI-immune), NOT SendInput (which returned `sent=0` under a foreground-ownership
// gate). See the Win32Input class doc for the mechanism + the re-expressed security property.

using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

// Global namespace (matches Program.cs's `internal static class KeyLocker`; a `namespace KeyLocker`
// here would collide with that class name).

/// The dedicated-console target of an injection, parsed off the `inject` frame's `t` field (§2.1).
/// `ConsolePid` is the WINDOW-OWNING pid (`GetWindowThreadProcessId(hwnd)`) — L3 sends
/// `getWindowProcessId(hwnd)` and this side re-reads the same API on the same hwnd, so it matches by
/// construction (not asserted to be a specific conhost-vs-shell process). DF-5 also uses `ConsolePid`
/// as the `AttachConsole` target — the same window-owning pid identifies the console to attach to.
internal readonly record struct InjectTarget(nint Hwnd, uint ConsolePid, string TitleFp, bool Submit);

/// The abort reasons the re-verify predicate can raise (§2.2); null = passed.
internal static class InjectAbort
{
    public const string Gone = "target_gone";
    public const string Multiplexed = "target_multiplexed";
    // DF-5: no longer emitted (the console-buffer injector has no foreground gate). Retained so the wire
    // enum + the Node-side InjectAbortCode union stay byte-stable for any in-flight old reply.
    public const string NotForeground = "not_foreground";
    public const string Mismatch = "target_mismatch";
    public const string NoSecret = "no_secret";
}

/// Win32 CONSOLE-BUFFER injector (DF-5 fix) + the injection-instant re-verify.
///
/// DF-5 (live dogfood 2026-07-08): the previous `SendInput` path returned `sent=0/N, GetLastError()==0`
/// — a foreground-OWNERSHIP gate (the input was refused because this process is not the foreground-input
/// owner; NOT UIPI, which would return the full count with events silently dropped). A window-less
/// helper cannot acquire foreground ownership without a fragile cross-process AllowSetForegroundWindow +
/// foreground-steal ladder. So injection now writes `KEY_EVENT` records DIRECTLY into the target
/// console's input buffer via `AttachConsole(consolePid)` + `WriteConsoleInputW(CONIN$)`, which the shell
/// cooked-reads (`ReadConsole`) — foreground- and UIPI-immune, self-contained in the helper, and a
/// natural fit because the Key Locker only ever targets a classic conhost (`ConsoleWindowClass`).
///
/// The old "inject only when the target is FOREGROUND" property is re-expressed as "inject only into the
/// verified `consolePid`'s console input buffer": the write is ADDRESSED to that console (not broadcast to
/// whatever is foreground), and a two-stage identity re-verify (before attach + after CONIN$ open) pins
/// that the hwnd/pid/class/title still name the same console — so mis-delivery to a wrong window is
/// structurally impossible. Spike-proven (scratchpad/df5-spike, 4/4): cross-process WriteConsoleInput is
/// cooked-read; Unicode/BMP/surrogate round-trip; a `wScan`-only mapping types ZERO chars (a cooked-read
/// cooks `UnicodeChar`, NOT `wScan`).
internal static class Win32Input
{
    private const string ConsoleClass = "ConsoleWindowClass"; // the console window-class name (class-name origin, not a pid claim — intentionally retained through the R1 P3-1 conhost doc-fix)

    // A console INPUT_RECORD carrying a KEY_EVENT. EventType is at offset 0 (WORD); the union member is at
    // offset 4 on x64 (2 bytes of alignment padding after EventType). sizeof(INPUT_RECORD) = 20.
    [StructLayout(LayoutKind.Explicit)]
    private struct INPUT_RECORD { [FieldOffset(0)] public ushort EventType; [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent; }
    [StructLayout(LayoutKind.Sequential)]
    private struct KEY_EVENT_RECORD
    {
        public int bKeyDown;            // BOOL
        public ushort wRepeatCount;     // MUST be 1 — a repeat count of 0 emits nothing
        public ushort wVirtualKeyCode;
        public ushort wVirtualScanCode;
        public ushort UnicodeChar;      // the field a cooked-read cooks (NOT wVirtualScanCode)
        public uint dwControlKeyState;
    }

    private const ushort KEY_EVENT = 0x0001;
    private const ushort VK_RETURN = 0x0D;
    private const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, OPEN_EXISTING = 3;
    private const int STD_INPUT_HANDLE = -10, STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;
    private static readonly nint INVALID_HANDLE = -1;

    // Console-buffer injection surface (kernel32). AttachConsole/FreeConsole are PROCESS-GLOBAL: the
    // helper attaches to the target console only transiently for one inject, then detaches.
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AttachConsole(uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool WriteConsoleInputW(nint hConsoleInput, [In] INPUT_RECORD[] lpBuffer, uint nLength, out uint lpNumberOfEventsWritten);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern nint CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, nint lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, nint hTemplateFile);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(nint hObject);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetStdHandle(int nStdHandle, nint hHandle);

    [DllImport("user32.dll")] private static extern bool IsWindow(nint hWnd);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint GetWindowThreadProcessId(nint hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern int GetClassName(nint hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(nint hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(nint hWnd);

    /// Re-verify the target IDENTITY at the injection instant. Returns an InjectAbort code on any
    /// mismatch, or null if all predicates pass. POSITIVE allowlist: the window MUST be the classic
    /// console class AND owned by the tracked window-owning pid — anything else is `target_multiplexed`.
    ///
    /// DF-5: there is NO foreground check — the console-buffer injector addresses the write to the
    /// verified `consolePid` (it does not broadcast to the foreground window), so foreground is no longer
    /// the delivery gate; identity (hwnd alive + class + owning pid + title fp) is. This predicate runs
    /// TWICE per inject (before AttachConsole and again after the CONIN$ handle opens) so the console
    /// cannot be swapped out from under the attached handle. `InjectAbort.NotForeground` is therefore no
    /// longer emitted (kept in the wire enum for back-compat only).
    private static string? ReVerify(in InjectTarget t)
    {
        if (t.Hwnd == 0 || !IsWindow(t.Hwnd)) return InjectAbort.Gone;

        var cls = new StringBuilder(64);
        GetClassName(t.Hwnd, cls, cls.Capacity);
        if (cls.ToString() != ConsoleClass) return InjectAbort.Multiplexed;

        _ = GetWindowThreadProcessId(t.Hwnd, out var pid);
        if (pid == 0) return InjectAbort.Gone;
        if (pid != t.ConsolePid) return InjectAbort.Multiplexed;

        // Secondary anchor (defense-in-depth): the live title hash must match the expected fp.
        // Skipped when the engine supplied no fp.
        if (!string.IsNullOrEmpty(t.TitleFp) && TitleFp(t.Hwnd) != t.TitleFp) return InjectAbort.Mismatch;

        return null;
    }

    /// SHA-256 (hex) of the window title — the same opaque fp both sides compute (§2.2). Non-secret.
    internal static string TitleFp(nint hwnd)
    {
        var len = GetWindowTextLength(hwnd);
        var sb = new StringBuilder(len + 1);
        GetWindowText(hwnd, sb, sb.Capacity);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString()))).ToLowerInvariant();
    }

    /// Build the KEY_EVENT records, re-verify the target identity, ATTACH to the target console, re-verify
    /// again, then write the secret + Enter (if `submit`) into that console's input buffer. Returns
    /// (injected, abortCode). BOTH plaintext-bearing buffers — the decoded char[] AND the INPUT_RECORD[]
    /// (the secret lives in each `KEY_EVENT_RECORD.UnicodeChar`) — are zeroized in the finally, upholding
    /// the zeroize discipline. Building into a sized array (not a List) avoids a hidden backing-array copy
    /// that would survive uncleared.
    ///
    /// DF-5 delivery mechanism = `AttachConsole(consolePid)` + `WriteConsoleInputW(CONIN$)` (foreground-
    /// and UIPI-immune), replacing the SendInput foreground path that returned `sent=0`. AttachConsole is
    /// PROCESS-GLOBAL and rebinds the std handles, so the 3 std handles are saved before FreeConsole and
    /// restored after, and NO `Console.Error` (or any std-stream) write may happen between AttachConsole
    /// and the final FreeConsole — a hard invariant: a diagnostic there would leak onto the USER's console.
    public static (bool injected, string? abort) ReVerifyAndType(in InjectTarget t, byte[] secret)
    {
        char[] chars = Encoding.UTF8.GetChars(secret);
        // One down + one up record per UTF-16 code unit (surrogate pairs => 2 code units => 2 records),
        // plus a VK_RETURN down/up when submitting. The secret rides in each record's UnicodeChar.
        var n = chars.Length * 2 + (t.Submit ? 2 : 0);
        var arr = new INPUT_RECORD[n];
        try
        {
            var j = 0;
            foreach (var ch in chars) { arr[j++] = KeyRecord(ch, 0, true); arr[j++] = KeyRecord(ch, 0, false); }
            if (t.Submit) { arr[j++] = KeyRecord('\r', VK_RETURN, true); arr[j++] = KeyRecord('\r', VK_RETURN, false); }

            // Stage-1 identity re-verify (cheap early-out before we perturb the process console state).
            var abort = ReVerify(in t);
            if (abort != null) return (false, abort);

            return AttachAndWrite(in t, arr);
        }
        finally
        {
            Array.Clear(chars, 0, chars.Length);
            Array.Clear(arr, 0, arr.Length); // the INPUT_RECORD[] holds the secret in each UnicodeChar
        }
    }

    /// The attach bracket: save std handles → FreeConsole → AttachConsole(consolePid) → open CONIN$ →
    /// STAGE-2 re-verify (after the handle exists, so the console can't be swapped underneath) → write.
    /// Everything is torn down in the finally (close CONIN$, FreeConsole, restore std handles). NO
    /// std-stream write may occur inside this bracket (see ReVerifyAndType doc).
    private static (bool injected, string? abort) AttachAndWrite(in InjectTarget t, INPUT_RECORD[] arr)
    {
        nint savedIn = GetStdHandle(STD_INPUT_HANDLE);
        nint savedOut = GetStdHandle(STD_OUTPUT_HANDLE);
        nint savedErr = GetStdHandle(STD_ERROR_HANDLE);
        nint conin = INVALID_HANDLE;
        var attached = false;
        try
        {
            FreeConsole(); // detach from any console we already hold (the helper is a WinExe: usually none)
            if (!AttachConsole(t.ConsolePid)) return (false, InjectAbort.Gone); // target console is gone
            attached = true;

            conin = CreateFileW("CONIN$", GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE, 0, OPEN_EXISTING, 0, 0);
            if (conin == INVALID_HANDLE) return (false, "executor_failed");

            // Stage-2 re-verify: now that the CONIN$ handle is open, confirm the hwnd/pid/class/title
            // STILL name the same console — closes the attach→write TOCTOU window (Opus R1 P2-3).
            var abort = ReVerify(in t);
            if (abort != null) return (false, abort);

            var ok = WriteConsoleInputW(conin, arr, (uint)arr.Length, out var written);
            return (ok && written == (uint)arr.Length, ok && written == (uint)arr.Length ? null : "executor_failed");
        }
        finally
        {
            if (conin != INVALID_HANDLE) CloseHandle(conin);
            if (attached) FreeConsole();
            // Restore the std handles AttachConsole/FreeConsole rebound, so later verbs' diagnostics go
            // back to the helper's original streams, not the user's console (Opus R1 P2-1).
            SetStdHandle(STD_INPUT_HANDLE, savedIn);
            SetStdHandle(STD_OUTPUT_HANDLE, savedOut);
            SetStdHandle(STD_ERROR_HANDLE, savedErr);
        }
    }

    private static INPUT_RECORD KeyRecord(char ch, ushort vk, bool down) => new()
    {
        EventType = KEY_EVENT,
        KeyEvent = new KEY_EVENT_RECORD
        {
            bKeyDown = down ? 1 : 0,
            wRepeatCount = 1,
            wVirtualKeyCode = vk,
            wVirtualScanCode = 0,
            UnicodeChar = ch,
            dwControlKeyState = 0,
        },
    };
}

/// One outstanding serving grant: a single-use, TTL-bounded ticket bound to an opaqueId and, for
/// git, the expected credential context (§3.1). The secret flows only over the serving pipe.
internal sealed class ServingGrant
{
    public required string Ticket;
    public required string OpaqueId;
    public required long ExpiryTick;             // Environment.TickCount64 deadline
    public string? Protocol;                     // git ctx (null for ssh-password askpass)
    public string? Host;
    public string? Path;
    public int Consumed;                         // 0/1 via Interlocked — one-shot
}

/// Mints tickets + runs per-injection serving pipes for the askpass helper (§3, §3.1). Each mint
/// creates a fresh FIRST_PIPE_INSTANCE pipe with a 128-bit unguessable name that serves exactly one
/// ticketed fetch and is then torn down.
internal sealed class ServingRegistry
{
    private const int TtlMs = 15_000;            // short TTL (§3.1 bounded model)
    private readonly LockerStore _store;
    public ServingRegistry(LockerStore store) { _store = store; }

    /// Create a serving pipe + ticket for `opaqueId`, optionally bound to a git `ctx`. Returns the
    /// (non-secret) ticket + pipe name; spawns a background one-shot server. Returns null if the id
    /// has no secret.
    public (string ticket, string pipe)? Mint(string opaqueId, JsonElement ctx)
    {
        if (!_store.Exists(opaqueId)) return null;

        var ticket = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
        var pipeName = "dtm-serve-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
        var grant = new ServingGrant
        {
            Ticket = ticket,
            OpaqueId = opaqueId,
            ExpiryTick = Environment.TickCount64 + TtlMs,
        };
        if (ctx.ValueKind == JsonValueKind.Object)
        {
            grant.Protocol = GetStr(ctx, "protocol");
            grant.Host = GetStr(ctx, "host");
            grant.Path = GetStr(ctx, "path");
        }

        // FIRST_PIPE_INSTANCE fail-loud + CurrentUserOnly (mirrors the control pipe's L0 discipline).
        NamedPipeServerStream server;
        try
        {
            server = NamedPipeServerStreamAcl.Create(
                pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.FirstPipeInstance | PipeOptions.CurrentUserOnly,
                0, 0, pipeSecurity: null!);
        }
        catch { return null; } // squatter won the (unguessable) name -> abort, never serve through it

        _ = Task.Run(() => ServeOnce(server, grant));
        return (ticket, pipeName);
    }

    /// Accept one connection, validate the presented ticket + (git) context, stream the secret, then
    /// tear the pipe down. A forged/expired/consumed ticket or a context mismatch serves NOTHING.
    private void ServeOnce(NamedPipeServerStream server, ServingGrant grant)
    {
        try
        {
            var accept = server.WaitForConnectionAsync();
            if (!accept.Wait(TtlMs)) return; // no consumer within TTL -> drop
            var reader = new StreamReader(server, Encoding.UTF8, false, 1024, leaveOpen: true);
            var reqLine = reader.ReadLine();
            if (reqLine == null) return;

            using var doc = JsonDocument.Parse(reqLine);
            var root = doc.RootElement;
            if (GetStr(root, "ticket") != grant.Ticket) return;                 // wrong ticket
            if (Environment.TickCount64 > grant.ExpiryTick) return;             // expired
            if (Interlocked.Exchange(ref grant.Consumed, 1) != 0) return;       // already consumed (replay)

            // git context validation (§3.1): the presented get-context must match the ticket-bound ctx.
            if (grant.Protocol != null)
            {
                if (GetStr(root, "protocol") != grant.Protocol) return;         // context_mismatch
                if (GetStr(root, "host") != grant.Host) return;
                if (grant.Path != null && GetStr(root, "path") != grant.Path) return;
            }

            // Stream the secret bytes, then flush + close. The plaintext is zeroized by WithDecrypted.
            _store.WithDecrypted(grant.OpaqueId, plain =>
            {
                server.Write(plain, 0, plain.Length);
                server.Flush();
            });
            server.WaitForPipeDrain();
        }
        catch { /* best-effort; a failed serve yields no secret */ }
        finally { try { server.Dispose(); } catch { /* ignore */ } }
    }

    private static string? GetStr(JsonElement obj, string name)
        => obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;

    /// A minimal serving-pipe CLIENT (mirrors key-askpass) for the headless -SelfTestL2 seam.
    private static byte[]? Fetch(string pipe, string ticket, Dictionary<string, string>? ctx)
    {
        using var client = new NamedPipeClientStream(".", pipe, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        try { client.Connect(3000); } catch { return null; }
        var req = new Dictionary<string, string> { ["ticket"] = ticket };
        if (ctx != null) foreach (var kv in ctx) req[kv.Key] = kv.Value;
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(req) + "\n");
        client.Write(bytes, 0, bytes.Length);
        client.Flush();
        using var ms = new MemoryStream();
        client.CopyTo(ms);
        return ms.Length > 0 ? ms.ToArray() : null;
    }

    /// Headless deterministic proof of the serving/ticket contract (§3, §3.1): valid fetch,
    /// single-use (replay refused), forged ticket refused, git context_mismatch refused. The
    /// console-buffer injection path needs a live conhost and is exercised by `-SelfTestInjectConsole`
    /// (headless, self-spawned console) + the e2e suite, not here.
    public bool SelfTest()
    {
        const string id = "l2-selftest-id";
        const string secret = "L2-SERVE-SECRET-✓";
        _store.Capture(id, secret);
        try
        {
            // 1. Valid fetch returns the exact secret.
            var m1 = Mint(id, default);
            if (m1 == null) return false;
            var got = Fetch(m1.Value.pipe, m1.Value.ticket, null);
            if (got == null || Encoding.UTF8.GetString(got) != secret) return false;

            // 2. Single-use: the pipe is torn down after one serve — a second fetch gets nothing.
            if (Fetch(m1.Value.pipe, m1.Value.ticket, null) != null) return false;

            // 3. Forged ticket on a fresh mint → nothing served.
            var m2 = Mint(id, default);
            if (m2 == null) return false;
            if (Fetch(m2.Value.pipe, "deadbeefdeadbeefdeadbeefdeadbeef", null) != null) return false;
            Fetch(m2.Value.pipe, m2.Value.ticket, null); // consume/close m2

            // 4. git context_mismatch: mint bound to github.com, present a wrong host → nothing.
            using var ctxDoc = JsonDocument.Parse("{\"protocol\":\"https\",\"host\":\"github.com\",\"path\":\"o/r\"}");
            var m3 = Mint(id, ctxDoc.RootElement);
            if (m3 == null) return false;
            var wrong = new Dictionary<string, string> { ["protocol"] = "https", ["host"] = "evil.example.com", ["path"] = "o/r" };
            if (Fetch(m3.Value.pipe, m3.Value.ticket, wrong) != null) return false;

            // 5. git context MATCH still serves (positive control on a fresh mint).
            using var ctxDoc2 = JsonDocument.Parse("{\"protocol\":\"https\",\"host\":\"github.com\",\"path\":\"o/r\"}");
            var m4 = Mint(id, ctxDoc2.RootElement);
            if (m4 == null) return false;
            var right = new Dictionary<string, string> { ["protocol"] = "https", ["host"] = "github.com", ["path"] = "o/r" };
            var got4 = Fetch(m4.Value.pipe, m4.Value.ticket, right);
            if (got4 == null || Encoding.UTF8.GetString(got4) != secret) return false;

            return true;
        }
        finally { _store.Delete(id); }
    }
}

/// DF-5 headless self-test for the console-buffer injector (`-SelfTestInjectConsole`). Deterministic proof
/// — no live ssh — that `Win32Input.ReVerifyAndType` (AttachConsole + WriteConsoleInput) types a
/// unicode+surrogate secret into ANOTHER process's console and that its cooked-read (echo OFF) reads it
/// back exactly. The parent spawns a child copy of THIS exe with CREATE_NEW_CONSOLE; the child (a
/// GUI-subsystem WinExe, which CREATE_NEW_CONSOLE does not reliably auto-attach) calls
/// `FreeConsole`+`AllocConsole` to own a fresh console, and the parent then attaches to it by the
/// window-owning pid. On a classic-conhost machine (CI, and the default Windows desktop) `AllocConsole`
/// yields a `ConsoleWindowClass` window so the `ReVerify` allowlist passes. LIMITATION: on a desktop whose
/// Default Terminal is Windows Terminal, `AllocConsole` may hand off to a ConPTY pseudoconsole whose window
/// is NOT `ConsoleWindowClass`, in which case `ReVerify` aborts `target_multiplexed` and this self-test can
/// fail — that path (like OQ-DF-7/8) is covered by the live dogfood, not this headless proof.
internal static class ConsoleInjectSelfTest
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public nint lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION { public nint hProcess, hThread; public uint dwProcessId, dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(string? app, StringBuilder cmd, nint pa, nint ta, bool inherit, uint flags, nint env, string? cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(nint h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(nint h, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(nint h);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetConsoleMode(nint h, out uint mode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetConsoleMode(nint h, uint mode);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool ReadConsoleW(nint h, [Out] char[] buf, uint toRead, out uint read, nint pInputControl);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern nint CreateFileW(string name, uint access, uint share, nint sa, uint disp, uint flags, nint template);
    [DllImport("kernel32.dll")] private static extern nint GetConsoleWindow();
    [DllImport("user32.dll", SetLastError = true)] private static extern uint GetWindowThreadProcessId(nint hWnd, out uint pid);

    private const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, OPEN_EXISTING = 3;
    private const uint ENABLE_PROCESSED_INPUT = 0x0001, ENABLE_LINE_INPUT = 0x0002, ENABLE_ECHO_INPUT = 0x0004;
    private const uint ENABLE_WINDOW_INPUT = 0x0008, ENABLE_MOUSE_INPUT = 0x0010;
    private const uint CREATE_NEW_CONSOLE = 0x0010;
    private static readonly nint INVALID = -1;

    // A secret with an ASCII mix, BMP non-ASCII (Ω, ✓), and a surrogate pair (😀) — exercises the
    // "1 UTF-16 code unit = 1 record" claim end-to-end.
    private const string TestSecret = "Pw-Ω✓-😀-9";

    /// CHILD role (`-InjectConsoleChild <ready> <out>`): we run as conhost's client, so we already own a
    /// classic console. Arm echo-off line input, publish our console hwnd via the ready file, cooked-read
    /// one line, and record it. Returns 0 always (the parent judges by the recorded line).
    public static int RunChild(string readyPath, string outPath)
    {
        try
        {
            // Guarantee our OWN console: key-locker.exe is a GUI-subsystem WinExe, which CREATE_NEW_CONSOLE
            // does NOT reliably auto-attach — AllocConsole gives us a fresh classic conhost we fully own.
            FreeConsole(); AllocConsole();
            nint hwnd = GetConsoleWindow();
            nint conin = CreateFileW("CONIN$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, 0, OPEN_EXISTING, 0, 0);
            if (conin == INVALID) { File.WriteAllText(outPath, "<conin-open-failed>"); return 0; }
            GetConsoleMode(conin, out uint mode);
            SetConsoleMode(conin, (mode | ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT) & ~(ENABLE_ECHO_INPUT | ENABLE_MOUSE_INPUT | ENABLE_WINDOW_INPUT));
            File.WriteAllText(readyPath, ((long)hwnd).ToString()); // signal + hand the parent our console hwnd
            var buf = new char[512];
            bool ok = ReadConsoleW(conin, buf, (uint)buf.Length, out uint read, 0);
            File.WriteAllText(outPath, ok ? new string(buf, 0, (int)read).TrimEnd('\r', '\n') : "<readconsole-failed>");
            CloseHandle(conin);
        }
        catch (Exception e) { try { File.WriteAllText(outPath, "<child-exn:" + e.Message + ">"); } catch { } }
        return 0;
    }

    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AllocConsole();

    /// PARENT role: spawn the child under conhost, derive the InjectTarget from the child's console hwnd
    /// exactly as L3 does (`consolePid = GetWindowThreadProcessId(hwnd)`), run the REAL production injector,
    /// and assert the child cooked-read the exact secret. titleFp is left empty (the title anchor is
    /// unchanged pre-existing logic; this test covers the DF-5 attach/write path).
    public static bool Run()
    {
        string tmp = Path.GetTempPath();
        string tag = Convert.ToHexString(RandomNumberGenerator.GetBytes(8));
        string readyPath = Path.Combine(tmp, $"dtm-inj-ready-{tag}.txt");
        string outPath = Path.Combine(tmp, $"dtm-inj-out-{tag}.txt");
        var pi = default(PROCESS_INFORMATION);
        var spawned = false;
        try
        {
            string self = Environment.ProcessPath!;
            var cmd = new StringBuilder($"\"{self}\" -InjectConsoleChild \"{readyPath}\" \"{outPath}\"");
            var si = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>() };
            if (!CreateProcessW(self, cmd, 0, 0, false, CREATE_NEW_CONSOLE, 0, tmp, ref si, out pi)) return false;
            spawned = true;

            if (!PollFile(readyPath, 8000)) return false;
            if (!long.TryParse(File.ReadAllText(readyPath).Trim(), out var hraw) || hraw == 0) return false;
            nint hwnd = (nint)hraw;
            _ = GetWindowThreadProcessId(hwnd, out uint consolePid); // derive exactly as L3 does
            if (consolePid == 0) return false;

            var target = new InjectTarget(hwnd, consolePid, "", true);
            var (injected, _) = Win32Input.ReVerifyAndType(in target, Encoding.UTF8.GetBytes(TestSecret));
            if (!injected) return false;

            WaitForSingleObject(pi.hProcess, 8000);
            if (!PollFile(outPath, 8000)) return false;
            return File.ReadAllText(outPath) == TestSecret;
        }
        catch { return false; }
        finally
        {
            if (spawned)
            {
                // Kill the child if it is still blocked in ReadConsoleW on a FAILURE path (on success the
                // injected Enter already terminated its cooked-read and it exited). Otherwise a failed
                // self-test — e.g. the WT-default `target_multiplexed` case, or `ReVerifyAndType`
                // returning false — orphans a `key-locker.exe` (+ its AllocConsole'd conhost, which
                // self-exits once its last client dies) blocked on input on the CI machine (Codex P2).
                // TerminateProcess on an already-exited process is a harmless no-op.
                try { TerminateProcess(pi.hProcess, 1); } catch { }
                try { CloseHandle(pi.hThread); CloseHandle(pi.hProcess); } catch { }
            }
            foreach (var p in new[] { readyPath, outPath }) { try { if (File.Exists(p)) File.Delete(p); } catch { } }
        }
    }

    private static bool PollFile(string path, int timeoutMs)
    {
        long deadline = Environment.TickCount64 + timeoutMs;
        while (Environment.TickCount64 < deadline)
        {
            if (File.Exists(path)) return true;
            Thread.Sleep(30);
        }
        return File.Exists(path);
    }
}
