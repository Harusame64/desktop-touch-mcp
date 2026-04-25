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
          // Zombie prevention (Phase 4b-6): use forks pool for native-binding
          // safety, cap maxForks to limit zombie count if teardown fails,
          // teardownTimeout forces pool exit after grace period.
          pool: "forks",
          poolOptions: {
            forks: {
              maxForks: 4,
              minForks: 1,
              isolate: true,
            },
          },
          teardownTimeout: 5_000,
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
          // Single fork forces strict serial execution and clean teardown
          // between e2e files (prevents zombie accumulation that may have
          // caused past flaky e2e failures — context-consistency / screenshot-electron).
          pool: "forks",
          poolOptions: {
            forks: { singleFork: true, isolate: true },
          },
          teardownTimeout: 10_000,
        },
      },
      {
        plugins: [stripShebang],
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          // Integration tests require native Win32 APIs and win-ocr.exe.
          // Gated by RUN_OCR_GOLDEN=1 env var inside each test file.
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 60_000,
          pool: "forks",
          poolOptions: {
            forks: { singleFork: true, isolate: true },
          },
          teardownTimeout: 10_000,
        },
      },
    ],
  },
});
