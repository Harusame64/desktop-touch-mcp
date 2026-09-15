import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";

// Strip shebang lines from .js/.cjs/.mjs files so vitest can import them.
// Node.js handles shebangs natively; Vite's transform pipeline does not.
//
// `.mjs` was outside this until a `scripts/*.mjs` with a shebang was imported by
// a test. It passed for as long as the file had only ever been written locally,
// and failed the first time it came back through a checkout: `core.autocrlf`
// turns the shebang into `#!/usr/bin/env node\r`, and the transform reports
// "SyntaxError: Invalid or unexpected token" with no location. Every clone on
// Windows would have hit it.
const stripShebang: Plugin = {
  name: "strip-shebang",
  transform(code, id) {
    // Split on "?" so a cache-busting query (bin/launcher.js?case=1, used by the
    // release-resolution tests to get a fresh module per case) still matches.
    if (/\.[cm]?js$/.test(id.split("?")[0]) && code.startsWith("#!")) {
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
          // Never append to the developer's real diagnostic log from a unit run.
          setupFiles: ["./tests/unit/setup-diagnostic-log.ts"],
          // fileParallelism defaults to true — 363 files run in parallel
          testTimeout: 10_000,
          hookTimeout: 10_000,
          // Zombie prevention (Phase 4b-6): use the forks pool for native-binding
          // safety, cap the workers so a failed teardown cannot leave many behind,
          // teardownTimeout forces pool exit after a grace period.
          //
          // THE CAP HAD STOPPED BEING APPLIED. `poolOptions` was removed in Vitest 4:
          // the shipped code reads it in exactly one place, to print a deprecation, and
          // nowhere else. Measured on 2026-09-15 with 4.1.11 before this change — the
          // parent had 6-7 live children on an 8-CPU machine (the default, CPU-1), and
          // `--maxWorkers=2` brought it to 2, which is what says the count is the cap
          // and not the instrument. So `maxForks: 4` had been decorative since the
          // upgrade, and the comment above it was describing a limit that did not exist.
          pool: "forks",
          maxWorkers: 4,
          // `minForks` has NO top-level equivalent in Vitest 4 and is dropped rather than
          // renamed to something that does not mean the same thing.
          isolate: true,
          teardownTimeout: 5_000,
        },
      },
      {
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
          // Emergency stop: globalSetup clears a stale `.e2e-stop` sentinel;
          // abort-check.ts skips remaining tests once the sentinel is dropped by
          // `npm run e2e:stop` from any terminal. See tests/e2e/helpers/stop-sentinel.ts.
          globalSetup: ["./tests/e2e/global-setup.ts"],
          setupFiles: ["./tests/e2e/abort-check.ts"],
          // E2E tests share OS-level resources (windows, focus, clipboard)
          // and must run serially. `fileParallelism: false` is what holds that, and it
          // is top-level: it overrides `maxWorkers` to 1 by its own documented behaviour.
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // `singleFork` was here for strict serial execution and clean teardown between
          // e2e files (zombie accumulation — context-consistency / screenshot-electron).
          // It was already inert (see the unit project), and Vitest 4 has no top-level
          // spelling of "all files in ONE process": the serial part is `fileParallelism`,
          // which is kept; the one-process part is gone and is not faked here.
          pool: "forks",
          isolate: true,
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
          // Serial, for the same reason as e2e; `singleFork` dropped for the same reason.
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 60_000,
          pool: "forks",
          isolate: true,
          teardownTimeout: 10_000,
        },
      },
    ],
  },
});
