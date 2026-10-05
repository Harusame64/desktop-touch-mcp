/**
 * The environment `generate-stub-tool-catalog.mjs` hands vitest — a pure function so a unit test
 * can hold it (gate 2 round 3 on #792: a runner that passed the write flag in `--check` mode
 * rewrote a stale catalog and exited 0, and nothing failed).
 *
 * - `--check` (`check === true`): the write flag is REMOVED, so the run compares and writes
 *   nothing, even when the caller's own environment carries the flag.
 * - generate: the write flag is set.
 * - both: the kill switches are removed. The catalog is the DEFAULT configuration, and some of
 *   them are read when a tool module is imported, so a developer's shell that has one set would
 *   otherwise write (or check against) a catalog for a different surface.
 */
export const WRITE_FLAG = "DESKTOP_TOUCH_WRITE_STUB_CATALOG";
export const KILL_SWITCHES = ["DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2", "DESKTOP_TOUCH_DISABLE_KEY_LOCKER"];

export function stubCatalogEnv(base, check) {
  const env = Object.fromEntries(
    Object.entries(base).filter(([k]) => k !== WRITE_FLAG && !KILL_SWITCHES.includes(k)),
  );
  if (!check) env[WRITE_FLAG] = "1";
  return env;
}
