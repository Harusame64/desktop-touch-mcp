import { describe, it, expect } from "vitest";
import { resolveV2Activation } from "../../src/tools/desktop-activation.js";

describe("resolveV2Activation — v0.17 default-on contract", () => {
  it("default (both unset) enables v2", () => {
    const d = resolveV2Activation({});
    expect(d.enabled).toBe(true);
    expect(d.disabledByFlag).toBe(false);
    expect(d.legacyEnableSet).toBe(false);
  });

  it("ENABLE=1 alone enables v2 and marks legacy (deprecation warning path)", () => {
    const d = resolveV2Activation({ DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2: "1" });
    expect(d.enabled).toBe(true);
    expect(d.legacyEnableSet).toBe(true);
    expect(d.disabledByFlag).toBe(false);
  });

  it("DISABLE=1 alone disables v2 (kill switch)", () => {
    const d = resolveV2Activation({ DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2: "1" });
    expect(d.enabled).toBe(false);
    expect(d.disabledByFlag).toBe(true);
    expect(d.legacyEnableSet).toBe(false);
  });

  it("DISABLE=1 + ENABLE=1 → DISABLE wins, legacy flag still marked", () => {
    const d = resolveV2Activation({
      DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2: "1",
      DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2:  "1",
    });
    expect(d.enabled).toBe(false);
    expect(d.disabledByFlag).toBe(true);
    expect(d.legacyEnableSet).toBe(true);
  });

  it.each(["0", "true", "yes", "1 ", ""])(
    "DISABLE=%j is treated as unset (exact-match — v2 stays ON)",
    (v) => {
      const d = resolveV2Activation({ DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2: v });
      expect(d.disabledByFlag).toBe(false);
      expect(d.enabled).toBe(true);
    }
  );

  it.each(["0", "true", "yes", "1 ", ""])(
    "ENABLE=%j is treated as unset (exact-match — no legacy mark)",
    (v) => {
      const d = resolveV2Activation({ DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2: v });
      expect(d.legacyEnableSet).toBe(false);
    }
  );
});
