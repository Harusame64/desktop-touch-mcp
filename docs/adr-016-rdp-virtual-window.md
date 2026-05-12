# ADR-016: RDP Virtual Window — Multi-machine perception via RemoteApp / visual segmentation / DVC plugin

- Status: **Draft (Proposed, Round 3, multi-phase)** — Opus Round 1 + Round 2 findings reflected; Phase 1 ready to implement, Phase 2/3 require dedicated ADR phases on top of this overview
- Date: 2026-05-12 (Round 1 draft) / 2026-05-12 (Round 2 revision) / 2026-05-12 (Round 3 revision)
- Authors: Claude (Sonnet draft, research backed by Opus 2026-05-12 web survey; Opus + Codex review feedback integrated)
- Related:
  - User report 2026-05-12 — when operating a remote PC via RDP / mstsc, the MCP only sees the local RDP-client window. The user asked for a virtual-window split.
  - ADR-008 (`docs/adr-008-reactive-perception-engine.md`) — the reactive perception graph + view catalog architecture that this ADR's Phase 3 extends to multi-machine; **Phase 3 requires changes to dataflow event structs and view key space, not only envelope-level metadata** (see §6, Codex Round 1 P1)
  - ADR-015 (`docs/adr-015-vba-extensibility-bridge.md`) — parallel-track work; not blocking, but Phase 1 of this ADR follows the same "single tool + action dispatcher + explicit invariant 6 exception" pattern (see §3.1)
  - `crates/engine-perception/` — the operator graph
  - `src/l3_bridge/focus_pump.rs` — the existing L1→L3 bridge whose decode flow Phase 3 §6 extends
  - `src/l1_capture/` — the L1 ring + `SubscriptionEvent` + `EventEnvelope` types
- Blocks: none today
- Blocked by: this ADR's review and acceptance (Phase 1) → its own follow-up sub-plans (Phase 2 / Phase 3)

---

## 1. Context

### 1.1 The problem in concrete terms

When the user is inside an RDP session driven by `mstsc.exe`, the Windows host sees:

- **One** local window: the RDP client (`hwnd = X`, `title = "<remote machine> - Remote Desktop Connection"`, `processName = "mstsc"`)
- **Zero** local windows for any application running on the remote machine

Consequences for this MCP:

- `desktop_state` and `desktop_discover` return only the RDP client window
- `screenshot(windowTitle = "Remote Desktop")` captures the entire remote desktop as one image — token cost scales with full-screen pixel count
- `mouse_click(x, y, …)` does work (RDP forwards clicks) but the target has to be chosen from the full-screen capture
- `keyboard.type(text, windowTitle = …)` cannot be scoped to a remote application, because the remote app is not a local window

The net effect is that an LLM driving the MCP through an RDP session falls back to coordinate-roulette — the exact experience the project's hero text positions against.

### 1.2 Why the existing perception layer cannot fix this in place

| Primitive | What it does | Why RDP defeats it |
|---|---|---|
| `EnumWindows` | Lists local top-level `HWND`s | Remote app windows are not local `HWND`s — they are bitmap regions inside the RDP client's window |
| `IUIAutomation::ElementFromHandle` | Walks the UIA tree under a given `HWND` | Cross-session UIA queries fail with `0x80040201 UIA_E_ELEMENTNOTAVAILABLE` for arbitrary remote elements (explicitly called out by Microsoft Q&A for RemoteApp sessions, see §10) |
| `GetWindowTextW` | Reads a window's title | Reads only the RDP client's title — usually the remote-machine hostname |

UIA is **not designed to tunnel across RDP** for ordinary Win32 / Chrome apps. The fix is structural — change the transport, not the primitive.

### 1.3 What the industry actually does

1. **Out-of-band agent + DVC plugin** — Microsoft Power Automate Desktop ships `PAD.RDP.ControlAgent.exe` + `PAD.RDP.AutomationAgent.exe` inside the remote session, plus a `Microsoft.Flow.RPA.Desktop.UIAutomation.RDP.DVC.Plugin` loaded by `mstsc` on the local machine. This is the technique used by every production-grade RPA tool that supports RDP. Microsoft published OSS DVC plugin samples on 2025-08 (`microsoft/rdp-dvc-plugin-samples`).
2. **RemoteApp publishing** — Instead of full-desktop RDP, the remote publishes individual applications as RemoteApp windows that appear on the local desktop as **independent local `HWND`s** (RAIL protocol, `MS-RDPERP`). Works on Windows 10/11 Pro with a registry hack at the cost of single-session restriction.
3. **Visual grounding only** — Capture the full RDP screen, detect interactable regions. The project already integrates Microsoft OmniParser V2 in `src/vision_backend/omniparser.rs`; routing RDP-client capture through the existing pipeline is an **application** of existing code.

The right answer is to ship all three as a progressive ladder so each user's situation maps to the cheapest viable option.

---

## 2. Decision

**Adopt a three-phase progressive RDP support strategy.** Each phase is shippable in isolation, ordered by user-install cost (not implementation cost).

| Phase | What it ships | Implementation cost | User install cost | Target user case |
|---|---|---|---|---|
| **Phase 1 — RemoteApp helper** | One new `rdp` MCP tool with `generate_rdp` / `check_setup` actions; setup is a CLI script | S (~1 day) | Registry tweak on remote PC (admin), one-time | Case A: personal LAN |
| **Phase 2 — Visual segmentation** | New `desktop_discover` mode for RDP client windows routing through the **existing** OmniParser pipeline + a classical-CV fast-lane sub-module of `engine-vision` | M (~1-2 weeks) | None (host only) | Case B: enterprise VDI |
| **Phase 3 — DVC plugin + thin agent** | Custom RDP DVC plugin + remote-side agent + perception-graph extension to multi-machine (see §6) | L (~4-6 weeks for pure implementation, excluding its own ADR drafting cost) | DVC DLL register on local (admin) + agent msi on remote (admin) | Case C: cloud VPS, multi-app remote sessions |

This ADR locks in:

- The ordering (Phase 1 → Phase 2 → Phase 3)
- Acceptance gates between phases (each phase must close at least one user case before the next phase starts)
- The structural extension point on the existing perception graph (§6) that Phase 3 will plug into — **including the dataflow-key and event-struct changes the Round 1 draft omitted**

### 2.1 Why not skip Phase 1 and go straight to Phase 3?

Phase 1 is 1 day of work and may close 80% of the user-reported pain. Phase 3's L cost is justified only after Phase 1 / 2 telemetry shows users hitting their ceiling.

### 2.2 Why not the alternative axes (UIA tunnel, WinRM-only, SendMessage)?

| Alternative | Why rejected |
|---|---|
| Force UIA to tunnel through RDP | Microsoft Q&A explicitly documents this as not supported for non-UWP apps |
| WinRM / SSH read-only enumeration (without remote agent) | Can list processes but cannot enumerate `HWND` geometry, UIA tree, or focus state without a remote helper |
| `SendMessage` from local to remote via RDP | Win32 messages do not cross RDP boundaries |
| Self-built TCP transport instead of DVC | Loses the RDP-session piggyback (separate firewall hole, NAT traversal becomes the user's problem) |

---

## 3. Phase 1 — RemoteApp helper (S, ready to implement on demand)

### 3.1 What ships — a single new `rdp` MCP tool + a CLI setup script

Following ADR-015's pattern (single tool + action discriminator + explicit invariant 6 exception), Phase 1 adds **one** new MCP tool `rdp` with:

```ts
const rdpInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("generate_rdp"),
    remoteHost: z.string(),
    remoteAppPath: z.string(),
    friendlyName: z.string(),
    audioMode: z.enum(["disabled", "leave-at-remote", "redirect"]).default("disabled"),
    redirectClipboard: z.boolean().default(false),
    redirectDrives: z.boolean().default(false),
    outputPath: z.string(),
    overwrite: z.boolean().default(false),  // refuse to clobber an existing file by default
  }),
  z.object({
    action: z.literal("check_setup"),  // read-only, scope-local only — see Round 3 note below
  }),
]);
```

**`action: "generate_rdp"`** — produces a `.rdp` file with `remoteapplicationmode:i:1` + `RemoteApplicationProgram` + `RemoteApplicationName`. Defaults are minimal-safe. `overwrite: false` refuses to clobber an existing file unless the caller explicitly opts in.

**`action: "check_setup"`** — read-only. Inspects the local machine's registry to determine whether the user has run the setup script on **this** machine (typically run on the remote PC). The action operates ONLY on the local machine.

> **Round 3 note — remote verification deferred.** Round 2 proposed a `scope: "verify-remote-via-winrm"` variant that would use a native WinRM-over-HTTP client to check a different machine's registry. WinRM requires credential exposure (username/password or Kerberos), which conflicts with the §7 R8 / ADR-015 §3.7 principle that security-sensitive operations live in CLI scripts where execution context is explicit. **Remote verification is therefore deferred to Phase 1.5 (a separate small ADR if user feedback requests it) or to a CLI-only `scripts/check-remoteapp-setup-on.mjs <host>` script.** The `check_setup` MCP action is local-only.

**Setup operation (writing the remote PC's registry) is CLI-only**, NOT exposed as an MCP tool action:

1. Per Codex Round 1 P2, machine-global "active RDP session" detection is not session-safe on multi-user hosts
2. Per ADR-015 §3.7 principle, security-sensitive registry mutations live in CLI scripts where execution context is explicit

The CLI script `scripts/setup-remoteapp.mjs` runs **on the remote machine** (the user opens an MCP / shell on the remote temporarily) with admin and writes:
- `HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services\fAllowUnlistedRemotePrograms = 1`
- `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Terminal Server\TSAppAllowList\Applications\<app>\Name = <friendly>`
- `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Terminal Server\TSAppAllowList\Applications\<app>\Path = <full-exe-path>`

When the user lacks admin on the remote, the CLI reports the missing privilege and prints a manual checklist.

### 3.2 Host-side code — intentional no-change, with empirical-matrix requirement

Phase 1 ships with no **intentional** code changes to `desktop_state` / `desktop_discover` / `screenshot` / `keyboard.type`. RAIL's design is that each remote app appears as an independent local `HWND` (`MS-RDPERP`), so existing Win32 enumeration should pick them up unchanged.

**However, "should" is not "verified."** Per Opus Round 1 P1-3, we cannot acceptance-gate Phase 1 on a "no code change" claim alone:

- `desktop_discover` may have implicit `processName` filtering that excludes RAIL windows
- `screenshot(windowTitle=...)` against a RAIL window goes through DXGI capture; RAIL composition differs from a regular local window and may return a black or zero-variance frame, then trigger the existing all-black safety side (`memory/feedback_blank_capture_safety_side.md`)
- `clickAt` coordinate translation for RAIL windows may need verification
- `keyboard.type(text, windowTitle = <RAIL>)` must reach the remote application reliably (Opus Round 2 P2-3 explicitly added this axis since §1.1 lists it as a Problem statement)

Phase 1 therefore **requires an empirical 6-axis verification matrix** (see §3.3) and a Phase 1.5 budget for small targeted fixes if the matrix reveals any axis where existing host-side code mishandles RAIL windows.

### 3.3 Acceptance — 6-axis empirical matrix in `docs/rdp-remoteapp-setup.md`

For each row, the docs page records **what works, what fails, and what workaround applies**, verified against at least Notepad (and ideally a Chromium-based browser) published as a RemoteApp:

| # | Axis | What is verified | Required outcome to ship |
|---|---|---|---|
| 1 | `desktop_state` | Returns the RAIL window's hwnd / title / processName / focusedElement | Must return a non-null window record. focusedElement may be sparse (acceptable) |
| 2 | `desktop_discover` | RAIL window appears in the windows list with non-zero region | Must appear. If implicit filtering excludes it, file Phase 1.5 fix |
| 3 | UIA inside RAIL window | `screenshot(detail='text')` returns clickable elements | Best-effort. Result is documented per-app; null is acceptable for v1 docs |
| 4 | DXGI capture of RAIL window | `screenshot(windowTitle=<RAIL>)` returns a non-black, non-empty image | Must succeed for Notepad. If all-black, Phase 1.5 fix to identify when RAIL composition requires a different capture path |
| 5 | `mouse_click` against RAIL coordinates | Clicking image coords on the captured RAIL window has the expected effect on the remote app | Must succeed for Notepad on the title-bar close button + a button inside the client area |
| 6 | `keyboard.type` against RAIL window | `keyboard.type(text, windowTitle=<RAIL>)` produces the typed text in the remote application | Must succeed for typing into Notepad's text area |

The matrix is committed to `docs/rdp-remoteapp-setup.md` as part of Phase 1's PR. Any axis where the outcome falls short of "Required outcome to ship" gets a Phase 1.5 fix in the same PR sequence or is documented as a known limitation with a workaround.

### 3.4 Risks

- RemoteApp same-session-singleton: the remote PC can publish at most one concurrent RemoteApp session per user
- UIA gap (axis 3) is expected. Documented per-app
- Registry write requires admin on the remote. Documented
- "Windows Home" cannot be the remote. Documented

---

## 4. Phase 2 — Visual segmentation for full-desktop RDP (M)

### 4.1 What ships — apply existing OmniParser pipeline to RDP capture

OmniParser V2 (icon_detect, YOLO11-based) **is already integrated** in `src/vision_backend/omniparser.rs` (constants `OMNIPARSER_INPUT_SIDE = 1280`, `OMNIPARSER_CONF_THRESHOLD`, `OMNIPARSER_IOU_THRESHOLD`; decode + NMS; gated behind the `vision-gpu` feature).

Phase 2 therefore does **not** integrate OmniParser — it **routes the RDP-client capture path through the existing OmniParser pipeline** and emits the detected interactable regions as **virtual entities** in a new `desktop_discover` mode triggered when the focused window is an RDP client:

- New code path: when `desktop_discover` sees `processName == "mstsc"` (or other configured RDP clients), capture the RDP client window, run the existing OmniParser pipeline, map detected boxes to screen coordinates, return them as entities with `clickAt` coordinates already mapped
- Classical-CV fast lane: a sub-module of `engine-vision` (new code, ~600 lines: Hough line detection for window borders + title-bar band detection + Windows.Media.Ocr on detected title bars) for layouts that OmniParser overkills

### 4.2 What does NOT ship in Phase 2

- No remote install
- No focus state (visual capture cannot tell which remote window has keyboard focus)
- No minimized-window enumeration
- No new OmniParser model — Phase 2 uses the existing model, distribution path, and ONNX runtime

### 4.3 Acceptance gate before starting Phase 2

- Phase 1 has shipped for at least one release cycle
- At least one user has reported a real-world need that Phase 1 does not cover (e.g., "company VDI, cannot register registry settings on the remote")

### 4.4 Risks

- Latency: ~200-500 ms per inference on CPU, ~50-100 ms on GPU. Acceptable for `desktop_discover`, too slow for tight `desktop_act` loops
- False positives on dark / blurry / partially-occluded windows — surface a confidence score in `hints.virtualEntityConfidence`
- Coordinate mapping accuracy: OmniParser's bounding boxes are at model-input resolution (1280 max side); the existing dotByDot capture path already handles this

### 4.5 Sub-plan

This phase will get its own `docs/adr-016-phase-2-plan.md` once Phase 1 lands and the acceptance gate is met.

---

## 5. Phase 3 — DVC plugin + thin agent (L, own ADR)

### 5.1 What ships (overview only — Phase 3 needs its own ADR)

- A custom RDP Dynamic Virtual Channel plugin implemented as a COM `IWTSPlugin` server, written in Rust + windows-rs, registered with `mstsc.exe`
- A small remote-side agent (`desktop-touch-rdp-agent.exe`) that runs in the remote session, listens on the DVC channel, accepts `desktop_state` / `desktop_discover` / `desktop_act` requests, and replies using the remote machine's perception stack
- An extension to the existing ADR-008 view catalog architecture so a remote agent's view stream merges into the local perception graph as an additional source

The reference architecture is Microsoft Power Automate Desktop's deployed solution:

- DVC plugin: `Microsoft.Flow.RPA.Desktop.UIAutomation.RDP.DVC.Plugin` (loaded by `mstsc`)
- Remote: `PAD.RDP.ControlAgent.exe` (resident) + `PAD.RDP.AutomationAgent.exe` (UIA worker)

These exact filenames are cited from the Power Automate Desktop documentation linked in §10.

### 5.2 Why this needs its own ADR

- COM plugin lifecycle, signing, and install flow each carry their own design decisions
- Agent install across organizations (msi authoring, code signing, AppLocker / WDAC compatibility) is a non-trivial distribution problem
- The view catalog + dataflow extension (§6) is the largest architectural change in the project's history
- The "3-4 weeks" estimate in the Round 1 draft did not account for the dataflow-key changes Codex Round 1 P1 uncovered; the revised estimate is **4-6 weeks for pure implementation, excluding Phase 3 ADR-drafting cost**

### 5.3 Acceptance gate before starting Phase 3

- Phase 1 + Phase 2 have shipped for at least two release cycles between them
- Aggregate user feedback contains at least three independent reports of scenarios only Phase 3 closes

### 5.4 Risks (preview, full treatment deferred to Phase 3 ADR)

- DVC plugin COM registration requires admin
- Some RDP clients (the UWP "Remote Desktop" app, Windows App, mRemoteNG) may not load DVC plugins — `mstsc.exe` is the only confirmed host
- Enterprise policy can block DVC plugin loading via `Virtual channel allow list policy`
- Code-signing the agent is non-optional for enterprise distribution

---

## 6. Architectural note — Phase 3 origin propagation (corrected per Opus Round 2 P1-C against the actual decode flow)

### 6.1 Current L1→L3 decode flow (line-cited)

The existing L1→L3 bridge for focus events lives at `src/l3_bridge/focus_pump.rs`. Per its doc-comment (`focus_pump.rs:22-32`) and implementation:

1. The worker thread receives a `SubscriptionEvent` from the L1 ring's broadcast channel (`focus_pump.rs:42`)
2. `SubscriptionEvent` carries two parts:
   - `env`: an `EventEnvelope` with metadata fields (`event_id`, `timestamp_source`, `wallclock_ms`, `sub_ordinal`)
   - `payload`: a `Vec<u8>` (binary-encoded payload, type identified by `kind`)
3. The worker filters by `kind == EventKind::UiaFocusChanged` (`focus_pump.rs:43`)
4. The worker `bincode-decode`s `payload` to `UiaFocusChangedPayload` (line-cite from doc comment 26)
5. Skips `payload.after = None` (doc-comment 27)
6. Constructs a `FocusEvent` using both:
   - decoded `payload` fields (after.hwnd, after.process_name, after.name, etc.)
   - `env` metadata fields (`source_event_id = env.event_id`, `timestamp_source`, `wallclock_ms`, `sub_ordinal`) — see doc-comment 28-32
7. Calls `sink.push_focus(ev)` (line 32 of doc-comment)

Today, the dataflow operator graph keys local state purely by native identifiers from the **payload** side or by a singleton key:

- `current_focused_element` view (`crates/engine-perception/src/views/current_focused_element.rs`) keys on `hwnd` (a 64-bit native handle, locally unique on a single machine)
- `dirty_rects_aggregate` view keys on `(monitor_index, frame_index)` (locally unique on a single monitor)
- `latest_focus` view (`crates/engine-perception/src/views/latest_focus.rs`) reduces under the **singleton key `()`**, producing 0 or 1 globally-latest-focused row regardless of which `hwnd` carried the event. This view backs the production `view_get_focused()` API used by `desktop_state.ts`

The `env` metadata that today carries `event_id` / `timestamp_source` / etc. **does not yet carry an origin field**.

### 6.2 Why envelope-level alone is insufficient (Codex Round 1 P1)

If Phase 3 were to merge a remote agent's stream into the local graph with origin info only in `env`, the view materialization would corrupt:

- Two different machines can present a same-valued `hwnd` (handles are not globally unique). A remote `hwnd=0x1234` and a local `hwnd=0x1234` would alias into the same `current_focused_element` row, with later-arrival overwriting earlier
- The same applies to `(monitor_index, frame_index)` if Phase 3 ever surfaces dirty-rect events from the remote
- **`latest_focus` is the most severe case** — its singleton `()` key means any remote focus event would overwrite the locally-latest-focused row outright, breaking the documented `Origin::Local` default for `view_get_focused()` (Codex Round 2 P1)
- Operators performing per-key reductions would silently produce nonsense

### 6.3 Required propagation (3-layer change)

Phase 3 must propagate origin through three layers of the existing decode flow:

**Layer A — envelope (`EventEnvelope` / `SubscriptionEvent.env`):**

Add an `origin: Origin` field to the envelope. The L1 ring source — whoever produces the `SubscriptionEvent` — stamps this field. For local events, the existing producers stamp `Origin::Local`. For remote events arriving via the DVC channel, the DVC-side adapter stamps `Origin::Rdp { host, session_id }`.

```rust
enum Origin {
  Local,
  Rdp { host: String, session_id: String },
  // future protocols (Citrix HDX, NoMachine) extend this enum
}
```

**Layer B — dataflow event structs (`FocusEvent`, `DirtyRectEvent`, …):**

Add an `origin: Origin` field to every dataflow event struct that flows into the timely-dataflow operator graph. The bridge (`focus_pump.rs` and equivalent L1→L3 bridges for other event kinds) copies `env.origin` into the new `event.origin` field at the `FocusEvent` construction site (doc-comment step 5; the construction is alongside the existing `source_event_id = env.event_id` line).

**Layer C — view key space:**

Every view's key is extended to include `origin`. The exact mapping depends on the view's current key shape:

- `current_focused_element` (per-hwnd) becomes `HashMap<(Origin, Hwnd), FocusRow>`, not `HashMap<Hwnd, FocusRow>`
- `dirty_rects_aggregate` (per `(monitor_index, frame_index)`) becomes keyed on `(Origin, MonitorIndex, FrameIndex)`
- **`latest_focus` (singleton)** is promoted from `Option<FocusRow>` / single-key reduce to a per-origin reduce: `HashMap<Origin, FocusRow>` (or equivalently, the timely reduce switches from singleton key `()` to key `Origin`). The view materialization tracks one latest-focused row **per origin**, so the local origin's row is never overwritten by a remote focus event. The shared input collection from the bridge is still single (origin-tagged events flow into one reduce that partitions by `Origin` internally), preserving the "process the event stream once, fan into two reduces" property that the current implementation relies on for bounded memory growth (`latest_focus.rs:19-24`)

### 6.4 Backward compatibility — public surface

Query APIs (`view_get_focused` etc.) accept an `origin` filter and default to `Origin::Local` for backward compatibility:

```rust
fn view_get_focused(origin: Origin = Origin::Local) -> Option<FocusRow>
```

Concretely: `view_get_focused()` (no arg) returns the latest focus row from the **local** origin's per-origin partition of `latest_focus`. Existing `desktop_state.ts` code paths continue to receive only local focus events; a remote origin's latest-focus row is queryable only when the caller explicitly passes `origin: Origin::Rdp { … }`. The Codex Round 2 P1 concern (newest remote event overwriting the documented `Origin::Local` default) is structurally eliminated by the per-origin reduce partitioning in Layer C.

Existing callers see no behavioural change; the new origin filter is opt-in.

A natural follow-on benefit: the same `origin` enum cleanly extends to non-RDP remote protocols (Citrix HDX, NoMachine), keeping the architecture protocol-agnostic at the view layer.

### 6.5 Implementation cost callout

This 3-layer change is the reason Phase 3's pure-implementation estimate is 4-6 weeks, not the 3-4 weeks the Round 1 draft proposed. The Phase 3 ADR will own this design end-to-end with full Opus + Codex review per CLAUDE.md §3.3; the present ADR-016 only names the intent so that Phase 1 / Phase 2 implementation choices do not accidentally diverge.

---

## 7. Acceptance criteria (whole ADR)

- [ ] This ADR landed (Status: Draft → Accepted) when Phase 1 lands
- [ ] Phase 1 shipped under its own PR with the single `rdp` MCP tool, `scripts/setup-remoteapp.mjs` CLI, and `docs/rdp-remoteapp-setup.md` containing the 6-axis empirical matrix
- [ ] Phase 1's tool-surface addition is an explicit ADR-level exception to invariant 6, applied additively against whatever value invariant 6's derivative count holds at the time of Phase 1 implementation (e.g., if ADR-015 lands first and derivative counts read "29 tools," Phase 1 of this ADR lifts derivative counts to "30 tools"; the invariant 6 rule text in `docs/layer-constraints.md:330` is not modified, only a cross-reference note is added)
- [ ] Phase 2 sub-plan drafted only **after** Phase 1 acceptance gate passes
- [ ] Phase 3 dedicated ADR drafted only **after** Phase 1 + Phase 2 acceptance gates pass

Phase 2 and Phase 3 are tracked in subordinate documents.

---

## 8. Risks (cross-phase)

| # | Risk | Affected phase | Mitigation |
|---|---|---|---|
| R1 | The user actually wants Phase 3 from day one but pays for it via Phase 1 limitations they can't articulate up front | All | Phase 1 ships first and documents its limits clearly |
| R2 | Microsoft changes the registry hack behaviour on a future Windows update | Phase 1 | Pin the verified version range; the CLI degrades to a typed error |
| R3 | OmniParser license changes or model is retracted | Phase 2 | The phase uses the existing pipeline; classical-CV fast lane stays viable |
| R4 | DVC plugin signing requirement makes Phase 3 distribution infeasible for individual developers | Phase 3 | Defer to the Phase 3 ADR; potentially scope Phase 3 to "maintainer dogfood + paid customers" |
| R5 | Phase 1 docs ship but the user can't get the remote PC's admin rights | Phase 1 | The Phase 1 doc opens with this exact caveat |
| R6 | Phase 3 dataflow-key change (§6) breaks an existing operator | Phase 3 | The Phase 3 ADR will require integration tests exercising both single-origin and multi-origin keying. Default `Origin::Local` filter preserves caller-visible behaviour |

---

## 9. Open questions

- **OQ #1** — *(Resolved by Round 2.)* Minimal-safe defaults for `generate_rdp` confirmed (no clipboard, no audio, no drive redirect).
- **OQ #2** — *(Resolved by Round 3.)* `check_setup` self-detection. Resolved to **local-only**; remote verification deferred to Phase 1.5 or CLI script. The Round 2 `verify-remote-via-winrm` option is removed from the schema to avoid credential exposure through the MCP boundary (§3.1 Round 3 note).
- **OQ #3** — Phase 2 model storage path: under `%USERPROFILE%\.desktop-touch-mcp\models\` (project cache) or `%LOCALAPPDATA%\desktop-touch-mcp\models\` (Windows convention)? **Lean: existing OmniParser pipeline path** (Phase 2 reuses, not re-decides).
- **OQ #4** — Phase 2 classical-CV fast lane: separate Rust crate or submodule of `engine-vision`? **Lean: submodule**.
- **OQ #5** — Phase 3 origin: implicit `Origin::Local` default or every caller must specify? **Lean: implicit `Origin::Local`** for backward compatibility.
- **OQ #6** — Non-RDP remote protocols (Citrix HDX, VMware Horizon, Parsec, NoMachine)? **Lean: not in this ADR**, but §6 origin enum is protocol-agnostic so future variants extend cleanly.

---

## 10. References

All URLs verified accessible on 2026-05-12.

- User request 2026-05-12 (this session) — "RDP やっていて気になったのだけれど画面越しで操作するとき如何しても全画面取得になってしまう"
- [Microsoft RDP DVC plugin samples announcement (TechCommunity, 2025-08)](https://techcommunity.microsoft.com/blog/windows-itpro-blog/announcing-the-rdp-dynamic-virtual-channel-plugin-samples/4501337)
- [microsoft/rdp-dvc-plugin-samples (GitHub)](https://github.com/microsoft/rdp-dvc-plugin-samples)
- [MS Learn — Dynamic Virtual Channels (Win32)](https://learn.microsoft.com/en-us/windows/win32/termserv/dynamic-virtual-channels)
- [MS-RDPEDYC: Dynamic Channel Virtual Channel Extension](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpedyc/1edc9fd6-c7f9-4de9-82d6-5d13ee41d03a)
- [MS-RDPERP: Remote Programs (RAIL) protocol overview](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdperp/485e6f6d-2401-4a9c-9330-46454f0c5aba)
- [Power Automate — Automate on virtual desktops (MS Learn)](https://learn.microsoft.com/en-us/power-automate/desktop-flows/virtual-desktops) — the reference architecture this ADR's Phase 3 mirrors. The filenames `PAD.RDP.ControlAgent.exe`, `PAD.RDP.AutomationAgent.exe`, and the DVC plugin name `Microsoft.Flow.RPA.Desktop.UIAutomation.RDP.DVC.Plugin` cited in §5.1 are taken from this page
- [Configuring RemoteApps on Windows 10/11 without Server (woshub)](https://woshub.com/run-remoteapps-desktop-windows/) — Phase 1's registry hack reference
- [MS Q&A — UIA does not work in RemoteApp session](https://learn.microsoft.com/en-us/answers/questions/1296647/why-an-application-using-ms-ui-automation-does-not) — official confirmation of the UIA tunneling limitation
- [microsoft/OmniParser (GitHub)](https://github.com/microsoft/OmniParser) — Phase 2's primary model (already integrated)
- [OmniParser V2 — Microsoft Research article](https://www.microsoft.com/en-us/research/articles/omniparser-v2-turning-any-llm-into-a-computer-use-agent/)
- [UiPath Citrix Automation](https://www.uipath.com/platform/agentic-automation/ai-ecosystem/citrix-automation)
- ADR-008 (`docs/adr-008-reactive-perception-engine.md`) — perception graph this ADR's Phase 3 extends
- ADR-015 (`docs/adr-015-vba-extensibility-bridge.md`) — parallel work; same "single tool + action dispatcher + explicit invariant 6 exception" pattern
- `src/vision_backend/omniparser.rs` — current OmniParser integration (Phase 2 routes through this)
- `src/l3_bridge/focus_pump.rs:1-100` — current L1→L3 decode flow that §6 cites
- `src/l1_capture/` — current `EventEnvelope` / `SubscriptionEvent` types that §6 extends
- `crates/engine-perception/` — operator graph that §6 must teach to key on `(Origin, hwnd)`

---

## 11. Decision history

### 2026-05-12 — Draft (Proposed, Round 1)

Author: Claude (Sonnet) + Opus 2026-05-12 research.

Initial draft after user report about full-screen-only RDP capture. Three-phase progressive plan.

### 2026-05-12 — Draft (Proposed, Round 2)

Author: Claude (Sonnet) reflecting Opus + Codex Round 1.

- Phase 1 restructured into single `rdp` MCP tool following ADR-015's pattern
- Setup-write moved to CLI per Codex P2 (machine-global session detection is not session-safe)
- §3.3 5-axis empirical matrix added per Opus P1-3
- §4.1 rewritten to reflect that OmniParser V2 is already integrated per Opus P1-1
- §5.1 added exact PAD agent filenames + DVC plugin name from Power Automate docs verification
- §6 rewritten to require origin propagation into dataflow event structs and view key space (not only envelope) per Codex P1; Phase 3 estimate raised from 3-4 weeks to 4-6 weeks
- §10 References URL existence verified per Opus P2-7

### 2026-05-12 — Draft (Proposed, Round 4)

Author: Claude (Sonnet) reflecting Codex Round 2 P1 (the Codex review arrived after the Round 3 Opus review prompt was fired and so was processed in this Round 4).

- **Codex Round 2 P1 (`latest_focus` origin partitioning)** — Round 3 §6 named `current_focused_element` and `dirty_rects_aggregate` but missed the singleton `latest_focus` view that backs the production `view_get_focused()` API. The singleton key `()` means any remote focus event would overwrite the locally-latest row, breaking the documented `Origin::Local` default. §6.1 now enumerates `latest_focus` explicitly with `crates/engine-perception/src/views/latest_focus.rs` reference; §6.2 calls out this view as "the most severe case" of the aliasing problem; §6.3 Layer C promotes `latest_focus` from singleton-key reduce to per-origin reduce so the local origin's row is never overwritten; §6.4 explicitly states the backward-compatibility behavior for `view_get_focused()` (no arg) — returns the local-origin partition.

### 2026-05-12 — Draft (Proposed, Round 3)

Author: Claude (Sonnet) reflecting Opus Round 2.

- **P1-A** §7 acceptance row 3 reframed: Phase 1's tool-surface addition is an explicit ADR-level exception to invariant 6, applied additively against whatever value invariant 6's derivative count holds (not "lifts invariant 6 to 30" — invariant 6 rule text is preserved literal, derivative numeric refs are updated)
- **P1-C** §6 rewritten to match the actual L1→L3 decode flow in `src/l3_bridge/focus_pump.rs:1-100`. `SubscriptionEvent` carries `env` + `payload`; bridge bincode-decodes payload AND uses env metadata when constructing `FocusEvent`. Phase 3 origin propagation extends `env` (Layer A), event structs (Layer B), and view key space (Layer C). Citations to `focus_pump.rs:42-43` and doc-comment lines 22-32 added
- **P2-3** Added 6th axis to §3.3 empirical matrix: `keyboard.type(text, windowTitle=<RAIL>)` verification against Notepad (Opus Round 1 noted this gap; §1.1 already lists `keyboard.type` as a problem statement)
- **P2-5** Removed `scope: "verify-remote-via-winrm"` option from `check_setup` schema. WinRM auth introduces credential exposure through the MCP boundary, conflicting with the security-sensitive-operations-go-to-CLI principle (§3.7 / R8 of ADR-015). Remote verification deferred to Phase 1.5 or CLI script
- **P2-7** Decision history reformatted as bulleted sub-lists per round for legibility
- Added `overwrite: z.boolean().default(false)` to `generate_rdp` schema to prevent accidental file clobber (Codex Round 2 schema-safety axis)
