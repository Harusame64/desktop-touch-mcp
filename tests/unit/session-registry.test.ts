import { describe, it, expect } from "vitest";
import {
  SessionRegistry,
  type SessionCreateOpts,
  type TargetSpec,
} from "../../src/engine/world-graph/session-registry.js";

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
    r.indexViewId("view-abc", key);
    expect(r.getByViewId("view-abc")).toBe(s);
  });

  it("getByViewId returns undefined for unknown viewId", () => {
    const r = new SessionRegistry();
    expect(r.getByViewId("nonexistent")).toBeUndefined();
  });

  it("old viewIds from the same target still find the session (generation_mismatch path)", () => {
    const r = new SessionRegistry();
    const key = r.resolveKey({ hwnd: "1" });
    const s = r.getOrCreate(key, makeOpts());
    r.indexViewId("view-old", key);
    r.indexViewId("view-new", key); // new viewId after second see()
    // Old viewId still maps to the session — validation will catch generation_mismatch
    expect(r.getByViewId("view-old")).toBe(s);
    expect(r.getByViewId("view-new")).toBe(s);
  });
});

describe("SessionRegistry — eviction", () => {
  it("evictStale removes sessions older than ttlMs", () => {
    let now = 1000;
    const r = new SessionRegistry();
    const opts = makeOpts({ nowFn: () => now });
    const key = r.resolveKey({ hwnd: "1" });
    r.getOrCreate(key, opts); // lastAccess = 1000
    r.indexViewId("view-1", key);

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

    r.indexViewId("view-1", key);
    expect(r.getByViewId("view-1")).toBeDefined();
  });

  it("evictStale removes viewId index entries for evicted sessions", () => {
    let now = 1000;
    const r = new SessionRegistry();
    const opts = makeOpts({ nowFn: () => now });
    const key = r.resolveKey({ hwnd: "1" });
    r.getOrCreate(key, opts);
    r.indexViewId("view-1", key);

    now = 5000;
    r.evictStale(1000, () => now);

    expect(r.getByViewId("view-1")).toBeUndefined();
  });
});
