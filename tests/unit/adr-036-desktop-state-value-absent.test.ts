/**
 * adr-036-desktop-state-value-absent.test.ts — `desktop_state` says which ROAD left the value out.
 *
 * `focusedElement` comes from one of three roads, and two of them can name an element while
 * carrying no value: the perception view has no `value` field at all, and the CDP read
 * deliberately drops a masked one. Measured on Windows, those two produce output identical to an
 * empty field — 24 of 24 reads carried a value while the source hint said `uia`, 0 of 8 while it
 * said `view`, with the element's NAME the same in all thirty-two (win2, 2026-09-14).
 *
 * This file drives the handler itself, because the hint is wiring rather than projection: the two
 * assignments sit beside `hints.focusedElementSource`, and a pure-builder test cannot see them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { view, uiaFocus, cdpResult, fgTitle } = vi.hoisted(() => ({
  view: { value: null as unknown },
  uiaFocus: { value: null as unknown },
  cdpResult: { value: null as unknown },
  /** Chromium or not decides whether the CDP road is reachable at all. */
  fgTitle: { value: "Notepad" },
}));

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(() => [{
      hwnd: 4242n, title: fgTitle.value, isActive: true, zOrder: 0,
      isMinimized: false, isMaximized: false, className: "Notepad", ownerHwnd: null,
      region: { x: 0, y: 0, width: 800, height: 600 }, processName: "notepad.exe",
    }]),
    enumMonitors: vi.fn(() => [{ index: 0, isPrimary: true, region: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, dpi: 96 }]),
    getVirtualScreen: vi.fn(() => ({ x: 0, y: 0, width: 1920, height: 1080 })),
    getWindowProcessId: vi.fn(() => 1234),
    getProcessIdentityByPid: vi.fn(() => ({ pid: 1234, processName: "notepad.exe", processStartTimeMs: 900 })),
    getWindowIdentity: vi.fn(() => ({ pid: 1234, processName: "notepad.exe", processStartTimeMs: 900 })),
  };
});

vi.mock("../../src/engine/native-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/native-engine.js")>();
  return {
    ...actual,
    nativeViewFocus: { viewGetFocused: () => view.value },
    nativeWin32: undefined,
  };
});
vi.mock("../../src/engine/uia-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/uia-bridge.js")>();
  return { ...actual, getFocusedAndPointInfo: vi.fn(async () => ({ focused: uiaFocus.value, atPoint: null })) };
});
vi.mock("../../src/engine/cdp-bridge.js", () => ({
  evaluateInTab: vi.fn(async () => cdpResult.value),
  DEFAULT_CDP_PORT: 9222,
}));
vi.mock("../../src/engine/nutjs.js", () => ({
  mouse: { getPosition: async () => ({ x: 0, y: 0 }) },
}));

const { desktopStateHandler } = await import("../../src/tools/desktop-state.js");

function parse(result: { content: ReadonlyArray<{ type: string; text?: string }> }): Record<string, any> {
  return JSON.parse(result.content[0]?.text ?? "{}");
}

describe("ADR-036: desktop_state names the road that left the value out", () => {
  beforeEach(() => { view.value = null; uiaFocus.value = null; cdpResult.value = null; fgTitle.value = "Notepad"; });

  it("says so when the perception view answered, because that road has no value field at all", async () => {
    view.value = { name: "Notes", automationId: null, controlType: "Edit", windowTitle: "Notepad" };
    const out = parse(await desktopStateHandler({}) as never);
    expect(out.hints.focusedElementSource).toBe("view");
    expect(out.focusedElement).not.toHaveProperty("value");
    expect(out.hints.focusedElementValueAbsent).toBe("view_road_has_no_value");
  });

  it("says nothing when UIA answered with a value — the road that can carry one", async () => {
    uiaFocus.value = { name: "Notes", controlType: "Edit", value: "PROBE-ROAD" };
    const out = parse(await desktopStateHandler({}) as never);
    expect(out.hints.focusedElementSource).toBe("uia");
    expect(out.focusedElement.value).toBe("PROBE-ROAD");
    expect(out.hints).not.toHaveProperty("focusedElementValueAbsent");
  });

  it("says so when CDP dropped a masked field, which otherwise looks exactly like an empty one", async () => {
    // The measured hole: on this road a `type=password` box and a paragraph carrying only a
    // `tabindex` produce identical output. The script substitutes an empty value for the first,
    // and the projection drops an empty one either way — so the row cannot say which it saw.
    fgTitle.value = "Sign in - Google Chrome";
    cdpResult.value = { tag: "INPUT", id: "pw", name: "pw", value: "", masked: true, text: "" };
    const out = parse(await desktopStateHandler({}) as never);
    expect(out.hints.focusedElementSource).toBe("cdp");
    expect(out.focusedElement).not.toHaveProperty("value");
    expect(out.hints.focusedElementValueAbsent).toBe("masked_on_this_road");
  });

  it("says nothing on the same road when the field was not masked — the pairing that makes the row above mean something", async () => {
    fgTitle.value = "Sign in - Google Chrome";
    cdpResult.value = { tag: "INPUT", id: "user", name: "user", value: "PROBE-CDP", masked: false, text: "" };
    const out = parse(await desktopStateHandler({}) as never);
    expect(out.hints.focusedElementSource).toBe("cdp");
    expect(out.focusedElement.value).toBe("PROBE-CDP");
    expect(out.hints).not.toHaveProperty("focusedElementValueAbsent");
  });

  /**
   * THE ADVICE THAT SENDS A CALLER HERE HAS TO SAY WHAT AN EMPTY ANSWER MEANS. Two shipped
   * strings tell a caller whose background write was not confirmed to "read the field back before
   * relying on it". Measured in both directions (win2, `a23bda2`): a window whose title does not
   * change keeps matching its recorded focus row, so the read can be answered from the perception
   * view, which carries no value at all — the field comes back empty even though the write landed,
   * and a caller reads that as proof it did not. Renaming that same window from OUTSIDE, with no
   * keystroke and no focus move, puts the value back; renaming it to its old title takes it away.
   *
   * The condition is the application's, not the caller's, so the advice cannot be met by trying
   * harder — it can only be read correctly. And the advice keys on the HINT rather than on the
   * title, because a fixed title does not guarantee the view road either: the other filters can
   * reject a matching row and fall through to UIA or CDP, where a value may be there. Both copies
   * must name the hint that distinguishes "no value on this road" from "the field is empty".
   */
  /**
   * THE WHOLE PARAGRAPH, PINNED, because "contains no instruction" cannot be checked by listing
   * the instructions one has already thought of. The previous form enumerated five phrases, and
   * gate 1 walked through it with `Retry the write now.` — every required substring present,
   * every forbidden one absent, green. The READMEs were not in that loop at all.
   *
   * So the four copies are fixed text. Any edit fails here and has to be made deliberately, which
   * is the point: this paragraph took fourteen rounds to stop claiming things the code cannot
   * support, and every round removed something — that the read tells you, that the hint's silence
   * means something, that a match settles it, that focusing first is enough, that the element can
   * be compared, that the value is predictable, that an empty field settles it, that `diff` has a
   * baseline, that a retry is free, that focus makes the next write confirmable, that a clear
   * resets, that a retry appends, that there is anything to do about it here, and finally the two
   * instructions that had framed it since before the first round.
   */
  it("keeps all four copies of the landing paragraph exactly as measurement left them", () => {
    const EXPECTED: Record<string, string> = {
      "src/tools/desktop-register.ts":
        "A type/setValue that answers ok=true with 'landing' {confirmed:false, why} took the background write route but was not confirmed to have reached the field named. THIS LANDING IS A REPORT, not a state that can be resolved here: nothing on this response establishes whether the characters arrived; reading the field back does not settle it (`desktop_state` answers about the FOREGROUND, from a sticky focus row that can name a field in another window with the same title, and it may carry no value at all — `hints.focusedElementValueAbsent` names the road that dropped it, `view_road_has_no_value` or `masked_on_this_road`, and NO hint is not evidence that a value was there: on the UIA road a provider that serves none leaves an absent value with no hint); `diff.value_changed` is not delivery either, its baseline being your `desktop_discover` snapshot rather than the write; and retrying a nonempty write is not a repeat, because a background write lands at the caret and replaces the selection exactly as typing does.",
      "src/server-windows.ts":
        "  keyboard_target_unsafe → the background write would not have reached the field this act named — the focus is on a different control or in a different window, or the receiving control does not take typed text — so nothing was typed. Put the focus on the field you named, then type again — if_unexpected.detail names the ground and the way back for the road this act took: on a window named by title, desktop_act(action='click') on the same entity does it; on a window named by handle no route here focuses a text field yet, so re-call desktop_discover by the window's title and click it from there (a common dialog's title resolves to a handle as well, so that road does not open there). For other_window, bring the field's window forward first (focus_window) — it comes forward with the focus it last had, and the window holding the focus is usually over the field, which makes a click answer aim_occluded; do NOT type through the foreground instead, whatever holds the focus would take the characters. A type that answers ok:true with landing {confirmed:false, why} took the background write route but was not confirmed to have reached the field named. THIS LANDING IS A REPORT, not a state that can be resolved here: nothing on this response establishes whether the characters arrived; reading the field back does not settle it (`desktop_state` answers about the FOREGROUND, from a sticky focus row that can name a field in another window with the same title, and it may carry no value at all — `hints.focusedElementValueAbsent` names the road that dropped it, `view_road_has_no_value` or `masked_on_this_road`, and NO hint is not evidence that a value was there: on the UIA road a provider that serves none leaves an absent value with no hint); `diff.value_changed` is not delivery either, its baseline being your `desktop_discover` snapshot rather than the write; and retrying a nonempty write is not a repeat, because a background write lands at the caret and replaces the selection exactly as typing does;",
      "README.md":
        "A successful `type` can carry `landing: { confirmed: false, why }`. The write took the background route, but the server could not confirm that it reached the field you named — for example, in a WPF window, whose fields have no window of their own. **This is a report, not a state that can be resolved here**: nothing in the response establishes whether the characters arrived, reading the field back does not settle it (`desktop_state` answers about the foreground, and may come back with no value at all — `hints.focusedElementValueAbsent` names the road that dropped it, `view_road_has_no_value` or `masked_on_this_road`, and no hint is not evidence a value was there — or name a field in another window with the same title), `diff.value_changed` is not delivery either, its baseline being your `desktop_discover` snapshot rather than the write, and retrying a nonempty write is not a repeat — a background write lands at the caret and replaces the selection, exactly as typing does.",
      "README.ja.md":
        "成功した `type` に `landing: { confirmed: false, why }` が付くことがある。書き込みは背景の経路を通ったが、指定した欄に届いたことをサーバが確かめられなかった（例: WPF のウィンドウは欄ごとのウィンドウを持たない）。**これは報告であり、ここで解消できる状態ではない**——応答の中に文字が届いたかを示すものは無く、欄を読み返しても決着しない（`desktop_state` は前面について答え、値を一切返さないことも、同じ題の別の窓の欄を名乗ることもある。`hints.focusedElementValueAbsent` は落とした road を名乗る——`view_road_has_no_value` か `masked_on_this_road`。**hint が無いことは値が在った証拠ではない**）。`diff.value_changed` も配達ではない——その基準は書き込みではなく `desktop_discover` のスナップショットである。そして**空でない書き込みの再試行は反復ではない**——背景の書き込みは打鍵と同じくキャレット位置に入り、選択を置換する。",
    };
    for (const [rel, expected] of Object.entries(EXPECTED)) {
      // NORMALISE LINE ENDINGS FIRST. Only `.githooks/**` is pinned to LF in `.gitattributes`, so
      // on a Windows checkout with core.autocrlf=true the READMEs come back CRLF and a slice that
      // ends at "\n" keeps a trailing "\r" — the cell passed on CI and on macOS and failed on the
      // one machine that runs it before a merge (win2, 2026-09-14). CI proves nothing here either:
      // the unit job in `.github/workflows/ci.yml` is commented out.
      const text = readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8")
        .replace(/\r\n/g, "\n");
      const start = text.indexOf(expected.slice(0, 40));
      expect(start, `${rel} no longer opens the landing paragraph the same way`).toBeGreaterThan(-1);
      if (rel.startsWith("src/")) {
        // Quote to quote over the whole literal, not from the paragraph's own opening words:
        // anchoring there left everything BEFORE it unpinned inside the same literal, and gate 2
        // walked `Retry the write now.` in at the head of the `keyboard_target_unsafe` bullet with
        // the cell green (2026-09-14).
        //
        // THE LITERAL IS NOT THE SHIPPED UNIT, and saying it was is what let the next hole stand:
        // both descriptions are `[...].join(...)`, so a SIBLING element added next to this one
        // ships to the same caller with every assertion in this cell green. Both gates reproduced
        // it independently on 2026-09-15, in both source files. This cell pins the paragraph, and
        // the cell below pins the unit that ships around it — neither is enough alone.
        const open = text.lastIndexOf('"', start);
        const end = text.indexOf('",', start);
        expect(open, `${rel}: the landing paragraph's string literal has no opening quote`).toBeGreaterThan(-1);
        expect(end, `${rel}: the landing paragraph's string literal is not terminated`).toBeGreaterThan(start);
        expect(text.slice(open + 1, end), `${rel}'s shipped string changed`).toBe(expected);
      } else {
        const end = text.indexOf("\n", start);
        expect(end, `${rel}: the landing paragraph does not end a line`).toBeGreaterThan(start);
        expect(text.slice(start, end), `${rel}'s landing paragraph changed`).toBe(expected);
        // AND IT IS ITS OWN BLOCK, blank line above and below. `end` stops at the newline, so an
        // instruction added on the next line is invisible to the comparison above — gate 2 put the
        // deleted Japanese read-back sentence back that way and the cell stayed green.
        expect(text.slice(start - 2, start), `${rel}: something was added directly above the paragraph`).toBe("\n\n");
        expect(text.slice(end, end + 2), `${rel}: something was added directly below the paragraph`).toBe("\n\n");
        // AND ADJACENCY IS NOT ABSENCE: an instruction one blank line further out is a separate
        // paragraph, ships to the same reader, and passes both lines above (win2 and gate 1, both
        // 2026-09-15). The section pin below is what answers that.
      }
      // AND THERE IS ONLY ONE OF IT PER FILE. A first-match lookup cannot tell one copy from two,
      // and a second copy would be the one nobody edits (gate 1 P3, 2026-09-15).
      expect(
        text.indexOf(expected.slice(0, 40)),
        `${rel} carries more than one copy of the landing paragraph`,
      ).toBe(text.lastIndexOf(expected.slice(0, 40)));
    }
  });

  /**
   * THE UNIT THAT SHIPS, pinned whole — because the cell above cannot assert an absence.
   *
   * What the caller receives is not the string literal: it is `[...].join(" ")` for the tool
   * description, `[...].join("\n")` for the server instructions, and the rendered section for a
   * README. Every one of those has room next to the paragraph that the literal-level pin does not
   * see, and on 2026-09-15 both review gates, independently, walked the same sentence in through
   * it — `Retry the write now.` as a sibling array element immediately before the pinned literal,
   * in both source files, with the cell above green. win2 had already measured the README half of
   * the same hole from the other side: an instruction added as its own paragraph, one blank line
   * further out, ships and passes.
   *
   * So the unit here is the whole shipped surface, and the fixtures under
   * `tests/fixtures/landing-paragraph/` are what it is expected to be, byte for byte:
   *
   *   - `desktop_act.description.txt` — ASSEMBLED AT RUNTIME by registering the real tools on a
   *     recording server, so this is the string the client is handed and not a re-join of the
   *     source. (It matched win2's four-corner measurement of a running server exactly: 7,356
   *     characters before this round's edit.)
   *   - `server-windows.instructions.txt` — the `instructions:` array, sliced from source. That
   *     entry point cannot be imported here (it is the Windows server, with top-level awaits on
   *     native modules), so this side is source text and says so.
   *   - `README.section.md` / `README.ja.section.md` — the whole `## Standard workflow` section,
   *     heading to next heading.
   *
   * THE PRICE, STATED: any deliberate edit to those four surfaces reddens this cell, including
   * edits that have nothing to do with `landing`. That is the cost of asserting that nothing was
   * added, and there is no cheaper unit that can — every narrower one is a list of the insertions
   * somebody already thought of. Update the fixture in the same commit as the change.
   *
   * WHAT IT COVERS, SAID EXACTLY, because the previous version of this docstring claimed more than
   * it held and that is how the last hole survived: the two v2 tool descriptions as `tools/list`
   * serves them, the whole `new McpServer(...)` call that carries the instructions, and the ONE
   * section of each README that the paragraph is in. Outside that: another tool's description (the
   * V1 tools are registered elsewhere and are not read here), another section of either README, and
   * any prose that is not markdown. `docs/anti-fukuwarai-3x-supplement.md` §5.2 makes a read-back
   * claim and is annotated rather than pinned — it is a maintainers' document, not a shipped string.
   * The inventory assertion at the end is what notices a NEW document; nothing here notices a new
   * paragraph in an old section that the paragraph does not live in.
   */
  it("keeps the whole shipped unit around the landing paragraph, not only the paragraph", async () => {
    const fixture = (name: string): string =>
      readFileSync(fileURLToPath(new URL(`../fixtures/landing-paragraph/${name}`, import.meta.url)), "utf8")
        .replace(/\r\n/g, "\n");
    const source = (rel: string): string =>
      readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

    // 1. The tool description, as the client receives it.
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { registerDesktopTools } = await import("../../src/tools/desktop-register.js");
    const registered: Record<string, string> = {};
    const server = new McpServer({ name: "pin", version: "0.0.0" });
    const realTool = server.tool.bind(server);
    (server as unknown as { tool: unknown }).tool = (...args: unknown[]) => {
      if (typeof args[0] === "string" && typeof args[1] === "string") {
        registered[args[0]] = args[1] as string;
      }
      return (realTool as (...a: unknown[]) => unknown)(...args);
    };
    registerDesktopTools(server);
    expect(registered["desktop_act"], "desktop_act was not registered at all").toBeTypeOf("string");
    // AND WHAT REGISTRATION WAS HANDED IS NOT WHAT IS SERVED. `server.tool()` returns a handle with
    // `.update({ description })`, so a later line can change the advertised text while the recorded
    // argument keeps the fixture's value (gate 1, 2026-09-15, reproduced against the installed SDK).
    // So the assertion runs on the `tools/list` response — the same door the integration gate uses.
    const listTools = (server.server as unknown as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<{ tools: Array<{ name: string; description?: string }> }>>;
    })._requestHandlers.get("tools/list");
    expect(listTools, "this SDK no longer answers tools/list through _requestHandlers").toBeTypeOf("function");
    const listed = await listTools!({ method: "tools/list", params: {} }, { signal: new AbortController().signal });
    // BOTH V2 TOOLS, not only the one the paragraph lives in. `registerDesktopTools` hands the same
    // caller a `desktop_discover` description in the same session, and a sentence there contradicting
    // the paragraph two tools over ships with every other assertion here green (gate 2, 2026-09-15,
    // reproduced). The road this paragraph is about runs through both of them.
    for (const tool of ["desktop_act", "desktop_discover"] as const) {
      const served = listed.tools.find((t) => t.name === tool)?.description;
      expect(served, `${tool} is not in tools/list`).toBeTypeOf("string");
      expect(served, `the ${tool} description served by tools/list changed`).toBe(
        fixture(`${tool}.description.txt`),
      );
      expect(served, `tools/list serves something other than what registration handed for ${tool}`).toBe(
        registered[tool],
      );
    }

    // 2. The server instructions, from source — see the docstring for why this side is not runtime.
    //    THE UNIT IS THE WHOLE CONSTRUCTOR CALL, not the array inside it: a spread or a second key
    //    added after `.join("\n")` replaces what the SDK serves while an array-only pin stays green
    //    (gate 1, 2026-09-15).
    const sw = source("src/server-windows.ts");
    const open = sw.indexOf("  const s = new McpServer(\n");
    expect(open, "server-windows.ts no longer constructs the McpServer the way this pin reads it").toBeGreaterThan(-1);
    const close = sw.indexOf("\n  );\n", open);
    expect(close, "the McpServer constructor call is not terminated the way this pin reads it").toBeGreaterThan(open);
    expect(sw.slice(open, close + "\n  );\n".length), "the shipped instructions changed").toBe(
      fixture("server-windows.instructions.txt"),
    );

    // 3. The README sections, heading to next heading.
    for (const [rel, name, needle] of [
      ["README.md", "README.section.md", "A successful `type` can carry"],
      ["README.ja.md", "README.ja.section.md", "成功した `type` に `landing"],
    ] as const) {
      const text = source(rel);
      const at = text.indexOf(needle);
      expect(at, `${rel} no longer contains the landing paragraph`).toBeGreaterThan(-1);
      // STOP AT THE NEXT HEADING OF THE SAME LEVEL OR HIGHER, not at the next heading of any level.
      // Taking any heading as the end lets a new SUBheading be inserted just before the section's
      // real end: the slice above it stays byte-identical to the fixture while an instruction under
      // the new subheading ships in the same section (gate 1 on the PR, 2026-09-15).
      const headings = [...text.matchAll(/^(#{1,6}) .*$/gm)].map((m) => ({
        at: m.index ?? 0,
        level: m[1].length,
      }));
      const opened = headings.filter((h) => h.at < at).pop();
      expect(opened, `${rel}: the landing paragraph is not under a heading`).toBeTruthy();
      const closed = headings.find((h) => h.at > at && h.level <= (opened?.level ?? 1));
      expect(closed, `${rel}: the landing section is not closed by a heading of its own level`).toBeTruthy();
      expect(text.slice(opened?.at ?? 0, closed?.at ?? text.length), `${rel}'s landing section changed`).toBe(
        fixture(name),
      );
    }

    // 4. AND THE INVENTORY OF PROSE THAT SPEAKS ABOUT AN UNCONFIRMED LANDING. Pinning four surfaces
    //    cannot see a FIFTH one appearing, and gate 1 found one that had been there all along:
    //    `docs/system-overview.md` told its readers a landing-bearing `type` "was sent", which is
    //    the claim removed from the other four ([[the-same-defect-has-three-audiences]] — the
    //    envelope, the record and the memory). So the set of MARKDOWN files that mention an
    //    unconfirmed landing is fixed here: a new document reddens this and a human decides whether
    //    it needs the paragraph. Tests are excluded on purpose — they are not read as instructions.
    const docs = [...walkMarkdown(fileURLToPath(new URL("../..", import.meta.url)))]
      .filter((f) => /confirmed: ?false/.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(fileURLToPath(new URL("../..", import.meta.url)), "").replace(/\\/g, "/"))
      .sort();
    expect(docs, "a document that speaks about an unconfirmed landing was added or removed").toEqual([
      "README.ja.md",
      "README.md",
      "docs/system-overview.md",
    ]);
  });

  it("says nothing when a CDP field is simply empty, because nothing was withheld there", async () => {
    // The third shape on this road, and the reason the hint is not "there is no value": an empty
    // input is an empty input, and naming a reason there would read as "something was kept".
    fgTitle.value = "Sign in - Google Chrome";
    cdpResult.value = { tag: "INPUT", id: "empty", name: "empty", value: "", masked: false, text: "" };
    const out = parse(await desktopStateHandler({}) as never);
    expect(out.focusedElement).not.toHaveProperty("value");
    expect(out.hints).not.toHaveProperty("focusedElementValueAbsent");
  });
});

/**
 * Every tracked `.md` under the repository root, minus the fixtures this cell owns and anything
 * under `node_modules`. Used for the inventory assertion: the point is to notice a NEW document
 * speaking about an unconfirmed landing, so the walk must not be a list of the ones already known.
 */
function* walkMarkdown(root: string): Generator<string> {
  const skip = new Set(["node_modules", ".git", "target", "dist", "tests"]);
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) stack.push(join(dir, entry.name));
      } else if (entry.name.endsWith(".md")) {
        yield join(dir, entry.name);
      }
    }
  }
}
