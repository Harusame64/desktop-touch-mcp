/**
 * ESLint rule: no-tool-failure-shape-direct-construct
 * — ADR-021 Phase 4 PR-P4-1 (Option B North Star enforcement).
 *
 * Bans hand-building the flat tool-failure WIRE shape (`{ ok:false, ..., error,
 * ... }`) at an emission point — i.e. as the argument to `fail(...)` or
 * `JSON.stringify(...)`. Every handler failure must instead go through the
 * single sanctioned presenter family in `src/tools/_errors.ts`:
 *
 *   failWith(err, toolName, context?)   — code via classify(message)
 *   failCode(code, error, { suggest?, context?, rootExtras? })  — explicit code
 *   failArgs(message, toolName, context?)  — fixed InvalidArgs
 *   fail(toToolFailure(errorFromMessage(...)))  — the underlying composition
 *
 * or the envelope-family `toFailureEnvelope(...)`. This is what makes the
 * ADR-021 drift North Star ("単体 OK / 繋ぐと破綻 を型/lint/SSOT で書けなくする")
 * structural rather than test-only: PR-P2-2/P2-3 swept every existing hand-built
 * literal, and this rule prevents new ones from re-appearing (plan §3.5.1; closes
 * the R12 "un-deprecate window").
 *
 * Discriminator = `ok:false` AND an `error` property. Internal discriminated-union
 * returns (`{ ok:false, reason }`, `{ ok:false, errorResult }`, CDP eval helper
 * shapes) have no `error` key, so they are NOT flagged. Only the wire-emission
 * contexts (`fail(...)` / `JSON.stringify(...)` arguments) are checked, so the
 * `(E)` failure-as-success returns carried over to OQ-10 (e.g. `dock.ts`'s
 * `return { ok:false, title, error }` consumed by `ok()`) are intentionally out of
 * scope here — they are a different mechanism needing semantic detection.
 *
 * Scope (wired in eslint.config.mjs): `src/tools/**` minus the sanctioned
 * converters `_errors.ts` (defines fail* helpers) and `_envelope.ts`
 * (defines toFailureEnvelope / buildFailureEnvelope).
 */

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-building the flat tool-failure wire shape ({ok:false, error, ...}); route failures through failWith / failCode / failArgs / toFailureEnvelope (ADR-021 Option B).",
    },
    messages: {
      directConstruct:
        "Do not hand-build the tool-failure wire shape ({{where}}). Use failWith / failCode / failArgs (src/tools/_errors.ts) or toFailureEnvelope so the failure path stays single-sourced (ADR-021 Phase 4 / OQ-1 RE).",
    },
    schema: [],
  },

  create(context) {
    /** Does an ObjectExpression look like the flat failure wire shape? */
    function isFailureShape(node) {
      if (!node || node.type !== "ObjectExpression") return false;
      let hasOkFalse = false;
      let hasError = false;
      for (const p of node.properties) {
        if (p.type !== "Property" || p.computed) continue;
        const key =
          p.key.type === "Identifier"
            ? p.key.name
            : p.key.type === "Literal"
              ? p.key.value
              : null;
        if (key === "ok" && p.value.type === "Literal" && p.value.value === false) {
          hasOkFalse = true;
        }
        if (key === "error") hasError = true;
      }
      return hasOkFalse && hasError;
    }

    function report(arg, where) {
      if (isFailureShape(arg)) {
        context.report({ node: arg, messageId: "directConstruct", data: { where } });
      }
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        // fail({ ok:false, error, ... })
        if (callee.type === "Identifier" && callee.name === "fail") {
          report(node.arguments[0], "fail(...) argument");
        }
        // JSON.stringify({ ok:false, error, ... })  (hand-built content-block body)
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.object.type === "Identifier" &&
          callee.object.name === "JSON" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "stringify"
        ) {
          report(node.arguments[0], "JSON.stringify(...) argument");
        }
      },
    };
  },
};
