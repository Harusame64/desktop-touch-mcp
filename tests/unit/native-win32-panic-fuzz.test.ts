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
  });
});
