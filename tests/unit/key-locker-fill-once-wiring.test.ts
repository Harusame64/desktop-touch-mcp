// key-locker-fill-once-wiring.test.ts — internal #280: the WIRING routes fill_once's prompt read through
// `widenForFillOnce`, and leaves the capture loop's read alone. The pure widening is pinned in
// key-locker-fill-once.test.ts; this pins the one line that connects it (reverting it kept every other test
// green — PR #812 Opus P3). The pane read is faked; `runFillOnce` is replaced to capture the live seams.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/engine/nutjs.js", () => ({ mouse: { getPosition: vi.fn() } }));

const TAIL = "PS C:\\Users\\a> ssh jump\r\nEnter passphrase for key 'owner\\.ssh\\ssh_key': ";
vi.mock(import("../../src/tools/terminal.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolvePaneTitle: vi.fn(() => "dtm-locker-console-1"),
    readTerminalRaw: vi.fn(async () => ({ text: TAIL }) as never),
  };
});

let seams: import("../../src/engine/key-locker/fill-once.js").FillOnceDeps | null = null;
vi.mock(import("../../src/engine/key-locker/fill-once.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runFillOnce: vi.fn(async (deps) => { seams = deps; return { kind: "cancelled" } as const; }),
  };
});

import { KeyLockerManager } from "../../src/engine/key-locker/key-locker-manager.js";
import { KeyLockerWiring } from "../../src/tools/key-locker-wiring.js";
import type { CaptureDriverDeps } from "../../src/engine/key-locker/key-locker-capture-driver.js";

describe("fill_once reads the pane through the widened classifier; the loop does not (internal #280)", () => {
  it("the same key-passphrase tail is a prompt for fill_once and not for the capture loop", async () => {
    const wiring = new KeyLockerWiring(new KeyLockerManager({ storeDir: mkdtempSync(join(tmpdir(), "dtm-fo-")) }));
    await wiring.fillOnce("1", "unlock the jump-host key", true);
    expect(seams).not.toBeNull();
    expect(await seams!.readPromptTail("1")).toMatchObject({ isCredentialPrompt: true, tail: TAIL });

    const loop = (wiring as unknown as { driver: { deps: CaptureDriverDeps } }).driver.deps;
    expect(await loop.readPromptTail("1")).toMatchObject({ isCredentialPrompt: false, tail: TAIL });
  });
});
