/**
 * adr-036-post-value-registration.test.ts — the post value, through the REGISTRATION.
 *
 * `post.focusedElement.value` is carried only for a call that named the window focus ended in, and
 * which argument does the naming is declared per tool at its `withRichNarration` registration
 * (`windowTitleKey`). `focus_window` declares `title`.
 *
 * Everything else about that rule is pinned one layer down, against `withPostState` with the keys
 * passed by hand — which cannot see a registration that stops declaring them. Gate 2 measured the
 * hole on `447698f`: deleting `{ windowTitleKey: "title" }` from `window.ts` and `window-dock.ts`
 * left six related files, one hundred assertions, entirely green. Neither tool accepts `narrate`,
 * so that declaration now feeds the post layer and nothing else; without this file it is
 * unreferenced by any test and free to be tidied away.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const FOREGROUND = { hwnd: 4242n, title: "Notepad", isActive: true };

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(() => [
      {
        ...FOREGROUND, zOrder: 0, isMinimized: false, isMaximized: false,
        region: { x: 0, y: 0, width: 800, height: 600 },
        className: "Notepad", ownerHwnd: null, processName: "notepad.exe",
      },
      // The second window makes the pairing possible: naming it is a SUCCESSFUL call that named a
      // window other than the one the (mocked) foreground reports after the action.
      {
        hwnd: 5151n, title: "Calculator", isActive: false, zOrder: 1,
        isMinimized: false, isMaximized: false,
        region: { x: 0, y: 0, width: 400, height: 600 },
        className: "ApplicationFrameWindow", ownerHwnd: null, processName: "calc.exe",
      },
    ]),
    getWindowProcessId: vi.fn(() => 1234),
    getProcessIdentityByPid: vi.fn(() => ({ processName: "notepad.exe" })),
    restoreAndFocusWindow: vi.fn(() => true),
    getWindowTitleW: vi.fn(() => FOREGROUND.title),
  };
});
vi.mock("../../src/engine/window-cache.js", () => ({ updateWindowCache: vi.fn() }));
vi.mock("../../src/engine/cdp-bridge.js", () => ({
  listTabs: vi.fn(async () => []), activateTab: vi.fn(), DEFAULT_CDP_PORT: 9222,
}));
vi.mock("../../src/engine/nutjs.js", () => ({ getActiveWindow: vi.fn() }));
vi.mock("../../src/engine/uia-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/uia-bridge.js")>();
  return {
    ...actual,
    getVirtualDesktopStatus: vi.fn(async () => ({ ok: true, onCurrentDesktop: true })),
    getFocusedAndPointInfo: vi.fn(async () => ({
      focused: { name: "Notes", controlType: "Edit", value: "PROBE-REGISTRATION-1" },
    })),
  };
});

const { focusWindowRegistrationHandler } = await import("../../src/tools/window.js");
const { getFocusedAndPointInfo } = await import("../../src/engine/uia-bridge.js");

/** The `post` block, wherever the envelope put it. */
function postOf(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = result.content?.[0]?.text;
  const obj = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  const post = (obj.post ?? (obj.context as Record<string, unknown> | undefined)?.post) as Record<string, unknown> | undefined;
  return post ?? {};
}

describe("ADR-036: focus_window's own argument carries the post value", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("carries the value for a call whose only naming is `title`", async () => {
    // THE PIN. Drop `{ windowTitleKey: "title" }` from the registration and the post layer falls
    // back to `windowTitle`, which this tool's schema does not have — so the value disappears and
    // this line goes red. Nothing else in the suite notices that deletion.
    const named = postOf(await focusWindowRegistrationHandler({ title: "Notepad" }) as never);
    expect(named.focusedElement).toHaveProperty("value", "PROBE-REGISTRATION-1");
  });

  it("reports the same element without a value when UIA has none, so the row above tracks the snapshot", async () => {
    // The control for the pin. "Named a window, focus ended elsewhere" is not constructible for
    // THIS tool — a `focus_window` that does not end with its window in front returns
    // `ForegroundRestricted` instead of succeeding (measured here: with the foreground mocked to
    // Notepad, `{title:"Calculator"}` fails). So the control varies the other input instead: same
    // call, same naming, UIA carrying no value. The element still comes back; only the value is
    // gone, which is what a passing row above has to be sensitive to.
    vi.mocked(getFocusedAndPointInfo).mockResolvedValueOnce({
      focused: { name: "Notes", controlType: "Edit", value: null },
    } as never);
    const post = postOf(await focusWindowRegistrationHandler({ title: "Notepad" }) as never);
    expect(post.focusedElement).toMatchObject({ name: "Notes", type: "Edit", hasValuePattern: false });
    expect(post.focusedElement).not.toHaveProperty("value");
  });

  it("fails rather than succeeding elsewhere, which is why the control above varies UIA instead", async () => {
    const result = await focusWindowRegistrationHandler({ title: "Calculator" }) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false, code: "ForegroundRestricted" });
  });
});
