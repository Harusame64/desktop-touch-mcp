/**
 * ADR-018 Phase 1b skeleton — DDPM overlay fake fixture.
 *
 * Real activation happens in Phase 4 / Phase 5 smoke tests: a Win32 child
 * process is spawned with `WS_EX_LAYERED | WS_EX_TRANSPARENT` covering the
 * full virtual screen, so the dispatcher's Tier 1/2/3 fall-through can be
 * exercised in CI without requiring the actual Dell Display Peripheral
 * Manager binary.
 *
 * Phase 1b lands the file as a placeholder so:
 *   1. Phase 4 can wire the spawn helper without churning the test layout
 *   2. CI lint guards (input-pipeline-guard.yml, Phase 5) can reference the
 *      symbol from day one
 *
 * **Do not invoke `spawnFakeOverlay` from Phase 1b tests** — it currently
 * throws. The Phase 1b dispatcher unit tests (`tests/unit/input-pipeline-dispatch.test.ts`)
 * cover Tier 1 routing via native-call mocks, not live overlay observation.
 */

/**
 * Spawn a fake DDPM-style fullscreen transparent overlay. Returns a `kill()`
 * handle the test can call in `afterEach`.
 *
 * Phase 4 implementation outline:
 *   - Use `child_process.spawn(node, ['__test__/fixtures/overlay-process.mjs'])`
 *     where `overlay-process.mjs` is a small ES-module entry that calls
 *     `CreateWindowExW` with `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST`
 *     via `koffi` or the existing native `win32_create_window` helper.
 *   - Stretch the window to `GetSystemMetrics(SM_CXVIRTUALSCREEN/SM_CYVIRTUALSCREEN)`.
 *   - Set `SetLayeredWindowAttributes(LWA_ALPHA=0)` so the overlay is fully invisible.
 *   - `kill()` posts `WM_CLOSE` to the spawned process's HWND and awaits exit.
 *
 * @throws Always in Phase 1b. Phase 4 land removes the throw.
 */
export async function spawnFakeOverlay(): Promise<{ kill: () => Promise<void> }> {
  throw new Error(
    "spawnFakeOverlay is not implemented until ADR-018 Phase 4 (Tier 3 PostMessage path). " +
      "Phase 1b lands the file as a skeleton; do not call from Phase 1b tests.",
  );
}
