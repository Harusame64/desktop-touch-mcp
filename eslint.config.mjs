// Two-tier lint policy:
//   1. All JS/TS — typescript-eslint recommended (light code-quality baseline).
//   2. src/      — adds no-console (allow: error/warn) to defend the MCP stdio
//                  JSON-RPC stream against console.log/debug/info contamination
//                  (Issue #60 regression guard, see Issue #61).
//   3. scripts/, tests/, __test__/ — relax console + test-friendly rules.

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

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
