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
/** A window the aim owns — a dropdown or dialog, which is what the allowance is for. */
const POPUP = 555n;

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

  it("refuses an owned dialog that is not the window the pixels came from", async () => {
    // PR 側 codex, 2026-09-10 (P1). The popup allowance let ANY owned window take the press — the
    // rung that consults the entity's provenance lived only inside the `measured_in_another_window`
    // branch, and on this road the verdict is `no_origin_rect`. So a titled dialog that had opened
    // over the remembered point was pressed although the entity's own origin says the pixels came
    // from the PARENT. Both rungs ask the same question now.
    const pointOwner = vi.fn(() => ({ kind: "owned" as const, hwnd: STRANGER, title: "名前を付けて保存", via: "os_hit_test" as const }));
    const d = deps({ pointOwner });
    await expect(createDesktopExecutor(titleOnly, d)(entity({ kind: "window", id: "Notepad", hwnd: "4919" }), "click"))
      .rejects.toThrow(/measured in window 4919/);
    expect(d.mouseClick).not.toHaveBeenCalled();
  });

  it("presses an owned dropdown when that is the window the pixels came from — on the PINNED road", async () => {
    // The other half, and the reason the allowance exists at all: an entity discovered INSIDE a
    // dropdown records that dropdown's handle, and the press belongs there. Refusing this was the
    // mistake of an earlier round (gate 2, 2026-09-10) — a false refusal for the commonest popup on
    // Windows.
    //
    // **Pinned deliberately, because on the title-only road this state cannot occur** (Opus sandbox
    // review, 2026-09-10). There the coordinate handle IS the entity's own, so an owned window
    // under the point is by definition a different handle — `whoIsUnderPoint` answers `aim` when
    // the top window is the one it was asked about. The cell that stood here pinned a state
    // production cannot reach and passed under a reversion of the rule it claimed to defend.
    // A pinned call is the real shape: the caller names the parent, the entity was captured in the
    // dropdown the parent owns.
    const pointOwner = vi.fn(() => ({ kind: "owned" as const, hwnd: POPUP, title: "", via: "os_hit_test" as const }));
    const d = deps({ pointOwner });
    const pinned: Aim = { kind: "aim", title: "Notepad", hwnd: OBSERVED };
    await createDesktopExecutor(pinned, d)(entity({ kind: "window", id: "Notepad", hwnd: POPUP.toString() }), "click");
    expect(d.mouseClick).toHaveBeenCalledWith(140, 215);
  });

  it("keeps the allowance when the ENUMERATION named the owned window, not the OS", async () => {
    // The narrowing rides on the OS hit test alone. The enumeration reads rectangles and is
    // measured blind to a click-through overlay's transparency, so it names windows a press falls
    // straight through — refusing on that would invent a refusal out of a known blind spot and
    // break presses that work today on every build without the native addon (Opus sandbox review,
    // 2026-09-10). Same inputs as the refusal cell above, one field different.
    const pointOwner = vi.fn(() => ({ kind: "owned" as const, hwnd: STRANGER, title: "名前を付けて保存", via: "enumeration" as const }));
    const d = deps({ pointOwner });
    await createDesktopExecutor(titleOnly, d)(entity({ kind: "window", id: "Notepad", hwnd: "4919" }), "click");
    expect(d.mouseClick).toHaveBeenCalledWith(140, 215);
  });

  it("keeps the allowance for an entity that recorded no window at all", async () => {
    // Absence is not evidence. An entity with no `origin.hwnd` has nothing to contradict the
    // screen, and it keeps the behaviour it had before this item existed.
    const pointOwner = vi.fn(() => ({ kind: "owned" as const, hwnd: STRANGER, title: "名前を付けて保存", via: "os_hit_test" as const }));
    const d = deps({ pointOwner, aimRect: vi.fn(async () => ({ x: 0, y: 0, width: 1000, height: 1000 })) });
    const pinned: Aim = { kind: "aim", title: "Notepad", hwnd: OBSERVED };
    await createDesktopExecutor(pinned, d)(entity(), "click");
    expect(d.mouseClick).toHaveBeenCalledWith(140, 215);
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

  it("presses unchecked when the recorded handle names no window, exactly as before the ladder", async () => {
    // The boundary of "the entity knows". `"0"` is what a lane writes when it looked and resolved
    // nothing, and it has to arrive here as SILENCE: no ladder, and the press goes out the way it
    // did before this item existed. Pinned because the two sides of that rule sit in different
    // files — the resolver decides which lane's handle becomes `origin.hwnd`, `observedHwndOfOrigin`
    // decides whether that string names a window — and they were using different rules until gate 2
    // (2026-09-10). A refusal here would be a new refusal in a case that used to work.
    //
    // A round of this branch also carried an `hwndConflict` refusal, for a group whose lanes named
    // different windows; the state cannot occur (one road writes `originHwnd`, called once per
    // pass), so the code and its cell are gone rather than kept as a fixture-only path.
    const d = deps();
    await createDesktopExecutor(titleOnly, d)(entity({ kind: "window", id: "Notepad", hwnd: "0" }), "click");
    expect(d.mouseClick).toHaveBeenCalledWith(140, 215);
    expect(d.aimRect).not.toHaveBeenCalled();
  });

  it("checks the UIA downgrade against that window too, not only the mouse road", async () => {
    // Gate 2 (2026-09-10): the ladder was given `coordHwnd` at one of the two coordinate presses in
    // this closure. When UIA fails and the call downgrades to the mouse, the point came from the
    // same entity and went out unchecked — with a `設定` window over it, `mouseClick` was issued and
    // `pointOwner` was never asked. Merged uia+ocr entities are the ladder's real traffic, so this
    // was the road that mattered.
    const pointOwner = vi.fn(() => ({ kind: "other" as const, hwnd: STRANGER, title: "設定" }));
    // The failure is one the downgrade still exists for — the element is there and cannot be
    // invoked. `Element not found` ends the ladder before this rung now (ADR-036 item 16).
    const d = deps({
      uiaClick: vi.fn(async () => { throw new Error("InvokePattern not supported by this element"); }),
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
