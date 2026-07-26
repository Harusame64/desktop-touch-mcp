# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 0.11.x | ✅ |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report security issues privately via [GitHub Security Advisories](https://github.com/Harusame64/desktop-touch-mcp/security/advisories/new).

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

You can expect a response within 72 hours.

## Security Design

- **Emergency stop (Failsafe)**: Park the mouse in the top-left corner of the primary monitor (within 10px of 0,0) for 500ms to trigger the emergency stop. The server exits if a tool call is running; while idle it stays up and refuses tool calls until the cursor leaves the corner. Background credential autofill is cancelled before any of its dialogs open — it does not pick up again by itself, so move the cursor away from the corner and run the command again.
- **Shell interpreter blocklist**: `cmd.exe`, `powershell.exe`, and other interpreters cannot be launched via `workspace_launch`.
- **Script extension blocklist**: `.bat`, `.ps1`, `.vbs`, etc. are rejected.
- **Shell metacharacter rejection**: Arguments containing `;`, `&`, `|`, `` ` ``, `$(`, `${` are blocked.
- **Keyboard blocklist**: `Win+R`, `Win+X`, `Win+S`, `Win+L` are blocked.
- **Input length limits**: All string inputs are length-capped via Zod schema validation.
- **PowerShell injection protection**: All `-like` patterns in the UIA bridge are sanitized with `escapeLike()`.
- **User allowlist**: Blocked executables can be selectively re-enabled via `desktop-touch-allowlist.json`.
