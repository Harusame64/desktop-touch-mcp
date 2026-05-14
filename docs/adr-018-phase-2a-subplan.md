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

1. **New helper `flattenUnionToObjectSchema()` in `src/tools/_envelope.ts`** (adjacent to `withEnvelopeIncludeForUnion`):
   - **Signature**: `flattenUnionToObjectSchema(union: ZodDiscriminatedUnion): ZodObject` — takes a discriminated union (already passed through `withEnvelopeIncludeForUnion`), returns a flat `z.object`.
   - **Algorithm**:
     1. Enumerate the union's variants. Reuse the same variant-extraction `withEnvelopeIncludeForUnion` already uses (`union._def.options ?? union.options`, with the v3/v4 fallback that helper already has).
     2. For each variant, obtain its field map (`.shape`). **A variant may be `.refine()`-wrapped** (terminal's `run`) — unwrap to the underlying `ZodObject` first (`._def.schema` / `.innerType()` / whatever zod 4.3.6 exposes; verify empirically, mirror `withEnvelopeIncludeForUnion`'s handling if it already does this).
     3. The discriminator field (`action`) → `z.enum([...all variant literals])`, **required**, with a description that lists every action value.
     4. Every other field → `.optional()` in the flat object. Collision resolution (see §2.2).
     5. Return `z.object({ action: <enum>, ...mergedOptionalFields })`. Do **not** `.strict()` (the envelope `include` field and per-action fields must all be allowed).
   - **No SDK patch, no JSON Schema hand-rolling** — the output is a plain Zod object; the SDK's existing `normalizeObjectSchema` + `toJsonSchemaCompat` then produce correct `tools/list` output (`toJsonSchemaCompat` was verified to convert `z.object` correctly).
   - Unit-tested in `tests/unit/flatten-union-schema.test.ts` (new) — one case per collision class (§2.2) + a round-trip "flattened schema still accepts every real variant's valid input" assertion.

2. **All 7 tools' `registerTool` `inputSchema` switched** to `flattenUnionToObjectSchema(withEnvelopeIncludeForUnion(<union>))`:
   - `src/tools/scroll.ts` — `scrollRegistrationSchema`
   - `src/tools/keyboard.ts` — `keyboardRegistrationSchema`
   - `src/tools/excel.ts` — `excelRegistrationSchema`
   - `src/tools/browser.ts` — `browserEvalRegistrationSchema`
   - `src/tools/window-dock.ts` — `windowDockRegistrationSchema`
   - `src/tools/terminal.ts` — `terminalRegistrationSchema`
   - `src/tools/clipboard.ts` — `clipboardRegistrationSchema`
   - **The real `z.discriminatedUnion` (`scrollSchema` etc.) is retained unchanged** — it stays the `*Args` type source and is used by the handler for strict runtime validation. Only what is passed to `registerTool` changes.

3. **Handler-side strict validation confirmed** — each tool already has a `*DispatchHandler` / `*Handler` that `switch`es on `args.action`. Phase 2a verifies the dispatch handler still parses the real discriminated union (so a wrong action/field combo → typed error, not silent accept). For tools where the wrapper (`makeCommitWrapper` / `withRichNarration`) parses against the registered schema, ensure the strict union parse happens at the dispatch boundary. **No handler logic change** beyond guaranteeing this strict re-parse exists.

4. **Per-field/per-action description updates** where flattening loosens a field — the `action` enum description lists all modes; collision/loosened fields document which action accepts which value (§2.2).

5. **`__test__/integration/tools-list-schema.test.ts`** (new CI gate):
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
| `scroll` | `raw`, `to_element`, `smart`, `capture`, `read` | **`windowTitle`** required in `capture`/`read`, optional in others (all `z.string()`); **`direction`** is `enum[up,down,left,right]` (`raw`), `enum[into-view,up,down,left,right]` (`smart`), `enum[down,right]` (`capture`) — **3 different enums**; `scrollDelayMs`/`tabId`/`port` compatible | `windowTitle` → optional `z.string()` (description: "required for action='capture'/'read'"); `direction` → `z.enum` of the **union of all values** (`[into-view,up,down,left,right]`), description states per-action subset |
| `keyboard` | `type`, `press`, `sequence` | **`method`** is `methodParam` (enum) in `type`/`press` but `z.literal("foreground")` in `sequence`; shared focus params (`windowTitle`/`hwnd`/`forceFocus`/`trackFocus`/`settleMs`/`narrate`) identical; `forceImeOff`/`fixId`/`lensId` compatible | `method` → the **wider** type (`methodParam` enum — it already includes `"foreground"`); description states `sequence` only accepts `"foreground"` |
| `terminal` | `read`, `send`, `run` | **structural**: `run` variant is `z.object({...}).refine(...)` (unwrap needed); **`until`** field = `z.preprocess(tryParseJsonObject, z.discriminatedUnion("mode", [...]))` — a **nested** union; `sendOptions`/`readOptions` = `z.preprocess(..., z.record(z.string(), z.unknown()))`; `windowTitle` shared across all 3 (`...terminalReadSchema`/`...terminalSendSchema` spreads expand into `.shape`); `input`/`command` are `run`-only | unwrap the `.refine()` on `run` before reading `.shape`; **leave `until` / `sendOptions` / `readOptions` field types intact** (copy as-is, made optional) — the nested `until` union renders as a property-level `anyOf` which the Anthropic API accepts; the `.refine()` itself does NOT carry to the flat schema (runtime-only — stays on the real `terminalSchema` for the handler) |

### 2.3 Out of scope (carry-over / non-goals)

| Item | Reason |
|---|---|
| Changing the real `z.discriminatedUnion` schemas (`scrollSchema` etc.) | They stay as the `*Args` type + strict-validation source. Only `registerTool`'s arg changes. |
| `outputSchema` handling | Audit confirmed no tool uses `outputSchema` — the bug is input-only. |
| The `$schema: draft-07` vs MCP-preferred 2020-12 dialect nit | The SDK's `toJsonSchemaCompat` emits draft-07; clients tolerate it; non-breaking. Recorded as a known minor non-conformance in ADR §1.1; not Phase 2a scope. |
| SDK patch / fork | ADR §2.5.3 + §7 OQ4 — rejected (patch-package unsafe for published packages). |
| The other 22 (flat-object) tools | Audit confirmed clean — no nested `oneOf`/`anyOf`, no `$ref`, no untyped props. |

---

## 3. G2a acceptance (Phase 2a only)

1. `tools/list` for all 7 tools (`scroll`/`keyboard`/`excel`/`browser_eval`/`window_dock`/`terminal`/`clipboard`) returns non-empty `inputSchema.properties` including `action` enumerated as a flat `z.enum`.
2. Server-wide: no registered tool (all 29) has empty `properties`; no tool's top-level `inputSchema` has `oneOf`/`anyOf`/`allOf`.
3. For each of the 7 tools: every input that the **real** `discriminatedUnion` accepts is also accepted by the flattened `z.object` (round-trip test) — flattening only *loosens*, never *rejects* a previously-valid call.
4. Each tool's handler still strict-validates via the real `discriminatedUnion` — a wrong action/field combo produces a typed error (verified by a per-tool negative test or existing dispatch test).
5. `terminal`'s `until` field renders in `tools/list` as a property-level `anyOf` (nested union intact, not stripped, not top-level).
6. `npm run build` (tsc) + full vitest run: no regression.

---

## 4. CLAUDE.md sweep checklist (mandatory per §3.3 Step 1)

- **§3.1 multi-table fact sweep**: `Grep "flattenUnionToObjectSchema|RegistrationSchema|registerTool"` across `src/` `tests/` `docs/`. Synchronized surfaces: `_envelope.ts` (helper) / 7 tool files (`*RegistrationSchema`) / ADR §2.5.2 + §3 SSOT table + §4 Phase 2a / this sub-plan / `tools-list-schema.test.ts`. The "7 tools" count must be identical everywhere it appears.
- **§3.2 carry-over scope shrink**: the real `discriminatedUnion` schemas are **retained** — no existing public API is narrowed. The flattened schema is strictly *looser* (all fields optional) — every previously-valid call still validates; strict per-action enforcement moves to the handler's runtime parse, which already exists. `run_macro` (`TOOL_REGISTRY`) shares the same wrapped handler instances — verify the registry path still works (PR #112 shared-registration pattern; `feedback_tool_registry_include_strip.md`).
- **Lesson 1-4**: (1) no causal-window concern; (2) compile-time: the flat `z.object`'s TS type is wider than the union — handlers must `switch`/parse on the real union, not trust the flat type (the existing `*DispatchHandler` already does); (3) order: `withEnvelopeIncludeForUnion` THEN `flattenUnionToObjectSchema` — pin the order; (4) numeric count sync: "7 tools" everywhere.

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
| `src/tools/_envelope.ts` | add `flattenUnionToObjectSchema` helper |
| `src/tools/scroll.ts` | `scrollRegistrationSchema` → wrap with `flattenUnionToObjectSchema`; `direction`/`windowTitle` description updates |
| `src/tools/keyboard.ts` | `keyboardRegistrationSchema` → flatten; `method` description update |
| `src/tools/excel.ts` | `excelRegistrationSchema` → flatten |
| `src/tools/browser.ts` | `browserEvalRegistrationSchema` → flatten |
| `src/tools/window-dock.ts` | `windowDockRegistrationSchema` → flatten |
| `src/tools/terminal.ts` | `terminalRegistrationSchema` → flatten (handle `.refine()` unwrap + nested `until` union intact) |
| `src/tools/clipboard.ts` | `clipboardRegistrationSchema` → flatten |
| `tests/unit/flatten-union-schema.test.ts` | **new** — helper unit tests (collision classes + looser-than-union round-trip) |
| `__test__/integration/tools-list-schema.test.ts` | **new** — `tools/list` CI gate (7 tools non-empty + server-wide empty-`properties` guard + no top-level `oneOf`) |

Total ≈ 2 new files + 8 modified files. Expected diff ≈ +400 / -20 lines.

---

## 7. Phase checklist

- [ ] `flattenUnionToObjectSchema` helper implemented + unit-tested
- [ ] `clipboard` / `excel` / `window_dock` flattened (trivial tier)
- [ ] `browser_eval` flattened (shared-param tier)
- [ ] `scroll` flattened (`direction`/`windowTitle` collision tier) + descriptions updated
- [ ] `keyboard` flattened (`method` collision tier) + description updated
- [ ] `terminal` flattened (structural-wrinkle tier — `.refine()` unwrap, `until` nested union verified)
- [ ] `tools-list-schema.test.ts` CI gate added, all 7 + server-wide guard pass
- [ ] handler strict re-validation confirmed for all 7
- [ ] `npm run build` + full vitest green
- [ ] Opus 2+ rounds + Codex 1+ round, P1 zero
