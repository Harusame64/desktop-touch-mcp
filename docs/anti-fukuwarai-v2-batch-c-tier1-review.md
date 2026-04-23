# Anti-Fukuwarai v2 — Batch C Tier 1 技術的暫定 Go レビュー

作成: 2026-04-23  
フェーズ: P4-E / Batch C  
判定者: Claude Sonnet 4.6 (1M context) + Opus 設計レビュー

---

## 判定フレームワーク

Batch C の dogfood は **2 層構造** で判定する。

| 層 | 担当 | 内容 | 結果が意味すること |
|---|---|---|---|
| **Tier 1** | Claude（AI） | 静的コード確認 + 実機 HTTP 確認 | v0.17.0 default-on の「コード準備完了」 |
| **Tier 2** | ユーザー | 5 シナリオ実録（dogfood-log.md） | v0.17.0 release tag + publish の許可 |

Tier 1 が ✅ でも **Tier 2 完了まで release しない**（v0.16.x patch で dogfood 継続）。

---

## Tier 1 チェック結果

### T1: unit tests all pass

- **確認方法**: `npx vitest run`
- **結果**: ✅ **350 tests pass**（2026-04-23 Batch B 完了時確認済み）
- **スコープ**: lease / digest / modal guard 契約・activation policy・visual retry 条件

### T2: HTTP preflight 6/6 pass（default-on = 60 tools）

- **確認方法**: `pwsh -File scripts/test-http-mcp.ps1` (2026-04-23 Batch B 直後)
- **結果**: ✅ **6/6 pass、60 tools（58 V1 + 2 V2）**
- **スコープ**: health / initialize / tools/list / invalid method / CORS / stateless mode

### T3: G1 modal/viewport/focus wiring — production facade に実接続済み

- **確認方法**: `src/tools/desktop-register.ts` 静的解析
- **結果**: ✅ **実接続確認済み**

| 機能 | 実装関数 | 行番号 | デフォルト値ではないことの確認 |
|---|---|---|---|
| viewport guard | `productionIsInViewport()` | L50-63 | foreground window との rect 比較ロジック（`computeViewportPosition` 使用） |
| focus detection | `productionGetFocusedEntityId()` | L73-81 | `enumWindowsInZOrder()` で実 hwnd を取得 |
| wiring | `getDesktopFacade()` | L174-176 | `isInViewport: productionIsInViewport`, `getFocusedEntityId: productionGetFocusedEntityId` を渡している |

`isModalBlocking` はデフォルトの session-registry 実装（`() => false` ではなく UIA `role === "unknown"` チェック）を使用。これは session-registry.ts 内のデフォルト値が production-ready である確認済み（P4-C 時点）。

### T4: G2 terminal WM_CHAR background path — foreground path 置換済み

- **確認方法**: `src/tools/desktop-executor.ts` 静的解析
- **結果**: ✅ **background path のみ、foreground focus steal なし**

| 確認項目 | 行番号 | 結果 |
|---|---|---|
| `terminalSend()` が `postCharsToHwnd` / WM_CHAR path を使用 | L241-254 | ✅ `terminalBgExecute()` 経由 |
| `restoreAndFocusWindow()` + `keyboard.type()` が残っていない | 全体 | ✅ 存在しない |
| unsupported terminal に explicit throw | L69-92 | ✅ `canInjectViaPostMessage` 失敗時に throw |
| partial send も throw | L78-91 | ✅ `result.full === false` で throw |

### T5: G4 visual attach retry — 実装済み

- **確認方法**: `src/tools/desktop-providers/compose-providers.ts` 静的解析
- **結果**: ✅ **両警告対象 + 1 回上限 + 全 3 ブランチ使用**

| 確認項目 | 行番号 | 結果 |
|---|---|---|
| `fetchVisualCandidatesWithRetry()` 存在 | L35-50 | ✅ |
| `visual_provider_unavailable` が retry 対象 | L36 | ✅ |
| `visual_provider_warming` が retry 対象 | L37 | ✅ |
| retry 上限 1 回 | L45-49 | ✅（2 回目フェッチ後は再 retry しない） |
| 待機時間 ~200ms | L32: `VISUAL_RETRY_DELAY_MS = 200` | ✅ |
| browser ブランチで retry wrapper 使用 | L170 | ✅ |
| terminal ブランチで retry wrapper 使用 | L192 | ✅ |
| native ブランチで retry wrapper 使用 | L210 | ✅ |

### T6: kill switch 実機確認 — DISABLE=1 で V2 が消える

- **確認方法**: HTTP server 起動 × 2（default / DISABLE=1 設定）→ tools/list
- **確認日時**: 2026-04-23 Batch C Tier 1 実施時
- **結果**: ✅ **kill switch 動作確認済み**

| 環境 | tool count | V2 tools (desktop_see + desktop_touch) |
|---|---|---|
| default（DISABLE 未設定） | **60** | **2（present）** |
| `DISABLE_FUKUWARAI_V2=1` | **58** | **0（absent）** |

サーバー stdout に `[desktop-touch] v2 tools: disabled (DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1)` が正確に出力されることも確認。

### T7: warning / fail reason enum — coexistence-policy.md §3 と完全一致

- **確認方法**: `guarded-touch.ts` + `compose-providers.ts` vs `coexistence-policy.md §3`
- **結果**: ✅ **7 + 7 = 14 コード全て一致、過不足なし**

**desktop_see warnings（7 種）:**

| warning コード | 実装ファイル | docs 記載 |
|---|---|---|
| `no_provider_matched` | compose-providers.ts L141, 150 | ✅ |
| `partial_results_only` | compose-providers.ts L91-92 | ✅ |
| `cdp_provider_failed` | compose-providers.ts L174 | ✅ |
| `visual_provider_unavailable` | compose-providers.ts L36 | ✅ |
| `visual_provider_warming` | compose-providers.ts L37 | ✅ |
| `uia_provider_failed` | compose-providers.ts L195 | ✅ |
| `terminal_provider_failed` | compose-providers.ts L195 | ✅ |

**desktop_touch fail reasons（7 種）:**

| reason コード | 実装ファイル | docs 記載 |
|---|---|---|
| `lease_expired` | guarded-touch.ts L22 | ✅ |
| `lease_generation_mismatch` | guarded-touch.ts L23 | ✅ |
| `entity_not_found` | guarded-touch.ts L24 | ✅ |
| `lease_digest_mismatch` | guarded-touch.ts L25 | ✅ |
| `modal_blocking` | guarded-touch.ts L26 | ✅ |
| `entity_outside_viewport` | guarded-touch.ts L27 | ✅ |
| `executor_failed` | guarded-touch.ts L28 | ✅ |

### T8: v0.16.x 運用中の crash/hang/leak

- **確認方法**: v0.16.0 はまだ npm publish されていない（P4-D 決定段階、release 実行は未着手）
- **結果**: 🔵 **未リリースのため計測不可（N/A）**
- **代替証跡**: HTTP preflight 起動 × 複数回（本セッション含む）で crash/hang なし。unit test 350 件でも session leak が 0 件（`_resetFacadeForTest` による明示的リセットで session isolation を検証済み）

---

## Tier 1 判定サマリ

| # | チェック項目 | 結果 |
|---|---|---|
| T1 | 350 unit tests pass | ✅ |
| T2 | HTTP preflight 6/6, 60 tools | ✅ |
| T3 | G1 modal/viewport/focus — production wiring | ✅ |
| T4 | G2 terminal — WM_CHAR background path | ✅ |
| T5 | G4 visual attach retry（両警告・1 回・全ブランチ） | ✅ |
| T6 | kill switch 実機確認（DISABLE=1 → 58 tools） | ✅ |
| T7 | warning / fail reason enum 完全一致（14 コード） | ✅ |
| T8 | crash/hang/leak 0 件 | 🔵 N/A（未リリース）|

**結論: Tier 1 技術的暫定 Go ✅**

v0.17.0 default-on のコード実装は完了。kill switch は動作確認済み。warning / fail reason の契約は実装と docs で完全一致。

> **ただし Tier 2（ユーザー dogfood 5 シナリオ）完了まで v0.17.0 release tag / npm publish は実行しない。**

---

## Tier 2 に向けての引き継ぎ

`docs/anti-fukuwarai-v2-dogfood-log.md` の各シナリオを実行してください。

### 事前確認

```bash
# 1. MCP サーバーが desktop-touch-mcp に接続していることを確認
# 2. v2 が default-on になっていることを確認（DISABLE flag が設定されていないこと）
# 3. ブラウザ（Chrome/Edge）を --remote-debugging-port=9222 付きで起動しておく
```

### 実録手順

各シナリオで以下を記録する（dogfood-log.md のテンプレートに従う）:

1. `desktop_see` を呼んで entity 一覧を確認
2. `desktop_touch` で目的の操作を実行
3. `ok: true` か `ok: false` かを記録
4. `warnings[]` に何が出たかを記録
5. fallback が必要なら V1 tool を使い、その結果も記録
6. 最終 verdict を記録

### 合格ライン再確認（Tier 2）

1. 5 シナリオ全て記録済み
2. 3/5 以上が V2 単独 passed（V1 fallback 1 回以内も可）
3. fail 時は V1 fallback 成功
4. warning / reason が docs と矛盾しない（T7 で確認済みの enum を参照）
5. crash / hang / session leak 0 件

合格ライン 5 点達成 → v0.17.0 default-on release 実行可。
