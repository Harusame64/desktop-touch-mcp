/**
 * visual-gpu-onnx-backend.test.ts
 *
 * Phase 4a (ADR-005) — verifies the OnnxBackend wrapper around the Rust
 * vision_backend napi binding.
 *
 * Coverage:
 *   1. isAvailable() returns false when native binding is absent.
 *   2. ensureWarm() reports "evicted" without native (no fake warm state).
 *   3. recognizeRois() returns [] when native is absent (no throw).
 *   4. recognizeRois() with a mocked native that rejects → returns [] (L5: never throws).
 *   5. recognizeRois() with a mocked native success → maps RawCandidate → UiEntityCandidate
 *      with source="visual_gpu", correct role normalisation, actionability.
 *   6. updateSnapshot() / getStableCandidates() / onDirty() round-trip.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Block A: native binding absent ────────────────────────────────────────────

describe("OnnxBackend without native vision binding", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: null,
      nativeEngine: null,
      nativeUia: null,
    }));
  });

  it("isAvailable() returns false", async () => {
    const { OnnxBackend } = await import("../../src/engine/vision-gpu/onnx-backend.js");
    expect(OnnxBackend.isAvailable()).toBe(false);
  });

  it("ensureWarm() returns 'evicted'", async () => {
    const { OnnxBackend } = await import("../../src/engine/vision-gpu/onnx-backend.js");
    const b = new OnnxBackend();
    const s = await b.ensureWarm({ kind: "game", id: "g1" });
    expect(s).toBe("evicted");
  });

  it("recognizeRois() returns [] (no throw)", async () => {
    const { OnnxBackend } = await import("../../src/engine/vision-gpu/onnx-backend.js");
    const b = new OnnxBackend();
    const cands = await b.recognizeRois("window:1", [
      { trackId: "t1", rect: { x: 0, y: 0, width: 10, height: 10 } },
    ]);
    expect(cands).toEqual([]);
  });
});

// ── Block B: native binding present (mocked) ─────────────────────────────────

describe("OnnxBackend with mocked native binding", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("recognizeRois() returns [] when native call rejects (panic isolation)", async () => {
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        visionRecognizeRois: vi.fn().mockRejectedValue(new Error("simulated rust panic")),
      },
      nativeEngine: null,
      nativeUia: null,
    }));
    const { OnnxBackend } = await import("../../src/engine/vision-gpu/onnx-backend.js");
    const b = new OnnxBackend();
    const cands = await b.recognizeRois("window:1", [
      { trackId: "t1", rect: { x: 0, y: 0, width: 10, height: 10 } },
    ]);
    expect(cands).toEqual([]);
  });

  it("recognizeRois() maps NativeRawCandidate → UiEntityCandidate", async () => {
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        visionRecognizeRois: vi.fn().mockResolvedValue([
          {
            trackId: "track-A",
            rect: { x: 10, y: 20, width: 80, height: 32 },
            label: "Send",
            class: "button",
            confidence: 0.94,
            provisional: false,
          },
          {
            trackId: "track-B",
            rect: { x: 100, y: 50, width: 24, height: 24 },
            label: "",
            class: "icon",
            confidence: 0.71,
            provisional: true,
          },
        ]),
      },
      nativeEngine: null,
      nativeUia: null,
    }));
    const { OnnxBackend } = await import("../../src/engine/vision-gpu/onnx-backend.js");
    const b = new OnnxBackend();
    expect(OnnxBackend.isAvailable()).toBe(true);

    const cands = await b.recognizeRois("window:1234", [
      { trackId: "track-A", rect: { x: 10, y: 20, width: 80, height: 32 } },
      { trackId: "track-B", rect: { x: 100, y: 50, width: 24, height: 24 } },
    ]);
    expect(cands).toHaveLength(2);

    expect(cands[0]?.source).toBe("visual_gpu");
    expect(cands[0]?.target).toEqual({ kind: "window", id: "1234" });
    expect(cands[0]?.role).toBe("button");
    expect(cands[0]?.label).toBe("Send");
    expect(cands[0]?.confidence).toBe(0.94);
    expect(cands[0]?.provisional).toBe(false);
    expect(cands[0]?.actionability).toContain("click");
    expect(cands[0]?.actionability).toContain("invoke");

    // icons are clickable (mapped to "button" role)
    expect(cands[1]?.role).toBe("button");
    expect(cands[1]?.label).toBeUndefined(); // empty string → undefined label
    expect(cands[1]?.provisional).toBe(true);
  });

  it("getStableCandidates() returns the last recognised snapshot per target", async () => {
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        visionRecognizeRois: vi.fn().mockResolvedValue([
          { trackId: "x", rect: { x: 0, y: 0, width: 10, height: 10 }, label: "A", class: "label", confidence: 0.5, provisional: false },
        ]),
      },
      nativeEngine: null,
      nativeUia: null,
    }));
    const { OnnxBackend } = await import("../../src/engine/vision-gpu/onnx-backend.js");
    const b = new OnnxBackend();
    await b.recognizeRois("window:42", [{ trackId: "x", rect: { x: 0, y: 0, width: 10, height: 10 } }]);

    const got = await b.getStableCandidates("window:42");
    expect(got).toHaveLength(1);
    expect(got[0]?.label).toBe("A");

    const empty = await b.getStableCandidates("window:99");
    expect(empty).toEqual([]);
  });

  it("onDirty() listeners fire after recognizeRois produces a snapshot", async () => {
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        visionRecognizeRois: vi.fn().mockResolvedValue([
          { trackId: "x", rect: { x: 0, y: 0, width: 10, height: 10 }, label: "L", class: "label", confidence: 0.5, provisional: false },
        ]),
      },
      nativeEngine: null,
      nativeUia: null,
    }));
    const { OnnxBackend } = await import("../../src/engine/vision-gpu/onnx-backend.js");
    const b = new OnnxBackend();
    const seen: string[] = [];
    b.onDirty((key) => seen.push(key));
    await b.recognizeRois("window:7", [{ trackId: "x", rect: { x: 0, y: 0, width: 10, height: 10 } }]);
    expect(seen).toEqual(["window:7"]);
  });

  it("updateSnapshot() preserves the PocBackend migration path", async () => {
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: { visionRecognizeRois: vi.fn() },
      nativeEngine: null,
      nativeUia: null,
    }));
    const { OnnxBackend } = await import("../../src/engine/vision-gpu/onnx-backend.js");
    const b = new OnnxBackend();
    const seen: string[] = [];
    b.onDirty((k) => seen.push(k));
    b.updateSnapshot("window:99", []);
    expect(seen).toEqual(["window:99"]);
  });
});

// ── Block C: empty input fast-path ───────────────────────────────────────────

describe("OnnxBackend empty input", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        visionRecognizeRois: vi.fn().mockResolvedValue([]),
      },
      nativeEngine: null,
      nativeUia: null,
    }));
  });

  it("recognizeRois([]) skips the native call and returns []", async () => {
    const { OnnxBackend } = await import("../../src/engine/vision-gpu/onnx-backend.js");
    const { nativeVision } = await import("../../src/engine/native-engine.js");
    const b = new OnnxBackend();
    const cands = await b.recognizeRois("window:1", []);
    expect(cands).toEqual([]);
    expect(nativeVision?.visionRecognizeRois).not.toHaveBeenCalled();
  });
});

// ── Block D: Phase 4b-5 stage pipeline integration ────────────────────────────

import type { NativeSessionInit } from "../../src/engine/native-types.js";

describe("OnnxBackend Phase 4b-5 stage pipeline integration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("ensureWarm loads manifest, initialises 3 sessions, transitions to warm", async () => {
    const initCalls: string[] = [];
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        visionInitSession: vi.fn().mockImplementation(async (req: NativeSessionInit) => {
          initCalls.push(req.sessionKey);
          return { ok: true, selectedEp: "DirectML(0)", error: null, sessionKey: req.sessionKey };
        }),
        visionRecognizeRois: vi.fn(),
        detectCapability: vi.fn().mockReturnValue({
          os: "windows", osBuild: 26100, gpuVendor: "AMD", gpuDevice: "Radeon RX 9070 XT",
          gpuArch: "RDNA4", gpuVramMb: 16384, winml: true, directml: true,
          rocm: false, cuda: false, tensorrt: false, cpuIsa: ["avx2"],
          backendBuilt: true, epsBuilt: ["directml"],
        }),
      },
      nativeEngine: null, nativeUia: null,
    }));
    const { OnnxBackend } = await import("../../src/engine/vision-gpu/onnx-backend.js");
    const b = new OnnxBackend();
    const state = await b.ensureWarm({ kind: "game", id: "g1" });
    expect(state).toBe("warm");
    // 3 sessions initialised — one per stage
    expect(initCalls.length).toBe(3);
    expect(initCalls.some((k) => k.startsWith("florence-2-base"))).toBe(true);
    expect(initCalls.some((k) => k.startsWith("omniparser-v2-icon-detect"))).toBe(true);
    expect(initCalls.some((k) => k.startsWith("paddleocr-v4-server"))).toBe(true);
  });

  it("ensureWarm transitions to evicted when visionInitSession rejects on any stage", async () => {
    let call = 0;
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        visionInitSession: vi.fn().mockImplementation(async () => {
          call++;
          if (call === 2) return { ok: false, selectedEp: "", error: "artifact missing", sessionKey: "" };
          return { ok: true, selectedEp: "DirectML(0)", error: null, sessionKey: `k${call}` };
        }),
        visionRecognizeRois: vi.fn(),
        detectCapability: vi.fn().mockReturnValue({
          os: "windows", osBuild: 26100, gpuVendor: "AMD", gpuDevice: "X", gpuArch: "RDNA4",
          gpuVramMb: 16384, winml: true, directml: true, rocm: false, cuda: false, tensorrt: false,
          cpuIsa: ["avx2"], backendBuilt: true, epsBuilt: ["directml"],
        }),
      },
      nativeEngine: null, nativeUia: null,
    }));
    const { OnnxBackend } = await import("../../src/engine/vision-gpu/onnx-backend.js");
    const b = new OnnxBackend();
    const state = await b.ensureWarm({ kind: "game", id: "g1" });
    expect(state).toBe("evicted");
  });

  it("recognizeRois invokes stage pipeline after warm (at least 2 native calls, stage3 skipped for 'other' class)", async () => {
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        visionInitSession: vi.fn().mockResolvedValue({ ok: true, selectedEp: "DirectML(0)", error: null, sessionKey: "k" }),
        visionRecognizeRois: vi.fn().mockImplementation(async (req: { rois: Array<{ trackId: string; rect: object; classHint: string | null }> }) =>
          req.rois.map((r) => ({ trackId: r.trackId, rect: r.rect, label: "", class: r.classHint ?? "other", confidence: 0.5, provisional: true })),
        ),
        detectCapability: vi.fn().mockReturnValue({
          os: "windows", osBuild: 26100, gpuVendor: "AMD", gpuDevice: "X", gpuArch: "RDNA4",
          gpuVramMb: 16384, winml: true, directml: true, rocm: false, cuda: false, tensorrt: false,
          cpuIsa: ["avx2"], backendBuilt: true, epsBuilt: ["directml"],
        }),
      },
      nativeEngine: null, nativeUia: null,
    }));
    const { OnnxBackend } = await import("../../src/engine/vision-gpu/onnx-backend.js");
    const b = new OnnxBackend();

    await b.ensureWarm({ kind: "game", id: "g1" });
    expect(b.getWarmState()).toBe("warm");

    const after = await b.recognizeRois("window:1", [{ trackId: "t1", rect: { x: 0, y: 0, width: 100, height: 50 } }]);
    expect(after).toHaveLength(1);
    // At least 2 native calls (stage1 + stage2, stage3 skipped because stub class is "other")
    const { nativeVision } = await import("../../src/engine/native-engine.js");
    const callCount = (nativeVision!.visionRecognizeRois as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// ── Block E: Phase 4b-5a-1 frameBuffer plumbing ───────────────────────────────

describe("OnnxBackend Phase 4b-5a-1 frameBuffer plumbing", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("recognizeRois forwards frameBuffer to native request when provided", async () => {
    const recorded: Array<{ sessionKey: string; bufferLen: number }> = [];
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        visionInitSession: vi.fn().mockImplementation(async (req: NativeSessionInit) => ({
          ok: true, selectedEp: "DirectML(0)", error: null, sessionKey: req.sessionKey,
        })),
        visionRecognizeRois: vi.fn().mockImplementation(async (req: { sessionKey: string; frameBuffer?: { length: number }; rois: Array<{ trackId: string; rect: object; classHint: string | null }> }) => {
          recorded.push({ sessionKey: req.sessionKey, bufferLen: req.frameBuffer?.length ?? 0 });
          return req.rois.map((r) => ({
            trackId: r.trackId, rect: r.rect, label: "", class: "other", confidence: 0.5, provisional: true,
          }));
        }),
        detectCapability: vi.fn().mockReturnValue({
          os: "windows", osBuild: 26100, gpuVendor: "AMD", gpuDevice: "X",
          gpuArch: "RDNA4", gpuVramMb: 16384, winml: true, directml: true,
          rocm: false, cuda: false, tensorrt: false, cpuIsa: ["avx2"],
          backendBuilt: true, epsBuilt: ["directml"],
        }),
      },
      nativeEngine: null, nativeUia: null,
    }));
    const { OnnxBackend } = await import("../../src/engine/vision-gpu/onnx-backend.js");
    const b = new OnnxBackend();
    await b.ensureWarm({ kind: "game", id: "g1" });

    const frameBuf = Buffer.alloc(100 * 100 * 4, 128);
    await b.recognizeRois(
      "window:1",
      [{ trackId: "t1", rect: { x: 0, y: 0, width: 100, height: 100 } }],
      100, 100, frameBuf,
    );
    expect(recorded.length).toBeGreaterThanOrEqual(1);
    expect(recorded[0]!.bufferLen).toBe(100 * 100 * 4);
  });

  it("recognizeRois without frameBuffer uses empty Buffer (legacy-safe)", async () => {
    const recorded: Array<{ bufferLen: number }> = [];
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        visionInitSession: vi.fn().mockImplementation(async (req: NativeSessionInit) => ({
          ok: true, selectedEp: "DirectML(0)", error: null, sessionKey: req.sessionKey,
        })),
        visionRecognizeRois: vi.fn().mockImplementation(async (req: { frameBuffer?: { length: number }; rois: Array<{ trackId: string; rect: object; classHint: string | null }> }) => {
          recorded.push({ bufferLen: req.frameBuffer?.length ?? 0 });
          return req.rois.map((r) => ({
            trackId: r.trackId, rect: r.rect, label: "", class: "other", confidence: 0.5, provisional: true,
          }));
        }),
        detectCapability: vi.fn().mockReturnValue({
          os: "windows", osBuild: 26100, gpuVendor: "AMD", gpuDevice: "X",
          gpuArch: "RDNA4", gpuVramMb: 16384, winml: true, directml: true,
          rocm: false, cuda: false, tensorrt: false, cpuIsa: ["avx2"],
          backendBuilt: true, epsBuilt: ["directml"],
        }),
      },
      nativeEngine: null, nativeUia: null,
    }));
    const { OnnxBackend } = await import("../../src/engine/vision-gpu/onnx-backend.js");
    const b = new OnnxBackend();
    await b.ensureWarm({ kind: "game", id: "g1" });

    // Call without frameBuffer — should use empty Buffer (bufferLen === 0)
    await b.recognizeRois(
      "window:1",
      [{ trackId: "t1", rect: { x: 0, y: 0, width: 100, height: 100 } }],
      100, 100,
      // frameBuffer omitted
    );
    expect(recorded.length).toBeGreaterThanOrEqual(1);
    expect(recorded[0]!.bufferLen).toBe(0);
  });
});
