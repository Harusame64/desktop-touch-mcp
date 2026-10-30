/**
 * internal #324 — desktop_act click on a text field with no Invoke, aimed by handle, moves the focus
 * into it.
 *
 * win2 (2026-10-30, Chrome): a web page's `<textarea>` and `<input>` are UIA `Edit`s with no Invoke, and
 * a click on one aimed by handle answered `aim_route_failed` on every build: the handle road does not
 * finish as a coordinate click. The engine (`src/uia/actions.rs`) now moves the focus into such a field
 * and answers `FocusedTextField`; when the focus was not moved, it refuses as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Aim } from "../../src/engine/aim.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import { classifyUiaRouteFailure } from "../../src/engine/uia-route-failure.js";

/** The engine's code, read from the Rust source so the two sides cannot drift apart unnoticed. */
function rustCode(): string {
  const src = readFileSync(join(process.cwd(), "src", "uia", "actions.rs"), "utf8");
  const m = /pub\(crate\) const FOCUSED_TEXT_FIELD: &str = "([^"]+)";/.exec(src);
  if (m === null) throw new Error("FOCUSED_TEXT_FIELD not found in src/uia/actions.rs");
  return m[1]!;
}

/** The refusal `focus_text_field` answers when the focus was not moved. */
function rustRefusal(): string {
  const src = readFileSync(join(process.cwd(), "src", "uia", "actions.rs"), "utf8");
  const body = src.slice(src.indexOf("fn focus_text_field("));
  const m = /error: \(!moved\)\.then\(\|\| "([^"]+)"/.exec(body);
  if (m === null) throw new Error("focus_text_field's refusal not found in src/uia/actions.rs");
  return m[1]!;
}

const byHandle: Aim = { kind: "aim", title: "Chrome", hwnd: 4919n };

function textField(): UiEntity {
  return {
    entityId: "ta", role: "textbox", label: "ta-field", confidence: 0.9, sources: ["uia"], controlType: "Edit",
    locator: { uia: { name: "ta-field", via: "native" } },
    affordances: [{ verb: "click", executors: ["uia", "mouse"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d", rect: { x: 605, y: 187, width: 306, height: 127 },
  };
}

const clickElement = vi.fn();
const probeAim = vi.fn();

beforeEach(() => {
  vi.resetModules();
  clickElement.mockReset();
  vi.doMock("../../src/engine/uia-bridge.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/engine/uia-bridge.js")>()),
    clickElement,
  }));
  probeAim.mockReset();
  vi.doMock("../../src/engine/aim-probe.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/engine/aim-probe.js")>()),
    probeAim,
  }));
});
afterEach(() => { vi.doUnmock("../../src/engine/uia-bridge.js"); vi.doUnmock("../../src/engine/aim-probe.js"); vi.resetModules(); });

async function click(): Promise<unknown> {
  const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
  return createDesktopExecutor(byHandle)(textField(), "click").then((outcome) => outcome, (err: unknown) => err);
}

describe("internal #324 — a click on a text field aimed by handle", () => {
  it("is the engine's own code", () => {
    expect(rustCode()).toBe("FocusedTextField");
  });

  it("succeeds through UIA when the engine moved the focus into the field", async () => {
    clickElement.mockResolvedValue({ ok: true, element: "ta-field", code: rustCode(), focusedBy: "uia", via: "native" });
    expect(await click()).toBe("uia");
    expect(clickElement.mock.calls[0]![4]).toEqual({ hwnd: 4919n });
    // The record says it was a focus, not a press.
    const route = probeAim.mock.calls.find((c) => c[0] === "act.route")?.[1];
    expect(route).toMatchObject({ route: "uia", why: "uia_invoke", focusedTextField: true, focusedBy: "uia" });
  });

  it("records an ordinary press as one (the control)", async () => {
    clickElement.mockResolvedValue({ ok: true, element: "ta-field", focusedBy: "uia", via: "native" });
    expect(await click()).toBe("uia");
    const route = probeAim.mock.calls.find((c) => c[0] === "act.route")?.[1];
    expect(route).toMatchObject({ why: "uia_invoke" });
    expect(route).toMatchObject({ focusedTextField: false });
  });

  it("is still refused, not pressed by coordinates, when the focus was not moved", async () => {
    clickElement.mockResolvedValue({ ok: false, code: "PatternNotSupported", error: rustRefusal(), focusedBy: "kept_behind", via: "native" });
    const thrown = await click();
    expect((thrown as Error).name).toBe("AimedRouteFailedError");
    // The reason the caller is told survives (win2 on #878: a changed sentence dropped it).
    expect(classifyUiaRouteFailure(new Error(rustRefusal()))).toBeDefined();
  });
});
