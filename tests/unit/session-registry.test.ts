import { describe, it, expect } from "vitest";
import {
  SessionRegistry,
  targetSessionKey,
  type SessionCreateOpts,
} from "../../src/engine/world-graph/session-registry.js";
import { targetKeyFromSpec } from "../../src/engine/vision-gpu/ocr-adapter.js";

function makeOpts(overrides: Partial<SessionCreateOpts> = {}): SessionCreateOpts {
  return {
    snapshotFn: () => [],
    ...overrides,
  };
}

describe("SessionRegistry — key resolution", () => {
  it("hwnd → window: prefix", () => {
    const r = new SessionRegistry();
    expect(r.resolveKey({ hwnd: "12345" })).toBe("window:12345");
  });

  it("tabId → tab: prefix", () => {
    const r = new SessionRegistry();
    expect(r.resolveKey({ tabId: "tab-1" })).toBe("tab:tab-1");
  });

  it("windowTitle → title: prefix", () => {
    const r = new SessionRegistry();
    expect(r.resolveKey({ windowTitle: "Notepad" })).toBe("title:Notepad");
  });

  it("hwnd takes priority over windowTitle", () => {
    const r = new SessionRegistry();
    expect(r.resolveKey({ hwnd: "99", windowTitle: "App" })).toBe("window:99");
  });

  it("empty target → default session key", () => {
    const r = new SessionRegistry();
    expect(r.resolveKey({})).toBe("window:__default__");
    expect(r.resolveKey(undefined)).toBe("window:__default__");
  });
});

describe("SessionRegistry — one session per window, however the handle is spelled (internal #215)", () => {
  it("keys a hex and a decimal spelling of one handle alike, in decimal", () => {
    const r = new SessionRegistry();
    expect(r.resolveKey({ hwnd: "0x1F4" })).toBe("window:500");
    expect(r.resolveKey({ hwnd: "500" })).toBe("window:500");
    expect(r.getOrCreate(r.resolveKey({ hwnd: "0x1F4" }), makeOpts()))
      .toBe(r.getOrCreate(r.resolveKey({ hwnd: "500" }), makeOpts()));
  });

  it("keys every spelling BigInt reads, and the sign-extended spelling, as the one window (gate 2 on #917)", () => {
    const r = new SessionRegistry();
    for (const hwnd of ["0x1f4", "0X1F4", " 500 ", "0o764", "0b111110100"]) {
      expect(r.resolveKey({ hwnd })).toBe("window:500");
    }
    // user32 reads the low 32 bits: a handle with bit 31 set, and its sign extension, are one window.
    expect(r.resolveKey({ hwnd: "0xFFFFFFFF80001234" })).toBe(r.resolveKey({ hwnd: "0x80001234" }));
    expect(r.resolveKey({ hwnd: "0x80001234" })).toBe("window:2147488308");
    expect(r.resolveKey({ hwnd: "0x1F4", windowTitle: "App" })).toBe("window:500");
  });

  it("keys the visual lanes alike (one rule: targetSessionKey)", () => {
    const r = new SessionRegistry();
    for (const target of [{ hwnd: "0x1F4" }, { hwnd: "-1", windowTitle: "X" }, { tabId: "t" }, {}]) {
      expect(targetSessionKey(target)).toBe(r.resolveKey(target));
    }
    expect(targetKeyFromSpec({ hwnd: "0x1F4" })).toBe("window:500");
    expect(targetKeyFromSpec({ hwnd: "-1", windowTitle: "X" })).toBe("title:X");
  });

  it("still keys an unusable handle by its spelling when nothing else aims", () => {
    const r = new SessionRegistry();
    expect(r.resolveKey({ hwnd: "A" })).toBe("window:A");
  });
});

describe("SessionRegistry — session lifecycle", () => {
  it("getOrCreate returns the same session for the same key", () => {
    const r = new SessionRegistry();
    const key = r.resolveKey({ hwnd: "1" });
    const s1 = r.getOrCreate(key, makeOpts());
    const s2 = r.getOrCreate(key, makeOpts());
    expect(s1).toBe(s2);
  });

  it("different keys produce independent sessions", () => {
    const r = new SessionRegistry();
    const s1 = r.getOrCreate(r.resolveKey({ hwnd: "A" }), makeOpts());
    const s2 = r.getOrCreate(r.resolveKey({ hwnd: "B" }), makeOpts());
    expect(s1).not.toBe(s2);
    expect(s1.leaseStore).not.toBe(s2.leaseStore);
  });

  it("session has its own LeaseStore — leases are isolated between targets", () => {
    const r = new SessionRegistry();
    const sA = r.getOrCreate(r.resolveKey({ hwnd: "A" }), makeOpts());
    const sB = r.getOrCreate(r.resolveKey({ hwnd: "B" }), makeOpts());
    expect(sA.leaseStore).not.toBe(sB.leaseStore);
  });

  it("session starts with seq=0 and generation=''", () => {
    const r = new SessionRegistry();
    const s = r.getOrCreate(r.resolveKey({ hwnd: "1" }), makeOpts());
    expect(s.seq).toBe(0);
    expect(s.generation).toBe("");
    expect(s.entities).toHaveLength(0);
  });
});

describe("SessionRegistry — viewId index", () => {
  it("getByViewId returns the session after indexing", () => {
    const r = new SessionRegistry();
    const key = r.resolveKey({ hwnd: "1" });
    const s = r.getOrCreate(key, makeOpts());
    r.replaceViewId(undefined, "view-abc", key);
    expect(r.getByViewId("view-abc")).toBe(s);
  });

  it("getByViewId returns undefined for unknown viewId", () => {
    const r = new SessionRegistry();
    expect(r.getByViewId("nonexistent")).toBeUndefined();
  });

  it("replaceViewId removes old entry and adds new one", () => {
    const r = new SessionRegistry();
    const key = r.resolveKey({ hwnd: "1" });
    const s = r.getOrCreate(key, makeOpts());
    r.replaceViewId(undefined, "view-first", key);
    r.replaceViewId("view-first", "view-second", key);
    // Old viewId evicted from index (bounded growth)
    expect(r.getByViewId("view-first")).toBeUndefined();
    expect(r.getByViewId("view-second")).toBe(s);
  });
});

describe("SessionRegistry — eviction", () => {
  it("evictStale removes sessions older than ttlMs", () => {
    let now = 1000;
    const r = new SessionRegistry();
    const opts = makeOpts({ nowFn: () => now });
    const key = r.resolveKey({ hwnd: "1" });
    r.getOrCreate(key, opts); // lastAccess = 1000
    r.replaceViewId(undefined, "view-1", key);

    now = 2200; // 1200ms later
    r.evictStale(1000, () => now); // TTL = 1000ms → threshold = 1200 → 1000 < 1200 → evict

    expect(r.getByViewId("view-1")).toBeUndefined();
  });

  it("evictStale keeps sessions accessed within ttlMs", () => {
    let now = 1000;
    const r = new SessionRegistry();
    const opts = makeOpts({ nowFn: () => now });
    const key = r.resolveKey({ hwnd: "1" });
    r.getOrCreate(key, opts); // lastAccess = 1000

    now = 1500; // 500ms later
    r.evictStale(1000, () => now); // TTL = 1000ms → threshold = 500 → 1000 >= 500 → keep

    r.replaceViewId(undefined, "view-1", key);
    expect(r.getByViewId("view-1")).toBeDefined();
  });

  it("evictStale removes viewId index entries for evicted sessions", () => {
    let now = 1000;
    const r = new SessionRegistry();
    const opts = makeOpts({ nowFn: () => now });
    const key = r.resolveKey({ hwnd: "1" });
    r.getOrCreate(key, opts);
    r.replaceViewId(undefined, "view-1", key);

    now = 5000;
    r.evictStale(1000, () => now);

    expect(r.getByViewId("view-1")).toBeUndefined();
  });

  // Codex PR #55 P2: in-flight workflows must keep their session alive.
  // Without the lastAccessMs refresh on getByViewId, the eviction sweep
  // could delete a session that the LLM is in the middle of using.
  it("getByViewId refreshes lastAccessMs so eviction won't delete an in-flight workflow", () => {
    let now = 1000;
    const r = new SessionRegistry();
    const opts = makeOpts({ nowFn: () => now });
    const key = r.resolveKey({ hwnd: "1" });
    r.getOrCreate(key, opts); // lastAccess = 1000
    r.replaceViewId(undefined, "view-1", key);

    // Simulate the LLM thinking past the TTL and then calling touch().
    now = 1900;
    expect(r.getByViewId("view-1", () => now)).toBeDefined(); // refreshes lastAccessMs to 1900

    // Eviction sweep at 2100 with TTL=1000 → threshold=1100. lastAccessMs is
    // now 1900 (not the original 1000), so the session survives.
    now = 2100;
    r.evictStale(1000, () => now);

    expect(r.getByViewId("view-1", () => now)).toBeDefined();
  });
});
