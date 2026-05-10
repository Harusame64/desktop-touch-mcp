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
// LowLevel keyboard hook (option, default OFF) for `foreground_flash` channel
// typing-leak mitigation (§3.4)。
#[cfg(windows)]
pub(crate) mod kbd_hook;
// WT paste warning ContentDialog scan (option, default ON) — fail-safe for
// `largePasteWarning` / `multiLinePasteWarning` (§3.3.3)。
#[cfg(windows)]
pub(crate) mod wt_dialog_scan;
