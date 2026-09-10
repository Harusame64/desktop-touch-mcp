/**
 * The commonest way to name a window produces no handle at all, and every rung was gated on one.
 *
 * ADR-036 item 12. `desktop_discover({windowTitle: "Notepad"})` against an ordinary top-level
 * window goes through `_resolve-window.ts` **case 3**, which finds the match, emits the resolve
 * event, and then returns `null` **on purpose** — "preserve existing pass-through behaviour", so
 * the providers keep searching by title. The target therefore carries no `hwnd`,
 * `session.lastAim.hwnd` is `undefined`, and `desktop-executor.ts` gates the whole ladder behind
 * it: identity invalidation, occlusion, containment and the homing correction all silently skipped,
 * and a coordinate press goes out exactly as it did before this ADR began.
 *
 * The entity knows which window it came from. ADR-029 had to answer the same question for the
 * viewport gate, and `UiEntity.origin.hwnd` is its answer — the handle the CAPTURE resolved, not
 * a re-derivation of the query. Its JSDoc even carries this ADR's reasoning: re-resolving a title
 * at act time can select a different window if the z-order changed since discovery.
 *
 * So the part existed and the line to it did not, which is the shape this dig keeps finding.
 *
 * The handle it supplies is deliberately NOT the one the backends are addressed with: it decides
 * only where a coordinate press may land, so a wrong one costs a refusal rather than a press into
 * another window.
 */
import { describe, it, expect, vi } from "vitest";
import { createDesktopExecutor, type ExecutorDeps } from "../../src/tools/desktop-executor.js";
import { AimOccludedError, type Aim } from "../../src/engine/aim.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

const OBSERVED = 4919n;
const STRANGER = 777n;

/** A visual entity from a title-only discover: no handle on the aim, one on the entity. */
function entity(origin?: UiEntity["origin"]): UiEntity {
  return {
    entityId: "e1", role: "label", label: "Save", confidence: 0.9,
    sources: ["ocr"],
    affordances: [{ verb: "click", executors: ["mouse"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d",
    rect: { x: 100, y: 200, width: 80, height: 30 },
    ...(origin ? { origin } : {}),
  };
}

function deps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    uiaClick: vi.fn(async () => {}), uiaSetValue: vi.fn(async () => {}),
    cdpClick: vi.fn(async () => {}), cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}), keyboardTypeBg: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
    aimRect: vi.fn(async () => ({ x: 0, y: 0, width: 1000, height: 1000 })),
    ...over,
  };
}

/** What a title-only discover leaves behind: a title, and nothing else. */
const titleOnly: Aim = { kind: "aim", title: "Notepad" };

describe("a title-only discover still gets the coordinate ladder", () => {
  it("refuses a press a stranger would take, where before nothing was asked", async () => {
    const pointOwner = vi.fn(() => ({ kind: "other" as const, hwnd: STRANGER, title: "設定" }));
    const d = deps({ pointOwner });
    const exec = createDesktopExecutor(titleOnly, d);

    await expect(exec(entity({ kind: "window", id: "Notepad", hwnd: "4919" }), "click"))
      .rejects.toBeInstanceOf(AimOccludedError);
    expect(d.mouseClick).not.toHaveBeenCalled();
    // Asked about the window the ENTITY was observed in, not about the title.
    expect(pointOwner).toHaveBeenCalledWith(OBSERVED, 140, 215);
  });

  it("refuses a press that has left the window it was measured in", async () => {
    const d = deps({ aimRect: vi.fn(async () => ({ x: 5000, y: 5000, width: 100, height: 100 })) });
    const exec = createDesktopExecutor(titleOnly, d);
    await expect(exec(entity({ kind: "window", id: "Notepad", hwnd: "4919" }), "click"))
      .rejects.toThrow(/Refusing to click/);
  });

  it("does not correct the point, because there is no origin measured for that window", async () => {
    // The half this item does NOT buy: the origin rectangle is read at discover against the aim's
    // own handle, and a title-only discover has none to read it against. Occlusion and containment
    // run; the homing correction declines. Recorded so the gap is a decision, not an oversight.
    const d = deps();
    await createDesktopExecutor(titleOnly, d)(entity({ kind: "window", id: "Notepad", hwnd: "4919" }), "click");
    expect(d.mouseClick).toHaveBeenCalledWith(140, 215);
    // The coordinate alone cannot tell "the ladder ran and declined" from "the ladder never ran" —
    // both press the remembered point, and this cell stayed green under a full reversion of the
    // item (gate 2, 2026-09-10). That distinction is the file's whole subject, so the cell has to
    // read the rectangle the ladder went and fetched.
    expect(d.aimRect).toHaveBeenCalledWith(OBSERVED);
  });

  it("does not move the point by a delta measured in another window", async () => {
    // Gate 2 (2026-09-10), reproduced by construction. The rectangle in `aim.origin` was measured
    // around the window `toAim` resolved; the rectangle the ladder compares it against is now read
    // from the ENTITY's handle. An `Aim` carrying an origin but no handle makes those two different
    // windows, and the correction then moves the point by a delta nothing here has a reason for —
    // 100 px in each direction below, silently. Production never records such an aim, but the
    // invariant that stops it lives in `compose-providers.ts`, and a ladder that presses
    // coordinates must not depend on a caller it does not control.
    const originWithoutHandle: Aim = {
      kind: "aim", title: "Notepad",
      origin: { kind: "measured", rect: { x: 0, y: 0, width: 1000, height: 1000 } },
    };
    const d = deps({ aimRect: vi.fn(async () => ({ x: 100, y: 100, width: 1000, height: 1000 })) });
    await createDesktopExecutor(originWithoutHandle, d)(entity({ kind: "window", id: "Notepad", hwnd: "4919" }), "click");
    expect(d.mouseClick).toHaveBeenCalledWith(140, 215);   // not (240, 315)
  });

  it("refuses the press outright when the lanes disagreed about the window", async () => {
    // A missing handle means nobody looked, and the press goes out the way it always did. A
    // CONFLICT means two lanes looked and named different windows — there is nothing to check the
    // coordinates against, and reaching the same absent `coordHwnd` for both turned declining to
    // aim into pressing blind (PR 側 codex, 2026-09-10).
    const d = deps();
    const conflicted: UiEntity = {
      ...entity(),
      origin: { kind: "window", id: "Notepad", hwndConflict: true },
    };
    await expect(createDesktopExecutor(titleOnly, d)(conflicted, "click")).rejects.toThrow(/DIFFERENT windows/);
    expect(d.mouseClick).not.toHaveBeenCalled();
  });

  it("checks the UIA downgrade against that window too, not only the mouse road", async () => {
    // Gate 2 (2026-09-10): the ladder was given `coordHwnd` at one of the two coordinate presses in
    // this closure. When UIA fails and the call downgrades to the mouse, the point came from the
    // same entity and went out unchecked — with a `設定` window over it, `mouseClick` was issued and
    // `pointOwner` was never asked. Merged uia+ocr entities are the ladder's real traffic, so this
    // was the road that mattered.
    const pointOwner = vi.fn(() => ({ kind: "other" as const, hwnd: STRANGER, title: "設定" }));
    const d = deps({
      uiaClick: vi.fn(async () => { throw new Error("Element not found"); }),
      pointOwner,
    });
    const uiaEntity = {
      ...entity({ kind: "window", id: "Notepad", hwnd: "4919" }),
      sources: ["uia", "ocr"],
      affordances: [{ verb: "click" as const, executors: ["uia" as const, "mouse" as const], confidence: 0.9, preconditions: [], postconditions: [] }],
    };
    await expect(createDesktopExecutor(titleOnly, d)(uiaEntity, "click")).rejects.toThrow(/設定/);
    expect(pointOwner).toHaveBeenCalledWith(OBSERVED, 140, 215);
    expect(d.mouseClick).not.toHaveBeenCalled();
  });
});

describe("what it will not take a handle from", () => {
  it("ignores an origin that is the caller's query rather than a handle", async () => {
    // `origin.id` is provider-defined and is usually the title or `"@active"`. Only `origin.hwnd`
    // is a handle, and reading `id` would pin the act to whatever a number-looking title parsed to.
    const pointOwner = vi.fn(() => ({ kind: "other" as const, hwnd: STRANGER, title: "設定" }));
    const d = deps({ pointOwner });
    await createDesktopExecutor(titleOnly, d)(entity({ kind: "window", id: "4919" }), "click");
    expect(pointOwner).not.toHaveBeenCalled();
    expect(d.mouseClick).toHaveBeenCalled();
  });

  it("ignores a browser tab, which has no window handle", async () => {
    const pointOwner = vi.fn(() => ({ kind: "other" as const, hwnd: STRANGER, title: "設定" }));
    const d = deps({ pointOwner });
    await createDesktopExecutor(titleOnly, d)(entity({ kind: "browserTab", id: "t1", hwnd: "4919" }), "click");
    expect(pointOwner).not.toHaveBeenCalled();
  });

  it("ignores an unreadable or non-positive handle, the same rule as everywhere else", async () => {
    const pointOwner = vi.fn(() => ({ kind: "other" as const, hwnd: STRANGER, title: "設定" }));
    for (const hwnd of ["0", "-1", "", "bad"]) {
      const d = deps({ pointOwner });
      await createDesktopExecutor(titleOnly, d)(entity({ kind: "window", id: "Notepad", hwnd }), "click");
      expect(pointOwner, `pinned on ${JSON.stringify(hwnd)}`).not.toHaveBeenCalled();
    }
  });

  it("asks nothing when the entity carries no origin at all", async () => {
    // Entities resolved before ADR-029's field existed, and every test double. The behaviour is
    // the one that existed before this item: an unpinned press, unexamined.
    const pointOwner = vi.fn(() => ({ kind: "other" as const, hwnd: STRANGER, title: "設定" }));
    const d = deps({ pointOwner });
    await createDesktopExecutor(titleOnly, d)(entity(), "click");
    expect(pointOwner).not.toHaveBeenCalled();
    expect(d.mouseClick).toHaveBeenCalled();
  });
});

describe("the handle from the entity never addresses a backend", () => {
  it("leaves the UIA route searching by title, exactly as before", async () => {
    // The whole reason this is a second value rather than a wider `aim.hwnd`: pointing the read
    // path at a handle it did not resolve itself is a behaviour change in the layer where refusing
    // an unreadable `hwnd` broke six tests across three files (ADR-036 item 7).
    const d = deps();
    const uiaEntity: UiEntity = {
      ...entity({ kind: "window", id: "Notepad", hwnd: "4919" }),
      sources: ["uia"],
      affordances: [{ verb: "invoke", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
    };
    await createDesktopExecutor(titleOnly, d)(uiaEntity, "click");
    // Fourth argument is the handle the backend is aimed at: still nothing.
    expect(d.uiaClick).toHaveBeenCalledWith("Notepad", "Save", undefined, undefined);
  });

  it("still prefers the aim's own handle when the call named one", async () => {
    // The two handles are deliberately different, because that is the only way to see WHICH one the
    // ladder ran on. `aim` under the point does NOT refuse the press: the enumeration cannot see an
    // untitled popup, so it answers `aim` exactly when a dropdown or tooltip is sitting on top of
    // its owner — and the press that follows is correct (win2, 2026-09-10).
    const pointOwner = vi.fn(() => ({ kind: "aim" as const }));
    const d = deps({ pointOwner });
    const pinned: Aim = { kind: "aim", title: "Notepad", hwnd: 1234n };
    await createDesktopExecutor(pinned, d)(entity({ kind: "window", id: "Notepad", hwnd: "4919" }), "click");
    expect(pointOwner).toHaveBeenCalledWith(1234n, 140, 215);
    expect(d.mouseClick).toHaveBeenCalled();
  });
});
