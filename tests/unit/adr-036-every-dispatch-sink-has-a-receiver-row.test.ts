/**
 * Every `logDispatchSink` in `keyboard.ts` has a receiver row beside it, and they agree on the rung.
 *
 * **This cell exists because a mislabel shipped and nothing could see it** (gate 2, 2026-09-16): the
 * clipboard rung was probed as `clipboard_flash`, which is a DIFFERENT channel in the same file —
 * the foreground-flash road, already probed separately. The sink it sits beside is
 * `clipboard_paste`. `KeyboardRung`'s docstring says the rungs are "named the way `logDispatchSink`
 * names them", and every other member was.
 *
 * The cells for the probe itself call the helper directly with hand-built rows, so none of the ten
 * call sites that feed it were pinned: the `rung` literal, the guard, the receiver expression. This
 * one reads the source, because the property is ABOUT the source — that each place the tool records
 * a dispatch also records who received it, under the same name.
 *
 * It is a weak check in the sense that it cannot run the code. It is a real one in the sense that it
 * turns red for the defect that shipped, which is the only test that matters for a cell like this.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src/tools/keyboard.ts");

interface Site { line: number; sink: string; rung: string | null; }

/**
 * Pair each `logDispatchSink({ sink: X …})` with the first `rung: "Y"` that follows it within a few
 * lines — which is where the wiring convention puts it, and where a future edit would put it too.
 */
function sites(): Site[] {
  const lines = readFileSync(SRC, "utf8").split("\n");
  const out: Site[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /logDispatchSink\(\{\s*sink:\s*"([a-z_]+)"/.exec(lines[i]);
    if (!m) continue;
    let rung: string | null = null;
    for (let j = i + 1; j < Math.min(i + 16, lines.length); j++) {
      if (/logDispatchSink\(/.test(lines[j])) break;
      const r = /rung:\s*"([a-z_]+)"/.exec(lines[j]);
      if (r) { rung = r[1]; break; }
    }
    out.push({ line: i + 1, sink: m[1], rung });
  }
  return out;
}

describe("the keyboard tool's dispatch sites", () => {
  it("has the sites this round wired — a new one arriving unwired should fail here", () => {
    // Not a magic number for its own sake: it is the count the arm-A round measured against, and a
    // rung added later without a receiver row is exactly the thing this file exists to catch.
    expect(sites().length).toBe(10);
  });

  it("writes a receiver row beside every one of them", () => {
    expect(sites().filter((s) => s.rung === null)).toEqual([]);
  });

  it("names the rung exactly as the sink names the channel", () => {
    // THE DEFECT THAT SHIPPED. `clipboard_paste` was probed as `clipboard_flash` — a name that is
    // live in this same file for the foreground-flash road, so the rows read as the opposite rung
    // and a join on the name would have dropped them.
    expect(sites().map((s) => `${s.sink}=${s.rung}`).filter((p) => {
      const [sink, rung] = p.split("=");
      return sink !== rung;
    })).toEqual([]);
  });
});
