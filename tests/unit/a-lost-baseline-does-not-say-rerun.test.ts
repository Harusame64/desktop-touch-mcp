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
    expect(catalog).toContain("the command may have run — read this terminal before sending it again");
    expect(catalog).not.toMatch(/baseline_lost[^"]*rerun with/);
  });

  it("the run reply's advice and warning say to read this terminal first, and name no rerun or other mode", () => {
    const src = read("tools/terminal.ts");
    const at = src.indexOf('code: "BaselineMarkerLost"');
    expect(at).toBeGreaterThan(-1);
    // the readError block and the warning pushed with it
    const block = src.slice(at, src.indexOf(");", src.indexOf("warnings.push(", at)));
    expect(block).toMatch(/Do NOT send the command again until you have read this terminal/);
    expect(block).toMatch(/Read this terminal before sending it again/);
    // no advice that sends it again or switches mode to retry it (gate 2 on #923: exit mode with a lost
    // marker returns earlier text as ok)
    expect(block).not.toMatch(/rerun|retry|re-run|timeoutMs|mode:'(pattern|exit|quiet)'/i);
  });
});
