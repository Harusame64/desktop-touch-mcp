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
import { compareAimIdentity, homingCorrectionForSources, observedHwndOfOrigin, type Aim, type Homing, type WindowIdentity } from "../engine/aim.js";
import { detectOcrLanguage, runSomPipeline } from "../engine/ocr-bridge.js";
import { getWindowRectByHwnd } from "../engine/win32.js";
import { productionWindowIdentity } from "./_window-identity.js";
import type { StaleRereadAnswer } from "../engine/world-graph/guarded-touch.js";
import type { UiEntity } from "../engine/world-graph/types.js";
import type { Rect } from "../engine/vision-gpu/types.js";
import { resolveFoldOcrRoi } from "./_roi-region.js";

/**
 * The homing answers the press goes on with, at the point this read will look at. Every other
 * answer is one the press path refuses on, or one where the press lands somewhere this read cannot
 * describe — so the read steps aside and lets the press path answer.
 */
const READABLE: ReadonlySet<string> = new Set(["applied", "not_moved", "no_origin_rect", "measurement_moment_unknown"]);

/**
 * Text as it is compared: compatibility-folded, case-folded, and **letters and digits only**. OCR
 * splits and joins words differently from one read to the next ("PAINTED-A" / "PAINTED - A"), and
 * the label being looked for may have been written by another engine than the one reading now —
 * the ONNX visual backend reads with PaddleOCR, this read with Windows OCR — which can disagree on a
 * hyphen, a dash or a bracket. A false `absent` is a refusal of something that is there, the
 * costlier error here, so what is compared is what two engines are likeliest to agree on. A label
 * with no letter or digit folds to nothing and is not looked for (`no_label`).
 */
export function foldForMatch(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

type Found = { text: string; region: Rect };

/** A script written without spaces: every character boundary in it is a word boundary. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

/**
 * One line's text as it is compared ({@link foldForMatch}, per element), with the positions a word
 * may start or end at: the ends of every element, wherever a space or a symbol was folded away, and
 * around every character of a script written without spaces.
 */
function foldLine(items: readonly Found[]): { text: string; edges: Set<number> } {
  let text = "";
  const edges = new Set<number>([0]);
  for (const e of items) {
    edges.add(text.length);
    for (const ch of e.text.normalize("NFKC").toLowerCase()) {
      if (/[\p{L}\p{N}]/u.test(ch)) {
        if (UNSPACED.test(ch)) edges.add(text.length);
        text += ch;
        if (UNSPACED.test(ch)) edges.add(text.length);
      } else {
        edges.add(text.length);
      }
    }
    edges.add(text.length);
  }
  return { text, edges };
}

/**
 * Whether `label` is AT `place` in what the read found.
 *
 * **At the place, not in the crop.** The crop is padded for the OCR's sake — Windows OCR does not
 * segment a strip one line high — and the padding reaches the next row of a list. Only an element
 * whose centre is within the place's height and whose span overlaps its width counts: a list that
 * scrolled one row must not find the label in the row it moved to (gate 2).
 *
 * **Whole words, not a substring.** Found as a substring, `OK` is in `Book` and `Item 1` is in
 * `Item 10` — each a press on the wrong thing, which is what G1 exists to stop (gate 2). The label
 * must start and end where a word does; see {@link foldLine}.
 *
 * **Joined within a line**, so a label OCR split across elements is still found, and the line is read
 * left to right. Lines are grouped by vertical overlap, not sorted by `y`: the two halves of one
 * label need not share a top edge, and `PAINTED` at y 224 and `-A` at y 223 sorted by `y` read
 * "apainted" (codex, gate 1).
 */
export function labelIsAt(label: string, found: readonly Found[], place: Rect): boolean {
  const wanted = foldForMatch(label);
  if (wanted === "") return false;
  const centreY = (r: Rect): number => r.y + r.height / 2;
  const slack = place.height / 4;
  const atPlace = found.filter((e) => {
    const c = centreY(e.region);
    return c >= place.y - slack && c <= place.y + place.height + slack
      && e.region.x < place.x + place.width && e.region.x + e.region.width > place.x;
  });
  const lines: Array<{ top: number; bottom: number; items: Found[] }> = [];
  for (const e of [...atPlace].sort((a, b) => centreY(a.region) - centreY(b.region))) {
    const c = centreY(e.region);
    const line = lines.find((l) => c >= l.top && c <= l.bottom);
    if (line) {
      line.items.push(e);
      line.top = Math.min(line.top, e.region.y);
      line.bottom = Math.max(line.bottom, e.region.y + e.region.height);
    } else {
      lines.push({ top: e.region.y, bottom: e.region.y + e.region.height, items: [e] });
    }
  }
  return lines.some((l) => {
    const { text, edges } = foldLine([...l.items].sort((a, b) => a.region.x - b.region.x));
    for (let at = text.indexOf(wanted); at !== -1; at = text.indexOf(wanted, at + 1)) {
      if (edges.has(at) && edges.has(at + wanted.length)) return true;
    }
    return false;
  });
}

/** `deps` exists for unit tests only. */
export interface StaleRereadDeps {
  windowRect?: (hwnd: bigint) => Rect | null;
  identityNow?: (hwnd: bigint) => WindowIdentity | undefined;
  read?: (hwnd: bigint, roi: Rect) => Promise<readonly Found[]>;
  timeoutMs?: number;
}

async function productionRead(hwnd: bigint, roi: Rect): Promise<readonly Found[]> {
  // The discover OCR lane's language, not the fold's fixed "ja": the label being looked for was
  // written by a lane that read in this one.
  const som = await runSomPipeline("", hwnd, detectOcrLanguage(), 2, "auto", false, [], roi);
  return som.elements;
}

/**
 * How long the read may take. The loop validates the lease again after it, so the read's own
 * duration is time taken out of the lease; `runSomPipeline` can wait up to its OCR child's timeout
 * (20 s). A read past this bound answers `cannot_say` and the act goes on unchecked (gate 2).
 */
export const STALE_REREAD_TIMEOUT_MS = 3000;

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
  // **Every way out writes the row**, a throw included: the act goes on after `cannot_say` exactly as
  // after `present`, and only the row tells them apart (gate 2 — a throw outside the read used to
  // reach the loop's own catch and leave no row at all).
  try {
    return await reread(entity, aim, hwnd, capturedIn, label, deps, row, cannotSay);
  } catch (err) {
    return cannotSay("threw", { error: err instanceof Error ? err.name : typeof err });
  }
}

async function reread(
  entity: UiEntity,
  aim: Aim | undefined,
  hwnd: bigint | undefined,
  capturedIn: bigint | undefined,
  label: string,
  deps: StaleRereadDeps,
  row: (answer: StaleRereadAnswer, extra?: Record<string, unknown>) => StaleRereadAnswer,
  cannotSay: (why: string, extra?: Record<string, unknown>) => StaleRereadAnswer,
): Promise<StaleRereadAnswer> {
  if (foldForMatch(label) === "") return cannotSay("no_label");
  if (!entity.rect) return cannotSay("no_rect");
  if (hwnd === undefined) return cannotSay("no_handle");

  // The aim's window still the aim's owner? Otherwise the executor refuses the act as
  // `aim_identity_changed`, and a read of a stranger's window must not answer first. (When the aim
  // has a handle, it is the handle read.)
  if (aim?.hwnd !== undefined) {
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
  // A press point outside the window is the press path's refusal (`aim_point_outside_window`), with
  // its own advice. Reading the strip of the rect that is still inside would answer first (gate 2).
  if (homed.x < windowRect.x || homed.x >= windowRect.x + windowRect.width
      || homed.y < windowRect.y || homed.y >= windowRect.y + windowRect.height) {
    return cannotSay("point_outside_window", { homing });
  }

  // The entity's rect, moved with its centre: on the screen (where the read's elements are) and in
  // the window's own coordinates (what the crop is cut in).
  const place: Rect = { x: r.x + (homed.x - cx), y: r.y + (homed.y - cy), width: r.width, height: r.height };
  const inWindow: Rect = { ...place, x: place.x - windowRect.x, y: place.y - windowRect.y };
  // Padded as the fold pads its crop: Windows OCR does not segment a crop about one line high.
  const roi = resolveFoldOcrRoi(inWindow, windowRect);

  let found: readonly Found[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), deps.timeoutMs ?? STALE_REREAD_TIMEOUT_MS);
    });
    const outcome = await Promise.race([(deps.read ?? productionRead)(hwnd, roi), timedOut]);
    if (outcome === "timed_out") return cannotSay("read_timed_out", { homing, roi });
    found = outcome;
  } catch (err) {
    return cannotSay("read_failed", { homing, roi, error: err instanceof Error ? err.name : typeof err });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  // **A read that found nothing at all is not an absence**: a black capture (a GPU or protected
  // window), a missing OCR language, a crop that missed the buffer all look like this, and each of
  // them was pressed correctly before G1 (gate 2). A read that found text — just not the label, at
  // the place — is the ground.
  if (found.length === 0) return cannotSay("read_found_nothing", { homing, roi });
  const present = labelIsAt(label, found, place);
  return row(present ? { kind: "present" } : { kind: "absent" }, { homing, roi, foundCount: found.length });
}
