// key-locker-kept-tags-wiring.test.ts — internal #281: the WIRING's half of kept fill_once tags. The pure
// rules are pinned in key-locker-kept-tags.test.ts and key-locker-fill-once.test.ts; this pins the lines that
// connect them to the live pieces:
//   * a new tag is kept only under the helper that CAPTURED it (not merely "whatever helper is live");
//   * a pane close through the driver erases the pane's tags on the live helper;
//   * the manager is told not to idle-dispose while a tag is held, and `stop()` lets go of it;
//   * forget_tag / list go through the same map.
// `runFillOnce` is replaced to capture the live seams (as in key-locker-fill-once-wiring.test.ts).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/engine/nutjs.js", () => ({ mouse: { getPosition: vi.fn() } }));

let seams: import("../../src/engine/key-locker/fill-once.js").FillOnceDeps | null = null;
vi.mock(import("../../src/engine/key-locker/fill-once.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runFillOnce: vi.fn(async (deps) => { seams = deps; return { kind: "cancelled" } as const; }),
  };
});

import type { KeyLockerHost } from "../../src/engine/key-locker-host.js";
import { KeyLockerManager } from "../../src/engine/key-locker/key-locker-manager.js";
import type { PaneAnchor } from "../../src/engine/key-locker/inject-target.js";
import { KeyLockerWiring } from "../../src/tools/key-locker-wiring.js";

const ANCHOR: PaneAnchor = { kind: "wt", shellPid: 4321, shellStartTimeMs: 10 };

class FakeHostManager extends KeyLockerManager {
  readonly deletes: string[] = [];
  readonly confirms: unknown[] = [];
  alive = true;
  clock = 1_000;
  readonly fake = {
    get alive(): boolean { return hostAlive(); },
    capture: async () => ({ captured: true, rt: true }),
    delete: async (id: string) => { this.deletes.push(id); return true; },
    confirmKeptFill: async (d: unknown) => { this.confirms.push(d); return "fill"; },
    dispose: async () => {},
  } as unknown as KeyLockerHost;
  constructor(dir: string) { super({ storeDir: dir, now: () => mgrClock() }); }
  protected override startHost(): Promise<KeyLockerHost> { return Promise.resolve(this.fake); }
}
let current: FakeHostManager | null = null;
const hostAlive = (): boolean => current?.alive ?? false;
const mgrClock = (): number => current?.clock ?? 0;

function setup(): { wiring: KeyLockerWiring; mgr: FakeHostManager } {
  const dir = mkdtempSync(join(tmpdir(), "dtm-kt-"));
  writeFileSync(join(dir, "consent.json"), JSON.stringify({ version: 1, acceptedAt: "2026-10-30T00:00:00.000Z" }), "utf8");
  const mgr = new FakeHostManager(dir);
  current = mgr;
  const wiring = new KeyLockerWiring(mgr);
  return { wiring, mgr };
}

async function seamsFor(wiring: KeyLockerWiring, tag = "jump") {
  seams = null;
  await wiring.fillOnce("wt:4321:10", "log in via the jump host", true, { tag });
  expect(seams).not.toBeNull();
  return seams!;
}

describe("the wiring keeps a tag only under the helper that captured it (internal #281)", () => {
  it("before any capture in THIS call, keep is refused even with a live helper", async () => {
    const { wiring, mgr } = setup();
    await mgr.withHost(async () => undefined); // a helper is live, but it did not capture this secret
    const s = await seamsFor(wiring);
    expect(s.kept.keep("wt:4321:10", ANCHOR, "jump", "op-1")).toBe(false);
    expect(wiring.keptTagNames()).toEqual({});
  });

  it("after this call's capture, the tag is kept and listed by name", async () => {
    const { wiring } = setup();
    const s = await seamsFor(wiring);
    await s.capture("op-1", { label: "l", note: "n", tag: "jump" });
    expect(s.kept.keep("wt:4321:10", ANCHOR, "jump", "op-1")).toBe(true);
    expect(wiring.keptTagNames()).toEqual({ "wt:4321:10": ["jump"] });
    expect(s.kept.lookup("wt:4321:10", ANCHOR, "jump")).toBe("op-1");
  });

  it("the confirm seam goes to the helper's fill_kept confirm with the dialog's tag, label and reason", async () => {
    const { wiring, mgr } = setup();
    const s = await seamsFor(wiring);
    expect(await s.kept.confirm({ label: "l", note: "n", tag: "jump" })).toBe("fill");
    expect(mgr.confirms).toEqual([{ label: "l", note: "n", tag: "jump" }]);
  });
});

describe("the wiring's lifetime hooks (internal #281)", () => {
  async function kept(): Promise<{ wiring: KeyLockerWiring; mgr: FakeHostManager }> {
    const r = setup();
    const s = await seamsFor(r.wiring);
    await s.capture("op-1", { label: "l", note: "n", tag: "jump" });
    s.kept.keep("wt:4321:10", ANCHOR, "jump", "op-1");
    return r;
  }

  it("a pane close through the driver erases its tags on the live helper", async () => {
    const { wiring, mgr } = await kept();
    (wiring as unknown as { driver: { onPaneClosed(id: string): void } }).driver.onPaneClosed("wt:4321:10");
    expect(wiring.keptTagNames()).toEqual({});
    expect(mgr.deletes).toEqual(["op-1"]);
  });

  it("forget_tag erases one tag", async () => {
    const { wiring, mgr } = await kept();
    expect(wiring.forgetTag("wt:4321:10", "jump")).toBe(true);
    expect(wiring.forgetTag("wt:4321:10", "jump")).toBe(false);
    expect(mgr.deletes).toEqual(["op-1"]);
  });

  it("the helper is not idle-disposed while a tag is held; it is once the tag is gone", async () => {
    const { wiring, mgr } = await kept();
    mgr.clock += 10_000_000;
    expect(await mgr.disposeIfIdle(60_000)).toBe(false);
    wiring.forgetTag("wt:4321:10", "jump");
    expect(await mgr.disposeIfIdle(60_000)).toBe(true);
  });

  it("a helper that died underneath takes the tags with it (nothing dangles, idle-dispose resumes)", async () => {
    const { wiring, mgr } = await kept();
    mgr.alive = false;
    expect(wiring.keptTagNames()).toEqual({});
    mgr.clock += 10_000_000;
    expect(await mgr.disposeIfIdle(60_000)).toBe(true);
  });

  it("stop() forgets the map and releases the keep-alive", async () => {
    const { wiring } = await kept();
    await wiring.stop();
    expect(wiring.keptTagNames()).toEqual({});
  });
});
