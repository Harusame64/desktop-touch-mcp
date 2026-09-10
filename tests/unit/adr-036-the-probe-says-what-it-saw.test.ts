/**
 * The probe says what it saw — which lane read, which addon answered, and which rung refused.
 *
 * ADR-036 item 14. Three silences in the instrument every real-machine round leans on, and each of
 * them let a round read an absence as an answer:
 *
 *   - 14a — only the UIA lane wrote a `provider.read` row, so "that lane did not read" and "that
 *     lane is not instrumented" printed the same (win2, 2026-09-10, `dev/pr615-roads/`: a passing
 *     terminal arm was voided by that rule).
 *   - 14b — nothing in a record said which `.node` produced it. A sandbox carrying the 2026-08-29
 *     addon measured the enumeration road while its source had the OS hit test, and only
 *     `pointOwner.via` noticed.
 *   - 14c — seven rungs refuse, five of them with one class and one published reason, and the rows
 *     could not say which of them had (win2, 2026-09-11 — a reading of the code, measured next).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Aim, WindowIdentity, WindowRect } from "../../src/engine/aim.js";
import type { ExecutorDeps } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

/** Every module a cell below replaces, unmocked after each cell so none leaks into the next. */
const MOCKED = [
  "node:fs",
  "../../src/engine/native-engine.js",
  "../../src/engine/uia-bridge.js",
  "../../src/engine/ocr-bridge.js",
  "../../src/engine/vision-gpu/ocr-adapter-registry.js",
  "../../src/engine/cdp-bridge.js",
  "../../src/engine/vision-gpu/runtime.js",
  "../../src/tools/desktop-providers/uia-provider.js",
  "../../src/tools/desktop-providers/visual-provider.js",
  "../../src/tools/desktop-providers/ocr-provider.js",
  "../../src/tools/desktop-providers/browser-provider.js",
  "../../src/tools/desktop-providers/terminal-provider.js",
];

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "probe-saw-"));
  logPath = join(dir, "aim-probe.jsonl");
  process.env.DESKTOP_TOUCH_AIM_PROBE = "1";
  process.env.DESKTOP_TOUCH_AIM_PROBE_PATH = logPath;
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.DESKTOP_TOUCH_AIM_PROBE;
  delete process.env.DESKTOP_TOUCH_AIM_PROBE_PATH;
  delete process.env.DESKTOP_TOUCH_DISABLE_VISUAL_GPU;
  for (const m of MOCKED) vi.doUnmock(m);
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

type Row = Record<string, unknown>;

function rows(): Row[] {
  return readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row);
}

function laneRows(lane: string): Row[] {
  return rows().filter((r) => r.seam === "provider.read" && r.lane === lane);
}

describe("row zero says what the process is running on (14b)", () => {
  async function probeOn(boundExports: string[] | null) {
    vi.doMock("../../src/engine/native-engine.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/engine/native-engine.js")>()),
      nativeExportNames: () => boundExports,
    }));
    return await import("../../src/engine/aim-probe.js");
  }

  it("is written once, first, as row zero, and every other row keeps the number it had", async () => {
    const { probeAim } = await probeOn(["uiaGetElements"]);
    probeAim("see.enter", { key: "window:1" });
    probeAim("act.aim", { aimHwnd: null });
    expect(rows().map((r) => [r.seq, r.seam])).toEqual([[0, "probe.start"], [1, "see.enter"], [2, "act.aim"]]);
  });

  it("tells an addon with the OS hit test from one without it", async () => {
    // The 2026-09-10 misreading as a pair: the 08-29 addon has no `win32WindowFromPoint`, the one
    // built that evening does, and the sandbox that measured the wrong road carried the first.
    const without = await probeOn(["uiaGetElements", "win32EnumTopLevelWindows"]);
    without.probeAim("see.enter", {});
    const before = rows()[0]!;

    rmSync(logPath);
    vi.resetModules();
    const withIt = await probeOn(["uiaGetElements", "win32EnumTopLevelWindows", "win32WindowFromPoint"]);
    withIt.probeAim("see.enter", {});
    const after = rows()[0]!;

    expect(before.boundExports).not.toContain("win32WindowFromPoint");
    expect(after.boundExports).toContain("win32WindowFromPoint");
  });

  it("records a build with no binding as null, not as an empty list", async () => {
    const { probeAim } = await probeOn(null);
    probeAim("see.enter", {});
    const header = rows()[0]!;
    expect(Object.hasOwn(header, "boundExports")).toBe(true);
    expect(header.boundExports).toBeNull();
  });

  it("identifies each .node the process has loaded, from the process's own list", async () => {
    const node = join(dir, "desktop-touch-engine.win32-x64-msvc.node");
    const bytes = Buffer.from("not an addon, only a file whose hash is known");
    writeFileSync(node, bytes);
    vi.spyOn(process.report, "getReport").mockReturnValue(
      { sharedObjects: ["/usr/lib/libc.so.6", node, "C:\\Windows\\System32\\user32.dll"] } as never,
    );
    const { probeAim } = await probeOn(["uiaGetElements"]);
    probeAim("see.enter", {});
    const header = rows()[0]!;
    expect(header.addonFilesFrom).toBe("process.report.sharedObjects");
    expect(header.addonFiles).toEqual([{
      path: node,
      bytes: bytes.length,
      mtimeMs: expect.any(Number),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }]);
  });

  it("names a listed file it could not read, rather than dropping it from the list", async () => {
    const vanished = join(dir, "vanished.node");
    vi.spyOn(process.report, "getReport").mockReturnValue({ sharedObjects: [vanished] } as never);
    const { probeAim } = await probeOn(["uiaGetElements"]);
    probeAim("see.enter", {});
    expect(rows()[0]!.addonFiles).toEqual([{ path: vanished, error: expect.any(String) }]);
  });

  it("asks for the report without resolving socket names, and puts the setting back", async () => {
    // Gate 2 on #621: the report looks up a host name for every open socket by default, on the
    // event loop, inside the first seam of the run being measured.
    const settings = process.report as typeof process.report & { excludeNetwork?: boolean };
    const before = settings.excludeNetwork;
    const seen: unknown[] = [];
    vi.spyOn(process.report, "getReport").mockImplementation(() => {
      seen.push(settings.excludeNetwork);
      return { sharedObjects: [] } as never;
    });
    const { probeAim } = await probeOn(["uiaGetElements"]);
    probeAim("see.enter", {});
    expect(seen).toEqual([true]);
    expect(settings.excludeNetwork).toBe(before);
  });

  it("does not ask for the report on a runtime that cannot skip the socket names", async () => {
    // PR 側 codex on #621: `excludeNetwork` is missing on Node 20.0–20.12, which the package still
    // admits, and setting it there only makes an ignored property — the lookups would run anyway.
    // Not asking keeps the run being measured unslowed, and the row says why it has no list.
    const { addonFilesFromReport } = await probeOn(["uiaGetElements"]);
    const older = { getReport: vi.fn(() => ({ sharedObjects: [] })) };
    expect(addonFilesFromReport(older)).toEqual({
      addonFilesFrom: "process.report.sharedObjects",
      addonFiles: null,
      addonFilesError: expect.stringContaining("excludeNetwork"),
    });
    expect(older.getReport).not.toHaveBeenCalled();

    // The pair: a runtime that has the setting is asked, and gets its setting back.
    const current = { getReport: vi.fn(() => ({ sharedObjects: [] })), excludeNetwork: false };
    expect(addonFilesFromReport(current)).toEqual({ addonFilesFrom: "process.report.sharedObjects", addonFiles: [] });
    expect(current.getReport).toHaveBeenCalledOnce();
    expect(current.excludeNetwork).toBe(false);
  });

  it("takes the size from the bytes it hashed, and says when the file moved under the read", async () => {
    // PR 側 codex on #621, the CodeQL race one layer down: a single descriptor does not freeze a file
    // rewritten in place, so a stat's size beside a hash of later bytes could still describe two
    // states of one file.
    const node = join(dir, "moving.node");
    const bytes = Buffer.from("the bytes that were actually hashed");
    writeFileSync(node, bytes);
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      let looks = 0;
      return {
        ...actual,
        // The second look at the descriptor sees a different file — what a rewrite in place between
        // the two would show.
        fstatSync: (fd: number) => {
          const st = actual.fstatSync(fd);
          return ++looks === 1 ? st : { ...st, size: st.size + 7, mtimeMs: st.mtimeMs + 1000 };
        },
      };
    });
    vi.spyOn(process.report, "getReport").mockReturnValue({ sharedObjects: [node] } as never);
    const { probeAim } = await probeOn(["uiaGetElements"]);
    probeAim("see.enter", {});
    expect(rows()[0]!.addonFiles).toEqual([{
      path: node,
      bytes: bytes.length,
      mtimeMs: expect.any(Number),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      changedWhileRead: true,
    }]);
  });

  it("still writes the header, and the rows after it, when the process cannot say what it loaded", async () => {
    vi.spyOn(process.report, "getReport").mockImplementation(() => {
      throw new Error("report unavailable");
    });
    const { probeAim } = await probeOn(["uiaGetElements"]);
    probeAim("see.enter", { key: "window:1" });
    const [header, first] = rows();
    expect(header).toMatchObject({ seq: 0, seam: "probe.start", addonFiles: null, addonFilesError: "report unavailable" });
    expect(first).toMatchObject({ seq: 1, seam: "see.enter", key: "window:1" });
  });
});

describe("every lane says what it did with the read (14a)", () => {
  describe("terminal", () => {
    async function terminalReading(read: () => Promise<string | null>) {
      vi.doMock("../../src/engine/uia-bridge.js", () => ({ getTextViaTextPattern: vi.fn(read) }));
      return (await import("../../src/tools/desktop-providers/terminal-provider.js")).fetchTerminalCandidates;
    }

    it("says it read the buffer, and never what the buffer said", async () => {
      const fetch = await terminalReading(async () => "export TOKEN=hunter2-in-the-buffer\nPS C:\\> ");
      const result = await fetch({ windowTitle: "Windows PowerShell" });
      expect(laneRows("terminal")).toEqual([expect.objectContaining({
        outcome: "read", bufferRead: true, scoped: false, candidateCount: result.candidates.length,
      })]);
      // The candidates carry the buffer — that is the product. The row must not.
      expect(JSON.stringify(result.candidates)).toContain("hunter2-in-the-buffer");
      expect(readFileSync(logPath, "utf8")).not.toContain("hunter2-in-the-buffer");
    });

    it("tells an empty buffer from a read that failed", async () => {
      const empty = await terminalReading(async () => null);
      await empty({ windowTitle: "Windows PowerShell" });
      vi.resetModules();
      const failing = await terminalReading(async () => {
        throw new Error("TextPattern unavailable");
      });
      await failing({ windowTitle: "Windows PowerShell" });
      const [a, b] = laneRows("terminal");
      expect(a).toMatchObject({ outcome: "read", bufferRead: false, warnings: ["terminal_buffer_empty"] });
      expect(b).toMatchObject({ outcome: "failed", warnings: ["terminal_provider_failed"] });
    });

    it("says it did not look when there was no window to read", async () => {
      const fetch = await terminalReading(async () => {
        throw new Error("must not be called");
      });
      await fetch(undefined);
      expect(laneRows("terminal")).toEqual([expect.objectContaining({ outcome: "skipped", why: "no_target", candidateCount: 0 })]);
    });
  });

  describe("ocr", () => {
    async function ocrCapturing(run: () => Promise<unknown>) {
      vi.doMock("../../src/engine/ocr-bridge.js", () => ({ runSomPipeline: vi.fn(run), detectOcrLanguage: () => "en" }));
      vi.doMock("../../src/engine/vision-gpu/ocr-adapter-registry.js", () => ({
        getOcrVisualAdapter: () => ({ pollOnce: vi.fn(async () => {}) }),
      }));
      return (await import("../../src/tools/desktop-providers/ocr-provider.js")).fetchOcrCandidates;
    }

    it("records the handle the capture resolved beside the one it was asked for", async () => {
      const fetch = await ocrCapturing(async () => ({
        elements: [{ text: "OK", region: { x: 1, y: 2, width: 3, height: 4 }, confidence: 0.9 }],
        resolvedHwnd: "4919",
      }));
      await fetch({ windowTitle: "Blind", hwnd: "4919" });
      expect(laneRows("ocr")).toEqual([expect.objectContaining({
        outcome: "read", scoped: true, pinnedHwnd: "4919", resolvedHwnd: "4919", elementCount: 1, candidateCount: 1,
      })]);
    });

    it("tells 'looked and found nothing' from 'could not look'", async () => {
      const empty = await ocrCapturing(async () => ({ elements: [] }));
      await empty({ windowTitle: "Blind" });
      vi.resetModules();
      const failing = await ocrCapturing(async () => {
        throw new Error("capture failed");
      });
      await failing({ windowTitle: "Blind" });
      const [a, b] = laneRows("ocr");
      expect(a).toMatchObject({ outcome: "read", elementCount: 0, warnings: ["ocr_attempted_empty"] });
      expect(b).toMatchObject({ outcome: "failed", warnings: ["ocr_provider_failed"] });
    });
  });

  describe("cdp", () => {
    async function cdpAnswering(evaluate: () => Promise<unknown>) {
      vi.doMock("../../src/engine/cdp-bridge.js", () => ({ evaluateInTab: vi.fn(evaluate), DEFAULT_CDP_PORT: 9222 }));
      return (await import("../../src/tools/desktop-providers/browser-provider.js")).fetchBrowserCandidates;
    }

    it("counts what the tab returned, and never records what it said", async () => {
      const fetch = await cdpAnswering(async () => [
        { type: "button", text: "Pay alice@example.com", selector: "#pay", inViewport: true },
      ]);
      await fetch({ tabId: "T1" });
      expect(laneRows("cdp")).toEqual([expect.objectContaining({
        outcome: "read", tabId: "T1", elementCount: 1, candidateCount: 1, warnings: [],
      })]);
      expect(readFileSync(logPath, "utf8")).not.toContain("alice@example.com");
    });

    it("says why it did not look, and why a reply was not a read", async () => {
      const noTab = await cdpAnswering(async () => {
        throw new Error("must not be called");
      });
      await noTab({ windowTitle: "Not a tab" });
      vi.resetModules();
      const notAList = await cdpAnswering(async () => ({ error: "Target closed" }));
      await notAList({ tabId: "T1" });
      expect(laneRows("cdp").map((r) => [r.outcome, r.why])).toEqual([["skipped", "no_tab"], ["failed", "not_an_array"]]);
    });
  });

  describe("visual_gpu", () => {
    async function visualWith(runtime: Record<string, unknown>) {
      vi.doMock("../../src/engine/vision-gpu/runtime.js", () => ({
        getVisualRuntime: () => runtime,
        targetKeyToWarmTarget: (key: string) => key,
      }));
      return (await import("../../src/tools/desktop-providers/visual-provider.js")).fetchVisualCandidates;
    }

    it("says which of three reasons kept it from looking", async () => {
      // Two of them answer the same warning, `visual_provider_unavailable`; only the row tells an
      // operator's switch from a backend that never attached.
      const none = await visualWith({ isAvailable: () => false });
      await none({ windowTitle: "W" });
      vi.resetModules();
      const warming = await visualWith({ isAvailable: () => true, ensureWarm: async () => "warming" });
      await warming({ windowTitle: "W" });
      vi.resetModules();
      process.env.DESKTOP_TOUCH_DISABLE_VISUAL_GPU = "1";
      const off = await visualWith({ isAvailable: () => true });
      await off({ windowTitle: "W" });
      expect(laneRows("visual_gpu").map((r) => [r.outcome, r.why])).toEqual([
        ["skipped", "no_backend"], ["skipped", "warming"], ["skipped", "disabled_by_env"],
      ]);
    });

    it("reads when warm, and fails when warming throws", async () => {
      const warm = await visualWith({
        isAvailable: () => true,
        ensureWarm: async () => "warm",
        getStableCandidates: async () => [{ source: "visual_gpu", label: "Painted button" }],
        recognitionCapability: () => "recognises",
      });
      await warm({ windowTitle: "W" });
      vi.resetModules();
      const throwing = await visualWith({
        isAvailable: () => true,
        ensureWarm: async () => {
          throw new Error("session init failed");
        },
      });
      await throwing({ windowTitle: "W" });
      const [a, b] = laneRows("visual_gpu");
      expect(a).toMatchObject({ outcome: "read", targetKey: "title:W", warmState: "warm", recognition: "recognises", candidateCount: 1 });
      expect(b).toMatchObject({ outcome: "failed", why: "ensure_warm_threw" });
    });

    it("does not call a replay a look, whether or not it replayed anything", async () => {
      // PR 側 codex on #621 (P1). The default build's backend is warm in 50 ms and never inspects the
      // window: it serves snapshots another lane injected. Its row said `read`, so a round using
      // `provider.read` as reach evidence would have concluded the visual lane looked at a painted
      // window it never saw. A replay that DID carry candidates did not look either.
      const replay = (candidates: unknown[]) => visualWith({
        isAvailable: () => true,
        ensureWarm: async () => "warm",
        getStableCandidates: async () => candidates,
        recognitionCapability: () => "replays_injected_only",
      });
      await (await replay([]))({ windowTitle: "W" });
      vi.resetModules();
      await (await replay([{ source: "visual_gpu", label: "Replayed from OCR" }]))({ windowTitle: "W" });
      const [empty, replayed] = laneRows("visual_gpu");
      expect(empty).toMatchObject({
        outcome: "skipped", why: "replays_injected_only", recognition: "replays_injected_only",
        candidateCount: 0, warnings: ["visual_backend_cannot_recognise"],
      });
      expect(replayed).toMatchObject({
        outcome: "skipped", why: "replays_injected_only", recognition: "replays_injected_only",
        candidateCount: 1, warnings: [],
      });
    });
  });

  describe("uia", () => {
    async function uiaAnswering(getUiElements: () => Promise<unknown>) {
      vi.doMock("../../src/engine/uia-bridge.js", () => ({
        getUiElements: vi.fn(getUiElements),
        detectUiaBlind: () => ({ blind: false }),
      }));
      return (await import("../../src/tools/desktop-providers/uia-provider.js")).fetchUiaCandidates;
    }

    it("keeps the row it always wrote, with what came back added at the end", async () => {
      const fetch = await uiaAnswering(async () => ({
        elements: [{
          name: "OK", controlType: "Button", isEnabled: true, automationId: "ok",
          boundingRect: { x: 1, y: 2, width: 3, height: 4 }, patterns: ["Invoke"],
        }],
        elementCount: 1,
        windowHwnd: "4919",
      }));
      await fetch({ windowTitle: "Dialog", hwnd: "4919" });
      const [row] = laneRows("uia");
      // Several rounds read these rows as fixed-width excerpts, so the keys that existed keep their
      // place and the new ones follow them.
      expect(Object.keys(row!).slice(4)).toEqual([
        "lane", "windowTitle", "targetId", "scoped", "pinnedHwnd", "elementCount", "truncated",
        "clientProviders", "windowHwnd", "outcome", "candidateCount", "warnings",
      ]);
      expect(row).toMatchObject({ outcome: "read", scoped: true, pinnedHwnd: "4919", windowHwnd: "4919", candidateCount: 1, warnings: [] });
    });

    it("writes a row for a read that threw, saying what it had asked for", async () => {
      // Before item 14a this lane wrote its row only after a successful read, so a failing UIA read
      // left the same trace as a lane that was never called.
      const fetch = await uiaAnswering(async () => {
        throw new Error("COM failure");
      });
      await fetch({ windowTitle: "Dialog", hwnd: "4919" });
      expect(laneRows("uia")).toEqual([expect.objectContaining({
        outcome: "failed", windowTitle: "Dialog", scoped: true, pinnedHwnd: "4919", warnings: ["uia_provider_failed"],
      })]);
    });
  });

  describe("the road decides which lanes run, and says so", () => {
    async function composeWith(uia: () => Promise<unknown>) {
      vi.doMock("../../src/tools/desktop-providers/uia-provider.js", () => ({ fetchUiaCandidates: vi.fn(uia) }));
      vi.doMock("../../src/tools/desktop-providers/visual-provider.js", () => ({
        fetchVisualCandidates: vi.fn(async () => ({ candidates: [], warnings: [] })),
      }));
      vi.doMock("../../src/tools/desktop-providers/ocr-provider.js", () => ({
        fetchOcrCandidates: vi.fn(async () => ({ candidates: [], warnings: [] })),
      }));
      vi.doMock("../../src/tools/desktop-providers/browser-provider.js", () => ({ fetchBrowserCandidates: vi.fn() }));
      vi.doMock("../../src/tools/desktop-providers/terminal-provider.js", () => ({ fetchTerminalCandidates: vi.fn() }));
      vi.doMock("../../src/engine/uia-bridge.js", () => ({
        getUiElements: vi.fn().mockResolvedValue({ elements: [], elementCount: 0, windowRect: null }),
        detectUiaBlind: vi.fn().mockReturnValue({ blind: false }),
      }));
      return (await import("../../src/tools/desktop-providers/compose-providers.js")).composeCandidates;
    }

    it("records that OCR did not look because UIA could see the window", async () => {
      const compose = await composeWith(async () => ({ candidates: [], warnings: [] }));
      await compose({ windowTitle: "Outlook (PWA)" });
      expect(laneRows("ocr")).toEqual([expect.objectContaining({ outcome: "skipped", why: "uia_not_blind" })]);
    });

    it("records a lane that rejected instead of returning", async () => {
      // Every provider catches inside its own body; a rejection is the one road around that, and it
      // used to leave a warning and no row.
      const compose = await composeWith(async () => {
        throw new Error("rejected outside the provider's catch");
      });
      await compose({ windowTitle: "Outlook (PWA)" });
      expect(laneRows("uia")).toEqual([expect.objectContaining({
        outcome: "failed", why: "rejected", warnings: ["uia_provider_failed"],
      })]);
    });
  });
});

describe("a refusal says which rung made it (14c)", () => {
  const HWND = 4919n;
  const ORIGIN: WindowRect = { x: 100, y: 200, width: 600, height: 400 };
  const MOVED: WindowRect = { x: 100, y: 129, width: 600, height: 400 };
  const PARKED: WindowRect = { x: -32000, y: -32000, width: 600, height: 400 };
  const WIDER: WindowRect = { x: 100, y: 200, width: 900, height: 400 };
  const FAR: WindowRect = { x: 100, y: 600, width: 600, height: 400 };
  const aimed: Aim = { kind: "aim", title: "CELL BUTTONS", hwnd: HWND, origin: { kind: "measured", rect: ORIGIN } };
  const unstable: Aim = { kind: "aim", title: "CELL BUTTONS", hwnd: HWND, origin: { kind: "moved_during_read" } };
  const noOrigin: Aim = { kind: "aim", title: "CELL BUTTONS", hwnd: HWND };

  /** An OCR entity centred on (458, 215): inside ORIGIN, from a lane the correction trusts. */
  function entity(over: Partial<UiEntity> = {}): UiEntity {
    return {
      entityId: "e1", role: "text", label: "CELL BUTTONS", confidence: 0.9, sources: ["ocr"],
      affordances: [{ verb: "click", executors: ["mouse"], confidence: 0.9, preconditions: [], postconditions: [] }],
      generation: "gen-1", evidenceDigest: "d", rect: { x: 448, y: 210, width: 20, height: 10 },
      ...over,
    };
  }

  function deps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
    return {
      uiaClick: vi.fn(async () => {}), uiaSetValue: vi.fn(async () => {}),
      cdpClick: vi.fn(async () => {}), cdpFill: vi.fn(async () => {}),
      terminalSend: vi.fn(async () => {}), keyboardTypeBg: vi.fn(async () => {}),
      mouseClick: vi.fn(async () => {}),
      aimRect: vi.fn(async () => MOVED),
      ...over,
    };
  }

  const stranger = () => ({ kind: "other" as const, hwnd: 777n, title: "設定", via: "os_hit_test" as const });
  const fromTheDropdown = () => entity({ origin: { kind: "window", id: "CELL BUTTONS", hwnd: "888" } });

  /** What the envelope calls a refusal — asked of the real loop, not of a table kept in this file. */
  async function publishedReason(err: unknown): Promise<string | undefined> {
    const { GuardedTouchLoop } = await import("../../src/engine/world-graph/guarded-touch.js");
    const { LeaseStore } = await import("../../src/engine/world-graph/lease-store.js");
    const e = entity();
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "view-1");
    const loop = new GuardedTouchLoop(store, {
      resolveLiveEntities:      () => [e],
      currentGeneration:        () => "gen-1",
      isModalBlocking:          () => false,
      checkViewport:            () => null,
      execute:                  async () => { throw err; },
      resolvePostTouchEntities: async () => [],
    });
    const result = await loop.touch({ lease });
    return result.ok ? undefined : result.reason;
  }

  function refusals(): Row[] {
    return rows().filter((r) => r.route === "refusal");
  }

  const ladder: Array<{ rung: string; aim: Aim; entity: () => UiEntity; deps: () => ExecutorDeps }> = [
    {
      rung: "excluded_window", aim: aimed, entity: () => entity(),
      deps: () => deps({ pointOwner: () => ({ kind: "blocked" as const, why: "excluded_window" as const, via: "os_hit_test" as const }) }),
    },
    { rung: "window_off_desktop", aim: aimed, entity: () => entity(), deps: () => deps({ aimRect: vi.fn(async () => PARKED), pointOwner: stranger }) },
    { rung: "moved_during_read", aim: unstable, entity: () => entity(), deps: () => deps() },
    {
      rung: "owned_window_not_origin", aim: unstable, entity: fromTheDropdown,
      deps: () => deps({ pointOwner: () => ({ kind: "owned" as const, hwnd: 999n, title: "Recent files", via: "os_hit_test" as const }) }),
    },
    { rung: "window_resized", aim: aimed, entity: () => entity(), deps: () => deps({ aimRect: vi.fn(async () => WIDER) }) },
    { rung: "occluded", aim: aimed, entity: () => entity(), deps: () => deps({ pointOwner: stranger }) },
    { rung: "point_outside_window", aim: noOrigin, entity: () => entity(), deps: () => deps({ aimRect: vi.fn(async () => FAR) }) },
  ];

  for (const c of ladder) {
    it(`names the rung when ${c.rung} refuses, in the reason the envelope uses`, async () => {
      const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
      const d = c.deps();
      const thrown = await createDesktopExecutor(c.aim, d)(c.entity(), "click").then(() => undefined, (e: unknown) => e);
      expect(thrown, "the rung has to refuse for this cell to say anything").toBeInstanceOf(Error);
      expect(d.mouseClick).not.toHaveBeenCalled();

      expect(refusals()).toEqual([expect.objectContaining({ rung: c.rung, coordHwnd: String(HWND) })]);
      // Not a second table of reasons: the loop that builds the envelope is asked what it calls
      // this error, and the row has to agree with it.
      expect(refusals()[0]!.refused).toBe(await publishedReason(thrown));
    });
  }

  it("writes no refusal row for a press that went through", async () => {
    // The pair that makes the cells above mean something: the same ladder, one press allowed.
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
    const d = deps();
    await createDesktopExecutor(aimed, d)(entity(), "click");
    expect(d.mouseClick).toHaveBeenCalledWith(458, 144);
    expect(refusals()).toEqual([]);
  });

  describe("on the UIA route", () => {
    const aim: Aim = { kind: "aim", title: "Untitled - Notepad", hwnd: HWND };
    const uiaEntity = (): UiEntity => ({
      entityId: "u1", role: "button", label: "Save", confidence: 0.9, sources: ["uia"],
      locator: { uia: { name: "Save" } },
      affordances: [{ verb: "invoke", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
      generation: "gen-1", evidenceDigest: "d", rect: { x: 1, y: 2, width: 3, height: 4 },
    });
    /** What a PowerShell rejection carries: the whole command line. It may not reach a record. */
    const SCRIPT = "Command failed: powershell -NoProfile -Command SECRET-SCRIPT-BODY";

    const clickCases: Array<{ name: string; make: () => Promise<Error>; refused: string }> = [
      { name: "a route that failed", make: async () => new Error(SCRIPT), refused: "aim_route_failed" },
      {
        name: "a window that has gone", refused: "aim_window_gone",
        make: async () => new (await import("../../src/engine/aim.js")).AimedWindowGoneError(HWND, "gone"),
      },
      {
        name: "an excluded window", refused: "window_excluded",
        make: async () => new (await import("../../src/engine/tool-exclusion.js")).WindowExcludedError("excluded"),
      },
    ];

    for (const c of clickCases) {
      it(`records ${c.name} on the click route, without the backend's words`, async () => {
        const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
        const err = await c.make();
        const d = deps({ uiaClick: vi.fn(async () => { throw err; }) });
        const thrown = await createDesktopExecutor(aim, d)(uiaEntity(), "click").then(() => undefined, (e: unknown) => e);
        expect(thrown).toBeInstanceOf(Error);
        expect(d.mouseClick).not.toHaveBeenCalled();
        expect(refusals()).toEqual([expect.objectContaining({ rung: "uia_click", refused: c.refused, aimHwnd: String(HWND) })]);
        expect(refusals()[0]!.refused).toBe(await publishedReason(thrown));
        expect(readFileSync(logPath, "utf8")).not.toContain("SECRET-SCRIPT-BODY");
      });
    }

    it("records a write whose two rungs were both spent, without the text being typed", async () => {
      const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
      const d = deps({
        uiaSetValue: vi.fn(async () => { throw new Error(`${SCRIPT} -Value PROBE-TYPED-TEXT`); }),
        keyboardTypeBg: vi.fn(async () => { throw new Error("background write refused"); }),
      });
      const thrown = await createDesktopExecutor(aim, d)(uiaEntity(), "type", "PROBE-TYPED-TEXT").then(() => undefined, (e: unknown) => e);
      expect(thrown).toBeInstanceOf(Error);
      expect(refusals()).toEqual([expect.objectContaining({ rung: "uia_set_value_then_keyboard", refused: "aim_route_failed" })]);
      expect(refusals()[0]!.refused).toBe(await publishedReason(thrown));
      const record = readFileSync(logPath, "utf8");
      expect(record).not.toContain("SECRET-SCRIPT-BODY");
      expect(record).not.toContain("PROBE-TYPED-TEXT");
    });
  });

  it("records a terminal whose window has gone, on the terminal route", async () => {
    // Gate 2 on #621: `terminalSend`'s lookup throws a typed refusal for a destroyed handle, and it
    // left the executor with no row — `act.aim`, then nothing.
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
    const { AimedWindowGoneError } = await import("../../src/engine/aim.js");
    const terminal: UiEntity = {
      entityId: "t1", role: "textbox", label: "PS C:\\>", confidence: 1, sources: ["terminal"],
      locator: { terminal: { windowTitle: "Windows PowerShell" } },
      affordances: [{ verb: "type", executors: ["terminal"], confidence: 1, preconditions: [], postconditions: [] }],
      generation: "gen-1", evidenceDigest: "d", rect: { x: 1, y: 2, width: 3, height: 4 },
    };
    const d = deps({ terminalSend: vi.fn(async () => { throw new AimedWindowGoneError(HWND); }) });
    const aim: Aim = { kind: "aim", title: "Windows PowerShell", hwnd: HWND };
    const thrown = await createDesktopExecutor(aim, d)(terminal, "type", "dir").then(() => undefined, (e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(refusals()).toEqual([expect.objectContaining({ rung: "terminal_send", refused: "aim_window_gone", aimHwnd: String(HWND) })]);
    expect(refusals()[0]!.refused).toBe(await publishedReason(thrown));
  });

  it("marks the identity row that refused, and leaves the one that let the act through unmarked", async () => {
    const identity: WindowIdentity = {
      hwnd: HWND, pid: 1234, processName: "notepad.exe", processStartTimeMs: 111,
      className: "Notepad", titleFingerprint: "Untitled - Notepad",
    };
    const aim: Aim = { kind: "aim", title: "Untitled - Notepad", hwnd: HWND, identity };
    const uiaEntity: UiEntity = {
      entityId: "u1", role: "button", label: "Save", confidence: 0.9, sources: ["uia"],
      locator: { uia: { name: "Save" } },
      affordances: [{ verb: "invoke", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
      generation: "gen-1", evidenceDigest: "d", rect: { x: 1, y: 2, width: 3, height: 4 },
    };

    const same = await import("../../src/tools/desktop-executor.js");
    await same.createDesktopExecutor(aim, deps({ aimIdentity: vi.fn(async () => identity) }))(uiaEntity, "click");

    vi.resetModules();
    const replaced = await import("../../src/tools/desktop-executor.js");
    const d = deps({ aimIdentity: vi.fn(async () => ({ ...identity, className: "#32770", titleFingerprint: "Save As" })) });
    const thrown = await replaced.createDesktopExecutor(aim, d)(uiaEntity, "click").then(() => undefined, (e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);

    const identityRows = rows().filter((r) => r.seam === "act.identity");
    expect(identityRows.map((r) => [r.verdict === "changed", r.refused])).toEqual([[false, null], [true, "aim_identity_changed"]]);
    expect(identityRows[1]!.refused).toBe(await publishedReason(thrown));
  });
});
