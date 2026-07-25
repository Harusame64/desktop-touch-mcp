/**
 * ESLint rule: no-suggest-in-failwith-context
 * — ADR-029 follow-up (OQ8).
 *
 * `failWith(err, toolName, context?)` takes a **context record** as its third
 * argument, not an options bag. Everything in it except the three
 * `ROOT_HOISTED_KEYS` (`_perceptionForPost` / `_richForPost` / `hints`) is
 * nested under `context` in the emitted failure. So this:
 *
 *   failWith(err, "mouse_drag", { suggest: ["Pass allowCrossWindowDrag:true"] })
 *
 * puts the recovery advice at `context.suggest`, while the root `suggest` — the
 * one the server instructions tell the model to read — stays whatever
 * `classify(message)` produced, which for an unclassified message is nothing at
 * all. Fourteen call sites had drifted into this shape and five of them were
 * emitting no root advice whatsoever.
 *
 * Nesting `context` inside the context record has the same flavour of bug:
 *
 *   failWith(err, tool, { suggest: [...], context: { windowTitle } })
 *
 * renders as `context.context.windowTitle` — one level deeper than any reader
 * expects. Context keys belong at the top level of that argument.
 *
 * The fix for both is not to pass them here:
 *   - recovery advice belongs in `SUGGESTS` in `_errors.ts`, keyed by the code
 *     that `classify` derives from the message (add a `classify` arm if the
 *     code is new — see the SpawnFailed precedent);
 *   - or use `failCode(code, error, { suggest, context })`, whose third
 *     argument really is an options bag.
 *
 * Scope (wired in eslint.config.mjs): `src/**` minus `_errors.ts`, which
 * defines the helpers and mentions the key names in its own documentation.
 *
 * Callee matching is the union of two signals (Codex R1 P2):
 *   - the name at the call site is one of the helpers (`failWith(...)`,
 *     `errors.failWith(...)`), and
 *   - the callee resolves to a binding imported from `_errors`, which also
 *     covers an alias (`import { failWith as f }` → `f(...)`) and a local
 *     re-alias of one (`const f = failWith`).
 * The union is deliberate: this is a guard rule, so a same-named helper from
 * somewhere else being flagged is a cheap, visible false positive, whereas a
 * missed alias silently recreates the malformed envelope. Suppress with an
 * eslint-disable line if a genuinely unrelated `failWith` ever appears.
 *
 * What this rule still cannot see: a third argument that is a variable or a
 * spread rather than an object literal, and a binding obtained dynamically
 * (`const { failWith } = await import("./_errors.js")` — none exist). The
 * routing tests and the failWith call-site fixtures cover what slips past.
 */

const BANNED = {
  suggest:
    "`suggest` in the third argument of failWith / errorFromMessage / failArgs lands at `context.suggest`, not the root `suggest` the model reads. Put the advice in SUGGESTS (add a classify arm for the code), or use failCode(code, error, { suggest }).",
  context:
    "`context` in the third argument of failWith / errorFromMessage / failArgs renders as `context.context`. Pass the context keys flat — the whole argument already IS the context record.",
};

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `suggest` / `context` keys in the third argument of failWith / errorFromMessage / failArgs — that argument is a flat context record, so they end up nested where nothing reads them (ADR-029 OQ8).",
    },
    schema: [],
    messages: { banned: "{{detail}}" },
  },

  create(context) {
    // The third argument is the context record for all three. `failArgs`
    // differs only in that its whole third argument becomes `context`
    // verbatim (no root-hoisting) — a `suggest` / `context` key inside it
    // mis-nests the same way (Opus R1 P3-2).
    const CHECKED_CALLEES = new Set(["failWith", "errorFromMessage", "failArgs"]);

    /** Module specifiers that mean `src/tools/_errors`. */
    const ERRORS_MODULE = /(^|[\\/])_errors(\.js|\.ts)?$/;

    /** Nearest declaration of `name`, walking out to module scope. */
    function findVariable(scope, name) {
      for (let s = scope; s; s = s.upper) {
        const found = s.variables.find((v) => v.name === name);
        if (found) return found;
      }
      return null;
    }

    /**
     * Does this Identifier callee resolve to a helper imported from `_errors`,
     * whatever it is called here? Covers `import { failWith as f }` and a local
     * `const g = f` re-alias of one, at any scope depth. `depth` bounds the
     * chain (a self-referential `const f = f` would otherwise not terminate).
     */
    function resolvesToHelper(idNode, depth = 0) {
      if (depth > 4) return false;
      const variable = findVariable(context.sourceCode.getScope(idNode), idNode.name);
      if (!variable) return false;
      for (const def of variable.defs) {
        if (def.type === "ImportBinding") {
          const source = def.parent?.source?.value;
          if (typeof source !== "string" || !ERRORS_MODULE.test(source)) continue;
          if (def.node.type !== "ImportSpecifier" || def.node.imported.type !== "Identifier") continue;
          if (CHECKED_CALLEES.has(def.node.imported.name)) return true;
          continue;
        }
        if (def.type === "Variable" && def.node.type === "VariableDeclarator") {
          const init = def.node.init;
          if (init?.type !== "Identifier") continue;
          if (CHECKED_CALLEES.has(init.name) || resolvesToHelper(init, depth + 1)) return true;
        }
      }
      return false;
    }

    function isCheckedCallee(callee) {
      if (callee.type === "Identifier") {
        return CHECKED_CALLEES.has(callee.name) || resolvesToHelper(callee);
      }
      // `errors.failWith(...)` / `_errors.failWith(...)` — a namespace import
      // cannot rename the member, so the property name is the whole signal.
      if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
        return CHECKED_CALLEES.has(callee.property.name);
      }
      return false;
    }

    return {
      CallExpression(node) {
        const third = node.arguments[2];
        if (!third || third.type !== "ObjectExpression") return;
        if (!isCheckedCallee(node.callee)) return;

        for (const prop of third.properties) {
          if (prop.type !== "Property") continue;
          // A computed *literal* key (`["suggest"]`) nests identically; a
          // computed identifier (`[k]`) is unknowable, so it is not guessed.
          const key =
            !prop.computed && prop.key.type === "Identifier"
              ? prop.key.name
              : prop.key.type === "Literal"
                ? String(prop.key.value)
                : null;
          if (key && Object.hasOwn(BANNED, key)) {
            context.report({ node: prop, messageId: "banned", data: { detail: BANNED[key] } });
          }
        }
      },
    };
  },
};
