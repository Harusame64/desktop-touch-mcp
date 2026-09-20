/**
 * ADR-031 §2(d) — `scope_element`'s capture region.
 *
 * The padding around the element used to be clamped with `Math.max(0, …)` on
 * both axes, which assumes the desktop starts at (0, 0). On a monitor placed
 * left of the primary one that assumption pulls the capture onto the primary
 * monitor and returns a picture of somewhere else as if it were the element —
 * the same class of failure the ADR is about.
 *
 * The replacement keeps two behaviours apart, and this pins both:
 *   - element inside the capturable area → trim the padding overhang only;
 *   - element outside it → change nothing, let the capture be refused, and
 *     continue with text alone. A degraded answer that says less is better
 *     than a confident answer about the wrong pixels.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  state: { nativeCapture: true },
  monitors: [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: -1920, y: 0, width: 1920, height: 1080 },
  ],
  captured: [] as { x: number; y: number; width: number; height: number }[],
}));

// Partial: `uia-bridge` reaches for other exports of this module, and the
// only thing this test needs to steer is the capture capability.
vi.mock("../../src/engine/native-engine.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/native-engine.js")>(
    "../../src/engine/native-engine.js",
  );
  return { ...actual, hasNativeCaptureRegion: () => hoisted.state.nativeCapture };
});
vi.mock("../../src/engine/win32.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/win32.js")>(
    "../../src/engine/win32.js",
  );
  return {
    ...actual,
    enumMonitors: () => hoisted.monitors.map((bounds, i) => ({ primary: i === 0, bounds })),
    getPrimaryMonitorBounds: () => hoisted.monitors[0],
  };
});
vi.mock("../../src/engine/diagnostic-log.js", () => ({ logDiagnostic: () => undefined }));

// Pre-emptive, not currently reached: `resolveCaptureRegionAsync` consults the
// nut.js backend for a primary screen size when monitor enumeration yields
// nothing. The win32 mock below still returns bounds, so that path is dormant
// — but if it ever stops doing so, the real nut.js module would load its
// native backend inside a unit test. One line keeps that from happening
// silently.
vi.mock("../../src/engine/nutjs.js", () => ({
  getPrimaryScreenSize: async () => null,
}));

// The capture itself is the choke point's job and is pinned by its own tests;
// here it only has to record what it was asked for and refuse what the real
// one would refuse.
vi.mock("../../src/engine/image.js", () => ({
  captureScreen: async (region: { x: number; y: number; width: number; height: number }) => {
    hoisted.captured.push(region);
    const bounds = hoisted.state.nativeCapture
      ? { x: -1920, y: 0, width: 3840, height: 1080 }
      : hoisted.monitors[0]!;
    const inside =
      region.x >= bounds.x &&
      region.y >= bounds.y &&
      region.x + region.width <= bounds.x + bounds.width &&
      region.y + region.height <= bounds.y + bounds.height;
    if (!inside) throw new Error("RegionOutsideCapturableBounds: refused by the choke point");
    return { base64: "ZmFrZQ==", width: region.width, height: region.height, mimeType: "image/png" as const };
  },
}));

vi.mock("../../src/engine/uia-bridge.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/uia-bridge.js")>(
    "../../src/engine/uia-bridge.js",
  );
  return {
    ...actual,
    getUiElements: vi.fn(),
    clickElement: vi.fn(),
    setElementValue: vi.fn(),
    insertTextViaTextPattern2: vi.fn(),
    getElementBounds: vi.fn(),
    getElementChildren: vi.fn().mockResolvedValue(null),
  };
});
vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: vi.fn().mockResolvedValue({ title: "TestApp", warnings: [] }),
}));
vi.mock("../../src/engine/perception/registry.js", () => ({
  evaluatePreToolGuards: vi.fn(),
  buildEnvelopeFor: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../src/tools/_action-guard.js", () => ({
  isAutoGuardEnabled: vi.fn().mockReturnValue(false),
  runActionGuard: vi.fn(),
  validateAndPrepareFix: vi.fn(),
  consumeFix: vi.fn(),
}));
vi.mock("../../src/engine/identity-tracker.js", () => ({
  buildHintsForTitle: vi.fn().mockReturnValue(null),
  observeTarget: vi.fn(),
  toTargetHints: vi.fn().mockReturnValue({}),
  buildCacheStateHints: vi.fn().mockReturnValue({}),
}));

import { scopeElementHandler } from "../../src/tools/ui-elements.js";
import { getElementBounds } from "../../src/engine/uia-bridge.js";
import { _resetCaptureBackendForTests } from "../../src/engine/reachable-bounds.js";

const ARGS = {
  windowTitle: "TestApp",
  name: "Save",
  automationId: undefined,
  controlType: undefined,
  hwnd: undefined,
  maxDepth: 3,
  maxElements: 20,
  padding: 20,
};

/** A read that answered nothing, with the reason the refusal is supposed to be built from. */
const scopeMissing = async (why: string, via = "powershell") => {
  vi.mocked(getElementBounds).mockResolvedValue({ found: null, why, via } as Awaited<ReturnType<typeof getElementBounds>>);
  const result = await scopeElementHandler(ARGS);
  const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as { code?: string; error?: string; suggest?: string[]; context?: Record<string, unknown> };
};

const scopeWith = async (boundingRect: { x: number; y: number; width: number; height: number }) => {
  vi.mocked(getElementBounds).mockResolvedValue({
    found: { name: "Save", controlType: "Button", automationId: "", boundingRect, value: null },
    via: "native",
  } as Awaited<ReturnType<typeof getElementBounds>>);
  return scopeElementHandler(ARGS);
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.DESKTOP_TOUCH_CAPTURE_BACKEND;
  hoisted.state.nativeCapture = true;
  hoisted.captured.length = 0;
  _resetCaptureBackendForTests();
});

describe("scope_element capture region (ADR-031 §2(d))", () => {
  it("captures the element on the left-hand monitor at its real coordinates", async () => {
    const result = await scopeWith({ x: -1500, y: 400, width: 120, height: 40 });
    expect(hoisted.captured).toEqual([{ x: -1520, y: 380, width: 160, height: 80 }]);
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  it("trims the padding overhang at the far edge without moving the element", async () => {
    const result = await scopeWith({ x: -1920, y: 0, width: 120, height: 40 });
    expect(hoisted.captured).toEqual([{ x: -1920, y: 0, width: 140, height: 60 }]);
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  // The regression this replaces: with `Math.max(0, …)` the region became
  // { x: 0, y: 380 } — the primary monitor — and the handler returned that as
  // the element's screenshot.
  it("does not pull an unreachable element onto the primary monitor", async () => {
    hoisted.state.nativeCapture = false; // nut.js: primary monitor only
    await scopeWith({ x: -1500, y: 400, width: 120, height: 40 });
    expect(hoisted.captured).toEqual([{ x: -1520, y: 380, width: 160, height: 80 }]);
    expect(hoisted.captured[0]!.x).toBeLessThan(0);
  });

  it("continues with text only when that capture is refused", async () => {
    hoisted.state.nativeCapture = false;
    const result = await scopeWith({ x: -1500, y: 400, width: 120, height: 40 });
    expect(result.content.some((c) => c.type === "image")).toBe(false);
    expect(result.content.some((c) => c.type === "text")).toBe(true);
  });
});

describe("internal #142 — the refusal is built from which silence it was", () => {
  // FOUND BY MUTATION (gate 2): `why` was added to the CONTEXT and the refusal itself was left
  // alone, so a window that does not exist still answered `ElementNotFound` with five suggestions
  // telling the caller to shorten the element name, re-discover the element, and consider that
  // their target might be a CSS selector. `why` is data; the advice is what a caller acts on.
  it("says the WINDOW was not found, rather than blaming the element name", async () => {
    const envelope = await scopeMissing("window_not_found");
    expect(envelope.code).toBe("WindowNotFound");
    expect(envelope.context).toMatchObject({ why: "window_not_found", via: "powershell" });
    expect((envelope.suggest ?? []).join(" ")).not.toMatch(/shorter partial name|candidate names/);
  });

  it("says the read did not finish, rather than that the element may not be visible yet", async () => {
    const envelope = await scopeMissing("read_unfinished", "none");
    expect(envelope.code).toBe("UiaTimeout");
    expect(envelope.context).toMatchObject({ why: "read_unfinished", via: "none" });
  });

  it("does not tell the caller their app is unresponsive when another window is the slow one", async () => {
    // GATE 2, THIRD PASS. The code is honest — a budget did expire — but `SUGGESTS.UiaTimeout`
    // opens with "The target app may be unresponsive — wait and retry", and this change's own
    // measurement says that is false in exactly the case that produces it: resolving a title reads
    // every top-level window's name, so ONE hung window anywhere taxes every title-resolving read
    // and the app the caller named may be perfectly healthy. The dictionary line must not ship
    // here, and the read's own three lines must.
    const envelope = await scopeMissing("read_unfinished", "none");
    expect((envelope.suggest ?? []).join(" ")).not.toMatch(/target app may be unresponsive/);
    expect((envelope.suggest ?? [])[0]).toMatch(/not a statement about the window or the element/);
    expect((envelope.suggest ?? []).join(" ")).toMatch(/not necessarily the one you named/);
    expect((envelope.suggest ?? []).join(" ")).toMatch(/budget is fixed/);
  });

  it("does not assert the window was there when the client could not tell", async () => {
    // FOUND BY MUTATION: `unreadable` is what the NATIVE road answers for BOTH of its misses, and
    // it is the road this product runs. Folding it into the plain "Element not found" arm is how a
    // window that does not exist kept getting the element-name advice here.
    const envelope = await scopeMissing("unreadable", "native");
    expect(envelope.error).toMatch(/or no window matched/);
    expect(envelope.error).toMatch(/cannot tell the two apart/);
    // It routes as `WindowNotFound`, and that is a decision rather than an accident: the code has
    // to be ONE of the two while the answer is genuinely both, so it is chosen for what the caller
    // should do FIRST — you cannot find an element inside a window that is not there, and
    // `WindowNotFound`'s own first suggestion is to list the window titles. The ambiguity lives in
    // the message, which says both halves out loud; the code carries the recovery order. This is
    // also what `wait_until` advises for the same `why`, so the two roads agree.
    expect(envelope.code).toBe("WindowNotFound");
    expect((envelope.suggest ?? []).join(" ")).toMatch(/list_window_titles|desktop_discover|get_windows/);
  });

  it("carries the read's own error, which on a failed read is the only evidence there is", async () => {
    // FOUND BY MUTATION: dropping the `error` spread killed nothing — `via: "none"` then sat
    // beside a refusal with nothing to explain either of them.
    //
    // THE CODE MOVED (gate 2, third pass): this asserted `UiaTimeout`, and `read_failed` is not a
    // timeout — it is `spawn powershell.exe ENOENT`, a non-zero exit, or output that is not JSON.
    // The caller was being advised to wait for an app to become responsive over a PowerShell that
    // never started. `ToolError` is what `classify` itself falls back to for this class, so the
    // vocabulary does not grow; what changes is that the arm now carries advice, and the advice
    // points at the one thing the refusal actually knows.
    vi.mocked(getElementBounds).mockResolvedValue({
      found: null, why: "read_failed", via: "none", error: "PowerShell read failed: the real reason",
    } as Awaited<ReturnType<typeof getElementBounds>>);
    const result = await scopeElementHandler(ARGS);
    const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "{}";
    const envelope = JSON.parse(text) as { code?: string; error?: string; suggest?: string[]; context?: Record<string, unknown> };
    expect(envelope.code).toBe("ToolError");
    expect(envelope.context).toMatchObject({ why: "read_failed", via: "none", error: "PowerShell read failed: the real reason" });
    expect((envelope.suggest ?? []).join(" ")).not.toMatch(/target app may be unresponsive/);
    expect((envelope.suggest ?? [])[0]).toMatch(/Read context\.error/);
  });

  it("treats an unrecognised PowerShell answer as a failed read, not as an ambiguous one", async () => {
    // GATE 2, THIRD PASS. `unreadable` wears one name for two opposite situations: on the native
    // road the engine discarded the distinction, and on the PowerShell road the script said
    // something SPECIFIC this server did not recognise — the words are in `context.error`. Telling
    // that caller "the client that answered cannot tell the two apart" names the wrong cause for
    // text sitting in the same envelope. `wait_until` splits on the same field one file over.
    const envelope = await scopeMissing("unreadable", "powershell");
    expect(envelope.code).toBe("ToolError");
    expect(envelope.error).not.toMatch(/cannot tell the two apart/);
    expect((envelope.suggest ?? [])[0]).toMatch(/Read context\.error/);
  });

  it("declares its code rather than letting the window title choose one", async () => {
    // GATE 2, THIRD PASS. The `unreadable` arm was the only one of the five spelling no
    // `<Code>:` prefix, so it fell into `classify`'s substring cascade WITH THE CALLER'S TITLE
    // interpolated into it — the exact smuggling class the declared-code arm exists to close. A
    // window whose title contains "is disabled" routed the refusal to `ElementDisabled` and
    // shipped "The element exists but is currently disabled" for a window that was never read.
    vi.mocked(getElementBounds).mockResolvedValue({ found: null, why: "unreadable", via: "native" } as Awaited<ReturnType<typeof getElementBounds>>);
    const result = await scopeElementHandler({ ...ARGS, windowTitle: "Printer is disabled — Settings" });
    const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "{}";
    const envelope = JSON.parse(text) as { code?: string };
    expect(envelope.code).toBe("WindowNotFound");
  });

  it("still says ElementNotFound when the element really was not found", async () => {
    // The control: the refusal that was always right must not move.
    const envelope = await scopeMissing("element_not_found");
    expect(envelope.code).toBe("ElementNotFound");
    expect((envelope.suggest ?? []).join(" ")).toMatch(/candidate names/);
  });
});
