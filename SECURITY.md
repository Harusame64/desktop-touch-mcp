# Security Policy

desktop-touch-mcp is a personal project, maintained in spare time and provided as is under the MIT license, without
warranty. There is no service-level agreement. What it sends off your PC and what it keeps on it is in the
[privacy policy](https://harusame64.github.io/desktop-touch-mcp/articles/privacy.html).

## Supported Versions

| Version | Supported |
|---|---|
| Latest 2.x release | ✅ Fixes ship as a new 2.x release |
| 1.x and older | ❌ |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report privately through [GitHub Security Advisories](https://github.com/Harusame64/desktop-touch-mcp/security/advisories/new).
If you cannot use GitHub, use the contact address on the [author's page](https://harusame64.github.io).

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

There is no guaranteed response time. Reports are read and handled as time allows, and a confirmed problem is fixed
in a new release, with credit if you want it.

## Security Design

- **Emergency stop (Failsafe)**: Park the mouse in the top-left corner of the primary monitor (within 10px of 0,0) for 500ms to trigger the emergency stop. The server exits if a tool call is running; while idle it stays up and refuses tool calls until the cursor leaves the corner. Background credential autofill is cancelled before any of its dialogs open — it does not pick up again by itself, so move the cursor away from the corner and run the command again.
- **Shell interpreter blocklist**: `cmd.exe`, `powershell.exe`, and other interpreters cannot be launched via `workspace_launch`.
- **Script extension blocklist**: `.bat`, `.ps1`, `.vbs`, etc. are rejected.
- **Shell metacharacter rejection**: Arguments containing `;`, `&`, `|`, `` ` ``, `$(`, `${` are blocked.
- **Keyboard blocklist**: `Win+R`, `Win+X`, `Win+S`, `Win+L` are blocked.
- **Input length limits**: All string inputs are length-capped via Zod schema validation.
- **PowerShell injection protection**: All `-like` patterns in the UIA bridge are sanitized with `escapeLike()`.
- **User allowlist**: Blocked executables can be selectively re-enabled via `desktop-touch-allowlist.json`.
