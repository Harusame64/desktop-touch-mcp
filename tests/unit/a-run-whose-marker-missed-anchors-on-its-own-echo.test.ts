/**
 * internal #241 — terminal(action:'run', until:pattern) ended `baseline_lost` after 15 s although the
 * command had run: the baseline marker (a hash of the 256 chars before the send) was not found again,
 * so the pattern was never matched. Without the marker, the run anchors on its own echoed command,
 * counted against the text before the send.
 */
import { describe, expect, it } from "vitest";
import { scanRegionAfterOwnEcho } from "../../src/tools/terminal.js";

const CMD = "npm test; echo DONE";

describe("scanRegionAfterOwnEcho (internal #241)", () => {
  it("defers until this run's echo appears, so an earlier run of the same command cannot match", () => {
    // Three earlier runs of the same command, each with its DONE, are in the text before the send.
    const before = [1, 2, 3].map((n) => `PS C:\\> ${CMD}\nrun ${n}\nDONE`).join("\n") + "\nPS C:\\>";
    // The prompt was redrawn (the marker missed), and this run's echo has not rendered yet.
    const redrawn = before.replace(/PS C:\\>$/, "PS C:\\Users>");
    expect(scanRegionAfterOwnEcho(redrawn, before, CMD)).toBeUndefined();
  });

  it("returns what follows this run's echo once it has rendered", () => {
    const before = `PS C:\\> ${CMD}\nold\nDONE\nPS C:\\>`;
    const after = `PS C:\\> ${CMD}\nold\nDONE\nPS C:\\Users> ${CMD}\nnew output\nDONE`;
    expect(scanRegionAfterOwnEcho(after, before, CMD)).toBe("\nnew output\nDONE");
  });

  it("works when the command was not in the text before at all", () => {
    expect(scanRegionAfterOwnEcho(`banner\nPS> ${CMD}\nok\nDONE`, "banner\nPS>", CMD)).toBe("\nok\nDONE");
  });

  it("does not anchor input it cannot locate safely: multiline, blank, or not echoed", () => {
    const after = `PS> a\nPS> b\nout`;
    expect(scanRegionAfterOwnEcho(after, "", "a\nb")).toBeUndefined();
    expect(scanRegionAfterOwnEcho(after, "", "   ")).toBeUndefined();
    expect(scanRegionAfterOwnEcho(after, "", "a", false)).toBeUndefined();
  });

  it("compares normalised text (CRLF and trailing spaces), as the marker path does", () => {
    expect(scanRegionAfterOwnEcho(`PS> ${CMD}   \r\nok\r\n`, "PS>", CMD)).toBe("\nok");
  });
});
