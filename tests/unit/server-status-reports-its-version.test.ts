/**
 * internal #377 (2.4.1 dogfood): server_status had no version field, so telling which build answered
 * took a second call or `--help`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { serverStatusHandler } from "../../src/tools/server-status.js";

const pkgVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

describe("server_status", () => {
  it("reports the version this server was built as (package.json's)", async () => {
    const r = await serverStatusHandler();
    const body = JSON.parse((r.content[0] as { text: string }).text);
    expect(body.version).toBe(pkgVersion);
  });
});
