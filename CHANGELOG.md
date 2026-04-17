# Changelog

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
