/**
 * internal #232 — a UIA press whose call failed after it was made is not pressed again by coordinates.
 *
 * The native press (`src/uia/actions.rs`, `Invoke`) can fail after the call reached the element: a
 * dialog that closed itself during the call, an RPC disconnect. The press may have happened. Before
 * this, such a failure came back with the backend's own text, the classifier did not know it, and the
 * title-only road downgraded to a mouse press at the entity's rect — a second press when the first
 * landed (a check box toggled back, a button pressed twice), answered as a success.
 *
 * Now the engine answers in its own words (`mod.rs::PRESS_OUTCOME_UNKNOWN`), the classifier names it
 * `press_outcome_unknown`, and the act is refused with advice to look before pressing again. A
 * failure the engine does not name keeps the downgrade (the element is there and has no Invoke).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Aim } from "../../src/engine/aim.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import type { ExecutorDeps } from "../../src/tools/desktop-executor.js";
import { classifyUiaRouteFailure, describeUiaRouteFailure } from "../../src/engine/uia-route-failure.js";
import { getSuggestsForCode } from "../../src/tools/_errors.js";

/** The engine's sentence, read from the Rust source so the two sides cannot drift apart unnoticed. */
function rustConst(name: string): string {
  const src = readFileSync(join(process.cwd(), "src", "uia", "mod.rs"), "utf8");
  const m = new RegExp(`pub\\(crate\\) const ${name}: &str = "([^"]+)";`).exec(src);
  if (m === null) throw new Error(`${name} not found in src/uia/mod.rs`);
  return m[1]!;
}

const titleOnly: Aim = { kind: "aim", title: "AIM-FIXTURE" };

function uiaEntity(): UiEntity {
  return {
    entityId: "u1", role: "checkbox", label: "TARGET", confidence: 0.9, sources: ["uia"],
    locator: { uia: { name: "TARGET", via: "native", automationId: "TARGET" } },
    affordances: [{ verb: "invoke", executors: ["uia", "mouse"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d", rect: { x: 100, y: 200, width: 80, height: 30 },
  };
}

function deps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    uiaClick: vi.fn(async () => {}), uiaSetValue: vi.fn(async () => {}),
    cdpClick: vi.fn(async () => {}), cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}), keyboardTypeBg: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
    ...over,
  };
}

const failingWith = (text: string) =>
  vi.fn(async () => { throw Object.assign(new Error(text), { uiaVia: "native" as const }); });

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.resetModules(); });

async function act(d: ExecutorDeps): Promise<unknown> {
  const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
  return createDesktopExecutor(titleOnly, d)(uiaEntity(), "click").then((outcome) => outcome, (err: unknown) => err);
}

describe("the engine's answer for a press call that failed after it was made", () => {
  it("is the sentence the classifier names press_outcome_unknown", () => {
    expect(classifyUiaRouteFailure(new Error(rustConst("PRESS_OUTCOME_UNKNOWN")))).toBe("press_outcome_unknown");
  });

  it("is told to the caller as possibly done, not as nothing done", () => {
    const words = describeUiaRouteFailure("press_outcome_unknown");
    expect(words).toContain("may have taken effect");
    expect(words).toContain("before pressing again");
  });
});

describe("a title-only click whose UIA press may have landed", () => {
  it("is refused as aim_route_failed, and not pressed again by coordinates", async () => {
    const d = deps({ uiaClick: failingWith(rustConst("PRESS_OUTCOME_UNKNOWN")) });
    const thrown = await act(d);
    expect((thrown as Error).name).toBe("AimedRouteFailedError");
    expect(d.mouseClick).not.toHaveBeenCalled();
    const detail = (thrown as { callerDetail: string }).callerDetail;
    expect(detail).toContain('"TARGET"');
    expect(detail).toContain("may have taken effect");
  });

  it("keeps the downgrade for a failure the engine does not name (the control: same entity, same road)", async () => {
    const d = deps({ uiaClick: failingWith("InvokePattern not supported by this element") });
    await act(d);
    expect(d.mouseClick).toHaveBeenCalledTimes(1);
  });
});

describe("the advice that comes back with the refusal (review on 208131d0)", () => {
  it("does not send the caller to press again with click_element when the press may have landed", () => {
    const lines = getSuggestsForCode("AimRouteFailed");
    const mayHaveLanded = lines.find((l) => l.includes("the press call failed after it was made"));
    expect(mayHaveLanded).toBeDefined();
    expect(mayHaveLanded).toContain("do NOT press again, click_element included");
    // The click_element suggestion that remains is for the other failures only.
    const clickElementLine = lines.find((l) => l.includes("click_element(name=…) is worth one try"));
    expect(clickElementLine?.startsWith("Otherwise")).toBe(true);
  });
});
