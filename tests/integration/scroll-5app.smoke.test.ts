/**
 * scroll-5app.smoke.test.ts — ADR-018 Phase 5 acceptance harness (Phase 3 stub).
 *
 * Phase 3 deliverable per ADR §4: this file exists and pins **one** Chrome
 * case (Tier 2 CDP path) behind the `SCROLL_SMOKE=1` env gate so it does not
 * fire in regular CI. Phase 5 fills in the 5-app × 4-direction matrix
 * (Chrome / Notepad / Word / Excel / File Explorer) per ADR AC1.
 *
 * Manual invocation (Windows runner with Chrome listening on
 * --remote-debugging-port=9222):
 *
 *   SCROLL_SMOKE=1 npx vitest run tests/integration/scroll-5app.smoke.test.ts
 *
 * The Chrome assertion below imports the dispatch handler indirectly via
 * `scrollDispatchHandler` so the full envelope assembly is exercised
 * (`verifyDelivery.channel='cdp'` + `reason='delivered_via_cdp'` + numeric
 * `scrollObserved.delta`). The Phase 5 follow-up wires up the other 4 apps.
 */

import { describe, it, expect } from "vitest";

const smokeEnabled = process.env.SCROLL_SMOKE === "1";

describe.skipIf(!smokeEnabled)(
  "ADR-018 Phase 3 — scroll Tier 2 CDP smoke (Chrome, SCROLL_SMOKE=1)",
  () => {
    it("scroll(action='raw', windowTitle:'Chrome', direction:'down') reports channel='cdp' / reason='delivered_via_cdp'", async () => {
      const { scrollDispatchHandler } = await import("../../src/tools/scroll.js");
      const result = await scrollDispatchHandler({
        action: "raw",
        direction: "down",
        amount: 3,
        windowTitle: "Chrome",
        homing: true,
      } as Parameters<typeof scrollDispatchHandler>[0]);
      // The handler returns a ToolResult; envelope hints carry the Phase 3
      // contract. Parse the first content block JSON to read hints.
      const text = (result.content[0] as { text: string }).text;
      const parsed = JSON.parse(text) as {
        hints?: {
          verifyDelivery?: { status?: string; channel?: string; reason?: string };
          scrollObserved?: { delta?: unknown };
        };
      };
      expect(parsed.hints?.verifyDelivery?.channel).toBe("cdp");
      expect(parsed.hints?.verifyDelivery?.reason).toBe("delivered_via_cdp");
      // scrollObserved.delta should NOT be the placeholder string in the
      // delivered case (Tier 2 success → at least one axis observed numerically).
      // The exact shape is asserted by tests/unit/scroll-raw-verify.test.ts.
      expect(parsed.hints?.scrollObserved?.delta).toBeDefined();
    }, 30_000);
  },
);
