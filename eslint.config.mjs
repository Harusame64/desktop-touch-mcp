// Lint policy, in the order the blocks appear below:
//   1. All JS/TS — typescript-eslint recommended (light code-quality baseline),
//      plus `reportUnusedDisableDirectives: "error"`: a stale eslint-disable is
//      a failure, not a warning nobody reads (`npm run lint` has no
//      --max-warnings, so warnings never failed CI — PR #550 Round 1 P2-1).
//   2. src/      — adds no-console (allow: error/warn) to defend the MCP stdio
//                  JSON-RPC stream against console.log/debug/info contamination
//                  (Issue #60 regression guard, see Issue #61).
//   3. src/tools/ — ADR-021: no hand-built tool-failure wire shapes.
//   4. scripts/, tests/, __test__/ — relax console and test-shaped rules, but
//      unused *imports* stay an error (see the block's own comment).

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import noToolFailureShapeDirectConstruct from "./eslint-rules/no-tool-failure-shape-direct-construct.mjs";

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
    // A disable comment for a rule that reports nothing is dead weight that
    // hides the next real violation of that rule. Reported as an ERROR because
    // `npm run lint` is plain `eslint .` with no --max-warnings, so anything
    // warning-level passes CI unnoticed — which is exactly how the 14 stale
    // directives this PR sweeps accumulated.
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
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

  // scripts / tests — CLI tools and test runners legitimately use stdout,
  // and contain regex / require / fixture patterns that recommended dislikes.
  {
    files: ["scripts/**", "tests/**", "__test__/**"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      // Unused *imports* stay an error here. Turning the whole rule off (the
      // previous setting) meant a stale import in a test was invisible to lint
      // and only surfaced later as a CodeQL alert — which is how two of them
      // reached main. Arguments and caught errors are exempt instead, since
      // those are the test-shaped cases the blanket "off" was really for.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "none",
          caughtErrors: "none",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
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
