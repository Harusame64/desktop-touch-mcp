import type { UiEntity } from "./world-graph/types.js";

/**
 * internal #233 — the UIA control types a click selects rather than invokes (`selectCollectionItem`).
 * MenuItem and TabItem are not here: neither was measured, and a tab's Invoke is not a double-click.
 */
export const COLLECTION_ITEM_CONTROL_TYPES = ["ListItem", "DataItem", "TreeItem"] as const;

export type CollectionItemAdviceClass = "collection_item_select" | "collection_item_select_no_invoke";

/**
 * internal #291 — the advice class of a click on a collection item, or `undefined` for anything else.
 * On these items click_element's Invoke is the press a click avoids (Explorer opens the file, a grid cell
 * starts editing, a .NET 10 parent node expands without selecting), so a refusal of such a click must not
 * send the caller there. `_no_invoke` when discover read no InvokePattern on the item.
 */
export function collectionItemAdviceClass(entity: UiEntity, action: string): CollectionItemAdviceClass | undefined {
  if (action !== "click" || entity.controlType === undefined) return undefined;
  if (!(COLLECTION_ITEM_CONTROL_TYPES as readonly string[]).includes(entity.controlType)) return undefined;
  return (entity.patterns ?? []).includes("InvokePattern") ? "collection_item_select" : "collection_item_select_no_invoke";
}
