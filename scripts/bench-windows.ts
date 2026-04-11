/**
 * scripts/bench-windows.ts
 *
 * Benchmark: nut-js getWindows() vs win32 enumWindowsInZOrder()
 * + Chrome UIA cost
 *
 * Run: npx tsx scripts/bench-windows.ts
 * (Open Chrome before running for realistic results)
 */

// We import directly from src — tsx resolves TypeScript without building
import { getWindows } from "../src/engine/nutjs.js";
import { enumWindowsInZOrder } from "../src/engine/win32.js";
import { getUiElements } from "../src/engine/uia-bridge.js";

function ms(start: bigint): string {
  return `${Number(process.hrtime.bigint() - start) / 1e6 | 0}ms`;
}

// ── (A) nut-js getWindows() + sequential win.region ─────────────────────────
async function benchNutjs() {
  console.log("\n── (A) nut-js getWindows() + sequential await win.region ──");
  const t0 = process.hrtime.bigint();
  const windows = await getWindows();
  console.log(`  getWindows() returned ${windows.length} windows  [${ms(t0)}]`);

  const t1 = process.hrtime.bigint();
  const usable: typeof windows = [];
  for (const win of windows) {
    if (usable.length >= 20) break;
    try {
      const reg = await win.region;
      if (reg.width >= 100 && reg.height >= 50) usable.push(win);
    } catch { /* skip */ }
  }
  console.log(`  Filter to 20 usable windows  [${ms(t1)}]`);
  console.log(`  TOTAL  [${ms(t0)}]`);
}

// ── (B) win32 enumWindowsInZOrder() ─────────────────────────────────────────
function benchWin32() {
  console.log("\n── (B) win32 enumWindowsInZOrder() ──");
  const t0 = process.hrtime.bigint();
  const all = enumWindowsInZOrder();
  console.log(`  enumWindowsInZOrder() returned ${all.length} windows  [${ms(t0)}]`);

  const t1 = process.hrtime.bigint();
  const usable = all
    .filter(w => !w.isMinimized && w.region.width >= 100 && w.region.height >= 50)
    .slice(0, 20);
  console.log(`  Filter to ${usable.length} usable windows  [${ms(t1)}]`);
  console.log(`  TOTAL  [${ms(t0)}]`);
  return usable;
}

// ── (C) UIA getUiElements() on Chrome ───────────────────────────────────────
async function benchUia(windows: ReturnType<typeof enumWindowsInZOrder>) {
  console.log("\n── (C) UIA getUiElements() on each window (timeout 2000ms) ──");
  for (const w of windows) {
    const t0 = process.hrtime.bigint();
    try {
      const result = await getUiElements(w.title, 3, 60, 2000);
      console.log(`  "${w.title.slice(0, 50)}"  →  ${result.elementCount} elements  [${ms(t0)}]`);
    } catch (err) {
      console.log(`  "${w.title.slice(0, 50)}"  →  ERROR: ${String(err).slice(0, 60)}  [${ms(t0)}]`);
    }
  }
}

async function main() {
  console.log("=== desktop-touch-mcp window benchmark ===");
  console.log("Make sure Chrome is open for realistic results.\n");

  await benchNutjs();
  const usable = benchWin32();
  await benchUia(usable);

  console.log("\n=== done ===");
}

main().catch(console.error);
