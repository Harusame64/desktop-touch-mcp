/**
 * phase7-f3-spawn-failed-typed-code.test.ts — Phase 7 F3 unit tests.
 *
 * Pins the `SpawnFailed` typed code contract added in Phase 7 (Phase 6
 * dogfood F3 follow-up). production handler `workspace_launch` previously
 * fell through to generic `ToolError` for spawnDetached rejections (ENOENT
 * / EACCES / EPERM); F3 fix prefixes the rejection messages with
 * "SpawnFailed:" so `_errors.ts::classify()` upgrades them to the typed
 * `SpawnFailed` enum + emits SUGGESTS recovery hints.
 *
 * matrix doc §3.1 line 156 (workspace_launch error path),
 * `docs/llm-audit/phase6-dogfood-findings.md` §F3 expectation.
 */

import { describe, it, expect } from "vitest";
import { failWith, getSuggestsForCode } from "../../src/tools/_errors.js";

describe("Phase 7 F3: SpawnFailed typed code", () => {
  it("failWith maps `SpawnFailed: Command \"x\" not found...` to code:'SpawnFailed' (ENOENT path)", () => {
    const err = new Error(`SpawnFailed: Command "__nonexistent_app__.exe" not found. Provide the full path (e.g. "C:\\Program Files\\App\\app.exe").`);
    const result = failWith(err, "workspace_launch");
    const body = JSON.parse(result.content[0]!.text);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("SpawnFailed");
    expect(body.error).toContain("workspace_launch failed");
    expect(body.error).toContain("SpawnFailed:");
    expect(Array.isArray(body.suggest)).toBe(true);
    expect(body.suggest.length).toBeGreaterThan(0);
  });

  it("failWith maps `SpawnFailed: Permission denied...` to code:'SpawnFailed' (EACCES path)", () => {
    const err = new Error(`SpawnFailed: Permission denied for "blocked.exe". Check that the file is executable and not blocked by policy.`);
    const result = failWith(err, "workspace_launch");
    const body = JSON.parse(result.content[0]!.text);
    expect(body.code).toBe("SpawnFailed");
  });

  it("failWith maps `SpawnFailed: spawn failed for...` to code:'SpawnFailed' (other OS error path)", () => {
    const err = new Error(`SpawnFailed: spawn failed for "weird.exe": EBUSY`);
    const result = failWith(err, "workspace_launch");
    const body = JSON.parse(result.content[0]!.text);
    expect(body.code).toBe("SpawnFailed");
  });

  it("classify falls back to generic ToolError when message lacks SpawnFailed prefix", () => {
    // Sanity check: ensures the typed-code upgrade depends on the prefix,
    // not just any "command not found" / "spawn" substring (otherwise the
    // F3 fix would over-classify unrelated errors).
    const err = new Error(`some unrelated error containing the word spawn that should not be misclassified`);
    const result = failWith(err, "unrelated_tool");
    const body = JSON.parse(result.content[0]!.text);
    expect(body.code).toBe("ToolError");
  });

  it("SUGGESTS dictionary exposes SpawnFailed via getSuggestsForCode()", () => {
    const suggests = getSuggestsForCode("SpawnFailed");
    expect(suggests.length).toBeGreaterThanOrEqual(3);
    // Recovery hints should mention key remediation paths surfaced in
    // the error message: full path, permission, elevation.
    const joined = suggests.join(" ").toLowerCase();
    expect(joined).toContain("path");
    expect(joined).toContain("permission");
  });

  it("SpawnFailed classify has higher priority than generic 'not found' classify cascades", () => {
    // SpawnFailed message contains "not found" substring that could collide
    // with WindowNotFound branch ("window not found" / "no window") today
    // — in practice no collision because the literal substrings differ —
    // but verify the SpawnFailed branch wins for any message containing
    // both "spawnfailed" and "not found".
    const err = new Error(`SpawnFailed: Command "x.exe" not found. some window not found context appended`);
    const result = failWith(err, "workspace_launch");
    const body = JSON.parse(result.content[0]!.text);
    expect(body.code).toBe("SpawnFailed");
  });
});
