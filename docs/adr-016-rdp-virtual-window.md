# ADR-016: RDP Virtual Window — Multi-machine perception via RemoteApp / visual segmentation / DVC plugin

- Status: **Draft (Proposed, Round 2, multi-phase)** — Opus + Codex Round 1 findings reflected; Phase 1 ready to implement on user demand, Phase 2/3 require dedicated ADR phases on top of this overview
- Date: 2026-05-12 (Round 1 draft) / 2026-05-12 (Round 2 revision)
- Authors: Claude (Sonnet draft, research backed by Opus 2026-05-12 web survey; Opus + Codex review feedback integrated)
- Related:
  - User report 2026-05-12 — when operating a remote PC via RDP / mstsc, the MCP only sees the local RDP-client window. The user asked for a virtual-window split.
  - ADR-008 (`docs/adr-008-reactive-perception-engine.md`) — the reactive perception graph + view catalog architecture that this ADR's Phase 3 extends to multi-machine; **Phase 3 requires changes to dataflow event structs and view key space, not only envelope-level metadata** (see §6, Codex Round 1 P1)
  - ADR-015 (`docs/adr-015-vba-extensibility-bridge.md`) — parallel-track work; not blocking, but Phase 1 of this ADR follows the same "single tool + action dispatcher + invariant 6 +1 amendment" pattern (see §3.1)
  - `crates/engine-perception/` and `src/l3_bridge/focus_pump.rs` — the operator graph and L1→L3 bridge that today drop any origin metadata; Phase 3 must propagate origin through these (§6)
- Blocks: none today (full-screen RDP works through coordinate clicks + OCR, just poorly)
- Blocked by: this ADR's review and acceptance (Phase 1) → its own follow-up sub-plans (Phase 2 / Phase 3)

---

## 1. Context

### 1.1 The problem in concrete terms

When the user is inside an RDP session driven by `mstsc.exe`, the Windows host sees:

- **One** local window: the RDP client (`hwnd = X`, `title = "<remote machine> - Remote Desktop Connection"`, `processName = "mstsc"`)
- **Zero** local windows for any application running on the remote machine (Notepad, Excel, browsers, terminals on the remote do not appear in `EnumWindows`, do not respond to UIA queries from the local host)

Consequences for this MCP:

- `desktop_state` and `desktop_discover` return only the RDP client window. The remote app the user actually wants to operate is invisible at the entity level.
- `screenshot(windowTitle = "Remote Desktop")` captures the entire remote desktop as a single image. Token cost scales with full-screen pixel count instead of per-window relevance.
- `mouse_click(x, y, …)` does work — RDP forwards the click to the remote — but the click target has to be chosen visually from the full-screen capture. The semantic targeting that makes this MCP differentiated (`desktop_discover` then `desktop_act`) does not apply.
- `keyboard.type(text, windowTitle = …)` cannot be scoped to a remote application, because the remote application is not a local window.

The net effect is that an LLM driving the MCP through an RDP session falls back to the same coordinate-roulette experience that the project's hero text positions against.

### 1.2 Why the existing perception layer cannot fix this in place

The existing perception layer rests on three Win32 / UIA primitives:

| Primitive | What it does | Why RDP defeats it |
|---|---|---|
| `EnumWindows` | Lists local top-level `HWND`s | Remote app windows are not local `HWND`s — they are bitmap regions inside the RDP client's window |
| `IUIAutomation::ElementFromHandle` | Walks the UIA tree under a given `HWND` | The remote app's UIA tree lives in the remote session; cross-session UIA queries fail with `0x80040201 UIA_E_ELEMENTNOTAVAILABLE` for arbitrary remote elements (verified industry-wide; explicitly called out by Microsoft Q&A for RemoteApp sessions, see §10) |
| `GetWindowTextW` | Reads a window's title | Reads only the RDP client's title — usually the remote-machine hostname, not the remote app |

No straightforward improvement to any of these primitives unlocks remote windows. UIA is **not designed to tunnel across RDP** for ordinary Win32 / Chrome apps. The fix is structural — change the transport, not the primitive.

### 1.3 What the industry actually does

The 2026-05 research found exactly three production patterns:

1. **Out-of-band agent + DVC plugin** — Microsoft Power Automate Desktop's `PAD.RDP.ControlAgent.exe` + `PAD.RDP.AutomationAgent.exe` inside the remote session, plus a custom RDP Dynamic Virtual Channel plugin (`Microsoft.Flow.RPA.Desktop.UIAutomation.RDP.DVC.Plugin`) loaded by `mstsc` on the local machine. Local MCP-equivalent ↔ DVC plugin ↔ DVC channel ↔ remote agent ↔ remote UIA. **This is the technique used by every production-grade RPA tool that supports RDP.** Microsoft published OSS DVC plugin samples on 2025-08 (`microsoft/rdp-dvc-plugin-samples`).
2. **RemoteApp publishing** — Instead of full-desktop RDP, the remote machine publishes individual applications as RemoteApp windows that appear on the local desktop as **independent local `HWND`s** (RAIL protocol, `MS-RDPERP`). Win32 enumeration works through these. UIA partially works but with documented gaps. Officially a Windows Server / RDS feature, **also works on Windows 10/11 Pro with a registry hack** at the cost of single-session restriction.
3. **Visual grounding only** — Capture the full RDP screen, run an interactive-element detector. The project already integrates Microsoft OmniParser V2 in `src/vision_backend/omniparser.rs` (Stage 2 icon_detect, YOLO11-based, gated behind the `vision-gpu` feature). Routing the RDP-client capture through the existing OmniParser pipeline is therefore an **application** of existing code, not a new integration.

The research's conclusion: **none of these is the right answer for every user; the right answer is to ship all three as a progressive ladder** so each user's situation maps to the cheapest viable option.

---

## 2. Decision

**Adopt a three-phase progressive RDP support strategy.** Each phase is shippable in isolation. The phases are ordered by user-install cost, not by implementation cost — Phase 1 is cheapest for the user (no remote install) and shippable in ~1 day, Phase 3 is most powerful but requires both a local DLL register and a remote agent install.

| Phase | What it ships | Implementation cost | User install cost | Target user case |
|---|---|---|---|---|
| **Phase 1 — RemoteApp helper** | Docs + a single new `rdp` MCP tool with `generate_rdp` / `check_setup` actions; setup is a CLI script | S (1 day) | Registry tweak on remote PC (admin), one-time | Case A: personal LAN (home PC ↔ home PC) |
| **Phase 2 — Visual segmentation** | New `desktop_discover` mode for RDP client windows that routes capture through the **existing** OmniParser V2 pipeline + a classical-CV fast-lane sub-module of `engine-vision` | M (1-2 weeks) | None (host only) | Case B: enterprise VDI |
| **Phase 3 — DVC plugin + thin agent** | Custom RDP DVC plugin + remote-side agent + dataflow-key + event-struct origin propagation per Codex Round 1 P1 | L (4-6 weeks, own ADR; the +1-2 weeks vs Round 1's estimate covers the dataflow-key changes uncovered by Codex review) | DVC DLL register on local (admin) + agent msi on remote (admin) | Case C: cloud VPS, multi-app remote sessions, persistent remote desktops |

This ADR locks in:

- The ordering (Phase 1 → Phase 2 → Phase 3)
- The acceptance gates between phases (each phase must close at least one user case before the next phase starts)
- The structural extension point on the existing perception graph (§6) that Phase 3 will plug into — **including the dataflow-key and event-struct changes the Round 1 draft omitted**

### 2.1 Why not skip Phase 1 and go straight to Phase 3?

Phase 1 is 1 day of work and may close 80% of the user-reported pain. Phase 2 lifts coverage to 95% with no remote install. Phase 3's L cost is justified only after Phase 1 / 2 telemetry shows users hitting their ceiling.

### 2.2 Why not the alternative axes (UIA tunnel, WinRM-only, SendMessage)?

| Alternative | Why rejected |
|---|---|
| Force UIA to tunnel through RDP | Microsoft Q&A explicitly documents this as not supported for non-UWP apps |
| WinRM / SSH read-only enumeration (without remote agent) | Can list processes but cannot enumerate `HWND` geometry, UIA tree, or focus state without a remote helper; equivalent to Phase 3 cost without DVC's benefits |
| `SendMessage` from local to remote via RDP | Win32 messages do not cross RDP boundaries |
| Self-built TCP transport instead of DVC | Loses the RDP-session piggyback (separate firewall hole required, NAT traversal becomes the user's problem) — strictly worse than DVC for the same agent code |

---

## 3. Phase 1 — RemoteApp helper (S, ready to implement on demand)

### 3.1 What ships — a single new `rdp` MCP tool + a CLI setup script

Following ADR-015's pattern (single tool + action discriminator + invariant 6 +1 amendment), Phase 1 adds **one** new MCP tool `rdp` with an action-discriminated Zod schema:

```ts
// Zod schema (sketch)
const rdpInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("generate_rdp"),
    remoteHost: z.string(),
    remoteAppPath: z.string(),         // full path on the remote PC
    friendlyName: z.string(),
    audioMode: z.enum(["disabled", "leave-at-remote", "redirect"]).default("disabled"),
    redirectClipboard: z.boolean().default(false),
    redirectDrives: z.boolean().default(false),
    outputPath: z.string(),            // where to save the .rdp file
  }),
  z.object({
    action: z.literal("check_setup"),  // read-only: does this machine have AllowUnlistedRemotePrograms=1?
    scope: z.enum(["local", "verify-remote-via-winrm"]).default("local"),
    remoteHost: z.string().optional(), // required when scope === "verify-remote-via-winrm"
  }),
]);
```

**`action: "generate_rdp"`** — produces a `.rdp` file with `remoteapplicationmode:i:1` + `RemoteApplicationProgram` + `RemoteApplicationName` lines. Defaults are minimal-safe (no clipboard, no audio, no drive redirect) per Opus Round 1 OQ #1.

**`action: "check_setup"`** — read-only inspection. When `scope === "local"`, checks the machine the MCP is running on. When `scope === "verify-remote-via-winrm"`, uses a native WinRM-over-HTTP client to check the remote machine's registry without launching a PowerShell process (per the user's stated preference against PowerShell-mediated transports).

**The setup operation (writing the remote PC's registry) is CLI-only**, NOT exposed as an MCP tool action. Two reasons:

1. **Codex Round 1 P2** — machine-global "active RDP session" detection is not session-safe on multi-user hosts; binding the operation to the current process / session transport context is non-trivial. The CLI runs in an explicit user context where this concern doesn't arise.
2. **Mirrors ADR-015 §3.7** — security-sensitive registry mutations live in CLI scripts (`scripts/setup-remoteapp.mjs`), the MCP tool surface exposes only read-only `check_setup` plus a `suggest` field pointing at the CLI.

The CLI script `scripts/setup-remoteapp.mjs` writes (when run on the **remote** machine, with admin):
- `HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services\fAllowUnlistedRemotePrograms = 1`
- `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Terminal Server\TSAppAllowList\Applications\<app>\Name = <friendly>`
- `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Terminal Server\TSAppAllowList\Applications\<app>\Path = <full-exe-path>`

When the user does not have admin on the remote, the CLI script reports the missing privilege and prints a manual checklist for an admin to follow.

### 3.2 Host-side code — intentional no-change, with empirical-matrix requirement

Phase 1 ships with no **intentional** code changes to `desktop_state` / `desktop_discover` / `screenshot`. The RAIL protocol's design is that each remote app appears as an independent local `HWND` (see `MS-RDPERP`), so existing Win32 enumeration should pick them up unchanged.

**However, "should" is not "verified."** Per Opus Round 1 P1-3, we cannot acceptance-gate Phase 1 on a "no code change" claim alone, because:

- `desktop_discover` may have implicit filtering on `processName` (mstsc-related) that incorrectly excludes RAIL windows
- `screenshot(windowTitle=...)` against a RAIL window goes through DXGI capture; the RAIL window is composited differently from a regular local window and may return a black or zero-variance frame, which then triggers the existing all-black safety side (see `memory/feedback_blank_capture_safety_side.md`) and falls back unexpectedly
- `clickAt` coordinate translation for RAIL windows may need verification — the RAIL client and server collaborate on coordinate space; clicks on a local RAIL window must arrive at the right remote-side coordinate

Phase 1 therefore **requires an empirical 5-axis verification matrix** (see §3.3) and a Phase 1.5 budget for small targeted fixes if the matrix reveals any axis where existing host-side code mishandles RAIL windows. Phase 1.5 fixes do not block the Phase 1 RemoteApp helper from shipping; they ship as follow-up PRs against this ADR.

### 3.3 Acceptance — 5-axis empirical matrix in `docs/rdp-remoteapp-setup.md`

The verification matrix is the deliverable. For each row, the docs page records **what works, what fails, and what workaround (if any) applies**, verified end-to-end against at least one RAIL-published app (Notepad at minimum, ideally also a Chromium-based browser):

| # | Axis | What is verified | Required outcome to ship |
|---|---|---|---|
| 1 | `desktop_state` | Returns the RAIL window's hwnd / title / processName / focusedElement | Must return a non-null window record. focusedElement may be sparse (acceptable). |
| 2 | `desktop_discover` | RAIL window appears in the windows list with non-zero region | Must appear at least once. If implicit filtering excludes it, file Phase 1.5 fix |
| 3 | UIA inside RAIL window | `screenshot(detail='text')` returns clickable elements | Best-effort. Result is documented per-app; null is acceptable for the v1 docs page |
| 4 | DXGI capture of RAIL window | `screenshot(windowTitle=<RAIL>)` returns a non-black, non-empty image | Must succeed for Notepad. If all-black, file Phase 1.5 fix to identify when RAIL composition path requires a fallback |
| 5 | `mouse_click` against RAIL coordinates | Clicking image coordinates on the captured RAIL window has the expected effect on the remote app | Must succeed for Notepad on the title-bar close button + a button inside the app's client area |

The matrix is committed to `docs/rdp-remoteapp-setup.md` as part of Phase 1's PR. Any axis where the outcome falls short of "Required outcome to ship" either (a) gets a Phase 1.5 fix in the same PR sequence, or (b) is documented as a known limitation with a workaround.

### 3.4 Risks

- RemoteApp same-session-singleton: the remote PC can publish at most one concurrent RemoteApp session per user. Documented.
- UIA gap (axis 3 above) is expected. Documented per-app.
- Registry write requires admin on the remote. Documented.
- "Windows Home" cannot be the remote. Documented.

---

## 4. Phase 2 — Visual segmentation for full-desktop RDP (M)

### 4.1 What ships — apply existing OmniParser pipeline to RDP capture

OmniParser V2 (icon_detect, YOLO11-based) **is already integrated** in `src/vision_backend/omniparser.rs` (see `OMNIPARSER_INPUT_SIDE = 1280`, `OMNIPARSER_CONF_THRESHOLD`, `OMNIPARSER_IOU_THRESHOLD`, decode + NMS). It is gated behind the `vision-gpu` feature and feeds the existing icon-detection pipeline.

Phase 2 therefore does **not** integrate OmniParser — it **routes the RDP-client capture path through the existing OmniParser pipeline** and emits the detected interactable regions as **virtual entities** in a new `desktop_discover` mode triggered when the focused window is an RDP client:

- New code path: when `desktop_discover` sees `processName == "mstsc"` (or other configured RDP clients), capture the RDP client window, run the existing OmniParser pipeline, map detected boxes to screen coordinates, return them as entities with `clickAt` coordinates already mapped
- Classical-CV fast lane: a sub-module of `engine-vision` (new code, ~600 lines: Hough line detection for window borders + title-bar band detection + Windows.Media.Ocr on detected title bars) for layouts that OmniParser overkills. Falls back to OmniParser when classical CV's confidence is below threshold

### 4.2 What does NOT ship in Phase 2

- No remote install (the whole point)
- No focus state (visual capture cannot tell you which remote window has keyboard focus; this is documented)
- No minimized-window enumeration (visually invisible windows are not detectable)
- No new OmniParser model — Phase 2 uses the existing model, distribution path, and ONNX runtime

### 4.3 Acceptance gate before starting Phase 2

- Phase 1 has been shipped for at least one release cycle
- At least one user (the maintainer counts) has reported a real-world need that Phase 1 does not cover (e.g., "company VDI, cannot register registry settings on the remote, but I need to click around inside a remote Excel")

### 4.4 Risks

- Latency: ~200-500 ms per inference on CPU, ~50-100 ms on GPU. Acceptable for `desktop_discover`, too slow for tight `desktop_act` loops. Classical-CV path stays as the fast lane
- False positives on dark / blurry / partially-occluded windows — surface a confidence score in `hints.virtualEntityConfidence`
- Coordinate mapping accuracy: OmniParser's bounding boxes are at model-input resolution (1280 max side). Mapping back to screen coords introduces sub-pixel rounding; the existing dotByDot capture path already handles this for `mouse_click`, so the impact is minimal

### 4.5 Sub-plan

This phase will get its own `docs/adr-016-phase-2-plan.md` once Phase 1 lands and the acceptance gate is met. The sub-plan will cover: classical-CV thresholds, how the new `desktop_discover` mode routes through the existing OmniParser path without forking it, `desktop_act` handoff details.

---

## 5. Phase 3 — DVC plugin + thin agent (L, own ADR)

### 5.1 What ships (overview only — Phase 3 needs its own ADR)

- A custom RDP Dynamic Virtual Channel plugin implemented as a COM `IWTSPlugin` server, written in Rust + windows-rs, registered with `mstsc.exe` so the channel is automatically opened whenever the user starts a new RDP session
- A small remote-side agent (`desktop-touch-rdp-agent.exe`) that runs in the remote session, listens on the DVC channel, accepts `desktop_state` / `desktop_discover` / `desktop_act` requests, and replies using the remote machine's existing `engine-uia-bridge` + `engine-win32` code paths
- An extension to the existing ADR-008 view catalog architecture so a remote agent's view stream merges into the local perception graph as an additional source

The reference architecture is Microsoft Power Automate Desktop's deployed solution:

- Local: `PAD.RDP.ControlAgent.exe` + the user-facing flow designer
- DVC plugin: `Microsoft.Flow.RPA.Desktop.UIAutomation.RDP.DVC.Plugin` (loaded by `mstsc`)
- Remote: `PAD.RDP.ControlAgent.exe` (resident) + `PAD.RDP.AutomationAgent.exe` (UIA worker)

(Reference paths from `docs/power-automate-virtual-desktops.md` linked in §10. The Microsoft 2025-08 `microsoft/rdp-dvc-plugin-samples` repo provides COM plugin templates in seven languages including Rust.)

### 5.2 Why this needs its own ADR

- COM plugin lifecycle, signing, and install flow each carry their own design decisions
- Agent install across organizations (msi authoring, code signing, AppLocker / WDAC compatibility) is a non-trivial distribution problem
- The view catalog + dataflow extension (§6) is the largest architectural change in the project's history and deserves a dedicated review with full Opus + Codex sweeps per CLAUDE.md §3.3
- The "3-4 weeks" estimate in the Round 1 draft did not account for the dataflow-key changes Codex Round 1 P1 uncovered (see §6); the revised estimate is **4-6 weeks for pure implementation, excluding Phase 3 ADR-drafting cost**

### 5.3 Acceptance gate before starting Phase 3

- Phase 1 + Phase 2 have shipped for at least two release cycles between them
- Aggregate user feedback contains at least three independent reports of the kind of scenarios only Phase 3 closes: multi-app remote sessions, persistent VPSes, needing focus state / minimized enumeration, sub-100ms `desktop_act` latency to remote

### 5.4 Risks (preview, full treatment deferred to Phase 3 ADR)

- DVC plugin COM registration on the local machine requires admin
- Some RDP clients (the UWP "Remote Desktop" app from the Store, Windows App, mRemoteNG) may not load DVC plugins — `mstsc.exe` is the only confirmed host
- Enterprise policy can block DVC plugin loading via `Virtual channel allow list policy` — the Power Automate Desktop docs explicitly document Citrix VDA 2407+ policy syntax for this case (see §10), this is a known industry-wide gating
- The Phase 3 agent on the remote machine is, by definition, **the same kind of installed thing** that competing tools (UiPath, PAD) ship. Code-signing it becomes non-optional for enterprise distribution

---

## 6. Architectural note — Phase 3 origin propagation (revised per Codex Round 1 P1)

The existing ADR-008 reactive perception graph operates a `timely-dataflow` operator network over input streams. Today the graph keys local state purely by native identifiers:

- `current_focused_element` view keys on `hwnd` (a 64-bit native handle, locally unique on a single machine)
- `dirty_rects_aggregate` view keys on `(monitor_index, frame_index)` (locally unique on a single monitor)
- The L1→L3 bridge in `src/l3_bridge/focus_pump.rs` builds `FocusEvent` records that drop any origin metadata — there is currently no concept of an origin field on the dataflow event structs

If Phase 3 were to merge a remote agent's stream into the local graph **with origin information only at envelope level** (the Round 1 draft proposal), this would corrupt the view materialization:

- Two different machines can present a same-valued `hwnd` (handles are not globally unique). A remote machine's `hwnd=0x1234` and a local `hwnd=0x1234` would alias into the same `current_focused_element` view row, with later-arrival overwriting earlier
- The same applies to `(monitor_index, frame_index)` if Phase 3 ever surfaces dirty-rect events from the remote
- Operators that perform per-key reductions would silently produce nonsense

**Phase 3 therefore requires propagating origin into both the event structs and the view key space, not only the envelope.** Concretely:

1. **Event-struct change**: add an `origin: Origin` field to every dataflow event struct (`FocusEvent`, `DirtyRectEvent`, etc.), where:
   ```rust
   enum Origin {
     Local,
     Rdp { host: String, session_id: String },
     // future protocols (Citrix HDX, VMware Horizon, NoMachine) extend this enum
   }
   ```
2. **Key-space change**: every view that today keys on a native identifier must key on `(origin, native_id)`. For example, `current_focused_element` becomes a `HashMap<(Origin, Hwnd), FocusRow>`, not `HashMap<Hwnd, FocusRow>`.
3. **Bridge change**: `src/l3_bridge/focus_pump.rs` (and equivalent L1→L3 bridges for other event kinds) must preserve `origin` from the incoming event envelope all the way into the dataflow event struct. The Round 1 draft missed this — bridges currently allocate a fresh struct from envelope payload only, with no origin field to carry forward.
4. **Public surface**: query APIs (`view_get_focused` etc.) accept an `origin` filter and default to `Origin::Local` for backward compatibility. Existing callers see no behavioural change.

This is a **non-trivial change** to the perception graph that the Phase 3 ADR will own end-to-end. It is named here so that Phase 1 / Phase 2 implementation choices do not accidentally diverge in a way that would force a perception-graph rewrite later.

A natural follow-on benefit: the same origin field cleanly extends to non-RDP remote-protocols (Citrix HDX, NoMachine), keeping the architecture protocol-agnostic at the view layer.

---

## 7. Acceptance criteria (whole ADR)

- [ ] This ADR landed (Status: Draft → user / Opus / Codex review)
- [ ] Phase 1 shipped under its own PR with the single `rdp` MCP tool, `scripts/setup-remoteapp.mjs` CLI, and `docs/rdp-remoteapp-setup.md` containing the 5-axis empirical matrix
- [ ] Phase 1's invariant 6 amendment is a +1 against whatever invariant value is current at the time of Phase 1 implementation (e.g., if ADR-015 lands first and lifts invariant 6 to 29, Phase 1 of this ADR lifts it to 30; cascade sweep handled per the same pattern as ADR-015 §4.5)
- [ ] Phase 2 sub-plan (`docs/adr-016-phase-2-plan.md`) drafted only **after** Phase 1 acceptance gate passes
- [ ] Phase 3 dedicated ADR drafted only **after** Phase 1 + Phase 2 acceptance gates pass

The ADR closes (Status: Draft → Accepted) when Phase 1 lands. Phase 2 and Phase 3 are tracked in subordinate documents.

---

## 8. Risks (cross-phase)

| # | Risk | Affected phase | Mitigation |
|---|---|---|---|
| R1 | The user actually wants Phase 3 from day one but pays for it via Phase 1 limitations they can't articulate up front | All | Phase 1 ships first (lowest cost) and documents its limits clearly so a user who is in Case C surfaces themselves quickly |
| R2 | Microsoft changes the registry hack behaviour on a future Windows update | Phase 1 | Pin the version range that has been verified; the CLI script degrades to a typed error explaining the user must move to RDS proper if the hack stops working |
| R3 | OmniParser license changes or model is retracted | Phase 2 | The phase uses the existing pipeline; if it's removed elsewhere in the project, this ADR follows the same disposition. Classical-CV fast lane (Phase 2's new code) does 70% of OmniParser's job and stays viable |
| R4 | DVC plugin signing requirement makes Phase 3 distribution infeasible for individual developers | Phase 3 | Defer to the Phase 3 ADR; potentially scope Phase 3 to "the maintainer's own dogfood + paid enterprise customers" if signing turns out to gatekeep too aggressively |
| R5 | Phase 1 docs ship but the user can't get the remote PC's admin rights | Phase 1 | The Phase 1 doc opens with a "this won't work if you don't have admin on the remote — skip ahead to Phase 2 once it ships" note |
| R6 | Phase 3 dataflow-key change (§6) breaks an existing operator that assumes single-machine keys | Phase 3 | The Phase 3 ADR will require integration tests that exercise both single-origin and multi-origin keying against every view in the catalog before the change merges. The default `Origin::Local` filter preserves caller-visible behaviour |

---

## 9. Open questions

- **OQ #1** — Should the Phase 1 `generate_rdp` action default `audiomode`, `redirectclipboard`, etc.? **Resolved by Round 2**: minimal-safe defaults (no clipboard redirect, no audio, no drive redirect), explicit caller override available. (See §3.1.)
- **OQ #2** — Should `check_setup` self-detect "is this machine the remote"? **Round 2 revision**: machine-global "active RDP session" detection is not session-safe (Codex Round 1 P2). The Phase 1 design moves the actual write operation to the CLI (`scripts/setup-remoteapp.mjs`), where execution context is explicit; `check_setup` is read-only and runs on whichever machine the MCP is executing on. A `scope: "verify-remote-via-winrm"` option lets the local MCP check the remote machine's registry via a native WinRM-over-HTTP client (no PowerShell) for the operator's convenience.
- **OQ #3** — Phase 2 model storage path: under `%USERPROFILE%\.desktop-touch-mcp\models\` (project cache) or `%LOCALAPPDATA%\desktop-touch-mcp\models\` (Windows convention)? **Resolved**: the existing OmniParser pipeline already has a model-storage convention (see `src/vision_backend/`); Phase 2 reuses that path without re-deciding.
- **OQ #4** — Phase 2 classical-CV fast lane: ship as a separate Rust crate (`engine-window-segmentation`) or as a submodule of `engine-vision`? **Lean: submodule** — the classical-CV code is small (< 600 lines of Rust including OCR plumbing) and shares vision-engine primitives.
- **OQ #5** — Phase 3 origin: store on every event struct (per §6 revision) confirmed; the OQ now becomes "should `Origin::Local` be the implicit default for callers, or must every caller specify origin?" **Lean: implicit `Origin::Local` default** for backward compatibility, opt-in to broader filters.
- **OQ #6** — Should this ADR consider non-RDP remote protocols (Citrix HDX, VMware Horizon, Parsec, NoMachine)? **Lean: no for the initial draft, but the §6 origin enum is protocol-agnostic, so future variants extend cleanly without re-architecting.**

---

## 10. References

All URLs verified accessible on 2026-05-12.

- User request 2026-05-12 (this session) — "RDP やっていて気になったのだけれど画面越しで操作するとき如何しても全画面取得になってしまう"
- [Microsoft RDP DVC plugin samples (TechCommunity 2025-08)](https://techcommunity.microsoft.com/blog/windows-itpro-blog/announcing-the-rdp-dynamic-virtual-channel-plugin-samples/4501337)
- [microsoft/rdp-dvc-plugin-samples (GitHub)](https://github.com/microsoft/rdp-dvc-plugin-samples)
- [MS Learn — Dynamic Virtual Channels (Win32)](https://learn.microsoft.com/en-us/windows/win32/termserv/dynamic-virtual-channels)
- [MS-RDPEDYC: Dynamic Channel Virtual Channel Extension protocol spec](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpedyc/1edc9fd6-c7f9-4de9-82d6-5d13ee41d03a)
- [MS-RDPERP: Remote Programs (RAIL) protocol overview](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdperp/485e6f6d-2401-4a9c-9330-46454f0c5aba)
- [Power Automate — Automate on virtual desktops (MS Learn)](https://learn.microsoft.com/en-us/power-automate/desktop-flows/virtual-desktops) — the reference architecture this ADR's Phase 3 mirrors. The exact filenames `PAD.RDP.ControlAgent.exe`, `PAD.RDP.AutomationAgent.exe`, and the DVC plugin name `Microsoft.Flow.RPA.Desktop.UIAutomation.RDP.DVC.Plugin` cited in §5.1 are taken from this page
- [Configuring RemoteApps on Windows 10/11 without Server (woshub)](https://woshub.com/run-remoteapps-desktop-windows/) — Phase 1's registry hack reference
- [MS Q&A — UIA does not work in RemoteApp session](https://learn.microsoft.com/en-us/answers/questions/1296647/why-an-application-using-ms-ui-automation-does-not) — official confirmation of the UIA tunneling limitation
- [microsoft/OmniParser (GitHub)](https://github.com/microsoft/OmniParser) — Phase 2's primary model (already integrated in `src/vision_backend/omniparser.rs`)
- [OmniParser V2 — Microsoft Research article](https://www.microsoft.com/en-us/research/articles/omniparser-v2-turning-any-llm-into-a-computer-use-agent/)
- [UiPath Citrix Automation (product page)](https://www.uipath.com/platform/agentic-automation/ai-ecosystem/citrix-automation) — comparable industry implementation for Citrix
- ADR-008 (`docs/adr-008-reactive-perception-engine.md`) — perception graph this ADR's Phase 3 extends
- ADR-015 (`docs/adr-015-vba-extensibility-bridge.md`) — parallel work, shares the project's "single tool + action dispatcher + invariant 6 +1 amendment" pattern
- `src/vision_backend/omniparser.rs` — current OmniParser integration (Phase 2 routes through this)
- `src/l3_bridge/focus_pump.rs` — current L1→L3 bridge that Phase 3 §6 must teach to preserve origin
- `crates/engine-perception/` — operator graph that Phase 3 §6 must teach to key on `(origin, hwnd)`

---

## 11. Decision history

| Date | Status | Author | Rationale |
|---|---|---|---|
| 2026-05-12 | Draft (Proposed, Round 1) | Claude (Sonnet) + Opus 2026-05-12 research | Initial draft after user report about full-screen-only RDP capture. Three-phase progressive plan |
| 2026-05-12 | Draft (Proposed, Round 2) | Claude (Sonnet) reflecting Opus + Codex Round 1 | **Major revisions**: (a) Phase 1 restructured into single `rdp` MCP tool with `generate_rdp` / `check_setup` actions following ADR-015's single-tool pattern; setup write moved to CLI per Codex Round 1 P2 (machine-global session detection is not session-safe). (b) §3.2 / §3.3 rewritten with explicit 5-axis empirical matrix as the Phase 1 acceptance, per Opus Round 1 P1-3 ("no host code change" claim cannot stand alone). (c) §4.1 rewritten to reflect that OmniParser V2 is **already integrated** in `src/vision_backend/omniparser.rs` — Phase 2 routes through the existing pipeline, not a new integration, per Opus Round 1 P1-1. (d) §5.1 added exact PAD agent filenames + DVC plugin name per WebFetch verification of the Power Automate docs. (e) §6 rewritten to require origin propagation into dataflow event structs and view key space (not only envelope) per Codex Round 1 P1; this raises the Phase 3 implementation estimate from 3-4 weeks to 4-6 weeks. (f) §10 References URL existence verified per Opus P2-7 |
