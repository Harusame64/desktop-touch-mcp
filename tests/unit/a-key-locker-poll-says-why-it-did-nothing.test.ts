/**
 * internal #283: the wiring armed every armed pane's poll with `.catch(() => {})`, so a poll that ended
 * without a fill — or threw — left no trace, and a locker that "did nothing" at a prompt could not say why.
 * Each such end now writes one diagnostic line; routine ticks write nothing, and nothing written is a secret.
 */
import { describe, expect, it, vi } from "vitest";

const { logged } = vi.hoisted(() => ({ logged: [] as unknown[] }));
vi.mock("../../src/engine/diagnostic-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/diagnostic-log.js")>();
  return { ...actual, logDiagnostic: vi.fn((e: unknown) => { logged.push(e); }) };
});

const { pollOutcomeEvent, logPollOutcome } = await import("../../src/engine/key-locker/poll-log.js");

describe("pollOutcomeEvent", () => {
  it.each(["idle", "polling", "busy"] as const)("a routine %s tick writes nothing", (status) => {
    expect(pollOutcomeEvent("p1", { status })).toBeNull();
  });
  it.each(["timed_out", "superseded", "declined"] as const)("a poll that ends the arm (%s) says so", (status) => {
    expect(pollOutcomeEvent("p1", { status })).toEqual({ kind: "key_locker_poll", paneId: "p1", status });
  });
  it("a capture loop's outcome is written by kind and reason or code, never its detail", () => {
    expect(pollOutcomeEvent("p1", { status: "filled", outcome: { kind: "discarded", reason: "not_landed", detail: "exit=255 Permission denied" } }))
      .toEqual({ kind: "key_locker_poll", paneId: "p1", status: "filled", outcome: "discarded", reason: "not_landed" });
    expect(pollOutcomeEvent("p1", { status: "filled", outcome: { kind: "fill_aborted", matched: true, code: "target_mismatch" } }))
      .toEqual({ kind: "key_locker_poll", paneId: "p1", status: "filled", outcome: "fill_aborted", reason: "target_mismatch" });
    expect(pollOutcomeEvent("p1", { status: "filled", outcome: { kind: "capture_cancelled" } }))
      .toEqual({ kind: "key_locker_poll", paneId: "p1", status: "filled", outcome: "capture_cancelled" });
    expect(pollOutcomeEvent("p1", { status: "filled", outcome: { kind: "declined", reason: "never_suppressed" } }))
      .toEqual({ kind: "key_locker_poll", paneId: "p1", status: "filled", outcome: "declined", reason: "never_suppressed" });
  });
  it("a poll that threw is written by the error's name, not its message", () => {
    class KeyLockerPipeError extends Error { override name = "KeyLockerPipeError"; }
    const e = pollOutcomeEvent("p1", undefined, new KeyLockerPipeError("hunter2 was typed into the wrong pane"));
    expect(e).toEqual({ kind: "key_locker_poll", paneId: "p1", status: "error", errorName: "KeyLockerPipeError" });
    expect(JSON.stringify(e)).not.toContain("hunter2");
    expect(pollOutcomeEvent("p1", undefined, "a string")).toMatchObject({ status: "error", errorName: "string" });
  });
});

describe("logPollOutcome", () => {
  it("writes the line for an end and nothing for a routine tick", () => {
    logged.length = 0;
    logPollOutcome("p1", { status: "polling" });
    logPollOutcome("p1", { status: "timed_out" });
    expect(logged).toEqual([{ kind: "key_locker_poll", paneId: "p1", status: "timed_out" }]);
  });
});

describe("the wiring logs each armed pane's poll end", () => {
  it("source: the poll is no longer swallowed silently", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/tools/key-locker-wiring.ts", import.meta.url), "utf8");
    expect(src).not.toContain("this.driver.poll(paneId).catch(() => {})");
    expect(src).toMatch(/this\.driver\.poll\(paneId\)\.then\(\s*\(result\) => logPollOutcome\(paneId, result\),\s*\(error: unknown\) => logPollOutcome\(paneId, undefined, error\)/);
  });
});
