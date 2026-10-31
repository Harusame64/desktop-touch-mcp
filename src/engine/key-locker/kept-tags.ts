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
// "Don't ask again" (user request 2026-10-30; scope decided 2026-10-31: that tag only, and only at the same
// prompt): the confirm dialog has a checkbox, and a Fill with it ticked that FILLS marks THAT tag of THAT pane
// with the prompt the user saw (its rows and the row above, `fill-once.ts promptLineOf`), so later fills of it
// at a prompt with the same text skip the dialog. Past
// the first hop a prompt is text the remote side writes, so a prompt with other text (sudo, another host, a
// bare `Password:`) asks again; one that copies the text exactly is not caught. The mark lives on the entry,
// so it goes with the tag — on pane close, forget_tag, a re-anchor, a helper change — and a retype (a new
// secret) clears it: the user agreed to the secret they saw.
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
  /** The user ticked "Don't ask again" for this tag at this prompt line: later fills there skip the confirm. */
  alwaysAt?: string;
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

  /** The prompt line this pane's tag fills at without the confirm, or null (not marked, or not kept). */
  alwaysAt(paneId: string, anchor: PaneAnchor, tag: string): string | null {
    return this.paneFor(paneId, anchor)?.tags.get(tag)?.alwaysAt ?? null;
  }

  /** Mark a kept tag "Don't ask again" at `promptLine` (replacing an earlier mark). False (nothing marked) when
   *  the tag is not kept, or no longer holds `opaqueId` — the secret the user confirmed. */
  allowAlways(paneId: string, anchor: PaneAnchor, tag: string, opaqueId: string, promptLine: string): boolean {
    const e = this.paneFor(paneId, anchor)?.tags.get(tag);
    if (e === undefined || e.opaqueId !== opaqueId) return false;
    e.alwaysAt = promptLine;
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

  /** The NAMES of the tags marked "Don't ask again", per pane (never the prompt, ids or secrets) — `list`'s
   *  `paneTagsNoConfirm`. Panes with none are left out. */
  noConfirmNames(): Record<string, string[]> {
    this.prune();
    const out: Record<string, string[]> = {};
    for (const [paneId, p] of this.panes) {
      const names = [...p.tags].filter(([, e]) => e.alwaysAt !== undefined).map(([t]) => t).sort();
      if (names.length > 0) out[paneId] = names;
    }
    return out;
  }

  /** Tag NAMES per pane (never ids or secrets) — `list`'s `paneTags`. */
  names(): Record<string, string[]> {
    this.prune();
    const out: Record<string, string[]> = {};
    for (const [paneId, p] of this.panes) out[paneId] = [...p.tags.keys()].sort();
    return out;
  }
}
