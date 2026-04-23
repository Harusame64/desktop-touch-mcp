import { describe, it, expect } from "vitest";
import { deriveViewConstraints, type ViewConstraints } from "../../src/tools/desktop-constraints.js";

// ── No warnings → no constraints ──────────────────────────────────────────────

describe("deriveViewConstraints — no warnings", () => {
  it("returns undefined for empty warnings", () => {
    expect(deriveViewConstraints([], 0)).toBeUndefined();
    expect(deriveViewConstraints([], 5)).toBeUndefined();
  });

  it("partial_results_only alone yields no constraints (warning-only)", () => {
    expect(deriveViewConstraints(["partial_results_only"], 3)).toBeUndefined();
  });
});

// ── UIA ───────────────────────────────────────────────────────────────────────

describe("deriveViewConstraints — UIA", () => {
  it("uia_blind_single_pane → constraints.uia=blind_single_pane", () => {
    const c = deriveViewConstraints(["uia_blind_single_pane"], 2);
    expect(c?.uia).toBe("blind_single_pane");
  });

  it("uia_blind_too_few_elements → constraints.uia=blind_too_few_elements", () => {
    const c = deriveViewConstraints(["uia_blind_too_few_elements"], 0);
    expect(c?.uia).toBe("blind_too_few_elements");
  });

  it("uia_provider_failed → constraints.uia=provider_failed", () => {
    const c = deriveViewConstraints(["uia_provider_failed"], 0);
    expect(c?.uia).toBe("provider_failed");
  });

  it("uia_blind_single_pane wins over uia_blind_too_few_elements (first match wins)", () => {
    const c = deriveViewConstraints(["uia_blind_single_pane", "uia_blind_too_few_elements"], 0);
    expect(c?.uia).toBe("blind_single_pane");
  });
});

// ── CDP ───────────────────────────────────────────────────────────────────────

describe("deriveViewConstraints — CDP", () => {
  it("cdp_provider_failed → constraints.cdp=provider_failed", () => {
    const c = deriveViewConstraints(["cdp_provider_failed"], 0);
    expect(c?.cdp).toBe("provider_failed");
  });

  it("visual_attempted_empty_cdp_fallback → cdp=provider_failed + visual=attempted_empty", () => {
    const c = deriveViewConstraints(["visual_attempted_empty_cdp_fallback"], 0);
    expect(c?.cdp).toBe("provider_failed");
    expect(c?.visual).toBe("attempted_empty");
  });
});

// ── Visual ────────────────────────────────────────────────────────────────────

describe("deriveViewConstraints — visual", () => {
  it("visual_not_attempted → constraints.visual=not_attempted", () => {
    const c = deriveViewConstraints(["visual_not_attempted"], 0);
    expect(c?.visual).toBe("not_attempted");
  });

  it("visual_attempted_empty → constraints.visual=attempted_empty", () => {
    const c = deriveViewConstraints(["visual_attempted_empty"], 0);
    expect(c?.visual).toBe("attempted_empty");
  });

  it("visual_provider_unavailable → constraints.visual=provider_unavailable", () => {
    const c = deriveViewConstraints(["visual_provider_unavailable"], 5);
    expect(c?.visual).toBe("provider_unavailable");
  });

  it("visual_provider_warming → constraints.visual=provider_warming", () => {
    const c = deriveViewConstraints(["visual_provider_warming"], 5);
    expect(c?.visual).toBe("provider_warming");
  });

  it("visual_not_attempted wins when combined with visual_attempted_empty (first match wins)", () => {
    const c = deriveViewConstraints(["visual_not_attempted", "visual_attempted_empty"], 0);
    expect(c?.visual).toBe("not_attempted");
  });
});

// ── Terminal ──────────────────────────────────────────────────────────────────

describe("deriveViewConstraints — terminal", () => {
  it("terminal_provider_failed → constraints.terminal=provider_failed", () => {
    const c = deriveViewConstraints(["terminal_provider_failed"], 0);
    expect(c?.terminal).toBe("provider_failed");
  });

  it("terminal_buffer_empty → constraints.terminal=buffer_empty", () => {
    const c = deriveViewConstraints(["terminal_buffer_empty"], 1);
    expect(c?.terminal).toBe("buffer_empty");
  });
});

// ── Window / hierarchy ────────────────────────────────────────────────────────

describe("deriveViewConstraints — window", () => {
  it("no_provider_matched → constraints.window=no_provider_matched", () => {
    const c = deriveViewConstraints(["no_provider_matched"], 0);
    expect(c?.window).toBe("no_provider_matched");
  });

  it("dialog_resolved_via_owner_chain is a success-path notification — does NOT produce constraints", () => {
    // H3 success notifications stay in warnings[] only; they are not failure constraints.
    expect(deriveViewConstraints(["dialog_resolved_via_owner_chain"], 3)).toBeUndefined();
  });

  it("parent_disabled_prefer_popup is a success-path notification — does NOT produce constraints", () => {
    expect(deriveViewConstraints(["parent_disabled_prefer_popup"], 2)).toBeUndefined();
  });

  it("dialog_resolved + no_provider_matched: window constraint is no_provider_matched (failure wins)", () => {
    const c = deriveViewConstraints(["dialog_resolved_via_owner_chain", "no_provider_matched"], 0);
    expect(c?.window).toBe("no_provider_matched");
    expect(c?.entityZeroReason).toBe("foreground_unresolved");
  });
});

// ── Ingress ───────────────────────────────────────────────────────────────────

describe("deriveViewConstraints — ingress", () => {
  it("ingress_fetch_error → constraints.ingress=fetch_error", () => {
    const c = deriveViewConstraints(["ingress_fetch_error"], 0);
    expect(c?.ingress).toBe("fetch_error");
  });
});

// ── entityZeroReason ──────────────────────────────────────────────────────────

describe("deriveViewConstraints — entityZeroReason", () => {
  it("not set when entities > 0", () => {
    const c = deriveViewConstraints(["uia_blind_single_pane", "visual_not_attempted"], 3);
    expect(c?.entityZeroReason).toBeUndefined();
    expect(c?.uia).toBe("blind_single_pane"); // constraints still present
  });

  it("foreground_unresolved when no_provider_matched + entities === 0", () => {
    const c = deriveViewConstraints(["no_provider_matched"], 0);
    expect(c?.entityZeroReason).toBe("foreground_unresolved");
  });

  it("ingress_fetch_error when only ingress error + entities === 0", () => {
    const c = deriveViewConstraints(["ingress_fetch_error"], 0);
    expect(c?.entityZeroReason).toBe("ingress_fetch_error");
  });

  it("uia_blind_visual_unready: uia blind + visual not_attempted", () => {
    const c = deriveViewConstraints(["uia_blind_single_pane", "visual_not_attempted"], 0);
    expect(c?.entityZeroReason).toBe("uia_blind_visual_unready");
  });

  it("uia_blind_visual_unready: uia blind + visual provider_unavailable", () => {
    const c = deriveViewConstraints(["uia_blind_too_few_elements", "visual_provider_unavailable"], 0);
    expect(c?.entityZeroReason).toBe("uia_blind_visual_unready");
  });

  it("uia_blind_visual_empty: uia blind + visual attempted_empty", () => {
    const c = deriveViewConstraints(["uia_blind_single_pane", "visual_attempted_empty"], 0);
    expect(c?.entityZeroReason).toBe("uia_blind_visual_empty");
  });

  it("cdp_failed_visual_empty: cdp failed + visual attempted_empty (browser PWA scenario)", () => {
    const c = deriveViewConstraints(["visual_attempted_empty_cdp_fallback"], 0);
    expect(c?.entityZeroReason).toBe("cdp_failed_visual_empty");
  });

  it("cdp_failed_visual_empty: explicit cdp_provider_failed + visual_attempted_empty", () => {
    const c = deriveViewConstraints(["cdp_provider_failed", "visual_attempted_empty"], 0);
    expect(c?.entityZeroReason).toBe("cdp_failed_visual_empty");
  });

  it("all_providers_failed when uia_provider_failed alone", () => {
    const c = deriveViewConstraints(["uia_provider_failed"], 0);
    expect(c?.entityZeroReason).toBe("all_providers_failed");
  });

  it("all_providers_failed when terminal_provider_failed alone", () => {
    const c = deriveViewConstraints(["terminal_provider_failed"], 0);
    expect(c?.entityZeroReason).toBe("all_providers_failed");
  });

  it("no entityZeroReason when only partial_results_only (and entities=0 with no constraint)", () => {
    // partial_results_only alone is not a constraint, so constraints is undefined
    expect(deriveViewConstraints(["partial_results_only"], 0)).toBeUndefined();
  });

  it("foreground_unresolved takes priority over ingress_fetch_error", () => {
    const c = deriveViewConstraints(["ingress_fetch_error", "no_provider_matched"], 0);
    expect(c?.entityZeroReason).toBe("foreground_unresolved");
  });

  it("foreground_unresolved takes priority over uia_blind", () => {
    const c = deriveViewConstraints(["no_provider_matched", "uia_blind_single_pane", "visual_not_attempted"], 0);
    expect(c?.entityZeroReason).toBe("foreground_unresolved");
  });
});

// ── Additive: constraints field absent when irrelevant ───────────────────────

describe("deriveViewConstraints — field isolation", () => {
  it("uia blind warning does not set cdp/visual/terminal/window/ingress", () => {
    const c = deriveViewConstraints(["uia_blind_single_pane"], 2) as ViewConstraints;
    expect(c.cdp).toBeUndefined();
    expect(c.visual).toBeUndefined();
    expect(c.terminal).toBeUndefined();
    expect(c.window).toBeUndefined();
    expect(c.ingress).toBeUndefined();
  });

  it("terminal warning does not set uia/cdp/visual", () => {
    const c = deriveViewConstraints(["terminal_buffer_empty"], 1) as ViewConstraints;
    expect(c.uia).toBeUndefined();
    expect(c.cdp).toBeUndefined();
    expect(c.visual).toBeUndefined();
  });
});
