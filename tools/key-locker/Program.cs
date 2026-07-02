// ADR-014 v2 R3 Key Locker — L0 trunk (the locker process).
//
// Plan: desktop-touch-mcp-internal@main:docs/adr-014-v2-r3-slice-plan.md (L0)
//
// The locker is a compiled C# component (D6) — a SEPARATE process from any pwsh pane, so
// the DPAPI-decrypted plaintext lives only here. L0 stands up the TRUST BOUNDARY:
//   1. a CurrentUserOnly named-pipe SERVER, auth = the S1 bridge-host pattern
//      (FILE_FLAG_FIRST_PIPE_INSTANCE fail-loud + kernel client-verify
//      GetNamedPipeClientProcessId == -McpPid + a 128-bit unguessable name from -PipeName);
//   2. a DPAPI (CurrentUser) at-rest store — the "value envelope" only (opaque ids;
//      the binding-KEY schema is L1);
//   3. a WPF PasswordBox SECURE CAPTURE DIALOG — D1-spike-proven un-capturable by the MCP's
//      own read paths (no UIA value, masked, no clipboard). The engine additionally
//      tool-EXCLUDES this process's windows by PID (L0 engine side).
//
// The SECRET never crosses the pipe: it is entered into the dialog (locker-local) and only
// its DPAPI-encrypted form is persisted. The pipe carries opaque ids + control, never the
// secret. Retrieve/inject is L2; capture-on-use + landed-detection is L3.
//
// Wire (mirrors S1): raw UTF-8, one JSON object per '\n' line, buffered read.
//   MCP -> locker : {"id":N,"m":"ping|version|capture|exists|delete|shutdown","k":"<opaqueId>"}
//   locker -> MCP : {"t":"hello","pid":<pid>,"v":"<proto>"}                    (first frame)
//                   {"id":N,"ok":true,"r":"...","captured":true,"rt":true}     (replies)
//
// Test seams (no pipe, no GUI): `key-locker.exe -SelfTest -StoreDir <dir>` runs a headless
// DPAPI round-trip + corrupt-tag-rejection check and prints a JSON result.

using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;

internal static class KeyLocker
{
    private const string ProtocolVersion = "1";
    private const int MaxClientRejects = 8;

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(IntPtr Pipe, out uint ClientProcessId);

    private static LockerStore _store = null!;
    private static ServingRegistry _serving = null!;
    private static Application? _app;

    [System.STAThread]
    private static int Main(string[] args)
    {
        string? pipeName = null;
        uint mcpPid = 0;
        string? storeDir = null;
        var selfTest = false;
        var selfTestL2 = false;
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "-PipeName" when i + 1 < args.Length: pipeName = args[++i]; break;
                case "-McpPid" when i + 1 < args.Length: _ = uint.TryParse(args[++i], out mcpPid); break;
                case "-StoreDir" when i + 1 < args.Length: storeDir = args[++i]; break;
                case "-SelfTest": selfTest = true; break;
                case "-SelfTestL2": selfTestL2 = true; break;
            }
        }

        storeDir ??= Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "desktop-touch-mcp", "locker");
        _store = new LockerStore(storeDir);
        _serving = new ServingRegistry(_store);

        // Headless DPAPI test seam — no pipe, no GUI. Proves L0 acceptance (round-trip +
        // corrupt-tag rejection) deterministically from a unit/e2e test.
        if (selfTest) return RunSelfTest();

        // Headless L2 serving-path seam — proves the ticket + serving-pipe contract (valid fetch,
        // single-use, forged/context_mismatch refused) without live ssh/git.
        if (selfTestL2)
        {
            var ok = _serving.SelfTest();
            Console.WriteLine(JsonSerializer.Serialize(new { ok }));
            return ok ? 0 : 1;
        }

        if (string.IsNullOrEmpty(pipeName)) { Console.Error.WriteLine("key-locker: missing -PipeName"); return 2; }
        if (mcpPid == 0) { Console.Error.WriteLine("key-locker: missing/invalid -McpPid"); return 2; }

        NamedPipeServerStream server;
        try
        {
            // CurrentUserOnly => cross-user block (OS DACL). maxInstances=1 => the .NET runtime
            // sets FILE_FLAG_FIRST_PIPE_INSTANCE (NamedPipeServerStream.Windows.cs computes
            // `openMode |= (maxNumberOfServerInstances == 1 ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0)`),
            // so if a squatter already created this (unguessable) name our create FAILS LOUD here
            // (ERROR_ACCESS_DENIED -> exception -> return 3) instead of attaching to theirs — the MCP
            // sees us die and aborts. This holds even when the squatter pre-created a MULTI-INSTANCE
            // pipe (MaxAllowedServerInstances): our maxInstances=1 create is still refused (first-
            // instance semantics + instance-count mismatch). Verified empirically + pinned by the
            // "MULTI-INSTANCE squatter" e2e (tests/e2e/key-locker.e2e.test.ts). (S1 §8; server-verify
            // is demoted/infeasible for the Node client — it cannot get the pipe's OS handle.)
            server = new NamedPipeServerStream(
                pipeName, PipeDirection.InOut, 1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"key-locker: pipe create failed (name taken / not fresh?): {e.Message}");
            return 3;
        }

        try
        {
            if (!WaitForVerifiedClient(server, mcpPid))
            {
                Console.Error.WriteLine("key-locker: no authorized client connected; exiting.");
                return 4;
            }

            WriteFrame(server, $"{{\"t\":\"hello\",\"pid\":{Environment.ProcessId},\"v\":\"{ProtocolVersion}\"}}");

            // WPF needs an STA dispatcher for the secure dialog. Run the pipe control loop on
            // a background thread; pump the dispatcher on this (main STA) thread so `capture`
            // can marshal the dialog onto the UI thread. No main window => headless until capture.
            _app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            var loop = new Thread(() =>
            {
                try { RunControlLoop(server); }
                finally { try { _app.Dispatcher.Invoke(() => _app.Shutdown()); } catch { /* app already gone */ } }
            }) { IsBackground = true, Name = "locker-pipe" };
            loop.SetApartmentState(ApartmentState.MTA);
            loop.Start();
            _app.Run();
            return 0;
        }
        finally
        {
            try { server.Dispose(); } catch { /* ignore */ }
        }
    }

    private static bool WaitForVerifiedClient(NamedPipeServerStream server, uint mcpPid)
    {
        for (var attempt = 0; attempt <= MaxClientRejects; attempt++)
        {
            try { server.WaitForConnection(); }
            catch (Exception e) { Console.Error.WriteLine($"[key-locker] WaitForConnection failed: {e.Message}"); return false; }

            var ok = GetNamedPipeClientProcessId(server.SafePipeHandle.DangerousGetHandle(), out var clientPid);
            if (ok && clientPid == mcpPid) return true;

            Console.Error.WriteLine($"[key-locker] rejecting client: getOk={ok} clientPid={clientPid} expected={mcpPid} (attempt {attempt + 1}).");
            try { server.Disconnect(); } catch { /* loop + re-wait */ }
        }
        return false;
    }

    private static void RunControlLoop(NamedPipeServerStream server)
    {
        var reader = new FramedReader(server);
        while (true)
        {
            var line = reader.ReadLine();
            if (line == null) break; // pipe closed by MCP
            if (line.Length == 0) continue;

            long id = -1; string method = ""; string key = "";
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                if (root.TryGetProperty("id", out var idEl) && idEl.TryGetInt64(out var idv)) id = idv;
                if (root.TryGetProperty("m", out var mEl)) method = mEl.GetString() ?? "";
                if (root.TryGetProperty("k", out var kEl)) key = kEl.GetString() ?? "";
            }
            catch (Exception e) { Console.Error.WriteLine($"[key-locker] bad frame: {e.Message}"); WriteReply(server, id, false, "", "bad_json"); continue; }

            switch (method)
            {
                case "ping": WriteReply(server, id, true, "pong", null); break;
                case "version": WriteReply(server, id, true, ProtocolVersion, null); break;
                case "capture": HandleCapture(server, id, key); break;
                case "exists": WriteReply(server, id, true, _store.Exists(key) ? "1" : "0", null); break;
                case "delete": WriteReply(server, id, true, _store.Delete(key) ? "1" : "0", null); break;
                case "inject": HandleInject(server, id, key, line); break;
                case "mint_ticket": HandleMintTicket(server, id, key, line); break;
                case "shutdown": WriteReply(server, id, true, "bye", null); return;
                default: WriteReply(server, id, false, "", $"unknown_method:{method}"); break;
            }
        }
    }

    /// Show the secure dialog on the UI thread, capture a secret, DPAPI-store it under the
    /// opaque key, and internally round-trip-verify it — WITHOUT the secret ever crossing the
    /// pipe. Reply reports captured + round-trip-ok booleans only.
    private static void HandleCapture(NamedPipeServerStream server, long id, string key)
    {
        if (string.IsNullOrEmpty(key)) { WriteReply(server, id, false, "", "missing_key"); return; }
        string? secret = null;
        try { secret = _app!.Dispatcher.Invoke(() => SecureDialog.Prompt(key)); }
        catch (Exception e) { Console.Error.WriteLine($"[key-locker] dialog failed: {e.Message}"); }

        if (secret == null) { WriteFrameReplyCaptured(server, id, false, false); return; }
        _store.Capture(key, secret);
        var rt = _store.RoundTripOk(key, secret); // in-process verify; secret stays local
        WriteFrameReplyCaptured(server, id, true, rt);
    }

    /// SendInput the secret under `key` into the frame's dedicated-conhost target, AFTER the
    /// injection-instant re-verify (§2.2). The secret NEVER crosses the pipe — the reply carries
    /// only {injected, verified}; an abort carries the typed reason. The plaintext is decrypted
    /// transiently inside the locker and zeroized (WithDecrypted).
    private static void HandleInject(NamedPipeServerStream server, long id, string key, string line)
    {
        if (string.IsNullOrEmpty(key)) { WriteReply(server, id, false, "", InjectAbort.NoSecret); return; }
        InjectTarget target;
        try
        {
            using var doc = JsonDocument.Parse(line);
            if (!doc.RootElement.TryGetProperty("t", out var t) || t.ValueKind != JsonValueKind.Object)
            { WriteReply(server, id, false, "", "bad_target"); return; }
            target = new InjectTarget(
                Hwnd: (nint)ParseLong(t, "hwnd"),
                ConsolePid: (uint)ParseLong(t, "consolePid"),
                TitleFp: t.TryGetProperty("titleFp", out var fp) && fp.ValueKind == JsonValueKind.String ? fp.GetString() ?? "" : "",
                Submit: t.TryGetProperty("submit", out var sub) && sub.ValueKind == JsonValueKind.True);
        }
        catch { WriteReply(server, id, false, "", "bad_target"); return; }

        string? abort = InjectAbort.NoSecret;
        var injected = false;
        var found = _store.WithDecrypted(key, plain =>
        {
            (injected, abort) = Win32Input.ReVerifyAndType(in target, plain);
        });
        if (!found) { WriteReply(server, id, false, "", InjectAbort.NoSecret); return; }
        if (!injected) { WriteReply(server, id, false, "", abort ?? "executor_failed"); return; }
        WriteFrame(server, $"{{\"id\":{id},\"ok\":true,\"r\":\"\",\"injected\":true,\"verified\":true}}");
    }

    /// Mint a single-use ticket + per-injection serving pipe for the askpass helper to fetch the
    /// secret under `key` (§3). The ticket + pipe name are NON-secret; the secret only ever flows
    /// locker->helper on the serving pipe. `ctx` (git credential fields) binds the ticket for
    /// serve-time context_mismatch.
    private static void HandleMintTicket(NamedPipeServerStream server, long id, string key, string line)
    {
        if (string.IsNullOrEmpty(key)) { WriteReply(server, id, false, "", InjectAbort.NoSecret); return; }
        JsonElement ctx = default;
        try
        {
            using var doc = JsonDocument.Parse(line);
            if (doc.RootElement.TryGetProperty("ctx", out var c)) ctx = c.Clone();
        }
        catch { /* ctx optional; treat parse failure as no ctx */ }

        var minted = _serving.Mint(key, ctx);
        if (minted == null) { WriteReply(server, id, false, "", InjectAbort.NoSecret); return; }
        WriteFrame(server, $"{{\"id\":{id},\"ok\":true,\"r\":{JsonSerializer.Serialize(minted.Value.ticket)},\"pipe\":{JsonSerializer.Serialize(minted.Value.pipe)}}}");
    }

    private static long ParseLong(JsonElement obj, string name)
    {
        if (!obj.TryGetProperty(name, out var v)) return 0;
        return v.ValueKind switch
        {
            JsonValueKind.Number => v.GetInt64(),
            JsonValueKind.String => long.TryParse(v.GetString(), out var n) ? n : 0,
            _ => 0,
        };
    }

    private static int RunSelfTest()
    {
        // Headless: encrypt -> persist -> decrypt -> verify, plus corrupt-tag rejection.
        var id = "selftest-" + Guid.NewGuid().ToString("N");
        var secret = "DPAPI-ROUNDTRIP-" + Guid.NewGuid().ToString("N");
        _store.Capture(id, secret);
        var roundTrip = _store.RoundTripOk(id, secret);
        var wrongValueRejected = !_store.RoundTripOk(id, secret + "X");   // decrypt ok, value mismatch
        var corruptRejected = _store.CorruptAndCheckRejected(id);         // tamper -> decrypt fails
        _store.Delete(id);
        var ok = roundTrip && wrongValueRejected && corruptRejected;
        Console.WriteLine(JsonSerializer.Serialize(new { ok, roundTrip, wrongValueRejected, corruptRejected }));
        return ok ? 0 : 1;
    }

    private static void WriteFrameReplyCaptured(Stream s, long id, bool captured, bool rt)
        => WriteFrame(s, $"{{\"id\":{id},\"ok\":true,\"r\":\"\",\"captured\":{(captured ? "true" : "false")},\"rt\":{(rt ? "true" : "false")}}}");

    private static void WriteReply(Stream s, long id, bool ok, string result, string? err)
    {
        var sb = new StringBuilder(64);
        sb.Append("{\"id\":").Append(id).Append(",\"ok\":").Append(ok ? "true" : "false");
        sb.Append(",\"r\":").Append(JsonSerializer.Serialize(result));
        if (err != null) sb.Append(",\"e\":").Append(JsonSerializer.Serialize(err));
        sb.Append('}');
        WriteFrame(s, sb.ToString());
    }

    private static void WriteFrame(Stream s, string json)
    {
        var b = Encoding.UTF8.GetBytes(json + "\n");
        s.Write(b, 0, b.Length);
        s.Flush();
    }

    /// Buffered raw-byte '\n' line reader (S1 pattern). Returns null on pipe close.
    private sealed class FramedReader
    {
        private readonly Stream _s;
        private readonly byte[] _buf = new byte[4096];
        private int _len, _pos;
        public FramedReader(Stream s) { _s = s; }
        public string? ReadLine()
        {
            var line = new List<byte>(128);
            while (true)
            {
                if (_pos >= _len) { _len = _s.Read(_buf, 0, _buf.Length); _pos = 0; if (_len == 0) return null; }
                var b = _buf[_pos++];
                if (b == (byte)'\n')
                {
                    if (line.Count > 0 && line[^1] == (byte)'\r') line.RemoveAt(line.Count - 1);
                    return Encoding.UTF8.GetString(line.ToArray());
                }
                line.Add(b);
            }
        }
    }
}

/// The DPAPI (CurrentUser) at-rest store — L0 freezes the VALUE ENVELOPE only (opaque id ->
/// DPAPI-wrapped value). The binding-KEY schema (URI / ssh fingerprint) is L1 and must slot
/// into this envelope without amending it.
internal sealed class LockerStore
{
    private const int Version = 1;
    // App-specific optionalEntropy: binds the blob to this app + user; a blob copied to
    // another app/context won't decrypt. (DPAPI itself provides integrity — tamper => throw.)
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("desktop-touch-mcp/key-locker/v1");

    private readonly string _path;
    private readonly Dictionary<string, string> _entries = new(StringComparer.Ordinal); // id -> base64(DPAPI blob)

    public LockerStore(string dir)
    {
        Directory.CreateDirectory(dir);
        _path = Path.Combine(dir, "store.json");
        Load();
    }

    private void Load()
    {
        if (!File.Exists(_path)) return;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(_path));
            if (doc.RootElement.TryGetProperty("entries", out var e) && e.ValueKind == JsonValueKind.Object)
                foreach (var p in e.EnumerateObject()) _entries[p.Name] = p.Value.GetString() ?? "";
        }
        catch { /* corrupt store file -> start empty rather than crash */ }
    }

    private void Save()
    {
        var json = JsonSerializer.Serialize(new StoreShape { version = Version, entries = _entries });
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, json);
        File.Move(tmp, _path, overwrite: true); // atomic replace
    }

    public void Capture(string id, string secret)
    {
        var blob = ProtectedData.Protect(Encoding.UTF8.GetBytes(secret), Entropy, DataProtectionScope.CurrentUser);
        _entries[id] = Convert.ToBase64String(blob);
        Save();
    }

    public bool Exists(string id) => _entries.ContainsKey(id);

    public bool Delete(string id) { var r = _entries.Remove(id); if (r) Save(); return r; }

    /// In-process round-trip: decrypt the stored blob and compare to `expected`. Any DPAPI
    /// integrity/decrypt failure returns false (never throws to the caller). The secret is
    /// NOT returned — only the boolean.
    public bool RoundTripOk(string id, string expected)
    {
        if (!_entries.TryGetValue(id, out var b64)) return false;
        try
        {
            var plain = ProtectedData.Unprotect(Convert.FromBase64String(b64), Entropy, DataProtectionScope.CurrentUser);
            return CryptographicOperations.FixedTimeEquals(plain, Encoding.UTF8.GetBytes(expected));
        }
        catch { return false; } // corrupt/tampered blob -> reject
    }

    /// Transiently decrypt the stored secret and hand the plaintext BYTES to `use`, then zeroize
    /// the buffer — the plaintext lives only for the callback and NEVER leaves the locker process
    /// (L2 §0 invariant). Returns false if the id is absent or the blob won't decrypt. Used by the
    /// SendInput injector and the askpass serving path.
    public bool WithDecrypted(string id, Action<byte[]> use)
    {
        if (!_entries.TryGetValue(id, out var b64)) return false;
        byte[]? plain = null;
        try
        {
            plain = ProtectedData.Unprotect(Convert.FromBase64String(b64), Entropy, DataProtectionScope.CurrentUser);
            use(plain);
            return true;
        }
        catch { return false; } // corrupt/tampered blob -> reject
        finally { if (plain != null) CryptographicOperations.ZeroMemory(plain); }
    }

    /// Tamper with a stored blob and confirm decrypt now fails (DPAPI integrity). Used by the
    /// self-test to prove "corrupt tag -> reject".
    public bool CorruptAndCheckRejected(string id)
    {
        if (!_entries.TryGetValue(id, out var b64)) return false;
        var blob = Convert.FromBase64String(b64);
        blob[^1] ^= 0xFF; // flip the last byte
        try { _ = ProtectedData.Unprotect(blob, Entropy, DataProtectionScope.CurrentUser); return false; } // should NOT succeed
        catch { return true; } // decrypt failed on tamper -> integrity holds
    }

    private sealed class StoreShape
    {
        public int version { get; set; }
        public Dictionary<string, string> entries { get; set; } = new();
    }
}

/// The WPF secure capture dialog — a PasswordBox (D1-spike-proven un-capturable: no UIA value,
/// masked, no clipboard copy). Runs on the STA UI thread. Returns the entered secret or null
/// (cancel). The secret is returned IN-PROCESS only; it never crosses the pipe.
internal static class SecureDialog
{
    public static string? Prompt(string bindingLabel)
    {
        string? result = null;
        var pwd = new PasswordBox { Margin = new Thickness(10, 4, 10, 12), FontSize = 18, Width = 360 };
        var ok = new Button { Content = "Save", Width = 90, Margin = new Thickness(4), IsDefault = true };
        var cancel = new Button { Content = "Cancel", Width = 90, Margin = new Thickness(4), IsCancel = true };

        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        buttons.Children.Add(ok);
        buttons.Children.Add(cancel);

        var panel = new StackPanel { Margin = new Thickness(14) };
        panel.Children.Add(new Label { Content = "desktop-touch key locker — secret entry", FontWeight = FontWeights.Bold });
        panel.Children.Add(new TextBlock { Text = $"Enter the secret for:  {bindingLabel}", Margin = new Thickness(10, 6, 10, 4), TextWrapping = TextWrapping.Wrap });
        panel.Children.Add(pwd);
        panel.Children.Add(buttons);

        var win = new Window
        {
            Title = "desktop-touch key locker",
            Content = panel,
            SizeToContent = SizeToContent.WidthAndHeight,
            ResizeMode = ResizeMode.NoResize,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            Topmost = true,
            ShowInTaskbar = false,
        };
        ok.Click += (_, _) => { result = pwd.Password; win.DialogResult = true; };
        win.Loaded += (_, _) => { win.Activate(); pwd.Focus(); };
        var dr = win.ShowDialog();
        return dr == true ? result : null;
    }
}
