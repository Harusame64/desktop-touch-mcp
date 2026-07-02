// ADR-014 v2 R3 Key Locker — L2 injection (C# side): the SendInput injector with injection-instant
// re-verify, and the askpass serving path (single-use ticket + per-injection serving pipe).
//
// Plan: desktop-touch-mcp-internal@<plan>:docs/adr-014-v2-r3-l2-injection-plan.md (§2, §3)
//
// The secret NEVER crosses the control pipe and never reaches Node: SendInput happens HERE (the
// locker holds the plaintext); the askpass helper fetches it over a SEPARATE serving pipe this file
// creates. Plaintext is decrypted transiently (LockerStore.WithDecrypted) and zeroized after use.

using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

// Global namespace (matches Program.cs's `internal static class KeyLocker`; a `namespace KeyLocker`
// here would collide with that class name).

/// The dedicated-conhost target of a SendInput, parsed off the `inject` frame's `t` field (§2.1).
internal readonly record struct InjectTarget(nint Hwnd, uint ConsolePid, string TitleFp, bool Submit);

/// The abort reasons the re-verify predicate can raise (§2.2); null = passed.
internal static class InjectAbort
{
    public const string Gone = "target_gone";
    public const string Multiplexed = "target_multiplexed";
    public const string NotForeground = "not_foreground";
    public const string Mismatch = "target_mismatch";
    public const string NoSecret = "no_secret";
}

/// Win32 SendInput + the injection-instant re-verify (§2.2). Foreground-routed input demands the
/// target be re-checked at the SEND instant, inside the locker, immediately before the first key.
internal static class Win32Input
{
    private const string ConsoleClass = "ConsoleWindowClass"; // the classic conhost window class

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public nint dwExtraInfo; }

    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const ushort VK_RETURN = 0x0D;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, [In] INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool IsWindow(nint hWnd);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint GetWindowThreadProcessId(nint hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern int GetClassName(nint hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(nint hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(nint hWnd);

    /// Re-verify the target at the injection instant (§2.2). Returns an InjectAbort code on any
    /// mismatch, or null if all predicates pass. POSITIVE allowlist: the window MUST be the classic
    /// console class AND owned by the tracked conhost pid — anything else is `target_multiplexed`.
    private static string? ReVerify(in InjectTarget t)
    {
        if (t.Hwnd == 0 || !IsWindow(t.Hwnd)) return InjectAbort.Gone;

        var cls = new StringBuilder(64);
        GetClassName(t.Hwnd, cls, cls.Capacity);
        if (cls.ToString() != ConsoleClass) return InjectAbort.Multiplexed;

        _ = GetWindowThreadProcessId(t.Hwnd, out var pid);
        if (pid == 0) return InjectAbort.Gone;
        if (pid != t.ConsolePid) return InjectAbort.Multiplexed;

        if (GetForegroundWindow() != t.Hwnd) return InjectAbort.NotForeground;

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

    /// Build the keystrokes, re-verify the target at the LAST moment, then type the secret + Enter
    /// if `submit`. Returns (injected, abortCode). BOTH plaintext-bearing buffers — the decoded
    /// char[] AND the INPUT[] (the secret lives in each `KEYBDINPUT.wScan`) — are zeroized in the
    /// finally, upholding §2.2 step 5's zeroize discipline (Opus R1 P2-1). Building into a sized
    /// INPUT[] (not a List) avoids a hidden backing-array copy that would survive uncleared.
    public static (bool injected, string? abort) ReVerifyAndType(in InjectTarget t, byte[] secret)
    {
        char[] chars = Encoding.UTF8.GetChars(secret);
        var n = chars.Length * 2 + (t.Submit ? 2 : 0);
        var arr = new INPUT[n];
        try
        {
            var j = 0;
            foreach (var ch in chars) { arr[j++] = UnicodeKey(ch, false); arr[j++] = UnicodeKey(ch, true); }
            if (t.Submit) { arr[j++] = VkKey(VK_RETURN, false); arr[j++] = VkKey(VK_RETURN, true); }

            // Re-verify IMMEDIATELY before the send — the tightest TOCTOU window (Opus R1 P3-2). An
            // abort here types nothing; the built (secret-bearing) INPUT[] is still zeroized below.
            var abort = ReVerify(in t);
            if (abort != null) return (false, abort);

            var sent = SendInput((uint)arr.Length, arr, Marshal.SizeOf<INPUT>());
            return (sent == (uint)arr.Length, sent == (uint)arr.Length ? null : "executor_failed");
        }
        finally
        {
            Array.Clear(chars, 0, chars.Length);
            Array.Clear(arr, 0, arr.Length); // the INPUT[] holds the secret in each wScan
        }
    }

    private static INPUT UnicodeKey(char ch, bool up) => new()
    {
        type = INPUT_KEYBOARD,
        U = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0) } },
    };
    private static INPUT VkKey(ushort vk, bool up) => new()
    {
        type = INPUT_KEYBOARD,
        U = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = up ? KEYEVENTF_KEYUP : 0 } },
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
    /// single-use (replay refused), forged ticket refused, git context_mismatch refused. SendInput
    /// needs a live foreground conhost and is exercised by the e2e suite, not here.
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
