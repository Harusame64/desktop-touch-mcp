# v1.0.0 Release Readiness Review — 計画書

- 作成: 2026-04-26 (PR #41 merge 後)
- 目的: v1.0.0 release 前に **特に v2 World-Graph (Anti-Fukuwarai v2) 系を重点として** コードベース全体の健全性を確認し、release blocker と Phase 5 dogfood 重点項目を同定する
- 範囲: TS (`src/`) + Rust (`tools/win-ocr/`, native engine) 両側
- 想定 deliverable: `docs/v1-release-readiness-review.md` (発見一覧 + 緊急度分類 + dogfood checklist) + 個別修正 PR (P0/P1 のみ即時)

---

## 1. ユーザー強調事項 — V2 重点

「V2 で追加したところが心配」を計画に反映。Phase 1+2 (リネーム + family merge) や Phase 3 (browser 再配置) と異なり、v2 World-Graph は **新規コア追加** が多く、未踏のリスクポイントが多い:

- **DesktopFacade / SessionRegistry** — lease 発行・session 隔離・eviction TTL
- **GuardedTouchLoop** — pre/post action guard、SemanticDiff 計算
- **CandidateProvider compose** — UIA / CDP / terminal / visual GPU の lane 統合と warning 伝播
- **Perception 3 軸** — registry (lens 管理) / sensors (Win32/CDP/UIA) / hot-target-cache (attention)
- **Vision GPU** — Rust native engine、Florence2/PaddleOCR、Vulkan/CUDA lane
- **Native bindings** — napi-rs FFI、build.rs (node.lib)、koffi 残留

V2 は Phase 4b dogfood で main merge 済 (PR #34、`072b1db`) ですが、Phase 4 で desktop_discover/desktop_act の **公開面が大きく変わった** (windows[] 追加 / setValue 追加 / kill-switch fallback) ので、再点検が要る。

---

## 2. Scope (V2 重点 9 カテゴリ)

優先度マーク: ★★★ = V2 直撃 / ★★ = V2 周辺 / ★ = 全般

| # | カテゴリ | 優先 | 主要対象 | 担当 |
|---|---|---|---|---|
| **A** | Phase 1-4 Surface | ★ | 28 public tools 整合、stub catalog、handler 残置、migration breadcrumb、kill-switch fallback の動作 | Opus 直 |
| **B1** | **V2 facade core** | **★★★** | `src/tools/desktop.ts` (DesktopFacade) / `desktop-register.ts` / `desktop-executor.ts` / `desktop-constraints.ts` / `desktop-providers/*` / `desktop-activation.ts` | Explore agent |
| **B2** | **V2 world-graph engine** | **★★★** | `src/engine/world-graph/*` (lease-store / session-registry / guarded-touch / resolver / candidate-ingress / snapshot-ingress / lease-ttl-policy / types) | Explore agent |
| **B3** | **Perception 3 軸** | **★★★** | `src/engine/perception/*` (registry / hot-target-cache / sensors-*.ts / fluent-store / guards / resource-model / target-timeline / dirty-journal / flush-scheduler / reconciliation) | Explore agent |
| **C** | **Rust native + Vision GPU** | **★★★** | `tools/win-ocr/` (PaddleOCR / Florence2 / OmniParser preprocess) / `native-rs-engine` (image-diff SSE2 + UIA + perception sensors) / `src/engine/vision-gpu/*` (backend / dirty-signal / types) | Explore agent |
| **D** | **TS ↔ Rust 境界** | **★★★** | napi-rs binding / `*.node` loading / FFI shape / error propagation / `build.rs` (node.lib) / koffi 残留 | Opus 直 (判断系) |
| **E** | Security & Safety | ★★ | failsafe / failsafe-wrap (PR #40) / kill-switch (PR #41 round 6) / guards / SUGGESTS strings / secret handling / CodeQL alerts 残 | general-purpose agent + `/security-review` |
| **F** | Performance | ★ | token cost / cache hit / memoization / lease TTL / hot-target-cache LRU / Vulkan lane warmup race | Explore agent |
| **G** | Test infrastructure | ★ | unit (1962) / e2e / integration project 配置、`registry-lru` flake / `context-consistency` C3 / `rich-narration` B1 / Phase 4 contract test 123 | Explore agent |
| **H** | Build & CI | ★ | npm scripts / GitHub Actions (build / docker-build / CodeQL) / dependency drift / TypeScript version / Rust toolchain / release.yml | Opus 直 |
| **I** | Documentation | ★ | README × 2 / system-overview / plan docs / CHANGELOG / known-issues / Phase 4 design 完了マーク | Sonnet (or Opus 直) |

---

## 3. V2 重点観点 (B1 / B2 / B3 / C / D の深掘り)

### 3.1. B1 — V2 facade core 観点

- **DesktopFacade.see()** が複数 lane (UIA / CDP / terminal / visual GPU) を compose する流れ — warning 伝播が完全か、lane failure 時の fallback が graceful か
- **DesktopFacade.touch()** の lease validation 順序 — 古い lease を生成違いの session に渡したときの挙動
- **session eviction TTL (120s)** — 長時間 idle で session GC されたら lease は entity_not_found に転ぶか、それとも session 蘇生?
- **Phase 4 round 5 で追加した `windows[]` 経路** — windowsProvider が throw した時のフォールバック、production 用 Win32 enumeration のパフォーマンス
- **desktop-executor.ts の UIA / CDP / terminal route 切替** — `setValue` 追加 (Phase 4 round 3) の fallback パスが意図通り
- **desktop-providers/ocr-provider.ts** の visual lane fire-and-forget — 失敗時の silent drop が他 lane を巻き込まないか
- **desktop-constraints.ts** の constraint derivation — warnings → constraints の mapping ロジック網羅性

### 3.2. B2 — World-graph engine 観点

- **LeaseStore** — issue / consume / 同 entity 多重 lease の挙動
- **SessionRegistry** — viewId 重複 / generation rollover (`session.seq` overflow リスク)
- **GuardedTouchLoop** — pre-touch guard が fail した時の post.perception 取得経路、retry policy の有無
- **resolver.ts (resolveCandidates)** — UiEntityCandidate → UiEntity 変換、generation 印字、dedupe 戦略
- **candidate-ingress / snapshot-ingress** — event-driven cache の onDirty propagation、メモリ上限
- **lease-ttl-policy.ts** — entityCount に応じた TTL bonus の上限 (overflow / underflow)
- **types.ts** — public type の breaking change リスク (EntityLease / UiEntity / ExecutorKind)

### 3.3. B3 — Perception 3 軸観点

- **registry.ts (\_registerWindowLens)** — Phase 3 §3.3 で発覚した `vi.mock` leak は registry 起因か別か (test isolation flake の根本原因)
- **hot-target-cache** — Phase 1 §1.4 の B1 修正 (HotTargetCache 経由 attention 取得) のエッジケース。multi-monitor / virtual desktop 切替時の slot ジレンマ
- **sensor loops (sensors-uia / sensors-native-win32 / sensors-cdp)** — long-lived subscription、`__resetSensorForTests()` の正確性、リーク
- **fluent-store** — fluent 上書きの race condition、TTL based eviction
- **guards.ts** — Phase 4 で `perception_read` → `desktop_state` に書換た suggestedAction の実機妥当性
- **resource-model** — `summary.suggestedNext` の決定木カバレッジ
- **target-timeline** — `listRecentTargetKeys` のメモリ使用量
- **dirty-journal / flush-scheduler / reconciliation** — sensor → fluent 反映の遅延 / 順序依存

### 3.4. C — Rust native + Vision GPU 観点

- **`tools/win-ocr/`** PaddleOCR / Florence2 / OmniParser preprocess — `unsafe` ブロック / `unwrap()` / `panic!` 数、エラーパス、メモリ確保失敗時の挙動
- **`native-rs-engine`** image-diff SSE2 SIMD — bounds check の正当性、SIMD intrinsic の non-x86_64 fallback
- **`native-rs-engine`** UIA bindings — koffi 削除済み (napi-rs に統合)? それとも残留? (Phase 1 §1.5 引継ぎで言及あり)
- **`native-rs-engine`** perception sensors (Rust 側) — TS 側 sensor 群との重複・整合性
- **`src/engine/vision-gpu/backend.ts`** ↔ Rust 接続 — Vulkan / CUDA / DirectML の lane warmup race、`PocVisualBackend` のフェイルセーフ動作 (Tier ∞)
- **`build.rs`** — node.lib 取得 (windows-latest CI で `node-gyp install` 必要、memory `feedback_ci_node_lib.md` 引継ぎ)
- **Rust テスト** — `cargo check` / `cargo test` / `cargo clippy` の状況、CI 統合

### 3.5. D — TS↔Rust 境界観点

- **napi-rs wrapper (root index.js が ESM)** — `createRequire` で `.node` load する pattern (memory `feedback_esm_napi_loader.md`) — 全モジュール正しく書かれているか
- **`*.node` ファイルの cross-platform** — Windows 限定 binary が non-Windows で要らない経路に load されていないか
- **error propagation** — Rust panic / Err が TS 側でどう surface するか、未補足 panic で TS が落ちる経路
- **type alignment** — Rust `napi::Result<T>` ↔ TS `T | { error: string }` 等の境界
- **memory ownership** — Rust が返した string buffer の lifetime、TS gc との衝突
- **Rust thread safety** — TS は single-thread、Rust 側で thread 起こしてる場合の syncronization

---

## 4. Method (3 phase + 並列圧縮)

```
Phase 1 (now): 計画書 approve 待ち (この doc)

Phase 2: 並列 audit (~30-60 分、20x プランの並列性活用)

   Agent 1 (Explore, foreground)   B1 V2 facade core
   Agent 2 (Explore, background)   B2 World-graph engine
   Agent 3 (Explore, background)   B3 Perception 3 axes
   Agent 4 (Explore, background)   C  Rust native + Vision GPU
   Agent 5 (Explore, background)   F  Performance (cache / TTL / warmup)
   Agent 6 (Explore, background)   G  Test infrastructure (flaky 解析)
   Agent 7 (general-purpose, Opus)
                                  E  Security audit (CodeQL alerts 残 + secret)

   Opus 直 (foreground)            A  Surface 整合 (kill-switch fallback 動作)
                                  D  TS↔Rust 境界
                                  H  Build & CI

   Sonnet 委譲 (foreground)        I  Documentation 整合

Phase 3: 発見集約 + 緊急度分類

   P0  release blocker (data corruption / security / panic / capability ロス)
       → 即修正、v1.0.0 reflease 必須前提
   P1  functional regression / 設計逸脱
       → 修正必須、release 前
   P2  UX / migration friction / minor flake
       → 修正推奨、v1.0.0 OR v1.0.x
   P3  polish / cosmetic / nit
       → Phase 5 以降に持越し

Phase 4: ユーザー approve → P0/P1 を 1-2 commits で fix → docs に発見記録 → release prep
```

### 4.1. 並列 Agent prompt template

各 Agent 投下時の共通フォーマット (簡素化):

```
You are auditing the {category} of desktop-touch-mcp PR #41 merged code base.

Goal: identify any issue that could regress capability, leak resources, panic
under realistic load, or expose secrets / wrong tool names to the LLM.

Files in scope: {file_list}
Specific concerns to check: {concern_list}

Report (under 600 words per agent):
  P0  release blocker (data corruption / security / panic / capability loss)
  P1  functional regression / design deviation  
  P2  UX / migration / minor flake
  P3  polish

For each finding: file:line + 1-line summary + suggested fix direction.
```

### 4.2. 想定タイムライン

- **Phase 1** (計画 approve): 5-10 分 (今この doc + 確認)
- **Phase 2** (並列 audit): 30-60 分 (Agent 並列、5-7 個同時)
- **Phase 3** (集約 + 分類): 15-30 分 (Opus 直)
- **Phase 4** (P0/P1 修正): 発見次第。理想 0-2 件、悲観 5-10 件

合計 1-2 セッション。20x プランなら容量的に余裕、Phase 5 dogfood 着手前にクロージャ可能。

---

## 5. Forbidden / out of scope

- **動作変更を伴う refactor** — audit のみ。設計変更が必要なら別 PR
- **新機能追加** — v1.0.0 cut の範囲を超える
- **競合製品比較** — `docs/competitor-research.md` 範疇、別作業
- **MCP Registry / Glama 更新** — release prep の後段

---

## 6. Risks & rollback

| Risk | 確率 | 影響 | 対策 |
|---|---|---|---|
| **設計 flaw 発覚 (P0)** で release が大幅遅延 | 低 | 高 | P0 はその場で fix。判断難しいなら Phase 5 dogfood に持越して v1.0.0 → v1.0.1 patch 方式 |
| **Rust 側で unsafe leak** 発見 | 中 | 中-高 | unsafe ブロック数列挙 + ハンドオフ可能な領域は別 PR で hardening |
| 並列 Agent の発見が重複 | 中 | 低 | Opus 集約段階で deduplicate |
| 発見が多すぎて release 出せない | 低 | 中 | P0 のみ blocker、P1/P2 を v1.0.x patch にスケジュール (CLAUDE.md feedback_no_compromise_closure と矛盾するが、release 全停止 vs 段階リリースのトレードオフを user 判断に委ねる) |
| audit 中に context 飽和 | 低 | 低 | 各 Agent に word limit (600 words) を課している |

---

## 7. 計画 approve 後のアクション

1. このファイルを `docs/v1-release-readiness-review-plan.md` として commit (audit 着手前のスナップショット)
2. 並列 Agent 投下 (B1/B2/B3/C/F/G/E)、Opus 直で A/D/H を実行、Sonnet で I
3. 各 Agent の return を収集 → `docs/v1-release-readiness-review.md` に集約
4. P0/P1/P2/P3 分類してチャットに要約報告
5. ユーザー approve → P0/P1 修正 PR or 別途方針合意
6. release prep へ
