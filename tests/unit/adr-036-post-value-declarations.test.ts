/**
 * adr-036-post-value-declarations.test.ts — the four registrations that tell the post layer which
 * arguments name a window, read from the production modules themselves.
 *
 * Gate 2 measured what happens without a file like this: deleting `{ windowTitleKey: "title" }`
 * from `focus_window` and `window_dock` left six related files and a hundred assertions green,
 * because every cell passed the keys by hand. Three of these declarations exist ONLY for the post
 * layer — none of these tools accepts `narrate` — so nothing else would notice their removal.
 *
 * Importing each module is the assertion: `withRichNarration` runs at module scope, so the keys
 * are recorded as the registration is built.
 */
import { describe, it, expect, vi } from "vitest";

const { mockPostKeys } = vi.hoisted(() => ({ mockPostKeys: vi.fn() }));
vi.mock("../../src/tools/_post.js", () => ({
  withPostState: (
    name: string,
    handler: (a: Record<string, unknown>) => Promise<unknown>,
    keys?: { windowTitleKey?: string; hwndKey?: string; supersedingKeys?: string[] },
  ) => {
    mockPostKeys(name, keys);
    return handler;
  },
  getHistorySnapshot: () => [],
  recordHistory: () => undefined,
}));

await import("../../src/tools/window.js");
await import("../../src/tools/window-dock.js");
await import("../../src/tools/terminal.js");
await import("../../src/tools/scroll.js");

/** What the post layer was told for one tool, or undefined if it was never registered. */
function keysFor(tool: string): Record<string, unknown> | undefined {
  const call = mockPostKeys.mock.calls.find((c) => c[0] === tool);
  return call?.[1] as Record<string, unknown> | undefined;
}

describe("ADR-036: the post layer is told which argument names a window, by the registration", () => {
  it("carries `title` for the two tools that call their destination that", () => {
    // Delete the declaration in `window.ts` / `window-dock.ts` and the post layer falls back to
    // `windowTitle`, which neither schema has — so the value silently stops being carried by the
    // tools whose whole job is naming a window.
    expect(keysFor("focus_window")).toMatchObject({ windowTitleKey: "title" });
    expect(keysFor("window_dock")).toMatchObject({ windowTitleKey: "title" });
  });

  it("carries the superseding selectors, which are the arguments that make a title meaningless", () => {
    // `terminal` branches on `paneId !== undefined` before reading the title; `scroll` takes the
    // CDP road on `selector` and never reads it. Without these, a stale title beside either
    // selector credits whatever window is in front with a field nobody touched.
    expect(keysFor("terminal")).toMatchObject({ windowTitleKey: "windowTitle", supersedingKeys: ["paneId"] });
    // Two names for the one thing: `to_element` calls it `selector`, `smart` calls it `target`.
    // Declaring only the first left the CDP road open under the other name.
    expect(keysFor("scroll")).toMatchObject({ windowTitleKey: "windowTitle", supersedingKeys: ["selector", "target"] });
  });
});
