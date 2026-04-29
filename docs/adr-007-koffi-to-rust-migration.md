# ADR-007: koffi → Rust 全面移行 + L1 Capture 統一

- Status: **Proposed (Draft for review)**
- Date: 2026-04-29 (初版骨子: 2026-04-28)
- Authors: Claude (Opus, max effort) — project `desktop-touch-mcp`
- Related:
  - 統合書 (SSOT): `docs/architecture-3layer-integrated.md`
  - 制約: `docs/layer-constraints.md` §2 (L1 Capture)
  - 後続: ADR-008 (本 ADR が L1 input source を提供)
  - 後続: ADR-009 (HW Acceleration Plane の Tier 別実装ガイド)
  - 後続: ADR-010 (本 ADR が EventEnvelope を提供、L5 envelope の起点)
- 北極星: 最高パフォーマンス + 最高技術の公開 + L1 が「全層 1 graph」の入力源として機能

---

## 1. Context

### 1.1 koffi の問題

現状 `src/engine/win32.ts` と `src/engine/perception/sensors-win32.ts` で koffi の FFI binding 定義 (`koffi.func/struct/alias/load`) が **12 箇所** (実測)、call site は `src/engine/win32.ts` 内に多数:

- 5 DLL: `user32` / `gdi32` / `shcore` / `kernel32` / `dwmapi`
- 既知の地雷:
  - `PROCESSENTRY32W.dwSize` ハードコード事故
  - `SCROLLINFO` sizeof 検証 (`win32.ts:81-82`)
  - `ULONG_PTR` alignment 問題
- **致命的: koffi の sizeof / alignment ミスは Node プロセス全滅 (sigsegv)**
- TypeScript 型は実 ABI と乖離する余地あり、コンパイル時に検出不能

### 1.2 既存 Rust 資産

`desktop-touch-engine` crate (napi-rs, edition 2024) は既に:

- pixel_diff (SSE2 SIMD で 13.4x)
- dhash (純 Rust)
- UIA bridge 13 関数 (windows-rs 0.62、PowerShell から脱却済)
- Visual GPU Phase 4b (ADR-005)

→ **新規 crate ではなく、既存 crate に win32 binding を拡張する形**で進める。

### 1.3 統合書で確定した L1 Capture の位置づけ

ADR-007 が担うのは **単なる koffi 撤去** ではなく、**L1 Capture 層の確立**。

- DXGI Desktop Duplication + dirty rect 統合 (統合書 §3)
- EventEnvelope 統一 schema (統合書 §6)
- wallclock_ms canonical + sub_ordinal 採番 (統合書 §5)
- Tier 0-3 hw assist (統合書 §9)
- WAL durability for replay (統合書 §10)
- 全層 1 graph の input source として timely input に流入 (統合書 §2 P3)

つまり **L1 を「event を生成する単一窓口」に集約する** のが本 ADR の本質。

---

## 2. Decision

### 2.1 主要決定 (12 項目)

| # | 項目 | 決定 |
|---|---|---|
| 1 | koffi 完全撤去 | `package.json` から削除、Linux stub は `_linux-stub.ts` で空実装維持 |
| 2 | binding 配置 | 既存 `desktop-touch-engine` crate に `src/win32/` モジュール追加 |
| 3 | TS API 互換 | TS 関数シグネチャ不変、内部で `nativeEngine.xxx()` に置換 |
| 4 | DXGI 統合 | `IDXGIOutputDuplication::GetFrameDirtyRects` / `GetFrameMoveRects` を Rust から直接 |
| 5 | EventEnvelope schema | `#[napi(object)]` で TS にも露出、本 ADR §4 で確定 |
| 6 | wallclock canonical | 統合書 §5 の優先順 (Reflex > DXGI Present > DWM > std::time) |
| 7 | sub_ordinal 採番 | L1 が monotonic 採番、以降 immutable (統合書 §17 X1) |
| 8 | Ring buffer + WAL | 256MB MPSC ring + fsync batch WAL (10ms interval) |
| 9 | Tier 0-3 dispatch | DataflowAccelerator trait の L1 担当 op を実装 (本 ADR §5) |
| 10 | Linux stub | 関数シグネチャ維持、内部 unimplemented! → JS Error |
| 11 | Phase 戦略 | 高頻度→低頻度の順、各 Phase 独立 PR で merge 可能 |
| 12 | 既存 PR への影響 | RPG / lease / server_status の API 互換維持、内部実装のみ差替 |

### 2.2 決め手 (本 ADR 固有)

- **型安全**: Rust `repr(C)` で sizeof 地雷消滅
- **catch_unwind**: panic を local に閉じ込める、Node プロセス生存
- **batch 化**: AttachThreadInput + 操作 + Detach を 1 native call に融合 (FFI hop 削減)
- **配布**: koffi prebuilt 同梱不要 → launcher zip サイズ縮小
- **既存 napi-rs パイプライン**: build.rs / GH Actions / load-dynamic を流用
- **Tool Surface 不変**: 本 ADR は **L1 内部実装の置換** に閉じる。TS 関数シグネチャ / tool 名 / 既存 positional args は変更なし、新規 tool 追加なし (統合書 P7 / §7.4)

---

## 3. Architecture (L1 内部構造)

### 3.1 component 構成

```
desktop-touch-engine (Rust crate)
├── src/lib.rs                    ← napi-rs エントリ + L1 公開 API
├── src/uia/                       ← 既存 (UIA bridge 13 関数)
├── src/pixel_diff.rs              ← 既存
├── src/dhash.rs                   ← 既存
├── src/vision_backend/            ← 既存 (Visual GPU Phase 4b)
├── src/win32/                     ← ★ 本 ADR で新設
│   ├── mod.rs                     ← module re-export
│   ├── window.rs                  ← Enum/GetWindowText/Rect/Foreground 等 (P1)
│   ├── gdi.rs                     ← PrintWindow/GDI/DPI (P2)
│   ├── monitor.rs                 ← Monitor/DPI 関連 (P2)
│   ├── process.rs                 ← Process/Thread/Toolhelp32 (P3)
│   ├── input.rs                   ← AttachThreadInput/SetWindowPos (P3)
│   └── sensors.rs                 ← sensors-win32 移植 (P4)
├── src/capture/                   ← ★ 本 ADR で新設、L1 のコア
│   ├── mod.rs
│   ├── event.rs                   ← EventEnvelope struct + EventKind enum
│   ├── ring.rs                    ← 256MB MPSC ring buffer
│   ├── wal.rs                     ← Write-Ahead Log (fsync batch)
│   ├── timestamp.rs               ← Tier dispatch for timestamp source
│   ├── dxgi_dup.rs                ← DXGI Desktop Duplication wrapper
│   └── tier.rs                    ← DataflowAccelerator L1 実装群
└── src/_errors.rs                 ← typed reason enum (ADR-010 と共有)
```

### 3.2 入出力の流れ

```
[OS API 群]                       [L1 内部]                       [TS / L2]
  UIA event ─────► event.rs (EventKind 構築) ─► ring.rs (push)
  DXGI dirty ────► dxgi_dup.rs ─► event.rs ──► ring.rs           ─► napi-rs
  hw input ──────► input.rs ────► event.rs ──► ring.rs              poll API
  tool call ─────► (L5 → L1) ───► event.rs ──► ring.rs           ─► subscribe
                                       │                              capability
                                       ▼
                                    wal.rs (durability、record モード時)
                                       │
                                       ▼
                                  fsync (10ms batch)
```

ring.rs と wal.rs は同じ EventEnvelope を 2 経路に push (durability と速度の両立)。

### 3.3 windows-rs 依存範囲

```toml
[dependencies]
windows = { version = "0.62", features = [
    # 既存 (UIA / Visual GPU 用)
    "Win32_UI_Accessibility",
    "Win32_System_Com",
    "Win32_Foundation",
    "Win32_UI_Shell",
    "Win32_Graphics_Direct3D11",
    "Win32_Graphics_Dxgi",

    # 本 ADR で追加
    "Win32_UI_WindowsAndMessaging",     # EnumWindows, GetWindowText, GetWindowRect, etc.
    "Win32_Graphics_Gdi",                # PrintWindow, GDI/DC
    "Win32_System_Threading",            # OpenProcess, GetProcessTimes
    "Win32_System_ProcessStatus",        # QueryFullProcessImageName
    "Win32_System_Diagnostics_ToolHelp", # CreateToolhelp32Snapshot
    "Win32_UI_Input_KeyboardAndMouse",   # SendInput, AttachThreadInput
    "Win32_UI_HiDpi",                    # SetProcessDpiAwareness, GetDpiForMonitor
    "Win32_Graphics_Dwm",                # DwmGetCompositionTimingInfo
] }
```

### 3.4 Panic Containment + Worker Lifecycle

L1 の堅牢性の核心は **「プロセス全滅を起こさない」** ことと **「worker thread の lifecycle を Node.js libuv と安全に接続する」** ことの 2 点。Gemini review 指摘の対応として、以下を強制する。

#### 3.4.1 Panic Containment

| 仕組み | 内容 |
|---|---|
| 自前 attr macro **`#[napi_safe]`** | 全 `#[napi]` export 関数を `std::panic::catch_unwind` で wrap、`#[napi]` 単体使用は禁止 |
| clippy lint | `#[napi]` のみで `#[napi_safe]` が無い関数を `deny` |
| CI panic-fuzz テスト | 各 `#[napi]` 関数に異常入力 (negative size / null Buffer / UTF-16 不正 / NaN 等) を投入、プロセス生存を確認 |
| panic 時の envelope 化 | `MostLikelyCause::Unknown` + `failed_at_layer="L1-panic"` で typed return、`_errors.ts` SUGGESTS coverage 改善対象 |
| `panic_rate_per_min` 監視 | catch_unwind hit を `server_status` に集約、steady state で 0/min (統合書 §17.6) |

`#[napi_safe]` 実装スケッチ:

```rust
#[proc_macro_attribute]
pub fn napi_safe(_attr: TokenStream, item: TokenStream) -> TokenStream {
    // 1. #[napi] export 名を抽出
    // 2. fn body を std::panic::catch_unwind で wrap
    // 3. panic を Result<T, napi::Error> に変換
    //    → napi::Error::from_reason(format!("panic in {}: {:?}", fn_name, payload))
    // 4. panic 発生回数を atomic counter に記録 (server_status 用)
}
```

#### 3.4.2 Worker Lifecycle

timely worker (ADR-008) と L1 capture worker は **dedicated thread** (既存 UIA COM thread と同パターン)、Node.js libuv main thread とは napi-rs `AsyncTask` で接続する。

| ライフサイクル段階 | 内容 |
|---|---|
| **起動** | 初回 `#[napi]` 呼び出し時に lazy init (`OnceLock<Sender<Task>>`)、副作用なしで idle 待ち |
| **稼働中の通信** | napi-rs `AsyncTask` で worker → libuv main thread へ Promise resolve、`crossbeam-channel` で非同期 task 配送 |
| **panic 時 auto-restart** | catch_unwind で worker 内 panic を捕捉、worker 再起動、次の `#[napi]` 呼び出しで新 thread spawn、`recent_failures_log` (server_status) に記録 |
| **graceful shutdown** | Node.js process exit 時に `Drop` で shutdown channel に signal、`join` (timeout 1s)、超過したら force terminate + warning log |
| **shutdown ordering** | L5 → L4 → L3 → L2 → L1 の **逆順** で停止 (新規 tool call 拒否 → in-flight 完了待ち → arrangement flush → WAL fsync → worker join) |

#### 3.4.3 Acceptance Criteria

- panic-fuzz CI で **プロセス全滅 0 件**
- worker auto-restart で **次の呼び出しが 1s 以内に成功**
- shutdown 完了が **3s 以内** (P5d 完了基準)
- `clippy` カスタムルールで `#[napi]` のみで `#[napi_safe]` 無しが **CI で deny pass**

---

## 4. EventEnvelope Schema (本 ADR の中核)

### 4.1 Rust struct

```rust
#[napi(object)]
pub struct EventEnvelope {
    pub envelope_version: u32,        // ★ top-level schema version (現行: 1)
    pub event_id: BigInt,             // u64 monotonic、L1 で採番
    pub wallclock_ms: BigInt,         // canonical (統合書 §5)
    pub sub_ordinal: u32,             // 同 wallclock 内の tie-break
    pub timestamp_source: String,     // "Reflex" | "DXGI" | "DWM" | "StdTime"
    pub kind: EventKind,              // (下記 enum)
    pub payload_bytes: Buffer,        // bincode-encoded、kind 固有 schema
    pub session_id: Option<String>,   // L5 起源
    pub tool_call_id: Option<String>, // L5 起源
}

#[napi]
pub enum EventKind {
    // === 観測系 ===
    DirtyRect = 0,           // DXGI dirty/move rect 検知
    UiaFocusChanged = 1,     // UIA focus event
    UiaTreeChanged = 2,      // UIA tree structure event
    UiaInvoked = 3,          // UIA Invoke pattern event
    UiaValueChanged = 4,     // UIA value pattern event
    WindowChanged = 5,       // Z-order / activation
    ScrollChanged = 6,       // UIA Scroll pattern event

    // === 副作用系 (commit の入力) ===
    ToolCallStarted = 100,   // L5 → L1 (commit 軸の入口)
    ToolCallCompleted = 101, // L5 → L1 (副作用結果)
    HwInputSent = 102,       // SendInput 呼び出し

    // === システム系 ===
    Failure = 200,           // hw failure / tier fallback
    TierFallback = 201,      // op が tier 落ちした
    Heartbeat = 202,         // L1 alive (no event 期間でも frontier 進行用)

    // === replay 系 ===
    SessionStart = 300,      // session 起点
    SessionEnd = 301,        // session 終了
}
```

### 4.2 payload schema 一覧 (主要 EventKind)

`payload_bytes` は bincode encoded。kind ごとに以下の Rust struct を decoder が deserialize。

```rust
// EventKind::DirtyRect
#[derive(Serialize, Deserialize)]
pub struct DirtyRectPayload {
    pub rect: [i32; 4],          // [x, y, w, h]
    pub kind: DirtyKind,         // Update | Move(src_x, src_y)
    pub frame_index: u64,        // DXGI frame id
}

// EventKind::UiaFocusChanged
#[derive(Serialize, Deserialize)]
pub struct UiaFocusChangedPayload {
    pub before: Option<UiElementRef>,
    pub after: Option<UiElementRef>,
    pub window_title: String,
}

// EventKind::ToolCallStarted
#[derive(Serialize, Deserialize)]
pub struct ToolCallStartedPayload {
    pub tool: String,
    pub args_json: String,        // 監査用、PII redaction layer 通過後
}

// EventKind::Failure
#[derive(Serialize, Deserialize)]
pub struct FailurePayload {
    pub layer: String,            // "L1" 等
    pub op: String,
    pub tier: u8,
    pub reason: String,           // typed (ADR-010 §5.4 enum と共有)
}
```

### 4.3 不変条件 (`layer-constraints.md` §2.3 と同期)

- `event_id` は monotonic、生成は L1 内部 atomic counter
- `wallclock_ms` は単調増加 (sub_ordinal で同 ms tie-break)
- `timestamp_source` は event 単位で固定 (混在禁止)
- 同じ event は 2 回 emit しない
- WAL に書き終わるまで ring buffer 上の "committed" mark を立てない

### 4.4 Schema versioning

EventEnvelope は **top-level に `envelope_version: u32`** を持つ (§4.1)。`payload_bytes` 側は `EventKind` 値域で schema を識別する (kind 追加は MINOR 互換、既存 kind の意味変更は MAJOR 破壊)。

L5 Tool Envelope の `_version` (string `MAJOR.MINOR`、ADR-010 §5) とは **独立に進化** する (制約 layer-constraints §7.4 / cross-layer X4)。両者の互換 matrix は起動時 integration test で検証し、不一致は fatal で worker 再起動 (制約 §2.5)。

互換 matrix の運用:
- `envelope_version` 増分 ↔ L1 Capture / L2 Storage 側変更
- L5 Envelope `_version` 増分 ↔ tool 応答 shape 変更
- 起動時に両者を読んで integration matrix で許容組合せを判定 (`docs/schema-compat-matrix.md` で管理予定)

---

## 5. HW Tier 0-3 (L1 観点)

統合書 §9 の op kind × tier マトリクスを L1 部分だけ抜粋・詳細化。

| op | T0 (Pure Rust) | T1 (OS API) | T2 (HW Assist) | T3 (Vendor) |
|---|---|---|---|---|
| screen capture | std GDI BitBlt | DXGI Desktop Duplication | DXGI + D3D11 compute shader | (n/a) |
| dirty rect detect | 自前 diff (CPU) | **DXGI GetFrameDirtyRects** | (n/a) | (n/a) |
| memcpy bulk | std::ptr::copy | rayon parallel | Intel DSA (Sapphire Rapids+) | (n/a) |
| frame ring buffer | Vec<Vec<u8>> | DXGI shared texture | NVENC / Quick Sync / AMF | (n/a) |
| timestamp source | std::time | DwmGetCompositionTimingInfo | DXGI Present statistics | NVIDIA Reflex Latency API |
| event log persist | std::fs (WAL) | (n/a) | Intel PT trace (任意併用) | (n/a) |

### 5.1 T1 が確実に効く環境

- **Windows 11 全環境で T1 動作保証** (DXGI Desktop Duplication + DwmGetCompositionTimingInfo)
- T0 fallback は test 用 + Linux stub のためのみ

### 5.2 T2 capability detect

起動時:
1. NVENC: `D3D11Device::CheckFeatureSupport` + NVENC SDK probe
2. Quick Sync: Intel iGPU 検出 + `oneVPL` initialize
3. AMF: AMD GPU 検出 + `AMD AMF Runtime` initialize
4. Intel DSA: `/dev/dsa*` (Linux) or Windows DSA driver / WMI で確認 (Sapphire Rapids+ サーバ Xeon に限る)
5. Reflex API: NVIDIA driver 535+ + Reflex SDK
6. Intel PT: Windows ETW Intel PT provider 有効性確認

各 capability は `server_status.tier_dispatch_stats` に集約 (統合書 §13.2)。

### 5.3 T3 (vendor compute) は L1 では使わない

L1 の op (event capture / encode) は Tier 0-2 で完結。Tier 3 (CUDA Graph 等) は L3 view 計算側 (ADR-008 §5)。

---

## 6. Implementation Phases

| Phase | 範囲 | 目安 | 完了基準 (acceptance criteria) |
|---|---|---|---|
| **P1: Hot path 高頻度系** | EnumWindows / GetWindowTextW / GetWindowRect / GetForegroundWindow / IsWindowVisible / IsIconic / IsZoomed / GetClassNameW / GetWindowThreadProcessId / GetWindowLongPtrW | 1-2 週 | enum+title 1000 回 latency 半減、perception loop frame -20% |
| **P2: GDI/DC + Monitor/DPI** | PrintWindow / GetDC / CreateCompatibleDC / SelectObject / DeleteObject / GetDIBits / EnumDisplayMonitors / GetMonitorInfoW / MonitorFromWindow / GetDpiForMonitor / SetProcessDpiAwareness | 1-2 週 | screenshot/printWindow latency 計測、回帰なし |
| **P3: Process/Thread + Input** | OpenProcess / GetProcessTimes / QueryFullProcessImageNameW / Toolhelp32 (snapshot/process32) / AttachThreadInput / GetCurrentThreadId / GetScrollInfo / SetWindowPos / BringWindowToTop / ShowWindow / SetForegroundWindow | 1 週 | sizeof 地雷 0 件達成 (gauntlet test) |
| **P4: sensors + 撤去** | sensors-win32.ts、koffi 依存削除、launcher zip size 計測、`package.json` から koffi 削除、Linux stub 維持 | 0.5-1 週 | koffi 行数 33→0、zip size 削減量を memory に記録 |
| **P5: L1 Capture コア新設 (本 ADR の核)** | EventEnvelope schema 確定 + ring buffer + WAL + DXGI dirty rect 統合 + Tier 0-2 dispatch + capability detect | 2-3 週 | event ingest 10k/s @ p99 < 1ms、DXGI 60Hz 同期、WAL fsync 10ms batch、replay E2E 1 件成立 |

P1-P4 は **既存 PoC 骨子のまま**、P5 が本 ADR の追加部分。

### 6.1 PR 単位の granularity

- P1-P4 は各 Phase を 1 PR で main 入れる (互換維持で段階導入)
- P5 は **subphase 化**:
  - P5a: EventEnvelope schema + ring buffer (TS API は変えない)
  - P5b: WAL + replay E2E (record モード default off で導入)
  - P5c: DXGI dirty rect 統合 + Tier dispatch
  - P5d: timestamp source 多重化 (Reflex/DXGI/DWM)

---

## 7. Migration Plan (koffi 33 箇所の置換手順)

### 7.1 一覧 (現行 koffi 使用箇所)

| ファイル | binding 定義数 / 概要 | 所属 Phase |
|---|---|---|
| `src/engine/win32.ts` | 12 koffi 定義 (func/struct/alias/load) + 多数 call site、5 DLL (user32 / gdi32 / shcore / kernel32 / dwmapi) | P1-P3 |
| `src/engine/perception/sensors-win32.ts` | sensor probe (1 binding) | P4 |

### 7.2 置換手順 (各箇所共通)

1. windows-rs で binding 関数を Rust 側 (`src/win32/<group>.rs`) に書く
2. `#[napi]` で公開、`index.d.ts` を再生成
3. TS 側 `win32.ts` の koffi 呼び出しを `nativeEngine.xxx()` に置換
4. unit test で前後比較 (戻り値・エラー・パフォーマンス)
5. e2e test で回帰確認 (既存 RPG / lens 系を含む)
6. PR 単位で main マージ

### 7.3 互換維持の鉄則

- **TS 関数のシグネチャは絶対に変えない** (呼び出し元 26+ tool に波及するため)
- 戻り値の shape も同一 (Rust から JS object 化する際、既存 TS 型に合わせる)
- エラー shape も同一 (`_errors.ts` の SUGGESTS が機能し続けること)

### 7.4 Linux stub

```typescript
// src/_linux-stub.ts
export function enumWindows(): never {
    throw new Error("Linux is not supported for win32 features");
}
// ... (全 win32 関数を unimplemented として export)
```

build 時に platform-aware で win32.ts vs _linux-stub.ts を切替。

---

## 8. Risks

| # | リスク | 影響度 | 軽減策 |
|---|---|---|---|
| 1 | 移植時に shape 微差発生 (struct field order 等) | High | Rust 側で `#[napi(object)]` 構造を TS 既存と shape-align、ゴールデンテストで検証 |
| 2 | windows-rs API の breaking change | Medium | crate version pin (`0.62.x`)、major 上げは独立 PR で |
| 3 | catch_unwind 漏れで Node 全滅 | High | 全 #[napi] 関数の最外周に `std::panic::catch_unwind`、CI に panic-fuzz 追加 |
| 4 | DXGI dirty rect が一部 driver で不正値 | Medium | Tier 1 → Tier 0 fallback chain、warning event emit |
| 5 | WAL ファイル肥大化 | Medium | rotate (1GB / 1h で renew)、古い WAL は自動 delete (env 設定) |
| 6 | Tier 2 capability detect の偽陽性 (driver 古い等) | Medium | runtime 失敗で Tier 1 cascade、`server_status` で監視 |
| 7 | Linux stub の動作保証 | Low | macOS/Linux CI で stub の throw 動作のみ確認 |
| 8 | Reflex API NVIDIA 限定 | Low | DWM/DXGI fallback (T1) で全環境動作 |
| 9 | event_id 採番の atomic counter 競合 | Low | `AtomicU64::fetch_add(Ordering::SeqCst)` で安全 |
| 10 | bincode payload と TS 側 decoder の不一致 | Medium | Rust struct と TS interface を 1 つの IDL から自動生成 (将来課題、初期は手動同期) |

---

## 9. Acceptance Criteria

### 9.1 Phase 単位

| Phase | 検証項目 |
|---|---|
| P1 | enum+title 1000 回 latency 半減、既存 e2e 回帰 0 件 |
| P2 | screenshot/printWindow 既存 e2e 回帰 0 件、PrintWindow latency 計測 |
| P3 | sizeof 地雷 0 件 (gauntlet test pass)、AttachThreadInput 既存挙動維持 |
| P4 | `git grep koffi` 行数 0、`package.json` から koffi 削除、launcher zip size を memory に記録 |
| P5a | EventEnvelope が ring buffer に push される、TS から poll 取得可能 |
| P5b | WAL に fsync 10ms batch、replay E2E で 1 session 再生成功 |
| P5c | DXGI dirty rect を `EventKind::DirtyRect` として emit、Tier 1 cascade 動作 |
| P5d | timestamp_source が capability に応じて自動選択、`server_status` に統計 |

### 9.2 統合書 SLO 達成 (本 ADR 範囲)

- event ingest throughput: 10k events/sec @ p99 < 1ms ✓
- dirty rect detect cycle: DXGI 60Hz 同期 ✓
- ring buffer overflow rate: < 0.001% ✓
- WAL write latency p99: < 5ms ✓
- replay 一致率: 100% (本 ADR では P5b のスコープのみ、L2-3 は ADR-008 D6 で完成)

### 9.3 観測されるべき副次効果

- Node プロセス sigsegv 件数 → 0 (koffi 撤去の効果)
- launcher zip size → 削減 (koffi prebuilt 同梱不要)
- LLM 体感 latency → 改善 (FFI hop 削減)

---

## 10. Open Questions

| # | OQ | 決定タイミング |
|---|---|---|
| 1 | bincode vs capnproto vs flatbuffers (payload encoder) | P5a 着手時 |
| 2 | WAL rotation サイズ (1GB / 4GB / 時間ベース) | P5b 着手時 |
| 3 | DXGI dirty rect の secondary monitor 扱い | P5c 着手時 |
| 4 | sub_ordinal 採番を per-source か global か | P5a 着手前 (sourceごとが推奨、tie 軽減) |
| 5 | Intel PT 統合は本 ADR か別 ADR か | P5d 完了後 |
| 6 | ring buffer back-pressure: drop oldest vs throttle producer | P5a 着手前 (drop oldest 推奨) |
| 7 | event_id を u64 で十分か、UUID にするか | P5a (u64 で十分、replay は (record_id, event_id) で識別) |
| 8 | `koffi-replacement` を別 crate にするか同 crate か | 着手前 (同 crate 推奨、分離価値低) |

---

## 11. 公開価値

本 ADR 単独でも:

- **"Replacing koffi with windows-rs in production: a Rust + Node.js story"** — Rust ecosystem の dev blog 系
- **"Unified event capture for Windows desktop automation in Rust"** — DXGI dirty rect + UIA event + tool call の統合は希少
- **"Crash-free FFI: how catch_unwind saved our Node.js MCP server"** — koffi sigsegv 撤廃の dev story

ADR-008 / -010 と合わせて初めて世界初級の価値だが、本 ADR 単独でも認知獲得可能。

---

## 12. Related Artifacts

- 本 ADR (`docs/adr-007-koffi-to-rust-migration.md`)
- 統合書 (SSOT): `docs/architecture-3layer-integrated.md`
- 制約: `docs/layer-constraints.md` §2 (本 ADR の不変条件・SLO の根拠)
- 後続: ADR-008 (本 ADR の EventEnvelope を input source として消費)
- 後続: ADR-009 (本 ADR §5 の Tier 0-2 を詳細化)
- 後続: ADR-010 (本 ADR の event_id / wallclock_ms / typed reason を envelope 化)

---

END OF ADR-007 (Draft).
