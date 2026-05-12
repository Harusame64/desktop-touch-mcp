# ADR-015: VBA Extensibility Bridge — `engine-vba-bridge` crate for COM-native VBA module injection and macro execution

- Status: **Draft (Proposed, Round 2)** — Opus + Codex Round 1 findings reflected; awaiting Round 2 review
- Date: 2026-05-12 (Round 1 draft) / 2026-05-12 (Round 2 revision)
- Authors: Claude (Sonnet draft, research backed by Opus 2026-05-12 web survey; Opus + Codex review feedback integrated)
- Related:
  - Issue [#256](https://github.com/Harusame64/desktop-touch-mcp/issues/256) (F2: VBE is UIA-blind)
  - Issue [#255](https://github.com/Harusame64/desktop-touch-mcp/issues/255) (F4: MCP server disconnect on parallel keyboard calls)
  - Issue [#257](https://github.com/Harusame64/desktop-touch-mcp/issues/257) (F3: keyboard sequence mode)
  - Issue [#258](https://github.com/Harusame64/desktop-touch-mcp/issues/258) (F1: workspace_launch App Paths)
  - `docs/layer-constraints.md` §6.3 invariant 6 (the 28-tool unchanging-surface invariant that this ADR formally amends; see §2.3 and §6 cascade sweep)
  - `docs/operation-verification-matrix.md` (cascade sweep target for invariant 6 amendment)
  - `docs/architecture-3layer-integrated.md` §7 (cascade sweep target)
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

`Claude for Excel` (GA 2026-05-07) writes single-workbook formulas through an Office add-in but **cannot author or run VBA**, cannot cross app boundaries, and cannot drive Power Query refresh against external connections. Each of those gaps is structurally addressable via `Excel.Application.VBE.VBProjects` COM access. The promotion strategy hinges on a demo that visibly does at least one of: dynamically generate a VBA macro, run it, and surface the result — all without a user touching VBE.

A demo built on UI driving of VBE would either crash mid-record (issue #255), drift across Office versions (`SendMessage` path), or fail silently when an element is not in the UIA tree (current state). A demo built on COM access does not depend on any UI being present, drawn, or focused.

---

## 2. Decision

**Adopt the VBA Extensibility Object Model (Excel COM `Application.VBE.VBProjects`) as the production path for VBA authoring and macro invocation. Implement it as a new `engine-vba-bridge` Rust crate, exposed to TypeScript via napi-rs, and surfaced as a single new MCP tool `excel` with an action-discriminated union covering authoring / execution / inspection.**

### 2.1 Why this is the chosen path

- UiPath's `Invoke VBA` activity, Power Automate Desktop's Excel actions, and every comparable mid-to-high-end Windows RPA tool route through the same COM API; this is the **industry standard solution**, not a novel approach
- The COM call sites do not touch the VBE UI at all, so the entire class of UI-driving failures (issues #255 / #256 / #257) is structurally bypassed, not patched
- The implementation reuses the existing `windows-rs` Rust toolchain that already powers `engine-uia-bridge` and `engine-vision`; no new external dependency, no new transport
- A single new crate cleanly composes: COM bridging primitives are reusable for future Word / PowerPoint / Outlook / OneNote bridges without further architectural cost

### 2.2 Why this is not over-investment

- Issue #256 needs to be closed one way or another. Patching UIA / MSAA / SendMessage would each cost roughly the same as this approach for a worse outcome
- The crate is small (< 1,500 lines of Rust including the late-binding `IDispatch` helper and Excel wrapper) and the work is bounded to 2-3 days of focused implementation
- The new MCP tool surface is **additive by exactly +1**, not +2 as the Round 1 draft proposed. The Trust Center setup path moves to a CLI script (§3.7 / §4.4) for security and surface-count reasons

### 2.3 Invariant 6 amendment (28 → 29)

`docs/layer-constraints.md` §6.3 invariant 6 currently fixes the public MCP tool surface at **28 tools** (26 stub catalog + 2 dynamic v2; commit-axis 17 + query-axis 11). This invariant is referenced and cross-checked from at least five SSOT docs (see §6 cascade sweep). This ADR **formally amends invariant 6 from 28 to 29** to admit the new `excel` tool. Subsequent additions of Word / PowerPoint / Outlook bridges (out of scope here) would each require their own one-tool amendment, justified individually.

Reasoning for amendment over absorption into an existing tool:

- `desktop_act` is entity-driven (takes a lease + action against a discovered UI entity); VBA macro authoring has no UI entity to target, so semantically misfits
- `workspace_launch` is process-lifecycle scoped; VBA work is intra-process, semantically misfits
- `run_macro` is the existing MCP tool name for **batching MCP tool calls** in a single envelope, not Office macros — semantic collision would mislead callers
- Inventing a new top-level `excel` tool keeps the namespace clean and gives Word / PowerPoint / Outlook a clear template for future ADRs

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
│   ├── registry.rs     # HKCU AccessVBOM read (write lives in scripts/, not here)
│   └── errors.rs       # typed errors mapped from HRESULT
└── tests/
    └── integration.rs  # gated by `excel-installed` feature
```

The crate is registered in the napi-rs build pipeline (parallel to `engine-uia-bridge`), and the produced `.node` is loaded on demand from `src/engine/native-engine.ts` only when the `excel` tool is invoked.

### 3.3 Late-binding `IDispatch` helper (`dispatch.rs`)

Three helpers form the entire COM dance:

```rust
fn invoke_get(disp: &IDispatch, name: &str, args: &[VARIANT]) -> Result<VARIANT>
fn invoke_call(disp: &IDispatch, name: &str, args: &[VARIANT]) -> Result<VARIANT>
fn invoke_put(disp: &IDispatch, name: &str, value: VARIANT) -> Result<()>
```

Each resolves the dispatch ID via `IDispatch::GetIDsOfNames` then calls `IDispatch::Invoke` with the appropriate `DISPATCH_FLAGS` (`PROPERTYGET` / `METHOD` / `PROPERTYPUT`). The Qiita "Rust で Excel オートメーション (windows-rs 版)" reference (linked in §10) targets windows-rs 0.39.0; the project's current `windows-rs` version is the workspace-pinned 0.5x. The two API surfaces are similar but the workspace version is used as the source of truth; the Qiita example is read for the late-binding pattern, not its literal API names.

### 3.4 Apartment model (`apartment.rs`)

`Excel.Application` is a **single-threaded apartment (STA)** COM object. All calls must originate from a thread that has called `CoInitializeEx(COINIT_APARTMENTTHREADED)`. Violating this hangs Excel.

The crate exposes an `ExcelSession` handle that owns one STA worker thread; all dispatch calls on a given session route through that thread via a small command channel. The pattern mirrors `engine-uia-bridge` (see `crates/engine-uia-bridge/src/worker.rs` — MTA worker, but the channel-based command pump shape is the same; `engine-vba-bridge` uses STA initialization instead). The thread holds the `IDispatch` for `Excel.Application` for its lifetime and tears it down on drop.

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
| `null` | `VT_NULL` | Matches VBA `IsNull()` semantics. (Round 1 draft incorrectly used `VT_EMPTY`, which means "uninitialized" and triggers VBA `IsEmpty()` not `IsNull()`.) |
| `boolean` | `VT_BOOL` | true → `VARIANT_TRUE` (−1), false → `0` |
| `number` (integer) | `VT_I4` | clamped to i32 range |
| `number` (float) | `VT_R8` | |
| `string` | `VT_BSTR` | BSTR allocated via `SysAllocStringLen`, freed on drop |
| `Date` (ISO string) | `VT_DATE` | only when caller passes ISO-8601, otherwise `VT_BSTR` |

Out of scope for v1: `VT_ARRAY`, `VT_DISPATCH`, `VT_UNKNOWN`, `VT_CY`, `VT_DECIMAL`. Caller using these would receive a typed error `VbaUnsupportedArgumentType` and can fall back to serializing into a worksheet cell.

### 3.6 Excel-specific wrapper (`excel.rs`)

Public Rust functions (each translates to one action variant of the single `excel` MCP tool):

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

### 3.7 AccessVBOM precondition (`registry.rs` — read-only)

Excel returns `0x800AC472 Programmatic access to Visual Basic Project is not trusted` when:
- HKCU `Software\Microsoft\Office\16.0\Excel\Security\AccessVBOM` ≠ 1, **and**
- HKLM mirror is not forcing it to 1 via group policy

One helper (read-only inside the MCP):

```rust
fn check_access_vbom() -> AccessVbomStatus  // { trusted: bool, locked_by_policy: bool, scope: "hkcu" | "hklm" | "default" }
```

**Writing the registry is intentionally NOT exposed as an MCP tool action.** Round 1 draft proposed an `excel.enable_access_vbom` tool action; Opus Round 1 P2-1 and the broader security-boundary review concluded that any MCP client should not be able to silently lower Office trust for the user. The setup path lives in a CLI script:

```
scripts/enable-access-vbom.mjs
```

The script is invoked once during user onboarding (or whenever `check_access_vbom` returns `trusted: false`); the MCP tool surface emits a typed error `VbaAccessNotTrusted` with a suggest pointing at this script. If HKLM has it forced to 0 by policy, the script returns a typed error explaining that the user's IT department has disabled this and that no MCP-side workaround exists.

`enable-access-vbom.mjs` only takes effect after Excel is **restarted** (Excel reads the value at process startup and caches it). The setup flow therefore: write registry → close Excel → notify user → re-open via `workspace_launch` on next operation.

---

## 4. Phased implementation

### 4.1 Phase 1 — Rust primitives (1 day)

- New crate `engine-vba-bridge` registered in workspace `Cargo.toml`
- `dispatch.rs`, `variant.rs`, `apartment.rs` complete
- Unit tests on `variant.rs` (JSON ↔ VARIANT round-trip for all 6 supported types, including `null → VT_NULL` regression pin)
- No Excel-specific code yet — just COM primitives

Acceptance:
- `cargo test -p engine-vba-bridge` green for VARIANT bridge
- `cargo build -p engine-vba-bridge` succeeds on the project's standard MSVC toolchain

### 4.2 Phase 2 — Excel wrapper (1 day)

- `excel.rs` complete with all 8 public functions from §3.6
- Integration test under `tests/integration.rs` gated by `excel-installed` feature flag (skipped in CI, ran locally + on the release machine)
  - Opens Excel hidden, creates a workbook, adds a module with a known macro, runs it, asserts the return value, closes without saving
- `registry.rs` AccessVBOM read-only check (no write)

Acceptance:
- Integration test passes locally on the maintainer machine (Excel 365)
- `check_access_vbom` correctly distinguishes the three states (`trusted` / `locked_by_policy` / `default`)

### 4.3 Phase 3 — napi-rs binding (½ day)

- `engine-vba-bridge` exports surfaced through the existing napi build (`src/engine/native-engine.ts`)
- TypeScript types added to `src/engine/native-types.ts`
- Standard `check:native-types` / `check:stub-catalog` CI checks green

Acceptance:
- `npm run build` produces a `.node` that exports the 8 functions + `checkAccessVbom` (no `setAccessVbom` — CLI-only path)
- `src/engine/native-types.ts` matches `cargo build --bin generate-types` output bit-equal

### 4.4 Phase 4 — MCP tool surface (½ day) — **single `excel` tool with action dispatcher**

One new MCP tool: `excel`. All operations are actions on this tool, dispatched by a Zod discriminated union on the `action` field:

```ts
// Zod schema (sketch)
const excelInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("run_vba"),
    code: z.string(),                  // VBA source containing Sub <macroName>(...) End Sub
    macroName: z.string().optional(),  // default: "DesktopTouchAdHoc"
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

**`action: "run_vba"`** — the headline action for the demo. Authors and runs a single macro in one call.

Returns:
```ts
{
  ok: true,
  result: unknown,           // macro return value, or null
  hints: {
    accessVbomTrustedAt: "hkcu" | "hklm-policy",
    elapsedMs: number,
  }
}
```

**`action: "check_access_vbom"`** — read-only inspection. Returns:
```ts
{
  ok: true,
  trusted: boolean,
  scope: "hkcu" | "hklm-policy" | "default",
  lockedByPolicy: boolean,
  suggest: string,            // populated when not trusted: "Run: node scripts/enable-access-vbom.mjs"
}
```

Typed errors (added to `src/tools/_errors.ts`, **PascalCase with single-cap acronyms per existing `Uia*` / `Ime*` convention** — see Codex Round 1 P2 on `pascalToSnake` boundary):

| Code | Meaning |
|---|---|
| `VbaAccessNotTrusted` | HKCU AccessVBOM is 0; suggest the setup script |
| `VbaAccessLockedByPolicy` | HKLM forces 0; user must contact IT |
| `ExcelNotInstalled` | `CLSIDFromProgID("Excel.Application")` returned `REGDB_E_CLASSNOTREG` |
| `VbaModuleAuthoringFailed` | `AddFromString` returned an HRESULT (usually syntax error) |
| `VbaMacroExecutionFailed` | `Application.Run` returned a non-zero HRESULT |
| `VbaUnsupportedArgumentType` | caller passed an object / array / dispatch into `args` |
| `VbaWorkbookProtected` | `VBProject` access blocked by workbook-level VBA password |

Acceptance:
- The single `excel` tool is registered in `src/tools/_registry.ts` and visible in `tools/list` as one tool (not multiple)
- `tests/unit/excel-tool.test.ts` covers the schema validation cases for each action variant
- The naming convention check (`pascalToSnake` round-trip) passes for all 7 new typed errors
- An e2e test gated like §4.2 verifies a full round trip

### 4.5 Phase 5 — Invariant 6 cascade sweep + demo recording + release (1 day)

**Invariant 6 cascade sweep (28 → 29 across all SSOT documents):**

| Document | Section / line | What changes |
|---|---|---|
| `docs/layer-constraints.md` | §6.3 invariant 6 | 28 → 29; add ADR-015 as the authority for this amendment |
| `docs/operation-verification-matrix.md` | §1.4 / §3.1 table totals / §3.2 table totals / §6 acceptance | 28 → 29; commit-axis 17 → 18 (new `excel` tool is commit-axis); §3.1 row count updated; acceptance summary updated |
| `docs/architecture-3layer-integrated.md` | §6 / §7 / §11.3 | 28 → 29 |
| `docs/system-overview.md` | tool-count references | 28 → 29 |
| `docs/llm-operation-audit.md` | §1 | 28 → 29 |
| `docs/llm-audit/phase2a-doc-audit.md` / `phase2b-execution-audit.md` / `phase4-query-audit.md` | tool count references | 28 → 29 (most likely no change to phase4-query since `excel` is commit-axis) |
| `docs/tool-surface-phase4-privatize-absorb-design.md` | tool-count references | 28 → 29 |
| `docs/tool-surface-known-issues.md` | `26 stub + 2 dynamic = 28` claim | `27 stub + 2 dynamic = 29` (the new `excel` tool gets a stub entry) |
| `src/stub-tool-catalog.ts` (auto-generated) | regen via `npm run generate:stub-catalog` | new `excel` entry appears automatically |

The sweep is **required to be a single atomic commit** so reviewers can verify "old count → new count" in one diff. Any document where the sweep would conflict with another in-flight change must be sequenced before or after, not interleaved.

**Demo recording (optional promotion stretch — NOT a technical acceptance gate):**

- Record a 30-second MP4 (1080p 9:16 for X / vertical) of the following sequence:
  1. User types prompt to Claude (Cursor / Claude Code) — "Open Excel, write a VBA macro that fills A1..A3 with a greeting and a timestamp, run it, then show me a message box that says it's done"
  2. (One-time-setup) If `check_access_vbom` returns not-trusted, run `node scripts/enable-access-vbom.mjs` from the shell
  3. Claude calls `excel({action: "run_vba", visible: true, code: "..."})`
  4. Excel becomes visible, cells populate, MsgBox appears
  5. User closes the MsgBox; Excel stays open showing the populated cells
- Place under `docs/media/excel-vba-demo.mp4` and embed in `README.md` hero (replacing the GIF slot reserved for Stage B)

**Release:**

- Bump version to **the next feature-level release** (likely `v1.5.x`; the exact patch level depends on whether ADR-016 Phase 1 ships in the same release. ADR-014 reserves `v1.5.0+` as a stretch slot — coordinate version numbers with ADR-014 owner at release time)
- Follow `docs/release-process.md` for npm + GH Release + MCP Registry publish

Acceptance:
- All cascade-sweep documents updated in a single atomic commit (see table above)
- All e2e tests green on a clean Win11 + Excel 365 install with `AccessVBOM=1` set by the bundled CLI script
- `docs/release-process.md` smoke test passes against the published `npx` invocation
- Demo MP4 recorded (optional, does not block technical release)

---

## 5. Public API surface — what callers see

Before this ADR lands: **28 public MCP tools** (26 stub + 2 dynamic v2; commit-axis 17 + query-axis 11).

After this ADR lands: **29 public MCP tools** (27 stub + 2 dynamic v2; commit-axis 18 + query-axis 11). The single addition is `excel`, which exposes its operations through the action discriminator described in §4.4.

The new tool is additive. Nothing existing changes shape. Invariant 6 is formally amended from 28 to 29 (see §4.5 cascade sweep).

---

## 6. Acceptance criteria (whole ADR)

- [ ] Issue #256 (F2 VBE UIA-blind) Resolved by structural bypass (not by improving UIA inspection of VBE)
- [ ] `engine-vba-bridge` crate exists with the 8 functions from §3.6, all behind a single thread-local STA worker
- [ ] `excel` tool succeeds end-to-end on a clean Win11 + Excel 365 install with `AccessVBOM=1` set by the bundled CLI script
- [ ] All 7 new typed errors are catalogued in `_errors.ts` and surveyed in ADR-010 §5.4 (CLAUDE.md §3.1 — cascade sweep over all numeric-ref docs and acceptance tables)
- [ ] The new typed-error names pass the `pascalToSnake` round-trip used by `src/tools/_envelope.ts` (Codex Round 1 P2)
- [ ] `docs/layer-constraints.md` §6.3 invariant 6 amended from 28 to 29 in a single atomic commit covering all 9+ cascade-sweep documents listed in §4.5
- [ ] No regression in `vitest run` or `cargo test --workspace`
- [ ] Demo MP4 recorded (optional, promotion stretch)

---

## 7. Risks

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | Workbook has a VBA project password — `wb.VBProject` access raises before any `VBComponents.Add` succeeds | Low (demo uses fresh workbook) | Typed error `VbaWorkbookProtected`; caller can prompt user to unlock manually |
| R2 | Group policy forces HKLM `AccessVBOM=0`, HKCU has no effect | Medium (enterprise) | Typed error `VbaAccessLockedByPolicy` explains no MCP-side workaround exists |
| R3 | STA worker panic kills the Excel `IDispatch` pointer without releasing it — Excel becomes a zombie | Low | `catch_unwind` in worker loop + always release `IDispatch` on drop; integration test asserts process count returns to baseline |
| R4 | `Application.Run` blocks if the VBA macro shows a modal (`MsgBox`, `InputBox`, etc.) and no user is present | Medium (demo uses MsgBox) | Document that the `run_vba` action blocks until any modal is dismissed; for headless usage, document `vbInformation`-style synchronous-but-no-prompt alternatives |
| R5 | Excel hidden mode (`visible: false`) plus a VBA `MsgBox` causes an invisible-yet-blocking dialog the user cannot reach | Medium | When `visible: false`, validate code does not contain `MsgBox` / `InputBox` / `Application.Dialogs(...)` (string scan, conservative regex `^[\s]*MsgBox\b`) and raise `BlockingDialogInHiddenMode` if found |
| R6 | Office build drift breaks late-binding (very unlikely — the COM interface is contractually stable since Excel 97) | Very low | Pin the `engine-vba-bridge` integration test in CI when Excel is available; rely on `CLSIDFromProgID("Excel.Application")` for version independence |
| R7 | Anti-malware flags an unsigned `.node` that calls `Excel.Application` COM as suspicious | Medium | Same exposure as existing `engine-uia-bridge`; document in `README` troubleshooting section; long-term: sign the `.node` (out of ADR scope) |
| R8 | Auto-registry-mutation social engineering — an attacker who can prompt an MCP client could silently lower Office trust via an `enable_access_vbom` MCP action | Was Medium (Round 1 design) → **structurally eliminated in Round 2** | The setup path is CLI-only (`scripts/enable-access-vbom.mjs`). The MCP tool surface exposes only the read-only `check_access_vbom` action plus a `suggest` field pointing at the CLI. No MCP client can write the registry value |

---

## 8. Open questions

- **OQ #1** — Should the `run_vba` action accept an array of macros (batch authoring) in v1, or stay single-macro for simplicity? **Lean: single macro v1**, batch as future expansion.
- **OQ #2** — *(Resolved by Round 2 — see §11.)* Tool naming and grouping. Resolved to single `excel` tool with action discriminator. Future Office app bridges (Word / PowerPoint / Outlook) get their own top-level tools (`word`, `powerpoint`, `outlook`) — each via its own one-tool ADR amendment to invariant 6.
- **OQ #3** — *(Resolved by Round 2 — see §11.)* AccessVBOM setup as MCP tool or CLI? Resolved to CLI-only (`scripts/enable-access-vbom.mjs`) per Opus Round 1 P2-1 + R8 mitigation.
- **OQ #4** — Should `run_vba` save the workbook before running (so the macro can reference `ThisWorkbook.Path`)? Trade-off: saving adds disk I/O and forces `.xlsm` choice. **Lean: only save when caller passes `save: true`**.
- **OQ #5** — How aggressive should the `MsgBox` / `InputBox` string scan in §7 R5 be? Aggressive scanning may false-positive on macros that legitimately reference those tokens in comments or strings. **Lean: regex on the start of a line (`^[\s]*MsgBox\b`) and only when `visible: false`**.
- **OQ #6** — Should MSAA fallback (research axis 2) be tackled in this ADR's follow-up or deferred to a separate issue? **Lean: deferred** — close issue #256 with this ADR shipping, file a new "VBA Editor inspection via MSAA" issue if a user requests it. The promotion-driving demo does not need it.

---

## 9. Out of scope

- Word / PowerPoint / Outlook / OneNote VBA bridges (same architecture, different `IDispatch` target, future expansion; each is its own one-tool invariant amendment)
- VBE UI driving (the entire point of this ADR is that we no longer need to drive the UI)
- MSAA / `IAccessible` improvements to VBE inspection (covered by issue #256 follow-up if requested)
- `Application.Quit` semantics around dirty workbooks (deferred to a later release)
- Worksheet-level operations that don't need VBA (`Range.Value` write, `Workbook.SaveAs`, `Connections.Refresh`) — these are available via §4.4 action variants (`eval_cell`, `refresh_query`); larger surface (chart manipulation, pivot tables) is future expansion

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
- [Security notes for Office solution developers | Microsoft Learn](https://learn.microsoft.com/en-us/office/vba/library-reference/concepts/security-notes-for-microsoft-office-solution-developers) — the canonical guidance for the AccessVBOM setting
- [Pre-Setting Trust access to the VBA project object model via registry | ELB Solutions](https://elbsolutions.com/projects/pre-setting-trust-access-to-the-vba-project-object-model-for-users-via-registry/) — practical registry-value reference
- [Rust で Excel オートメーション (windows-rs 版) — Qiita](https://qiita.com/benki/items/42099c58e07b16293609) — late-binding pattern reference (the Qiita article targets windows-rs 0.39.0; this project's pin is 0.5x and the API surface differs slightly — read for pattern not for literal API names)
- [IDispatch in windows::Win32::System::Com — windows-rs docs](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/System/Com/struct.IDispatch.html)
- [UiPath Invoke VBA activity (industry-standard reference)](https://docs.uipath.com/activities/other/latest/productivity/invoke-vba)
- ADR-008 (`docs/adr-008-reactive-perception-engine.md`) — sibling crate pattern (`engine-perception`)
- ADR-014 (`docs/adr-014-cooperative-bridge.md`) — example of phased Draft → Phase 1/2/3 pattern this ADR mirrors
- `crates/engine-uia-bridge/src/worker.rs` — referenced in §3.4 as the channel-based STA / MTA worker pattern that `engine-vba-bridge` mirrors

---

## 11. Decision history

| Date | Status | Author | Rationale |
|---|---|---|---|
| 2026-05-12 | Draft (Proposed, Round 1) | Claude (Sonnet) + Opus 2026-05-12 research | Initial draft after dogfood discovery of issue #256 + Opus research confirming VBA Extensibility COM as industry standard. Proposed 2 new MCP tools (`excel.run_vba` + `excel.enable_access_vbom`, i.e. 28 → 30) |
| 2026-05-12 | Draft (Proposed, Round 2) | Claude (Sonnet) reflecting Opus + Codex Round 1 | **Major revisions**: (a) Consolidated to single `excel` tool with action discriminator per Opus P1-2 (28 → 29 + cascade-sweep across 9+ SSOT docs). (b) Moved `enable_access_vbom` from MCP tool action to CLI-only (`scripts/enable-access-vbom.mjs`) per Opus P2-1 / R8 mitigation. (c) Renamed `AccessVBOM*` typed errors to `VbaAccess*` etc. per Codex P2 (`pascalToSnake` round-trip safety) and Opus P2-2 (single-cap acronym convention). (d) Fixed `null → VT_NULL` semantics per Opus P3-2. (e) Resolved OQ #2 / OQ #3 to Decision history. (f) Added §3.4 reference to `crates/engine-uia-bridge/src/worker.rs` per Opus P3-3. (g) Added §7 R8 covering the auto-registry-mutation social engineering vector. (h) Version language relaxed to "next feature-level release (likely v1.5.x)" with explicit ADR-014 coordination note per Opus P2-5. (i) §10 References URL existence verified per Opus P2-7 |
