/**
 * internal #154 — an action the caller did not ask for must not be performed on the world.
 *
 * MEASURED, win2, 2026-09-21, on `main` `c8f87c4f`, one act per arm with a WinForms fixture's own
 * click log read before and after each one:
 *
 *   arm  action     response                                                  button pressed?
 *   W1   click      {"ok":true,"executor":"uia","diff":[],"next":"none"}      yes  (control)
 *   W2   select     THE SAME BYTES                                            **YES**
 *   W4   invoke     THE SAME BYTES                                            yes  (control)
 *
 * W1, W2 and W4 are byte-identical, so a caller cannot tell "I pressed it because you asked" from
 * "I pressed it because there was nothing else to do with `select`". Whatever the button does —
 * submit, delete, send — happened.
 *
 * **THAT IS ONE STEP PAST THE FORBIDDEN ROAD.** The user named "a success reported for an act that
 * did not happen" on 2026-09-11. This is an act that DID happen and was not asked for.
 *
 * **AND IT IS NOT ABOUT BUTTONS.** `uiaActionability` and `cdpActionability` both return
 * `Array<"click" | "invoke" | "type" | "read">` — `"select"` is not in the type. No provider in this
 * product can advertise it, so every `select` the schema invites took the substitution. win2
 * measured one button; the cause is the whole road. The cell below pins that as a property of the
 * PRODUCERS, because a fix aimed at buttons would leave the rest.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { GuardedTouchLoop, type TouchAction } from "../../src/engine/world-graph/guarded-touch.js";
import { LeaseStore } from "../../src/engine/world-graph/lease-store.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import { getSuggestsForCode } from "../../src/tools/_errors.js";

/** A button as the resolver builds one: `invoke` and `click`, and nothing else. */
const button = (): UiEntity => ({
  entityId: "ent_button",
  role: "button",
  label: "TARGET",
  rect: { x: 10, y: 10, width: 80, height: 24 },
  confidence: 1,
  sources: ["uia"],
  affordances: [{ verb: "invoke" }, { verb: "click" }],
  locator: { uia: { name: "TARGET" } },
  generation: "gen-1",
  evidenceDigest: "d-button",
} as unknown as UiEntity);

/** The same shape as a provider that DOES advertise selection would build it. */
const selectable = (): UiEntity => ({
  ...button(),
  entityId: "ent_listitem",
  role: "listitem",
  affordances: [{ verb: "select" }, { verb: "click" }],
  evidenceDigest: "d-listitem",
} as unknown as UiEntity);

/**
 * The real loop, with an executor that RECORDS instead of acting — so "was anything done" is
 * answered by the harness and not by the response, the same separation win2's fixture log gives on
 * the machine. Everything else is the product's own `GuardedTouchLoop` and `LeaseStore`.
 */
async function act(
  entity: UiEntity,
  action: TouchAction,
  opts: { modal?: boolean; windowBlocked?: boolean } = {},
) {
  const performed: TouchAction[] = [];
  const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
  const lease = store.issue(entity, "view-1");
  const loop = new GuardedTouchLoop(store, {
    resolveLiveEntities:      () => [entity],
    currentGeneration:        () => "gen-1",
    // **TWO environment refusals, not one** — the loop asks the OS first (`findBlockingWindow`) and
    // only then the snapshot (`isModalBlocking`). A cell that drives just one of them cannot see the
    // guard being moved past the other: measured, the first version of this file was green on a
    // mutation that slid the guard between them.
    findBlockingWindow:       () => (opts.windowBlocked === true
      ? { kind: "blocked", blocker: { entityId: "blocker", role: "dialog" } }
      : { kind: "cannot_say" }),
    isModalBlocking:          () => opts.modal === true,
    checkViewport:            () => null,
    execute:                  async (_e: UiEntity, a: TouchAction) => { performed.push(a); return "uia"; },
    resolvePostTouchEntities: async () => [entity],
  } as never);
  const result = (await loop.touch({ lease, action })) as { ok: boolean; reason?: string };
  return { result, performed };
}

describe("internal #154 — an action the target does not offer", () => {
  it("does not press a button that was asked to select, and says nothing was done", async () => {
    // THE MUTATION THIS KILLS: deleting the guard, which restores the measured behaviour exactly —
    // `ok:true`, executor `uia`, and the button pressed.
    const { result, performed } = await act(button(), "select");
    expect(result.ok, "the caller was told the act succeeded").toBe(false);
    expect(result.reason).toBe("action_not_offered");
    // **The load-bearing assertion is this one.** A refusal that still ran the executor would pass
    // every assertion above while doing exactly what the issue is about.
    expect(performed, "the executor ran for an action the target does not offer").toEqual([]);
  });

  it("CONTROL: the actions the target DOES offer still reach the executor", async () => {
    // Without this, "refuse everything" passes the cell above. Two answers must look different.
    for (const action of ["click", "invoke"] as const) {
      const { result, performed } = await act(button(), action);
      expect(result.ok, `${action} was refused`).toBe(true);
      expect(performed, `${action} did not reach the executor`).toEqual([action]);
    }
  });

  it("CONTROL: select is served when the target really offers it", async () => {
    // The guard is written as "not among the affordances", not "always refuse", so a provider that
    // later advertises the verb is served. If this ever goes red, the guard has become a blanket ban
    // and the comment in `guarded-touch.ts` is describing something the code no longer does.
    const { result, performed } = await act(selectable(), "select");
    expect(result.ok).toBe(true);
    expect(performed).toEqual(["select"]);
  });

  it("refuses before EITHER environment check, because no environment change fixes it", async () => {
    // Order matters for what the caller does next. Told `modal_blocking`, a caller dismisses the
    // modal, retries — and gets the press this refusal exists to stop.
    //
    // **BOTH checks are driven, and the first version of this cell drove only one.** The loop asks
    // the OS (`findBlockingWindow`) before the snapshot (`isModalBlocking`), so a mutation that slid
    // the guard between them left every cell in this file green — measured. One arm per check now.
    for (const env of [{ modal: true }, { windowBlocked: true }] as const) {
      const { result, performed } = await act(button(), "select", env);
      expect(result.reason, `answered by the environment first: ${JSON.stringify(env)}`).toBe(
        "action_not_offered",
      );
      expect(performed).toEqual([]);
    }
    // CONTROLS: each environment check really does refuse on its own, so the arms above are not
    // passing because the harness failed to arm them.
    for (const [env, reason] of [
      [{ modal: true }, "modal_blocking"],
      [{ windowBlocked: true }, "modal_blocking"],
    ] as const) {
      const { result } = await act(button(), "click", env);
      expect(result.reason, `the env check did not fire at all: ${JSON.stringify(env)}`).toBe(reason);
    }
  });

  it("no provider in this product advertises `select`, which is why this is not a button problem", () => {
    // **The producers, not the symptom.** A fix aimed at buttons would leave every other target
    // taking the substitution. Read from source: both actionability tables return a union that does
    // not contain the verb.
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(`../../src/tools/desktop-providers/${rel}`, import.meta.url)), "utf8");
    for (const [file, fn] of [
      ["uia-provider.ts", "uiaActionability"],
      ["browser-provider.ts", "cdpActionability"],
    ] as const) {
      const text = read(file);
      const at = text.indexOf(`function ${fn}(`);
      expect(at, `${fn} is gone — this cell is describing a function that no longer exists`).toBeGreaterThan(-1);
      const signature = text.slice(at, text.indexOf("{", text.indexOf(")", at)));
      expect(signature, `${fn}'s return type`).toContain("Array<");
      expect(signature, `${fn} can now advertise select — the refusal above is no longer total`).not.toContain("select");
    }
    // The control: the same read DOES find the verbs that are advertised, so a signature that
    // stopped matching would not pass as "select is absent".
    expect(read("uia-provider.ts")).toContain('"invoke", "click"');
  });

  it("the advice tells the caller which action to ask for instead", async () => {
    // A refusal whose advice does not name the alternative leaves the caller where they started —
    // and the road this replaces answered `ok:true`, so they have no other way to learn.
    const advice = getSuggestsForCode("ActionNotOffered");
    expect(advice.length).toBeGreaterThanOrEqual(3);
    const joined = advice.join("\n");
    expect(joined, "nothing was done — the part that separates this from executor_failed").toMatch(
      /nothing was done|not a road that was tried/i,
    );
    expect(joined, "the alternative is not named").toMatch(/action='click'|action='invoke'/);
    expect(joined, "the substitution is not warned about").toMatch(/interchangeable|substituted/i);
  });
});
