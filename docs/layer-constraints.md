# Layer Constraints Matrix — 各層の制約条件詳細

- Status: **Draft (起草中)**
- Date: 2026-04-29
- Authors: Claude (Opus, max effort)
- Scope: `docs/architecture-3layer-integrated.md` §17 の詳細版
- 役割: 各層 (L1-L5) が満たさねばならない契約・不変条件・性能 SLO・失敗モード・境界を明文化
- 目的: 各 ADR の詳細実装を「制約を満たす設計選択」として機械的に進められるようにする

---

## 1. 制約条件の読み方

各層について、6 観点で制約を整理する。

| 観点 | 意味 |
|---|---|
| **入力契約** | 何を、どの形式・順序・レートで受け取るか |
| **出力契約** | 何を、どの形式・SLO で出すか |
| **不変条件** | 必ず保たねばならない invariant (これが破れたら設計が壊れる) |
| **性能制約** | latency / memory / throughput の SLO (acceptance criteria の根拠) |
| **失敗モード** | 典型的な failure と recovery 戦略 |
| **境界** | 越権してはいけないこと (層の責務) |

各層の依存関係 (どの crate / OS API / hw に依存するか) は別途明記。

---

## 2. L1: Capture (センサー層)

### 2.1 入力契約

| 入力 | 形式 | 順序 | レート (期待) |
|---|---|---|---|
| DXGI dirty/move rect | `IDXGIOutputDuplication::GetFrameDirtyRects` | 表示更新順 | 60Hz (DWM 周期) |
| UIA event | `IUIAutomation` callback | provider 提供順 (out-of-order あり) | event 発生時 |
| hw input event | windows-rs `SendInput` 系 | call 順 | 操作時のみ |
| tool call (commit 軸) | L5 → L1 内部 channel | submission 順 | < 100/s |
| 副作用結果 | OS API 戻り値 | 同期的 | call 同期 |

### 2.2 出力契約

`EventEnvelope` Rust struct (`#[napi(object)]` で TS にも露出):

```rust
#[napi(object)]
pub struct EventEnvelope {
    pub event_id: BigInt,             // u64 monotonic
    pub wallclock_ms: BigInt,         // canonical
    pub sub_ordinal: u32,             // 同 ms tie-break
    pub timestamp_source: TimestampSource,  // Reflex/DXGI/DWM/StdTime
    pub kind: EventKind,              // DirtyRect | UiaFocus | UiaInvoke | ToolCall | ...
    pub payload: Vec<u8>,             // kind 別 schema、bincode encoded
    pub session_id: Option<String>,
    pub tool_call_id: Option<String>,
}
```

- 出力先: ring buffer (in-memory MPSC) + WAL (record モード時)
- WAL durability: `fsync` after each batch (interval 設定可、default 10ms)

### 2.3 不変条件

| # | invariant | 違反時の影響 |
|---|---|---|
| 1 | `event_id` は monotonic increasing | replay が壊れる、§5 の logical_time 一意性破綻 |
| 2 | 同じ wallclock_ms 内では `sub_ordinal` が unique | partial-order tie-break 失敗 |
| 3 | `timestamp_source` は event 単位で固定 (混在しない) | freshness_ms 計算不能 |
| 4 | 同じ event を 2 回 emit しない | L2 materialize で duplicate row |
| 5 | WAL に書き終わるまで L2 に push しない | crash 時の event ロスト |
| 6 | hw failure (DXGI/UIA など) は EventKind として emit、panic しない | プロセス全滅 |

### 2.4 性能制約 (SLO)

| KPI | 目標 |
|---|---|
| event ingest throughput | 10k events/sec |
| event ingest latency p99 | < 1ms |
| dirty rect detect cycle | DXGI 60Hz と同期 (16.67ms 周期) |
| ring buffer capacity | default 256MB、env で調整可 |
| WAL write latency p99 | < 5ms (10ms batch interval 内に収まる) |
| ring buffer overflow rate | < 0.001% (1k 中 1 以下) |

### 2.5 失敗モード

| failure | 検出 | recovery |
|---|---|---|
| DXGI Desktop Duplication 失敗 | `AcquireNextFrame` Err | Tier 1 から Tier 0 (std GDI) にフォールバック、warning event emit |
| UIA timeout (provider 無応答) | timeout 8s | fallback PowerShell (現行互換)、warning event |
| WAL write fail (disk full) | `io::Error` | 緊急 GC、それでもダメなら fatal で worker 再起動 |
| ring buffer overflow | producer が consumer を越えそう | oldest drop + warning event (priority 低 event を優先 drop) |
| Reflex API 利用不可 (NVIDIA driver 古い) | capability detect 時 | DXGI Present statistics に格下げ、env warning |
| timestamp source 全部利用不可 | capability detect 時 | std::time、env error |

### 2.6 境界 (やってはいけないこと)

- **計算しない** — diff / aggregate / semantic 推論は L3 の責務
- **state を保持しない** — arrangement は L2、L1 は ring buffer (一時) と WAL (durability) のみ
- **L2 以上の構造を知らない** — timely / arrangement / view の概念に依存しない (event を出すだけ)
- **副作用は OS API 直叩きのみ** — 第三者プロセスへの reach、network、外部 SDK 呼び出しは禁止

### 2.7 依存

- `windows-rs` 0.62+ (UIA, DXGI, DWM, Reflex)
- `koffi` を **撤去** (ADR-007)、win32 binding は windows-rs 経由
- Tier 2 任意: Intel DSA SDK, NVENC/Quick Sync/AMF、Intel PT (perf or自前)
- Rust 2024 edition、stable 1.85+

---

## 3. L2: Storage (MVCC arrangement)

### 3.1 入力契約

- L1 EventEnvelope stream (ring buffer から timely input)
- frontier 進行 hint (Reflex/DXGI tick で自動進行可)

### 3.2 出力契約

- `arrangement::Arrangement<G, K, V, T, R>` を view consumer (L3) に提供
- frontier 通知 capability
- `state_at(t: wallclock_ms)` query API (point query、batch slice 走査)

### 3.3 不変条件

| # | invariant | 違反時の影響 |
|---|---|---|
| 1 | logical_time は monotonic な partial-order | timely の semantic 破綻 |
| 2 | 同じ event_id を 2 回 materialize しない | view duplicate |
| 3 | `state_at(t)` は compaction frontier 内の t に対し正しい state を返す | time-travel 結果不正 |
| 4 | arrangement に書き戻すのは L1 input のみ (L3 から書き戻し禁止) | dataflow の単方向性破綻 |
| 5 | compaction frontier が advance したら過去 t は引けなくなる (明示) | LLM が古い t を試した時の error が typed であること |

### 3.4 性能制約

| KPI | 目標 |
|---|---|
| materialize latency p99 | < 100μs/event |
| `state_at(t)` p99 | < 5ms |
| arrangement memory budget | default 512MB、超過時 compaction 加速 |
| compaction frequency | adaptive (memory pressure 連動) |
| compaction frontier lag | < 5s (default、env で調整) |

### 3.5 失敗モード

| failure | 検出 | recovery |
|---|---|---|
| memory budget OOM | arrangement size monitor | 古い epoch を強制 compact、frontier を進める、warning event |
| logical_time 衝突 | sub_ordinal でも tie 破れない | error event emit、event 1 つを drop (max iter で防げる) |
| `state_at(t)` で t が compaction 済 | 範囲外 | typed error: `most_likely_cause: "time_compacted"`、L4 で envelope 化 |

### 3.6 境界

- **view 計算しない** — operator graph は L3
- **副作用しない** — read-only sink for L1 input
- **schema 進化を独立に決めない** — `_version` matrix (§11) に従う

### 3.7 依存

- `timely-dataflow` 0.13+
- `differential-dataflow` 0.13+
- L1 EventEnvelope schema (`_version` 共通)

### 3.8 Worker Lifecycle (ADR-007 §3.4 と整合)

L2 (timely + DD) と L1 capture worker は **dedicated thread**。Node.js libuv main thread とは napi-rs `AsyncTask` で接続。

| 段階 | 規約 |
|---|---|
| 起動 | 初回 `#[napi]` 呼び出し時 lazy init (`OnceLock<Sender<Task>>`) |
| 通信 | `AsyncTask` + `crossbeam-channel` (UIA bridge と同パターン) |
| panic 時 | `catch_unwind` で捕捉、worker 再起動、`recent_failures_log` 記録 |
| graceful shutdown | shutdown channel + 1s join timeout、超過は force terminate + warning |
| shutdown ordering | L5 → L4 → L3 → L2 → L1 の **逆順** |

詳細は ADR-007 §3.4 を SSOT として参照。

---

## 4. L3: Compute (IVM)

### 4.1 入力契約

- L2 arrangement collection (read-only)
- timely capability (subscribe 起点)
- DataflowAccelerator trait 実装 (Tier 0-3、§9)

### 4.2 出力契約

主要 view (D2 で実装、ADR-008):

| view 名 | output type | consumer |
|---|---|---|
| `current_focused_element` | `Collection<UiElementRef, Diff>` | L4 envelope.data |
| `dirty_rects_aggregate` | `Collection<Rect, Diff>` | L4 envelope.invariants_held / data |
| `semantic_event_stream` | `Collection<SemanticEvent, Diff>` | L4 envelope.caused_by |
| `predicted_post_state` | `Collection<StateDelta, Diff>` (dry-run subgraph) | L4 envelope.if_you_did |

加えて lens-dependent な cyclic view (D4):

| view 名 | type | 備考 |
|---|---|---|
| `lens_attention` | `Collection<Lens, Diff>` | iterative scope、fixed-point |

### 4.3 不変条件

| # | invariant | 違反時の影響 |
|---|---|---|
| 1 | view は incremental 更新のみ (full recompute 禁止) | latency SLO 破綻 |
| 2 | cyclic view は fixed-point で必ず settle | 無限ループ |
| 3 | dry-run subgraph は本番 arrangement を変更しない | side-effect leak |
| 4 | Tier 失敗時は cascade で必ず Tier 0 まで落ちる (op 単位) | 動かない環境発生 |
| 5 | view から L1/L2 に書き戻さない | dataflow 単方向性 |

### 4.4 性能制約

| KPI | 目標 |
|---|---|
| view 更新 latency p99 | < 1ms |
| dry-run preview latency p99 | < 50ms |
| GPU op throughput (Tier 3 動作時) | change_fraction で 13.4x 以上 (現行 PoC ベース) |
| cyclic max iter | 100 (default、超過時 abort + warning) |

### 4.5 失敗モード

| failure | 検出 | recovery |
|---|---|---|
| Tier 3 failure (CUDA Graph 不在) | capability detect or runtime err | Tier 2 cascade、`server_status` に集約 |
| cyclic 無限ループ | max iter 超過 | abort、warning event、view を最後の安定値で fallback |
| dry-run 計算失敗 | timely panic catch | `if_you_did = null`、本体 envelope は normal 返却 |
| view operator panic | `catch_unwind` | view を offline、L4 で confidence=stale |

### 4.6 境界

- **L2 に書き戻さない** (read-only consumer)
- **副作用しない** (UIA Invoke / hw input は L1 commit 経由)
- **time advance を勝手に進めない** (L2 frontier に従う)

### 4.7 依存

- L2 arrangement
- `DataflowAccelerator` trait (§9)
- Tier 3: CUDA / HIP / Level Zero SDK (任意)

---

## 5. L4: Cognitive Projection + Envelope Assembly

### 5.1 入力契約

| 入力 | 出典 |
|---|---|
| L3 view 値 | `current_focused_element` 等 |
| tool_call_id | L5 wrapper |
| session_id | MCP request 起源 |
| 直近 commit 履歴 | L4 内 episodic store (working memory) |

### 5.2 出力契約

完成した Envelope (ADR-010 §5、本書 §11)。

### 5.3 不変条件

| # | invariant | 違反時の影響 |
|---|---|---|
| 1 | `data` フィールドは L3 view の値のみ (L4 で計算しない) | data の出自が曖昧化 |
| 2 | `caused_by` は session 内 1 つ前の commit との因果のみ | causal trail 嘘 |
| 3 | `failed_at_layer` は失敗発生層を正しく示す | trouble shoot 不能 |
| 4 | `as_of.wallclock_ms` は L1 入力時の値を継承 | freshness 嘘 |
| 5 | `query_past` link は実 API 形式と一致 | LLM が呼んでも届かない |

### 5.4 性能制約

| KPI | 目標 |
|---|---|
| envelope assembly p99 | < 5ms (include 最大時) |
| working memory N 上限 | default 50 (調整可) |
| episodic memory N 上限 | default 100 (調整可) |

### 5.5 失敗モード

| failure | 検出 | recovery |
|---|---|---|
| L3 view 不在 (起動直後) | view subscribe Err | `confidence = stale`、`data = null` |
| session_id 不在 | MCP request に無し | `caused_by = null`、ログ警告 |
| episodic store 容量超過 | N 超 | LRU で oldest drop |
| typed reason mapping 漏れ | enum match で fallthrough | `most_likely_cause = "unknown"`、log で coverage 改善 |

### 5.6 境界

- **副作用しない**
- **L1-L3 に新しい event を生成しない** (L1 commit を経由しないと event は産まれない)
- **計算しない** — view 値の整形・enrichment のみ
- **session 跨ぎの記憶を持たない** (cross-session のことは ADR-011 で扱う)

### 5.7 依存

- L3 view
- session_id / tool_call_id 管理 (L5 から受領)
- typed reason enum (`_errors.ts` を SSOT として吸収)

---

## 6. L5: MCP Tool Surface

### 6.1 入力契約

- MCP request: `{ tool: string, args: object, include?: string[] }`
- MCP transport: stdio / HTTP / WebSocket (subscribe 用)

### 6.2 出力契約

- 完成した envelope を MCP response として返却
- subscribe 軸は capability に follow した notification stream

### 6.3 不変条件

| # | invariant | 違反時の影響 |
|---|---|---|
| 1 | 全 tool 応答が `_version` stamped envelope | client compat 崩壊 |
| 2 | query 軸 tool は副作用ゼロ (event_id を新規発行しない) | dry-run / replay の semantic 破綻 |
| 3 | commit 軸 tool は L1 commit を経由 (直接 OS API を叩かない) | event log 不完全 |
| 4 | subscribe 軸 tool は capability 経由のみ | push 配信の整合性 |
| 5 | `include` 引数は string array のみ受付 (struct 化しない) | schema 過剰複雑化 |
| 6 | **既存 tool 名 / 関数シグネチャ / positional args は不変、新規 tool 追加なし、リネームなし** (統合書 P7 / §7.4) | tool surface の互換性破綻、LLM 学習無効化 |

### 6.4 性能制約

| KPI | 目標 |
|---|---|
| query tool round-trip p99 | < 50ms |
| commit tool round-trip p99 | < 200ms (UIA hw 込み) |
| subscribe push 遅延 p99 | < 10ms (capability 通知から MCP notification まで) |

### 6.5 失敗モード

| failure | 検出 | recovery |
|---|---|---|
| L4 失敗 | partial envelope 受領 | failure テンプレで応答 (data=null + if_unexpected) |
| timeout (hw 無応答) | timeout 設定値超過 | `most_likely_cause: "timeout"` |
| MCP transport 切断 | connection 断 | subscribe を破棄、再接続待ち |
| tool not found | tool registry 検索失敗 | typed error envelope (`tool_unknown`) |

### 6.6 境界

- **計算しない** (L4 envelope を受けて MCP に流すだけ)
- **新しい event を生成しない** (commit は L1 経由必須)
- **session 状態を保持しない** (session 状態は L4 working/episodic memory)
- **tool 名のリネーム / 新規 tool 追加 / positional args 変更を禁止** (統合書 P7 / §7.4、tool surface 不変原則)
- **`include` / `dry_run` / `as_of` 等の横断的 optional 引数は L5 wrapper が一元解釈** し、tool 個別実装に渡さない

### 6.7 依存

- L4 envelope
- MCP SDK (現行 stdio + 既存 HTTP transport)
- typed reason enum (L4 と共用)

---

## 7. Cross-layer 制約 (層またぎ)

各層単独では保証できないが、システム全体で守るべき制約。

### 7.1 Total ordering

- すべての event は **`(wallclock_ms, sub_ordinal)` の partial-order** に従う
- 同 wallclock 内の sub_ordinal は L1 で **採番、以降の層は変更不可**
- replay 時は WAL 順序が再生 → 全層で同じ順序になる

### 7.2 Memory budget

| 層 | budget | 超過時 |
|---|---|---|
| L1 ring buffer | 256MB (default) | oldest drop |
| L2 arrangement | 512MB (default) | compaction 加速 |
| L3 view materialization | 256MB (default) | view ごとに retention 制御 |
| L4 episodic store | 数 MB (N=100) | LRU drop |
| 合計 | 1-2GB 想定 | env で各 budget 調整可 |

env: `DESKTOP_TOUCH_MEMORY_*=N` で個別調整。

### 7.3 Error propagation chain

```
L1 hw failure
  └─ EventKind::Failure として emit (panic しない)
       └─ L2 materialize は警告 view に
            └─ L3 view は warning collection を持つ
                 └─ L4 envelope.invariants_held に "hw_warning_X" を追加
                      └─ L5 envelope の confidence を fresh→cached に降格
```

L1 から L5 へエラーが伝播する経路が **typed event として明示**。throw + 文字列で揺れない。

### 7.4 Schema version 整合 (§11 / 統合書 §11 と連動)

- L1 EventEnvelope の **`envelope_version: u32`** (top-level、numeric、ADR-007 §4) と L5 Tool Envelope の **`_version: "MAJOR.MINOR"`** (top-level、string、ADR-010 §5) は **独立に進化**
- ただし「L1 v2 を L5 v1 が消費する」ような mismatch は禁止
- 起動時に integration matrix でチェック、不一致なら fatal で worker 再起動
- 詳細は ADR-007 §4.4 と `docs/schema-compat-matrix.md` (起草予定、ADR-008 D6 着手前) で管理

### 7.5 Replay determinism chain

- L1 で record 時の wallclock を WAL に格納
- L2 logical_time は WAL から再注入で同じ
- L3 view は decoder が deterministic (timely の保証)
- L4 envelope は §5.3 の record 時 wallclock を使う
- → bit-for-bit 再現 (acceptance criteria D6)

### 7.6 Tier dispatch consistency

- 各 op の Tier は **op 単位で独立**、L1 と L3 は別の Tier を選んで OK
- ただし `server_status` で全 op の Tier 状態を集約 (§13)

### 7.7 継続監視 SLO (統合書 §17.6 と同期、Gemini review 指摘対応)

| 監視項目 | 統合書 §17.6 閾値 | 違反時の挙動 |
|---|---|---|
| `envelope_size_full_p99` | < 10KB | confidence `degraded`、warning event |
| `tier_fallback_overhead_p99` | < 500μs | tier 強制 pin 5min |
| `worker_lag_p99` | < 8.5ms | confidence `degraded` |
| `arrangement_size_total` | < 512MB | compaction 加速 |
| `panic_rate_per_min` | 0 in steady state | 自動 worker 再起動 |
| `wal_disk_usage_mb` | < 1024MB | rotation 加速 |

詳細・SSOT は統合書 §17.6 を参照。本書は cross-layer 制約として **違反時の挙動を確認する役割** に留める。

---

## 8. Acceptance Criteria の集約

各層の制約を満たしているかの検証基準。各 ADR の AC を本書に集約。

| 層 | 検証項目 | 出典 |
|---|---|---|
| L1 | event ingest 10k/s @ p99 < 1ms | 本書 §2.4 |
| L1 | DXGI dirty rect 60Hz 同期 | 本書 §2.4 |
| L1 | WAL durability (crash 後の event ロスト 0) | 本書 §2.3 |
| L2 | materialize p99 < 100μs | 本書 §3.4 |
| L2 | `state_at(t)` p99 < 5ms | 本書 §3.4 (ADR-008 D3) |
| L2 | arrangement memory < 512MB (default) | 本書 §3.4 |
| L3 | view 更新 p99 < 1ms | 本書 §4.4 (ADR-008 D1) |
| L3 | dry-run latency p99 < 50ms | 本書 §4.4 (ADR-008 D5) |
| L3 | cyclic 無限ループ自動検出 | 本書 §4.4 (ADR-008 D4) |
| L4 | envelope assembly p99 < 5ms | 本書 §5.4 |
| L4 | typed reason coverage > 95% | ADR-010 P2 |
| L4 | LLM context 1/3 削減 (代表シナリオ) | ADR-010 P6 |
| L5 | query round-trip p99 < 50ms | 本書 §6.4 |
| L5 | commit round-trip p99 < 200ms | 本書 §6.4 |
| L5 | subscribe push 遅延 p99 < 10ms | 本書 §6.4 |
| 全層 | replay bit-for-bit 一致率 100% | 本書 §7.5 (ADR-008 D6) |

ベンチハーネス (`bench/` crate) は上記すべてを単一 CI で測定する。

---

## 9. 制約の運用

### 9.1 制約変更時のフロー

1. 本書を更新 (constraint 行を編集)
2. 統合書 §17 の summary も同期
3. 該当 ADR の §性能 / §不変 / §境界 を後追い更新
4. acceptance criteria を bench で実測 → 達成可否確認

### 9.2 制約と実装の乖離検出

- bench/ で SLO 違反検出 → CI で fail
- server_status で実運用 SLO 監視 → metric を出力
- LLM session log で「不安行動」増減を観測 → ADR-010 §1.1 の指標で

### 9.3 制約の追加判断

新しい制約を追加するときの基準:
- **観測可能か** (bench / server_status で測れるか)
- **違反時に何が壊れるか明示できるか**
- **SLO 数値が根拠を持つか** (推測でなく現実装ベンチ起点)

---

## 10. Related Files

- 統合書: `docs/architecture-3layer-integrated.md` (§17 が本書のサマリ)
- ADR-007: L1 詳細 (起草中)
- ADR-008: L2-L3 詳細 (起草済)
- ADR-009: HW Acceleration Plane Tier 別実装 (後続)
- ADR-010: L4-L5 詳細 (起草済)
- ADR-011: Cognitive Memory Extension (Phase B、後続)

---

END OF Layer Constraints Matrix (Draft).
