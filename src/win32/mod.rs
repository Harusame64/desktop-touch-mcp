//! Win32 native bindings (ADR-007 P1).
//!
//! Replaces 10 hot-path koffi bindings in `src/engine/win32.ts` with
//! windows-rs equivalents. Each `#[napi]` export wraps its body in
//! `napi_safe_call` so panics never reach the libuv main thread (ADR-007 §3.4).
//!
//! TS function signatures in `src/engine/win32.ts` (e.g. `enumWindowsInZOrder`,
//! `getWindowTitleW`) are unchanged — only the underlying primitive bindings
//! are swapped. Tool surface 不変原則 (統合書 §2 P7 / §7.4) is preserved.

pub(crate) mod safety;
pub(crate) mod types;
#[cfg(windows)]
pub(crate) mod window;
#[cfg(windows)]
pub(crate) mod gdi;
#[cfg(windows)]
pub(crate) mod monitor;
#[cfg(windows)]
pub(crate) mod dpi;
// ADR-007 P3: process/thread + input bindings.
#[cfg(windows)]
pub(crate) mod process;
#[cfg(windows)]
pub(crate) mod input;
#[cfg(windows)]
pub(crate) mod window_op;
#[cfg(windows)]
pub(crate) mod scroll;
// ADR-007 P4: final 5 owner/ancestor/enabled/popup/cloaked utilities.
#[cfg(windows)]
pub(crate) mod dwm;
// ADR-013 Option E (foreground_flash channel) — `background` 契約とは分離した
// 妥協 BG path (Clipboard + foreground flash + paste + restore)。詳細は
// `docs/adr-013-option-e-impl.md` v3 + `src/win32/foreground_flash.rs`。
#[cfg(windows)]
pub(crate) mod foreground_flash;
// Clipboard rigorous handling (HGLOBAL save/restore + 3 point sequence) for
// foreground_flash channel. 詳細は `docs/adr-013-option-e-impl.md` v3 §3.2 +
// `src/win32/clipboard_snapshot.rs`。
#[cfg(windows)]
pub(crate) mod clipboard_snapshot;
// issue #386 — native no-steal console-paste for the conhost exit-mode path
// (reuses clipboard_snapshot). Replaces the powershell-spawning TS clipboard
// handling in `bg-input.ts::pasteIntoConsoleNoFocus`. 詳細は
// `desktop-touch-mcp-internal/docs/issue-386-native-clipboard-plan.md`。
#[cfg(windows)]
pub(crate) mod console_paste;
// LowLevel keyboard hook (option, default OFF) for `foreground_flash` channel
// typing-leak mitigation (§3.4)。
#[cfg(windows)]
pub(crate) mod kbd_hook;
// WT paste warning ContentDialog scan (option, default ON) — fail-safe for
// `largePasteWarning` / `multiLinePasteWarning` (§3.3.3)。
#[cfg(windows)]
pub(crate) mod wt_dialog_scan;
// Issue #245 系統②: IME open-status query / control (ImmGetDefaultIMEWnd +
// WM_IME_CONTROL). Used by `desktop_state.hints.imeOpen` and
// `keyboard(action='type', forceImeOff:true)`.
#[cfg(windows)]
pub(crate) mod imm;
// ADR-017: read-only Terminal Services session observability.
// `desktop_state(include:[sessionContext])` opt-in surfaces own session id,
// console session id, sessionLabel ('console'|'rdp'|'other'), and sessionState
// ('active'|'connected'|'disconnected'|'locked'|'unknown') without any
// cross-session control surface (out of scope per ADR-017 v1 §2.2).
#[cfg(windows)]
pub(crate) mod session;
// WGC (Windows.Graphics.Capture) — HWND-based window capture from DWM
// composition surface. Fallback for PrintWindow on WM_PRINT-noncompliant windows.
#[cfg(windows)]
pub(crate) mod wgc;
