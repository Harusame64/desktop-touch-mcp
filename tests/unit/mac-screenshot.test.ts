import { describe, it, expect, vi } from "vitest";
import { macScreenshotHandler, sharpEncodePng, type MacScreenshotDeps } from "../../src/tools/mac/screenshot.js";

const w = (id: number, pid: number, title: string, onScreen = true, layer = 0): any => ({
  windowId: id, pid, title, layer, onScreen, bounds: { x: 0, y: 0, width: 200, height: 100 },
});

function setup(ON: any[], ALL: any[], over: Partial<Record<keyof MacScreenshotDeps, any>> = {}) {
  const deps = {
    permissions: vi.fn(() => ({ accessibility: true, screenCapture: true })),
    listWindows: vi.fn((onScreenOnly?: boolean) => (onScreenOnly ? ON : ALL)),
    getFocus: vi.fn(async () => ({})),
    capture: vi.fn(async () => ({
      ok: true, data: Buffer.alloc(16), width: 2, height: 2,
      frame: { x: 10, y: 20, width: 200, height: 100 }, onScreen: true, elapsedMs: 1,
    })),
    encodePng: vi.fn(async () => ({ png: Buffer.from("PNGDATA"), width: 100, height: 50 })),
    ...over,
  };
  return deps as any;
}
const body = (r: any) => JSON.parse(r.content.find((b: any) => b.type === "text").text);

describe("macScreenshotHandler", () => {
  it("1 permission missing", async () => {
    const perms = { accessibility: true, screenCapture: false };
    const d = setup([], [], { permissions: vi.fn(() => perms) });
    const b = body(await macScreenshotHandler(d, { windowTitle: "x" }));
    expect(b.ok).toBe(false);
    expect(b.code).toBe("PermissionRequired");
    expect(b.context.permissions).toEqual(perms);
    expect(d.listWindows).not.toHaveBeenCalled();
    expect(d.capture).not.toHaveBeenCalled();
  });

  it("2 several matches", async () => {
    const L = [w(1, 7, "Other"), w(2, 7, "My Doc"), w(3, 8, "doc two")];
    const d = setup(L, L);
    const r = await macScreenshotHandler(d, { windowTitle: "doc" });
    expect(d.capture).toHaveBeenCalledWith({ windowId: 2 });
    expect(body(r).warnings).toEqual(["several_windows_match"]);
    expect(r.content[0]).toEqual({ type: "image", data: Buffer.from("PNGDATA").toString("base64"), mimeType: "image/png" });
  });

  it("3 single match meta", async () => {
    const L = [w(5, 7, "Calc")];
    const d = setup(L, L);
    const m = body(await macScreenshotHandler(d, { windowTitle: "calc" }));
    expect(m.windowId).toBe(5);
    expect(m.pid).toBe(7);
    expect(m.imageWidth).toBe(100);
    expect(m.imageHeight).toBe(50);
    expect(m.bounds).toEqual({ x: 10, y: 20, width: 200, height: 100 });
    expect(m.pointsPerPixel).toBe(2);
    expect("warnings" in m).toBe(false);
    expect(d.encodePng).toHaveBeenCalledWith(Buffer.alloc(16), 2, 2, 1280);
  });

  it("4 maxDimension", async () => {
    const L = [w(5, 7, "Calc")];
    const d = setup(L, L);
    await macScreenshotHandler(d, { windowTitle: "calc", maxDimension: 600 });
    expect(d.encodePng.mock.calls[0][3]).toBe(600);
  });

  it("5 off-screen only", async () => {
    const d = setup([], [w(9, 7, "Hidden", false)]);
    const m = body(await macScreenshotHandler(d, { windowTitle: "hidden" }));
    expect(d.capture).toHaveBeenCalledWith({ windowId: 9 });
    expect(m.warnings).toEqual(["window_off_screen"]);
  });

  it("6 no match, titled windows exist", async () => {
    const L = [w(1, 7, "Other")];
    const d = setup(L, L);
    const b = body(await macScreenshotHandler(d, { windowTitle: "zzz" }));
    expect(b.code).toBe("WindowNotFound");
    const s = JSON.stringify(b.suggest);
    for (const bad of ["list_window_titles", "focus_window", "PrintWindow"]) expect(s).not.toContain(bad);
    expect(d.capture).not.toHaveBeenCalled();
  });

  it("7 no titled windows", async () => {
    const L = [w(1, 7, ""), { windowId: 2, pid: 8, layer: 0, onScreen: true }];
    const d = setup(L, L);
    const b = body(await macScreenshotHandler(d, { windowTitle: "doc" }));
    expect(b.code).toBe("WindowNotFound");
    // Gate 2 (#781): Screen Recording was just confirmed, so the cause is not named as missing.
    expect(b.error).not.toContain("Screen Recording");
    expect(JSON.stringify(b.suggest)).not.toContain("Accessibility");
  });

  it("8 no title uses focus", async () => {
    const L = [w(1, 7, "A"), w(2, 7, "B"), w(3, 8, "B")];
    const d = setup(L, L, { getFocus: vi.fn(async () => ({ pid: 7, focusedWindowTitle: "B" })) });
    await macScreenshotHandler(d, {});
    expect(d.capture).toHaveBeenCalledWith({ windowId: 2 });
  });

  it("9 no title, no focus", async () => {
    const L = [w(1, 7, "A")];
    const d = setup(L, L);
    const b = body(await macScreenshotHandler(d, {}));
    expect(b.code).toBe("WindowNotFound");
    expect(d.capture).not.toHaveBeenCalled();
  });

  it("10 capture failure", async () => {
    const L = [w(1, 7, "A")];
    const d = setup(L, L, {
      capture: vi.fn(async () => ({ ok: false, reason: "sck_error -3811: x", width: 0, height: 0, elapsedMs: 1 })),
    });
    const r = await macScreenshotHandler(d, { windowTitle: "a" });
    const b = body(r);
    expect(b.code).toBe("CaptureBackendFailed");
    expect(b.context.reason).toBe("sck_error -3811: x");
    expect(r.content.some((c: any) => c.type === "image")).toBe(false);
    const s = JSON.stringify(b.suggest);
    expect(s).not.toContain("PrintWindow");
    expect(s).not.toContain("USERPROFILE");
  });

  // "Never an older image": a failure that still carries pixels must not hand them back. Without
  // pixels on the failure (cell 10) a check of `data` alone and a check of `ok` look the same.
  it("10b a failure that carries pixels returns no image", async () => {
    const L = [w(1, 7, "A")];
    const d = setup(L, L, {
      capture: vi.fn(async () => ({ ok: false, reason: "timeout", data: Buffer.alloc(16), width: 2, height: 2, elapsedMs: 1 })),
    });
    const r = await macScreenshotHandler(d, { windowTitle: "a" });
    expect(body(r).code).toBe("CaptureBackendFailed");
    expect(r.content.some((c: any) => c.type === "image")).toBe(false);
    expect(d.encodePng).not.toHaveBeenCalled();
  });
});

describe("sharpEncodePng", () => {
  const rgba = Buffer.alloc(100 * 50 * 4, 255);
  it("11 scales down", async () => {
    const r = await sharpEncodePng(rgba, 100, 50, 40);
    expect(r.width).toBe(40);
    expect(r.height).toBe(20);
    expect([...r.png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
  it("12 no enlargement", async () => {
    const r = await sharpEncodePng(rgba, 100, 50, 1000);
    expect(r.width).toBe(100);
    expect(r.height).toBe(50);
  });
});

describe("gate 2 (#781)", () => {
  it("a window that closed before the capture is WindowNotFound", async () => {
    const L = [w(1, 7, "A")];
    const d = setup(L, L, { capture: vi.fn(async () => ({ ok: false, reason: "window_not_found", width: 0, height: 0, elapsedMs: 1 })) });
    expect(body(await macScreenshotHandler(d, { windowTitle: "a" })).code).toBe("WindowNotFound");
  });
  it("a large window is captured scaled down to maxDimension, a small one at the native scale", async () => {
    const big = { ...w(1, 7, "Big"), bounds: { x: 0, y: 0, width: 2560, height: 1440 } };
    const d = setup([big], [big]);
    await macScreenshotHandler(d, { windowTitle: "big", maxDimension: 1280 });
    expect(d.capture).toHaveBeenCalledWith({ windowId: 1, scale: 0.5 });
    const small = w(2, 7, "Small");
    const d2 = setup([small], [small]);
    await macScreenshotHandler(d2, { windowTitle: "small" });
    expect(d2.capture).toHaveBeenCalledWith({ windowId: 2 });
  });
  it("an encoder that cannot load costs this capture only", async () => {
    const L = [w(1, 7, "A")];
    const d = setup(L, L, { encodePng: vi.fn(async () => { throw new Error("Could not load the sharp module"); }) });
    const r = await macScreenshotHandler(d, { windowTitle: "a" });
    expect(body(r).code).toBe("CaptureBackendFailed");
    expect(r.content.some((c: any) => c.type === "image")).toBe(false);
  });
  it("the Screen Recording advice comes first when it is missing", async () => {
    const L = [w(1, 7, "A")];
    const d = setup(L, L, { permissions: vi.fn(() => ({ accessibility: true, screenCapture: false })) });
    const b = body(await macScreenshotHandler(d, { windowTitle: "a" }));
    expect(b.suggest[0]).toContain("Screen Recording");
  });
});

describe("codex (#781)", () => {
  it("an untargeted capture without Accessibility is PermissionRequired, not WindowNotFound", async () => {
    const L = [w(1, 7, "A")];
    const d = setup(L, L, { permissions: vi.fn(() => ({ accessibility: false, screenCapture: true })) });
    const b = body(await macScreenshotHandler(d, {}));
    expect(b.code).toBe("PermissionRequired");
    expect(d.getFocus).not.toHaveBeenCalled();
  });
  it("a titled capture without Accessibility still works", async () => {
    const L = [w(1, 7, "A")];
    const d = setup(L, L, { permissions: vi.fn(() => ({ accessibility: false, screenCapture: true })) });
    const r = await macScreenshotHandler(d, { windowTitle: "a" });
    expect(r.content.some((c: any) => c.type === "image")).toBe(true);
  });
  it("a window under maxDimension points but over it at 2x is captured at the fitting scale", async () => {
    const mid = { ...w(1, 7, "Mid"), bounds: { x: 0, y: 0, width: 1200, height: 800 } };
    const d = setup([mid], [mid]);
    await macScreenshotHandler(d, { windowTitle: "mid", maxDimension: 1280 });
    expect(d.capture).toHaveBeenCalledWith({ windowId: 1, scale: 1280 / 1200 });
  });
});
