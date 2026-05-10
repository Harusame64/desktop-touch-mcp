# Windows Terminal BG Input Spike Prompt — AttachConsole + WriteConsoleInputW

> 2026-05-10
>
> Purpose: give Claude/Codex enough context, evidence, and guardrails to run a
> short spike for issue #185's last live-session input candidate:
> `AttachConsole(shellPid)` + `CONIN$` + `WriteConsoleInputW`.

---

## Copy-Paste Prompt For Claude

You are working in `D:\git\desktop-touch-mcp`.

Please run a focused spike for Windows Terminal background input using
`AttachConsole` + `CONIN$` + `WriteConsoleInputW`.

### Context

`terminal({action:'send'})` used to treat Windows Terminal
(`CASCADIA_HOSTING_WINDOW_CLASS`) as compatible with background `WM_CHAR`
`PostMessage`. That was wrong: WT's WinUI/XAML input pipeline silently swallows
those messages. The current code intentionally rejects WT for the `wm_char`
background path and falls back to foreground input.

Issue #185 is the stretch follow-up: can we recover a foreground-independent
input path for an existing live Windows Terminal pane?

Prior alternatives:

- UIA writable text path is effectively ruled out. WT exposes readable
  `TextPattern` for terminal content, but not a writable text surface.
- Direct ConPTY handle access is unattractive because desktop-touch-mcp is a
  sibling process of WT, not the ConPTY owner/parent. There is no clean
  pseudo-console handle path without parent ownership, handle duplication from
  the owner, elevation, injection, or a helper that created the session.
- Remoting (`WSMan` / SSH PowerShell remoting) is clean for BG command
  execution, but it is not live WT pane input.

This spike investigates one remaining live-session idea:

> If we can identify the real console client process behind the visible WT pane
> (for example `pwsh.exe`, `powershell.exe`, or `cmd.exe`), can a helper process
> call `AttachConsole(pid)`, open `CONIN$`, write `KEY_EVENT_RECORD`s with
> `WriteConsoleInputW`, detach, and then verify through existing
> `terminal_read`?

This is explicitly uncertain. Treat it as a Go/No-Go experiment, not as a
feature implementation.

### Evidence To Use

Use these references as the basis for the spike notes:

- `AttachConsole` attaches the calling process to another process's console as
  a client application:
  https://learn.microsoft.com/en-us/windows/console/attachconsole
- A process can attach to one console, and a console can have many attached
  processes:
  https://learn.microsoft.com/en-us/windows/console/attaching-to-a-console
- A console consists of an input buffer and screen buffers; any number of
  processes can share a console:
  https://learn.microsoft.com/en-us/windows/console/consoles
- `CONIN$` can be opened with `CreateFile` to get a handle to the console input
  buffer, even when standard handles are redirected:
  https://learn.microsoft.com/en-us/windows/console/console-handles
- The console input buffer is a queue of input records. Low-level input
  functions can read records from it or place records into it:
  https://learn.microsoft.com/en-us/windows/console/console-input-buffer
- `WriteConsoleInput` writes `INPUT_RECORD` data directly to the console input
  buffer, but Microsoft marks it as legacy/not recommended for new products and
  warns it can fail conceptually for remoting/cross-platform transports:
  https://learn.microsoft.com/en-us/windows/console/writeconsoleinput
- `GetConsoleProcessList` retrieves processes attached to the current console,
  but Microsoft notes the state is local/session/privilege-context specific:
  https://learn.microsoft.com/en-us/windows/console/getconsoleprocesslist
- Pseudoconsole sessions are created by the host before the child character-mode
  process is launched; this is why direct ConPTY access is not assumed available
  from a sibling MCP process:
  https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session
- Current repo context:
  - `src/tools/terminal.ts`
  - `src/engine/bg-input.ts`
  - `src/engine/win32.ts`
  - `src/win32/input.rs`
  - `src/win32/process.rs`
  - `docs/terminal-integration-plan.md`
  - issue #185: https://github.com/Harusame64/desktop-touch-mcp/issues/185

### Non-Goals

- Do not modify the production `terminal_send` behavior yet.
- Do not wire a public MCP tool yet.
- Do not inject into the user's arbitrary existing terminal before the
  controlled launch scenario passes.
- Do not require admin/elevation, DLL injection, handle stealing, or moving
  existing tags/releases.
- Do not treat WSMan/SSH remoting as the same thing as live WT pane input.

### Safety Rules

- Use only controlled terminals launched for this spike.
- Send harmless sentinel commands only, such as:
  - PowerShell: `Write-Output "__DTM_ATTACHCONSOLE_SPIKE_<guid>__"`
  - cmd: `echo __DTM_ATTACHCONSOLE_SPIKE_<guid>__`
- Never send secrets, destructive commands, credential prompts, or clipboard
  content.
- Always verify delivery by reading the terminal buffer after the write.
- Always call `FreeConsole` after any `AttachConsole` attempt.
- If a candidate process is elevated and the MCP/helper process is not, record
  the privilege mismatch and skip.

### Suggested Spike Shape

1. Create a scratch branch or keep all code in an uncommitted scratch path.
   Prefer a tiny helper under `scripts/spikes/` or a native-only temporary
   export. Keep the production tool surface untouched.

2. Establish a conhost baseline:
   - Launch a controlled `cmd.exe` or `powershell.exe` in legacy conhost if
     possible.
   - Find its PID.
   - `AttachConsole(pid)`.
   - `CreateFileW(L"CONIN$", GENERIC_READ | GENERIC_WRITE,
     FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL)`.
   - Write a sentinel command using `WriteConsoleInputW`.
   - Detach with `FreeConsole`.
   - Verify the sentinel appears in the terminal using existing read logic.
   - If this baseline fails, fix the helper before testing WT.

3. Controlled Windows Terminal test:
   - Launch a unique WT tab:
     `wt.exe new-tab --title DTM-ATTACHCONSOLE-SPIKE -- powershell.exe -NoLogo -NoExit`
   - Find the top-level WT window by title/class.
   - Build the process parent map using the existing process helpers or
     `Get-CimInstance Win32_Process` as temporary discovery.
   - Enumerate candidate descendant/sibling processes around that WT window:
     `WindowsTerminal.exe`, `OpenConsole.exe`, `conhost.exe`, `pwsh.exe`,
     `powershell.exe`, `cmd.exe`, `wsl.exe`.
   - For each plausible shell/client PID, attempt:
     - `FreeConsole()` first, to clear any current attachment.
     - `AttachConsole(candidatePid)`.
     - `GetConsoleProcessList()` and log attached PIDs.
     - Open `CONIN$`.
     - Write a unique sentinel command.
     - `FreeConsole()`.
     - Verify via `terminal_read` / UIA read-back.

4. Try at least these variants:
   - `powershell.exe` in WT
   - `cmd.exe` in WT
   - `pwsh.exe` in WT, if installed
   - WSL only as optional, likely No-Go or separate follow-up

5. Try two `KEY_EVENT_RECORD` encodings:
   - Key-down records only, with `UnicodeChar` set and `wRepeatCount = 1`.
   - Key-down + key-up pairs, with `VK_RETURN` / `'\r'` for Enter.
   Record which one works. Prefer the least surprising Windows-console shape
   if both work.

6. Record failure modes precisely:
   - `AttachConsole` failed: `GetLastError` value and candidate PID/name.
   - `CONIN$` open failed: `GetLastError`.
   - `WriteConsoleInputW` failed or wrote fewer records than expected.
   - Write API succeeded, but sentinel did not appear.
   - Sentinel appeared in the wrong pane/window.
   - Multi-pane/tab mapping is ambiguous.

### Acceptance Criteria

Go only if all of these are true:

- A controlled WT PowerShell tab receives a sentinel command without WT becoming
  foreground.
- Delivery can be verified with current `terminal_read` / UIA read-back.
- The candidate PID can be chosen deterministically for a normal single-pane WT
  window.
- Failures are observable as typed errors, not silent `ok:true`.
- The path does not require elevation, injection, or being WT's parent process.

No-Go if any of these are true:

- We cannot map WT window/tab/pane to the correct console client process.
- It works only for terminals created by our helper, not for user-created WT
  sessions.
- It can write to a console, but not the currently visible pane.
- Multi-pane WT can silently route input to the wrong pane.
- It depends on admin/elevation, injected helper code, or private WT internals.
- It succeeds at the API layer but cannot be reliably verified.

### Deliverable

Write a concise result note, preferably `docs/wt-attachconsole-spike-results.md`,
with:

- environment details: Windows version, WT version if available, shell versions,
  elevated vs non-elevated
- test matrix:

| host | shell | candidate PID strategy | AttachConsole | CONIN$ | WriteConsoleInputW | verified | notes |
|---|---|---|---|---|---|---|---|

- final recommendation:
  - `GO`: propose a scoped implementation plan
  - `NO-GO`: close this candidate and keep #185 ranking as remoting for BG-only
    execution, foreground for live WT input
  - `MAYBE`: list the single blocking unknown and the next shortest test

Keep the write-up explicit about the distinction between:

- live WT pane input
- BG command execution through remoting
- terminals created/owned by desktop-touch-mcp

---

## Design Notes For Reviewers

### Why This Idea Exists

The failed WT path was HWND-level `PostMessage(WM_CHAR)`. WT's UI pipeline does
not consume those messages as terminal input. This spike deliberately moves down
one layer: instead of sending messages to WT's top-level window, it tries to
write keyboard records into the console input buffer associated with the shell
process hosted by WT/ConPTY.

The idea is plausible because the Windows Console documentation says a console
has an input buffer, multiple processes can share a console, `AttachConsole`
can attach a process to another process's console, and `WriteConsoleInputW` can
place input records into that buffer.

The idea is risky because Microsoft positions these low-level console APIs as
legacy/local-console mechanisms, not a modern cross-platform transport. It may
also be impossible to map a WT top-level window to the right active pane's
console client process without WT-private state.

### Expected Product Decision

This should remain a spike until proven. Even if the API writes successfully,
the product decision should be conservative:

- `terminal_send(method:'auto')` must not switch to this path until delivery is
  verified and routing is deterministic.
- Any future implementation needs a post-send verification step, mirroring the
  silent-success audit policy from #173/#184.
- If pane mapping is ambiguous, the path can at most be an opt-in/debug-only
  experimental route, not a default route.

### Likely Implementation Location If It Works

If the spike passes, the real implementation probably belongs in the native
Win32 layer, not the TypeScript `bg-input.ts` PostMessage helper:

- Rust/native exports under `src/win32/console.rs` or similar
- TypeScript wrapper in `src/engine/win32.ts`
- Routing logic in `src/tools/terminal.ts`
- tests covering positive conhost, positive/negative WT, explicit failure
  codes, and verification behavior

Do not build this production surface until the result note demonstrates a
controlled WT success.

