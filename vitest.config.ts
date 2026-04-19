import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
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
