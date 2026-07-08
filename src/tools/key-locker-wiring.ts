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
import { assembleInjectTarget } from "../engine/key-locker/inject-target.js";
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
  generateExitNonce,
  isSecretInputPrompt,
  parseExitSentinel,
  readTerminalRaw,
  resolveTitleByHwnd,
  setTerminalDispatchHook,
  terminalSendHandler,
  type ExitShell,
} from "./terminal.js";
import { keyLockerManager } from "./key-locker-tool.js";

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
  private readonly bindings: BindingStore;
  private readonly nevers: NeverStore;
  private tickTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private eventSubId: string | null = null;

  constructor(private readonly manager: KeyLockerManager) {
    // The BindingStore verifies each candidate secret still EXISTS in the locker (prune stale rows) via the
    // host `exists` verb, and the NeverStore holds tombstones — both keyed off the manager's store dir.
    this.bindings = BindingStore.load(manager.storeDir, (id) => manager.withHost((h) => h.exists(id)));
    this.nevers = NeverStore.load(manager.storeDir);
    this.driver = new KeyLockerCaptureDriver(this.buildDeps());
  }

  /** Install the S-A dispatch hook + subscribe the event-bus + start the timers. Idempotent-ish (call once). */
  start(): void {
    setTerminalDispatchHook((ev) => {
      if (!this.enabled()) return; // runtime consent/kill re-check — never arm/record for an un-consented user
      this.driver.onDispatch(ev.paneId, ev.command);
    });
    this.eventSubId = subscribe(["window_disappeared"]);
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.tickTimer.unref?.();
    this.idleTimer = setInterval(() => { void this.manager.disposeIfIdle(IDLE_DISPOSE_MS); }, IDLE_CHECK_MS);
    this.idleTimer.unref?.();
  }

  /** Tear EVERYTHING down (the "dispose stops the timers" obligation carried from W-3): clear both timers,
   *  unsubscribe the event-bus (its 500ms EnumWindows sweep), and detach the dispatch hook. Idempotent. */
  stop(): void {
    if (this.tickTimer !== null) { clearInterval(this.tickTimer); this.tickTimer = null; }
    if (this.idleTimer !== null) { clearInterval(this.idleTimer); this.idleTimer = null; }
    if (this.eventSubId !== null) { unsubscribe(this.eventSubId); this.eventSubId = null; }
    setTerminalDispatchHook(null);
  }

  /**
   * DOGFOOD/tool entry (§5-3): launch a classic conhost the locker can anchor + fill, and anchor it KNOWN-LOCAL.
   * The only path that produces an autofillable pane (a pre-existing user pane is never anchored — P1-B).
   * Returns the pane's hwnd string so the caller can drive `sudo`/`ssh` into it.
   */
  async launchAndAnchorConsole(): Promise<{ paneId: string; title: string }> {
    const { hwnd, shellPid, title } = await this.manager.launchAnchoredConsole();
    const paneId = String(hwnd);
    this.driver.onLocalPaneLaunched(paneId, shellPid);
    return { paneId, title };
  }

  // ── the reconcile tick ────────────────────────────────────────────────────────────────────────────────
  private tick(): void {
    if (!this.enabled()) return;
    // gap3: a closed pane → forget it (W2 close atomicity is inside onPaneClosed).
    if (this.eventSubId !== null) {
      for (const ev of pollEvents(this.eventSubId)) {
        if (ev.type === "window_disappeared") this.driver.onPaneClosed(ev.hwnd);
      }
    }
    // Periodic reconcile (correlate stragglers + advance baselines + watch.tick + arm-hygiene).
    this.driver.tickWatch();
    // Poll every armed pane for a credential prompt (pollBusy serializes; the loop runs on a hit).
    for (const paneId of this.driver.armedPaneIds()) void this.driver.poll(paneId);
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
      resolveBinding: (k) => this.bindings.resolve(k),
      bindBinding: (k, id, meta) => this.bindings.bind(k, id, meta),
      confirmPolicyFor: (k) => this.bindings.getPolicy(k),
      isNever: (k) => this.nevers.has(k),
      onNever: (k) => this.nevers.add(k),

      capture: (id) => m.withHost((h) => h.capture(id)).then((r) => ({ captured: r.captured })),
      deleteSecret: (id) => m.withHost((h) => h.delete(id)).then(() => undefined),
      injectPane: (paneId, binding, opaqueId, submit) => this.injectPane(paneId, binding, opaqueId, submit),
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

  /** injectPane: hwnd-bound target (gap2 — assembleInjectTarget takes the exact hwnd) → L2 inject over the pipe. */
  private async injectPane(paneId: string, binding: BindingUri, opaqueId: string, submit: boolean) {
    let hwnd: bigint;
    try { hwnd = BigInt(paneId); } catch { return { ok: false, code: "bad_target" } as const; }
    const target = assembleInjectTarget(hwnd, submit);
    if (target === null) return { ok: false, code: "target_gone" } as const;
    return this.manager.withHost((h) => inject(h, binding, opaqueId, "pane", target));
  }

  /** S-B readPromptTail: resolve the pane's title (substring-unique or null → decline) → read → classify. */
  private async readPromptTail(paneId: string): Promise<PromptVerdict | null> {
    const title = resolveTitleByHwnd(paneId);
    if (title === null) return null; // ambiguous / vanished title ⇒ decline (never read a same-title sibling)
    const raw = await readTerminalRaw(title);
    if (raw === null) return null;
    const isCredentialPrompt = isSecretInputPrompt(raw.text);
    return { isCredentialPrompt, tail: raw.text, stillHiddenPrompt: isCredentialPrompt };
  }

  /** Mode-B readPaneAfterAuth (gap5): BOUNDED POLL until the hidden prompt clears or the window elapses — an
   *  immediate read would see the still-present prompt and false-reject, discarding the correct secret. Returns
   *  the settled `{ tail, stillHiddenPrompt }`; `isAuthAccepted` then checks a denial line + the cleared prompt. */
  private async readPaneAfterAuth(paneId: string): Promise<{ tail: string; stillHiddenPrompt: boolean }> {
    const title = resolveTitleByHwnd(paneId);
    if (title === null) return { tail: "", stillHiddenPrompt: true }; // can't read ⇒ fail-safe reject
    const deadline = Date.now() + AUTH_SETTLE_MS;
    let last = { tail: "", stillHiddenPrompt: true };
    for (;;) {
      const raw = await readTerminalRaw(title);
      if (raw !== null) {
        const stillHiddenPrompt = isSecretInputPrompt(raw.text);
        last = { tail: raw.text, stillHiddenPrompt };
        if (!stillHiddenPrompt) return last; // prompt cleared → settled (accepted iff no denial line)
      }
      if (Date.now() >= deadline) return last; // still prompting at timeout → stillHiddenPrompt:true → reject
      await sleep(AUTH_POLL_MS);
    }
  }

  /** Mode-A runToExit (gap6): OBSERVE the already-run command's exit — send an EPILOGUE-ONLY probe (never the
   *  command) with `notifyDispatch:false`, poll for its echo-immune sentinel, return the exit code. */
  private async runToExit(paneId: string, isRemote: boolean): Promise<ExitCompletion> {
    const title = resolveTitleByHwnd(paneId);
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
      const raw = await readTerminalRaw(title);
      if (raw !== null) {
        const m = parseExitSentinel(raw.text, nonce, shell);
        if (m.matched) return { reason: "exited", exitCode: m.exitCode };
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
export function registerKeyLockerWiring(): () => void {
  if (keyLockerDisabled()) return () => { /* feature off */ };
  wiringSingleton = new KeyLockerWiring(keyLockerManager());
  wiringSingleton.start();
  return () => { wiringSingleton?.stop(); wiringSingleton = null; };
}

/** The live wiring instance (for the dogfood `launchAndAnchorConsole` entry), or null if not registered. */
export function keyLockerWiring(): KeyLockerWiring | null {
  return wiringSingleton;
}

/** Consumed BindingMeta type re-export so a caller can build metadata without importing binding-store. */
export type { BindingMeta };
