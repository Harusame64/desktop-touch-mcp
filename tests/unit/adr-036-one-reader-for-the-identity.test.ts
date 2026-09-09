/**
 * Three places read the same identity, and they had already stopped agreeing.
 *
 * ADR-036. The baseline the act-time guard compares against is taken in three places — the ingress
 * (`compose-providers.ts`), the fallback for results that carried none (`desktop.ts::_aimFor`), and
 * the act-side re-read (the executor's `aimIdentity` dep). They were three copies of the same
 * fifteen lines, and gate 2 found the drift: two of them filed `target.windowTitle` — the caller's
 * SEARCH STRING — as `titleFingerprint`, while the third filed the live `GetWindowTextW`. Nothing
 * consumes that field yet, so nothing was refused wrongly; the first rule that compares the two
 * sides would have refused every act.
 *
 * So the policy moved into one function and the three sites pass their reads to it. These cells
 * hold that: the policy itself, and each site actually going through it.
 *
 * The other half is legibility. A refusal that cannot say what it refused about is a bug report
 * against the comparator: the message told one story ("a different process") while the new
 * class check fires INSIDE one process, printing `notepad.exe (pid 1234)` on both sides.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readWindowIdentityFields,
  AimIdentityChangedError,
  type Aim,
  type WindowIdentity,
} from "../../src/engine/aim.js";
import type { ExecutorDeps } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

const HWND = 4919n;

/** The live window: a title that is NOT the string a caller would search for. */
vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    getWindowIdentity: vi.fn(() => ({ pid: 1234, processName: "notepad.exe", processStartTimeMs: 111 })),
    getWindowClassName: vi.fn(() => "Notepad"),
    getWindowTitleW: vi.fn(() => "Untitled - Notepad"),
  };
});

describe("one policy for what an identity read records", () => {
  const reads = {
    identity: () => ({ pid: 1234, processName: "notepad.exe", processStartTimeMs: 111 }),
    className: () => "Notepad",
    title: () => "Untitled - Notepad",
  };

  it("fills every field the comparator can use", () => {
    expect(readWindowIdentityFields(HWND, reads)).toEqual({
      hwnd: HWND,
      pid: 1234,
      processName: "notepad.exe",
      processStartTimeMs: 111,
      className: "Notepad",
      titleFingerprint: "Untitled - Notepad",
    });
  });

  it("answers nothing at all when it could not ask", () => {
    // A zeroed pid is `getWindowIdentity` saying "no such window" AND "this build cannot ask", and
    // both have to arrive as absence rather than as a value that compares unequal to everything.
    expect(readWindowIdentityFields(HWND, { ...reads, identity: () => ({ pid: 0, processName: "", processStartTimeMs: 0 }) })).toBeUndefined();
    expect(readWindowIdentityFields(HWND, { ...reads, identity: () => undefined })).toBeUndefined();
    expect(readWindowIdentityFields(HWND, { ...reads, identity: () => { throw new Error("no binding"); } })).toBeUndefined();
  });

  it("lets a secondary read fail without costing the whole identity", () => {
    // The class and the title are extra discriminators, not the identity. A build that cannot read
    // them still knows which PROCESS owns the handle, and dropping that would turn a partial
    // answer into no answer — the same mistake as reading a null rectangle as a gone window.
    const partial = readWindowIdentityFields(HWND, {
      ...reads,
      className: () => { throw new Error("nope"); },
      title: () => { throw new Error("nope"); },
    });
    expect(partial).toMatchObject({ pid: 1234, className: undefined, titleFingerprint: undefined });
  });

  it("reads an empty string as 'could not read it', not as a value", () => {
    // `getWindowClassName` returns "" for a dead handle and for a failed call. Storing "" would
    // later compare unequal to a real class and refuse an act on evidence nobody has.
    const blank = readWindowIdentityFields(HWND, { ...reads, className: () => "", title: () => "" });
    expect(blank).toMatchObject({ className: undefined, titleFingerprint: undefined });
  });
});

describe("each site records through that policy", () => {
  it("the ingress files the window's own title, not the caller's query", async () => {
    const { readIdentityForTarget } = await import("../../src/tools/desktop-providers/compose-providers.js");
    const id = readIdentityForTarget({ hwnd: "4919", windowTitle: "Notepad" });
    // "Notepad" is what the caller typed; "Untitled - Notepad" is the window.
    expect(id?.titleFingerprint).toBe("Untitled - Notepad");
    expect(id?.className).toBe("Notepad");
  });

  it("the fallback files the same thing", async () => {
    const { DesktopFacade } = await import("../../src/tools/desktop.js");
    const facade = new DesktopFacade(async () => []);
    const aim: Aim = await (facade as unknown as { _aimFor(t: unknown): Promise<Aim> })
      ._aimFor({ hwnd: "4919", windowTitle: "Notepad" });
    expect(aim.identity?.titleFingerprint).toBe("Untitled - Notepad");
    expect(aim.identity?.className).toBe("Notepad");
  });
});

describe("the refusal says which field decided it", () => {
  const then: WindowIdentity = {
    hwnd: HWND, pid: 1234, processName: "notepad.exe", processStartTimeMs: 111,
    className: "Notepad", titleFingerprint: "Untitled - Notepad",
  };

  it("names the class when the same program replaced its own window", () => {
    const msg = new AimIdentityChangedError(HWND, then, { ...then, className: "#32770" }).message;
    // The old sentence, printed about this case, contradicted its own numbers.
    expect(msg).not.toMatch(/different process/);
    // A SENTENCE naming the class, not the two identities dumped whole: the fallback branch below
    // prints both sides as JSON, which contains every class string too and would pass a looser
    // assertion while saying nothing (found by mutating the branch away).
    expect(msg).toMatch(/its class was "Notepad" when the lease was taken and is "#32770" now/);
    expect(msg).not.toMatch(/does not name yet/);
  });

  it("names the process when the handle left the program", () => {
    const msg = new AimIdentityChangedError(HWND, then, { ...then, pid: 9999, processName: "chrome.exe" }).message;
    expect(msg).toMatch(/it belonged to notepad\.exe \(pid 1234\) and now belongs to chrome\.exe \(pid 9999\)/);
    expect(msg).not.toMatch(/does not name yet/);
  });

  it("says 'restarted' for a reused pid, which is neither of the other two", () => {
    const msg = new AimIdentityChangedError(HWND, then, { ...then, processStartTimeMs: 222 }).message;
    expect(msg).toMatch(/notepad\.exe \(pid 1234\) was restarted — same pid, a later process wearing it/);
    expect(msg).not.toMatch(/does not name yet/);
  });
});

describe("the probe row can explain the verdict it records", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "act-identity-"));
    logPath = join(dir, "aim-probe.jsonl");
  });
  afterEach(() => {
    delete process.env.DESKTOP_TOUCH_AIM_PROBE;
    delete process.env.DESKTOP_TOUCH_AIM_PROBE_PATH;
    rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("carries every field the comparator reads, on both sides", async () => {
    // A `changed` decided by the class used to land as a row whose two sides were byte-identical:
    // the one instrument that exists for this refusal could not tell it from a broken comparator.
    process.env.DESKTOP_TOUCH_AIM_PROBE = "1";
    process.env.DESKTOP_TOUCH_AIM_PROBE_PATH = logPath;
    vi.resetModules();
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");

    const identity: WindowIdentity = {
      hwnd: HWND, pid: 1234, processName: "notepad.exe", processStartTimeMs: 111,
      className: "Notepad", titleFingerprint: "Untitled - Notepad",
    };
    const deps: ExecutorDeps = {
      uiaClick: vi.fn(async () => {}), uiaSetValue: vi.fn(async () => {}),
      cdpClick: vi.fn(async () => {}), cdpFill: vi.fn(async () => {}),
      terminalSend: vi.fn(async () => {}), keyboardTypeBg: vi.fn(async () => {}),
      mouseClick: vi.fn(async () => {}),
      aimIdentity: vi.fn(async () => ({ ...identity, className: "#32770", titleFingerprint: "Save As" })),
    };
    const entity: UiEntity = {
      entityId: "e1", role: "button", label: "Save", confidence: 0.9, sources: ["uia"],
      affordances: [{ verb: "invoke", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
      generation: "gen-1", evidenceDigest: "d", rect: { x: 1, y: 2, width: 3, height: 4 },
    };

    const exec = createDesktopExecutor({ kind: "aim", title: "Untitled - Notepad", hwnd: HWND, identity }, deps);
    await expect(exec(entity, "click")).rejects.toThrow(/class/);

    const row = readFileSync(logPath, "utf8").trim().split("\n")
      .map((l) => JSON.parse(l)).find((r) => r.seam === "act.identity");
    expect(row.verdict).toBe("changed");
    expect(row.then.className).toBe("Notepad");
    expect(row.now.className).toBe("#32770");
    // Recorded, never decisive — and a reader has to be able to see that it did not decide.
    expect(row.then.titleFingerprint).toBe("Untitled - Notepad");
    expect(row.now.titleFingerprint).toBe("Save As");
  });
});
