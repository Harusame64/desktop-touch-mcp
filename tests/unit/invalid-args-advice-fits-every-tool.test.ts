/**
 * internal #244 — `InvalidArgs` advice is handed to every tool that refuses its arguments, so it
 * may only say what is true of all of them.
 *
 * Found on v2.1.0 (win2, 2026-10-04): `screenshot(mode='background', detail='text')` was refused
 * with a correct message, and `suggest[]` added "At least one of name or automationId must be
 * provided" — click_element's rule, for a tool that takes neither. The advice table is keyed by
 * code alone; the line belonged in the three tools' own messages, which already carry it.
 */
import { describe, expect, it } from "vitest";
import { failArgs, getSuggestsForCode } from "../../src/tools/_errors.js";

function suggestOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string[] {
  const block = result.content[0];
  if (!block || typeof block.text !== "string") throw new Error("expected text content");
  return (JSON.parse(block.text) as { suggest?: string[] }).suggest ?? [];
}

describe("InvalidArgs advice", () => {
  it("does not name another tool's arguments on a screenshot refusal", () => {
    const suggest = suggestOf(failArgs(
      "screenshot(mode='background') only supports detail in {'image','meta'}; got detail='text'.",
      "screenshot",
    ));
    // CONTROL: advice is still given, so "no automationId" is not what an empty list answers.
    expect(suggest.length).toBeGreaterThan(0);
    expect(suggest.join(" ")).not.toMatch(/automationId/);
  });

  it("carries no line about name / automationId in the shared table", () => {
    expect(getSuggestsForCode("InvalidArgs").join(" ")).not.toMatch(/automationId/);
  });
});
