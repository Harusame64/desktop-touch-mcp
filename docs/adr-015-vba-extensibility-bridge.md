# ADR-015: VBA Extensibility Bridge — `engine-vba-bridge` crate for COM-native VBA module injection and macro execution

- Status: **Draft (Proposed)** — awaiting Opus + Codex review on this plan before implementation
- Date: 2026-05-12
- Authors: Claude (Sonnet draft, research backed by Opus 2026-05-12 web survey)
- Related:
  - Issue [#256](https://github.com/Harusame64/desktop-touch-mcp/issues/256) (F2: VBA Editor (VBE) / legacy MFC Office host is UIA-blind — `focusedElement: null`, Project Explorer / Code Window invisible to UIA tree walk)
  - Issue [#255](https://github.com/Harusame64/desktop-touch-mcp/issues/255) (F4: MCP server disconnect on parallel `keyboard` calls — concurrent UI-level VBE driving is structurally fragile)
  - Issue [#257](https://github.com/Harusame64/desktop-touch-mcp/issues/257) (F3: keyboard sequence mode — VBE menu navigation via UI is brittle even without F4)
  - Issue [#258](https://github.com/Harusame64/desktop-touch-mcp/issues/258) (F1: `workspace_launch` Office App Paths resolution — orthogonal but in same dogfood batch)
- Blocks: none (UI-driven VBE workaround would always be available as fallback, but is not viable for the promotion demo per dogfood findings)
- Blocked by: this ADR

---

## 1. Context

### 1.1 Background — dogfood discovery 2026-05-12

While preparing the "Claude writes and runs a VBA macro in Excel" demo (the headline differentiator against Anthropic's `Claude for Excel` GA on 2026-05-07, which writes formulas but cannot run VBA), driving the VBA Editor (VBE) through the existing UIA + keyboard tool stack revealed multiple structural failures in a single short session:

1. VBE returns `focusedElement: null` for the entire MDI workspace; Project Explorer / Code Window / Properties Window children are not enumerable through `IUIAutomation::ElementFromHandle` + tree walk
2. Menu navigation via `Alt+I, M` (Insert > Module) requires holding the menu open across two tool calls; the natural agent pattern of firing the calls in parallel crashed the MCP server (issue #255), and serializing them with a `desktop_state` between calls closes the menu before the second key fires (issue #257)
3. Coordinate-click fallback would work but is brittle across Excel builds (VBE menu IDs and toolbar layouts drift between Office 365 / 2019 / 2021 / 2024)

The combined fragility makes a reliable 30-second viral demo video (the project's primary promotion artifact per the 2026-05-12 promotion strategy research) **impossible to record reproducibly** via UI-level driving of VBE.

### 1.2 Why UIA / MSAA / SendMessage cannot fix this structurally

Per the 2026-05-12 research:

| Axis | Why rejected as primary path |
|---|---|
| UIA improvements | VBE does not implement modern UIA providers for its inner controls. Nothing in the host MCP can summon UIA elements that don't exist in the target process. |
| MSAA (`IAccessible`) fallback | VBE's legacy MFC classes (`wndclass_desked_gsk`, `VbaWindow`, `ThunderDFrame`) do respond to MSAA at the container level but expose almost empty children for Project Explorer and Code Window. Worth implementing as a secondary inspection layer but cannot drive macro authoring. |
| Win32 `SendMessage(WM_COMMAND, menu_id)` | Office menu IDs shift between builds. UiPath and other industry tools moved off this approach over a decade ago. |

### 1.3 Why this matters now (promotion timing)

`Claude for Excel` (GA 2026-05-07) writes single-workbook formulas through an Office add-in but **cannot author or run VBA**, cannot cross app boundaries, and cannot drive Power Query refresh against external connections. Each of those gaps is structurally addressable via `Excel.Application.VBE.VBProjects` COM access. The promotion strategy hinges on a demo that visibly does at least one of: dynamically generate a VBA macro, run it, and surface the result — all without a user touching VBE.

A demo built on UI driving of VBE would either crash mid-record (issue #255), drift across Office versions (`SendMessage` path), or fail silently when an element is not in the UIA tree (current state). A demo built on COM access does not depend on any UI being present, drawn, or focused.

---

## 2. Decision

**Adopt the VBA Extensibility Object Model (Excel COM `Application.VBE.VBProjects`) as the production path for VBA authoring and macro invocation. Implement it as a new `engine-vba-bridge` Rust crate, exposed to TypeScript via napi-rs, and surfaced as one or more new MCP tools under an `excel.*` or `office.*` namespace.**

UIA, MSAA, and `SendMessage` remain available for **inspection** of VBE state when a user opens it manually, but are not used for **authoring or executing** VBA. Inspection-side improvements are deferred to a follow-up addressed under issue #256's carry-over.

### 2.1 Why this is the chosen path

- UiPath's `Invoke VBA` activity, Power Automate Desktop's Excel actions, and every comparable mid-to-high-end Windows RPA tool route through the same COM API; this is the **industry standard solution**, not a novel approach
- The COM call sites do not touch the VBE UI at all, so the entire class of UI-driving failures (issues #255 / #256 / #257) is structurally bypassed, not patched
- The implementation reuses the existing `windows-rs` Rust toolchain that already powers `engine-uia-bridge` and `engine-vision`; no new external dependency, no new transport
- A single new crate cleanly composes: COM bridging primitives are reusable for future Word / PowerPoint / Outlook / OneNote bridges without further architectural cost

### 2.2 Why this is not over-investment

- Issue #256 needs to be closed one way or another. Patching UIA / MSAA / SendMessage would each cost roughly the same as this approach for a worse outcome
- The crate is small (< 1,500 lines of Rust including the late-binding `IDispatch` helper and Excel wrapper) and the work is bounded to 2-3 days of focused implementation
- The new MCP tool surface is additive; no existing tool changes shape

---

## 3. Architecture

### 3.1 Layer map

```
┌─────────────────────────────────────────────────────────┐
│ MCP tool layer (src/tools/excel-run-vba.ts, …)          │
│ - Public Zod schema, AccessVBOM precondition check,     │
│   typed error mapping (AccessVBOMNotTrusted etc.)       │
└────────────────────────┬────────────────────────────────┘
                         │ napi-rs binding (TS ↔ Rust)
┌────────────────────────▼────────────────────────────────┐
│ engine-vba-bridge (Rust crate, new)                     │
│ - excel.rs: Excel.Application late-binding wrapper      │
│ - dispatch.rs: IDispatch GetIDsOfNames + Invoke helper  │
│ - variant.rs: VARIANT ↔ serde_json::Value bridge        │
│ - registry.rs: HKCU AccessVBOM check + setup            │
│ - apartment.rs: thread-local STA management             │
└────────────────────────┬────────────────────────────────┘
                         │ COM (IDispatch)
┌────────────────────────▼────────────────────────────────┐
│ Excel.exe (target process)                              │
│  Excel.Application > VBE > VBProjects > VBComponents >  │
│  CodeModule  (no UI involvement)                        │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Crate boundary

`crates/engine-vba-bridge/` is a new sibling crate to `engine-uia-bridge` and `engine-vision`:

```
crates/engine-vba-bridge/
├── Cargo.toml          # features: Win32_System_Com, Win32_System_Variant
├── src/
│   ├── lib.rs          # public API surface
│   ├── dispatch.rs     # late-binding IDispatch helper
│   ├── variant.rs      # VARIANT ↔ serde_json::Value conversion
│   ├── apartment.rs    # CoInitializeEx(STA) thread-local manager
│   ├── excel.rs        # Excel.Application wrapper
│   ├── registry.rs     # HKCU AccessVBOM read + write
│   └── errors.rs       # typed errors mapped from HRESULT
└── tests/
    └── integration.rs  # gated by `excel-installed` feature
```

The crate is registered in the napi-rs build pipeline (parallel to `engine-uia-bridge`), and the produced `.node` is loaded on demand from `src/engine/native-engine.ts` only when an `excel.*` tool is invoked.

### 3.3 Late-binding `IDispatch` helper (`dispatch.rs`)

Three helpers form the entire COM dance:

```rust
fn invoke_get(disp: &IDispatch, name: &str, args: &[VARIANT]) -> Result<VARIANT>
fn invoke_call(disp: &IDispatch, name: &str, args: &[VARIANT]) -> Result<VARIANT>
fn invoke_put(disp: &IDispatch, name: &str, value: VARIANT) -> Result<()>
```

Each resolves the dispatch ID via `IDispatch::GetIDsOfNames` then calls `IDispatch::Invoke` with the appropriate `DISPATCH_FLAGS` (`PROPERTYGET` / `METHOD` / `PROPERTYPUT`). The Qiita "Rust で Excel オートメーション (windows-rs 版)" reference (linked in §11) provides a working reference implementation that this design mirrors.

### 3.4 Apartment model (`apartment.rs`)

`Excel.Application` is a **single-threaded apartment (STA)** COM object. All calls must originate from a thread that has called `CoInitializeEx(COINIT_APARTMENTTHREADED)`. Violating this hangs Excel.

The crate exposes an `ExcelSession` handle that owns one STA worker thread; all dispatch calls on a given session route through that thread via a small command channel (the same shape used by `engine-uia-bridge` for its MTA worker, but with STA initialization instead). The thread holds the `IDispatch` for `Excel.Application` for its lifetime and tears it down on drop.

This keeps the napi worker pool free of `CoInitializeEx` state and makes the `Excel.Application` lifecycle explicit at the TypeScript layer.

### 3.5 VARIANT bridge (`variant.rs`)

VBA macro arguments and return values flow through `VARIANT`. The crate exposes:

```rust
fn json_to_variant(v: &serde_json::Value) -> Result<VARIANT>
fn variant_to_json(v: &VARIANT) -> Result<serde_json::Value>
```

Supported types in v1 (covers the dogfood demo + all bench scenarios):

| JSON type | VARIANT type | Notes |
|---|---|---|
| `null` | `VT_EMPTY` | |
| `boolean` | `VT_BOOL` | true → `VARIANT_TRUE` (−1), false → `0` |
| `number` (integer) | `VT_I4` | clamped to i32 range |
| `number` (float) | `VT_R8` | |
| `string` | `VT_BSTR` | BSTR allocated via `SysAllocStringLen`, freed on drop |
| `Date` (ISO string) | `VT_DATE` | only when caller passes ISO-8601, otherwise `VT_BSTR` |

Out of scope for v1: `VT_ARRAY`, `VT_DISPATCH`, `VT_UNKNOWN`, `VT_CY`, `VT_DECIMAL`. Caller using these would receive a typed error `UnsupportedVbaArgumentType` and can fall back to serializing into a worksheet cell.

### 3.6 Excel-specific wrapper (`excel.rs`)

Public Rust functions (each translates 1:1 to a napi export):

```rust
fn excel_open() -> Result<ExcelSession>
fn excel_open_workbook(s: &ExcelSession, path: Option<&Path>) -> Result<WorkbookHandle>
fn excel_set_visible(s: &ExcelSession, visible: bool) -> Result<()>
fn excel_add_vba_module(wb: &WorkbookHandle, name: &str, code: &str) -> Result<()>
fn excel_run_macro(s: &ExcelSession, name: &str, args: &[serde_json::Value]) -> Result<serde_json::Value>
fn excel_eval_cell(wb: &WorkbookHandle, sheet: &str, addr: &str) -> Result<serde_json::Value>
fn excel_refresh_power_query(wb: &WorkbookHandle, connection: Option<&str>) -> Result<()>
fn excel_save_as(wb: &WorkbookHandle, path: &Path, format: SaveFormat) -> Result<()>
fn excel_close(s: ExcelSession, save: bool) -> Result<()>
```

Each is a thin wrapper around `invoke_*` helpers on the appropriate `IDispatch` pointer. The handles (`ExcelSession`, `WorkbookHandle`) hold their respective COM pointers and the STA worker channel.

### 3.7 AccessVBOM precondition (`registry.rs`)

Excel returns `0x800AC472 Programmatic access to Visual Basic Project is not trusted` when:
- HKCU `Software\Microsoft\Office\16.0\Excel\Security\AccessVBOM` ≠ 1, **and**
- HKLM mirror is not forcing it to 1 via group policy

Two helpers:

```rust
fn check_access_vbom() -> AccessVbomStatus  // { trusted: bool, locked_by_policy: bool, scope: "hkcu" | "hklm" | "default" }
fn set_access_vbom_hkcu_to_true() -> Result<()>  // writes HKCU only; never touches HKLM
```

A new MCP tool (or a shipped script — see §4.4) calls `set_access_vbom_hkcu_to_true` on user opt-in. If HKLM has it forced to 0 by policy, the helper returns a typed error explaining that the user's IT department has disabled this and that no MCP-side workaround exists.

`set_access_vbom_hkcu_to_true` only takes effect after Excel is **restarted** (Excel reads the value at process startup and caches it). The setup flow therefore: write registry → close Excel → notify user → re-open via `workspace_launch` on next operation.

---

## 4. Phased implementation

### 4.1 Phase 1 — Rust primitives (1 day)

- New crate `engine-vba-bridge` registered in workspace `Cargo.toml`
- `dispatch.rs`, `variant.rs`, `apartment.rs` complete
- Unit tests on `variant.rs` (JSON ↔ VARIANT round-trip for all 6 supported types)
- No Excel-specific code yet — just COM primitives

Acceptance:
- `cargo test -p engine-vba-bridge` green for VARIANT bridge
- `cargo build -p engine-vba-bridge` succeeds on the project's standard MSVC toolchain

### 4.2 Phase 2 — Excel wrapper (1 day)

- `excel.rs` complete with all 8 public functions from §3.6
- Integration test under `tests/integration.rs` gated by `excel-installed` feature flag (skipped in CI, ran locally + on the release machine)
  - Opens Excel hidden, creates a workbook, adds a module with a known macro, runs it, asserts the return value, closes without saving
- `registry.rs` AccessVBOM check + write

Acceptance:
- Integration test passes locally on the maintainer machine (Excel 365)
- `check_access_vbom` correctly distinguishes the three states (`trusted` / `locked_by_policy` / `default`)

### 4.3 Phase 3 — napi-rs binding (½ day)

- `engine-vba-bridge` exports surfaced through the existing napi build (`src/engine/native-engine.ts`)
- TypeScript types added to `src/engine/native-types.ts`
- Standard `check:native-types` / `check:stub-catalog` CI checks green

Acceptance:
- `npm run build` produces a `.node` that exports the 8 functions + `checkAccessVbom` + `setAccessVbom`
- `src/engine/native-types.ts` matches `cargo build --bin generate-types` output bit-equal

### 4.4 Phase 4 — MCP tool surface (½ day)

Two new MCP tools, both under a new `excel.*` namespace:

**`excel.run_vba`** — the headline tool for the demo. Authors and runs a single anonymous-or-named macro in one call.

```ts
{
  action: "run",
  workbookPath?: string,   // if absent, operates on a new hidden workbook
  visible?: boolean,       // default false (hidden); set true for demo recording
  macroName?: string,      // default "DesktopTouchAdHoc"
  code: string,            // VBA source; must contain Sub <macroName>(...) End Sub
  args?: any[],            // VARIANT-compatible primitives only
  save?: boolean,          // default false; if true, saves as .xlsm at workbookPath
  closeAfter?: boolean,    // default true if no path; default false if path given
}
```

Returns:
```ts
{
  result: any,             // macro return value, or null
  ok: true,
  hints: {
    accessVbomTrustedAt: "hkcu" | "hklm-policy",
    elapsedMs: number,
  }
}
```

Typed errors (added to `src/tools/_errors.ts`):
- `AccessVBOMNotTrusted` — registry path is 0, suggest running setup
- `AccessVBOMLockedByPolicy` — HKLM forces 0, suggest contacting IT
- `ExcelNotInstalled` — `CLSIDFromProgID("Excel.Application")` returned `REGDB_E_CLASSNOTREG`
- `VbaMacroAuthoringFailed` — `AddFromString` returned an HRESULT (usually syntax error in the VBA source)
- `VbaMacroExecutionFailed` — `Application.Run` returned a non-zero HRESULT
- `UnsupportedVbaArgumentType` — caller passed an object / array / dispatch into `args`
- `WorkbookProtectedByPassword` — `VBProject` access blocked by workbook-level VBA password

**`excel.enable_access_vbom`** — one-shot setup tool. Writes HKCU `AccessVBOM=1`, returns the new state, and (if Excel is running) returns a `restartRequired: true` hint.

```ts
{}  // no args
```

Returns:
```ts
{
  ok: true,
  trustedAt: "hkcu" | "hklm-policy",
  restartRequired: boolean,
  hints: { previousValue: 0 | 1 | "absent", excelWasRunning: boolean }
}
```

Acceptance:
- Both tools registered in `src/tools/_registry.ts` and visible in `tools/list`
- `tests/unit/excel-run-vba.test.ts` covers the schema validation cases
- An e2e test gated like §4.2 verifies a full round trip

### 4.5 Phase 5 — Demo recording + release (½ day)

- Record a 30-second MP4 (1080p 9:16 for X / vertical) of the following sequence:
  1. User types prompt to Claude (Cursor / Claude Code) — "Open Excel, write a VBA macro that fills A1..A3 with a greeting and a timestamp, run it, then show me a message box that says it's done"
  2. Claude calls `excel.enable_access_vbom` (one-time, only if needed)
  3. Claude calls `excel.run_vba` with `visible: true` and the relevant code
  4. Excel becomes visible, cells populate, MsgBox appears
  5. User closes the MsgBox; Excel stays open showing the populated cells
- Place under `docs/media/excel-vba-demo.mp4` and embed in `README.md` hero (replacing the GIF slot reserved for Stage B)
- Bump version to `1.5.0` (new public MCP tool surface is a feature-level change, not a patch)
- Follow `docs/release-process.md` for npm + GH Release + MCP Registry publish

Acceptance:
- Recording reproducible from a clean Win11 image with the project's stock launcher and no manual VBE interaction
- `docs/release-process.md` smoke test passes against the published `npx` invocation

---

## 5. Public API surface — what callers see

Before this ADR lands, the project exposes 28 public MCP tools (26 stub + 2 dynamic v2). After this ADR lands, the project exposes **30 public MCP tools** (28 prior + `excel.run_vba` + `excel.enable_access_vbom`). The stub catalog generator picks them up automatically; downstream documentation (README, CHANGELOG, MCP Registry server.json) updates as part of the §4.5 release.

The new tools are additive. Nothing existing changes shape.

---

## 6. Acceptance criteria (whole ADR)

- [ ] Issue #256 (F2 VBE UIA-blind) Resolved by structural bypass (not by improving UIA inspection of VBE)
- [ ] Issue #255 (F4 parallel keyboard crash) untouched here but unblocked downstream — the demo no longer needs the failing call pattern
- [ ] `engine-vba-bridge` crate exists with the 8 functions from §3.6, all behind a single thread-local STA worker
- [ ] `excel.run_vba` succeeds end-to-end on a clean Win11 + Excel 365 install with `AccessVBOM=1` set by the bundled setup tool
- [ ] All new typed errors are catalogued in `_errors.ts` and surveyed in ADR-010 §5.4 (CLAUDE.md §3.1 — cascade sweep over all numeric-ref docs and acceptance tables)
- [ ] Demo MP4 recorded + embedded + released with `v1.5.0`
- [ ] No regression in `vitest run` or `cargo test --workspace`

---

## 7. Risks

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | Workbook has a VBA project password — `wb.VBProject` access raises before any `VBComponents.Add` succeeds | Low (demo uses fresh workbook) | Typed error `WorkbookProtectedByPassword`; caller can prompt user to unlock manually |
| R2 | Group policy forces HKLM `AccessVBOM=0`, HKCU has no effect | Medium (enterprise) | Typed error `AccessVBOMLockedByPolicy` explains no MCP-side workaround exists |
| R3 | STA worker panic kills the Excel `IDispatch` pointer without releasing it — Excel becomes a zombie | Low | `catch_unwind` in worker loop + always release `IDispatch` on drop; integration test asserts process count returns to baseline |
| R4 | `Application.Run` blocks if the VBA macro shows a modal (`MsgBox`, `InputBox`, etc.) and no user is present | Medium (demo uses MsgBox) | Document that `excel.run_vba` blocks until any modal is dismissed; for headless usage, document `vbInformation`-style synchronous-but-no-prompt alternatives |
| R5 | Excel hidden mode (`Visible = false`) plus a VBA `MsgBox` causes an invisible-yet-blocking dialog the user cannot reach | Medium | When `visible: false`, validate code does not contain `MsgBox` / `InputBox` / `Application.Dialogs(...)` (string scan, conservative) and raise `BlockingDialogInHiddenMode` if found |
| R6 | Office build drift breaks late-binding (very unlikely — the COM interface is contractually stable since Excel 97) | Very low | Pin the `engine-vba-bridge` integration test in CI when Excel is available; rely on `CLSIDFromProgID("Excel.Application")` for version independence |
| R7 | Anti-malware flags an unsigned `.node` that calls `Excel.Application` COM as suspicious | Medium | Same exposure as existing `engine-uia-bridge`; document in `README` troubleshooting section; long-term: sign the `.node` (out of ADR scope) |

---

## 8. Open questions

- **OQ #1** — Should `excel.run_vba` accept an array of macros (batch authoring) in v1, or stay single-macro for simplicity? **Lean: single macro v1**, batch as future expansion.
- **OQ #2** — Should the namespace be `excel.*`, `office.*`, or `vba.*`? Future Word / PowerPoint / Outlook bridges would either reuse `office.*` (one namespace, many objects) or split per-app. **Lean: `excel.*`** and rename to `office.*` only when adding the second app, since the cost of one rename later is small and `excel.*` is more discoverable for the v1.5.0 demo.
- **OQ #3** — Should the AccessVBOM setup be its own MCP tool (`excel.enable_access_vbom`) or a CLI script (`scripts/enable-access-vbom.mjs`) outside the MCP envelope? Both? **Lean: both** — MCP tool for in-session enable, CLI for setup-time use. Cheap to ship both.
- **OQ #4** — Should `excel.run_vba` save the workbook before running (so the macro can reference `ThisWorkbook.Path`)? Trade-off: saving adds disk I/O and forces `.xlsm` choice. **Lean: only save when caller passes `save: true`**.
- **OQ #5** — How aggressive should the `MsgBox` / `InputBox` string scan in §7 R5 be? Aggressive scanning may false-positive on macros that legitimately reference those tokens in comments or strings. **Lean: regex on the start of a line (`^[\s]*MsgBox\b`) and only when `visible: false`**.
- **OQ #6** — Should MSAA fallback (research axis 2) be tackled in this ADR's follow-up or deferred to a separate issue? **Lean: deferred** — close issue #256 with this ADR shipping, file a new "VBA Editor inspection via MSAA" issue if a user requests it. The promotion-driving demo does not need it.

---

## 9. Out of scope

- Word / PowerPoint / Outlook / OneNote VBA bridges (same architecture, different `IDispatch` target, future expansion)
- VBE UI driving (the entire point of this ADR is that we no longer need to drive the UI)
- MSAA / `IAccessible` improvements to VBE inspection (covered by issue #256 follow-up if requested)
- `Application.Quit` semantics around dirty workbooks (deferred to v1.6+)
- Worksheet-level operations that don't need VBA (`Range.Value` write, `Workbook.SaveAs`, `Connections.Refresh`) — these come **for free** as part of the COM helper but get their own dedicated MCP tools only if dogfood pulls them in

---

## 10. References

- Issue [#256](https://github.com/Harusame64/desktop-touch-mcp/issues/256) (F2 VBE UIA-blind)
- Issue [#255](https://github.com/Harusame64/desktop-touch-mcp/issues/255) (F4 parallel keyboard crash)
- Issue [#257](https://github.com/Harusame64/desktop-touch-mcp/issues/257) (F3 keyboard sequence mode)
- Issue [#258](https://github.com/Harusame64/desktop-touch-mcp/issues/258) (F1 workspace_launch App Paths)
- [Application.VBE property (Excel) | Microsoft Learn](https://learn.microsoft.com/en-us/office/vba/api/excel.application.vbe)
- [Application.Run method (Excel) | Microsoft Learn](https://learn.microsoft.com/en-us/office/vba/api/excel.application.run)
- [Objects (Visual Basic Add-In Model) | Microsoft Learn](https://learn.microsoft.com/en-us/office/vba/language/reference/visual-basic-add-in-model/objects-visual-basic-add-in-model)
- [Security notes for Office solution developers | Microsoft Learn](https://learn.microsoft.com/en-us/office/vba/library-reference/concepts/security-notes-for-microsoft-office-solution-developers)
- [Pre-Setting Trust access to the VBA project object model via registry | ELB Solutions](https://elbsolutions.com/projects/pre-setting-trust-access-to-the-vba-project-object-model-for-users-via-registry/)
- [Rust で Excel オートメーション (windows-rs 版) — Qiita](https://qiita.com/benki/items/42099c58e07b16293609)
- [IDispatch in windows::Win32::System::Com — windows-rs docs](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/System/Com/struct.IDispatch.html)
- [UiPath Invoke VBA activity (industry-standard reference)](https://docs.uipath.com/activities/other/latest/productivity/invoke-vba)
- ADR-008 (`docs/adr-008-reactive-perception-engine.md`) — sibling crate pattern (`engine-perception`)
- ADR-014 (`docs/adr-014-cooperative-bridge.md`) — example of phased Draft → Phase 1/2/3 pattern this ADR mirrors

---

## 11. Decision history

| Date | Status | Author | Rationale |
|---|---|---|---|
| 2026-05-12 | Draft (Proposed) | Claude (Sonnet) + Opus 2026-05-12 research | Initial draft after dogfood discovery of issue #256 (VBE UIA-blind) + Opus research confirming VBA Extensibility COM as industry standard (UiPath, PAD). Pending Opus + Codex review per CLAUDE.md §3.3 Step 1 + Step 2 (production code path, both required). |
