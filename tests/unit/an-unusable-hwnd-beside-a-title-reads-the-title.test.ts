/**
 * internal #310 — an hwnd that is not a handle, sent beside a windowTitle, reads the window by title.
 *
 * MEASURED win2 (2026-10-24, main 69009443 and #836): `{hwnd:'18446744073709556276', windowTitle:
 * 'k836.txt - メモ帳'}` read 0 entities, and the UIA lane was asked for `@active`. The session key was
 * `window:<the raw hwnd>`, and the ingress rebuilds the providers' target from the key alone
 * (`targetKeyToSpec`), so the title the caller sent never reached them. #831 meant a title (or a
 * tab) beside an unusable hwnd to still aim.
 */
import { describe, expect, it } from "vitest";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";
import { SessionRegistry } from "../../src/engine/world-graph/session-registry.js";
import { DesktopFacade } from "../../src/tools/desktop.js";

function candidate(label: string): UiEntityCandidate {
  return {
    source: "uia",
    target: { kind: "window", id: "k836.txt - メモ帳" },
    label,
    role: "button",
    rect: { x: 10, y: 10, width: 60, height: 20 },
    actionability: ["click"],
    confidence: 0.9,
    observedAtMs: 0,
    provisional: false,
  } as unknown as UiEntityCandidate;
}

function recordingIngress() {
  const keys: string[] = [];
  const ingress = {
    getSnapshot: async (key: string) => { keys.push(key); return { candidates: [candidate("保存")], warnings: [] }; },
    invalidate: () => undefined,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  };
  return { ingress, keys };
}

const UNUSABLE = ["18446744073709556276", "-1", "0", "not-a-handle"];

describe("internal #310: the session key names the title or tab when the hwnd is not a handle", () => {
  const registry = new SessionRegistry();

  it("an unusable hwnd gives way to the title, and to the tab", () => {
    for (const hwnd of UNUSABLE) {
      expect(registry.resolveKey({ hwnd, windowTitle: "k836.txt - メモ帳" }), `hwnd = ${hwnd}`).toBe("title:k836.txt - メモ帳");
      expect(registry.resolveKey({ hwnd, tabId: "B7AE2D" }), `hwnd = ${hwnd}`).toBe("tab:B7AE2D");
    }
  });

  it("a handle still keys by the handle, title or not (the control)", () => {
    expect(registry.resolveKey({ hwnd: "264078", windowTitle: "k836.txt - メモ帳" })).toBe("window:264078");
    expect(registry.resolveKey({ hwnd: "264078" })).toBe("window:264078");
  });

  it("an unusable hwnd with nothing else keeps its own key, not the foreground's", () => {
    // The tool refuses this call (#831); a direct facade caller must not land on window:__default__.
    expect(registry.resolveKey({ hwnd: "-1" })).toBe("window:-1");
  });
});

describe("internal #310: discover reads by the title, and says the hwnd was not read", () => {
  it("the ingress is asked for the title, and the reply carries target_hwnd_unparseable", async () => {
    const { ingress, keys } = recordingIngress();
    const facade = new DesktopFacade(async () => [], { executorFn: async () => "uia", ingress });
    const out = await facade.see({ target: { hwnd: "18446744073709556276", windowTitle: "k836.txt - メモ帳" } });
    expect(keys).toEqual(["title:k836.txt - メモ帳"]);
    expect(out.entities.map((e) => e.label)).toEqual(["保存"]);
    expect(out.warnings ?? []).toContain("target_hwnd_unparseable");
  });

  it("a real handle beside the title: read by the handle, no warning (the control)", async () => {
    const { ingress, keys } = recordingIngress();
    const facade = new DesktopFacade(async () => [], { executorFn: async () => "uia", ingress });
    const out = await facade.see({ target: { hwnd: "264078", windowTitle: "k836.txt - メモ帳" } });
    expect(keys).toEqual(["window:264078"]);
    expect(out.warnings ?? []).not.toContain("target_hwnd_unparseable");
  });
});
