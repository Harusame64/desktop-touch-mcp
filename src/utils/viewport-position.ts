/**
 * Compute the viewport position of an element relative to a containing viewport.
 *
 * Returns one of: 'in-view' | 'above' | 'below' | 'left' | 'right'
 *
 * Logic: use the element's center point and compare it against the viewport bounds.
 * An element is "in-view" when its center falls inside the viewport rect.
 * Vertical priority: if the center is above the top edge, report 'above' even if
 * also out-of-range horizontally (scroll vertically first is the natural UX).
 */
export type ViewportPosition = "in-view" | "above" | "below" | "left" | "right";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * @param elementRect  Bounding rect of the element (screen or viewport coords)
 * @param viewportRect Bounding rect of the viewport/window to compare against
 */
export function computeViewportPosition(
  elementRect: Rect,
  viewportRect: Rect
): ViewportPosition {
  const cx = elementRect.x + elementRect.width / 2;
  const cy = elementRect.y + elementRect.height / 2;

  const vLeft = viewportRect.x;
  const vRight = viewportRect.x + viewportRect.width;
  const vTop = viewportRect.y;
  const vBottom = viewportRect.y + viewportRect.height;

  if (cy < vTop) return "above";
  if (cy > vBottom) return "below";
  if (cx < vLeft) return "left";
  if (cx > vRight) return "right";
  return "in-view";
}
