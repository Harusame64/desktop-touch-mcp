# Changelog

## [Unreleased]

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

- **feat(keyboard, terminal): Focus Leash Phase A — terminal-class auto-route to WM_CHAR.**
  When `keyboard(action, method:'auto')` or `terminal(action:'send', method:'auto')`
  targets a known terminal window (`CASCADIA_HOSTING_WINDOW_CLASS` for Windows
  Terminal / `ConsoleWindowClass` for cmd/PowerShell/conhost), the engine now
  automatically uses HWND-targeted PostMessage delivery instead of the foreground
  keystroke path. Keystrokes intended for a terminal can no longer be diverted to
  other windows when the user grabs focus mid-stream. Existing `DTM_BG_AUTO=1`
  env flag continues to enable BG input globally for non-terminal apps; other
  apps still default to the foreground path.

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

---

## [Unreleased] — browser_eval IIFE wrapping

### Added
- **`browser_eval` IIFE auto-wrapping**: snippets are now automatically wrapped in an async IIFE
  before CDP evaluation. This prevents `const`/`let` redeclaration errors when calling
  `browser_eval` multiple times in the same tab with identical variable names.
- Expression-shaped snippets are wrapped as `;(async () => (expr))()` to preserve the return
  value without requiring an explicit `return`.
- Statement-shaped snippets fall back to an `eval()`-based wrapper that preserves completion
  values (e.g. `const x = 1; x` still returns `1`). On pages with CSP that blocks `unsafe-eval`,
  the wrapper automatically falls back to a plain IIFE block so the snippet still runs (completion
  value may be lost but no error is thrown).
- Explicitly-wrapped IIFE expressions are passed through unchanged.

### Changed
- **`browser_eval` schema description** updated to document the IIFE wrapping behavior and
  note that `window.*` / `globalThis.*` should be used when state must persist across calls.

### Breaking Changes
- **Variable declarations do not persist across `browser_eval` calls.** Previously, `var`
  declarations evaluated in the same CDP session were visible in subsequent calls; they are
  now scoped to each individual snippet. Migrate persistent state to `window.myVar = …` or
  `globalThis.myVar = …`.

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
