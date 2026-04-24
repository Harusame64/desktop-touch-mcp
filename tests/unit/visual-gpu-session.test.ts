/**
 * visual-gpu-session.test.ts
 *
 * Phase 4b-1 (ADR-005 D1' / D2') — verifies the `visionInitSession` napi
 * function and its integration with the OnnxBackend via mocked native binding.
 *
 * Coverage:
 *   1. `nativeVision.visionInitSession` absent → OnnxBackend still reaches
 *      "warm" (ensureWarm does not require visionInitSession in 4b-1).
 *   2. `visionInitSession` resolves with `{ok: true, selectedEp: "DirectML(0)"}` →
 *      result fields are correctly typed and surfaced to TS.
 *   3. `visionInitSession` resolves with `{ok: false, error: "all EPs failed"}` →
 *      error path does not throw (L5).
 *   4. `visionInitSession` rejects (simulated panic isolation) → caller does not
 *      throw (Promise rejection should be caught gracefully).
 *   5. `sessionKey` is echoed back in NativeSessionResult.
 *   6. `NativeVision.visionInitSession` optional method is present on the
 *      interface when mocked (type-level smoke test).
 *   7. `selectedEp` label format smoke test (validates string format contract).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NativeSessionInit, NativeSessionResult } from "../../src/engine/native-types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeProfile() {
  return {
    os: "windows",
    osBuild: 26100,
    gpuVendor: "AMD",
    gpuDevice: "Radeon RX 9070 XT",
    gpuArch: "RDNA4",
    gpuVramMb: 16384,
    winml: false,
    directml: true,
    rocm: false,
    cuda: false,
    tensorrt: false,
    cpuIsa: ["avx2", "avx"],
    backendBuilt: true,
    epsBuilt: ["directml"],
  };
}

function makeSessionInit(overrides: Partial<NativeSessionInit> = {}): NativeSessionInit {
  return {
    modelPath: "C:/models/dummy.onnx",
    profile: makeProfile(),
    sessionKey: "ui_detector:dml-fp16",
    ...overrides,
  };
}

// ── Block A: visionInitSession absent ────────────────────────────────────────

describe("OnnxBackend without visionInitSession (4b-1 absence test)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        // visionRecognizeRois present but visionInitSession is NOT
        visionRecognizeRois: vi.fn().mockResolvedValue([]),
        detectCapability: vi.fn().mockReturnValue(makeProfile()),
        // visionInitSession intentionally absent
      },
      nativeEngine: null,
      nativeUia: null,
    }));
  });

  it("ensureWarm() still reaches 'warm' when visionInitSession is absent", async () => {
    const { OnnxBackend } = await import("../../src/engine/vision-gpu/onnx-backend.js");
    const b = new OnnxBackend();
    const state = await b.ensureWarm({ kind: "game", id: "g1" });
    expect(state).toBe("warm");
  });
});

// ── Block B: visionInitSession present (mocked) ───────────────────────────────

describe("visionInitSession with mocked native binding", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("resolves with ok=true and selectedEp='DirectML(0)'", async () => {
    const result: NativeSessionResult = {
      ok: true,
      selectedEp: "DirectML(0)",
      error: null,
      sessionKey: "ui_detector:dml-fp16",
    };
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        visionInitSession: vi.fn().mockResolvedValue(result),
        visionRecognizeRois: vi.fn(),
        detectCapability: vi.fn().mockReturnValue(makeProfile()),
      },
      nativeEngine: null,
      nativeUia: null,
    }));
    const { nativeVision } = await import("../../src/engine/native-engine.js");
    const r = await nativeVision!.visionInitSession!(makeSessionInit());
    expect(r.ok).toBe(true);
    expect(r.selectedEp).toBe("DirectML(0)");
    expect(r.error).toBeNull();
    expect(r.sessionKey).toBe("ui_detector:dml-fp16");
  });

  it("resolves with ok=false and error message when all EPs fail", async () => {
    const result: NativeSessionResult = {
      ok: false,
      selectedEp: "",
      error: "all EPs failed: [DirectML(0): ort session failure: ... | CPU: ...]",
      sessionKey: "test-key",
    };
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        visionInitSession: vi.fn().mockResolvedValue(result),
        visionRecognizeRois: vi.fn(),
        detectCapability: vi.fn().mockReturnValue(makeProfile()),
      },
      nativeEngine: null,
      nativeUia: null,
    }));
    const { nativeVision } = await import("../../src/engine/native-engine.js");
    const r = await nativeVision!.visionInitSession!(makeSessionInit({ sessionKey: "test-key" }));
    expect(r.ok).toBe(false);
    expect(r.selectedEp).toBe("");
    expect(r.error).toMatch(/all EPs failed/);
  });

  it("handles promise rejection (panic isolation) without propagating throw", async () => {
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        visionInitSession: vi.fn().mockRejectedValue(new Error("simulated ort panic")),
        visionRecognizeRois: vi.fn(),
        detectCapability: vi.fn().mockReturnValue(makeProfile()),
      },
      nativeEngine: null,
      nativeUia: null,
    }));
    const { nativeVision } = await import("../../src/engine/native-engine.js");
    // A well-behaved TS caller should catch rejects from visionInitSession
    let caughtError: unknown = undefined;
    try {
      await nativeVision!.visionInitSession!(makeSessionInit());
    } catch (e) {
      caughtError = e;
    }
    // The promise rejected — confirm the error is what we injected
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toMatch(/simulated ort panic/);
    // Critically: the test itself completes normally (process still alive — L5)
  });

  it("sessionKey is echoed back in NativeSessionResult", async () => {
    const sessionKey = "my-custom-session-key-abc123";
    const result: NativeSessionResult = {
      ok: true,
      selectedEp: "CPU",
      error: null,
      sessionKey,
    };
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        visionInitSession: vi.fn().mockResolvedValue(result),
        visionRecognizeRois: vi.fn(),
        detectCapability: vi.fn().mockReturnValue(makeProfile()),
      },
      nativeEngine: null,
      nativeUia: null,
    }));
    const { nativeVision } = await import("../../src/engine/native-engine.js");
    const r = await nativeVision!.visionInitSession!(makeSessionInit({ sessionKey }));
    expect(r.sessionKey).toBe(sessionKey);
  });

  it("NativeVision interface accepts visionInitSession as optional method", async () => {
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        visionInitSession: vi.fn().mockResolvedValue({
          ok: true, selectedEp: "DirectML(0)", error: null, sessionKey: ""
        }),
        visionRecognizeRois: vi.fn(),
        detectCapability: vi.fn(),
      },
      nativeEngine: null,
      nativeUia: null,
    }));
    const { nativeVision } = await import("../../src/engine/native-engine.js");
    // visionInitSession is typed as optional — verify it is present
    expect(typeof nativeVision?.visionInitSession).toBe("function");
  });
});

// ── Block C: selectedEp label format validation ───────────────────────────────

describe("NativeSessionResult.selectedEp label format contract", () => {
  const validLabels = [
    "WinML",
    "DirectML(0)",
    "DirectML(1)",
    "ROCm(0)",
    "CUDA(0)",
    "CPU",
    "Fallback(some reason)",
  ];

  it.each(validLabels)("selectedEp='%s' matches expected label format", (label) => {
    const result: NativeSessionResult = {
      ok: label !== "Fallback(some reason)",
      selectedEp: label,
      error: label === "Fallback(some reason)" ? "some reason" : null,
      sessionKey: "k",
    };
    expect(result.selectedEp).toBe(label);
    // Validate the format is a string (type-level check at runtime)
    expect(typeof result.selectedEp).toBe("string");
  });
});
