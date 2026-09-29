/**
 * internal #211 (C) — a `Window` element's `IsModal` travels from the read to the entity's locator:
 * the native road's `isModal` (Rust `None` arrives as null and is left out), the PowerShell road's
 * own read of the pattern, and the UIA lane's candidate.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../../index.js");
  vi.doUnmock("node:child_process");
  vi.doUnmock("../../src/engine/uia-bridge.js");
  vi.unstubAllEnvs();
  vi.resetModules();
});

const el = (name: string, controlType: string, isModal: boolean | null | undefined) => ({
  name, controlType, automationId: "", className: "", isEnabled: true,
  boundingRect: { x: 0, y: 0, width: 10, height: 10 }, patterns: [], depth: 1,
  ...(isModal !== undefined && { isModal }),
});

async function nativeBridge(elements: unknown[]) {
  vi.resetModules();
  vi.doMock("node:child_process", () => ({ execFile: () => { throw new Error("no PowerShell here"); } }));
  vi.doMock("../../index.js", () => ({
    default: {
      computeChangeFraction: () => 0, dhashFromRaw: () => 0n, hammingDistance: () => 0, win32EnumTopLevelWindows: () => [],
      uiaGetElements: async () => ({ windowTitle: "T", elementCount: elements.length, elements }),
      uiaGetElementChildren: async () => elements,
    },
  }));
  return import("../../src/engine/uia-bridge.js");
}

describe("the native road", () => {
  it("carries IsModal true and false, and leaves out a window that did not answer", async () => {
    const { getUiElements } = await nativeBridge([el("Save As", "Window", true), el("Replace", "Window", false), el("TitleBar", "Window", null), el("OK", "Button", null)]);
    const r = await getUiElements("T", 4, 80, 4000);
    expect(r.elements.map((e) => [e.name, "isModal" in e ? e.isModal : "absent"])).toEqual([
      ["Save As", true], ["Replace", false], ["TitleBar", "absent"], ["OK", "absent"],
    ]);
  });

  it("leaves it out on an addon older than the field", async () => {
    const { getUiElements } = await nativeBridge([el("Save As", "Window", undefined)]);
    expect("isModal" in (await getUiElements("T", 4, 80, 4000)).elements[0]).toBe(false);
  });

  it("carries it on the children read too", async () => {
    const { getElementChildren } = await nativeBridge([el("Save As", "Window", true), el("TitleBar", "Window", null)]);
    const kids = await getElementChildren("T", undefined, undefined, undefined, 1, 10, 1000);
    expect(kids.map((k) => ("isModal" in k ? k.isModal : "absent"))).toEqual([true, "absent"]);
  });
});

describe("the PowerShell road", () => {
  it("reads a Window's IsModal from its WindowPattern and writes it only when it answered", async () => {
    vi.resetModules();
    const scripts: string[] = [];
    vi.doMock("node:child_process", () => ({
      execFile: (_f: string, args: string[], _o: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
        scripts.push(args[args.length - 1]);
        cb(null, { stdout: JSON.stringify({ windowTitle: "T", elementCount: 1, elements: [el("Save As", "Window", true)], truncated: false }), stderr: "" });
      },
    }));
    vi.doMock("../../index.js", () => ({ default: { computeChangeFraction: () => 0, dhashFromRaw: () => 0n, hammingDistance: () => 0, win32EnumTopLevelWindows: () => [] } }));
    vi.stubEnv("DESKTOP_TOUCH_DISABLE_NATIVE_UIA", "1");
    const { getUiElements } = await import("../../src/engine/uia-bridge.js");
    const r = await getUiElements("T", 4, 80, 4000);
    expect(scripts[0]).toContain("if ($ctName -eq 'Window') {");
    expect(scripts[0]).toContain("[System.Windows.Automation.WindowPattern]::Pattern).Current.IsModal");
    expect(scripts[0]).toContain("if ($null -ne $elModal) { $elObj['isModal'] = $elModal }");
    expect(r.elements[0].isModal).toBe(true);
  });
});

describe("the PowerShell road of the children read", () => {
  it("reads a Window child's IsModal too (gate 2)", async () => {
    vi.resetModules();
    const scripts: string[] = [];
    vi.doMock("node:child_process", () => ({
      execFile: (_f: string, args: string[], _o: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
        scripts.push(args[args.length - 1]);
        cb(null, { stdout: JSON.stringify({ elementCount: 1, elements: [el("Save As", "Window", true)] }), stderr: "" });
      },
    }));
    vi.doMock("../../index.js", () => ({ default: { computeChangeFraction: () => 0, dhashFromRaw: () => 0n, hammingDistance: () => 0, win32EnumTopLevelWindows: () => [] } }));
    vi.stubEnv("DESKTOP_TOUCH_DISABLE_NATIVE_UIA", "1");
    const { getElementChildren } = await import("../../src/engine/uia-bridge.js");
    await getElementChildren("T", "Dialogs", undefined, undefined, 1, 10, 1000).catch(() => undefined);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("if ($item['controlType'] -eq 'Window') {");
    expect(scripts[0]).toContain("$item['isModal'] = [bool]$el.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Current.IsModal");
  });
});

describe("the UIA lane", () => {
  async function candidates(elements: unknown[]) {
    vi.resetModules();
    vi.doMock("../../src/engine/uia-bridge.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/engine/uia-bridge.js")>()),
      getUiElements: vi.fn(async () => ({ windowTitle: "Notepad", windowRect: { x: 0, y: 0, width: 900, height: 600 }, elementCount: elements.length, elements, via: "native" })),
    }));
    const { fetchUiaCandidates } = await import("../../src/tools/desktop-providers/uia-provider.js");
    return (await fetchUiaCandidates({ windowTitle: "Notepad" })).candidates;
  }

  it("puts a Window's IsModal on its locator, and nothing when the read did not say", async () => {
    const out = await candidates([el("置換", "Window", false), el("名前を付けて保存", "Window", true), el("TitleBar", "Window", undefined)]);
    expect(out.map((c) => [c.label, c.locator?.uia && "isModal" in c.locator.uia ? c.locator.uia.isModal : "absent"])).toEqual([
      ["置換", false], ["名前を付けて保存", true], ["TitleBar", "absent"],
    ]);
  });
});
