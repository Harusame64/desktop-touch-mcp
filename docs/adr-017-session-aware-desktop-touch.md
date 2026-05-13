# ADR-017: Session-aware desktop-touch — exposing the Terminal Services session context to the LLM

- Status: **Accepted (Round 2, implementation landed)** — paired with `docs/rdp-session-window-behavior.md` investigation
- Date: 2026-05-13
- Authors: Claude (Opus 4.7) reflecting user-led RDP investigation 2026-05-13
- Related:
  - ADR-016 (`docs/adr-016-rdp-virtual-window.md`) — host→remote axis (driving a remote PC over RDP). ADR-017 is the **complementary axis**: making desktop-touch self-describe its own session context when it is the *in-session* host process.
  - `docs/rdp-session-window-behavior.md` — context, theoretical matrix, S1/S2/S5 spike results that anchor this ADR. **Required reading before reviewing this ADR.**
  - `src/win32/window.rs` (ADR-007 P1 hot path) — existing native binding surface that ADR-017 extends with three read-only session APIs.
- Blocks: none.
- Blocked by: this ADR's review and acceptance.

---

## 1. Context

### 1.1 What the spike showed (one paragraph summary)

S1 (console) and S2 (active RDP) results in `docs/rdp-session-window-behavior.md` §5.1–§5.2 confirmed that the project's existing Win32 primitives (`EnumWindows`, `GetForegroundWindow`, `GetWindowTextW`, …) are **already** session-bound. Cross-session leakage is structurally impossible: every HWND returned by `EnumWindows` from inside an RDP session (own session id = 5) had `sessionId = 5`, despite five other sessions (one Console, one stale Disconnected, one zombie, two RDP listeners) coexisting on the host. So ADR-017 is not about adding gates — it is about adding **observability** so:

1. The LLM can see which session it is in (`'console' | 'rdp' | 'other'`) and adapt its narration accordingly.
2. The LLM can avoid issuing input commands in pathological states (locked / disconnected) by reading a derived `sessionState` field.
3. The project is forward-compatible with ADR-016 Phase 3's `Origin::Rdp { host, session_id }` without later schema churn.

### 1.2 Why it is worth a separate ADR (not just a `desktop_state` field doc note)

Two reasons:

- **Cross-ADR coupling.** ADR-016 §6.3 commits to `Origin { Local, Rdp { host, session_id } }` as the dataflow event origin. ADR-017's `sessionContext.ownSessionId` is the same id field. If Phase 3 of ADR-016 lands later, the on-wire JSON shape from ADR-017 should already match (`{ kind: 'local', sessionId }` today → easy to extend to `{ kind: 'rdp', host, sessionId }` then). Locking that shape in via ADR is cheaper than discovering the mismatch during Phase 3 review.
- **Native-binding surface.** Three new `#[napi]` functions touch the ADR-007 P1 hot path — `win32_get_process_session_id`, `win32_get_active_console_session_id`, `wts_enumerate_sessions`. These are read-only and panic-safe, but they add to the binding contract `index.d.ts` ships, and ADR-007 P1 requires deliberate decisions for additions there.

---

## 2. Decision

**Add a `sessionContext` opt-in to `desktop_state`, backed by three new read-only native bindings.** Cross-session control surfaces (`CreateProcessAsUser`, session-id filters on `desktop_discover`) are explicitly out of scope for ADR-017 v1.

### 2.1 What ships

#### 2.1.1 Three new `#[napi]` bindings in `src/win32/session.rs` (new file)

```rust
/// Map a Win32 process id to its Terminal Services session id via
/// `ProcessIdToSessionId`. Returns `None` if the pid is invalid or the
/// call fails (TS wrapper converts to `null`).
#[napi]
pub fn win32_get_process_session_id(pid: u32) -> napi::Result<Option<u32>> { ... }

/// Wrap `WTSGetActiveConsoleSessionId`. Returns the active console session
/// id, or `0xFFFFFFFF` (`u32::MAX`) when no user is logged in at the
/// physical console. The caller is expected to treat `u32::MAX` as the
/// sentinel and not interpret it as a real session id.
#[napi]
pub fn win32_get_active_console_session_id() -> napi::Result<u32> { ... }

/// Wrap `WTSEnumerateSessionsW`. Returns one entry per session on the
/// local host: `{ sessionId, winStation, state, stateLabel }`. Empty list
/// on failure; never returns an error variant (the call is best-effort
/// diagnostic, not part of any control path).
#[napi]
pub fn wts_enumerate_sessions() -> napi::Result<Vec<NativeWtsSessionInfo>> { ... }
```

Panic safety is identical to existing `win32_*` bindings (each call is wrapped in `napi_safe_call(...)`). Memory ownership for `WTSEnumerateSessionsW`'s out-parameter is handled internally — `WTSFreeMemory` is called before the `Vec` is built so the napi return value owns no `wtsapi32`-allocated memory.

#### 2.1.2 `desktop_state` opt-in

`desktop_state` gains a new boolean field on the existing `include` array (the same include-API surface §1 of ADR-010/011 commits to). The field is `'sessionContext'`:

```ts
desktop_state({ include: ['sessionContext'] })
```

When set, the response gains a top-level `sessionContext` object:

```ts
{
  // existing fields unchanged
  sessionContext: {
    origin: { kind: 'local', sessionId: number },   // forward-compat with ADR-016 Phase 3 Origin
    consoleSessionId: number | null,                // null when WTSGetActiveConsoleSessionId returned u32::MAX
    sessionLabel: 'console' | 'rdp' | 'other',
    sessionState: 'active' | 'connected' | 'disconnected' | 'locked' | 'unknown',
    ownWinStation: string,                          // 'Console' | 'RDP-Tcp#N' | '' (when WTSEnumerateSessions failed)
  }
}
```

Classifier logic (TS layer, not native — keeps native binding minimal):

- `sessionLabel = 'console'` iff `ownSessionId === consoleSessionId && consoleSessionId !== null`
- `sessionLabel = 'rdp'` iff `ownWinStation` matches `/^RDP-Tcp/`
- `sessionLabel = 'other'` otherwise

The `sessionState` field is read from the matching `WTSEnumerateSessions` entry for `ownSessionId`. If `WTSEnumerateSessions` failed (no entries), `sessionState = 'unknown'`. The four happy-path values map directly from `WTS_CONNECTSTATE_CLASS` (`WTSActive=0`, `WTSConnected=1`, `WTSConnectQuery=2`, `WTSDisconnected=4`). `'locked'` is **derived** in the TS layer when `sessionState === 'active'` but `GetForegroundWindow → null` *and* the foreground was non-null on the previous `desktop_state` call within the last 60 s. See §3.2 for why this is a heuristic.

#### 2.1.3 Boolean serialisation

Per the project's `coercedBoolean()` convention (user memory `reference_mcp_boolean_serialization`), the `include` array continues to use string literals (no boolean fields are added by ADR-017). No new `z.boolean()` calls.

### 2.2 What does NOT ship

- **Cross-session operation.** No `CreateProcessAsUser` / `WTSGetSessionUserToken` / impersonation. Driving another logged-in session is a security surface that does not fit in ADR-017's "observability only" remit.
- **`desktop_discover` session filter.** ADR-016 Phase 3 will introduce `Origin` filtering across views; doing it twice would create migration churn. ADR-017 only exposes the `sessionId` so the LLM can see, not act on, the session distinction.
- **`WTSRegisterSessionNotification` event subscription.** Latency-sensitive lock/unlock detection (e.g. for an LLM that wants to pause input on lock) would benefit from this, but it requires a window-message-pump host, which is invasive. Out of scope for v1; revisit if LLM telemetry shows the heuristic in §3.2 is unreliable.
- **Cross-machine session aggregation.** That is ADR-016 Phase 3's job (the dataflow operator graph extension).

---

## 3. Design notes

### 3.1 Why a single `include: ['sessionContext']` rather than always-on

`desktop_state` is the project's cheapest perception call (`memory/feedback_dogfood_desktop_touch` calls it out as the first thing to call). Adding three extra syscalls to every invocation, even small ones, pays a token cost across the entire LLM session. The opt-in shape keeps the default path unchanged and lets the LLM ask for it once per logical context (e.g. on startup, after a focus change to mstsc).

### 3.2 Why `'locked'` is a heuristic, not a Win32 fact

The matrix in `docs/rdp-session-window-behavior.md` §3 predicts (and we deferred verifying in S3) that `GetForegroundWindow` returns NULL when the session is locked. We cannot read the `LockWorkStation` state directly without WTSRegisterSessionNotification or per-session winsta queries that need admin. So ADR-017 v1 derives `'locked'` from observable correlates:

- `sessionState === 'active'` (the session is *connected* to a client; this rules out S4/disconnected)
- `GetForegroundWindow() === null` (no input desktop is the calling thread's desktop)
- and the previous `desktop_state` call within the last 60 s had a non-null foreground (we transitioned NULL — not "always NULL")

Three-of-three → `'locked'`. Otherwise `'active'`. This is **deliberately conservative** (false-negatives are cheap, false-positives would mislead the LLM into deferring input on a legitimately active session). The 60-second window is held in the same TS-side cache that `desktop_state` already uses for `latest_focus`; no new state to introduce.

If S3 (locked) is ever captured and shows the prediction wrong, the heuristic needs revision — but the ADR-017 surface (the JSON fields and their semantics) does not change. Only the derivation function changes.

### 3.3 Forward-compat with ADR-016 Phase 3 `Origin`

ADR-016 §6.3 commits to:

```rust
enum Origin {
  Local,
  Rdp { host: String, session_id: String },
  // future: Citrix, NoMachine, …
}
```

ADR-017's on-wire shape pre-emptively matches this:

- Today, every `desktop_state` response with `sessionContext` carries `origin: { kind: 'local', sessionId: N }`.
- When Phase 3 lands, remote-agent-supplied events will populate `origin: { kind: 'rdp', host: '...', sessionId: 'N' }` (Phase 3 will need to decide if `sessionId` stays `number` or becomes `string`; ADR-017 v1 picks `number` for the local case because that is what `ProcessIdToSessionId` returns).

The TS-side type can be a `discriminatedUnion('kind', [...])` from day one to make the migration trivial:

```ts
type Origin =
  | { kind: 'local'; sessionId: number }
  // Phase 3 (ADR-016): | { kind: 'rdp'; host: string; sessionId: number | string }
  ;
```

### 3.4 Generated artefact discipline (memory `feedback_stub_catalog_regen`)

The three new `#[napi]` bindings will appear in `index.d.ts` via the existing `napi build` flow, and they will need to be reflected in `src/stub-tool-catalog.ts` if and only if they become user-facing MCP tool schemas. They are *not* user-facing tools — they are internal native binding helpers consumed by `desktop_state`'s implementation. So:

- `check:native-types` will catch the `index.d.ts` regen (run `npm run check:native-types` after the Rust change, commit the diff).
- `check:stub-catalog` is unaffected because no new `server.tool` / `server.registerTool` call is added (only a new include keyword inside `desktop_state`'s existing registration).

---

## 4. Acceptance criteria

- [ ] This ADR landed (Status: Draft → Accepted) when the implementation PR opens.
- [ ] Implementation PR adds `src/win32/session.rs` with three `#[napi]` bindings and panic-safety wrappers matching `src/win32/window.rs` style.
- [ ] `desktop_state` accepts `include: ['sessionContext']` and returns the schema in §2.1.2.
- [ ] `tests/unit/` adds (a) unit tests over the TS classifier (`sessionLabel`, `sessionState`, the locked heuristic), and (b) at least one fuzz iteration in `native-win32-panic-fuzz.test.ts` covering the three new bindings.
- [ ] `docs/rdp-session-window-behavior.md` gains a §6 cross-reference back to the accepted ADR-017 (currently the §6 already references the draft).
- [ ] If S3 (locked) measurement is taken in the implementation PR's verification, its result is appended to `docs/rdp-session-window-behavior.md` §5.3; if the heuristic in §3.2 needs revision, the implementation PR carries the revision.

Phase 2 / Phase 3 do not exist in this ADR. Any larger session-aware work (event subscription, cross-session control) is a separate ADR.

---

## 5. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | The `'locked'` heuristic in §3.2 misclassifies under conditions S3 spike was not run against | Conservative-by-default (false-negative is the only side); explicit `'unknown'` escape hatch when state is genuinely ambiguous; document the heuristic transparently in `desktop_state` description so the LLM treats it as advisory |
| R2 | Enterprise lockdown blocks `WTSEnumerateSessions` for a non-admin user | `wts_enumerate_sessions` returns an empty Vec on failure; `sessionState` falls back to `'unknown'`; `sessionContext` still returns the `Origin` and the `sessionLabel` from `ProcessIdToSessionId` + `WTSGetActiveConsoleSessionId` alone |
| R3 | `ProcessIdToSessionId` is only available on Windows; the project's TS surface must not crash on non-Windows callers | Existing pattern: the native binding module is `#[cfg(windows)]`-gated; the TS classifier returns `sessionContext: null` with a `hints.sessionContextUnavailable: 'non-windows-host'` field |
| R4 | `Origin` shape locked in ADR-017 v1 conflicts with ADR-016 Phase 3's eventual decision | Discriminated-union from day one (§3.3) makes the future additions purely additive; the Phase 3 ADR can extend variants without breaking ADR-017 callers |
| R5 | LLM misuses `sessionLabel='rdp'` to decide things it shouldn't (e.g. refusing to type) | `sessionLabel` is informational. The tool descriptions must explicitly state that the LLM should keep using `keyboard` / `mouse` normally; only `sessionState='locked'` (heuristic) implies input pause |

---

## 6. Open questions

- **OQ1** — Should `sessionContext` also include the `userName` (whoever owns the session)? Lean: **no for v1** — the existing `userName` is in `os.userInfo().username` and the LLM can read it without a new field; adding it here costs nothing but is redundant.
- **OQ2** — Should the `'locked'` heuristic move into native code so it can also light up in non-MCP contexts (e.g. `engine-perception` operators)? Lean: **no for v1** — the heuristic depends on TS-side caching of the previous foreground. Native could replicate it but adds invariants. Revisit if a perception-graph operator wants it.
- **OQ3** — `sessionId` numeric vs string in the `Origin` JSON shape: ADR-016 §6.3 currently writes `session_id: String`. ADR-017 v1 picks `number` for local (`ProcessIdToSessionId` returns `u32`). Phase 3 needs to reconcile. Lean: **let Phase 3 promote local to string too** if cross-protocol uniformity matters; both sides can do the conversion losslessly.
- **OQ4** — Should ADR-017 ship a `desktop_discover` advisory (when `sessionLabel='rdp'`, include `hints.rdpAdvisory: 'mstsc client window is the only local HWND; remote app discovery requires ADR-016 path'`)? Lean: **yes** — it is a one-line hint that pre-emptively educates the LLM, and the host side already calls ADR-016's existence out.

---

## 7. References

- ADR-007 P1 (`docs/adr-007-p1-design-proposal.md`) — Native binding hot-path architecture; ADR-017's three bindings follow the same panic-safety pattern as `src/win32/window.rs`
- ADR-008 (`docs/adr-008-reactive-perception-engine.md`) — Operator graph that ADR-016 Phase 3 extends; ADR-017 does not modify this layer but inherits its `Origin` design
- ADR-010 / ADR-011 — `include` API convention; ADR-017's `include: ['sessionContext']` uses the same shape
- ADR-016 (`docs/adr-016-rdp-virtual-window.md`) — The orthogonal axis; ADR-017's `Origin` shape is forward-compatible with §6.3
- `docs/rdp-session-window-behavior.md` — Spike + matrix + S2 results that anchor ADR-017
- `src/win32/window.rs` — Reference implementation for the panic-safety wrapper pattern that ADR-017's three bindings copy
- [Remote Desktop Sessions — Win32 apps](https://learn.microsoft.com/en-us/windows/win32/termserv/terminal-services-sessions) — Session / window-station / desktop hierarchy
- [WTSEnumerateSessionsExW](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsenumeratesessionsexw) — Session enumeration API
- [ProcessIdToSessionId](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-processidtosessionid) — Process-to-session resolution
- [WTSGetActiveConsoleSessionId](https://learn.microsoft.com/en-us/windows/win32/api/kernel32/nf-kernel32-wtsgetactiveconsolesessionid) — Console session id

---

## 8. Decision history

### 2026-05-13 — Draft (Round 1)

Author: Claude (Opus 4.7) reflecting user-led RDP investigation.

- Drafted after spike S1 (console, self-run) + S2 (RDP-active, user PC-B run) + S5 (other-session-running, confirmed inside S2 capture) in `docs/rdp-session-window-behavior.md`.
- Scoped tightly to observability (three native bindings + one `include` field). Cross-session control and `WTSRegisterSessionNotification` event subscription deferred to a future ADR if telemetry demands it.
- `Origin` discriminated-union shape locked in at draft time to be forward-compatible with ADR-016 Phase 3.

### 2026-05-13 — Round 2 (Accepted, implementation landed)

Author: Claude (Opus 4.7).

Implemented in the same session as the Round 1 draft. The three `#[napi]`
bindings, the TS classifier, and the `desktop_state` `includeSessionContext` /
`include: ['sessionContext']` opt-in all match the §2.1 contract; the Round 2
addendum in `docs/rdp-session-window-behavior.md` §8 records the live S1
re-verification (console session: classifier emits `sessionLabel: 'console'`
+ `sessionState: 'active'`, matches predicted matrix row).

Implementation deviations from the Round 1 draft, with rationale:

- §2.1.2 advertised `include: ['sessionContext']` as the sole opt-in keyword;
  the implementation accepts both that **and** an equivalent
  `includeSessionContext: true` boolean schema field. Reason: the existing
  `desktop_state` schema already uses `includeCursor` / `includeScreen` /
  `includeDocument` booleans for analogous opt-ins, and the envelope wrapper
  (`makeEnvelopeAware`) destructures `include` off `args` before the handler
  sees it. Rather than thread the keyword through the wrapper, a thin
  registration shim (`desktopStateRegistrationHandlerWithIncludeRoute`)
  translates `include: ['sessionContext']` → `includeSessionContext: true`
  before forwarding. Both forms produce the same on-wire shape; the
  description string in the registered schema documents both for LLM
  clients.
- §3.2's locked heuristic is implemented exactly as specified (3-of-3
  conditions: native `active` + `GetForegroundWindow → null` + previous
  sample within 60s observed a non-null foreground). The 60s window is
  measured inclusively (`<= 60_000`), pinned by
  `tests/unit/session-context.test.ts`. The cache lives in
  `src/tools/desktop-state.ts` module scope rather than the
  `latest_focus` cache the ADR text gestured at — keeping the heuristic
  state local to its only consumer keeps the L3 view's existing surface
  unchanged.

Acceptance criteria coverage:

- [x] ADR moved Draft → Accepted in the implementation PR.
- [x] `src/win32/session.rs` adds three `#[napi]` bindings with
      `napi_safe_call` panic-safety wrappers matching `src/win32/window.rs`
      style.
- [x] `desktop_state` accepts the opt-in and returns the §2.1.2 schema.
- [x] `tests/unit/session-context.test.ts` covers the classifier and the
      locked heuristic; `tests/unit/native-win32-panic-fuzz.test.ts` adds
      adversarial fuzz over the three new bindings.
- [x] `docs/rdp-session-window-behavior.md` §8 carries the Round 2
      cross-reference back.
- [ ] S3 (locked) live verification — deferred per §5.7; the
      implementation will run the matrix-defined script in a follow-up
      session and append the result either to this ADR (as a Round 3
      note) or to the RDP behaviour doc §5.3.
