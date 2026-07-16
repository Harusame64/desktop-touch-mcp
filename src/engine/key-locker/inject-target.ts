// ADR-014 v2 R3 Key Locker — L3 §4: InjectTarget assembly for the `pane` (console-buffer inject) channel,
// re-based on the S-pid PaneAnchor identity (ADR-014 R3.x S-pid gate §1/E4).
//
// Plan: desktop-touch-mcp-internal:docs/adr-014-v2-r3-l3-capture-plan.md (§4, THE LOCKED CONTRACT #4)
//       + desktop-touch-mcp-internal:docs/adr-014-v2-r3x-s-pid-gate.md (§1 PaneAnchor, E3 wire, E4 assembly)
//
// Target identity is the SHELL PROCESS the locker itself spawned, named by `{shellPid, shellStartTimeMs}`
// (unforgeable by pid reuse — a reused pid reads a different creation time). The console window, where one
// exists (classic conhost), is an ADDITIONAL classic-only anchor, no longer the identity source:
//   * classic: consolePid/titleFp are still derived from the hwnd via the SAME Win32 APIs the locker
//     re-verifies with (match by CONSTRUCTION), PLUS the anchor's shellPid/shellStartMs ride the wire so
//     the locker's PRIMARY pid+creation-time re-verify covers classic too.
//   * wt (Windows Terminal, R3.x La): a pane has NO per-pane window — the target is pid+creation-time
//     alone. As a cheap early decline (before a doomed pipe round-trip) the shell must still be alive
//     with the anchored creation time; the C# re-verify remains the AUTHORITATIVE gate.
//
// This module holds no secret and does no I/O beyond read-only Win32 queries. Channel selection
// (pane vs askpass vs git-credential) and `submit` classification are the capture-loop's job.

import { createHash } from "node:crypto";
import { getProcessIdentityByPid, getWindowProcessId, getWindowTitleW } from "../win32.js";
import type { InjectTarget } from "../key-locker-host.js";

/**
 * The per-pane target identity, captured AT SPAWN by the launch path (`launchAnchoredConsole`) and
 * immutable thereafter (S-pid gate §1). One per anchored pane.
 */
export interface PaneAnchor {
  kind: "classic" | "wt";
  /** The console window hwnd — CLASSIC ONLY (a WT pane has no per-pane window). */
  hwnd?: bigint;
  /** The spawn-tracked SHELL pid (powershell in the tab/console) — the AttachConsole target
   *  and the sshDescendants subtree root, in BOTH hosts. */
  shellPid: number;
  /** The shell's process creation time, ms since the Windows (1601) epoch, computed as
   *  floor(FILETIME_ticks / 10000) — EXACTLY `process.rs filetime_to_ms` (gate §4). NEVER 0:
   *  a 0 read at spawn FAILS the launch (0 is the doubt sentinel and can never anchor). */
  shellStartTimeMs: number;
}

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
 * Assemble the `pane` InjectTarget for an anchored pane (S-pid gate E4). Returns `null` (the caller
 * DECLINES — never round-trips a garbage target) when:
 *   * classic: the window is gone / the hwnd is invalid (`getWindowProcessId` yields 0 — PID 0 never
 *     owns a console window), exactly the pre-S-pid decline;
 *   * wt: the shell is gone or its live creation time no longer equals the anchor's (a reused pid) —
 *     a cheap Node-side early decline; the C# `ReVerify` pid+time check is the authoritative gate.
 *
 * `hwnd` is serialized as a DECIMAL integer string (the `InjectTarget.hwnd` contract; the locker's
 * `ParseLong` accepts a decimal string or number). `shellPid`/`shellStartMs` are carried from the
 * spawn-captured anchor VERBATIM for BOTH hosts (never re-derived here — the anchor is the identity).
 * `submit` appends Enter after the secret for a line-oriented echo-off prompt; it is only emitted
 * when true (the field is optional).
 */
export function assembleInjectTarget(anchor: PaneAnchor, submit: boolean): InjectTarget | null {
  if (anchor.kind === "classic") {
    if (anchor.hwnd === undefined) return null; // malformed classic anchor — no window to derive from
    const consolePid = getWindowProcessId(anchor.hwnd);
    if (consolePid === 0) return null; // window gone / invalid hwnd — no target, caller declines
    return {
      hwnd: anchor.hwnd.toString(10),
      consolePid,
      titleFp: titleFingerprint(getWindowTitleW(anchor.hwnd)),
      shellPid: anchor.shellPid,
      shellStartMs: anchor.shellStartTimeMs,
      ...(submit ? { submit: true } : {}),
    };
  }
  // wt: nothing window-derived exists to read. Early-decline if the shell identity already fails the
  // anchor (dead pid reads {"",0}; a reused pid reads a DIFFERENT non-zero time) — saves a doomed
  // round-trip; equality is EXACT (gate §4 — a tolerance would re-open the pid-reuse hole).
  const live = getProcessIdentityByPid(anchor.shellPid).processStartTimeMs;
  if (live === 0 || live !== anchor.shellStartTimeMs) return null;
  return {
    shellPid: anchor.shellPid,
    shellStartMs: anchor.shellStartTimeMs,
    ...(submit ? { submit: true } : {}),
  };
}
