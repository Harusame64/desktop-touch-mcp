/**
 * G1 (ADR-036 §10) — read a `stale` target's place again, just before the press.
 *
 * The user's decision of 2026-09-23, "Re-read, then refuse": an entity no lane looked at in the read
 * that returned it (`status: "stale"`) is read again where the press would land; its label still
 * there goes on to the press, its label not there is refused. Measured before this existed, win2,
 * 2026-09-23 on `main` `5163932c` (internal `ea46fd9`): a label painted over after the read came
 * back `stale`, was pressed at its remembered place, answered `ok:true`, and the press landed on
 * the label painted there since.
 *
 * **Only `absent` refuses, and it is only said after a read that ran.** Everything that stops the
 * read — no label to look for, no window, a window whose owner changed, a place the press itself
 * would not use — answers `cannot_say`, and the act goes on as it did before G1 (the user's rule of
 * 2026-09-11: refuse only on a clear ground). The `act.stale` row says which.
 *
 * **The place is the one the press would use**, found by the press's own homing function
 * (`homingCorrectionForSources`), not by a second copy of it. Where the press path refuses on the
 * homing's answer of its own accord (a resized window, a window that moved during the read, one
 * parked off the desktop, a capture from another window), this answers `cannot_say` so that the
 * press path's reason — and its advice — is the one the caller gets.
 *
 * **The read does not ask whether the window is blind to UI Automation.** The discover OCR lane
 * does (`uia_not_blind`), and win2's R arm is exactly that shape: a window with real buttons, and a
 * painted label the visual lane handed back `stale`. A re-read that inherited the lane's gate would
 * never read R, and every stale target in a sighted window would go on unread.
 */
import { probeAim } from "../engine/aim-probe.js";
import { compareAimIdentity, homingCorrectionForSources, observedHwndOfOrigin, readWindowIdentityFields, type Aim, type Homing, type WindowIdentity } from "../engine/aim.js";
import { detectOcrLanguage, runSomPipeline } from "../engine/ocr-bridge.js";
import { getWindowClassName, getWindowIdentity, getWindowRectByHwnd, getWindowTitleW } from "../engine/win32.js";
import type { StaleRereadAnswer } from "../engine/world-graph/guarded-touch.js";
import type { UiEntity } from "../engine/world-graph/types.js";
import type { Rect } from "../engine/vision-gpu/types.js";
import { clampRectToWindow, resolveFoldOcrRoi } from "./_roi-region.js";

/**
 * The homing answers the press goes on with, at the point this read will look at. Every other
 * answer is one the press path refuses on, or one where the press lands somewhere this read cannot
 * describe — so the read steps aside and lets the press path answer.
 */
const READABLE: ReadonlySet<string> = new Set(["applied", "not_moved", "no_origin_rect", "measurement_moment_unknown"]);

/**
 * Text as it is compared: compatibility-folded, case-folded, with every space removed. OCR splits
 * and joins words differently from one read to the next ("PAINTED-A" / "PAINTED - A"), and a false
 * `absent` is a refusal of something that is there — the costlier error here.
 */
export function foldForMatch(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

/**
 * Whether `label` is in what the read found. **Joined, then searched**: the elements are put in
 * reading order and their text concatenated, so a label OCR split across two elements is still
 * found. Joining can only turn an `absent` into a `present` — which costs the refusal, never a
 * press that did not happen before G1.
 */
export function labelIsIn(label: string, found: ReadonlyArray<{ text: string; region: Rect }>): boolean {
  const wanted = foldForMatch(label);
  if (wanted === "") return false;
  const read = [...found]
    .sort((a, b) => a.region.y - b.region.y || a.region.x - b.region.x)
    .map((e) => foldForMatch(e.text))
    .join("");
  return read.includes(wanted);
}

/** `deps` exists for unit tests only. */
export interface StaleRereadDeps {
  windowRect?: (hwnd: bigint) => Rect | null;
  identityNow?: (hwnd: bigint) => WindowIdentity | undefined;
  read?: (hwnd: bigint, roi: Rect) => Promise<ReadonlyArray<{ text: string; region: Rect }>>;
}

function productionWindowIdentity(hwnd: bigint): WindowIdentity | undefined {
  return readWindowIdentityFields(hwnd, { identity: getWindowIdentity, className: getWindowClassName, title: getWindowTitleW });
}

async function productionRead(hwnd: bigint, roi: Rect): Promise<ReadonlyArray<{ text: string; region: Rect }>> {
  // The discover OCR lane's language, not the fold's fixed "ja": the label being looked for was
  // written by a lane that read in this one.
  const som = await runSomPipeline("", hwnd, detectOcrLanguage(), 2, "auto", false, [], roi);
  return som.elements;
}

export async function productionRereadStale(
  entity: UiEntity,
  aim: Aim | undefined,
  deps: StaleRereadDeps = {},
): Promise<StaleRereadAnswer> {
  const started = Date.now();
  const capturedIn = observedHwndOfOrigin(entity.origin);
  const hwnd = aim?.hwnd ?? capturedIn;
  const label = entity.label ?? "";
  const row = (answer: StaleRereadAnswer, extra: Record<string, unknown> = {}): StaleRereadAnswer => {
    probeAim("act.stale", {
      entityId: entity.entityId,
      handle: hwnd?.toString() ?? null,
      label,
      answer: answer.kind,
      ...(answer.kind === "cannot_say" ? { why: answer.why } : {}),
      ...extra,
      ms: Date.now() - started,
    });
    return answer;
  };
  const cannotSay = (why: string, extra: Record<string, unknown> = {}): StaleRereadAnswer => row({ kind: "cannot_say", why }, extra);

  if (foldForMatch(label) === "") return cannotSay("no_label");
  if (!entity.rect) return cannotSay("no_rect");
  if (hwnd === undefined) return cannotSay("no_handle");

  // The aim's window still the aim's owner? Otherwise the executor refuses the act as
  // `aim_identity_changed`, and a read of a stranger's window must not answer first.
  if (aim?.hwnd !== undefined && hwnd === aim.hwnd) {
    const now = (deps.identityNow ?? productionWindowIdentity)(hwnd);
    if (compareAimIdentity(aim, now) === "changed") return cannotSay("aim_identity_changed");
  }

  const windowRect = (deps.windowRect ?? getWindowRectByHwnd)(hwnd);
  if (windowRect === null || windowRect.width <= 0 || windowRect.height <= 0) return cannotSay("no_window_rect");

  // Where the press would go: the entity's centre, through the press's own homing.
  const r = entity.rect;
  const cx = Math.round(r.x + r.width / 2);
  const cy = Math.round(r.y + r.height / 2);
  const homed: Homing = homingCorrectionForSources(entity.sources, aim?.origin, windowRect, cx, cy, {
    capturedIn,
    originOf: aim?.hwnd,
  });
  const homing = homed.applied ? "applied" : homed.why;
  if (!READABLE.has(homing)) return cannotSay(`homing_${homing}`);

  // The entity's rect, moved with its centre, in the window's own coordinates.
  const inWindow: Rect = {
    x: r.x + (homed.x - cx) - windowRect.x,
    y: r.y + (homed.y - cy) - windowRect.y,
    width: r.width,
    height: r.height,
  };
  if (clampRectToWindow(inWindow, windowRect) === null) return cannotSay("rect_outside_window", { homing });
  // Padded as the fold pads its crop: Windows OCR does not segment a crop about one line high.
  const roi = resolveFoldOcrRoi(inWindow, windowRect);

  let found: ReadonlyArray<{ text: string; region: Rect }>;
  try {
    found = await (deps.read ?? productionRead)(hwnd, roi);
  } catch (err) {
    return cannotSay("read_failed", { homing, roi, error: err instanceof Error ? err.name : typeof err });
  }
  const present = labelIsIn(label, found);
  return row(present ? { kind: "present" } : { kind: "absent" }, { homing, roi, foundCount: found.length });
}
