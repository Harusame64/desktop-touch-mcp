/**
 * internal #137 — a wait that timed out says what its last look saw.
 *
 * A probe answers `null` for every reason it has — the element was not found, the read failed, the
 * element was there and the thing waited for did not happen — and the envelope then says
 * `WaitTimeout`. Those were one answer. MEASURED 2026-09-20 win2 (internal `bdef099`):
 * `value_changes` on a name that matched nothing timed out at 3065 ms, and the control arm, whose
 * element was there all along, timed out at 3064 ms. Same envelope, same words, same suggestions.
 *
 * Which of the two it was decides what the caller should do next, and the two recoveries have
 * nothing in common: waiting longer is right for a thing that has not happened yet and useless for
 * a name that matches nothing. So the timeout carries `context.lastLook`, and the first suggestion
 * is the one the last look earned.
 *
 * Nothing routes on it; it is an answer, not a branch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Bounds = { name: string; controlType?: string; automationId?: string; value?: string; boundingRect?: unknown } | null;

let bounds: Bounds = null;
let readThrows: Error | null = null;

vi.mock("../../src/engine/uia-bridge.js", () => ({
  getElementBounds: async () => {
    if (readThrows) throw readThrows;
    return bounds;
  },
}));
vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: () => [],
  getWindowProcessId: () => 0,
  findWindow: () => null,
}));
vi.mock("../../src/engine/cdp-bridge.js", () => ({ DEFAULT_CDP_PORT: 9222, evaluateInTab: async () => null }));
vi.mock("../../src/utils/desktop-config.js", () => ({ getCdpPort: () => 9222 }));

const { waitUntilHandler } = await import("../../src/tools/wait-until.js");

beforeEach(() => { bounds = null; readThrows = null; });

/** The envelope a timed-out wait produces, parsed. */
async function waitFor(condition: string, timeoutMs = 600): Promise<Record<string, unknown>> {
  const result = await waitUntilHandler({
    condition,
    target: { windowTitle: "App", elementName: "Save" },
    timeoutMs,
    intervalMs: 100,
  } as never);
  const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

// The envelope is flat — `{ok, code, error, suggest, context}` — which is worth reading off a real
// one rather than assuming: the first version of this file nested them under `error` and every cell
// failed against a working implementation.
const contextOf = (envelope: Record<string, unknown>) =>
  (envelope["context"] ?? {}) as Record<string, unknown>;
const suggestOf = (envelope: Record<string, unknown>) =>
  (envelope["suggest"] ?? []) as string[];

describe("a timed-out wait says which silence it was", () => {
  it("says the element was never resolved, and says so first", async () => {
    // The read answers nothing: no element by that name.
    const envelope = await waitFor("element_appears");
    expect(contextOf(envelope)["lastLook"]).toMatchObject({ resolved: false, why: "element_not_found" });
    // The first suggestion is the one this look earned — "increase the timeout" is the advice a
    // caller would otherwise take three times for a name that matches nothing.
    expect(suggestOf(envelope)[0]).toMatch(/never resolved/);
    expect(suggestOf(envelope)).toContain("Increase timeoutMs");
  });

  it("separates a read that failed from a name that matched nothing", async () => {
    readThrows = new Error("RPC_E_DISCONNECTED");
    const envelope = await waitFor("element_appears");
    expect(contextOf(envelope)["lastLook"]).toMatchObject({
      resolved: false, why: "read_failed", error: "RPC_E_DISCONNECTED",
    });
  });

  it("says the value was being watched, and what it was watching", async () => {
    // The element IS there and its value never moves: the other half of the measured pair, which
    // used to be the same envelope as the arm above.
    bounds = { name: "Save", controlType: "Edit", value: "draft" };
    const envelope = await waitFor("value_changes");
    expect(contextOf(envelope)["lastLook"]).toMatchObject({ resolved: true, baseline: "draft", latest: "draft" });
    // …and this one is NOT told the element was never resolved, because it was.
    expect(suggestOf(envelope)[0]).toBe("Increase timeoutMs");
  });

  it("tells the two value silences apart, which is the whole point", async () => {
    bounds = { name: "Save", value: "draft" };
    const found = contextOf(await waitFor("value_changes"))["lastLook"];
    bounds = null;
    const missing = contextOf(await waitFor("value_changes"))["lastLook"];
    expect(found).toMatchObject({ resolved: true });
    expect(missing).toMatchObject({ resolved: false });
    expect(found).not.toEqual(missing);
  });

  it("carries no last look for a condition that looks at no element", async () => {
    // An empty object would read as "it looked and saw nothing". The key is absent instead.
    const result = await waitUntilHandler({
      condition: "window_appears", target: { windowTitle: "Nothing" }, timeoutMs: 300, intervalMs: 100,
    } as never);
    const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "{}";
    const envelope = JSON.parse(text) as Record<string, unknown>;
    expect(contextOf(envelope)).not.toHaveProperty("lastLook");
    expect(contextOf(envelope)).toMatchObject({ condition: "window_appears" });
  });
});

describe("a wait that succeeds says what it resolved", () => {
  it("names the control type and AutomationId the same read already carried", async () => {
    // `observed` used to be the name and the rect. A caller handed the wrong element — the defect
    // internal #134 closed for the window case — had nothing in the answer to see it with.
    bounds = { name: "Save", controlType: "Button", automationId: "btnSave", boundingRect: { x: 1, y: 2, width: 3, height: 4 } };
    const result = await waitUntilHandler({
      condition: "element_appears", target: { windowTitle: "App", elementName: "Save" }, timeoutMs: 600, intervalMs: 100,
    } as never);
    const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "{}";
    const envelope = JSON.parse(text) as { ok: boolean; observed: Record<string, unknown> };
    expect(envelope.ok).toBe(true);
    expect(envelope.observed).toMatchObject({ name: "Save", controlType: "Button", automationId: "btnSave" });
  });

  it("leaves the AutomationId out when the read had none, rather than saying it is empty", async () => {
    bounds = { name: "Save", controlType: "Button", automationId: "", boundingRect: { x: 1, y: 2, width: 3, height: 4 } };
    const result = await waitUntilHandler({
      condition: "element_appears", target: { windowTitle: "App", elementName: "Save" }, timeoutMs: 600, intervalMs: 100,
    } as never);
    const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "{}";
    const envelope = JSON.parse(text) as { observed: Record<string, unknown> };
    expect(envelope.observed).not.toHaveProperty("automationId");
  });
});
