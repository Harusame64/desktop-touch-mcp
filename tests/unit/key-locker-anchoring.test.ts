/**
 * key-locker-anchoring.test.ts — ADR-014 R3 OQ-W-16-bis Phase 2 + 3.
 *
 *   Phase 2  KeyLockerWiring.ensureAnchoredConsole — idempotent reuse of a live pane, `fresh` opens a new
 *            one, the R2 cap declines a spray, a dead pane is pruned then relaunched.
 *   Phase 3  credentialNudge — the `_advisory.ts` hook body: nudge toward launch_console on a credential
 *            command to a non-anchored pane, suppressed by paneId / non-credential / no-consent, deduped.
 *
 * The live spawn (`manager.launchAnchoredConsole`) and window liveness (`findTerminalWindowByHwnd`) are faked
 * so the reuse/cap/prune logic is unit-testable without a real console.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Control which fake hwnds are "live" (a live ConsoleWindowClass window) via a Set the mock reads.
const liveHwnds = new Set<bigint>();
vi.mock(import("../../src/tools/terminal.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findTerminalWindowByHwnd: vi.fn((hwnd: bigint) =>
      liveHwnds.has(hwnd) ? ({ hwnd, title: `dtm-locker-console-${hwnd}`, className: "ConsoleWindowClass" } as never) : null,
    ),
  };
});

import { KeyLockerManager } from "../../src/engine/key-locker/key-locker-manager.js";
import type { PaneAnchor } from "../../src/engine/key-locker/inject-target.js";
import { KeyLockerWiring } from "../../src/tools/key-locker-wiring.js";
import { maybeAdvisory } from "../../src/tools/_advisory.js";

// wt panes have no window — their liveness is the shell's creation-time identity, faked via this map
// (paneId → the anchored startTimeMs; a live shell reads the same value, a dead/reused one differs).
const liveWtShells = new Map<number, number>();
vi.mock(import("../../src/engine/win32.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getProcessIdentityByPid: vi.fn((pid: number) => ({
      pid,
      processName: liveWtShells.has(pid) ? "powershell" : "",
      processStartTimeMs: liveWtShells.get(pid) ?? 0,
    })),
  };
});

/** A manager whose console launch is faked (no real conhost/wt) and whose consent/kill are directly settable. */
class FakeWiringManager extends KeyLockerManager {
  hwndSeq = 1000n;
  wtPidSeq = 30000;
  consent = true;
  constructor(dir: string) { super({ storeDir: dir }); }
  override isConsentAccepted(): boolean { return this.consent; }
  override isDisabled(): boolean { return false; }
  override async launchAnchoredConsole(
    o: { host?: "classic" | "windows-terminal" } = {},
  ): Promise<{ anchor: PaneAnchor; title: string }> {
    if (o.host === "windows-terminal") {
      const shellPid = this.wtPidSeq++;
      const startMs = 10;
      liveWtShells.set(shellPid, startMs); // a freshly launched wt shell is live with its anchored time
      return { anchor: { kind: "wt", shellPid, shellStartTimeMs: startMs }, title: `dtm-locker-console-wt-${shellPid}` };
    }
    const hwnd = this.hwndSeq++;
    liveHwnds.add(hwnd); // a freshly launched console is live
    return {
      anchor: { kind: "classic", hwnd, shellPid: Number(hwnd) + 1, shellStartTimeMs: 10 },
      title: `dtm-locker-console-${hwnd}`,
    };
  }
}

function newWiring(): { wiring: KeyLockerWiring; mgr: FakeWiringManager } {
  const dir = mkdtempSync(join(tmpdir(), "dtm-anchor-"));
  const mgr = new FakeWiringManager(dir);
  return { wiring: new KeyLockerWiring(mgr), mgr };
}

beforeEach(() => {
  liveHwnds.clear();
  liveWtShells.clear();
});

// The Phase-2 reuse/cap/prune logic is host-agnostic; these exercise it on the CLASSIC path (host:'classic'
// explicit — the default is now 'windows-terminal', E7). The WT path is exercised in its own describe below.
describe("ensureAnchoredConsole classic path (Phase 2)", () => {
  const classic = { host: "classic" } as const;
  it("reuses the same live pane by default (idempotent)", async () => {
    const { wiring } = newWiring();
    const a = await wiring.ensureAnchoredConsole(classic);
    const b = await wiring.ensureAnchoredConsole(classic);
    expect(b.paneId).toBe(a.paneId);
  });

  it("opens a NEW pane when fresh:true", async () => {
    const { wiring } = newWiring();
    const a = await wiring.ensureAnchoredConsole(classic);
    const b = await wiring.ensureAnchoredConsole({ ...classic, fresh: true });
    expect(b.paneId).not.toBe(a.paneId);
  });

  it("relaunches when the reusable pane has died (pruned)", async () => {
    const { wiring } = newWiring();
    const a = await wiring.ensureAnchoredConsole(classic);
    liveHwnds.delete(BigInt(a.paneId)); // the user closed it
    const b = await wiring.ensureAnchoredConsole(classic);
    expect(b.paneId).not.toBe(a.paneId);
  });

  it("declines with KeyLockerConsoleLimit once the live-pane cap is reached", async () => {
    const { wiring } = newWiring();
    await wiring.ensureAnchoredConsole({ ...classic, fresh: true }); // 1
    await wiring.ensureAnchoredConsole({ ...classic, fresh: true }); // 2
    await wiring.ensureAnchoredConsole({ ...classic, fresh: true }); // 3 (cap)
    await expect(wiring.ensureAnchoredConsole({ ...classic, fresh: true })).rejects.toMatchObject({ code: "KeyLockerConsoleLimit" });
  });

  it("frees a cap slot when a live pane dies", async () => {
    const { wiring } = newWiring();
    const a = await wiring.ensureAnchoredConsole({ ...classic, fresh: true });
    await wiring.ensureAnchoredConsole({ ...classic, fresh: true });
    await wiring.ensureAnchoredConsole({ ...classic, fresh: true }); // at cap
    liveHwnds.delete(BigInt(a.paneId)); // one dies → slot freed
    await expect(wiring.ensureAnchoredConsole({ ...classic, fresh: true })).resolves.toHaveProperty("paneId");
  });

  // OQ-8: a pane whose WINDOW is still live but which can no longer ARM (driver record torn down by a spurious
  // window_disappeared, or session drifted to UNKNOWN) must NOT be reused — reuse launches a fresh, re-anchored
  // pane instead (self-healing). Blind re-anchor of the stale pane is rejected (wrong-target disclosure risk).
  const driverOf = (w: KeyLockerWiring) =>
    (w as unknown as { driver: { panes: Map<string, unknown> } }).driver;

  it("does NOT reuse a live-window pane whose driver record was torn down (OQ-8) — relaunches", async () => {
    const { wiring } = newWiring();
    const a = await wiring.ensureAnchoredConsole(classic);
    // Isolate the hasPane gate: delete ONLY the driver's pane record, NOT the tracker session — so the
    // session stays KNOWN and `hasPane` ALONE must reject the reuse (proves it is load-bearing, not shadowed
    // by the isKnownSession check that the full onPaneClosed teardown would also trip). Window stays live.
    driverOf(wiring).panes.delete(a.paneId);
    const b = await wiring.ensureAnchoredConsole(classic);
    expect(b.paneId).not.toBe(a.paneId);
  });

  it("does NOT reuse a pane whose session drifted to UNKNOWN (OQ-8) — relaunches", async () => {
    const { wiring, mgr } = newWiring();
    const a = await wiring.ensureAnchoredConsole(classic);
    mgr.tracker.markUnknown(a.paneId); // hypothesis B: session no longer KNOWN
    const b = await wiring.ensureAnchoredConsole(classic);
    expect(b.paneId).not.toBe(a.paneId);
  });
});

// ── S-pid E7: the WT host path (default) + host-aware reuse ────────────────────────────────────────────
describe("ensureAnchoredConsole WT path (S-pid E7)", () => {
  it("defaults to the windows-terminal host and returns a wt:… paneId", async () => {
    const { wiring } = newWiring();
    const a = await wiring.ensureAnchoredConsole(); // no host ⇒ default windows-terminal
    expect(a.paneId).toMatch(/^wt:\d+:\d+$/);
  });

  it("reuses the same wt pane by default (anchor-identity liveness, no window needed)", async () => {
    const { wiring } = newWiring();
    const a = await wiring.ensureAnchoredConsole();
    const b = await wiring.ensureAnchoredConsole();
    expect(b.paneId).toBe(a.paneId);
  });

  it("relaunches when the wt shell died (identity read 0)", async () => {
    const { wiring } = newWiring();
    const a = await wiring.ensureAnchoredConsole();
    const parsed = /^wt:(\d+):/.exec(a.paneId)!;
    liveWtShells.delete(Number(parsed[1])); // the tab closed — shell exited
    const b = await wiring.ensureAnchoredConsole();
    expect(b.paneId).not.toBe(a.paneId);
  });

  it("relaunches when the wt shell pid was REUSED (different non-zero creation time)", async () => {
    const { wiring } = newWiring();
    const a = await wiring.ensureAnchoredConsole();
    const shellPid = Number(/^wt:(\d+):/.exec(a.paneId)![1]);
    liveWtShells.set(shellPid, 999); // same pid, DIFFERENT creation time ⇒ a reused pid, not our shell
    const b = await wiring.ensureAnchoredConsole();
    expect(b.paneId).not.toBe(a.paneId);
  });

  it("does NOT reuse a classic pane for a windows-terminal request (host-aware reuse)", async () => {
    const { wiring } = newWiring();
    const c = await wiring.ensureAnchoredConsole({ host: "classic" });
    const w = await wiring.ensureAnchoredConsole({ host: "windows-terminal" });
    expect(w.paneId).not.toBe(c.paneId);
    expect(w.paneId).toMatch(/^wt:/);
    // …and back: a classic request does not hand back the wt pane.
    const c2 = await wiring.ensureAnchoredConsole({ host: "classic" });
    expect(c2.paneId).toBe(c.paneId); // the classic pane is still reused for a classic request
  });

  it("counts BOTH kinds toward the cap", async () => {
    const { wiring } = newWiring();
    await wiring.ensureAnchoredConsole({ host: "classic", fresh: true });
    await wiring.ensureAnchoredConsole({ host: "windows-terminal", fresh: true });
    await wiring.ensureAnchoredConsole({ host: "windows-terminal", fresh: true }); // 3 (cap)
    await expect(wiring.ensureAnchoredConsole({ host: "windows-terminal", fresh: true }))
      .rejects.toMatchObject({ code: "KeyLockerConsoleLimit" });
  });
});

describe("credentialNudge (Phase 3)", () => {
  const nudge = (wiring: KeyLockerWiring, args: Record<string, unknown>) =>
    (wiring as unknown as { credentialNudge(a: Record<string, unknown>): unknown }).credentialNudge(args);

  it("nudges toward key_locker on a credential command to a non-anchored (no-paneId) pane", () => {
    const { wiring } = newWiring();
    const hint = nudge(wiring, { input: "ssh user@host", windowTitle: "PowerShell" }) as { preferredPath: string } | null;
    expect(hint?.preferredPath).toBe("key_locker");
  });

  it("suppresses the nudge when the send already targets an anchored pane (paneId set)", () => {
    const { wiring } = newWiring();
    expect(nudge(wiring, { input: "sudo apt update", paneId: "12345", windowTitle: "x" })).toBeNull();
  });

  it("suppresses the nudge for a non-credential command", () => {
    const { wiring } = newWiring();
    expect(nudge(wiring, { input: "ls -la", windowTitle: "PowerShell" })).toBeNull();
  });

  it("suppresses the nudge when consent is not accepted", () => {
    const { wiring, mgr } = newWiring();
    mgr.consent = false;
    expect(nudge(wiring, { input: "ssh user@host", windowTitle: "PowerShell" })).toBeNull();
  });

  it("dedupes: nudges a given pane title at most once", () => {
    const { wiring } = newWiring();
    expect(nudge(wiring, { input: "ssh a@b", windowTitle: "PowerShell" })).not.toBeNull();
    expect(nudge(wiring, { input: "ssh c@d", windowTitle: "PowerShell" })).toBeNull();
  });

  it("recognises path-qualified ssh (C:\\...\\ssh.exe) as credential-shaped", () => {
    const { wiring } = newWiring();
    const hint = nudge(wiring, { input: "C:\\Windows\\System32\\OpenSSH\\ssh.exe -p 2222 u@h", windowTitle: "cmd" });
    expect(hint).not.toBeNull();
  });
});

describe("start() registers the credential advisor with _advisory (Phase 3 integration)", () => {
  it("routes a terminal:send advisory through the wiring, and stop() unregisters it", () => {
    const { wiring } = newWiring();
    try {
      wiring.start();
      const hint = maybeAdvisory("terminal", { action: "send", input: "ssh u@h", windowTitle: "PowerShell" }, null, "powershell.exe");
      expect(hint?.preferredPath).toBe("key_locker");
    } finally {
      void wiring.stop();
    }
    // After stop() the advisor is unregistered → no nudge.
    expect(maybeAdvisory("terminal", { action: "send", input: "ssh u@h", windowTitle: "Other" }, null, "powershell.exe")).toBeNull();
  });
});
