import { z } from "zod";
import { mouse } from "../engine/nutjs.js";
import {
  evaluateInTab,
  getScrollAncestorsCdp,
  setScrollPositionCdp,
  detectStickyHeaderCdp,
  scrollVirtualListCdp,
  resolveTabId,
} from "../engine/cdp-bridge.js";
import {
  getScrollAncestors,
  scrollByPercent,
  scrollElementIntoView,
} from "../engine/uia-bridge.js";
import { readScrollInfo, enumWindowsInZOrder } from "../engine/win32.js";
import { offDesktopFailure } from "./_off-desktop.js";
import { bringForward } from "./_bring-forward.js";
import { blockedByDialogFailure } from "./_blocked-by-dialog.js";
import { logResolve, logDispatchSink } from "./_resolve-log.js";
import {
  dHashFromRaw,
  hammingDistance,
  extractStripRaw,
  detectScrollThumbFromStrip,
} from "../engine/image.js";
import { captureWindowRawAndHash, getCachedRaw } from "../engine/layer-buffer.js";
import { getCdpPort } from "../utils/desktop-config.js";
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith, failArgs, failCode, getSuggestsForCode } from "./_errors.js";
import { coercedBooleanWithDefault } from "./_coerce.js";
import { WHEEL_DELTA_PER_NOTCH } from "./_input-pipeline.js";

const _defaultPort = getCdpPort();

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Wheel notches that move roughly one viewport on a typical page. */
const SCROLL_TICKS_PER_PAGE = 6;
const HASH_MOVE_THRESHOLD = 5; // Hamming distance below which we consider scroll a no-op

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const smartScrollSchema = {
  target: z.string().min(1).describe(
    "CSS selector (Chrome/Edge) or partial UIA name (native apps). " +
    "For CDP path, must be a valid CSS selector (starts with #, ., tag, or [ ). " +
    "For UIA path, a partial name match against element Name property."
  ),
  windowTitle: z.string().optional().describe(
    "Partial window title. Required for UIA and image paths. For CDP path, optional."
  ),
  tabId: z.string().optional().describe("CDP tab ID (Chrome path only). Omit for first page tab."),
  port: z.coerce.number().int().min(1).max(65535).default(_defaultPort).describe(
    `CDP port (default ${_defaultPort})`
  ),
  strategy: z.enum(["auto", "cdp", "uia", "image"]).default("auto").describe(
    "auto (default): try CDP → UIA → image in order. cdp: Chrome/Edge only. uia: native Windows UIA. image: image + Win32 binary-search."
  ),
  direction: z.enum(["into-view", "up", "down", "left", "right"]).default("into-view").describe(
    "Scroll direction. into-view: scroll until target element is visible (default). Other values scroll unconditionally."
  ),
  inline: z.enum(["start", "center", "end", "nearest"]).default("center").describe(
    "Vertical alignment after scroll (CDP path). Default: center."
  ),
  maxDepth: z.number().int().min(1).max(10).default(3).describe(
    "Max number of ancestor scroll containers to walk. Default 3."
  ),
  retryCount: z.number().int().min(1).max(4).default(3).describe(
    "Max scroll attempts (image path binary-search). Default 3, cap 4."
  ),
  verifyWithHash: coercedBooleanWithDefault(false).describe(
    "Verify scroll effectiveness via perceptual hash comparison. Automatically enabled for image path."
  ),
  virtualIndex: z.number().int().min(0).optional().describe(
    "Target row index in a virtualised list (0-based). Enables direct TanStack/data-index seeking."
  ),
  virtualTotal: z.number().int().min(1).optional().describe(
    "Total row count in a virtualised list. Required when virtualIndex is set."
  ),
  expandHidden: coercedBooleanWithDefault(false).describe(
    "Scroll the target into view even inside overflow:hidden ancestors (refused by default: such content may be hidden on purpose). The page's CSS is not changed."
  ),
  hint: z.enum(["above", "below", "left", "right"]).optional().describe(
    "Scroll direction hint for binary-search (image path). Seeds lo/hi bounds to reduce attempts."
  ),
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isSelectorLike(target: string): boolean {
  return /^[#.[a-zA-Z]/.test(target.trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// CDP path
// ─────────────────────────────────────────────────────────────────────────────

async function tryCdp(params: {
  target: string;
  tabId?: string;
  port: number;
  inline: "start" | "center" | "end" | "nearest";
  maxDepth: number;
  verifyWithHash: boolean;
  virtualIndex?: number;
  virtualTotal?: number;
  expandHidden: boolean;
}): Promise<ToolResult | null> {
  const { target, tabId, port, inline, maxDepth, verifyWithHash, virtualIndex, virtualTotal, expandHidden } = params;
  const warnings: string[] = [];

  try {
    // The tab is chosen once (internal #423). With no tabId each of the steps below resolved the default page tab
    // again, so a tab brought to the front mid-call took the later steps: the layer scrolls, scrollIntoView, the
    // sticky-header shift and the final read could run in another tab than the one whose ancestors were walked. A
    // tab that cannot be resolved fails this path at once, for the caller to try the next strategy.
    const tab = tabId ?? await resolveTabId(null, port);
    // Ancestor walk. Nothing is marked: expandHidden changes no CSS (below).
    const { ancestors, warnings: ancWarn } = await getScrollAncestorsCdp(target, tab, port, maxDepth);
    warnings.push(...ancWarn);

    // Overflow:hidden check
    const hiddenAncestors = ancestors.filter(a => a.isHidden);
    if (hiddenAncestors.length > 0 && !expandHidden) {
      return failWith(
        `OverflowHiddenAncestor: '${hiddenAncestors[0]?.cssSelectorPath}' has overflow:hidden`,
        "scroll(action='smart')",
        { target, expandHidden }
      );
    }

    // expandHidden is a permission to scroll inside an overflow:hidden ancestor, not a CSS change: an
    // overflow:hidden box is a scroll container, and scrollIntoView (below) scrolls it as it does an auto one.
    // The page's CSS is left as it is. It used to be unlocked to overflow:auto and put back in the same call,
    // before any scroll, so the unlock did nothing while the answer said "unlocked — call smart_scroll again to
    // restore", and the put-back wrote overflow:hidden inline whatever the element had (internal #423). Opening it
    // for the scroll instead was worse (/code-review): an inline overflow-y or !important came back wrong,
    // Windows' classic scrollbars rewrapped the layout the answer was read in, and two calls in one tab undid
    // each other's changes.
    if (expandHidden && hiddenAncestors.length > 0) {
      // Said as the permission it is, not as a scroll done: nothing here measures whether the hidden box moved (a
      // box of height 0 does not), and the virtual-list road does not run scrollIntoView (/code-review).
      const names = hiddenAncestors.map((a) => `'${a.cssSelectorPath}'`).join(", ");
      warnings.push(`expandHidden: scrolling allowed inside overflow:hidden ancestor(s) ${names}; the page's CSS is not changed`);
    }

    // Virtual list
    const virtualAncestors = ancestors.filter(a => a.isVirtualized);
    if (virtualAncestors.length > 0 && virtualIndex !== undefined && virtualTotal !== undefined) {
      const vResult = await scrollVirtualListCdp(
        virtualAncestors[0]!.cssSelectorPath, virtualIndex, virtualTotal, tab, port
      );
      warnings.push(...(vResult.warnings ?? []));
      if (!vResult.ok) {
        return failWith("VirtualScrollExhausted: " + (vResult.warnings[0] ?? "bisect failed"), "scroll(action='smart')", { target });
      }
    } else {
      // Layer-by-layer: outer → inner ancestors, then final scrollIntoView
      for (const ancestor of ancestors.filter(a => !a.isHidden)) {
        // Calculate desired scrollTop so the element ends up at `inline` position
        const targetScrollTop = Math.max(0, ancestor.scrollTop + (ancestor.scrollHeight - ancestor.clientHeight) * 0.5);
        await setScrollPositionCdp(ancestor.cssSelectorPath, targetScrollTop, ancestor.scrollLeft, tab, port);
      }
      // Final scrollIntoView.
      //
      // ADR-018 Phase 3 / §5 R3 — `target='body'` / `target='html'` regression
      // fix: `document.querySelector('body').scrollIntoView({block:'instant'})`
      // is interpreted by Chromium as "snap viewport to the body's top edge",
      // which resets `scrollTop` to 0 even when the page was scrolled.
      // ADR §1.1 symptom 4 reported this as a silent reverse-direction scroll.
      // Use the two-step `document.scrollingElement || document.documentElement`
      // query for the document root and skip `scrollIntoView` — the root is in
      // view by definition; reading its bounding rect is sufficient for the
      // viewportTop/Bottom response. Non-root selectors keep the existing
      // `scrollIntoView({behavior:'instant'})` path unchanged.
      const scrollExpr = `
(function() {
  const target = ${JSON.stringify(target)};
  const isRoot = target === 'body' || target === 'html';
  const el = isRoot
    ? (document.scrollingElement || document.documentElement)
    : document.querySelector(target);
  if (!el) return { ok: false, error: isRoot ? 'No scrolling element' : 'Element not found' };
  if (!isRoot) {
    el.scrollIntoView({ block: ${JSON.stringify(inline)}, inline: 'nearest', behavior: 'instant' });
  }
  const r = el.getBoundingClientRect();
  return { ok: true, viewportTop: Math.round(r.top), viewportBottom: Math.round(r.bottom) };
})()`;
      const svResult = await evaluateInTab(scrollExpr, tab, port) as {
        ok: boolean; error?: string; viewportTop?: number; viewportBottom?: number;
      };
      if (!svResult.ok) {
        return failWith(svResult.error ?? "scrollIntoView failed", "scroll(action='smart')", { target });
      }
    }

    // Sticky header check
    const headerCheck = await detectStickyHeaderCdp(target, tab, port);
    let occludedBy: { header?: boolean } | undefined;
    if (headerCheck.occluded) {
      occludedBy = { header: true };
      // Shift scrollTop to compensate
      const headerHeight = headerCheck.headerRect?.height ?? 56;
      const shiftExpr = `
(function() {
  const el = document.querySelector(${JSON.stringify(target)});
  if (!el) return;
  const scrollEl = el.parentElement;
  if (scrollEl) scrollEl.scrollTop -= ${headerHeight + 8};
})()`;
      try { await evaluateInTab(shiftExpr, tab, port); } catch { /* ignore */ }
      warnings.push(`Sticky header occlusion detected (height ~${headerHeight}px), scrolled an extra ${headerHeight + 8}px`);
    }

    // Compute final state
    const finalStateExpr = `
(async function() {
  const el = document.querySelector(${JSON.stringify(target)});
  if (!el) return null;
  const at = function(r) {
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    return cy < 0 ? 'above' : cy > window.innerHeight ? 'below' : cx < 0 ? 'left' : cx > window.innerWidth ? 'right' : 'in-view';
  };
  const ratio = function(r) { return Math.max(0, Math.min(1, (window.scrollY + r.top) / (document.documentElement.scrollHeight || 1))); };
  const r = el.getBoundingClientRect();
  const out = { viewportPosition: at(r), pageRatio: ratio(r), clipped: false, clipCheck: 'asked' };
  // Inside the window is not yet on screen: an ancestor (overflow:clip, clip-path, contain:paint, or a box the scroll
  // did not move far enough) can still cut the target off. The browser's own IntersectionObserver answers it: it cuts
  // the target by each clip on its containing-block chain, and so knows what a hand walk kept missing (display:contents,
  // the top layer, overflow-clip-margin, will-change, slots). A tall target partly shown still intersects; a row
  // touching the box's edge with no area inside does not (isIntersecting says yes there, the ratio says 0).
  // It answers a frame later, so the position is read again from its entry: a page that moved the target out of the
  // window meanwhile gets that position, not clipped. Not asked: a target outside the window, or one with no box
  // (display:none, removed, empty: no position either, clipCheck 'gone'). A page
  // that is not visible may not render, so it is not asked either; that and no answer within 500 ms are said in
  // clipCheck, since in-view is then only the window's answer.
  if (!(r.width > 0 && r.height > 0)) { out.viewportPosition = null; out.clipCheck = 'gone'; return out; }
  if (out.viewportPosition !== 'in-view') { out.clipCheck = 'not-needed'; return out; }
  if (document.visibilityState !== 'visible') { out.clipCheck = 'page-not-visible'; return out; }
  if (typeof IntersectionObserver !== 'function') { out.clipCheck = 'no-observer'; return out; }
  return await new Promise(function(res) {
    let timer = 0;
    const o = new IntersectionObserver(function(es) {
      o.disconnect(); clearTimeout(timer);
      const e = es[es.length - 1];
      // Gone in that frame (removed, display:none): no box to be clipped, and no position to give.
      if (!el.isConnected || !(e.boundingClientRect.width > 0 && e.boundingClientRect.height > 0)) {
        out.viewportPosition = null; out.clipCheck = 'gone'; res(out); return;
      }
      const now = at(e.boundingClientRect);
      res(now !== 'in-view'
        ? { viewportPosition: now, pageRatio: ratio(e.boundingClientRect), clipped: false, clipCheck: 'moved' }
        : { viewportPosition: now, pageRatio: ratio(e.boundingClientRect), clipped: !(e.intersectionRatio > 0), clipCheck: 'asked' });
    });
    timer = setTimeout(function() { o.disconnect(); out.clipCheck = 'no-answer'; res(out); }, 500);
    o.observe(el);
  });
})()`;
    // The scrolls have already run: a page that navigates during the read must not send the caller to the other roads,
    // which would scroll again. Answer without a final state instead.
    type FinalState = { viewportPosition: string; pageRatio: number; clipped?: boolean; clipCheck?: string };
    const finalState = await (evaluateInTab(finalStateExpr, tab, port) as Promise<FinalState | null>).catch((err: unknown) => {
      warnings.push(`The position after the scroll was not read: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    const notChecked: Record<string, string> = {
      "page-not-visible": "the page is not visible, so whether an ancestor clips it was not checked",
      "no-observer": "the page has no IntersectionObserver, so whether an ancestor clips it was not checked",
      "no-answer": "the browser did not answer within 500 ms whether an ancestor clips it",
      "gone": "the target has no box on the page (display:none, removed, or empty), so it is not on screen either",
    };
    const why = finalState?.clipCheck !== undefined ? notChecked[finalState.clipCheck] : undefined;
    if (why) {
      warnings.push(finalState?.clipCheck === "gone"
        ? `viewportPosition is null: ${why}`
        : `viewportPosition says only that the target was inside the window: ${why}`);
    }
    const ancestorsOut = ancestors.map(a => ({
      selector: a.cssSelectorPath,
      overflowY: a.overflowY,
      isVirtualized: a.isVirtualized,
      scrollTop: a.scrollTop,
      scrollHeight: a.scrollHeight,
    }));
    if (finalState?.clipped) {
      return failCode(
        "TargetClipped",
        occludedBy
          // The tool's own sticky-header shift ran first, and can be what moved the target out of its box.
          ? "The target is inside the window, but an ancestor cuts it off, so nothing of it is on screen. This tool shifted the target's parent for a sticky header first (see warnings), which may be what cut it off."
          : "The target is inside the window, but an ancestor cuts it off, so nothing of it is on screen.",
        {
          suggest: getSuggestsForCode("TargetClipped"),
          // The scrolls already ran: say so, with what the success answer carries (ancestors as walked before the scroll).
          context: {
            target, path: "cdp", scrolled: true, viewportPosition: finalState.viewportPosition,
            pageRatio: finalState.pageRatio, ancestors: ancestorsOut,
            ...(occludedBy && { occludedBy }), ...(warnings.length > 0 && { warnings }),
          },
        },
      );
    }

    // Hash verification
    const scrolled = true;
    if (verifyWithHash) {
      // We can't easily do pre/post hash without a before-capture, so mark as assumed-true
      // when verifyWithHash is set but no pre-hash exists. The image path does full verification.
      warnings.push("verifyWithHash: pre-scroll hash not available for CDP path — scrolled:true assumed");
    }

    return ok({
      ok: true,
      path: "cdp",
      attempts: 1,
      pageRatio: finalState?.pageRatio ?? null,
      scrolled,
      ancestors: ancestorsOut,
      viewportPosition: finalState?.viewportPosition ?? null,
      ...(occludedBy && { occludedBy }),
      ...(warnings.length > 0 && { warnings }),
    });
  } catch {
    // Let caller try next strategy
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UIA path
// ─────────────────────────────────────────────────────────────────────────────

async function tryUia(params: {
  target: string;
  windowTitle: string;
  verifyWithHash: boolean;
  retryCount: number;
}): Promise<{ result: ToolResult | null; shouldTryImage: boolean }> {
  const { target, windowTitle, verifyWithHash } = params;

  try {
    const ancestors = await getScrollAncestors(windowTitle, target);

    if (ancestors.length === 0) {
      // No ScrollPattern — return null so image path can try
      return { result: null, shouldTryImage: true };
    }

    // Scroll each ancestor outer → inner toward target
    for (const ancestor of ancestors) {
      if (ancestor.verticallyScrollable) {
        // Target 50% as a neutral scroll (we don't know exact ratio without element coords)
        const currentPct = ancestor.verticalPercent;
        const targetPct = Math.max(0, Math.min(100, currentPct)); // keep current, just trigger ScrollPattern
        await scrollByPercent(windowTitle, target, targetPct, -1);
      }
    }

    // Final ScrollItemPattern
    const sipResult = await scrollElementIntoView(windowTitle, target);

    // Hash verification
    const warnings: string[] = [];
    let scrolled = sipResult.scrolled;

    if (verifyWithHash) {
      // Try to get raw pixels from layer buffer
      const win = enumWindowsInZOrder().find(w => w.title.toLowerCase().includes(windowTitle.toLowerCase()));
      if (win) {
        const cached = getCachedRaw(win.hwnd);
        if (cached) {
          const preHash = await dHashFromRaw(cached.rawPixels, cached.width, cached.height, cached.channels);
          // Small delay then re-capture
          await new Promise(r => setTimeout(r, 150));
          const post = await captureWindowRawAndHash(win.hwnd, win.region);
          if (post) {
            const dist = hammingDistance(preHash, post.dHash);
            scrolled = dist >= HASH_MOVE_THRESHOLD;
            if (!scrolled) warnings.push("Hash verification: viewport unchanged after scroll (distance=" + dist + ")");
          }
        }
      }
    }

    const innerMost = ancestors[ancestors.length - 1];
    const pageRatio = innerMost?.verticallyScrollable
      ? Math.max(0, Math.min(1, innerMost.verticalPercent / 100))
      : null;

    return {
      result: ok({
        ok: true,
        path: "uia",
        attempts: 1,
        pageRatio,
        scrolled,
        ancestors: ancestors.map(a => ({
          name: a.name,
          verticalPercent: a.verticalPercent,
          verticallyScrollable: a.verticallyScrollable,
        })),
        viewportPosition: sipResult.scrolled ? "in-view" : null,
        ...(sipResult.error && { note: sipResult.error }),
        ...(warnings.length > 0 && { warnings }),
      }),
      shouldTryImage: !scrolled,
    };
  } catch {
    return { result: null, shouldTryImage: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Image path (binary search with Win32 GetScrollInfo + dHash)
// ─────────────────────────────────────────────────────────────────────────────

async function tryImage(params: {
  windowTitle: string;
  retryCount: number;
  hint?: "above" | "below" | "left" | "right";
}): Promise<ToolResult> {
  const { windowTitle, retryCount, hint } = params;

  // Resolve HWND
  const matches = enumWindowsInZOrder().filter(w =>
    w.title.toLowerCase().includes(windowTitle.toLowerCase())
  );
  const win = matches[0];
  // ADR-035 §2 #7 — a write: the resolved window is focused and then scrolled.
  logResolve({ resolver: "smartScrollImage", query: windowTitle, matches, identity: "lookup" });
  if (!win) {
    return failWith(`Window not found: "${windowTitle}"`, "scroll(action='smart')", { windowTitle });
  }

  // Focus the window before sending scroll input, through the shared bring-forward (gate 2 on #957):
  // a window on another virtual desktop is not brought forward (it would switch the user's desktop,
  // internal #382 / #221), nor one its own dialog has disabled (it took the dialog's focus, #381).
  // A window Windows did not bring to the front is scrolled as before (best effort).
  const brought = await bringForward(win.hwnd, { force: false, named: windowTitle, settleMs: 80 });
  if (brought.offDesktop) return offDesktopFailure("scroll(action='smart')", brought.offDesktop);
  if (brought.blockedByDialog) {
    return blockedByDialogFailure("scroll(action='smart')", brought.blockedByDialog, { extra: { strategy: "image" } });
  }

  // Get initial scroll position
  const scrollInfo = readScrollInfo(win.hwnd, "vertical");
  let currentRatio = scrollInfo?.pageRatio ?? 0.5;
  let lo = 0, hi = 1;

  // Seed from hint
  if (hint === "above" || hint === "left") hi = currentRatio;
  else if (hint === "below" || hint === "right") lo = currentRatio;

  // Initial capture for hash baseline
  const region = win.region;
  const capture = await captureWindowRawAndHash(win.hwnd, region);
  if (!capture) {
    return failWith("Failed to capture window pixels", "scroll(action='smart')", { windowTitle });
  }
  let prevHash = capture.dHash;

  const warnings: string[] = [];
  let noMoveSCount = 0;
  let attempts = 0;
  let scrolled = false;

  for (let i = 0; i < Math.min(retryCount, 4); i++) {
    attempts++;
    const targetRatio = (lo + hi) / 2;
    const delta = targetRatio - currentRatio;

    if (Math.abs(delta) < 0.02) {
      // Already close enough
      scrolled = true;
      break;
    }

    const ticks = Math.round(Math.abs(delta) * SCROLL_TICKS_PER_PAGE);
    // `ticks` is the notch count the binary search wants; nut-js forwards this
    // argument straight to libnut's `INPUT.mi.mouseData`, which is RAW
    // `WHEEL_DELTA` units — hence the scale.
    //
    // ADR-018 Phase 6 §2.1 — this used to be a private `SCROLL_MULTIPLIER = 3`,
    // so a full-page request delivered 18/120 of a notch and the search below
    // could not converge within `retryCount <= 4` on pages that scroll
    // perfectly well.
    const effectiveWheelUnits = Math.max(1, ticks) * WHEEL_DELTA_PER_NOTCH;

    // ADR-035 Phase 1 — this path resolves a window (logged above as
    // `smartScrollImage`) and then scrolls through SendInput, which follows the
    // CURSOR, not the handle. Without this the resolution has no write to be
    // joined to (Codex Round 2). One event per burst, because each iteration is
    // a separate dispatch.
    logDispatchSink({ sink: "sendinput", tool: "scroll:smart", targetHwnd: null });
    if (delta > 0) {
      await mouse.scrollDown(effectiveWheelUnits);
    } else {
      await mouse.scrollUp(effectiveWheelUnits);
    }

    await new Promise(r => setTimeout(r, 100));

    // Re-capture and compute new hash
    const newCapture = await captureWindowRawAndHash(win.hwnd, region);
    if (!newCapture) break;

    const dist = hammingDistance(prevHash, newCapture.dHash);
    if (dist < HASH_MOVE_THRESHOLD) {
      noMoveSCount++;
      warnings.push(`Attempt ${i + 1}: viewport unchanged (Hamming=${dist}) — page end or virtual scroll`);
      if (noMoveSCount >= 2) {
        return failWith(
          "VirtualScrollExhausted: page did not move after 2 consecutive scroll attempts — may be at boundary or virtual scroll",
          "scroll(action='smart')",
          { windowTitle, attempts }
        );
      }
      // Halve the step and try again from same position
      if (delta > 0) hi = (lo + hi) / 2;
      else lo = (lo + hi) / 2;
    } else {
      noMoveSCount = 0;
      scrolled = true;

      // Update scroll info for next iteration
      const newScrollInfo = readScrollInfo(win.hwnd, "vertical");
      if (newScrollInfo) {
        currentRatio = newScrollInfo.pageRatio;
      } else {
        // Use strip-based estimation
        const stripW = Math.min(16, newCapture.width);
        const stripLeft = Math.max(0, newCapture.width - stripW);
        const strip = await extractStripRaw(
          newCapture.rawPixels, newCapture.width, newCapture.height, newCapture.channels,
          { left: stripLeft, top: 0, width: stripW, height: newCapture.height }
        );
        const thumb = detectScrollThumbFromStrip(strip.data, strip.info.width, strip.info.height, strip.info.channels as 3 | 4);
        if (thumb) {
          currentRatio = thumb.thumbTop / Math.max(1, thumb.trackHeight - thumb.thumbHeight);
        } else {
          currentRatio = targetRatio; // assume we got there
        }
      }

      // Binary search update
      if (currentRatio < targetRatio) lo = currentRatio;
      else if (currentRatio > targetRatio) hi = currentRatio;
      else break;

      prevHash = newCapture.dHash;
    }
  }

  const finalScrollInfo = readScrollInfo(win.hwnd, "vertical");
  const pageRatio = finalScrollInfo?.pageRatio ?? currentRatio;

  return ok({
    ok: true,
    path: "image",
    attempts,
    pageRatio,
    scrolled,
    viewportPosition: null, // image path cannot resolve target rect
    ...(warnings.length > 0 && { warnings }),
    ...(scrolled ? {} : { note: "Image path: target coords unknown — call again with hint to refine position" }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

export const smartScrollHandler = async (params: {
  target: string;
  windowTitle?: string;
  tabId?: string;
  port: number;
  strategy: "auto" | "cdp" | "uia" | "image";
  direction: "into-view" | "up" | "down" | "left" | "right";
  inline: "start" | "center" | "end" | "nearest";
  maxDepth: number;
  retryCount: number;
  verifyWithHash: boolean;
  virtualIndex?: number;
  virtualTotal?: number;
  expandHidden: boolean;
  hint?: "above" | "below" | "left" | "right";
}): Promise<ToolResult> => {
  const {
    target, windowTitle, tabId, port, strategy, inline,
    maxDepth, retryCount, verifyWithHash, virtualIndex, virtualTotal, expandHidden, hint,
  } = params;

  // Validate
  if (strategy === "uia" || strategy === "image") {
    if (!windowTitle) return failArgs(`strategy:'${strategy}' requires windowTitle`, "scroll(action='smart')", { strategy });
  }
  if (strategy === "cdp" && !isSelectorLike(target)) {
    return failArgs("strategy:'cdp' requires a CSS selector as target (must start with #, ., tag name, or [)", "scroll(action='smart')", { target });
  }
  if (strategy === "image" && !windowTitle) {
    return failArgs("strategy:'image' requires windowTitle", "scroll(action='smart')", { strategy });
  }

  // Determine which strategies to try
  const tryStrategies: Array<"cdp" | "uia" | "image"> = [];
  if (strategy === "auto") {
    if (isSelectorLike(target)) tryStrategies.push("cdp");
    if (windowTitle) tryStrategies.push("uia", "image");
  } else {
    tryStrategies.push(strategy as "cdp" | "uia" | "image");
  }

  if (tryStrategies.length === 0) {
    return failArgs(
      "Cannot determine scroll strategy: provide a CSS selector (CDP) or windowTitle (UIA/image)",
      "scroll(action='smart')",
      { target, windowTitle, strategy }
    );
  }

  const strategyWarnings: string[] = [];

  for (const s of tryStrategies) {
    if (s === "cdp") {
      const result = await tryCdp({
        target, tabId, port, inline, maxDepth, verifyWithHash: verifyWithHash || false,
        virtualIndex, virtualTotal, expandHidden,
      });
      if (result !== null) return result;
      strategyWarnings.push("CDP path: browser not connected or element not found — trying next strategy");
    }

    if (s === "uia") {
      if (!windowTitle) continue;
      const { result, shouldTryImage } = await tryUia({
        target, windowTitle, verifyWithHash, retryCount,
      });
      if (result !== null && !shouldTryImage) return result;
      if (result !== null && shouldTryImage) {
        strategyWarnings.push("UIA path: scroll did not move viewport — falling through to image path");
      } else {
        strategyWarnings.push("UIA path: no ScrollPattern ancestor found — trying image path");
      }
    }

    if (s === "image") {
      if (!windowTitle) {
        return failArgs("image path requires windowTitle", "scroll(action='smart')", {});
      }
      const result = await tryImage({ windowTitle, retryCount, hint });
      // Merge strategy warnings into result if present
      if (strategyWarnings.length > 0) {
        try {
          const parsed = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
          const existing = Array.isArray(parsed["warnings"]) ? parsed["warnings"] as string[] : [];
          parsed["warnings"] = [...strategyWarnings, ...existing];
          return { content: [{ type: "text", text: JSON.stringify(parsed) }] };
        } catch { /* return as-is */ }
      }
      return result;
    }
  }

  return failWith("All scroll strategies failed", "scroll(action='smart')", { target, windowTitle, strategy });
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

// registerSmartScrollTools removed in Phase 2b (family merge).
// smart_scroll is now registered via scroll(action='smart') in scroll.ts.
