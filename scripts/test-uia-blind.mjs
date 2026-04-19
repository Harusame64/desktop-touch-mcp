#!/usr/bin/env node
/**
 * detectUiaBlind() の動作検証スクリプト
 * Usage: node scripts/test-uia-blind.mjs [window-title]
 */
import { getUiElements, detectUiaBlind } from "../dist/engine/uia-bridge.js";
import { enumWindowsInZOrder } from "../dist/engine/win32.js";

const searchTitle = process.argv[2] ?? "メモ帳";

const wins = enumWindowsInZOrder();
const win = wins.find(w => w.title.toLowerCase().includes(searchTitle.toLowerCase()));

if (!win) {
  console.error(`Window not found: "${searchTitle}"`);
  console.log("Available windows:");
  wins.slice(0, 10).forEach(w => console.log(`  "${w.title}"`));
  process.exit(1);
}

console.log(`Window: "${win.title}"  hwnd=${win.hwnd}`);
console.log(`Region: ${win.region.width}×${win.region.height} @ (${win.region.x},${win.region.y})\n`);

// getUiElements takes (windowTitle, maxDepth, maxElements)
const result = await getUiElements(searchTitle, 4, 80);
const blind = detectUiaBlind(result);

console.log(`UIA elements detected: ${result.elements.length}`);
console.log(`detectUiaBlind():`, JSON.stringify(blind, null, 2));

if (blind.blind) {
  console.log(`\n✅ → SoM fallback WOULD TRIGGER (reason: ${blind.reason})`);
} else {
  console.log(`\n— → SoM fallback would NOT trigger (UIA sufficient)`);
}
