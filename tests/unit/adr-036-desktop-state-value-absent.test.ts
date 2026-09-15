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
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
   * So the two hand-written renderings are fixed text — the two SHIPPED copies come from one
   * source now and are pinned in the cell below, not here. Any edit fails here and has to be made deliberately, which
   * is the point: this paragraph took fourteen rounds to stop claiming things the code cannot
   * support, and every round removed something — that the read tells you, that the hint's silence
   * means something, that a match settles it, that focusing first is enough, that the element can
   * be compared, that the value is predictable, that an empty field settles it, that `diff` has a
   * baseline, that a retry is free, that focus makes the next write confirmable, that a clear
   * resets, that a retry appends, that there is anything to do about it here, and finally the two
   * instructions that had framed it since before the first round.
   */
  it("keeps the two hand-written renderings exactly as measurement left them", () => {
    const EXPECTED: Record<string, string> = {
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

      // AND THERE IS ONLY ONE OF IT PER FILE. A first-match lookup cannot tell one copy from two,
      // and a second copy would be the one nobody edits (gate 1 P3, 2026-09-15).
      expect(
        text.indexOf(expected.slice(0, 40)),
        `${rel} carries more than one copy of the landing paragraph`,
      ).toBe(text.lastIndexOf(expected.slice(0, 40)));
    }
  });

  it("ships both copies from one source, and they differ only where they are meant to", async () => {
    // ONE SOURCE. Measured at `71d5a52`, just before this existed: the two shipped copies were
    // 1,019 and 1,008 characters with a 967-character identical run and FIVE differences, all in
    // the opening clause and the final mark — `A type/setValue` / `A type`, `ok=true` / `ok:true`,
    // `'landing'` / `landing`, a full stop / a semicolon. So one template with two voices
    // reproduces both exactly, and the proof this refactor owes is that NO SHIPPED BYTE MOVED:
    // `desktop_act.description.txt` is the fixture `tools/list` is compared against, and it did
    // not change.
    //
    // Why it is worth doing at all: a claim that reaches the caller twice can disagree with
    // itself, and did. The hint clause was hedged in both READMEs and unhedged in both of these
    // for a round; a round earlier, only one of them said what a retry does.
    const { landingAdvice, LANDING_ADVICE_TOOL_DESCRIPTION, LANDING_ADVICE_SERVER_INSTRUCTIONS } =
      await import("../../src/engine/landing-advice.js");
    const description = landingAdvice(LANDING_ADVICE_TOOL_DESCRIPTION);
    const instructions = landingAdvice(LANDING_ADVICE_SERVER_INSTRUCTIONS);

    // The two voices differ in exactly four places and nowhere else — a fifth divergence is how
    // the copies drifted apart by hand in the first place, so it has to be deliberate. Stated as
    // the slice rather than as a similarity score: a helper counting a shared head and tail
    // measured SIX here and said nothing, because the divergence is at both ends and the
    // agreement is in the middle.
    expect(description).not.toBe(instructions);
    const DESCRIPTION_HEAD = "A type/setValue that answers ok=true with 'landing' ";
    const INSTRUCTIONS_HEAD = "A type that answers ok:true with landing ";
    expect(description.startsWith(DESCRIPTION_HEAD), "the description's opening clause changed").toBe(true);
    expect(instructions.startsWith(INSTRUCTIONS_HEAD), "the instructions' opening clause changed").toBe(true);
    expect(
      description.slice(DESCRIPTION_HEAD.length),
      "the two voices diverge after the opening clause"
    ).toBe(`${instructions.slice(INSTRUCTIONS_HEAD.length, -1)}.`);
    expect(description.endsWith("."), "the description no longer ends in a full stop").toBe(true);
    expect(instructions.endsWith(";"), "the instructions entry no longer ends in a semicolon").toBe(true);

    // AND THE INSTRUCTIONS VOICE IS PINNED AGAINST A FIXTURE, because moving the text out of
    // `server-windows.ts` took it out of the source slice that used to hold it: that slice pins
    // the array AROUND the paragraph, and the paragraph is generated now. Found by mutation —
    // changing this voice's terminator left every cell green. `desktop_act`'s copy is covered by
    // the `tools/list` comparison below; this one cannot be, because that entry point does not
    // import on a non-Windows machine.
    // NORMALISED like every other fixture read in this file. It is safe today only because this
    // fixture is one line with no newline in it at all; the moment the paragraph gains an internal
    // newline, a CRLF checkout fails here and nowhere else — on the one machine that runs the suite
    // before a merge (gate 2, 2026-09-15, and win2 lived exactly that on 2026-09-14).
    expect(instructions, "the instructions voice changed").toBe(
      readFileSync(
        fileURLToPath(new URL("../fixtures/landing-paragraph/landing-advice.instructions.txt", import.meta.url)),
        "utf8"
      ).replace(/\r\n/g, "\n")
    );

    // AND EACH CALLER IS PINNED TO THE VOICE IT ASKS FOR. This cell evaluates its OWN import,
    // and the source fixture starts at `new McpServer(`, so the import lines sit between the two
    // and were checked by neither: aliasing
    // `LANDING_ADVICE_TOOL_DESCRIPTION as LANDING_ADVICE_SERVER_INSTRUCTIONS` in the server
    // changes what ships while every assertion above stays green (gate 1, 2026-09-15, reproduced
    // in memory). It is the same shape as the mutation that put the fixture here in the first
    // place — the refactor moved a thing out of the region its check covered.
    // READ AS CODE, NOT AS TEXT — because both text checks this cell had were beaten by text.
    //
    // The walk for "the paragraph exists once under src/" missed
    // `"THIS LANDING " + "IS A REPORT"`, and the alias guard missed
    // `LANDING_ADVICE_TOOL_DESCRIPTION /* voice */ as LANDING_ADVICE_SERVER_INSTRUCTIONS`,
    // whose comment its regex could not cross while the positive check accepted the alias's
    // local name (gate 1, 2026-09-15, both verified in memory, both leaving the served bytes
    // byte-identical in the first case and silently changed in the second).
    //
    // Enumerating the ways text can be written differently does not end; parsing it does. The
    // parser is the same one that compiles this repository, so the two cannot disagree about
    // what the source says.
    for (const [rel, voice] of [
      ["src/tools/desktop-register.ts", "LANDING_ADVICE_TOOL_DESCRIPTION"],
      ["src/server-windows.ts", "LANDING_ADVICE_SERVER_INSTRUCTIONS"],
    ] as const) {
      const file = fileURLToPath(new URL(`../../${rel}`, import.meta.url));
      const source = ts.createSourceFile(rel, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);

      // 1. It is IMPORTED UNDER ITS OWN NAME from the shared module. `propertyName` is what an
      //    `as` gives us: when it is set, the local name is an alias, and the pair is what a
      //    comment cannot hide.
      const imported: Array<{ from: string; local: string }> = [];
      const visitImports = (node: ts.Node): void => {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text.endsWith("landing-advice.js")
        ) {
          const bindings = node.importClause?.namedBindings;
          if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const spec of bindings.elements) {
              imported.push({ from: (spec.propertyName ?? spec.name).text, local: spec.name.text });
            }
          }
        }
        ts.forEachChild(node, visitImports);
      };
      visitImports(source);
      expect(imported.length, `${rel} imports nothing from landing-advice`).toBeGreaterThan(0);
      for (const { from, local } of imported) {
        expect(local, `${rel} imports ${from} under the name ${local}`).toBe(from);
      }
      expect(
        imported.map((i) => i.local).sort(),
        `${rel} does not import exactly landingAdvice and ${voice}`
      ).toEqual(["landingAdvice", voice].sort());

      // 2. The call is a CALL, with that voice as its only argument — the expression, not a
      //    string that looks like it. A literal restored beside a commented-out call passes
      //    every text check and fails this one.
      const calls: string[] = [];
      const visitCalls = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "landingAdvice"
        ) {
          calls.push(node.arguments.map((a) => a.getText(source)).join(", "));
        }
        ts.forEachChild(node, visitCalls);
      };
      visitCalls(source);
      expect(calls, `${rel} no longer calls landingAdvice(${voice}) exactly once`).toEqual([voice]);

      // 3. AND THE PARAGRAPH IS NOWHERE IN ITS STRING LITERALS. Adjacent literals joined by `+`
      //    are folded first, which is what the text walk could not do.
      const texts: string[] = [];
      const fold = (node: ts.Node): string | undefined => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
          const left = fold(node.left);
          const right = fold(node.right);
          if (left !== undefined && right !== undefined) return left + right;
        }
        return undefined;
      };
      const visitStrings = (node: ts.Node): void => {
        const folded = fold(node);
        if (folded !== undefined) texts.push(folded);
        else ts.forEachChild(node, visitStrings);
      };
      visitStrings(source);
      expect(
        texts.filter((t) => t.includes("THIS LANDING IS A REPORT")),
        `${rel} carries the paragraph in a string literal again`
      ).toEqual([]);
    }

    // AND NO OTHER FILE UNDER `src/` CARRIES IT EITHER. The two call sites are parsed above; this
    // walks the rest, so a third carrier appearing anywhere is caught rather than assumed absent.
    // A list of the files one expects to carry it could not notice a new one.
    const srcRoot = fileURLToPath(new URL("../../src", import.meta.url));
    const carriers = [...walkSource(srcRoot)]
      .filter((file) => readFileSync(file, "utf8").includes("THIS LANDING IS A REPORT"))
      .map((file) => file.slice(srcRoot.length + 1).replace(/\\/g, "/"))
      .sort();
    expect(carriers, "the landing paragraph is written in more than one place under src/").toEqual([
      "engine/landing-advice.ts",
    ]);
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
   *   - `server-windows.instructions.txt` — the whole `new McpServer(...)` call, sliced from source.
   *     That entry point cannot be imported here (it is the Windows server, with top-level awaits on
   *     native modules), so this side is source text. THAT THE SOURCE SLICE IS WHAT SHIPS WAS AN
   *     ASSUMPTION UNTIL 2026-09-15: win2 extracted the array from this slice, joined it the way
   *     production does, and compared it to what a real Windows server puts on the wire — byte
   *     identical at all four corners (`2658e49`). The unit stays the source slice, which is WIDER
   *     than the wire string (it catches a spread, or a second options key, that the wire would only
   *     show as a replacement); what was missing was the correspondence, and that is now measured.
   *     The two tool descriptions were checked the same way in the same run: 8/8 byte identical.
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

    // 4. AND AN INVENTORY OF THE DOCUMENTS THAT SPEAK ABOUT AN UNCONFIRMED LANDING — A DETECTOR,
    //    NOT A GUARANTEE, and the difference is written here so the next reader does not inherit the
    //    mistake the rest of this cell already made once. Pinning surfaces cannot see a new one
    //    appear, and gate 1 found one that had been there all along: `docs/system-overview.md` told
    //    its readers a landing-bearing `type` "was sent", the claim removed from the other four
    //    ([[the-same-defect-has-three-audiences]] — the envelope, the record and the memory).
    //
    //    WHAT IT ACTUALLY MATCHES is `landing` within 80 characters of `confirmed`, over TRACKED
    //    markdown. That covers the serialisations the documents use (`confirmed: false`,
    //    `"confirmed": false`, "`landing.confirmed` is false"), and it will not catch a document
    //    that describes the same state in words that use neither token. Enumerating spellings does
    //    not end; the root is that the paragraph is copied by hand instead of generated from one
    //    source, and that is filed rather than fixed here.
    //
    //    TRACKED, via `git ls-files`: walking the working tree made this gate depend on whatever
    //    untracked markdown a developer happens to have, so the same commit could fail in one
    //    checkout and pass in a clean clone (gate 1, 2026-09-15).
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const tracked = execFileSync("git", ["ls-files", "-z", "*.md"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter((f) => f.length > 0 && !f.startsWith("tests/"));
    const docs = tracked
      .filter((f) => /landing[\s\S]{0,80}confirmed/i.test(readFileSync(join(root, f), "utf8")))
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
 * Every `.ts` file under a directory. Used to assert the landing paragraph exists ONCE in the
 * source: a list of the files one expects to carry it could not notice a new one, which is the
 * failure this assertion exists to prevent.
 */
function* walkSource(root: string): Generator<string> {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
      else if (entry.name.endsWith(".ts")) yield join(dir, entry.name);
    }
  }
}
