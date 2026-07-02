// ADR-014 v2 R3 Key Locker — L2 askpass streaming helper (the exe ssh/git spawn).
//
// Plan: desktop-touch-mcp-internal@<plan>:docs/adr-014-v2-r3-l2-injection-plan.md (§3)
//
// Two invocation modes:
//   * SSH_ASKPASS  — ssh runs us with the prompt text as argv[0..]; we stream the secret to stdout.
//   * git credential-helper — git runs us as `key-askpass credential <get|store|erase>` and pipes a
//     request on stdin (protocol/host/path/username lines); on `get` we emit `password=…` (+ a
//     `username=…` per the §3.2 precedence). `store`/`erase` are no-ops (the locker owns save; L3
//     owns lifecycle).
//
// Secret path: we connect (C#-client) to the locker's per-injection SERVING pipe whose name +
// single-use ticket arrive in env (DTM_LOCKER_PIPE / DTM_ASKPASS_TICKET). We send the ticket (+ the
// git context for a git `get`), read the secret bytes, and hand them to ssh/git. Plaintext never
// touches disk; the MCP is not on this path.

using System.IO.Pipes;
using System.Text;
using System.Text.Json;

internal static class KeyAskpass
{
    private const int ConnectTimeoutMs = 5000;

    private static int Main(string[] args)
    {
        try
        {
            // git credential-helper: `key-askpass credential <op>` with the request on stdin.
            if (args.Length >= 2 && args[0] == "credential")
                return RunGitCredential(args[1]);

            // Otherwise SSH_ASKPASS: stream the secret straight to stdout.
            return RunSshAskpass();
        }
        catch
        {
            // Fail closed: emit nothing (ssh/git then treats it as no credential).
            return 1;
        }
    }

    /// Fetch the secret from the locker serving pipe. Returns the raw bytes, or null on any failure
    /// (no ticket/pipe env, connect timeout, empty serve). `ctx` is the git get-context lines to
    /// present for context validation (null for ssh askpass).
    private static byte[]? FetchSecret(Dictionary<string, string>? ctx)
    {
        var pipe = Environment.GetEnvironmentVariable("DTM_LOCKER_PIPE");
        var ticket = Environment.GetEnvironmentVariable("DTM_ASKPASS_TICKET");
        if (string.IsNullOrEmpty(pipe) || string.IsNullOrEmpty(ticket)) return null;

        using var client = new NamedPipeClientStream(".", pipe, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        try { client.Connect(ConnectTimeoutMs); } catch { return null; }

        // Request frame: {ticket, [protocol, host, path]} — one UTF-8 line.
        var req = new Dictionary<string, string> { ["ticket"] = ticket! };
        if (ctx != null) foreach (var kv in ctx) req[kv.Key] = kv.Value;
        var line = JsonSerializer.Serialize(req) + "\n";
        var reqBytes = Encoding.UTF8.GetBytes(line);
        client.Write(reqBytes, 0, reqBytes.Length);
        client.Flush();

        // The locker streams the secret bytes then closes.
        using var ms = new MemoryStream();
        client.CopyTo(ms);
        return ms.Length > 0 ? ms.ToArray() : null;
    }

    private static int RunSshAskpass()
    {
        var secret = FetchSecret(null);
        if (secret == null) return 1;
        try
        {
            using var stdout = Console.OpenStandardOutput();
            stdout.Write(secret, 0, secret.Length);
            stdout.WriteByte((byte)'\n'); // ssh expects a trailing newline
            stdout.Flush();
            return 0;
        }
        finally { Array.Clear(secret, 0, secret.Length); }
    }

    private static int RunGitCredential(string op)
    {
        // git only ever needs us to answer `get`; `store`/`erase` are no-ops (exit 0).
        if (op != "get") return 0;

        // Parse git's request (key=value lines, blank line terminates).
        var req = new Dictionary<string, string>(StringComparer.Ordinal);
        string? l;
        while (!string.IsNullOrEmpty(l = Console.ReadLine()))
        {
            var eq = l.IndexOf('=');
            if (eq > 0) req[l[..eq]] = l[(eq + 1)..];
        }

        var ctx = new Dictionary<string, string>();
        if (req.TryGetValue("protocol", out var proto)) ctx["protocol"] = proto;
        if (req.TryGetValue("host", out var host)) ctx["host"] = host;
        if (req.TryGetValue("path", out var path)) ctx["path"] = path;

        var secret = FetchSecret(ctx);
        if (secret == null) return 1; // no credential -> git falls back / prompts

        try
        {
            // Username precedence (§3.2): echo git's own → env DTM_GIT_USERNAME → omit (password-only).
            var username = req.TryGetValue("username", out var u) && u.Length > 0
                ? u
                : Environment.GetEnvironmentVariable("DTM_GIT_USERNAME");
            var sb = new StringBuilder();
            if (!string.IsNullOrEmpty(username)) sb.Append("username=").Append(username).Append('\n');
            sb.Append("password=").Append(Encoding.UTF8.GetString(secret)).Append('\n');
            Console.Out.Write(sb.ToString());
            Console.Out.Flush();
            return 0;
        }
        finally { Array.Clear(secret, 0, secret.Length); }
    }
}
