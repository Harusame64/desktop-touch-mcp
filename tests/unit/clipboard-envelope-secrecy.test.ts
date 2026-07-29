/**
 * clipboard-envelope-secrecy.test.ts — ADR-033 P0-1, invariant I-2.
 *
 * I-2: a `clipboard` failure envelope must never carry the ACTUAL clipboard
 * contents, only byte counts. The clipboard is a shared OS resource: when a
 * write fails the verification read-back, what came back is by definition
 * something another process put there — a password pulled out of a password
 * manager, an API key another tool copied. Echoing it into the failure envelope
 * would push it into the tool result, the server log and the model's context in
 * one move, i.e. the failure path would leak more than the success path ever
 * could.
 *
 * The production code has always intended this (the comment at the mismatch
 * branch says so), but nothing pinned it — a future maintainer adding
 * `actualText` "for debuggability" would have shipped the leak silently. This
 * file is the pin, and it is deliberately written against the *envelope text*
 * rather than against a named field, so it also catches a leak arriving through
 * a hint string, a re-thrown error message, or a nested diagnostic object.
 *
 * Added BEFORE the native clipboard migration (ADR-033) so the invariant is
 * green on the PowerShell path first and the native path inherits a pin that
 * already passed, rather than one written to fit the new implementation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

const { clipboardWriteHandler } = await import("../../src/tools/clipboard.js");

/** promisify(execFile) resolves whatever the callback's (stdout, stderr) are. */
function fakePowerShell(stdout: string) {
  execFileMock.mockImplementation((_file: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
    (cb as (e: null, out: { stdout: string; stderr: string }) => void)(null, { stdout, stderr: "" });
    return {};
  });
}

/** The raw envelope text — what actually reaches the caller / the logs. */
function envelopeText(r: { content: Array<{ type: string; text?: string }> }): string {
  const text = r.content[0]?.text;
  if (!text) throw new Error("missing envelope body");
  return text;
}

function body(r: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(envelopeText(r)) as {
    ok: boolean;
    code?: string;
    context?: Record<string, unknown>;
  };
}

// A racing application's clipboard content. Distinctive enough that a substring
// search cannot false-negative, and long enough that a truncated echo (the
// "just the first 40 chars for debugging" temptation) still trips the pin.
const RACING_SECRET = "sk-live-SECRET-9f3a2b7c-do-not-echo-this-into-any-envelope";

beforeEach(() => {
  execFileMock.mockReset();
});

describe("I-2 — a clipboard failure envelope never carries clipboard contents", () => {
  it("reports byte counts, not the racing application's text", async () => {
    // The verification read-back returns someone else's clipboard content:
    // the exact situation ClipboardWriteNotDelivered exists to report.
    fakePowerShell(Buffer.from(RACING_SECRET, "utf16le").toString("base64"));

    const res = await clipboardWriteHandler({ text: "delivery-target" });
    const raw = envelopeText(res);
    const parsed = body(res);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("ClipboardWriteNotDelivered");

    // Neither the decoded text nor the wire form it arrived in may appear
    // anywhere in the envelope — a base64 echo leaks exactly as much.
    expect(raw).not.toContain(RACING_SECRET);
    expect(raw).not.toContain(Buffer.from(RACING_SECRET, "utf16le").toString("base64"));

    // What IS allowed: lengths. "0 vs N" → cleared, "N vs M" → replaced, which
    // is all the diagnosis a caller needs.
    expect(parsed.context?.expectedBytes).toBe(Buffer.from("delivery-target", "utf16le").length);
    expect(parsed.context?.actualBytes).toBe(Buffer.from(RACING_SECRET, "utf16le").length);
  });

  it("does not leak the racing text when the clipboard was cleared instead of replaced", async () => {
    // Empty read-back is still a mismatch (I-5) and must report 0 bytes rather
    // than reaching for whatever else it can find to describe the failure.
    fakePowerShell("");

    const res = await clipboardWriteHandler({ text: "delivery-target" });
    const parsed = body(res);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("ClipboardWriteNotDelivered");
    expect(parsed.context?.actualBytes).toBe(0);
  });

  it("keeps the byte counts numeric so a length can never smuggle the text", async () => {
    // A string-typed "length" field is how this invariant would erode in
    // practice ("expectedBytes: '15 (delivery-target)'"), so the pin is on the
    // TYPE, not merely on the absence of one particular secret.
    fakePowerShell(Buffer.from(RACING_SECRET, "utf16le").toString("base64"));

    const parsed = body(await clipboardWriteHandler({ text: "delivery-target" }));
    expect(typeof parsed.context?.expectedBytes).toBe("number");
    expect(typeof parsed.context?.actualBytes).toBe("number");
  });
});
