import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";

// Strip shebang lines from .js files so vitest can import bin/launcher.js.
// Node.js handles shebangs natively; Vite's transform pipeline does not.
const stripShebang: Plugin = {
  name: "strip-shebang",
  transform(code, id) {
    if (id.endsWith(".js") && code.startsWith("#!")) {
      return { code: code.slice(code.indexOf("\n") + 1), map: null };
    }
    return null;
  },
};

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [stripShebang],
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          // fileParallelism defaults to true — 57 files run in parallel
          testTimeout: 10_000,
          hookTimeout: 10_000,
        },
      },
      {
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
          // E2E tests share OS-level resources (windows, focus, clipboard)
          // and must run serially.
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
