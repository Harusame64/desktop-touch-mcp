// ADR-014 v2 R3.x S-pid — E2: the paneId codec + the wt tab-title registry.
//
// Plan: desktop-touch-mcp-internal:docs/adr-014-v2-r3x-s-pid-gate.md (E2, E6)
//
// The paneId is the ONE shipped-public pane handle (v1.12.0: `key_locker launch_console` returns it;
// `terminal read/send` accept it). Two forms:
//   * classic: `String(hwnd)` decimal — UNCHANGED (zero back-compat break).
//   * wt:      `wt:<shellPid>:<shellStartTimeMs>` — self-describing (a WT pane has no per-pane window,
//     so the handle carries the full S-pid anchor) and collision-free with the decimal form, so ANY
//     resolver can re-verify identity from the paneId alone.
//
// `parsePaneId` is the ONE internal resolver replacing the scattered `BigInt(paneId)` try/catch sites;
// malformed ⇒ null ⇒ the caller declines (the existing contract). All internal maps keep the STRING key.
//
// The wt TAB-TITLE REGISTRY (E6): a wt pane's reads/sends resolve by the nonce tab title (pinned by
// `--suppressApplicationTitle`), but the anchor carries no title — so the launch path REGISTERS the
// title here and the terminal-layer resolver looks it up. This inversion keeps `terminal.ts` free of
// any locker import (the rejected "terminal fold" coupling): both sides depend only on this tiny
// engine module. Process-lifetime, bounded by MAX_ANCHORED_PANES; the wiring unregisters a pane when
// its driver record is pruned (shell exit). Titles are NON-secret (a window-enumeration-visible nonce).

/** A parsed pane handle (E2). */
export type ParsedPaneId =
  | { kind: "classic"; hwnd: bigint }
  | { kind: "wt"; shellPid: number; shellStartTimeMs: number };

/**
 * The `terminal` paneId schema cap (`z.string().max(WT_PANE_ID_SCHEMA_MAX)`). Bumped 32 → 48 for the
 * wt form (additive — it only widens the accepted set): worst case `wt:` (3) + pid ≤ 10 digits + `:`
 * (1) + startMs 14 digits ≈ 28, leaving real slack. A unit test pins `formatWtPaneId(max).length <=
 * WT_PANE_ID_SCHEMA_MAX` so a future format tweak cannot silently exceed the cap (gate E2 / Opus P3-1).
 */
export const WT_PANE_ID_SCHEMA_MAX = 48;

// startMs is bounded to 14 digits: a real FILETIME-ms is ~1.33e13 (14 digits) and 14 digits max
// (9.99e13) stays well inside Number.MAX_SAFE_INTEGER (9.007e15) so parsing never loses precision; a
// wider bound would accept values Number() rounds. pid is the 32-bit max (10 digits). Both feed the
// length invariant (WT_PANE_ID_SCHEMA_MAX): 3 + 10 + 1 + 14 = 28 <= 48.
const WT_PANE_ID_RE = /^wt:([0-9]{1,10}):([0-9]{1,14})$/;

/** Format a wt pane's public paneId from its S-pid anchor identity (E2). */
export function formatWtPaneId(shellPid: number, shellStartTimeMs: number): string {
  return `wt:${shellPid}:${shellStartTimeMs}`;
}

/**
 * Parse a public paneId into its typed form, or null on ANY malformed input (the caller declines —
 * never throws). The decimal classic form and the `wt:` form are disjoint by construction (`wt:` is
 * not parseable as a BigInt), so no input is ambiguous.
 */
export function parsePaneId(paneId: string): ParsedPaneId | null {
  const wt = WT_PANE_ID_RE.exec(paneId);
  if (wt !== null) {
    const shellPid = Number(wt[1]);
    const shellStartTimeMs = Number(wt[2]);
    // 0 is the doubt sentinel — a 0 pid/time can never have anchored, so it never parses (E2/§4).
    if (shellPid === 0 || shellStartTimeMs === 0) return null;
    return { kind: "wt", shellPid, shellStartTimeMs };
  }
  if (!/^[0-9]+$/.test(paneId)) return null; // BigInt would also accept 0x…/whitespace — the handle is decimal-only
  try {
    return { kind: "classic", hwnd: BigInt(paneId) };
  } catch {
    return null;
  }
}

// ── wt tab-title registry (E6) ───────────────────────────────────────────────────────────────────────

const wtPaneTitles = new Map<string, string>();

/** Register a launched wt pane's nonce tab title so the terminal-layer resolver can find its window. */
export function registerWtPaneTitle(paneId: string, tabTitle: string): void {
  wtPaneTitles.set(paneId, tabTitle);
}

/** The registered tab title for a wt paneId, or null (an unregistered wt pane always declines). */
export function wtPaneTitleOf(paneId: string): string | null {
  return wtPaneTitles.get(paneId) ?? null;
}

/** Drop a pruned/closed wt pane's registration (the wiring calls this when the driver record goes). */
export function unregisterWtPaneTitle(paneId: string): void {
  wtPaneTitles.delete(paneId);
}
