# Phase 4b-1 設計書 — EP cascade real wiring

- Status: **Approved (2026-04-24)** — ユーザー承認済 (「私の基本方針遵守で、おすすめで！」)、Sonnet 実装中
- 設計者: Claude (Opus, max effort)
- 実装担当: Sonnet (起動方法は `docs/phase4b-sonnet-prompt.md` の Prompt 2)
- 対応 ADR-005 セクション: D1' (Rust 内 napi-rs AsyncTask) / D2' (AMD-first vendor-neutral cascade)
- 対応 ADR-005 §5 batch: 4b-1
- 前提 commits: `c4a9a7f`〜`98753e7` (Phase 4a + handbook A案切替済)

---

## 1. Goal

Phase 4a で dummy だった `recognize_rois_blocking` の **session lifecycle 部分** を本物の `ort::Session` に置き換える。
ただし実 model の inference 実行は本 batch の対象外 (4b-4 以降)。本 batch の単一目標は次の 1 行:

> capability profile を入力に取り、WinML → DirectML → ROCm → CUDA → CPU の順で
> EP cascade を試行し、最初に成功した EP で `ort::Session` を作成して保持できる。

ADR-005 D2' の cascade を **明示的な 1 EP ずつの順次試行** で実装する。
`with_execution_providers([all_eps])` 1 回呼び出しで ort に任せる方法は採らない (op-level fallback と
session-init fallback が混ざるため、どの EP が選ばれたか確定的に追えない)。

---

## 2. Files to touch

### 新規作成

| Path | 役割 | 推定行数 |
|---|---|---|
| `src/vision_backend/session.rs` | `VisionSession` 構造、`create()` で EP cascade 試行、`SelectedEp` enum | 約 220 |
| `src/vision_backend/ep_select.rs` | capability profile → EP 試行リスト生成、各 EP の SessionBuilder 構成 | 約 180 |
| `src/vision_backend/dylib.rs` | `ORT_DYLIB_PATH` 解決 + `ort::init()` 一度だけ呼ぶ | 約 90 |
| `tests/unit/visual-gpu-session.test.ts` | TS 側で `vision_init_session` napi 関数を mock 経由で検証 (5 ケース) | 約 180 |

### 変更

| Path:行 | 変更内容 |
|---|---|
| `src/vision_backend/mod.rs` | `pub mod session; pub mod ep_select; pub mod dylib;` 追加、`pub use` 追加 |
| `src/vision_backend/types.rs` | `NativeSessionInit` / `NativeSessionResult` / `SelectedEp` を `#[napi(object)]` で公開 |
| `src/vision_backend/inference.rs` | `recognize_rois_blocking` を「session が attached なら使う、無ければ dummy_recognise」分岐に変更。`dummy_recognise` 関数は **削除せず維持** (kill-switch fallback) |
| `src/lib.rs` | `vision_init_session` napi 関数 + `VisionInitSessionTask` AsyncTask を追加 |
| `src/engine/native-types.ts` | `NativeSessionInit` / `NativeSessionResult` / `NativeSelectedEp` 追加 |
| `src/engine/native-engine.ts` | `NativeVision` interface に `visionInitSession?` 追加 |
| `src/engine/vision-gpu/onnx-backend.ts` | `ensureWarm` で session を初期化 (warm 状態に到達するまで EP cascade を実行)、`recognizeRois` は session ハンドル経由 |
| `Cargo.toml` | windows crate features に追加無し (4b-1 では Wdk/SystemInformation で足りる)。ort feature は既存 `directml` のみで OK |

### 削除禁止 (handbook §4.3 の skeleton)

- `src/vision_backend/inference.rs::dummy_recognise` (kill-switch fallback として保持)
- `src/vision_backend/inference.rs::recognize_rois_blocking` の signature
- `src/engine/vision-gpu/poc-backend.ts` の `PocVisualBackend`
- `bin/win-ocr.exe`
- `tests/unit/visual-gpu-onnx-backend.test.ts` の既存 9 ケース
- `tests/unit/visual-gpu-model-registry.test.ts` の既存 15 ケース

### Forbidden な依存追加

- ort の追加 feature (`cuda` / `tensorrt` / `rocm` / `migraphx` / `webgpu` / `winml`)
  → 本 batch では `directml` のみ。他は 4b-2/4b-3/4b-6 の各 batch で feature flag 経由で opt-in
- npm side dependencies — 一切追加しない

---

## 3. API design

### 3.1 `src/vision_backend/types.rs` 追加部

```rust
/// Final EP that the cascade settled on. Echoed back to TS for diagnostics.
/// String form (used in NativeSessionResult): "WinML" | "DirectML(0)" |
/// "ROCm(0)" | "CUDA(0)" | "CPU" | "Fallback(reason)"
#[derive(Debug, Clone)]
pub enum SelectedEp {
    WinML,
    DirectML { device_id: u32 },
    Rocm { device_id: u32 },
    Cuda { device_id: u32 },
    Cpu,
    /// All preferred EPs failed; reason is the concatenated error chain.
    Fallback(String),
}

impl SelectedEp {
    pub fn as_label(&self) -> String {
        match self {
            Self::WinML => "WinML".into(),
            Self::DirectML { device_id } => format!("DirectML({device_id})"),
            Self::Rocm { device_id } => format!("ROCm({device_id})"),
            Self::Cuda { device_id } => format!("CUDA({device_id})"),
            Self::Cpu => "CPU".into(),
            Self::Fallback(r) => format!("Fallback({r})"),
        }
    }
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeSessionInit {
    /// Absolute path to the .onnx file to load.
    pub model_path: String,
    /// CapabilityProfile produced by detect_capability().
    pub profile: crate::vision_backend::capability::CapabilityProfile,
    /// Optional: stable session key used to look up the session later
    /// (e.g. "ui_detector:dml-fp16"). Empty string for ad-hoc sessions.
    pub session_key: String,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeSessionResult {
    pub ok: bool,
    /// Set when `ok == true`. SelectedEp.as_label() format.
    pub selected_ep: String,
    /// Set when `ok == false`. Concatenated cascade attempt errors.
    pub error: Option<String>,
    /// Set when `ok == true`. Echoed `session_key` (caller can use it as
    /// the lookup key for subsequent recognize_rois calls in 4b-4+).
    pub session_key: String,
}
```

### 3.2 `src/vision_backend/session.rs`

```rust
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::vision_backend::capability::CapabilityProfile;
use crate::vision_backend::error::VisionBackendError;
use crate::vision_backend::ep_select::{build_cascade, EpAttempt};
use crate::vision_backend::types::SelectedEp;

/// One loaded ONNX session bound to a specific EP. Held by VisionSessionPool.
pub struct VisionSession {
    /// Boxed inside Arc<Mutex<>> so we can hand out clones without unsafe.
    /// ort::Session is Send + Sync per the 2.x API, but we wrap in Mutex
    /// because ort::Value passing is &mut at run time.
    inner: Arc<Mutex<ort::session::Session>>,
    pub selected_ep: SelectedEp,
    pub model_path: String,
    pub session_key: String,
}

impl VisionSession {
    /// Try EPs in cascade order and return the first session that loads.
    /// Returns Err(SessionFailed) only when EVERY EP attempt failed.
    pub fn create(
        model_path: &Path,
        profile: &CapabilityProfile,
        session_key: String,
    ) -> Result<Self, VisionBackendError> {
        let attempts = build_cascade(profile);
        let mut errors: Vec<String> = Vec::new();
        for attempt in attempts {
            match try_one_ep(model_path, &attempt) {
                Ok(sess) => {
                    return Ok(Self {
                        inner: Arc::new(Mutex::new(sess)),
                        selected_ep: attempt.kind,
                        model_path: model_path.to_string_lossy().into_owned(),
                        session_key,
                    });
                }
                Err(e) => errors.push(format!("{}: {}", attempt.kind.as_label(), e)),
            }
        }
        Err(VisionBackendError::SessionFailed(format!(
            "all EPs failed: [{}]",
            errors.join(" | ")
        )))
    }

    pub fn selected_ep_label(&self) -> String { self.selected_ep.as_label() }
}

/// Run a single EP attempt. Wrapped in catch_unwind so a panic inside ort
/// (rare, but possible during session init on driver issues) never aborts
/// the host process — L5.
fn try_one_ep(
    model_path: &Path,
    attempt: &EpAttempt,
) -> Result<ort::session::Session, VisionBackendError> {
    use std::panic::AssertUnwindSafe;
    let model_path = model_path.to_path_buf();
    let attempt_clone = attempt.clone(); // EpAttempt is Clone (see ep_select.rs)
    let result = std::panic::catch_unwind(AssertUnwindSafe(move || {
        let builder = ort::session::Session::builder()
            .map_err(|e| VisionBackendError::SessionFailed(format!("builder: {e}")))?;
        let builder = (attempt_clone.apply)(builder)
            .map_err(|e| VisionBackendError::SessionFailed(format!("ep {}: {e}", attempt_clone.kind.as_label())))?;
        builder.commit_from_file(&model_path)
            .map_err(|e| VisionBackendError::SessionFailed(format!("commit: {e}")))
    }));
    match result {
        Ok(Ok(sess)) => Ok(sess),
        Ok(Err(e)) => Err(e),
        Err(payload) => {
            let msg = crate::vision_backend::inference::panic_payload_to_string_pub(payload);
            Err(VisionBackendError::InferencePanic(msg))
        }
    }
}
```

### 3.3 `src/vision_backend/ep_select.rs`

```rust
use crate::vision_backend::capability::CapabilityProfile;
use crate::vision_backend::types::SelectedEp;

/// One EP attempt: the kind (for logging) and a closure that registers the
/// EP on a SessionBuilder. Cloneable so we can retry / log without consuming.
pub struct EpAttempt {
    pub kind: SelectedEp,
    /// `apply` mutates the builder by registering the EP, then returns it.
    /// Returning Err here means "this EP couldn't even be configured" —
    /// caller treats it as a failed attempt and moves to the next.
    pub apply: std::sync::Arc<
        dyn Fn(ort::session::builder::SessionBuilder)
            -> Result<ort::session::builder::SessionBuilder, ort::Error>
            + Send + Sync,
    >,
}

impl Clone for EpAttempt {
    fn clone(&self) -> Self {
        Self { kind: self.kind.clone(), apply: self.apply.clone() }
    }
}

/// Build the cascade order from a capability profile. Order matches
/// ADR-005 D2' Layer 1/2 + final CPU fallback.
///
/// 4b-1 scope: WinML attempt is **registered as a label only** but skipped
/// at try time (Phase 4b-2 wires it). DirectML / ROCm / CUDA depend on
/// runtime detection AND build features.
pub fn build_cascade(profile: &CapabilityProfile) -> Vec<EpAttempt> {
    let mut out: Vec<EpAttempt> = Vec::new();

    // WinML (Phase 4b-2 will provide the real implementation)
    if profile.winml && cfg!(feature = "vision-gpu-winml") {
        out.push(winml_attempt());
    }

    // DirectML (always available with `vision-gpu` feature on Windows)
    if profile.directml {
        out.push(directml_attempt(0));
    }

    // ROCm (opt-in feature)
    #[cfg(feature = "vision-gpu-rocm")]
    if profile.rocm {
        out.push(rocm_attempt(0));
    }

    // CUDA (opt-in feature)
    #[cfg(feature = "vision-gpu-cuda")]
    if profile.cuda {
        out.push(cuda_attempt(0));
    }

    // CPU is always last
    out.push(cpu_attempt());

    out
}

fn directml_attempt(device_id: u32) -> EpAttempt {
    EpAttempt {
        kind: SelectedEp::DirectML { device_id },
        apply: std::sync::Arc::new(move |builder| {
            use ort::execution_providers::DirectMLExecutionProvider;
            builder.with_execution_providers([
                DirectMLExecutionProvider::default()
                    .with_device_id(device_id as i32)
                    .build(),
            ])
        }),
    }
}

fn cpu_attempt() -> EpAttempt {
    EpAttempt {
        kind: SelectedEp::Cpu,
        // CPU EP is implicit — registering an empty list lets ort use
        // the default CPU provider for every op.
        apply: std::sync::Arc::new(|builder| Ok(builder)),
    }
}

fn winml_attempt() -> EpAttempt {
    // Phase 4b-1: stub that always errors — Phase 4b-2 replaces this body.
    EpAttempt {
        kind: SelectedEp::WinML,
        apply: std::sync::Arc::new(|_b| {
            Err(ort::Error::new("WinML EP not yet implemented in 4b-1"))
        }),
    }
}

#[cfg(feature = "vision-gpu-rocm")]
fn rocm_attempt(device_id: u32) -> EpAttempt {
    EpAttempt {
        kind: SelectedEp::Rocm { device_id },
        apply: std::sync::Arc::new(move |builder| {
            use ort::execution_providers::ROCmExecutionProvider;
            builder.with_execution_providers([
                ROCmExecutionProvider::default()
                    .with_device_id(device_id as i32)
                    .build(),
            ])
        }),
    }
}

#[cfg(feature = "vision-gpu-cuda")]
fn cuda_attempt(device_id: u32) -> EpAttempt {
    EpAttempt {
        kind: SelectedEp::Cuda { device_id },
        apply: std::sync::Arc::new(move |builder| {
            use ort::execution_providers::CUDAExecutionProvider;
            builder.with_execution_providers([
                CUDAExecutionProvider::default()
                    .with_device_id(device_id as i32)
                    .build(),
            ])
        }),
    }
}
```

### 3.4 `src/vision_backend/dylib.rs`

```rust
use std::path::PathBuf;
use std::sync::OnceLock;

use crate::vision_backend::error::VisionBackendError;

static ORT_INITIALIZED: OnceLock<Result<(), VisionBackendError>> = OnceLock::new();

/// Resolve the ONNX Runtime DLL path and call ort::init() exactly once
/// per process. Subsequent calls return the cached result.
///
/// Lookup order:
///   1. ORT_DYLIB_PATH env var (verbatim)
///   2. %USERPROFILE%/.desktop-touch-mcp/runtime/onnxruntime.dll (Windows)
///   3. ~/.desktop-touch-mcp/runtime/libonnxruntime.so (Linux, future)
///   4. ~/.desktop-touch-mcp/runtime/libonnxruntime.dylib (macOS, future)
///
/// Returns Err if no DLL is found or ort::init() fails.
pub fn ensure_ort_initialized() -> Result<(), VisionBackendError> {
    ORT_INITIALIZED
        .get_or_init(do_init)
        .clone()
}

fn do_init() -> Result<(), VisionBackendError> {
    let dylib = resolve_dylib_path()
        .ok_or_else(|| VisionBackendError::Other(
            "onnxruntime dylib not found (set ORT_DYLIB_PATH or place under \
             ~/.desktop-touch-mcp/runtime/)".into()
        ))?;
    ort::init()
        .with_dylib_path(dylib.to_string_lossy().into_owned())
        .commit()
        .map_err(|e| VisionBackendError::Other(format!("ort::init failed: {e}")))?;
    Ok(())
}

fn resolve_dylib_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("ORT_DYLIB_PATH") {
        let pb = PathBuf::from(p);
        if pb.exists() { return Some(pb); }
    }
    let home = if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE")
    } else {
        std::env::var("HOME")
    }.ok()?;
    let runtime = PathBuf::from(home).join(".desktop-touch-mcp").join("runtime");
    let candidate = if cfg!(target_os = "windows") {
        runtime.join("onnxruntime.dll")
    } else if cfg!(target_os = "macos") {
        runtime.join("libonnxruntime.dylib")
    } else {
        runtime.join("libonnxruntime.so")
    };
    if candidate.exists() { Some(candidate) } else { None }
}
```

### 3.5 `src/lib.rs` 追加部

```rust
#[cfg(feature = "vision-gpu")]
pub struct VisionInitSessionTask(vision_backend::NativeSessionInit);

#[cfg(feature = "vision-gpu")]
impl Task for VisionInitSessionTask {
    type Output = vision_backend::NativeSessionResult;
    type JsValue = vision_backend::NativeSessionResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let placeholder = vision_backend::NativeSessionInit {
            model_path: String::new(),
            profile: vision_backend::detect_capability(),
            session_key: String::new(),
        };
        let req = std::mem::replace(&mut self.0, placeholder);
        Ok(vision_backend::init_session_blocking(req))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(feature = "vision-gpu")]
#[napi]
pub fn vision_init_session(
    init: vision_backend::NativeSessionInit,
) -> AsyncTask<VisionInitSessionTask> {
    AsyncTask::new(VisionInitSessionTask(init))
}
```

`vision_backend::init_session_blocking(init)` の概念:

```rust
// src/vision_backend/mod.rs に追加
pub fn init_session_blocking(init: NativeSessionInit) -> NativeSessionResult {
    if let Err(e) = dylib::ensure_ort_initialized() {
        return NativeSessionResult {
            ok: false,
            selected_ep: String::new(),
            error: Some(e.to_string()),
            session_key: init.session_key,
        };
    }
    let path = std::path::Path::new(&init.model_path);
    match session::VisionSession::create(path, &init.profile, init.session_key.clone()) {
        Ok(sess) => {
            // Phase 4b-1: store nowhere yet. 4b-4 will introduce a global
            // VisionSessionPool and insert here.
            NativeSessionResult {
                ok: true,
                selected_ep: sess.selected_ep_label(),
                error: None,
                session_key: init.session_key,
            }
        }
        Err(e) => NativeSessionResult {
            ok: false,
            selected_ep: String::new(),
            error: Some(e.to_string()),
            session_key: init.session_key,
        },
    }
}
```

### 3.6 TS 側 (`src/engine/native-types.ts` 追加)

```typescript
export interface NativeSessionInit {
  modelPath: string;
  profile: NativeCapabilityProfile;
  sessionKey: string;
}

export interface NativeSessionResult {
  ok: boolean;
  selectedEp: string;
  error?: string | null;
  sessionKey: string;
}
```

### 3.7 `src/engine/vision-gpu/onnx-backend.ts` 修正

```typescript
async ensureWarm(_target: WarmTarget): Promise<WarmState> {
  if (!OnnxBackend.isAvailable()) { this.state = "evicted"; return this.state; }
  // 4b-1: defer real session init until a model is requested. Mark warm
  // because the binding is loaded; Phase 4b-4 changes this to actually
  // load the detector model and gate on success.
  this.state = "warm";
  return this.state;
}
```

(Phase 4b-1 では `ensureWarm` は session を作らない。session 作成は 4b-4 で recognizer model 投入時に統合する。本 batch では `vision_init_session` napi を **TS 側から呼べる状態にする** までが範囲。)

---

## 4. EP / モデル統合の具体仕様

### 4.1 EP cascade 順序 (build_cascade の出力)

| profile | cargo features | 試行順序 (上から試して最初の成功を採用) |
|---|---|---|
| AMD RDNA4 + DirectML (dogfood baseline) | default | DirectML(0) → CPU |
| AMD + DirectML + WinML (Win11 24H2) | default + `vision-gpu-winml` | WinML → DirectML(0) → CPU (4b-1 では WinML 常に Err) |
| AMD + DirectML + ROCm 7.2 | default + `vision-gpu-rocm` | DirectML(0) → ROCm(0) → CPU |
| NVIDIA + CUDA + DirectML | default + `vision-gpu-cuda` | DirectML(0) → CUDA(0) → CPU |
| Intel iGPU + DirectML | default | DirectML(0) → CPU |
| CPU only | default | CPU |

WinML を一番上に置く根拠: ADR-005 D2' で「WinML default」と明示。
本 batch では実装せず stub なので必ず Err を返し、次 EP に fall through する。

### 4.2 ORT_DYLIB_PATH 解決

| 環境 | 採用パス |
|---|---|
| ORT_DYLIB_PATH 設定済 + 実在 | env の値 |
| Windows + cache あり | `%USERPROFILE%/.desktop-touch-mcp/runtime/onnxruntime.dll` |
| Linux + cache あり | `~/.desktop-touch-mcp/runtime/libonnxruntime.so` |
| macOS + cache あり | `~/.desktop-touch-mcp/runtime/libonnxruntime.dylib` |
| いずれもなし | `Err(Other("onnxruntime dylib not found ..."))` |

`launcher zip` への DLL 同梱は **本 batch ではやらない** (handbook §4.8 の依存追加に該当、Opus 設計で明示が必要)。
代わりに dogfood ユーザーが手動で `~/.desktop-touch-mcp/runtime/onnxruntime.dll` を置く想定。
launcher zip 同梱は **4b-7 (BenchmarkHarness) の done criteria** で Opus 承認後に追加。

### 4.3 `ort::init()` の重複呼び出し対策

`OnceLock` で 1 度だけ実行、結果を cache。
2 回目以降は cache を返すだけ。これにより `vision_init_session` を複数 model に対して呼んでも再 init しない。

### 4.4 panic isolation (L5)

- `try_one_ep` 内部で `catch_unwind` を使い、ort 内部の panic (driver crash 等) を
  `VisionBackendError::InferencePanic` に変換
- `init_session_blocking` の戻り値は **絶対に panic しない** (NativeSessionResult)
- TS 側は `await visionInitSession(...)` で `result.ok === false` を確認してから次に進む

---

## 5. Done criteria (binary check)

- [ ] `cargo check --release --features vision-gpu` exit 0
- [ ] `cargo check --release --features vision-gpu,vision-gpu-cuda` exit 0 (CUDA feature ON でも build 通る)
- [ ] `cargo check --release --features vision-gpu,vision-gpu-rocm` exit 0
- [ ] `cargo check --release --no-default-features` exit 0 (vision-gpu OFF でも全体 build 通る)
- [ ] `tsc --noEmit` exit 0
- [ ] `npm run test:capture -- --force` 全パス、regression なし、新規 5+ ケース pass
- [ ] ADR-005 §5 の 4b-1 checklist 4 項目全て `[x]` flip
- [ ] 設計書本文の Status を「Implemented (commit ...)」に更新
- [ ] (実機 verify、ユーザーが実行) RX 9070 XT で:
  ```powershell
  $env:ORT_DYLIB_PATH = "$env:USERPROFILE\.desktop-touch-mcp\runtime\onnxruntime.dll"
  npm run build:rs
  node -e "
    const { detectCapability, visionInitSession } = require('./index.js');
    visionInitSession({
      modelPath: 'C:/path/to/dummy.onnx',
      profile: detectCapability(),
      sessionKey: 'test'
    }).then(r => console.log(JSON.stringify(r, null, 2)));
  "
  ```
  → `selectedEp === "DirectML(0)"` が出力されること

---

## 6. Test cases

### 6.1 Rust unit tests (`src/vision_backend/ep_select.rs:#[cfg(test)]`)

最低 4 ケース:

```rust
#[test]
fn cascade_amd_directml_only() {
    let p = profile_amd_rdna4_no_extras();
    let attempts = build_cascade(&p);
    let kinds: Vec<_> = attempts.iter().map(|a| a.kind.as_label()).collect();
    assert_eq!(kinds, vec!["DirectML(0)", "CPU"]);
}

#[test]
fn cascade_winml_first_when_feature_on() {
    // Compiled only with vision-gpu-winml
    #[cfg(feature = "vision-gpu-winml")]
    {
        let mut p = profile_amd_rdna4_no_extras();
        p.winml = true;
        let attempts = build_cascade(&p);
        assert_eq!(attempts[0].kind.as_label(), "WinML");
    }
}

#[test]
fn cascade_cpu_only_when_no_gpu() {
    let mut p = profile_amd_rdna4_no_extras();
    p.directml = false;
    let attempts = build_cascade(&p);
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0].kind.as_label(), "CPU");
}

#[test]
fn cascade_rocm_when_feature_on() {
    #[cfg(feature = "vision-gpu-rocm")]
    {
        let mut p = profile_amd_rdna4_no_extras();
        p.rocm = true;
        let attempts = build_cascade(&p);
        let labels: Vec<_> = attempts.iter().map(|a| a.kind.as_label()).collect();
        assert!(labels.contains(&"ROCm(0)".to_string()));
    }
}

fn profile_amd_rdna4_no_extras() -> CapabilityProfile { ... }
```

### 6.2 TS unit tests (`tests/unit/visual-gpu-session.test.ts`)

最低 5 ケース (mocked native binding):

1. `nativeVision.visionInitSession` 不在時 → `OnnxBackend` の挙動 (warm に到達するが session なし)
2. `visionInitSession` resolves with `{ok: true, selectedEp: "DirectML(0)"}` → result が TS に正しく渡る
3. `visionInitSession` resolves with `{ok: false, error: "all EPs failed"}` → error path で throw しない
4. `visionInitSession` rejects (panic isolation) → throw しない
5. `sessionKey` が echo される (caller が後で session pool lookup に使える)

### 6.3 Integration (gated, 実機実行のみ)

`tests/integration/visual-gpu-session-real.test.ts` を新規作成、`describe.skipIf(!process.env["RUN_VISUAL_GPU_REAL"])`:

1. `ORT_DYLIB_PATH` 設定済 + dummy onnx file (test fixture) で session 作成 → `ok === true && selectedEp === "DirectML(0)"`

これは CI では skip。dogfood で手動実行。

---

## 7. Known traps

### Phase 4a で観測した罠 (再発させない)

1. **windows crate 0.62 API mismatch**: 本 batch では windows crate を新規呼び出ししないので影響無し。ただし他 batch では再発リスクあり
2. **ort prebuilt 不在 (msys2/gnu)**: load-dynamic 採用済。本 batch では追加 feature 入れないので問題なし
3. **Cargo.toml の features 漏れ**: 本 batch では追加 features なし

### 4b-1 で予想される罠

| 罠 | 対策 |
|---|---|
| `ort::Session` が `!Sync` で Mutex 必須 | 設計時点で `Arc<Mutex<Session>>` に decided |
| `with_execution_providers([all])` で op-level fallback と混ざる | **必ず 1 EP ずつ試行** (build_cascade で attempts list 化) |
| `ort::init()` 二重呼び出しで panic | `OnceLock` で gate |
| `DirectMLExecutionProvider::with_device_id(i32)` が `u32` を受けるかも | ort 2.0.0-rc.12 のシグネチャ確認、`as i32` でキャスト |
| `commit_from_file` がモデル不在で long-running blocking | session 作成は AsyncTask の compute 側 (libuv worker)、Node メインを止めない |
| ROCm EP の ort feature 名が `migraphx` か `rocm` か | Cargo.toml 既存定義通り `vision-gpu-rocm = ["ort/rocm"]`、API は `ROCmExecutionProvider` |
| WinML stub が「常に Err を返す」とユーザーが「壊れた」と勘違い | log message に "WinML EP stub (Phase 4b-2)" と明示 |
| `ORT_DYLIB_PATH` 未設定 + cache 不在で `init_session_blocking` 呼ばれた → graceful Err 返す (panic しない) | `dylib.rs::do_init` が `Err(Other(...))` を返す path 確認 |
| `ort::init()` の error が "Initialization already failed" の場合、再試行可能か | OnceLock cache のため再試行不可。ユーザーがプロセス再起動で対応 |
| Cargo.toml の `vision-gpu-rocm` feature 有効時に Linux でしか build 通らない | 本 batch では feature opt-in なので default build には影響なし |
| `EpAttempt::apply` が `Fn` (not `FnOnce`) で複数回呼べる必要 | 設計通り `Arc<dyn Fn ...>` に決定済 |

### Sonnet が踏みやすい罠 (Stop conditions §5 該当)

1. 「DirectML attempt が 1 回失敗したら全部失敗にしよう」 → ❌ cascade 全部試行が必要。**設計書 §3 の `for attempt in attempts` ループ厳守**
2. 「`with_execution_providers([all])` で 1 回呼べばシンプル」 → ❌ §3.2 の理由で禁止
3. 「ORT_DYLIB_PATH 必須にしてエラー時は panic」 → ❌ graceful Err で返す (L5)
4. 「`dummy_recognise` を消して inference.rs を綺麗にする」 → ❌ kill-switch fallback として残す
5. 「test 通らないから unit test の assertion を緩める」 → ❌ tests/ 書き換え禁止 (handbook §4.1)

---

## 8. Acceptable Sonnet judgment scope

設計書内で Sonnet が決めて良い:

- private helper 関数の命名 (`do_init` を `init_ort_runtime` 等に変える)
- log message の wording (`println!`/`eprintln!` の文字列)
- error message の日本語/英語選択 (英語推奨だが日本語混在可)
- `EpAttempt` struct の field 命名 (`apply` を `register` 等)
- import の順序整理 (`use` ブロック内)
- `cfg!` 分岐の追加コメント
- test case 名 (英語推奨)
- `Cargo.toml` の dependencies コメント文言
- `#[derive(Debug, Clone)]` の追加 (struct に含めるか判断は Sonnet)
- `mod.rs` の `pub use` 順序
- 6.1 / 6.2 の test cases に **追加で** 境界条件 / smoke test を足す

---

## 9. Forbidden Sonnet judgments

Sonnet が独自に決めてはいけない:

### 9.1 API surface 変更
- `VisionSession` struct の field 追加/削除/型変更
- `SelectedEp` variant 追加/削除/順序変更
- `NativeSessionInit` / `NativeSessionResult` の field 変更
- `vision_init_session` napi 関数の signature 変更
- `build_cascade` の戻り値型変更
- `EpAttempt::apply` の closure シグネチャ変更

### 9.2 EP cascade 戦略の変更
- `with_execution_providers([all_eps])` 1 回呼び出しへの変更 (§3.2 で禁止理由明記)
- WinML を後ろに移動 (D2' 違反)
- CPU を最後でなくす
- DirectML の優先順位を下げる (AMD baseline で必須)

### 9.3 削除禁止
- `dummy_recognise` 関数 (kill-switch fallback)
- `PocVisualBackend` (Phase 1-3 fallback)
- `bin/win-ocr.exe`
- 既存テスト
- Phase 4a の構造 (handbook §4.3 全項目)

### 9.4 依存追加禁止
- ort の追加 feature (`cuda` / `tensorrt` / `migraphx` / `webgpu` / `winml`)
  → 4b-2/4b-3/4b-6 の Opus 設計で個別承認
- npm package 追加
- windows crate features 追加 (本 batch では既存で足りる)
- Cargo.lock 以外の Cargo.toml 変更 (features セクション含む)

### 9.5 Build / CI 変更禁止
- `bin/launcher.js` 変更
- `.github/workflows/release.yml` 変更
- `package.json` の `scripts` 追加
- `src/version.ts` 変更

### 9.6 ドキュメント更新義務 (やるべきこと)
- ADR-005 §5 の 4b-1 checklist `[ ]` → `[x]` flip
- 本設計書の Status を「Implemented (commit hash)」に更新

これらを sonnet が独自判断で変更しようとしたら、handbook §5 stop conditions §9
「設計書 §9 Forbidden の領域に踏み込みたくなった」に該当 → 即 Opus 委譲。

---

## 10. 実装順序の推奨 (Sonnet 向け参考)

設計書 §2 の files-to-touch を、依存関係に従って以下の順で書く:

1. `src/vision_backend/types.rs` 拡張 (`SelectedEp`, `NativeSessionInit/Result`)
2. `src/vision_backend/ep_select.rs` 新規 + Rust unit test 4 ケース
3. `src/vision_backend/dylib.rs` 新規
4. `src/vision_backend/session.rs` 新規
5. `src/vision_backend/mod.rs` 更新 (pub mod / pub use / `init_session_blocking` 関数)
6. `src/lib.rs` 更新 (`VisionInitSessionTask` + `vision_init_session`)
7. `cargo check --release --features vision-gpu` で Rust 側通す
8. `src/engine/native-types.ts` 更新
9. `src/engine/native-engine.ts` 更新 (NativeVision に `visionInitSession?`)
10. `src/engine/vision-gpu/onnx-backend.ts` 軽微修正 (今回 ensureWarm は変更なしで OK、コメント追加程度)
11. `tests/unit/visual-gpu-session.test.ts` 新規 5 ケース
12. `tsc --noEmit` 通す
13. `npm run test:capture -- --force` 全パス確認
14. ADR-005 §5 の 4b-1 checklist flip
15. 本設計書の Status を「Implemented」に
16. Sonnet → Opus 完了報告 (handbook §6.1)

---

END OF DESIGN DOC.
