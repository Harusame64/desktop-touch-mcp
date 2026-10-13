/**
 * internal #282 — the server's shutdown closes the key locker for good.
 *
 * `KeyLockerWiring.stop()` runs at shutdown. It used `manager.dispose()`, which is also the idle dormancy and
 * lets the next op restart the host: the loop's clean-up after the disposed capture then spawned a second
 * `key-locker.exe` at the quit second, which nothing connected to (win2, 2026-10-13; the 2.3.0 shape). It must
 * call `close()`, after which no op can start one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KeyLockerClosedError, KeyLockerManager } from "../../src/engine/key-locker/key-locker-manager.js";
import { KeyLockerWiring } from "../../src/tools/key-locker-wiring.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("KeyLockerWiring.stop", () => {
  it("closes the manager, so a later op throws instead of spawning a helper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dtm-kl-stop-"));
    dirs.push(dir);
    const manager = new KeyLockerManager({ storeDir: dir });
    const close = vi.spyOn(manager, "close");
    const wiring = new KeyLockerWiring(manager);
    await wiring.stop();
    expect(close).toHaveBeenCalledTimes(1);
    await expect(manager.withHost(async () => "x")).rejects.toBeInstanceOf(KeyLockerClosedError);
  });
});
