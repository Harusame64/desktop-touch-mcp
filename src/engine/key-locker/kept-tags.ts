// ADR-014 v2 R3 Key Locker — `fill_once` kept tags (internal #281).
//
// The user's case: a jump host (`ssh jump`, then `ssh user@IP` inside it) in a launch_console pane. Every
// re-entry asked them to type the same password again, because a fill_once secret is deleted after one fill.
// Decided by the user (2026-10-13, re-confirmed 2026-10-30): a fill_once may name a TAG; the secret typed for
// it is then KEPT for as long as that pane (window / tab) exists, and every later fill of the tag asks a
// one-click confirm instead of a retype.
//
// This module is the server-side MAP only: (paneId, tag) → the opaque id the secret lives under in the helper.
// It holds no secret. The secret itself stays in the helper's memory (`LockerStore.CaptureEphemeral`, never
// store.json), so the map is only meaningful while THAT helper process lives:
//   * a kept tag is bound to the pane's ANCHOR (shell pid + creation time; classic hwnd too). A paneId that
//     comes back with a different anchor (a reused hwnd, a re-launched pane) never sees the old tags — they
//     are erased on first sight;
//   * every tag records the helper that holds its secret (`holder`). When the live helper is not that one
//     (it died, was disposed, or was replaced underneath), the tag is dropped silently: its id would dangle,
//     and the secret went with the old process;
//   * `dropPane` runs on every pane close (the driver's `onPaneClosed`, both the window_disappeared path and
//     the wt shell-exit prune), `forget` on `forget_tag`, `clear` on server shutdown.
// "Always fill in this terminal" (user request 2026-10-30, scope decided 2026-10-31: that tag only): the
// confirm dialog has a checkbox, and a Fill with it ticked marks THAT tag of THAT pane so later fills of it
// skip the dialog. The mark lives on the entry, so it goes with the tag — on pane close, forget_tag, a
// re-anchor, a helper change — and a retype (a new secret) clears it: the user agreed to the secret they saw.
// While any tag is held the helper must not be idle-disposed (that would kill the secrets after a minute) —
// the wiring hands `hasAny` to `KeyLockerManager.setIdleKeepAlive`.

import type { PaneAnchor } from "./inject-target.js";

/** Tag syntax: short, plain, safe to show in a dialog and to echo back in a tool result. */
export const KEPT_TAG_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
/** At most this many kept tags per pane (a decline past it, never an eviction). */
export const MAX_KEPT_TAGS_PER_PANE = 8;

export function isValidKeptTag(tag: string): boolean {
  return KEPT_TAG_PATTERN.test(tag);
}

interface KeptEntry {
  opaqueId: string;
  /** The helper (host object) that holds the secret. Compared by identity with the live one. */
  holder: object;
  /** The user ticked "always fill in this terminal" for this tag: later fills skip the confirm. */
  always?: true;
}

interface PaneTags {
  anchor: PaneAnchor;
  tags: Map<string, KeptEntry>;
}

export interface KeptTagsDeps {
  /** The live helper session, or null when none is running (disposed / dead). Identity is what counts. */
  liveHolder(): object | null;
  /** Erase these ids from the live helper (fire-and-forget; a failure leaves them in helper memory only,
   *  where they die with the process). Not called for ids whose helper is already gone. */
  erase(opaqueIds: string[]): void;
}

function sameAnchor(a: PaneAnchor, b: PaneAnchor): boolean {
  return a.kind === b.kind && a.shellPid === b.shellPid && a.shellStartTimeMs === b.shellStartTimeMs && a.hwnd === b.hwnd;
}

export class KeptTags {
  private readonly panes = new Map<string, PaneTags>();

  constructor(private readonly deps: KeptTagsDeps) {}

  /** Drop every tag whose secret lives in a helper that is no longer the live one (nothing to erase). */
  private prune(): void {
    const live = this.deps.liveHolder();
    for (const [paneId, p] of this.panes) {
      for (const [tag, e] of p.tags) if (e.holder !== live) p.tags.delete(tag);
      if (p.tags.size === 0) this.panes.delete(paneId);
    }
  }

  /** The pane's tags if they belong to `anchor`; a mismatched anchor (a reused paneId) erases them first. */
  private paneFor(paneId: string, anchor: PaneAnchor): PaneTags | null {
    this.prune();
    const p = this.panes.get(paneId);
    if (p === undefined) return null;
    if (sameAnchor(p.anchor, anchor)) return p;
    this.dropPane(paneId);
    return null;
  }

  /** The opaque id kept under `tag` for this pane AND this anchor, or null. */
  lookup(paneId: string, anchor: PaneAnchor, tag: string): string | null {
    return this.paneFor(paneId, anchor)?.tags.get(tag)?.opaqueId ?? null;
  }

  /** Did the user allow this pane's tag to fill without the confirm? False when it is not kept. */
  isAlways(paneId: string, anchor: PaneAnchor, tag: string): boolean {
    return this.paneFor(paneId, anchor)?.tags.get(tag)?.always === true;
  }

  /** Mark a kept tag "always fill in this terminal". False (nothing marked) when the tag is not kept. */
  allowAlways(paneId: string, anchor: PaneAnchor, tag: string): boolean {
    const e = this.paneFor(paneId, anchor)?.tags.get(tag);
    if (e === undefined) return false;
    e.always = true;
    return true;
  }

  /** How many tags this pane (with this anchor) holds. */
  count(paneId: string, anchor: PaneAnchor): number {
    return this.paneFor(paneId, anchor)?.tags.size ?? 0;
  }

  /**
   * Keep `opaqueId` under `tag` for this pane. Refused (false) when the tag is malformed, when `holder` is not
   * the live helper (the secret would not be where the id says), or when a NEW tag would pass the per-pane cap.
   * A tag already kept is replaced, and its old id erased; the replacement starts without "always".
   */
  keep(paneId: string, anchor: PaneAnchor, tag: string, opaqueId: string, holder: object | null): boolean {
    if (!isValidKeptTag(tag)) return false;
    if (holder === null || holder !== this.deps.liveHolder()) return false;
    let p = this.paneFor(paneId, anchor);
    if (p !== null && !p.tags.has(tag) && p.tags.size >= MAX_KEPT_TAGS_PER_PANE) return false;
    if (p === null) {
      p = { anchor, tags: new Map() };
      this.panes.set(paneId, p);
    }
    const old = p.tags.get(tag);
    p.tags.set(tag, { opaqueId, holder });
    if (old !== undefined && old.opaqueId !== opaqueId) this.deps.erase([old.opaqueId]);
    return true;
  }

  /** `forget_tag`: delete one tag. Returns whether it existed. */
  forget(paneId: string, tag: string): boolean {
    this.prune();
    const p = this.panes.get(paneId);
    const e = p?.tags.get(tag);
    if (p === undefined || e === undefined) return false;
    p.tags.delete(tag);
    if (p.tags.size === 0) this.panes.delete(paneId);
    this.deps.erase([e.opaqueId]);
    return true;
  }

  /** The pane closed (or was re-anchored): drop and erase all its tags. Idempotent. */
  dropPane(paneId: string): void {
    const p = this.panes.get(paneId);
    if (p === undefined) return;
    this.panes.delete(paneId);
    const live = this.deps.liveHolder();
    const ids = [...p.tags.values()].filter((e) => e.holder === live).map((e) => e.opaqueId);
    if (ids.length > 0) this.deps.erase(ids);
  }

  /** Server shutdown: forget everything (the helper is going away with its memory; nothing to erase). */
  clear(): void {
    this.panes.clear();
  }

  /** Does any pane hold a kept tag in the live helper? (idle-dispose keep-alive) */
  hasAny(): boolean {
    this.prune();
    return this.panes.size > 0;
  }

  /** Tag NAMES per pane (never ids or secrets) — `list`'s `paneTags`. */
  names(): Record<string, string[]> {
    this.prune();
    const out: Record<string, string[]> = {};
    for (const [paneId, p] of this.panes) out[paneId] = [...p.tags.keys()].sort();
    return out;
  }
}
