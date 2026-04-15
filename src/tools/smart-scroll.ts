import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mouse } from "../engine/nutjs.js";
import {
  evaluateInTab,
  getScrollAncestorsCdp,
  setScrollPositionCdp,
  detectStickyHeaderCdp,
  scrollVirtualListCdp,
} from "../engine/cdp-bridge.js";
import {
  getScrollAncestors,
  scrollByPercent,
  scrollElementIntoView,
} from "../engine/uia-bridge.js";
import { readScrollInfo, enumWindowsInZOrder, restoreAndFocusWindow } from "../engine/win32.js";
import {
  dHashFromRaw,
  hammingDistance,
  extractStripRaw,
  detectScrollThumbFromStrip,
} from "../engine/image.js";
import { captureWindowRawAndHash, getCachedRaw } from "../engine/layer-buffer.js";
import { getCdpPort } from "../utils/desktop-config.js";
import { ok, buildDesc } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith, failArgs } from "./_errors.js";
import { coercedBoolean } from "./_coerce.js";

const _defaultPort = getCdpPort();

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SCROLL_TICKS_PER_PAGE = 6;
const SCROLL_MULTIPLIER = 3;  // nut-js multiplier matching existing scroll tool
const HASH_MOVE_THRESHOLD = 5; // Hamming distance below which we consider scroll a no-op

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const smartScrollSchema = {
  target: z.string().describe(
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
  verifyWithHash: coercedBoolean().default(false).describe(
    "Verify scroll effectiveness via perceptual hash comparison. Automatically enabled for image path."
  ),
  virtualIndex: z.number().int().min(0).optional().describe(
    "Target row index in a virtualised list (0-based). Enables direct TanStack/data-index seeking."
  ),
  virtualTotal: z.number().int().min(1).optional().describe(
    "Total row count in a virtualised list. Required when virtualIndex is set."
  ),
  expandHidden: coercedBoolean().default(false).describe(
    "Temporarily set overflow:hidden ancestors to overflow:auto to unlock scroll. Mutates live CSS."
  ),
  hint: z.enum(["above", "below", "left", "right"]).optional().describe(
    "Scroll direction hint for binary-search (image path). Seeds lo/hi bounds to reduce attempts."
  ),
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isSelectorLike(target: string): boolean {
  return /^[#.\[a-zA-Z]/.test(target.trim());
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
    // Ancestor walk
    const { ancestors, warnings: ancWarn } = await getScrollAncestorsCdp(target, tabId ?? null, port, maxDepth);
    warnings.push(...ancWarn);

    // Overflow:hidden check
    const hiddenAncestors = ancestors.filter(a => a.isHidden);
    if (hiddenAncestors.length > 0 && !expandHidden) {
      return failWith(
        `OverflowHiddenAncestor: '${hiddenAncestors[0]?.cssSelectorPath}' has overflow:hidden`,
        "smart_scroll",
        { target, expandHidden }
      );
    }

    // Unlock hidden ancestors if requested.
    // getScrollAncestorsCdp already marked each hidden ancestor with data-dt-hidden-ancestor,
    // so the unlock expression needs no external data embedded — pure attribute query.
    if (expandHidden && hiddenAncestors.length > 0) {
      const unlockExpr = `(function(){var els=document.querySelectorAll('[data-dt-hidden-ancestor]');els.forEach(function(el){el.setAttribute('data-dt-prev-overflow','hidden');el.style.overflow='auto';el.removeAttribute('data-dt-hidden-ancestor');});})()`;
      try { await evaluateInTab(unlockExpr, tabId ?? null, port); } catch { /* ignore */ }
      warnings.push("expandHidden: overflow:hidden unlocked — call smart_scroll again to restore");
    }

    // Restore any previously unlocked elements, and clean up stale data-dt-hidden-ancestor markers.
    const restoreExpr = `
(function(){
  const old = document.querySelectorAll('[data-dt-prev-overflow]');
  for (const el of old) { el.style.overflow = el.getAttribute('data-dt-prev-overflow') || ''; el.removeAttribute('data-dt-prev-overflow'); }
  const marked = document.querySelectorAll('[data-dt-hidden-ancestor]');
  for (const el of marked) { el.removeAttribute('data-dt-hidden-ancestor'); }
})()`;
    try { await evaluateInTab(restoreExpr, tabId ?? null, port); } catch { /* ignore */ }

    // Virtual list
    const virtualAncestors = ancestors.filter(a => a.isVirtualized);
    if (virtualAncestors.length > 0 && virtualIndex !== undefined && virtualTotal !== undefined) {
      const vResult = await scrollVirtualListCdp(
        virtualAncestors[0]!.cssSelectorPath, virtualIndex, virtualTotal, tabId ?? null, port
      );
      warnings.push(...(vResult.warnings ?? []));
      if (!vResult.ok) {
        return failWith("VirtualScrollExhausted: " + (vResult.warnings[0] ?? "bisect failed"), "smart_scroll", { target });
      }
    } else {
      // Layer-by-layer: outer → inner ancestors, then final scrollIntoView
      for (const ancestor of ancestors.filter(a => !a.isHidden)) {
        // Calculate desired scrollTop so the element ends up at `inline` position
        const targetScrollTop = Math.max(0, ancestor.scrollTop + (ancestor.scrollHeight - ancestor.clientHeight) * 0.5);
        await setScrollPositionCdp(ancestor.cssSelectorPath, targetScrollTop, ancestor.scrollLeft, tabId ?? null, port);
      }
      // Final scrollIntoView
      const scrollExpr = `
(function() {
  const el = document.querySelector(${JSON.stringify(target)});
  if (!el) return { ok: false, error: 'Element not found' };
  el.scrollIntoView({ block: ${JSON.stringify(inline)}, inline: 'nearest', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  return { ok: true, viewportTop: Math.round(r.top), viewportBottom: Math.round(r.bottom) };
})()`;
      const svResult = await evaluateInTab(scrollExpr, tabId ?? null, port) as {
        ok: boolean; error?: string; viewportTop?: number; viewportBottom?: number;
      };
      if (!svResult.ok) {
        return failWith(svResult.error ?? "scrollIntoView failed", "smart_scroll", { target });
      }
    }

    // Sticky header check
    const headerCheck = await detectStickyHeaderCdp(target, tabId ?? null, port);
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
      try { await evaluateInTab(shiftExpr, tabId ?? null, port); } catch { /* ignore */ }
      warnings.push(`Sticky header occlusion detected (height ~${headerHeight}px), scrolled an extra ${headerHeight + 8}px`);
    }

    // Compute final state
    const finalStateExpr = `
(function() {
  const el = document.querySelector(${JSON.stringify(target)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const vp = cy < 0 ? 'above' : cy > window.innerHeight ? 'below' : cx < 0 ? 'left' : cx > window.innerWidth ? 'right' : 'in-view';
  const pageRatio = (window.scrollY + r.top) / (document.documentElement.scrollHeight || 1);
  return { viewportPosition: vp, pageRatio: Math.max(0, Math.min(1, pageRatio)) };
})()`;
    const finalState = await evaluateInTab(finalStateExpr, tabId ?? null, port) as {
      viewportPosition: string; pageRatio: number;
    } | null;

    // Hash verification
    let scrolled = true;
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
      ancestors: ancestors.map(a => ({
        selector: a.cssSelectorPath,
        overflowY: a.overflowY,
        isVirtualized: a.isVirtualized,
        scrollTop: a.scrollTop,
        scrollHeight: a.scrollHeight,
      })),
      viewportPosition: finalState?.viewportPosition ?? null,
      ...(occludedBy && { occludedBy }),
      ...(warnings.length > 0 && { warnings }),
    });
  } catch (err) {
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
  const win = enumWindowsInZOrder().find(w =>
    w.title.toLowerCase().includes(windowTitle.toLowerCase())
  );
  if (!win) {
    return failWith(`Window not found: "${windowTitle}"`, "smart_scroll", { windowTitle });
  }

  // Focus the window before sending scroll input
  try { restoreAndFocusWindow(win.hwnd); } catch { /* best effort */ }
  await new Promise(r => setTimeout(r, 80));

  // Get initial scroll position
  const scrollInfo = readScrollInfo(win.hwnd, "vertical");
  let currentRatio = scrollInfo?.pageRatio ?? 0.5;
  let lo = 0, hi = 1;

  // Seed from hint
  if (hint === "above" || hint === "left") hi = currentRatio;
  else if (hint === "below" || hint === "right") lo = currentRatio;

  // Initial capture for hash baseline
  const region = win.region;
  let capture = await captureWindowRawAndHash(win.hwnd, region);
  if (!capture) {
    return failWith("Failed to capture window pixels", "smart_scroll", { windowTitle });
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
    const effectiveTicks = Math.max(1, ticks) * SCROLL_MULTIPLIER;

    if (delta > 0) {
      await mouse.scrollDown(effectiveTicks);
    } else {
      await mouse.scrollUp(effectiveTicks);
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
          "smart_scroll",
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
    if (!windowTitle) return failArgs(`strategy:'${strategy}' requires windowTitle`, "smart_scroll", { strategy });
  }
  if (strategy === "cdp" && !isSelectorLike(target)) {
    return failArgs("strategy:'cdp' requires a CSS selector as target (must start with #, ., tag name, or [)", "smart_scroll", { target });
  }
  if (strategy === "image" && !windowTitle) {
    return failArgs("strategy:'image' requires windowTitle", "smart_scroll", { strategy });
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
      "smart_scroll",
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
        return failArgs("image path requires windowTitle", "smart_scroll", {});
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

  return failWith("All scroll strategies failed", "smart_scroll", { target, windowTitle, strategy });
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerSmartScrollTools(server: McpServer): void {
  server.tool(
    "smart_scroll",
    buildDesc({
      purpose: "Scroll any element into the viewport — handles nested scroll layers, virtualised lists, sticky-header occlusion, and image-only fallbacks in a single call.",
      details:
        "Three paths selected by strategy:'auto' (default): " +
        "(1) CDP (Chrome/Edge): walks scroll ancestor chain, handles overflow:hidden (expandHidden), virtualised lists (TanStack/data-index bisect), detects sticky headers and compensates. " +
        "(2) UIA (native Windows apps): uses ScrollPattern.SetScrollPercent on ancestor containers then ScrollItemPattern for final snap. " +
        "(3) Image: binary-search via Win32 GetScrollInfo (exact ratio) or scrollbar-strip pixel sampling (overlay scrollbars), with dHash verification — detects no-op scrolls (Hamming < 5). " +
        "All paths emit a unified response: ok, path, attempts, pageRatio (0..1), scrolled (bool), ancestors[], viewportPosition. " +
        "pageRatio is the normalised vertical position of the element on the full page (0=top, 1=bottom). " +
        "Set verifyWithHash:true to explicitly check that pixels changed (auto-enabled on image path). " +
        "Nested scroll: ancestors[] is ordered outer→inner; the tool scrolls outer containers first. " +
        "Virtual lists: set virtualIndex + virtualTotal for O(log n) bisect (≤6 iterations).",
      prefer:
        "Use instead of scroll_to_element when: content is virtualised (React Virtualized, TanStack Virtual), multiple scroll containers nest, " +
        "or scroll_to_element returns scrolled:true but the viewport did not actually move. " +
        "For a simple single-container non-virtual scroll, scroll_to_element is lighter.",
      caveats:
        "CDP path requires browser_connect. Cross-origin iframes are not traversed (warning returned). " +
        "expandHidden mutates live CSS (overflow:auto); previous value is stored in data-dt-prev-overflow and restored on the next smart_scroll call (or after 30 s). " +
        "Image path cannot determine whether the target element is in-view — viewportPosition is null. Call screenshot(detail='text') afterwards to verify. " +
        "UIA ScrollPattern may not be available in all native apps — falls through to image path.",
      examples: [
        "smart_scroll({target: '#create-release-btn'}) — CDP, nested container, no virtual list",
        "smart_scroll({target: '[data-index]', virtualIndex: 500, virtualTotal: 10000}) — TanStack virtual list",
        "smart_scroll({target: 'Create Release', windowTitle: 'File Explorer', strategy: 'uia'}) — native UIA",
        "smart_scroll({target: 'readme section', windowTitle: 'MyApp', strategy: 'image', hint: 'below'}) — image binary-search",
      ],
    }),
    smartScrollSchema,
    smartScrollHandler
  );
}
