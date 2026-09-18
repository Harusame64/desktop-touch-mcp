/**
 * ADR-036 — the road reader on the parser.
 *
 * `readRoadVocabulary` answered with regexes over comment-stripped text, a literal mask, a brace
 * walk to find `probeRoute`'s body, a `[^{}]*` window for `landing`, and a file-wide regex for the
 * one binding that forwards a refusal. The parser states each of those as a fact about a node. The
 * design, its survey of the executor, and win2's source check that corrected it are in internal
 * `docs/the-road-reader-on-the-parser.md`.
 *
 * **Three kinds of cell, as for the type readers (#681)** — agreement with the scanner through the
 * gate's own call; a producer neither reader has seen, written into the real executor; and
 * behaviour named, with the scanner's answer beside it wherever the two differ on purpose.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readRoadVocabulary as scannerRead } from "../../scripts/lib/route-vocabulary.mjs";
import { readInlineFieldUnion, readRoadVocabulary } from "../../scripts/lib/typescript-source.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string): string => readFileSync(join(REPO, rel), "utf8");

/** The resolver `check-route-vocabulary.mjs` passes — the differential has to call it the same way. */
function gateResolver(): (name: string) => string[] {
  const aim = read("src/engine/aim.ts");
  const owner = read("src/engine/point-owner.ts");
  return (name) =>
    name === "homing.why"
      ? readInlineFieldUnion(aim, "Homing", "why", [])
      : name === "owner.why"
        ? readInlineFieldUnion(owner, "PointOwner", "why", [])
        : [];
}

/** The two producers whose bodies spread a caller's `extra` over the row, as the executor writes them. */
const PRODUCERS = `
function probeRoute(route: string, aimHwnd: bigint | undefined, entity: UiEntity, extra: Record<string, unknown> = {}): void {
  probeAim("act.route", { route, hasAim: aimHwnd !== undefined, ...extra });
}
function probeRefusal(rung: string, refused: string, aimHwnd: bigint | undefined, entity: UiEntity, extra: Record<string, unknown> = {}): void {
  probeRoute("refusal", aimHwnd, entity, { rung, refused, ...extra });
}
`;

describe("the parser answers what the scanner answered, through the gate's own call", () => {
  it("reads the real executor the same, every field and every problem", () => {
    // win2's baseline instruments called the reader WITHOUT the gate's resolver, so 12 of the 24
    // whys were invisible to them (internal `0b9f5a3`). This one calls it the way the gate does.
    const source = read("src/tools/desktop-executor.ts");
    const resolve = gateResolver();
    expect(readRoadVocabulary(source, resolve, "src/tools/desktop-executor.ts")).toEqual(scannerRead(source, resolve));
  });
});

describe("a producer neither reader has seen, written into the real executor", () => {
  const source = read("src/tools/desktop-executor.ts").replace(
    "function probeRoute(",
    'function writtenByTheTest() {\n  probeRoute("a_road_written_only_by_this_test", undefined, entity, { why: "a_why_written_only_by_this_test" });\n' +
      '  probeRefusal("a_rung_written_only_by_this_test", "a_ground_written_only_by_this_test", undefined, entity);\n}\nfunction probeRoute(',
  );

  it.each([
    ["route", "a_road_written_only_by_this_test"],
    ["why", "a_why_written_only_by_this_test"],
    ["rung", "a_rung_written_only_by_this_test"],
    ["refused", "a_ground_written_only_by_this_test"],
  ])("finds the %s both readers must find", (field, value) => {
    const resolve = gateResolver();
    const parsed = readRoadVocabulary(source, resolve) as unknown as Record<string, string[]>;
    const scanned = scannerRead(source, resolve) as unknown as Record<string, string[]>;
    expect(parsed[field]).toContain(value);
    expect(scanned[field]).toContain(value);
  });
});

describe("the shapes the pin already counts, in the executor's own nesting (win2, internal `cb0f6d6`)", () => {
  it("reads rung and refused off a row that is not act.route (B1)", () => {
    // `identity_changed` / `aim_identity_changed` exist only on the act.identity row, and are pinned.
    // Reading only the road object's depth one would have moved rung and refused by one each.
    const source = `probeAim("act.identity", {
  refused: verdict === "changed" ? "aim_identity_changed" : null,
  rung: verdict === "changed" ? "identity_changed" : null,
});`;
    const out = readRoadVocabulary(source);
    expect(out.rung).toEqual(["identity_changed"]);
    expect(out.refused).toEqual(["aim_identity_changed"]);
    expect(out.problems).toEqual([]);
  });

  it("reads owner.why inside a conditional spread inside a conditional object (B2)", () => {
    // The four PointOwner.why values reach the pin only from here. The older cell writes
    // `{ why: owner.why }` at depth one, which is not the tree's shape.
    const source = `probeRoute("containment_check", undefined, entity, {
  pointOwner: owner ? { kind: owner.kind, ...("why" in owner ? { why: owner.why } : {}) } : null,
});`;
    const out = readRoadVocabulary(source, (name) => (name === "owner.why" ? ["from_the_owner_union"] : []));
    expect(out.why).toEqual(["from_the_owner_union"]);
    expect(out.problems).toEqual([]);
  });
});

describe("where the parser answers differently from the scanner, on purpose", () => {
  it("reads BOTH branches of a conditional, where the scanner read the one after `?`", () => {
    const source = 'probeAim("act.identity", { rung: changed ? "when_true" : "when_false" });';
    expect(readRoadVocabulary(source).rung).toEqual(["when_false", "when_true"]);
    expect(scannerRead(source).rung).toEqual(["when_true"]);
  });

  it("does not read a `why:` spelled inside a string", () => {
    const source = 'const advice = \'set why: "in_prose" on the row\';\nprobeRoute("uia", undefined, entity, { why: "real" });';
    expect(readRoadVocabulary(source).why).toEqual(["real"]);
    expect(scannerRead(source).why).toContain("in_prose");
  });

  it("keeps a road why that shares its spelling with a landing why", () => {
    // The scanner subtracted the landing's whys from the road axis GLOBALLY, which deletes a road
    // why of the same spelling in silence. Scoped to the landing object, it cannot.
    const source =
      'probeRoute("keyboard", undefined, entity, { why: "receiver_unknown" });\n' +
      'function k() {\n  return { kind: "keyboard", landing: { confirmed: false, why: "receiver_unknown" } };\n}\n';
    const out = readRoadVocabulary(source);
    expect(out.why).toEqual(["receiver_unknown"]);
    expect(out.landingWhyOnTheRow).toEqual(["receiver_unknown"]);
    expect(scannerRead(source).why).toEqual([]);
  });

  it("reports a non-literal rung, which the scanner did not look at", () => {
    const out = readRoadVocabulary('probeAim("act.route", { route: "x", rung: row.rung });');
    expect(out.problems.join("\n")).toContain("a rung is not a literal: row.rung");
    expect(scannerRead('probeAim("act.route", { route: "x", rung: row.rung });').problems).toEqual([]);
  });

  it("reads adr029Refusal's OWN returns, not a nested function's", () => {
    const source = `function adr029Refusal(err: unknown): string | undefined {
  const describe = () => {
    return "not_a_ground";
  };
  if (err) return "real_ground";
  return undefined;
}
async function probedStep(rung: string, aimHwnd: bigint | undefined, entity: UiEntity, step: () => void) {
  try {
    return await step();
  } catch (err) {
    const refused = adr029Refusal(err);
    if (refused !== undefined) probeRefusal(rung, refused, aimHwnd, entity);
    throw err;
  }
}
probedStep("a_step", undefined, entity, () => {});`;
    const out = readRoadVocabulary(source);
    expect(out.refused).toEqual(["real_ground"]);
    expect(out.problems).toEqual([]);
    expect(scannerRead(source).refused).toContain("not_a_ground");
  });

  it("scopes the refusal binding to the function that forwards it, not the file", () => {
    // The scanner matched `const refused = adr029Refusal(err);` ANYWHERE; a binding in another
    // function exempted a call whose `refused` holds something else.
    const source = `function elsewhere(err: unknown) {
  const refused = adr029Refusal(err);
  return refused;
}
function adr029Refusal(err: unknown) {
  return "g";
}
async function probedStep(rung: string, aimHwnd: bigint | undefined, entity: UiEntity, step: () => void) {
  try {
    return await step();
  } catch (err) {
    const refused = pickAnyGround(err);
    probeRefusal(rung, refused, aimHwnd, entity);
    throw err;
  }
}
probedStep("a_step", undefined, entity, () => {});`;
    expect(readRoadVocabulary(source).problems.join("\n")).toMatch(/probedStep no longer forwards/);
    expect(scannerRead(source).problems).toEqual([]);
  });
});

describe("the refusal binding belongs to the function that makes the call", () => {
  it("does not take a binding written inside a NESTED function of the same body", () => {
    // Found by a mutation the file-vs-function cell above survived: that cell's other binding is in
    // a separate function, which the walk of this body never reaches anyway. The boundary that needs
    // its own cell is a function INSIDE the body — its `refused` is not the one passed.
    const source = `function adr029Refusal(err: unknown) {
  return "g";
}
async function probedStep(rung: string, aimHwnd: bigint | undefined, entity: UiEntity, step: () => void) {
  try {
    return await step();
  } catch (err) {
    const read = () => {
      const refused = adr029Refusal(err);
      return refused;
    };
    const refused = read() ?? "smuggled_ground";
    probeRefusal(rung, refused, aimHwnd, entity);
    throw err;
  }
}
probedStep("a_step", undefined, entity, () => {});`;
    expect(readRoadVocabulary(source).problems.join("\n")).toMatch(/probedStep no longer forwards/);
  });
});

describe("Rule F — an identifier is accepted only as a forward whose values are read elsewhere", () => {
  it("accepts `{ why }` forwarding a parameter annotated with literals, and reads the annotation", () => {
    const source = 'function rung(why: "first_reason" | "second_reason") {\n  probeRoute("keyboard", undefined, entity, { why });\n}\n';
    const out = readRoadVocabulary(source);
    expect(out.why).toEqual(["first_reason", "second_reason"]);
    expect(out.problems).toEqual([]);
  });

  it("reports `{ why }` when it is a LOCAL of the same name, not a parameter", () => {
    // The distinction: same spelling, same shorthand, a different binding.
    const source = 'function rung() {\n  const why = pickOne();\n  probeRoute("keyboard", undefined, entity, { why });\n}\n';
    expect(readRoadVocabulary(source).problems.join("\n")).toContain("a shorthand `why` is not a forward");
  });

  it("accepts an arrow producer bound to a const, forwarding its parameters", () => {
    // `refusal` in the executor is `const refusal = (rung, refused, err) => …`, not a declaration.
    const source = `const refusal = (rung: string, refused: string, err: Error): Error => {
  probeAim("act.route", { route: "refusal", rung, refused });
  return err;
};
throw refusal("a_rung", "a_ground", new Error("x"));`;
    const out = readRoadVocabulary(source);
    expect(out.rung).toEqual(["a_rung"]);
    expect(out.refused).toEqual(["a_ground"]);
    expect(out.route).toEqual(["refusal"]);
    expect(out.problems).toEqual([]);
  });

  it("reports `{ rung }` forwarding a parameter of a function nobody reads", () => {
    const source = 'function notAProducer(rung: string) {\n  probeAim("act.route", { route: "x", rung });\n}\n';
    expect(readRoadVocabulary(source).problems.join("\n")).toContain("a shorthand `rung` is not a forward");
  });
});

describe("a type declaration is not a value the executor writes", () => {
  it.each([
    ["a type literal's field", 'type Shape = { why: "declared_not_written"; via: Via };\n'],
    ["an interface's field", 'interface Shape {\n  why: "declared_not_written";\n}\n'],
    ["a parameter nobody forwards", 'function f(why: "declared_not_written" | "also_declared") {\n  return why.length;\n}\n'],
  ])("does not count %s as a why", (_label, source) => {
    // win2, internal `b660d03`: the first version read every `why:` annotation in the file, so a
    // type declaration counted as a road value — silently, when its value was a literal.
    const out = readRoadVocabulary(source as string);
    expect(out.why).toEqual([]);
    expect(out.problems).toEqual([]);
  });
});

describe("Rule S — a spread comes last, so a caller's extra overrides the positional value", () => {
  it("reports a route passed in probeRoute's extra: the row carries it, not the one read", () => {
    // win2 measured the scanner on this: ["uia"], no problem — the row's `mouse` dropped in silence.
    const source = `${PRODUCERS}\nprobeRoute("uia", undefined, entity, { route: "mouse" });\n`;
    expect(readRoadVocabulary(source).problems.join("\n")).toMatch(/probeRoute\(…\) at line \d+ passes `route`/);
    expect(scannerRead(source).problems).toEqual([]);
  });

  it("reports rung and refused passed in probeRefusal's extra, which forwards into probeRoute's", () => {
    // The over-count direction: the scanner counted both pairs.
    const source = `${PRODUCERS}\nprobeRefusal("uia_click", "window_excluded", undefined, entity, { rung: "x", refused: "y" });\n`;
    const text = readRoadVocabulary(source).problems.join("\n");
    expect(text).toMatch(/probeRefusal\(…\) at line \d+ passes `rung`/);
    expect(text).toMatch(/probeRefusal\(…\) at line \d+ passes `refused`/);
  });

  it("reports a route passed through probeRefusal's extra, two spreads deep", () => {
    const source = `${PRODUCERS}\nprobeRefusal("uia_click", "window_excluded", undefined, entity, { route: "sneaky" });\n`;
    expect(readRoadVocabulary(source).problems.join("\n")).toMatch(/probeRefusal\(…\) at line \d+ passes `route`/);
  });

  it("does not report a why in the extra, which is how a why reaches the row", () => {
    // The distinction: `why` is not written before the spread, so nothing is overridden.
    const source = `${PRODUCERS}\nprobeRoute("uia", undefined, entity, { why: "uia_invoke" });\n`;
    const out = readRoadVocabulary(source);
    expect(out.problems).toEqual([]);
    expect(out.why).toEqual(["uia_invoke"]);
  });
});

describe("the landing axis", () => {
  it("reads a landing's literal why and its draw from the union, and nothing else as landing", () => {
    const source =
      'function a() { return { landing: { confirmed: false, why: "receiver_unknown" } }; }\n' +
      "function b() { return { landing: { confirmed: true, why: verdict.why } }; }\n";
    const out = readRoadVocabulary(source);
    expect(out.landingWhyOnTheRow).toEqual(["receiver_unknown"]);
    expect(out.landingWhyDrawsFromTheUnion).toBe(true);
    expect(out.why).toEqual([]);
    expect(out.problems).toEqual([]);
  });

  it("reports verdict.why written outside a landing object", () => {
    expect(readRoadVocabulary('probeRoute("keyboard", undefined, entity, { why: verdict.why });').problems.join("\n")).toContain(
      "a why is not a literal: verdict.why",
    );
  });
});

it("REPORTS AN EXECUTOR THAT DID NOT PARSE, and names the file", () => {
  const problems = readRoadVocabulary('probeRoute("uia", undefined, entity, {\n', () => [], "src/tools/desktop-executor.ts").problems;
  expect(problems.join("\n")).toContain("src/tools/desktop-executor.ts did not parse");
});

describe("gate 2 on #682 — each finding's own input, as a cell", () => {
  it("ends when one function spreads two parameters (it hung the gate)", () => {
    const started = Date.now();
    // Road fields before EACH spread, so both parameters are recorded as overriding — the shape
    // that flipped the single index per name forever. `{ ...a, ...b }` alone no longer reaches it:
    // a spread with nothing before it overrides nothing and is skipped first.
    const out = readRoadVocabulary(
      `${PRODUCERS}\nfunction merge(a: object, b: object) {\n  return { route: "r", ...a, why: "w", ...b };\n}\nmerge({ route: "x" }, { why: "y" });\n`,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out.problems.join("\n")).toMatch(/merge\(…\) at line \d+ passes `route`/);
    expect(out.problems.join("\n")).toMatch(/merge\(…\) at line \d+ passes `why`/);
  });

  it.each([
    ["a variable", `${PRODUCERS}\nconst extra = { route: "mouse" };\nprobeRoute("uia", undefined, entity, extra);\n`, /passes `extra` where a route in it would override/],
    ["a conditional of objects", `${PRODUCERS}\nprobeRoute("uia", undefined, entity, c ? { route: "mouse" } : {});\n`, /passes `route` in an object spread over the row/],
  ])("reports %s in the extra position, which can carry a route", (_label, source, expected) => {
    expect(readRoadVocabulary(source as string).problems.join("\n")).toMatch(expected as RegExp);
  });

  it("reads a producer called as a method, as the scanner did", () => {
    const out = readRoadVocabulary('this.refusal("hidden_rung", "hidden_ground", new Error("x"));\nprobes.probeRoute("hidden_road", undefined, entity, {});');
    expect(out.rung).toEqual(["hidden_rung"]);
    expect(out.refused).toEqual(["hidden_ground"]);
    expect(out.route).toEqual(["hidden_road"]);
  });

  it("does not accept a forward whose parameter the body writes to", () => {
    const source = `function probeRefusal(rung: string, refused: string, aimHwnd: bigint | undefined, entity: UiEntity) {
  refused = pickAny();
  probeRoute("refusal", aimHwnd, entity, { rung, refused });
}`;
    expect(readRoadVocabulary(source).problems.join("\n")).toContain("a shorthand `refused` is not a forward");
  });

  it("resolves the refusal binding by scope, not by the first declaration of the name", () => {
    const source = `function adr029Refusal(err: unknown) {
  return "g";
}
async function probedStep(rung: string, aimHwnd: bigint | undefined, entity: UiEntity, step: () => void) {
  try {
    return await step();
  } catch (err) {
    if (err) {
      const refused = adr029Refusal(err);
      log(refused);
    }
    const refused = pickAnyGround(err);
    probeRefusal(rung, refused, aimHwnd, entity);
    throw err;
  }
}
probedStep("a_step", undefined, entity, () => {});`;
    expect(readRoadVocabulary(source).problems.join("\n")).toMatch(/probedStep no longer forwards/);
  });

  it("reads the grounds of an adr029Refusal written as an expression-bodied arrow", () => {
    const source = `const adr029Refusal = (err: unknown) => (err instanceof A ? "ground_a" : err instanceof B ? "ground_b" : undefined);`;
    const out = readRoadVocabulary(source);
    expect(out.refused).toEqual(["ground_a", "ground_b"]);
    expect(out.problems).toEqual([]);
  });

  it("says adr029Refusal has moved when the exemption was USED, whatever the caller is called", () => {
    const source = `import { adr029Refusal } from "./elsewhere";
async function stepWithProbe(rung: string, aimHwnd: bigint | undefined, entity: UiEntity) {
  const refused = adr029Refusal(err);
  probeRefusal("step_rung", refused, aimHwnd, entity);
}`;
    expect(readRoadVocabulary(source).problems.join("\n")).toContain("adr029Refusal has moved");
  });

  it.each([
    ["a shorthand why", "const why = pick();\nfunction a() { return { landing: { confirmed: false, why } }; }\n", "a landing why is not a literal: why (shorthand)"],
    ["a spread", "function a() { return { landing: { confirmed: false, ...x } }; }\n", "a landing object spreads `x`"],
  ])("reports %s in a landing object", (_label, source, expected) => {
    expect(readRoadVocabulary(source as string).problems.join("\n")).toContain(expected as string);
  });

  it.each([
    ["a template literal", 'probeAim(`act.route`, { route: "from_a_template" });', "from_a_template"],
    ["parentheses", 'probeAim(("act.route"), { route: "from_parentheses" });', "from_parentheses"],
  ])("reads the act.route row when its kind is written as %s", (_label, source, expected) => {
    expect(readRoadVocabulary(source as string).route).toEqual([expected]);
  });

  it.each([
    ["an assignment to a property", 'facts.why = "assigned_why";', "why", "assigned_why"],
    ["an assignment by element", 'row["rung"] = "assigned_rung";', "rung", "assigned_rung"],
    ["a computed key", 'probeRoute("uia", undefined, entity, { ["why"]: "computed_why" });', "why", "computed_why"],
  ])("reads a row field written as %s", (_label, source, field, value) => {
    const out = readRoadVocabulary(source as string) as unknown as Record<string, string[]>;
    expect(out[field as string]).toContain(value);
  });

  it.each([
    ['"w" as const', 'probeRoute("uia" as const, undefined, entity, { why: "w" as const });'],
    ['"w" satisfies T', 'probeRoute("uia", undefined, entity, { why: "w" satisfies string });'],
    ["a non-null assertion", 'probeRoute("uia", undefined, entity, { why: ("w")! });'],
  ])("reads a literal wrapped as %s, which the scanner read by its prefix", (_label, source) => {
    const out = readRoadVocabulary(source as string);
    expect(out.why).toEqual(["w"]);
    expect(out.route).toEqual(["uia"]);
    expect(out.problems).toEqual([]);
  });
});
