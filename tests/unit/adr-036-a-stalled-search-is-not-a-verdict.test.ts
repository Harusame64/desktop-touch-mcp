/**
 * internal #147 — a title search that could not read every window must not answer "the window is
 * not there".
 *
 * MEASURED 2026-09-21 win2 (`dev/route-check/pr-a/RESULTS-147-currentname.md`), one hung window on
 * the desktop: `FindAll` took 15022 ms (19 ms before the hang, 12 ms after) and the hung row took
 * 10014 ms, then answered `ok` with an EMPTY name — which matches no title pattern, so the loop
 * walked past it and the script printed "Window not found" about a window that was on the screen.
 * `getUiElements` with a 30 s budget reached that verdict in 33386 ms.
 *
 * TWO THINGS THE MACHINE KILLED BEFORE THIS FIX WAS WRITTEN, and both are why these cells look the
 * way they do:
 *
 *   - The first design wrapped the row read in `try/catch` and counted failures. **There are no
 *     exceptions on that path** — the count would have been zero and the fix a no-op that reported
 *     success.
 *   - The second idea was to treat an empty name as the signal. **A nameless window answers `ok`
 *     with an empty string in ONE millisecond** on the same desktop, identical in value to the hung
 *     one. Only time separates them.
 *
 * So the discriminator is time, in two places (the enumeration and the worst row), and the
 * threshold lives here rather than inside a PowerShell string, where no cell could hold it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const psOutputs: string[] = [];

vi.mock("node:child_process", () => ({
  execFile: (
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: (e: Error | null, r: { stdout: string; stderr: string }) => void,
  ) => {
    const queued = psOutputs.shift();
    if (queued === undefined) { cb(new Error("a script ran that this cell did not queue"), { stdout: "", stderr: "" }); return; }
    cb(null, { stdout: queued, stderr: "" });
  },
}));

// No addon: `getUiElements` then goes straight to the PowerShell road, which is the road that was
// measured lying. A build WITH the addon reaches the same script on a native throw.
vi.mock("../../index.js", () => ({ default: {} }));

vi.resetModules();
const { getUiElements, WindowSearchStalledError } = await import("../../src/engine/uia-bridge.js");

beforeEach(() => { psOutputs.length = 0; });

/** What the script prints when it walked the whole list and matched nothing. */
const notFound = (search?: { enumMs: number; rows: number; slowestRowMs: number }) =>
  JSON.stringify({ error: "Window not found", ...(search ? { search } : {}) });

const HEALTHY = { enumMs: 19, rows: 6, slowestRowMs: 4 };

describe("internal #147 — a stalled search is not a verdict", () => {
  it("still says the window is not there when the search was clean", async () => {
    // The control, and it has to come first: the fix must not turn every miss into a maybe.
    psOutputs.push(notFound(HEALTHY));
    await expect(getUiElements("Nothing", 3, 50, 10000)).rejects.toThrow(/Window not found/);
  });

  it("refuses to call a window missing when the ENUMERATION stalled", async () => {
    // 15022 ms is the measured enumeration cost with one hung window on the desktop — and the loop
    // never sees it, which is why an instrument on the rows alone explains ten of twenty-five
    // seconds.
    psOutputs.push(notFound({ enumMs: 15022, rows: 6, slowestRowMs: 4 }));
    await expect(getUiElements("Editor", 3, 50, 10000)).rejects.toThrow(WindowSearchStalledError);
  });

  it("refuses to call a window missing when one ROW stalled", async () => {
    // The other half of the cost, independently: a fast enumeration and one window that took ten
    // seconds to answer with nothing.
    psOutputs.push(notFound({ enumMs: 19, rows: 6, slowestRowMs: 10014 }));
    await expect(getUiElements("Editor", 3, 50, 10000)).rejects.toThrow(WindowSearchStalledError);
  });

  it("says what happened to the SEARCH, and never that the window is gone", async () => {
    psOutputs.push(notFound({ enumMs: 15022, rows: 6, slowestRowMs: 10014 }));
    const err = await getUiElements("Editor", 3, 50, 10000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WindowSearchStalledError);
    const detail = (err as InstanceType<typeof WindowSearchStalledError>).callerDetail;
    expect(detail).toMatch(/not a verdict/);
    expect(detail).toMatch(/not necessarily the one asked about/);
    // The sentence a caller acts on must not contain the claim this whole change exists to stop.
    expect(detail).not.toMatch(/Window not found/);
    expect((err as InstanceType<typeof WindowSearchStalledError>).search).toEqual({ enumMs: 15022, rows: 6, slowestRowMs: 10014 });
  });

  it("does not re-judge an error that is about something the script DID observe", async () => {
    // A stalled search does not make "Element not found" less true: the window answered, the
    // element was looked for, and only the window-miss arm is a claim about what was never read.
    psOutputs.push(JSON.stringify({ error: "Element not found", search: { enumMs: 15022, rows: 6, slowestRowMs: 10014 } }));
    await expect(getUiElements("Editor", 3, 50, 10000)).rejects.toThrow(/Element not found/);
  });

  it("reads a build with no numbers as the build it is, not as one that reported zero", async () => {
    // An older addon/script pair prints no `search` at all. Absence of the field is absence of
    // evidence — the honest answer is the one the script gave, not a stall nobody measured.
    psOutputs.push(notFound());
    await expect(getUiElements("Nothing", 3, 50, 10000)).rejects.toThrow(/Window not found/);
  });

  it("treats the threshold as a floor, not as a range", async () => {
    // Exactly at the constant: the measured populations are 4 ms and 10014 ms, so the only wrong
    // answer here is an off-by-one that lets a stall through.
    psOutputs.push(notFound({ enumMs: 1000, rows: 6, slowestRowMs: 4 }));
    await expect(getUiElements("Editor", 3, 50, 10000)).rejects.toThrow(WindowSearchStalledError);
    psOutputs.push(notFound({ enumMs: 999, rows: 6, slowestRowMs: 999 }));
    await expect(getUiElements("Editor", 3, 50, 10000)).rejects.toThrow(/Window not found/);
  });
});
