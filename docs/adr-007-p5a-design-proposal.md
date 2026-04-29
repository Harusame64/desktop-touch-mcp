# ADR-007 P5a — Implementation Design Proposal (drafted by Opus)

- Status: **Approved v4 — Codex round 1+2 + Sonnet fit-check round 1 すべて反映、実装着手 ready**
- Date: 2026-04-29
- Author: Claude Opus 4.7 (this session)
- v1 → v2 changelog: §16 (Codex round 1 で出た 4 件の P1/P2 指摘 + 1 件の supplementary を反映)
- v2 → v3 changelog: §17 (Codex round 2 で出た 3 件の test/bench/bg-input/stale-text 指摘を反映、API 名の安定化を含む)
- v3 → v4 changelog: §18 (Sonnet fit-check round 1 で出た 1 件 CI blocker + 3 件 minor を反映)
- Scope: ADR-007 P5a = L1 Capture コアの **ring buffer + EventEnvelope schema + worker thread + napi event API**。WAL (P5b) / DXGI dirty rect (P5c) / multi-source timestamp (P5d) は別 phase。

---

## 1. Why this proposal is structured differently

P1-P4 と違い、本 P5a は **schema 設計が下流 (P5b/c/d + ADR-008 D1 + ADR-010 P1) の anchor になる**。Sonnet draft → Opus review の順だと「Opus が architectural な書き直しを要求 → 全部やり直し」になりやすい (P5a の Open Questions は ADR-007 §10 で 8 件残っており、その多くが architectural)。

そこで **Opus が design v1 を起草、Sonnet が codebase-fit-check のみ実施 (max 1 round)** に役割を分けた (ユーザー合意済、CLAUDE.md 強制命令 4 を設計フェーズに適用)。Sonnet は本書 §10 の **Fit-check 範囲** に列挙した項目だけをレビューし、architectural critique は控える。

---

## 2. Scope decision — P5a を更に分割するか

**しない**。P5a は単一 PR で完結させる。理由:

1. P5 は ADR-007 §6.1 で既に a/b/c/d に分割済。P5a 内部で更に分割すると ring buffer / worker thread / napi 配線が個別 PR になって **テストできない断片** が生まれる (ring buffer 単独では event を produce できないし、worker thread だけでは TS から見えない)。
2. P5a の 4 要素 (envelope schema / ring buffer / worker thread / napi API) は **同時に存在しないと何も検証できない**。Phase の意味で 1 単位。
3. 推定 LOC: Rust ~600 + TS ~150 + tests ~250。P3 (Rust 620 / TS 220 / tests 470) と同規模、十分 1 PR で扱える。

ただし commit 分割は **6 commits** (§9 参照) で読みやすさを確保する。

---

## 3. Rust 実装決定 — 主要 12 項目

### 3.1 12 主要決定

| # | 項目 | 決定 | 根拠 |
|---|---|---|---|
| 1 | Module 配置 | `src/l1_capture/` 新設 (`win32/` の隣) | Layer 1 概念は Win32 に依存しない (UIA / DXGI も入る予定)、独立 module が clean |
| 2 | Worker thread モデル | dedicated thread + `crossbeam-channel` (UIA bridge `src/uia/thread.rs` と同パターン) | 既存実績、`tokio` 依存を増やさない |
| 3 | Ring buffer 実装 | `crossbeam_queue::ArrayQueue<EventEnvelope>` (lock-free MPMC) | crossbeam は既存依存、bounded、drop-oldest 実装が `force_push` 1 行 |
| 4 | Capacity | 1,000,000 events default (= ~256MB @ 256B/event 想定) | ADR-007 §2.1 #8 (256MB ring) との整合 |
| 5 | Back-pressure | **drop oldest** | ADR-007 §10 OQ #6 推奨、UIA event を取りこぼしてでも tool call は止めない |
| 6 | Event ID | u64 monotonic global counter (`AtomicU64::fetch_add(SeqCst)`) | ADR-007 §10 OQ #7、UUID は replay anchor で過剰 |
| 7 | sub_ordinal | **per-source** counter (`HashMap<TimestampSource, AtomicU32>`)、wallclock 進むとリセット | ADR-007 §10 OQ #4、global は contention 温床 |
| 8 | Timestamp source | P5a は **`StdTime` のみ** 実装、enum 値は ADR-007 §4 通り全部定義しておく (将来 P5d で `Reflex`/`DXGI`/`DWM` を埋める) | scope 制御、enum 値だけ予約 |
| 9 | Payload encoding | **bincode 2.x with serde feature** (`bincode::serde::encode_to_vec`)。Cargo.toml: `bincode = { version = "2", features = ["serde"] }` + `serde = { version = "1", features = ["derive"] }` (Codex review v1→v2、bincode 2 では serde が feature-gated) | ADR-007 §10 OQ #1、Rust↔Rust で十分、capnproto は overshoot |
| 10 | Schema versioning | top-level `envelope_version: u32 = 1`、payload は EventKind 値で dispatch | ADR-007 §4.4 SSOT |
| 11 | Subscribe API | P5a は **polling のみ** (`l1_poll_events(since, max)`)、push 通知は P5b で `ThreadsafeFunction` 化 | scope 制御、polling で 10k/s 目標は楽勝 |
| 12 | `napi_safe_call` 拡大 | **本 PR で `src/lib.rs` の sync exports + vision_backend を全部 wrap**、`scripts/check-napi-safe.mjs` の SCAN_DIR を `src/` 全体に拡大 | ADR-007 P1 follow-up が解消、PANIC_COUNTER hit が ring buffer に流れる土台になる |

### 3.2 やらないリスト (scope creep 防止)

| やらない | Phase |
|---|---|
| `#[napi_safe]` proc_macro 化 (workspace 変換) | 任意 chore PR、本 PR は `napi_safe_call` ヘルパー継続 |
| WAL fsync / replay | P5b |
| DXGI dirty rect / UIA event subscription / Tier 0-2 dispatch / `DataflowAccelerator` | P5c |
| Reflex / DXGI Present / DWM timestamp source | P5d |
| timely / DD adapter (`l1_drain_to_timely_input`) | P5b 開始時 |
| `server_status` ツールへの `panic_rate_per_min` / `wal_*` 等の追加 | P5d 完了後 (全 metric 揃った段階で 1 PR で追加) |
| `ThreadsafeFunction` ベースの push subscribe API | P5b |
| `auto-restart 1s` / `shutdown 3s` の SLO 検証 | P5a で **shutdown のみ** 達成、auto-restart は P5b で worker panic 注入テストを書く |

---

## 4. Rust ファイル構成

```
src/
├── lib.rs                  # mod l1_capture 追加 + 既存 sync exports を napi_safe_call で wrap
├── l1_capture/             # ★ P5a で新設
│   ├── mod.rs              # public API re-export
│   ├── envelope.rs         # InternalEvent / EventEnvelope struct + EventKind enum
│   ├── payload.rs          # bincode encode/decode helper + payload struct
│   ├── ring.rs             # ArrayQueue<InternalEvent> + drop-oldest force_push + atomic counters
│   ├── worker.rs           # OnceLock<Mutex<Option<Arc<L1Inner>>>> + shutdown_with_timeout
│   └── napi.rs             # 7 #[napi] export (4 typed helpers + poll/stats/shutdown)
│                           # `use crate::win32::safety::PANIC_COUNTER;` で stats 集計
├── vision_backend/capability.rs  # commit 5 で sync `detect_capability` を napi_safe_call wrap
└── win32/safety.rs         # 既存 PANIC_COUNTER + emit_failure_event() helper 追加
```

---

## 5. EventEnvelope schema 詳細

### 5.1 Rust 表現

**Codex review v1→v2**: 内部保存用の `InternalEvent` と napi 公開用の `EventEnvelope` を分離 (napi `Buffer` は JS 側で mutable、ring に直保存だと replay determinism 違反のため)。

```rust
// src/l1_capture/envelope.rs

/// Ring buffer 内に保持する内部表現。`payload` は `Vec<u8>` で **所有**
/// するため、JS 側からの後から mutation を受けない。
pub struct InternalEvent {
    pub envelope_version: u32,         // 現行 1
    pub event_id: u64,                 // monotonic
    pub wallclock_ms: u64,             // canonical
    pub sub_ordinal: u32,              // per-source counter
    pub timestamp_source: u8,          // TimestampSource enum 値
    pub kind: u16,                     // EventKind enum 値
    pub payload: Vec<u8>,              // bincode-encoded (owned, immutable post-push)
    pub session_id: Option<String>,
    pub tool_call_id: Option<String>,
}

/// napi 公開する境界型。`Buffer` は new allocation で `InternalEvent.payload`
/// から複製したものを返す (JS 側 mutate しても ring 内 InternalEvent には
/// 影響しない)。`l1_poll_events` の戻り値で使われる。
#[napi(object)]
pub struct EventEnvelope {
    pub envelope_version: u32,
    pub event_id: BigInt,              // u64 → BigInt
    pub wallclock_ms: BigInt,
    pub sub_ordinal: u32,
    pub timestamp_source: u8,
    pub kind: u16,
    pub payload_bytes: Buffer,         // freshly allocated copy of InternalEvent.payload
    pub session_id: Option<String>,
    pub tool_call_id: Option<String>,
}

impl From<&InternalEvent> for EventEnvelope {
    fn from(e: &InternalEvent) -> Self {
        EventEnvelope {
            envelope_version: e.envelope_version,
            event_id: BigInt::from(e.event_id),
            wallclock_ms: BigInt::from(e.wallclock_ms),
            sub_ordinal: e.sub_ordinal,
            timestamp_source: e.timestamp_source,
            kind: e.kind,
            payload_bytes: Buffer::from(e.payload.clone()),  // owned copy
            session_id: e.session_id.clone(),
            tool_call_id: e.tool_call_id.clone(),
        }
    }
}

#[repr(u8)]
pub enum TimestampSource {
    StdTime = 0,                       // P5a: 唯一の実装
    Dwm = 1,                           // P5d で実装
    Dxgi = 2,                          // P5d
    Reflex = 3,                        // P5d
}

#[repr(u16)]
pub enum EventKind {
    // 観測系 (P5c で実装)
    DirtyRect = 0,
    UiaFocusChanged = 1,
    UiaTreeChanged = 2,
    UiaInvoked = 3,
    UiaValueChanged = 4,
    WindowChanged = 5,
    ScrollChanged = 6,

    // 副作用系 (P5a で実装)
    ToolCallStarted = 100,
    ToolCallCompleted = 101,
    HwInputSent = 102,                 // win32.ts::postMessageToHwnd 内の hook から push (将来 SendInput 用 helper も同 kind)

    // システム系 (P5a で実装)
    Failure = 200,                     // napi_safe_call から push
    TierFallback = 201,                // P5c で push
    Heartbeat = 202,                   // L1 worker が 1s 周期で push (frontier 進行用)

    // replay 系 (P5a で実装)
    SessionStart = 300,                // L1 worker init 時に 1 回
    SessionEnd = 301,                  // shutdown drain 時に 1 回
}
```

`EventKind` は `#[napi]` で u16 として export (napi-rs の enum repr 互換性のため、整数 export が安全)。TS 側で `enum EventKind { ToolCallStarted = 100, ... }` を手書きで mirror する。

### 5.2 Payload 設計 (bincode)

各 `EventKind` に対応する payload struct を `src/l1_capture/payload.rs` に集約:

```rust
#[derive(Serialize, Deserialize)]
pub struct ToolCallStartedPayload {
    pub tool: String,
    pub args_json: String,             // PII redaction 済 (TS 側責務)
}

#[derive(Serialize, Deserialize)]
pub struct ToolCallCompletedPayload {
    pub tool: String,
    pub elapsed_ms: u32,
    pub ok: bool,
    pub error_code: Option<String>,
}

/// PostMessageW 経路用 (P5a で実装)。`target_hwnd` / `msg` / `wParam` /
/// `lParam` を生のまま記録。意味解釈 (どの key だったか / どの修飾子か) は
/// downstream (LLM 側 or P5c のセマンティック lift) に委ねる。
/// SendInput 用は将来 `HwInputSendInputPayload` で別 helper として追加。
#[derive(Serialize, Deserialize)]
pub struct HwInputPostMessagePayload {
    pub target_hwnd: u64,
    pub msg: u32,                      // WM_CHAR / WM_KEYDOWN / WM_KEYUP 等
    pub w_param: u64,                  // usize wide on x64
    pub l_param: i64,                  // isize, signed (PR #77 lesson, WM_KEYUP 上位 bit 保存)
}

#[derive(Serialize, Deserialize)]
pub struct FailurePayload {
    pub layer: String,                 // "L1" / "L5"
    pub op: String,                    // 関数名
    pub reason: String,                // typed enum (ADR-010 §5.4 の 37 codes と互換)
    pub panic_payload: Option<String>, // catch_unwind の payload string
}

#[derive(Serialize, Deserialize)]
pub struct HeartbeatPayload {
    pub uptime_ms: u64,
    pub event_count: u64,
    pub drop_count: u64,
}

#[derive(Serialize, Deserialize)]
pub struct SessionStartPayload {
    pub envelope_version: u32,
    pub addon_version: String,
}

#[derive(Serialize, Deserialize)]
pub struct SessionEndPayload {
    pub reason: String,                // "shutdown" / "panic" / "unknown"
}
```

bincode encoder は `bincode::serde::encode_to_vec(&payload, bincode::config::standard())` で 1 行。decoder は P5b で必要になる (本 PR では encode side のみ使う)。

### 5.3 不変条件

| # | invariant | 違反時の挙動 |
|---|---|---|
| 1 | `event_id` は monotonic increasing across all events | `AtomicU64::fetch_add(SeqCst)` で構造的に保証 |
| 2 | 同 wallclock_ms 内では `(timestamp_source, sub_ordinal)` が unique | per-source counter + tie-break で保証 |
| 3 | `envelope_version = 1` (本 PR) | hardcoded |
| 4 | drop-oldest 時でも `event_id` の連続性は保証されない (= 飛ぶ) | L2 adapter (P5b) で許容する設計 |
| 5 | `payload_bytes` の bincode encoding は `EventKind` 値で一意に対応 | dispatch table を `payload.rs` で集約 |

---

## 6. Ring buffer 実装

### 6.1 構造

**Codex review v1→v2**: ArrayQueue が保持するのは `InternalEvent` (Vec<u8> 所有)。`poll` 戻り値の `EventEnvelope` への変換は `From<&InternalEvent>` で行い、Buffer は new allocation。

```rust
// src/l1_capture/ring.rs

use crossbeam_queue::ArrayQueue;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

pub struct EventRing {
    queue: ArrayQueue<InternalEvent>,       // ★ InternalEvent (Vec<u8> 所有)
    event_id_counter: AtomicU64,
    drop_count: AtomicU64,
    push_count: AtomicU64,
}

impl EventRing {
    pub fn new(capacity: usize) -> Self { ... }

    /// Drop-oldest 押し込み。`force_push` は満杯時に最古を pop して捨てる。
    /// Returns the freshly assigned `event_id`.
    pub fn push(&self, mut event: InternalEvent) -> u64 {
        let id = self.event_id_counter.fetch_add(1, Ordering::SeqCst);
        event.event_id = id;
        if self.queue.force_push(event).is_some() {
            self.drop_count.fetch_add(1, Ordering::Relaxed);
        }
        self.push_count.fetch_add(1, Ordering::Relaxed);
        id
    }

    /// Drain events with `event_id > since_event_id`, up to `max` items.
    /// Returns `EventEnvelope` (Buffer は freshly allocated)。
    pub fn poll(&self, since_event_id: u64, max: usize) -> Vec<EventEnvelope> {
        let mut buf = Vec::with_capacity(max.min(self.queue.len()));
        while buf.len() < max {
            match self.queue.pop() {
                Some(e) if e.event_id > since_event_id => buf.push(EventEnvelope::from(&e)),
                Some(_) => continue,    // since_event_id 以下は捨てる
                None => break,
            }
        }
        buf
    }

    pub fn stats(&self) -> CaptureStats { ... }
}
```

### 6.2 "drained once, gone" semantic

ArrayQueue の `pop()` は破壊的なので、L1 ring buffer は **single-consumer model**:
- P5a: TS 側 ( ADR-010 P1 で envelope を組立てる時に必要) が唯一の consumer
- P5b: timely input adapter が consumer になる時、TS polling は廃止

これは ADR-008 §2 #5 「L1 ring buffer → timely input」と整合。複数 subscriber 用には P5b で `ThreadsafeFunction` ベースの push 通知 + 各 subscriber 専用 buffer を上に乗せる。

### 6.3 Capacity と memory 計算

- 平均 event size 推定: envelope (~80 B fixed fields) + payload bincode (~150 B average) + Buffer overhead (~64 B) ≈ **~300 B/event**
- Default capacity 1M events ≈ **~300 MB**
- ADR-007 §2.1 #8 の「256MB ring」目標と概ね一致。env で調整可 (`DESKTOP_TOUCH_RING_CAPACITY=N`)

### 6.4 Memory budget の env override

```rust
fn ring_capacity_from_env() -> usize {
    std::env::var("DESKTOP_TOUCH_RING_CAPACITY")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&n| n >= 1024 && n <= 10_000_000)  // sanity
        .unwrap_or(1_000_000)
}
```

---

## 7. Worker thread architecture

### 7.1 構造

**Codex review v1→v2**: `OnceLock<L1Worker>` 直は drop/reset 不可で `JoinHandle::join` も timeout 無し → **`OnceLock<Mutex<Option<Arc<L1Inner>>>>`** パターンに rewrite。Mutex で interior mutability、Option で take 可能、Arc で `ensure_l1()` が clone 返却。`join_with_timeout` は別 thread + `mpsc::recv_timeout` で実装 (Rust std `JoinHandle::join` には timeout 無いため)。

```rust
// src/l1_capture/worker.rs

use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::thread;
use std::time::{Duration, Instant};
use crossbeam_channel::{bounded, Sender, Receiver};

/// 内部状態。Drop で worker thread に shutdown を通知、join は呼び出し元責務
/// (`shutdown_with_timeout` 経由)。
pub(crate) struct L1Inner {
    pub ring: Arc<EventRing>,
    shutdown_tx: Sender<()>,
    join_handle: Mutex<Option<thread::JoinHandle<()>>>,
    started_at: Instant,
}

impl L1Inner {
    pub fn shutdown_with_timeout(&self, timeout: Duration) -> Result<(), &'static str> {
        // Idempotent: bounded(1) なので 2 回送ると Err、無視
        let _ = self.shutdown_tx.try_send(());
        let handle_opt = {
            let mut guard = self.join_handle.lock().unwrap();
            guard.take()
        };
        let handle = match handle_opt {
            Some(h) => h,
            None => return Ok(()),  // already joined
        };
        // std::thread::JoinHandle::join に timeout が無いので、別 thread で
        // join → mpsc で完了通知 → 元 thread が recv_timeout で待つ。
        let (tx, rx) = mpsc::channel::<()>();
        thread::spawn(move || {
            let _ = handle.join();
            let _ = tx.send(());
        });
        match rx.recv_timeout(timeout) {
            Ok(()) => Ok(()),
            Err(mpsc::RecvTimeoutError::Timeout) => Err("worker join timed out"),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("join helper disconnected"),
        }
    }
}

impl Drop for L1Inner {
    fn drop(&mut self) {
        // Best-effort: shutdown signal だけ送って、join は `shutdown_with_timeout`
        // を明示的に呼ぶ運用。Drop で 1s ブロックすると Node 終了が遅れる。
        let _ = self.shutdown_tx.try_send(());
    }
}

/// 静的 slot。`OnceLock<Mutex<Option<Arc<L1Inner>>>>` で:
/// - 初回 `ensure_l1()` で OnceLock 初期化 + Mutex<Option> = Some(Arc::new(...))
/// - test 中の `l1_shutdown_for_test()` で take(), join, None に置換
/// - 次の `ensure_l1()` 呼び出しで Mutex<Option> を Some に再 init
/// OnceLock 自体は reset 不可だが、Mutex<Option<Arc<>>> の中身は差し替え可。
static L1_SLOT: OnceLock<Mutex<Option<Arc<L1Inner>>>> = OnceLock::new();

pub(crate) fn ensure_l1() -> Arc<L1Inner> {
    let cell = L1_SLOT.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().unwrap();
    if guard.is_none() {
        *guard = Some(Arc::new(spawn_l1_inner()));
    }
    Arc::clone(guard.as_ref().unwrap())
}

pub(crate) fn shutdown_l1_for_test(timeout: Duration) -> Result<(), &'static str> {
    let cell = match L1_SLOT.get() {
        Some(c) => c,
        None => return Ok(()),
    };
    let inner_opt = {
        let mut guard = cell.lock().unwrap();
        guard.take()
    };
    match inner_opt {
        Some(inner) => inner.shutdown_with_timeout(timeout),
        None => Ok(()),
    }
}

fn spawn_l1_inner() -> L1Inner {
    let ring = Arc::new(EventRing::new(ring_capacity_from_env()));
    let (shutdown_tx, shutdown_rx) = bounded::<()>(1);
    let ring_for_worker = Arc::clone(&ring);
    let join = thread::Builder::new()
        .name("l1-capture".into())
        .spawn(move || worker_loop(ring_for_worker, shutdown_rx))
        .expect("spawn l1-capture thread");

    // SessionStart event を最初に push
    ring.push(make_session_start_event());

    L1Inner {
        ring,
        shutdown_tx,
        join_handle: Mutex::new(Some(join)),
        started_at: Instant::now(),
    }
}

fn worker_loop(ring: Arc<EventRing>, shutdown: Receiver<()>) {
    let heartbeat_interval = Duration::from_millis(1000);
    loop {
        // shutdown signal を非同期で待つ。期限内 heartbeat、期限到達なら exit。
        match shutdown.recv_timeout(heartbeat_interval) {
            Ok(()) | Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                // Drain pending Failure events 1 回、SessionEnd 入れて exit
                ring.push(make_session_end_event("shutdown"));
                return;
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                // 1s 経過、Heartbeat push
                ring.push(make_heartbeat_event(&ring));
            }
        }
    }
}
```

worker thread は **唯一 Heartbeat と SessionStart/End を発火する所有者**。Push の主体は他 thread (libuv main thread からの `l1_push_event`、`napi_safe_call` の panic catch path) だが、worker thread が破棄されたら ring も死ぬので **worker thread = ring の owner**。

### 7.2 Shutdown ordering (Codex review v1→v2 で書き直し)

ADR-007 §3.4.2 の「L5 → L4 → L3 → L2 → L1 逆順 shutdown」は P5a 単体では検証できない (L2-5 がまだ存在しない)。本 PR では:

- **Node.js process exit 時の挙動**: `OnceLock<Mutex<Option<Arc<L1Inner>>>>` 自体は静的 lifetime なので「Drop で勝手に shutdown」は **設計しない**。代わりに napi-rs の `Env::add_env_cleanup_hook` (= addon teardown hook、`napi_add_env_cleanup_hook`) で `shutdown_l1_for_test(Duration::from_secs(1))` を登録 (※ Sonnet fit-check で napi-rs 0.x の正確な API 名と signature を確認)。これで Node embedder からの cleanup callback が走る
- **明示的 shutdown** (`shutdown_l1_for_test`): test で 1s timeout 付き join、超過時は worker thread を leak (force terminate は std API では不可、leak が現実解)
- **`auto-restart 1s 以内`** は P5b で worker panic injection test を書いた時に実装。本 PR では再起動可能性を `OnceLock<Mutex<Option<>>>` パターンで担保 (test で shutdown → 次の `ensure_l1()` で再 init)

### 7.3 Panic 安全

Worker thread 自体が panic した場合:
- `JoinHandle::join()` が `Err` を返す
- `OnceLock<Mutex<Option<Arc<L1Inner>>>>` の Mutex 内 `Some(Arc<L1Inner>)` は alive のままだが内部 worker thread は死亡 → 次の `l1_push_event` は ring に書ける (ring は Arc で別所有) が Heartbeat / SessionEnd は出ない
- 次の `shutdown_l1_for_test` 後の `ensure_l1()` 呼び出しで再 init される (Codex 指摘の "100x shutdown test" が成立する形)

P5a では **worker thread の auto-restart は実装しない** (P5b で実装)。代わりに worker_loop 内に `std::panic::catch_unwind` を入れ、loop iteration ごとの panic を握り潰す:

```rust
fn worker_loop(ring: Arc<EventRing>, shutdown: Receiver<()>) {
    loop {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // recv_timeout / heartbeat push を実行
        }));
        if result.is_err() {
            ring.push(make_failure_event("L1-worker", "loop_panic", ...));
            // Loop は継続 (auto-restart 相当だが thread 再起動はしない)
        }
    }
}
```

これで worker が SessionEnd を出さずに死ぬケースを最小化。

---

## 8. napi event API (typed helpers + 共通 export)

**Codex review v1→v2**: TS 側に bincode encoder が無いので、generic な `l1_push_event(kind, Buffer)` は実装不能 (TS から事前 encode した Buffer を渡せない)。**per-EventKind 典型的 helper** に置換、Rust 内部で bincode encode して ring に push。

### 8.1 公開関数 (typed helpers + 3 共通)

```rust
// src/l1_capture/napi.rs

// ── EventKind ごとの typed helper (TS から呼ぶ producer) ───────────────────
//
// session_id / tool_call_id は両方 Option<String>、現行 P5a では `None` で
// 良い (L5 wrapper が ADR-010 P1 で session/tool_call ID を渡し始める)。

/// `EventKind::ToolCallStarted` を push。L5 wrapper が tool 受信時に呼ぶ。
#[napi]
pub fn l1_push_tool_call_started(
    tool: String,
    args_json: String,                 // PII redaction 済 (TS 側責務)
    session_id: Option<String>,
    tool_call_id: Option<String>,
) -> napi::Result<BigInt>;

/// `EventKind::ToolCallCompleted` を push。
#[napi]
pub fn l1_push_tool_call_completed(
    tool: String,
    elapsed_ms: u32,
    ok: bool,
    error_code: Option<String>,
    session_id: Option<String>,
    tool_call_id: Option<String>,
) -> napi::Result<BigInt>;

/// `EventKind::HwInputSent` を push (PostMessageW 経路)。`win32.ts::postMessageToHwnd`
/// 内の hook から呼ぶ — bg-input.ts の 6 callsite を一網打尽 + 将来の caller も自動カバー。
/// `target_hwnd` / `w_param` / `l_param` はすべて BigInt (lParam の bit-31 を sign-preserve、
/// PR #77 の Codex P1 指摘と同パターン)。SendInput 経路は将来 `l1_push_hw_input_send_input`
/// として別 helper で追加 (どちらも EventKind = HwInputSent = 102)。
#[napi]
pub fn l1_push_hw_input_post_message(
    target_hwnd: BigInt,
    msg: u32,                          // WM_CHAR / WM_KEYDOWN / WM_KEYUP 等
    w_param: BigInt,
    l_param: BigInt,
    session_id: Option<String>,
    tool_call_id: Option<String>,
) -> napi::Result<BigInt>;

/// `EventKind::Failure` を push。`napi_safe_call` の catch_unwind path から
/// 呼ばれる (Rust 内部) + TS 側からも呼べる (例: tool call top-level catch)。
#[napi]
pub fn l1_push_failure(
    layer: String,                     // "L1" / "L5" 等
    op: String,                        // 関数名
    reason: String,                    // typed enum (ADR-010 §5.4)
    panic_payload: Option<String>,
    session_id: Option<String>,
    tool_call_id: Option<String>,
) -> napi::Result<BigInt>;

// ── 共通 (poll / stats / shutdown) ────────────────────────────────────────

/// `since_event_id` より新しい event を最大 `max` 件 drain。
/// 注意: drain は破壊的操作。同じ event は二度返らない。
#[napi]
pub fn l1_poll_events(
    since_event_id: BigInt,
    max_count: u32,
) -> napi::Result<Vec<EventEnvelope>>;

/// L1 ring buffer のヘルスチェック。bench / server_status 用。
#[napi]
pub fn l1_get_capture_stats() -> napi::Result<NativeCaptureStats>;

/// L1 worker thread を強制 shutdown (test 用、通常運用では env cleanup hook で自動)。
/// 1s timeout で join、超過時は napi::Error。
#[napi]
pub fn l1_shutdown_for_test() -> napi::Result<()>;
```

### 8.1.x なぜ generic raw push API を expose しないか

理由 3 点:
1. **TS 側に bincode encoder がない** (Codex P1 指摘の本質)。事前 encode は実装不能
2. **schema 整合性の単一 source-of-truth**: payload struct 定義は `src/l1_capture/payload.rs` に集約、Rust 側の `Serialize` derive が bincode と直結。TS 側は **値を渡すだけ**で良い
3. **Heartbeat / SessionStart / SessionEnd は worker thread 専有**: TS から push する用途がないので helper を expose しない

**Replay (P5b) 時には raw bytes を入力する `l1_push_event_raw(kind, payload_bytes)` が必要になる** が、これは P5b で追加 (P5b 完了時の WAL replay 経路で使われる)。本 PR では追加しない。

```rust
#[napi(object)]
pub struct NativeCaptureStats {
    pub uptime_ms: BigInt,
    pub push_count: BigInt,
    pub drop_count: BigInt,
    pub current_buffered: u32,
    pub panic_count: BigInt,             // PANIC_COUNTER の値
    pub event_id_high_water: BigInt,     // 最新採番 event_id
}
```

全 7 関数 (typed helpers 4 + poll/stats/shutdown 3) が `napi_safe_call` で wrap される (P1-P3 と同パターン)。

### 8.2 TS 側配線 (Codex review v1→v2 で追記: `nativeL1` export const + load 判定)

`src/engine/native-engine.ts` に **`NativeL1` interface + `nativeL1` export const + load detection** を追加。`nativeWin32` と同じ pattern:

```typescript
// src/engine/native-engine.ts (差分のみ)

import type {
  NativeEventEnvelope,
  NativeCaptureStats,
} from "./native-types.js";

export interface NativeL1 {
  // EventKind ごとの typed helpers (ADR-007 P5a)
  l1PushToolCallStarted?(
    tool: string,
    argsJson: string,
    sessionId?: string,
    toolCallId?: string,
  ): bigint;
  l1PushToolCallCompleted?(
    tool: string,
    elapsedMs: number,
    ok: boolean,
    errorCode?: string,
    sessionId?: string,
    toolCallId?: string,
  ): bigint;
  l1PushHwInputPostMessage?(
    targetHwnd: bigint,
    msg: number,
    wParam: bigint,
    lParam: bigint,
    sessionId?: string,
    toolCallId?: string,
  ): bigint;
  l1PushFailure?(
    layer: string,
    op: string,
    reason: string,
    panicPayload?: string,
    sessionId?: string,
    toolCallId?: string,
  ): bigint;

  // 共通
  l1PollEvents?(sinceEventId: bigint, maxCount: number): NativeEventEnvelope[];
  l1GetCaptureStats?(): NativeCaptureStats;
  l1ShutdownForTest?(): void;
}

// nativeWin32 と同じく、addon の `l1_*` family が見えれば L1 native available と判定。
// `l1_push_failure` を probe key にする (4 typed helpers のうち最も汎用、P5b 以降も残る)。
export const nativeL1: NativeL1 | null =
  nativeBinding && typeof nativeBinding.l1PushFailure === "function"
    ? (nativeBinding as unknown as NativeL1)
    : null;

if (nativeL1) {
  console.error("[native-engine] Rust L1 capture loaded (ADR-007 P5a)");
}
```

`native-types.ts` には `NativeEventEnvelope` / `NativeCaptureStats` interface を追加 (既存 `Native*` パターン踏襲)。

### 8.3 既存 TS hot path に push 点を埋める (Codex review v2→v3 で位置確定)

**Codex round 2 の指摘**: v2 は「`nativeWin32.win32PostMessage` 呼び出しの直前」と書いていたが、`bg-input.ts` は `nativeWin32` を直接呼ばず、`win32.ts` の TS wrapper **`postMessageToHwnd`** を 6 箇所で呼ぶ。bg-input.ts に 6 hook 入れるより、**`postMessageToHwnd` 内部に hook を 1 箇所だけ** 追加する方が clean (将来の caller も自動カバー)。

P5a では **1 箇所のみ** event push を呼ぶ:

```typescript
// src/engine/win32.ts の postMessageToHwnd 内部 (差分の概形)

import { nativeL1 } from "./native-engine.js";

export function postMessageToHwnd(hwnd: unknown, msg: number, wParam: number, lParam: number): boolean {
  if (typeof hwnd !== "bigint") return false;
  // L1 capture hook — production caller (bg-input.ts の 6 callsite) を一網打尽 + 将来の
  // 別 caller (例: terminal helper) も自動でログされる。null-safe: nativeL1 が無い build
  // (Linux stub / pre-P5a addon) でも throw しない。
  nativeL1?.l1PushHwInputPostMessage?.(
    hwnd,
    msg >>> 0,
    BigInt(wParam | 0),
    BigInt(lParam | 0),
  );
  try {
    return requireNativeWin32().win32PostMessage!(hwnd, msg >>> 0, BigInt(wParam | 0), BigInt(lParam | 0));
  } catch {
    return false;
  }
}
```

注意点:
- bg-input.ts は **無修正**。既存 `postMessageToHwnd(target, WM_CHAR, wParam, 0)` 等 6 callsite はそのまま動く
- `wParam | 0` / `lParam | 0` の signed-int32 化は P5a の前から `postMessageToHwnd` 内部で行われている既存挙動 (PR #77 で `BigInt(lParam | 0)` への native 渡しが既に実装済)
- L1 push は **失敗しても無視** (`?.` chain)、postMessage 自体の失敗時にも push が出る (= 「送信を試みた」の記録、結果は ToolCallCompleted で別途残す)

`ToolCallStarted` / `ToolCallCompleted` は L5 wrapper (`src/server-windows.ts` の MCP request handler) で発火。**P5a では実装しない** (ADR-010 P1 の wrapper 整備時に同時実装が clean)。本 PR の typed helper 4 つは **受け入れる準備** までで止める。

---

## 9. Implementation Phases (commit 単位)

| # | commit | 範囲 |
|---|---|---|
| 1 | `feat(l1): scaffold l1_capture module + InternalEvent/EventEnvelope schema` | `src/l1_capture/{mod,envelope,payload}.rs` + `Cargo.toml` 依存 (`bincode = { version = "2", features = ["serde"] }`、`serde = { version = "1", features = ["derive"] }`、`crossbeam-queue = "0.3"`) |
| 2 | `feat(l1): add ring buffer with drop-oldest semantics over InternalEvent` | `src/l1_capture/ring.rs` + unit test |
| 3 | `feat(l1): add l1-capture worker thread (OnceLock<Mutex<Option<Arc<>>>> + heartbeat + manual join-with-timeout)` | `src/l1_capture/worker.rs` |
| 4 | `feat(l1): expose 7 napi exports (4 typed push helpers + poll + stats + shutdown_for_test)` | `src/l1_capture/napi.rs` + `index.d.ts` / `index.js` / `native-types.ts` / `native-engine.ts` (NativeL1 interface + nativeL1 export const + load detection) |
| 5 | `feat(safety): wire PANIC_COUNTER hits into l1 ring as Failure events + extend napi_safe_call to existing sync exports` | `src/win32/safety.rs` + `src/lib.rs` (compute_change_fraction / dhash_from_raw / hamming_distance / **both detect_capability variants** を wrap) + `src/vision_backend/capability.rs` (sync `#[napi] detect_capability` を `napi_safe_call` で wrap、Sonnet fit-check #2/#10 で SCAN_DIR 拡大の CI blocker として検出) + `scripts/check-napi-safe.mjs` SCAN_DIR 拡大 |
| 6 | `test+bench(l1): panic-fuzz drop-oldest + ingest p99 < 1ms bench + postMessageToHwnd hook` | `tests/unit/l1-capture.test.ts` + `scripts/bench-l1-ingest.mjs` + `src/engine/win32.ts::postMessageToHwnd` に 1 行追加 (bg-input.ts は無修正、Codex review v2→v3) |

各 commit で `cargo check` + `npm run build` + `npm run lint` + 4 guards (napi-safe / native-types / no-koffi / stub-catalog) 通過。

---

## 10. Sonnet Fit-check 範囲 (Round 2 で確認してほしい項目のみ)

Sonnet は **architectural critique を控え**、以下の codebase 固有事項のみレビューしてください。

### 10.1 必須 fit-check 項目

| # | 項目 | 確認内容 |
|---|---|---|
| 1 | **`Cargo.toml` 追加依存** | `bincode = { version = "2", features = ["serde"] }` + `serde = { version = "1", features = ["derive"] }` + `crossbeam-queue = "0.3"` を `[dependencies]` に追加して既存 build (vision-gpu feature 含む、特に `serde` を ort 経由で間接依存している可能性) と衝突しないか。**Codex review v1→v2** で bincode 2 が serde feature-gate であることを反映済 |
| 2 | **`scripts/check-napi-safe.mjs` SCAN_DIR 拡大** | 現状 `src/win32/` のみ。本 PR で `src/` 全体にする時、既存 UIA AsyncTask exports (~13 個) や vision_backend AsyncTask exports が **誤検出されない** か (AsyncTask は `napi_safe_call` 不要、proposal §3.1 #12 通り)。AsyncTask 戻り値 pattern を skip する正規表現が grep で正しく動くか。**Sonnet fit-check v3→v4**: SCAN_DIR 拡大で `src/vision_backend/capability.rs::detect_capability` が既存違反として検出される (module レベル `#[cfg(feature = "vision-gpu")]` で gate されているが per-fn `#[cfg]` が無いため backward-scan が gate を見つけない)。**commit 5 で同関数を `napi_safe_call` で wrap して解消** (option A、同じ commit に同梱) |
| 3 | **`scripts/check-native-types.mjs` FEATURE_GATED_DIRS** | 新 `src/l1_capture/` は features-gated でない (常に compile)。allowlist 修正不要のはずだが、SCAN_DIR が既にカバーしているか確認 |
| 4 | **`scripts/check-no-koffi.mjs`** | 本 PR で何ら影響しない (koffi は触らない)、念のため pass 確認 |
| 5 | **`scripts/build-rs.mjs` snapshot/restore** | `index.d.ts` に **2 interface + 7 declare** 追加 (NativeEventEnvelope, NativeCaptureStats / l1PushToolCallStarted, l1PushToolCallCompleted, **l1PushHwInputPostMessage** [v3 rename], l1PushFailure, l1PollEvents, l1GetCaptureStats, l1ShutdownForTest) を **commit 4 で含める**。build:rs script の snapshot/restore と衝突しない (uncommitted な状態で build:rs を走らせない運用) |
| 6 | **`index.d.ts` / `index.js` 手動同期** | 2 interface + 7 declare + 7 export const の手動メンテ漏れ防止。commit 4 で確実に同期 |
| 7 | **`tests/unit/` panic-fuzz pattern 既存慣習** | `native-win32-panic-fuzz.test.ts` の構造 (3 adversarial × N functions) を踏襲。`describe.skipIf(!nativeL1)` で Linux skip |
| 8 | **`src/engine/win32.ts::postMessageToHwnd` push 1 行追加** | bg-input.ts は無修正で OK (`postMessageToHwnd` 内部に hook を入れることで 6 callsite 一網打尽)。**Codex review v2→v3** で確定 — bg-input.ts が `nativeWin32` を直接呼んでいない事実を反映 |
| 9 | **`src/server-linux-stub.ts` への影響** | L1 capture は Windows-only、Linux stub は触らない。ただし `index.d.ts` の declare は cross-platform なので Linux build で missing 関数 import になる可能性。`NativeL1` interface の **optional `?:`** で対応 |
| 10 | **既存 sync `#[napi]` exports の `napi_safe_call` wrap** (commit 5) | **Sonnet fit-check v3→v4 で確定済**。対象 5 関数: (a) `src/lib.rs::compute_change_fraction` / (b) `src/lib.rs::dhash_from_raw` / (c) `src/lib.rs::hamming_distance` / (d) `src/lib.rs::detect_capability` (`#[cfg(not(feature = "vision-gpu"))]` stub) / (e) `src/vision_backend/capability.rs::detect_capability` (vision-gpu 経路)。**AsyncTask 形式 (`preprocess_image`, `draw_som_labels`, `vision_init_session`, 全 UIA `uia_*`, `vision_recognize_rois`) は触らない** (napi-rs worker pool で panic 捕捉される)。`src/win32/*.rs` は P1-P4 で wrap 済 |
| 14 | **napi-rs cleanup hook 名前** | **Sonnet fit-check v3→v4 で確認済**: napi-rs 2.16.17 (本プロジェクトの pinned version) で `Env::add_env_cleanup_hook` は **利用可** (`#[cfg(feature = "napi3")]` gated、本プロジェクトの `napi = { features = ["napi8"] }` が含意)。production cleanup hook として実装可。登録タイミング: `#[napi(module_init)]` callback または init 専用 `#[napi]` 関数の `env` 引数経由で呼ぶ |
| 15 | **`OnceLock<Mutex<Option<Arc<L1Inner>>>>` の型整合** | Rust `std::sync::{OnceLock, Mutex}` で書けるか確認 (Rust 1.70+ で `OnceLock` 安定)。`crossbeam-channel` の `Sender<()>` clone も Mutex の中で問題ないか |
| 11 | **`Cargo.toml` features 追加** | P5a で OS API 増やさないので features 追加なし、と本書で書いたが confirm。`bincode` / `crossbeam-queue` は features 制御不要 |
| 12 | **MCP tool 追加なし** | `src/stub-tool-catalog.ts` 不変、`npm run check:stub-catalog` で confirm |
| 13 | **vitest configuration** | **Sonnet fit-check v3→v4 で訂正**: `vitest.config.ts` の `unit` project は既に `testTimeout: 10_000` を設定済 (本 fit-check で確認)。`tests/unit/l1-capture.test.ts` / `l1-capture-panic-fuzz.test.ts` は `unit` project に自動包含。個別テストで `{ timeout: 5_000 }` を pass する必要なし、10s 内に収まることだけ確認すれば良い |

### 10.2 fit-check で **しないこと**

- 「ring buffer policy は drop-oldest より throttle-producer の方が良い」← architectural critique は Opus 領分
- 「EventKind の分類は別の切り方が良い」← schema design は Opus が確定済
- 「sub_ordinal は global の方が良い」← OQ #4 で per-source 確定済
- 「proc_macro 化を P5a でやるべき」← scope creep

これらは Sonnet round 1 で出さない。出てきたら Opus が round 2 で再評価する判断ポイント。

---

## 11. テスト

### 11.1 Unit (`tests/unit/l1-capture.test.ts`)

**Codex review v2→v3**: typed helpers 化に合わせて API references を全部書き直し。テスト不能な「不正 EventKind」テストは削除 (typed helper には EventKind 引数が無い)。代わりに typed-arg validation tests を追加。

- Push N events via `l1PushHwInputPostMessage`、`l1PollEvents(0n, max)` で全件取得 (順序保証 + event_id monotonic)
- Push (capacity + 100) events via `l1PushHwInputPostMessage`、`drop_count == 100` + poll で最古の 100 が消えていること
- 不正引数 panic-safety:
  - `l1PushHwInputPostMessage(0n, 0, 0n, 0n)` — null hwnd で panic しない (returns BigInt event_id)
  - `l1PushHwInputPostMessage(0xFFFFFFFFFFFFFFFFn, 0, 0n, -1n)` — all-ones hwnd / bit-31 lParam で panic しない
  - `l1PushFailure("L9-fake", "fake", "FakeReason", null, null, null)` — long string でも panic しない
- `l1GetCaptureStats` の各 field が増分整合 (`push_count == polled + buffered + dropped`)

EventKind 範囲外 validation は **Rust 側 unit test** で行う (`src/l1_capture/envelope.rs` 内の `#[test]`、`InternalEvent { kind: 9999, ... }` を ring に push して `EventEnvelope::from(&)` 経由で u16 wrap 動作確認)。napi 層では typed helper が EventKind を引数で取らないので、TS 側からは触れない。

### 11.2 Bench (`scripts/bench-l1-ingest.mjs`)

ADR-007 §6 P5a acceptance: **event ingest 10k/s @ p99 < 1ms**:

- 10,000 events を for ループで `nativeL1.l1PushHwInputPostMessage(0n, 0, 0n, 0n)` 連続 push (最小 payload を持つ helper、bincode encode が ~28 byte で benchmark 雑音最小)
- 各 push の latency を `process.hrtime.bigint()` で記録
- p50 / p95 / p99 / max を出力
- 目標: **p99 < 1ms** (= 各 push で `AtomicU64::fetch_add` + bincode encode + `ArrayQueue::force_push` + napi marshalling 完結)
- bench 後 `l1GetCaptureStats` で `drop_count == 0`、`push_count == 10_000` を確認 (drop-oldest 不発)

### 11.3 panic-fuzz 拡張 (新規 file `tests/unit/l1-capture-panic-fuzz.test.ts`)

`tests/unit/native-win32-panic-fuzz.test.ts` の構造を踏襲、`l1_capture` 専用に切り出し。

- worker thread shutdown → 次の `l1PushHwInputPostMessage` で再 init → 5 回連続でテスト (Codex round 1 の "100 回連続テストは OnceLock で不能" 指摘を、`OnceLock<Mutex<Option<Arc<>>>>` パターンで成立可に変えた v2 設計で 5 回に抑えて検証)
- panic catch worker_loop 内で発生させて Failure event が ring に入ること (`l1PushFailure` を直接呼んで擬似的に検証)
- ring overflow: capacity を env で 1024 に絞って起動 → 10,000 push → `l1GetCaptureStats().drop_count == 8976` を確認 (drop-oldest が動作)

---

## 12. リスク

| # | リスク | 軽減策 |
|---|---|---|
| 1 | bincode 2.x の API は 1.x と非互換、既存 dep に影響 | 既存 cargo dep に bincode は無いはず (Sonnet fit-check #1)、新規追加で 2.x を使う。serde feature gate は §3.1 #9 で `features = ["serde"]` 指定済 (Codex review v1→v2 反映) |
| 2 | `OnceLock<Mutex<Option<Arc<L1Inner>>>>` 内部の lock poisoning | Mutex が panic 中に poison しても `lock().unwrap_or_else(\|e\| e.into_inner())` で recover。本 PR の `ensure_l1` / `shutdown_l1_for_test` で defensive recovery 入れる |
| 3 | `ArrayQueue::force_push` の他 thread からの干渉 | crossbeam_queue::ArrayQueue は MPMC lock-free、複数 push スレッドで safe |
| 4 | event_id u64 overflow (~5×10^17 events) | 1k events/s で 1500 万年。実用上問題なし |
| 5 | `EventEnvelope.payload_bytes: Buffer` (Vec<u8> から複製) のクローンコスト | `From<&InternalEvent>` で `Buffer::from(e.payload.clone())`、典型 payload ~28-256 byte。100k poll/s でも ~25MB/s で問題なし |
| 6 | TS 側 polling 漏れで ring buffer 満杯 → drop-oldest 多発 | poll を hot path で確実に呼ぶ責務を ADR-010 P1 で明記、P5a の bench で drop_count の期待値を出す |
| 7 | `napi_safe_call` 拡大で AsyncTask 形式を誤って wrap して double-catch | Sonnet fit-check #2 で grep pattern 確認 |
| 8 | `crossbeam-queue` を新規依存に追加 → license/security チェック | crossbeam-queue は Apache-2.0 / MIT、security audit クリーン (UIA bridge で既使用の crossbeam-channel と同じ author) |
| 9 | `bincode = "2"` の serde 統合 | `bincode::serde::encode_to_vec` 経路で `serde::Serialize` derive struct を encode、`features = ["serde"]` で有効化 (Codex review v1→v2 反映) |
| 10 | Schema versioning の `envelope_version: u32 = 1` を mutate する将来 | bincode は前方互換性が低い、`envelope_version` 増分時は decoder 側で dispatch 必須。本 PR では encoder のみで decoder は P5b、変更 path は P5b で書く |
| 11 | `l1_push_hw_input_post_message` を `postMessageToHwnd` 内部に置くことの副次影響 | 既存 caller (bg-input.ts 6 sites + 将来の caller) すべて自動 instrument。利益、ただし「postMessage 失敗時にも push が出る」点を contract で明示 (本書 §8.3) |

---

## 13. Acceptance チェックリスト (PR description に貼る)

- [ ] `cargo check` clean
- [ ] `npm run build:rs` (release) produces working `.node`
- [ ] `npm run build` (tsc) clean
- [ ] `npm run lint` clean
- [ ] `npm run check:napi-safe` (SCAN_DIR 拡大後、AsyncTask 誤検出なし) passes
- [ ] `npm run check:native-types` passes (新 7 declare + 2 interface)
- [ ] `npm run check:no-koffi` passes (P4 acceptance carry over)
- [ ] `npm run check:stub-catalog` passes (MCP tool 数不変)
- [ ] `tests/unit/l1-capture.test.ts` (新規、~12 cases) 全 case pass
- [ ] `tests/unit/l1-capture-panic-fuzz.test.ts` (新規、~8 cases) 全 case pass
- [ ] 既存 `tests/unit/native-win32-panic-fuzz.test.ts` (現 91 cases) 回帰なし
- [ ] `npm run test:capture` 全 file pass (0 regression)
- [ ] **`scripts/bench-l1-ingest.mjs` で p99 < 1ms @ 10k events** (ADR-007 §6 P5a acceptance)
- [ ] PANIC_COUNTER hit が ring buffer に Failure event として流れること (1 case in panic-fuzz)
- [ ] worker thread shutdown が 1s 以内に完了 (`l1_shutdown_for_test` の戻り値で確認)
- [ ] worker shutdown → ensure_l1 再 init で再 start できること (5 回連続テスト)

---

## 14. Open Questions の処理 (ADR-007 §10)

| OQ # | 質問 | P5a での扱い |
|---|---|---|
| 1 | bincode vs capnproto vs flatbuffers | **bincode 採用** (§3.1 #9) |
| 2 | WAL rotation サイズ | **P5b に持ち越し** |
| 3 | DXGI dirty rect の secondary monitor 扱い | **P5c に持ち越し** |
| 4 | sub_ordinal per-source vs global | **per-source 採用** (§3.1 #7) |
| 5 | Intel PT 統合の ADR 帰属 | **本 ADR / 別 ADR は P5d 完了後** |
| 6 | drop oldest vs throttle producer | **drop oldest 採用** (§3.1 #5) |
| 7 | event_id u64 vs UUID | **u64 採用** (§3.1 #6) |
| 8 | proc_macro crate vs same crate | **P5a で proc_macro 化しない** ので保留 |

P5a で 4 件確定 (#1, #4, #6, #7)。残り 4 件は対応 phase に持ち越し。

---

## 15. Sonnet round 2 への引き継ぎ

Sonnet が本書を読んで:

1. §10 の **fit-check 項目 13 件** を順に確認、issue があれば「該当項目 + 具体的問題」を箇条書きで返す
2. **architectural critique は出さない** (出てきたら Opus round 3 で対応するが、原則控える)
3. 確認項目以外の編集提案 (typo / wording) は OK だが、構造変更は Opus 判断

Sonnet round 2 で 0 issue なら implementation 着手。残れば Opus round 3 で design v2 に修正、再度 Sonnet fit-check (max 1 round)。

---

## 16. v1 → v2 changelog (Codex round 1 review 反映)

Codex round 1 で 4 件の P1/P2 + 1 件の supplementary 指摘。すべて反映済。

### 16.1 P1: TS callers が bincode payload を作れない

**指摘**: 旧 §8.1 の `l1_push_event(kind: u16, payload: Buffer)` は generic API だが、TS には bincode encoder が無いので `bg-input.ts` 等の producer が実装不能。

**反映**: §8.1 を **per-EventKind typed helpers** (`l1_push_tool_call_started` / `l1_push_tool_call_completed` / `l1_push_hw_input_sent` / `l1_push_failure`) に置換。Rust 内部で payload struct を bincode encode、TS は **値を渡すだけ**。Heartbeat / SessionStart / SessionEnd は worker thread 専有で TS 公開せず。Replay 用の generic raw API は P5b で必要時に追加。

### 16.2 P1: `OnceLock<L1Worker>` の lifecycle が破綻

**指摘**: 旧 §7.1 の `OnceLock<L1Worker>` 直は drop/reset 不可、`JoinHandle::join` も std::thread には timeout API なし、`l1_shutdown_for_test` が `&'static L1Worker` から `Option::take` できない。100x shutdown test が成立しない。

**反映**: §7.1 を **`OnceLock<Mutex<Option<Arc<L1Inner>>>>`** パターンに rewrite。Mutex で interior mutability、Option で take 可能、Arc で `ensure_l1()` が clone 返却。`shutdown_with_timeout` は別 helper thread + `mpsc::recv_timeout` で manual timeout 実装。`l1_shutdown_for_test` 後に `ensure_l1()` を再呼ぶと再 init される (test の repeat 可)。§7.2 に Node.js process exit 時の挙動 (napi-rs cleanup hook) を追記。

### 16.3 P2: Buffer の所有権 / immutability

**指摘**: 旧 §5.1 の `EventEnvelope.payload_bytes: Buffer` は napi `Buffer` で JS 側 mutable。ring に直保存だと、JS が `l1_push_event` 後に元 Buffer を mutate すると ring 内 event の bytes が変わる (replay determinism 違反)。

**反映**: §5.1 を **`InternalEvent` (Vec<u8> 所有、ring 内保存) と `EventEnvelope` (Buffer、napi 公開のみ) を分離**。`From<&InternalEvent> for EventEnvelope` で poll 時に new allocation。§6.1 の ring buffer 実装を `ArrayQueue<InternalEvent>` に変更、poll で変換。

### 16.4 P2: bincode 2 の serde feature

**指摘**: 旧 §3.1 #9 の `bincode = "2"` だけでは `bincode::serde::encode_to_vec` が compile しない (bincode 2 で serde は feature-gated)。

**反映**: `bincode = { version = "2", features = ["serde"] }` + `serde = { version = "1", features = ["derive"] }` に変更。§3.1 #9、§9 commit 1、§10 fit-check #1 で反映。

### 16.5 補足: `nativeL1` export const + load detection

**指摘**: 旧 §8.2 は `NativeL1` interface のみ定義、`nativeL1` export const と load 判定が抜けていた。

**反映**: §8.2 に **`nativeWin32` と同パターンの `nativeL1` export const + `l1PushFailure` を probe key にした load detection + console.error log** を追記。§8.3 の `bg-input.ts` 呼び出し例も `nativeL1?.l1PushHwInputSent?.(...)` の null 安全 form に修正。

---

## 17. v2 → v3 changelog (Codex round 2 review 反映)

Codex round 2 で 3 件の P2/P3 指摘 (test/bench/bg-input/stale-text consistency)。すべて反映済。

### 17.1 P2: tests/bench が削除済 generic API を参照していた

**指摘**: §11.1 unit test と §11.2 bench plan が v2 で削除した `l1_push_event(kind, payload)` を呼んでおり、特に Heartbeat は worker-owned で TS 公開していないと §1.1 に書いた直後にテスト/ベンチ計画は `l1_push_event(EventKind.Heartbeat, ...)` を使うと書いていた。実装担当が impossible path に進む。

**反映**:
- §11.1 unit test を **`l1PushHwInputPostMessage` ベース**に書き直し。順序/監視/overflow 系テストはこの helper で十分カバー。「不正 EventKind」テストは TS 層から不可能 (typed helper には EventKind 引数なし) なので **削除**、代わりに Rust unit test で InternalEvent 直構築 → EventEnvelope 経由の wrap 動作を検証
- §11.2 bench を `l1PushHwInputPostMessage(0n, 0, 0n, 0n)` ベースに書き直し (~28 byte payload で benchmark 雑音最小)
- §11.3 panic-fuzz の "100 回連続 shutdown" を **5 回連続** に scope-cut (v2 の `OnceLock<Mutex<Option<Arc<>>>>` パターンで再 init 可能になったので 5 回で十分有意)

### 17.2 P2: bg-input.ts の hook 位置が実コードと合わない

**指摘**: v2 は「`nativeWin32.win32PostMessage` 呼び出しの直前」と書いていたが、`bg-input.ts` は `nativeWin32` を直接呼ばず `win32.ts::postMessageToHwnd` を 6 callsite で呼んでいる。指示通り bg-input に hook を入れると 6 箇所に重複コードが生まれる。

**反映**:
- §8.3 を **`win32.ts::postMessageToHwnd` 内部 hook 1 箇所** に書き直し。bg-input.ts は無修正、6 callsite が自動 instrument される + 将来の別 caller (terminal helper 等) も自動カバー
- §9 commit 6 の commit message を `bg-input push hook` → `postMessageToHwnd hook` に修正
- §10 fit-check item #8 を bg-input → postMessageToHwnd に更新
- §12 risk table に項目 #11 (postMessageToHwnd 内部 hook の副次影響) を追加

### 17.3 P3: stale text — v1 用の数値/型名残置

**指摘**: §13 acceptance チェックリストが `新 4 export declared` と書いていた (v2 は 7 declare + 2 interface)、§12 risk table の項目 2 が `OnceLock<L1Worker>` と v1 型名のまま、panic-fuzz cases を `91 cases` と現在のファイル状態でハードコード。

**反映**:
- §13 を `新 7 declare + 2 interface declared` / `~12 + ~8 cases of new tests` / 既存 91 を `回帰なし` 文言で表現に修正
- §12 risk #2 を `OnceLock<Mutex<Option<Arc<L1Inner>>>>` に更新、Mutex poison handling を軽く追記
- §12 risk #5 を `payload_bytes: Buffer (Vec<u8> から複製)` に Cargo Codex P2-buffer 指摘の反映を表記
- 全体スキャンで `OnceLock<L1Worker>` / `4 export` / `91 cases` 残置を grep して整合化

### 17.4 API 名の安定化 (Codex P2-bg-input の派生)

bg-input.ts の hook 位置を `postMessageToHwnd` に移したことで、payload を **Win32 PostMessage signature と 1:1 対応** させる方が clean。これに伴い API 名/payload を redesign:

- `l1_push_hw_input_sent(method, target_hwnd, key_or_button, modifiers)` → **`l1_push_hw_input_post_message(target_hwnd, msg, w_param, l_param)`** に rename
- payload struct `HwInputSentPayload` → **`HwInputPostMessagePayload { target_hwnd, msg, w_param, l_param }`**
- TS interface `l1PushHwInputSent` → **`l1PushHwInputPostMessage`**
- EventKind は変えない (HwInputSent = 102 まま、SendInput 用 helper は将来同 kind で別 payload struct 追加)
- `wParam` / `lParam` は **BigInt 受け** (PR #77 Codex P1 と同じ sign-preserve 規約、`get_i64` で受けて `as usize` / `as isize` で bit reinterpret)

§5.2 / §8.1 / §8.2 / §8.3 / §10 fit-check #5, #6, #8 / §11 / §17.4 で名前を全部統一。

---

## 18. v3 → v4 changelog (Sonnet fit-check round 1 反映)

Sonnet fit-check round 1 で 1 件 CI blocker + 3 件 minor (vitest config 訂正 / napi-rs cleanup hook 確認 / module 構成補足)。すべて反映済。

### 18.1 (CI blocker) `detect_capability` の SCAN_DIR 拡大違反

**指摘**: `src/vision_backend/capability.rs::detect_capability` は sync `#[napi]` だが `napi_safe_call` で wrap されていない。module レベル `#[cfg(feature = "vision-gpu")]` で gate されているが、per-fn `#[cfg]` 属性は無いので `check-napi-safe.mjs` の backward-scan は gate を発見できない。SCAN_DIR を `src/` 全体に拡大すると CI 違反として検出される。

**反映**:
- §9 commit 5 の scope に `src/vision_backend/capability.rs` を追加
- §10 fit-check #2 に CI blocker 説明を追記、option A (同 commit で wrap) を確定
- §10 fit-check #10 を **5 関数** (`compute_change_fraction` / `dhash_from_raw` / `hamming_distance` / lib.rs `detect_capability` stub / vision_backend `detect_capability`) に拡張、AsyncTask 例外を明示

### 18.2 (minor) vitest `testTimeout` 既定値訂正

**指摘**: §10 fit-check #13 で「`testTimeout: 5_000` を pass timeout で書く」と書いていたが、`vitest.config.ts` の `unit` project は既に `testTimeout: 10_000` を設定済。個別テストでの timeout pass は不要。

**反映**: §10 fit-check #13 を「10s 既定で十分、個別 timeout pass 不要」に訂正。

### 18.3 (minor) napi-rs cleanup hook 利用可確認

**指摘**: §10 fit-check #14 で「Sonnet 確認、無ければ test-only で運用」と保留にしていたが、napi-rs 2.16.17 で `Env::add_env_cleanup_hook` が `#[cfg(feature = "napi3")]` gate で利用可、本プロジェクトの `napi = { features = ["napi8"] }` が含意するので **production cleanup hook として実装可**。

**反映**: §10 fit-check #14 を「確認済み・利用可」に更新、登録タイミング (`#[napi(module_init)]` または init 専用 `#[napi]` 関数の env 引数経由) を明記。

### 18.4 (minor) `PANIC_COUNTER` cross-module reference

**指摘**: §4 module diagram で `src/l1_capture/napi.rs` から `src/win32/safety.rs::PANIC_COUNTER` を参照する点が明示されていなかった。

**反映**: §4 module diagram に `use crate::win32::safety::PANIC_COUNTER;` の comment 追加。

### 18.5 Sonnet "Beyond fit-check" 観察事項 (実装メモ)

Sonnet が "fit-check 外" として軽く言及した 3 点。実装時に意識すれば足りる、design 変更不要:

- **`worker_loop` の `catch_unwind(AssertUnwindSafe(...))` で `Receiver<()>` 捕捉**: `crossbeam_channel::Receiver` は 0.8+ で `UnwindSafe`、`AssertUnwindSafe` は blanket safety で OK
- **`l1_push_hw_input_post_message` の `lParam: BigInt` を `get_i64()` で受ける**: §17.4 changelog で書いた sign-preserve 規約 (PR #77 教訓)。implementation 時に `.get_u64()` を使ったら逆戻り、必ず `.get_i64()` を使う
- **`PANIC_COUNTER` cross-module visibility**: `src/win32/safety.rs::PANIC_COUNTER` は `pub static` で crate 内可視。`src/l1_capture/napi.rs` の `l1_get_capture_stats` は `use crate::win32::safety::PANIC_COUNTER;` で参照可

---

END OF P5A DESIGN PROPOSAL v4 (Opus draft, Codex 1+2 + Sonnet fit-check 反映済、Approved for implementation).
