// ADR-014 v2 R3 Key Locker — L3 §4: InjectTarget assembly for the `pane` (console-buffer inject) channel.
//
// Plan: desktop-touch-mcp-internal@<plan>:docs/adr-014-v2-r3-l3-capture-plan.md (§4, THE LOCKED
// CONTRACT #4)
//
// For a pane console-buffer injection L3 must hand the locker an `InjectTarget {hwnd, consolePid, titleFp,
// submit}` (L2 §2.1). The hwnd is already in hand — the terminal/tool layer that observed the
// credential prompt located the console window — so this module only reads the two derived fields
// (consolePid, titleFp) via the SAME Win32 APIs the locker re-verifies with, so both match by
// CONSTRUCTION (no TOCTOU on the identity, only the intended abort if the window changes between
// derive and inject):
//   * consolePid = getWindowProcessId(hwnd)          — the window-owning pid (shell for a pseudoconsole)
//   * titleFp    = sha256hex(utf8(GetWindowTextW))   — byte-identical to Injection.cs `TitleFp`
//
// This module holds no secret and does no I/O beyond the two read-only Win32 queries. Channel
// selection (pane vs askpass vs git-credential) and `submit` classification are the capture-loop's
// job (§4 second half / §5 detection); this module is handed the resolved hwnd + submit flag.

import { createHash } from "node:crypto";
import { getWindowProcessId, getWindowTitleW } from "../win32.js";
import type { InjectTarget } from "../key-locker-host.js";

/**
 * The window-title fingerprint the C# locker recomputes at the injection instant
 * (`Injection.cs` `TitleFp`): the lowercase hex SHA-256 of the UTF-8 bytes of `GetWindowTextW(hwnd)`.
 *
 * This MUST stay byte-identical to the C# side (`Convert.ToHexString(SHA256.HashData(
 * Encoding.UTF8.GetBytes(title))).ToLowerInvariant()`) — a divergence would abort every injection
 * with `target_mismatch`. Both sides read the title with `GetWindowTextW`, so the input string is the
 * same; both hash its UTF-8 bytes; `digest("hex")` is already lowercase. Non-secret.
 */
export function titleFingerprint(title: string): string {
  return createHash("sha256").update(title, "utf8").digest("hex");
}

/**
 * Assemble the `pane` InjectTarget for a resolved console window (L3 plan §4). Returns `null` when the
 * window is gone / the hwnd is invalid (`getWindowProcessId` yields 0 — PID 0 never owns a console
 * window): there is no valid target, so the caller DECLINES rather than round-tripping a garbage
 * target (whose `titleFp` would be `sha256("")`) to the locker.
 *
 * `hwnd` is serialized as a DECIMAL integer string (the `InjectTarget.hwnd` contract; the locker's
 * `ParseLong` accepts a decimal string or number). `submit` appends Enter after the secret for a
 * line-oriented echo-off prompt; it is only emitted when true (the field is optional).
 */
export function assembleInjectTarget(hwnd: bigint, submit: boolean): InjectTarget | null {
  const consolePid = getWindowProcessId(hwnd);
  if (consolePid === 0) return null; // window gone / invalid hwnd — no target, caller declines
  return {
    hwnd: hwnd.toString(10),
    consolePid,
    titleFp: titleFingerprint(getWindowTitleW(hwnd)),
    ...(submit ? { submit: true } : {}),
  };
}
