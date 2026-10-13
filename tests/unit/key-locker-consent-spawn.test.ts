/**
 * internal #282 (review on 036ed740) — the first-run consent dialog is told which server it belongs to, so it
 * closes by itself when that server exits (the helper's `-Consent` path watches `-McpPid`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawned: string[][] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((_exe: string, args: string[]) => {
      spawned.push(args);
      const child = new EventEmitter();
      setTimeout(() => child.emit("exit", 0), 0);
      return child;
    }),
  };
});

const { KeyLockerManager } = await import("../../src/engine/key-locker/key-locker-manager.js");

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); spawned.length = 0; });

describe("the consent dialog spawn", () => {
  it("passes this server's pid as -McpPid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dtm-kl-consent-"));
    dirs.push(dir);
    const mgr = new KeyLockerManager({ storeDir: dir });
    await mgr.ensureConsent(); // no consent.json: spawns the dialog, which "closes" at once
    const args = spawned.find((a) => a.includes("-Consent"));
    expect(args).toBeDefined();
    const i = args!.indexOf("-McpPid");
    expect(i).toBeGreaterThan(-1);
    expect(args![i + 1]).toBe(String(process.pid));
  });
});
