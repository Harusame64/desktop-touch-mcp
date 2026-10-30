// key-locker-kept-tags.test.ts — internal #281: the server-side map of fill_once tags kept per pane.
// Pins the lifetime rules the user chose ("until that pane closes") and the bindings that keep an old tag
// from ever reaching a different pane:
//   * a tag is bound to the paneId AND the pane's anchor — a reused paneId (another anchor) never sees it,
//     and its ids are erased on first sight;
//   * a tag is bound to the helper that holds its secret — a restarted / dead helper drops the map silently;
//   * syntax and the per-pane cap; forget / dropPane / clear; names only for `list`.
import { describe, expect, it } from "vitest";
import {
  KeptTags, MAX_KEPT_TAGS_PER_PANE, isValidKeptTag,
} from "../../src/engine/key-locker/kept-tags.js";
import type { PaneAnchor } from "../../src/engine/key-locker/inject-target.js";

const A: PaneAnchor = { kind: "wt", shellPid: 100, shellStartTimeMs: 5000 };
const A_REUSED_PID: PaneAnchor = { kind: "wt", shellPid: 100, shellStartTimeMs: 9999 };
const CLASSIC: PaneAnchor = { kind: "classic", hwnd: 77n, shellPid: 200, shellStartTimeMs: 6000 };
const CLASSIC_OTHER_HWND: PaneAnchor = { ...CLASSIC, hwnd: 78n };

function make(): { tags: KeptTags; erased: string[]; setLive(h: object | null): void; host: object } {
  const host = { name: "helper-1" };
  let live: object | null = host;
  const erased: string[] = [];
  const tags = new KeptTags({ liveHolder: () => live, erase: (ids) => erased.push(...ids) });
  return { tags, erased, setLive: (h) => { live = h; }, host };
}

describe("KeptTags — syntax", () => {
  it("accepts [A-Za-z0-9._-]{1,32} and nothing else", () => {
    for (const ok of ["jump", "db1", "a.b_c-d", "X".repeat(32), "0"]) expect(isValidKeptTag(ok)).toBe(true);
    for (const bad of ["", "X".repeat(33), "a b", "jump/2", "ünï", "a\nb", "tag:1", "‮jump"]) expect(isValidKeptTag(bad)).toBe(false);
  });

  it("keep refuses a malformed tag", () => {
    const f = make();
    expect(f.tags.keep("p", A, "bad tag", "id-1", f.host)).toBe(false);
    expect(f.tags.names()).toEqual({});
  });
});

describe("KeptTags — bound to the pane AND its anchor", () => {
  it("keeps and looks up under the same paneId + anchor", () => {
    const f = make();
    expect(f.tags.keep("p", A, "jump", "id-1", f.host)).toBe(true);
    expect(f.tags.lookup("p", A, "jump")).toBe("id-1");
    expect(f.tags.lookup("p", A, "other")).toBeNull();
    expect(f.tags.lookup("q", A, "jump")).toBeNull();
  });

  it("a reused paneId with a different anchor never sees the old tag, and the old ids are erased", () => {
    const f = make();
    f.tags.keep("p", A, "jump", "id-1", f.host);
    f.tags.keep("p", A, "db", "id-2", f.host);
    expect(f.tags.lookup("p", A_REUSED_PID, "jump")).toBeNull();
    expect(f.erased.sort()).toEqual(["id-1", "id-2"]);
    // …and they are gone for the original anchor too: the map no longer holds that pane.
    expect(f.tags.lookup("p", A, "jump")).toBeNull();
    expect(f.tags.names()).toEqual({});
  });

  it("a classic pane whose hwnd differs is a different pane", () => {
    const f = make();
    f.tags.keep("77", CLASSIC, "jump", "id-1", f.host);
    expect(f.tags.lookup("77", CLASSIC_OTHER_HWND, "jump")).toBeNull();
    expect(f.erased).toEqual(["id-1"]);
  });

  it("keeping under a new anchor replaces the old pane's tags (erasing them)", () => {
    const f = make();
    f.tags.keep("p", A, "jump", "id-1", f.host);
    expect(f.tags.keep("p", A_REUSED_PID, "jump", "id-9", f.host)).toBe(true);
    expect(f.erased).toEqual(["id-1"]);
    expect(f.tags.lookup("p", A_REUSED_PID, "jump")).toBe("id-9");
  });
});

describe("KeptTags — bound to the helper that holds the secret", () => {
  it("a restarted helper (a different live session) drops every tag without erasing", () => {
    const f = make();
    f.tags.keep("p", A, "jump", "id-1", f.host);
    f.setLive({ name: "helper-2" });
    expect(f.tags.lookup("p", A, "jump")).toBeNull();
    expect(f.tags.hasAny()).toBe(false);
    expect(f.tags.names()).toEqual({});
    expect(f.erased).toEqual([]); // the secret went with the old process; nothing to erase
  });

  it("a dead helper (no live session) drops every tag", () => {
    const f = make();
    f.tags.keep("p", A, "jump", "id-1", f.host);
    f.setLive(null);
    expect(f.tags.hasAny()).toBe(false);
  });

  it("keep refuses an id held by a helper that is not the live one", () => {
    const f = make();
    expect(f.tags.keep("p", A, "jump", "id-1", { name: "old" })).toBe(false);
    expect(f.tags.keep("p", A, "jump", "id-1", null)).toBe(false);
    expect(f.tags.hasAny()).toBe(false);
  });
});

describe("KeptTags — the per-pane cap", () => {
  it(`holds at most ${MAX_KEPT_TAGS_PER_PANE} tags per pane; a replacement of a kept tag is not a new one`, () => {
    const f = make();
    for (let i = 0; i < MAX_KEPT_TAGS_PER_PANE; i++) expect(f.tags.keep("p", A, `t${i}`, `id-${i}`, f.host)).toBe(true);
    expect(f.tags.count("p", A)).toBe(MAX_KEPT_TAGS_PER_PANE);
    expect(f.tags.keep("p", A, "one-more", "id-x", f.host)).toBe(false);
    expect(f.tags.keep("p", A, "t0", "id-0b", f.host)).toBe(true); // replace
    expect(f.erased).toEqual(["id-0"]);
    // Another pane has its own budget.
    expect(f.tags.keep("q", A, "one-more", "id-y", f.host)).toBe(true);
  });
});

describe("KeptTags — forget / dropPane / clear / names", () => {
  it("forget erases one tag and reports whether it existed", () => {
    const f = make();
    f.tags.keep("p", A, "jump", "id-1", f.host);
    f.tags.keep("p", A, "db", "id-2", f.host);
    expect(f.tags.forget("p", "jump")).toBe(true);
    expect(f.erased).toEqual(["id-1"]);
    expect(f.tags.forget("p", "jump")).toBe(false);
    expect(f.tags.names()).toEqual({ p: ["db"] });
  });

  it("dropPane (the pane closed) erases all its tags and leaves other panes alone", () => {
    const f = make();
    f.tags.keep("p", A, "jump", "id-1", f.host);
    f.tags.keep("p", A, "db", "id-2", f.host);
    f.tags.keep("q", CLASSIC, "jump", "id-3", f.host);
    f.tags.dropPane("p");
    expect(f.erased.sort()).toEqual(["id-1", "id-2"]);
    expect(f.tags.names()).toEqual({ q: ["jump"] });
    f.tags.dropPane("p"); // idempotent
    f.tags.dropPane("never-seen");
    expect(f.erased).toHaveLength(2);
  });

  it("clear forgets everything (shutdown: the helper takes the secrets with it)", () => {
    const f = make();
    f.tags.keep("p", A, "jump", "id-1", f.host);
    f.tags.clear();
    expect(f.tags.hasAny()).toBe(false);
    expect(f.erased).toEqual([]);
  });

  it("names lists tag names per pane, sorted, and nothing else", () => {
    const f = make();
    f.tags.keep("p", A, "jump", "id-1", f.host);
    f.tags.keep("p", A, "db", "id-2", f.host);
    expect(f.tags.names()).toEqual({ p: ["db", "jump"] });
    expect(JSON.stringify(f.tags.names())).not.toContain("id-");
  });
});
