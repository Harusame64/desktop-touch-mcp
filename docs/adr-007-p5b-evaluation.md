# ADR-007 P5b — `#[napi_safe]` proc_macro 化 評価

**結論: 保留 (defer)。** 既存ガードで coverage 100% / `napi_safe_call` 手動 wrap 70 箇所は管理可能、workspace 変換コストに見合う追加価値が見えない。

---

## 現状 (2026-04-29)

| 項目 | 値 |
|---|---|
| `napi_safe_call(...)` 呼び出し件数 | **70 箇所 / 16 ファイル** |
| `#[napi]` sync export coverage | **100%** (`scripts/check-napi-safe.mjs` で CI fail) |
| Cargo.toml | **単一 package** (`desktop-touch-engine`)、workspace 未使用 |
| `napi_safe_call` 実装 | `src/win32/safety.rs` (catch_unwind + L1 ring 通知) |

`scripts/check-napi-safe.mjs` は `src/` 全 `*.rs` をスキャンし、sync `#[napi]` export ごとに `napi_safe_call(` の wrap を確認。AsyncTask return は除外（libuv worker pool が panic を Promise reject に変換するため）。

## proc_macro 化のメリット

1. **ボイラープレート 70 行削減**: `napi_safe_call("fn_name", || { ... })` の wrap が `#[napi_safe]` 1 行に
2. **新規 export の取りこぼし漏れ防止 (構文レベル)**: 関数本体を読まずに macro 展開で確実に wrap
3. **関数名の自動取得**: `napi_safe_call("fn_name", ...)` のラベル文字列重複ミスを排除

## proc_macro 化のコスト

| 項目 | 内容 |
|---|---|
| **workspace 変換** | Rust の proc_macro は別 crate 必須。root `Cargo.toml` を `[workspace]` 化し、`proc-macros/` member 追加。`crate-type = ["proc-macro"]` 指定 |
| **napi-rs build pipeline** | `scripts/build-rs.mjs` の root 解決パス調整、`napi build` の対象 crate 明示 (`-p desktop-touch-engine`) |
| **CI 影響** | `.github/workflows/release.yml` の `cargo` 起動コマンドに `--workspace` または crate 指定追加。`Swatinem/rust-cache@v2` の cache key も変化 |
| **`rust-analyzer` / IDE** | workspace 認識のため VS Code 設定確認 (通常自動だが、users may need rust-analyzer reload) |
| **`target/`** | workspace 共通 `target/` への変化、ビルド成果物パス再確認 |
| **`build:rs` snapshot** | PR #75 で導入した `index.d.ts`/`index.js` snapshot ロジックは crate-relative、workspace 化で root 相対との一貫性確認 |

実工数見積: **2 sub-batch (約 1 PR)**、ただし `napi build` pipeline の workspace 対応で hidden snag 発生のリスク中。

## 代替案 — 既に 50% は獲得済

`scripts/check-napi-safe.mjs` (ADR-007 P5a で SCAN_DIR を `src/` 全体に拡大済) が既に:

- 新規 sync `#[napi]` export を追加した瞬間に CI fail
- AsyncTask return は除外、誤検出ゼロ
- 関数名は `fn xxx` から正規表現で自動抽出、人為ミスの大半を遮断

つまり「**取りこぼし漏れ防止**」というメリットの主要価値は既に達成済み。proc_macro 化が追加で得られるのは:

- ボイラープレート行数 (70 行 → 0 行)
- ラベル文字列の重複ミス検出 (現状ゼロ件)

の 2 点のみ。

## 推奨: 保留 (defer)

**理由:**

1. coverage は既に 100%、機能リスクゼロ
2. ボイラープレート 70 行は feature 数が頭打ちなら sub-linear、年内に 200+ 化する見込みなし
3. workspace 変換は ADR-008 / ADR-006 (WinML) のような将来の large-scope work で必要が出れば、そのタイミングで一括化が経済的
4. proc_macro crate を切ると「engine 本体 + proc-macro crate + (将来) WinML crate」の 3-crate workspace に成長する可能性が高い → 段階的に切るより一気にやる方が cleanup コスト小

## 復活条件

以下のいずれかを満たしたら再評価:

- [ ] sync `#[napi]` export が 150 件を超えた (boilerplate 増加が顕在化)
- [ ] ADR-006 (WinML) または ADR-008 が独立 crate を要求し、workspace 化が別理由で発生
- [ ] `napi_safe_call` の signature が変わり、70 箇所の機械置換が必要になった
- [ ] 静的ガード (`check-napi-safe.mjs`) で false negative が観測された

## 関連

- 親 ADR: `docs/adr-007-koffi-to-rust-migration.md` §3.4 / §10
- P5a 完了レポート: `memory/project_adr007_p5a_done.md`
- フォロー TODO: `memory/todo_adr007_p1_followups.md`
- 静的ガード実装: `scripts/check-napi-safe.mjs`
- macro 展開対象: `src/win32/safety.rs::napi_safe_call`
