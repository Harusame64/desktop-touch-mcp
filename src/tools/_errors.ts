import { fail, type ToolFailure, type ToolResult } from "./_types.js";
import { ToolFailureError } from "../errors/typed-errors.js";

// Context keys that must be hoisted to the root of the failure JSON so that
// _post.ts (withPostState) can find them. `_post.ts` reads obj._perceptionForPost /
// obj._richForPost from the root of the parsed response body; if we let failWith
// put them under `context`, the failure path never attaches post.perception.
//
// Issue #181: `hints` is also hoisted so that typed delivery codes
// (BrowserClickNotDelivered / BrowserFillNotDelivered) can carry a
// verifyDelivery hint at the same envelope position as the success path
// (matrix doc §4.2 規範 shape). Without hoisting, the hint would be buried
// under `context.hints.verifyDelivery` on failures and `hints.verifyDelivery`
// on success — an asymmetry that would force callers to look in two places.
const ROOT_HOISTED_KEYS = new Set<string>(["_perceptionForPost", "_richForPost", "hints"]);

// ─────────────────────────────────────────────────────────────────────────────
// Error code → suggest dictionary
// ─────────────────────────────────────────────────────────────────────────────

const SUGGESTS: Record<string, string[]> = {
  InvalidArgs: [
    "Check the required parameters for this tool",
    "At least one of name or automationId must be provided",
  ],
  WindowNotFound: [
    "Run desktop_discover to see available titles",
    "Try a shorter partial title match (e.g. first word only)",
    "The window may be minimized — try focus_window first",
    "If the app is still launching, use wait_until(condition='window_appears') before focus_window",
    "If the target is a Chrome/Edge tab (only the active tab's title appears in window titles), use browser_open to get the tabId, then browser_navigate to the target URL to switch tabs",
  ],
  ElementNotFound: [
    "Call desktop_discover to see candidate names and automationIds",
    "Use screenshot(detail='text') for actionable[] with clickAt coords",
    "Try a shorter partial name match",
    "The element may not be visible yet — use wait_until(condition='element_appears')",
  ],
  InvokePatternNotSupported: [
    "Use mouse_click with clickAt coords from screenshot(detail='text')",
    "Use desktop_act({action:'setValue'}) for text input fields",
    "Use screenshot({region:{x,y,width,height}}) to inspect the element region (after desktop_discover)",
  ],
  BlockedKeyCombo: [
    "Use workspace_launch to open applications by name instead",
    "If you need shell execution, use terminal({action:'send'}) to an existing terminal window",
  ],
  UiaTimeout: [
    "The target app may be unresponsive — wait and retry",
    "Try screenshot(detail='image') as a visual fallback",
  ],
  ElementDisabled: [
    "The element exists but is currently disabled",
    "Use wait_until(condition='value_changes') to wait for it to become enabled",
    "Check page state with screenshot(detail='text') before retrying",
  ],
  BrowserNotConnected: [
    "Call browser_open first with the correct port",
    "Verify Chrome was launched with --remote-debugging-port",
    "Or call browser_open({launch:{}}) to spawn a debug-mode Chrome on the configured port",
  ],
  TerminalWindowNotFound: [
    "Call desktop_discover to see available titles",
    "Try a partial title match (e.g. 'PowerShell' or 'pwsh')",
    "Filter by processName: pwsh / powershell / cmd / bash / WindowsTerminal",
  ],
  TerminalTextPatternUnavailable: [
    "Retry with source:'ocr' to use Windows OCR",
    "Or source:'auto' to auto-fallback when TextPattern is missing",
    "Some terminal apps (e.g. WSL inside vt100) do not implement TextPattern",
  ],
  // issue #386: terminal(action='run', until:{mode:'exit'}) appends a completion
  // epilogue after your command. If the command ends in an OPEN construct, the
  // shell keeps parsing into the epilogue instead of running it, so the
  // completion sentinel never prints and the run would time out. Rejected
  // up front (no command sent) so the caller can fix the input or pick a mode
  // that does not inject an epilogue. context.reason names the detected
  // construct.
  ExitModeUnsafeInput: [
    "until:{mode:'exit'} cannot append its completion epilogue after an input that ends in an open construct — close it first.",
    "context.reason names what was detected: heredoc (<<EOF), unbalanced_quotes, unterminated_command_substitution ($(…), powershell_herestring (@\"…\"@), or trailing_line_continuation (\\ or backtick).",
    "Or switch to until:{mode:'pattern', pattern:'<final output>'} / {mode:'quiet'} — those do not inject an epilogue and accept any input.",
  ],
  // issue #386: until:{mode:'exit'} resolved (or was told) to cmd.exe. cmd's
  // exit code needs delayed expansion (`cmd /v:on` + !ERRORLEVEL!), a separate
  // invocation path not wired in the first release. bash and PowerShell are
  // first-class.
  ExitModeShellUnsupported: [
    "until:{mode:'exit'} supports shell:'bash' and shell:'powershell'. cmd.exe is not supported yet (its exit code needs a separate `cmd /v:on` delayed-expansion path).",
    "If the terminal runs bash or PowerShell, pass that shell explicitly (shell:'bash' / shell:'powershell').",
    "For cmd.exe, use until:{mode:'pattern', pattern:'<final output>'} instead.",
  ],
  // issue #386: until:{mode:'exit', shell:'auto'} could not identify the shell
  // from the window's process. Hosts like Windows Terminal / conhost / OpenSSH
  // hide the real shell (classic PowerShell often surfaces as conhost; an
  // SSH/WSL session hides the remote shell entirely). Guessing wrong would send
  // a broken epilogue, so this fails loudly and asks for an explicit shell.
  ExitModeShellAmbiguous: [
    "until:{mode:'exit', shell:'auto'} could not tell which shell the terminal runs — the host process hides it (Windows Terminal / conhost / OpenSSH, or an SSH/WSL session).",
    "Pass shell:'bash' or shell:'powershell' explicitly to match the shell actually running in that window.",
    "context.processName shows the host process that was detected, for reference.",
  ],
  BrowserSearchNoResults: [
    "Try a different 'by' axis (text → ariaLabel, regex → role)",
    "Remove the scope parameter to search the full document",
    "Set visibleOnly:false to include hidden / off-viewport elements",
    "Toggle caseSensitive:false for text and regex",
  ],
  BrowserSearchTimeout: [
    "Reduce maxResults",
    "Narrow the scope via a CSS selector",
    "Try by:'selector' for a specific element if you know it",
  ],
  ScopeNotFound: [
    "Verify the scope CSS selector matches at least one element",
    "Omit the scope parameter to search the full document",
  ],
  WaitTimeout: [
    "Increase timeoutMs",
    "Verify the target window/element appears as expected",
    "Check intermediate state with screenshot(detail='meta') or desktop_state()",
  ],
  ScrollbarUnavailable: [
    "The target window has no Win32 scrollbar (e.g. overlay scrollbars or non-scrollable content)",
    "Try strategy:'image' with a hint param for binary-search scrolling",
    "Verify the target is actually a scrollable container",
  ],
  OverflowHiddenAncestor: [
    "A parent element has overflow:hidden which silently swallows scroll input",
    "Pass expandHidden:true to temporarily unlock it (mutates live CSS)",
    "Or click an expand/collapse control on the page to reveal the content first",
  ],
  VirtualScrollExhausted: [
    "The virtualised list did not reach the target after retryCount attempts",
    "Provide virtualIndex + virtualTotal for direct proportional seeking",
    "Increase retryCount (default 3) or narrow search with hint:'above'|'below'",
  ],
  GuardFailed: [
    "Read the perception envelope for attention/guard details",
    "Call desktop_state to force a fresh observation before retrying",
    "Consider a corrective action: focus_window, dismiss modal, or wait_until",
  ],
  // Phase 6 PR-B (epic #211 6-4): AutoGuard pre-action gate refused the
  // operation because the target's perception envelope is unsafe for an
  // immediate action. The error message preserves the guard's 1-sentence
  // `summary.next` (`AutoGuardEnvelope.next`) which encodes a tailored
  // recovery for the specific block reason. Block-reason space is the
  // `AutoGuardStatus` enum at `src/engine/perception/action-target.ts:53`
  // (9 values: ok / unguarded / ambiguous_target / target_not_found /
  // identity_changed / blocked_by_modal / unsafe_coordinates /
  // browser_not_ready / needs_escalation; only the latter 7 surface as
  // blocks since `ok` / `unguarded` allow the action through).
  AutoGuardBlocked: [
    "Read the error message — its tail preserves the auto-guard's 1-sentence recommended next step (refreshed each call from `summary.next`).",
    "If the descriptor matched multiple targets (ambiguous_target), narrow windowTitle / name / automationId until a single target resolves.",
    "If the target was not found (target_not_found), run desktop_discover — the window or element no longer matches the current desktop state.",
    "If a modal is blocking the action (blocked_by_modal), dismiss it (Escape, or click the appropriate button) before retrying.",
    "If the browser tab is not ready (browser_not_ready), call browser_open or wait_until({condition:'ready_state'}) on the target tab.",
    "If the target requires admin elevation (needs_escalation), re-run the MCP server elevated, or match elevation levels on both sides.",
    "If app state shifted under the lens (identity_changed) or coords look stale (unsafe_coordinates), refresh via desktop_state or screenshot before retrying.",
  ],
  LensNotFound: [
    "Drop the lensId — Auto Perception tracks state when you pass windowTitle / tabId directly",
    "If you cached a lensId from a prior session, treat it as expired",
  ],
  BackgroundInputUnsupported: [
    "Target app does not accept background input - use method:'foreground' or omit",
    "For Chrome/Edge: use browser_fill instead",
  ],
  // Issue #197: focus_window auto-escalation (default SetForegroundWindow →
  // 100ms wait → re-enum → AttachThreadInput force-focus → re-enum) failed to
  // bring the target window to the foreground. Win11 enforces tight foreground
  // transfer rules (UIPI cross-elevation, calling-thread-not-foreground rule,
  // admin/non-admin asymmetry); when both the default and force paths are
  // refused we surface this typed code so callers stop trusting a silent
  // ok:true and choose a fallback path explicitly.
  ForegroundRestricted: [
    "Windows blocked SetForegroundWindow even after AttachThreadInput escalation — UIPI cross-elevation barrier or admin-only target.",
    "Run the MCP server elevated (admin) if the target is elevated, or match elevation levels on both sides.",
    "If the call originates from a background process or service, the OS suppresses foreground transfers — proxy the focus request via the foreground app.",
    "Skip explicit focus_window: tools that accept windowTitle directly (keyboard / desktop_act / browser_click) handle focus internally and may succeed where focus_window cannot.",
  ],
  BackgroundInputIncomplete: [
    "Input sent partially - retry with method:'foreground' for full input",
    "Check context.sent vs context.total",
  ],
  BackgroundInputNotDelivered: [
    "Retry with method:'foreground' — post-send UIA read-back could not find the input echoed in the terminal buffer.",
    "Common cause: Windows Terminal (WinUI/XAML host) silently drops WM_CHAR; use foreground SendInput.",
    "Common cause: terminal runs elevated (admin) while caller does not — UIPI blocks PostMessage.",
    "False-positive cause: hidden-input prompts (password / sudo / ssh / Read-Host -AsSecureString) accept WM_CHAR but suppress echo, so this check cannot distinguish delivery from drop. Use method:'foreground' for credential entry.",
  ],
  // Issue #245 系統②b: keyboard({action:'type', forceKeystrokes:true, use_clipboard:false})
  // refused to inject when the target window's IME is currently ON. Without
  // this guard the keystrokes would feed the IME composition pipeline and the
  // resulting text would not match the requested `text` (silent romaji
  // conversion). The handler reads IME open-status via the Imm32 bridge
  // (`ImmGetDefaultIMEWnd` + `WM_IME_CONTROL`) before the inner pipeline,
  // so the failure is fast and lossless — no characters have been sent yet.
  ImeOnDuringType: [
    "Pass forceImeOff:true to flip the IME OFF for the duration of this call (and restore in finally).",
    "Pass use_clipboard:true to bypass the keystroke pipeline — the clipboard route is IME-immune.",
    "Drop forceKeystrokes (default false) so auto-clipboard promotion handles non-ASCII / IME-active windows transparently.",
    "Diagnose live state via desktop_state — hints.imeOpen reports the focused window's IME composition mode.",
  ],
  // Issue #180 (matrix doc §3.1 / §5.2): clipboard(action:'write') post-write
  // read-back returned bytes that disagree with the requested UTF-16LE payload.
  ClipboardWriteNotDelivered: [
    "Another application replaced the clipboard contents between Set-Clipboard and the verification read — retry, ideally without a clipboard manager intercepting writes.",
    "DLP / endpoint security may sanitize or block clipboard writes; check organisation policy or test on an unmanaged session.",
    "RDP / Citrix / ChromeBook clipboard sharing can drop or transcode UTF-16 payloads — verify on the local console session.",
    "Clipboard format conversion (CF_UNICODETEXT vs CF_TEXT) lost characters; try shorter ASCII text to isolate, then file an issue with the original payload's hex dump.",
    "Treat the clipboard as un-written on this failure: do not assume a paste downstream will see the requested value.",
  ],
  // Issue #178: SendInput-based mouse_click delivered nothing observable.
  // Pre/post ElementFromPoint + foregroundWindow + focusedElement diff was empty.
  // matrix doc §3.1 row mouse_click; suggest[] follows §5.2 click-specific advice.
  MouseClickNotDelivered: [
    "Retry with elementName + windowTitle to use UIA InvokePattern via click_element (more reliable than pixel click)",
    "Use desktop_act(lease, action='click') with a freshly-discovered lease — entity-based click survives layout shifts",
    "Verify the click coordinate is inside the target window rect — homing may have stale window bounds; refresh via screenshot or desktop_state first",
    "If the target runs elevated (admin) and the MCP server does not, UIPI silently blocks SendInput at the cursor — relaunch the server elevated or use a non-elevated target",
    "For Chrome/Edge: prefer browser_click (CDP) over pixel mouse_click — CDP click survives repaints and reports DOM ack",
  ],
  // Issue #178: SendInput drag sequence delivered nothing observable.
  // mouse_drag failure modes are qualitatively different from mouse_click: the
  // sequence (down → moves → up) can break partway, modifier-key state can drop
  // mid-drag, and dragdrop API targets need DROPEFFECT inspection. Keep suggest[]
  // separate from MouseClickNotDelivered (matrix doc §5.2 justify).
  MouseDragNotDelivered: [
    "Retry the drag at a slower speed — fast drags can outpace the target's drop-target hit testing",
    "If the drag is meant to scroll, use scroll(action='raw' or 'smart') instead — scroll has a dedicated delivery contract",
    "For tab rearrangement: pass allowTabDrag:true if the drag intentionally starts in a tab strip",
    "For cross-window drops: pass allowCrossWindowDrag:true — endpoint-window mismatch is blocked by default",
    "If a modifier key (Shift / Ctrl) must be held during the drag, send it via keyboard({action:'press'}) before the drag and release after — modifier state is not preserved across the SendInput sequence",
    "If the drop target is a dragdrop API consumer (Explorer, IDE file tabs), pixel SendInput cannot signal DROPEFFECT — use desktop_act(lease, action='drag') if the target is UIA-discoverable",
  ],
  // Issue #177: keyboard({action:'press', method:'background'}) WM_KEYDOWN/UP
  // delivery verification (terminal-class targets only). Distinct from
  // BackgroundInputNotDelivered because the channel is WM_KEYDOWN/UP (key combo)
  // not WM_CHAR (text), and the verification scope is narrower (only enter /
  // tab / arrow keys produce a buffer mutation that UIA TextPattern read-back
  // can detect — other combos return hints.verifyDelivery: 'unverifiable'
  // instead of failing). Suggest copy is keyboard-press specific so classify()
  // is 1:1 with SUGGESTS dictionary (PR #174 Codex round 2 P1-1 SSOT pattern).
  BackgroundKeyNotDelivered: [
    "Retry with method:'foreground' — post-send UIA read-back did not observe the expected buffer mutation (cursor advance / new line / tab insertion).",
    "Common cause: Windows Terminal (WinUI/XAML host) silently drops WM_KEYDOWN; use foreground SendInput which dispatches via the system input queue.",
    "Common cause: terminal runs elevated (admin) while caller does not — UIPI blocks PostMessage.",
    "Verification scope: only enter / tab / arrow keys are read-back-verified on terminal-class targets. Other combos return hints.verifyDelivery:'unverifiable' rather than this error — caller should observe the semantic effect (e.g. menu open, selection change) directly.",
  ],
  // Issue #181 / matrix doc §3.1 §5.2: post-click DOM mutation verification
  // failed to observe ANY signal (MutationObserver event, URL change, or
  // document.activeElement change) within the verification window. The click
  // dispatch itself succeeded at the OS level — the page simply did not respond.
  // Most common cause: SPA button rendered without an event listener attached
  // (silent-fail signature isolated by issue #181).
  BrowserClickNotDelivered: [
    "The element rendered, but no DOM mutation, URL change, or focus change followed the click — the page may have no handler attached.",
    "Verify the selector targets the actual interactive element (a button label / icon span often forwards clicks to a parent button)",
    "If the page uses delayed handlers (>500ms), retry then immediately read state with browser_eval to confirm the action took effect",
    "For canvas / WebGL apps, DOM mutations are not produced — switch to browser_eval to assert against the app's own state, or use mouse_click against the same coords",
    "If the target is inside a cross-origin iframe, the verification scope is the top frame only — pin the iframe with a frame selector before clicking",
  ],
  // Issue #181 / matrix doc §3.1 §5.2: post-fill element.value read-back did
  // not match the requested value. False-positive watch (matrix doc §5.2):
  // React/Vue controlled inputs may transform the value in onChange (e.g.
  // numbers-only filter strips letters, max-length truncates), in which case
  // the value was delivered but stored as transformed. The hint surfaces a
  // sub-reason `controlled_input_transform` so the caller can disambiguate
  // without resorting to a generic retry.
  BrowserFillNotDelivered: [
    "The input rejected or transformed the value — element.value after fill did not match the requested string.",
    "If hints.verifyDelivery.subReason is 'controlled_input_transform', the value reached the page but the framework rewrote it (e.g. numbers-only filter, max-length truncation, format mask). Treat the actual value (echoed in context) as authoritative.",
    "If the input has a pattern / inputmode / type=number constraint, try sending an already-canonical value (digits only, lowercased, etc.)",
    "For inputs guarded by React's synthetic-event proxy, try keyboard(action='type') against the focused element as a fallback (slower but framework-agnostic)",
    "Verify the selector targets an <input> / <textarea> — contenteditable div uses different setters (use browser_eval instead)",
  ],
  // Issue #179 / matrix doc §3.1+§5.2: scroll(action:'raw') wheel SendInput was
  // ack'd by the OS but post-state Win32 GetScrollInfo (or UIA ScrollPattern, or
  // image-hash diff) observed no movement on the requested axis with pre off-
  // boundary, so the wheel was silently swallowed (overlay window above target,
  // non-scrollable container, UIPI from low-IL into elevated app, etc).
  // Distinct from `ScrollbarUnavailable` (no scrollbar at all — caller redirected
  // to image strategy) and `OverflowHiddenAncestor` (CSS overflow:hidden detected
  // up-front in scroll(action:'smart')); ScrollNotDelivered is reserved for the
  // post-ack silent-drop case the other two cannot catch.
  //
  // ADR-018 Phase 1b will replace the 4-value `hints.verifyDelivery.reason` enum
  // with a 5-value tier-based enum (delivered_via_uia / delivered_via_cdp /
  // delivered_via_postmessage / wheel_overlay_intercepted / target_unreachable).
  // The suggest copy below references the new names where appropriate so callers
  // reading suggestions today are already pointed at the destination-explicit
  // recovery strategies (UIA ScrollPattern / CDP / PostMessage) that ADR-018
  // landings will make first-class.
  ScrollNotDelivered: [
    "Retry with scroll({action:'smart', target:'<selector>'}) — multi-strategy fallback (CDP / UIA ScrollPattern / image binary-search) often delivers where wheel SendInput is swallowed",
    "Use scroll({action:'to_element', name|selector}) when you know the target — bypasses the wheel channel entirely via UIA ScrollItemPattern or CDP scrollIntoView (the same Tier 1 / Tier 2 destination-explicit channels ADR-018 Phase 1b/3 wire into action='raw')",
    "Verify the target is actually scrollable: run desktop_state or screenshot(detail='text') first to confirm the focused element under the cursor accepts wheel input — transparent layered overlays (Dell DDPM, Logitech Options+, etc.) intercept wheel events and produce reason='wheel_overlay_intercepted' once ADR-018 Phase 4 detection ships",
    "If the target runs elevated (admin) and the caller does not, wheel events are blocked by UIPI — re-run the caller with matching integrity level",
    "If the target uses overlay/Chromium scrollbars (no Win32 scrollbar), pass coords inside the actual scrollable region — the cursor must be over a scroll-receiving element. For Chrome/Edge tabs prefer scroll(action:'smart') which uses CDP (the same path ADR-018 Phase 3 wires into action='raw' as Tier 2)",
  ],
  SetValueAllChannelsFailed: [
    "Verify the element supports text input",
    "Try click_element + keyboard({action:'type'}) manually",
    "Check context.attempts for per-channel error codes",
  ],
  // Issue #327 item G: `desktop_act` returned `reason: "executor_failed"` —
  // the GuardedTouchLoop selected an executor and the executor threw
  // (`guarded-touch.ts:315-319`). Most common dogfood causes (issue #327):
  // (C) UIA Edit/Document control without InvokePattern, so click fell
  // through then mouse-fallback was also skipped, and (E) UIA Edit without
  // a usable name/automationId for the `setValue` PowerShell locator filter.
  // The hints below point to the alternate channels for each action,
  // matching the wiring the dogfood confirmed actually works.
  ExecutorFailed: [
    "For action='click', fall back to mouse_click({clickAt}) using the entity rect center from desktop_discover — common when UIA InvokePattern is missing on the control",
    "For action='type' or action='setValue': desktop_act has already tried UIA setValue and background WM_CHAR (post-#327 E ladder) before reporting executor_failed. The remaining rung is keyboard({action:'type', text, method:'foreground'}) — foreground SendInput uses the OS input queue and bypasses BG injection blocks that stopped the internal ladder (Chromium hosts, WT-XAML, etc.). Focus the target window first with focus_window or mouse_click",
    "If the entity has a stable name or automationId, try click_element({name|automationId}) — uses a different UIA path than desktop_act and may succeed where this executor threw",
    "Re-run desktop_discover — the entity may have moved or been re-keyed between discover and act, in which case the executor saw a stale locator",
  ],
  // Phase 2a F4 / Phase 5 I1: keyboard({action:'type'}) Focus Leash Phase B
  // mid-stream focus theft. matrix §3.1 line 141 規範:
  // foreground-stealing protection が caller の send 中に他 window へ focus
  // を奪った場合、SendInput が誤窓に landing するのを防ぐため send を中断し
  // typed/remaining を返す。caller は context.remaining を text として
  // re-focus + retry することで full delivery を完了できる。
  FocusLostDuringType: [
    "User stole foreground mid-type — re-focus the target window then call keyboard(action:'type') again with context.remaining as text",
    "For terminals, prefer method:'auto' so input routes through HWND-targeted WM_CHAR (Phase A — foreground-independent)",
    "Pass abortOnFocusLoss:false to disable the leash and fall back to single-shot send (post-action focusLost detection still runs)",
  ],
  // Issue #257: keyboard(action:'sequence') mid-loop focus loss.
  // The first step opened a menu (or asserted FG); a later step's pre-check
  // saw foreground change to a different hwnd, so the remaining keystrokes
  // would land on the wrong target. context.remaining echoes the un-issued
  // Step[] so the caller can re-focus and re-invoke without re-deriving the
  // suffix.
  MenuFocusLostMidSequence: [
    "Focus left the target between steps — re-focus the window then call keyboard({action:'sequence', steps: context.remaining, windowTitle, ...}) to continue.",
    "If the menu state is unrecoverable (auto-closed by the OS), pivot to desktop_act / click_element for the remaining action.",
    "For long sequences, reduce step count or rely on UIA targeting instead of Alt-mnemonic chord navigation.",
  ],
  // Issue #257: keyboard(action:'sequence') is FG-only by construction
  // (Alt-menu mnemonic activation requires real SendInput; WM_KEYDOWN does
  // not open menus on non-terminal windows). The Zod schema only accepts
  // method:'foreground'|undefined, so this typed code surfaces when the
  // schema-level check is somehow bypassed (defensive only).
  ForegroundFlashNotApplicableToSequence: [
    "Sequence is foreground-only. Use keyboard(action:'press') with method:'foreground_flash' for individual key combos that need the ADR-013 妥協 path.",
    "If you need to chord Alt-mnemonics in a terminal, split the sequence into per-step keyboard(action:'press') calls.",
  ],
  // Issue #279: keyboard(action:'press') rejects method:'foreground_flash'
  // because clipboard-paste cannot deliver a key combo (would require Ctrl+V
  // to inject Ctrl+V — circular). ADR-013 Option E targets text injection
  // (keyboard:type / terminal:send) only. Producer: keyboard.ts:1490.
  ForegroundFlashNotApplicableToKeyPress: [
    "method:'foreground_flash' is for text injection (keyboard:type / terminal:send) only — clipboard paste cannot carry a key combo.",
    "For the key combo, call keyboard({action:'press', keys, method:'foreground', windowTitle}) instead (default FG SendInput).",
    "If the target supports background injection (WM_KEYDOWN-class hosts), keyboard({action:'press', keys, method:'background', windowTitle}) also works.",
    "If you actually wanted to paste text (not chord keys), switch to keyboard({action:'type', text, method:'foreground_flash', windowTitle}) or terminal({action:'send', input, method:'foreground_flash'}).",
  ],
  BackgroundNotApplicableToSequence: [
    "Sequence does not support the background path — Alt-menu mnemonics require real SendInput which only the foreground path provides.",
    "Use foreground (default) and target via windowTitle/hwnd, or split into separate keyboard(action:'press') calls if BG delivery is essential.",
  ],
  // Phase 7 F3: workspace_launch spawnDetached rejection (ENOENT / EACCES /
  // EPERM 等) の typed reason。production handler は `failWith(err)` 経由で
  // generic `ToolError` に流れていた (Phase 6 dogfood で発見)、agent が typed
  // code 経由 retry pattern を組めない silent fall-through だった。
  // launch.ts:148-152 の hint message を `SpawnFailed:` prefix 化して
  // classify() で typed enum に昇格、SUGGESTS で recovery hint を提示する。
  // matrix doc §3.1 line 156 の workspace_launch error path 規範整合
  // (`docs/llm-audit/dogfood-scenarios/launcher-macro.md` §1.2 expectation)。
  SpawnFailed: [
    "The OS rejected the process spawn — verify the executable exists and is accessible from the MCP server's working directory.",
    "If the command is not in PATH, provide the full path (e.g. \"C:\\\\Program Files\\\\App\\\\app.exe\"). Common ENOENT cause is unqualified executable name.",
    "EACCES / EPERM (permission denied): verify the file is executable and not blocked by Windows policy / AV / `Unblock-File` (right-click → properties → Unblock).",
    "If the target requires admin elevation, the MCP server must run elevated to spawn it (UAC blocks cross-elevation spawn from non-admin parents).",
    "For built-in commands (cmd.exe / powershell.exe / etc.), the executable lives under %SystemRoot%\\\\System32 — pass the full path or rely on PATH env var.",
  ],
  // ADR-011 Phase B B-1: Working memory N upper bound (WORKING_MEMORY_N_MAX
  // = 50, layer-constraints §5 SSOT 整合) を超える要求が来た場合の typed
  // reason。silently truncate せず error を返す設計 (Phase B plan §4.3
  // acceptance、ADR-010 §5.6.1 truncation 規約と整合 — capacity 内 truncate
  // は `_truncation` notation で expose、上限超えは error)。
  WorkingMemoryNUpperBoundExceeded: [
    "Reduce working:N — upper bound is WORKING_MEMORY_N_MAX (= 50, layer-constraints §5)",
    "If you need more recent events, use include=[\"episodic:N\"] for richer rich-shape projection (B-2 land 後に有効)",
    "Working memory is a compact summary of recent commits — N typically ≤ 10 is sufficient for context",
  ],
  // ADR-011 Phase B B-2: Episodic memory N upper bound
  // (EPISODIC_MEMORY_N_MAX = 100, layer-constraints §5 SSOT 整合) を超える要求の typed reason。
  // Working との使い分けを suggest で誘導 (compact = working、rich = episodic)。
  EpisodicMemoryNUpperBoundExceeded: [
    "Reduce episodic:N — upper bound is EPISODIC_MEMORY_N_MAX (= 100, layer-constraints §5)",
    "Use include=[\"working:N\"] (compact summary) when the rich shape (lease_token / event_id / elapsed_ms) is unnecessary",
    "Episodic memory exposes the full ToolCallEvent shape — N typically ≤ 5 is sufficient for causal context recovery",
  ],
  // ADR-011 Phase B B-3: Semantic memory K upper bound
  // (SEMANTIC_MEMORY_K_MAX = 10) を超える要求の typed reason。
  // Working/Episodic との使い分けを suggest で誘導 (compact = working、
  // rich = episodic、pattern reuse = semantic)。
  SemanticMemoryKUpperBoundExceeded: [
    "Reduce semantic:K — upper bound is SEMANTIC_MEMORY_K_MAX (= 10)",
    "Semantic memory surfaces top-K learned UI patterns (rule-based: same windowTitle + 3+ successful commits)",
    "If you want recent commits instead of patterns, use include=[\"episodic:N\"] (rich shape) or [\"working:N\"] (compact)",
  ],
  // ADR-011 Phase B B-4: Procedural memory K upper bound
  // (PROCEDURAL_MEMORY_K_MAX = 10) を超える要求の typed reason。
  // suggest filter (success>=3 + failure==0 + no destructive) で expose
  // 候補は構造的に少なく、K 大幅増加に意味は薄い。
  ProceduralMemoryKUpperBoundExceeded: [
    "Reduce procedural:K — upper bound is PROCEDURAL_MEMORY_K_MAX (= 10)",
    "Procedural memory surfaces top-K successful repeated workflows (success>=3 + 0 failures + no destructive tools)",
    "Suggest candidates are limited by design — destructive macro suggest is non-goal in Phase B (consider Phase B follow-up for explicit consent UX)",
  ],
  // ─── ADR-015 Phase 4: VBA Extensibility bridge typed errors (12 codes) ─────
  // Crate-level (8): emitted by engine_vba_bridge::errors::VbaBridgeError via
  // `Display` impl with bare PascalCase prefix; surfaced through the napi
  // shim's `Error::from_reason`. napi-binding-level (3): emitted directly by
  // `src/vba_bridge.rs` for session-handle and napi-shim concerns the crate
  // is intentionally agnostic about (SessionNotFound / SessionIdExhausted /
  // VbaUnsupportedFileFormat). TS-binding-only (1): emitted by
  // `src/tools/excel.ts` BEFORE the napi boundary is crossed (non-Windows
  // or pre-v1.5.0 build, no Rust Producer; VbaBridgeUnavailable).
  //
  // ADR-015 §4.4 typed errors table is the SSOT for the catalog; this dict
  // is the runtime SUGGESTS surface that `failWith` populates into envelopes.
  VbaAccessNotTrusted: [
    "HKCU AccessVBOM is 0 (or never set). Run `node scripts/enable-access-vbom.mjs` to set it to 1.",
    "Close any running Excel.exe BEFORE retrying — Excel caches the AccessVBOM value at process start.",
    "If a fresh terminal is fine, run the CLI with --check-only first to see the current trust state.",
  ],
  VbaAccessLockedByPolicy: [
    "HKLM group policy forces AccessVBOM=0. No MCP-side workaround exists; contact your IT department.",
    "The setting `Software\\Microsoft\\Office\\16.0\\Excel\\Security\\AccessVBOM` under HKLM cannot be overridden by HKCU.",
  ],
  ExcelNotInstalled: [
    "Excel.Application COM class is not registered. Install Microsoft Excel 365 / 2019 / 2021 / 2024.",
    "If Excel IS installed but unregistered, repair the install via Control Panel → Programs → Office → Change → Quick Repair.",
  ],
  VbaModuleAuthoringFailed: [
    "VBA AddFromString rejected the source. Common cause: syntax error in the `code` argument.",
    "ALTERNATIVELY: SaveAs to the Trusted Location failed. Verify the directory exists and is writable, and that AV is not blocking the file.",
    "ALTERNATIVELY: the DisplayAlerts save-restore guard failed during SaveAs — typically means the COM apartment is being torn down concurrently. Retry with a fresh excel() call.",
  ],
  VbaMacroExecutionFailed: [
    "Application.Run rejected the macro. Most common cause is HRESULT 0x800a03ec: macros disabled by Trust Center.",
    "Ensure the workbook is in a registered Trusted Location (the bridge does this automatically via SaveAs to %LOCALAPPDATA%\\desktop-touch-mcp\\trusted-vba).",
    "Verify HKCU VBAWarnings=1 — otherwise dynamically-authored macros are blocked even from Trusted Locations.",
    "Close all running Excel.exe BEFORE retrying — Excel caches Trusted Locations at process start.",
  ],
  VbaMacroNotFound: [
    "Your `code` argument does not declare a Sub matching `macroName`. Add `Sub <macroName>()` at the start of `code`.",
    "Default macroName is `DesktopTouchAdHoc`; rename to that OR pass an explicit `macroName` parameter that matches your Sub.",
    "The check is a regex scan for `Sub <name>(...)` with optional Public/Private modifier — no Function support in v1.",
  ],
  VbaUnsupportedArgumentType: [
    "VBA macro args support null / boolean / number / string only in v1. For complex types, serialise into a worksheet cell from the macro side.",
    "Date arguments need an explicit `{__type: 'date', value: '<ISO>'}` wrapper because MCP/JSON transport does not preserve native Date objects.",
  ],
  VbaWorkbookProtected: [
    "The workbook has a VBA project password set. Manually unlock the workbook before authoring (Tools → VBAProject Properties → Protection in the VBA Editor).",
    "Alternative: author the macro into a fresh unprotected workbook instead.",
  ],
  SessionNotFound: [
    "The Excel session ID is no longer valid (already closed or never opened). Retry the operation — the run_vba tool spawns a fresh session per call.",
    "If this fires during a single run_vba invocation, the addon's session registry was reset (e.g. MCP server restart). Re-run the tool.",
  ],
  SessionIdExhausted: [
    "The u32 monotonic session counter has saturated at 2^32 spawns. Practically only reachable after ~136 years of continuous 1-spawn-per-second use.",
    "Restart the MCP server to reset the counter.",
  ],
  VbaUnsupportedFileFormat: [
    "The Phase 4 v1 bridge only supports `.xlsm` (xlOpenXMLWorkbookMacroEnabled = 52). Saving as `.xlsx` would silently drop the VBA module, so it is rejected up front.",
    "If you need a different format, the future ADR-015 expansion (`eval_cell` / `refresh_query` phase) will surface additional XlFileFormat variants.",
  ],
  VbaBridgeUnavailable: [
    "The native VBA bridge (`vba_bridge.rs`) is not loaded — likely a pre-v1.5.0 addon build or non-Windows host.",
    "Upgrade to a v1.5.0+ desktop-touch-mcp build (or run on Windows where the addon is included).",
    "If the addon IS present, verify it loaded successfully: check the stderr for `[native-engine] Rust VBA bridge loaded`.",
  ],

  // ── Key locker (ADR-014 R3) — the credential store + terminal autofill surface. ────────────
  // Only the two manager-produced codes are wired here (their producers are the KeyLocker*Error
  // constructors in key-locker-manager.ts). The host/inject codes (KeyLockerSpawnFailed / …Rejected /
  // …PipeUnavailable / the inject-abort family / RequiresRedaction / NoInjectorForBinding) are wired
  // WHEN their producers land (the tool + the L3 inject loop) — the classify producer-pin invariant
  // (issue-211) forbids a branch without a producer.
  KeyLockerConsentRequired: [
    "The key locker is off until you enable it once. Run key_locker with action='save' to open the enable dialog, or click Enable when it appears.",
    "Enabling is a one-time confirmation shown by the locker itself; the assistant never sees your secret.",
  ],
  KeyLockerDisabled: [
    "The key locker is turned off by DESKTOP_TOUCH_DISABLE_KEY_LOCKER=1. Remove that environment variable (and restart the MCP server) to use it.",
  ],
  // Emitted EXPLICITLY by the key_locker tool via `failCode` (not classify): the host-lifecycle codes
  // are surfaced dynamically from a caught `KeyLockerError.code`, and the two tool-specific codes below
  // have no classify branch on purpose (SUGGESTS-only — the tool sets the code directly).
  KeyLockerSpawnFailed: [
    "The locker helper could not start. Ensure key-locker.exe is present (build it: cd tools/key-locker && dotnet publish -c Release -o ../../bin/).",
    "This tool is Windows-only.",
  ],
  KeyLockerHandshakeRejected: [
    "The locker helper started but its secure handshake was rejected. Restart the MCP server so a fresh locker session is created.",
  ],
  KeyLockerPipeUnavailable: [
    "The connection to the locker helper was lost. Retry; if it persists, restart the MCP server.",
  ],
  KeyLockerConsoleLimit: [
    "Too many anchored consoles are already open. Reuse an existing one (key_locker action='launch_console' without fresh:true returns the most recent), or close a console window before opening another.",
  ],
  KeyLockerSshUnresolved: [
    "The ssh host key is not in known_hosts yet. Connect to the host once (ssh user@host) so its key is recorded, then save.",
    "ProxyJump / ProxyCommand bindings are not supported — the first prompt may belong to the jump host.",
  ],
  KeyLockerNoSuchBinding: [
    "No saved binding matches that URI. Run key_locker action='list' to see the exact display URIs, then retry with one of them.",
  ],
  // Binding-URI parse failures reachable via key_locker `save`/`forget`/`set_policy` (L1 grammar).
  // Shared grammar hint — the typed message already names the offending character/component.
  UnknownScheme: [
    "The URI scheme is not one of: ssh:// (user@host:port), sudo:// (host/targetUser), https-cred:// (host:port), sshkey: (SHA256:…, opaque form — no //).",
  ],
  MissingComponent: [
    "The binding URI is missing a required part. Examples: ssh://user@host:22, sudo://host/root, https-cred://github.com:443, sshkey:SHA256:abc…",
  ],
  MalformedUri: [
    "The binding URI is malformed. Percent-encode any character outside the grammar and follow the scheme's shape (e.g. ssh://user@host:22).",
    "For an SSH key passphrase use the opaque form sshkey:SHA256:<fingerprint> — no // after the scheme.",
  ],
  BadPercentEscape: [
    "A percent-escape in the URI is invalid — use %XX with two hex digits.",
  ],
  BadPort: [
    "The port must be an integer between 1 and 65535.",
  ],
};

/**
 * @internal Read-only access to the SUGGESTS dictionary for typed-error
 * envelope wiring (Round 1 Opus P1-3 反映). `makeQueryWrapper` uses this
 * to populate `if_unexpected.try_next` with `{action: string}` entries
 * derived from SUGGESTS string lines, ensuring runtime hint delivery
 * for Phase B B-1 `WorkingMemoryNUpperBoundExceeded` and any future
 * code that needs `buildFailureEnvelope` direct call (rather than
 * `failWith`-based path).
 */
export function getSuggestsForCode(code: string): string[] {
  return SUGGESTS[code] ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

function classify(message: string): { code: string; suggest: string[] } {
  const m = message.toLowerCase();

  // Key locker (ADR-014 R3) — checked FIRST: both codes carry the unique `keylocker` prefix, so a
  // keylocker message only matches these branches, never an existing generic one (e.g. `KeyLockerDisabled`
  // must not be swallowed by a future generic branch; and when the host codes land, `KeyLockerSpawnFailed`
  // ⊃ `spawnfailed` / `KeyLockerTargetNotForeground` ⊃ `foreground` would be mis-routed if placed after the
  // generic branches — Opus L4-R1 P3-7 collision check). Producers: the KeyLocker*Error constructors in
  // key-locker-manager.ts (`super("<code>: …")`). Host/inject codes are added when their producers land.
  if (m.includes("keylockerconsentrequired")) {
    return { code: "KeyLockerConsentRequired", suggest: SUGGESTS.KeyLockerConsentRequired };
  }
  if (m.includes("keylockerdisabled")) {
    return { code: "KeyLockerDisabled", suggest: SUGGESTS.KeyLockerDisabled };
  }

  // Order matters: check more-specific patterns first, then fall back to general ones.
  // Perception guards and lens errors — check before generic "not found" patterns
  if (m.includes("guardfailed") || m.startsWith("guard failed") || m.includes("guard failed:")) {
    return { code: "GuardFailed", suggest: SUGGESTS.GuardFailed };
  }
  // Phase 6 PR-B: AutoGuardBlocked — `failWith(new Error("AutoGuardBlocked: ${ag.summary.next}"))`
  // 12 producers across browser.ts (3) / mouse.ts (3、L746 `AutoGuardBlocked[endpoint]:` 変種) /
  // keyboard.ts (3) / ui-elements.ts (2) / _action-guard.ts (1)。
  // Substring is unique within classify cascade (no overlap with "guard failed" / etc).
  if (m.includes("autoguardblocked") || m.includes("auto guard blocked")) {
    return { code: "AutoGuardBlocked", suggest: SUGGESTS.AutoGuardBlocked };
  }
  if (m.includes("lens not found") || m.includes("unknownlens")) {
    return { code: "LensNotFound", suggest: SUGGESTS.LensNotFound };
  }
  // "Terminal window not found" must match BEFORE "window not found" (substring).
  if (m.includes("terminal window not found") || m.includes("terminal not found")) {
    return { code: "TerminalWindowNotFound", suggest: SUGGESTS.TerminalWindowNotFound };
  }
  if (m.includes("textpattern") || m.includes("text pattern")) {
    return { code: "TerminalTextPatternUnavailable", suggest: SUGGESTS.TerminalTextPatternUnavailable };
  }
  // issue #386: terminal(action='run', until:{mode:'exit'}) pre-flight rejects.
  // Emitted via `failWith(new Error("ExitMode…"))` from terminal.ts so callers
  // get the typed code + recovery suggest from SUGGESTS. The three suffixes are
  // mutually exclusive (no substring poaching) and none contains a generic
  // keyword ("timeout"/"window"/"shell"-phrase), so placement is order-safe.
  if (m.includes("exitmodeunsafeinput")) {
    return { code: "ExitModeUnsafeInput", suggest: SUGGESTS.ExitModeUnsafeInput };
  }
  if (m.includes("exitmodeshellunsupported")) {
    return { code: "ExitModeShellUnsupported", suggest: SUGGESTS.ExitModeShellUnsupported };
  }
  if (m.includes("exitmodeshellambiguous")) {
    return { code: "ExitModeShellAmbiguous", suggest: SUGGESTS.ExitModeShellAmbiguous };
  }
  if (m.includes("scope not found") || m.includes("scopenotfound")) {
    return { code: "ScopeNotFound", suggest: SUGGESTS.ScopeNotFound };
  }
  if (m.includes("wait timeout") || m.includes("waittimeout")) {
    return { code: "WaitTimeout", suggest: SUGGESTS.WaitTimeout };
  }
  if (m.includes("browser") && (m.includes("not connected") || m.includes("econnrefused"))) {
    return { code: "BrowserNotConnected", suggest: SUGGESTS.BrowserNotConnected };
  }
  if (m.includes("element is disabled") || m.includes("is disabled") || m === "disabled") {
    return { code: "ElementDisabled", suggest: SUGGESTS.ElementDisabled };
  }
  if (m.includes("is not allowed because it could open a shell")) {
    return { code: "BlockedKeyCombo", suggest: SUGGESTS.BlockedKeyCombo };
  }
  if (m.includes("invokepattern") || m.includes("invoke pattern")) {
    return { code: "InvokePatternNotSupported", suggest: SUGGESTS.InvokePatternNotSupported };
  }
  // Phase 7 F3: workspace_launch spawnDetached rejection (ENOENT / EACCES /
  // EPERM 等). MUST stay BEFORE WindowNotFound — branch ordering is the
  // only defense layer (no test-time guard) for the case where a SpawnFailed
  // message tail accidentally contains "window not found" substring. Today
  // the literal SpawnFailed messages emitted by `src/utils/launch.ts:153-157`
  // do not contain that substring, but messages can grow over time (extra
  // context appended by `failWith(err, ...)` callers). The Phase 7 F3 unit
  // test (`tests/unit/phase7-f3-spawn-failed-typed-code.test.ts` case #6)
  // pins this ordering by feeding a synthesized message with both substrings
  // and asserting SpawnFailed wins.
  if (m.includes("spawnfailed") || m.includes("spawn failed:")) {
    return { code: "SpawnFailed", suggest: SUGGESTS.SpawnFailed };
  }
  if (m.includes("window not found") || m.includes("no window")) {
    return { code: "WindowNotFound", suggest: SUGGESTS.WindowNotFound };
  }
  if (m.includes("element not found") || m.includes("no element")) {
    return { code: "ElementNotFound", suggest: SUGGESTS.ElementNotFound };
  }
  if (m.includes("timeout") || m.includes("timed out")) {
    return { code: "UiaTimeout", suggest: SUGGESTS.UiaTimeout };
  }
  if (m.includes("scrollbar unavailable") || m.includes("no scrollbar") || m.includes("no scrollpattern")) {
    return { code: "ScrollbarUnavailable", suggest: SUGGESTS.ScrollbarUnavailable ?? [] };
  }
  if (m.includes("overflow:hidden") || m.includes("overflowancestor")) {
    return { code: "OverflowHiddenAncestor", suggest: SUGGESTS.OverflowHiddenAncestor ?? [] };
  }
  if (m.includes("virtual scroll exhausted") || m.includes("virtualscrollexhausted")) {
    return { code: "VirtualScrollExhausted", suggest: SUGGESTS.VirtualScrollExhausted ?? [] };
  }
  if (m.includes("backgroundinputunsupported") || m.includes("background input unsupported")) {
    return { code: "BackgroundInputUnsupported", suggest: SUGGESTS.BackgroundInputUnsupported };
  }
  if (m.includes("foregroundrestricted") || m.includes("foreground restricted")) {
    return { code: "ForegroundRestricted", suggest: SUGGESTS.ForegroundRestricted ?? [] };
  }
  if (m.includes("backgroundinputincomplete") || m.includes("background input incomplete")) {
    return { code: "BackgroundInputIncomplete", suggest: SUGGESTS.BackgroundInputIncomplete };
  }
  if (m.includes("backgroundinputnotdelivered") || m.includes("background input not delivered")) {
    return { code: "BackgroundInputNotDelivered", suggest: SUGGESTS.BackgroundInputNotDelivered };
  }
  // Issue #245 系統②b: typed error emitted by keyboard({action:'type'}) when
  // forceKeystrokes && !use_clipboard meets an IME-ON target. Pre-injection
  // refusal — no characters have been sent — so the suggest[] focuses on
  // toggling the safe paths (forceImeOff / use_clipboard / drop forceKeystrokes).
  if (m.includes("imeonduringtype") || m.includes("ime on during type")) {
    return { code: "ImeOnDuringType", suggest: SUGGESTS.ImeOnDuringType };
  }
  // Phase 5 I1 (Phase 2a F4): keyboard({action:'type'}) Focus Leash mid-stream
  // focus theft typed code. SUGGESTS dictionary entry above provides the SSOT
  // for recovery hints (re-focus + retry with context.remaining).
  if (m.includes("focuslostduringtype") || m.includes("focus lost during type")) {
    return { code: "FocusLostDuringType", suggest: SUGGESTS.FocusLostDuringType };
  }
  // Issue #257: keyboard(action:'sequence') typed codes. Substrings are
  // long and unique enough that subsequent generic arms (timeout / window
  // not found) cannot poach the match, but the test pin in
  // tests/unit/keyboard-input-serialization.test.ts asserts the ordering
  // so future SUGGESTS additions cannot regress it silently.
  if (m.includes("menufocuslostmidsequence") || m.includes("menu focus lost mid sequence")) {
    return { code: "MenuFocusLostMidSequence", suggest: SUGGESTS.MenuFocusLostMidSequence };
  }
  if (m.includes("foregroundflashnotapplicabletosequence")) {
    return { code: "ForegroundFlashNotApplicableToSequence", suggest: SUGGESTS.ForegroundFlashNotApplicableToSequence };
  }
  // Issue #279: keyboard(action:'press') with method:'foreground_flash' early
  // reject (keyboard.ts:1490). Placed AFTER Sequence so neither substring
  // poaches the other — the codes share the "ForegroundFlashNotApplicableTo"
  // prefix, but the suffixes (Sequence / KeyPress) are mutually exclusive.
  if (m.includes("foregroundflashnotapplicabletokeypress")) {
    return { code: "ForegroundFlashNotApplicableToKeyPress", suggest: SUGGESTS.ForegroundFlashNotApplicableToKeyPress };
  }
  if (m.includes("backgroundnotapplicabletosequence")) {
    return { code: "BackgroundNotApplicableToSequence", suggest: SUGGESTS.BackgroundNotApplicableToSequence };
  }
  if (m.includes("clipboardwritenotdelivered") || m.includes("clipboard write not delivered")) {
    return { code: "ClipboardWriteNotDelivered", suggest: SUGGESTS.ClipboardWriteNotDelivered };
  }
  if (m.includes("backgroundkeynotdelivered") || m.includes("background key not delivered")) {
    return { code: "BackgroundKeyNotDelivered", suggest: SUGGESTS.BackgroundKeyNotDelivered };
  }
  // Issue #178: keep mouse_drag check BEFORE mouse_click — "mouseclicknotdelivered"
  // would otherwise substring-match a longer string like "mousedragnotdelivered" (it
  // does not today, but matching the more specific code first is the safe ordering).
  if (m.includes("mousedragnotdelivered") || m.includes("mouse drag not delivered")) {
    return { code: "MouseDragNotDelivered", suggest: SUGGESTS.MouseDragNotDelivered };
  }
  if (m.includes("mouseclicknotdelivered") || m.includes("mouse click not delivered")) {
    return { code: "MouseClickNotDelivered", suggest: SUGGESTS.MouseClickNotDelivered };
  }
  // Issue #181: typed CDP delivery codes — substring match in lowercase.
  if (m.includes("browserclicknotdelivered") || m.includes("browser click not delivered")) {
    return { code: "BrowserClickNotDelivered", suggest: SUGGESTS.BrowserClickNotDelivered };
  }
  if (m.includes("browserfillnotdelivered") || m.includes("browser fill not delivered")) {
    return { code: "BrowserFillNotDelivered", suggest: SUGGESTS.BrowserFillNotDelivered };
  }
  // Issue #179: scroll(raw) wheel SendInput silently dropped (matrix doc §3.1).
  if (m.includes("scrollnotdelivered") || m.includes("scroll not delivered")) {
    return { code: "ScrollNotDelivered", suggest: SUGGESTS.ScrollNotDelivered };
  }
  if (m.includes("setvalueallchannelsfailed") || m.includes("all channels failed")) {
    return { code: "SetValueAllChannelsFailed", suggest: SUGGESTS.SetValueAllChannelsFailed };
  }

  // ─── ADR-015 Phase 4: VBA Extensibility bridge typed codes ─────────────
  // Pattern: napi shim emits `"<PascalCaseCode>: <prose>"` (ADR §4.4 +
  // src/vba_bridge.rs module doc-block). Match in lowercase as the
  // existing codes do.
  //
  // Ordering: no two PascalCase codes in this group are substrings of each
  // other today, so order doesn't affect correctness. We still place
  // `VbaMacroNotFound` AFTER `VbaMacroExecutionFailed` for a defensive
  // reason — if a future error message ever chains both (e.g. "got
  // VbaMacroNotFound during preflight, retried as VbaMacroExecutionFailed
  // at runtime"), the chain semantically resolves to the latter. The
  // pre-COM regex pre-flight in `src/tools/excel.ts::handleRunVba`
  // (`codeDeclaresMacro`) already returns VbaMacroNotFound BEFORE any
  // COM call, so the chain scenario is structurally impossible — this
  // ordering is belt-and-suspenders documentation (Opus Round 1 P2-3).
  if (m.includes("vbaaccesslockedbypolicy")) {
    return { code: "VbaAccessLockedByPolicy", suggest: SUGGESTS.VbaAccessLockedByPolicy };
  }
  if (m.includes("vbaaccessnottrusted")) {
    return { code: "VbaAccessNotTrusted", suggest: SUGGESTS.VbaAccessNotTrusted };
  }
  if (m.includes("excelnotinstalled")) {
    return { code: "ExcelNotInstalled", suggest: SUGGESTS.ExcelNotInstalled };
  }
  if (m.includes("vbamoduleauthoringfailed")) {
    return { code: "VbaModuleAuthoringFailed", suggest: SUGGESTS.VbaModuleAuthoringFailed };
  }
  if (m.includes("vbamacroexecutionfailed")) {
    return { code: "VbaMacroExecutionFailed", suggest: SUGGESTS.VbaMacroExecutionFailed };
  }
  if (m.includes("vbamacronotfound")) {
    return { code: "VbaMacroNotFound", suggest: SUGGESTS.VbaMacroNotFound };
  }
  if (m.includes("vbaunsupportedfileformat")) {
    return { code: "VbaUnsupportedFileFormat", suggest: SUGGESTS.VbaUnsupportedFileFormat };
  }
  if (m.includes("vbaunsupportedargumenttype")) {
    return { code: "VbaUnsupportedArgumentType", suggest: SUGGESTS.VbaUnsupportedArgumentType };
  }
  if (m.includes("vbaworkbookprotected")) {
    return { code: "VbaWorkbookProtected", suggest: SUGGESTS.VbaWorkbookProtected };
  }
  if (m.includes("vbabridgeunavailable")) {
    return { code: "VbaBridgeUnavailable", suggest: SUGGESTS.VbaBridgeUnavailable };
  }
  if (m.includes("sessionidexhausted")) {
    return { code: "SessionIdExhausted", suggest: SUGGESTS.SessionIdExhausted };
  }
  if (m.includes("sessionnotfound")) {
    return { code: "SessionNotFound", suggest: SUGGESTS.SessionNotFound };
  }

  return { code: "ToolError", suggest: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `errorFromMessage` — factory that turns a thrown value into the canonical
 * {@link ToolFailureError} model (ADR-021 Phase 2 PR-P2-0, OQ-7(c)).
 *
 * The first arg is `unknown` (a true superset of `failWith`'s first arg) and is
 * normalized to a message string with the SAME rule `failWith` uses today —
 * production callsites throw / pass non-Error values (bare strings, `??`-
 * coalesced strings, raw caught values), so the factory, not the callsite, owns
 * that normalization. This is what lets the PR-P2-2 flip stay bit-equal for any
 * input (pinned by the equivalence test's non-Error cases).
 *
 * This is the ONE place that runs `classify(message)` for the flat-failure
 * family, and the ONE place that splits a caller's `context` into the two
 * halves the flat shape needs:
 *   - root-hoisted keys (`_perceptionForPost` / `_richForPost` / `hints`) →
 *     `rootExtras`, spread onto the failure root so `_post.ts` can find them;
 *   - everything else → nested `context` (the LLM-facing detail).
 *
 * The returned error is a pure value; rendering it to the flat wire shape is
 * `toToolFailure`'s job (separation of concerns — the model is the SSOT, the
 * presenter is replaceable). `failWith` becomes a thin wrapper over
 * `fail(toToolFailure(errorFromMessage(...)))` in PR-P2-2 — kept untouched here
 * so PR-P2-0 only ADDS the model + factory + presenter and proves bit-equality
 * (tests/unit/path-class-contract/to-tool-failure-payload.test.ts) before the
 * flip, mirroring the snapshot-first discipline that de-risked Phase 1.
 */
export function errorFromMessage(
  err: unknown,
  toolName: string,
  context?: Record<string, unknown>,
): ToolFailureError {
  const message = err instanceof Error ? err.message : String(err);
  const { code, suggest } = classify(message);

  // Same split `failWith` performs today: hoisted keys go to the failure root
  // (so `_post.ts` can attach post-perception), the rest stays nested under
  // `context`. Both halves preserve `Object.entries(context)` iteration order
  // so the rendered JSON is byte-for-byte identical to `failWith`'s.
  let rootExtras: Record<string, unknown> | undefined;
  let nestedContext: Record<string, unknown> | undefined;
  if (context) {
    for (const [k, v] of Object.entries(context)) {
      if (ROOT_HOISTED_KEYS.has(k)) {
        (rootExtras ??= {})[k] = v;
      } else {
        (nestedContext ??= {})[k] = v;
      }
    }
  }

  return new ToolFailureError(code, {
    toolName,
    displayMessage: message,
    suggest,
    context: nestedContext,
    rootExtras,
  });
}

/**
 * `toToolFailure` — presenter that renders a {@link ToolFailureError} into the
 * flat `ToolFailure` wire shape (ADR-021 Phase 2 PR-P2-0, B′ presenter family).
 *
 * Sibling of `toFailureEnvelope` (the envelope-family presenter in
 * `_envelope.ts`): both consume a typed error, neither re-classifies, and each
 * has a single narrow return type — one error model, two render targets. The
 * key order / omission rules match today's `failWith` output byte-for-byte so
 * PR-P2-2 can route `failWith` through this presenter with zero shape change
 * (codemod fixtures + the equivalence test pin it):
 *
 *   { ok:false, code, error, [suggest], [context], ...rootExtras }
 *
 * `error` is total over the payload: with both `toolName` and `displayMessage`
 * it is `"${toolName} failed: ${displayMessage}"` (the canonical failWith
 * string); the partial-payload fallbacks are pinned in the matrix test. An
 * empty `displayMessage` (`""`) is preserved (not coalesced to `code`) so an
 * empty thrown message stays bit-equal with `failWith`.
 */
export function toToolFailure(err: ToolFailureError): ToolFailure & Record<string, unknown> {
  const code = err.name;
  const displayMessage = err.displayMessage ?? code;
  const error =
    err.toolName !== undefined ? `${err.toolName} failed: ${displayMessage}` : displayMessage;

  return {
    ok: false,
    code,
    error,
    ...(err.suggest && err.suggest.length > 0 && { suggest: err.suggest }),
    ...(err.context && { context: err.context }),
    ...(err.rootExtras ?? {}),
  };
}

/**
 * `failWith` — the canonical entry point for a flat handler failure
 * (`{ ok:false, code, error, suggest?, context?, ...rootExtras }`). Normalizes
 * any thrown value, classifies it to a typed `code` with recovery `suggest`,
 * and renders the flat wire shape, returning it as a `ToolResult`.
 *
 * Implemented as a thin wrapper over the B′ presenter family (ADR-021 Phase 2):
 * `errorFromMessage` owns the `unknown` → message normalization + `classify`
 * (the typed error model is the SSOT); `toToolFailure` renders the flat shape
 * (the presenter). `failWith` composes them so handlers have ONE concise,
 * lint-enforceable failure path. Do NOT hand-build `{ ok:false, ... }` literals
 * (or wire failures through `ok()`) — route them here instead; Phase 4 ESLint
 * (`no-tool-failure-shape-direct-construct`) bans the former.
 *
 * Output is byte-for-byte stable (pinned by
 * tests/unit/path-class-contract/failwith-thin-wrapper.test.ts layer A).
 *
 * ADR-021 OQ-1 RE-DECISION (Round 6, 2026-05-21): kept as the canonical window —
 * full removal (old OQ-1(a)) was superseded once B′ + PR-P2-2 collapsed the dual
 * failure system (failWith now delegates to the presenter; the typed error model
 * is the SSOT). Deleting it would only churn the 171 already-sanctioned callsites.
 */
export function failWith(
  err: unknown,
  toolName: string,
  context?: Record<string, unknown>
): ToolResult {
  return fail(toToolFailure(errorFromMessage(err, toolName, context)));
}

/**
 * `failCode` — flat failure for handlers that already KNOW the typed `code`
 * (no message classification needed). The explicit-code sibling of `failWith`
 * (code derived via `classify`) and `failArgs` (fixed `InvalidArgs`).
 *
 * Routes through the B′ presenter (`toToolFailure(new ToolFailureError(...))`) so
 * the wire shape stays bit-equal with a hand-built literal — use this instead of
 * `fail({ ok:false, code, ... })` (ADR-021 PR-P2-3; Phase 4 ESLint
 * `no-tool-failure-shape-direct-construct` bans the literal). Emitted shape:
 *
 *   { ok:false, code, error, [suggest], [context], ...rootExtras }
 *
 * `error` is emitted VERBATIM — no `${toolName} failed:` prefix (the caller owns
 * the full string, unlike `failWith`), matching the bespoke error strings the
 * replaced literals carry. `suggest` is omitted when empty / absent (same guard
 * as `failWith`). `rootExtras` (e.g. `_perceptionForPost`) spread onto the root.
 */
export function failCode(
  code: string,
  error: string,
  extra?: {
    suggest?: string[];
    context?: Record<string, unknown>;
    rootExtras?: Record<string, unknown>;
  }
): ToolResult {
  return fail(
    toToolFailure(
      new ToolFailureError(code, {
        displayMessage: error,
        suggest: extra?.suggest,
        context: extra?.context,
        rootExtras: extra?.rootExtras,
      })
    )
  );
}

/**
 * Return a structured ToolFailure for invalid / missing input arguments.
 * Use this instead of failWith() for validation errors so they get the
 * dedicated InvalidArgs code rather than the generic ToolError fallback.
 */
export function failArgs(
  message: string,
  toolName: string,
  context?: Record<string, unknown>
): ToolResult {
  const failure: ToolFailure = {
    ok: false,
    code: "InvalidArgs",
    error: `${toolName}: ${message}`,
    suggest: SUGGESTS.InvalidArgs,
    ...(context && { context }),
  };
  return fail(failure);
}
