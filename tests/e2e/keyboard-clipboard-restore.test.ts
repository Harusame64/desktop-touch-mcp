/**
 * keyboard-clipboard-restore.test.ts — ADR-033 P2-4: the I-13 invariant against
 * the real clipboard.
 *
 * I-13 (native path): after `keyboard(action=type)` routes through the native
 * `typeViaClipboard` composite, the user's clipboard holds what it held before
 * the call. The unit suites prove the addon is ASKED to snapshot and restore;
 * what they cannot prove is that the OS agrees — that once a real
 * CF_UNICODETEXT round-trip, the clipboard-history service, and a real
 * foreground window are involved, the clipboard actually ends up holding the
 * pre-call content. This is that proof.
 *
 * SIDE EFFECT: replaces the machine's clipboard during the run (that is the
 * point) and pastes into a scratch Notepad window on the live desktop. The
 * suite restores whatever clipboard text it found on entry, best-effort, on
 * the same terms as `clipboard-native-backend.test.ts`.
 *
 * Skips (never a silent pass): without the compiled addon the composite runs
 * the PowerShell fallback, where I-13 is best-effort by decision (plan D-3 /
 * R3 P1-1) — a strict restore assertion would be testing a guarantee the
 * fallback deliberately does not make.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { keyboardTypeHandler } from "../../src/tools/keyboard.js";
import { clipboardWriteHandler, clipboardReadHandler } from "../../src/tools/clipboard.js";
import { hasNativeTypeViaClipboard } from "../../src/engine/native-engine.js";
import { launchNotepad, type NpInstance } from "./helpers/notepad-launcher.js";
import { parsePayload, sleep } from "./helpers/wait.js";
import { restoreAndFocusWindow } from "../../src/engine/win32.js";

const nativeAvailable = hasNativeTypeViaClipboard();

let np: NpInstance;

/** `null` = the entry snapshot read failed, so there is nothing trustworthy to
 *  put back. `""` is a REAL state (an empty clipboard) and is still restored. */
let originalText: string | null = null;

beforeAll(async () => {
  if (!nativeAvailable) return;
  const before = parsePayload(await clipboardReadHandler());
  originalText = typeof before.text === "string" ? before.text : null;
  np = await launchNotepad();
  try { restoreAndFocusWindow(np.hwnd); } catch { /* non-fatal */ }
  await sleep(400);
}, 15_000);

afterAll(async () => {
  np?.kill();
  if (nativeAvailable && originalText !== null) {
    await clipboardWriteHandler({ text: originalText });
  }
});

describe.skipIf(!nativeAvailable)("ADR-033 I-13 — native typeViaClipboard puts the user's clipboard back", () => {
  it("restores the pre-call clipboard text after a clipboard-routed type", async () => {
    // Seed the "user's clipboard" with a value the paste payload cannot be
    // mistaken for. If the restore is a no-op (or restores our own payload),
    // the final read below cannot accidentally pass.
    const sentinel = `dtm-i13-original-${Date.now().toString(36)}`;
    const w = parsePayload(await clipboardWriteHandler({ text: sentinel }));
    expect(w.ok, JSON.stringify(w)).toBe(true);

    try { restoreAndFocusWindow(np.hwnd); } catch { /* non-fatal */ }
    await sleep(200);

    const result = await keyboardTypeHandler({
      text: "I-13 実機検証テキスト",
      use_clipboard: true,
      windowTitle: np.title,
      settleMs: 200,
    });
    const p = parsePayload(result);
    expect(p.ok, JSON.stringify(p).slice(0, 400)).toBe(true);
    expect(p.method).toBe("clipboard");

    const clip = (p.hints as { clipboard?: Record<string, unknown> } | undefined)?.clipboard;
    expect(clip, "hints.clipboard must disclose the side effect").toBeTruthy();
    // The invariant under test is native-only: a silent fallback to PowerShell
    // would not FAIL the strict assertions below so much as make them
    // meaningless, so the backend is load-bearing, not informational.
    expect(clip!.backend).toBe("native");
    expect(clip!.restored, JSON.stringify(clip)).toBe(true);

    // The load-bearing half: the OS clipboard, not the response envelope, says
    // the snapshot came back.
    const r = parsePayload(await clipboardReadHandler());
    expect(r.ok).toBe(true);
    expect(r.text).toBe(sentinel);
  });
});
