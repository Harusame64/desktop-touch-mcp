# ADR-018 Phase 2a — Sub-plan: MCP schema collapse fix (`flattenUnionToObjectSchema`)

- Status: **Draft**
- Date: 2026-05-14
- Parent: `docs/adr-018-input-pipeline-3tier.md` §2.5 (D5, redesigned) + §4 Phase 2a
- Authors: Claude (Sonnet investigation + web research + Plan agent design)

---

## 1. Why this sub-plan exists

ADR §2.5 was redesigned (Round-0 → Round-1, 2026-05-14) after investigation invalidated the original `materializeUnionJsonSchema` design. This sub-plan pins the **replacement** implementation:

1. **Scope is 7 tools, not 3.** A full-server empirical `tools/list` audit (all 29 registered tools) found 7 with the empty-`properties` bug — `scroll`, `keyboard`, `excel` (ADR Round-0) **plus `browser_eval`, `window_dock`, `terminal`, `clipboard`** (ADR Round-0 missed these). All 7 share the identical root cause: a top-level `z.discriminatedUnion("action", …)` that the SDK's `normalizeObjectSchema` returns `undefined` for.
2. **The fix is `flattenUnionToObjectSchema`, not `materializeUnionJsonSchema`.** Top-level `oneOf` is rejected by the Anthropic API (HTTP 400, "not planned"), and `registerTool` only accepts Zod schemas. The conformant + ecosystem-standard form is a flat `z.object` with an `action` enum. See ADR §2.5.1–2.5.3 for the full rationale.
3. **The 7 tools have non-uniform flattening difficulty.** Most are trivial; `scroll` and `keyboard` have genuine field-type collisions; `terminal` has structural wrinkles (a `.refine()`-wrapped variant, a nested `z.discriminatedUnion`, `z.preprocess`/`z.record` fields). This sub-plan enumerates each.

---

## 2. Phase 2a scope

### 2.1 In-scope deliverables

> **Round 1 review correction (Opus P1 / Codex P1)**: the Draft falsely claimed
> "strict validation is preserved — the handler still parses the real
> discriminatedUnion." It does **not** — verified: `scrollDispatchHandler`,
> `terminalDispatchHandler`, etc. only `switch (args.action)`; the *only*
> runtime Zod validation today is the SDK `CallTool` handler parsing against
> the registered `inputSchema`. Swapping `inputSchema` to the loose flat object
> therefore **removes** strict per-action validation unless it is explicitly
> restored. Phase 2a now does that explicitly (deliverable 2 below). The
> `tools-list-schema.test.ts` path is also corrected to `tests/integration/`.

> **The `unionWithInclude` intermediate (Round 2 Opus P1).** In each of the 7
> tool files, name the result of `withEnvelopeIncludeForUnion(<bareUnion>)` as
> a local — e.g. `const scrollUnionWithInclude = withEnvelopeIncludeForUnion(scrollSchema);`
> — and use that **one** value for **both** `flattenUnionToObjectSchema(...)`
> (the wire schema) **and** `parseActionArgsOrFail(...)` (the strict gate). The
> bare `scrollSchema` is NOT passed to `parseActionArgsOrFail`: it has no
> `include` field, so re-parsing against it and using the parsed result would
> let Zod `.parse()` strip `include` — the exact `feedback_tool_registry_include_strip.md`
> failure. `withEnvelopeIncludeForUnion` only `.extend()`s each variant, so
> `unionWithInclude` still carries every `.refine()`/`z.literal()`/per-action
> `required` constraint **and** the `include` field.

1. **New helper `flattenUnionToObjectSchema()` in `src/tools/_envelope.ts`** (adjacent to `withEnvelopeIncludeForUnion`):
   - **Signature**: `flattenUnionToObjectSchema(unionWithInclude: ZodDiscriminatedUnion): ZodObject` — takes the `withEnvelopeIncludeForUnion`-injected union, returns a flat `z.object` (the **wire schema** — what `tools/list` shows; NOT the validation gate).
   - **Algorithm**:
     1. Enumerate the union's variants. Reuse the same variant-extraction `withEnvelopeIncludeForUnion` already uses (`union._def.options ?? union.options`, with the v3/v4 fallback that helper already has).
     2. For each variant, obtain its field map (`.shape`). **A `.refine()`-wrapped variant** (terminal's `run`) is still a `ZodObject` in zod 4.3.6 — `.refine()` appends the check in place rather than wrapping in `ZodEffects`, so `.shape` (and `.extend()`) are directly accessible. This is why `withEnvelopeIncludeForUnion` already works on `terminalSchema` today **without any unwrap**. Read `.shape` directly — **no unwrap needed** (verified empirically against zod 4.3.6; Opus Round 3 P2).
     3. The discriminator field (`action`) → `z.enum([...all variant literals])`, **required**, with a description that lists every action value.
     4. **The `include` field** (present on every variant because the input is the include-injected union) → carried through to the flat object as `.optional()`, unchanged — this is load-bearing (`tools/list` must advertise `include`, and the wire schema must accept it); a dedicated test case pins it.
     5. Every other field → `.optional()` in the flat object. Collision resolution (see §2.2).
     6. Return `z.object({ action: <enum>, include: <optional>, ...mergedOptionalFields })`. Do **not** `.strict()`.
   - **No SDK patch, no JSON Schema hand-rolling** — the output is a plain Zod object; the SDK's existing `normalizeObjectSchema` + `toJsonSchemaCompat` then produce correct `tools/list` output (`toJsonSchemaCompat` was verified to convert `z.object` correctly).
   - Unit-tested in `tests/unit/flatten-union-schema.test.ts` (new) — one case per collision class (§2.2) + a round-trip "the flat wire schema accepts every input the include-injected union accepts, i.e. is strictly *looser*, never rejects a previously-valid call" + an explicit "`include` survives the flatten" case.

2. **New helper `parseActionArgsOrFail()` in `src/tools/_envelope.ts`** — the strict-validation gate that the flat wire schema no longer provides:
   - **Return type — a discriminated wrapper, NOT `T | ToolResult`** (Opus Round 3 P1): `ToolResult` is `{ content: ContentBlock[]; [key: string]: unknown }` and both `ok()` success and `failArgs()` failure produce that identical shape — there is no safe top-level discriminant, and **no `isToolResult` predicate exists in `src/`**. So `parseActionArgsOrFail` returns an explicit discriminated result:
     ```ts
     // both exported from src/tools/_envelope.ts (adjacent to the two helpers)
     export type ParsedOrFail<T> = { ok: true; value: T } | { ok: false; result: ToolResult };
     export function parseActionArgsOrFail<T>(unionWithInclude, args: unknown, toolName: string): ParsedOrFail<T>
     ```
   - **Behavior**: `safeParse`s `args` against the **include-injected union** `withEnvelopeIncludeForUnion(<bareUnion>)` (which carries every `.refine()` / `z.literal()` / per-action `required` constraint **and** the `include` field — so the parsed result keeps `include`, no strip). On success → `{ ok: true, value }`. On failure → `{ ok: false, result }` where `result` is a **typed `InvalidArgs` error `ToolResult`** built via **`failArgs`** (`_errors.ts:712` — the dedicated validation/input-error path that sets `code:"InvalidArgs"` + `SUGGESTS.InvalidArgs`). **Do NOT use `failWith`** (Codex Round 2 P2): it falls back to generic classification and would mislabel a per-action schema violation, degrading the LLM's invalid-argument recovery. `failArgs(message, toolName, context?)` `context` carries a JSON-friendly digest of the `ZodError` — **`context: { issues: err.issues.map(i => ({ path: i.path, message: i.message })) }`** — NOT the raw `ZodError` (which does not `JSON.stringify` usefully; Opus Round 3 P2).
   - Each of the 7 `*DispatchHandler`s calls it **as the first statement, before the `switch`**: `const parsed = parseActionArgsOrFail(scrollUnionWithInclude, args, "scroll"); if (!parsed.ok) return parsed.result; switch (parsed.value.action) {…}`. **Ordering invariant**: it runs *inside the innermost handler* — the `makeCommitWrapper`/`withRichNarration` wrappers have already seen the raw `args` (their `windowTitleKey` extraction is unaffected), and the typed-error `ToolResult` flows out through the handler's normal return path (the wrappers do not need to catch a throw).
   - This single in-handler gate covers **both** the `server.tool` path **and** the `run_macro` / `TOOL_REGISTRY` path — both ultimately invoke the same wrapped `*DispatchHandler` (PR #112 shared-registration-handler pattern).
   - Unit-tested in `tests/unit/flatten-union-schema.test.ts` — "per-action-invalid input (e.g. `scroll({action:'capture'})` with no `windowTitle`; `terminal({action:'run'})` with neither `input` nor `command`; `keyboard({action:'sequence', method:'background'})`) yields `{ ok: false }` with a `result` whose `code` is `InvalidArgs`" + "a valid call with `include` set yields `{ ok: true }` with `value.include` preserved."

3. **All 7 tools' `registerTool` `inputSchema` switched** to `flattenUnionToObjectSchema(<toolUnionWithInclude>)` (`scrollRegistrationSchema` / `keyboardRegistrationSchema` / `excelRegistrationSchema` / `browserEvalRegistrationSchema` / `windowDockRegistrationSchema` / `terminalRegistrationSchema` / `clipboardRegistrationSchema`), **and** each `*DispatchHandler` updated to call `parseActionArgsOrFail(<toolUnionWithInclude>, args, …)` as its first statement (deliverable 2).
   - **The bare `z.discriminatedUnion` (`scrollSchema` etc.) source definitions are retained unchanged** — they stay the `*Args` type source and the input to `withEnvelopeIncludeForUnion`. What changes: (a) `registerTool`'s `inputSchema` arg, (b) each `*DispatchHandler` gains the re-parse call against `<tool>UnionWithInclude`. **This IS a scoped handler change** — the Draft's "no handler logic change" was wrong.
   - `terminal`'s `terminalDispatchHandler` has a manual `throw new Error(...)` guard whose comment reads "Should be unreachable thanks to the schema-level refine". After Phase 2a it stays unreachable — but now because `parseActionArgsOrFail(terminalUnionWithInclude, …)` runs the `.refine()` first. Update that comment to reference the re-parse (anchor on the comment text, not a line number — line numbers rot).

4. **`src/tools/macro.ts` — `TOOL_REGISTRY` path made consistent.** `macro.ts` does `entry.schema.parse(params)` and currently sets `entry.schema` to the discriminatedUnion. Set `TOOL_REGISTRY[*].schema` for the 7 tools to the **flat wire schema** (same instance as `registerTool` — PR #112 shared pattern). Strict validation for `run_macro` is then the in-handler `parseActionArgsOrFail` (deliverable 2), identical to the `server.tool` path — no validation asymmetry. Because the flat wire schema carries `include` (deliverable 1 step 4), `entry.schema.parse(params)` does **not** strip `include` on the registry path — verify with a `flatten-union-schema.test.ts` case (`feedback_tool_registry_include_strip.md` axis).

5. **Per-field/per-action description updates** where flattening loosens a field — the `action` enum description lists all modes; collision/loosened fields document which action accepts which value; fields whose `.refine()`/`z.literal()` constraint is dropped from the *wire* schema note "enforced at call time, see action='…'" (§2.2).

6. **`tests/integration/tools-list-schema.test.ts`** (new CI gate — path is `tests/integration/`, the only directory the repo's Vitest `integration` project includes; `__test__/` test files are NOT picked up — Codex Round 1 P1):
   - Instantiates an `McpServer`, registers all tools (mirror `server-windows.ts::createMcpServer` registration list), dumps `tools/list`.
   - Asserts each of the 7 flattened tools: non-empty `inputSchema.properties` AND `properties.action` is an `enum` containing every action literal.
   - **Server-wide guard**: asserts NO registered tool has empty `properties` — catches any future top-level-union regression on any tool.
   - Asserts no tool's top-level `inputSchema` has `oneOf` / `anyOf` / `allOf` (Anthropic API conformance).

### 2.2 Per-tool collision analysis (the implementer's checklist)

| Tool | Variants (discriminator `action`) | Collisions / wrinkles | Flatten strategy |
|---|---|---|---|
| `clipboard` | `read`, `write` | none | trivial — `text` → optional |
| `excel` | `run_vba`, `check_access_vbom` | none | trivial — `code`/`macroName`/`visible` → optional |
| `window_dock` | `pin`, `unpin`, `dock` | `title` in all 3 (all `z.string()`, identical) | `title` → optional `z.string()`; all `dock`-only fields optional. (`pin` is both an `action` literal and a `dock` field — different keys, no real collision) |
| `browser_eval` | `js`, `dom`, `appState` | `tabId`/`port`/`includeContext` shared (identical shared params) | keep shared param type once; all variant-unique fields optional |
| `scroll` | `raw`, `to_element`, `smart`, `capture`, `read` | **`windowTitle`** required in `capture`/`read`, optional in others (all `z.string()`); **`direction`** is `enum[up,down,left,right]` (`raw`), `enum[into-view,up,down,left,right]` (`smart`), `enum[down,right]` (`capture`) — **3 different enums**; `raw`'s `direction` is required, `smart`/`capture` have `.default(...)`; `scrollDelayMs`/`tabId`/`port` compatible | `windowTitle` → optional `z.string()` (desc: "required for action='capture'/'read'"); `direction` → `z.enum` of the **union of all values** (`[into-view,up,down,left,right]`), desc states per-action subset. **Wire-loosening note**: the flat schema now accepts `scroll({action:'raw', direction:'into-view'})` and `scroll({action:'raw'})` with no direction — both formerly hard schema rejects. `parseActionArgsOrFail(scrollUnionWithInclude, …)` re-rejects them as typed errors (deliverable 2). |
| `keyboard` | `type`, `press`, `sequence` | **`method`** is `methodParam` (enum) in `type`/`press` but `z.literal("foreground")` in `sequence`; shared focus params (`windowTitle`/`hwnd`/`forceFocus`/`trackFocus`/`settleMs`/`narrate`) identical; `forceImeOff`/`fixId`/`lensId` compatible | `method` → the **wider** type (`methodParam` enum — already includes `"foreground"`); desc states `sequence` only accepts `"foreground"`. **Dropped wire constraint**: `sequence`'s `method` description (`keyboard.ts:2261-2266`) says `background`/`foreground_flash` are "rejected at schema parse time" with typed codes — the *wire* schema no longer rejects them; `parseActionArgsOrFail(keyboardUnionWithInclude, …)` does (the real `sequence` variant's `z.literal("foreground")` still throws). |
| `terminal` | `read`, `send`, `run` | **structural**: `run` variant is `z.object({...}).refine(input \|\| command)` — in zod 4.3.6 this is **still a `ZodObject`**, `.shape` is directly accessible (no unwrap); **`until`** field = `z.preprocess(tryParseJsonObject, z.discriminatedUnion("mode", [...]))` — a **nested** union; `sendOptions`/`readOptions` = `z.preprocess(..., z.record(z.string(), z.unknown()))`; `windowTitle` shared across all 3 (`...terminalReadSchema`/`...terminalSendSchema` spreads expand into `.shape`); `input`/`command` are `run`-only | read `run`'s `.shape` directly (no `.refine()` unwrap — see §2.1 step 2); **leave `until` / `sendOptions` / `readOptions` field types intact** (copy as-is, made optional) — the nested `until` union renders as a property-level `anyOf` (expected-accepted; verified per §3#6). **Dropped wire constraint**: the `run` `.refine(input \|\| command)` is NOT on the flat wire schema (runtime-only) — but `parseActionArgsOrFail(terminalUnionWithInclude, …)` runs it (the include-injected union still carries the `.refine()`), so the existing `terminalDispatchHandler` manual `throw` (anchor: the "Should be unreachable thanks to the schema-level refine" comment) stays unreachable; update that comment to reference the re-parse. |

### 2.3 Out of scope (carry-over / non-goals)

| Item | Reason |
|---|---|
| Changing the **definitions** of the bare `z.discriminatedUnion` schemas (`scrollSchema` etc.) | The bare union *definitions* are untouched — they stay the `*Args` type source and the input to `withEnvelopeIncludeForUnion`. `parseActionArgsOrFail` receives the **include-injected** union (`withEnvelopeIncludeForUnion(<bare>)`), not the bare one (Round 2 Opus P1). What changes is (a) `registerTool`'s `inputSchema` arg and (b) each `*DispatchHandler` gains a `parseActionArgsOrFail` call (deliverable 2). |
| Touching the non-union tools in `browser.ts` | `browser.ts` defines `browser_eval` (a union — in scope) plus several flat-object browser tools (`browser_navigate`, `browser_click`, …) that the audit confirmed clean. Phase 2a touches **only** `browserEvalSchema` / `browserEvalRegistrationSchema` and `browserEvalHandler`. |
| `outputSchema` handling | Audit confirmed no tool uses `outputSchema` — the bug is input-only. |
| The `$schema: draft-07` vs MCP-preferred 2020-12 dialect nit | The SDK's `toJsonSchemaCompat` emits draft-07; clients tolerate it; non-breaking. Recorded as a known minor non-conformance in ADR §1.1; not Phase 2a scope. |
| SDK patch / fork | ADR §2.5.3 + §7 OQ4 — rejected (patch-package unsafe for published packages). |
| The other 22 tools | Their **top-level** schema is a flat `z.object` (emits non-empty `tools/list` `properties`) — not the empty-`properties` regression surface. Nested combinators inside a property (e.g. `perception.ts`'s `perceptionRegisterSchema.target`) are out of scope: they render as property-level `anyOf`, which is not the bug and is API-accepted (only top-level `oneOf`/`anyOf` is rejected). |

---

## 3. G2a acceptance (Phase 2a only)

1. `tools/list` for all 7 tools (`scroll`/`keyboard`/`excel`/`browser_eval`/`window_dock`/`terminal`/`clipboard`) returns non-empty `inputSchema.properties` including `action` enumerated as a flat `z.enum`.
2. Server-wide: no registered tool (all 29) has empty `properties`; no tool's top-level `inputSchema` has `oneOf`/`anyOf`/`allOf`.
3. For each of the 7 tools: every input the **real** `discriminatedUnion` accepts is also accepted by the flat **wire** schema (round-trip test) — flattening only *loosens* the wire schema, never *rejects* a previously-valid call.
4. **`parseActionArgsOrFail` is the strict gate** — for each of the 7 tools, a per-action-invalid input (a combination the real union rejects but the loose flat wire schema accepts — e.g. `scroll({action:'capture'})` with `windowTitle` omitted; `terminal({action:'run'})` with neither `input` nor `command`; `keyboard({action:'sequence', method:'background'})`) is rejected by the in-handler re-parse as a **typed `InvalidArgs` error** (`failArgs` / `_errors.ts`), not silently accepted and not a raw `Error`. Verified by a per-tool negative test.
5. Both entry points enforce identically — the same per-action-invalid input is rejected whether the tool is invoked via `server.tool` (MCP) or via `run_macro` (`TOOL_REGISTRY`).
6. `terminal`'s `until` field renders in `tools/list` as a property-level `anyOf` (nested union intact, not stripped, not top-level) — **empirically checked**, not assumed.
7. `npm run build` (tsc) + full vitest run: no regression.

---

## 4. CLAUDE.md sweep checklist (mandatory per §3.3 Step 1)

- **§3.1 multi-table fact sweep**: `Grep "flattenUnionToObjectSchema|parseActionArgsOrFail|RegistrationSchema|registerTool"` across `src/` `tests/` `docs/`. Synchronized surfaces: `_envelope.ts` (both helpers) / 7 tool files (`*RegistrationSchema` + `*DispatchHandler`) / `macro.ts` (`TOOL_REGISTRY`) / ADR §2.5.2 + §3 SSOT table + §4 Phase 2a / this sub-plan / `tools-list-schema.test.ts`. The "7 tools" count must be identical everywhere it appears.
- **§3.2 carry-over scope shrink**: the real `discriminatedUnion` schema *definitions* are **retained** — no existing public API is narrowed. The flat **wire** schema is strictly *looser* (all fields optional) so every previously-valid call still validates at the wire layer; strict per-action enforcement is **explicitly re-added** as `parseActionArgsOrFail` in each `*DispatchHandler` (it did NOT exist before — Round 1 Opus P1 corrected the Draft's false "already exists" claim). Both entry points (`server.tool` and `run_macro` / `TOOL_REGISTRY`) invoke the same wrapped `*DispatchHandler`, so the single in-handler gate keeps them consistent (PR #112 shared-registration pattern; `feedback_tool_registry_include_strip.md` — also verify `include` survives the flat schema on the registry path).
- **Lesson 1-4**: (1) no causal-window concern; (2) **compile-time-guard over-trust**: the flat `z.object`'s TS type is *wider* than the union — a handler that trusts the flat type would type-check yet accept invalid combos at runtime; the `parseActionArgsOrFail` re-parse is the runtime guard that the compile-time type cannot provide (this is exactly the Lesson-2 trap, and the Draft fell into it by assuming the `switch` validated); (3) order + which-union: `unionWithInclude = withEnvelopeIncludeForUnion(<bare>)` is computed once per tool and feeds **both** `flattenUnionToObjectSchema(unionWithInclude)` (wire schema) **and** `parseActionArgsOrFail(unionWithInclude, …)` (strict gate) — the bare union is NOT used for either (Round 2 Opus P1: bare union has no `include` → `.parse()` strip); (4) numeric count sync: "7 tools" everywhere.

---

## 5. Review loop

Per ADR §4 + CLAUDE.md §3.3 Step 0 (production code, public-API-surface change):
- **Opus 2+ rounds** mandatory (architecture / fact integrity / scope shrink axis — the "real union retained, only registration flattened" contract is the key thing to verify).
- **Codex 1+ round** required (schema / API-contract axis — Codex's strength; this is squarely a schema-shape PR).
- Round 1 prompt includes the §3.1/§3.2/Lesson 1-4 sweep + `file:line` citations + explicit "verify the flattened schema is strictly looser than the real union, never rejects a valid call".
- merge per `feedback_auto_mode_merge_opus_judgment.md` (auto-mode: Opus Approved + P1 zero → AI merges).

---

## 6. File-level work plan

| File | Action |
|---|---|
| `docs/adr-018-phase-2a-subplan.md` | **new** (this file) |
| `src/tools/_envelope.ts` | add `flattenUnionToObjectSchema` (wire schema) + `parseActionArgsOrFail` (strict gate → typed error) helpers |
| `src/tools/scroll.ts` | `scrollRegistrationSchema` → `flattenUnionToObjectSchema`; `scrollDispatchHandler` → `parseActionArgsOrFail(scrollUnionWithInclude, …)` at top; `direction`/`windowTitle` description updates |
| `src/tools/keyboard.ts` | `keyboardRegistrationSchema` → flatten; `keyboardDispatchHandler` → `parseActionArgsOrFail`; `method` description update |
| `src/tools/excel.ts` | `excelRegistrationSchema` → flatten; `excelDispatchHandler` → `parseActionArgsOrFail` |
| `src/tools/browser.ts` | `browserEvalRegistrationSchema` → flatten; `browserEvalHandler` → `parseActionArgsOrFail`. **Scope fence**: touch only the `browser_eval` union — do NOT touch the flat-object browser tools in this file |
| `src/tools/window-dock.ts` | `windowDockRegistrationSchema` → flatten; `windowDockHandler` → `parseActionArgsOrFail` |
| `src/tools/terminal.ts` | `terminalRegistrationSchema` → flatten (`run`'s `.shape` read directly — no `.refine()` unwrap in zod 4.3.6; nested `until` union left intact); `terminalDispatchHandler` → `parseActionArgsOrFail(terminalUnionWithInclude, …)` + update the now-stale "unreachable thanks to schema-level refine" comment to reference the re-parse |
| `src/tools/clipboard.ts` | `clipboardRegistrationSchema` → flatten; `clipboardHandler` → `parseActionArgsOrFail` |
| `src/tools/macro.ts` | `TOOL_REGISTRY[*].schema` for the 7 tools → flat wire schema (consistency with `registerTool`); strict gate is the shared in-handler `parseActionArgsOrFail` |
| `tests/unit/flatten-union-schema.test.ts` | **new** — `flattenUnionToObjectSchema` + `parseActionArgsOrFail` unit tests (collision classes + looser-than-union round-trip + typed-error rejection) |
| `tests/integration/tools-list-schema.test.ts` | **new** — `tools/list` CI gate (7 tools non-empty + server-wide empty-`properties` guard + no top-level `oneOf`). Path `tests/integration/` per the Vitest project include (Codex Round 1 P1) |

Total ≈ 2 new files + 9 modified files. Expected diff ≈ +500 / -40 lines (the per-handler `parseActionArgsOrFail` wiring + collision-field description rewrites add to the Draft's original estimate).

---

## 7. Phase checklist

- [ ] `flattenUnionToObjectSchema` (wire schema) helper implemented + unit-tested
- [ ] `parseActionArgsOrFail` (strict gate → typed error) helper implemented + unit-tested
- [ ] `clipboard` / `excel` / `window_dock` flattened (trivial tier) + `parseActionArgsOrFail` wired in handler
- [ ] `browser_eval` flattened (shared-param tier) + `parseActionArgsOrFail` wired (scope fence: no other browser tool touched)
- [ ] `scroll` flattened (`direction`/`windowTitle` collision tier) + `parseActionArgsOrFail` wired + descriptions updated
- [ ] `keyboard` flattened (`method` collision tier) + `parseActionArgsOrFail` wired + description updated
- [ ] `terminal` flattened (structural-wrinkle tier — `run`'s `.shape` read directly w/o unwrap, `until` nested union left intact + verified) + `parseActionArgsOrFail` wired + stale comment updated
- [ ] `macro.ts` `TOOL_REGISTRY[*].schema` → flat wire schema for the 7 tools; both entry points enforce identically
- [ ] `tests/integration/tools-list-schema.test.ts` CI gate added, all 7 + server-wide guard pass
- [ ] per-tool negative test: per-action-invalid input → typed error (not silent, not raw `Error`)
- [ ] `npm run build` + full vitest green
- [ ] Opus 2+ rounds + Codex 1+ round, P1 zero
