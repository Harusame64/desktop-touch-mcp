# Release Notes: Rust Native Engine Integration

> **desktop-touch-engine** v0.2.0 — UIA (UI Automation) ネイティブエンジン

---

## ハイライト

Windows UI Automation の全 13 関数を **Rust (napi-rs)** でネイティブ実装し、従来の PowerShell プロセス起動方式から劇的なパフォーマンス向上を実現しました。

### 🚀 パフォーマンス

| 関数 | Rust Native | PowerShell | 高速化 |
|---|---|---|---|
| `getFocusedElement` | **2.2 ms** | 366 ms | **163.9x** |
| `getUiElements` | **106.5 ms** | 346 ms | **3.3x** |

**平均高速化: 83.6 倍**

- `getFocusedElement`: COM ダイレクト呼び出しにより PowerShell プロセス起動コスト (~360ms) を完全に排除
- `getUiElements`: `FindAllBuildCache(TreeScope_Children)` によるバッチ BFS アルゴリズムで、レベル単位の一括フェッチと `maxElements` による即時打ち切りを実現

### 🛡️ 堅牢性

- **PS フォールバック**: Rust エンジンが利用不可またはエラーを返した場合、自動的に従来の PowerShell パスへフォールバック
- **COM スレッド安全**: MTA (Multi-Threaded Apartment) シングルトンパターンによる COM スレッド基盤
- **CacheRequest 一括フェッチ**: 7 プロパティ + 6 パターンをキャッシュリクエストに登録し、クロスプロセス RPC を最小化

---

## 実装済み関数 (13/13)

### Phase A: COM スレッド基盤
- MTA シングルトン (`OnceLock<Mutex<UiaContext>>`)
- `IUIAutomation` / `IUIAutomationTreeWalker` / `IUIAutomationCacheRequest` の初期化

### Phase B: コア関数 — ツリー取得 + フォーカス
| 関数 | 説明 |
|---|---|
| `uiaGetElements` | バッチ BFS によるUI要素ツリー取得 |
| `uiaGetFocusedElement` | フォーカス要素の取得 |
| `uiaGetFocusedAndPoint` | フォーカス + カーソル位置の要素取得 |

### Phase C: アクション関数
| 関数 | 説明 |
|---|---|
| `uiaClickElement` | InvokePattern による要素クリック |
| `uiaSetValue` | ValuePattern による値設定 |
| `uiaInsertText` | ValuePattern による文字挿入 |
| `uiaGetElementBounds` | 要素の BoundingRectangle 取得 |
| `uiaGetElementChildren` | 指定要素の子要素ツリー取得 |
| `uiaGetTextViaTextPattern` | TextPattern によるテキスト取得 |

### Phase D: スクロール + 仮想デスクトップ
| 関数 | 説明 |
|---|---|
| `uiaScrollIntoView` | ScrollItemPattern による表示領域スクロール |
| `uiaGetScrollAncestors` | 親要素の ScrollPattern 探索 |
| `uiaScrollByPercent` | ScrollPattern.SetScrollPercent |
| `uiaGetVirtualDesktopStatus` | IVirtualDesktopManager による仮想デスクトップ判定 |

### Phase E: TS 統合
- `uia-bridge.ts` の全 13 関数にネイティブ優先ルーティング追加
- `try/catch` による PS フォールバック二重安全策
- 既存キャッシュロジック (`getCachedUia`/`updateUiaCache`) との整合性維持

---

## アルゴリズム最適化履歴

`getUiElements` のツリー探索アルゴリズムを3段階で検証:

| # | アルゴリズム | RPC 回数 | 中央値 | Early Exit |
|---|---|---|---|---|
| 1 | TreeWalker DFS | ~2N | 91.5 ms | ✓ (ノード単位) |
| 2 | BuildUpdatedCache (TreeScope_Subtree) | 1 | ~95 ms | ❌ (全ツリー) |
| 3 | **FindAllBuildCache (TreeScope_Children) BFS** | ~N_parent | ~105 ms | ✓ (レベル単位) |

**選定理由**: `TreeScope_Subtree` は UIA プロバイダーに全ツリー列挙を強制するため、巨大ツリー (1000+ 要素) では `maxElements` による早期打ち切りが不可能。バッチ BFS はレベル単位で打ち切り可能であり、大規模アプリケーションでの真の高速化を実現。

---

## テスト

- **51 テスト全通過** (UIA 統合テスト 29 件 + 画像差分テスト 22 件)
- テストカテゴリ:
  - エクスポート存在確認 (13 関数)
  - エラーハンドリング (存在しないウィンドウ、ActionResult 形式)
  - ライブ呼び出し (フォーカス要素、ツリー取得、型検証)
  - maxElements 制限遵守
  - fetchValues オプション動作

---

## 技術スタック

- **Rust** + **napi-rs** (Node.js ネイティブアドオン)
- **windows-rs 0.62** (COM / UIA / Shell API)
- **Rust 2024 edition**
- ターゲット: `x86_64-pc-windows-msvc`

---

## 既知の制限

- `getUiElements` の実行時間 (~105ms) は、UIA プロバイダー側 (Explorer.exe 等) の要素列挙処理 (~80ms) が支配的であり、クライアント側アルゴリズムでは解消不可能
- 仮想デスクトップ判定 (`IVirtualDesktopManager`) は Windows 10 以降のみ対応
