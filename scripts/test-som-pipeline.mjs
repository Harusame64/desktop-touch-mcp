#!/usr/bin/env node
/**
 * test-som-pipeline.mjs
 *
 * SoM パイプラインの結合テストスクリプト。
 * ネイティブ (.node) が存在する環境で runSomPipeline を直接キックし、
 * 各フェーズの実行時間・出力要素数・SoM 画像の有無を検証する。
 *
 * 使い方:
 *   node scripts/test-som-pipeline.mjs [window-title] [scale]
 *
 * 例:
 *   node scripts/test-som-pipeline.mjs "メモ帳" 2
 *   node scripts/test-som-pipeline.mjs "Notepad" 2
 *
 * ネイティブモジュール (.node) がまだビルドされていない場合:
 *   npm run build:rs        # リリースビルド (推奨)
 *   npm run build:rs:debug  # デバッグビルド (遅いが詳細エラーが出る)
 *
 * 出力ファイル:
 *   _som-test-output.png  — SoM 画像 (Rust drawSomLabels が利用可能な場合)
 */

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

// ── CLI 引数 ──────────────────────────────────────────────────────────────────
const windowTitle = process.argv[2] ?? "メモ帳";
const scale       = Number(process.argv[3] ?? 2);
const ocrLang     = process.argv[4] ?? "ja";

console.log(`\n=== SoM Pipeline Integration Test ===`);
console.log(`  window : "${windowTitle}"`);
console.log(`  scale  : ${scale}`);
console.log(`  lang   : ${ocrLang}`);
console.log(`=====================================\n`);

// ── Import (ESM 動的 import) ───────────────────────────────────────────────
const { runSomPipeline } = await import("../dist/engine/ocr-bridge.js").catch((e) => {
  console.error("ERROR: dist/ が見つかりません。先に npm run build を実行してください。");
  console.error(e.message);
  process.exit(1);
});

// ── 実行 ──────────────────────────────────────────────────────────────────────
const t0 = performance.now();

let result;
try {
  result = await runSomPipeline(windowTitle, null, ocrLang, scale);
} catch (err) {
  console.error(`FAILED: ${err.message}`);
  console.error("\n考えられる原因:");
  console.error("  1. ウィンドウが見つからない → タイトルを確認してください");
  console.error("  2. win-ocr.exe がインストールされていない");
  console.error("  3. .node が古い (npm run build:rs でリビルド)");
  process.exit(1);
}

const elapsed = (performance.now() - t0).toFixed(1);

// ── 結果表示 ──────────────────────────────────────────────────────────────────
console.log(`\n--- Results (wall-clock: ${elapsed}ms) ---`);
console.log(`  preprocessScale : ${result.preprocessScale}`);
console.log(`  elements        : ${result.elements.length}`);
console.log(`  somImage        : ${result.somImage ? `present (${result.somImage.mimeType})` : "null (Rust .node not available)"}`);

if (result.elements.length > 0) {
  console.log(`\n  Top 10 elements:`);
  for (const el of result.elements.slice(0, 10)) {
    const r = el.region;
    console.log(
      `    [${String(el.id).padStart(3)}] "${el.text.slice(0, 40)}"  ` +
      `click=(${el.clickAt.x},${el.clickAt.y})  ` +
      `region=(${r.x},${r.y} ${r.width}×${r.height})`
    );
  }
  if (result.elements.length > 10) {
    console.log(`    ... and ${result.elements.length - 10} more`);
  }
}

// ── SoM 画像を保存 ────────────────────────────────────────────────────────────
if (result.somImage) {
  const outPath = "_som-test-output.png";
  writeFileSync(outPath, Buffer.from(result.somImage.base64, "base64"));
  console.log(`\n  SoM image saved → ${outPath}`);
} else {
  console.log(`\n  ℹ SoM image skipped (Rust drawSomLabels unavailable; rebuild with npm run build:rs)`);
}

// ── 基本アサーション ──────────────────────────────────────────────────────────
let passed = true;

if (result.elements.length === 0) {
  console.warn(`\n  ⚠ WARN: 0 elements detected — OCR が機能していない可能性があります`);
  passed = false;
}

if (result.preprocessScale !== scale) {
  console.error(`\n  ✗ preprocessScale mismatch: expected=${scale}, got=${result.preprocessScale}`);
  passed = false;
}

console.log(passed ? `\n✅ Test PASSED\n` : `\n⚠  Test finished with warnings\n`);
