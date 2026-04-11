import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run test files serially to avoid CDP port conflicts
    sequence: { concurrent: false },
  },
});
