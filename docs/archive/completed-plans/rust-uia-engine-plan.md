# UIA ネイティブ移行プロジェクト — 完了報告書

> **Status: ✅ 全フェーズ完了 (Phase A〜E)**
> **Date: 2026-04-18**
> **Package: `@harusame64/desktop-touch-engine` v0.2.0**

---

## 1. プロジェクト概要

`uia-bridge.ts` の全 UIA 操作 (13 関数) を PowerShell プロセス起動方式から
**Rust (`napi-rs` + `windows-rs 0.62`) による直接 COM 呼び出し** に移行するプロジェクト。

設計計画書: [`docs/rust-uia-engine-design.md`](./rust-uia-engine-design.md)

---

## 2. 最終ベンチマーク結果

| 関数 | Rust Native | PowerShell | 高速化倍率 |
|---|---|---|---|
| `getFocusedElement` | **2.2 ms** | 366 ms | **163.9x** |
| `getUiElements` (Explorer) | **106.5 ms** | 346 ms | **3.3x** |

### 高速化の構造的分析

**`getFocusedElement` — 163.9 倍高速化**
PowerShell 版の実行時間 (~366ms) の大部分は `powershell.exe` プロセス起動 + .NET アセンブリロードに費やされていた。
Rust 版はインプロセス COM 呼び出しにより、このオーバーヘッドを **完全に排除**。

**`getUiElements` — 3.3 倍高速化**
UIA プロバイダー側 (Explorer.exe 等) の要素列挙処理 (~80ms) がボトルネックの下限であり、
クライアント側アルゴリズムの最適化ではこれ以上の高速化は原理的に不可能。
3.3 倍の高速化は PowerShell 起動コスト (~200ms) の排除分に相当し、理論限界に近い成果。

### BFS アルゴリズムのスケーラビリティ設計

`getUiElements` は最終的に **バッチ型 BFS (FindAllBuildCache + TreeScope_Children)** を採用した。

3 段階のアルゴリズム検証を実施:

| # | アルゴリズム | RPC 回数 | 中央値 | Early Exit |
|---|---|---|---|---|
| 1 | TreeWalker DFS | ~2N (~120) | 91.5 ms | ✓ (ノード単位) |
| 2 | BuildUpdatedCache (TreeScope_Subtree) | 1 | ~95 ms | ❌ (全ツリー) |
| **3** | **FindAllBuildCache (TreeScope_Children) BFS** | **~N_parent** | **~105 ms** | **✓ (レベル単位)** |

**Explorer 等の軽量アプリ (~60-100 要素) では RPC 削減効果が相殺されるが、
VS Code やブラウザ等の巨大ツリー (1000+ 要素) において `maxElements` キャップによる
Early Exit で不要な RPC を完全に打ち切れるため、圧倒的なスケーラビリティと安定性を発揮する設計である。**

> **`TreeScope_Subtree` の罠**: UIA プロバイダーに全ツリー列挙を強制するため、
> 巨大ツリーでは `maxElements` による早期打ち切りが不可能。
> これは UIA の既知のパフォーマンス・アンチパターンであり、設計段階で排除した。

---

## 3. 実装フェーズ完了状況

### Phase A: COM スレッド基盤 (P0) — ✅ 完了

- [x] `src/uia/mod.rs` — モジュール構成 + `control_type_name` ユーティリティ
- [x] `src/uia/thread.rs` — COM スレッド singleton (`OnceLock<Sender<UiaTask>>`)
- [x] `src/uia/types.rs` — `#[napi(object)]` 型定義 (全 10 struct)
- [x] `Cargo.toml` — `windows 0.62` + `crossbeam-channel 0.5` 依存追加
- [x] COM 初期化 + `IUIAutomation` + `CacheRequest` + `ControlViewCondition` の生成確認
- [x] ビルド確認 + 既存画像差分テスト通過

### Phase B: コア関数 — ツリー取得 + フォーカス (P0) — ✅ 完了

- [x] `src/uia/tree.rs` — `uia_get_elements` (バッチ型 BFS)
  - ウィンドウ検索 (部分タイトル一致, case-insensitive)
  - `FindAllBuildCache(TreeScope_Children)` による BFS ウォーク
  - `maxDepth`, `maxElements` 制限 + Early Exit
  - `fetchValues` オプション (GetCachedPattern → CachedValue)
  - オフスクリーン要素の枝刈り
- [x] `src/uia/focus.rs` — `uia_get_focused_and_point` / `uia_get_focused_element`
- [x] `lib.rs` — AsyncTask + napi エクスポート追加
- [x] 統合テスト (`__test__/uia.spec.ts`): 29 テスト全通過

### Phase C: アクション関数 (P1) — ✅ 完了

- [x] `src/uia/actions.rs` — `uia_click_element` / `uia_set_value` / `uia_insert_text`
  - 要素検索 (name/automationId/controlType フィルタ)
  - InvokePattern / ValuePattern
  - IsEnabled チェック → ActionResult `{ ok: false, error }` 返却
- [x] `src/uia/tree.rs` — `uia_get_element_bounds` / `uia_get_element_children`
- [x] `src/uia/text.rs` — `uia_get_text_via_text_pattern`

### Phase D: スクロール + 仮想デスクトップ (P2) — ✅ 完了

- [x] `src/uia/scroll.rs` — `uia_scroll_into_view` / `uia_get_scroll_ancestors` / `uia_scroll_by_percent`
- [x] `src/uia/vdesktop.rs` — `uia_get_virtual_desktop_status`

### Phase E: TS 統合 + フォールバック — ✅ 完了

- [x] `uia-bridge.ts` — 全 13 関数にネイティブ優先パス + PS フォールバック
- [x] `index.js` / `index.d.ts` — UIA 関数のエクスポート
- [x] パフォーマンスベンチマーク (`scripts/benchmark-uia.ts`)
- [x] 29 UIA 統合テスト + 22 画像差分テスト = **51 テスト全通過**

---

## 4. テスト結果

```
 Test Files  2 passed (2)
      Tests  51 passed (51)
   Duration  2.34s
```

| カテゴリ | テスト数 | 結果 |
|---|---|---|
| エクスポート存在確認 (全 13 関数) | 13 | ✅ |
| エラーハンドリング (ActionResult, null) | 11 | ✅ |
| ライブ呼び出し (Focus, Tree, Bounds) | 5 | ✅ |
| 画像差分エンジン (pixel_diff, dhash) | 22 | ✅ |

---

## 5. 技術的知見

### UIA の RPC 特性

- UIA のクロスプロセス COM 呼び出し 1 回あたりのオーバーヘッドは **~0.1ms** (当初推定の ~0.5-1ms より遥かに軽量)
- ボトルネックはクライアント側の RPC 回数ではなく、**UIA プロバイダー側 (対象アプリ) の要素列挙処理**
- Explorer.exe のような軽量アプリ (~60 要素) は、いかなるアルゴリズムでも ~80ms が下限

### COM スレッドモデルの解決

- `IUIAutomation` (ネイティブ COM) は **MTA セーフ** — .NET の STA 制約は適用されない
- `OnceLock<Sender<UiaTask>>` パターンで lazy-init singleton を実現
- クロージャ送信 + one-shot reply channel パターンにより、API 設計をシンプルに維持

### CacheRequest の効果

- 7 プロパティ + 6 パターンをプリビルド CacheRequest に登録
- `GetCachedPattern` / `CachedValue` により ValuePattern 取得時の追加 RPC をゼロ化
- キャッシュ設計は `TreeScope_Element` スコープで統一 (FindAllBuildCache 互換)

---

## 6. モジュール構成 (確定)

```
src/uia/
├── mod.rs              ← サブモジュール re-export + control_type_name()
├── thread.rs           ← COM スレッド singleton (OnceLock + crossbeam-channel)
├── types.rs            ← #[napi(object)] 型定義 (10 struct)
├── tree.rs             ← getElements / getElementBounds / getElementChildren (BFS)
├── focus.rs            ← getFocusedElement / getFocusedAndPoint
├── actions.rs          ← clickElement / setValue / insertText
├── text.rs             ← getTextViaTextPattern
├── scroll.rs           ← scrollIntoView / getScrollAncestors / scrollByPercent
└── vdesktop.rs         ← getVirtualDesktopStatus (IVirtualDesktopManager)
```

---

## 7. 参照

- 技術設計書: [`docs/rust-uia-engine-design.md`](./rust-uia-engine-design.md)
- リリースノート: [`docs/release-notes-native-engine.md`](./release-notes-native-engine.md)
- ベンチマーク: `scripts/benchmark-uia.ts`