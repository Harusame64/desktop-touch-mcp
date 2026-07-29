/**
 * clipboard-native-backend.test.ts — ADR-033 P1-3, the half that needs a real
 * clipboard.
 *
 * `tests/unit/clipboard-native-dispatch.test.ts` proves the TS↔addon boundary
 * against a fake that mirrors `clipboard_text.rs`. What a fake cannot prove is
 * that the OS agrees: that `CF_UNICODETEXT` really does round-trip an unpaired
 * surrogate, that 100 000 characters really do land (the PowerShell path capped
 * silently at ~12 150 — the user-visible bug ADR-033 removes), and that the
 * two-stage read-back verdict holds against the live clipboard-history service
 * and whatever else on the machine listens for `WM_CLIPBOARDUPDATE`.
 *
 * SIDE EFFECT: every case here REPLACES the machine's clipboard. It lives in
 * the e2e project for that reason and is never part of the unit run. The suite
 * restores whatever text was on the clipboard when it started, which is
 * best-effort: a non-text payload (an image, a file selection) cannot be put
 * back, so do not run this while holding something you care about.
 *
 * Skips (never a silent pass): on a build with no compiled addon there is no
 * native backend to test, and the PowerShell fallback is already covered by
 * `clipboard-readback.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { clipboardWriteHandler, clipboardReadHandler } from "../../src/tools/clipboard.js";
import { hasNativeClipboardText } from "../../src/engine/native-engine.js";
import { parsePayload } from "./helpers/wait.js";

const nativeAvailable = hasNativeClipboardText();

/** `null` = the snapshot read failed, so there is nothing trustworthy to put
 *  back. `""` is a REAL state — an empty clipboard — and must still be
 *  restored, or an originally-empty clipboard keeps the last 100 000-character
 *  test payload. */
let originalText: string | null = null;

beforeAll(async () => {
  if (!nativeAvailable) return;
  const before = parsePayload(await clipboardReadHandler());
  originalText = typeof before.text === "string" ? before.text : null;
});

afterAll(async () => {
  if (!nativeAvailable) return;
  if (originalText !== null) await clipboardWriteHandler({ text: originalText });
});

describe.skipIf(!nativeAvailable)("ADR-033 — the native clipboard backend against the real OS clipboard", () => {
  it("serves the call natively and round-trips", async () => {
    const payload = `dtm-adr033-${Date.now().toString(36)}`;
    const w = parsePayload(await clipboardWriteHandler({ text: payload }));
    expect(w.ok, JSON.stringify(w)).toBe(true);
    // The load-bearing assertion: had the addon probe regressed, this would say
    // "powershell" and the Defender exposure would be back with no other
    // symptom until the next process kill.
    expect(w.backend).toBe("native");

    const r = parsePayload(await clipboardReadHandler());
    expect(r.ok).toBe(true);
    expect(r.backend).toBe("native");
    expect(r.text).toBe(payload);
  });

  it("writes the full 100 000 characters the schema advertises", async () => {
    // The PowerShell path embedded the payload as base64 in a command line and
    // failed with a raw ENAMETOOLONG somewhere past ~12 150 characters — one
    // eighth of the documented limit, for the whole life of the tool.
    const payload = "あ".repeat(100_000);
    const w = parsePayload(await clipboardWriteHandler({ text: payload }));
    expect(w.ok, JSON.stringify(w).slice(0, 300)).toBe(true);
    expect(w.written).toBe(100_000);

    const r = parsePayload(await clipboardReadHandler());
    expect(r.text).toBe(payload);
  });

  const matrix: Array<[name: string, text: string]> = [
    ["cjk-ja", "日本語のテキスト"],
    ["emoji ZWJ family sequence", "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"],
    ["astral CJK ext-B", "\u{20BB7}\u{2A6B2}"],
    ["lone surrogate", "before\uD800after"],
    ["combining marks (NFD next to NFC)", "éé ÅÅ"],
    ["CRLF mixed with LF and a lone CR", "a\r\nb\nc\rd"],
    ["tabs and control chars", "a\tbc"],
    ["single space (empty is covered by the non-text case)", " "],
  ];

  it.each(matrix)("%s survives the real clipboard byte-for-byte", async (_name, text) => {
    const w = parsePayload(await clipboardWriteHandler({ text }));
    expect(w.ok, JSON.stringify(w)).toBe(true);

    const r = parsePayload(await clipboardReadHandler());
    // Byte compare, not string compare: a string compare would hide a
    // normalisation change, which is one of the failure modes under test.
    expect(
      Buffer.from(r.text as string, "utf16le").equals(Buffer.from(text, "utf16le")),
      `round-trip differed for ${_name}`,
    ).toBe(true);
  });

  it("refuses a payload containing an embedded NUL", async () => {
    // CF_UNICODETEXT is NUL-terminated, so this text is unrepresentable and
    // every reader would see it truncated. Failing the write is the honest
    // answer, and it is what the PowerShell path did too.
    const w = parsePayload(await clipboardWriteHandler({ text: "before\u0000after" }));
    expect(w.ok).toBe(false);
    expect(w.code).toBe("ClipboardWriteNotDelivered");
  });
});
