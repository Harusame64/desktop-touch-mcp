#!/usr/bin/env node
/**
 * e2e-stop.mjs — request an emergency stop of a running e2e suite.
 *
 * Drops the `.e2e-stop` sentinel that tests/e2e/abort-check.ts watches; the run
 * then skips every remaining test at its next boundary (afterAll/afterEach still
 * run, so Chrome / spawned windows are cleaned up). Run this from ANY terminal —
 * it never touches the desktop, so it works even while a test is driving the
 * cursor via SendInput.
 *
 *   npm run e2e:stop
 *
 * The sentinel is auto-cleared at the start and end of every e2e run
 * (tests/e2e/global-setup.ts), so a leftover file never skips a fresh run.
 */
import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const sentinel = join(dirname(fileURLToPath(import.meta.url)), "..", ".e2e-stop");
writeFileSync(sentinel, `stop ${new Date().toISOString()}\n`, "utf8");
console.log(`[e2e:stop] requested — the e2e run will halt at the next test boundary.\n  sentinel: ${sentinel}`);
