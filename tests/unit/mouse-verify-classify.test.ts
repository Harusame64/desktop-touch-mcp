/**
 * mouse-verify-classify.test.ts — Issue #178 unit tests.
 *
 * Pins the `classifyDelivery()` truth table (matrix doc §3.1 row mouse_click,
 * §4.4 status enum). The classifier is a pure function over (pre, post,
 * channel) so it can be tested without any UIA / win32 mocks.
 *
 * The complementary `snapshotForVerify()` is exercised by E2E tests because
 * it depends on real UIA / win32 calls.
 */

import { describe, it, expect } from "vitest";
import {
  classifyDelivery,
  type MouseVerifySnapshot,
} from "../../src/tools/_mouse-verify.js";
import type { UiaFocusInfo } from "../../src/engine/uia-bridge.js";

const elemA: UiaFocusInfo = { name: "ButtonA", controlType: "Button", automationId: "btn-a" };
const elemB: UiaFocusInfo = { name: "ButtonB", controlType: "Button", automationId: "btn-b" };

const snap = (over: Partial<MouseVerifySnapshot> = {}): MouseVerifySnapshot => ({
  elementAtPoint: null,
  focusedElement: null,
  foregroundHwnd: null,
  verticalScrollPos: null,
  ...over,
});

describe("classifyDelivery — issue #178 truth table", () => {
  it("returns 'unverifiable' when both pre and post lack any UIA observation", () => {
    const r = classifyDelivery(snap(), snap(), "send_input");
    expect(r.status).toBe("unverifiable");
    expect(r.channel).toBe("send_input");
    expect(r.reason).toBe("read_back_unsupported");
    expect(r.detail).toBeTruthy();
  });

  it("returns 'delivered' when elementAtPoint changes", () => {
    const pre = snap({ elementAtPoint: elemA, focusedElement: elemA });
    const post = snap({ elementAtPoint: elemB, focusedElement: elemA });
    const r = classifyDelivery(pre, post, "send_input");
    expect(r.status).toBe("delivered");
    expect(r.reason).toBeUndefined();
  });

  it("returns 'delivered' when focusedElement changes", () => {
    const pre = snap({ elementAtPoint: elemA, focusedElement: elemA });
    const post = snap({ elementAtPoint: elemA, focusedElement: elemB });
    const r = classifyDelivery(pre, post, "send_input");
    expect(r.status).toBe("delivered");
  });

  it("returns 'delivered' when verticalScrollPos changes", () => {
    const pre = snap({ elementAtPoint: elemA, verticalScrollPos: 0 });
    const post = snap({ elementAtPoint: elemA, verticalScrollPos: 100 });
    const r = classifyDelivery(pre, post, "send_input");
    expect(r.status).toBe("delivered");
  });

  it("returns 'delivered' when foregroundHwnd changes", () => {
    const pre = snap({
      elementAtPoint: elemA,
      foregroundHwnd: 1n,
    });
    const post = snap({
      elementAtPoint: elemA,
      foregroundHwnd: 2n,
    });
    const r = classifyDelivery(pre, post, "send_input");
    expect(r.status).toBe("delivered");
  });

  it("returns 'focus_only' when UIA available but nothing changed", () => {
    // Same element at point, same focused element, same scroll, same fg.
    // This is the canonical "click consumed without observable side effect" case.
    const pre = snap({
      elementAtPoint: elemA,
      focusedElement: elemA,
      verticalScrollPos: 50,
      foregroundHwnd: 1n,
    });
    const post = snap({
      elementAtPoint: elemA,
      focusedElement: elemA,
      verticalScrollPos: 50,
      foregroundHwnd: 1n,
    });
    const r = classifyDelivery(pre, post, "send_input");
    expect(r.status).toBe("focus_only");
    expect(r.reason).toBe("no_observable_change");
    expect(r.detail).toBeTruthy();
  });

  it("returns 'delivered' when an observable element disappeared post-click", () => {
    // pre had UIA but post lost it (e.g. target window crashed / closed by the
    // click). A null→element transition IS a state change; we must not
    // collapse it to focus_only or unverifiable. The reverse direction
    // (no-UIA-pre, UIA-post) is also a delivered signal.
    const pre = snap({ elementAtPoint: elemA, focusedElement: elemA });
    const post = snap();
    const r = classifyDelivery(pre, post, "send_input");
    expect(r.status).toBe("delivered");
  });

  it("treats only-value-changes (same name/controlType/id) as no change", () => {
    // Volatile fields like clock text or caret value should NOT register as
    // a delivered click — otherwise every click on a clock-bearing app
    // would false-positive.
    const elemAv1: UiaFocusInfo = { ...elemA, value: "12:00" };
    const elemAv2: UiaFocusInfo = { ...elemA, value: "12:01" };
    const pre = snap({ elementAtPoint: elemAv1, focusedElement: elemAv1 });
    const post = snap({ elementAtPoint: elemAv2, focusedElement: elemAv2 });
    const r = classifyDelivery(pre, post, "send_input");
    expect(r.status).toBe("focus_only");
  });

  it("propagates the channel string into the hint", () => {
    const r = classifyDelivery(snap(), snap(), "uia_invoke");
    expect(r.channel).toBe("uia_invoke");
  });

  it("ignores scrollPos diff when one side is null (no scrollbar)", () => {
    // Chromium overlay scrollbars / non-scrollable windows return null.
    // Treating null vs 100 as a change would false-positive every click on
    // such a target. UIA element diff still drives 'delivered', but pure
    // null↔value scrollPos must not.
    const pre = snap({
      elementAtPoint: elemA,
      focusedElement: elemA,
      verticalScrollPos: null,
    });
    const post = snap({
      elementAtPoint: elemA,
      focusedElement: elemA,
      verticalScrollPos: 100,
    });
    const r = classifyDelivery(pre, post, "send_input");
    expect(r.status).toBe("focus_only");
  });
});
