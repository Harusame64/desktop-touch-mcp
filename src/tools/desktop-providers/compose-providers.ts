/**
 * compose-providers.ts — Selects and merges candidate providers based on target type.
 *
 * Routing policy:
 *   tabId present            → browser (primary) + visual (additive)
 *   hwnd/title is terminal   → terminal (primary) + uia (additive, for structured overlay)
 *   hwnd/title is window     → uia (primary) + visual (additive)
 *
 * "Additive" means: a provider's results are merged INTO the candidate list; they
 * do not replace other sources. The resolver deduplicates by digest/label+rect,
 * so overlap between sources naturally produces cross-source entities.
 *
 * Warnings from all providers are collected and deduplicated. Rejection of one
 * provider does not prevent others from contributing candidates.
 *
 * Warning codes emitted here:
 *   no_provider_matched               — target omitted and foreground window could not be resolved
 *   target_window_gone                — target.hwnd names no window any more (the OS said so); no
 *                                       lane runs
 *   window_excluded                   — the target is excluded from every tool surface (the key
 *                                       locker's own windows); no lane runs (internal #222)
 *   partial_results_only              — primary provider returned 0 entities; fallback attempted
 *   visual_not_attempted              — (H4) visual lane was unready (unavailable/warming) on a blind target
 *   visual_attempted_empty            — (H4) visual lane ran warm but produced no candidates on a blind target
 *   visual_backend_cannot_recognise   — the attached backend replays injected snapshots and looks
 *                                       at nothing (the default build), so an empty answer from it
 *                                       is not evidence about the window
 *   visual_attempted_empty_cdp_fallback — (H4) CDP failed and visual also empty (browser target)
 */

import { parseTargetHwnd, type TargetSpec } from "../../engine/world-graph/session-registry.js";
import { WEB_AREA_AUTOMATION_ID } from "../_advisory.js";
import type { ProviderResult } from "../../engine/world-graph/candidate-ingress.js";
import type { UiEntityCandidate } from "../../engine/vision-gpu/types.js";
import { fetchUiaCandidates }      from "./uia-provider.js";
import { fetchBrowserCandidates }  from "./browser-provider.js";
import { fetchTerminalCandidates } from "./terminal-provider.js";
import { fetchVisualCandidates }   from "./visual-provider.js";
import { fetchOcrCandidates }      from "./ocr-provider.js";
import { resolveWindowTarget }     from "../_resolve-window.js";
import { WindowExcludedError }     from "../../engine/tool-exclusion.js";
import { probeAim, probeLane, type ProbeLane } from "../../engine/aim-probe.js";
import { containsPoint, toAim, readWindowIdentityFields, type WindowIdentity, type WindowRect, type AimOrigin } from "../../engine/aim.js";
import { getWindowIdentity, getWindowClassName, getWindowTitleW, getWindowRectByHwnd, windowIsAlive } from "../../engine/win32.js";

// ── G4: transient visual warnings trigger a single 200ms retry ────────────────
// Covers the first-request race where VisualRuntime.attach() (fire-and-forget in
// desktop-register.ts) has not completed yet (unavailable) or the backend has
// attached but warmup is still in flight (warming). Retry once with a short
// delay; if the warning persists, return it and let the caller continue on the
// structured lane.
const VISUAL_TRANSIENT_WARNINGS = new Set([
  "visual_provider_unavailable",
  "visual_provider_warming",
]);
const VISUAL_RETRY_DELAY_MS = 200;

async function fetchVisualCandidatesWithRetry(
  target: TargetSpec | undefined
): Promise<ProviderResult> {
  const first = await fetchVisualCandidates(target);
  const isTransient = first.warnings.some((w) => VISUAL_TRANSIENT_WARNINGS.has(w));
  if (!isTransient) return first;

  await new Promise<void>((resolve) => setTimeout(resolve, VISUAL_RETRY_DELAY_MS));
  return fetchVisualCandidates(target, 2);
}

/**
 * ADR-036 item 14a — a lane that REJECTED never reached its own return, so its row was never
 * written. Every provider catches inside its body; this is the one road around those catches, and
 * it used to answer with a warning and no row — the same "nothing here" a lane nobody called prints.
 * The fallback warning is the one each call site always carried.
 */
function settledLane(lane: ProbeLane, s: PromiseSettledResult<ProviderResult>, fallbackWarning: string): ProviderResult {
  if (s.status === "fulfilled") return s.value;
  return probeLane(lane, "failed", { why: "rejected" }, { candidates: [], warnings: [fallbackWarning] });
}

/**
 * Heuristic terminal title patterns.
 *
 * Design notes:
 * - Use word boundaries (\b) for short tokens like "sh", "wsl", "cmd" to avoid
 *   matching "Photoshop", "Dashboard", "cmd inside longer title", etc.
 * - "cmd.exe" doesn't appear in window titles — use "Command Prompt" instead.
 * - "terminal" is a common substring — anchor with \b to reduce false positives.
 *
 * A future improvement: prefer processName checks (more reliable than title).
 */
const TERMINAL_TITLE_PATTERN =
  /powershell|\bcommand prompt\b|\bterminal\b|\bbash\b|\b(wsl|zsh|fish|ksh|sh)\b|git.?bash|conemu|mintty/i;

export function isTerminalTarget(target: TargetSpec | undefined): boolean {
  return TERMINAL_TITLE_PATTERN.test(target?.windowTitle ?? "");
}

export function isBrowserTarget(target: TargetSpec | undefined): boolean {
  return Boolean(target?.tabId);
}

function mergeResults(results: ProviderResult[]): ProviderResult {
  const candidates = results.flatMap((r) => r.candidates);
  // Deduplicate warnings while preserving order.
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const r of results) {
    for (const w of r.warnings) {
      if (!seen.has(w)) { seen.add(w); warnings.push(w); }
    }
  }
  return { candidates, warnings };
}

function addWarningIfPartial(result: ProviderResult, primaryCount: number): ProviderResult {
  if (primaryCount === 0 && result.candidates.length === 0) return result;
  if (primaryCount === 0 && result.candidates.length > 0) {
    // Primary returned nothing but additive providers contributed — flag as partial.
    if (!result.warnings.includes("partial_results_only")) {
      return { ...result, warnings: [...result.warnings, "partial_results_only"] };
    }
  }
  return result;
}

// ── H4: visual escalation ─────────────────────────────────────────────────────
// When structured lanes (UIA / CDP) cannot surface actionable entities due to
// renderer opacity, surface the visual lane's outcome for explainability.
// Call frequency is NOT increased — only the interpretation of existing results.
//
// Scope: applied to "uia" (native window) and "browser" primary routes only.
// Terminal route is excluded intentionally: terminal provider is the primary
// there, and uia is additive. Even if uia is blind, the terminal buffer is the
// authoritative source — visual escalation would add noise, not signal.

/**
 * UIA-blind warning codes (PWA/Electron/canvas/RDP — UIA tree unusable). The
 * single SSOT predicate for "is this target visual-only": both the OCR lane gate
 * (`uiaBlindForOcr` below) and the ADR-024 Seed-2 session flag
 * (`SessionState.lastDiscoverVisualOnly`, set in desktop.ts from the same
 * `rawResult.warnings`) test membership in this set, so they never diverge.
 */
export const UIA_BLIND_WARNINGS = new Set(["uia_blind_single_pane", "uia_blind_too_few_elements"]);
const VISUAL_UNREADY_WARNINGS = new Set(["visual_provider_unavailable", "visual_provider_warming"]);

function applyVisualEscalation(
  primaryResult: ProviderResult,
  visualResult: ProviderResult,
  primaryKind: "uia" | "browser",
): string[] {
  const extra: string[] = [];
  const uiaBlind      = primaryResult.warnings.some((w) => UIA_BLIND_WARNINGS.has(w));
  const cdpFailed     = primaryResult.warnings.includes("cdp_provider_failed");
  // "Cannot recognise" joins "unready" HERE and nowhere else. Rule-A' below would otherwise report
  // `visual_attempted_empty` — *the lane ran warm and produced no candidates* — about a backend that
  // never looked at the window, which is the claim this whole change exists to stop making. It is
  // deliberately not added to `VISUAL_UNREADY_WARNINGS`: that set is also read by `desktop.ts` and
  // by `lastDiscoverVisualOnly`, where "not ready yet, retry" is the meaning, and this state never
  // becomes ready by waiting.
  const visualBlind   = visualResult.warnings.includes("visual_backend_cannot_recognise");
  const visualUnready = visualResult.warnings.some((w) => VISUAL_UNREADY_WARNINGS.has(w)) || visualBlind;
  const visualEmpty   = visualResult.candidates.length === 0;

  // Rule-A: uia blind + visual backend unready → visual_not_attempted
  if (primaryKind === "uia" && uiaBlind && visualUnready) {
    extra.push("visual_not_attempted");
  }
  // Rule-A': uia blind + visual warm but empty → visual_attempted_empty
  if (primaryKind === "uia" && uiaBlind && !visualUnready && visualEmpty) {
    extra.push("visual_attempted_empty");
  }
  // Rule-C: browser CDP failed + visual also empty → visual_attempted_empty_cdp_fallback.
  //
  // `!visualBlind` for the same reason Rule-A' carries it: "ran and found no candidates" is a claim
  // about an attempt, and a backend that recognises nothing made none. Without it the response said
  // both — the backend cannot inspect the window, AND it inspected and found nothing — with advice
  // to retry (PR 側 codex). The blind notice rides on its own, and it is news here because the
  // visual lane was the fallback CDP had just handed off to.
  if (primaryKind === "browser" && cdpFailed && visualEmpty && !visualBlind) {
    extra.push("visual_attempted_empty_cdp_fallback");
  }
  return extra;
}


/**
 * internal #211 item 9(3) — a `target.hwnd` the OS says is not a window: a handle read the way the
 * act reads it (`parseTargetHwnd` — every spelling `BigInt` takes, `0x…` included, and nothing at or
 * below zero), and `windowIsAlive`'s definite no. Not for an opaque key (the visual lanes pass those
 * in the same field), and not for a question that could not be asked. A hidden window is alive and
 * is not this.
 */
function handleIsGone(hwnd: string): boolean {
  const h = parseTargetHwnd({ hwnd });
  return h !== undefined && windowIsAlive(h) === false;
}

/**
 * ADR-036 — a fact about the deployment is not a warning about THIS read.
 *
 * `visual_backend_cannot_recognise` is true of every call in a default build: the attached backend
 * replays injected snapshots and looks at nothing. Emitted as the provider sees it, it therefore
 * appears on **every `desktop_discover` response of every user** — measured on a real machine
 * (win2, 2026-09-10), where a window whose UIA tree answered completely, with nine entities, carried
 * the same warning and the same constraint as one whose buttons are painted.
 *
 * That is the difference between a capability and a warning. It is newsworthy only where the visual
 * lane was the one that could have answered — a target the primary lane came back blind on — and
 * there the composer's own rules already fire. Everywhere else it is noise attached to a healthy
 * result, and noise on every response is how a caller learns to stop reading warnings.
 *
 * The provider still reports it, because the composer needs to see it to make this decision; what
 * changes is that the caller is not told about a lane whose silence cost them nothing.
 */
/**
 * internal #211 — for a window holding a web page, the page first: UIA controls on the page, then
 * OCR text on the page when OCR ran (a window that also read as blind), then everything else (the
 * browser's own tabs, address bar and toolbar), each group in read order. discover keeps the first
 * `maxEntities` in this order; in read order the browser's chrome filled them (gate 2; win2 measured
 * page-first on #746: Wikipedia 49 of 50 page entries, NHK chrome from 31st, against 2nd on main).
 *
 * "On the page" is the element's centre inside the page's rectangle, so a control half scrolled out
 * of view still counts. Text that repeats a control on the page — the same label, its centre inside
 * that control — is dropped, whether OCR read it or the visual lane replays it: the UIA entity is
 * the one pressed by pattern, and two copies spent the cap twice.
 */
export function pageFirst(
  candidates: ProviderResult["candidates"],
  page: { x: number; y: number; width: number; height: number },
): ProviderResult["candidates"] {
  type C = ProviderResult["candidates"][number];
  const centreIn = (r: C["rect"], box: { x: number; y: number; width: number; height: number }): boolean =>
    r !== undefined && containsPoint(box, r.x + r.width / 2, r.y + r.height / 2);
  const norm = (s: string | undefined): string => (s ?? "").trim().toLowerCase();
  const isPageControl = (c: C): boolean =>
    c.source === "uia" && c.locator?.uia?.automationId !== WEB_AREA_AUTOMATION_ID && centreIn(c.rect, page);
  // Text only repeats a CONTROL on the page — not the page element (its name is the page's title)
  // nor the browser's own chrome (gate 2 on A2). The visual lane's replays of OCR are repeats too:
  // the OCR lane hands everything it read to the visual backend, so a dropped copy came back on the
  // next discover as `visual_gpu`.
  const controls = candidates.filter(isPageControl);
  const repeatsControl = (c: C): boolean =>
    (c.source === "ocr" || c.source === "visual_gpu") &&
    controls.some((u) => u.rect !== undefined && norm(u.label) === norm(c.label) && centreIn(c.rect, u.rect));
  const onPage: C[] = [];
  const readOnPage: C[] = [];
  const rest: C[] = [];
  for (const c of candidates) {
    if (repeatsControl(c)) continue;
    if (isPageControl(c)) onPage.push(c);
    else if (c.source === "ocr" && centreIn(c.rect, page)) readOnPage.push(c);
    else rest.push(c);
  }
  return [...onPage, ...readOnPage, ...rest];
}

function withoutUnneededBlindNotice(result: ProviderResult, visualWasNeeded: boolean): ProviderResult {
  if (visualWasNeeded) return result;
  if (!result.warnings.includes("visual_backend_cannot_recognise")) return result;
  return { ...result, warnings: result.warnings.filter((w) => w !== "visual_backend_cannot_recognise") };
}

function withPrependedWarnings(result: ProviderResult, warnings: string[]): ProviderResult {
  if (warnings.length === 0) return result;
  const seen = new Set<string>();
  const mergedWarnings: string[] = [];
  for (const warning of [...warnings, ...result.warnings]) {
    if (!seen.has(warning)) {
      seen.add(warning);
      mergedWarnings.push(warning);
    }
  }
  return { ...result, warnings: mergedWarnings };
}

async function normalizeTarget(
  target: TargetSpec | undefined
): Promise<{ target: TargetSpec | undefined; warnings: string[] }> {
  if (target?.tabId) {
    return { target, warnings: [] };
  }

  // PR 側 codex asked for the opposite of what is here — refuse a `hwnd` this cannot read, rather
  // than falling through to the title (or, with no title, to the FOREGROUND window) and returning
  // actionable entities for a window the caller did not name. The diagnosis is right: the session
  // keeps the unreadable string, `parseTargetHwnd` reads it as `undefined` again at act time, and
  // the act goes out unpinned, so a discover that NAMED a window can end in a press on whichever
  // window resolution picks.
  //
  // The refusal was written, and it broke six tests across three files (`benchmark-gates`,
  // `poc-backend`, `dirty-signal`, 2026-09-09): the visual / GPU lanes address targets like
  // `{ hwnd: "hwnd-game" }`, where the field is an OPAQUE KEY for a snapshot and never a Win32
  // handle. `TargetSpec.hwnd` is `string` and carries both meanings, so "cannot read it as a
  // handle" is not the same fact as "the caller mistyped a handle", and refusing on the first
  // takes the visual lane down.
  //
  // Left as it is deliberately, with the hole named instead of half-closed: the fix is to stop one
  // field meaning two things (ADR-036's "make the aim a value"), not to guess which meaning was
  // intended. Recorded in `desktop-touch-mcp-internal` ADR-036 under what is left.

  if (target?.hwnd && !target.windowTitle) {
    try {
      const resolved = await resolveWindowTarget({ hwnd: target.hwnd });
      if (!resolved) return { target, warnings: [] };
      return {
        target: {
          ...target,
          hwnd: target.hwnd,
          windowTitle: resolved.title,
        },
        warnings: resolved.warnings,
      };
    } catch (e) {
      // R3 tool-exclusion: a WindowExcludedError must not be swallowed as a normal resolution miss
      // — otherwise the original (excluded) hwnd flows on into the provider fan-out and the OCR
      // lane reads the key-locker dialog by handle (Codex R1 P1-A). It is said, and no lane runs
      // (internal #222: it used to be thrown, and arrived as the retryable `ingress_fetch_error`).
      // The exclusion check fails closed on a PID it cannot read, which is what a window that has
      // just closed reads as — so a handle the OS says is gone is `target_window_gone` (gate 2).
      // Other resolution errors keep the legacy tolerant passthrough.
      if (e instanceof WindowExcludedError) return { target, warnings: [handleIsGone(target.hwnd) ? "target_window_gone" : "window_excluded"] };
      // internal #211 item 9(3): a handle that names no window any more — a dialog that has
      // closed, the one a refusal named — read as nothing at all, and the caller who followed the
      // advice there got `entities: []` with no warning (win2, internal #212 arm 9c). Said only on
      // the OS's definite no, and only for a decimal handle: the visual lanes pass opaque keys in
      // the same field, and a question that could not be asked is not a closed window.
      if (handleIsGone(target.hwnd)) return { target, warnings: ["target_window_gone"] };
      return { target, warnings: [] };
    }
  }

  // H3: plain windowTitle without hwnd — try dialog resolution (case 4 in _resolve-window.ts).
  // resolveWindowTarget returns null when a top-level window matches (preserving existing behaviour).
  // Only dialog-fallback results (dialog_resolved_via_owner_chain) change the effective target.
  if (target?.windowTitle && !target.hwnd) {
    try {
      const resolved = await resolveWindowTarget({ windowTitle: target.windowTitle });
      if (resolved) {
        return {
          target: { ...target, hwnd: resolved.hwnd.toString(), windowTitle: resolved.title },
          warnings: resolved.warnings,
        };
      }
    } catch (e) {
      // R3: an excluded key-locker title is said, and no lane runs (parity with the hwnd branch
      // above); other resolution errors keep the tolerant fall-through.
      // `@active` names no window: the foreground is excluded, and the aim must not keep the word
      // as a title (gate 2, as the bare call below).
      if (e instanceof WindowExcludedError) return { target: target.windowTitle === "@active" ? undefined : target, warnings: ["window_excluded"] };
      /* fall through */
    }
    return { target, warnings: [] };
  }

  if (target?.windowTitle) {  // hwnd + windowTitle: pass through as before
    // …but a handle that names no window any more is said here too (gate 2 on internal #211 9(3)).
    if (target.hwnd && handleIsGone(target.hwnd)) return { target, warnings: ["target_window_gone"] };
    return { target, warnings: [] };
  }

  try {
    const resolved = await resolveWindowTarget({ windowTitle: "@active" });
    if (!resolved) return { target: undefined, warnings: ["no_provider_matched"] };
    return {
      target: {
        hwnd: resolved.hwnd.toString(),
        windowTitle: resolved.title,
      },
      warnings: resolved.warnings,
    };
  } catch (e) {
    // The foreground window is the key locker's own: say so, and name no window (gate 2 on #222 —
    // it arrived as `no_provider_matched`, whose advice is to retry).
    if (e instanceof WindowExcludedError) return { target: undefined, warnings: ["window_excluded"] };
    return { target: undefined, warnings: ["no_provider_matched"] };
  }
}

/**
 * The candidates alone, for the roads that keep nothing else (the facade's direct provider, which is
 * also the post-touch snapshot). An excluded target still fails loudly there, as it did before
 * internal #222: an empty list would read as every entity gone (gate 2).
 */
export async function composeCandidatesOnly(target: TargetSpec | undefined): Promise<UiEntityCandidate[]> {
  const result = await composeCandidates(target);
  if (result.warnings.includes("window_excluded")) {
    throw new WindowExcludedError("WindowExcluded: the target is excluded from every tool surface of this server");
  }
  return result.candidates;
}

/** Resolution answers after which no lane may run on the target. */
const NO_LANE_WARNINGS: ReadonlySet<string> = new Set(["target_window_gone", "window_excluded"]);

/**
 * Fetch candidates from all appropriate providers and return merged result + warnings.
 * Uses Promise.allSettled so one failing provider doesn't block others.
 */
export async function composeCandidates(
  target: TargetSpec | undefined
): Promise<ProviderResult> {
  const normalized = await normalizeTarget(target);
  // ADR-036 probe — the seam the session never used to see. What comes out of here is what every
  // provider reads; what the session stored was what went in. When a bare `desktop_discover()`
  // resolves the foreground window, `in` is empty and `out` names a handle — and that handle was
  // the one the write path did NOT get (measured, 2026-09-09).
  probeAim("compose.normalize", {
    in: target ?? null,
    out: normalized.target ?? null,
    warnings: normalized.warnings,
  });
  if (!normalized.target) {
    // Nothing resolved: no candidates, and — deliberately — no `target`. "We could not work out
    // which window" must not arrive as "the window is nothing" (ADR-036).
    return { candidates: [], warnings: normalized.warnings };
  }
  // The window the caller named has closed: nothing a lane reads there is about it, and a lane that
  // replays an earlier snapshot would hand back leases for the closed window (gate 2 on internal
  // #211 item 9(3)). The target stays — it is the window that was named — and its identity is
  // recorded as looked for and not found, so no later read baselines whoever inherits the handle.
  // The same for a window excluded from every tool surface (internal #222): no lane runs on it, and
  // its identity is not read.
  if (normalized.warnings.some((w) => NO_LANE_WARNINGS.has(w))) {
    return { candidates: [], warnings: normalized.warnings, target: normalized.target, identityRead: true };
  }

  // ADR-036 — the resolution and the warnings it produced are applied HERE, once, rather than at
  // each lane's return. A lane added later inherits both instead of having to remember them,
  // which is the disease this ADR is about: identity that is carried by hand gets dropped by hand.
  // ADR-036 — the identity is taken HERE, with the read, not later when the session files it. After
  // a slow or remembered read those are different moments, and a handle recycled in between would be baselined
  // against its new owner (gate 1, 2026-09-09). Taken before the lanes run rather than after, so
  // it describes the window they are about to be pointed at.
  const identity = readIdentityForTarget(normalized.target);
  // ADR-036 item 5 — and where that window was, so a press taken from these coordinates can be
  // moved with the window instead of staying where the screen used to be.
  //
  // Read TWICE, around the lanes, and kept only when the two agree. The lanes take seconds, and a
  // window that moves while they run leaves the candidates describing its new position and the
  // origin describing its old one: the correction would then treat a move that happened BEFORE the
  // coordinates were measured as one that happened after, and shift an already-correct point a
  // second time (gate 1, 2026-09-09). That is a wrong press this rung would have introduced, in a
  // case the code got right before it existed.
  //
  // What two samples establish is that the window was in the same place at both ENDS of the read —
  // not that it held still throughout. A window that moves away and returns to the same rectangle
  // reads as stable, and candidates captured at the intermediate position are then pressed without
  // correction: the blind press this rung is narrowing, surviving in a case it cannot see (gate 1,
  // fifth pass). Closing that needs each observation to carry the origin it was measured against,
  // which is lane work — recorded in ADR-036 item 5 rather than approximated with a third sample
  // that would prove no more than these two.
  //
  // A disagreement is not a value to repair — there is no single origin those coordinates were all
  // measured against — so the aim records none and no correction runs. Unlike the identity beside
  // it, which fails SAFE when it goes stale (the act-time comparison answers "changed" and the act
  // is refused), a stale origin fails dangerous, which is why only this one is read twice.
  const originBefore = readOriginRectForTarget(normalized.target);
  const result = await composeCandidatesInner(normalized.target);
  const originAfter = readOriginRectForTarget(normalized.target);
  const origin: AimOrigin | undefined =
    originBefore && originAfter
      ? (sameRect(originBefore, originAfter)
          ? { kind: "measured", rect: originBefore }
          // Positive evidence, not a gap: these coordinates were measured across more than one
          // window position and no single origin describes them. Recorded as a value so the act
          // path can refuse on it — an absent rectangle would read as "nobody looked", which costs
          // the correction and lets the blind press through (gate 1, third pass).
          : { kind: "moved_during_read" })
      // Neither read could answer, or the window went away mid-read: no evidence either way, and
      // no evidence may not become a refusal.
      : undefined;
  return {
    ...withPrependedWarnings(result, normalized.warnings),
    target: normalized.target,
    identity,
    origin,
    // Looked for, whether or not it was found. A later read cannot stand in for this one: it would
    // describe whoever owns the handle at that later moment.
    identityRead: true,
  };
}

/**
 * ADR-036 — who owns the target's window right now, or nothing when the question cannot be asked.
 *
 * Read through `win32` directly rather than through `identity-tracker.ts`: that module's entry
 * point RECORDS what it sees, and a read that updates a baseline compares the world against
 * itself. A zeroed identity (`pid: 0`) means "could not ask" — a missing native binding, a window
 * already gone — and becomes `undefined` here, because absence has to stay distinguishable from a
 * value.
 */
export function readIdentityForTarget(target: TargetSpec): WindowIdentity | undefined {
  const hwnd = toAim(target).hwnd;
  if (hwnd === undefined) return undefined;
  // Through the shared reader, not a fourth copy of the same fifteen lines. The title in
  // particular: this side used to file `target.windowTitle`, which is the caller's search string
  // and not the window's title at all.
  return readWindowIdentityFields(hwnd, {
    identity: getWindowIdentity,
    className: getWindowClassName,
    title: getWindowTitleW,
  });
}

/**
 * ADR-036 item 5 — the aimed window's rectangle at the moment these candidates are read.
 *
 * `null` from the native read is two facts at once — no such window, and this build cannot ask —
 * and both become nothing here. A missing origin means the homing correction does not run, which
 * is the behaviour that existed before it did; inventing one from a later read would move a press
 * by a delta nobody measured.
 */
function readOriginRectForTarget(target: TargetSpec): WindowRect | undefined {
  const hwnd = toAim(target).hwnd;
  if (hwnd === undefined) return undefined;
  try {
    return getWindowRectByHwnd(hwnd) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Two samples of the same window, taken around the lanes.
 *
 * Both sides are required to BE answers, and that is enforced by the caller rather than repeated
 * here: the only call site is inside `originBefore && originAfter`, so a guard for the undefined
 * case could never fire and CodeQL was right to call it useless. The rule it stood for — a read
 * that failed on either end leaves the question open, and an open question is not agreement — is
 * kept where it is actually decided.
 */
function sameRect(a: WindowRect, b: WindowRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** The provider fan-out, against a target that is already resolved. */
async function composeCandidatesInner(target: TargetSpec): Promise<ProviderResult> {

  if (isBrowserTarget(target)) {
    const [browser, visual] = await Promise.allSettled([
      fetchBrowserCandidates(target),
      fetchVisualCandidatesWithRetry(target),
    ]);
    const browserResult = settledLane("cdp", browser, "cdp_provider_failed");
    const visualResult  = settledLane("visual_gpu", visual, "visual_provider_unavailable");

    // The visual lane is the FALLBACK here, so its incapacity is news exactly when CDP failed —
    // the same test Rule-C uses below. A successful CDP discovery does not need to hear about it,
    // and the browser branch was left out of the first version of this filter (PR 側 codex).
    const merged     = withoutUnneededBlindNotice(
      mergeResults([browserResult, visualResult]),
      browserResult.warnings.includes("cdp_provider_failed"),
    );
    const escalation = applyVisualEscalation(browserResult, visualResult, "browser");
    const extra      = escalation.filter((w) => !merged.warnings.includes(w));
    const finalMerged = extra.length > 0
      ? { ...merged, warnings: [...merged.warnings, ...extra] }
      : merged;

    return addWarningIfPartial(finalMerged, browserResult.candidates.length);
  }

  if (isTerminalTarget(target)) {
    const [terminal, uia, visual] = await Promise.allSettled([
      fetchTerminalCandidates(target),
      fetchUiaCandidates(target),
      fetchVisualCandidatesWithRetry(target),
    ]);
    const termResult   = settledLane("terminal", terminal, "terminal_provider_failed");
    const uiaResult    = settledLane("uia", uia, "uia_provider_failed");
    const visualResult = settledLane("visual_gpu", visual, "visual_provider_unavailable");

    // Terminal reads its own buffer; the visual lane is additive and nobody falls back to it here,
    // so its incapacity is never news on this road. Left out of the first version of the filter for
    // the same reason the browser branch was: the fix was written where the case had been measured
    // and not where the warning is merged (PR 側 codex).
    return addWarningIfPartial(
      withoutUnneededBlindNotice(
        mergeResults([termResult, uiaResult, visualResult]),
        termResult.warnings.includes("terminal_provider_failed"),
      ),
      termResult.candidates.length
    );
  }

  // Native Windows window: UIA primary + visual additive.
  const [uia, visual] = await Promise.allSettled([
    fetchUiaCandidates(target),
    fetchVisualCandidatesWithRetry(target),
  ]);
  const uiaResult    = settledLane("uia", uia, "uia_provider_failed");
  const visualResult = settledLane("visual_gpu", visual, "visual_provider_unavailable");

  // OCR lane: additive, UIA-blind targets only.
  // Builds a label dictionary from UIA candidates for snap-correction inside runSomPipeline.
  const uiaBlindForOcr = uiaResult.warnings.some((w) => UIA_BLIND_WARNINGS.has(w));
  // internal #211 — the page a UIA read found (Chrome/Edge/Electron). It orders the reply; it does
  // NOT start OCR. OCR is the lane for a window UIA cannot see: on a page UIA reads, it cost
  // 340–435 ms per discover while almost none of it reached the first 50 entities (win2, #746). A
  // caller that finds the page's text missing switches tools itself (screenshot, detail 'ocr') —
  // the user's call, 2026-09-29.
  const webArea = uiaResult.webArea;
  const ocrResult: ProviderResult = uiaBlindForOcr
    ? await fetchOcrCandidates(
        target,
        uiaResult.candidates
          .filter((c) => c.label && c.rect)
          .map((c) => ({ label: c.label!, rect: c.rect })),
      ).catch((): ProviderResult => probeLane("ocr", "failed", { why: "rejected" }, { candidates: [], warnings: ["ocr_provider_failed"] }))
    // Not called, and said so: on this road "OCR did not look" is a decision about THIS window, and
    // without a row it prints like a lane nobody instrumented (item 14a).
    : probeLane("ocr", "skipped", { why: "uia_not_blind" }, { candidates: [], warnings: [] });

  const mergedAll  = withoutUnneededBlindNotice(mergeResults([uiaResult, visualResult, ocrResult]), uiaBlindForOcr);
  const merged     = webArea !== undefined ? { ...mergedAll, candidates: pageFirst(mergedAll.candidates, webArea) } : mergedAll;
  const escalation = applyVisualEscalation(uiaResult, visualResult, "uia");
  const extra      = escalation.filter((w) => !merged.warnings.includes(w));
  const finalMerged = extra.length > 0
    ? { ...merged, warnings: [...merged.warnings, ...extra] }
    : merged;

  return addWarningIfPartial(finalMerged, uiaResult.candidates.length);
}
