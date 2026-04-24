# desktop-touch-mcp — Project-wide Wiring Audit (2026-04-24)

Companion to `docs/visual-gpu-capability-audit.md`. The Visual GPU backend
exposed a "complete control plane, zero data plane" pattern. This document
answers: **Are there other subsystems with the same failure mode?**

Scope: everything under `src/engine/vision-gpu/`, `src/engine/world-graph/`,
the desktop v2 tool layer (`src/tools/desktop-register.ts`,
`src/tools/desktop-providers/`, `src/tools/desktop.ts`,
`src/tools/desktop-executor.ts`), the primary engine bridges
(`ocr-bridge`, `uia-bridge`, `cdp-bridge`, `image`, `win32`, `native-engine`,
`layer-buffer`, `nutjs`, `window-cache`), the MCP entry points
(`src/index.ts`, `src/server-windows.ts`), and the perception resource layer
touched from `desktop-register` / the compose providers.

Methodology:
1. Start at each MCP `server.tool(...)` registration and walk the import graph.
2. For every exported `class` / factory, check whether it is `new`'d,
   `create*()`'d, or otherwise constructed outside tests.
3. For every exported `interface`, check whether a production implementation
   reaches the facade.
4. For every `register*(handler)` pattern, check whether a producer ever
   emits to that handler at runtime (not just tests).
5. Cross-check `TODO / FIXME / Poc / stub / placeholder / Mock / not yet
   implemented / setTimeout(simulate)` against the production call graph.

---

## 1. Summary table

| Component                                    | Pattern | Severity     | One-line summary |
|----------------------------------------------|---------|--------------|------------------|
| Visual GPU data plane                        | A+B+C+D | 🔴 critical  | Control plane wired; no capture / detector / recognizer / producer ever runs. Lane is ornamental — always empty. (Known, see `visual-gpu-capability-audit.md`.) |
| `GpuWarmupManager._doWarmup` (`setTimeout(50)`) | A   | 🔴 critical  | Reports `warmState === "warm"` after 50 ms of nothing. Any quality / latency claim downstream is meaningless. Part of the Visual GPU defect cluster. |
| `CandidateProducer` / `RoiScheduler` / `TrackStore` / `TemporalFusion` | C | 🔴 critical | Full algorithmic pipeline. 4 exported classes + `CandidateProducer.create()` factory, unit-tested in isolation, **zero production `new` sites** — only test files instantiate them. |
| `PocVisualBackend.updateSnapshot` consumers  | D       | 🔴 critical  | The only writer in prod is the `onDirtySignal` handler at `desktop-register.ts:146`. `pushDirtySignal()` is never called from `src/` — only from `tests/unit/*`. |
| `ReplayBackend` + `MockVisualBackend` + `BenchmarkHarness` | C | 🟢 minor  | Deliberate test/future-work artefacts. Safe so long as their test-only status stays documented. |
| `getVisualIngressSource()` / `getPocVisualBackend()` exports | C | 🟢 minor | Exported as "entry point for P3-D" but only `tests/unit/*` consumes them. Dead export in the production graph. |
| `visual-provider.ts` retry on `evicted`      | B       | 🟢 minor     | Second `ensureWarm` call is reachable, but "evicted" only fires after `VisualRuntime.dispose()`. With the PoC backend lifecycle, this branch is production-dead. Correct behaviour when a real backend arrives. |
| OCR → SoM lane (`fetchOcrCandidates`)        | —       | 🟢 working   | PrintWindow + `win-ocr.exe` is genuinely wired; feeds `source: "ocr"` candidates on UIA-blind windows. Real fallback path for the Visual GPU gap. |
| `perception` subsystem                       | D (partial) | 🟡 major | Big opt-in resource layer, gated by `DESKTOP_TOUCH_PERCEPTION_RESOURCES=1` (off by default). One view (`"events"`) still returns `"events view not yet implemented"` (`perception-resources.ts:232`). The lens/sensor pipeline itself is wired. |
| `terminal-provider` line cap                 | A (micro) | 🟢 minor    | `TODO (Phase 3): add a line-cap parameter to getTextViaTextPattern.` (`terminal-provider.ts:58`). Functional, just inefficient on large scrollbacks. |
| `desktop-executor.cdpClick` CDP port         | A (micro) | 🟢 minor    | `TODO: support non-default CDP port via TargetSpec.cdpPort` (`desktop-executor.ts:212`). Pinned to 9222. |
| `runtime.ts` WarmTarget.kind                 | B (micro) | 🟢 minor    | `kind: "game"` is an unused metadata tag across all current backends. Harmless; flagged so it isn't mistaken for real routing. |
| Resolver legacy `sourceId` fallback path     | A (micro) | 🟢 minor    | `TODO: add dedicated terminalWindowTitle field on UiEntityCandidate in P3` (`resolver.ts:113`). Bridge that emits a `console.warn`. All current providers set `locator` directly, so the fallback is cold code. |
| Other tools (mouse, keyboard, screenshot, workspace, scroll-capture, browser, terminal, wait-until, clipboard, notification, dock, macro, pin, scroll-to-element, smart-scroll, context, events, ui-elements, engine-status) | — | 🟢 working | Real native bindings via `nutjs` / `koffi` / `win-ocr.exe` / UIA / CDP / WinEvents. No stub patterns found. |

Legend: 🔴 critical — lane / feature does not provide its advertised capability.
🟡 major — partial feature or opt-in gated off by default.
🟢 minor — cosmetic TODOs or unused-but-harmless exports.

---

## 2. Detailed findings

### 2.1 Visual GPU data plane (already audited — confirmed here)

See `docs/visual-gpu-capability-audit.md` for the deep dive. Re-verified:

- `RoiScheduler.scheduleRois` (`src/engine/vision-gpu/roi-scheduler.ts:72`)
  is a pure function; it is only called from `tests/unit/roi-scheduler.test.ts`.
  No `grep` hit inside `src/` other than its own definition.
- `TrackStore`, `TemporalFusion`, `CandidateProducer`: all four classes /
  the factory `CandidateProducer.create` are only `new`'d inside
  `src/engine/vision-gpu/candidate-producer.ts` test factory + test files.
  No `new TrackStore(`, `new TemporalFusion(`, or
  `CandidateProducer.create(` call site exists in `src/tools/` or
  `src/engine/` outside the vision-gpu folder itself.
- `pushDirtySignal(...)` (`src/engine/vision-gpu/dirty-signal.ts:48`) —
  production callers: **zero**. All call sites are under `tests/unit/`.
- `onDirtySignal(handler)` is registered exactly once, at
  `src/tools/desktop-register.ts:146`, and forwards to
  `PocVisualBackend.updateSnapshot`. With no producer, the handler is idle
  at runtime.
- `PocVisualBackend` (`src/engine/vision-gpu/poc-backend.ts`) stores
  candidates in a `Map` that has no production writer. Any `visual_gpu`
  source candidate observed in production is therefore 0 by construction.

Severity 🔴 critical: the entire `visual_gpu` lane returns [] at runtime,
even though `fetchVisualCandidates` reports `warmState === "warm"`.

### 2.2 Simulated warmup — `GpuWarmupManager._doWarmup`

File: `src/engine/vision-gpu/warmup.ts:37-53`

```ts
if (this.warmupFn) {
  await this.warmupFn(target);
} else {
  await new Promise<void>((r) => setTimeout(r, this.coldWarmupMs)); // 50 ms
}
```

In production `PocVisualBackend` constructs `new GpuWarmupManager({ coldWarmupMs: 50 })`
without providing `warmupFn`. After 50 ms of real-time sleep,
`warmState` flips to `"warm"` and `visual-provider.ts` happily reports
"backend ready". No model is loaded, no GPU handle is acquired, no session
is compiled.

Consequence: any latency / recall number surfaced via `BenchmarkHarness`
against this warmup is meaningless. Fortunately `BenchmarkHarness` itself
is not wired to any tool (see 2.4), so no user-visible claim depends on it
yet.

Severity 🔴 critical (as a contributor to the Visual GPU defect cluster).

### 2.3 Dead exports in `desktop-register.ts`

File: `src/tools/desktop-register.ts:97,105`

```ts
export function getVisualIngressSource(): VisualIngressSource | undefined { ... }
export function getPocVisualBackend(): PocVisualBackend | undefined { ... }
```

Both are documented as "call this from the P3-D pipeline / external code
(e.g. GPU pipeline)". Neither is referenced anywhere in `src/`. Only
`tests/unit/{dirty-signal,poc-backend,benchmark-gates}.test.ts` calls them.

Severity 🟢 minor on its own; 🔴 critical when read together with 2.1 —
the "external caller" they were designed for does not exist.

### 2.4 `BenchmarkHarness` / `ReplayBackend` / `MockVisualBackend`

- `BenchmarkHarness` (`src/engine/vision-gpu/benchmark.ts`) — never
  instantiated outside `tests/`. No tool surface, no CLI entry.
- `ReplayBackend` (`src/engine/vision-gpu/replay-backend.ts`) — referenced
  only by its own doc comments and a one-line mention in
  `src/engine/vision-gpu/runtime.ts:105` (describing unused-but-metadata
  `WarmTarget.kind`). No production `new` site.
- `MockVisualBackend` (`src/engine/vision-gpu/backend.ts`) — in the same
  file as the interface; used by unit tests only.

These are legitimate fixture / future-implementation artefacts, not
misleading stubs, as long as they are not advertised to the LLM as
capabilities. No MCP tool exposes any of them.

Severity 🟢 minor.

### 2.5 `visual-provider` `evicted` retry path

File: `src/tools/desktop-providers/visual-provider.ts:53-64`

```ts
if (warmState === "evicted") {
  try { warmState = await runtime.ensureWarm(warmTarget); } catch { ... }
  if (warmState !== "warm") return { candidates: [], warnings: ["visual_provider_warming"] };
}
```

`GpuWarmupManager` only transitions to `"evicted"` from `dispose()`. In
production, `PocVisualBackend.dispose()` is called by `VisualRuntime.attach()`
when replacing a previous backend, and by `_resetFacadeForTest()`. Neither
fires during steady-state operation. The retry therefore handles a state
that current code will not produce — it is forward-compatible armour for
`SidecarBackend` / `OnnxBackend`, which would evict on session teardown.

Severity 🟢 minor (correct forward-looking code, currently cold).

### 2.6 `perception` subsystem — optional `events` view stub

File: `src/tools/perception-resources.ts:232`

```ts
case "events": body = { lensId: lens.lensId, message: "events view not yet implemented" }; break;
```

`perception-resources` is itself gated behind `DESKTOP_TOUCH_PERCEPTION_RESOURCES=1`
(`server-windows.ts:205-207`). The resource URI scheme advertises `summary`,
`guards`, `debug`, `events` views. Three are implemented; the fourth returns
an explicit "not yet implemented" message rather than failing.

The underlying `perception/` subsystem itself is live:
- `stopNativeRuntime` imported from `perception/registry.js` is called at
  shutdown (`server-windows.ts:243`).
- `evaluatePreToolGuards` / `buildEnvelopeFor` are consumed by
  `browser.ts`, `keyboard.ts`, `mouse.ts`, `ui-elements.ts`,
  `_action-guard.ts` — the guard & envelope paths are wired.
- `sensors-win32`, `sensors-uia`, `sensors-cdp` are started by
  `startSensorLoop` / `startUiaSensorLoop` / `startCdpSensorLoop` from
  `perception/registry.ts`. Native WinEvent sidecar is wired via
  `NativeSensorBridge` + `RawEventQueue` + `FlushScheduler`.
- `HotTargetCache` is read/written from `action-target.ts` + `_action-guard.ts`.

Severity 🟡 major for the `events` MCP resource view (opt-in, does not break
default tooling). The rest of `perception/` is wired.

### 2.7 Micro-TODOs (harmless)

| Location | TODO | Severity |
|---|---|---|
| `src/engine/event-bus.ts:8` | "MCP notifications/message push is not implemented — clients should …" — deliberate design limit, not a stub. | 🟢 minor |
| `src/tools/desktop-executor.ts:212` | CDP port hardcoded to 9222. Works for the overwhelmingly common case. | 🟢 minor |
| `src/tools/desktop-providers/terminal-provider.ts:58` | Line-cap on `getTextViaTextPattern`. Cosmetic. | 🟢 minor |
| `src/engine/world-graph/resolver.ts:113` | Legacy `sourceId` → `locator` bridge. All current providers emit `locator` directly; the fallback warns with `console.warn` and is cold. | 🟢 minor |
| `src/engine/vision-gpu/runtime.ts:107` | `WarmTarget.kind` metadata unused by all backends. | 🟢 minor |

### 2.8 Subsystems cleared by audit

- **UIA bridge** (`src/engine/uia-bridge.ts`) — Rust-native path via
  `nativeUia` with PowerShell fallback. Real implementation,
  `clickElement` / `setElementValue` / `getUiElements` /
  `getTextViaTextPattern` / `detectUiaBlind` all used by production
  providers and the executor.
- **OCR bridge** (`src/engine/ocr-bridge.ts`) — spawns real `bin/win-ocr.exe`
  via stdin/stdout with a timeout; `runSomPipeline` /
  `printWindowToBuffer` / `snapToDictionary` all exercised by
  `ocr-provider.ts`.
- **CDP bridge** (`src/engine/cdp-bridge.ts`) — `evaluateInTab` /
  `getElementScreenCoords` / `listTabsLight` consumed by
  `browser-provider.ts`, `browser-ingress.ts`, and
  `desktop-executor.ts::cdpClick/cdpFill`.
- **world-graph** (`src/engine/world-graph/`) — `SessionRegistry`,
  `LeaseStore`, `GuardedTouchLoop`, `resolveCandidates`,
  `SnapshotIngress`, `combineEventSources`, `createWinEventIngressSource`,
  `createBrowserIngressSource`, `createTerminalIngressSource`,
  `createVisualIngressSource` are all wired from
  `desktop-register.getDesktopFacade()`. The `markDirty` entry on the
  visual ingress source is the only one whose producer is missing — it
  comes from `PocVisualBackend.onDirty`, which only fires when
  `updateSnapshot` is called, which (as established) never happens in prod.
- **`desktop-executor.ts`** — `uiaClick`, `uiaSetValue`, `cdpClick`,
  `cdpFill`, `terminalSend` (background WM_CHAR), `mouseClick` all resolve
  to real native bindings (`nutjs`, `uia-bridge`, `cdp-bridge`, `bg-input`,
  `win32`).
- **`image.ts` / `win32.ts` / `native-engine.ts` / `layer-buffer.ts` /
  `window-cache.ts`** — all real native-backed implementations (koffi,
  `user32.dll`, `gdi32.dll`, native Rust addons, sharp encoding).
- **Remaining tools** — `screenshot`, `mouse`, `keyboard`, `window`,
  `ui-elements`, `workspace`, `pin`, `macro`, `scroll-capture`, `browser`,
  `dock`, `wait-until`, `context`, `terminal`, `events`, `clipboard`,
  `notification`, `scroll-to-element`, `smart-scroll`, `perception`,
  `engine-status` — all registered in `server-windows.ts:182-202`, all
  backed by real implementations.

---

## 3. Overall verdict

### Does the "control-plane-only, data-plane-missing" pattern recur?

**Only inside the Visual GPU cluster.** The four modules that together look
like a visual recognition pipeline — `GpuWarmupManager`, `RoiScheduler`,
`TrackStore` + `TemporalFusion`, `CandidateProducer` — are one logical
defect: a complete algorithmic scaffold with no frame source, no detector,
no producer. Counting them as separate criticals overstates the blast
radius. They are a single "Visual GPU data plane missing" finding expressed
in four files.

No other subsystem audited exhibits this pattern. The patterns that
superficially match (e.g. `ReplayBackend`, `MockVisualBackend`,
`BenchmarkHarness`, `visual-provider` `evicted` retry) turn out on inspection
to be test fixtures, future-work armour, or opt-in feature flags whose
default-off behaviour is honest.

### Recommendation

**Continue the project. Do not rebuild.**

Reasons:
- Exactly one critical wiring defect exists (Visual GPU data plane),
  and it is well-contained behind a single provider (`visual-provider.ts`)
  and a clean backend interface (`VisualBackend`). Replacing
  `PocVisualBackend` with a real implementation is a local surgery, not
  an architectural rewrite.
- The OCR → SoM lane already fills the visual lane's role on UIA-blind
  targets — the product is shippable today for that workflow, albeit
  under a different `source` label (`"ocr"` instead of `"visual_gpu"`).
- Every other lane — UIA, CDP, terminal, OCR, perception — is genuinely
  wired to real native / subprocess / IPC infrastructure. The heavy
  lifting (`lease`/`generation`/`digest` lifecycle, ingress caching,
  event sources, executor routing, viewport/focus guards, session
  registry) is non-trivial and works.
- Of the TODOs remaining in production code, none are larger than "add an
  optional parameter". The project is in *hardening* territory, not
  *bring-up* territory — which is exactly what the recent commit history
  (`docs/anti-fukuwarai-v2-phase4b-*`) claims.

### Priority-ordered follow-ups (aligned with Phase 3 suggestions in the capability audit)

1. **Quick win — ship "visual_gpu" as OCR in disguise.**
   The OCR → CandidateProducer adapter sketched in
   `visual-gpu-capability-audit.md` §Phase 3 turns the lane from ornamental
   into useful within a few hours. No new native code; reuses
   `ocr-provider.ts`'s pipeline. After this patch, the first critical
   finding drops from 🔴 to 🟡.
2. **Replace `setTimeout(50)` warmup** once a real backend
   (`SidecarBackend` or `OnnxBackend`) is selected. Until then, the
   simulated warmup is honest: the lane returns [] either way, so the
   fiction of "warm" has no downstream damage beyond cosmetic warnings.
3. **Delete or test-scope the dead exports** (`getPocVisualBackend`,
   `getVisualIngressSource`) once the real producer lands, or move them
   behind a `__test__` re-export to stop advertising capability that
   isn't plugged in.
4. **Consider a kill-switch env var** `DESKTOP_TOUCH_DISABLE_VISUAL_GPU=1`
   so operators with UIA-only workflows can suppress `visual_*` warnings
   entirely until a real backend ships. Low-cost transparency win.

No re-architecture is required. The current design already cleanly
separates "what the lane promises" from "which backend delivers it" via
the `VisualBackend` interface — that is precisely the seam you want when
swapping a PoC for a real implementation. The blocker is shipping a real
implementation, not redesigning the plumbing.
