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
 * What this rule cannot see, by construction: a third argument that is a
 * variable or a spread rather than an object literal, and an aliased import
 * (`import { failWith as f }`). Both are matched on the name at the call site.
 * The routing tests and the failWith call-site fixtures cover what slips past.
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

    function calleeName(node) {
      if (node.type === "Identifier") return node.name;
      // `errors.failWith(...)` / `_errors.failWith(...)`
      if (node.type === "MemberExpression" && node.property.type === "Identifier") {
        return node.property.name;
      }
      return null;
    }

    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (!name || !CHECKED_CALLEES.has(name)) return;

        const third = node.arguments[2];
        if (!third || third.type !== "ObjectExpression") return;

        for (const prop of third.properties) {
          if (prop.type !== "Property") continue;
          const key =
            prop.key.type === "Identifier"
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
