# RDP session × Win32 window APIs — behaviour matrix and spike

- Status: **Draft (Round 1)** — theoretical column filled from Win32 docs; spike results pending
- Date: 2026-05-13
- Authors: Claude (Opus draft, follow-up to Round 1 desktop-touch-mcp session investigation)
- Related:
  - ADR-016 (`docs/adr-016-rdp-virtual-window.md`) — **different axis**: that ADR is about *host → remote* visibility when the user drives a remote PC over RDP. This document is about *what does the desktop-touch host process see when it is the one running inside the RDP session*.
  - `memory/reference_rdp_som_breakthrough.md` (user-side memory) — RDP-inside DXGI capture is blocked by GPU virtualisation; `screenshot(detail='som')` is the only working path. This document treats the **window-acquisition** side (EnumWindows / GetForegroundWindow / GetWindowText / etc), which is decoupled from the DXGI capture issue.
  - `src/win32/window.rs` — current native binding surface (ADR-007 P1 hot path), session-agnostic.

---

## 1. Problem statement

When `desktop-touch` (and the LLM driving it) is launched **inside** a Terminal Services session — typically:

- The user RDPs from PC-A to PC-B and runs Claude Code + the MCP **on PC-B inside the RDP session**, or
- Two interactive sessions coexist on the same PC (e.g. console user + a second user via RDP)

…it is not obvious what the Win32 window APIs the project relies on actually return. Concretely we need to know, per session state:

1. Does `EnumWindows` return only the calling session's windows, or does it cross session boundaries?
2. Does `GetForegroundWindow` return `NULL` when the session is locked / disconnected / on the secure desktop?
3. Does `GetWindowTextW` work cross-session if you somehow obtained another session's HWND?
4. Does `PrintWindow` (not currently called from native, but conceptually relevant for capture) draw correctly inside an RDP session at all?
5. Should the project gain session-awareness (WTSEnumerateSessions / ProcessIdToSessionId) so it can refuse to operate, or warn, in pathological states?

We have to answer 1–4 before answering 5: if EnumWindows already self-scopes to the calling session there is little to do; if not, the project needs explicit session gates.

---

## 2. The session / window-station / desktop hierarchy

From MS Learn (verified 2026-05-13):

- A **Terminal Services session** wraps one interactive logon. The console (physically logged-in) user is one session; each RDP/RemoteApp/RDS connection is another. Sessions are numbered (`SessionId`); the console's id can be read from `WTSGetActiveConsoleSessionId()` and is **not always 0** (it is `0xFFFFFFFF` if no user is logged in at the console).
- Each session has its own **interactive window station** named `"WinSta0"` plus zero or more non-interactive window stations for services. The names collide across sessions; they are scoped per-session.
- Each window station has a tree of **desktops** (`Default`, `Winlogon`, screen-saver, …). Only one desktop per session is "active" (receives input) at a time.
- A thread is bound to one window station + desktop at creation time. APIs like `EnumWindows`, `GetForegroundWindow`, `GetWindowTextW` operate on the *calling thread's desktop*. They cannot see windows in a different session, a different window station, or a different desktop within the same station, **even when the calling process has SYSTEM privilege** — visibility is desktop-bound, not privilege-bound.

This is the structural reason why the project's existing primitives are already, accidentally, session-scoped: they cannot leak across the boundary even if we want them to.

Sources:

- [Remote Desktop Sessions — Win32 apps](https://learn.microsoft.com/en-us/windows/win32/termserv/terminal-services-sessions)
- [Window Stations — Win32 apps](https://learn.microsoft.com/en-us/windows/win32/winstation/window-stations)
- [EnumWindows](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumwindows)
- [EnumDesktopWindows](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumdesktopwindows)
- [WTSEnumerateSessionsExW](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsenumeratesessionsexw)

---

## 3. Theoretical matrix (per API × session state)

Legend for state column:

- **console-active** — calling thread is in the console session, that session is logged in and the user is on the Default desktop
- **rdp-active** — calling thread is in an RDP session, the RDP client window on PC-A is open and connected, Default desktop
- **rdp-disconnected** — same session as rdp-active, but the RDP client on PC-A has been closed without logout (session lingers in `WTSDisconnected` state)
- **rdp-locked** — same session as rdp-active, user pressed Win+L; Winlogon's secure-desktop is active in front of the Default desktop
- **other-session-running** — the calling thread is in session X, but a different session Y exists and is `Active` (e.g. console session running while we are inside an RDP session)

| API | console-active | rdp-active | rdp-disconnected | rdp-locked | other-session-running |
|---|---|---|---|---|---|
| `EnumWindows` | Returns this session's WinSta0\Default top-level HWNDs (expected) | Returns this RDP session's WinSta0\Default top-level HWNDs (expected — no leak from other sessions) | Likely returns the same set as rdp-active because the desktop still exists; the windows just have no screen presence. **Needs spike confirmation.** | Returns Default-desktop windows; the Winlogon secure desktop is a separate desktop and is invisible to EnumWindows from Default | Other session's HWNDs are **not** returned. Calling thread's desktop is the only scope |
| `GetForegroundWindow` | Returns the focused HWND (non-null in normal use) | Same | Likely `NULL` — Disconnected sessions have no input desktop. **Needs spike confirmation.** | `NULL` (foreground is on Winlogon's desktop, not Default) | Calling thread's foreground only — never the other session's focus |
| `GetWindowTextW(hwnd)` | Title of `hwnd` if same desktop. Cross-desktop hwnd returns `""` or fails | Same | If you somehow already hold an HWND, the title is still readable as long as the owning process is alive; the desktop being disconnected does not destroy windows. **Spike for actual return** | Same: titles of Default-desktop windows are readable while you are on Default | Cross-session HWND: GetWindowText sends WM_GETTEXT; cross-session SendMessage is blocked → likely `""`. **Spike for confirmation** |
| `GetClassNameW(hwnd)` | Reads stored class — independent of focus / disconnection. Does NOT send a message, reads the cached class atom | Same | Same — class name is in the kernel-side window object, not a message | Same | Cross-session HWND: untested; class name read does not go via SendMessage so it should succeed even cross-desktop. **Needs spike** |
| `GetWindowRect`, `IsWindowVisible`, `IsIconic`, `IsZoomed` | Read window state struct — message-free, succeeds for any HWND the desktop owns | Same | Same — state is preserved across disconnect | Same | Cross-session HWND: should succeed (struct read, not message) but `IsWindowVisible` semantics may differ when the desktop is not the input desktop. **Needs spike** |
| `GetWindowThreadProcessId` | Always returns the owning thread/process even for HWNDs from other desktops in same session | Same | Same | Same | Cross-session: should work — process / thread ids are server-side globally unique |
| `PrintWindow(hwnd, …)` | Sends WM_PRINT — generally works for the calling thread's desktop windows | Same — but the bitmap path is GPU-virtualised inside RDP and is a known weakness (see `memory/reference_rdp_som_breakthrough`) | Likely fails — disconnected sessions have no rendered framebuffer. **Spike if relevant** | Default-desktop windows may not paint while their desktop is not active. **Spike if relevant** | Cross-session: WM_PRINT is sent via SendMessage; cross-session SendMessage is blocked → fails |

Key invariants we can extract from doc reading alone (before spike data):

- **No primitive in the current binding crosses a session boundary**. Whatever session the desktop-touch process is launched in is the only session it sees. This is the **safe failure mode** — we cannot accidentally drive another user's desktop.
- The risky states are not "cross-session leaks" (those cannot happen) but "intra-session API returns are different from what an LLM expects": `GetForegroundWindow → NULL` on lock/disconnect, `EnumWindows` returning a non-empty list even while the user cannot actually see anything.

---

## 4. Spike plan

### 4.1 Script

`scripts/spikes/rdp-session-window-probe.ps1` (already in tree). Read-only PowerShell script that captures, in one snapshot:

- Calling process's `pid` and `ProcessIdToSessionId` result
- `WTSGetActiveConsoleSessionId()`
- `WTSEnumerateSessionsW` over all sessions on this host (id, win-station name, state)
- `EnumWindows` total count + a sample of up to 20 visible top-level windows decorated with title / class / pid / sessionId
- `GetForegroundWindow` result and, if non-null, the same decoration

Output is a single JSON blob (stdout or `-OutputPath`). No mutation, no message dispatch, safe to run anywhere.

### 4.2 Scenarios

| # | Scenario | How to set up | What we want to learn |
|---|---|---|---|
| S1 | console-active | Run the script directly on the host's local logon | Baseline. Confirms enum window count, foreground decoded, own session id matches console session id. |
| S2 | rdp-active | RDP from PC-A to PC-B, open a PowerShell prompt inside the RDP session on PC-B, run the script there | Confirms `ownSession ≠ consoleSession`, foreground HWND's session id matches ownSession, EnumWindows count is independent of console session activity. |
| S3 | rdp-locked | Inside the RDP session (S2), press Win+L, then run the script via Task Scheduler (or have it already running and re-poll), capture output for that snapshot | Confirms `foregroundWindow.isNull = true` while Default-desktop EnumWindows still returns the user's windows. |
| S4 | rdp-disconnected (stretch) | After S2, close mstsc on PC-A *without* logout. Have a scheduled task on PC-B run the script some seconds later, write to a known path | Confirms whether the session enters `Disconnected` state, whether EnumWindows still returns the user's windows, and what GetForegroundWindow returns. |
| S5 | other-session-running (stretch) | While S1's console session is signed in, RDP in as a different user from PC-A, run script in *both* sessions, compare | Confirms zero-leak: each session sees only its own windows. |

S4 + S5 are stretch — the answers are likely already pinned by the theoretical row in §3 (zero leak; disconnected just means no input desktop) but cheap to verify if the user can spare the time.

### 4.3 Safety

- Script is read-only (no SendMessage, no window manipulation, no registry write, no process spawn beyond the PowerShell host itself).
- All session-listing APIs run with the caller's existing token — no elevation.
- Output JSON contains the calling user's name and host name; no credentials, no clipboard contents, no file paths beyond the script's own.

---

## 5. Spike results

### S1 — console-active (this host, 2026-05-13)

Captured by Claude during the session that drafted this document, on the same host where development happens (host tag elided). Probe was self-run via PowerShell tool; no manual user action.

- `ownProcess.sessionId = 8`, `consoleSessionId = 8` → confirms we are running in the console session. (Note: console session id was **8**, not 1 — Windows reuses ids across reboots and lock/unlock cycles. Confirms the project must never hard-code session ids.)
- `WTSEnumerateSessions` returned two entries:
  - `{ id=0, winStation=Services, state=Disconnected }` — kernel services session
  - `{ id=8, winStation=Console, state=Active }` — our user session
- `EnumWindows` returned a set of ~20 sampled visible top-level windows, **every single one carrying `sessionId=8`**. Zero leakage from session 0 (Services), as predicted by §3.
- `GetForegroundWindow` returned the focused HWND of the user's foreground app, with `sessionId=8`.
- Sampled class names included expected `Shell_TrayWnd`, `CabinetWClass` (Explorer), `Chrome_WidgetWin_1`, `CASCADIA_HOSTING_WINDOW_CLASS` (Windows Terminal), `ConsoleWindowClass`, `PseudoConsoleWindow`. No anomalous window-station-foreign classes.

**Confirms** the §3 theoretical row for console-active.

### S2 — rdp-active (pending user spike)

Setup: RDP from PC-A to PC-B with this user's account, open PowerShell inside the RDP session on PC-B, run the script. Expected: `ownSession ≠ consoleSession`, `consoleSession` either equals the physically-logged-in user's id or `0xFFFFFFFF` if no one is at the console; EnumWindows count nonzero and all `sessionId == ownSession`.

### S3 — rdp-locked (pending user spike)

Setup: while in S2, press Win+L inside the RDP session, then re-run the script (or have it scheduled). Expected: `foregroundWindow.isNull = true`, EnumWindows still returns the user's Default-desktop windows.

### S4 — rdp-disconnected (stretch, pending or skipped)

Setup: after S2, close mstsc on PC-A without logout; have Task Scheduler on PC-B run the script with `-OutputPath`. Expected: session enters `Disconnected` state in WTSEnumerateSessions; `foregroundWindow.isNull = true`; EnumWindows still returns the user's windows.

### S5 — other-session-running (stretch, pending or skipped)

Setup: while S1's console session is signed in on PC-B, RDP in as a different user from PC-A; run script in both sessions; compare. Expected: zero leak — each session's EnumWindows sample contains only `sessionId == ownSession` entries.

---

## 6. Decision: ADR vs docs entry vs no action

To be settled after spike results come back. Candidates:

- **No action (docs-only).** If §3's theoretical matrix is confirmed in full and there are no surprises, the conclusion is "the project is already session-safe by Win32 design." A short `docs/llm-audit/rdp-session-notes.md` page summarising the matrix is enough; ADR-016 already covers the host-side axis.
- **Lightweight gate (project hint).** If `GetForegroundWindow → NULL` on lock/disconnect is observed and the project's `desktop_state` returns confusing output in that state, add a `hints.sessionState` field to `desktop_state` derived from `WTSGetActiveConsoleSessionId` + `ProcessIdToSessionId` comparison. No new ADR — note in the existing `desktop_state` tool docs.
- **New ADR (-017?)** for **session-aware desktop-touch**. If cross-session leakage is observed in any API (extremely unlikely per §2) **or** if we decide to give the LLM explicit `session` filters on `desktop_discover` and elsewhere as forward-compatibility for ADR-016 Phase 3's `Origin::Rdp`. This is a structural commitment and would require its own design pass.

---

## 7. Open questions

- OQ1 — Should the spike collect `EnumDesktops` per session as well? Mostly diagnostic; out of scope for the matrix.
- OQ2 — Do we want to capture `IsWindowVisible(fg)` after Win+L to verify the "Default-desktop window is reachable but not visible" claim? Currently the sample loop reads it; the foreground decoder reads it too. Sufficient.
- OQ3 — Does the project ever want to *intentionally* operate across sessions (e.g. drive another logged-in session for shared-machine automation)? This would require running code in the target session via `CreateProcessAsUser` + `WTSGetSessionUserToken`, a substantial security surface. Not in this document's scope.

---

## 8. Decision history

### 2026-05-13 — Draft (Round 1)

Author: Claude (Opus).

- §1–§3 written from Win32 doc reading; matrix theoretical column complete.
- §4 spike script committed at `scripts/spikes/rdp-session-window-probe.ps1`.
- §5–§6 left empty pending user-driven spike execution across S1–S3 (S4 / S5 stretch).
