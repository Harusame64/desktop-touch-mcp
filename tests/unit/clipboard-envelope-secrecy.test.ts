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
 *
 * ADR-033 P1-3(b) then made the backend EXPLICIT here. Two reasons, and only
 * the harness changed — every assertion below is the one that passed before the
 * migration:
 *   1. The handler now picks its backend from whether a compiled `.node` is
 *      present, so without a pin this file would silently stop testing the
 *      PowerShell path on a developer machine that has built the addon — and
 *      would reach the REAL clipboard from a unit test while doing it.
 *   2. I-2 is a claim about the tool, not about one implementation. The native
 *      path reports the same byte counts from a different source (the addon's
 *      post-close read), so it needs the same pin, not an inherited assumption.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

const nativeState: { available: boolean; write: ReturnType<typeof vi.fn> } = {
  available: false,
  write: vi.fn(),
};

// Partial mock: native-engine is the load point for the whole addon and
// unrelated importers read other members of it at module init.
vi.mock(import("../../src/engine/native-engine.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    hasNativeClipboardText: () => nativeState.available,
    nativeWin32: {
      ...(actual.nativeWin32 ?? {}),
      win32ClipboardReadText: () => ({ ok: true, hasText: false, bytes: Buffer.alloc(0) }),
      win32ClipboardWriteTextVerified: (...a: unknown[]) => nativeState.write(...a),
    } as unknown as typeof actual.nativeWin32,
  };
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
  nativeState.write.mockReset();
  nativeState.available = false;
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

// ADR-033 P1-3(b) — the same invariant on the native backend. The addon is the
// one component that has actually SEEN the racing text (it did the post-close
// read), so it is the component best placed to leak it; it returns byte counts
// only, and this pins that the TS layer does not reach for anything more.
describe("I-2 — the native backend's failure envelope carries no clipboard contents either", () => {
  beforeEach(() => {
    nativeState.available = true;
  });

  it("reports byte counts, not the racing application's text", async () => {
    nativeState.write.mockReturnValue({
      ok: false,
      reason: "clipboard_replaced_after_write",
      expectedBytes: Buffer.from("delivery-target", "utf16le").length,
      inSessionReadable: true,
      inSessionBytes: Buffer.from("delivery-target", "utf16le").length,
      inSessionMatch: true,
      postCloseChecked: true,
      postCloseBytes: Buffer.from(RACING_SECRET, "utf16le").length,
      postCloseMatch: false,
      sequenceAfterWrite: 5,
    });

    const res = await clipboardWriteHandler({ text: "delivery-target" });
    const raw = envelopeText(res);
    const parsed = body(res);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("ClipboardWriteNotDelivered");
    expect(raw).not.toContain(RACING_SECRET);
    expect(raw).not.toContain(Buffer.from(RACING_SECRET, "utf16le").toString("base64"));

    // The post-close read is the leg that saw the interception, so its count is
    // the one reported.
    expect(parsed.context?.expectedBytes).toBe(Buffer.from("delivery-target", "utf16le").length);
    expect(parsed.context?.actualBytes).toBe(Buffer.from(RACING_SECRET, "utf16le").length);
    expect(typeof parsed.context?.expectedBytes).toBe("number");
    expect(typeof parsed.context?.actualBytes).toBe("number");
    // No spawn happened, so the base64 blob never existed to leak in the first
    // place — the structural half of the same guarantee.
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("reports 0 bytes when the clipboard was cleared rather than replaced", async () => {
    nativeState.write.mockReturnValue({
      ok: false,
      reason: "clipboard_replaced_after_write",
      expectedBytes: Buffer.from("delivery-target", "utf16le").length,
      inSessionReadable: true,
      inSessionBytes: Buffer.from("delivery-target", "utf16le").length,
      inSessionMatch: true,
      postCloseChecked: true,
      postCloseBytes: 0,
      postCloseMatch: false,
      sequenceAfterWrite: 5,
    });

    const parsed = body(await clipboardWriteHandler({ text: "delivery-target" }));
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("ClipboardWriteNotDelivered");
    expect(parsed.context?.actualBytes).toBe(0);
  });

  it("omits actualBytes rather than reporting a 0 no leg measured", async () => {
    // The secrecy rule says report counts, not contents — but a count nobody
    // measured is not a count. `actualBytes:0` reads as "the clipboard was
    // empty", which would send a caller chasing a racing app that does not
    // exist when the truth is that the write never got far enough to look.
    nativeState.write.mockReturnValue({
      ok: false,
      reason: "clipboard_lock_contention",
      expectedBytes: Buffer.from("delivery-target", "utf16le").length,
      inSessionReadable: false,
      inSessionBytes: 0,
      inSessionMatch: false,
      postCloseChecked: false,
      postCloseBytes: 0,
      postCloseMatch: false,
      postCloseSkipReason: "write_failed",
      sequenceAfterWrite: 0,
    });

    const res = await clipboardWriteHandler({ text: "delivery-target" });
    const parsed = body(res);
    expect(parsed.ok).toBe(false);
    expect(parsed.context).not.toHaveProperty("actualBytes");
    // The half that still has to hold: no clipboard text anywhere, and the
    // expectation count is still there to diagnose with.
    expect(envelopeText(res)).not.toContain(RACING_SECRET);
    expect(parsed.context?.expectedBytes).toBe(
      Buffer.from("delivery-target", "utf16le").length,
    );
  });
});
