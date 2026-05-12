# ADR-016: RDP Virtual Window — Multi-machine perception via RemoteApp / visual segmentation / DVC plugin

- Status: **Draft (Proposed, multi-phase)** — Phase 1 ready to implement on user demand, Phase 2/3 require dedicated ADR phases on top of this overview
- Date: 2026-05-12
- Authors: Claude (Sonnet draft, research backed by Opus 2026-05-12 web survey)
- Related:
  - User report 2026-05-12 — when operating a remote PC via RDP / mstsc, the MCP only sees the local RDP-client window (`screenshot(windowTitle=...)` returns the full remote desktop image, `desktop_discover` cannot enumerate remote application windows individually). The user asked for a virtual-window split so the LLM receives per-window information instead of the full screen.
  - ADR-008 (`docs/adr-008-reactive-perception-engine.md`) — the reactive perception graph + view catalog architecture that this ADR's Phase 3 extends to multi-machine
  - ADR-015 (`docs/adr-015-vba-extensibility-bridge.md`) — parallel-track work; not blocking, but Phase 1 of this ADR shares no overlapping files with ADR-015
- Blocks: none today (full-screen RDP works through coordinate clicks + OCR, just poorly)
- Blocked by: this ADR (Phase 1) → its own follow-up sub-plans (Phase 2 / Phase 3)

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

The net effect is that an LLM driving the MCP through an RDP session falls back to the same coordinate-roulette experience that the project's hero text positions against. The RDP-bound user is the exact user the README claims to help.

### 1.2 Why the existing perception layer cannot fix this in place

The existing perception layer rests on three Win32 / UIA primitives:

| Primitive | What it does | Why RDP defeats it |
|---|---|---|
| `EnumWindows` | Lists local top-level `HWND`s | Remote app windows are not local `HWND`s — they are bitmap regions inside the RDP client's window |
| `IUIAutomation::ElementFromHandle` | Walks the UIA tree under a given `HWND` | The remote app's UIA tree lives in the remote session; cross-session UIA queries fail with `0x80040201 UIA_E_ELEMENTNOTAVAILABLE` for arbitrary remote elements (verified industry-wide; explicitly called out by Microsoft Q&A for RemoteApp sessions, see §10) |
| `GetWindowTextW` | Reads a window's title | Reads only the RDP client's title — usually the remote-machine hostname, not the remote app |

No straightforward improvement to any of these primitives unlocks remote windows. UIA is **not designed to tunnel across RDP** for ordinary Win32 / Chrome apps. The fix is structural — change the transport, not the primitive.

### 1.3 What the industry actually does

The 2026-05 research (web survey of Microsoft, UiPath, Anthropic, OpenAI documentation and OSS samples) found exactly three production patterns:

1. **Out-of-band agent + DVC plugin** — Microsoft Power Automate Desktop's `PAD.RDP.AutomationAgent.exe` + `PAD.RDP.ControlAgent.exe` inside the remote session, plus a custom RDP Dynamic Virtual Channel plugin (`Microsoft.Flow.RPA.Desktop.UIAutomation.RDP.DVC.Plugin`) loaded by `mstsc` on the local machine. Local MCP-equivalent ↔ DVC plugin ↔ DVC channel ↔ remote agent ↔ remote UIA. **This is the technique used by every production-grade RPA tool that supports RDP.** Microsoft published OSS DVC plugin samples on 2025-08 (`microsoft/rdp-dvc-plugin-samples`) which lower the start-cost meaningfully.
2. **RemoteApp publishing** — Instead of full-desktop RDP, the remote machine publishes individual applications as RemoteApp windows that appear on the local desktop as **independent local `HWND`s** (RAIL protocol, `MS-RDPERP`). Win32 enumeration works through these. UIA partially works but with documented gaps. Officially a Windows Server / RDS feature, **also works on Windows 10/11 Pro with a registry hack** (`fAllowUnlistedRemotePrograms = 1`) at the cost of single-session restriction.
3. **Visual grounding only** — Capture the full RDP screen, run an interactive-element detector (UiPath's AI Computer Vision, Anthropic Computer Use, Microsoft OmniParser V2 = YOLOv8 + Florence-2), get bounding boxes for clickable regions, treat each box as a virtual entity. No remote-side install. Limited to what is visually distinguishable; cannot read focus state, cannot enumerate minimized windows.

The research's conclusion: **none of these is the right answer for every user; the right answer is to ship all three as a progressive ladder** so each user's situation maps to the cheapest viable option.

---

## 2. Decision

**Adopt a three-phase progressive RDP support strategy.** Each phase is shippable in isolation. The phases are ordered by user-install cost, not by implementation cost — Phase 1 is cheapest for the user (no remote install) and shippable in ~1 day, Phase 3 is most powerful but requires both a local DLL register and a remote agent install.

| Phase | What it ships | Implementation cost | User install cost | Target user case |
|---|---|---|---|---|
| **Phase 1 — RemoteApp helper** | Docs + `.rdp` template generator tool | S (1 day) | Registry tweak on remote PC (admin), one-time | Case A: personal LAN (home PC ↔ home PC), single-user, both machines under user's control |
| **Phase 2 — Visual segmentation** | Local ML model (OmniParser V2 ONNX) integrated into `engine-vision` + new `desktop_discover` mode for RDP client windows | M (1-2 weeks) | None (host only) | Case B: enterprise VDI / Terminal Server (cannot install on remote) |
| **Phase 3 — DVC plugin + thin agent** | Custom RDP DVC plugin (Rust + COM `IWTSPlugin`) + remote-side agent (`desktop-touch-rdp-agent.exe`) + perception view catalog extension to multi-machine | L (3-4 weeks, own ADR) | DVC DLL register on local (admin) + agent msi on remote (admin) | Case C: cloud VPS, multi-app remote sessions, persistent remote desktops |

This ADR locks in:

- The ordering (Phase 1 → Phase 2 → Phase 3)
- The acceptance gates between phases (each phase must close at least one user case before the next phase starts; preventing the project from accidentally over-committing to Phase 3's L cost before learning whether Phase 1 / 2 already satisfies the user base)
- The structural extension point on the existing perception graph (§3.4) that Phase 3 will plug into

### 2.1 Why not skip Phase 1 and go straight to Phase 3?

The research note that Phase 3 reuses the existing ADR-008 view catalog architecture as a "multi-machine perception graph" is intriguing and a real moat extension. But:

- Phase 1 is 1 day of work and may close 80% of the user-reported pain (the user driving this ADR's request is in Case A)
- Phase 2 lifts coverage to 95% with no remote install — a meaningful unblock for any user who cannot touch the remote
- Phase 3's L cost is justified only after Phase 1 / 2 telemetry shows users hitting their ceiling

Skipping ahead would commit 3-4 weeks of focused work before learning whether the cheaper approaches suffice.

### 2.2 Why not the alternative axes (UIA tunnel, WinRM-only, SendMessage)?

| Alternative | Why rejected |
|---|---|
| Force UIA to tunnel through RDP | Microsoft Q&A explicitly documents this as not supported for non-UWP apps; the per-control `RemoteAutomationClientSession` API exists but requires the **remote application** to opt in, which third-party apps universally don't |
| WinRM / SSH read-only enumeration (without remote agent) | Can list processes but cannot enumerate `HWND` geometry, UIA tree, or focus state without a remote helper; ends up equivalent to Phase 3 cost without Phase 3's transport benefits |
| `SendMessage` from local to remote via RDP | Win32 messages do not cross RDP boundaries — `FindWindow` from the local machine cannot find a remote-side `HWND` |
| Self-built TCP transport instead of DVC | Loses the RDP-session piggyback (separate firewall hole required, NAT traversal becomes the user's problem) — strictly worse than DVC for the same agent code |

---

## 3. Phase 1 — RemoteApp helper (S, ready to implement on demand)

### 3.1 What ships

- A new docs page (`docs/rdp-remoteapp-setup.md`) explaining how to enable single-app RemoteApp publishing on Windows 10/11 Pro without RDS licensing
- A new MCP tool **`rdp.generate_remoteapp_rdp`** that produces a `.rdp` file for a given (remote-host, remote-app-path, friendly-name) triple, with the correct `remoteapplicationmode:i:1` + `RemoteApplicationProgram` lines
- An optional companion tool **`rdp.apply_remote_registry_setup`** that, when run **on the remote machine** (the user opens the MCP on the remote temporarily), writes the required registry entries
  - `HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services\fAllowUnlistedRemotePrograms = 1`
  - `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Terminal Server\TSAppAllowList\Applications\<app>\Name = <friendly>`
  - `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Terminal Server\TSAppAllowList\Applications\<app>\Path = <full-exe-path>`

### 3.2 What does NOT ship in Phase 1

- No host-side code change to `desktop_state` / `desktop_discover` / `screenshot` — once the user is connected via RemoteApp, remote app windows appear as ordinary local `HWND`s and existing MCP tools already work
- No UIA-tunneling work
- No DVC plugin

### 3.3 Acceptance

- [ ] User can install registry settings on the remote machine in one MCP call (when MCP runs there) or follow a 5-step manual checklist (when MCP doesn't run there)
- [ ] User can generate a `.rdp` file in one MCP call from the controlling machine
- [ ] Opening the `.rdp` produces a RemoteApp session in which `desktop_discover` returns the remote app as an independent entity (verified end-to-end with Notepad as the target)
- [ ] An "Open Question" section in `docs/rdp-remoteapp-setup.md` documents which UIA queries actually work through RemoteApp and which fail (per-control empirical results, since this is the most ambiguous part)

### 3.4 Risks

- RemoteApp same-session-singleton: the remote PC can publish at most one concurrent RemoteApp session per user. For multi-app scenarios on the same remote, the user must drop to Phase 2 or Phase 3. **Documented honestly in §3.1's docs page.**
- UIA gap: Microsoft Q&A documents that some controls inside RemoteApp windows still return null from `IUIAutomation::ElementFromPoint`. The acceptance gate at §3.3's last bullet exists exactly to surface this on the project's specific test set.
- Registry write requires admin on the remote. Documented.
- "Windows Home" cannot be the remote (no RDS / no terminal services). Documented.

---

## 4. Phase 2 — Visual segmentation for full-desktop RDP (M)

### 4.1 What ships

- Integration of [Microsoft OmniParser V2](https://github.com/microsoft/OmniParser) (YOLOv8 + Florence-2 caption) into the existing `engine-vision` crate via the project's existing `ort` (ONNX Runtime) dependency
- A new `desktop_discover` mode that, when the focused window is an RDP client, runs OmniParser on the captured frame and returns the detected interactable regions as **virtual entities** with `clickAt` coordinates already mapped to screen space
- Classical-CV pre-filter (Hough lines + title-band edge detection + Windows.Media.Ocr on detected title bars) as a fast path for layouts that OmniParser overkills

### 4.2 What does NOT ship in Phase 2

- No remote install (the whole point)
- No focus state (visual capture cannot tell you which remote window has keyboard focus; this is documented)
- No minimized-window enumeration (visually invisible windows are not detectable)

### 4.3 Acceptance gate before starting Phase 2

- Phase 1 has been shipped for at least one release cycle
- At least one user (the maintainer counts) has reported a real-world need that Phase 1 does not cover (e.g., "company VDI, cannot register registry settings on the remote, but I need to click around inside a remote Excel")

### 4.4 Risks

- OmniParser model size (~470 MB combined for YOLOv8 + Florence-2 at typical configs). Decision: ship as **opt-in download** triggered on first `desktop_discover` against an RDP client window, cached under `%USERPROFILE%\.desktop-touch-mcp\models\`. Not bundled in the npm launcher
- Latency: ~200-500 ms per inference on CPU, ~50-100 ms on GPU. Acceptable for `desktop_discover`, too slow for tight `desktop_act` loops. Documented; classical-CV path stays as the fast lane
- False positives on dark / blurry / partially-occluded windows — same class of issue as the existing all-white safety check (`memory/feedback_blank_capture_safety_side.md` pattern). Surface a confidence score in `hints.virtualEntityConfidence`

### 4.5 Sub-plan

This phase will get its own `docs/adr-016-phase-2-plan.md` once Phase 1 lands and the acceptance gate is met. The sub-plan will cover: classical-CV thresholds, model file distribution, OCR cost vs. coverage trade-off, `desktop_act` handoff (`mouse_click(x, y)` works directly because RDP forwards clicks; no further engineering needed there).

---

## 5. Phase 3 — DVC plugin + thin agent (L, own ADR)

### 5.1 What ships (overview only — Phase 3 needs its own ADR)

- A custom RDP Dynamic Virtual Channel plugin implemented as a COM `IWTSPlugin` server, written in Rust + windows-rs, registered with `mstsc.exe` so the channel is automatically opened whenever the user starts a new RDP session
- A small remote-side agent (`desktop-touch-rdp-agent.exe`) that runs in the remote session, listens on the DVC channel, accepts `desktop_state` / `desktop_discover` / `desktop_act` requests, and replies using the remote machine's existing `engine-uia-bridge` + `engine-win32` code paths
- An extension to the existing ADR-008 view catalog architecture so a remote agent's view stream merges into the local perception graph as an additional source, addressed by an `rdp-session://<host>/<session-id>` URI scheme
- Phase 3 lifts the abstraction: a remote app becomes a first-class entity in the same `desktop_discover` output the user already knows, with the only difference being a `hints.location = "rdp:<host>"` marker

### 5.2 Why this needs its own ADR

- COM plugin lifecycle, signing, and install flow each carry their own design decisions
- Agent install across organizations (msi authoring, code signing, AppLocker / WDAC compatibility) is a non-trivial distribution problem
- The view catalog extension is the largest architectural change in the project's history and deserves a dedicated review with full Opus + Codex sweeps per CLAUDE.md §3.3

### 5.3 Acceptance gate before starting Phase 3

- Phase 1 + Phase 2 have shipped for at least two release cycles between them
- Aggregate user feedback contains at least three independent reports of the kind of scenarios only Phase 3 closes: multi-app remote sessions, persistent VPSes, needing focus state / minimized enumeration, sub-100ms `desktop_act` latency to remote

### 5.4 Risks (preview, full treatment deferred to Phase 3 ADR)

- DVC plugin COM registration on the local machine requires admin
- Some RDP clients (the UWP "Remote Desktop" app from the Store, Windows App, mRemoteNG) may not load DVC plugins — `mstsc.exe` is the only confirmed host. Documented as compatibility matrix
- Enterprise policy can block DVC plugin loading via `Virtual channel allow list policy` — this is a "your IT department says no" risk we cannot mitigate from inside the MCP
- The Phase 3 agent on the remote machine is, by definition, **the same kind of installed thing** that competing tools (UiPath, PAD) ship. Code-signing it becomes non-optional for enterprise distribution

---

## 6. Architectural note — why Phase 3 extends the project's moat

The existing ADR-008 reactive perception graph is structured as a `timely-dataflow` operator network that consumes `EventEnvelope` streams from local sensor sources (`engine-uia-bridge`, `engine-win32`, `engine-vision`) and materializes view catalogs (`current_focused_element`, `latest_focus`, future expansion views). The graph is intentionally agnostic to the source of an event — a `FocusChanged` event from the local UIA bridge and a hypothetical `FocusChanged` event from a remote agent have the same shape.

Phase 3 makes that latent multi-machine property explicit: the remote agent emits the same `EventEnvelope` shape, the DVC channel transports it, and the local perception graph integrates it as just another input stream. No new operator is needed; the existing `current_focused_element` view becomes a multi-machine view almost for free. This is the moat the research called out — a competitor would have to redesign their perception layer to match, whereas this project gets it as a natural extension.

This ADR locks in that intent (per-machine streams merge into a single timely graph at the local node, identified by an `originLocation: { kind: "local" } | { kind: "rdp", host: string, sessionId: string }` field on every event). The detailed shape is a Phase 3 concern, but stating the intent now prevents Phase 1 / 2 from accidentally diverging in a way that would force a rewrite at Phase 3.

---

## 7. Acceptance criteria (whole ADR)

- [ ] This ADR landed (Status: Draft → user / Opus / Codex review)
- [ ] Phase 1 shipped under its own PR with the `rdp.generate_remoteapp_rdp` tool, `rdp.apply_remote_registry_setup` tool, and `docs/rdp-remoteapp-setup.md`
- [ ] Phase 2 sub-plan (`docs/adr-016-phase-2-plan.md`) drafted only **after** Phase 1 acceptance gate passes
- [ ] Phase 3 dedicated ADR drafted only **after** Phase 1 + Phase 2 acceptance gates pass

The ADR closes (Status: Draft → Accepted) when Phase 1 lands. Phase 2 and Phase 3 are tracked in subordinate documents.

---

## 8. Risks (cross-phase)

| # | Risk | Affected phase | Mitigation |
|---|---|---|---|
| R1 | The user actually wants Phase 3 from day one but pays for it via Phase 1 limitations they can't articulate up front | All | Phase 1 ships first (lowest cost) and documents its limits clearly so a user who is in Case C surfaces themselves quickly |
| R2 | Microsoft changes the registry hack behaviour on a future Windows update | Phase 1 | Pin the version range that has been verified; degrade `rdp.apply_remote_registry_setup` to a typed error explaining the user must move to RDS proper if the hack stops working |
| R3 | OmniParser license changes or model is retracted | Phase 2 | The phase ships with classical-CV as a fast lane that does 70% of OmniParser's job and a fallback to "render the full image with grid annotations" in the worst case |
| R4 | DVC plugin signing requirement makes Phase 3 distribution infeasible for individual developers | Phase 3 | Defer to the Phase 3 ADR; potentially scope Phase 3 to "the maintainer's own dogfood + paid enterprise customers" if signing turns out to gatekeep too aggressively |
| R5 | Phase 1 docs ship but the user can't get the remote PC's admin rights | Phase 1 | The Phase 1 doc opens with a "this won't work if you don't have admin on the remote — skip ahead to Phase 2 once it ships" note |

---

## 9. Open questions

- **OQ #1** — Should the Phase 1 `.rdp` generator default `audiomode`, `redirectclipboard`, etc.? **Lean: minimal-safe defaults** (no clipboard redirect, no audio, no drive redirect) with caller able to override via tool args. Surface security implications in the docs.
- **OQ #2** — Should `rdp.apply_remote_registry_setup` self-detect that it's running on the remote (e.g., by checking for an active RDP session) and refuse to run on the local? **Lean: yes, with an explicit `force` arg to override.** Reduces foot-guns.
- **OQ #3** — Phase 2 model storage path: under `%USERPROFILE%\.desktop-touch-mcp\models\` (project cache) or `%LOCALAPPDATA%\desktop-touch-mcp\models\` (Windows convention)? **Lean: the existing project cache root, for consistency with the launcher zip cache.**
- **OQ #4** — Phase 2 classical-CV fast lane: ship as a separate Rust crate (`engine-window-segmentation`) or as a submodule of `engine-vision`? **Lean: submodule** — the classical-CV code is small (< 600 lines of Rust including OCR plumbing) and shares vision-engine primitives.
- **OQ #5** — Phase 3 `originLocation` tag: store on every `EventEnvelope` (envelope-level), or only on the top-level view catalog entries? **Lean: envelope-level** so the timely graph can filter / route by location without inspecting payloads.
- **OQ #6** — Should this ADR consider non-RDP remote protocols (Citrix HDX, VMware Horizon, Parsec, NoMachine)? **Lean: no for the initial draft, but the Phase 3 architecture should not preclude a future Citrix-channel sibling.** Mention in §6 that the abstraction is per-protocol-channel, not RDP-specific.

---

## 10. References

- User request 2026-05-12 (this session) — "RDP やっていて気になったのだけれど画面越しで操作するとき如何しても全画面取得になってしまう。これをどうにか、仮想的なWindowに分けてLLMに情報を渡せるようにはならないか"
- [Microsoft RDP DVC plugin samples (TechCommunity 2025-08)](https://techcommunity.microsoft.com/blog/windows-itpro-blog/announcing-the-rdp-dynamic-virtual-channel-plugin-samples/4501337)
- [microsoft/rdp-dvc-plugin-samples (GitHub)](https://github.com/microsoft/rdp-dvc-plugin-samples)
- [MS Learn — Dynamic Virtual Channels (Win32)](https://learn.microsoft.com/en-us/windows/win32/termserv/dynamic-virtual-channels)
- [MS-RDPEDYC: Dynamic Channel Virtual Channel Extension protocol spec](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpedyc/1edc9fd6-c7f9-4de9-82d6-5d13ee41d03a)
- [MS-RDPERP: Remote Programs (RAIL) protocol overview](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdperp/485e6f6d-2401-4a9c-9330-46454f0c5aba)
- [Power Automate — Automate on virtual desktops (MS Learn)](https://learn.microsoft.com/en-us/power-automate/desktop-flows/virtual-desktops) — the reference architecture this ADR's Phase 3 mirrors
- [Configuring RemoteApps on Windows 10/11 without Server (woshub)](https://woshub.com/run-remoteapps-desktop-windows/) — Phase 1's registry hack reference
- [MS Q&A — UIA does not work in RemoteApp session](https://learn.microsoft.com/en-us/answers/questions/1296647/why-an-application-using-ms-ui-automation-does-not) — official confirmation of the UIA tunneling limitation
- [microsoft/OmniParser (GitHub)](https://github.com/microsoft/OmniParser) — Phase 2's primary model
- [OmniParser V2 — Microsoft Research article](https://www.microsoft.com/en-us/research/articles/omniparser-v2-turning-any-llm-into-a-computer-use-agent/)
- [UiPath Citrix Automation (product page)](https://www.uipath.com/platform/agentic-automation/ai-ecosystem/citrix-automation) — comparable industry implementation for Citrix, conceptually identical to DVC plugin pattern
- ADR-008 (`docs/adr-008-reactive-perception-engine.md`) — perception graph this ADR's Phase 3 extends to multi-machine
- ADR-015 (`docs/adr-015-vba-extensibility-bridge.md`) — parallel work, shares the project's "fix structural problems by switching transport, not by patching the broken transport" pattern

---

## 11. Decision history

| Date | Status | Author | Rationale |
|---|---|---|---|
| 2026-05-12 | Draft (Proposed) | Claude (Sonnet) + Opus 2026-05-12 research | Initial draft after user report about full-screen-only RDP capture. Three-phase progressive plan chosen because the underlying user cases (home LAN / enterprise VDI / cloud VPS) are different enough that no single phase serves all of them. Pending Opus + Codex review per CLAUDE.md §3.3 Step 1 + Step 2 (this is a planning doc, so Codex is recommended-but-not-strictly-required per §3.3 Step 0 table; the maintainer should still run it given the large architectural surface). |
