# Phase 4b-5 設計書 — Stage pipeline orchestration framework

- Status: Implemented (2026-04-25、commits d4a6244 / c539680 / 31f4f94 / ADR flip)
- 設計者: Claude (Opus 4.7)
- 実装担当: **Sonnet** (handbook §2 Step B)
- レビュー担当: Opus 4.7 (別 subagent)
- 対応 ADR-005 セクション: D1' (Rust backend) / D3' (multi-engine + cross-check pathway) / D5' (multi-stage detector)
- 対応 ADR-005 §5 batch: 4b-5 (ただし **framework のみ**、実 preprocess/postprocess は 4b-5a/b/c sub-batch)
- 前提 commits: `c4a9a7f`〜`a50826f` (Phase 4a + 4b-1 + 4b-3 + 4b-4 完了)
- 期待工数: **3-4 日 (Sonnet 実装、Rust + TS 両側)**

---

## 1. Goal

ADR-005 §3 D5' Multi-stage 検出器 (Stage 1 = Florence-2-base region proposer /
Stage 2 = OmniParser-v2 UI detector / Stage 3 = PaddleOCR-v4 OCR) を
**直列で動かすための orchestration framework** を構築する。各 stage の
実 preprocess / session.run() / postprocess は **stub 実装** で置き換え、
後続 sub-batch (4b-5a/b/c) で順に差し替え可能な形にする。

単一目標:

> `OnnxBackend.ensureWarm` が 3 つの session (Stage 1/2/3 モデル) を
> `visionInitSession` で初期化し、`OnnxBackend.recognizeRois` が
> 3 stage 直列呼び出しを成功させ、最終出力 `UiEntityCandidate[]` が
> stage2 の rect + stage3 の label を merge した形で返る。
> 実モデル無し (stub inference) でも wiring end-to-end が green。

### 明示的に本 batch の scope 外 (4b-5a/b/c 以降)

- 各モデルの **実 preprocess / postprocess / ort::Session::run**
  (現状 Rust 側は `dummy_recognise` — 1 ROI → 1 RawCandidate、空 label)
- Stage 3 class-aware dispatcher (PaddleOCR-v4 vs PaddleOCR-mobile vs GOT-OCR2)
- Cross-check (D3' multi-engine voting) — 4b-6
- Stage 4 state classifier / Stage 5 relationship GNN / Stage 6 DSL — Phase 4c
- Real model artifact のダウンロード実装 — 4b-5 でも必要だが本 batch は
  **「artifact 不在時も framework が crash せず fallback path を通る」** の保証のみ
  実ダウンロードは別 batch または 4b-7 bench 直前
- Rust 側 `recognize_rois_blocking` の session-aware 動作拡張 (session pool lookup
  は実装するが、**session 取得後のモデル推論は stub**、既存 dummy 動作を session pool
  対応に置き換えるだけ)

---

## 2. Files to touch

### 新規作成

| Path | 役割 | 推定行数 |
|---|---|---|
| `src/engine/vision-gpu/stage-pipeline.ts` | Stage 1→2→3 直列 orchestrator (TS-side pure function + class) | ~200 |
| `src/vision_backend/session_pool.rs` | `VisionSessionPool` 実装 (HashMap<session_key, Arc<VisionSession>>) + global accessor | ~120 |
| `tests/unit/stage-pipeline.test.ts` | Stage pipeline の orchestration テスト (mocked native binding) | ~250 |

### 変更

| Path:行 | 変更内容 |
|---|---|
| `src/vision_backend/mod.rs` | `pub mod session_pool;` 追加、`pub use session_pool::VisionSessionPool` 追加 |
| `src/vision_backend/types.rs::RecognizeRequest` | `session_key: String` field を追加 (非空の時 pool lookup、空の時 legacy dummy path) |
| `src/vision_backend/mod.rs::init_session_blocking` | session 作成成功時に `global_pool().insert(session_key, Arc::new(sess))` を追加、**session は drop せず pool に保持** |
| `src/vision_backend/inference.rs::recognize_rois_blocking` | `req.session_key` が非空なら `global_pool().get(&req.session_key)` で lookup、存在すれば **stub inference** (既存 dummy を session-bound に再配線、model_path を log 用に読み出し可)、不在なら legacy dummy path |
| `src/vision_backend/inference.rs::VisionSessionPool` (既存 placeholder) | **削除** (`session_pool.rs` に本実装を移す、既存は空 struct なので置換) |
| `src/engine/native-types.ts::NativeRecognizeRequest` | `sessionKey: string` field 追加 (camelCase) |
| `src/engine/vision-gpu/onnx-backend.ts::ensureWarm` | `ModelRegistry.loadManifestFromFile` + 3 model × `visionInitSession` 呼び出し、session_keys をインスタンスに保持。artifact 不在 / session init 失敗で warm=failed に遷移 (既存 "warm" / "evicted" に追加する新状態 "failed"、または "evicted" 再利用) |
| `src/engine/vision-gpu/onnx-backend.ts::recognizeRois` | `stage-pipeline.ts` の `runStagePipeline` を呼んで 3-stage 結果を返す |
| `src/engine/vision-gpu/types.ts::WarmState` | 必要なら "failed" state を追加 (または "evicted" を使い回す — §3.3 参照) |
| `src/engine/vision-gpu/onnx-backend.ts::dispose` | pool 内の session を retire (本 batch では TS 側で session_keys を clear するのみ、Rust 側の pool drop は 4b-5c 以降で考慮) |
| `tests/unit/visual-gpu-onnx-backend.test.ts` (追記) | stage pipeline 経路の mock 検証 1-2 ケース追加 (既存 `ensureWarm`/`recognizeRois` テストは temporarily skip 化せず **書換禁止**、新規追記のみ) |
| `docs/visual-gpu-backend-adr-v2.md §5 4b-5 checklist` | `[x]` flip + summary (framework のみ、sub-batch 分岐の経緯明記) |

### 削除禁止

- `src/engine/vision-gpu/onnx-backend.ts` の既存 public method の **signature**
  (`ensureWarm` / `recognizeRois` / `getStableCandidates` / `onDirty` / `dispose` / `getWarmState` / `updateSnapshot` / `isAvailable`) — 戻り値型と引数は不変
- `src/engine/vision-gpu/model-registry.ts` の全 method (4b-4 成果物維持)
- Phase 4a の `PocVisualBackend` / `bin/win-ocr.exe` / `DESKTOP_TOUCH_ENABLE_ONNX_BACKEND` / `DESKTOP_TOUCH_DISABLE_VISUAL_GPU` kill-switch
- Phase 4b-1 の `SelectedEp` variants / `webgpu_attempt` / EP cascade
- Phase 4b-3 の `SelectedEp::WebGPU { adapter }` / `webgpu_attempt`
- Phase 4b-4 の `isCpuOnlyVariant` tier + EpName rename + assets/models.json
- Rust `inference.rs::recognize_rois_blocking` の `catch_unwind` barrier (L5、絶対不変)
- Rust `session.rs::try_one_ep` の `catch_unwind` barrier (L5)
- Rust `session.rs::VisionSession::create` の signature

### Forbidden な依存追加

- 新 npm package 追加禁止 (stage pipeline は既存 Map/Promise/async で実装)
- 新 Rust crate 追加禁止 (HashMap / Mutex / OnceLock は std)
- `package.json` / `Cargo.toml` 変更禁止 (feature flag / dependency の新規追加なし)

---

## 3. API design

### 3.1 Rust: `VisionSessionPool` (新規 `session_pool.rs`)

```rust
//! VisionSessionPool — global session cache keyed by `session_key`.
//!
//! Each successful `init_session_blocking` inserts the session here; each
//! `recognize_rois_blocking` with a non-empty session_key looks it up and
//! reuses the bound ort::Session. This eliminates the re-loading cost on
//! every inference call and keeps GPU buffers allocated for the session lifetime.
//!
//! Thread-safety: std::sync::Mutex over a HashMap. Contention is expected to
//! be low — session_key lookups are O(1) under the lock, and actual inference
//! runs against the session's internal Arc<Mutex<ort::Session>> which is
//! independent of this top-level pool lock.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use crate::vision_backend::session::VisionSession;

static POOL: OnceLock<VisionSessionPool> = OnceLock::new();

/// Acquire the process-wide session pool. Created lazily on first call.
pub fn global_pool() -> &'static VisionSessionPool {
    POOL.get_or_init(VisionSessionPool::new)
}

pub struct VisionSessionPool {
    inner: Mutex<HashMap<String, Arc<VisionSession>>>,
}

impl VisionSessionPool {
    pub fn new() -> Self {
        Self { inner: Mutex::new(HashMap::new()) }
    }

    /// Insert a session under the given key. Replaces any prior entry with
    /// the same key (the old Arc is dropped when the last borrow returns).
    pub fn insert(&self, key: String, session: Arc<VisionSession>) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.insert(key, session);
        }
        // If the mutex is poisoned, silently drop — L5 says never panic here.
    }

    /// Look up a session by key. Returns None if absent or the mutex is poisoned.
    pub fn get(&self, key: &str) -> Option<Arc<VisionSession>> {
        self.inner.lock().ok().and_then(|g| g.get(key).cloned())
    }

    /// Remove a session from the pool (used by dispose/retire).
    pub fn remove(&self, key: &str) -> Option<Arc<VisionSession>> {
        self.inner.lock().ok().and_then(|mut g| g.remove(key))
    }

    /// Current pool size. Primarily for tests / diagnostics.
    pub fn len(&self) -> usize {
        self.inner.lock().map(|g| g.len()).unwrap_or(0)
    }

    /// True when the pool has no entries.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Default for VisionSessionPool {
    fn default() -> Self { Self::new() }
}
```

### 3.2 Rust: `RecognizeRequest` に `session_key` 追加

```rust
// Before (types.rs::RecognizeRequest)
#[napi(object)]
#[derive(Clone, Debug)]
pub struct RecognizeRequest {
    pub target_key: String,
    pub rois: Vec<RoiInput>,
    pub frame_width: u32,
    pub frame_height: u32,
    pub now_ms: f64,
}

// After (Phase 4b-5)
#[napi(object)]
#[derive(Clone, Debug)]
pub struct RecognizeRequest {
    pub target_key: String,
    /// Session key from `init_session_blocking`. Empty string → legacy dummy path
    /// (kept for Phase 4a backward-compat with tests / PocVisualBackend migration).
    pub session_key: String,
    pub rois: Vec<RoiInput>,
    pub frame_width: u32,
    pub frame_height: u32,
    pub now_ms: f64,
}
```

**Back-compat**: field 追加は napi で safe (optional 扱いにはしない — 明示的な空文字列で
legacy path を示す)。TS 側の既存 test が `session_key` を渡していないなら型エラーに
なるが、TS 側は `NativeRecognizeRequest` interface が別定義なのでそちらの更新で揃える。

### 3.3 Rust: `init_session_blocking` の pool insert

```rust
// mod.rs::init_session_blocking の match 成功ブランチを改修

match session::VisionSession::create(path, &init.profile, init.session_key.clone()) {
    Ok(sess) => {
        let label = sess.selected_ep_label();
        // Phase 4b-5: insert into pool so subsequent recognize_rois_blocking
        // calls can look it up by session_key. If session_key is empty, we
        // still insert under "" — but the pool treats "" as a legitimate key
        // (caller decides not to send session_key in recognize_rois for
        // the legacy path, so "" entries are harmless).
        crate::vision_backend::session_pool::global_pool()
            .insert(init.session_key.clone(), std::sync::Arc::new(sess));
        NativeSessionResult {
            ok: true,
            selected_ep: label,
            error: None,
            session_key: init.session_key,
        }
    }
    Err(e) => NativeSessionResult { /* unchanged */ },
}
```

### 3.4 Rust: `recognize_rois_blocking` の session lookup

```rust
// inference.rs::recognize_rois_blocking を改修
pub fn recognize_rois_blocking(req: RecognizeRequest) -> Result<Vec<RawCandidate>, VisionBackendError> {
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        if !req.session_key.is_empty() {
            // Phase 4b-5: session-bound stub path
            if let Some(sess) = crate::vision_backend::session_pool::global_pool().get(&req.session_key) {
                return stub_recognise_with_session(req, sess);
            }
            // session_key requested but absent — emit a single empty fallback
            // candidate list so TS can tell "session not ready" from "no ROIs"
            // via `raw.length === 0 && input.rois.length > 0`.
            return Vec::new();
        }
        // Legacy dummy path (Phase 4a compatible)
        dummy_recognise(req)
    }));
    match result {
        Ok(out) => Ok(out),
        Err(payload) => Err(VisionBackendError::InferencePanic(panic_payload_to_string(payload))),
    }
}

/// Phase 4b-5 stub inference. Reuses `dummy_recognise` body and tags each
/// candidate with `selected_ep` info for downstream tracing. Real preprocess /
/// session.run() / postprocess go into 4b-5a/b/c as drop-in replacements.
fn stub_recognise_with_session(req: RecognizeRequest, _sess: std::sync::Arc<crate::vision_backend::session::VisionSession>) -> Vec<RawCandidate> {
    // The dummy body matches Phase 4a behavior: 1 RawCandidate per input ROI,
    // empty label, provisional=true, class from class_hint or "other".
    //
    // Keeping the stub identical to dummy_recognise makes 4b-5 a pure wiring
    // change — no test output drift for existing dummy-path tests.
    dummy_recognise(req)
}
```

**Note**: `stub_recognise_with_session` は現状 `dummy_recognise` と同一挙動。
4b-5a 以降で preprocess → `sess.lock().run(...)` → postprocess の本体に
置き換える差し込み点。`_sess` 引数は framework wiring の存在証明 (未使用 lint 抑止用に `_`)。

### 3.5 Rust: `inference.rs::VisionSessionPool` 既存 placeholder の整理

既存 (inference.rs L67-74) の空 struct `VisionSessionPool` と `new()` は
**削除** する。新実装は `session_pool.rs` に独立モジュールとして作成。
`mod.rs::pub use inference::VisionSessionPool` も
`mod.rs::pub use session_pool::VisionSessionPool` に変更。

### 3.6 TS: `stage-pipeline.ts` 新規 module

```typescript
/**
 * stage-pipeline.ts — Stage 1→2→3 serial orchestrator (Phase 4b-5).
 *
 * Runs three `visionRecognizeRois` calls in sequence, feeding rects from each
 * stage's output into the next. The resulting candidates merge stage 2's
 * rect/class with stage 3's label.
 *
 * Phase 4b-5 scope: orchestration only. Each stage's inference is currently
 * stubbed on the Rust side (returns input ROIs echoed back). Sub-batches
 * 4b-5a (Florence-2) / 4b-5b (OmniParser-v2) / 4b-5c (PaddleOCR-v4) drop in
 * the real preprocess/postprocess per stage without touching this module.
 */

import type { NativeRecognizeRequest, NativeRawCandidate } from "../native-types.js";

export interface StageSessionKeys {
  /** Session key for the Stage 1 model (region proposer, e.g. florence-2-base). */
  stage1: string;
  /** Session key for the Stage 2 model (UI detector, e.g. omniparser-v2-icon-detect). */
  stage2: string;
  /** Session key for the Stage 3 model (OCR recognizer, e.g. paddleocr-v4-server). */
  stage3: string;
}

export interface StagePipelineInput {
  targetKey: string;
  rois: NativeRecognizeRequest["rois"];
  frameWidth: number;
  frameHeight: number;
  nowMs: number;
}

export type VisionRecognizeFn = (req: NativeRecognizeRequest) => Promise<NativeRawCandidate[]>;

/**
 * Run the 3-stage pipeline. Returns Stage 2 candidates with Stage 3 labels
 * merged in by trackId. Throws only when visionRecognizeRois itself rejects
 * (caller wraps in try/catch — see onnx-backend.ts recognizeRois).
 */
export async function runStagePipeline(
  keys: StageSessionKeys,
  input: StagePipelineInput,
  visionRecognize: VisionRecognizeFn,
): Promise<NativeRawCandidate[]> {
  // Stage 1: region proposals
  const stage1 = await visionRecognize({
    targetKey: input.targetKey,
    sessionKey: keys.stage1,
    rois: input.rois,
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    nowMs: input.nowMs,
  });
  if (stage1.length === 0) return [];

  // Stage 2: fine UI element detection inside each region
  const stage2 = await visionRecognize({
    targetKey: input.targetKey,
    sessionKey: keys.stage2,
    rois: stage1.map((c) => ({
      trackId: c.trackId,
      rect: c.rect,
      classHint: c.class || null,
    })),
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    nowMs: input.nowMs,
  });
  if (stage2.length === 0) return [];

  // Stage 3: OCR over text-class candidates only (class-aware dispatch)
  const textCandidates = stage2.filter((c) => isTextClass(c.class));
  if (textCandidates.length === 0) {
    // No text to OCR — return stage 2 as final output unchanged.
    return stage2;
  }
  const stage3 = await visionRecognize({
    targetKey: input.targetKey,
    sessionKey: keys.stage3,
    rois: textCandidates.map((c) => ({
      trackId: c.trackId,
      rect: c.rect,
      classHint: c.class || null,
    })),
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    nowMs: input.nowMs,
  });

  // Merge stage 3 labels into stage 2 candidates keyed by trackId.
  const labelByTrackId = new Map<string, string>();
  for (const c of stage3) {
    if (c.label) labelByTrackId.set(c.trackId, c.label);
  }
  return stage2.map((c) => {
    const ocrLabel = labelByTrackId.get(c.trackId);
    return ocrLabel ? { ...c, label: ocrLabel } : c;
  });
}

function isTextClass(cls: string): boolean {
  // Matches ADR D3' class-aware dispatch — text / label / icon classes get OCR
  // (icon for short description read by VLM). Phase 4b-5a/b/c may refine.
  return cls === "text" || cls === "label" || cls === "title" || cls === "icon" || cls === "mixed";
}
```

### 3.7 TS: `OnnxBackend.ensureWarm` 再設計

```typescript
// onnx-backend.ts — ensureWarm を再実装
import { ModelRegistry, type ModelVariant } from "./model-registry.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "assets");
const MANIFEST_PATH = join(ASSETS_DIR, "models.json");

// OnnxBackend class に以下フィールド追加
private stageKeys: StageSessionKeys | null = null;
private readonly registry = new ModelRegistry();

// Phase 4b-5 refactor of ensureWarm
async ensureWarm(target: WarmTarget): Promise<WarmState> {
  if (!OnnxBackend.isAvailable()) {
    this.state = "evicted";
    return this.state;
  }
  // Idempotent: if already warm, short-circuit.
  if (this.state === "warm" && this.stageKeys !== null) return "warm";

  // Load bundled manifest (fallback gracefully if missing — treat as evicted).
  try {
    this.registry.loadManifestFromFile(MANIFEST_PATH);
  } catch (err) {
    console.error("[onnx-backend] manifest load failed:", err);
    this.state = "evicted";
    return this.state;
  }

  const profile = nativeVision!.detectCapability!();
  const stage1Model = "florence-2-base";
  const stage2Model = "omniparser-v2-icon-detect";
  const stage3Model = "paddleocr-v4-server";

  const stage1Variant = this.registry.selectVariant(stage1Model, profile);
  const stage2Variant = this.registry.selectVariant(stage2Model, profile);
  const stage3Variant = this.registry.selectVariant(stage3Model, profile);

  if (!stage1Variant || !stage2Variant || !stage3Variant) {
    console.error("[onnx-backend] selectVariant returned null for one or more stages");
    this.state = "evicted";
    return this.state;
  }

  const keys = await this.initStageSessions(stage1Model, stage1Variant, stage2Model, stage2Variant, stage3Model, stage3Variant);
  if (!keys) {
    this.state = "evicted";
    return this.state;
  }
  this.stageKeys = keys;
  this.state = "warm";
  return this.state;
}

private async initStageSessions(
  s1Name: string, s1: ModelVariant,
  s2Name: string, s2: ModelVariant,
  s3Name: string, s3: ModelVariant,
): Promise<StageSessionKeys | null> {
  const profile = nativeVision!.detectCapability!();
  const results = await Promise.all([
    this.initOne(s1Name, s1, profile),
    this.initOne(s2Name, s2, profile),
    this.initOne(s3Name, s3, profile),
  ]);
  if (results.some((r) => r === null)) return null;
  return { stage1: results[0]!, stage2: results[1]!, stage3: results[2]! };
}

/**
 * Initialise one ORT session via visionInitSession. Returns the session_key
 * on success, null on artifact absence / session init failure. The Rust side
 * is panic-isolated (L5) so this never throws for inference failures.
 *
 * Artifact absence path: if the model file is not on disk, we still invoke
 * visionInitSession — the native side attempts to commit_from_file and returns
 * `ok: false, error: "..."`. We treat that as soft-failure for the stage.
 */
private async initOne(modelName: string, variant: ModelVariant, profile: NativeCapabilityProfile): Promise<string | null> {
  const modelPath = this.registry.pathFor(modelName, variant);
  const sessionKey = `${modelName}:${variant.name}`;
  try {
    const res = await nativeVision!.visionInitSession!({
      modelPath,
      profile,
      sessionKey,
    });
    if (!res.ok) {
      console.error(`[onnx-backend] session init failed for ${sessionKey}: ${res.error ?? "unknown"}`);
      return null;
    }
    return res.sessionKey;
  } catch (err) {
    console.error(`[onnx-backend] visionInitSession threw for ${sessionKey}:`, err);
    return null;
  }
}
```

### 3.8 TS: `OnnxBackend.recognizeRois` 再配線

```typescript
async recognizeRois(
  targetKey: string,
  rois: RoiInput[],
  frameWidth?: number,
  frameHeight?: number,
): Promise<UiEntityCandidate[]> {
  if (!OnnxBackend.isAvailable() || !nativeVision?.visionRecognizeRois) return [];
  if (rois.length === 0) return [];
  if (this.state !== "warm" || this.stageKeys === null) {
    // Not warmed up — caller should have awaited ensureWarm first. Fall back
    // to empty to keep visual lane non-blocking (L5 spirit).
    return [];
  }

  const nativeRois = rois.map((r) => ({
    trackId: r.trackId,
    rect: { ...r.rect },
    classHint: r.classHint ?? null,
  }));
  const input: StagePipelineInput = {
    targetKey,
    rois: nativeRois,
    frameWidth: frameWidth ?? this.opts.defaultFrameWidth ?? 0,
    frameHeight: frameHeight ?? this.opts.defaultFrameHeight ?? 0,
    nowMs: Date.now(),
  };

  let raw: NativeRawCandidate[];
  try {
    raw = await runStagePipeline(
      this.stageKeys,
      input,
      (req) => nativeVision!.visionRecognizeRois!(req),
    );
  } catch (err) {
    console.error("[onnx-backend] runStagePipeline failed:", err);
    return [];
  }
  const candidates = raw.map((c) => mapRawToCandidate(c, targetKey));
  this.snapshots.set(targetKey, candidates);
  for (const cb of this.listeners) {
    try { cb(targetKey); } catch { /* one bad listener must not break others */ }
  }
  return candidates;
}
```

### 3.9 TS: `WarmState` に "failed" 追加するか?

既存: `"cold" | "warm" | "evicted"` (types.ts)。

「session init failed」状態を明示したい誘惑があるが、**本 batch では追加しない**
(新規 variant 追加は既存下流 consumer の型穴を誘発、§9 scope change 相当)。
代わりに `state="evicted"` を再利用して「artifact 未揃い or session init 失敗」を示す
(既存 semantics「利用不可」と一致)。

### 3.10 Rust `dispose` 側の session pool retire

本 batch では TS `dispose` で `stageKeys = null` にするだけ (Rust 側 pool は
process 生存中残存)。pool からの remove は **4b-5c 以降** (全 stage 実装完了後) に
`vision_retire_session(session_key)` napi を追加して実装。本 batch では Rust pool
の `len()` が process 内で monotonically 増加するだけだが、session 数が高々 3 つ
(Stage 1/2/3) なので問題なし。

---

## 4. Stage pipeline 挙動 (stub 時)

```text
Input (from DirtyRectRouter):
  rois = [{trackId: "t1", rect: R1}, {trackId: "t2", rect: R2}, ...]

Stage 1 (Florence-2 stub):
  → native returns 1 RawCandidate per ROI, class_hint or "other" として class
  出力: [{trackId: "t1", rect: R1, class: "other", label: ""}, ...]

Stage 2 (OmniParser-v2 stub):
  入力: Stage 1 の出力を rois に再 wrapping (rect 維持、classHint = stage1.class)
  → native 同じ dummy 挙動、class = class_hint = "other"
  出力: [{trackId: "t1", rect: R1, class: "other", label: ""}, ...]

Stage 3 (PaddleOCR stub):
  入力: Stage 2 で isTextClass(class) == true のもののみ
  stub では class == "other" で isTextClass(other) = false → Stage 3 skip
  最終出力 = Stage 2 そのまま

実モデル投入後 (4b-5a/b/c 完了時):
  Stage 1: class が "region" / "form" / "panel" 等に埋まる
  Stage 2: class が "text" / "button" / "checkbox" 等に細分化
  Stage 3: class == "text" の label が OCR 結果で埋まる
```

**stub 時の test assertion**:
- `recognizeRois` の戻り値 `UiEntityCandidate[]` が `rois.length` と等しい
- 各 candidate の `label === undefined` (empty 変換で undefined、既存 mapRawToCandidate L158)
- `role` は class_hint または "unknown"
- stage1/stage2/stage3 それぞれ `visionRecognizeRois` が 1 回ずつ呼ばれる (isTextClass=false で stage3 skip 挙動の方がデフォルト) — または `classHint: "text"` を投入した test で stage3 呼ばれる assertion

---

## 5. Done criteria (binary check)

- [ ] `cargo check --release --features vision-gpu` exit 0
- [ ] `cargo check --release --features vision-gpu,vision-gpu-webgpu` exit 0
- [ ] `cargo check --release --no-default-features` exit 0
- [ ] `tsc --noEmit` exit 0
- [ ] `npx vitest run --project=unit "tests/unit/stage-pipeline.test.ts"` 全パス
- [ ] `npx vitest run --project=unit "tests/unit/visual-gpu-onnx-backend.test.ts"` 全パス (既存 + 新規)
- [ ] `npx vitest run --project=unit "tests/unit/visual-gpu-model-registry.test.ts"` 既存全パス (regression 0)
- [ ] `npx vitest run --project=unit "tests/unit/visual-gpu-session.test.ts"` 既存全パス (regression 0)
- [ ] 最終 `npm run test:capture -- --force` **1 回のみ**: 2001+ pass / 2 pre-existing e2e (regression 0)
- [ ] ADR-005 §5 4b-5 checklist `[x]` flip、4b-5a/b/c sub-batch として remainder を明記
- [ ] 本設計書 Status を `Implemented (2026-04-??、commit hash)` に更新
- [ ] Opus self-review BLOCKING 0

---

## 6. Test cases

### 6.1 `tests/unit/stage-pipeline.test.ts` 新規 (最低 6 case)

```typescript
describe("runStagePipeline (Phase 4b-5)", () => {
  const baseInput: StagePipelineInput = {
    targetKey: "window:1",
    rois: [{ trackId: "t1", rect: { x: 0, y: 0, width: 100, height: 50 }, classHint: null }],
    frameWidth: 1920, frameHeight: 1080, nowMs: 0,
  };
  const keys: StageSessionKeys = { stage1: "s1", stage2: "s2", stage3: "s3" };

  it("invokes stage1 then stage2, skipping stage3 when no text-class candidates", async () => {
    const calls: Array<{ sessionKey: string }> = [];
    const recognize: VisionRecognizeFn = async (req) => {
      calls.push({ sessionKey: req.sessionKey });
      return req.rois.map((r) => ({ trackId: r.trackId, rect: r.rect, label: "", class: "other", confidence: 0.5, provisional: true }));
    };
    const out = await runStagePipeline(keys, baseInput, recognize);
    expect(calls.map(c => c.sessionKey)).toEqual(["s1", "s2"]);   // no s3
    expect(out).toHaveLength(1);
    expect(out[0].class).toBe("other");
  });

  it("invokes all 3 stages when stage2 yields text-class candidates", async () => {
    let nth = 0;
    const calls: string[] = [];
    const recognize: VisionRecognizeFn = async (req) => {
      calls.push(req.sessionKey);
      nth++;
      return req.rois.map((r, idx) => ({
        trackId: r.trackId,
        rect: r.rect,
        label: nth === 3 ? `ocr-${idx}` : "",
        class: nth === 2 ? "text" : r.classHint ?? "other",
        confidence: 0.5,
        provisional: true,
      }));
    };
    const out = await runStagePipeline(keys, baseInput, recognize);
    expect(calls).toEqual(["s1", "s2", "s3"]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("ocr-0");   // stage3 label merged into stage2
    expect(out[0].class).toBe("text");    // stage2 class retained
  });

  it("returns [] when stage1 returns empty (early exit)", async () => {
    const calls: string[] = [];
    const recognize: VisionRecognizeFn = async (req) => { calls.push(req.sessionKey); return []; };
    const out = await runStagePipeline(keys, baseInput, recognize);
    expect(calls).toEqual(["s1"]);   // no stage2, no stage3
    expect(out).toEqual([]);
  });

  it("returns stage2 output when stage2 has candidates but stage3 returns empty", async () => {
    let nth = 0;
    const recognize: VisionRecognizeFn = async (req) => {
      nth++;
      if (nth === 3) return [];   // stage3 returns empty
      return req.rois.map((r) => ({ trackId: r.trackId, rect: r.rect, label: "", class: "text", confidence: 0.7, provisional: false }));
    };
    const out = await runStagePipeline(keys, baseInput, recognize);
    expect(out).toHaveLength(1);
    expect(out[0].class).toBe("text");
    expect(out[0].label).toBe("");    // stage3 produced no label
  });

  it("merges stage3 labels by trackId (subset match)", async () => {
    const input: StagePipelineInput = {
      ...baseInput,
      rois: [
        { trackId: "a", rect: { x: 0, y: 0, width: 10, height: 10 }, classHint: null },
        { trackId: "b", rect: { x: 0, y: 0, width: 10, height: 10 }, classHint: null },
      ],
    };
    let nth = 0;
    const recognize: VisionRecognizeFn = async (req) => {
      nth++;
      if (nth === 1) {
        return req.rois.map(r => ({ trackId: r.trackId, rect: r.rect, label: "", class: "region", confidence: 0.5, provisional: true }));
      }
      if (nth === 2) {
        return [
          { trackId: "a", rect: req.rois[0]!.rect, label: "", class: "text", confidence: 0.5, provisional: true },
          { trackId: "b", rect: req.rois[1]!.rect, label: "", class: "button", confidence: 0.5, provisional: true },
        ];
      }
      // stage3: only "a" is text, returns OCR label
      return [{ trackId: "a", rect: req.rois[0]!.rect, label: "Submit", class: "text", confidence: 0.8, provisional: false }];
    };
    const out = await runStagePipeline(keys, input, recognize);
    expect(out).toHaveLength(2);
    expect(out.find(c => c.trackId === "a")?.label).toBe("Submit");
    expect(out.find(c => c.trackId === "b")?.label).toBe("");     // untouched
  });

  it("propagates rejection from any stage (caller handles)", async () => {
    const recognize: VisionRecognizeFn = async () => { throw new Error("simulated ort panic"); };
    await expect(runStagePipeline(keys, baseInput, recognize)).rejects.toThrow(/simulated/);
  });
});
```

### 6.2 `tests/unit/visual-gpu-onnx-backend.test.ts` 追記 (最低 3 case、既存書換禁止)

```typescript
describe("OnnxBackend Phase 4b-5 stage pipeline integration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("ensureWarm loads manifest, initialises 3 sessions, transitions to warm", async () => {
    const initCalls: string[] = [];
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        visionInitSession: vi.fn().mockImplementation(async (req: NativeSessionInit) => {
          initCalls.push(req.sessionKey);
          return { ok: true, selectedEp: "DirectML(0)", error: null, sessionKey: req.sessionKey };
        }),
        visionRecognizeRois: vi.fn(),
        detectCapability: vi.fn().mockReturnValue({
          os: "windows", osBuild: 26100, gpuVendor: "AMD", gpuDevice: "Radeon RX 9070 XT",
          gpuArch: "RDNA4", gpuVramMb: 16384, winml: true, directml: true,
          rocm: false, cuda: false, tensorrt: false, cpuIsa: ["avx2"],
          backendBuilt: true, epsBuilt: ["directml"],
        }),
      },
      nativeEngine: null, nativeUia: null,
    }));
    const { OnnxBackend } = await import("../../src/engine/vision-gpu/onnx-backend.js");
    const b = new OnnxBackend();
    const state = await b.ensureWarm({ kind: "game", id: "g1" });
    expect(state).toBe("warm");
    // 3 sessions initialised — one per stage
    expect(initCalls.length).toBe(3);
    expect(initCalls.some(k => k.startsWith("florence-2-base"))).toBe(true);
    expect(initCalls.some(k => k.startsWith("omniparser-v2-icon-detect"))).toBe(true);
    expect(initCalls.some(k => k.startsWith("paddleocr-v4-server"))).toBe(true);
  });

  it("ensureWarm transitions to evicted when visionInitSession rejects on any stage", async () => {
    let call = 0;
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        visionInitSession: vi.fn().mockImplementation(async () => {
          call++;
          if (call === 2) return { ok: false, selectedEp: "", error: "artifact missing", sessionKey: "" };
          return { ok: true, selectedEp: "DirectML(0)", error: null, sessionKey: `k${call}` };
        }),
        visionRecognizeRois: vi.fn(),
        detectCapability: vi.fn().mockReturnValue({
          os: "windows", osBuild: 26100, gpuVendor: "AMD", gpuDevice: "X", gpuArch: "RDNA4",
          gpuVramMb: 16384, winml: true, directml: true, rocm: false, cuda: false, tensorrt: false,
          cpuIsa: ["avx2"], backendBuilt: true, epsBuilt: ["directml"],
        }),
      },
      nativeEngine: null, nativeUia: null,
    }));
    const { OnnxBackend } = await import("../../src/engine/vision-gpu/onnx-backend.js");
    const b = new OnnxBackend();
    const state = await b.ensureWarm({ kind: "game", id: "g1" });
    expect(state).toBe("evicted");
  });

  it("recognizeRois invokes stage pipeline after warm, returns empty before warm", async () => {
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        visionInitSession: vi.fn().mockResolvedValue({ ok: true, selectedEp: "DirectML(0)", error: null, sessionKey: "k" }),
        visionRecognizeRois: vi.fn().mockImplementation(async (req) =>
          req.rois.map((r: any) => ({ trackId: r.trackId, rect: r.rect, label: "", class: r.classHint ?? "other", confidence: 0.5, provisional: true })),
        ),
        detectCapability: vi.fn().mockReturnValue({
          os: "windows", osBuild: 26100, gpuVendor: "AMD", gpuDevice: "X", gpuArch: "RDNA4",
          gpuVramMb: 16384, winml: true, directml: true, rocm: false, cuda: false, tensorrt: false,
          cpuIsa: ["avx2"], backendBuilt: true, epsBuilt: ["directml"],
        }),
      },
      nativeEngine: null, nativeUia: null,
    }));
    const { OnnxBackend } = await import("../../src/engine/vision-gpu/onnx-backend.js");
    const b = new OnnxBackend();

    // Before warm → []
    const before = await b.recognizeRois("window:1", [{ trackId: "t1", rect: { x: 0, y: 0, width: 100, height: 50 } }]);
    expect(before).toEqual([]);

    await b.ensureWarm({ kind: "game", id: "g1" });
    const after = await b.recognizeRois("window:1", [{ trackId: "t1", rect: { x: 0, y: 0, width: 100, height: 50 } }]);
    expect(after).toHaveLength(1);
    // At least 2 native calls (stage1 + stage2, stage3 skipped because stub class is "other")
    const callCount = (await import("../../src/engine/native-engine.js")).nativeVision!.visionRecognizeRois!.mock.calls.length;
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});
```

### 6.3 Rust unit test (`session_pool.rs` 内 `#[cfg(test)]`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_insert_get_remove_roundtrip() {
        let pool = VisionSessionPool::new();
        // We can't easily construct a real VisionSession without a model file,
        // so we test the HashMap plumbing via Arc<VisionSession> only indirectly:
        // insert/get/remove semantics need a dummy Arc. Since VisionSession
        // holds an ort::Session (no public default ctor), we test len()/is_empty()
        // on an empty pool which covers the Mutex poison fallback.
        assert!(pool.is_empty());
        assert_eq!(pool.len(), 0);
        assert!(pool.get("nonexistent").is_none());
        assert!(pool.remove("nonexistent").is_none());
    }

    #[test]
    fn global_pool_is_singleton() {
        let a = global_pool() as *const VisionSessionPool;
        let b = global_pool() as *const VisionSessionPool;
        assert_eq!(a, b);
    }
}
```

(実 VisionSession 作成は model file 依存、本 batch の unit test スコープ外。
4b-5a で model 投入後に full roundtrip を追加。)

### 6.4 既存 test の挙動維持

`tests/unit/visual-gpu-onnx-backend.test.ts` の既存 9 テスト (Phase 4a) は
`ensureWarm` が manifest load を試みるようになったため、**mock に `loadManifestFromFile` が
成功するよう assets/models.json が存在する前提が必要**。現状 assets/models.json は
4b-4 で commit 済なので実 file として存在 — 既存 test は naturally pass する想定。

もし既存 test 内で `ensureWarm` が `"warm"` を期待していて、manifest load が
予想外に失敗する挙動があれば **テスト書換ではなく実装側を直す**
(handbook §4.1 絶対条件)。例: `try/catch` で manifest load 失敗をログのみに留めて
`"warm"` を返す現在の behavior と整合させる。

---

## 7. Known traps

### Phase 4a / 4b-1 / 4b-3 / 4b-4 で観測した罠 (再発させない)

| 罠 | 本 batch での回避 |
|---|---|
| ort prebuilt 不在 (msys2/gnu) | load-dynamic で解決済、影響なし |
| windows crate API mismatch | windows 操作なし、影響なし |
| napi field 追加で既存 test mock が型穴 | `NativeRecognizeRequest` に `sessionKey` 追加時、既存 mock で `sessionKey` 欠落すると TS 型エラー。mock helper を test 内で update (新規追記、書換ではない) |
| selectVariant の bench_ms 空時 tie-break (4b-4 で発見) | 4b-4 で `isCpuOnlyVariant` tier 追加済、本 batch では再発しない |

### 4b-5 で予想される罠

| 罠 | 対策 |
|---|---|
| `VisionSessionPool` の global OnceLock 初期化順序 | `get_or_init` で lazy 初期化、明示的 init は不要 |
| Mutex poison (pool 内で panic 発生時) | `lock().ok()` で全 method が poison safe に (panic 後は pool 使用不能だが process 生存 = L5) |
| session_key に空文字列を insert した時の lookup 挙動 | insert("") は許容、legacy dummy path は空文字列 session_key でも `req.session_key.is_empty()` check が先に捕まえるので pool に落ちない |
| `ensureWarm` の並列 init で 1 つ失敗した時 Promise.all の reject | `initOne` は soft fail (null 返却)、`Promise.all` は reject せず `results.some(r => r === null)` で判定 |
| manifest path 解決 (`import.meta.url` + `../../../assets/models.json`) | TS でコンパイル後の相対 path が dist/ 構造で変わる。Sonnet が実 path を verify、失敗時は handbook §5 stop condition で Opus 委譲 |
| 既存 `WarmState` が "cold" → "warm" のみ想定、test が "evicted" を想定していない | 既存 test は `isAvailable()` false → "evicted" は既にカバー済 (Phase 4a test "ensureWarm returns evicted when native binding unavailable"。manifest 不在 + session init 失敗も同じ "evicted" に集約 (§3.9 決定) |
| stage pipeline の test で `mock calls.length >= 2` が flaky | runStagePipeline は deterministic (early exit 条件が明示)、flaky にならない |
| artifact 不在で `visionInitSession` が `ok: false` で返る → `ensureWarm` evicted | 本 batch では期待挙動。実機で artifact 同梱後 (4b-5a 以降) は `ok: true` に遷移 |
| session_key format `"${modelName}:${variant.name}"` が collision 起こす | 現在 4 model × 最大 7 variant で 28 key、全て unique。model_name に `:` 含まない規約を維持 |
| Rust 側 `session_key` が同じ値で 2 度 init された時 (OnnxBackend 再構築 etc) | pool::insert() は既存 entry を置き換え、古い Arc は last borrow で drop。無問題 |
| TS `dispose` で Rust pool を remove しないと長期 memory leak | 本 batch 範囲外 (session 3 つ固定、leak 影響小)。4b-5c 以降で `vision_retire_session` 追加 |

---

## 8. Acceptable Sonnet judgment scope

Sonnet が設計書内で独自判断して良い範囲:

- `ASSETS_DIR` / `MANIFEST_PATH` の相対 path 解決方法 (import.meta.url vs process.cwd())、ただし既存 dist/ 構造を破壊しないこと
- `session_key` 命名 (`"${modelName}:${variant.name}"` 推奨だが、`"${modelName}/${variant.name}"` 等の変更は可)
- Rust `stub_recognise_with_session` の lint 抑止 (`#[allow(unused_variables)]` で `_sess` を明示化など)
- test 内の mock helper 関数名 / 英語 wording
- `isTextClass` の class 一覧微調整 (ADR D3' 範囲内、"title" / "mixed" 含めるかの境界)
- コメント wording / JSDoc 詳細度
- commit 分割判断 (Rust pool / TS stage-pipeline / OnnxBackend 改修 / ADR flip を 2-4 commit に分割推奨)
- session init の並列度 (Promise.all 推奨、ただし順次 await でも可)

---

## 9. Forbidden Sonnet judgments

### 9.1 API surface 変更
- `OnnxBackend` の public method signature (ensureWarm / recognizeRois / getStableCandidates / onDirty / dispose / getWarmState / updateSnapshot / isAvailable) 変更禁止
- `VisualBackend` interface 変更禁止 (下流 PocVisualBackend / desktop-register.ts に影響)
- `ModelRegistry` の method 変更禁止 (4b-4 成果物)
- `NativeSessionResult` / `NativeSessionInit` の既存 field 変更禁止
- `UiEntityCandidate` shape 変更禁止 (resolver / CandidateProducer 下流)
- `ort::Session` の lifecycle semantics 変更禁止 (VisionSession 側で抽象化)

### 9.2 Scope 変更
- Stage 1/2/3 の **実 preprocess/postprocess/ort::Session::run** 実装禁止 (4b-5a/b/c)
- D3' class-aware dispatcher (text density でのルーティング) 実装禁止 (4b-6)
- Cross-check (multi-engine voting) 実装禁止 (4b-6)
- Stage 4/5/6 (state / relationship / DSL) 実装禁止 (Phase 4c)
- Real artifact download 実装禁止 (Phase 4b-5 以降 or 4b-7)
- `vision_retire_session` napi 追加禁止 (4b-5c 以降)
- Phase 4a / 4b-1 / 4b-3 / 4b-4 成果物の変更禁止

### 9.3 依存追加禁止
- 新 npm package / Rust crate 追加禁止
- `package.json` / `Cargo.toml` / `.github/workflows/` / `bin/launcher.js` / `src/version.ts` 変更禁止

### 9.4 テスト書換禁止
- 既存 test body 変更禁止 (handbook §4.1)
- `tests/unit/visual-gpu-onnx-backend.test.ts` の既存 9 テストは保持、既存 mock が
  新 behaviour に追従できない場合 **実装側で既存 behaviour を維持** (例: manifest load
  失敗を evicted ではなく warm 継続する alternative などは禁止、後述の stop condition で Opus 委譲)
- 新規テストは既存 file への追記のみ、新規 test file は `stage-pipeline.test.ts` のみ

### 9.5 絶対不変
- `catch_unwind` barrier (inference.rs / session.rs) 削除禁止
- `DESKTOP_TOUCH_ENABLE_ONNX_BACKEND` opt-in flag 維持
- `DESKTOP_TOUCH_DISABLE_VISUAL_GPU` kill-switch 維持
- `PocVisualBackend` / `bin/win-ocr.exe` 削除禁止
- `WarmState` 型の union から既存 3 値 ("cold"/"warm"/"evicted") 削除禁止 (追加のみ許容 — §3.9 で本 batch は追加しない決定)

### 9.6 ドキュメント更新義務
- ADR-005 §5 4b-5 checklist `[x]` flip + summary (framework のみ、sub-batch 4b-5a/b/c で real inference と記載)
- 本設計書 Status を `Implemented (2026-04-??、commit hash)` に

---

## 10. Future work / 次 batch への hand-off

### 10.1 Phase 4b-5a (Florence-2-base 実装、次の着手)

- Rust: `stub_recognise_with_session` → `florence2_recognise` に置換 (stage 1 のみ)
- Rust: preprocess (frame crop, 1024×1024 resize, normalisation)
- Rust: `sess.lock().run(...)` with input "pixel_values" tensor
- Rust: postprocess (bbox decode → RawCandidate with class = "region" / "form" / "panel" 等)
- TS: 変更なし (framework 側は 4b-5 完了で stable)

### 10.2 Phase 4b-5b (OmniParser-v2)

- Stage 2 の real inference。class が "text" / "button" / "checkbox" 等に細分化
- D3' class-aware dispatcher の前段階

### 10.3 Phase 4b-5c (PaddleOCR-v4)

- Stage 3 の real OCR 実装
- class == "text" の candidate に label が入るようになる
- `vision_retire_session` napi の追加、dispose からの pool cleanup

### 10.4 Phase 4b-6 以降

- Cross-check (multi-engine voting)
- PaddleOCR-mobile / GOT-OCR2 / Surya の Tier 2/3 dispatcher
- kill-switch 拡張 (per-stage disable)

---

## 11. 実装順序 (Sonnet 手順)

設計書 §2 Files to touch に従い、以下の順で実装:

### Rust 側 (先行、TS が依存)

1. `src/vision_backend/session_pool.rs` 新規作成 (§3.1)
2. `src/vision_backend/inference.rs` 既存 placeholder `VisionSessionPool` 削除
3. `src/vision_backend/mod.rs` に `pub mod session_pool;` + `pub use session_pool::VisionSessionPool` 追加、`pub use inference::VisionSessionPool` を削除
4. `src/vision_backend/types.rs::RecognizeRequest` に `session_key: String` field 追加 (§3.2)
5. `src/vision_backend/mod.rs::init_session_blocking` に pool insert 追加 (§3.3)
6. `src/vision_backend/inference.rs::recognize_rois_blocking` に pool lookup 分岐追加 (§3.4)
7. `src/vision_backend/inference.rs` に `stub_recognise_with_session` helper 追加
8. `cargo check --release --features vision-gpu` exit 0
9. `cargo check --release --features vision-gpu,vision-gpu-webgpu` exit 0
10. `cargo check --release --no-default-features` exit 0
11. Rust unit test 追加 (§6.3)

### TS 側

12. `src/engine/native-types.ts::NativeRecognizeRequest` に `sessionKey: string` field 追加
13. `src/engine/vision-gpu/stage-pipeline.ts` 新規作成 (§3.6)
14. `src/engine/vision-gpu/onnx-backend.ts::ensureWarm` を §3.7 に従って改修
15. `src/engine/vision-gpu/onnx-backend.ts::recognizeRois` を §3.8 に従って改修
16. `tsc --noEmit` exit 0
17. `tests/unit/stage-pipeline.test.ts` 新規作成 (§6.1、6 ケース)
18. `tests/unit/visual-gpu-onnx-backend.test.ts` に §6.2 の追記 (3 ケース)
19. `npx vitest run --project=unit "tests/unit/stage-pipeline.test.ts"` 全緑
20. `npx vitest run --project=unit "tests/unit/visual-gpu-onnx-backend.test.ts"` 全緑 (既存 9 + 新規 3)
21. `npx vitest run --project=unit "tests/unit/visual-gpu-model-registry.test.ts"` regression 0
22. `npx vitest run --project=unit "tests/unit/visual-gpu-session.test.ts"` regression 0

### 最終確認

23. `npm run test:capture -- --force` で full suite 最終 1 回 (regression 0)
24. ADR-005 §5 4b-5 checklist `[x]` flip + summary (framework のみ、sub-batch 4b-5a/b/c に real inference を委譲、と明記)
25. 本設計書 Status を `Implemented (2026-04-??、commit hash)` に
26. commit 分割 (推奨):
    - commit A: `feat(vision-gpu): Phase 4b-5 — VisionSessionPool + RecognizeRequest session_key`
    - commit B: `feat(vision-gpu): Phase 4b-5 — stage-pipeline.ts + OnnxBackend 3-stage wiring`
    - commit C: `test(vision-gpu): Phase 4b-5 — stage pipeline + OnnxBackend integration tests`
    - commit D (docs): `docs(vision-gpu): Phase 4b-5 — ADR §5 flip + design doc Status`
27. push origin desktop-touch-mcp-fukuwaraiv2
28. Opus self-review は本人 (Opus session) が別 session で実施、Sonnet は要請のみ
29. notification_show で Windows 通知

---

END OF DESIGN DOC.
