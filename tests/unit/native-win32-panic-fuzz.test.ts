// ADR-007 P1 panic-fuzz suite — covers the "panic-fuzz CI でプロセス全滅 0 件"
// acceptance criterion (ADR-007 §3.4.3). The other §3.4.3 items
// (auto-restart, shutdown, clippy deny) are P5a follow-ups and intentionally
// out of scope here.

import { describe, expect, it } from "vitest";
import { nativeWin32 } from "../../src/engine/native-engine.js";

const native = nativeWin32!;

describe.skipIf(!nativeWin32)("ADR-007 P1: native win32 panic-safety", () => {
  // Adversarial HWND values: NULL, an obvious-stale value, and the all-ones
  // bit pattern (max u64). Each must be handled without crashing the Node
  // process — that is what `napi_safe_call` exists to guarantee.
  const adversarial: Array<[label: string, hwnd: bigint]> = [
    ["null hwnd", 0n],
    ["stale hwnd", 9_999_999_999n],
    ["all-ones u64", 0xffff_ffff_ffff_ffffn],
  ];

  describe("adversarial HWND inputs survive without panic", () => {
    for (const [label, hwnd] of adversarial) {
      it(`win32GetWindowText(${label})`, () => {
        expect(native.win32GetWindowText!(hwnd)).toBe("");
      });
      it(`win32GetClassName(${label})`, () => {
        expect(native.win32GetClassName!(hwnd)).toBe("");
      });
      it(`win32GetWindowRect(${label})`, () => {
        expect(native.win32GetWindowRect!(hwnd)).toBeNull();
      });
      it(`win32IsWindowVisible(${label})`, () => {
        expect(native.win32IsWindowVisible!(hwnd)).toBe(false);
      });
      it(`win32IsIconic(${label})`, () => {
        expect(native.win32IsIconic!(hwnd)).toBe(false);
      });
      it(`win32IsZoomed(${label})`, () => {
        expect(native.win32IsZoomed!(hwnd)).toBe(false);
      });
      it(`win32GetWindowThreadProcessId(${label})`, () => {
        const r = native.win32GetWindowThreadProcessId!(hwnd);
        expect(r.threadId).toBe(0);
        expect(r.processId).toBe(0);
      });
      it(`win32GetWindowLongPtrW(${label}, GWL_EXSTYLE)`, () => {
        // GetWindowLongPtrW returns 0 on invalid HWND; treating as i32 still
        // yields 0. The point of the test is "no panic" — value comparison is
        // a bonus signal.
        expect(typeof native.win32GetWindowLongPtrW!(hwnd, -20)).toBe("number");
      });
    }
  });

  describe("HWND BigInt round-trip preserves bits", () => {
    // Foreground HWND read from native must round-trip through any of the
    // sync getters without panic and produce a self-consistent shape. We use
    // it to verify positive-bigint emission on the Rust → JS side and the
    // get_u64() ingest on the JS → Rust side (Opus review §10.1).
    it("foreground hwnd round-trip", () => {
      const fg = native.win32GetForegroundWindow!();
      if (fg === null) return; // headless runner / lock screen — accept
      expect(fg).toBeTypeOf("bigint");
      expect(fg >= 0n).toBe(true);
      // Round-trip: feed the same bigint back into another native function.
      expect(typeof native.win32IsWindowVisible!(fg)).toBe("boolean");
      const r = native.win32GetWindowThreadProcessId!(fg);
      expect(r.processId).toBeGreaterThanOrEqual(0);
    });

    // High-bit HWNDs (0xFFFF_8000_xxxx_xxxx-class) appear when Win64 emits
    // pointers in the upper canonical range. The conversion chain
    // u64 ↔ isize ↔ *mut c_void must not lose those bits or trip the
    // catch_unwind net.
    it("synthetic high-bit hwnd does not panic", () => {
      const synthetic = 0xffff_8000_0000_0000n;
      expect(native.win32IsWindowVisible!(synthetic)).toBe(false);
      expect(native.win32GetWindowText!(synthetic)).toBe("");
    });
  });

  describe("RSS does not balloon under repeated enumeration", () => {
    it("100 win32EnumTopLevelWindows() iterations stay under 50MB delta", () => {
      // Warm up GC scheduler (Node's lazy allocator).
      native.win32EnumTopLevelWindows!();
      const before = process.memoryUsage().rss;
      for (let i = 0; i < 100; i++) {
        const hwnds = native.win32EnumTopLevelWindows!();
        expect(hwnds.length).toBeGreaterThanOrEqual(1);
      }
      const after = process.memoryUsage().rss;
      const deltaMB = (after - before) / (1024 * 1024);
      expect(deltaMB).toBeLessThan(50);
    });

    // Opus review §11.6 wants P2 to match P1's iteration count and tighten
    // the RSS guard. enumMonitors should not allocate per-call beyond the
    // small Vec it returns; 5MB is generous headroom for V8 churn.
    it("100 win32EnumMonitors() iterations stay under 5MB delta (ADR-007 P2)", () => {
      native.win32EnumMonitors!();
      const before = process.memoryUsage().rss;
      for (let i = 0; i < 100; i++) {
        const mons = native.win32EnumMonitors!();
        expect(mons.length).toBeGreaterThanOrEqual(1);
      }
      const after = process.memoryUsage().rss;
      const deltaMB = (after - before) / (1024 * 1024);
      expect(deltaMB).toBeLessThan(5);
    });
  });

  describe("ADR-007 P2: GDI / monitor / DPI panic safety", () => {
    // Adversarial HWNDs for the new P2 surface. printWindowToBuffer must
    // throw a typed Error (the underlying GetWindowRect fails) but NEVER
    // crash the process; getWindowDpi must hand back the safe 96 fallback.
    const adversarial: Array<[label: string, hwnd: bigint]> = [
      ["null hwnd", 0n],
      ["stale hwnd", 9_999_999_999n],
      ["all-ones u64", 0xffff_ffff_ffff_ffffn],
    ];

    for (const [label, hwnd] of adversarial) {
      it(`win32PrintWindowToBuffer(${label}) throws typed Error, process survives`, () => {
        expect(() => native.win32PrintWindowToBuffer!(hwnd, 2)).toThrow();
      });
      it(`win32GetWindowDpi(${label}) returns 96`, () => {
        expect(native.win32GetWindowDpi!(hwnd)).toBe(96);
      });
    }

    it("win32SetProcessDpiAwareness with already-set state returns true", () => {
      // The native binding maps E_ACCESSDENIED (already set) to success
      // (Opus review §11.3). The process startup path already calls this
      // once with level=2; calling again here exercises that mapping.
      expect(native.win32SetProcessDpiAwareness!(2)).toBe(true);
    });

    it("win32SetProcessDpiAwareness with invalid level does not panic", () => {
      // Some invalid levels return E_INVALIDARG; we accept either true/false
      // (the contract is "no panic"), not the specific HRESULT outcome.
      expect(typeof native.win32SetProcessDpiAwareness!(99)).toBe("boolean");
    });

    it("printWindowToBuffer round-trip on the foreground window produces RGBA8", () => {
      const fg = native.win32GetForegroundWindow!();
      if (fg === null) return; // headless / lock screen
      const r = native.win32PrintWindowToBuffer!(fg, 2);
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);
      // length = w * h * 4 (RGBA8)
      expect(r.data.length).toBe(r.width * r.height * 4);
      // alpha channel is forced to 255 by the BGRA→RGBA pass
      // (sample the first pixel's alpha and a middle pixel's alpha).
      expect(r.data[3]).toBe(255);
      const mid = Math.floor(r.data.length / 8) * 4;
      expect(r.data[mid + 3]).toBe(255);
    });
  });

  // ── ADR-007 P3: process / thread / input / window-state ops ────────────────
  describe("ADR-007 P3: process / input panic safety", () => {
    const adversarialHwnds: Array<[label: string, hwnd: bigint]> = [
      ["null hwnd", 0n],
      ["stale hwnd", 9_999_999_999n],
      ["all-ones u64", 0xffff_ffff_ffff_ffffn],
    ];

    for (const [label, hwnd] of adversarialHwnds) {
      it(`win32ShowWindow(${label}) returns false, no panic`, () => {
        expect(typeof native.win32ShowWindow!(hwnd, 9)).toBe("boolean");
      });
      it(`win32SetForegroundWindow(${label}) returns false, no panic`, () => {
        expect(native.win32SetForegroundWindow!(hwnd)).toBe(false);
      });
      it(`win32SetWindowTopmost(${label}) returns false, no panic`, () => {
        expect(native.win32SetWindowTopmost!(hwnd)).toBe(false);
      });
      it(`win32ClearWindowTopmost(${label}) returns false, no panic`, () => {
        expect(native.win32ClearWindowTopmost!(hwnd)).toBe(false);
      });
      it(`win32SetWindowBounds(${label}) returns false, no panic`, () => {
        expect(native.win32SetWindowBounds!(hwnd, 0, 0, 100, 100)).toBe(false);
      });
      it(`win32ForceSetForegroundWindow(${label}) returns ok=false, no panic`, () => {
        const r = native.win32ForceSetForegroundWindow!(hwnd);
        expect(r.ok).toBe(false);
        expect(typeof r.attached).toBe("boolean");
        expect(typeof r.fgBefore).toBe("bigint");
        expect(typeof r.fgAfter).toBe("bigint");
      });
      it(`win32GetFocusedChildHwnd(${label}) returns null, no panic`, () => {
        expect(native.win32GetFocusedChildHwnd!(hwnd)).toBeNull();
      });
      it(`win32GetScrollInfo(${label}, "vertical") returns null, no panic`, () => {
        expect(native.win32GetScrollInfo!(hwnd, "vertical")).toBeNull();
      });
      it(`win32PostMessage(${label}, 0, 0n, 0n) does not panic`, () => {
        // The contract here is "no panic", not specifically false:
        // - hwnd=0 posts to the calling thread's message queue (Win32 returns TRUE).
        // - all-ones u64 maps to HWND_BROADCAST (-1) which Win32 also accepts.
        // - stale hwnd usually fails. We only assert the boolean shape.
        expect(typeof native.win32PostMessage!(hwnd, 0, 0n, 0n)).toBe("boolean");
      });
    }

    it("win32GetScrollInfo rejects unknown axis with a typed Error", () => {
      // Use the foreground hwnd if available so the call reaches our axis
      // branch — for stale hwnds the GetScrollInfo failure would mask it.
      const fg = native.win32GetForegroundWindow!() ?? 0n;
      expect(() => native.win32GetScrollInfo!(fg, "diagonal")).toThrow();
    });

    it("win32GetProcessIdentity(0) returns empty identity, no panic", () => {
      const r = native.win32GetProcessIdentity!(0);
      expect(r.pid).toBe(0);
      expect(r.processName).toBe("");
      expect(r.processStartTimeMs).toBe(0);
    });

    it("win32GetProcessIdentity(2147483647) (non-existent PID) returns empty identity", () => {
      // 2^31 - 1 — almost certainly not a live PID on this machine.
      const r = native.win32GetProcessIdentity!(2_147_483_647);
      expect(r.pid).toBe(2_147_483_647);
      expect(r.processName).toBe("");
      expect(r.processStartTimeMs).toBe(0);
    });

    it("win32VkToScanCode(0xFFFF) returns 0 for unknown codes", () => {
      expect(native.win32VkToScanCode!(0xffff)).toBe(0);
    });

    it("win32VkToScanCode(VK_RETURN=0x0D) returns scan code 0x1C", () => {
      // 0x1C = 28 is the canonical Enter scan code on US PS/2 layouts.
      expect(native.win32VkToScanCode!(0x0d)).toBe(0x1c);
    });

    it("win32GetFocus returns either null or a bigint", () => {
      const f = native.win32GetFocus!();
      if (f !== null) expect(typeof f).toBe("bigint");
    });
  });

  // ── ADR-007 §6 P3 acceptance: sizeof gauntlet ──────────────────────────────
  // The legacy koffi binding had a `PROCESSENTRY32W.dwSize` hard-code that
  // bit users when the kernel struct grew. windows-rs `repr(C)` removes
  // that class of failure entirely; this gauntlet locks the property in
  // CI by hammering the two structs (PROCESSENTRY32W via Toolhelp32 walk
  // and the OpenProcess identity path) until any sizeof drift would show
  // as a length / field-shape regression.
  describe("ADR-007 P3 sizeof gauntlet (PROCESSENTRY32W + OpenProcess identity)", () => {
    it(
      "win32BuildProcessParentMap stays consistent across 1000 invocations",
      { timeout: 30_000 },
      () => {
        const baseline = native.win32BuildProcessParentMap!();
        expect(baseline.length).toBeGreaterThan(0);
        // Every entry must have plausible u32 fields. The legacy koffi
        // binding silently mis-aligned ULONG_PTR on x64 when dwSize was
        // wrong; if that regressed, parent_pid would frequently land on
        // stale stack data and exceed the kernel's pid range.
        for (const e of baseline) {
          expect(e.pid).toBeGreaterThanOrEqual(0);
          expect(e.pid).toBeLessThan(0x7fff_ffff);
          expect(e.parentPid).toBeGreaterThanOrEqual(0);
          expect(e.parentPid).toBeLessThan(0x7fff_ffff);
        }
        // System (pid 4) should always exist on a live Windows system.
        const pids = new Set(baseline.map((e) => e.pid));
        expect(pids.has(4)).toBe(true);

        // Hammer the call to surface any non-deterministic struct corruption.
        // 1000 iterations × ~400 processes × Vec allocations land around
        // ~14s on a debug-built CI runner, hence the 30s timeout above.
        for (let i = 0; i < 999; i++) {
          const r = native.win32BuildProcessParentMap!();
          expect(r.length).toBeGreaterThan(0);
        }
      },
    );

    it("win32GetProcessIdentity stays consistent across 100 PIDs", () => {
      const map = native.win32BuildProcessParentMap!();
      // Sample 100 PIDs (or all of them if fewer).
      const sample = map.slice(0, 100).map((e) => e.pid);
      let identifiedCount = 0;
      for (const pid of sample) {
        const id = native.win32GetProcessIdentity!(pid);
        expect(id.pid).toBe(pid);
        expect(typeof id.processName).toBe("string");
        expect(typeof id.processStartTimeMs).toBe("number");
        if (id.processName.length > 0) identifiedCount++;
      }
      // We expect to resolve a non-trivial fraction of process names.
      // A regression that mangled the OpenProcess handle would push this
      // toward zero, while a sizeof bug in PROCESSENTRY32W would feed
      // garbage PIDs that would all fail to resolve.
      expect(identifiedCount).toBeGreaterThan(0);
    });
  });
});
