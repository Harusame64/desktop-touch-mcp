/**
 * A typed error exists to replace "something went wrong" with a name and a way out. The name
 * lives in `errors/typed-errors.ts`; the way out lives in `_errors.ts`'s `SUGGESTS`, keyed by
 * that name. Half of that is not a typed error — it is a rename.
 *
 * Written after ADR-036 shipped the half without the advice. `AimWindowGone` got its own
 * `TouchFailReason`, its own catch arm and its own envelope, and came back to the caller as
 * "Inspect the underlying error and retry with adjusted args" — the generic line, which does not
 * say to re-discover and, worse, does not close the road the whole refusal exists to close
 * (retrying at the entity's rect, where the window used to be). The rule was written next door in
 * the sibling errors' docstrings, and each round followed a different half of it: the catch arm
 * one round, the advice the next (measured on Windows 2026-09-09, both halves by win2).
 *
 * The classify-cascade invariant explicitly does not look here — "plus the SUGGESTS table
 * contents themselves" is listed among the things outside its anchor — so this is the seam.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const typedErrors = readFileSync(join(root, "src/errors/typed-errors.ts"), "utf8");
const errorsModule = readFileSync(join(root, "src/tools/_errors.ts"), "utf8");

/** The base class carries no name of its own — every concrete error assigns one. */
const BASE = "HandlerError";

function declaredErrorNames(): string[] {
  return [...typedErrors.matchAll(/this\.name = "([^"]+)"/g)]
    .map((m) => m[1]!)
    .filter((n) => n !== BASE);
}

function suggestKeys(): Set<string> {
  const table = errorsModule.slice(errorsModule.indexOf("const SUGGESTS"));
  return new Set([...table.matchAll(/^ {2}([A-Za-z][A-Za-z0-9_]*):\s*\[/gm)].map((m) => m[1]!));
}

describe("every typed error carries a recovery", () => {
  it("finds the names at all — the extraction is the trust anchor", () => {
    // If this shrinks to nothing the test below passes vacuously, which is the failure mode of
    // every source-reading invariant.
    const names = declaredErrorNames();
    expect(names.length).toBeGreaterThanOrEqual(5);
    expect(names).toContain("AimWindowGone");
    expect(suggestKeys().size).toBeGreaterThan(20);
  });

  it("has a SUGGESTS entry for each of them", () => {
    const keys = suggestKeys();
    const missing = declaredErrorNames().filter((n) => !keys.has(n));
    expect(missing, `typed errors with no recovery advice: ${missing.join(", ")}`).toEqual([]);
  });

  it("gives them advice worth reading, not a placeholder", () => {
    // One line saying "retry" is the generic fallback wearing a specific name. Each of these
    // errors was created because the generic advice was wrong for it.
    const table = errorsModule.slice(errorsModule.indexOf("const SUGGESTS"));
    for (const name of declaredErrorNames()) {
      const entry = new RegExp(`^ {2}${name}:\\s*\\[([\\s\\S]*?)^ {2}\\]`, "m").exec(table);
      expect(entry, `${name} has no readable SUGGESTS block`).not.toBeNull();
      const lines = [...entry![1]!.matchAll(/"([^"]{10,})"/g)];
      expect(lines.length, `${name} should suggest more than one thing`).toBeGreaterThanOrEqual(2);
    }
  });
});
