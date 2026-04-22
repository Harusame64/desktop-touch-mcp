# Anti-Fukuwarai v2 — Release Planning Review

作成: 2026-04-22  
フェーズ: Phase 4 / Batch P4-C  
ブランチ: `desktop-touch-mcp-fukuwaraiv2`  
現行バージョン: 0.15.7

---

## 1. Current Release Outcome Recommendation

**Outcome 1: Ship experimental in release notes**

理由:
- G1/G2 blocker は両方 ✅ 閉
- Packaging review で新たな blocker なし
- Default OFF / opt-in / V1 escape hatch の 3 前提は崩れていない
- Vitest shebang fix を追加したため test suite が全 pass

条件: **README に V2 実験的機能セクションを追加してから release commit へ進むこと。**

---

## 2. Versioning Recommendation

### 推奨: `0.16.0` (minor)

| 候補 | 判断 | 理由 |
|---|---|---|
| `0.15.8` (patch) | 不採用 | G2 は terminal executor の挙動変更（foreground fallthrough → explicit throw）を含む。挙動変更は patch より minor が妥当 |
| **`0.16.0` (minor)** | **推奨** | 新 opt-in surface (`desktop_see`/`desktop_touch`) の追加 + G2 executor 挙動変更の組み合わせは minor に相当 |
| `0.16.0-experimental.0` (pre-release) | 不採用 | V2 が default OFF である以上、pre-release tag で外部露出を抑制する必要がない。minor で十分 |

#### 根拠詳細

- `desktop_see` / `desktop_touch` は `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` のときだけ公開される。default 動作は変わらない。
- G2: `terminalSend` real path が foreground fallthrough から explicit throw に変わった。これは experimental path のみの変更だが、挙動変更であり patch には不向き。
- semantic versioning `0.y.z`: y が「後方互換の機能追加」、z が「後方互換のバグ修正」。本変更は y に該当。

---

## 3. Server Surface Review

### 3.1. Flag OFF (default) の動作

| 観点 | 状態 |
|---|---|
| `desktop_see` / `desktop_touch` が catalog に出ないか | ✅ `src/server-windows.ts:46` の dynamic import guard で確認済み |
| V2 モジュールが import されないか | ✅ `_desktopV2 = null` — zero side-effects |
| V1 tools が影響を受けないか | ✅ `registerDesktopTools()` は呼ばれず、V1 登録フローに介入しない |

### 3.2. Flag ON (`DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1`) の動作

| 観点 | 状態 |
|---|---|
| V2 tools が MCP catalog に追加されるか | ✅ `desktop_see` + `desktop_touch` の 2 ツール |
| tool description が `[EXPERIMENTAL]` マーカーを持つか | ✅ `desktop-register.ts:208, 221` |
| fail reason / warning の説明が実装と一致しているか | ✅ P4-B で Opus review 済み |
| G1-A modal guard が有効か | ✅ session-aware UIA unknown-role 検出 |
| G1-B viewport guard が有効か | ✅ visual-only entity に foreground rect 判定 |
| G1-C focus detection が有効か | ✅ window-level hwnd fingerprint |
| G2 terminal が background path を優先するか | ✅ WM_CHAR injection、unsupported は explicit throw |

### 3.3. Tool description 注意点

- V2 descriptions は `[EXPERIMENTAL]` で始まるため、先頭が大文字ではない。
- `tests/unit/tool-descriptions.test.ts` は `TOOL_FILES` に `desktop-register.ts` を含まないため、この差異はテスト上問題なし。
- これは意図的な分離設計（V2 は opt-in surface、V1 とは別途 auditing）。

---

## 4. Packaging Review

### 4.1. ZIP into `desktop-touch-mcp-windows.zip`

| 観点 | 状態 |
|---|---|
| V2 ソースが `tsc` で `dist/` にコンパイルされるか | ✅ `npm run build` pass 確認済み |
| `release.yml` が `dist/` を全コピーするか | ✅ `Copy-Item -LiteralPath "dist" -Destination $releaseDir -Recurse` |
| V2 の dynamic import パス (`./tools/desktop-register.js`) が zip 内に存在するか | ✅ `dist/tools/desktop-register.js` として含まれる |
| 新たな native 依存が追加されていないか | ✅ なし（既存の `win32.js`, `bg-input.ts`, `uia-bridge.js` を reuse） |

### 4.2. npm Launcher Package

| 観点 | 状態 |
|---|---|
| npm package が V2 ファイルを含まないか | ✅ `files: [bin/launcher.js, LICENSE, README.md, README.ja.md]` のみ |
| launcher が V2 に依存しないか | ✅ launcher は純粋にダウンローダー。V2 は zip 内 |
| `PACKAGE_VERSION` / `RELEASE_MANIFEST.tagName` の整合性 | ✅ 現在 `0.15.7` — 次 release では `npm version 0.16.0 --no-git-tag-version` で自動更新 |
| `sha256` が `"PENDING"` でないか | ✅ `0.15.7` の sha256 が設定済み。次 release では CI が自動更新 |

### 4.3. HTTP Mode

| 観点 | 状態 |
|---|---|
| `test-http-mcp.ps1` が tool count を hardcode していないか | ✅ 動的にカウントして報告するのみ。特定数のアサーションなし |
| Flag OFF 時の HTTP mode ツール数変化 | ✅ V1 tools のみ (変化なし) |
| Flag ON 時の HTTP mode ツール数変化 | ✅ V1 + 2 = catalog count + 2 |
| HTTP preflight 手順が current state と矛盾するか | ✅ 矛盾なし (`release-process.md` の "56 tools" は旧バージョンの例示。現在は 58 tools だが手順に影響なし) |

### 4.4. Stub Catalog

- `npm run check:stub-catalog` → pass（diff なし）
- 現在 58 tools が catalog に登録されている

---

## 5. Docs / Release Note Planning

### 5.1. Release Note 表現案

```markdown
## Experimental: UI Operating Layer (Anti-Fukuwarai v2)

Two new opt-in tools that replace coordinate-based clicking with entity-based interaction.

Enable with `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` in your MCP env config.

- **`desktop_see`** — Observe a window or browser tab. Returns interactive entities with leases.
  No raw screen coordinates returned.
- **`desktop_touch`** — Interact with an entity from `desktop_see`. Validates lease before executing.
  Returns semantic diff (entity_disappeared, modal_appeared, etc.).

**Status**: Experimental. Default OFF. V1 tools remain as escape hatch.  
**Kill switch**: Remove the env var and restart. V1 tools continue to work without interruption.
```

### 5.2. README 更新要件

現状 README.md には V2 の記述がない。Ship 前に追加すべき内容:

- V2 experimental surface の概要 (2-3 行)
- `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` の設定方法
- kill switch / V1 fallback の説明

**blocker ではないが Ship commit に含めること** (現在は release planning 段階)。

### 5.3. 誤読防止のポイント

release note / README で避けるべき表現:

- ❌ 「新しいツール群で Windows を操作できます」(default-on のように読める)
- ❌ 「V1 ツールより優れた操作性」(migration を促すような表現)
- ✅ 「opt-in / experimental / default OFF」を必ず明記
- ✅ 「V1 tools はそのまま使える」escape hatch を明記

---

## 6. Ship / Hold 条件

### Ship (Outcome 1) の前提条件

次を全て満たした上で ship すること。

| 条件 | 現状 | 必要アクション |
|---|---|---|
| G1/G2 blocker 閉 | ✅ 済 | なし |
| build pass | ✅ 済 | なし |
| unit tests pass (5 files / 364 tests) | ✅ 済 | なし |
| stub-catalog check pass | ✅ 済 | なし |
| README に V2 experimental セクション追加 | ⬜ 未 | Ship commit に含める |
| HTTP preflight pass (6/6) | ⬜ 未確認 | release commit 前に実施 |
| `npm version 0.16.0 --no-git-tag-version` | ⬜ 未 | Phase 1 (release-process.md) |
| `git tag v0.16.0 && git push origin v0.16.0` | ⬜ 未 | Phase 3 (release-process.md) |
| CI build + zip + npm publish | ⬜ 未 | Phase 4-6 自動 |
| npx smoke test | ⬜ 未 | Phase 7 |

### Hold (Outcome 2) になる条件

以下のいずれかが発覚した場合は Hold とし、次の release 機会へ延期する。

| Hold 理由 | 現状評価 |
|---|---|
| HTTP preflight が 6/6 PASS しない | 未確認（実環境確認要） |
| zip 内に V2 `.js` ファイルが欠落している | リスク低（CI が `dist/` を全コピー） |
| V2 flag ON で V1 tools が壊れる | テスト済み（impact なし） |
| README に誤解を招く記述が入る | 事前レビューで防止可能 |
| release-process.md の手順に変更が必要な新要因 | 発見なし |

---

## 7. Rollout / Rollback Plan

### Rollout

```
1. README に V2 実験的機能セクションを追加（本 commit 後に実施）
2. npm version 0.16.0 --no-git-tag-version（release-process.md Phase 1）
3. HTTP preflight 確認（Phase 2）
4. git commit + tag v0.16.0 + push（Phase 3）
5. CI 完了待ち: GitHub Release zip + npm publish（Phase 4-6 自動）
6. npx smoke test + MCP registry publish（Phase 7）
```

### Kill Switch（ユーザー向け）

```json
// claude_desktop_config.json から DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1 を削除
// サーバーを再起動
// V1 tools は即時フルで使用可能
```

コード変更・再インストール不要。

---

## 8. Pre-existing Issues Found and Fixed

### P4-C で発見・修正したもの

| 項目 | 内容 | 対処 |
|---|---|---|
| `launcher-stdio.test.ts` が fail | `bin/launcher.js` のシェバン (`#!/usr/bin/env node`) を Vite transform がstrip しないため SyntaxError | `vitest.config.ts` に `strip-shebang` plugin を追加して修正 |

### Pre-existing だが今回修正しなかったもの

| 項目 | 内容 | 備考 |
|---|---|---|
| README "57 tools" 表記 | stub-catalog は 58 tools（V1）。一致していない | V2 追加記述のタイミングで合わせて修正推奨 |
| package.json description "56 tools" | 同様に旧カウント | 同上 |
| release-process.md "56 tools" 例示 | HTTP smoke 出力例が旧数値 | ドキュメント的な話で動作に影響なし |

---

## 9. Next Steps (実行すべき手順)

P4-C 完了後、P4-D (Ship/No-Ship Decision Memo) 前に実施すること。

```
1. README.md / README.ja.md に V2 experimental セクションを追加する（本 batch で minimal 版を追加済み or 次 commit）
2. HTTP preflight を実行し 6/6 PASS を確認する（release-process.md Phase 2）
3. npm version 0.16.0 --no-git-tag-version を実行する（Phase 1）
4. Phase 3 以降は release-process.md に従う
```

P4-D では Ship/No-Ship を 1 枚のメモで最終判断する。

---

## 10. 関連ドキュメント

- [anti-fukuwarai-v2-default-on-readiness.md](anti-fukuwarai-v2-default-on-readiness.md) — P4-B: rollback policy
- [anti-fukuwarai-v2-experimental-quality-review.md](anti-fukuwarai-v2-experimental-quality-review.md) — P4-A: quality review
- [anti-fukuwarai-v2-g1-g2-implementation-instructions.md](anti-fukuwarai-v2-g1-g2-implementation-instructions.md) — G1/G2 実装
- [release-process.md](release-process.md) — リリース実行手順（必ず full read）
