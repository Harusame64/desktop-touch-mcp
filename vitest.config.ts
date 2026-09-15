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
    // SO THE NUMBER IS `min(4, floor(cpus / 2))` AND IT VARIES BELOW 8 CPUs — 4 here, 3 on
    // six, 2 on four, 1 on two. It is not a machine-independent worker count: no constant
    // ABOVE 1 can both avoid raising the number on a small machine and stay the same on
    // every machine.
    //
    // WHAT WAS MEASURED, and only this: on TWO machines — 8 CPUs here, 16 on win2, both
    // of which resolve this formula to 4 — the capped parallel run fails the same FILE
    // SET as that machine's own serial run, where uncapped it did not (30 tests across 11
    // files against 19 across 10 here; 3 files against 1 there). The machines do not match
    // each other, and even the extra file differed (`resolve-log-topology` here,
    // `benchmark-gates` + `dirty-signal` there). THE 3-, 2- AND 1-WORKER REGIMES THIS
    // FORMULA INTRODUCES BELOW 8 CPUs HAVE NO MEASUREMENT BEHIND THEM (gate 2,
    // 2026-09-15) — if a contributor on a four-core machine sees a set that differs from
    // their serial run, that is unmeasured ground, not a contradiction of this comment.
    //
    // The cost is real and is measured on both machines: 18s -> 26s here (7 workers -> 4),
    // and 78s -> 98s on win2's 16-CPU machine (15 -> 4), where 6 workers took 70s. That
    // price is paid by the local pre-merge run, which is the only place this suite runs at
    // all — the windows-latest unit step was REMOVED (`4b1a5155`); what is left in
    // `.github/workflows/ci.yml` is the NOTE explaining why, not a commented-out step.
    //
    // It is at the root because a project-level `maxWorkers` is read before the CLI flag,
    // and under VITEST 4 it was not in the list of options a CLI flag may override: writing
    // it inside the unit project silently disabled `--maxWorkers` (measured, 2026-09-15 —
    // with the project-level value the control arm `--maxWorkers=2` still ran 4 workers).
    // THAT REASON EXPIRED WITH THE RUNNER: vitest 5 adds `maxWorkers` to its per-project
    // CLI override list, so a project-level value would no longer shadow the flag (checked
    // in v5's `PROJECT_CLI_OVERRIDES`, 2026-09-15). The placement stays — one place, one
    // value, and the flag reaches it either way — but the reason recorded here is a vitest 4
    // measurement and is written as one rather than left to read as timeless.
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
    // KEEPING VITEST 4's MOCK SEMANTICS ACROSS THE RUNNER UPGRADE, deliberately and for one
    // round only. Vitest 5 flips `clearMocks` from false to true (its own `defaults` says
    // `clearMocks: true, restoreMocks: false, mockReset: false`), which clears every mock's
    // recorded calls BEFORE EACH TEST — including calls made at module scope, before any test
    // ran. `adr-036-post-value-declarations.test.ts` is built exactly that way: importing the
    // production modules IS the assertion, because `withPostState` records the keys as each
    // registration is built. Under the new default its two cells went red on both machines;
    // with this line they are green again, and the whole suite reproduces the vitest 4
    // baseline test name for test name (2026-09-15).
    //
    // WHAT THIS LINE IS NOT: a verdict that the old default is better. The new default also
    // makes assertions of the form "was never called" EASIER to pass, so adopting it is a
    // round that has to re-read every mock-based cell rather than a flag flip — and a cell
    // that goes quietly weaker is not visible in a failing-file count. That round is not this
    // one, which changes the runner and nothing else — it is #659, which carries the steps
    // and the reason the set of affected cells grows while this line stands.
    //
    // ONE FILE NEEDS THIS TODAY (`grep -rln "^await import(" tests/unit`):
    // `adr-036-post-value-declarations.test.ts`. The pin is global because the alternative is
    // rewriting that cell inside the round that moves the runner, which mixes two variables in
    // the only comparison this suite has.
    clearMocks: false,
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
          // The cap itself lives in the ROOT `test` block, not here. Under vitest 4 a
          // project-level `maxWorkers` was returned before the CLI flag was ever read, so
          // writing it here silently disabled `--maxWorkers`, including the escape hatch
          // `.github/workflows/ci.yml` reaches for — and the control arm that proves the cap
          // is real (measured: `--maxWorkers=2` still ran 4). Vitest 5 lets the flag through
          // at project level too, so that hazard is a vitest 4 fact; the placement is kept
          // because one value in one place is the simpler thing, not because it is forced.
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
          // flake problem returns — AND IT NEEDS ONE MORE THING to not break the whole
          // run: with `isolate: false` this project stops taking the sequential path and
          // lands in the same group as `unit`, whose worker count differs, which vitest
          // refuses ("different 'maxWorkers' but same 'sequence.groupOrder'") before any
          // test runs. Give it its own `sequence.groupOrder` at the same time (gate 2,
          // 2026-09-15).
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
