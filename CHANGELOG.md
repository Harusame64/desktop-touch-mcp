# Changelog

## [1.0.0] - DRAFT — Tool Surface Reduction Phase 1 + Phase 2 + Phase 3

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

### Tool Count

- Phase 1 + Phase 2 + Phase 3 combined: **65 → 48 tools** (Phase 1: 10 renames, no count change; Phase 2: 13 → 5; Phase 3: 13 → 9 in browser family).
- Stub catalog: **46 entries** (v2 `desktop_discover` / `desktop_act` are dynamic, registered at startup, not in static catalog).

### Phase 3 Outstanding (deferred to Phase 4-5)

- `run_macro` DSL still accepts old tool names (`keyboard_type`, `pin_window`, etc.) via internal `TOOL_REGISTRY` mapping. Will be migrated to new dispatcher names in Phase 4.
- Phase 4 will absorb additional tools (`get_*` series, `set_element_value`, screenshot variants, `events_*` / `perception_*` hide).
- Comments referencing old browser tool names (`src/utils/launch.ts:4`, `src/tools/browser.ts:64/1462/1755`) are LLM non-exposed and queued for Phase 4 polish.
- `scripts/measure-tools-list-tokens.ts` Tier classifications still reflect pre-Phase 1 names — Phase 4 polish or removal candidate.

### Changed

- `src/server-windows.ts` instructions text updated for Phase 1 + Phase 2 naming. Phase 3 leaves browser-specific section addition for Phase 5 dogfood judgement (avoids preemptive surface bloat).
- `src/stub-tool-catalog.ts` regenerated (46 entries after Phase 3).
- All LLM-visible strings (description / suggest / error.message / engine layer literal types / `failWith` tool labels) updated:
  - `_errors.ts` `BrowserNotConnected.suggest` → references `browser_open({launch:{}})`.
  - `desktop-state.ts` `get_document_state` description → references `browser_eval({action:'dom'})`.
  - `browser.ts` `failWith` calls re-attribute internal handlers to their public dispatcher names (`browser_get_dom` / `browser_get_app_state` → `browser_eval`; `browser_launch` → `browser_open`).
- `README.md`, `README.ja.md`, `docs/system-overview.md`, `docs/tool-surface-reduction-plan.md`, `docs/tool-surface-known-issues.md` updated for Phase 3.
- `.gitignore` strengthened: `.vitest-out*.txt` / `.vitest-out*.json` wildcards (Phase 2 §2.6 follow-up).

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
