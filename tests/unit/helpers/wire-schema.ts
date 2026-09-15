/**
 * #657/#662 — ONE definition of "the document a client receives", because two disagreed.
 *
 * `registerTool` converts a tool's input schema with
 * `toJsonSchemaCompat(normalizeObjectSchema(tool.inputSchema), { strictUnions: true,
 * pipeStrategy: 'input' })` (`@modelcontextprotocol/sdk` 1.30.0, `server/mcp.js`). Every part of
 * that matters and each part has already been got wrong once in this PR's own history:
 *
 *   - `z.toJSONSchema`'s DEFAULTS (`draft-2020-12`, `io:"output"`) are a different document:
 *     `io:"output"` promotes a `.default()` field into `required`, so terminal's `until` reads
 *     `required:["mode","quietMs"]` there and `["mode"]` on the wire. A pin on the default
 *     rendering was green about a document nobody receives (gate 2 round 2).
 *   - the CALLER's options, not the callee's defaults: they agree today only because the zod-v4
 *     branch ignores `strictUnions` and defaults `io` to `'input'` (gate 2 round 2).
 *   - `normalizeObjectSchema` FIRST. For a flattened schema it is a no-op — byte-identical,
 *     measured — which is why omitting it looked harmless. It is not: `withEnvelopeIncludeSchema`'s
 *     products are not recognised as zod-4 schemas, so the converter alone takes them down the v3
 *     branch and THROWS (gate 2 round 3, found by a sweep whose first act was to reject the helper
 *     meant to measure it).
 *
 * So it lives here once, and both pinning files import it. Two places defining "the wire" is the
 * defect this PR argues against (gate 2 round 4).
 */
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";

/** The document a client receives, by the path `registerTool` takes. */
export function wire(schema: any): any {
  return toJsonSchemaCompat(normalizeObjectSchema(schema), {
    strictUnions: true,
    pipeStrategy: "input",
  });
}

/**
 * The spelling of a widened property, read from the document rather than assumed — and it THROWS
 * on a shape it does not recognise, so a third spelling fails loudly instead of passing as an
 * absence.
 *
 * THE ABSENCE CHECK IS FIRST, and that ordering is the whole point. It was written last, after the
 * `Array.isArray(prop.anyOf)` line that dereferences `prop` — so the most likely regression of all,
 * the pinned property leaving the wire, still arrived as `TypeError: Cannot read properties of
 * undefined (reading 'anyOf')`: verbatim the failure the check was added to replace. A fix placed
 * downstream of the defect it fixes is not a fix (gate 2 round 4, measured).
 */
export function spellingOf(
  prop: Record<string, unknown> | undefined | null,
): "anyOf" | "oneOf" | "type-array" | "single-type" {
  if (prop === undefined || prop === null) {
    throw new Error("spellingOf: the property is not on the wire at all — it left the schema.");
  }
  if (Array.isArray(prop.anyOf)) return "anyOf";
  if (Array.isArray(prop.oneOf)) return "oneOf";
  if (Array.isArray(prop.type)) return "type-array";
  if (typeof prop.type === "string") return "single-type";
  throw new Error(
    `spellingOf: unrecognised property shape ${JSON.stringify(prop)} — not anyOf, oneOf, a type ` +
      "array or a single type. A fourth spelling must fail this cell rather than read as an absence.",
  );
}

/**
 * Every place in a JSON Schema document where `type` is an ARRAY, by path.
 *
 * RECURSIVE, because a sweep of top-level `properties` cannot support the claim it is the check
 * for. `terminal.until` is a `oneOf` of three objects whose own properties were never looked at,
 * and `keyboard.method`'s `anyOf` branches likewise — so `quietMs: z.number()` in one branch and
 * `z.string()` in another would ship `{"type":["number","string"]}` nested, the one spelling #657
 * says nothing here can vouch for, with a top-level-only sweep still green (gate 2 round 4).
 */
export function typeArrayPaths(node: unknown, path = "$"): string[] {
  if (node === null || typeof node !== "object") return [];
  const found: string[] = [];
  if (!Array.isArray(node)) {
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.type)) found.push(path);
  }
  const entries = Array.isArray(node)
    ? node.map((v, i) => [String(i), v] as const)
    : Object.entries(node as Record<string, unknown>);
  for (const [key, value] of entries) {
    // `type` itself is never a subschema; everything else may be.
    if (key === "type") continue;
    found.push(...typeArrayPaths(value, `${path}.${key}`));
  }
  return found;
}
