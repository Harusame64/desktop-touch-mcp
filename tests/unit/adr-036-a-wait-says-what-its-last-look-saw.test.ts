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
let foundNativeFailed: string | undefined;

vi.mock("../../src/engine/uia-bridge.js", () => ({
  getElementBounds: async () => {
    if (readThrows) throw readThrows;
    return bounds
      ? { found: bounds, via: foundVia, ...(foundNativeFailed !== undefined && { nativeFailed: foundNativeFailed }) }
      : { found: null, ...miss };
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
  bounds = null; readThrows = null; foundVia = "powershell"; foundNativeFailed = undefined;
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

  it("tells the caller to wait, for the one silence where waiting works", async () => {
    // win2, internal `0c5547d`: a hung window makes this road answer nothing in 16 s — and the
    // envelope said `element_not_found`, so the caller went off to re-read a name belonging to an
    // element that was on the screen the whole time.
    //
    // THE SUBJECT IS THE READ, NOT THE WINDOW, and that is a correction rather than a style
    // choice. The first draft of this line said "the window is busy, not missing". Measured the
    // same day (win2, `30dac81`): reading a title that matches NO WINDOW AT ALL takes 16 s while
    // an unrelated window is hung, because a title search walks the root's children and reads
    // `Current.Name` on each. One unresponsive window is a tax on every title search, so a
    // sentence about "the window you named" is false in exactly the case that produces it.
    miss = { why: "read_unfinished", via: "none", nativeFailed: "UIA operation timed out after 8000ms" };
    const envelope = await waitFor("element_appears");
    expect(contextOf(envelope)["lastLook"]).toMatchObject({ resolved: false, why: "read_unfinished", via: "none" });
    expect(suggestOf(envelope)[0]).toMatch(/ran out of its own budget/);
    expect(suggestOf(envelope)[0]).toMatch(/not necessarily the one you named/);
    // …it says what a longer timeout actually buys, which is not what it sounds like (gate 2):
    // `getElementBounds` hard-codes its own 8000 ms and takes nothing from the caller, so a bigger
    // `timeoutMs` buys more 16-second attempts rather than one longer look (#144).
    expect(suggestOf(envelope)[0]).toMatch(/more attempts rather than a longer look/);
    // …and it does NOT send them to re-check either name.
    expect(suggestOf(envelope)[0]).not.toMatch(/target\.elementName|target\.windowTitle/);
    // …and it does not claim a client answered, because on this silence none did.
    expect(suggestOf(envelope).join(" ")).not.toMatch(/fell back to the PowerShell/);
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
    // SAID FIRST on this silence, and that ordering is the measurement rather than a preference.
    // MEASURED 2026-09-20 win2 (internal `c4374e9`): with an unrelated window hung, the native
    // read throws, the PowerShell road COMPLETES, and it genuinely has no element called `最小化`
    // — it calls that control `Minimize`. So `element_not_found` is true and "check
    // target.elementName" is the wrong recovery: the name was right and the ROAD was wrong. The
    // first round of this change put the vocabulary line second and the machine showed the
    // envelope opening with advice that could not work.
    expect(suggestOf(envelope)[0]).toMatch(/fell back to the PowerShell UIA client/);
    expect(suggestOf(envelope)[0]).toMatch(/WHICH client's name/);
    // …and the name line is still there, after it: the name CAN also be wrong.
    expect(suggestOf(envelope).join("\n")).toMatch(/No element by that name/);
  });

  it("does not question a NAME on a silence where no name was looked up", async () => {
    // THIS CELL USED TO ASSERT THE OPPOSITE — that the vocabulary line is said second on every
    // other silence, "because a changed road changes what a name means". Gate 2's third pass took
    // the remainder apart: on `window_not_found` the element was never looked for, and a window
    // title is not UIA vocabulary. There is no name here whose client could be the wrong one.
    miss = { why: "window_not_found", via: "powershell", nativeFailed: "UIA operation timed out after 8000ms" };
    const envelope = await waitFor("element_appears");
    expect(suggestOf(envelope)[0]).toMatch(/No window matched target\.windowTitle/);
    expect(suggestOf(envelope).join("\n")).not.toMatch(/fell back to the PowerShell UIA client/);
  });

  it("says nothing about vocabulary on a read that failed, which compared no name with anything", async () => {
    // The shape gate 2 named: `read_failed` on the PowerShell road. A client spoke and the read
    // still failed, so line one is about the failure — and a second line telling the caller their
    // name may be the other client's asserts an observation that never happened, which is the rule
    // this suite's own `baseline: ""` cell states one silence over.
    miss = { why: "read_failed", via: "powershell", nativeFailed: "UIA operation timed out after 8000ms", error: "PowerShell printed JSON that is not an object" };
    const envelope = await waitFor("element_appears");
    expect(suggestOf(envelope)[0]).toMatch(/The read itself failed/);
    expect(suggestOf(envelope).join("\n")).not.toMatch(/fell back to the PowerShell UIA client/);
  });

  it("says nothing about vocabulary when the read ran out of its own budget", async () => {
    // `read_unfinished` is the one silence that is not a statement about the window or the element.
    // `via: "none"` already kept the line off this arm; the cell holds the pair together, because
    // the two conditions were narrowed one round apart and either one alone would let it back.
    miss = { why: "read_unfinished", via: "none", nativeFailed: "UIA operation timed out after 8000ms" };
    const envelope = await waitFor("element_appears");
    expect(suggestOf(envelope)[0]).toMatch(/ran out of its own budget/);
    expect(suggestOf(envelope).join("\n")).not.toMatch(/fell back to the PowerShell UIA client/);
  });

  it("does not question the name of an element it found and read twice", async () => {
    // THE DEFECT GATE 2 FOUND, and it is this change's own shape one condition over. On any build
    // with the addon, the ONLY way to reach the PowerShell road is a native throw — so every
    // fall-back carries `nativeFailed`, and this fired on every one of them.
    //
    // Here the element was found and its value read on every poll; the wait timed out because the
    // value never moved. The envelope opened with "the name you passed may be the native engine's
    // — check WHICH client's name you are using", about a name that demonstrably worked, and it
    // displaced "Increase timeoutMs", which is the right advice for a value that has not changed
    // yet.
    bounds = { name: "Save", value: "draft" };
    foundVia = "powershell";
    foundNativeFailed = "UIA operation timed out after 8000ms";
    const envelope = await waitFor("value_changes");
    expect(contextOf(envelope)["lastLook"]).toMatchObject({ resolved: true, baseline: "draft", via: "powershell" });
    expect(suggestOf(envelope)[0]).toBe("Increase timeoutMs");
    expect(suggestOf(envelope).join(" ")).not.toMatch(/fell back/);
  });

  it("does not contradict itself about an element it found without a rectangle", async () => {
    // The other resolved shape: line one said "found but has no rectangle" and line two said the
    // name may be wrong. Both cannot be the thing to fix (gate 2).
    bounds = { name: "Save", controlType: "Button" };
    foundVia = "powershell";
    foundNativeFailed = "UIA operation timed out after 8000ms";
    const envelope = await waitFor("element_appears");
    expect(suggestOf(envelope)[0]).toMatch(/no rectangle/);
    expect(suggestOf(envelope).join(" ")).not.toMatch(/fell back/);
  });

  it("says two different things by 'unreadable', because two different roads produce it", async () => {
    // FOUND BY MUTATION (gate 2's own finding, then a mutation nobody had written): the NATIVE
    // road answers `unreadable` because the engine discards the distinction, while the PowerShell
    // road answers it only when the script said something this server does not recognise — and
    // then the words are in `context.lastLook.error`. One sentence for both told half the callers
    // something false about their build.
    miss = { why: "unreadable", via: "native" };
    const native = await waitFor("element_appears");
    expect(suggestOf(native)[0]).toMatch(/this build's UIA engine cannot tell the two apart/);

    miss = { why: "unreadable", via: "powershell", error: "Access is denied. (0x80070005)" };
    const ps = await waitFor("element_appears");
    expect(suggestOf(ps)[0]).toMatch(/something this server does not recognise/);
    expect(suggestOf(ps)[0]).toMatch(/context\.lastLook\.error/);
    expect(suggestOf(ps)[0]).not.toMatch(/this build's UIA engine/);
  });

  it("says nothing about vocabulary on an unrecognised answer, even though a client did answer", async () => {
    // THE ONE MUTATION GATE 2's FOURTH PASS COULD NOT KILL: re-adding the vocabulary line for
    // `unreadable` + PowerShell left all 28 cells green, because the `unreadable` + PowerShell cell
    // above never passes `nativeFailed` — and without it the line's first condition short-circuits,
    // so nobody was looking at the combination that actually reaches the guard.
    //
    // It is the same rule as the two silences above: the script said something this file did not
    // recognise, so no name was compared with anything and there is nothing a vocabulary can
    // explain. The words are in `context.lastLook.error`, which line one already points at.
    miss = { why: "unreadable", via: "powershell", nativeFailed: "UIA operation timed out after 8000ms", error: "Access is denied. (0x80070005)" };
    const envelope = await waitFor("element_appears");
    expect(suggestOf(envelope)[0]).toMatch(/something this server does not recognise/);
    expect(suggestOf(envelope).join("\n")).not.toMatch(/fell back to the PowerShell UIA client/);
  });

  it("says the road changed once, not twice", async () => {
    // FOUND BY MUTATION (gate 2): dropping the `why !== "element_not_found"` exclusion from the
    // trailing push emits the vocabulary line TWICE on that silence, and every cell stayed green
    // because they assert `suggest[0]` and a `join` containment, neither of which counts.
    miss = { why: "element_not_found", via: "powershell", nativeFailed: "UIA operation timed out after 8000ms" };
    const envelope = await waitFor("element_appears");
    expect(suggestOf(envelope).filter((line) => /fell back to the PowerShell/.test(line))).toHaveLength(1);
  });

  it("names the window lister by capability, not by a name nobody registered", async () => {
    // FOUND BY MUTATION (gate 2), and by eye before that: the first version of these two sentences
    // said `list_windows`, which exists nowhere in this product. The source-walking gate only
    // checks `{tool:…}` placeholders against the capability list — a BARE unregistered tool name
    // in prose is invisible to it, which is why the regression could come back unnoticed.
    for (const why of ["window_not_found", "unreadable"]) {
      miss = { why, via: why === "unreadable" ? "native" : "powershell" };
      const envelope = await waitFor("element_appears");
      const first = suggestOf(envelope)[0];
      expect(first, why).toMatch(/\{tool:list_window_titles\}|desktop_discover|get_windows/);
      expect(first, why).not.toMatch(/list_windows\b/);
    }
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

  it("routes the read's reason on the value road too, not only on the element road", async () => {
    // FOUND BY MUTATION (gate 2): hard-coding `element_not_found` in `probeValueChanges` survives,
    // because every envelope cell above drives `element_appears`. Two probes, one claim, one of
    // them unswept — which is the shape this whole file exists to stop.
    miss = { why: "window_not_found", via: "powershell" };
    const envelope = await waitFor("value_changes");
    expect(contextOf(envelope)["lastLook"]).toMatchObject({ resolved: false, why: "window_not_found", via: "powershell" });
    expect(suggestOf(envelope)[0]).toMatch(/No window matched target\.windowTitle/);
  });

  it("carries the read's error on the value road as well", async () => {
    miss = { why: "read_failed", via: "powershell", error: "PowerShell answered with something that is not JSON" };
    const envelope = await waitFor("value_changes");
    expect(contextOf(envelope)["lastLook"]).toMatchObject({ why: "read_failed", error: "PowerShell answered with something that is not JSON" });
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
