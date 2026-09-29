/**
 * uia-diff.ts — Compute before/after diff of a UIA element tree snapshot.
 *
 * Used by withRichNarration (3.2) to populate post.rich without a
 * confirmation screenshot.  Pure functions — no I/O.
 */

import type { UiElement } from "./uia-bridge.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AppearedItem {
  name: string;
  type: string;
  automationId?: string;
}

export interface DisappearedItem {
  name: string;
  type: string;
}

/**
 * internal #211 (B) — an element whose Name changed across the act: Calculator's display, a status
 * bar's "N items". Kept apart from `valueDeltas`, which stays the ValuePattern value.
 */
export interface NameDeltaItem {
  type: string;
  before: string;
  after: string;
}

export interface ValueDeltaItem {
  name: string;
  type: string;
  before: string;
  after: string;
}

export type DiffSource = "uia" | "cdp" | "none";
export type DiffDegraded =
  | "chromium_sparse"
  /**
   * internal #211 (B) — a snapshot stopped at its element cap, so it is a prefix of the window: two
   * prefixes that end in different places would read as elements appearing and disappearing that
   * never moved. A snapshot that ran out of time is `timeout`.
   */
  | "tree_truncated"
  | "timeout"
  | "window_closed"
  | "process_restarted"
  | "no_target"
  /**
   * ADR-036 — the call named a window by handle and more than one open window
   * carries its title, so the before/after snapshots (which find their window
   * BY TITLE) cannot be shown to describe the window that was acted on.
   */
  | "ambiguous_title"
  /**
   * ADR-036 — the target moved between the pre-action snapshot and the action:
   * a modal closed, or the foreground changed. NOT `window_closed`, which says
   * the window the caller named is gone — a caller reading that would give up
   * on a window that is still there and merely needs reacquiring.
   */
  | "target_changed"
  /**
   * ADR-036 — the call retried with a `fixId`. The handler then acts on the
   * window the STORED FIX names, and a fix exists because the guard found a
   * narrower one than the argument did, so the two normally differ. The
   * narration wrapper cannot see the fix, so its snapshots would describe the
   * window the caller asked for while the action went somewhere else.
   */
  | "fix_target_unknown";

export interface UiaDiffResult {
  appeared: AppearedItem[];
  disappeared: DisappearedItem[];
  valueDeltas: ValueDeltaItem[];
  /** internal #211 (B) — present when at least one element's Name changed. */
  nameDeltas?: NameDeltaItem[];
  truncated?: {
    appeared?: number;
    disappeared?: number;
    valueDeltas?: number;
    nameDeltas?: number;
  };
}

export interface RichBlock extends UiaDiffResult {
  diffSource: DiffSource;
  diffDegraded?: DiffDegraded;
  navigation?: { fromUrl: string; toUrl: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const CAP_APPEARED    = 5;
const CAP_DISAPPEARED = 5;
const CAP_VALUE_DELTAS = 3;
const CAP_NAME_DELTAS = 3;
/** Number of characters kept before appending the ellipsis "…". Total output length is VALUE_TRIM_PREFIX + 1. */
const VALUE_TRIM_PREFIX = 80;

function elementKey(el: UiElement): string {
  if (el.automationId) return `aid:${el.automationId}`;
  // NOTE: siblings with the same controlType, name, and depth collapse to one key.
  // This is a known limitation: duplicate-named siblings (e.g., repeated "Tab" items)
  // may cause phantom appeared/disappeared when sibling order changes.
  return `ct:${el.controlType}|n:${el.name}|d:${el.depth}`;
}

function trimValue(s: string): string {
  return s.length > VALUE_TRIM_PREFIX ? s.slice(0, VALUE_TRIM_PREFIX) + "…" : s;
}

function hasVisibleBounds(el: UiElement): boolean {
  const r = el.boundingRect;
  return !!r && r.width > 0 && r.height > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** The control types a collection's rows take: a list's, a grid's and a tree's items. */
const COLLECTION_ITEM_TYPES = ["ListItem", "DataItem", "TreeItem"] as const;

/**
 * Inside a collection row, not the row: a list's cells. The row is said as appeared or disappeared
 * itself; its cells are named after the columns ("名前", "更新日時" in Explorer), so saying them too
 * only fills the cap with noise (win2 on #750: one file added read as the file plus two cells).
 */
function insideRow(e: UiElement): boolean {
  return !(COLLECTION_ITEM_TYPES as readonly string[]).includes(e.controlType) &&
    e.path !== undefined && COLLECTION_ITEM_TYPES.some((t) => e.path!.includes(`/${t}[`));
}

/** A row of a collection, or an element inside one (by its path, when the read took one). */
function inCollection(e: UiElement): boolean {
  if ((COLLECTION_ITEM_TYPES as readonly string[]).includes(e.controlType)) return true;
  return e.path !== undefined && COLLECTION_ITEM_TYPES.some((t) => e.path!.includes(`/${t}[`));
}

/**
 * internal #211 (B) — which element after the act is which element before it.
 *
 * 1. The same `runtimeId`: the same live element (win2 S10 — unchanged across an act on elements
 *    updated in place).
 * 2. Of what is left, the same `path` — when, under that element's parent path, exactly one element
 *    before and one after are left: an element the app rebuilt on its own (Explorer's status bar and
 *    a Chrome text leaf came back with new RuntimeIds on the same path, S10). A parent with several
 *    rebuilt children — the rows of a list the app refilled on moving to another folder — is not
 *    paired by position: those are other items, not renamed ones (gate 2). Nor are two elements
 *    whose automationIds both say and differ (a wizard's "next" replaced by "finish").
 * 3. Of what is left, the old key: automationId, else controlType|name|depth — a read without the
 *    first two (an older addon) is diffed as it always was.
 * 4. Of what is left, collection rows by controlType|name|depth: a row's automationId can be its
 *    position.
 */
function pairElements(before: UiElement[], after: UiElement[]): {
  pairs: Array<[UiElement, UiElement]>;
  onlyBefore: UiElement[];
  onlyAfter: UiElement[];
} {
  // A pair found by RuntimeId or by position is trusted only when its names agree, or differ as a
  // rename does: the old name gone and the new one new, among elements of that type. Explorer's
  // refresh rebuilds its rows and hands a row's RuntimeId to another file's row, every name still
  // there (win2 on #750: sub1's RuntimeId came back on beta.txt). Such a pair is undone and its two
  // elements go on to the old key, which pairs each file with itself — otherwise the refresh read
  // as "beta.txt -> gamma.txt" renames, and then as one row appearing and another disappearing.
  const namesOf = (els: UiElement[]) => {
    const m = new Map<string, Set<string>>();
    for (const e of els) {
      if (!e.name) continue;
      const set = m.get(e.controlType);
      if (set) set.add(e.name); else m.set(e.controlType, new Set([e.name]));
    }
    return m;
  };
  const namesBefore = namesOf(before);
  const namesAfter = namesOf(after);
  // Nor is a pair trusted to be a rename inside a collection: a list's rows, and what is in them.
  // A list that moves to another folder keeps its rows' RuntimeIds and positions and fills them with
  // other files, whose names are all new — that passes the rename test above and is not a rename
  // (PR codex P2 ×2 on #750). A row renamed for real is then said as one gone and one new.
  const sameOrRenamed = (b: UiElement, a: UiElement) =>
    b.name === a.name ||
    (sameKindOutsideRows(b, a) &&
      !namesAfter.get(b.controlType)?.has(b.name) && !namesBefore.get(a.controlType)?.has(a.name));
  // A renamed element is one control: another type under a reused automationId is another control
  // (PR codex P2), and a collection row's identity is not to be trusted (above).
  const sameKindOutsideRows = (b: UiElement, a: UiElement) =>
    b.controlType === a.controlType && !inCollection(b) && !inCollection(a);

  const pairs: Array<[UiElement, UiElement]> = [];
  let restBefore = before;
  let restAfter = after;

  // 1. RuntimeId.
  const afterByRid = new Map<string, UiElement>();
  for (const a of restAfter) if (a.runtimeId) afterByRid.set(a.runtimeId, a);
  const usedAfter = new Set<UiElement>();
  const unpairedBefore: UiElement[] = [];
  for (const b of restBefore) {
    const a = b.runtimeId ? afterByRid.get(b.runtimeId) : undefined;
    // RuntimeId is the strongest identity outside a collection: it is kept here without the name test,
    // which would refuse a counter that changed while another element still shows its old value
    // (PR codex P2). The reuse win2 measured was inside a list, whose rows `sameKindOutsideRows` keeps
    // out.
    // One control either way: a RuntimeId handed to a control of another type is not the same
    // element, even under the same name (PR codex on #750's final head).
    if (a && !usedAfter.has(a) && a.controlType === b.controlType && (b.name === a.name || sameKindOutsideRows(b, a))) {
      pairs.push([b, a]);
      usedAfter.add(a);
    } else {
      unpairedBefore.push(b);
    }
  }
  restBefore = unpairedBefore;
  restAfter = restAfter.filter((a) => !usedAfter.has(a));

  // 1b. The same path and the same name: a child rebuilt unchanged. Paired first, so that a parent
  // that rebuilt all its children and renamed one leaves that one alone for the step below (PR codex
  // P2).
  const afterByPathName = new Map<string, UiElement>();
  for (const a of restAfter) if (a.path) afterByPathName.set(`${a.path}|${a.name}`, a);
  const pairedUnchanged = new Set<UiElement>();
  for (const b of restBefore) {
    const a = b.path ? afterByPathName.get(`${b.path}|${b.name}`) : undefined;
    if (a && !pairedUnchanged.has(a)) {
      pairs.push([b, a]);
      pairedUnchanged.add(b);
      pairedUnchanged.add(a);
    }
  }
  restBefore = restBefore.filter((e) => !pairedUnchanged.has(e));
  restAfter = restAfter.filter((e) => !pairedUnchanged.has(e));

  // 2. One-to-one on the same path, within a parent that has one element left on each side.
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
  const byParent = (els: UiElement[]) => {
    const m = new Map<string, UiElement[]>();
    for (const e of els) {
      if (!e.path) continue;
      const k = parentOf(e.path);
      const list = m.get(k);
      if (list) list.push(e); else m.set(k, [e]);
    }
    return m;
  };
  const beforeByParent = byParent(restBefore);
  const afterByParent = byParent(restAfter);
  const pairedByPath = new Set<UiElement>();
  for (const [k, bs] of beforeByParent) {
    const as = afterByParent.get(k);
    if (bs.length !== 1 || as?.length !== 1) continue;
    const [b, a] = [bs[0], as[0]];
    if (b.path !== a.path) continue;
    if (b.automationId && a.automationId && b.automationId !== a.automationId) continue;
    if (!sameOrRenamed(b, a)) continue;
    pairs.push([b, a]);
    pairedByPath.add(b);
    pairedByPath.add(a);
  }
  restBefore = restBefore.filter((e) => !pairedByPath.has(e));
  restAfter = restAfter.filter((e) => !pairedByPath.has(e));

  // 3. The old key, over named elements only, as before.
  const beforeByKey = new Map<string, UiElement>();
  const afterByKey = new Map<string, UiElement>();
  for (const e of restBefore) if (e.name) beforeByKey.set(elementKey(e), e);
  for (const e of restAfter) if (e.name) afterByKey.set(elementKey(e), e);
  const onlyBefore: UiElement[] = [];
  const onlyAfter: UiElement[] = [];
  // The key holds the name unless an automationId stands in for it, and an automationId can be a
  // position: Explorer numbers its rows "0", "1", "2" … so a renamed file that sorts into the same
  // place keeps its row's id (win2 on #750). A pair here whose names differ is held to the same test
  // as the two above; one that fails it is one element gone and another new.
  for (const [k, b] of beforeByKey) {
    const a = afterByKey.get(k);
    // An automationId key does not carry the type: a Button and a Text under one id are two controls,
    // named alike or not (PR codex on #750's final head).
    if (a && a.controlType === b.controlType && sameOrRenamed(b, a)) {
      pairs.push([b, a]);
    } else {
      onlyBefore.push(b);
      if (a) onlyAfter.push(a);
    }
  }
  for (const [k, a] of afterByKey) if (!beforeByKey.has(k)) onlyAfter.push(a);

  // 4. Collection rows an automationId kept apart, by name. A row's automationId can be its position
  // (Explorer numbers rows "0", "1", …), so a file that sorts in above others moves them to the next
  // number, and each is the same file under its own name. Only for rows: elsewhere two different
  // automationIds are two elements, whatever their names.
  const byName = (e: UiElement) => `ct:${e.controlType}|n:${e.name}|d:${e.depth}`;
  const leftAfter = new Map<string, UiElement>();
  for (const a of onlyAfter) if (inCollection(a) && !leftAfter.has(byName(a))) leftAfter.set(byName(a), a);
  const stillBefore: UiElement[] = [];
  for (const b of onlyBefore) {
    const a = inCollection(b) ? leftAfter.get(byName(b)) : undefined;
    if (a) {
      pairs.push([b, a]);
      leftAfter.delete(byName(b));
    } else {
      stillBefore.push(b);
    }
  }
  const matched = new Set(pairs.map(([, a]) => a));
  return { pairs, onlyBefore: stillBefore, onlyAfter: onlyAfter.filter((a) => !matched.has(a)) };
}

/**
 * Diff two UIA element snapshots.
 *
 * Identity: `runtimeId` → one-to-one `path` + control type → automationId → controlType|name|depth
 * (`pairElements`). Filters out elements with empty names or invisible bounding rects from
 * appeared / disappeared. Applies size caps and reports overflow in `truncated`.
 */
export function computeUiaDiff(
  before: UiElement[],
  after: UiElement[]
): UiaDiffResult {
  const { pairs, onlyBefore, onlyAfter } = pairElements(before, after);

  // ── Appeared ──────────────────────────────────────────────────────────────
  // Covers: (a) new element that is visible, (b) element that was hidden and became visible.
  const appearedAll: AppearedItem[] = [];
  const addAppeared = (el: UiElement) => {
    const item: AppearedItem = { name: el.name, type: el.controlType };
    if (el.automationId) item.automationId = el.automationId;
    appearedAll.push(item);
  };
  for (const a of onlyAfter) if (a.name && hasVisibleBounds(a) && !insideRow(a)) addAppeared(a);
  for (const [b, a] of pairs) if (a.name && hasVisibleBounds(a) && !hasVisibleBounds(b)) addAppeared(a);

  // ── Disappeared ───────────────────────────────────────────────────────────
  // Covers: (a) element fully removed, (b) element that was visible and became hidden.
  const disappearedAll: DisappearedItem[] = [];
  for (const b of onlyBefore) if (b.name && hasVisibleBounds(b) && !insideRow(b)) disappearedAll.push({ name: b.name, type: b.controlType });
  for (const [b, a] of pairs) if (b.name && hasVisibleBounds(b) && !hasVisibleBounds(a)) disappearedAll.push({ name: b.name, type: b.controlType });

  // ── Value deltas ──────────────────────────────────────────────────────────
  // Only produced when the element snapshot includes `value` (fetchValues:true).
  const valueDeltasAll: ValueDeltaItem[] = [];
  // ── Name deltas (internal #211 B) ─────────────────────────────────────────
  // Every pair whose names differ is a rename by now: `pairElements` unpairs the rest.
  const nameDeltasAll: NameDeltaItem[] = [];
  for (const [b, a] of pairs) {
    // Named elements only, as the diff always was: an unlabeled field's change cannot be told apart
    // from another's, and would take a place under the cap (gate 2).
    if (b.name && b.value !== undefined && a.value !== undefined && b.value !== a.value) {
      valueDeltasAll.push({
        name:   b.name,
        type:   b.controlType,
        before: trimValue(b.value),
        after:  trimValue(a.value),
      });
    }
    // Visible on both sides: a change of visibility is said as appeared / disappeared, and a hidden
    // element renaming itself in the background is not what the act did (gate 2).
    if (b.name !== a.name && hasVisibleBounds(b) && hasVisibleBounds(a)) {
      nameDeltasAll.push({ type: a.controlType, before: trimValue(b.name), after: trimValue(a.name) });
    }
  }

  // ── Apply caps ────────────────────────────────────────────────────────────
  const truncated: UiaDiffResult["truncated"] = {};

  const appeared = appearedAll.slice(0, CAP_APPEARED);
  if (appearedAll.length > CAP_APPEARED) {
    truncated.appeared = appearedAll.length - CAP_APPEARED;
  }

  const disappeared = disappearedAll.slice(0, CAP_DISAPPEARED);
  if (disappearedAll.length > CAP_DISAPPEARED) {
    truncated.disappeared = disappearedAll.length - CAP_DISAPPEARED;
  }

  const valueDeltas = valueDeltasAll.slice(0, CAP_VALUE_DELTAS);
  if (valueDeltasAll.length > CAP_VALUE_DELTAS) {
    truncated.valueDeltas = valueDeltasAll.length - CAP_VALUE_DELTAS;
  }

  const nameDeltas = nameDeltasAll.slice(0, CAP_NAME_DELTAS);
  if (nameDeltasAll.length > CAP_NAME_DELTAS) {
    truncated.nameDeltas = nameDeltasAll.length - CAP_NAME_DELTAS;
  }

  const result: UiaDiffResult = { appeared, disappeared, valueDeltas };
  if (nameDeltas.length > 0) result.nameDeltas = nameDeltas;
  if (Object.keys(truncated).length > 0) result.truncated = truncated;
  return result;
}

/** Build a degraded RichBlock (no diff available). */
export function degradedRichBlock(reason: DiffDegraded): RichBlock {
  return {
    appeared: [],
    disappeared: [],
    valueDeltas: [],
    diffSource: "none",
    diffDegraded: reason,
  };
}
