# LLM UX improvements — implementation plan

> 2026-04-14 — born from an Opus self-review of an actual MCP session
> (GitHub Notification Settings page exploration).
> Scope: 4 concrete UX/DX papercuts surfaced during real LLM use.

## Goals & non-goals

**Goals**

- Eliminate the most common reason an LLM burns 2-4 extra `browser_eval` calls per page.
- Make Zod input validation errors *self-correcting* — the LLM should be able to fix the call from the error message alone, without re-reading the schema.
- Cut token cost on chained `browser_*` calls in the same tab.

**Non-goals**

- Phase 4 intent composites (`fill_form`, `navigate_to_section`).
- Replacing `browser_get_dom` / `browser_eval` — these stay as escape hatches.
- Cross-tab state aggregation.

---

## The four items

### 1. Self-correcting validation errors (P0, smallest)

**Symptom observed**:
- `browser_navigate({ url, waitForLoad: "true" })` → MCP error -32602 `expected boolean, received string`.
- `wait_until({ target: "{}" })` → MCP error -32602 `expected object, received string`.
- The error names the expected type but gives no example. The LLM has to re-read the tool description (~200 tokens) to recover.

**Fix**:

- Wrap the JSON-RPC validation entry point so any Zod failure response includes a `hint` field with the **first valid example for that field**, derived from the schema's `.describe()` text or hand-curated per-tool.
- For boolean / object / number fields, also accept the obvious string coercions (`"true"`/`"false"`, JSON-parseable string) and emit a one-time `hints.warnings: ["CoercedString"]` so the LLM learns without failing.
- Touch points:
  - `src/index.ts` — central JSON-RPC error responder (wraps every `tool.callback`).
  - `src/tools/_errors.ts` — add `failValidation(zodError, toolName)` that builds the constructive message.

**Acceptance**:
- Calling `browser_navigate({ url:"http://x", waitForLoad:"true" })` returns `ok:true` with `hints.warnings:["CoercedString:waitForLoad"]`.
- Calling `wait_until({ condition:"window_appears", target:"{}" })` returns `fail` with a body that contains `hint: 'target must be an object, e.g. { "windowTitle": "Notepad" }'`.
- Existing well-formed calls keep their current shape (no new fields when nothing went wrong).

**Risk**: Coercion is opinionated. Limit to the safe pairs (`string→boolean`, `string→object via JSON.parse`); never coerce numbers from string (silent precision loss).

---

### 2. `browser_get_app_state` — SPA state extractor (P0, biggest payoff)

**Symptom observed**:
- GitHub's Notification Settings page renders 200 KB of HTML but no `<input>`/`[role=switch]` for the actual toggles. The real state lives in:
  ```html
  <script type="application/json" data-target="react-app.embeddedData">
    {"payload":{"vulnerabilityEmail":true, ...}}
  </script>
  ```
- Took 4 `browser_eval` calls to discover this pattern. Most React/Vue/Next.js apps embed similar payloads (`__NEXT_DATA__`, Apollo `__APOLLO_STATE__`, `<script id="__NUXT__">`, Redux DevTools snapshot, etc.).

**New tool**:

```ts
browser_get_app_state({
  selectors?: string[],   // optional override; default = the well-known list below
  maxBytes?: number,      // truncate per-payload (default 4_000)
  tabId?: string,
  port: number
})
→ ok({
  found: Array<{
    selector: string;        // "script#__NEXT_DATA__", "react-app.embeddedData", ...
    framework: "next" | "react-app" | "apollo" | "nuxt" | "redux-devtools" | "remix" | "custom";
    sizeBytes: number;
    truncated: boolean;
    payload: unknown;        // parsed JSON
  }>,
  notFound: string[],
  activeTab, readyState
})
```

**Default scan list** (cheap, parallelizable in one `Runtime.evaluate`):

| Selector / global | Framework | Notes |
|---|---|---|
| `script#__NEXT_DATA__` | next | App Router data |
| `script[type="application/json"][data-target$=".embeddedData"]` | github react-app | Today's pain point |
| `script#__NUXT__` | nuxt | |
| `script#__APOLLO_STATE__` | apollo | |
| `script#serverData` / `script[data-server-rendered]` | vue ssr | |
| `window.__INITIAL_STATE__` | redux ssr | global eval |
| `window.__REMIX_CONTEXT__` | remix | |
| Any `script[type="application/ld+json"]` | seo metadata | bonus |

**Implementation**:
- New file `src/tools/browser-app-state.ts` (handler) — reuses `evaluateInTab`.
- One composite JS expression that runs `document.querySelectorAll` once for the script-tag forms and reads the `window.*` globals in a single pass; returns a JSON map.
- Truncation per-payload to keep response under ~10 KB total.

**Acceptance**:
- On the GitHub Notification Settings page, returns one entry with `framework:"react-app"` and a payload containing `vulnerabilityEmail`/`vulnerabilityWeb`/etc. — no follow-up `browser_eval` needed.
- On an empty page (`about:blank`), returns `{ found:[], notFound:[...] }` cleanly.
- Token cost target: ≤ 1.5 KB for a found app (current alternative: 4-call probe averaging 6-8 KB).

---

### 3. `browser_get_interactive` — React/ARIA toggle awareness (P1)

**Current behavior**: scans `<input>`, `<button>`, `<a>`, `<select>`. Ignores custom toggles built from `<button role="switch" aria-checked="true">` (GitHub, Radix, shadcn, MUI, Headless UI all use this pattern).

**Extension**:

- Add `[role=switch]`, `[role=checkbox]`, `[role=radio]`, `[role=tab]`, `[role=menuitem]` to the scan.
- Surface `ariaChecked` / `ariaPressed` / `ariaSelected` / `ariaExpanded` as a new `state` field on each interactive entry.
- Keep the existing `enabled` / `disabled` axis distinct from the new `state`.
- Optional `types` enum gains `"toggle"` (covers switch/checkbox/radio when implemented as ARIA roles).

**Response shape change** (additive):

```ts
interactive: Array<{
  // existing
  selector: string;
  role: string;
  text: string;
  clickAt: { x: number; y: number };
  inViewport: boolean;
  enabled: boolean;
  // new
  state?: {
    checked?: boolean;     // from aria-checked
    pressed?: boolean;     // from aria-pressed
    selected?: boolean;    // from aria-selected
    expanded?: boolean;    // from aria-expanded
  };
}>
```

**Acceptance**:
- On the GitHub Notification Settings page, every Email/Web toggle appears with `state.checked` populated.
- Existing tests keep passing — `state` is optional and absent for elements without ARIA state attrs.

**Risk**: Enumerating ARIA roles can return shadow-DOM / hidden popovers. Filter by `getBoundingClientRect()` non-zero AND `getComputedStyle().visibility !== "hidden"` (already done for the existing scan).

---

### 4. `includeContext: false` for chained browser calls (P2, smallest)

**Symptom observed**: every `browser_eval` / `browser_find_element` / `browser_get_dom` / `browser_get_interactive` appends:

```
activeTab: {"id":"...","title":"...","url":"..."}
readyState: "complete"
```

For an LLM that just made 5 sequential calls in the same tab, this is ~150 tokens of redundant context per call.

**Fix**:
- Add `includeContext: boolean` (default `true`) to the four browser handlers.
- When `false`, skip the `getTabContext` fetch and the trailing two lines.
- Also: when `getTabContext` is fetched, cache it for ~500 ms keyed by `(port, tabId)` so chained calls without `includeContext:false` still benefit.

**Acceptance**:
- `browser_eval({ expression:"1+1", includeContext:false })` returns just `"2"`.
- Default behavior unchanged.
- Within a 500 ms window, two `browser_eval` calls do **one** CDP round-trip for tab context, not two.

---

## Sequencing & estimates

| # | Item | Effort | Order rationale |
|---|---|---|---|
| 1 | Self-correcting validation errors | S (1 file + tests) | Lands first — every other improvement benefits from it |
| 4 | `includeContext` opt-out + 500 ms cache | S | Trivial, ships alongside #1 |
| 3 | `get_interactive` ARIA roles | M | Touches existing handler + tests; behavior change is additive |
| 2 | `browser_get_app_state` | M (new file) | Largest payoff but most surface — ship after #1/#3/#4 are stable |

Aim: one PR per item, in the order above. Each PR is reviewable in <15 minutes.

---

## Testing

### Unit
- `_errors.test.ts`: validation error → hint mapping. Coercion table.
- `app-state-extract.test.ts`: pure function that selects the framework given a payload shape.

### E2E
- Extend `tests/e2e/browser-tab-context.test.ts`:
  - `browser_eval(includeContext:false)` does not append `activeTab:` lines.
  - Two consecutive `browser_eval` calls with `includeContext:true` use the 500 ms tab context cache (assert via mock or via timing under a threshold — prefer mock).
- New `tests/e2e/browser-app-state.test.ts`:
  - On the local fixture (`tests/e2e/fixtures/test-page.html`), inject a `<script type="application/json" data-target="x.embeddedData">{"foo":1}</script>` and assert it's surfaced.
  - On `about:blank`, returns empty `found`.
- New `tests/e2e/browser-interactive-aria.test.ts`:
  - Add a `<button role="switch" aria-checked="true">` to the fixture; assert it appears with `state.checked === true`.
- New `tests/unit/validation-coerce.test.ts`:
  - `"true"` → `true` for boolean field, `"{}"` → `{}` for object field.
  - `"abc"` → returns the constructive `fail` (no silent coercion).

### Hands-on
- Re-run today's GitHub Notification Settings exploration:
  - `browser_get_app_state` returns `vulnerabilityEmail` etc. in 1 call.
  - `browser_get_interactive` returns the Email/Web toggles with `state.checked`.
  - Total token cost ≤ 50% of the original 4-call probe.

---

## Risks & open questions

- **Coercion footgun**: if `waitForLoad:"true"` becomes legal, future tools that genuinely want a string `"true"` (e.g. `keyboard_type({ text:"true" })`) might confuse the LLM. Mitigation: coercion lives in the *validation wrapper* and only fires when the schema's expected type is the non-string one.
- **`browser_get_app_state` shape stability**: framework detection labels (`"next"` / `"react-app"` / etc.) become public API. Pin them and add a `"unknown"` bucket for future frameworks rather than guessing.
- **ARIA toggle clickability**: some `role=switch` elements need `mouse_click` while others need `keyboard_press("space")` to toggle. Document the difference in `set_element_value` instructions; do not silently dispatch — let the LLM pick.

---

## Out of scope (for next-next plan)

- WebSocket-based event subscription on the CDP side (live "form value changed" stream).
- `browser_fill_form` / `browser_submit` intent composites — wait for app-state usage data to inform the API shape.
