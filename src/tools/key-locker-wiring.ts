// ADR-014 v2 R3 Key Locker — L3-4 W-4b: the live-wiring composition root (THE impure root).
//
// Plan: desktop-touch-mcp-internal:docs/adr-014-v2-r3-l3-4-live-wiring-plan.md (§2.3, §4 W-4)
//
// Everything below the driver is pure + unit-tested; THIS file is the one impure seam that binds the merged
// pipeline into a running loop — it imports the real terminal hooks (S-A/B/C), Win32, the locker host, the
// BindingStore/NeverStore, and the injector, and drives the driver's timers. It is NOT unit-tested (it is the
// wiring); it is covered by the §5 live dogfood. Gated: it does nothing unless consent is accepted and the
// kill switch is off (both re-checked at RUNTIME, not just registration, so an un-consented user never spawns
// a locker for a `sudo`).
//
// The six gaps the plan enumerated (Fable review) are resolved in the seams here + the W-4a hot-path helpers:
//   gap1 anchor  — `manager.launchAnchoredConsole()` (a classic injectable conhost) → `onLocalPaneLaunched`.
//   gap2 read    — every title-keyed read/inject goes through `resolveTitleByHwnd(paneId)` (substring-unique or
//                  decline), so a same-title sibling can never redirect it.
//   gap3 close   — the tick timer polls the event-bus `window_disappeared` → `onPaneClosed`.
//   gap5 auth    — `readPaneAfterAuth` is a BOUNDED POLL (not a single read) so an in-progress prompt does not
//                  false-reject and discard the correct secret.
//   gap6 landed  — `runToExit` OBSERVES the already-run command's exit via an epilogue-only probe
//                  (`buildExitProbe`), NEVER re-running it.

import type { BindingMeta } from "../engine/key-locker/binding-store.js";
import { BindingStore } from "../engine/key-locker/binding-store.js";
import type { BindingUri } from "../engine/key-locker/binding.js";
import { formatBindingUri } from "../engine/key-locker/binding.js";
import { deriveBinding, type SessionContext } from "../engine/key-locker/command-derivation.js";
import { assembleInjectTarget, type PaneAnchor } from "../engine/key-locker/inject-target.js";
import {
  formatWtPaneId,
  parsePaneId,
  registerWtPaneTitle,
  unregisterWtPaneTitle,
  wtPaneTitleOf,
} from "../engine/key-locker/pane-id.js";
import { getProcessIdentityByPid } from "../engine/win32.js";
import { inject } from "../engine/key-locker/injector.js";
import {
  KeyLockerCaptureDriver,
  type CaptureDriverDeps,
  type PromptVerdict,
} from "../engine/key-locker/key-locker-capture-driver.js";
import { keyLockerDisabled, KeyLockerManager } from "../engine/key-locker/key-locker-manager.js";
import type { ExitCompletion } from "../engine/key-locker/landed-detection.js";
import { NeverStore } from "../engine/key-locker/never-store.js";
import { randomUUID } from "node:crypto";
import { poll as pollEvents, subscribe, unsubscribe } from "../engine/event-bus.js";
import {
  buildExitProbe,
  findTerminalWindowByHwnd,
  generateExitNonce,
  isSecretInputPrompt,
  lastNonEmptyPromptLine,
  parseExitSentinel,
  readTerminalRaw,
  resolvePaneTitle,
  setTerminalDispatchHook,
  terminalSendHandler,
  type ExitShell,
} from "./terminal.js";
import { keyLockerManager } from "./key-locker-tool.js";
import { KeyLockerError } from "../engine/key-locker-host.js";
import { setCredentialAdvisor, type AdvisoryHint } from "./_advisory.js";
import { isKnownSession } from "../engine/key-locker/session-tracker.js";

/** Max simultaneously-live anchored consoles the tool will open (Risk R2 — a `fresh:true` loop can't spray
 *  windows). Dead ones are pruned first, so this bounds LIVE panes, not lifetime launches. */
const MAX_ANCHORED_PANES = 3;

/** Programs that prompt for a credential (the cheap arm/advisory pre-filter — the loop's `deriveBinding` is
 *  the authoritative gate). A tiny LOCAL predicate, NOT the full tokenizer (OQ-W-16-bis P3-2). */
const CREDENTIAL_PROGRAMS = new Set(["sudo", "doas", "ssh", "su"]);
function looksCredentialShaped(input: unknown): boolean {
  if (typeof input !== "string") return false;
  const first = input.trim().split(/\s+/)[0] ?? "";
  const base = (first.replace(/\\/g, "/").split("/").pop() ?? first).toLowerCase().replace(/\.exe$/, "");
  return CREDENTIAL_PROGRAMS.has(base);
}

/** How often the wiring reconciles: event-bus close events → tickWatch → poll each armed pane. Fast enough to
 *  catch a session-end promptly, slow enough to be cheap (one Toolhelp snapshot per tick). */
const TICK_MS = 500;
/** Idle-dispose cadence — tear the locker host down after this long with no secret op (dormancy). */
const IDLE_DISPOSE_MS = 60_000;
const IDLE_CHECK_MS = 30_000;
/** Bounded auth-settle window for Mode-B `readPaneAfterAuth` (poll until the hidden prompt clears / timeout). */
const AUTH_SETTLE_MS = 8_000;
const AUTH_POLL_MS = 300;
/** Bounded exit-probe window for Mode-A `runToExit` (send the probe, poll for its sentinel / timeout). */
const EXIT_PROBE_MS = 10_000;
const EXIT_POLL_MS = 300;

/**
 * The live composition root. Constructed once at server startup (behind the kill switch); it builds the driver
 * from the shared manager's tracker/watch/snapshot + the real seams, installs the S-A dispatch hook, and runs
 * the reconcile + idle-dispose timers. `stop()` tears it ALL down (timers + event-bus + hooks).
 */
export class KeyLockerWiring {
  private readonly driver: KeyLockerCaptureDriver;
  private tickTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private eventSubId: string | null = null;
  /** Panes this wiring launched via `ensureAnchoredConsole` (most-recent last), for reuse + the R2 cap.
   *  Host-aware since S-pid E7: reuse only hands back a pane of the REQUESTED host. */
  private readonly launchedPanes: Array<{ paneId: string; host: "classic" | "windows-terminal" }> = [];
  /** windowTitles already nudged toward launch_console (Phase 3 dedup — one advisory per pane, no spam). */
  private readonly nudgedTitles = new Set<string>();

  constructor(private readonly manager: KeyLockerManager) {
    this.driver = new KeyLockerCaptureDriver(this.buildDeps());
  }

  // The binding + never stores are loaded FRESH per operation (from disk), NOT cached on the instance — the L4
  // `key_locker` tool writes a fresh `BindingStore`/never-store on every `save`/`set_policy`/`forget`, so a
  // cached copy would make a credential saved (or a policy changed) IN THE SAME SESSION invisible to autofill
  // until a process restart (Codex W-4b — the pre-seed flow would fall back to a no-match capture). `load` is
  // cheap (a JSON read) and matches the tool's own per-call load. The BindingStore verifies each candidate
  // still EXISTS in the locker (prune stale rows) via the host `exists` verb.
  private bindings(): BindingStore {
    return BindingStore.load(this.manager.storeDir, (id) => this.manager.withHost((h) => h.exists(id)));
  }
  private nevers(): NeverStore {
    return NeverStore.load(this.manager.storeDir);
  }

  /** Install the S-A dispatch hook + subscribe the event-bus + start the timers. Idempotent-ish (call once). */
  start(): void {
    setTerminalDispatchHook((ev) => {
      if (!this.enabled()) return; // runtime consent/kill re-check — never arm/record for an un-consented user
      this.driver.onDispatch(ev.paneId, ev.command);
    });
    // Phase 3 discoverability advisory (OQ-W-16-bis): nudge toward `launch_console` when a credential command
    // is sent to a pane the locker cannot autofill. Locker-agnostic hook (the wiring owns consent state) so
    // terminal.ts / _advisory.ts never import the locker (the rejected "terminal fold" coupling).
    setCredentialAdvisor((args) => this.credentialNudge(args));
    // NOTE: the event-bus subscription is NOT taken here — it is subscribed LAZILY in `tick()` only while
    // consent is active (Codex W-4b :100). On a default install where the locker was never enabled, subscribing
    // here would run the event-bus's 500ms EnumWindows sweep forever even though every tick returns early.
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.tickTimer.unref?.();
    // ALWAYS `.catch()` a floating drive: `server-windows.ts` turns an unhandledRejection into a full
    // `shutdown(1)` (all tools down). A locker-pipe hiccup during dispose must NOT crash the server — it
    // retries next check (Opus W-4b P1).
    this.idleTimer = setInterval(() => { void this.manager.disposeIfIdle(IDLE_DISPOSE_MS).catch(() => {}); }, IDLE_CHECK_MS);
    this.idleTimer.unref?.();
    // PRODUCTION ANCHORING: the assistant opens panes on demand via `key_locker launch_console`
    // (`ensureAnchoredConsole`). For the R3 dogfood (§5-3) the env flag ALSO pre-launches ONE pane at startup
    // so the DF-5 RESUME flow has a pane without a tool call — routed through the SAME `ensureAnchoredConsole`
    // (Phase 4) so the startup pane is TRACKED and REUSED by a later `launch_console` (no divergent spawn path,
    // no duplicate pane). The startup pop-up is dogfood-only; a normal install opens panes on demand.
    if (process.env.DESKTOP_TOUCH_KEY_LOCKER_DOGFOOD === "1") {
      void this.ensureAnchoredConsole().catch(() => { /* dogfood-only; a failed launch just means no pane */ });
    }
  }

  /** Tear EVERYTHING down (the "dispose stops the timers" obligation carried from W-3): clear both timers,
   *  unsubscribe the event-bus (its 500ms EnumWindows sweep), detach the dispatch hook, and dispose the locker
   *  host. Returns the host-dispose PROMISE so the shutdown path can AWAIT it before `process.exit()` — a
   *  fire-and-forget dispose could exit before `KeyLockerHost.dispose()` sends its shutdown frame + `killTree`,
   *  orphaning the detached `key-locker.exe` (Codex W-4b :127). Idempotent (dispose is a no-op with no host). */
  stop(): Promise<void> {
    if (this.tickTimer !== null) { clearInterval(this.tickTimer); this.tickTimer = null; }
    if (this.idleTimer !== null) { clearInterval(this.idleTimer); this.idleTimer = null; }
    if (this.eventSubId !== null) { unsubscribe(this.eventSubId); this.eventSubId = null; }
    setTerminalDispatchHook(null);
    setCredentialAdvisor(null);
    return this.manager.dispose().catch(() => {});
  }

  /**
   * Phase 3 credential advisory (OQ-W-16-bis): the `_advisory.ts` hook body. Returns a nudge toward
   * `launch_console` when a credential-shaped command was sent to a pane the locker cannot autofill. Proxy for
   * "non-anchored": the send used NO `paneId` (a `paneId` send targets a launch_console pane = already the
   * anchored flow). Gated on consent/kill-switch (never nudge an un-consented user). Deduped per windowTitle so
   * a repeated credential command does not spam. null = no nudge.
   */
  private credentialNudge(args: Record<string, unknown>): AdvisoryHint | null {
    if (!this.enabled()) return null;
    if (typeof args["paneId"] === "string") return null; // already using an anchored pane
    if (!looksCredentialShaped(args["input"])) return null;
    const windowTitle = typeof args["windowTitle"] === "string" ? (args["windowTitle"] as string) : "";
    if (this.nudgedTitles.has(windowTitle)) return null; // once per pane (bounded — no spam)
    this.nudgedTitles.add(windowTitle);
    return {
      preferredPath: "key_locker",
      reason:
        "a credential command (ssh / sudo / su) was sent to a terminal the locker cannot autofill — autofill " +
        "only works in a console opened by key_locker launch_console (a pre-existing terminal is never filled).",
      example: "key_locker({action:'launch_console'}) → terminal({action:'send', paneId:'<returned paneId>', input:'<your command>'})",
    };
  }

  /**
   * DOGFOOD/tool entry (§5-3): launch a pane the locker can anchor + fill, and anchor it KNOWN-LOCAL.
   * The only path that produces an autofillable pane (a pre-existing user pane is never anchored — P1-B).
   * S-pid E2 paneId forms: classic stays `String(hwnd)` decimal (zero back-compat break); a wt pane is
   * `wt:<shellPid>:<shellStartTimeMs>` (self-describing — no per-pane window exists). A wt pane's nonce
   * tab title is REGISTERED for the terminal-layer resolver (E6 read/send path).
   */
  async launchAndAnchorConsole(host: "classic" | "windows-terminal" = "classic"): Promise<{ paneId: string; title: string }> {
    const { anchor, title } = await this.manager.launchAnchoredConsole({ host });
    let paneId: string;
    if (anchor.kind === "classic") {
      if (anchor.hwnd === undefined) {
        throw new KeyLockerError("KeyLockerSpawnFailed", "launch returned a classic anchor with no hwnd");
      }
      paneId = String(anchor.hwnd);
    } else {
      paneId = formatWtPaneId(anchor.shellPid, anchor.shellStartTimeMs);
      registerWtPaneTitle(paneId, title);
    }
    this.driver.onLocalPaneLaunched(paneId, anchor);
    return { paneId, title };
  }

  /**
   * TOOL entry (ADR-014 R3 OQ-W-16-bis + S-pid E7, `key_locker launch_console`): return an autofill-capable
   * anchored pane the assistant can drive credential commands into. Host-aware since E7 — reuse only hands
   * back a pane of the REQUESTED host (a WT request never returns a classic window and vice versa).
   * Idempotent by default — reuses the most-recent REUSABLE same-host pane this wiring launched
   * (`isReusable`: classic = window alive via hwnd-direct `findTerminalWindowByHwnd`, NOT
   * `resolveTitleByHwnd` which would false-DEAD a same-host pane on its non-unique post-login title; wt =
   * ANCHOR-IDENTITY alive — shell pid + exact creation-time match; `resolveWtPane` is NOT required, an
   * INACTIVE tab is still a valid pane to hand back, its reads simply decline until the user activates it;
   * both AND still driver-anchored + session KNOWN, so it can actually arm — OQ-8). Pass `fresh` to force a
   * NEW pane (bounded by MAX_ANCHORED_PANES reusable panes of BOTH kinds so a `fresh` loop can't spray
   * windows). Returns the pane's CURRENT title (a reused pane's may already have drifted — drive it by paneId).
   */
  async ensureAnchoredConsole(
    { fresh = false, host = "windows-terminal" }: { fresh?: boolean; host?: "classic" | "windows-terminal" } = {},
  ): Promise<{ paneId: string; windowTitle: string }> {
    // Keep only REUSABLE panes — alive AND still driver-anchored AND session KNOWN (OQ-8). A pane whose
    // window/shell died, OR whose driver record was torn down by a spurious `window_disappeared` (the record is
    // gone but the window lives), OR whose session drifted to UNKNOWN, can NEVER arm — so we neither reuse nor
    // count it toward the cap. Dropping it here means the next launch RE-ANCHORS a working pane (a self-healing
    // reuse, NOT a blind re-anchor of the stale pane — re-anchoring a pane mid-remote-session as local would
    // disclose a LOCAL secret to a REMOTE prompt, the P1-B / W-2b hole). The orphaned window (if any) is left
    // for the human. A dropped wt pane's tab-title registration is released with it.
    const reusable = this.launchedPanes.filter((p) => {
      if (this.isReusable(p.paneId)) return true;
      if (p.host === "windows-terminal") unregisterWtPaneTitle(p.paneId);
      return false;
    });
    this.launchedPanes.length = 0;
    this.launchedPanes.push(...reusable);

    if (!fresh) {
      // Reuse the most-recent reusable pane OF THE REQUESTED HOST (E7).
      const match = [...this.launchedPanes].reverse().find((p) => p.host === host);
      if (match !== undefined) {
        return { paneId: match.paneId, windowTitle: this.paneTitleFor(match) ?? "" };
      }
    }
    if (this.launchedPanes.length >= MAX_ANCHORED_PANES) {
      throw new KeyLockerError(
        "KeyLockerConsoleLimit",
        `KeyLockerConsoleLimit: ${MAX_ANCHORED_PANES} anchored consoles are already open — close one before launching another`,
      );
    }
    const { paneId, title } = await this.launchAndAnchorConsole(host);
    this.launchedPanes.push({ paneId, host });
    return { paneId, windowTitle: title };
  }

  /** A launched pane is REUSABLE only if it is alive (classic: live console window, hwnd-direct; wt: the
   *  ANCHOR IDENTITY still holds — shell alive with the exact anchored creation time, S-pid E7) AND the
   *  driver still holds its anchor (`hasPane`) AND its tracked session is KNOWN — the conditions the arm
   *  gate needs. Any failure means a later dispatch would not arm, so reuse must skip it and launch fresh
   *  instead (OQ-8). */
  private isReusable(paneId: string): boolean {
    const parsed = parsePaneId(paneId);
    if (parsed === null) return false;
    if (parsed.kind === "classic") {
      if (this.livePaneTitle(paneId) === null) return false;
    } else {
      // wt: pid + EXACT creation-time equality (a reused pid reads a different non-zero time; a dead
      // shell reads 0 — both decline). The paneId itself carries the anchor identity (E2).
      if (getProcessIdentityByPid(parsed.shellPid).processStartTimeMs !== parsed.shellStartTimeMs) return false;
    }
    if (!this.driver.hasPane(paneId)) return false;
    return isKnownSession(this.manager.tracker.get(paneId));
  }

  /** The title to report for a REUSED pane: classic = the window's live title; wt = the registered nonce
   *  tab title (stable — `--suppressApplicationTitle` pins it; valid even while the tab is inactive). */
  private paneTitleFor(p: { paneId: string; host: "classic" | "windows-terminal" }): string | null {
    return p.host === "classic" ? this.livePaneTitle(p.paneId) : wtPaneTitleOf(p.paneId);
  }

  /** The current title of a launched pane if its hwnd is still a live console, else null (hwnd-direct). */
  private livePaneTitle(paneId: string): string | null {
    let h: bigint;
    try { h = BigInt(paneId); } catch { return null; }
    return findTerminalWindowByHwnd(h)?.title ?? null;
  }

  // ── the reconcile tick ────────────────────────────────────────────────────────────────────────────────
  private tick(): void {
    if (!this.enabled()) {
      // Un-consented / kill-switched: drop our event-bus subscription (if consent was revoked) so we stop
      // paying the 500ms EnumWindows sweep, and do nothing else (Codex W-4b :100).
      if (this.eventSubId !== null) { unsubscribe(this.eventSubId); this.eventSubId = null; }
      return;
    }
    // Consent is active — subscribe LAZILY on the first enabled tick (so a default install never paid for it).
    if (this.eventSubId === null) this.eventSubId = subscribe(["window_disappeared"]);
    // gap3: a closed pane → forget it (W2 close atomicity is inside onPaneClosed).
    for (const ev of pollEvents(this.eventSubId)) {
      if (ev.type === "window_disappeared") this.driver.onPaneClosed(ev.hwnd);
    }
    // Periodic reconcile (correlate stragglers + advance baselines + wt shell-exit prune + watch.tick +
    // arm-hygiene). Release the tab-title registration of any wt pane the prune dropped (idempotent; the
    // launchedPanes list itself is re-filtered on the next ensureAnchoredConsole).
    this.driver.tickWatch();
    for (const p of this.launchedPanes) {
      if (p.host === "windows-terminal" && !this.driver.hasPane(p.paneId)) unregisterWtPaneTitle(p.paneId);
    }
    // Poll every armed pane for a credential prompt (pollBusy serializes; the loop runs on a hit). ALWAYS
    // `.catch()` — a rejected poll (a locker-pipe hiccup mid-fill: the capture loop's pre-`try` seams
    // resolveBinding/confirmInjection/injectPane can reject through `withHost`) would otherwise become an
    // unhandledRejection → `server-windows.ts` `shutdown(1)` = ALL tools down (Opus W-4b P1). A swallowed poll
    // just re-polls next tick — bounded-safe, the fill-failure north-star. Never crash the server for a fill.
    for (const paneId of this.driver.armedPaneIds()) void this.driver.poll(paneId).catch(() => {});
  }

  private enabled(): boolean {
    return !this.manager.isDisabled() && this.manager.isConsentAccepted();
  }

  // ── the driver seams (the impure bindings) ────────────────────────────────────────────────────────────
  private buildDeps(): CaptureDriverDeps {
    const m = this.manager;
    return {
      tracker: m.tracker,
      watch: m.watch,
      snapshot: () => m.snapshotProcessTree(),

      deriveBinding: (command: string, session: SessionContext) => deriveBinding(command, session),
      // `prune:false` — the live hot path is READ-ONLY: a stale-row prune-save here would clobber a concurrent
      // user `key_locker` write (Codex W-4b). Fresh-loaded per op, so a stale row is just reported no-match.
      resolveBinding: (k) => this.bindings().resolve(k, { prune: false }),
      bindBinding: (k, id, meta) => this.bindings().bind(k, id, meta),
      confirmPolicyFor: (k) => this.bindings().getPolicy(k),
      isNever: (k) => this.nevers().has(k),
      onNever: (k) => this.nevers().add(k),

      capture: (id) => m.withHost((h) => h.capture(id)).then((r) => ({ captured: r.captured })),
      deleteSecret: (id) => m.withHost((h) => h.delete(id)).then(() => undefined),
      injectPane: (anchor, binding, opaqueId, submit) => this.injectPane(anchor, binding, opaqueId, submit),
      // gap4 confirm/offer: the W-3.5 secret-free `prompt` verb (label-only). `confirm` → fill vs decline.
      confirmInjection: (b) => m.withHost((h) => h.prompt("confirm", formatBindingUri(b))).then((c) => c === "autofill"),
      offerSave: (b) => m.withHost((h) => h.prompt("offer", formatBindingUri(b))),

      mintOpaqueId: () => randomUUID(),
      now: () => new Date().toISOString(),

      runToExit: (paneId, command, isRemote) => this.runToExit(paneId, isRemote),
      readPaneAfterAuth: (paneId) => this.readPaneAfterAuth(paneId),
      readPromptTail: (paneId) => this.readPromptTail(paneId),

      nowMs: () => Date.now(),
    };
  }

  /** injectPane: anchor-bound target (S-pid E4 — the driver passes the SPAWN-captured `PaneAnchor`, so
   *  identity is never re-derived from the paneId string) → L2 inject over the pipe. */
  private async injectPane(anchor: PaneAnchor, binding: BindingUri, opaqueId: string, submit: boolean) {
    const target = assembleInjectTarget(anchor, submit);
    if (target === null) return { ok: false, code: "target_gone" } as const;
    return this.manager.withHost((h) => inject(h, binding, opaqueId, "pane", target));
  }

  /** S-B readPromptTail: resolve the pane's title (substring-unique or null → decline) → read → classify.
   *  Stricter than a bare `isSecretInputPrompt` for the INJECT trigger: also require the cursor row to END IN A
   *  COLON. A real hidden-input prompt (`[sudo] password for alice:`, `Enter passphrase:`, `Password:`) ends in
   *  `:`; a COMMAND ECHO / OUTPUT that merely ends in a credential word (`sudo tail -f /tmp/password`, cached
   *  sudo, no prompt) does NOT — and `isSecretInputPrompt` alone would match it and inject the stored secret
   *  into the running process (Codex W-4b disclosure). A colon-less real prompt is rare ⇒ it declines and the
   *  human types it (never a wrong-inject). A proper echo-off detector is the robust follow-up (OQ-W-17-bis). */
  private async readPromptTail(paneId: string): Promise<PromptVerdict | null> {
    const title = resolvePaneTitle(paneId);
    if (title === null) return null; // ambiguous / vanished title ⇒ decline (never read a same-title sibling)
    const raw = await readTerminalRaw(title);
    if (raw === null) return null;
    const line = lastNonEmptyPromptLine(raw.text);
    const isCredentialPrompt = line !== null && /:\s*$/.test(line) && isSecretInputPrompt(raw.text);
    return { isCredentialPrompt, tail: raw.text, stillHiddenPrompt: isCredentialPrompt };
  }

  /** Mode-B readPaneAfterAuth (gap5): BOUNDED POLL until the hidden prompt clears or the window elapses — an
   *  immediate read would see the still-present prompt and false-reject, discarding the correct secret. Returns
   *  the settled `{ tail, stillHiddenPrompt }`; `isAuthAccepted` then checks a denial line + the cleared prompt. */
  private async readPaneAfterAuth(paneId: string): Promise<{ tail: string; stillHiddenPrompt: boolean }> {
    const deadline = Date.now() + AUTH_SETTLE_MS;
    let last = { tail: "", stillHiddenPrompt: true };
    for (;;) {
      // RE-RESOLVE the title EACH iteration (Codex W-4b): an interactive login (ssh) updates the console title
      // AFTER auth, so a title cached before the loop would stop resolving mid-poll → the correct secret would
      // false-reject as auth_rejected. Re-resolving keeps the read bound to the pane across the change (a wt
      // pane's nonce title is PINNED, so it re-resolves iff the tab is still active — E6).
      const title = resolvePaneTitle(paneId);
      if (title !== null) {
        const raw = await readTerminalRaw(title);
        if (raw !== null) {
          const stillHiddenPrompt = isSecretInputPrompt(raw.text);
          last = { tail: raw.text, stillHiddenPrompt };
          if (!stillHiddenPrompt) return last; // prompt cleared → settled (accepted iff no denial line)
        }
      }
      if (Date.now() >= deadline) return last; // still prompting at timeout → stillHiddenPrompt:true → reject
      await sleep(AUTH_POLL_MS);
    }
  }

  /** Mode-A runToExit (gap6): OBSERVE the already-run command's exit — send an EPILOGUE-ONLY probe (never the
   *  command) with `notifyDispatch:false`, poll for its echo-immune sentinel, return the exit code. */
  private async runToExit(paneId: string, isRemote: boolean): Promise<ExitCompletion> {
    const title = resolvePaneTitle(paneId);
    if (title === null) return { reason: "probe_error:no_title" };
    const shell: ExitShell = isRemote ? "bash" : "powershell";
    const nonce = generateExitNonce();
    const probe = buildExitProbe(shell, nonce);
    // Send the read-only probe. `notifyDispatch:false` suppresses the S-A re-fire; even if it fired, the driver
    // drops it (loopPhase pre-landed) and it is not credential-shaped. background method = do not steal focus.
    try {
      await terminalSendHandler({
        windowTitle: title, input: probe, method: "background", pressEnter: true,
        focusFirst: false, restoreFocus: false, preferClipboard: false, pasteKey: "auto",
        trackFocus: false, settleMs: 0, notifyDispatch: false,
      });
    } catch (e) {
      return { reason: `probe_error:${e instanceof Error ? e.message : String(e)}` };
    }
    const deadline = Date.now() + EXIT_PROBE_MS;
    for (;;) {
      // RE-RESOLVE the title each read (Codex W-4b): the ran command may have changed the console title; the
      // probe was already sent to the send-time window, but the READ must track the pane's current title.
      const rtitle = resolvePaneTitle(paneId);
      if (rtitle !== null) {
        const raw = await readTerminalRaw(rtitle);
        if (raw !== null) {
          const m = parseExitSentinel(raw.text, nonce, shell);
          if (m.matched) return { reason: "exited", exitCode: m.exitCode };
        }
      }
      if (Date.now() >= deadline) return { reason: "timeout" };
      await sleep(EXIT_POLL_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let wiringSingleton: KeyLockerWiring | null = null;

/**
 * Register the Key Locker live wiring at server startup (beside `registerKeyLockerTools`). No-op when the
 * feature is kill-switched. Returns a teardown fn (clears timers + hooks) for a clean shutdown. Shares the ONE
 * `keyLockerManager()` singleton with the L4 tool (so both use the same host + tracker/watch).
 */
export function registerKeyLockerWiring(): () => Promise<void> {
  if (keyLockerDisabled()) return () => Promise.resolve(); /* feature off */
  // IDEMPOTENT — start the timers/hook/subscription ONCE PER PROCESS. In HTTP transport `createMcpServer()`
  // runs for EVERY `/mcp` request (`server-windows.ts` request path), so a non-idempotent register would leak
  // a new 500ms reconcile timer + event-bus subscription + dispatch hook on every RPC (Codex W-4b). The wiring
  // is a process-global resource (one dispatch-hook slot, one tracker/watch), so reuse the singleton.
  if (wiringSingleton === null) {
    const wiring = new KeyLockerWiring(keyLockerManager());
    wiring.start();
    wiringSingleton = wiring;
  }
  // Every caller's teardown stops the ONE process-global wiring (called at process shutdown; safe to null and
  // re-init on a later register). Not a per-request teardown — HTTP request cleanup must NOT stop it. Returns
  // the stop() PROMISE (host dispose) so shutdown can AWAIT it before exit (Codex W-4b :127).
  return () => { const p = wiringSingleton?.stop() ?? Promise.resolve(); wiringSingleton = null; return p; };
}

/** The live wiring instance (for the dogfood `launchAndAnchorConsole` entry), or null if not registered. */
export function keyLockerWiring(): KeyLockerWiring | null {
  return wiringSingleton;
}

/** Consumed BindingMeta type re-export so a caller can build metadata without importing binding-store. */
export type { BindingMeta };
