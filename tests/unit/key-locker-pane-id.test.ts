// ADR-014 R3.x S-pid E2 — the paneId codec: the ONE shipped-public pane handle in its two forms.
//   * classic `String(hwnd)` decimal (unchanged, zero back-compat break)
//   * wt `wt:<shellPid>:<shellStartTimeMs>` (self-describing S-pid anchor)
// Pins the gate-mandated LENGTH INVARIANT (formatWtPaneId(max) <= the public schema cap) so a future
// format tweak cannot silently exceed the `terminal` paneId schema and reject valid wt panes (Opus P3-1).
// Plan: desktop-touch-mcp-internal:docs/adr-014-v2-r3x-s-pid-gate.md (E2)
import { describe, expect, it } from "vitest";
import {
  formatWtPaneId,
  parsePaneId,
  registerWtPaneTitle,
  unregisterWtPaneTitle,
  wtPaneTitleOf,
  WT_PANE_ID_SCHEMA_MAX,
} from "../../src/engine/key-locker/pane-id.js";

describe("parsePaneId — the one resolver over both public forms", () => {
  it("parses a classic decimal hwnd", () => {
    expect(parsePaneId("4660")).toEqual({ kind: "classic", hwnd: 4660n });
  });

  it("parses the wt form into its anchor identity", () => {
    expect(parsePaneId("wt:31264:13322426700123")).toEqual({
      kind: "wt",
      shellPid: 31264,
      shellStartTimeMs: 13322426700123,
    });
  });

  it("round-trips formatWtPaneId", () => {
    const id = formatWtPaneId(31264, 13322426700123);
    expect(id).toBe("wt:31264:13322426700123");
    expect(parsePaneId(id)).toEqual({ kind: "wt", shellPid: 31264, shellStartTimeMs: 13322426700123 });
  });

  it("declines malformed input with null (never throws) — the existing decline contract", () => {
    for (const bad of [
      "", "abc", "-5", "0x1234", " 4660", "4660 ",   // not the decimal classic form
      "wt:", "wt:12", "wt:12:", "wt:a:b", "wt:12:34:56", "WT:12:34",  // not the wt form
      "wt:0:34", "wt:12:0",                            // 0 is the doubt sentinel — can never have anchored
      "wt:12345678901:34", "wt:12:123456789012345",  // over max digit widths (pid > 10, startMs > 14)
    ]) {
      expect(parsePaneId(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("LENGTH INVARIANT: the PARSER's max-width wt paneId fits the public schema cap (gate E2 / Opus P3-1)", () => {
    // Bound at the PARSER's ceiling (pid 10 digits = 32-bit max; startMs 14 digits, the regex max — a
    // real FILETIME-ms is ~14 digits and 14 digits stays inside Number.MAX_SAFE_INTEGER so parsing is
    // exact), so a future format tweak can't silently exceed the cap. 3 (`wt:`) + 10 + 1 (`:`) + 14 = 28.
    const widest = formatWtPaneId(4294967295, 99999999999999);
    expect(widest.length).toBeLessThanOrEqual(WT_PANE_ID_SCHEMA_MAX);
    expect(parsePaneId(widest)).toEqual({ kind: "wt", shellPid: 4294967295, shellStartTimeMs: 99999999999999 });
  });
});

describe("wt tab-title registry (E6)", () => {
  it("register → lookup → unregister lifecycle; unregistered panes read null (decline)", () => {
    const id = formatWtPaneId(100, 200);
    expect(wtPaneTitleOf(id)).toBeNull();
    registerWtPaneTitle(id, "dtm-locker-console-abc");
    expect(wtPaneTitleOf(id)).toBe("dtm-locker-console-abc");
    unregisterWtPaneTitle(id);
    expect(wtPaneTitleOf(id)).toBeNull();
  });
});
