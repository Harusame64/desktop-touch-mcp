// ADR-014 R3 L3 §4 InjectTarget assembly, re-based on the S-pid PaneAnchor (S-pid gate §1/E3/E4).
// Three concerns:
//   1. `titleFingerprint` is byte-identical to the C# locker's `Injection.cs` `TitleFp` — pinned
//      against expected hex computed INDEPENDENTLY with .NET (`[SHA256]::HashData(UTF8.GetBytes(t))`,
//      lowercased hex), so a divergence in the algorithm/encoding is caught here rather than as a
//      `target_mismatch` abort at inject time.
//   2. classic: `assembleInjectTarget` reads consolePid/titleFp via win32 (decline (null) on a gone
//      window) AND carries the anchor's shellPid/shellStartMs VERBATIM onto the wire (the locker's
//      PRIMARY pid+creation-time re-verify).
//   3. wt: no window-derived field exists; the early decline requires the live creation time to
//      EXACTLY equal the anchor's (dead pid / reused pid / transient-0 all decline).
// Plan: desktop-touch-mcp-internal:docs/adr-014-v2-r3x-s-pid-gate.md (E3/E4)
import { describe, expect, it, vi, beforeEach } from "vitest";

const getWindowProcessId = vi.fn<(hwnd: unknown) => number>();
const getWindowTitleW = vi.fn<(hwnd: unknown) => string>();
const getProcessIdentityByPid = vi.fn<(pid: number) => { pid: number; processName: string; processStartTimeMs: number }>();

vi.mock("../../src/engine/win32.js", () => ({
  getWindowProcessId: (hwnd: unknown) => getWindowProcessId(hwnd),
  getWindowTitleW: (hwnd: unknown) => getWindowTitleW(hwnd),
  getProcessIdentityByPid: (pid: number) => getProcessIdentityByPid(pid),
}));

const { titleFingerprint, assembleInjectTarget } = await import(
  "../../src/engine/key-locker/inject-target.js"
);
type PaneAnchor = import("../../src/engine/key-locker/inject-target.js").PaneAnchor;

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

const classicAnchor = (o: Partial<PaneAnchor> = {}): PaneAnchor => ({
  kind: "classic",
  hwnd: 0x1234n,
  shellPid: 4242,
  shellStartTimeMs: 13322426700123,
  ...o,
});
const wtAnchor = (o: Partial<PaneAnchor> = {}): PaneAnchor => ({
  kind: "wt",
  shellPid: 5150,
  shellStartTimeMs: 13322426700456,
  ...o,
});

describe("assembleInjectTarget — classic pane target (S-pid E4)", () => {
  beforeEach(() => {
    getWindowProcessId.mockReset();
    getWindowTitleW.mockReset();
    getProcessIdentityByPid.mockReset();
  });

  it("assembles {hwnd(decimal), consolePid, titleFp} from the SAME win32 reads the locker re-verifies, plus the anchor's shellPid/shellStartMs verbatim", () => {
    getWindowProcessId.mockReturnValue(4242);
    getWindowTitleW.mockReturnValue("Administrator: Windows PowerShell");
    const t = assembleInjectTarget(classicAnchor(), false);
    expect(t).toEqual({
      hwnd: "4660", // 0x1234 in decimal — the InjectTarget.hwnd contract
      consolePid: 4242,
      titleFp: "d26d14f0263a47f3a31d10eb995fa1d073a63eb79c6f7502e3bd8902cd7ea13f",
      shellPid: 4242,
      shellStartMs: 13322426700123, // carried from the SPAWN-captured anchor, never re-derived
    });
    // consolePid + titleFp both read from the SAME hwnd the anchor carries.
    expect(getWindowProcessId).toHaveBeenCalledWith(0x1234n);
    expect(getWindowTitleW).toHaveBeenCalledWith(0x1234n);
    // classic never consults the live process identity — the C# re-verify owns the pid+time check.
    expect(getProcessIdentityByPid).not.toHaveBeenCalled();
  });

  it("emits submit:true only when requested (optional field otherwise omitted)", () => {
    getWindowProcessId.mockReturnValue(100);
    getWindowTitleW.mockReturnValue("t");
    expect(assembleInjectTarget(classicAnchor({ hwnd: 1n }), true)).toMatchObject({ submit: true });
    expect(assembleInjectTarget(classicAnchor({ hwnd: 1n }), false)).not.toHaveProperty("submit");
  });

  it("declines (null) when the window is gone / hwnd invalid (getWindowProcessId === 0)", () => {
    getWindowProcessId.mockReturnValue(0);
    getWindowTitleW.mockReturnValue("stale");
    expect(assembleInjectTarget(classicAnchor({ hwnd: 0xdeadn }), true)).toBeNull();
    // A gone window must NOT round-trip a garbage target (sha256("") titleFp) to the locker.
    expect(getWindowTitleW).not.toHaveBeenCalled();
  });

  it("declines (null) on a malformed classic anchor with no hwnd", () => {
    expect(assembleInjectTarget(classicAnchor({ hwnd: undefined }), true)).toBeNull();
    expect(getWindowProcessId).not.toHaveBeenCalled();
  });
});

describe("assembleInjectTarget — wt pane target (S-pid E4: pid+time only)", () => {
  beforeEach(() => {
    getWindowProcessId.mockReset();
    getWindowTitleW.mockReset();
    getProcessIdentityByPid.mockReset();
  });

  it("assembles {shellPid, shellStartMs} with NO window-derived field when the live identity matches the anchor", () => {
    getProcessIdentityByPid.mockReturnValue({ pid: 5150, processName: "powershell", processStartTimeMs: 13322426700456 });
    const t = assembleInjectTarget(wtAnchor(), true);
    expect(t).toEqual({ shellPid: 5150, shellStartMs: 13322426700456, submit: true });
    expect(getProcessIdentityByPid).toHaveBeenCalledWith(5150);
    // Nothing window-derived exists to read for a wt pane.
    expect(getWindowProcessId).not.toHaveBeenCalled();
    expect(getWindowTitleW).not.toHaveBeenCalled();
  });

  it("declines (null) when the shell is gone (identity reads 0 — the doubt sentinel)", () => {
    getProcessIdentityByPid.mockReturnValue({ pid: 5150, processName: "", processStartTimeMs: 0 });
    expect(assembleInjectTarget(wtAnchor(), false)).toBeNull();
  });

  it("declines (null) when the pid was REUSED (a DIFFERENT non-zero creation time — exact equality, no tolerance)", () => {
    getProcessIdentityByPid.mockReturnValue({ pid: 5150, processName: "powershell", processStartTimeMs: 13322426700457 });
    expect(assembleInjectTarget(wtAnchor(), false)).toBeNull();
  });
});
