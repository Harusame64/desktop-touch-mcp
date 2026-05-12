# ADR-015: VBA Extensibility Bridge — `engine-vba-bridge` crate for COM-native VBA module injection and macro execution

- Status: **Draft (Proposed, Round 3)** — Opus Round 1 + Round 2 findings reflected; awaiting Round 3 review
- Date: 2026-05-12 (Round 1 draft) / 2026-05-12 (Round 2 revision) / 2026-05-12 (Round 3 revision)
- Authors: Claude (Sonnet draft, research backed by Opus 2026-05-12 web survey; Opus + Codex review feedback integrated)
- Related:
  - Issue [#256](https://github.com/Harusame64/desktop-touch-mcp/issues/256) (F2: VBE is UIA-blind)
  - Issue [#255](https://github.com/Harusame64/desktop-touch-mcp/issues/255) (F4: MCP server disconnect on parallel keyboard calls)
  - Issue [#257](https://github.com/Harusame64/desktop-touch-mcp/issues/257) (F3: keyboard sequence mode)
  - Issue [#258](https://github.com/Harusame64/desktop-touch-mcp/issues/258) (F1: workspace_launch App Paths)
  - `docs/layer-constraints.md` §6.3 invariant 6 — the "no new tools / no renames" invariant that this ADR makes an explicit ADR-level exception against (see §2.3); the invariant's literal rule text is NOT modified by this ADR's cascade sweep
  - `docs/operation-verification-matrix.md` (cascade sweep target — derivative numeric refs)
  - `docs/architecture-3layer-integrated.md` (cascade sweep target — derivative numeric refs)
  - `docs/system-overview.md` (cascade sweep target — derivative numeric refs)
  - `docs/tool-surface-known-issues.md` (cascade sweep target — derivative numeric refs)
- Blocks: none (UI-driven VBE workaround would always be available as fallback, but is not viable for the promotion demo per dogfood findings)
- Blocked by: this ADR's review and acceptance

---

## 1. Context

### 1.1 Background — dogfood discovery 2026-05-12

While preparing the "Claude writes and runs a VBA macro in Excel" demo (the headline differentiator against Anthropic's `Claude for Excel` GA on 2026-05-07, which writes formulas but cannot run VBA), driving the VBA Editor (VBE) through the existing UIA + keyboard tool stack revealed multiple structural failures in a single short session:

1. VBE returns `focusedElement: null` for the entire MDI workspace; Project Explorer / Code Window / Properties Window children are not enumerable through `IUIAutomation::ElementFromHandle` + tree walk
2. Menu navigation via `Alt+I, M` (Insert > Module) requires holding the menu open across two tool calls; the natural agent pattern of firing the calls in parallel crashed the MCP server (issue #255), and serializing them with a `desktop_state` between calls closes the menu before the second key fires (issue #257)
3. Coordinate-click fallback would work but is brittle across Excel builds (VBE menu IDs and toolbar layouts drift between Office 365 / 2019 / 2021 / 2024)

The combined fragility makes a reliable 30-second viral demo video (the project's primary promotion artifact per the 2026-05-12 promotion strategy research) **impossible to record reproducibly** via UI-level driving of VBE.

### 1.2 Why UIA / MSAA / SendMessage cannot fix this structurally

| Axis | Why rejected as primary path |
|---|---|
| UIA improvements | VBE does not implement modern UIA providers for its inner controls. Nothing in the host MCP can summon UIA elements that don't exist in the target process. |
| MSAA (`IAccessible`) fallback | VBE's legacy MFC classes (`wndclass_desked_gsk`, `VbaWindow`, `ThunderDFrame`) do respond to MSAA at the container level but expose almost empty children for Project Explorer and Code Window. Worth implementing as a secondary inspection layer (issue #256 carry-over) but cannot drive macro authoring. |
| Win32 `SendMessage(WM_COMMAND, menu_id)` | Office menu IDs shift between builds. UiPath and other industry tools moved off this approach over a decade ago. |

### 1.3 Why this matters now (promotion timing)

`Claude for Excel` (GA 2026-05-07) writes single-workbook formulas through an Office add-in but **cannot author or run VBA**, cannot cross app boundaries, and cannot drive Power Query refresh against external connections. Each of those gaps is structurally addressable via `Excel.Application.VBE.VBProjects` COM access.

A demo built on UI driving of VBE would either crash mid-record (issue #255), drift across Office versions (`SendMessage` path), or fail silently when an element is not in the UIA tree (current state). A demo built on COM access does not depend on any UI being present, drawn, or focused.

---

## 2. Decision

**Adopt the VBA Extensibility Object Model (Excel COM `Application.VBE.VBProjects`) as the production path for VBA authoring and macro invocation. Implement it as a new `engine-vba-bridge` Rust crate, exposed to TypeScript via napi-rs, and surfaced as a single new MCP tool `excel` with an action-discriminated union covering authoring / execution / inspection.**

### 2.1 Why this is the chosen path

- UiPath's `Invoke VBA` activity, Power Automate Desktop's Excel actions, and every comparable mid-to-high-end Windows RPA tool route through the same COM API; this is the **industry standard solution**
- The COM call sites do not touch the VBE UI at all, so the entire class of UI-driving failures (issues #255 / #256 / #257) is structurally bypassed
- The implementation reuses the existing `windows-rs` Rust toolchain that already powers `src/uia/` and the existing vision backend; no new external dependency
- A single new crate cleanly composes: COM bridging primitives are reusable for future Word / PowerPoint / Outlook / OneNote bridges without further architectural cost (each future bridge gets its own ADR + invariant 6 exception, see §2.3)

### 2.2 Why this is not over-investment

- Issue #256 needs to be closed one way or another. Patching UIA / MSAA / SendMessage would each cost roughly the same as this approach for a worse outcome
- The crate is small (< 1,500 lines of Rust including the late-binding `IDispatch` helper and Excel wrapper) and the work is bounded to 2-3 days of focused implementation
- The new MCP tool surface is **additive by exactly +1**. The Trust Center setup path moves to a CLI script (§3.7 / §4.4) for security and surface-count reasons

### 2.3 Invariant 6 exception — explicit ADR-level carve-out

`docs/layer-constraints.md` §6.3 invariant 6 reads literally:

> **既存 tool 名 / 関数シグネチャ / positional args は不変、新規 tool 追加なし、リネームなし**

The invariant prohibits NEW TOOLS, NOT "more than 28 tools." The number 28 does not appear in invariant 6 itself; the value lives in derivative SSOT docs (see §4.5 cascade-sweep table).

This ADR therefore makes an **explicit ADR-level exception** to invariant 6 to add the single `excel` tool. The cascade sweep updates only the derivative docs that publish the "28" count, and adds a cross-reference note in `layer-constraints.md` §6.3 pointing at this ADR as the recognised carve-out.

**Concretely:**

- The invariant 6 rule text in `docs/layer-constraints.md:330` is **NOT modified** by this cascade sweep. It still reads as quoted above
- A footnote / aside is added in `layer-constraints.md` §6.3 immediately after the invariant table, cross-linking to this ADR as the first recognised carve-out
- Derivative docs that say "28 tools" (system-overview, architecture-3layer-integrated, operation-verification-matrix, tool-surface-known-issues) are updated to "29 tools"

**Why an exception, not absorption into an existing tool:**

- `desktop_act` is entity-driven (takes a lease + action against a discovered UI entity); VBA macro authoring has no UI entity to target — semantic mismatch
- `workspace_launch` is process-lifecycle scoped; VBA work is intra-process — semantic mismatch
- `run_macro` already names the existing MCP-level batching primitive (multiple MCP tool calls in one envelope), not Office macros — would mislead callers
- A new top-level `excel` tool keeps the namespace clean and gives Word / PowerPoint / Outlook a clear template for future ADRs (each its own invariant 6 carve-out)

---

## 3. Architecture

### 3.1 Layer map

```
┌─────────────────────────────────────────────────────────┐
│ MCP tool layer (src/tools/excel.ts)                     │
│ - Single `excel` tool, discriminated by `action`        │
│ - Zod schema, AccessVBOM precondition check (read-only),│
│   typed error mapping (VbaAccessNotTrusted etc.)        │
└────────────────────────┬────────────────────────────────┘
                         │ napi-rs binding (TS ↔ Rust)
┌────────────────────────▼────────────────────────────────┐
│ engine-vba-bridge (Rust crate, new)                     │
│ - excel.rs: Excel.Application late-binding wrapper      │
│ - dispatch.rs: IDispatch GetIDsOfNames + Invoke helper  │
│ - variant.rs: VARIANT ↔ serde_json::Value bridge        │
│ - registry.rs: HKCU AccessVBOM READ (write is CLI-only) │
│ - apartment.rs: thread-local STA management             │
└────────────────────────┬────────────────────────────────┘
                         │ COM (IDispatch)
┌────────────────────────▼────────────────────────────────┐
│ Excel.exe (target process)                              │
│  Excel.Application > VBE > VBProjects > VBComponents >  │
│  CodeModule  (no UI involvement)                        │
└─────────────────────────────────────────────────────────┘

CLI side-band (out-of-band setup, NOT in MCP tool surface):
  scripts/enable-access-vbom.mjs  →  writes HKCU AccessVBOM=1
  (intentionally not an MCP tool — see §3.7 / §7 R8)
```

### 3.2 Crate boundary

`crates/engine-vba-bridge/` is a new sibling crate to `crates/engine-perception/` (currently the only crate under `crates/`; the project also has Rust sources directly under `src/` — see §3.4 for the existing UIA worker location):

```
crates/engine-vba-bridge/
├── Cargo.toml          # features: Win32_System_Com, Win32_System_Variant
├── src/
│   ├── lib.rs          # public API surface
│   ├── dispatch.rs     # late-binding IDispatch helper
│   ├── variant.rs      # VARIANT ↔ serde_json::Value conversion
│   ├── apartment.rs    # CoInitializeEx(STA) thread-local manager
│   ├── excel.rs        # Excel.Application wrapper
│   ├── registry.rs     # HKCU AccessVBOM read (write lives in scripts/, not here)
│   └── errors.rs       # typed errors mapped from HRESULT
└── tests/
    └── integration.rs  # gated by `excel-installed` feature
```

The crate is registered in the napi-rs build pipeline, and the produced `.node` is loaded on demand from `src/engine/native-engine.ts` only when the `excel` tool is invoked.

### 3.3 Late-binding `IDispatch` helper (`dispatch.rs`)

Three helpers form the entire COM dance:

```rust
fn invoke_get(disp: &IDispatch, name: &str, args: &[VARIANT]) -> Result<VARIANT>
fn invoke_call(disp: &IDispatch, name: &str, args: &[VARIANT]) -> Result<VARIANT>
fn invoke_put(disp: &IDispatch, name: &str, value: VARIANT) -> Result<()>
```

Each resolves the dispatch ID via `IDispatch::GetIDsOfNames` then calls `IDispatch::Invoke` with the appropriate `DISPATCH_FLAGS` (`PROPERTYGET` / `METHOD` / `PROPERTYPUT`). The Qiita "Rust で Excel オートメーション (windows-rs 版)" reference (linked in §10) targets windows-rs 0.39.0; this project's pin is the workspace-current 0.5x. Read the Qiita example for the late-binding pattern, not for its literal API names.

### 3.4 Apartment model (`apartment.rs`)

`Excel.Application` is a **single-threaded apartment (STA)** COM object. All calls must originate from a thread that has called `CoInitializeEx(COINIT_APARTMENTTHREADED)`. Violating this hangs Excel.

The crate exposes an `ExcelSession` handle that owns one **STA** worker thread; all dispatch calls on a given session route through that thread via a command channel. The high-level shape — one dedicated worker thread + a command channel — mirrors the existing UIA worker at `src/uia/thread.rs:1-50`, with **two intentional differences**:

| Aspect | `src/uia/thread.rs` (existing UIA worker) | `engine-vba-bridge` (this crate) |
|---|---|---|
| COM apartment | MTA (`COINIT_MULTITHREADED`, `src/uia/thread.rs:17`) — UIA is apartment-neutral and MTA simplifies callbacks | **STA (`COINIT_APARTMENTTHREADED`)** — Excel COM strictly requires STA |
| Channel | `crossbeam-channel` (`src/uia/thread.rs:13`) | `crossbeam-channel` (same choice) |
| Lifetime | Process lifetime singleton (`OnceLock`) | Per-`ExcelSession` instance (multi-session safe) |

The pattern is therefore **structurally similar but not byte-identical**. This means the new crate cannot literally reuse `src/uia/thread.rs` — it needs its own STA worker — but the design lessons (channel-based command pump, one Rust thread owns the COM object for its lifetime, panic-safety via `catch_unwind`) all transfer directly.

### 3.5 VARIANT bridge (`variant.rs`)

VBA macro arguments and return values flow through `VARIANT`. The crate exposes:

```rust
fn json_to_variant(v: &serde_json::Value) -> Result<VARIANT>
fn variant_to_json(v: &VARIANT) -> Result<serde_json::Value>
```

Supported types in v1 (covers the dogfood demo + all bench scenarios):

| JSON type | VARIANT type | Notes |
|---|---|---|
| `null` | `VT_NULL` | Matches VBA `IsNull()` semantics. Round 1 incorrectly used `VT_EMPTY` (`IsEmpty()` semantics). Unit test pinned in §4.1. |
| `boolean` | `VT_BOOL` | true → `VARIANT_TRUE` (−1), false → `0` |
| `number` (integer) | `VT_I4` | clamped to i32 range |
| `number` (float) | `VT_R8` | |
| `string` (default) | `VT_BSTR` | BSTR allocated via `SysAllocStringLen`, freed on drop |
| `string` (caller-tagged via wrapper `{__type: "date", value: "<ISO-8601>"}`) | `VT_DATE` | Explicit per-arg opt-in. MCP/JSON transport does not preserve native JavaScript `Date` objects (they serialize to strings); the caller must mark date-typed arguments with an explicit `__type: "date"` discriminator. Otherwise strings stay `VT_BSTR`. |

Out of scope for v1: `VT_ARRAY`, `VT_DISPATCH`, `VT_UNKNOWN`, `VT_CY`, `VT_DECIMAL`. Caller using these would receive a typed error `VbaUnsupportedArgumentType` and can fall back to serializing into a worksheet cell.

### 3.6 Excel-specific wrapper (`excel.rs`)

Public Rust functions (each translates to one action variant of the single `excel` MCP tool):

```rust
// Phase 2c (shipped)
fn ExcelSession::spawn() -> Result<ExcelSession>

// Phase 2d (shipped, PR #261)
fn set_visible(session: &ExcelSession, visible: bool) -> Result<()>
fn workbook_add_new(session: &ExcelSession) -> Result<()>
fn vba_module_add(session: &ExcelSession, module_name: String, code: String) -> Result<()>
fn macro_run(session: &ExcelSession, macro_name: String) -> Result<()>

// Phase 2e (this round)
fn set_display_alerts(session: &ExcelSession, enabled: bool) -> Result<()>
fn workbook_save_as(session: &ExcelSession, path: String, format: XlFileFormat) -> Result<()>
fn workbook_close(session: &ExcelSession, save_changes: bool) -> Result<()>

// Future phases (naming follows the Phase 2c/d/e convention — no
// `excel_` prefix because the surrounding `excel` module path already
// scopes them; cf. `excel::set_visible`, `excel::workbook_save_as`)
fn eval_cell(session: &ExcelSession, sheet: &str, addr: &str) -> Result<serde_json::Value>
fn refresh_power_query(session: &ExcelSession, connection: Option<&str>) -> Result<()>
```

Implementation choices (Round 3 → Phase 2 impl):

- **No separate `WorkbookHandle`.** Round 1 / Round 2 of the ADR
  proposed a typed `WorkbookHandle` parameter for workbook-scoped
  operations (`vba_module_add` / `workbook_save_as` / `workbook_close`).
  The Phase 2 implementation consolidated these around
  `Application.ActiveWorkbook` because the bridge currently only
  manages one workbook per session; introducing `WorkbookHandle`
  would require modelling COM cross-apartment Send/Sync that the
  STA channel already enforces. A future ADR revision may
  reintroduce `WorkbookHandle` if Phase 3+ needs multi-workbook
  authoring.

- **`workbook_close` borrows the session (not consumes).** Round 1
  signature was `excel_close(s: ExcelSession, save: bool)` (consuming).
  Phase 2e implementation uses `workbook_close(&ExcelSession, save_changes: bool)`
  because the call closes the *workbook* (not the *session* / not the
  Excel.Application). The application itself is released only when
  the `ExcelSession` itself is dropped.

- **`XlFileFormat` enum, single variant in v1.** Round 1 used
  `SaveFormat`; Phase 2e renamed to `XlFileFormat` to match the
  Excel COM type-library name (`XlFileFormat` enum in
  Microsoft.Office.Interop.Excel). The v1 implementation exposes
  only `OpenXmlWorkbookMacroEnabled = 52` (`.xlsm`) because the
  Phase 2e demo path requires macro persistence and saving as
  `.xlsx` (`51`) would silently drop the VBA module. Additional
  variants (`OpenXmlWorkbook = 51` / `OpenXmlBinary = 50` / `Xls = 56`)
  are deferred until a caller needs them; the `#[repr(i32)]` value
  layout is forward-compatible.

Each function is a thin wrapper around `invoke_*` helpers on the
appropriate `IDispatch` pointer. The `ExcelSession` handle holds the
COM pointer for `Excel.Application` and the STA worker channel.

### 3.7 AccessVBOM precondition (`registry.rs` — read-only)

Excel returns `0x800AC472 Programmatic access to Visual Basic Project is not trusted` when HKCU `Software\Microsoft\Office\16.0\Excel\Security\AccessVBOM` ≠ 1 and HKLM mirror is not forcing it to 1 via group policy.

One helper (read-only inside the MCP):

```rust
fn check_access_vbom() -> AccessVbomStatus  // { trusted: bool, locked_by_policy: bool, scope: "hkcu" | "hklm" | "default" }
```

**Writing the registry is intentionally NOT exposed as an MCP tool action.** Round 1 draft proposed an `excel.enable_access_vbom` tool action; Opus Round 1 P2-1 concluded that any MCP client should not be able to silently lower Office trust for the user. The setup path lives in a CLI script (`scripts/enable-access-vbom.mjs`). The MCP tool surface emits a typed error `VbaAccessNotTrusted` with a `suggest` pointing at this script.

If HKLM has it forced to 0 by policy, the script returns a typed error explaining no MCP-side workaround exists. The setting only takes effect after Excel is **restarted**.

---

## 4. Phased implementation

### 4.1 Phase 1 — Rust primitives (1 day)

- New crate `engine-vba-bridge` registered in workspace `Cargo.toml`
- `dispatch.rs`, `variant.rs`, `apartment.rs` complete
- Unit tests on `variant.rs` (JSON ↔ VARIANT round-trip for all supported types, including a regression pin for `null → VT_NULL` not `VT_EMPTY`)
- No Excel-specific code yet — just COM primitives

Acceptance:
- `cargo test -p engine-vba-bridge` green for VARIANT bridge
- `cargo build -p engine-vba-bridge` succeeds on the project's standard MSVC toolchain

### 4.2 Phase 2 — Excel wrapper (1 day)

- `excel.rs` complete with all 8 public functions from §3.6
- Integration test under `tests/integration.rs` gated by `excel-installed` feature flag
  - Opens Excel hidden, creates a workbook, adds a module with a known macro, runs it, asserts the return value, closes without saving
- `registry.rs` AccessVBOM read-only check (no write)

Acceptance:
- Integration test passes locally on Excel 365
- `check_access_vbom` correctly distinguishes `trusted` / `locked_by_policy` / `default`

### 4.3 Phase 3 — napi-rs binding (½ day)

- `engine-vba-bridge` exports surfaced through the existing napi build (`src/engine/native-engine.ts`)
- TypeScript types added to `src/engine/native-types.ts`
- Standard `check:native-types` / `check:stub-catalog` CI checks green

Acceptance:
- `npm run build:rs` produces a `.node` that exports **11 functions**: the 8 §3.6 Phase-2c/d/e wrappers (`excelSetVisible` / `excelSetDisplayAlerts` / `excelWorkbookAddNew` / `excelVbaModuleAdd` / `excelWorkbookSaveAs` / `excelMacroRun` / `excelWorkbookClose` + `excelCheckAccessVbom`) **plus** 3 session-lifecycle helpers ergonomically required by the napi handle-ID pattern (`excelSessionSpawn` / `excelSessionClose` / `excelSessionIsAlive`). The 3 lifecycle helpers are NOT in §3.6 because `ExcelSession` cannot cross the napi FFI boundary by value — JS must address it through an integer handle. No `setAccessVbom` — CLI-only.
- `index.d.ts` declares all 11 functions; `src/engine/native-types.ts` declares the `NativeExcelAccessVbomStatus` interface; `npm run check:native-types` enforces the drift gate (Rust `#[napi] pub fn` vs `index.d.ts` `export declare function` parity)

### 4.4 Phase 4 — MCP tool surface (½ day) — single `excel` tool with action dispatcher

One new MCP tool: `excel`. All operations dispatched by a Zod discriminated union on `action`.

**v1.5.0 ships 2 of 4 variants**: Phase 4 ships `run_vba` + `check_access_vbom` only — the headline demo path + its preflight. `eval_cell` and `refresh_query` are v1.5.x carry-over because Phase 2 / §3.6 left their Rust counterparts (`excel::eval_cell` / `excel::refresh_power_query`) tagged "Future phases" with no `#[napi]` export. The TS-side discriminated union grows non-breakingly when those land, so no schema breakage either way. The full 4-variant schema below documents the **eventual** v1.5.x surface; the implementation in `src/tools/excel.ts` ships the 2-variant subset until the Rust functions land.

```ts
const excelInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("run_vba"),
    code: z.string(),
    macroName: z.string().optional(),  // default: "DesktopTouchAdHoc"; must match a Sub declared in `code`
    args: z.array(z.unknown()).optional(),
    workbookPath: z.string().optional(),
    visible: z.boolean().default(false),
    save: z.boolean().default(false),
    closeAfter: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("eval_cell"),
    workbookPath: z.string(),
    sheet: z.string(),
    addr: z.string(),
    visible: z.boolean().default(false),
  }),
  z.object({
    action: z.literal("refresh_query"),
    workbookPath: z.string(),
    connection: z.string().optional(),
    visible: z.boolean().default(false),
  }),
  z.object({
    action: z.literal("check_access_vbom"),  // read-only inspection
  }),
]);
```

**Action-axis classification (matters for `docs/operation-verification-matrix.md`):**

- `run_vba`, `eval_cell` (writes hidden workbook state during evaluation), `refresh_query`: **commit-axis** — produces L1 events, must be verified per §3.1 of operation-verification-matrix
- `check_access_vbom`: **query-axis** — pure registry read, no side-effects, no L1 event, justified per §3.2 of operation-verification-matrix

The tool **as a whole** is classified commit-axis in the overall tool-surface accounting (since at least one action is commit-axis), but the verification matrix per-action breakdown distinguishes the query-axis read.

**Macro authoring contract (Codex Round 2 axis):** the `code` argument must declare at least one `Sub <macroName>(...)` where `<macroName>` matches the `macroName` argument (default `DesktopTouchAdHoc`). Mismatch returns the new typed error `VbaMacroNotFound`.

Typed errors (added to `src/tools/_errors.ts`, **PascalCase single-cap acronym per `Uia*` / `Ime*` convention** — `pascalToSnake` round-trip safe):

| Code | Meaning | snake_case form |
|---|---|---|
| `VbaAccessNotTrusted` | HKCU AccessVBOM is 0; suggest the setup script | `vba_access_not_trusted` |
| `VbaAccessLockedByPolicy` | HKLM forces 0; user must contact IT | `vba_access_locked_by_policy` |
| `ExcelNotInstalled` | `CLSIDFromProgID` returned `REGDB_E_CLASSNOTREG` | `excel_not_installed` |
| `VbaModuleAuthoringFailed` | `AddFromString` returned HRESULT, **OR** `Workbook.SaveAs` failed (rare-path reuse — both are "could not persist macro-bearing workbook" events), **OR** the save-restore guard's `DisplayAlerts` suppress failed before SaveAs (rare-path reuse — the typed error is the only signal the caller has that the SaveAs precondition stage broke) | `vba_module_authoring_failed` |
| `VbaMacroExecutionFailed` | `Application.Run` returned non-zero HRESULT | `vba_macro_execution_failed` |
| `VbaMacroNotFound` | `code` does not declare a Sub matching `macroName` | `vba_macro_not_found` |
| `VbaUnsupportedArgumentType` | caller passed object / array / dispatch into `args` | `vba_unsupported_argument_type` |
| `VbaWorkbookProtected` | `VBProject` access blocked by workbook-level password | `vba_workbook_protected` |

**napi-binding-level typed codes** (Phase 3 napi shim — live in `src/vba_bridge.rs`, not in `engine_vba_bridge::errors`. The crate stays session-handle-agnostic; these surface only when the handle layer is in the call path):

| Code | Meaning | snake_case form |
|---|---|---|
| `SessionNotFound` | the supplied session ID is not in the registry (already closed or never opened) | `session_not_found` |
| `SessionIdExhausted` | the u32 monotonic session counter saturated at `2^32` spawns (practically unreachable) | `session_id_exhausted` |
| `VbaUnsupportedFileFormat` | `excel_workbook_save_as` received a `file_format` numeric value other than `52` (xlOpenXMLWorkbookMacroEnabled) — v1 only accepts `.xlsm` | `vba_unsupported_file_format` |

**TS-binding-only typed codes** (Phase 4 TS-side dispatcher — live in `src/tools/excel.ts`, no Rust crate or napi-shim Producer. Emitted before the napi boundary is crossed so non-Windows callers and pre-v1.5.0 builds get a clean fast-fail without an OS-level COM trip):

| Code | Meaning | snake_case form |
|---|---|---|
| `VbaBridgeUnavailable` | The TS-side `nativeExcel` surface is null — either the host is non-Windows or the addon is a pre-v1.5.0 build that lacks the `vba_bridge` module. Caller should upgrade or relocate to a Windows host with the v1.5.0+ build | `vba_bridge_unavailable` |

Acceptance:
- Single `excel` tool registered in `src/tools/_registry.ts` and visible in `tools/list` as one tool
- `tests/unit/excel-tool.test.ts` covers schema validation per action variant + `VbaMacroNotFound` regression case
- Naming convention check (`pascalToSnake` round-trip) passes for all 12 new typed errors (8 crate-level + 3 napi-binding-level + 1 TS-binding-only)
- The 12 new typed errors are catalogued in `src/tools/_errors.ts` SUGGESTS and surveyed in ADR-010 §5.4
- E2e test gated like §4.2 verifies a full round trip

### 4.5 Phase 5 — Invariant 6 cascade sweep + release (½ day; demo recording is a separate non-blocking step)

**Invariant 6 cascade sweep — derivative docs only, invariant text NOT modified:**

| Document | What changes | What does NOT change |
|---|---|---|
| `docs/layer-constraints.md` §6.3 | Add a footnote / aside row immediately after invariant 6, cross-referencing this ADR as the first recognised carve-out | The invariant 6 row text ("既存 tool 名 / 関数シグネチャ / positional args は不変、新規 tool 追加なし、リネームなし") is **NOT modified** |
| `docs/operation-verification-matrix.md` | All "28" → "29" in §1.4 / §3.1 table totals / §3.2 table totals / §6 acceptance summary. Commit-axis 17 → 18 (the new `excel` tool's `check_access_vbom` action is query-axis but the tool overall is commit-axis; query-axis count stays at 11) | Section structure |
| `docs/architecture-3layer-integrated.md` | "28 tool" / "全 28 tool" / "既存 ~28 tool" → "29 tool" at the 3 occurrences (lines 61, 240, 298 in the file at the time of this ADR's drafting) | Section structure |
| `docs/system-overview.md` | "28 public MCP tools (26 stub catalog + 2 dynamic v2)" → "29 public MCP tools (27 stub catalog + 2 dynamic v2)" at lines 67 and 73 | Section structure |
| `docs/tool-surface-known-issues.md` | Line ~204 "stub catalog 26 + dynamic v2 ... 2 = **28 public tools**" → "stub catalog 27 + dynamic v2 ... 2 = **29 public tools**" | Earlier line ~192 "stub catalog 46 → 26 entries" stays as-is (it documents the prior Phase 4 reduction, not the current count) |
| `docs/llm-operation-audit.md` | Any "28 tool" reference → "29 tool" (sweep at impl time) | Section structure |
| `src/stub-tool-catalog.ts` (auto-generated) | Regenerated via `npm run generate:stub-catalog` — new `excel` entry appears automatically | Manual edits are forbidden |

The sweep is **required to be a single atomic commit** so reviewers can verify "old count → new count" in one diff. Any document where the sweep would conflict with another in-flight change must be sequenced before or after, not interleaved.

**Release:**

- Bump version to the next feature-level release (likely `v1.5.x`; the exact patch level depends on whether ADR-016 Phase 1 ships in the same release. ADR-014 reserves `v1.5.0+` as a stretch slot — coordinate version numbers at release time)
- Follow `docs/release-process.md` for npm + GH Release + MCP Registry publish

**Demo recording — non-blocking promotion stretch, separate from technical acceptance:**

A 30-second MP4 (1080p 9:16) of "Claude writes and runs a VBA macro" can be recorded after the release ships. The recording is a promotion artifact, not a technical acceptance criterion. Placement: `docs/media/excel-vba-demo.mp4`, embedded in README hero.

Acceptance (technical):
- All cascade-sweep documents updated in a single atomic commit
- All e2e tests green on a clean Win11 + Excel 365 install with `AccessVBOM=1` set by the bundled CLI script
- `docs/release-process.md` smoke test passes against the published `npx` invocation

---

## 5. Public API surface — what callers see

Before this ADR lands: **28 public MCP tools** (26 stub + 2 dynamic v2; commit-axis 17 + query-axis 11).

After this ADR lands: **29 public MCP tools** (27 stub + 2 dynamic v2; commit-axis 18 + query-axis 11). The single addition is `excel`, a commit-axis tool whose `check_access_vbom` action is per-action read-only and is justified in `operation-verification-matrix.md` §3.2 alongside other per-tool query-axis exemptions.

Invariant 6 receives an explicit ADR-level carve-out (see §2.3). The invariant's rule text in `docs/layer-constraints.md` is not modified.

---

## 6. Acceptance criteria (whole ADR)

- [ ] Issue #256 (F2 VBE UIA-blind) Resolved by structural bypass (not by improving UIA inspection of VBE)
- [ ] `engine-vba-bridge` crate exists with the 8 functions from §3.6, all behind a single thread-local STA worker
- [ ] `excel` tool succeeds end-to-end on a clean Win11 + Excel 365 install with `AccessVBOM=1` set by the bundled CLI script
- [ ] All 8 crate-level + 3 napi-binding-level + 1 TS-binding-only = **12 typed errors** are catalogued in `_errors.ts` and surveyed in ADR-010 §5.4 (CLAUDE.md §3.1 cascade sweep) — crate-level: `VbaAccessNotTrusted` / `VbaAccessLockedByPolicy` / `ExcelNotInstalled` / `VbaModuleAuthoringFailed` / `VbaMacroExecutionFailed` / `VbaMacroNotFound` / `VbaUnsupportedArgumentType` / `VbaWorkbookProtected`; napi-binding-level (Rust shim): `SessionNotFound` / `SessionIdExhausted` / `VbaUnsupportedFileFormat`; TS-binding-only (`src/tools/excel.ts`, no Rust Producer): `VbaBridgeUnavailable`
- [ ] The new typed-error names pass the `pascalToSnake` round-trip used by `src/tools/_envelope.ts` (Codex Round 1 P2)
- [ ] Cascade sweep landed per §4.5 table in a single atomic commit — invariant 6 rule text in `layer-constraints.md:330` literal-preserved; derivative numeric refs updated 28 → 29
- [ ] No regression in `vitest run` or `cargo test --workspace`

(Demo MP4 is promotion stretch, see §4.5 — not in this acceptance list.)

---

## 7. Risks

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | Workbook has a VBA project password — `wb.VBProject` access raises before any `VBComponents.Add` succeeds | Low (demo uses fresh workbook) | Typed error `VbaWorkbookProtected`; caller can prompt user to unlock manually |
| R2 | Group policy forces HKLM `AccessVBOM=0`, HKCU has no effect | Medium (enterprise) | Typed error `VbaAccessLockedByPolicy` explains no MCP-side workaround exists |
| R3 | STA worker panic kills the Excel `IDispatch` pointer without releasing it — Excel becomes a zombie | Low | `catch_unwind` in worker loop + always release `IDispatch` on drop; integration test asserts process count returns to baseline |
| R4 | `Application.Run` blocks if the VBA macro shows a modal (`MsgBox`, `InputBox`, etc.) and no user is present | Medium (demo uses MsgBox) | Document blocking semantics in the tool description; for headless usage, document `vbInformation`-style synchronous-but-no-prompt alternatives |
| R5 | Excel hidden mode (`visible: false`) plus a VBA `MsgBox` causes an invisible-yet-blocking dialog the user cannot reach | Medium | When `visible: false`, validate code does not contain `MsgBox` / `InputBox` / `Application.Dialogs(...)` (string scan, conservative regex `^[\s]*MsgBox\b`) and raise `BlockingDialogInHiddenMode` if found |
| R6 | Office build drift breaks late-binding (very unlikely — the COM interface is contractually stable since Excel 97) | Very low | Pin the integration test in CI when Excel is available; `CLSIDFromProgID("Excel.Application")` for version independence |
| R7 | Anti-malware flags an unsigned `.node` that calls `Excel.Application` COM as suspicious | Medium | Same exposure as existing native bridges; document in `README` troubleshooting |
| R8 | Auto-registry-mutation social engineering — an attacker who can prompt an MCP client could silently lower Office trust via a write-access tool | Was Medium (Round 1 design) → **structurally eliminated in Round 2** | The setup path is CLI-only (`scripts/enable-access-vbom.mjs`). The MCP tool surface exposes only read-only `check_access_vbom` plus a `suggest` field pointing at the CLI |
| R9 | **`DisplayAlerts = false` leaked past `workbook_save_as`** — caller forgets to reset, subsequent flows silently lose data (e.g. close-without-save prompt suppressed) | Was Medium (Phase 2e Round 1 design) → **structurally eliminated in Phase 2e Round 2** | `workbook_save_as` internally takes a save-restore snapshot of `DisplayAlerts` and always restores it on exit (success OR error). Standalone [`set_display_alerts`] still exists for callers who explicitly want manual control; the demo / Phase 4 MCP tool path NEVER needs to call it directly. **Snapshot read failure fallback**: if the COM `get DisplayAlerts` call itself fails (extremely rare, would indicate apartment teardown in progress), the guard falls back to `true` for the restore, which is the safer default (Excel's installed default, never suppresses alerts) but may slightly diverge from a user's prior explicit `false` setting. Net safety wins over fidelity for this edge case |

---

## 8. Open questions

- **OQ #1** — Should the `run_vba` action accept an array of macros (batch authoring) in v1, or stay single-macro? **Lean: single macro v1**.
- **OQ #2** — *(Resolved by Round 2.)* Tool naming and grouping. Resolved to single `excel` tool with action discriminator. Future Office app bridges get their own top-level tools (`word`, `powerpoint`, `outlook`) — each via its own one-tool ADR exception to invariant 6.
- **OQ #3** — *(Resolved by Round 2.)* AccessVBOM setup as MCP tool or CLI? Resolved to CLI-only.
- **OQ #4** — Should `run_vba` save the workbook before running (so the macro can reference `ThisWorkbook.Path`)? **Lean: only save when caller passes `save: true`**.
- **OQ #5** — How aggressive should the `MsgBox` / `InputBox` string scan in §7 R5 be? **Lean: regex on the start of a line and only when `visible: false`**.
- **OQ #6** — Should MSAA fallback be tackled in this ADR's follow-up or deferred? **Lean: deferred** — close issue #256 with this ADR shipping.
- **OQ #7** — Should the Phase 4 MCP tool surface expose `set_display_alerts` as a public action, or only `workbook_save_as`-internal management? **Lean: only the internal guard in v1.** Rationale: Phase 4's `excel` MCP tool wraps the high-level demo path, not raw COM. Exposing `set_display_alerts` would re-introduce the R9 leak hazard at the MCP envelope layer. If Phase 4 review identifies a concrete caller need (e.g. a long-running session interleaving SaveAs with user-visible interactions), reintroduce as a manual toggle with a matching `excel.reset_display_alerts` cleanup action documented in `_errors.ts` suggestions.
- **OQ #8** *(opened by Opus Round 3 P3 review; Resolved 2026-05-12 by PR #266)* — `readTrustedLocationAllowSubFolders` in `scripts/enable-access-vbom.mjs` duplicated the REG_DWORD parse logic of the existing `readDword`. Refactored to delegate via `readDword(keyPath, "AllowSubFolders")`; behaviour preserved (net -13 / +3 lines).
- **OQ #9** *(opened by Opus Round 3 P3 review; defer-recommended)* — `workbook_save_as` doc-block says "Callers MUST treat the session as poisoned after restore failure" but the restore failure path silently discards the error (`let _ = invoke_put(...)`). The caller has no programmatic signal to detect poisoning. Either (a) remove the MUST and rely on subsequent operations failing organically, or (b) add a poisoning tracking field to `ExcelSession` and surface it via a `is_poisoned()` query. Defer to Phase 4 (when concrete caller patterns clarify the cost/benefit of (b)).
- **OQ #10** *(opened by Phase 3 Round 2 review; defer to Phase 4)* — typed-envelope structured error fields for the napi shim. Currently `VbaBridgeError::Display` produces flat prose strings like `"ComCallFailed: HRESULT=0x800ac472 at CodeModule.AddFromString"` and the Phase 4 TS layer must regex-extract HRESULT / context. napi-rs exposes `Error::new(Status, reason)` with a separate `Status` field that could carry structured data, OR a `code` JSON field could be added to the typed-error mapping. Phase 4 typed envelope design absorbs the trade-off; v1 prefix parsing is sufficient for the demo path.
- **OQ #11** *(opened by Phase 3 Round 2 review; Resolved 2026-05-12 — keep)* — `excelSessionIsAlive` napi export use case. Phase 4 (`src/tools/excel/*.ts`) shipped without an internal consumer (verified by grep: declaration in `index.d.ts:453` / `index.js:133` / `src/engine/native-engine.ts:396`, mocked in `tests/unit/excel-tool.test.ts:31`, no live call site). v1.5.0 already published with the export. Decision: **keep as a defensive surface for future tools** (Tier 4 `eval_cell` / `refresh_query` and the planned `is_poisoned()` query for OQ #9 are likely consumers). Pre-v1.5.x removal would force a breaking re-publish for no observed benefit.

---

## 9. Out of scope

- Word / PowerPoint / Outlook / OneNote VBA bridges (each is its own one-tool invariant 6 exception ADR)
- VBE UI driving (structurally bypassed)
- MSAA / `IAccessible` improvements to VBE inspection (issue #256 follow-up if requested)
- `Application.Quit` semantics around dirty workbooks (later release)
- Chart manipulation / pivot tables (future expansion)

---

## 10. References

All URLs verified accessible on 2026-05-12.

- Issue [#256](https://github.com/Harusame64/desktop-touch-mcp/issues/256) (F2 VBE UIA-blind)
- Issue [#255](https://github.com/Harusame64/desktop-touch-mcp/issues/255) (F4 parallel keyboard crash)
- Issue [#257](https://github.com/Harusame64/desktop-touch-mcp/issues/257) (F3 keyboard sequence mode)
- Issue [#258](https://github.com/Harusame64/desktop-touch-mcp/issues/258) (F1 workspace_launch App Paths)
- [Application.VBE property (Excel) | Microsoft Learn](https://learn.microsoft.com/en-us/office/vba/api/excel.application.vbe)
- [Application.Run method (Excel) | Microsoft Learn](https://learn.microsoft.com/en-us/office/vba/api/excel.application.run)
- [Objects (Visual Basic Add-In Model) | Microsoft Learn](https://learn.microsoft.com/en-us/office/vba/language/reference/visual-basic-add-in-model/objects-visual-basic-add-in-model)
- [Security notes for Office solution developers | Microsoft Learn](https://learn.microsoft.com/en-us/office/vba/library-reference/concepts/security-notes-for-microsoft-office-solution-developers)
- [Pre-Setting Trust access to the VBA project object model via registry | ELB Solutions](https://elbsolutions.com/projects/pre-setting-trust-access-to-the-vba-project-object-model-for-users-via-registry/)
- [Rust で Excel オートメーション (windows-rs 版) — Qiita](https://qiita.com/benki/items/42099c58e07b16293609) (targets windows-rs 0.39.0; read for pattern, not literal API names)
- [IDispatch in windows::Win32::System::Com — windows-rs docs](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/System/Com/struct.IDispatch.html)
- [UiPath Invoke VBA activity](https://docs.uipath.com/activities/other/latest/productivity/invoke-vba)
- ADR-008 (`docs/adr-008-reactive-perception-engine.md`)
- ADR-014 (`docs/adr-014-cooperative-bridge.md`) — phased Draft pattern this ADR mirrors
- `src/uia/thread.rs:1-50` — the existing MTA UIA worker that §3.4 compares against (channel + dedicated thread, MTA apartment vs the new crate's STA apartment)

---

## 11. Decision history

### 2026-05-12 — Draft (Proposed, Round 1)

Author: Claude (Sonnet) + Opus 2026-05-12 research.

Initial draft after dogfood discovery of issue #256 + Opus research confirming VBA Extensibility COM as industry standard. Proposed 2 new MCP tools (`excel.run_vba` + `excel.enable_access_vbom`, i.e. 28 → 30).

### 2026-05-12 — Draft (Proposed, Round 2)

Author: Claude (Sonnet) reflecting Opus + Codex Round 1.

- Consolidated to single `excel` tool with action discriminator per Opus P1-2 (28 → 29 + cascade-sweep)
- Moved `enable_access_vbom` from MCP tool action to CLI-only per Opus P2-1 / R8
- Renamed `AccessVBOM*` typed errors to `Vba*` per Codex P2 (`pascalToSnake` boundary) and Opus P2-2 (acronym convention)
- Fixed `null → VT_NULL` per Opus P3-2
- Resolved OQ #2 / OQ #3 to Decision history per Opus P2-4
- Added §3.4 reference to UIA worker pattern per Opus P3-3 (the reference itself was incorrect in Round 2 — see Round 3)
- Added §7 R8 covering the auto-registry-mutation vector
- Version language relaxed per Opus P2-5
- §10 References URL existence verified per Opus P2-7

### 2026-05-12 — Draft (Proposed, Round 3)

Author: Claude (Sonnet) reflecting Opus Round 2.

- **P1-A** Reframed §2.3 invariant 6 amendment. Invariant 6 literal text (`docs/layer-constraints.md:330`) is **"既存 tool 名 / 関数シグネチャ / positional args は不変、新規 tool 追加なし、リネームなし"** — does NOT contain "28." This ADR makes an **explicit ADR-level exception** to the "new tool" prohibition, not a numeric amendment. The invariant rule text is preserved; only derivative-doc numeric refs are swept
- **P1-B** §3.4 referenced a fictional `crates/engine-uia-bridge/src/worker.rs` — replaced with the actual existing UIA worker at `src/uia/thread.rs:1-50` and clarified that the existing worker uses MTA while this new crate uses STA (so the patterns are structurally similar but not identical)
- **P2-1** §4.5 cascade-sweep table row for `tool-surface-known-issues.md` corrected to match the actual literal phrase on line ~204 of that file ("stub catalog 26 + dynamic v2 ... 2 = 28 public tools")
- **P2-2** §4.4 / §5 / §4.5 commit-axis 17 → 18 narrative clarified to acknowledge that `check_access_vbom` is per-action query-axis even though the `excel` tool as a whole is commit-axis-classified
- **P2-6** Removed "(optional)" from §6 acceptance checkboxes; demo recording is a non-blocking promotion step in §4.5
- **P2-7** §11 Decision history reformatted from single-row long entries to bulleted sub-lists per round for legibility
- **P3-B** §3.5 JSON Date type clarified — caller must tag date-typed arguments explicitly via `{__type: "date", value: "<ISO>"}` since MCP/JSON transport does not preserve native Date objects
- Added `VbaMacroNotFound` typed error per Codex Round 2 axis (macro authoring contract)

### 2026-05-12 — Implementation update (Phase 2e Round 2 reflecting Opus Round 1)

Author: Claude (Sonnet) reflecting Opus Round 1 on Phase 2e PR.

- **§3.6 signature alignment** — Round 1 / 2 listed `SaveFormat` enum, `WorkbookHandle` type, `excel_close(s: ExcelSession, save: bool)` consuming session. Phase 2 implementation consolidated around `ExcelSession::ActiveWorkbook` (no `WorkbookHandle`), renamed enum to `XlFileFormat` (Excel COM type-library parity), changed close to borrowing `&ExcelSession` (closes workbook, not session). §3.6 prose updated to document each implementation choice with rationale; signature table now matches Phase 2 / Phase 2e crate surface
- **§7 R9** added — "`DisplayAlerts = false` leaked past `workbook_save_as`" — structurally eliminated by the save-restore guard inside `workbook_save_as` (preserves the prior `DisplayAlerts` value, sets `false` for the SaveAs window, restores on exit including error paths)
- **§8 OQ #7** added — whether Phase 4 should expose `set_display_alerts` as a public MCP tool action. Lean: only the internal guard in v1 (avoids re-introducing the R9 leak at MCP envelope layer)

### 2026-05-12 — Implementation update (Phase 3 Round 2 reflecting Opus Round 1)

Author: Claude (Sonnet) reflecting Opus Round 1 on Phase 3 PR.

- **§4.3 acceptance fixed** — Round 1 referenced a `cargo build --bin generate-types` that never existed; replaced with the actual `check:native-types` drift gate. Also corrected the function count from "8 + checkAccessVbom" (=9) to "11 functions" with explicit itemization of the 8 §3.6 wrappers + 3 session-lifecycle helpers (`excelSessionSpawn` / `excelSessionClose` / `excelSessionIsAlive`). Lifecycle helpers are NOT in §3.6 because `ExcelSession` cannot cross the napi FFI boundary by value
- **§4.4 binding-level codes table added** — Round 2 introduced 3 new typed-error codes that live in the napi shim (`src/vba_bridge.rs`), not in the `engine_vba_bridge::errors` enum: `SessionNotFound`, `SessionIdExhausted`, `VbaUnsupportedFileFormat`. They are listed in a sub-table alongside the 8 crate-level codes so Phase 4's `_errors.ts` SUGGESTS catalog has the full set
- **§6 acceptance** — typed-error count updated "8 new typed errors" → "8 crate-level + 3 binding-level = 11 typed errors" (subsequently bumped to **12** in Phase 4 Round 2 — see entry below for the `VbaBridgeUnavailable` TS-binding-only addition)
- **§8 OQ #10 / OQ #11 added** — Phase 4 carry-overs persisted in docs per CLAUDE.md §9 (commit-message-only deferral was insufficient)
- **`src/vba_bridge.rs` `NEXT_ID` race-free** — Round 2's `load+fetch_add` check-then-act window replaced with `fetch_update` CAS loop. Even if Phase 4 introduces `AsyncTask` and removes the libuv-single-threaded property, the saturation check + increment are now a single atomic transition

### 2026-05-12 — Implementation update (Phase 4 Round 2 reflecting Opus Round 1)

Author: Claude (Sonnet) reflecting Opus Round 1 on Phase 4 PR.

- **§4.4 binding-level table split into two sub-tables** — Opus Round 2 P2-1 flagged a categorisation contradiction: the original sub-table header said "live in `src/vba_bridge.rs`" but the new `VbaBridgeUnavailable` row was TS-only. Split into "napi-binding-level" (3 rows: SessionNotFound / SessionIdExhausted / VbaUnsupportedFileFormat) + "TS-binding-only" (1 row: VbaBridgeUnavailable). The latter sub-table header now explicitly states "live in `src/tools/excel.ts`, no Rust crate or napi-shim Producer"
- **§6 acceptance — typed-error count bumped 11 → 12** — Phase 4 `_errors.ts` ships `VbaBridgeUnavailable` for the non-Windows / pre-v1.5.0 build path (TS-binding-only, emitted before the napi boundary). 12 = 8 crate + 3 napi-binding + 1 TS-binding-only. **All sibling acceptance lines** (the 3 acceptance bullets under §6 plus the §4.4 binding-level sub-table count) updated bit-equal so future archeology doesn't see "11" / "8" stale refs. (Line numbers omitted intentionally because subsequent doc edits cause line drift; use `grep "12 (new )?typed errors" docs/adr-015-vba-extensibility-bridge.md` to enumerate the current set.)
- **ADR-010 §5.4 cascade sweep** — §6 acceptance explicitly requires "surveyed in ADR-010 §5.4". Added the 12 ADR-015 Phase 4 typed codes to ADR-010 §5.4 catalog. ADR-010 §1 TOC summary line bumped to 63 codes (live 51 [39 baseline + 12 ADR-015 Phase 4], ADR-added 12). Round 3 review also surfaced that `ImeOnDuringType` (Issue #245) was previously missing from the §5.4 body and §1 TOC formula — bumped baseline 38 → 39 across all 4 sync points (TOC line / §5.4 prose / `全 N codes` heading / `合計 N codes` total) and inserted `ImeOnDuringType` as a new "IME" sub-section between 入力チャネル and Workspace blocks
- **§4.4 schema example prologue** — added explicit "v1.5.0 ships 2 of 4 variants" note explaining the `eval_cell` / `refresh_query` deferral and non-breaking forward compatibility. Future readers will not need git archaeology to understand why the ADR schema lists 4 variants while the impl ships 2
- **`excel.ts` polish** — classify ordering rationale documents the pre-COM regex pre-flight (`codeDeclaresMacro`) short-circuit that makes chain scenarios structurally impossible; AccessVBOM preflight rationale cites ADR §7 R3 + §3.5 (200-500ms Excel.exe spawn + STA worker init saving, R3 zombie-process risk avoidance); `getTrustedDir()` error message stripped of embedded `\n` so envelope render stays clean for LLM agents
