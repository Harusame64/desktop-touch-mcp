# build-rs followups

`scripts/build-rs.mjs` および `build.rs` 周辺の永続的 follow-up（CLAUDE.md §9 準拠：残件は memory ではなく docs に書く）。

## 起源

- PR #125（chore/build-rs-node-lib-preflight）— Windows MSVC host で `node.lib` 不在時に node-gyp cache から自動 populate する preflight を `scripts/build-rs.mjs` に追加。
- Opus Round 1 review で識別された P2 / P3 のうち、本 PR scope 外に倒した項目を本 doc に永続化。

## Follow-up items

### F1. `build.rs` に `cargo:rerun-if-changed=node.lib` を追加（P2、別 PR）

**Why:** 現状 `build.rs` は `node.lib` 自体を tracking していない。preflight が初回 build で `node.lib` を配置 → cargo は問題なく link するが、ユーザが手で `node.lib` を削除して再生成するシナリオで cargo が incremental cache のまま再 link をスキップする可能性。

**How to apply:** `build.rs:13-26` の Windows ブランチに `println!("cargo:rerun-if-changed={manifest_dir}/node.lib");` を追加（msvc / gnu 両方）。最小 1 行 PR。

**Trigger:** ユーザから「`node.lib` を入れ替えても build が更新されない」型 issue が出たら優先度上げ。それまでは defer 可。

### F2. CI workflow の `Fetch node.lib for MSVC linking` step 削除（P3、別 PR）

**Why:** `.github/workflows/ci.yml:65-79` と `.github/workflows/release.yml` の `Fetch node.lib` step は PR #125 の preflight 導入後 **冗長**（`npm run build:rs` 内部で同等処理が走る）。重複は将来的に node-gyp install の引数（`--target` / `--yes`）が片側だけ更新される drift リスクの温床。

**How to apply:** 両 workflow から `Fetch node.lib for MSVC linking` step を削除し、`npm run build:rs` (or `build:rs:debug`) 単独で完結することをローカル + CI dry-run で確認。

**注意:** preflight は MSVC のみ対応。CI が gnu host で走る将来 plan があるなら本 follow-up は保留。現状 CI/release は windows-latest msvc 一択なので削除して安全。

### F3. `@napi-rs/cli` silent skip の upstream root cause 調査（P2、別 PR / issue）

**Why:** PR #125 は症状治療（preflight で `node.lib` を repo root に置く）であり、`@napi-rs/cli` v3.6.2 が clean clone で `node.lib` の download を silent に no-op する根本原因は未解明。

**How to apply:**
1. `@napi-rs/cli` v3.6.2 → 最新 (3.7+ 等) で再現するか確認
2. CLI source を読み、Windows host での node.lib fetch path を辿る（`packages/cli/src/api/build.ts` 周辺、推定）
3. 必要なら `napi-rs/napi-rs` リポに reproducer 付き issue を立てる
4. upstream で fix されたら本 PR の preflight を縮小 / 撤去（preflight comment block の `@napi-rs/cli download path can silently no-op` 記述を更新）

**Trigger:** napi-rs/cli の major update を入れるタイミング、または「Windows clean clone で build:rs が落ちる」型 issue が他リポでも報告された段階。

## 関連リンク

- PR #125: https://github.com/Harusame64/desktop-touch-mcp/pull/125
- `scripts/build-rs.mjs` preflight 実装
- `build.rs:13-26` MSVC / GNU 分岐
- `.github/workflows/ci.yml:65-79` 既存 CI fetch step
- `docs/ocr-quality-improvement-plan.md:40-44` 旧手動手順（PR #125 で更新済）
- `docs/v1-release-readiness-review.md:85` build.rs 観点（PR #125 で更新済）
