import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import { availableParallelism } from "node:os";

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
    // THE WORKER CAP, and it is a CAP IN BOTH MODES. A bare `4` is returned verbatim, so
    // on a small machine it SPAWNS MORE than the default did, in a change whose whole
    // purpose is holding the number down. Clamping against `cpus - 1` fixes that for a
    // plain run and NOT for watch, whose default is `floor(cpus / 2)` and is also reached
    // only after this value is consulted: on a 6-CPU box `npm run test:watch` would go
    // 3 -> 4 (gate 2, 2026-09-15). Clamping against the SMALLER of the two defaults is
    // what makes "can only lower" true wherever it is read.
    //
    // The cost is real and is measured, not waved at: on this 8-CPU machine the unit
    // project takes 18s uncapped and 26s at 4 workers. That price is paid by the local
    // pre-merge run, which is the only place the suite runs at all — the CI unit step
    // (`.github/workflows/ci.yml`) is commented out. What is bought is a baseline that
    // does not depend on the CPU count: uncapped, this machine failed 30 tests across 11
    // files; capped, it fails the same 10 files a serial run does.
    //
    // It is at the root because a project-level `maxWorkers` is read before the CLI flag
    // and is not in the list of options a CLI flag may override: writing it inside the
    // unit project silently disabled `--maxWorkers` (measured, 2026-09-15 — with the
    // project-level value the control arm `--maxWorkers=2` still ran 4 workers).
    // e2e and integration are unaffected: `fileParallelism: false` forces their worker
    // count to 1 by its own documented behaviour, which is stronger than this.
    maxWorkers: Math.min(4, Math.max(Math.floor(availableParallelism() / 2), 1)),
    // ONE teardownTimeout FOR THE RUN. It is a root-only option — the pool reads it from
    // the root Vitest instance — so the per-project 5_000 / 10_000 that stood here were as
    // decorative as `poolOptions`, and every project was getting the 10 000 ms default.
    // Keeping 10 000 keeps the behaviour that was actually in force (gate 2, 2026-09-15).
    //
    // WHAT IS DROPPED WITH IT, said rather than left to be rediscovered: the unit project
    // asked for a 5 000 ms grace as part of the same zombie-prevention trio, and Vitest 4
    // has NO per-project spelling of it — a unit fork that hangs in teardown holds the
    // pool for 10 s, as it already did. The way back is a separate vitest invocation for
    // that project, not a config key.
    teardownTimeout: 10_000,
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
          // Zombie prevention (Phase 4b-6): the forks pool, for native-binding safety.
          // The two other halves of that sentence now live at the root, where they are
          // actually read — the worker cap and `teardownTimeout`.
          //
          // THE CAP HAD STOPPED BEING APPLIED. `poolOptions` was removed in Vitest 4:
          // the shipped code reads it in exactly one place, to print a deprecation, and
          // nowhere else. Measured on 2026-09-15 with 4.1.11 before this change — the
          // parent had 6-7 live children on an 8-CPU machine (the default, CPU-1), and
          // `--maxWorkers=2` brought it to 2, which is what says the count is the cap
          // and not the instrument. So `maxForks: 4` had been decorative since the
          // upgrade, and the comment above it was describing a limit that did not exist.
          //
          // The cap itself lives in the ROOT `test` block, not here: a project-level
          // `maxWorkers` is returned before the CLI flag is ever read, so writing it here
          // silently disabled `--maxWorkers`, including the `--maxWorkers=1` that
          // `.github/workflows/ci.yml` reaches for on the 2-core runner — and the control
          // arm that proves the cap is real (measured: `--maxWorkers=2` still ran 4).
          // `minForks` has NO top-level equivalent in Vitest 4 and is dropped rather than
          // renamed to something that does not mean the same thing.
          pool: "forks",
          isolate: true,
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
          // It was already inert (see the unit project). The serial part is
          // `fileParallelism`, which is kept. The "all files in ONE process" part is
          // reachable in Vitest 4 only as `isolate: false` with one worker — the run then
          // merges every spec of a project into a single worker task — which `singleFork`
          // did NOT require, so it is not a rename but a trade: one process, no per-file
          // module isolation. Written down because it is the way back if the zombie or
          // flake problem returns.
          pool: "forks",
          isolate: true,
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
        },
      },
    ],
  },
});
