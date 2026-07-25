// Two-tier lint policy:
//   1. All JS/TS — typescript-eslint recommended (light code-quality baseline).
//   2. src/      — adds no-console (allow: error/warn) to defend the MCP stdio
//                  JSON-RPC stream against console.log/debug/info contamination
//                  (Issue #60 regression guard, see Issue #61).
//   3. scripts/, tests/, __test__/ — relax console + test-friendly rules.

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import noToolFailureShapeDirectConstruct from "./eslint-rules/no-tool-failure-shape-direct-construct.mjs";
import noSuggestInFailWithContext from "./eslint-rules/no-suggest-in-failwith-context.mjs";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "target/**",
      "site/**",
      "index.js",       // napi-generated
      "index.d.ts",     // napi-generated
      "tools/**",       // napi tooling
      ".claude/**",     // claude-code worktrees / scratch
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Global rule tuning — applies everywhere.
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Allow intentional `_arg` / `_unused` pattern.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },

  // src/ — production. MCP stdio invariant: stdout is JSON-RPC only.
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },

  // src/tools/ — ADR-021 Option B North Star enforcement. Hand-built failure
  // wire literals ({ ok:false, ..., error } as a fail() / JSON.stringify()
  // argument) are banned; failures must go through failWith / failCode / failArgs
  // / toFailureEnvelope. PR-P2-2/P2-3 swept every existing one, so this lands as
  // `error` (0 violations). The converters themselves are exempt: _errors.ts
  // defines the fail* helpers, _envelope.ts defines toFailureEnvelope.
  {
    files: ["src/tools/**/*.ts"],
    ignores: ["src/tools/_errors.ts", "src/tools/_envelope.ts"],
    plugins: {
      adr021: { rules: { "no-tool-failure-shape-direct-construct": noToolFailureShapeDirectConstruct } },
    },
    rules: {
      "adr021/no-tool-failure-shape-direct-construct": "error",
    },
  },

  // ADR-029 OQ8 — failWith's third argument is a flat context record, so a
  // `suggest` key there is nested where nothing reads it and a `context` key
  // renders as `context.context`. Fourteen call sites had drifted into the
  // first shape; five were emitting no root advice at all.
  //
  // `_errors.ts` was exempted at first "because it names the keys in its own
  // docs" — a false rationale: the rule inspects Property nodes inside a call
  // argument, never comments or type declarations, and it reports nothing in
  // that file today. The exemption bought nothing and blinded the one file
  // where a new fail* wrapper would be written (Round 3 P2-5), so it is gone.
  {
    files: ["src/**/*.ts"],
    plugins: {
      adr029: { rules: { "no-suggest-in-failwith-context": noSuggestInFailWithContext } },
    },
    rules: {
      "adr029/no-suggest-in-failwith-context": "error",
    },
  },

  // scripts / tests — CLI tools and test runners legitimately use stdout,
  // and contain regex / require / fixture patterns that recommended dislikes.
  {
    files: ["scripts/**", "tests/**", "__test__/**"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "no-control-regex": "off",
      "no-irregular-whitespace": "off",
      "no-empty": "off",
      "no-useless-escape": "off",
      "no-useless-assignment": "off",
    },
  },
];
