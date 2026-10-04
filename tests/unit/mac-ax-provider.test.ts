import { describe, it, expect, vi } from "vitest";
import {
  roleOf, actionabilityOf, isCandidate, toCandidate, readMacAxCandidates,
  type MacAxProviderDeps, type MacAxReadNotes,
} from "../../src/tools/mac/ax-provider.js";
import type { NativeMacAxElement } from "../../src/engine/native-types.js";
import { resolveCandidates } from "../../src/engine/world-graph/resolver.js";

const el = (over: Partial<NativeMacAxElement> = {}): NativeMacAxElement => ({
  id: "a.0.1",
  rootKey: "Doc\u001f\u001f0,0,10,10",
  elementKey: "k",
  depth: 1,
  role: "AXButton",
  actions: [],
  valueSettable: false,
  childCount: 0,
  ...over,
});

describe("roleOf", () => {
  it.each([
    ["AXButton", "button"], ["AXCheckBox", "button"], ["AXTextField", "textbox"],
    ["AXTextArea", "textbox"], ["AXLink", "link"], ["AXMenuItem", "menuitem"],
    ["AXStaticText", "label"], ["AXGroup", "unknown"],
  ])("%s -> %s", (role, expected) => {
    expect(roleOf({ role })).toBe(expected);
  });
});

describe("actionabilityOf", () => {
  it("press on a button", () => {
    expect(actionabilityOf(el({ actions: ["AXPress"] }))).toEqual(["click", "invoke"]);
  });
  it("settable text field types", () => {
    expect(actionabilityOf(el({ role: "AXTextField", valueSettable: true }))).toEqual(["type"]);
  });
  it("secure text field offers nothing", () => {
    expect(actionabilityOf(el({ role: "AXTextField", subrole: "AXSecureTextField", valueSettable: true }))).toEqual([]);
  });
  it("static text is read", () => {
    expect(actionabilityOf(el({ role: "AXStaticText" }))).toEqual(["read"]);
  });
  it("group with no actions", () => {
    expect(actionabilityOf(el({ role: "AXGroup" }))).toEqual([]);
  });
});

describe("isCandidate", () => {
  it("disabled button is not", () => {
    expect(isCandidate(el({ enabled: false, actions: ["AXPress"] }))).toBe(false);
  });
  it("static text with a value is", () => {
    expect(isCandidate(el({ role: "AXStaticText", value: "56" }))).toBe(true);
  });
  it("static text with no name is not", () => {
    expect(isCandidate(el({ role: "AXStaticText" }))).toBe(false);
  });
  it("group with no actions is not", () => {
    expect(isCandidate(el({ role: "AXGroup" }))).toBe(false);
  });
});

describe("toCandidate", () => {
  it("names a label by its value and carries no value key", () => {
    const c = toCandidate(el({ role: "AXStaticText", value: "56", description: "最後の式" }), 7, "Win", 1000);
    expect(c.label).toBe("56");
    expect(c.role).toBe("label");
    expect("value" in c).toBe(false);
  });
  it("button candidate", () => {
    const c = toCandidate(el({ title: "7", actions: ["AXPress"] }), 7, "Win", 1000);
    expect(c.label).toBe("7");
    expect(c.source).toBe("ax");
    expect(c.target).toEqual({ kind: "window", id: "Win" });
    expect(c.observedAtMs).toBe(1000);
    expect(c.status).toBe("observed");
    expect(c.locator).toEqual({
      ax: { pid: 7, id: "a.0.1", role: "AXButton", rootKey: "Doc\u001f\u001f0,0,10,10", elementKey: "k" },
    });
  });
  it("never leaks a secure field's value", () => {
    const c = toCandidate(el({ role: "AXTextField", subrole: "AXSecureTextField", value: "hunter2" }), 7, "Win", 1000);
    expect(JSON.stringify(c)).not.toContain("hunter2");
  });
  it("keeps a plain text field's value", () => {
    const c = toCandidate(el({ role: "AXTextField", value: "hello" }), 7, "Win", 1000);
    expect(c.value).toBe("hello");
  });
});

describe("readMacAxCandidates", () => {
  const tree = (over: object = {}) => ({
    pid: 7, appTitle: "App",
    elements: [
      el({ id: "a.0.1", rootKey: "My Doc\u001f\u001f0,0,1,1", actions: ["AXPress"], title: "OK" }),
      el({ id: "a.1.1", rootKey: "Other\u001f\u001f0,0,1,1", actions: ["AXPress"], title: "Cancel" }),
    ],
    truncated: false, selfReference: false, displayAsleep: false, elapsedMs: 1,
    ...over,
  });
  const mk = () => ({
    listWindows: vi.fn(),
    getFocus: vi.fn(),
    axTree: vi.fn(),
    now: vi.fn(() => 1000),
  });
  const run = (deps: ReturnType<typeof mk>, target?: { windowTitle?: string }) => {
    const notes: MacAxReadNotes = { warnings: [] };
    return readMacAxCandidates(deps as unknown as MacAxProviderDeps, target, notes).then((r) => ({ r, notes }));
  };

  it("filters to the window the title names", async () => {
    const d = mk();
    d.listWindows.mockReturnValue([{ windowId: 1, pid: 7, layer: 0, onScreen: true, title: "My Doc" }]);
    d.axTree.mockResolvedValue(tree());
    const { r, notes } = await run(d, { windowTitle: "doc" });
    expect(r).toHaveLength(1);
    expect(r[0].label).toBe("OK");
    expect(d.axTree).toHaveBeenCalledWith({ pid: 7 });
    expect(notes.pid).toBe(7);
    expect(notes.appTitle).toBe("App");
    expect(notes.warnings).toEqual([]);
  });
  it("warns when no window matches", async () => {
    const d = mk();
    d.listWindows.mockReturnValue([{ windowId: 1, pid: 7, layer: 0, onScreen: true, title: "Something else" }]);
    const { r, notes } = await run(d, { windowTitle: "nothing" });
    expect(r).toEqual([]);
    expect(notes.warnings).toEqual(["no_window_matches_title"]);
    expect(d.axTree).not.toHaveBeenCalled();
  });
  // Gate 2 (#780): without Screen Recording every CGWindowList title is empty — say so, not "no match".
  it("says titles are unavailable when no window has a title", async () => {
    const d = mk();
    d.listWindows.mockReturnValue([{ windowId: 1, pid: 7, layer: 0, onScreen: true }, { windowId: 2, pid: 8, layer: 0, onScreen: true, title: "" }]);
    const { r, notes } = await run(d, { windowTitle: "doc" });
    expect(r).toEqual([]);
    expect(notes.warnings).toEqual(["window_titles_unavailable"]);
  });
  it("warns when there is no frontmost app", async () => {
    const d = mk();
    d.getFocus.mockResolvedValue({});
    const { r, notes } = await run(d);
    expect(r).toEqual([]);
    expect(notes.warnings).toEqual(["no_frontmost_app"]);
  });
  it("reports every warning and keeps both elements without a title", async () => {
    const d = mk();
    d.getFocus.mockResolvedValue({ pid: 7 });
    d.axTree.mockResolvedValue(tree({
      displayAsleep: true, selfReference: true, truncated: true, stoppedBy: "max_ms", error: "cannot_complete",
    }));
    const { r, notes } = await run(d);
    expect(notes.warnings).toEqual(["ax_error:cannot_complete", "display_asleep", "ax_self_reference", "truncated:max_ms"]);
    expect(r).toHaveLength(2);
  });
});

describe("AX identity and the pinned app (codex gate 1, #780)", () => {
  const e = (over: Record<string, unknown>): any => ({
    id: "a.0.1", rootKey: "R", elementKey: "K", depth: 1, role: "AXButton", actions: ["AXPress"],
    valueSettable: false, childCount: 0, title: "Same", ...over,
  });

  it("keeps two AX elements with the same label and no frame apart", () => {
    const a = toCandidate(e({ id: "a.0.1" }), 7, "W", 1);
    const b = toCandidate(e({ id: "a.0.2" }), 7, "W", 1);
    expect(a.digest).toBeDefined();
    expect(a.digest).not.toBe(b.digest);
    const resolved = resolveCandidates([a, b], "g");
    expect(resolved.length).toBe(2);
  });

  it("does not change identity when only the value changes", () => {
    expect(toCandidate(e({ value: "x" }), 7, "W", 1).digest).toBe(toCandidate(e({ value: "y" }), 7, "W", 1).digest);
  });

  it("reads the pinned app without asking which is frontmost", async () => {
    const getFocus = vi.fn(async () => ({ pid: 99 }));
    const axTree = vi.fn(async () => ({ pid: 7, elements: [], truncated: false, selfReference: false, displayAsleep: false, elapsedMs: 1 }));
    const notes = { warnings: [] as string[] };
    await readMacAxCandidates({ listWindows: vi.fn(() => []), getFocus, axTree, now: () => 1 } as any, undefined, notes, 7);
    expect(getFocus).not.toHaveBeenCalled();
    expect(axTree).toHaveBeenCalledWith({ pid: 7 });
  });
});

describe("a text's identity follows what it shows (codex, #780)", () => {
  const t = (value: string): any => ({ id: "a.0.3", rootKey: "R", elementKey: "K", depth: 2, role: "AXStaticText", actions: [], valueSettable: false, childCount: 0, value });
  it("changes when the visible text changes", () => {
    expect(toCandidate(t("7"), 7, "W", 1).digest).not.toBe(toCandidate(t("56"), 7, "W", 1).digest);
  });
});

describe("title-bar buttons are named (2026-10-04)", () => {
  it("names the close button instead of leaving it nameless", () => {
    const close: any = { id: "a.0.5", rootKey: "R", elementKey: "K", depth: 1, role: "AXButton", subrole: "AXCloseButton", actions: ["AXPress"], valueSettable: false, childCount: 0 };
    expect(toCandidate(close, 7, "W", 1).label).toBe("Close window");
  });
});

describe("sheet warnings (2026-10-04)", () => {
  it("says a sheet whose controls live in another process is open", async () => {
    const sheet: any = { id: "a.0.7", rootKey: "R", elementKey: "K", depth: 1, role: "AXSheet", actions: [], valueSettable: false, childCount: 1 };
    const notes = { warnings: [] as string[] };
    await readMacAxCandidates({ listWindows: vi.fn(() => []), getFocus: vi.fn(async () => ({ pid: 7 })),
      axTree: vi.fn(async () => ({ pid: 7, elements: [sheet], truncated: false, selfReference: false, displayAsleep: false, elapsedMs: 1 })), now: () => 1 } as any, undefined, notes);
    expect(notes.warnings).toEqual(["sheet_open_in_other_process"]);
  });
});
