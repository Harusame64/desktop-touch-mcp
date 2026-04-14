import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run test files serially — E2E tests share OS-level resources (windows,
    // focus, clipboard) and must not run in parallel.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
