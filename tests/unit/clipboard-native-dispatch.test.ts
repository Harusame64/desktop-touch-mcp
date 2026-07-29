/**
 * clipboard-native-dispatch.test.ts — ADR-033 P1-3 (a) and (c).
 *
 * Two things are pinned here.
 *
 * (a) THE GUARD. When the compiled addon is present, `clipboard` must not spawn
 *     `powershell.exe`. That spawn is the entire reason ADR-033 exists —
 *     Microsoft Defender scored its command line as `Trojan:Win32/Commando.A!ml`
 *     and killed the server process — and a regression that quietly fell back to
 *     it would have no visible symptom until the next kill. So the assertion is
 *     on `execFile` never being called, not merely on the result shape. The
 *     mutation check for this pin (delete the native branch, watch these fail)
 *     is recorded in the ADR-033 PR-1 report.
 *
 * (c) THE ACCURACY MATRIX. The native path takes UTF-16LE BYTES rather than a
 *     napi `String`, because the String bridge transcodes through UTF-8 and
 *     would replace an unpaired surrogate with U+FFFD *before* the read-back
 *     comparison ran — the verification would then pass on mutated text. The
 *     matrix below drives real payloads through the TS layer's encode / decode
 *     and proves that boundary is lossless.
 *
 *     The addon is replaced by a fake that mirrors the two pure functions in
 *     `src/win32/clipboard_text.rs` — `to_terminated_u16` (append a NUL, drop a
 *     trailing odd byte) and `text_bytes_from_raw` (truncate at the first NUL
 *     u16) — so the CF_UNICODETEXT semantics that make embedded NUL a delivery
 *     failure are modelled rather than assumed. Those two functions carry their
 *     own Rust unit tests; the real clipboard round trip is covered by the
 *     `#[ignore]`d Rust tests (`npm run test:native-clipboard`) and by
 *     `tests/e2e/clipboard-native-backend.test.ts`. What this file owns is the
 *     TS↔addon boundary, which is where the String-vs-Buffer bug would live.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

const nativeState: {
  available: boolean;
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
} = { available: true, read: vi.fn(), write: vi.fn() };

// Partial mock: native-engine is the single load point for the whole addon and
// unrelated importers read other members of it at module init, so replacing the
// module wholesale would break them. Only the two clipboard entry points and
// the capability probe are overridden.
vi.mock(import("../../src/engine/native-engine.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    hasNativeClipboardText: () => nativeState.available,
    nativeWin32: {
      ...(actual.nativeWin32 ?? {}),
      win32ClipboardReadText: (...a: unknown[]) => nativeState.read(...a),
      win32ClipboardWriteTextVerified: (...a: unknown[]) => nativeState.write(...a),
    } as unknown as typeof actual.nativeWin32,
  };
});

const { clipboardReadHandler, clipboardWriteHandler } = await import("../../src/tools/clipboard.js");

function body(r: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(r.content[0]!.text!) as Record<string, unknown>;
}

/** promisify(execFile) resolves whatever the callback's (stdout, stderr) are. */
function fakePowerShell(stdout: string) {
  execFileMock.mockImplementation((_file: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
    (cb as (e: null, out: { stdout: string; stderr: string }) => void)(null, { stdout, stderr: "" });
    return {};
  });
}

// ── A fake CF_UNICODETEXT clipboard, mirroring clipboard_text.rs ─────────────

/** `text_bytes_from_raw`: truncate at the first NUL u16, drop a trailing odd byte. */
function textBytesFromRaw(raw: Buffer): Buffer {
  const usable = raw.length - (raw.length % 2);
  for (let i = 0; i + 1 < usable; i += 2) {
    if (raw[i] === 0 && raw[i + 1] === 0) return raw.subarray(0, i);
  }
  return raw.subarray(0, usable);
}

let stored: Buffer | null = null;
let sequence = 0;

/** What `win32_clipboard_write_text_verified` does, minus Win32. */
function fakeNativeWrite(utf16le: Buffer) {
  const usable = utf16le.length - (utf16le.length % 2);
  // `to_terminated_u16` + the HGLOBAL the OS ends up holding.
  stored = Buffer.concat([utf16le.subarray(0, usable), Buffer.from([0, 0])]);
  sequence += 5; // one write bumps the sequence 5 times — measured, ADR-033 P0-2.
  // `expected` is the UNTRUNCATED payload: that is what makes an embedded NUL
  // a delivery failure rather than a silently-passing short round trip.
  const expected = utf16le.subarray(0, usable);
  const readBack = textBytesFromRaw(stored);
  const match = readBack.equals(expected);
  return {
    ok: match,
    reason: match ? undefined : "readback_mismatch",
    expectedBytes: expected.length,
    inSessionReadable: true,
    inSessionBytes: readBack.length,
    inSessionMatch: match,
    postCloseChecked: true,
    postCloseBytes: readBack.length,
    postCloseMatch: match,
    sequenceAfterWrite: sequence,
  };
}

/** What `win32_clipboard_read_text` does, minus Win32. */
function fakeNativeRead() {
  if (stored === null) return { ok: true, hasText: false, bytes: Buffer.alloc(0) };
  return { ok: true, hasText: true, bytes: textBytesFromRaw(stored) };
}

beforeEach(() => {
  execFileMock.mockReset();
  nativeState.read.mockReset();
  nativeState.write.mockReset();
  nativeState.available = true;
  stored = null;
  sequence = 0;
});

// ── (a) the guard ───────────────────────────────────────────────────────────

describe("ADR-033 — with the addon present, clipboard never spawns powershell.exe", () => {
  beforeEach(() => {
    nativeState.write.mockImplementation(fakeNativeWrite);
    nativeState.read.mockImplementation(fakeNativeRead);
  });

  it("write goes native and spawns nothing", async () => {
    const r = body(await clipboardWriteHandler({ text: "hello" }));
    expect(r.ok).toBe(true);
    expect(r.backend).toBe("native");
    expect(execFileMock).not.toHaveBeenCalled();
    // And the addon received UTF-16LE bytes, not a string.
    const passed = nativeState.write.mock.calls[0]![0] as Buffer;
    expect(Buffer.isBuffer(passed)).toBe(true);
    expect(passed.equals(Buffer.from("hello", "utf16le"))).toBe(true);
  });

  it("read goes native and spawns nothing", async () => {
    await clipboardWriteHandler({ text: "hello" });
    const r = body(await clipboardReadHandler());
    expect(r.text).toBe("hello");
    expect(r.backend).toBe("native");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("a payload past the fallback's command-line ceiling still goes native", async () => {
    // The ~12000-character cap belongs to the PowerShell fallback's command
    // line. Applying it on the native path would reintroduce the very bug
    // ADR-033 fixes, so the schema's 100000 must go through untouched.
    const big = "x".repeat(100_000);
    const r = body(await clipboardWriteHandler({ text: big }));
    expect(r.ok).toBe(true);
    expect(r.written).toBe(100_000);
    expect(r.backend).toBe("native");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("a native failure is reported without falling back to powershell.exe", async () => {
    // Silently retrying through PowerShell on a native failure would put the
    // flagged command line back on the wire exactly when something is already
    // wrong — the failure must surface instead.
    nativeState.write.mockReturnValue({
      ok: false,
      reason: "clipboard_lock_contention",
      expectedBytes: 10,
      inSessionReadable: false,
      inSessionBytes: 0,
      inSessionMatch: false,
      postCloseChecked: false,
      postCloseBytes: 0,
      postCloseMatch: false,
      postCloseSkipReason: "write_failed",
      sequenceAfterWrite: 0,
    });
    const r = body(await clipboardWriteHandler({ text: "hello" }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("ClipboardWriteNotDelivered");
    expect(execFileMock).not.toHaveBeenCalled();

    nativeState.read.mockReturnValue({
      ok: false,
      reason: "clipboard_lock_contention",
      hasText: false,
      bytes: Buffer.alloc(0),
    });
    const rr = body(await clipboardReadHandler());
    expect(rr.ok).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("a native read failure stays on generic classification (the oq8 compact-code trap)", async () => {
    // An Error whose whole message is one PascalCase token is this repo's
    // compact-code producer shape and would demand its own SUGGESTS entry.
    // Read failures have no distinct recovery, so the message is lower-case.
    nativeState.read.mockReturnValue({
      ok: false,
      reason: "clipboard_lock_contention",
      hasText: false,
      bytes: Buffer.alloc(0),
    });
    const r = body(await clipboardReadHandler());
    expect(r.ok).toBe(false);
    expect(r.code).toBe("ToolError");
    expect((r.context as Record<string, unknown>)?.backend).toBe("native");
  });
});

// ── (c) the accuracy matrix ─────────────────────────────────────────────────

describe("ADR-033 — payload accuracy across the TS↔addon boundary", () => {
  beforeEach(() => {
    nativeState.write.mockImplementation(fakeNativeWrite);
    nativeState.read.mockImplementation(fakeNativeRead);
  });

  const cases: Array<[name: string, text: string]> = [
    ["ascii", "hello world"],
    ["empty", ""],
    ["cjk-ja", "日本語のテキスト、混在 kana/kanji"],
    ["emoji ZWJ family sequence", "👨‍👩‍👧‍👦 done 🎉"],
    ["astral CJK ext-B", "\u{20BB7}\u{2A6B2}"],
    ["lone surrogate", "before\uD800after"],
    ["combining marks (NFD next to NFC)", "e\u0301é A\u030aÅ"],
    ["CRLF mixed with LF and a lone CR", "a\r\nb\nc\rd"],
    ["tabs and control chars", "a\tbcd"],
    ["100k chars (schema max)", "あ".repeat(100_000)],
    ["1 MiB", "x".repeat(524_288)],
  ];

  it.each(cases)("%s round-trips byte-exactly", async (_name, text) => {
    const w = body(await clipboardWriteHandler({ text }));
    expect(w.ok, JSON.stringify(w).slice(0, 200)).toBe(true);
    expect(w.written).toBe(text.length);

    const r = body(await clipboardReadHandler());
    expect(r.ok).toBe(true);
    // Compare as UTF-16LE bytes: a string compare would hide a normalisation
    // (NFC/NFD) change, which is exactly one of the failure modes here.
    expect(Buffer.from(r.text as string, "utf16le").equals(Buffer.from(text, "utf16le"))).toBe(true);
  });

  it("embedded NUL fails the write — CF_UNICODETEXT cannot represent it", async () => {
    // Not a limitation to route around: the format is NUL-terminated, so every
    // reader would see a truncated string. Failing the write is the honest
    // answer, and it is what the PowerShell path did too.
    const r = body(await clipboardWriteHandler({ text: "before\u0000after" }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("ClipboardWriteNotDelivered");
    const ctx = r.context as Record<string, unknown>;
    // The payload is 12 chars = 24 bytes; a reader sees only "before" = 12.
    expect(ctx.expectedBytes).toBe(Buffer.from("before\u0000after", "utf16le").length);
    expect(ctx.actualBytes).toBe(Buffer.from("before", "utf16le").length);
  });

  it("a successful write reports what backed the verdict", async () => {
    const r = body(await clipboardWriteHandler({ text: "hello" }));
    expect(r.ok).toBe(true);
    // Diagnostic, never the verdict (plan D-5) — but it has to reach the
    // caller, or the two-leg design is invisible from outside.
    expect(typeof r.sequenceAfterWrite).toBe("number");
    expect(r.postCloseChecked).toBe(true);
    // Both legs answered, so neither weak-evidence disclosure is present.
    expect(r).not.toHaveProperty("postCloseSkipReason");
    expect(r).not.toHaveProperty("inSessionReadable");
  });

  it("discloses a skipped post-close leg on an otherwise successful write", async () => {
    // Contention on the verification re-open does not fail the write, but a
    // caller that cares about clipboard-manager interception must be able to
    // tell "checked and clean" from "never looked".
    nativeState.write.mockReturnValue({
      ok: true,
      expectedBytes: 10,
      inSessionReadable: true,
      inSessionBytes: 10,
      inSessionMatch: true,
      postCloseChecked: false,
      postCloseBytes: 0,
      postCloseMatch: false,
      postCloseSkipReason: "clipboard_lock_contention",
      sequenceAfterWrite: 42,
    });
    const r = body(await clipboardWriteHandler({ text: "hello" }));
    expect(r.ok).toBe(true);
    expect(r.postCloseChecked).toBe(false);
    expect(r.postCloseSkipReason).toBe("clipboard_lock_contention");
    expect(r.sequenceAfterWrite).toBe(42);
  });

  it("discloses when only the post-close leg backed the write", async () => {
    // The in-session read failed but the post-close read — the leg with the
    // old PowerShell pair's semantics — agreed, so the write stands on weaker
    // evidence and says so.
    nativeState.write.mockReturnValue({
      ok: true,
      expectedBytes: 10,
      inSessionReadable: false,
      inSessionBytes: 0,
      inSessionMatch: false,
      postCloseChecked: true,
      postCloseBytes: 10,
      postCloseMatch: true,
      sequenceAfterWrite: 7,
    });
    const r = body(await clipboardWriteHandler({ text: "hello" }));
    expect(r.ok).toBe(true);
    expect(r.inSessionReadable).toBe(false);
    expect(r.postCloseChecked).toBe(true);
  });

  it("omits actualBytes when no read-back leg measured anything", async () => {
    // The write itself failed, so no leg read the clipboard. Reporting 0 would
    // say "the clipboard was empty", which is a different — and wrong —
    // diagnosis from "nothing was measured".
    nativeState.write.mockReturnValue({
      ok: false,
      reason: "clipboard_lock_contention",
      expectedBytes: 30,
      inSessionReadable: false,
      inSessionBytes: 0,
      inSessionMatch: false,
      postCloseChecked: false,
      postCloseBytes: 0,
      postCloseMatch: false,
      postCloseSkipReason: "write_failed",
      sequenceAfterWrite: 0,
    });
    const r = body(await clipboardWriteHandler({ text: "hello" }));
    expect(r.ok).toBe(false);
    const ctx = r.context as Record<string, unknown>;
    expect(ctx).not.toHaveProperty("actualBytes");
    expect(ctx.expectedBytes).toBe(30);
    expect(ctx.hint).toBe("clipboard_lock_contention");
  });

  it("reports the in-session count when only that leg measured anything", async () => {
    nativeState.write.mockReturnValue({
      ok: false,
      reason: "readback_mismatch",
      expectedBytes: 30,
      inSessionReadable: true,
      inSessionBytes: 8,
      inSessionMatch: false,
      postCloseChecked: false,
      postCloseBytes: 0,
      postCloseMatch: false,
      postCloseSkipReason: "clipboard_lock_contention",
      sequenceAfterWrite: 5,
    });
    const r = body(await clipboardWriteHandler({ text: "hello" }));
    expect((r.context as Record<string, unknown>).actualBytes).toBe(8);
  });

  it("a non-text clipboard payload reads as the empty string", async () => {
    nativeState.read.mockReturnValue({ ok: true, hasText: false, bytes: Buffer.alloc(0) });
    const r = body(await clipboardReadHandler());
    expect(r.ok).toBe(true);
    expect(r.text).toBe("");
  });
});

// ── the fallback, and its newly explicit ceiling ────────────────────────────

describe("ADR-033 — PowerShell fallback (addon absent)", () => {
  beforeEach(() => {
    nativeState.available = false;
  });

  it("read falls back and labels the backend", async () => {
    fakePowerShell(Buffer.from("fallback", "utf16le").toString("base64"));
    const r = body(await clipboardReadHandler());
    expect(r.text).toBe("fallback");
    expect(r.backend).toBe("powershell");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]![0]).toBe("powershell.exe");
  });

  it("write falls back, verifies the read-back, and never calls the addon", async () => {
    fakePowerShell(Buffer.from("hello", "utf16le").toString("base64"));
    const r = body(await clipboardWriteHandler({ text: "hello" }));
    expect(r.ok).toBe(true);
    expect(r.backend).toBe("powershell");
    expect(nativeState.write).not.toHaveBeenCalled();
  });

  it("write still fails the read-back mismatch as ClipboardWriteNotDelivered (#180)", async () => {
    fakePowerShell(Buffer.from("something else", "utf16le").toString("base64"));
    const r = body(await clipboardWriteHandler({ text: "hello" }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("ClipboardWriteNotDelivered");
    expect((r.context as Record<string, unknown>)?.backend).toBe("powershell");
  });

  it("rejects an over-long payload up front instead of letting spawn fail", async () => {
    // Previously this returned a raw ENAMETOOLONG from `spawn`, hundreds of
    // milliseconds later, for a tool advertising a 100000-character schema.
    const r = body(await clipboardWriteHandler({ text: "x".repeat(20_000) }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("ClipboardWriteTooLargeForFallback");
    expect(Array.isArray(r.suggest) && (r.suggest as string[]).length).toBeGreaterThan(0);
    const ctx = r.context as Record<string, unknown>;
    expect(ctx.requestedChars).toBe(20_000);
    expect(typeof ctx.maxChars).toBe("number");
    expect(ctx.backend).toBe("powershell");
    // The point of the pre-check: nothing was spawned at all.
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("a payload just under the ceiling still goes through", async () => {
    const text = "x".repeat(12_000);
    fakePowerShell(Buffer.from(text, "utf16le").toString("base64"));
    const r = body(await clipboardWriteHandler({ text }));
    expect(r.ok).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("labels the backend when the spawn itself throws", async () => {
    execFileMock.mockImplementation((_f: unknown, _a: unknown, _o: unknown, cb: unknown) => {
      (cb as (e: Error) => void)(new Error("spawn ENOENT"));
      return {};
    });
    const r = body(await clipboardReadHandler());
    expect(r.ok).toBe(false);
    expect((r.context as Record<string, unknown>)?.backend).toBe("powershell");
  });
});
