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
  AimedRouteFailedError,
  AimBlockedByExcludedWindowError,
} from "../../src/engine/aim.js";
import { WindowExcludedError } from "../../src/engine/tool-exclusion.js";
import {
  AimPointOutsideWindowError,
  AimRouteFailedError,
  WindowExcludedRefusalError,
  AimBlockedByExcludedRefusalError,
  CursorPlacementBlockedError,
  CoordinateOutsideReachableBoundsError,
} from "../../src/errors/typed-errors.js";
import { toFailureEnvelope } from "../../src/tools/_envelope.js";
import { Err } from "../../src/types/result.js";
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

  it("says an aimed act was not finished blind, not that the executor failed", async () => {
    const { loop, lease } = loopThatThrows(
      new AimedRouteFailedError("UIA click failed on window 4919: Element not found", 4919n),
    );
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("aim_route_failed");
  });

  it("says the window is excluded, which is a refusal and not a route that failed", async () => {
    const { loop, lease } = loopThatThrows(
      new WindowExcludedError("WindowExcluded: target window belongs to the key locker"),
    );
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("window_excluded");
  });

  it("keeps the coordinate case apart from the target case, because the advice differs", async () => {
    // Same registry, opposite statements about the window the CALLER named: `window_excluded` means
    // "the one you addressed is out of bounds", this means "yours is fine, something else is over
    // the point". They shared a reason for one commit, and the caller was then told their own
    // window was excluded and to go act on a different one (gate 2, Opus sandbox review).
    const { loop, lease } = loopThatThrows(
      new AimBlockedByExcludedWindowError("Refusing to click (140, 215) for \"Save\": a window this server may not act through is over that point."),
    );
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("aim_blocked_by_excluded_window");
      // The sentence travels — that is item 13 — and it is the one the thrower chose to publish.
      expect(result.detail).toMatch(/may not act through/);
      // …and it is not the other refusal's sentence.
      expect(result.detail).not.toMatch(/key locker/i);
    }
  });

  it("publishes the same reason the loop reported, which the class name alone decides", async () => {
    // Two surfaces, one refusal. `desktop_act`'s catalogue documents the reason the loop reports,
    // while the RAW (non-opt-in) shape derives its `reason` from the typed error's name through
    // `pascalToSnake`. A class named one word short of the reason published two different strings
    // for one failure, and a client following the documented contract would not recognise the
    // short one (PR 側 codex on #618, P2).
    const raw = (e: Error) => (toFailureEnvelope(Err(e), { optIn: false }) as { reason?: string }).reason;
    expect(raw(new AimBlockedByExcludedRefusalError("x"))).toBe("aim_blocked_by_excluded_window");
    // The control: the same derivation on the refusals that were already right. Without these the
    // assertion above could be satisfied by a special case rather than by the naming rule.
    expect(raw(new WindowExcludedRefusalError("x"))).toBe("window_excluded");
    expect(raw(new AimPointOutsideWindowError("x"))).toBe("aim_point_outside_window");
    expect(raw(new AimRouteFailedError("x"))).toBe("aim_route_failed");
  });

  it("carries a detail for the two pointer refusals, whose advice already points at the field", async () => {
    // Both classes are purpose-written and engine-authored — coordinates, a monitor layout, and
    // which of the named cases applies — so there is nothing foreign to leak and the opt-in should
    // have covered them from the start. It did not, and the advice this branch added tells the
    // caller to read `if_unexpected.detail`: an envelope naming a field that never appears, which
    // is the defect item 13 exists to close, reintroduced by the line describing the fix.
    const cursor = new CursorPlacementBlockedError(
      "CursorPlacementBlocked: the cursor could not be moved to (140, 215), which is on a connected monitor.",
    );
    const cursorResult = await loopThatThrows(cursor).loop.touch({ lease: loopThatThrows(cursor).lease });
    expect(cursorResult.ok).toBe(false);
    if (!cursorResult.ok) {
      expect(cursorResult.reason).toBe("cursor_placement_blocked");
      expect(cursorResult.detail).toMatch(/on a connected monitor/);
    }
    const bounds = new CoordinateOutsideReachableBoundsError(
      "CoordinateOutsideReachableBounds: (9999, 9999) is on no connected monitor.",
    );
    const boundsResult = await loopThatThrows(bounds).loop.touch({ lease: loopThatThrows(bounds).lease });
    expect(boundsResult.ok).toBe(false);
    if (!boundsResult.ok) {
      expect(boundsResult.reason).toBe("coordinate_outside_reachable_bounds");
      expect(boundsResult.detail).toMatch(/no connected monitor/);
    }
  });

  it("matches names the classes actually carry", () => {
    // Same seam as the existing arm in `guarded-touch.test.ts`: the catch arms hold a string, the
    // classes hold a string, and nothing but this joins them. Rename one side and every refusal
    // above is silently demoted to `executor_failed` — with a green suite.
    expect(new AimedPointOutsideWindowError("x").name).toBe("AimedPointOutsideWindowError");
    expect(new AimedRouteFailedError("x").name).toBe("AimedRouteFailedError");
    expect(new WindowExcludedError("x").name).toBe("WindowExcludedError");
    expect(new AimBlockedByExcludedWindowError("x").name).toBe("AimBlockedByExcludedWindowError");
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

  for (const name of ["AimPointOutsideWindow", "AimRouteFailed", "WindowExcluded", "AimBlockedByExcludedWindow"]) {
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

  it("promises the distinction only where the detail carries it", async () => {
    // The advice for this reason listed "the control supports no pattern" as THE failure and sent
    // the caller to `if_unexpected.detail` for the specifics, while the detail was deliberately
    // generic — so the caller could not tell "no pattern" from "element not found", which have
    // different recoveries (PR 側 codex on #618, P2). It was narrowed then rather than filled: the
    // classification that would let the advice keep its promise had to be written against the real
    // backend messages, and those live on Windows.
    //
    // win2 collected them (2026-09-11, `dev/route-failure-strings/RESULTS.md`), and the detail now
    // names the failure when the answer is a known one. The advice promises exactly that and no
    // more: an answer the classifier does not recognise is still withheld, and the line says so.
    const advice = (await adviceFor("AimRouteFailed")).join(" ");
    expect(advice).toMatch(/when the backend's answer is one this server recognises/);
    expect(advice).toMatch(/says nothing more when it is not/);
    // The control: a reason whose detail DOES carry the specifics still says so, so this cell is
    // about honesty per reason and not a blanket ban on pointing at the field.
    expect((await adviceFor("AimOccluded")).join(" ")).toMatch(/detail field in if_unexpected names the window/);
  });

  it("puts the detail before the re-discover, which helps only one of the failures it names", async () => {
    // For three of the four failures the detail can name, a fresh discover finds the same element
    // giving the same answer. Advice that opens with "re-run desktop_discover" spends the caller's
    // first round trip on it anyway (win の外からの読み, #622).
    const advice = await adviceFor("AimRouteFailed");
    expect(advice[0]).toMatch(/^if_unexpected\.detail says which failure it was/);
    const rediscover = advice.find((line) => /re-run desktop_discover/i.test(line));
    expect(rediscover).toMatch(/^When the detail names no failure, or says the element was not found/);
  });

  it("renders each envelope-side class under the name its advice is filed under", () => {
    // `toFailureEnvelope` looks the advice up by `name`; a class whose name drifts gets the
    // generic entry and no test would notice, because the envelope still has a `try_next`.
    expect(new AimPointOutsideWindowError("x").name).toBe("AimPointOutsideWindow");
    expect(new AimRouteFailedError("x").name).toBe("AimRouteFailed");
    expect(new WindowExcludedRefusalError("x").name).toBe("WindowExcluded");
    expect(new AimBlockedByExcludedRefusalError("x").name).toBe("AimBlockedByExcludedWindow");
  });

  it("does not tell a caller whose window is fine that their window is the excluded one", async () => {
    // The half a shared code got wrong. `WindowExcluded`'s advice opens with "This window is
    // excluded ... Nothing was done to it" and closes by naming the key locker's own dialog — true
    // for a caller who addressed the locker, false for one whose own window is merely covered, and
    // the identification is exactly what the refusal's detail is written to withhold.
    const covered = await adviceFor("AimBlockedByExcludedWindow");
    const joined = covered.join(" ");
    expect(joined).not.toMatch(/key locker/i);
    expect(joined).toMatch(/NOT the excluded one/i);
    // A recovery that works on a window that is fine, rather than "go act on a different window".
    expect(joined).toMatch(/click_element/);
    // The control: the target case still says both of the things this one must not.
    const addressed = await adviceFor("WindowExcluded");
    expect(addressed.join(" ")).toMatch(/key locker/i);
    expect(addressed.join(" ")).toMatch(/Act on another window/i);
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

/**
 * ADR-036 item 13 — the envelope carries what the layer that refused knew, or the refusal is a code.
 *
 * The nine act-path refusals are REBUILT in `desktop-register.ts` from the reason alone, so the
 * engine's sentence — which names the covering window, the identity field that changed, the
 * rectangle the point left — stopped at `GuardedTouchLoop`. Measured on the real machine before
 * the fix (win2, 2026-09-10, `dev/item13-envelope/`): an `aim_occluded` response carried neither
 * the blocker's title nor its handle, and had no message field at all.
 *
 * These cells pin the two halves that make the sentence reach a caller: the envelope has a place
 * to put it, and an absent detail stays absent rather than becoming an empty string.
 */
describe("the envelope carries the refusing layer's own words", () => {
  it("puts the detail where the advice says to look", async () => {
    const { toFailureEnvelope } = await import("../../src/tools/_envelope.js");
    const detail = 'Refusing to press (426, 287) for the window this act named (hwnd 4919): the window on top at that point is "BLOCKER-CELL" (hwnd 777), so the press would go there.';
    const failure = toFailureEnvelope(
      { ok: false, error: new AimPointOutsideWindowError("AimPointOutsideWindow: …") },
      { optIn: true, detail },
    ) as { if_unexpected: { most_likely_cause: string; detail?: string } };
    expect(failure.if_unexpected.detail).toBe(detail);
    // The code still decides the advice — the detail is additive, not a replacement for either.
    expect(failure.if_unexpected.most_likely_cause).toBe("AimPointOutsideWindow");
  });

  it("omits the field rather than carrying an empty one", async () => {
    const { toFailureEnvelope } = await import("../../src/tools/_envelope.js");
    for (const detail of [undefined, "", "   "]) {
      const failure = toFailureEnvelope(
        { ok: false, error: new AimPointOutsideWindowError("AimPointOutsideWindow: …") },
        { optIn: true, detail },
      ) as { if_unexpected: Record<string, unknown> };
      expect("detail" in failure.if_unexpected).toBe(false);
    }
  });

  it("the advice for an occluded aim points at the field by name", async () => {
    // The line that names the covering window was REMOVED on 2026-09-10 because it pointed at a
    // message the caller never receives, with a note that it comes back when item 13 lands. It is
    // back — and it names `if_unexpected.detail`, not "the message", because a caller can only
    // read a field that is in the response.
    const { getSuggestsForCode } = await import("../../src/tools/_errors.js");
    const advice = getSuggestsForCode("AimOccluded");
    expect(advice.some((a) => /detail field in if_unexpected/.test(a))).toBe(true);
    expect(advice.some((a) => /read the message|the message names/i.test(a))).toBe(false);
    // And it does not promise a title the detail sometimes cannot give: the OS road can answer with
    // a captionless window, where the engine's sentence says "an untitled window" (gate 2).
    expect(advice.some((a) => /its handle always, its title when it has one/.test(a))).toBe(true);
  });
});

/**
 * ADR-036 item 13 — what a caller-facing sentence may contain.
 *
 * Two rounds found the same shape on two roads: a message written when nothing outside the process
 * read it, published the moment `detail` existed. win2's round caught `keyboardTypeBg` — an internal
 * dep name — inside a `type` ladder's text (2026-09-10, `dev/item13-detail/`), and their scan for
 * paths, PowerShell, HRESULTs and stack frames matched none of it: **a regex list finds the shapes
 * someone thought of.** So these cells check the rule instead — a caller sentence is written on
 * purpose, and the branches that dump internal records stay in `message`.
 */
describe("a published sentence carries no developer-facing text", () => {
  it("does not put the identity records in the caller's copy", async () => {
    const { AimIdentityChangedError } = await import("../../src/engine/aim.js");
    const then = { pid: 100, processName: "notepad.exe", processStartTimeMs: 1, className: "Notepad" };
    // Same pid, same start time, same class: the comparator would have to have decided on something
    // this build does not name — the branch that prints both records whole.
    const now = { pid: 100, processName: "notepad.exe", processStartTimeMs: 1, className: "Notepad" };
    const e = new AimIdentityChangedError(4919n, then, now);
    expect(e.message).toContain("processStartTimeMs");   // the log keeps the dump
    expect(e.callerDetail).not.toContain("processStartTimeMs");
    expect(e.callerDetail).not.toContain("{");
    expect(e.callerDetail).toContain("does not name yet");
  });

  it("names the process and class when it can, because that is what the advice promises", async () => {
    const { AimIdentityChangedError } = await import("../../src/engine/aim.js");
    const then = { pid: 100, processName: "notepad.exe", processStartTimeMs: 1, className: "Notepad" };
    const now  = { pid: 250, processName: "explorer.exe", processStartTimeMs: 2, className: "CabinetWClass" };
    const e = new AimIdentityChangedError(4919n, then, now);
    expect(e.callerDetail).toContain("notepad.exe");
    expect(e.callerDetail).toContain("explorer.exe");
  });

  it("the route-failure publishes its own sentence, not the backend's", async () => {
    // The leak gate 2 found: this error's message quotes the failure it reports, and on the UIA road
    // that is a PowerShell rejection carrying the whole script — with the typed text interpolated
    // into it on the `type` road.
    const { AimedRouteFailedError } = await import("../../src/engine/aim.js");
    const e = new AimedRouteFailedError(
      'UIA click failed: Command failed: powershell.exe -NoProfile -Command "…$secret…"',
      4919n,
      undefined,
      "The UIA route to window 4919 failed, and the act was not finished as a coordinate click.",
    );
    expect(e.message).toContain("powershell.exe");
    expect(e.callerDetail).not.toContain("powershell.exe");
    expect(e.callerDetail).not.toContain("Command failed");
  });
});
