---
title: "v2 Milestone — A Sense of Touch"
description: "How the 2.x series gives an agent something like sensory nerves: it learns whether it can touch a target before it acts, says so when it cannot, and reports what it felt when it did."
---

# v2 Milestone — A Sense of Touch

> v1.0 narrowed the surface. v1.2 deepened each response. v1.4 made delivery trustworthy, and v1.8 carried it through to completion. v1.9 extended targeting by meaning to the browser, and v1.10 brought visual confirmation into the act itself. The 2.x series turns to something more basic. In human terms, it is the work of growing sensory nerves: knowing whether a thing can be touched, knowing when it cannot, and knowing what touching it was like. It begins to give an LLM driving a desktop these three forms of feedback. The nerves are still growing.

## Where v1.16 left things

By v1.16 an agent could discover a target by meaning, then act on its lease and receive confirmation in the same response. But some failures still looked like success.

When the screen no longer matched what `desktop_discover` had seen, `desktop_act` guessed. It pressed the remembered coordinates, typed into whatever held the focus, or treated `select` as a click, and answered `ok: true` whether or not the thing the agent asked for had happened. A button renamed since discover was pressed by position. Text meant for a check box went out as keystrokes to some other field.

In those cases, `ok: true` did not tell the agent whether the intended action had happened, so it could not tell the press that landed from the press that went somewhere else.

## Can it be touched? — checking before the act (2.0, 2.1)

2.0 changes what `desktop_act` does when the world has moved on: it checks first. If the window has changed, the control is gone, a dialog is in the way, or the target does not take that action, the act is **refused under a named `reason`**, with next steps, and nothing is pressed or typed.

- A lease taken before another discover of the same window answers `entity_not_found`, not `unknown`.
- `type` or `setValue` on a button, check box, link or menu item answers `action_not_offered` instead of typing into whatever has the focus.

Separately, `keyboard` with `method: "background"` rejects Ctrl, Shift or Alt combinations with `BackgroundModifierComboUnsupported` instead of sending the unmodified key; with `method: "auto"` they go through the foreground.

This is why 2.0 is a major version. Several replies changed shape, and agents that branch on `reason` had to learn new names. The trade is deliberate: a refusal you can act on, in place of a success that may not be true.

2.1 widens what the agent can feel at all. The shallow UI Automation read left browsers and Electron apps largely dependent on OCR, and missed deeper controls in Explorer, Settings and Word. In 2.1 the native UI Automation read reaches depth 64, capped at 500 elements (the PowerShell fallback keeps the old depth). On the Windows 11 machine used for the release measurements, a Chrome page went from 6 OCR elements to its 45 controls, and VS Code from 6 elements to 128. Word's body, Store Notepad's text and Calculator's digit buttons became things an act can reach.

The same release fixes the UI Automation focus handling that could leave mouse movement and window switching stuck after an acted-on window closed, though menu and fallback paths still have limitations. A sense of touch that numbs the hand is not much use.

## Cannot be touched — saying so (2.2)

Knowing that something *cannot* be touched is as much a sense as knowing that it can. 2.2 stops answering as if it had seen what it did not.

- **A suspended app is not read from its last frame.** Windows suspends a Store app a second or two after it is minimised or hidden. Before 2.2, discover OCRed that frozen frame, account name included, as if it were the window now. When suspension is detected, OCR and text screenshots now refuse the read with `WindowFrozen`, discover reports `entityZeroReason: "window_frozen"`, and `windows[]` marks such windows `isFrozen`.
- **A covered window is not reported unchanged.** After an act, `observation` counts only the part of the window that is on screen. If the visible part did not change and the rest was covered, the answer is `indeterminate`, with `visibleFraction`, not `no_change`.
- **A truncated entity list says it is incomplete.** When discover limits the response to `maxEntities`, it returns the `entities_capped` warning and an `entitiesCapped` field, instead of leaving entities out without a word.

The macOS preview in 2.3 follows the same rule from its first release. An act is refused with `entity_not_found` when the window or element changed since discover, and with `modal_blocking` when a sheet is open over it.

## What did touching feel like? — reporting after the act (2.3)

The last nerve carries the answer back. Once an action has been sent, the agent needs to know what happened, including "it may have happened; look before you try again".

- **A click on a list item selects it** (2.3.1). A `desktop_act` click on a native list item used to go through UI Automation's Invoke, which acts as a double-click: Explorer opened the file, and a WinForms list view did nothing yet answered `ok: true`. The click now selects the item; use `action: "invoke"` to open or run it. Chromium-based content keeps its Invoke behavior, and `click_element` is unchanged.
- **A press that failed after it was sent says so** (2.3.1). When a `desktop_act` UI Automation press reports failure after dispatch, the call returns `aim_route_failed` and warns that the press may already have happened. It no longer falls back to a second mouse press at the same point.
- **A failed value write is checked before typing again** (2.3.2). On the native UI Automation path, the field is read back after the write reports failure. If it holds the requested value, the act reports success; if it changed to another value, it returns `value_not_applied` without typing again. If it is unchanged or cannot be read, the keyboard fallback remains.
- **`browser_click` lands where it aims** (2.3.2). After bringing the browser forward, it checks which window would receive the click before moving the cursor. A covering window, including a panel, popup or dialog of the browser itself, causes `BrowserPointCovered`; if Windows cannot answer the hit test, the click proceeds as before. The same release corrects clicks that landed roughly 8–12 px too low, points that drifted at any page zoom other than 100 %, and clicks that could land in another window showing the same title.

## Still being built

This is a nervous system under construction, and it still has numb spots and false alarms. A few are written down in the release notes:

- `desktop_discover` aimed at a Store app's frame window by its handle, rather than by its title, is not yet tested for suspension.
- A control whose label changes between discover and act (a `Play` button that turned into `Pause`) is refused, though it is the same control.
- With DevTools or a side panel docked beside a page, `browser_click` can still be off horizontally by half the panel's width and vertically by about 8 px.

Each one is a place where the agent cannot yet tell what it is touching. The direction does not change: when in doubt, say so and do nothing, rather than act and report success.

## Conclusion

The 1.x series taught desktop-touch to aim. It found targets by meaning, delivered input reliably and waited for commands to finish. The 2.x series teaches it to *feel*. Before an act it checks whether the target can be touched. When it cannot be, it says so. After an act it reports what happened, including when it is not sure. The agent on the other end has more evidence about whether a touch landed, and clearer signals when the system cannot tell. Those signals help it decide whether to continue, look again or stop.

> These tools are Windows-first; the macOS preview covers four tools. The refusals and reasons described here keep growing release to release.

## Next Steps

- View the full [Changelog on GitHub](https://github.com/Harusame64/desktop-touch-mcp/blob/main/CHANGELOG.md), including the 2.0.0 table of breaking changes
- Read the [v1.10 milestone article](./v1.10-milestone.html) — targeting by meaning, confirming in one call
- Read the [v1.8 milestone article](./v1.8-milestone.html) — from delivery to completion
- Read [Beyond Coordinate Roulette](./beyond-coordinate-roulette.html) — why operating by meaning beats operating by pixels
