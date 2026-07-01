// ADR-014 v2 S1 — cooperative terminal bridge helper (OQ #6 option (C)).
//
// Plan: desktop-touch-mcp-internal@HEAD:docs/adr-014-v2-s1-option-c-design.md
//
// This compiled C# console exe owns the CurrentUserOnly named-pipe SERVER; the
// MCP (Node, src/engine/bridge-host.ts) connects as CLIENT. It runs inside a
// dedicated conhost window so a human can type sudo/ssh passwords directly at the
// pane (crux (a), re-spiked in spike/adr-014-cs-crux) — S1 only stands up the
// server + handshake + ping/version; the interactive `run`/`cancel` child path is
// S2.
//
// Auth (see the design doc §1):
//   * Client direction (the threat-model §8 defense) = KERNEL TRUTH: the server
//     verifies the connected client's PID == -McpPid via GetNamedPipeClientProcessId
//     (a squatter same-user client is rejected). Together with the CurrentUserOnly
//     ACL (cross-user block) this is what §8 rests on.
//   * Server direction is verified on the MCP side by process topology + creation
//     time (Node has no kernel handle for net.connect); this helper simply
//     self-reports its own PID in the `hello` frame so the MCP can match it against
//     the conhost child it captured at spawn.
//
// Wire framing: raw UTF-8 bytes, one JSON object per '\n' line (StreamReader/
// StreamWriter over a NamedPipeStream deadlocked in the Phase 0 spike; raw byte
// framing is reliable). Reads are BUFFERED (fill a buffer, split on '\n') so an
// unbounded `run` payload (S2) is not thousands of 1-byte syscalls.
//   MCP -> helper : {"id":N,"m":"ping|version|shutdown"}
//   helper -> MCP : {"t":"hello","pid":<helperPid>,"v":"<proto>"}   (first frame)
//                   {"id":N,"ok":true,"r":"..."}                     (replies)

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

internal static class BridgeHost
{
    // Protocol version — bumped when the wire contract changes. The MCP reads this
    // from the `hello` frame and can refuse an incompatible helper.
    private const string ProtocolVersion = "1";

    // A squatter client that connects before the real MCP is rejected; bound the
    // reject loop so a hostile local process cannot wedge the helper forever (R-C).
    private const int MaxClientRejects = 8;

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(IntPtr Pipe, out uint ClientProcessId);

    // NOTE: S1 is HEADLESS (no console window). The MCP direct-spawns this helper
    // detached; the pipe server + kernel client-verify + hello/ping/version are all
    // launch-method-independent (the S1 locked contract). The DEDICATED console
    // window a human types passwords into (crux (a)) is S2, via a C# self-bootstrap
    // that re-execs under `conhost.exe` with CREATE_NEW_CONSOLE (a shared Windows
    // Terminal tab, e.g. from AllocConsole, is the phase-0 a2 input-misroute case
    // and is deliberately NOT used).

    private static int Main(string[] args)
    {
        string? pipeName = null;
        uint mcpPid = 0;
        for (var i = 0; i + 1 < args.Length; i++)
        {
            switch (args[i])
            {
                case "-PipeName": pipeName = args[i + 1]; break;
                case "-McpPid": _ = uint.TryParse(args[i + 1], out mcpPid); break;
            }
        }
        if (string.IsNullOrEmpty(pipeName))
        {
            Console.Error.WriteLine("bridge-host: missing -PipeName");
            return 2;
        }
        if (mcpPid == 0)
        {
            Console.Error.WriteLine("bridge-host: missing/invalid -McpPid");
            return 2;
        }

        var helperPid = Environment.ProcessId;
        try { Console.Title = "desktop-touch bridge"; } catch { /* ignore */ }
        Console.WriteLine($"[bridge-host] pid={helperPid} pipe={pipeName} — cooperative terminal helper (S1 headless).");

        NamedPipeServerStream server;
        try
        {
            // CurrentUserOnly => a different-user client cannot connect (the §8
            // cross-user guarantee, enforced by the OS DACL). maxInstances=1 makes
            // .NET pass FILE_FLAG_FIRST_PIPE_INSTANCE, so if a squatter already
            // created this (unguessable) name our create FAILS LOUD here instead of
            // silently attaching to their pipe — the MCP then sees us die and aborts.
            server = new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                maxNumberOfServerInstances: 1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        }
        catch (Exception e)
        {
            // Fail loud: most likely the name already exists (squatter) or an ACL
            // problem. Do NOT fall back to a permissive pipe.
            Console.Error.WriteLine($"bridge-host: pipe create failed (name taken / not fresh?): {e.Message}");
            return 3;
        }

        try
        {
            if (!WaitForVerifiedClient(server, mcpPid, helperPid))
            {
                Console.Error.WriteLine("bridge-host: no authorized client connected; exiting.");
                return 4;
            }

            // First frame: self-report identity so the MCP can match this PID against
            // the conhost child it captured at spawn (server-topology verify).
            WriteFrame(server, $"{{\"t\":\"hello\",\"pid\":{helperPid},\"v\":\"{ProtocolVersion}\"}}");

            RunControlLoop(server, helperPid);
            return 0;
        }
        finally
        {
            try { server.Dispose(); } catch { /* ignore */ }
            Console.WriteLine("[bridge-host] exit.");
        }
    }

    /// Accept connections until the connected client's kernel PID == mcpPid, or the
    /// reject budget is exhausted. A squatter client that connects first is dropped.
    private static bool WaitForVerifiedClient(NamedPipeServerStream server, uint mcpPid, int helperPid)
    {
        for (var attempt = 0; attempt <= MaxClientRejects; attempt++)
        {
            server.WaitForConnection();
            uint clientPid = 0;
            var ok = GetNamedPipeClientProcessId(server.SafePipeHandle.DangerousGetHandle(), out clientPid);
            if (ok && clientPid == mcpPid)
            {
                Console.WriteLine($"[bridge-host] client verified: clientPid={clientPid} == McpPid.");
                return true;
            }

            Console.Error.WriteLine(
                $"[bridge-host] rejecting client: getOk={ok} clientPid={clientPid} expected McpPid={mcpPid} " +
                $"(attempt {attempt + 1}/{MaxClientRejects + 1}).");
            try { server.Disconnect(); } catch { /* ignore, loop and re-wait */ }
        }
        return false;
    }

    /// Read '\n'-framed JSON control requests and answer ping/version/shutdown.
    private static void RunControlLoop(NamedPipeServerStream server, int helperPid)
    {
        var reader = new FramedReader(server);
        while (true)
        {
            var line = reader.ReadLine();
            if (line == null) { Console.WriteLine("[bridge-host] pipe closed by MCP."); break; }
            if (line.Length == 0) continue;

            long id = -1;
            string method = "";
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                if (root.TryGetProperty("id", out var idEl) && idEl.TryGetInt64(out var idv)) id = idv;
                if (root.TryGetProperty("m", out var mEl)) method = mEl.GetString() ?? "";
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"[bridge-host] bad frame: {e.Message}");
                WriteReply(server, id, false, "", "bad_json");
                continue;
            }

            switch (method)
            {
                case "ping":
                    WriteReply(server, id, true, "pong", null);
                    break;
                case "version":
                    WriteReply(server, id, true, ProtocolVersion, null);
                    break;
                case "shutdown":
                    WriteReply(server, id, true, "bye", null);
                    return;
                default:
                    WriteReply(server, id, false, "", $"unknown_method:{method}");
                    break;
            }
        }
    }

    private static void WriteReply(Stream s, long id, bool ok, string result, string? err)
    {
        var sb = new StringBuilder(64);
        sb.Append("{\"id\":").Append(id).Append(",\"ok\":").Append(ok ? "true" : "false");
        sb.Append(",\"r\":").Append(JsonEncodedString(result));
        if (err != null) sb.Append(",\"e\":").Append(JsonEncodedString(err));
        sb.Append('}');
        WriteFrame(s, sb.ToString());
    }

    private static string JsonEncodedString(string v)
    {
        // Reuse System.Text.Json for correct escaping of arbitrary content.
        return JsonSerializer.Serialize(v);
    }

    private static void WriteFrame(Stream s, string json)
    {
        var b = Encoding.UTF8.GetBytes(json + "\n");
        s.Write(b, 0, b.Length);
        s.Flush();
    }

    /// Buffered raw-byte line reader: fills a buffer and splits on '\n', so a large
    /// inbound frame (S2 `run`) costs O(bytes) not O(1-byte syscalls). Strips a
    /// trailing '\r'. Returns null on pipe close.
    private sealed class FramedReader
    {
        private readonly Stream _s;
        private readonly byte[] _buf = new byte[4096];
        private int _len;
        private int _pos;

        public FramedReader(Stream s) { _s = s; }

        public string? ReadLine()
        {
            var line = new List<byte>(128);
            while (true)
            {
                if (_pos >= _len)
                {
                    _len = _s.Read(_buf, 0, _buf.Length);
                    _pos = 0;
                    if (_len == 0) return null; // pipe closed
                }
                var b = _buf[_pos++];
                if (b == (byte)'\n')
                {
                    if (line.Count > 0 && line[line.Count - 1] == (byte)'\r') line.RemoveAt(line.Count - 1);
                    return Encoding.UTF8.GetString(line.ToArray());
                }
                line.Add(b);
            }
        }
    }
}
