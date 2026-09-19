## Standard workflow (v1.0.0)

The v2 World-Graph surface (`desktop_discover` / `desktop_act`) is the recommended dispatch path. The four-call shape works for native apps, browsers, and terminals identically.

```
desktop_state          → orient: focused window/element, modal, attention signal
desktop_discover       → find actionable entities (returns lease + windows[])
desktop_act(lease, …)  → act on entity (returns attention + post.perception)
desktop_state          → confirm the world changed as expected
```

Clicking — priority order:

```
browser_click(selector)               → Chrome / Edge (CDP, stable across repaints)
desktop_act(lease, action='click')    → native / dialog / visual (entity-based; use after desktop_discover)
click_element(name | automationId)    → native UIA fallback if desktop_act returns ok:false
mouse_click(x, y, origin?, scale?)    → pixel last resort; origin+scale from dotByDot screenshots only
```

Recovery hints — read `response.attention` after every observation and `response.warnings[]` on `desktop_discover` / `desktop_act`. Common reasons:

- `lease_expired` / `lease_generation_mismatch` / `lease_digest_mismatch` / `entity_not_found` → re-call `desktop_discover`
- `modal_blocking` → `response.blockingElement` (when present) names the blocking modal. `role: "dialog"` means a separate dialog window has disabled the target's window: `blockingElement.hwnd` is that dialog — re-call `desktop_discover` with `target.hwnd = blockingElement.hwnd`, answer it there, then retry (`name` is its title, which may be empty or shared). Any other role: a window the `desktop_discover` snapshot holds, where the OS could not say whether it blocks this entity — with `blockingElement.hwnd`, re-call `desktop_discover` with `target.hwnd = blockingElement.hwnd` and answer it there; without it, dismiss via `click_element(name=blockingElement.name)`. Then re-call `desktop_discover` on the original target and act on the new lease — this refusal came from that snapshot, so the same lease is refused again
- `entity_outside_viewport` → the element moved off screen: `scroll(action='to_element' | 'raw')`, or re-call `desktop_discover` if its window moved or closed
- `origin_window_not_visible` → the element's window is minimised or hidden, so nothing is drawn where it was found: `focus_window(windowTitle)` to restore it, then re-call `desktop_discover`
- `coordinate_outside_reachable_bounds` → the coordinate is not on any connected monitor. Coordinate-based mouse input (`mouse_click` / `mouse_drag` / `scroll` / `browser_click`, and the mouse route inside `desktop_act`) now works on every monitor, including monitors placed left of or above the primary one, so this error normally means the coordinates are stale — the window moved or closed after they were read. Re-run `desktop_discover` and act on the new coordinates. If the server is running without its built-in Windows input module, mouse input falls back to the primary monitor only; the error message says so, and moving the window onto the primary monitor (or reinstalling the server) is the fix
- `cursor_placement_blocked` → the coordinate is on a monitor, but the pointer could not be placed there, so nothing was clicked. This happens while another app confines the cursor to its own window (common in full-screen games), while a remote-desktop session is disconnected or locked, while another program keeps repositioning the pointer, or right after a monitor is added or removed. Leave the app holding the cursor, reconnect the session, or — after a monitor change — re-run `desktop_discover`, then retry. `click_element` acts through the accessibility API without moving the cursor and works meanwhile
- `keyboard_target_unsafe` → a `type` was refused, because the characters would not have reached the field you named: the keyboard focus is on a different control or in a different window, the control that would receive them is read-only, or the field you named — or its window — is disabled. Nothing was typed, and `if_unexpected.detail` says which. For a disabled field, answer or wait out whatever disabled it, then re-run `desktop_discover` and type again; clicking it does not help, and `desktop_discover` does not list a disabled field, so while it is missing there it is still disabled. For another control or window, put the focus on the field you named, then type again; `if_unexpected.detail` names the way back for the road the act took. On a window named by title, `desktop_act` with `action='click'` on the same entity does it. On a window named by handle nothing here moves the focus to a text field yet, so re-run `desktop_discover` by the window's title and click the field there — a common dialog's title resolves to a handle as well, so that road does not open there. For another window, bring the field's window forward first (`focus_window`): it comes forward with the focus it last had, and the window holding the focus is usually drawn over the field. Do not retry with a foreground `keyboard` type: whatever holds the focus would take the characters
- `executor_failed` → fall back to `click_element` / `mouse_click` / `browser_click`

A successful `type` can carry `landing: { confirmed: false, why }`. The write took the background route, but the server could not confirm that it reached the field you named — for example, in a WPF window, whose fields have no window of their own. **This is a report, not a state that can be resolved here**: nothing in the response establishes whether the characters arrived, reading the field back does not settle it (`desktop_state` answers about the foreground, and may come back with no value at all — `hints.focusedElementValueAbsent` names the road that dropped it, `view_road_has_no_value` or `masked_on_this_road`, and no hint is not evidence a value was there — or name a field in another window with the same title), `diff.value_changed` is not delivery either, its baseline being your `desktop_discover` snapshot rather than the write, and retrying a nonempty write is not a repeat — a background write lands at the caret and replaces the selection, exactly as typing does.

Lease lifecycle:

- Each `desktop_discover` response carries `softExpiresAtMs` (≈ 60 % of the TTL window). Past that timestamp the LLM should consider re-calling `desktop_discover` even though the lease is still technically valid — `lease.expiresAtMs` is the only correctness wall.
- TTL adapts to `view` mode (`action`/`explore`/`debug`), entity count, and response payload size. Cap is 60 s.
- Set `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1` to fall back to the v1 tool surface (`get_windows` / `get_ui_elements` / `set_element_value`) for troubleshooting only — V2 is the recommended default.

---

