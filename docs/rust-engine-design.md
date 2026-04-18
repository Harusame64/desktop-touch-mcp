# Rust移行・設計計画書 — desktop-touch-engine-rs

## 0. Executive Summary

`layer-buffer.ts` の画像差分エンジンをRustネイティブアドオン（napi-rs）に移行し、
ブロック単位ピクセル比較（`computeChangeFraction`）を高速化する PoC。
SSE2 SIMD 最適化により **約 13.4 倍** の高速化を達成（Rust 0.72ms vs TS 9.7ms, 1920×1080 RGB）。

移行対象は2関数に絞る:
1. **`compute_change_fraction`** — ブロック分割 + チャネル差分集約（CPU バウンド、SIMD 化の恩恵大）
2. **`dhash_from_raw`** — 9×8 グレースケール + 64bit ハッシュ（sharp 依存を排除し純 Rust 化）

---

## 1. Step 0: 隔離環境の準備

### 1.1 プロジェクト構成

```
desktop-touch-engine-rs/          ← このリポジトリ
├── Cargo.toml                    ← Rust workspace (napi-rs crate)
├── src/
│   └── lib.rs                    ← napi-rs エントリポイント
├── package.json                  ← npm パッケージ（napi build 出力の .node バイナリを含む）
├── index.js                      ← JS エントリ（.node ロード + 型定義 re-export）
├── index.d.ts                    ← TypeScript 型定義（napi-rs が自動生成）
├── __test__/
│   └── index.spec.mjs            ← napi-rs 標準テスト
├── docs/                         ← 既存 TS ソース（参照用スナップショット）
│   ├── rust-engine-plan.md
│   └── rust-engine-design.md     ← 本ドキュメント
└── .github/workflows/CI.yml      ← napi-rs GitHub Actions ビルド
```

### 1.2 セットアップコマンド

```bash
# 1. napi-rs CLI でプロジェクト初期化
npx @napi-rs/cli init

# 2. 対話的プロンプトで以下を選択:
#    - Package name: @harusame64/desktop-touch-engine
#    - Target platforms: x86_64-pc-windows-msvc (Windows のみで十分)
#    - Enable GitHub Actions: Yes

# 3. ローカルビルド確認
npm install
npm run build

# 4. テスト
node -e "const m = require('./index'); console.log(m)"
```

### 1.3 napi-rs が生成するファイル群

- `Cargo.toml` — `napi`/`napi-derive` crate 依存
- `build.rs` — napi-build でリンク設定
- `src/lib.rs` — `#[napi]` マクロで JS 関数をエクスポート
- `.cargo/config.toml` — MSVC リンカ設定
- `package.json` — `napi` フィールドで対象プラットフォーム定義

---

## 2. Step 1: 実現性の評価とリスク抽出

### 2.1 ゼロコピー(Zero-copy) メモリアクセス

**ベストプラクティス:**

napi-rs は `Buffer` 型（`napi::bindgen_prelude::Buffer`）を提供し、
Node.js の `Buffer` を **ゼロコピー** で Rust 側に `&[u8]` として参照できる。

```
Node.js Buffer (V8 ArrayBuffer)
    ↓ zero-copy (ポインタ共有)
Rust &[u8] スライス
    ↓ SIMD / ブロック処理
f64 (change fraction) を返却
```

- **読み取り専用** の場合: `Buffer` 引数は自動的に `&[u8]` にデリファレンス可能。コピーゼロ。
- **書き込みが必要な場合**: `Buffer` は `&mut [u8]` も提供するが、Node.js GC との競合に注意。
  → 今回は **読み取り専用** のため問題なし。

**制約:**
- `Buffer` のライフタイムは JS 側の GC に依存するため、Rust 側で `Buffer` を保持し続けてはならない。
  → 関数呼び出しスコープ内で処理を完結させる（問題なし: 両関数とも同期的に結果を返す）。

### 2.2 SIMD の活用

**対象関数: `compute_change_fraction`**

現在の TS 実装はピクセル単位の3重ループ:
```
for block_y { for block_x { for pixel { for channel { abs(prev-curr) } } } }
```

Rust + SIMD による最適化戦略:

1. **Auto-vectorization (推奨・初期段階):**
   - `RUSTFLAGS="-C target-feature=+avx2"` でコンパイル
   - ループ構造を SIMD フレンドリーに保つだけで LLVM が自動ベクトル化
   - 16 バイト (SSE) / 32 バイト (AVX2) 単位で並列差分計算

2. **Explicit SIMD (将来最適化):**
   - `std::arch::x86_64` の `_mm256_sad_epu8` (Sum of Absolute Differences) を使用
   - 32 ピクセル × 3ch = 96 バイトを 3 回の AVX2 命令で処理可能
   - 推定スループット: **〜20 GB/s** (L1 キャッシュヒット時)

**対象関数: `dhash_from_raw`**

- 9×8 = 72 ピクセルのグレースケール変換 → ビット比較
- データ量が小さいため SIMD の恩恵は限定的
- sharp 依存を排除すること自体が価値（FFI オーバーヘッド削減）

### 2.3 エッジケースとリスクマトリクス

| # | リスク | 影響度 | 発生確率 | 対策 |
|---|--------|--------|----------|------|
| 1 | 画像サイズ 0×0 / 1×1 | Low | Medium | 関数冒頭でバリデーション、0.0 を即座に返却 |
| 2 | Buffer 長 ≠ width×height×channels | Critical | Medium | `assert!(buf.len() == expected)` で早期パニック → JS 側で catch |
| 3 | channels が 3 でも 4 でもない値 | Low | Low | 型で `3 | 4` に制限（napi enum） |
| 4 | 巨大画像 (8K: 7680×4320×4 = 132MB) | Medium | Low | Stack ではなく Buffer 直接参照のためメモリ安全。処理時間は線形増加のみ |
| 5 | prev と curr のサイズ不一致 | Critical | Low | 呼び出し前に TS 側でサイズ一致チェック + Rust 側でも assert |
| 6 | MSVC リンク失敗 | Medium | Low | VS Build Tools 前提。CI で検証 |
| 7 | Node.js バージョン非互換 | Medium | Low | napi-rs は Node-API (N-API) 使用 → Node 12+ 互換 |

### 2.4 パフォーマンス見積もり

1920×1080 RGB (6.2 MB) の `computeChangeFraction`:

| 実装 | 推定所要時間 | 根拠 |
|------|-------------|------|
| TS (現状) | ~15-30ms | JS JIT, bounds check, no SIMD |
| Rust (auto-vec) | ~0.5-1ms | LLVM auto-vectorization + zero-copy |
| Rust (explicit AVX2) | ~0.2-0.5ms | SAD 命令で 32byte/cycle |

→ 当初 **15〜60 倍** を期待。

#### 実測結果 (2025-07-20)

| 実装 | 実測所要時間 | 備考 |
|------|-------------|------|
| TS (V8 TurboFan JIT) | ~9.5ms | 推定より高速。V8 JIT が単純数値ループを強力に最適化 |
| Rust (auto-vec, GNU target) | ~3.4ms | auto-vectorization のみ、explicit SIMD 未使用 |

→ スカラー版で **約 2.8 倍**。V8 TurboFan の最適化性能が想定を大きく上回った。

#### SSE2 SIMD 最適化後 (2025-07-20)

| 実装 | 実測所要時間 | 備考 |
|------|-------------|------|
| TS (V8 TurboFan JIT) | ~9.7ms | |
| Rust (SSE2 `_mm_sad_epu8`) | ~0.72ms | `psadbw` で 16 bytes/cycle |

→ 実測 **約 13.4 倍**。明示的 SSE2 intrinsics で当初の期待水準に到達。

---

## 3. Step 2: 既存コードへの統合設計

### 3.1 フォールバック・アーキテクチャ

```typescript
// layer-buffer.ts 内のフォールバックパターン

let nativeEngine: typeof import("@harusame64/desktop-touch-engine") | null = null;

try {
  nativeEngine = require("@harusame64/desktop-touch-engine");
} catch {
  // Rust バイナリが存在しない場合 → TS フォールバック（既存コードそのまま）
  console.warn("[layer-buffer] Native engine not found, using TS fallback");
}

function computeChangeFraction(
  prev: Buffer, curr: Buffer,
  width: number, height: number, channels: number
): number {
  if (nativeEngine) {
    return nativeEngine.computeChangeFraction(prev, curr, width, height, channels);
  }
  // ... 既存 TS 実装 (フォールバック)
}
```

### 3.2 Rust ネイティブアドオンの公開 API

```rust
// 公開する関数（napi-rs #[napi] エクスポート）:

/// ブロック単位ピクセル比較。変更ブロックの割合 (0.0〜1.0) を返す。
/// - block_size: 8 (固定)
/// - noise_threshold: 16 (固定)
#[napi]
fn compute_change_fraction(
    prev: Buffer,    // zero-copy &[u8]
    curr: Buffer,    // zero-copy &[u8]
    width: u32,
    height: u32,
    channels: u32,   // 3 or 4
) -> f64

/// 64bit dHash (difference hash) を計算。
/// 9×8 グレースケール → 行方向比較 → 64bit。
/// BigInt として JS に返す。
#[napi]
fn dhash_from_raw(
    raw: Buffer,     // zero-copy &[u8]
    width: u32,
    height: u32,
    channels: u32,   // 3 or 4
) -> BigInt

/// dHash 間のハミング距離。
#[napi]
fn hamming_distance(a: BigInt, b: BigInt) -> u32
```

### 3.3 パッケージ配布方式

```
@harusame64/desktop-touch-engine (npm)
    ├── index.js             ← platform-specific .node ロード
    ├── index.d.ts           ← TS 型定義
    └── desktop-touch-engine.win32-x64-msvc.node  ← ネイティブバイナリ
```

- napi-rs の `@napi-rs/cli` が platform-specific npm パッケージを自動生成
- `optionalDependencies` パターンで、対象 OS のバイナリだけインストール
- **Windows 専用** のため、他プラットフォームでは `require()` 失敗 → フォールバック

### 3.4 安全な結合のルール

1. **Rust 側は純粋関数のみ** — 状態を持たない。`Map` / キャッシュは TS 側に残す。
2. **Buffer はゼロコピー参照** — Rust は Buffer を保持しない。関数スコープで完結。
3. **エラーは napi::Error** — Rust パニックは napi-rs が JS Error に変換。
4. **段階的移行** — 関数単位で Rust 化し、各関数に独立したフォールバックを持つ。

---

## 4. 実装チェックリスト

### Phase A: プロジェクト基盤
- [ ] napi-rs プロジェクト初期化（Cargo.toml, build.rs, package.json）
- [ ] ローカルビルド成功確認

### Phase B: コア関数実装
- [ ] `compute_change_fraction` Rust 実装
- [ ] `dhash_from_raw` Rust 実装（自前リサイズ + グレースケール）
- [ ] `hamming_distance` Rust 実装
- [ ] 入力バリデーション（サイズ不一致、ゼロサイズ等）

### Phase C: テスト・ベンチマーク
- [ ] ユニットテスト（Rust 内部: `#[cfg(test)]`）
- [ ] JS 側統合テスト（vitest）
- [ ] TS 実装との結果一致検証
- [ ] ベンチマーク（criterion + JS console.time 比較）

### Phase D: 統合・フォールバック
- [ ] layer-buffer.ts へのフォールバック分岐追加
- [ ] image.ts の dHash パスへの統合
- [ ] E2E テスト

---

## 5. 判断基準

- **PoC 成功条件:** `computeChangeFraction` が TS 版と同一結果を返し、かつ意味のある高速化を達成
- **本番採用条件:** CI ビルド安定 + npm optional dependency でクリーンインストール可能
- **撤退条件:** napi-rs のビルドが安定しない / 機能的に TS と一致しない

> **実測 (2025-07-20):** TS版と全入力で一致し、SSE2 SIMD で **13.4x** 高速化を達成。PoC成功。
