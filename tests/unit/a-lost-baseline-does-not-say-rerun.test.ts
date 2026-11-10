/**
 * internal #241 — after `baseline_lost` the command was sent and may have run (win2: it had, every time).
 * The advice used to say "rerun with until:{mode:'pattern'} or longer timeoutMs", and a caller that did ran
 * the command twice. The published caveat and the run reply now say to read the terminal first.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), "utf8");

describe("baseline_lost does not tell the caller to run the command again (internal #241)", () => {
  it("the terminal caveat says the command was sent, and to read before sending again", () => {
    const catalog = read("stub-tool-catalog.ts");
    expect(catalog).toContain("the command was sent and may have run — read the terminal before sending it again");
    expect(catalog).not.toMatch(/baseline_lost[^"]*rerun with/);
  });

  it("the run reply's advice leads with not running it again", () => {
    const src = read("tools/terminal.ts");
    const at = src.indexOf('code: "BaselineMarkerLost"');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf("};", at));
    expect(block).toMatch(/Do NOT run the command again/);
    expect(block).not.toMatch(/Increase timeoutMs/);
  });
});
