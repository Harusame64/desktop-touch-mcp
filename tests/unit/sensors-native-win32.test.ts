/**
 * tests/unit/sensors-native-win32.test.ts
 *
 * Unit tests for NativeSensorBridge — event-to-dirty mapping and dispatch.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  NativeSensorBridge,
  EVENT_SYSTEM_FOREGROUND,
  EVENT_OBJECT_SHOW,
  EVENT_OBJECT_HIDE,
  EVENT_OBJECT_DESTROY,
  EVENT_OBJECT_NAMECHANGE,
  EVENT_SYSTEM_MOVESIZESTART,
  EVENT_SYSTEM_MOVESIZEEND,
  EVENT_OBJECT_LOCATIONCHANGE,
  EVENT_OBJECT_REORDER,
} from "../../src/engine/perception/sensors-native-win32.js";
import type { NativeSensorBridgeCallbacks } from "../../src/engine/perception/sensors-native-win32.js";
import type { RawWinEvent } from "../../src/engine/perception/raw-event-queue.js";
import { DirtyJournal } from "../../src/engine/perception/dirty-journal.js";
import {
  createLensEventIndex,
  addLensToIndex,
} from "../../src/engine/perception/lens-event-index.js";
import type { LensEventIndex } from "../../src/engine/perception/lens-event-index.js";
import type { PerceptionLens, LensSpec, WindowIdentity } from "../../src/engine/perception/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(eventCode: number, hwnd: string, idObject = 0): RawWinEvent {
  return {
    event: eventCode,
    hwnd,
    idObject,
    idChild: 0,
    eventThread: 1234,
    sourceEventTimeMs: 0,
    sidecarSeq: 1,
    receivedAtMonoMs: 5000,
    receivedAtUnixMs: 1700000000000,
    globalSeq: 1,
  };
}

const identity: WindowIdentity = {
  hwnd: "100", pid: 1234, processName: "notepad.exe",
  processStartTimeMs: 1700000000000, titleResolved: "Notepad",
};

function makeLens(lensId: string, hwnd: string, maintain: string[]): PerceptionLens {
  return {
    lensId,
    spec: {
      name: lensId,
      target: { kind: "window", match: { titleIncludes: "test" } },
      maintain: maintain as LensSpec["maintain"],
      guards: [],
      guardPolicy: "block",
      maxEnvelopeTokens: 120,
      salience: "normal",
    },
    binding: { hwnd, windowTitle: "Test" },
    boundIdentity: { ...identity, hwnd },
    fluentKeys: maintain.map(m => `window:${hwnd}.${m}`),
    registeredAtSeq: 0,
    registeredAtMs: Date.now(),
  };
}

function makeCallbacks() {
  return {
    onDirty:            vi.fn(),
    onGlobalDirty:      vi.fn(),
    onSchedule:         vi.fn(),
    onEnumWindowsNeeded: vi.fn(),
  } satisfies NativeSensorBridgeCallbacks;
}

// ── Phase 5-A event mapping ───────────────────────────────────────────────────

describe("NativeSensorBridge — Phase 5-A event mapping", () => {
  let journal: DirtyJournal;
  let index: LensEventIndex;

  beforeEach(() => {
    journal = new DirtyJournal();
    journal.__resetForTests();
    index = createLensEventIndex();
    addLensToIndex(index, makeLens("perc-1", "100", ["target.foreground"]));
  });

  it("EVENT_SYSTEM_FOREGROUND → target.foreground dirty, foreground schedule", () => {
    const cbs = makeCallbacks();
    const bridge = new NativeSensorBridge(cbs);
    bridge.processBatch([makeEvent(EVENT_SYSTEM_FOREGROUND, "100")], index, journal);
    expect(cbs.onDirty).toHaveBeenCalledWith(
      "window:100", ["target.foreground"], expect.stringContaining("0003"), 5000, undefined
    );
    expect(cbs.onSchedule).toHaveBeenCalledWith("foreground", expect.any(String));
    expect(cbs.onEnumWindowsNeeded).not.toHaveBeenCalled();
  });

  it("EVENT_SYSTEM_FOREGROUND fanout — other foreground-sensitive windows also marked dirty", () => {
    const cbs = makeCallbacks();
    const bridge = new NativeSensorBridge(cbs);
    // Add a second foreground-sensitive lens on a different hwnd
    addLensToIndex(index, makeLens("perc-2", "200", ["target.foreground"]));

    // Foreground event on hwnd 100 → hwnd 100 AND hwnd 200 should both be dirty
    bridge.processBatch([makeEvent(EVENT_SYSTEM_FOREGROUND, "100")], index, journal);

    const dirtyCalls = (cbs.onDirty as ReturnType<typeof vi.fn>).mock.calls;
    const dirtyEntityKeys = dirtyCalls.map((c: unknown[]) => c[0]);
    expect(dirtyEntityKeys).toContain("window:100"); // event source
    expect(dirtyEntityKeys).toContain("window:200"); // foreground-sensitive fanout
  });

  it("EVENT_OBJECT_SHOW → structural severity, EnumWindows needed", () => {
    const cbs = makeCallbacks();
    const bridge = new NativeSensorBridge(cbs);
    bridge.processBatch([makeEvent(EVENT_OBJECT_SHOW, "100")], index, journal);
    expect(cbs.onDirty).toHaveBeenCalledWith(
      "window:100", ["target.exists"], expect.any(String), 5000, "structural"
    );
    expect(cbs.onEnumWindowsNeeded).toHaveBeenCalled();
  });

  it("EVENT_OBJECT_HIDE → structural severity", () => {
    const cbs = makeCallbacks();
    const bridge = new NativeSensorBridge(cbs);
    bridge.processBatch([makeEvent(EVENT_OBJECT_HIDE, "100")], index, journal);
    expect(cbs.onDirty).toHaveBeenCalledWith(
      "window:100", ["target.exists"], expect.any(String), 5000, "structural"
    );
  });

  it("EVENT_OBJECT_DESTROY → structural severity", () => {
    const cbs = makeCallbacks();
    const bridge = new NativeSensorBridge(cbs);
    bridge.processBatch([makeEvent(EVENT_OBJECT_DESTROY, "100")], index, journal);
    expect(cbs.onDirty).toHaveBeenCalledWith(
      "window:100", ["target.exists"], expect.any(String), 5000, "structural"
    );
  });

  it("EVENT_OBJECT_NAMECHANGE → target.title dirty, title schedule", () => {
    const cbs = makeCallbacks();
    const bridge = new NativeSensorBridge(cbs);
    bridge.processBatch([makeEvent(EVENT_OBJECT_NAMECHANGE, "100")], index, journal);
    expect(cbs.onDirty).toHaveBeenCalledWith(
      "window:100", ["target.title"], expect.any(String), 5000, undefined
    );
    expect(cbs.onSchedule).toHaveBeenCalledWith("title", expect.any(String));
  });

  it("skips events with idObject !== OBJID_WINDOW", () => {
    const cbs = makeCallbacks();
    const bridge = new NativeSensorBridge(cbs);
    bridge.processBatch([makeEvent(EVENT_SYSTEM_FOREGROUND, "100", 1 /* not OBJID_WINDOW */)], index, journal);
    expect(cbs.onDirty).not.toHaveBeenCalled();
  });

  it("skips events with hwnd='0'", () => {
    const cbs = makeCallbacks();
    const bridge = new NativeSensorBridge(cbs);
    bridge.processBatch([makeEvent(EVENT_SYSTEM_FOREGROUND, "0")], index, journal);
    expect(cbs.onDirty).not.toHaveBeenCalled();
  });

  it("unknown event codes are silently ignored", () => {
    const cbs = makeCallbacks();
    const bridge = new NativeSensorBridge(cbs);
    bridge.processBatch([makeEvent(0xFFFF, "100")], index, journal);
    expect(cbs.onDirty).not.toHaveBeenCalled();
  });
});

// ── Overflow handling ─────────────────────────────────────────────────────────

describe("NativeSensorBridge — overflow handling", () => {
  it("processOverflow emits global dirty and overflow schedule", () => {
    const cbs = makeCallbacks();
    const bridge = new NativeSensorBridge(cbs);
    bridge.processOverflow(9000);
    expect(cbs.onGlobalDirty).toHaveBeenCalledWith("queue_overflow", 9000);
    expect(cbs.onSchedule).toHaveBeenCalledWith("overflow", "queue_overflow");
  });
});

// ── Location events (LOCATION_EVENTS=1) ───────────────────────────────────────

describe("NativeSensorBridge — location events (flag gated)", () => {
  it("MOVESIZESTART ignored when LOCATION_EVENTS is unset", () => {
    delete process.env.DESKTOP_TOUCH_PERCEPTION_LOCATION_EVENTS;
    const cbs = makeCallbacks();
    const bridge = new NativeSensorBridge(cbs);
    const index = createLensEventIndex();
    bridge.processBatch([makeEvent(EVENT_SYSTEM_MOVESIZESTART, "100")], index, new DirtyJournal());
    expect(cbs.onDirty).not.toHaveBeenCalled();
  });

  it("MOVESIZESTART → stable.rect dirty with move_start schedule when LOCATION_EVENTS=1", () => {
    vi.stubEnv("DESKTOP_TOUCH_PERCEPTION_LOCATION_EVENTS", "1");
    const cbs = makeCallbacks();
    const bridge = new NativeSensorBridge(cbs);
    const index = createLensEventIndex();
    bridge.processBatch([makeEvent(EVENT_SYSTEM_MOVESIZESTART, "100")], index, new DirtyJournal());
    expect(cbs.onDirty).toHaveBeenCalledWith(
      "window:100", ["target.rect", "stable.rect"], expect.any(String), 5000, undefined
    );
    expect(cbs.onSchedule).toHaveBeenCalledWith("move_start", expect.any(String));
    vi.unstubAllEnvs();
  });

  it("MOVESIZEEND → target.rect dirty with move_end schedule when LOCATION_EVENTS=1", () => {
    vi.stubEnv("DESKTOP_TOUCH_PERCEPTION_LOCATION_EVENTS", "1");
    const cbs = makeCallbacks();
    const bridge = new NativeSensorBridge(cbs);
    const index = createLensEventIndex();
    bridge.processBatch([makeEvent(EVENT_SYSTEM_MOVESIZEEND, "100")], index, new DirtyJournal());
    expect(cbs.onDirty).toHaveBeenCalledWith(
      "window:100", ["target.rect"], expect.any(String), 5000, undefined
    );
    expect(cbs.onSchedule).toHaveBeenCalledWith("move_end", expect.any(String));
    vi.unstubAllEnvs();
  });

  it("LOCATIONCHANGE → target.rect dirty with location schedule when LOCATION_EVENTS=1", () => {
    vi.stubEnv("DESKTOP_TOUCH_PERCEPTION_LOCATION_EVENTS", "1");
    const cbs = makeCallbacks();
    const bridge = new NativeSensorBridge(cbs);
    const index = createLensEventIndex();
    bridge.processBatch([makeEvent(EVENT_OBJECT_LOCATIONCHANGE, "100")], index, new DirtyJournal());
    expect(cbs.onDirty).toHaveBeenCalledWith(
      "window:100", ["target.rect"], expect.any(String), 5000, undefined
    );
    expect(cbs.onSchedule).toHaveBeenCalledWith("location", expect.any(String));
    vi.unstubAllEnvs();
  });

  it("REORDER → zOrder + modal dirty, EnumWindows needed when LOCATION_EVENTS=1", () => {
    vi.stubEnv("DESKTOP_TOUCH_PERCEPTION_LOCATION_EVENTS", "1");
    const cbs = makeCallbacks();
    const bridge = new NativeSensorBridge(cbs);
    const index = createLensEventIndex();
    bridge.processBatch([makeEvent(EVENT_OBJECT_REORDER, "100")], index, new DirtyJournal());
    expect(cbs.onDirty).toHaveBeenCalledWith(
      "window:100", ["target.zOrder", "modal.above"], expect.any(String), 5000, undefined
    );
    expect(cbs.onEnumWindowsNeeded).toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
