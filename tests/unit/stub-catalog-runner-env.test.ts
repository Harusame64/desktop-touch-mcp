/**
 * internal #252, gate 2 round 3 on #792 — what `npm run check:stub-catalog` / `generate:stub-catalog`
 * hand the vitest run they spawn.
 *
 * `--check` must not write: a runner that passed the write flag in check mode rewrote a stale
 * catalog and exited 0, and no cell failed. And neither mode may carry a kill switch into the run:
 * the catalog is the default configuration, and some switches are read when a tool module is
 * imported.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KILL_SWITCHES, WRITE_FLAG, stubCatalogEnv } from "../../scripts/lib/stub-catalog-env.mjs";

const dirty = { PATH: "x", [WRITE_FLAG]: "1", DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2: "1", DESKTOP_TOUCH_DISABLE_KEY_LOCKER: "1" };

describe("the stub-catalog runner's environment", () => {
  it("in --check mode carries no write flag, even from a caller that has one set", () => {
    const env = stubCatalogEnv(dirty, true) as Record<string, string>;
    expect(WRITE_FLAG in env).toBe(false);
    expect(env.PATH).toBe("x"); // CONTROL: the rest of the environment passes through
  });

  it("in generate mode sets the write flag", () => {
    expect((stubCatalogEnv({ PATH: "x" }, false) as Record<string, string>)[WRITE_FLAG]).toBe("1");
  });

  it("drops every kill switch in both modes", () => {
    for (const check of [true, false]) {
      const env = stubCatalogEnv(dirty, check) as Record<string, string>;
      for (const name of KILL_SWITCHES as string[]) expect(name in env, `${name} (check=${check})`).toBe(false);
    }
  });

  it("is what the runner spawns vitest with", () => {
    // The helper is only a guarantee if the runner uses it for the spawn.
    const runner = readFileSync(fileURLToPath(new URL("../../scripts/generate-stub-tool-catalog.mjs", import.meta.url)), "utf8");
    expect(runner).toMatch(/env:\s*stubCatalogEnv\(process\.env,\s*CHECK\)/);
    expect(runner).toMatch(/const CHECK = process\.argv\.includes\("--check"\);/);
  });
});
