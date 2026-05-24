/**
 * abort-check.ts — vitest `setupFiles` for the e2e project (runs in each worker).
 *
 * Registers a global `beforeEach` that honours the emergency-stop sentinel: once
 * `npm run e2e:stop` drops `.e2e-stop`, every remaining test skips at its next
 * boundary. `ctx.skip()` (not process.exit /
 * throw) is deliberate — it halts the run promptly while letting each file's
 * afterEach/afterAll still run, so Chrome instances and spawned windows are torn
 * down cleanly rather than orphaned. The check is a single existsSync per test
 * (microseconds) and adds no UI surface, so it never destabilises screenshot /
 * window-enumeration / focus tests.
 */
import { beforeEach } from "vitest";
import { isStopRequested } from "./helpers/stop-sentinel.js";

beforeEach((ctx) => {
  if (isStopRequested()) {
    ctx.skip();
  }
});
