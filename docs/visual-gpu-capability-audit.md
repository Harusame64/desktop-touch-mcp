# Visual GPU Backend — Capability Audit (2026-04-24)

Source-level audit of the `src/engine/vision-gpu/` stack and the
`visual_gpu` candidate lane wired through `desktop-register.ts`.
This document pairs with the executable specification in
`tests/unit/visual-gpu-capability.test.ts`
(unit, 17 cases, all passing) and the gated comparison harness in
`tests/integration/visual-gpu-vs-ocr.test.ts` (RUN_VISUAL_GPU_AUDIT=1).

Symptom that motivated the audit — Outlook PWA on `desktop_see`:

| field                  | value                                         |
|------------------------|-----------------------------------------------|
| UIA                    | `uia_blind_single_pane`                       |
| Visual (GPU)           | `visual_attempted_empty`                      |
| Entities returned      | 2 (title bar + search box)                    |

---

## Phase 1 — current state of the codebase

### What is implemented

| Component                         | File                                                | Status          |
|-----------------------------------|-----------------------------------------------------|-----------------|
| `PocVisualBackend`                | `src/engine/vision-gpu/poc-backend.ts`              | stub, working   |
| `GpuWarmupManager`                | `src/engine/vision-gpu/warmup.ts`                   | simulated 50 ms |
| `VisualRuntime` (singleton)       | `src/engine/vision-gpu/runtime.ts`                  | working         |
| `TrackStore` (IoU tracking)       | `src/engine/vision-gpu/track-store.ts`              | working         |
| `TemporalFusion` (vote decay)     | `src/engine/vision-gpu/temporal-fusion.ts`          | working         |
| `CandidateProducer`               | `src/engine/vision-gpu/candidate-producer.ts`       | working         |
| `RoiScheduler`                    | `src/engine/vision-gpu/roi-scheduler.ts`            | working         |
| `dirty-signal` pub/sub            | `src/engine/vision-gpu/dirty-signal.ts`             | working         |
| `visual-provider.fetchVisualCandidates()` | `src/tools/desktop-providers/visual-provider.ts` | working |
| `composeCandidates()` escalation  | `src/tools/desktop-providers/compose-providers.ts`  | working         |
| Runtime attach at server init     | `src/tools/desktop-register.ts:137`                 | working (PoC)   |

### What is stub / unimplemented

| Missing piece                                           | Where it should live                       |
|---------------------------------------------------------|--------------------------------------------|
| Frame capture driving the ROI path                      | Not present — only `printWindowToBuffer` under OCR |
| Dirty-rect source (Desktop Duplication or equivalent)   | Not present                                |
| Driver that calls `scheduleRois()` periodically         | Not present                                |
| Driver that calls `TrackStore.update()` with rois       | Not present                                |
| Detector / recognizer (ONNX, sidecar, …) feeding        | Not present — no implementation of         |
| `RecognitionInput[]` into `CandidateProducer.ingest()`  | `VisualBackend` other than the PoC         |
| Any caller of `pushDirtySignal(key, candidates)` with   |                                            |
| non-empty candidates in production code                 | Not present                                |

### Data flow — where it stalls

```
[ PrintWindow / Desktop Duplication ]  ❌ no production driver
            │
            ▼
[ RoiScheduler.scheduleRois ]           ❌ never called
            │
            ▼
[ TrackStore.update → TemporalFusion ]  ❌ never fed
            │
            ▼
[ CandidateProducer.ingest ]            ❌ never called
            │
            ▼
[ pushDirtySignal(key, candidates) ]    ❌ never invoked with data
            │
            ▼ wired in desktop-register.ts:146
[ onDirtySignal handler ]               ✅ registered
            │
            ▼
[ PocVisualBackend.updateSnapshot ]     ✅ works
            │
            ▼
[ PocVisualBackend.snapshots Map ]      ✅ works
            │
            ▼
[ getStableCandidates → VisualRuntime ] ✅ works
            │
            ▼
[ visual-provider → composeCandidates ] ✅ works
```

The glue from OS capture through to `pushDirtySignal` is entirely absent.
`PocVisualBackend.getStableCandidates()` is a `Map.get` — and the `Map`
has no writers in the production graph.

### Relationship to the existing PrintWindow → OCR (SoM) path

- `src/engine/ocr-bridge.ts` already captures the target window with
  `printWindowToBuffer()` and feeds Windows-RT OCR via `win-ocr.exe`.
- Output is consumed by `fetchOcrCandidates()`
  (`src/tools/desktop-providers/ocr-provider.ts`) and lands as
  `source: "ocr"` candidates.
- The SoM path is triggered **only** when UIA returns `uia_blind_*`
  warnings (`compose-providers.ts:280`).
- The SoM path is **disjoint** from the Visual GPU path: OCR does not
  feed `CandidateProducer`, does not push dirty signals, and does not
  produce `visual_gpu` candidates.
- An OCR → CandidateProducer adapter is the cheapest way to fill the
  visual lane without inventing a new detector. See Phase 3 below.

---

## Phase 2 — verification tests delivered

### Unit test: `tests/unit/visual-gpu-capability.test.ts` (17 cases)

Section A — PocVisualBackend stored-but-empty contract
- warmup succeeds without producing candidates
- `updateSnapshot` is the only writer
- per-`targetKey` isolation
- `dispose` clears snapshots

Section B — VisualRuntime state transitions
- detached runtime is unavailable; `ensureWarm → "cold"`
- attach → warm → dispose → unavailable
- `attach()` disposes the previous backend
- `targetKeyToWarmTarget` mapping (`window:` / `tab:` / `title:`)

Section C — `visual-provider` warning taxonomy
- no backend → `visual_provider_unavailable`
- stuck-cold backend → `visual_provider_warming`
- warm + empty → no warning (the Outlook PWA case)
- composer escalation → `visual_attempted_empty` (structural reminder)
- evicted retry → single retry succeeds
- `ensureWarm` throws → `visual_provider_failed`

Section D — Missing wiring
- dirty-signal bus has no default handlers in unit scope
- simulated fully-wired P3-D: inject via `pushDirtySignal`, watch
  `visual-provider` surface the candidates
- "production gap snapshot" — five missing wires encoded as data

### Integration test: `tests/integration/visual-gpu-vs-ocr.test.ts`

Gated by `RUN_VISUAL_GPU_AUDIT=1`. Runs against a live window (default
title fragment "Outlook"; override with `VISUAL_GPU_AUDIT_TITLE`).

Measures per lane:
- candidate count
- warnings
- OCR confidence distribution (min / avg / max)
- top 8 OCR labels

Example invocation:

```
RUN_VISUAL_GPU_AUDIT=1 VISUAL_GPU_AUDIT_TITLE="Outlook" \
  npx vitest run --project integration tests/integration/visual-gpu-vs-ocr.test.ts
```

The test is intentionally lenient (no hard count threshold) — its role
is a capability report, not a quality gate.

---

## Phase 3 — problem report

### Currently possible

- Control plane is fully operational:
  `VisualRuntime` singleton, `ensureWarm` / `getStableCandidates` /
  `onDirty` all work. `visual-provider` warning taxonomy is complete
  and surfaces `visual_provider_unavailable`, `visual_provider_warming`,
  `visual_provider_failed`.
- Escalation to `visual_attempted_empty` and `visual_not_attempted`
  fires correctly from `composeCandidates()` when UIA is blind.
- Tracking / fusion / candidate emission primitives all pass their own
  unit tests (`track-store.test.ts`, `temporal-fusion.test.ts`,
  `candidate-producer.test.ts`, `roi-scheduler.test.ts`).
- Any external caller that invokes `pushDirtySignal(key, candidates)`
  makes its candidates visible through `desktop_see` on the next call
  (verified by the `dirty-signal.test.ts` integration block and
  section D of the new capability test).
- PrintWindow + win-ocr.exe (SoM pipeline) works end-to-end and feeds
  `source: "ocr"` candidates on UIA-blind windows, with
  `snapToDictionary` correction from UIA hints.

### Currently impossible

- `visual_gpu` candidates against any real window. The stable-candidate
  store is never populated from live capture because no production
  component runs the capture → ROI → fusion → ingest loop.
- Structural entity recovery for Outlook PWA (and any other
  UIA-opaque WebView) via the visual lane. Users see exactly what they
  see today: 2 entities from UIA, 0 from visual, plus OCR labels when
  OCR has something to contribute.
- Any latency / frame-impact / recall measurement on the visual lane.
  `BenchmarkHarness` exists (`src/engine/vision-gpu/benchmark.ts`)
  but there is nothing behind it to measure.

### Root causes

1. **Missing wiring A — no frame source.** No code subscribes to
   Desktop Duplication dirty rects or drives `scheduleRois()` with
   captured frames.

2. **Missing wiring B — no detector/recognizer.** No `VisualBackend`
   implementation other than `PocVisualBackend` and `MockVisualBackend`
   exists. There is no `SidecarBackend`, no `OnnxBackend`.

3. **Missing wiring C — no `CandidateProducer.ingest()` call site.**
   The class exists, unit-tested in isolation, but is never constructed
   in production code.

4. **Missing wiring D — no `pushDirtySignal()` producer.** The
   `onDirtySignal` handler at `desktop-register.ts:146` is idle: no
   code path ever calls `pushDirtySignal(key, candidates)` with
   non-empty candidates during steady-state operation.

5. **Warmup is a fiction.** `GpuWarmupManager._doWarmup()` awaits a
   `setTimeout(50)` when no `warmupFn` is provided
   (`src/engine/vision-gpu/warmup.ts:42`). It does not load a model,
   compile a graph, or acquire any GPU resource. `warmState === "warm"`
   reports readiness that has no corresponding data-plane capability.

### Work required (priority order, rough estimates)

All estimates assume an engineer familiar with this codebase. Revise
upward for anyone new to Windows capture APIs.

1. **Quick win — OCR → CandidateProducer adapter (≈ 4–6 h).**
   Reuse the existing PrintWindow + win-ocr path. Map each
   `SomElement` to a fake "ROI seen for 3 consecutive frames" so that
   `TrackStore` promotes it to `stable`, feed fusion with the OCR
   text, and emit `visual_gpu` candidates via `pushDirtySignal`.
   No new native code. Immediately non-empty for Outlook PWA.
   Downside: polls rather than event-driven; cost scales with how
   often `desktop_see` is called.

2. **Dirty-rect source via Desktop Duplication (≈ 1–2 d native + 0.5 d TS).**
   New Rust / NAPI entry that returns the dirty rectangle list for a
   `hwnd`. Wire it into `RoiScheduler.scheduleRois()`; feed scheduled
   rois into `TrackStore.update()`. Replaces step 1's polling with
   real event-driven refresh.

3. **SidecarBackend or OnnxBackend (≈ 3–5 d).**
   Replace `PocVisualBackend` behind `VisualBackend`. Options:
   - ONNX Runtime inline (DETR / RT-DETR small, OCR via existing
     win-ocr.exe retained as recogniser).
   - Spawn a native sidecar process with a DirectML / CUDA detector.
   Either way `CandidateProducer.ingest()` becomes the glue between
   detector+recogniser output and the dirty-signal bus.

4. **Real warmup (≈ 0.5 d).**
   Replace `setTimeout` simulation in `GpuWarmupManager` with actual
   model / session instantiation. Required before any latency claim
   in `BenchmarkHarness` is meaningful.

5. **Benchmarks and quality gates (≈ 1 d).**
   Reuse `BenchmarkHarness` to measure cold / warm / idle cost on
   Outlook, Chrome, and a test native window. Gate at latency and
   recall numbers before promoting the lane from PoC.

Recommended sequence: 1 → 2 → 5 (ship OCR-backed `visual_gpu` first so
the lane stops being ornamental), then 3 → 4 for the real GPU path.
