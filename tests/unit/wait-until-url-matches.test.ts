/**
 * tests/unit/wait-until-url-matches.test.ts
 *
 * Issue #23: pin the matcher behavior of `wait_until(url_matches)`. The
 * probe under test calls `evaluateInTab` once per poll, so we mock the
 * cdp-bridge module to return a sequence of URL strings and assert the
 * substring vs regex matching path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock cdp-bridge before importing the handler so the probe sees the stub.
const evalSequence: Array<string | null> = [];
let evalCallCount = 0;
vi.mock("../../src/engine/cdp-bridge.js", () => ({
  DEFAULT_CDP_PORT: 9222,
  evaluateInTab: vi.fn().mockImplementation(async () => {
    evalCallCount += 1;
    return evalSequence.shift() ?? null;
  }),
}));

// Stub the other engine deps so importing wait-until.ts is cheap.
vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: () => [],
  getWindowProcessId: () => 0,
}));
vi.mock("../../src/engine/uia-bridge.js", () => ({
  getElementBounds: async () => null,
}));

import { waitUntilHandler } from "../../src/tools/wait-until.js";

beforeEach(() => {
  evalSequence.length = 0;
  evalCallCount = 0;
});

function expectOk(result: { content: Array<{ type: string; text?: string }> }): {
  ok: boolean; condition: string; observed: { url: string };
} {
  const text = result.content.find((b) => b.type === "text")!.text!;
  return JSON.parse(text);
}

describe("wait_until(url_matches)", () => {
  it("substring match succeeds when location.href contains the pattern", async () => {
    evalSequence.push("https://app.example.com/dashboard");
    const r = await waitUntilHandler({
      condition: "url_matches",
      target: { pattern: "/dashboard" },
      timeoutMs: 1000,
      intervalMs: 50,
    });
    const out = expectOk(r);
    expect(out.ok).toBe(true);
    expect(out.observed.url).toBe("https://app.example.com/dashboard");
  });

  it("substring match keeps polling until URL transitions to the target route", async () => {
    evalSequence.push(
      "https://app.example.com/login",
      "https://app.example.com/login?step=2",
      "https://app.example.com/dashboard",
    );
    const r = await waitUntilHandler({
      condition: "url_matches",
      target: { pattern: "/dashboard" },
      timeoutMs: 5000,
      intervalMs: 50,
    });
    const out = expectOk(r);
    expect(out.ok).toBe(true);
    expect(evalCallCount).toBeGreaterThanOrEqual(3);
  });

  it("regex match treats pattern as JS RegExp source when regex:true", async () => {
    evalSequence.push("https://app.example.com/orders/12345");
    const r = await waitUntilHandler({
      condition: "url_matches",
      target: {
        pattern: "^https://app\\.example\\.com/orders/[0-9]+$",
        regex: true,
      },
      timeoutMs: 1000,
      intervalMs: 50,
    });
    const out = expectOk(r);
    expect(out.ok).toBe(true);
  });

  it("regex match rejects substring-only matches when regex:true", async () => {
    // Drip 5 polls with the same wrong URL → matcher must keep returning
    // false → caller must time out.
    for (let i = 0; i < 5; i++) evalSequence.push("https://example.com/orders/abc");
    const r = await waitUntilHandler({
      condition: "url_matches",
      target: {
        pattern: "^https://app\\.example\\.com/orders/[0-9]+$",
        regex: true,
      },
      timeoutMs: 200,
      intervalMs: 50,
    });
    const text = r.content.find((b) => b.type === "text")!.text!;
    const out = JSON.parse(text) as { ok: boolean; code?: string };
    expect(out.ok).toBe(false);
    expect(out.code).toBe("WaitTimeout");
  });

  it("missing target.pattern fails with a useful error", async () => {
    const r = await waitUntilHandler({
      condition: "url_matches",
      target: {},
      timeoutMs: 100,
      intervalMs: 50,
    });
    const text = r.content.find((b) => b.type === "text")!.text!;
    const out = JSON.parse(text) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/target\.pattern is required/);
  });
});
