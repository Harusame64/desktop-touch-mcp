# Changelog

## [1.6.0] - 2026-05-16 — Excel scroll fix + verifyDelivery.observation hint with chain-trust telemetry

### Added

- **`scroll(action:'raw', …)` now reports a richer `verifyDelivery.observation`
  hint** with multi-frame ring-buffer telemetry when the dispatcher's
  chain-trust path runs (Excel cell grid is the confirmed target; other
  MDI receivers fall through to Tier 1 UIA). When `observation.source`
  is `"temporal_ring_observation_only"`, the hint now also carries
  `ringTelemetry` with:
  - `finalChangedFraction` — block-level diff between the pre-dispatch
    frame and the first visually-stable post-dispatch frame. Values
    above `0` indicate the wheel produced a visible change; on Excel
    the idle baseline is `0.000` and a real 3-notch scroll measures
    `0.003–0.015`. The LLM caller can treat any non-zero value as
    "the action moved something on screen" without per-app threshold
    tuning.
  - `axis` + `stripCount` + `finalStripChangedFractions[]` +
    `stripsAboveNoise` — per-strip diff partitioned along the
    dispatch motion axis (horizontal strips for vertical scroll). A
    real scroll touches multiple strips; a caret blink or local UI
    animation touches one. The LLM caller can distinguish translation
    from local repaint from the strip-count shape rather than tuning
    a global threshold.
  - `stableReached` + `framesToStability` + `changedFractions[]` +
    `maxChangedFraction` — the polling diagnostics that tell the
    LLM caller whether visual stability was reached within the
    700 ms wall-clock budget, how many frames it took to stabilise,
    and the inter-frame deltas along the way. `stableReached: false`
    means the budget exhausted without reaching stability (e.g. a
    persistent UI animation in the captured region); the dispatcher
    still emits `delivered_via_postmessage` honestly with this
    diagnostic visible.

  All new fields are additive on the existing `verifyDelivery.observation`
  surface introduced earlier in this release. Existing callers that
  ignore the hint are unaffected.

- **`scroll(action:'raw', …)` now reports a `verifyDelivery.observation`
  hint** when the dispatcher's chain-trust path runs (Excel cell grid /
  Word document body / similar MDI receivers). The new hint tells the
  LLM caller whether the delivery was independently observed or trusted
  by the dispatcher without observation. Three values ship in this
  release:
  - `observation.source: "uia_scroll_percent"` with `motion: "translation"`
    — the dispatcher read the receiver's scroll-percent via the
    accessibility API before and after the wheel message, and the
    percent changed. This is the most confident "delivered" signal
    available for custom-painted receivers and applies when the
    target exposes a UI Automation `ScrollPattern`.
  - `observation.source: "uia_scroll_percent"` with `motion: "no_change"`
    — same observation channel, but the percent did NOT change (boundary
    case: the receiver got the wheel and decided not to scroll, for
    example because the document is already at the top). The dispatcher
    still reports `verifyDelivery.status: "delivered"` (matches Tier 1
    boundary semantics), but the `motion: "no_change"` hint lets the
    LLM caller distinguish "actually moved" from "reached the receiver
    but no-op."
  - `observation.source: "chain_trust_unverified"` with `motion:
    "indeterminate"` — the receiver does not expose a `ScrollPattern`
    for reads (the common case for Excel `NUIScrollbar` / Word MFC
    custom-paint surfaces), so the dispatcher trusts the documented
    receiver contract for custom-painted scroll surfaces without
    independent observation. This is the same delivery contract as
    before, now with an explicit "unverified at the observation layer"
    hint instead of a silent assumption.

  Existing callers that ignore the hint are unaffected. The field is
  optional and only attached when a chain-trust observation actually
  ran.

### Fixed

- **`scroll(action:'raw', windowTitle:'Book1 - Excel')` now actually scrolls
  the Excel cell grid.** Previously the call returned `ok:false code:'ScrollNotDelivered'`
  with `verifyDelivery.reason:'target_unreachable'` because `WM_MOUSEWHEEL`
  is delivered upward from a window to its parent, never downward to a
  child — and Excel's cell grid lives in a deep child window (`XLMAIN →
  XLDESK → EXCEL7`), not on the top-level frame. The scroll dispatcher
  now walks the known child-class chain for Excel and Word (`OpusApp →
  _WwF → _WwG`) and posts the wheel message to the actual grid leaf.
  Excel's scrollbar is custom-painted (`NUIScrollbar`, not a Win32
  `SB_VERT`), so the dispatcher trusts the documented receiver contract
  rather than requiring a Win32-observable scrollbar delta — the cell
  grid scrolls and `verifyDelivery.reason:'delivered_via_postmessage'`
  is reported even when `GetScrollInfo` cannot see the move. Apps not
  in the chain table are unaffected (behaviour is bit-equal to the
  previous release). This restores cursor-only Excel scroll calls that
  worked before the destination-explicit pipeline landed in v1.5.0.

## [1.5.1] - 2026-05-12 — `workspace_launch` App Paths registry resolution + concurrent `keyboard` crash fix

### Added

- **`workspace_launch` now resolves common app names from the Windows
  App Paths registry.** Calls like
  `workspace_launch({command:'excel.exe'})`,
  `workspace_launch({command:'winword.exe'})`, or
  `workspace_launch({command:'outlook.exe'})` previously failed with
  `SpawnFailed: Command "excel.exe" not found` because Node's `spawn`
  only searches `PATH`, not the App Paths key Windows itself uses for
  Win+R and the Explorer address bar. The launch path now consults
  `HKCU` then `HKLM` (incl. `WOW6432Node`) for an `App Paths\<exe>`
  entry, expands `%VAR%` tokens in REG_EXPAND_SZ values, and re-runs
  the existing security validation on the resolved path so a tampered
  registry entry cannot smuggle a blocked shell interpreter through.
  The successful result surfaces the resolution in `note`, e.g.
  `Resolved "excel.exe" → "C:\\...\\EXCEL.EXE" via App Paths registry`.
  The existing built-in path lookups (chrome / edge / brave / VS Code)
  still take priority and are unchanged. Fixes
  [#258](https://github.com/Harusame64/desktop-touch-mcp/issues/258).

### Fixed

- **Native keyboard input no longer crashes the MCP server when
  fired from concurrent tool calls.** Two `keyboard` tool calls in
  the same Claude turn (e.g. the menu chord `alt+i` then `m`),
  or a `keyboard` call racing a `scroll` PageDown / `terminal:send`
  keystroke fallback, could interleave inside the shared
  key-injection backend (libnut) and segfault the Node process.
  When that happened, the whole `mcp__desktop-touch__*` tool
  namespace vanished from the session and the CLI had to be
  restarted. Every keyboard injection path (`keyboard`, `scroll`
  arrow / page keys, `terminal:send` text + Enter) now drains
  through a single FIFO inside the engine layer, so the
  press/release window of one call always completes before the
  next begins. Sequential calls and `run_macro` batches behave
  exactly as before — only true cross-request concurrency is held
  back, and only when it would otherwise share the native input
  backend. Mouse / clipboard tools are unaffected. Fixes
  [#255](https://github.com/Harusame64/desktop-touch-mcp/issues/255).

## [1.5.0] - 2026-05-12 — New `excel` tool: author and run VBA macros against Excel via COM (no VBA Editor UI needed)

### Added

- **New `excel` tool — author and run VBA macros against a live Excel
  instance via COM late binding. The headline differentiator against
  `Claude for Excel` (which writes formulas but cannot run VBA).** The
  tool is a single dispatcher with two actions in v1.5.0:

  ```ts
  // Headline path: author a Sub, save into the managed Trusted Location,
  // and Application.Run it. The Sub name MUST appear in `code` as
  // `Sub <macroName>(...)` — checked by a regex pre-flight before any
  // COM call so a typo fails fast with VbaMacroNotFound.
  excel({
    action: "run_vba",
    code: 'Sub DesktopTouchAdHoc()\n  Range("A1").Value = "Hello"\nEnd Sub',
    macroName: "DesktopTouchAdHoc", // default; override to match your Sub
    visible: false,                  // true to surface the Excel window for demo recording
  })
  // → { ok: true, workbookPath: "...\\trusted-vba\\dt_vba_<ts>.xlsm",
  //     hints: { verifyDelivery: { status: "delivered", ... } } }

  // Preflight: read-only HKCU/HKLM AccessVBOM inspection so callers
  // can surface a clean remediation hint before the workflow.
  excel({ action: "check_access_vbom" })
  // → { ok: true, trusted: true|false, lockedByPolicy: false, scope: "hkcu"|"hklm-policy"|"default" }
  ```

  The bridge structurally bypasses the VBA Editor UI — no UIA tree walk,
  no menu navigation, no coordinate clicks. It uses
  `Excel.Application.VBE.VBProjects` COM, which is the same API
  UiPath / Power Automate Desktop use. Authoring works against in-memory
  workbooks; execution requires the workbook to live in a registered
  Trusted Location, which the setup CLI handles automatically (see
  Setup below).

- **CLI setup script `scripts/enable-access-vbom.mjs` — one-shot
  configuration of all three trust axes Excel needs:**
  HKCU `AccessVBOM = 1` (allow programmatic VBA project access),
  HKCU `VBAWarnings = 1` (allow macro execution from trusted files), and
  registration of `%LOCALAPPDATA%\desktop-touch-mcp\trusted-vba` as
  a Trusted Location so dynamically-authored workbooks can run macros
  without an `0x800a03ec` Trust Center block.

  ```powershell
  node scripts/enable-access-vbom.mjs
  # Flags: --check-only (read state, exit 1 if any axis missing),
  #        --skip-macros (set AccessVBOM only, leave VBAWarnings),
  #        --skip-trusted-location (don't register the managed directory).
  ```

  Idempotent: re-running detects existing matching registry entries
  (case-insensitive, trailing-slash tolerant, `%LOCALAPPDATA%` literal
  vs expanded path tolerant) and reports them without writing
  duplicates. If any of the four LocationN values fails partway
  through registration, the partial slot is rolled back so the next
  run starts clean.

  Excel caches all three trust values at process start, so **close any
  running Excel.exe before retrying** when the CLI reports a successful
  write but the tool still fails with a trust-related error.

- **12 new typed error codes for VBA-bridge failures, so LLMs can
  pattern-match recovery paths instead of parsing English prose:**
  `VbaAccessNotTrusted` (run the CLI), `VbaAccessLockedByPolicy`
  (contact IT), `ExcelNotInstalled`, `VbaModuleAuthoringFailed`,
  `VbaMacroExecutionFailed` (typically HRESULT `0x800a03ec` —
  workbook outside Trusted Location), `VbaMacroNotFound` (Sub name
  doesn't appear in `code`), `VbaUnsupportedArgumentType`,
  `VbaWorkbookProtected` (workbook-level VBA password set),
  `SessionNotFound`, `SessionIdExhausted` (practically unreachable),
  `VbaUnsupportedFileFormat` (v1 only accepts `.xlsm`),
  `VbaBridgeUnavailable` (non-Windows or pre-v1.5.0 build).

### Requirements

- Excel 365 / 2019 / 2021 / 2024 installed (other Office versions
  use a different registry path and are not supported in v1.5.0).
- Run `node scripts/enable-access-vbom.mjs` once on each machine before
  first use. The script writes to `HKCU` only — no admin rights needed.
- v1.5.0+ build of `@harusame64/desktop-touch-mcp` (the native addon
  must include the VBA bridge module).

### Limitations (v1.5.0 known)

- `eval_cell` and `refresh_query` action variants are deferred to a
  later v1.5.x release. The discriminator schema is designed so they
  can be added without breaking callers.
- Macro arguments accept only null / boolean / number / string in v1.
  Complex types pass `VbaUnsupportedArgumentType`; serialise into a
  worksheet cell from the macro side instead.
- `Application.Run` blocks the COM thread for the macro's full
  duration. Long-running macros freeze subsequent `excel` calls on
  the same MCP server until they return.

## [1.4.4] - 2026-05-11 — Window-targeted screenshots use PrintWindow by default (recovers RDP + GPU-composited captures)

### Changed

- **Window-targeted screenshots now use Win32 PrintWindow by default, which
  captures GPU-composited apps (Chrome, Electron, WinUI3) and content shown
  inside an RDP session that the legacy BitBlt path returned as black or
  empty.** This affects every `screenshot(detail='image', windowTitle=...)`
  / `screenshot(detail='image', hwnd=...)` call as well as
  `screenshot(diffMode=true)` layer captures. Fullscreen / `displayId`
  captures are unchanged and still use BitBlt.

  When PrintWindow returns no data at all (driver / DRM-protected surface)
  or an all-black + zero-variance frame, the capture falls back to a BitBlt
  of the window's on-screen rect automatically. The route used and the
  reason for any fallback are surfaced on the response so callers can spot
  ambiguous captures:

  ```jsonc
  {
    "hints": {
      "captureSource": "printwindow" | "bitblt-fallback",
      "captureFallbackReason": "printwindow-failed" | "printwindow-all-black",
      "warnings": ["…fixed-string explanation…"]
    }
  }
  ```

  A fallback warning means the on-screen pixels may include overlapping
  windows that happened to be in front of the target. If the target window
  is legitimately all-black (terminal, dark editor, video frame), pass
  `mode='background'` to force the PrintWindow result without the BitBlt
  fallback layer.

- **`mode='background'` is retained and unchanged.** It is no longer the
  only way to reach the PrintWindow path (it now matches the `mode='normal'`
  default for window-targeted captures) but it is still useful for
  explicit selection — for example to force PrintWindow over BitBlt
  fallback when the target window is legitimately black.

## [1.4.3] - 2026-05-11 — LLM UX: terminal `command` alias, IME observe/control, and string-boolean parameter coercion

### Added

- **`desktop_state.hints.imeOpen` — read IME ON/OFF on the focused window.**
  Wraps Imm32's `ImmGetDefaultIMEWnd` + `WM_IME_CONTROL`. `true` means the
  focused window's IME is in composition mode (Japanese / Chinese / Korean
  active); `false` means OFF or no IME associated (ASCII layout). The hint
  is omitted entirely on older addon builds that predate the bridge, so a
  missing field can be distinguished from "definitely off". (issue #245)

- **`keyboard({action:'type', forceImeOff:true})` — flip IME OFF for the
  duration of one type call, then restore.** Solves the silent
  romaji-conversion failure where an LLM types ASCII while the user's
  Japanese IME is active. Before the inner pipeline runs, the handler
  queries the target window's IME via Imm32; if currently ON, it flips
  OFF, records the original state, types, and restores the prior IME mode
  in `finally` regardless of how the inner call returns. Round-trip
  verified end-to-end on a live IME-ON terminal: `method: "keystroke"` for
  26 ASCII characters, IME restored to ON afterwards. (issue #245)

- **New typed error `ImeOnDuringType`.** Emitted by
  `keyboard({action:'type'})` when `forceKeystrokes:true` + `use_clipboard:false`
  meet an IME-ON target without `forceImeOff:true`. The handler refuses
  early so no characters are sent — recovery is lossless. Suggestions
  point to the three escape paths: `forceImeOff:true`, `use_clipboard:true`,
  or drop `forceKeystrokes` (default auto-clipboard handles non-ASCII
  transparently). (issue #245)

### Changed

- **`terminal({action:'run', command:'…'})` is now accepted as a
  deprecated alias of `input`.** Pre-Phase-4 callers (and LLMs that
  remember the older surface) frequently send `command:'…'` because it
  reads more naturally than `input`; the schema now accepts either, with
  the dispatcher normalising `command` → `input` before
  `terminalRunHandler` sees it. `input` wins if both are set. The
  `terminal_read` / `terminal_send` Phase 4 absorption is now mentioned
  in the tool description's leading sentence so a text search for the
  old names lands on this tool. (issue #245)

- **`terminal` `caveats` now spells out the BG path auto-engage rule.**
  BG auto-engages only when (a) target window class is
  `ConsoleWindowClass` (conhost: cmd / PowerShell / pwsh classic hosts)
  OR (b) `DTM_BG_AUTO=1` is set. Windows Terminal
  (`CASCADIA_HOSTING_WINDOW_CLASS`) is intentionally excluded
  (issue #173) — without this note, LLMs saw `windowChanged:true` on a
  WT target and assumed a bug. (issue #245)

### Fixed

- **All boolean tool parameters now accept the LLM-friendly string
  spellings `"true"` / `"false"`.** Anthropic Claude (and some other MCP
  clients) serialise tool arguments by spelling booleans as strings;
  raw `z.boolean()` then rejected the call with `expected boolean,
  received string`. `src/tools/_coerce.ts` already shipped a strict-safe
  `coercedBoolean()` (accepts `"true"`/`"false"` case-insensitively + 0/1;
  ambiguous strings like `"yes"` still reject so typos cannot silently
  flip flags), and 5 schema files had already adopted it. This release
  finishes the migration mechanically across the remaining 13 schema
  files — `keyboard.use_clipboard`, `forceImeOff`, `forceKeystrokes`,
  `replaceAll`, plus boolean fields on `terminal` / `mouse` / `browser`
  / `screenshot` / `scroll` / `window` / `window-dock` / `workspace` /
  `dock` / `macro` / `desktop-state` / `desktop-register`. Literal
  `true` / `false` continue to pass through unchanged. (issue #247)

- **`scroll.ts` `homing` parameter no longer uses unsafe coercion.**
  The previous `z.coerce.boolean()` treated the string `"false"` as
  truthy (because non-empty strings are truthy in JavaScript), silently
  flipping the flag. Replaced with the strict `coercedBoolean()` helper.
  Issue scope drift caught during the issue #247 migration sweep.

## [1.4.2] - 2026-05-10 — Background input to Windows Terminal, plus reliable delivery verification on Notepad

### Added

- **New `method: 'foreground_flash'` for `keyboard({action:'type'})` and `terminal({action:'send'})`.**
  Windows Terminal is built on WinUI/XAML and silently drops `WM_CHAR`
  messages, which is why `method: 'background'` refuses to send to it. The
  new `'foreground_flash'` channel offers an opt-in middle ground: it briefly
  steals foreground, pastes the text via the clipboard, and restores the
  previous foreground — typically completing in 50–200 ms.

  The clipboard is saved before the paste and restored afterwards. If a
  clipboard format cannot be preserved (e.g. images, metafiles), the
  response lists what was lost in `hints.clipboardSkippedFormats`. A
  `typingLeakRisk: true` hint warns that any keystrokes the user happens to
  type during the flash window will be sent to the foreground app instead
  of where the user expects. Set `block_keyboard_during_flash: true` (or
  the env var `DESKTOP_TOUCH_FOREGROUND_FLASH_BLOCK_KEYBOARD=1`) to
  suppress user keystrokes during the flash; this also blocks Alt+Tab and
  similar shortcuts, which is why it is off by default.

  Failure modes are reported via typed reasons:
  `input_contains_newline`, `input_exceeds_paste_warning_threshold`,
  `foreground_steal_denied`, `focus_wait_timeout`,
  `clipboard_lock_contention`, `foreground_restore_failed`,
  `wt_paste_warning_intercepted`, and `send_input_failed`.

  Inputs over 5 KiB (UTF-16) are rejected up-front because Windows Terminal
  pops a paste-warning dialog at that size; if the dialog appears anyway,
  it is auto-dismissed. `keyboard({action:'press', method:'foreground_flash'})`
  is rejected with `ForegroundFlashNotApplicableToKeyPress` because key
  combos cannot be expressed as a clipboard paste.

  This channel is opt-in only. `method: 'background'` continues to refuse
  Windows Terminal targets — the silent-fail guarantee from v1.3.2 is
  unchanged.

### Fixed

- **`keyboard({action:'type', method:'background'})` against Windows 11
  New Notepad now reports `delivered` instead of `unverifiable`.** The
  delivery read-back used UIA `TextPattern`, which Notepad's editor
  element does not support. v1.4.1 added a `ValuePattern` fallback, but
  the fallback was only reachable in narrow cases. The verification path
  now keeps a `ValuePattern` baseline in parallel and uses it whenever
  `TextPattern` returns nothing comparable, so the delivery status is
  reported correctly on Notepad and similar `ValuePattern`-only editors.

## [1.4.1] - 2026-05-09 — Typed `SpawnFailed` for launch errors, plus an early read-back path for Notepad

> **2026-05-10 update**: the Notepad delivery-verification fix below was reachable only in
> narrow cases on this release; v1.4.2 finishes the job. Other fixes in v1.4.1 are unaffected.

### Added

- **New typed error code `SpawnFailed` for process-launch tools.**
  `workspace_launch` (and `browser_open` when it spawns a new browser)
  used to surface a generic `ToolError` when the spawn was rejected
  (typically reported by Node.js as `ENOENT`, `EACCES`, `EPERM`, or
  similar). These now return `code: "SpawnFailed"` with targeted
  recovery hints (full path, permission, elevation, built-in command,
  Windows policy). Agents can branch on the typed code instead of
  pattern-matching the error string.

- **`ValuePattern` fallback for delivery verification on
  `keyboard({action:'type', method:'background'})`.** Windows 11 New
  Notepad's editor element does not expose `TextPattern`, so the
  post-send read-back used to return `verifyDelivery: 'unverifiable'`
  even when the text was actually delivered. The verification path now
  also captures a `ValuePattern.Value` baseline and uses it for a delta
  check. **Note**: this fallback required a follow-up fix in v1.4.2 to
  fire reliably on real targets.

### Changed

- **Launch-failure scenario doc updated** to use `chrome.exe` instead of
  `notepad.exe` as the single-instance example. Win11 New Notepad now
  spawns multiple instances, which made the doc misleading. No behaviour
  change.

## [1.4.0] - 2026-05-09 — Typed error codes, partial-failure reporting, and delivery verification on browser/terminal sends

### Added

- **`AutoGuardBlocked` typed error code.** When auto-guard refuses an
  action (ambiguous target, target not found, blocked by modal, browser
  not ready, identity changed, unsafe coordinates, etc.), the response
  now carries `code: "AutoGuardBlocked"` with a status enum and matching
  recovery hints, instead of a generic `ToolError` that callers had to
  parse out of the error string. Existing message-prefix matching
  (`error.message.startsWith("AutoGuardBlocked:")`) continues to work,
  so this is additive.

- **`run_macro` reports partial failures via top-level `warnings[]`.**
  When `stop_on_error: false`, the macro summary now includes a
  `warnings[]` array listing the steps whose nested tool returned
  `ok:false` (`{step, tool, code?, error}`). Previously you had to
  `JSON.parse` each step's `text[0]` to discover failures. The field is
  omitted when no step failed, so existing callers see no shape change.

- **DOM-level delivery verification for `browser_click` and
  `browser_fill`.**
  - `browser_click` installs a `MutationObserver` on the page before
    the click and inspects DOM mutations, URL changes, and
    `document.activeElement` shifts over a 500 ms window. If any signal
    is observed, `hints.verifyDelivery.status` is `"delivered"`. If none
    are observed (typical of an SPA button with no listener attached),
    the status is `"unverifiable"` so the caller knows the click reached
    the OS but had no visible effect. Iframe-scoped selectors return
    `"unverifiable"` with `reason: "iframe_context_mismatch"` because
    the top-frame observer cannot see them.
  - `browser_fill` reads the input's `value` back after dispatch and
    fails with `BrowserFillNotDelivered` if it does not match the
    requested value. Controlled inputs that transform the value
    (numeric-only filters, max-length truncation, format masks) are
    distinguished from outright rejection (`controlled_input_transform`
    vs `value_not_retained`) so the caller can treat the actual value
    as authoritative when appropriate.

- **`terminal({action:'send', method:'background'})` auto-detects
  hidden-input prompts.** When the prompt line ends with `password:`,
  `passphrase:`, `secret:`, `sudo`, `Password for ...`, or `> `, the
  post-send read-back is skipped and the response carries
  `hints.verifyDelivery.status = "unverifiable"`,
  `reason: "hidden_input_prompt"`, and a `fallback: "method:'foreground'"`
  hint. Previously these calls returned a false-positive
  `BackgroundInputNotDelivered` because the terminal does not echo the
  password. The pattern is end-anchored to avoid false matches in
  scrollback.

- **New typed codes `BrowserClickNotDelivered` and
  `BrowserFillNotDelivered`.** `BrowserFillNotDelivered` is returned
  when the read-back diff fails. `BrowserClickNotDelivered` is reserved
  for a future strict mode and is not thrown today — a click that
  reaches the OS is treated as a transport-layer success; observation
  drift is reported via the `verifyDelivery` hint instead.

### Changed

- **`run_macro` with `stop_on_error: true` now actually stops on
  nested failures.** Previously a step whose handler returned an
  `ok:false` envelope still counted as `ok:true` at the macro level
  (the handler did not throw), so the macro continued running and
  could corrupt state — for example, attempting `keyboard:type` after
  a `focus_window` step had already failed. The macro driver now
  inspects the inner envelope and propagates the failure correctly.

- **`terminal({action:'send', method:'background'})` and
  `keyboard({action:'type'/'press', method:'background'})` against
  Windows Terminal now fail with `BackgroundInputNotDelivered`**
  instead of `BackgroundInputUnsupported`. This aligns with the
  v1.3.2 fix (Windows Terminal silently drops `WM_CHAR`): an
  explicitly-requested BG send must hard-fail rather than appear to
  succeed via a mismatched suggest path. Other unsupported targets
  (Chromium, UWP sandboxed, unknown class) still return
  `BackgroundInputUnsupported` with the existing `browser_fill` hint.

- **Pre-release manual verification is now a release prerequisite.**
  The release checklist runs a four-step manual pass (smoke test,
  recently-fixed-feature paths, high-priority scenarios, lower-priority
  scenarios). The change reflects a v1.3 lesson where a regression that
  silently broke `terminal:send` on Windows Terminal escaped automated
  CI for ~11 days.

### Removed

- **Three dead typed codes — `LensBudgetExceeded`,
  `TerminalMarkerStale`, `MaxDepthExceeded` — removed from the
  dictionary.** No path in the current code produces them, so the
  entries are deleted to keep the typed-code surface honest. A CI
  check now blocks the same kind of drift from coming back.

## [1.3.2] - 2026-05-08 — Windows Terminal background-input regression fixed

A ~11-day regression: with Windows Terminal set as the default terminal
app, `terminal({action:'send'})` returned `ok:true` but no input was
actually delivered. Windows Terminal is built on WinUI/XAML and discards
`WM_CHAR` messages at its input pipeline; the OS-layer `PostMessage`
call still returned success, so the tool reported delivery. The E2E
suite skipped on the failure path, which is why CI never caught it.

### Fixed

- **Windows Terminal removed from the `WM_CHAR` fast-path.** The
  `CASCADIA_HOSTING_WINDOW_CLASS` window class and the
  `WindowsTerminal.exe` process name are now classified as not
  supporting BG injection (`reason:"wt_xaml_pipeline"`).
  `terminal({action:'send', method:'auto'})` and
  `keyboard({action:'type'/'press', method:'auto'})` automatically fall
  back to the foreground keystroke path on Windows Terminal targets.

- **BG send adds a post-send read-back delivery check.** After
  `WM_CHAR` is dispatched, the engine waits briefly, reads the target
  via UIA `TextPattern`, and diffs against the pre-send baseline. If
  the input string is not present, the call fails with
  `BackgroundInputNotDelivered` instead of returning `ok:true`. `Enter`
  is only sent after the delivery check passes.

- **Changelog correction for v1.1.0** — the original entry claimed
  Windows Terminal was on the BG fast-path; that auto-route was
  incorrect for the WinUI pipeline. Annotated inline.

### Changed

- **`terminal({action:'send'})` now uses the foreground path on
  Windows Terminal targets.** Callers that explicitly set
  `method:'background'` against Windows Terminal now receive
  `BackgroundInputNotDelivered` (previously they got an inaccurate
  `ok:true`). Switch to `method:'foreground'` or `method:'auto'`, or
  set conhost as the default terminal.

- **`terminal({action:'run'})` `completion.reason` enum gains
  `send_failed`.** Returned when the target window is alive but the
  send step itself failed (typical case: explicit `method:'background'`
  against a target that returns `BackgroundInputNotDelivered`).
  Previously the same situation was misclassified as
  `window_not_found`. `warnings[]` carries the underlying error code.

### Known limitations

- **`method:'background'` against echo-suppressed prompts produces a
  false-positive failure.** `sudo` / `ssh` password prompts and
  `Read-Host -AsSecureString` accept the keystrokes but do not echo
  them, so the read-back delivery check reports the call as failed
  even when delivery succeeded. The `BackgroundInputNotDelivered`
  suggest text calls this out and recommends `method:'foreground'`,
  which uses key events and does not rely on echo. Auto-detection
  shipped in v1.4.0.

## [1.3.1] - 2026-05-08 — Six tools were rejecting all input on v1.3.0; fixed

A patch release for a v1.3.0 regression: `keyboard`, `clipboard`,
`window_dock`, `scroll`, `terminal`, and `browser_eval` returned
`Invalid discriminated union option at index 0` for every call,
regardless of arguments. The `include` API and the cognitive memory
layers were unaffected; the other 22 tools worked as in v1.3.0.

### Fixed

- **Discriminated-union dispatch for the six tools above.** A
  Zod 4.3.6 → 4.4.3 bump just before v1.3.0 moved an internal field
  the envelope wrapper relied on. The wrapper got `undefined` from
  the old path and could not route any variant. The wrapper now reads
  both the new and old paths and throws explicitly if neither is
  present, so future silent breakage of the same shape will fail loudly.

- **Regression test added** that parses each of the six tools'
  registration schemas with valid input, alternate variants,
  `include:["envelope"]` opt-in, and invalid discriminator inputs.
  Existing unit tests had only exercised pre-wrap schemas, which is
  why the bug shipped.

### Migration

The only behaviour change from v1.3.0 → v1.3.1 is "the six broken tools
work again". `include` semantics, the `DESKTOP_TOUCH_MEMORY_PERSIST` /
`DESKTOP_TOUCH_MEMORY_REDACT_TITLES` env vars, and the persistent
storage path (`%USERPROFILE%\.desktop-touch-mcp\memory\`) are
identical to v1.3.0.

## [1.3.0] - 2026-05-07 — Cognitive memory keywords for `include`

Four new memory keywords were added to the `include` option, letting an
LLM caller pull "what I just did", "rich detail of recent calls",
"successful UI patterns for this window", and "successful repeated
workflows" into a response in a single call. **Existing calls are 100%
backwards-compatible**: `include` absent, `["raw"]`, `["envelope"]`,
and `["causal"]` behave exactly as in v1.2.1. The new keywords are
opt-in only.

Use cases:
- "Recap what I just did before running this macro" → `include: ["working:5"]`
- "Show me lease and timing detail of similar past calls before fixing this failure" → `include: ["episodic:3"]`
- "Hint at successful interaction patterns for this window" → `include: ["semantic:3"]`
- "Suggest workflows I have already run successfully" → `include: ["procedural:3"]`
- "Treat this call as sensitive — force redaction" → `include: ["semantic:3", "memory_strict"]`

### Added

- **`include: ["working:N"]`** — adds `current_state.recent_events` to
  the response: a compact summary of the most recent N tool calls
  (default 10, max 50), including in-flight calls. Each entry has a
  small fixed shape (tool call id, tool name, truncated args, ok flag,
  compound-boundary flag). Useful for "remind me what I just did".

- **`include: ["episodic:N"]`** — adds `tool_call_history.episodes`
  to the response: completed tool calls only, in rich form (default 5,
  max 100). Includes a lease-token summary, started/completed event
  ids, elapsed time, and longer-truncated args. Differs from
  `working:N` in that it is rich-form and skips in-flight calls.
  Useful for "show me how the similar successful call was timed
  before I fix this failure".

- **`include: ["semantic:K"]`** — adds `learned_ui_pattern.patterns`
  to the response: rule-based extractions of "in this window, this
  sequence of three or more tool calls all succeeded" (default 3,
  max 10). Patterns are fingerprinted, stored in an in-memory LRU
  (100 patterns), and optionally persisted as JSON.

- **`include: ["procedural:K"]`** — adds
  `successful_macros.suggestions` to the response: aggregated
  `run_macro` outcomes that have succeeded at least three times,
  never failed, and contain no destructive tools (default 3,
  max 10). Destructive tools (`mouse_click`, `keyboard`, `terminal`,
  `clipboard`, `browser_click`, `browser_fill`, `browser_eval`,
  `workspace_launch`, `notification_show`, etc.) are excluded by
  design — auto-suggesting destructive workflows is intentionally
  out of scope. Outcomes are stored in an in-memory LRU (100
  outcomes) with optional JSON persistence.

- **Per-call security tier — `include: ["memory_strict|balanced|open"]`.**
  Adds `security_tier_active` to the response. The active tier is the
  combination of an operator-controlled ceiling (env vars) and the
  per-call request:
  - `memory_strict` — redaction ON, persistence flag hidden,
    procedural suggestions OFF (forces maximum security regardless of env).
  - `memory_balanced` (default) — follows env defaults.
  - `memory_open` — maximum exposure within the env ceiling.

  **Security floor**: an LLM cannot exceed the env ceiling. If the
  operator set `redact ON` or `persist OFF`, `memory_open` cannot
  override that. Only the strict direction can exceed env.

- **Optional JSON persistence (env opt-in).** Set
  `DESKTOP_TOUCH_MEMORY_PERSIST=1` to store learned patterns and
  macro outcomes under `%USERPROFILE%\.desktop-touch-mcp\memory\`
  (`ui-patterns.json`, `macro-outcomes.json`). Writes are atomic
  (temp file + rename), loaded on startup, debounced 5 s during
  runtime, and flushed on shutdown. Set
  `DESKTOP_TOUCH_MEMORY_REDACT_TITLES=1` to hash window titles
  before they are stored (irreversible). Tool names are not redacted.

### Compatibility

- All existing calls are unchanged — `include` absent, `["raw"]`,
  `["envelope"]`, and `["causal"]` produce the same responses as
  v1.2.1.
- Persistence and redaction default OFF. With both env vars unset,
  no data is persisted and nothing is hashed.

### Caveats

- **Persistence storage is global, not per-session.** If multiple
  LLM clients share the same Windows user profile, learned patterns
  from one client may appear in suggestions for another. Filtering
  exposes only safe patterns, but if you need stronger isolation,
  leave persistence env vars off, or call with
  `include: ["memory_strict"]` to suppress per-call exposure.
- **Destructive macros are not auto-suggested.** Macros containing
  destructive tools are excluded from `procedural:K` even if they
  succeeded multiple times.
- **Once a pattern has been recorded for a window, repeated successes
  do not increment its frequency count.** This is a side-effect of
  the cursor-based extraction and rarely matters for the typical
  "complete a macro, then query once" usage.

## [1.2.1] - 2026-05-03 — Optional `include` for envelope and causal metadata (fully backwards-compatible)

All 28 tools gained an optional `include` argument that lets the caller
request structured metadata (envelope) and a causal trace linking to the
previous tool call. **If `include` is not passed, responses are
byte-identical to v1.1.x** — existing settings, macros, and tool calls
need no changes.

Note: v1.2.0 was tagged but the release workflow failed (it referenced
the deleted `koffi` runtime dependency), so v1.2.0 has no npm tarball
and no GitHub Release zip. `@harusame64/desktop-touch-mcp@1.2.0` returns
404 on npm; users on v1.1.x should upgrade directly to v1.2.1, which is
feature-equivalent to the intended v1.2.0 plus the release-workflow fix.

### Added

- **`include` argument on all 28 tools.** Pass `include: ["envelope"]`
  to wrap the response in `{ _version, data, as_of, confidence }`, so
  the caller knows when the data was observed and how confident the
  engine was. `include` absent or `include: ["raw"]` returns the
  unwrapped legacy shape.

- **`desktop_state({ include: ["causal"] })` for causal tracing.**
  The response gains `your_last_action` (which tool you most recently
  called) and `events` (UI changes that occurred afterwards). This
  removes the need to diff screenshots or repeat `desktop_state` calls
  to determine "did my click take effect" or "did clicking that button
  open a dialog". Other read tools accept `include: ["causal"]` for
  forward compatibility but do not yet emit causal fields.

- **`run_macro` records macro boundaries in the causal log.** A macro
  of N steps writes N + 1 entries: one for the macro as a whole and
  one per step. `desktop_state({ include: ["causal"] })` can therefore
  distinguish "the previous action was a macro" from "the previous
  action was step K within a macro". Caveat: the causal log is a small
  ring buffer, so macros over ~8 steps may evict the earliest steps
  before they are queried.

### Fixed

- **Release workflow no longer references the removed `koffi`
  dependency.** v1.2.0 was tagged but never published because the
  release workflow tried to copy `koffi` (deleted in v1.0) into the
  release bundle and crashed during `npm install`. v1.2.1 restores the
  runtime dependency list to what `package.json` actually declares
  (`@modelcontextprotocol/sdk`, `@nut-tree-fork/nut-js`, `sharp`, `ws`,
  `zod`).

## [1.1.3] - 2026-04-28 — `browser_launch` killExisting + `scroll(action='read')` + stub catalog fixes

Two v1.1 enhancements ship together with a stub-catalog generator fix that
exposes nested `z.object` schemas to non-Windows tool discovery. Both new
features are gated behind explicit args (`killExisting:true` / `action:'read'`)
so existing callers are unaffected.

- **feat(browser): add `killExisting` option to `browser_launch` (#22, #70).**
  When true, terminate existing `chrome.exe` / `msedge.exe` / `brave.exe`
  before spawning with `--remote-debugging-port`. Resolves the case where
  a Chromium instance is already running without CDP and `browser_launch`
  silently inherits into the existing profile, leaving the port closed.
  `taskkill.exe` is invoked by absolute `%SystemRoot%\System32\taskkill.exe`
  path to defeat PATH-hijack (Codex P1). The return JSON gains `killed: string[]`
  on both `alreadyRunning` and freshly-launched paths.
- **feat(scroll): add `action='read'` for OCR + dedupe long-doc reading (#25, #71).**
  Scrolls a window page-by-page, OCRs each viewport, deduplicates overlapping
  lines, and returns the stitched text in one MCP call. OCR is bound to the
  resolved hwnd (no title-based lookup drift); scroll keys are dispatched via
  `postKeyComboToHwnd` gated by `canInjectAtTarget` so foreground changes do
  not redirect the keystroke. Falls back to nut-js global keyboard with
  re-focus on Chromium / WebView2 hosts where PostMessage is silently dropped.
  Dedupe window is bounded by the current frame length so `scrollKey:'ArrowDown'`
  (line-by-line, near-full-viewport overlap) works correctly. OCR language is
  auto-detected from the OS locale (BCP-47 primary tag passed verbatim — no
  hardcoded allowlist). Capture / OCR failures surface as a structured
  ToolResult (`ok:false` on first page, `ok:true` + `stoppedReason:"ocr_failed"` +
  partial text on later pages) instead of escaping as a tool execution error.
- **fix(stub-catalog): expand nested `z.object` schemas recursively (#71).**
  `scripts/generate-stub-tool-catalog.mjs` previously collapsed every nested
  `z.object(...)` field to an opaque `{type:'object'}`, hiding the inner
  property contract from non-Windows clients. The generator now recurses into
  the inner shape so `browser_open.launch` (`browser` / `userDataDir` / `url` /
  `waitMs` / `killExisting`), `mouse_click.origin` (`x` / `y`), and
  `screenshot.region` (`x` / `y` / `width` / `height`) all appear in
  `STUB_TOOL_CATALOG` with full property contracts. `z.record` / `z.union` /
  `z.discriminatedUnion` stay opaque (their shape is not a fixed property map).

## [1.1.2] - 2026-04-28 — stdio server defers shutdown while tool calls are in flight

Bug fix: when the MCP client closed its stdin write-end while a long-running
tool call (`terminal(action='run')`, `wait_until`, large UIA polls) was still
running, the stdio server immediately called `process.exit(0)` and the in-flight
response was lost — the client saw `MCP error -32000: Connection closed` and
retried the call from scratch. The server now defers shutdown until the
in-flight JSON-RPC requests drain (60s safety timeout), so the response is
delivered before the process exits. HTTP transport (`--http`) was unaffected.

- **fix(server): defer shutdown while tool calls are in flight (#68).**
  `process.stdin.on('end')` and `process.stdout.on('error')` now go through a
  new `requestShutdown()` path that waits for `inflightIds` (a transport-level
  JSON-RPC request id set tracked via wrapped `transport.onmessage` /
  `transport.send`) to reach zero before calling `shutdown()`. Explicit
  `SIGINT` / `SIGTERM` / `disconnect` still terminate immediately. JSON-RPC
  ids are stored with their original type (`Set<string | number>`) so a
  spec-compliant client sending both numeric and string ids in the same
  session is not undercounted (Codex P2). The wrap forwards all SDK
  options/extra args via rest-spread for forward compatibility. Closes #68.
- **chore(repro): remove unused `t0` in `tests/repros/stdin-eof-shutdown.repro.mjs`
  (CodeQL `js/unused-local-variable` #104).**

## [1.1.1] - 2026-04-28 — `modal_blocking` response surfaces blocker identity

`desktop_act` now tells the LLM *which* modal to dismiss when a touch is
blocked, closing a one-syscall gap surfaced by Haiku 4.5 during a 3-model
dogfood run on Outlook PWA. Backwards-compatible patch — the new field is
optional and engines that cannot identify the blocker still return
`modal_blocking` without it.

- **feat(desktop_act): include `blockingElement` in `modal_blocking` response (#63).**
  When a `desktop_act` call fails with `reason: "modal_blocking"`, the response now
  carries `blockingElement: { name, role, automationId? }` identifying the offending
  modal. The LLM can dismiss it directly via `click_element(name=blockingElement.name)`
  without taking an extra screenshot to figure out what to close. The session-aware
  default predicate is shared between `isModalBlocking` and the new `findBlockingModal`
  hook so the pair cannot diverge. When the caller overrides exactly one of the pair,
  the other is derived from the override (Codex P1) — `blockingElement` is omitted
  rather than surfacing an entity unrelated to the actual blocking predicate. Closes
  #63 (Haiku 4.5 dogfood feedback from 3-model comparison run on Outlook PWA).

## [1.1.0] - 2026-04-27 — Focus Leash System (Phase A + B)

Stray-write defense for keyboard automation when the user changes
foreground mid-stream. Two layers landed in this minor: terminal-class
windows auto-route through HWND-targeted WM_CHAR (foreground-independent),
and non-terminal SendInput sends are chunked with a per-chunk foreground
guard that aborts and returns `typed`/`remaining` for resumable retry.
Backwards-compatible — explicit `method` values, `DTM_BG_AUTO=1`, and the
clipboard path are unchanged.

- **feat(keyboard): Focus Leash Phase B — per-chunk foreground guard for
  non-terminal apps.** When `keyboard(action:'type')` targets a non-terminal
  window via the foreground keystroke path, the send is now split into chunks
  (default 8 chars; override via `DTM_LEASH_CHUNK_SIZE` env, range 1-1024) and
  the target's foreground state is verified between chunks via
  `checkForegroundOnce` (a no-settle variant of `detectFocusLoss`). If the user
  grabs focus mid-stream, the call aborts with `FocusLostDuringType` and the
  response includes `context.typed` (chars delivered) plus `context.remaining`
  (unsent tail) so the caller can re-focus and resume. New `abortOnFocusLoss`
  param (default true when `windowTitle` is set) disables the leash when set
  to false. Clipboard path (atomic Ctrl+V) and BG path (HWND-targeted
  WM_CHAR — Phase A) are unaffected.
  - Modifier release safety valve: on abort or unexpected exception inside
    the chunked send, explicit KeyUp is emitted for L/R Ctrl/Alt/Shift so a
    leaked modifier cannot leave the user's session with a stuck-down
    Shift/Ctrl/Alt (defense-in-depth — KeyUp is idempotent at the OS level).
  - Chunk boundaries are code-point-aware (`Array.from`) so non-BMP
    characters (emoji etc.) never get bisected between chunks; resume
    semantics (`typed` / `remaining`) stay coherent in UTF-16 code units.

- **feat(keyboard, terminal): Focus Leash Phase A — terminal-class auto-route to WM_CHAR.**
  When `keyboard(action, method:'auto')` or `terminal(action:'send', method:'auto')`
  targets a known terminal window (`CASCADIA_HOSTING_WINDOW_CLASS` for Windows
  Terminal / `ConsoleWindowClass` for cmd/PowerShell/conhost), the engine now
  automatically uses HWND-targeted PostMessage delivery instead of the foreground
  keystroke path. Keystrokes intended for a terminal can no longer be diverted to
  other windows when the user grabs focus mid-stream. Existing `DTM_BG_AUTO=1`
  env flag continues to enable BG input globally for non-terminal apps; other
  apps still default to the foreground path.
  - **2026-05-08 correction (issue #173):** the `CASCADIA_HOSTING_WINDOW_CLASS`
    half of this claim was wrong. Windows Terminal is built on WinUI/XAML and
    consumes input via `KeyEventArgs`; `PostMessage(WM_CHAR)` is queued at the
    OS layer but `TerminalControl` never reads it, so input is silently dropped.
    The auto-route quietly broke `terminal(action:'send')` for any user whose
    default terminal app was Windows Terminal, while CI (which runs under
    conhost) saw green. Fixed in v1.3.2 — WT is removed from the BG fast-path
    and a post-send UIA read-back surfaces `BackgroundInputNotDelivered` if the
    BG path is still requested explicitly.

## [1.0.5] - 2026-04-27 — Security and stability patch

Bundle of correctness fixes found after `v1.0.4`, plus a guard rail to prevent
stdio regressions from coming back.

- **fix(image_processing):** prevent `u64` underflow in the Sauvola integral-image
  sum. Large ROIs could underflow the running difference and corrupt the
  thresholded output.
- **fix(browser):** correct the `\s+` regex escape in a CDP-injected template
  literal. Whitespace matching in selector-injection paths now behaves as
  intended.
- **fix(action-guard):** replace a dead null/undefined check with `pid === 0`
  (CodeQL #103). Removes unreachable code flagged by static analysis.
- **fix(launcher-test):** skip the stdio shutdown test when the sha256 manifest
  is `PENDING`. The check ran on the release commit before CI populated the
  hash and produced a false failure.
- **chore(lint):** add an ESLint rule that guards the MCP stdio JSON-RPC stream
  (#61). Catches future `console.log` / direct `stdout` writes that would
  re-introduce the v1.0.4 issue.

## [1.0.4] - 2026-04-27 — stdio JSON-RPC stream fix (Issue #60)

Some MCP clients run the launcher with `console.debug` mapped to `stdout`,
which corrupted the JSON-RPC framing on the stdio transport (Issue #60).
All `console.debug` calls in the runtime are replaced with `console.error`
so stdout remains exclusively MCP protocol traffic.

Documentation cleanup shipped alongside the fix:

- README rewritten to match the v1.0.x positioning (28 tools, World-Graph
  default-on).
- Tool count corrected from 56 to 28 in `package.json` and `glama.json`.
- Site navigation standardized across pages; v1.0 milestone article added.

## [1.0.3] - 2026-04-26 — Release infrastructure fix

The v1.0.0 tag built the GitHub Release zip successfully but the `npm-publish`
job failed because `npm publish --ignore-scripts` still triggered the
`prepare: tsc` lifecycle and `node_modules` was missing on the ubuntu-latest
runner — TypeScript could not resolve `@types/node`, the MCP SDK, or zod.

Add an explicit `npm ci` step in `release.yml` so the prepare lifecycle has
the dev dependencies it needs. v1.0.1 contains no functional changes from
v1.0.0; the surface, lease hardening, security fixes, and CI Rust coverage
are identical.

## [1.0.0] - 2026-04-26 — Tool Surface Reduction (Phase 1+2+3+4) + V2 World-Graph default-on + lease hardening

### Highlights

- **65 → 28 public tools.** Tool Surface Reduction Phase 1 (naming redesign), Phase 2 (family-merge dispatchers), Phase 3 (browser rearrangement), Phase 4 (privatize / absorb) all shipped. The MCP catalogue is 26 stub-catalog entries plus 2 dynamic v2 World-Graph tools (`desktop_discover` / `desktop_act`).
- **Anti-Fukuwarai v2 (World-Graph) is the default surface.** `desktop_discover` issues entity leases; `desktop_act` consumes them. Kill switch `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1` exposes a v1 fallback tool set (`get_windows` / `get_ui_elements` / `set_element_value`) for troubleshooting only.
- **Lease hardening.** Payload-size aware TTL with a soft-expiry advisory (`response.softExpiresAtMs` ≈ 60 % of the TTL window) tells the LLM when to refresh proactively; cap raised to 60 s for large explore + payload combos. Session eviction is now wired into a `.unref`'d 30 s timer so long-running processes don't leak.
- **Security audit pass.** CWE-94 in CDP `cdpFill` fixed (raw selector interpolation → JSON.stringify), HTTP CORS narrowed from `*` to a localhost-origin allowlist with proper `Vary: Origin`, native vision-backend Mutex poison handled.
- **CI gains Rust regression coverage.** windows-latest CI now runs the napi-rs build (`build:rs:debug`) on every PR, so any drift in the FFI shape / `build.rs` / Cargo features fails fast.
- **Two new browser DX wins.** `wait_until(url_matches)` waits on `location.href`; `browser_get_dom` now attaches a body-structure hint to ElementNotFound errors so the LLM gets an alternative-selector starting point.



### Breaking Changes — Phase 1 (Naming Redesign, 10 tools)

This phase renames 10 tools with **no aliases**.

| Old name | New name | Notes |
|---|---|---|
| `get_context` | `desktop_state` | Read-only desktop observation (returns `attention` field) |
| `desktop_see` | `desktop_discover` | Lease-emitting entity discovery |
| `desktop_touch` | `desktop_act` | Lease-consuming entity action (returns `attention` field) |
| `engine_status` | `server_status` | MCP server status diagnostic |
| `browser_connect` | `browser_open` | CDP connect + list tabs |
| `browser_click_element` | `browser_click` | Find + click via CSS selector |
| `browser_fill_input` | `browser_fill` | Fill controlled inputs via CDP |
| `browser_get_form` | `browser_form` | Inspect form fields |
| `browser_get_interactive` | `browser_overview` | List all interactive elements |
| `browser_find_element` | `browser_locate` | CSS selector → screen coords |

### Breaking Changes — Phase 2 (Family Merge, 13 tools → 5 dispatchers)

This phase merges 13 tools into 5 family dispatchers via discriminated `action` parameter.

| Old name | New invocation |
|---|---|
| `keyboard_type({text})` | `keyboard({action:"type", text})` |
| `keyboard_press({keys})` | `keyboard({action:"press", keys})` |
| `clipboard_read()` | `clipboard({action:"read"})` |
| `clipboard_write({text})` | `clipboard({action:"write", text})` |
| `pin_window({title, duration_ms?})` | `window_dock({action:"pin", title, duration_ms?})` |
| `unpin_window({title})` | `window_dock({action:"unpin", title})` |
| `dock_window({title, corner, ...})` | `window_dock({action:"dock", title, corner, ...})` |
| `scroll({direction, amount, ...})` | `scroll({action:"raw", direction, amount, ...})` |
| `scroll_to_element({...})` | `scroll({action:"to_element", ...})` |
| `smart_scroll({...})` | `scroll({action:"smart", ...})` |
| `scroll_capture({...})` | `scroll({action:"capture", ...})` |
| `terminal_read({windowTitle, ...})` | `terminal({action:"read", windowTitle, ...})` |
| `terminal_send({windowTitle, input, ...})` | `terminal({action:"send", windowTitle, input, ...})` |

**New `terminal({action:"run", ...})` workflow** — sends input, waits, and reads in one call. Returns `completion={reason, ...}` with reasons: `quiet | pattern_matched | timeout | window_closed | window_not_found`.

```js
terminal({action:"run", windowTitle:"PowerShell", input:"npm test",
          until:{mode:"pattern", pattern:"npm test:"}, timeoutMs:30000})
// → {output, completion:{reason:"pattern_matched", elapsedMs, matchedPattern}}
```

### Breaking Changes — Phase 3 (Browser Rearrangement, 4 tools absorbed/privatized)

This phase reorganizes the browser CDP family from 13 → 9 tools by absorbing
two pairs of related tools into discriminated unions and privatizing one.

| Old call | New call |
|---|---|
| `browser_launch({})` | `browser_open({launch:{}})` |
| `browser_launch({browser, port, userDataDir, url, waitMs})` | `browser_open({port, launch:{browser, userDataDir, url, waitMs}})` |
| `browser_open({port})` (connect-only) | `browser_open({port})` (unchanged — `launch` is optional) |
| `browser_eval({expression})` | `browser_eval({action:"js", expression})` |
| `browser_eval({expression, withPerception})` | `browser_eval({action:"js", expression, withPerception})` |
| `browser_get_dom({selector, maxLength})` | `browser_eval({action:"dom", selector, maxLength})` |
| `browser_get_app_state({selectors, maxBytes})` | `browser_eval({action:"appState", selectors, maxBytes})` |
| `browser_disconnect({port})` | (removed — process exit auto-cleanup) |

Notes:
- `browser_open({launch:{}})` is **idempotent**: when a CDP endpoint is already
  live on the target port, the spawn step is skipped and connect proceeds.
  Pass `launch:{}` to use defaults (chrome → edge → brave auto-resolution,
  `C:\tmp\cdp` profile, no initial URL); omit `launch` entirely for pure connect.
- `browser_eval({action:'dom'|'appState'})` is wrapped with `withPostState` so
  all three actions (`js` / `dom` / `appState`) attach `post.perception` when
  guards run. Previously only `browser_eval` did.
- `browser_eval({expression})` (without `action`) now fails validation —
  callers must supply `action:'js'`.
- `browser_open({launch:{...}})` returns the connect payload (`tabs[].active`).
  The former `browser_launch` extras (`alreadyRunning`, `launched.{browser,path}`)
  are dropped from the LLM-facing response; spawn state can be inferred from
  whether tabs[] returns immediately vs after a short delay.

### Breaking Changes — Phase 4 (Privatize / Absorb, 20 tools)

The largest reduction phase — 20 tools either privatized (entry-point removed,
internal handlers retained for tests / future facades) or absorbed into the
World-Graph core (desktop_state / desktop_discover / desktop_act) plus the
unified screenshot tool.

#### Privatized (10 — handler retained as internal export)

| Old call | New path |
|---|---|
| `events_subscribe` / `events_poll` / `events_unsubscribe` / `events_list` | Use `wait_until` for one-shot waits (`condition='window_appears'`/`'terminal_output_contains'`/`'element_matches'`/`'focus_changes'`). Multi-event monitoring removed; revive via facade in a later phase if dogfood shows it's needed. |
| `perception_register` / `perception_read` / `perception_forget` / `perception_list` | Auto Perception (v0.12+) attaches `attention` to `desktop_state` / `desktop_act` responses automatically. Action tools auto-guard when given `windowTitle`. |
| `get_history` | Debug-only tool — removed from public surface. |
| `mouse_move` | Hover-trigger UIs are rare; use `mouse_click` for click targets. |

#### Absorbed into `screenshot` (3)

| Old call | New call |
|---|---|
| `screenshot_background({windowTitle})` | `screenshot({windowTitle, mode:'background'})` |
| `screenshot_ocr({windowTitle, language})` | `screenshot({windowTitle, detail:'ocr', ocrLanguage})` |
| `scope_element({windowTitle, name, automationId, ...})` | Discover element bounds via `desktop_discover`, then `screenshot({windowTitle, region:{x,y,width,height}})`. The UIA child-tree return value is no longer surfaced — `desktop_discover` already exposes that structure. |

#### Absorbed into `desktop_act` (1)

| Old call | New call |
|---|---|
| `set_element_value({windowTitle, value, name, automationId})` | `desktop_act({action:'setValue', lease, text:value})`. Lease comes from `desktop_discover`. UIA ValuePattern path or CDP fill path selected automatically based on entity source. |

#### Absorbed into `desktop_state` response fields (4)

| Old call | New call |
|---|---|
| `get_active_window()` | `desktop_state().focusedWindow` (always returned) |
| `get_cursor_position()` | `desktop_state({includeCursor:true}).cursor` |
| `get_document_state({port,tabId})` | `desktop_state({includeDocument:true,port?,tabId?}).document` |
| `get_screen_info()` | `desktop_state({includeScreen:true}).screen` |

#### Absorbed into `desktop_discover` response fields (2)

| Old call | New call |
|---|---|
| `get_ui_elements({windowTitle, ...})` | `desktop_discover({target:{windowTitle}}).entities[]` (`entityId` / `label` / `role` / `confidence` / `sources` / `primaryAction` / `lease`; `rect` only when `debug:true`) |
| `get_windows()` | `desktop_discover().windows[]` (`zOrder` / `title` / `hwnd` / `region` / `isActive` / `isMinimized` / `isMaximized` / `processName`) |

The legacy `get_windows.isOnCurrentDesktop` virtual-desktop flag is **not**
included in `desktop_discover.windows[]` because it requires an async
PowerShell call. Callers needing virtual-desktop awareness can keep using
the internal `getWindowsHandler` (still exported for tests / facades).
Other action tools (`screenshot`, `mouse_click`, `keyboard`, …) accept
`hwnd` strings directly from `windows[].hwnd` for exact-handle workflows.

#### `run_macro` DSL TOOL_REGISTRY migrated to v1.0.0 names

The pre-Phase-1 compatibility layer in `run_macro` was retired. The macro DSL
now accepts only the v1.0.0 dispatcher names — for example
`{tool:'keyboard', params:{action:'type', text:'hello'}}` instead of
`{tool:'keyboard_type', params:{text:'hello'}}`. Macros built for v0.x must
be rewritten alongside direct tool calls.

#### v2 kill-switch fallback (Codex PR #41 round 6)

Anti-Fukuwarai v2 (`desktop_discover` / `desktop_act`) is on by default since
v0.17. Phase 4 absorbs `get_ui_elements` / `get_windows` /
`set_element_value` into v2's response fields and dispatcher actions; to
keep `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1` deployments capability-complete,
those three V1 tools are **re-published as fallback** when the kill switch
is set:

```
DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1
  → desktop_discover / desktop_act       NOT registered
  → get_windows / get_ui_elements / set_element_value  registered (V1 fallback)
```

The descriptions are prefixed with `[V1 fallback — registered only when ...]`
so the LLM sees they are a fallback layer, not the primary surface. The
`run_macro` DSL mirrors the same gate: in v2 mode the fallback entries
short-circuit with a `"v2 mode use ..."` hint instead of executing.

Other Phase 4 privatizations have non-v2 replacements (`desktop_state.include*`
flags / `screenshot` dispatcher / `wait_until` / `mouse_click`) and stay
private regardless of the kill switch.

### Tool Count

- Phase 1 + Phase 2 + Phase 3 + Phase 4 combined: **65 → 28 public tools** (about 57% reduction; matches plan §13 target of 27 ± 1).
- Stub catalog: **26 entries** (v2 `desktop_discover` / `desktop_act` are dynamic, registered at startup, not in static catalog → 26 + 2 = 28 public surface).

### Phase 4 Outstanding (deferred to Phase 5)

- Pre-existing test-isolation flakiness in `tests/unit/registry-lru.test.ts` (Phase 3 §3.3) — unrelated to Phase 4, vitest `vi.mock` leak issue. Tracked for Phase 5.
- Pre-existing E2E flakiness in `tests/e2e/context-consistency.test.ts` C3 (Save-As dialog detection on Win11 MSStore Notepad) and `tests/e2e/rich-narration-edge.test.ts` B1 (Chromium narrate:rich) — Phase 5 dogfood will verify.
- `browser_disconnect` / `mouse_move` facade revival decision — Phase 5 dogfood will confirm whether the privatized capability is missed.
- MCP server instructions text (`src/server-windows.ts`) extension for the new screenshot mode/detail/region values and desktop_state include* flags — deferred to Phase 5 dogfood judgement to avoid preemptive surface bloat.
- Performance / token-cost release notes generation via the refreshed `scripts/measure-tools-list-tokens.ts`.

### Changed

- `src/server-windows.ts` instructions text updated for Phase 1 + Phase 2 naming + Phase 4 WindowNotFound recovery.
- `src/stub-tool-catalog.ts` regenerated (26 entries after Phase 4).
- All LLM-visible strings (description / suggest / error.message / engine layer literal types / `failWith` tool labels) updated:
  - `_errors.ts` SUGGESTS for `WindowNotFound` / `ElementNotFound` / `InvokePatternNotSupported` / `TerminalWindowNotFound` rewritten to point at `desktop_discover` / `desktop_act({action:'setValue'})` / `screenshot({region})` / `terminal({action:'send'})`.
  - `_errors.ts` `BrowserNotConnected.suggest` → `browser_open({launch:{}})` (Phase 3).
  - `_errors.ts` `GuardFailed` / `LensNotFound` / `LensBudgetExceeded` rewritten away from privatized perception_* tools.
  - `engine/perception/guards.ts` (10) + `resource-model.ts` (2) `suggestedAction` → `desktop_state` (was: `perception_read`).
  - `desktop-state.ts` description: declares which former `get_*` tools are absorbed via `include*` flags.
  - `desktop-register.ts` (`desktop_discover` description): V1 fallback list `get_ui_elements` → `click_element`.
  - `screenshot.ts` `failWith` tags inside `screenshotBgHandler` / `screenshotOcrHandler` re-attribute to `"screenshot"` (the public dispatcher name).
  - `keyboard.ts` / `mouse.ts` / `dock.ts` / `window-dock.ts` / `workspace.ts` / `screenshot.ts` schema descriptions: hwnd hints "from `get_windows`" → "from `desktop_discover`"; monitor hints "from `get_screen_info`" → "from `desktop_state({includeScreen:true})`".
  - `browser.ts` `failWith` calls re-attribute internal handlers to their public dispatcher names (`browser_get_dom` / `browser_get_app_state` → `browser_eval`; `browser_launch` → `browser_open`).
- `README.md`, `README.ja.md`, `docs/system-overview.md`, `docs/tool-surface-reduction-plan.md`, `docs/tool-surface-known-issues.md` updated for Phase 4.
- `.gitignore` strengthened: `.vitest-out*.txt` / `.vitest-out*.json` wildcards (Phase 2 §2.6 follow-up).
- `scripts/measure-tools-list-tokens.ts` Tier sets refreshed for the v1.0.0 surface.
- Comment-only references to pre-Phase-1/2/3 names in `src/engine/` and `src/tools/` polished to current dispatcher names (16+ touchpoints across uia-bridge, vision-gpu, world-graph, layer-buffer, ocr-bridge, desktop-executor, desktop-providers, desktop, server-windows, utils/launch).

### Pre-v1.0 carry-over: `browser_eval` IIFE wrapping (rolled into the v1.0 series)

The notes below were queued under [Unreleased] before v1.0 and were folded
into the v1.0 release sequence; preserved here for historical context.

#### Added
- **`browser_eval` snippets are automatically wrapped in an async IIFE
  before evaluation.** This prevents `const` / `let` redeclaration
  errors when calling `browser_eval` multiple times in the same tab
  with the same variable names.
- Expression-shaped snippets preserve their return value without an
  explicit `return`.
- Statement-shaped snippets still preserve completion values (e.g.
  `const x = 1; x` returns `1`). On pages whose CSP blocks `unsafe-eval`,
  the wrapper falls back to a plain IIFE block so the snippet still
  runs (the completion value may be lost, but no error is thrown).
- Snippets that are already wrapped in an IIFE pass through unchanged.

#### Changed
- The `browser_eval` schema description documents the IIFE wrapping
  behaviour and notes that `window.*` / `globalThis.*` should be used
  when state must persist across calls.

#### Breaking Changes
- **Variable declarations no longer persist across `browser_eval`
  calls.** Previously, `var` declarations evaluated in the same CDP
  session were visible in subsequent calls; they are now scoped to
  each individual snippet. Migrate persistent state to
  `window.myVar = …` or `globalThis.myVar = …`.

## [0.14.0] - 2026-04-18 — Background Input (WM_CHAR) + SetValue Chain + Terminal BG Fast-Path

### Added
- **Background input engine** (`src/engine/bg-input.ts`): WM_CHAR/WM_KEYDOWN injection via
  `PostMessageW` — delivers keystrokes to a target HWND without changing the foreground window.
  Works for standard Win32 controls, Windows Terminal, conhost, cmd, and PowerShell.
  Chromium (Chrome/Edge/Electron) and UWP sandboxed apps are automatically excluded.
- **`keyboard_type` / `keyboard_press`**: new `method:"auto"|"background"|"foreground"` parameter.
  `"background"` injects via WM_CHAR without bringing the window to front.
  `"auto"` selects BG when `DTM_BG_AUTO=1` and the target supports injection, else foreground.
- **`terminal_send`**: new `method` + `chunkSize` parameters. BG mode sends in 100-char chunks
  to avoid queue saturation. Windows Terminal and conhost are fast-pathed as always-supported.
  Duplicate Enter is suppressed when input already ends with CR/LF.
- **`set_element_value` channel chain**: ValuePattern → TextPattern2 → keyboard fallback.
  Enabled via `DTM_SET_VALUE_CHAIN=1` (default off for safety). Uses `TryGetCurrentPattern`
  for locale-independent TextPattern2 detection.
- New error codes: `BackgroundInputUnsupported`, `BackgroundInputIncomplete`,
  `SetValueAllChannelsFailed`.

### Fixed
- **Modal false-positive** (`Windows 入力エクスペリエンス` IME window detected as modal):
  Added `SYSTEM_RESIDENT_CLASSES` blocklist; `WS_EX_TOPMOST` demoted from standalone modal
  trigger to confidence booster (+0.03). Fixes `safe.keyboardTarget` guard always blocking
  with lensId on Japanese Windows.
- **Tab-strip drag detection** (`mouse_drag`): horizontal drags starting in the title-bar area
  of tabbed apps (Notepad, Terminal, Chrome, VS Code, etc.) are now blocked by default with
  `TabDragBlocked` error. Pass `allowTabDrag:true` to rearrange or detach tabs intentionally.
- **`getFocusedChildHwnd`**: guard `targetThread === 0` and `attached=false` before calling
  `GetFocus()` — prevents reading caller-thread focus when `AttachThreadInput` fails.

### Changed
- Default mouse movement speed increased from 1500 → 3000 px/sec.
  Override with `DESKTOP_TOUCH_MOUSE_SPEED` env var or per-call `speed` parameter.

### Feature Flags (default OFF — zero impact on existing users)
- `DTM_BG_AUTO=1`: enables automatic BG channel selection for `keyboard_type` / `keyboard_press`
  / `terminal_send` when `method:"auto"` and the target supports WM_CHAR injection.
- `DTM_SET_VALUE_CHAIN=1`: enables TextPattern2 + keyboard fallback in `set_element_value`.

### Compatibility
- 56 tools unchanged (no additions or removals).
- All new parameters are optional with backward-compatible defaults.
- `DTM_BG_AUTO=0` and `DTM_SET_VALUE_CHAIN=0` (both default) preserve all existing behavior.

## [0.13.1] - 2026-04-18 — CodeQL fixes + MCP Registry listing

### Fixed
- `browser_click_element`: removed `JSON.stringify(selector)` from `suggest` hint string to eliminate
  CWE-94 code-injection false-positive flagged by CodeQL (alerts #67/#68). The hint is now a
  generic fixed string instead of an interpolated selector value.
- `_action-guard.ts`: removed duplicate `consumeFix` from local `import` statement (alert #69).
  It is still re-exported for callers via `export { ... } from`.

### Chore
- Removed unused `vi` import from `browser-ready-policies.test.ts` (alert #70).
- Removed unused `forgetLens`, `readLens`, `refreshWin32Fluents`, `buildWindowIdentity` from
  `registry-lru.test.ts` (alerts #71-73).
- Added `server.json` MCP Registry manifest for future listing on `registry.modelcontextprotocol.io`.
- Added `mcpName` field to `package.json` per MCP Registry requirements.

### Compatibility
- No behavior change. All existing tool APIs unchanged.

---

## [0.13.0] - 2026-04-18 — v3 Auto-Perception Final Closure

### Added (Phase D — Target-Identity Timeline)
- **Semantic target-scoped event timeline** with 13 event kinds: `target_bound`,
  `action_attempted`, `action_succeeded`, `action_blocked`, `title_changed`,
  `rect_changed`, `foreground_changed`, `navigation`, `modal_appeared`,
  `modal_dismissed`, `identity_changed`, `target_closed`, `compacted`.
  Retention: per-target ring (32), global cap (256), session-scoped.
  Events older than 15 minutes are automatically compacted into summary entries.
- `get_history` now includes a compact `recentTargetKeys` array (3 most recent
  target keys; does not include event bodies — prevents history bloat).
- `perception_read(lensId)` now includes `recentEvents` (up to 10 events) for
  the lens's target, each containing `tsMs`, `semantic`, `summary`, optional
  `tool` and `result` fields.
- MCP resources `perception://target/{targetKey}/timeline` and
  `perception://targets/recent` behind the existing
  `DESKTOP_TOUCH_PERCEPTION_RESOURCES=1` flag, with push notifications on new
  events (per-URI 300ms debounce). Client disconnect cleans up listeners via
  `server.onclose`.
- Sensor-sourced timeline events (`title_changed`, `rect_changed`,
  `foreground_changed`, `navigation`, `modal_appeared`, `modal_dismissed`,
  `identity_changed`) emitted from native WinEvent / CDP fluent changes
  (200ms leading-edge debounce per (targetKey, semantic) pair; action/post
  events are never debounced to preserve failure traces).

### Added (Phase G — SuggestedFix full tool coverage)
- `keyboard_type({ fixId })`, `click_element({ fixId })`,
  `browser_click_element({ fixId })` now accept one-shot `fixId` approvals
  (15s TTL). `SuggestedFix.tool` union widened to all 4 tools specified
  in v3 §7.1: `"mouse_click" | "keyboard_type" | "browser_click_element" |
  "click_element"`.
- `fixId` approval includes target-fingerprint revalidation (window: `pid +
  processStartTimeMs` via Win32; browser tab: deferred to subsequent guard).
  Returns `FixTargetMismatch` if the target process changed.
- SuggestedFix emission extended to keyboard identity drift, UIA identity
  change, and browser tab readiness drift.

### Added (Phase I — `mouse_drag` endpoint guard)
- `mouse_drag` now guards **both** start and end coordinates. Cross-window
  drags (including dragging to the desktop/wallpaper) are blocked by default.
  Pass `allowCrossWindowDrag: true` to opt in for deliberate cross-window or
  desktop-range-selection drags.

### Added (Phase J — `browser_eval` structured response)
- `browser_eval({ withPerception: true })` returns structured JSON
  `{ ok, result, post }` with `post.perception` attached. Default `false`
  preserves the raw-text return for backwards compatibility. Circular
  references, functions, and BigInt in eval results are handled safely via
  `WeakSet`-based serialization.

### Changed (Phase E — Manual Lens LRU)
- Manual lens eviction is now **LRU (touch-on-use)** instead of FIFO.
  `evaluatePreToolGuards`, `buildEnvelopeFor`, and `readLens` promote the
  accessed lens to most-recently-used. `listLenses`, `getLens`, sensor loops,
  and resource reads do not touch. MAX=16 unchanged.

### Changed (Phase F — Browser readiness action-sensitive policies)
- `browser_click_element`: `readyState !== "complete"` is now a **pass-with-note**
  when the target selector is already in-viewport (policy `selectorInViewport`).
- `browser_navigate`: `readyState === "interactive"` passes with a warn note
  (policy `navigationGate` — navigation-in-progress is acceptable for pre-nav
  guard).
- `browser_eval`: strict block on `readyState !== "complete"` retained (default
  policy `strict`). Use `withPerception: true` to receive a structured response
  with guard status.

### Chore (Phase H — Code Scanning cleanup)
- Removed 1 trivial conditional and 6 unused local variables / imports flagged
  by GitHub Code Scanning (CodeQL). No behavior change.

### Compatibility
- Existing `lensId` workflows unchanged.
- Existing `post.perception` shape unchanged.
- New optional fields `recentEvents`, `recentTargetKeys` are additive.
- `browser_eval` default return is unchanged (raw text); structured mode is
  opt-in via `withPerception: true`.
- `mouse_drag` cross-window/desktop drags are now blocked by default (new
  behavior). Pass `allowCrossWindowDrag: true` for prior behavior. In-window
  drags are unaffected.
- `DESKTOP_TOUCH_AUTO_GUARD=0` rollback path unchanged.

---

## [0.12.0] - 2026-04-17

### Added (Auto Perception)
- **Auto guard for action tools**: `mouse_click`, `mouse_drag`, `keyboard_type`,
  `keyboard_press`, `click_element`, `set_element_value`, `browser_click_element`,
  `browser_navigate` now auto-guard using `windowTitle` / `tabId` / `port`
  without requiring `perception_register`.
- `post.perception` is now attached on both success **and failure** responses so
  LLMs can recover from guard blocks without taking another screenshot.
- **HotTargetCache**: hidden short-term target cache (6 slots, idle TTL 90s, hard
  TTL 10 min, bad TTL 15s) for repeated actions on the same window/tab.
  Improves guard performance on consecutive actions; does not consume manual lens
  budget (16 slots).
- **SuggestedFix + `mouse_click({ fixId })`**: one-shot recovery approval when a
  guard detects recoverable coordinate drift or identity change. `fixId` TTL is
  15s. The server revalidates the target fingerprint before executing.
- Environment variable `DESKTOP_TOUCH_AUTO_GUARD=0` to disable all auto-guard
  behavior and revert to v0.11.12 semantics.

### Fixed
- **`mouse_click` guard now evaluates the FINAL click coordinate** (after
  `origin`/`scale` conversion and homing), not the stale input coordinate.
  Previously the guard could silently pass a click whose final screen coordinate
  was outside the lens rect. Manual `lensId` users may see new `GuardFailed`
  errors for cases that were previously silently passing — this is intentional;
  verify the click is actually where you intend.

### Changed
- Tool descriptions for 8 action tools now prefer `windowTitle`/`tabId`
  arguments over explicit `lensId`. `perception_register` is now advertised
  as an advanced/debug API.
- `post.perception` type widened to `PerceptionEnvelope | AutoGuardEnvelope`
  (discriminated by `kind`: `"manual"` vs `"auto"`).

### Compatibility
- Existing `lensId`-based workflows continue to work unchanged.
- `perception_register` / `perception_read` / `perception_forget` /
  `perception_list` API is unchanged.
- `DESKTOP_TOUCH_AUTO_GUARD=0` restores v0.11.12 behavior exactly.
