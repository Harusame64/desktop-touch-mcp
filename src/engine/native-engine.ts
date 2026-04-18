/**
 * native-engine.ts
 *
 * Loader for the optional Rust native addon (@harusame64/desktop-touch-engine).
 * Provides 13x faster computeChangeFraction (SSE2 SIMD) and pure-Rust dHash.
 * Falls back gracefully to null when the addon is not installed.
 */

export interface NativeEngine {
  computeChangeFraction(
    prev: Buffer,
    curr: Buffer,
    width: number,
    height: number,
    channels: number,
  ): number;
  dhashFromRaw(
    raw: Buffer,
    width: number,
    height: number,
    channels: number,
  ): bigint;
  hammingDistance(a: bigint, b: bigint): number;
}

let nativeEngine: NativeEngine | null = null;

try {
  // @ts-expect-error — optional dependency, may not be installed
  const addon = await import("@harusame64/desktop-touch-engine");
  // CJS default export unwrapping
  const mod = addon.default ?? addon;
  if (
    typeof mod.computeChangeFraction === "function" &&
    typeof mod.dhashFromRaw === "function" &&
    typeof mod.hammingDistance === "function"
  ) {
    nativeEngine = mod as NativeEngine;
    console.error("[native-engine] Rust engine loaded (SSE2 SIMD)");
  }
} catch {
  // Addon not installed — TS fallback will be used
}

export { nativeEngine };
