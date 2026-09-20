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

/**
 * The stand-in speaks the shape the bridge speaks — internal #142. `miss` is what the read says
 * when it answers nothing, and the default is the one this file was written around: an element
 * that was not there, said by the PowerShell client.
 */
let miss: { why: string; via: string; nativeFailed?: string; error?: string } =
  { why: "element_not_found", via: "powershell" };
let foundVia: "native" | "powershell" = "powershell";

vi.mock("../../src/engine/uia-bridge.js", () => ({
  getElementBounds: async () => {
    if (readThrows) throw readThrows;
    return bounds ? { found: bounds, via: foundVia } : { found: null, ...miss };
  },
}));
vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: () => [],
  getWindowProcessId: () => 0,
  findWindow: () => null,
}));
vi.mock("../../src/engine/cdp-bridge.js", () => ({ DEFAULT_CDP_PORT: 9222, evaluateInTab: async () => null }));
// The real class, because the rethrow tests it with `instanceof` and a stand-in would pass the
// `name` check while failing the real one — which is the difference this cell exists to hold.
const { WindowExcludedError } = await import("../../src/engine/tool-exclusion.js");
vi.mock("../../src/utils/desktop-config.js", () => ({ getCdpPort: () => 9222 }));

const { waitUntilHandler } = await import("../../src/tools/wait-until.js");

beforeEach(() => {
  bounds = null; readThrows = null; foundVia = "powershell";
  miss = { why: "element_not_found", via: "powershell" };
});

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
    // caller would otherwise take three times for a name that matches nothing. The tool in it is
    // named by capability, so the sentence says whichever of the two this server registered.
    expect(suggestOf(envelope)[0]).toMatch(/No element by that name was found/);
    expect(suggestOf(envelope)[0]).toMatch(/desktop_discover|get_ui_elements/);
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

  it("prints no reading for an element it never read", async () => {
    // `baseline: ""` beside `resolved: false` asserts an observation that never happened — and ""
    // is exactly the value a missing element is NOT, which is the conflation this whole change is
    // about, one level down (gate 2).
    bounds = null;
    const look = contextOf(await waitFor("value_changes"))["lastLook"] as Record<string, unknown>;
    expect(look).toMatchObject({ resolved: false, why: "element_not_found" });
    expect(look).not.toHaveProperty("baseline");
    expect(look).not.toHaveProperty("latest");
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

  it("does not call an element that was found but has no rectangle a missing element", async () => {
    // THE DEFECT THIS CHANGE NEARLY SHIPPED (gate 2): both arms wrote `resolved:false`, so a button
    // in a collapsed panel — found by name every poll, rect nulled because it is empty or offscreen
    // — was told its NAME was wrong, and the tool the advice points at does not list such a control
    // either. The real recovery (bring it into view) was in none of the four suggestions.
    bounds = { name: "Save", controlType: "Button" };   // resolved, no boundingRect
    const envelope = await waitFor("element_appears");
    expect(contextOf(envelope)["lastLook"]).toMatchObject({ resolved: true, why: "no_rectangle" });
    expect(suggestOf(envelope)[0]).toMatch(/no rectangle/);
    expect(suggestOf(envelope)[0]).not.toMatch(/check target.elementName/);
  });

  it("does not leave one poll's reason standing beside another poll's answer", async () => {
    // The look is replaced, not merged: a read that throws on the first poll and succeeds on the
    // second used to ship `{resolved:true, why:"read_failed", error:…}` — a composite of two polls
    // that contradict each other, under a comment promising the LAST look (gate 2).
    readThrows = new Error("RPC_E_DISCONNECTED");
    bounds = { name: "Save", value: "draft" };
    let polls = 0;
    const original = readThrows;
    readThrows = null;
    // Throw on the first poll only.
    const uia = await import("../../src/engine/uia-bridge.js");
    const spy = vi.spyOn(uia, "getElementBounds").mockImplementation(async () => {
      polls += 1;
      if (polls === 1) throw original;
      return { found: bounds, via: "powershell" } as never;
    });
    const envelope = await waitFor("value_changes");
    spy.mockRestore();
    expect(polls).toBeGreaterThan(1);
    const look = contextOf(envelope)["lastLook"] as Record<string, unknown>;
    expect(look).toMatchObject({ resolved: true, baseline: "draft", latest: "draft" });
    expect(look).not.toHaveProperty("why");
    expect(look).not.toHaveProperty("error");
  });

  it("stops at once for a window this server may not act through, and says so with its own code", async () => {
    // A refusal is not a thing that has not happened yet. Swallowed, it polled the key locker for
    // the whole timeout and answered `WaitTimeout`; rethrown bare, it arrived as `ToolError` with
    // no advice at all, because `classify` reads the MESSAGE and not the class (gate 2 found both,
    // one round apart). The code is spelled into the message, which is how this product carries a
    // declared code out through `failWith`.
    // BOTH probes, not one: the two were kept symmetric by this change, and deleting the rethrow
    // from `value_changes` alone left every cell green while that condition went on polling the
    // locker for its whole timeout (gate 2 wrote the mutation).
    for (const condition of ["element_appears", "value_changes"]) {
      readThrows = new WindowExcludedError('UIA target window "Key Locker" belongs to the desktop-touch key locker and is excluded');
      const started = Date.now();
      const envelope = await waitFor(condition, 5000);
      expect(envelope["code"], condition).toBe("WindowExcluded");
      // It did not wait out the timeout to say so.
      expect(Date.now() - started, condition).toBeLessThan(2000);
      // …the advice for that code is the four lines the product already wrote, not silence…
      expect(suggestOf(envelope).length, condition).toBeGreaterThan(0);
      // …and it still says WHICH window was refused, which is the detail a caller acts on.
      expect(String(envelope["error"]), condition).toMatch(/Key Locker/);
      // The context is the refusal's, not the timeout's. Asserted as an equality rather than as an
      // absence: `lastLook` cannot appear on this road under any mutation of the probes, so
      // `not.toHaveProperty` would have been a cell that cannot fail (gate 2).
      expect(contextOf(envelope), condition).toEqual({
        condition, target: { windowTitle: "App", elementName: "Save" },
      });
    }
  });

  it("does not blame the element name when no window matched at all", async () => {
    // THE DEFECT internal #142 CLOSES, measured on Windows before it was fixed: a wait against a
    // title that matches no window answered `why: "element_not_found"` and advised checking
    // `target.elementName` against a discovery tool. Nothing was ever looked for — there was
    // nowhere to look — and re-reading the element name could not have helped.
    miss = { why: "window_not_found", via: "powershell" };
    const envelope = await waitFor("element_appears");
    expect(contextOf(envelope)["lastLook"]).toMatchObject({ resolved: false, why: "window_not_found" });
    expect(suggestOf(envelope)[0]).toMatch(/No window matched target\.windowTitle/);
    // …and it does NOT open with the element-name line, which is the whole point.
    expect(suggestOf(envelope)[0]).not.toMatch(/target\.elementName/);
  });

  it("says it could not tell the two apart, rather than picking one", async () => {
    // The native road's honest answer on a build whose engine discards the reason. Advice that
    // names BOTH checks in order is worth more than a confident wrong one.
    miss = { why: "unreadable", via: "native" };
    const envelope = await waitFor("element_appears");
    expect(contextOf(envelope)["lastLook"]).toMatchObject({ resolved: false, why: "unreadable", via: "native" });
    expect(suggestOf(envelope)[0]).toMatch(/without saying whether the WINDOW or the ELEMENT/);
  });

  it("says a read that failed learned nothing, instead of reporting an absence", async () => {
    miss = { why: "read_failed", via: "powershell", error: "powershell.exe: timed out" };
    const envelope = await waitFor("element_appears");
    expect(contextOf(envelope)["lastLook"]).toMatchObject({ resolved: false, why: "read_failed", error: "powershell.exe: timed out" });
    expect(suggestOf(envelope)[0]).toMatch(/nothing was learned about the window or the element/);
  });

  it("says the road changed under the wait, because that changes what a name means", async () => {
    // MEASURED 2026-09-20 win2 (internal `25da27f`): hanging a window's UI thread makes the native
    // call throw and the PowerShell road answer. The two clients name some controls differently
    // (internal #136), so the SAME wait on the SAME live element becomes a timeout — and the old
    // envelope said `element_not_found` with no hint that anything had changed.
    miss = { why: "element_not_found", via: "powershell", nativeFailed: "UIA operation timed out after 8000ms" };
    const envelope = await waitFor("element_appears");
    expect(contextOf(envelope)["lastLook"]).toMatchObject({
      resolved: false, why: "element_not_found", via: "powershell",
      nativeFailed: "UIA operation timed out after 8000ms",
    });
    // Said SECOND: the first line is still the one the silence earned, and this one explains what
    // a name means on the road that answered.
    expect(suggestOf(envelope)[0]).toMatch(/No element by that name/);
    expect(suggestOf(envelope)[1]).toMatch(/fell back to the PowerShell UIA client/);
  });

  it("stays quiet about the road when the road did not change", async () => {
    // An advice line that appears on every answer says nothing. This one is evidence that a
    // fall-back HAPPENED, so it has to be absent when it did not.
    miss = { why: "element_not_found", via: "powershell" };
    const envelope = await waitFor("element_appears");
    expect(suggestOf(envelope).join(" ")).not.toMatch(/fell back/);
    expect(contextOf(envelope)["lastLook"]).not.toHaveProperty("nativeFailed");
  });

  it("names the client on a look that SUCCEEDED too, not only on a miss", async () => {
    // Which client read a value is part of what the value means, and `value_changes` compares two
    // readings: two clients over one wait is a comparison across vocabularies.
    bounds = { name: "Save", value: "draft" };
    foundVia = "native";
    const envelope = await waitFor("value_changes");
    expect(contextOf(envelope)["lastLook"]).toMatchObject({ resolved: true, baseline: "draft", via: "native" });
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
