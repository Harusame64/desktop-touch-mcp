/**
 * index.ts — entry point.
 *
 * Picks the real Windows server, the macOS server (Mac port; it falls back to the stub
 * when the darwin addon is absent), or the stub, based on `process.platform`.
 * The stub exists so the process can boot on Linux / macOS (where the underlying
 * Win32 APIs do not exist) and answer `tools/list` for directory hosts (Glama,
 * etc.) that perform automated safety / quality checks. Stub tool calls return
 * a structured `UnsupportedPlatform` error.
 *
 * Dynamic `import()` is used deliberately — top-level static imports would
 * eagerly load the desktop-touch-engine native addon (windows-rs) → user32.dll,
 * which throws on non-Windows.
 */

if (process.platform === "win32") {
  await import("./server-windows.js");
} else if (process.platform === "darwin") {
  // Mac port: the macOS server, or the stub when the darwin addon is absent.
  await import("./server-darwin.js");
} else {
  await import("./server-linux-stub.js");
}
