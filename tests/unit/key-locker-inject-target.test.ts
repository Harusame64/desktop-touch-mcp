// ADR-014 v2 R3 Key Locker — L3 §4 InjectTarget assembly. Two concerns:
//   1. `titleFingerprint` is byte-identical to the C# locker's `Injection.cs` `TitleFp` — pinned
//      against expected hex computed INDEPENDENTLY with .NET (`[SHA256]::HashData(UTF8.GetBytes(t))`,
//      lowercased hex), so a divergence in the algorithm/encoding is caught here rather than as a
//      `target_mismatch` abort at inject time.
//   2. `assembleInjectTarget` reads consolePid/titleFp via win32 and declines (null) on a gone window.
// Plan: desktop-touch-mcp-internal@<plan>:docs/adr-014-v2-r3-l3-capture-plan.md (§4)
import { describe, expect, it, vi, beforeEach } from "vitest";

const getWindowProcessId = vi.fn<(hwnd: unknown) => number>();
const getWindowTitleW = vi.fn<(hwnd: unknown) => string>();

vi.mock("../../src/engine/win32.js", () => ({
  getWindowProcessId: (hwnd: unknown) => getWindowProcessId(hwnd),
  getWindowTitleW: (hwnd: unknown) => getWindowTitleW(hwnd),
}));

const { titleFingerprint, assembleInjectTarget } = await import(
  "../../src/engine/key-locker/inject-target.js"
);

// Expected values computed independently with .NET (the C# side):
//   [Convert]::ToHexString([SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($t))).ToLowerInvariant()
// The empty-string digest is the well-known SHA-256 of empty input.
const KNOWN_TITLE_FP: Array<[string, string]> = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["Administrator: Windows PowerShell", "d26d14f0263a47f3a31d10eb995fa1d073a63eb79c6f7502e3bd8902cd7ea13f"],
  ["ターミナル - pwsh", "154bdccbdbfb05d09049830ffafa8380f4b93e0d7487ad985978afbe54f69c57"],
  ["user@host:~/work$ ", "c3cdc582763da3938b23333ed6cb3f5dbe75808c7df035009ef9bbd945b6c6bb"],
];

describe("titleFingerprint — byte-identical to C# Injection.cs TitleFp", () => {
  for (const [title, expected] of KNOWN_TITLE_FP) {
    it(`sha256(utf8(${JSON.stringify(title)})) === ${expected.slice(0, 12)}…`, () => {
      expect(titleFingerprint(title)).toBe(expected);
    });
  }

  it("is lowercase hex (locker compares case-sensitively)", () => {
    const fp = titleFingerprint("MixedCase Title");
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("assembleInjectTarget — §4 pane target", () => {
  beforeEach(() => {
    getWindowProcessId.mockReset();
    getWindowTitleW.mockReset();
  });

  it("assembles {hwnd(decimal), consolePid, titleFp} from the SAME win32 reads the locker re-verifies", () => {
    getWindowProcessId.mockReturnValue(4242);
    getWindowTitleW.mockReturnValue("Administrator: Windows PowerShell");
    const t = assembleInjectTarget(0x1234n, false);
    expect(t).toEqual({
      hwnd: "4660", // 0x1234 in decimal — the InjectTarget.hwnd contract
      consolePid: 4242,
      titleFp: "d26d14f0263a47f3a31d10eb995fa1d073a63eb79c6f7502e3bd8902cd7ea13f",
    });
    // consolePid + titleFp both read from the SAME hwnd the caller passed.
    expect(getWindowProcessId).toHaveBeenCalledWith(0x1234n);
    expect(getWindowTitleW).toHaveBeenCalledWith(0x1234n);
  });

  it("emits submit:true only when requested (optional field otherwise omitted)", () => {
    getWindowProcessId.mockReturnValue(100);
    getWindowTitleW.mockReturnValue("t");
    expect(assembleInjectTarget(1n, true)).toMatchObject({ submit: true });
    expect(assembleInjectTarget(1n, false)).not.toHaveProperty("submit");
  });

  it("declines (null) when the window is gone / hwnd invalid (getWindowProcessId === 0)", () => {
    getWindowProcessId.mockReturnValue(0);
    getWindowTitleW.mockReturnValue("stale");
    expect(assembleInjectTarget(0xdeadn, true)).toBeNull();
    // A gone window must NOT round-trip a garbage target (sha256("") titleFp) to the locker.
    expect(getWindowTitleW).not.toHaveBeenCalled();
  });
});
