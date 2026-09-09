/**
 * A refusal that arrives as `executor_failed` is not a refusal.
 *
 * ADR-036 added three of them to the executor — the aimed point is no longer inside the window,
 * the UIA route failed on a window named by handle, the window may not be touched at all — and
 * each threw a plain `Error`. `GuardedTouchLoop` reports `executor_failed` for anything it cannot
 * name, and that reason's published FIRST suggestion is, verbatim, "fall back to mouse_click
 * ({clickAt}) using the entity rect center from desktop_discover". That is the press all three
 * branches exist to prevent: the executor closed the door and the envelope handed back the key
 * (PR 側 codex, three findings on 2026-09-09; win2 confirmed all three were introduced by this
 * branch and that the four `try_next` lines come back identical for each).
 *
 * So these tests pin both halves — the reason the loop reports, and the fact that the advice for
 * that reason does NOT name the coordinate press. Pinning only the reason would let the wiring
 * pass while the advice stayed generic, which is exactly how `AimWindowGone` shipped its first
 * round (see `every-typed-error-tells-you-what-to-do.test.ts`).
 */
import { describe, it, expect } from "vitest";
import {
  AimedPointOutsideWindowError,
  AimedUiaClickFailedError,
} from "../../src/engine/aim.js";
import { WindowExcludedError } from "../../src/engine/tool-exclusion.js";
import {
  AimPointOutsideWindowError,
  AimedUiaClickFailedError as AimedUiaClickFailedEnvelopeError,
  WindowExcludedRefusalError,
} from "../../src/errors/typed-errors.js";
import { GuardedTouchLoop, type TouchEnvironment } from "../../src/engine/world-graph/guarded-touch.js";
import { LeaseStore } from "../../src/engine/world-graph/lease-store.js";
import { detectUiaBlind } from "../../src/engine/uia-bridge.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

const GEN = "gen-1";

function entity(): UiEntity {
  return {
    entityId: "e1",
    role: "button",
    label: "Close",
    confidence: 0.9,
    sources: ["visual_gpu"],
    affordances: [
      { verb: "invoke", executors: ["uia", "mouse"], confidence: 0.9, preconditions: [], postconditions: [] },
    ],
    generation: GEN,
    evidenceDigest: "d-e1",
    rect: { x: 100, y: 200, width: 80, height: 30 },
  };
}

function loopThatThrows(err: Error): { loop: GuardedTouchLoop; lease: ReturnType<LeaseStore["issue"]> } {
  const e = entity();
  const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
  const lease = store.issue(e, "view-1");
  const env: TouchEnvironment = {
    resolveLiveEntities:      () => [e],
    currentGeneration:        () => GEN,
    isModalBlocking:          () => false,
    checkViewport:            () => null,
    // The real classes, not an `Error` wearing their names: the catch matches on `name`, so a
    // test that assigns the string itself would only prove the string equals the string.
    execute:                  async () => { throw err; },
    resolvePostTouchEntities: async () => [],
  };
  return { loop: new GuardedTouchLoop(store, env), lease };
}

describe("the loop keeps each refusal's own name", () => {
  it("says the aimed point left the window, not that the executor failed", async () => {
    const { loop, lease } = loopThatThrows(
      new AimedPointOutsideWindowError("Refusing to click (10, 10): window moved", 4919n),
    );
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("aim_point_outside_window");
  });

  it("says an aimed UIA click was not finished blind, not that the executor failed", async () => {
    const { loop, lease } = loopThatThrows(
      new AimedUiaClickFailedError("UIA click failed on window 4919: Element not found", 4919n),
    );
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("aimed_uia_click_failed");
  });

  it("says the window is excluded, which is a refusal and not a route that failed", async () => {
    const { loop, lease } = loopThatThrows(
      new WindowExcludedError("WindowExcluded: target window belongs to the key locker"),
    );
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("window_excluded");
  });

  it("matches names the classes actually carry", () => {
    // Same seam as the existing arm in `guarded-touch.test.ts`: the catch arms hold a string, the
    // classes hold a string, and nothing but this joins them. Rename one side and every refusal
    // above is silently demoted to `executor_failed` — with a green suite.
    expect(new AimedPointOutsideWindowError("x").name).toBe("AimedPointOutsideWindowError");
    expect(new AimedUiaClickFailedError("x").name).toBe("AimedUiaClickFailedError");
    expect(new WindowExcludedError("x").name).toBe("WindowExcludedError");
  });
});

describe("the advice for a refusal does not name the press it refused", () => {
  /**
   * Read from the shipped table rather than from a rendered envelope: `toFailureEnvelope` resolves
   * `try_next` from `SUGGESTS` by the typed error's `name`, so the table IS what the caller gets,
   * and reading it here keeps the assertion about the words rather than about the plumbing (the
   * plumbing has its own snapshot test).
   */
  async function adviceFor(name: string): Promise<string[]> {
    // `getSuggestsForCode` is the accessor `toFailureEnvelope` itself uses, so this reads the same
    // table by the same key the caller's envelope will be built from.
    const { getSuggestsForCode } = await import("../../src/tools/_errors.js");
    const entry = getSuggestsForCode(name);
    expect(entry.length, `${name} has no SUGGESTS entry`).toBeGreaterThan(0);
    return entry;
  }

  it("still says exactly that in the generic advice — the control for the three below", async () => {
    // Without this line the three assertions below could pass because the phrase moved or was
    // reworded, not because the refusals stopped inheriting it. This is the state we are steering
    // away from, so it has to be visible in the same run.
    const generic = await adviceFor("ExecutorFailed");
    expect(generic.join(" ")).toMatch(/mouse_click/);
  });

  for (const name of ["AimPointOutsideWindow", "AimedUiaClickFailed", "WindowExcluded"]) {
    it(`${name} never tells the caller to press the coordinate it just refused`, async () => {
      const advice = await adviceFor(name);
      const joined = advice.join(" ");
      // The refusals may NAME mouse_click to forbid it — "Do NOT retry by coordinate" is the
      // load-bearing line — so the assertion is about instruction, not about the token: no line
      // may recommend the press.
      for (const line of advice) {
        const mentionsCoordinatePress = /mouse_click|rect center|by coordinate/i.test(line);
        if (!mentionsCoordinatePress) continue;
        expect(line, `${name} suggests the press it refused: ${line}`).toMatch(/do not|never|cannot/i);
      }
      expect(joined).toMatch(/desktop_discover|another window/i);
      expect(advice.length).toBeGreaterThanOrEqual(2);
    });
  }

  it("renders each envelope-side class under the name its advice is filed under", () => {
    // `toFailureEnvelope` looks the advice up by `name`; a class whose name drifts gets the
    // generic entry and no test would notice, because the envelope still has a `try_next`.
    expect(new AimPointOutsideWindowError("x").name).toBe("AimPointOutsideWindow");
    expect(new AimedUiaClickFailedEnvelopeError("x").name).toBe("AimedUiaClickFailed");
    expect(new WindowExcludedRefusalError("x").name).toBe("WindowExcluded");
  });
});

describe("a truncated UIA walk is not evidence of a sparse window", () => {
  /**
   * Both `detectUiaBlind` conditions are counts, and a truncated walk's count describes the prefix
   * that came back before the deadline. The same window read twice — once with room, once against
   * the floor — must not change diagnosis, or the verdict is a property of the clock (win2's
   * framing, 2026-09-09).
   */
  function result(over: Partial<Parameters<typeof detectUiaBlind>[0]>): Parameters<typeof detectUiaBlind>[0] {
    return {
      windowTitle: "Untitled - Notepad",
      elementCount: 26,
      truncated: false,
      elements: [],
      ...over,
    } as Parameters<typeof detectUiaBlind>[0];
  }

  it("calls a short tree blind when the walk finished", () => {
    expect(detectUiaBlind(result({ elementCount: 2 }))).toEqual({ blind: true, reason: "too-few-elements" });
  });

  it("declines to call the same tree blind when the walk was cut short", () => {
    const verdict = detectUiaBlind(result({ elementCount: 2, truncated: true }));
    expect(verdict.blind).toBe(false);
    // Distinguishable from a healthy tree: "no evidence" and "evidence of health" are different
    // answers, and a caller that logs the verdict has to be able to tell them apart.
    expect(verdict).toEqual({ blind: false, undecided: "truncated_tree" });
  });

  it("declines the single-giant-pane verdict too, which the report did not mention", () => {
    // codex named only the sparsity branch. The pane branch counts as well — "fewer than five
    // actionable siblings" — so a walk cut short inside a Pane satisfies it for the same wrong
    // reason. Guarding one branch would have left the other (win2).
    const pane = {
      controlType: "Pane",
      name: "Root",
      isEnabled: true,
      boundingRect: { x: 0, y: 0, width: 1000, height: 800 },
    };
    const windowRect = { x: 0, y: 0, width: 1000, height: 800 };
    const cutShort = result({ elementCount: 6, truncated: true, elements: [pane], windowRect } as never);
    const finished = result({ elementCount: 6, truncated: false, elements: [pane], windowRect } as never);
    expect(detectUiaBlind(finished)).toEqual({ blind: true, reason: "single-giant-pane" });
    expect(detectUiaBlind(cutShort)).toEqual({ blind: false, undecided: "truncated_tree" });
  });
});
