/**
 * internal #371 — not pasting into the Windows Terminal tab this server's client runs in. The pieces
 * (ancestor walk, helper output, name comparison) and `readWtTab`'s rule: refuse only when the tab is
 * known to be the client's; when that cannot be read, paste and say so (the maintainer's rule).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(import("../../src/engine/win32.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  buildProcessParentMap: vi.fn(() => new Map<number, number>()),
  getProcessIdentityByPid: vi.fn(() => ({ pid: 0, processName: "", processStartTimeMs: 0 })),
}));

import { _resetOwnTabTitleCache, ancestorsBelowWt, helperScript, normalizeTabName, ownTabTitle, parseHelperOutput, type OwnTabTitle } from "../../src/engine/wt-own-tab.js";
import * as win32 from "../../src/engine/win32.js";
import { readWtTab, wtRefusalSentence, type WtCheckDeps } from "../../src/tools/_wt-terminal-checks.js";

describe("normalizeTabName", () => {
  it.each([
    ["◐ win2", "win2"],
    ["✳ win2", "win2"],
    ["win2", "win2"],
    ["  ⠋  Claude Code", "Claude Code"],
    ["◐ ", ""],
  ])("%j → %j", (name, want) => {
    expect(normalizeTabName(name)).toBe(want);
  });
});

describe("ancestorsBelowWt", () => {
  // win2's chain: node(launcher) ← cmd ← node(npx) ← cmd ← claude.exe ← pwsh ← WindowsTerminal.exe
  const parents = new Map([[10, 11], [11, 12], [12, 13], [13, 14], [14, 15], [15, 16], [16, 17]]);
  const names = new Map([[10, "node"], [11, "cmd"], [12, "node"], [13, "cmd"], [14, "claude"], [15, "pwsh"], [16, "WindowsTerminal"], [17, "explorer"]]);
  it("lists the ancestors below the first WindowsTerminal, nearest first", () => {
    expect(ancestorsBelowWt(10, (p) => parents.get(p), (p) => names.get(p) ?? "")).toEqual([10, 11, 12, 13, 14, 15]);
  });
  it("answers null when no ancestor is Windows Terminal (a classic console, or no terminal)", () => {
    const n = new Map(names); n.set(16, "conhost");
    expect(ancestorsBelowWt(10, (p) => parents.get(p), (p) => n.get(p) ?? "")).toBeNull();
  });
  it("also matches the .exe spelling", () => {
    const n = new Map(names); n.set(16, "WindowsTerminal.exe");
    expect(ancestorsBelowWt(10, (p) => parents.get(p), (p) => n.get(p) ?? "")).toHaveLength(6);
  });
});

describe("the helper", () => {
  const b64 = (s: string) => Buffer.from(s, "utf16le").toString("base64");
  it("tries the pids in the order given", () => {
    expect(helperScript([15, 14, 10])).toContain("foreach ($p in @(15,14,10))");
  });
  it("takes only a console whose window belongs to a Windows Terminal window (gate 2 on #941)", () => {
    expect(helperScript([1])).toContain("-ne 'CASCADIA_HOSTING_WINDOW_CLASS'");
  });
  it("prints only ASCII: the title as base64 of UTF-16, not through the console code page (gate 2 on #941)", () => {
    const s = helperScript([1]);
    expect(s).toContain("[Text.Encoding]::Unicode.GetBytes");
    expect(s).not.toContain("ConvertTo-Json");
    expect(s).not.toMatch(/OutputEncoding/);
  });
  it.each(["✳ win2", "◐ 作業", "PowerShell"])("reads the title %j back exactly", (title) => {
    expect(parseHelperOutput(`{"pid":15,"title16":"${b64(title)}"}`)).toEqual({ state: "title", title });
  });
  it.each<[string, OwnTabTitle["state"]]>([
    ['{"none":true}', "unknown"],
    ["", "unknown"],
    ["???", "unknown"],
  ])("reads %j as %s", (out, state) => {
    expect(parseHelperOutput(out).state).toBe(state);
  });
  it("reads a symbol-only title as unknown", () => {
    expect(parseHelperOutput(`{"pid":15,"title16":"${b64("◐ ")}"}`).state).toBe("unknown");
  });
});

describe("readWtTab and the client's own tab", () => {
  const deps = (own: OwnTabTitle | Error, name = "◐ win2"): WtCheckDeps => ({
    tabReaderAvailable: () => true,
    getSelectedTab: async () => ({ name, runtimeId: "rt-1", paneCount: 1 }),
    ownTabTitle: async () => { if (own instanceof Error) throw own; return own; },
  });

  it("refuses the client's tab, whichever status symbol either side shows", async () => {
    const r = await readWtTab(1n, deps({ state: "title", title: "✳ win2" }, "◐ win2"));
    expect(r).toEqual({ ok: false, why: "own_tab", tabName: "◐ win2" });
    expect(wtRefusalSentence("own_tab", { tabName: "◐ win2" })).toMatch(/^Nothing was typed: .*the name of the tab this server's client runs in \("◐ win2"\)/);
  });

  it("passes another tab", async () => {
    const r = await readWtTab(1n, deps({ state: "title", title: "✳ win2" }, "PowerShell"));
    expect(r).toEqual({ ok: true, tab: expect.objectContaining({ name: "PowerShell" }) });
  });

  it("passes without a note when the server is not inside Windows Terminal", async () => {
    const r = await readWtTab(1n, deps({ state: "not_in_wt" }));
    expect(r.ok && r.note).toBeFalsy();
  });

  it.each<[string, OwnTabTitle | Error]>([
    ["the helper failed", { state: "unknown", why: "the helper failed (ETIMEDOUT)" }],
    ["the reader threw", new Error("boom")],
  ])("pastes, with a note, when %s (the maintainer's escape hatch)", async (_, own) => {
    const r = await readWtTab(1n, deps(own));
    expect(r.ok).toBe(true);
    expect(r.ok && r.note).toMatch(/could not be checked/);
  });

  it("does not refuse when the client's title is only a status symbol", async () => {
    const r = await readWtTab(1n, deps({ state: "title", title: "◐ " }, "◐ "));
    expect(r.ok).toBe(true);
  });

  it("refuses a split tab before asking whose tab it is", async () => {
    let asked = false;
    const r = await readWtTab(1n, {
      tabReaderAvailable: () => true,
      getSelectedTab: async () => ({ name: "win2", runtimeId: "rt-1", paneCount: 2 }),
      ownTabTitle: async () => { asked = true; return { state: "title", title: "win2" }; },
    });
    expect(r).toEqual({ ok: false, why: "tab_split" });
    expect(asked).toBe(false);
  });
});

describe("ownTabTitle", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    _resetOwnTabTitleCache();
  });
  const asWindows = () => Object.defineProperty(process, "platform", { ...platform, value: "win32" });

  it("is unknown, not 'not inside WT', when the process list cannot be read (agy on #941)", async () => {
    asWindows();
    vi.mocked(win32.buildProcessParentMap).mockReturnValue(new Map());
    expect((await ownTabTitle()).state).toBe("unknown");
  });

  it("is 'not inside WT' when the ancestors end without Windows Terminal", async () => {
    asWindows();
    vi.mocked(win32.buildProcessParentMap).mockReturnValue(new Map([[process.pid, 4242]]));
    vi.mocked(win32.getProcessIdentityByPid).mockReturnValue({ pid: 0, processName: "explorer", processStartTimeMs: 0 });
    expect(await ownTabTitle()).toEqual({ state: "not_in_wt" });
  });

  it("keeps an answer for a while (one walk for two calls)", async () => {
    asWindows();
    vi.mocked(win32.buildProcessParentMap).mockClear().mockReturnValue(new Map([[process.pid, 4242]]));
    let t = 1_000;
    await ownTabTitle(() => t);
    t += 5_000;
    await ownTabTitle(() => t);
    expect(win32.buildProcessParentMap).toHaveBeenCalledTimes(1);
    t += 20_000;
    await ownTabTitle(() => t);
    expect(win32.buildProcessParentMap).toHaveBeenCalledTimes(2);
  });
});
