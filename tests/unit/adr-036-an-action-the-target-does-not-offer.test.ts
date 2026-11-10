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
 * internal #233 PR2 (2026-11-10) made `select` real on one kind of target: a UIA collection item that
 * exposes SelectionItemPattern, where the executor's click already selects (#819). Everywhere else the
 * refusal stands, and the cells below pin both sides.
 */
import { describe, it, expect } from "vitest";

import { GuardedTouchLoop, type TouchAction } from "../../src/engine/world-graph/guarded-touch.js";
import { LeaseStore } from "../../src/engine/world-graph/lease-store.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import { getSuggestsForCode } from "../../src/tools/_errors.js";
import { uiaActionability, uiaRoleFromControlType } from "../../src/tools/desktop-providers/uia-provider.js";
import { resolveCandidates } from "../../src/engine/world-graph/resolver.js";

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

/**
 * A list item as the resolver builds one from UIA (internal #233 PR2): the real executor takes its click
 * to the select road (#819), so a loop that hands `select` over as `click` is the road that exists —
 * the cells below pin the loop's half, and `a-click-on-a-list-item-selects-it.test.ts` the executor's.
 */
const listItem = (over: Partial<UiEntity> = {}): UiEntity => ({
  entityId: "ent_item",
  role: "listitem",
  label: "ITEM",
  confidence: 1,
  sources: ["uia"],
  controlType: "ListItem",
  patterns: ["SelectionItemPattern", "InvokePattern"],
  affordances: [{ verb: "select" }, { verb: "click" }, { verb: "invoke" }],
  locator: { uia: { name: "ITEM" } },
  generation: "gen-1",
  evidenceDigest: "d-item",
  ...over,
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

  it("select is accepted only on a UIA collection item that offers it, and reaches the executor as its click (internal #233 PR2)", async () => {
    // The executor has no select arm. On a collection item a click takes the select road (#819:
    // SelectionItem.Select, never Invoke), so that is what the loop hands over.
    const { result, performed } = await act(listItem(), "select");
    expect(result.ok).toBe(true);
    expect(performed).toEqual(["click"]);
    // Refused, nothing done: an item without the verb (no SelectionItemPattern), a non-UIA source, and a
    // button that lists the verb anyway — on any of them the click would press, not select.
    for (const entity of [
      listItem({ affordances: [{ verb: "click" }, { verb: "invoke" }] }),
      listItem({ sources: ["visual_gpu"] }),
      { ...button(), affordances: [{ verb: "select" }, { verb: "invoke" }, { verb: "click" }] } as unknown as UiEntity,
    ]) {
      const refused = await act(entity, "select");
      expect(refused.result.reason).toBe("action_not_offered");
      expect(refused.performed).toEqual([]);
    }
  });

  it("auto never invokes a collection item: one with Invoke and no SelectionItem is clicked (gate 2 on #919)", async () => {
    // A DataGridView cell: Invoke starts editing it, a ListItem's Invoke opens it like a double-click.
    const cell = listItem({ controlType: "DataItem", patterns: ["InvokePattern", "ValuePattern"], affordances: [{ verb: "click" }, { verb: "invoke" }] });
    expect((await act(cell, "auto")).performed).toEqual(["click"]);
    // An explicit invoke still opens it.
    expect((await act(cell, "invoke")).performed).toEqual(["invoke"]);
  });

  it("auto selects a collection item that offers select, rather than invoking (opening) it", async () => {
    const { performed } = await act(listItem(), "auto");
    expect(performed).toEqual(["click"]); // the select road
    // auto picked select itself, not a fall-back: with only select and type on offer, a missed select
    // would come out as type (agy on #919).
    expect((await act(listItem({ affordances: [{ verb: "select" }, { verb: "type" }] }), "auto")).performed).toEqual(["click"]);
    // An entity that lists select without being a collection item resolves auto to a verb it takes.
    const odd = { ...button(), affordances: [{ verb: "select" }, { verb: "invoke" }, { verb: "click" }] } as unknown as UiEntity;
    expect((await act(odd, "auto")).performed).toEqual(["invoke"]);
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

  it("a list item keeps the role listitem through the resolver", () => {
    const [entity] = resolveCandidates([{
      source: "uia", target: { kind: "window", id: "W" }, label: "ITEM", role: "listitem",
      rect: { x: 0, y: 0, width: 50, height: 20 }, actionability: ["select", "click", "invoke"],
      confidence: 0.9, observedAtMs: 0, provisional: false, controlType: "ListItem",
      patterns: ["SelectionItemPattern", "InvokePattern"], locator: { uia: { name: "ITEM" } },
    } as never]);
    expect(entity!.role).toBe("listitem");
    expect(entity!.affordances.map((a) => a.verb)).toEqual(["select", "click", "invoke"]);
  });

  it("the UIA provider gives list, tree and grid items the role listitem", () => {
    for (const ct of ["ListItem", "DataItem", "TreeItem"]) expect(uiaRoleFromControlType(ct)).toBe("listitem");
    expect(uiaRoleFromControlType("Button")).toBe("button");
    expect(uiaRoleFromControlType("Pane")).toBe("unknown");
  });

  it("the UIA provider offers select only on a collection item with SelectionItemPattern", () => {
    expect(uiaActionability("ListItem", ["SelectionItemPattern", "InvokePattern"])).toEqual(["select", "click", "invoke"]);
    expect(uiaActionability("TreeItem", ["SelectionItemPattern"])).toEqual(["select", "click"]);
    expect(uiaActionability("DataItem", ["SelectionItemPattern"])).toEqual(["select", "click"]);
    expect(uiaActionability("DataItem", ["InvokePattern", "ValuePattern"])).toEqual(["click", "invoke"]);
    for (const ct of ["Button", "CheckBox", "Edit", "ComboBox", "Text", "Pane"]) {
      expect(uiaActionability(ct, ["SelectionItemPattern"])).not.toContain("select");
    }
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

describe("internal #154 W3 — text into a control UI Automation says only presses", () => {
  // Measured, win2, 2026-09-21: setValue with text on a Button answered ok:true, executor keyboard —
  // no value was set, and the text went out as keystrokes.
  const pressOnly = ["Button", "CheckBox", "RadioButton", "Hyperlink", "MenuItem"];
  // The role each one gets from the UIA provider (`uiaRoleFromControlType`). Built with the real role,
  // because a guard keyed on `role === "button"` passed every cell while all five were built as
  // buttons — and would leave Hyperlink and MenuItem unguarded (gate 2 on #723, measured).
  const roleOf: Record<string, string> = { Button: "button", CheckBox: "button", RadioButton: "button", Hyperlink: "link", MenuItem: "menuitem" };

  for (const controlType of pressOnly) {
    it(`refuses setValue and type on a UIA ${controlType} (role ${roleOf[controlType]}), and nothing reaches the executor`, async () => {
      for (const action of ["setValue", "type"] as const) {
        const { result, performed } = await act({ ...button(), role: roleOf[controlType], controlType } as UiEntity, action);
        expect(result.ok, `${controlType}/${action} was told it succeeded`).toBe(false);
        expect(result.reason).toBe("action_not_offered");
        expect(performed, `${controlType}/${action} reached the executor`).toEqual([]);
      }
    });
  }

  it("the list the refusal reads is the list the UIA provider gives invoke/click to — exactly these five", async () => {
    const { UIA_PRESS_ONLY_CONTROL_TYPES } = await import("../../src/engine/world-graph/guarded-touch.js");
    expect([...UIA_PRESS_ONLY_CONTROL_TYPES]).toEqual(pressOnly);
    const src = (await import("node:fs")).readFileSync("src/tools/desktop-providers/uia-provider.ts", "utf8");
    expect(src, "the provider spells the list again instead of reading the shared one").toMatch(
      /if \(\(UIA_PRESS_ONLY_CONTROL_TYPES as readonly string\[\]\)\.includes\(ct\)\) return \["invoke", "click"\];/,
    );
  });

  // CONTROLS — the text roads that work today must still reach the executor. Each one is a reason
  // the ground is the UIA control type and not the affordances.
  const takesText: Array<[string, Partial<UiEntity>]> = [
    ["a UIA Edit", { role: "textbox", controlType: "Edit", affordances: [{ verb: "type" }, { verb: "click" }] }],
    // An editable combo box: the provider gives it type. "Allow only Edit and Document" passed the
    // cells without this one (gate 2 on #723).
    ["a UIA ComboBox", { role: "textbox", controlType: "ComboBox", affordances: [{ verb: "type" }, { verb: "click" }] }],
    // A custom text area outside every list: the commit names it as a reason for this ground.
    ["a UIA Custom control that advertises only read", { role: "unknown", controlType: "Custom", affordances: [{ verb: "read" }] }],
    // Notepad's body on the native road reports Document (win2 2b8f8c4); #327 item E's fallback.
    ["a UIA Document that advertises only read", { role: "label", controlType: "Document", affordances: [{ verb: "read" }] }],
    // A blind window: typing is the keyboard rung's designed marked success (release cut W-g).
    ["an OCR entity that advertises only click", { role: "label", sources: ["ocr"], affordances: [{ verb: "click" }], locator: undefined }],
    // The visual lane adds invoke to any region its detector calls a button: a guess, not a ground.
    ["a visual-lane 'button' with no UIA control type", { sources: ["visual_gpu"], locator: undefined }],
  ] as never;
  for (const [label, over] of takesText) {
    it(`CONTROL: ${label} still takes setValue and type`, async () => {
      for (const action of ["setValue", "type"] as const) {
        const { result, performed } = await act({ ...button(), ...over } as UiEntity, action);
        expect(result.ok, `${label}/${action} was refused`).toBe(true);
        expect(performed).toEqual([action]);
      }
    });
  }

  it("CONTROL: a UIA Button still takes click and invoke", async () => {
    for (const action of ["click", "invoke"] as const) {
      const { result, performed } = await act({ ...button(), controlType: "Button" } as UiEntity, action);
      expect(result.ok).toBe(true);
      expect(performed).toEqual([action]);
    }
  });
});
