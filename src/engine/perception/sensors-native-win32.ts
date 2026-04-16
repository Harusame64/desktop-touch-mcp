/**
 * sensors-native-win32.ts
 *
 * Bridge between the raw WinEvent queue and the DirtyJournal / FlushScheduler.
 * Consumes batches of raw events, maps each event code to dirty properties,
 * dispatches only to lenses affected via LensEventIndex, and schedules refreshes.
 *
 * Pure mapping logic — no direct Win32 imports. All side effects go through
 * the injected callbacks (onDirty, onSchedule).
 */

import type { RawWinEvent } from "./raw-event-queue.js";
import type { DirtyJournal } from "./dirty-journal.js";
import type { FlushScheduler, PropertyClass } from "./flush-scheduler.js";
import type { LensEventIndex } from "./lens-event-index.js";
import { lensesForHwnd, lensesForForegroundEvent } from "./lens-event-index.js";

// ── WinEvent constants ────────────────────────────────────────────────────────

export const EVENT_SYSTEM_FOREGROUND        = 0x0003;
export const EVENT_SYSTEM_MOVESIZESTART     = 0x000A;
export const EVENT_SYSTEM_MOVESIZEEND       = 0x000B;
export const EVENT_OBJECT_SHOW              = 0x8002;
export const EVENT_OBJECT_HIDE              = 0x8003;
export const EVENT_OBJECT_DESTROY          = 0x8001;
export const EVENT_OBJECT_NAMECHANGE        = 0x800C;
export const EVENT_OBJECT_LOCATIONCHANGE    = 0x800B;
export const EVENT_OBJECT_REORDER          = 0x8004;

// OBJID_WINDOW — events with idObject !== 0 are sub-objects we generally ignore
const OBJID_WINDOW = 0;

// ── Mapping table: event → { dirtyProps, severity, propertyClass } ───────────

interface EventMapping {
  dirtyProps: string[];
  severity?: "hint" | "structural" | "identityRisk";
  propertyClass: PropertyClass;
  /** If true, fan out to all foreground-sensitive lenses, not just byHwnd */
  foregroundFanout?: boolean;
  /** If true, trigger EnumWindows (needsEnumWindows in RefreshPlan) */
  needsEnumWindows?: boolean;
}

// Phase 5-A events only (location/reorder in Milestone 4 behind LOCATION_EVENTS flag)
const PHASE5A_EVENT_MAP: Map<number, EventMapping> = new Map([
  [EVENT_SYSTEM_FOREGROUND, {
    dirtyProps: ["target.foreground"],
    propertyClass: "foreground",
    foregroundFanout: true,
  }],
  [EVENT_OBJECT_SHOW, {
    dirtyProps: ["target.exists"],
    severity: "structural",
    propertyClass: "show_hide",
    needsEnumWindows: true,
  }],
  [EVENT_OBJECT_HIDE, {
    dirtyProps: ["target.exists"],
    severity: "structural",
    propertyClass: "show_hide",
    needsEnumWindows: true,
  }],
  [EVENT_OBJECT_DESTROY, {
    dirtyProps: ["target.exists"],
    severity: "structural",
    propertyClass: "show_hide",
    needsEnumWindows: true,
  }],
  [EVENT_OBJECT_NAMECHANGE, {
    dirtyProps: ["target.title"],
    propertyClass: "title",
  }],
]);

// Milestone 4 events (location/reorder) — added when LOCATION_EVENTS=1
const LOCATION_EVENT_MAP: Map<number, EventMapping> = new Map([
  [EVENT_SYSTEM_MOVESIZESTART, {
    dirtyProps: ["target.rect", "stable.rect"],
    propertyClass: "move_start",
  }],
  [EVENT_SYSTEM_MOVESIZEEND, {
    dirtyProps: ["target.rect"],
    propertyClass: "move_end",
  }],
  [EVENT_OBJECT_LOCATIONCHANGE, {
    dirtyProps: ["target.rect"],
    propertyClass: "location",
  }],
  [EVENT_OBJECT_REORDER, {
    dirtyProps: ["target.zOrder", "modal.above"],
    propertyClass: "reorder",
    needsEnumWindows: true,
  }],
]);

// ── NativeSensorBridge ────────────────────────────────────────────────────────

export interface NativeSensorBridgeCallbacks {
  /** Called when events need to be dispatched to the DirtyJournal. */
  onDirty(entityKey: string, props: string[], cause: string, monoMs: number, severity?: "hint" | "structural" | "identityRisk"): void;
  /** Called when a global dirty (overflow) should be emitted. */
  onGlobalDirty(cause: string, monoMs: number): void;
  /** Called to schedule a refresh flush. */
  onSchedule(propertyClass: PropertyClass, reason?: string): void;
  /** Called when needsEnumWindows is required by the event. */
  onEnumWindowsNeeded(reason: string): void;
}

export class NativeSensorBridge {
  private readonly locationEventsEnabled: boolean;

  constructor(private readonly cbs: NativeSensorBridgeCallbacks) {
    this.locationEventsEnabled = process.env.DESKTOP_TOUCH_PERCEPTION_LOCATION_EVENTS === "1";
  }

  /**
   * Process a batch of raw events from the queue.
   * All lensId lookups go through LensEventIndex for subset dispatch.
   */
  processBatch(events: RawWinEvent[], index: LensEventIndex, _journal: DirtyJournal): void {
    for (const ev of events) {
      // Only process OBJID_WINDOW events for window handle targeting
      if (ev.idObject !== OBJID_WINDOW) continue;
      if (ev.hwnd === "0") continue;

      const mapping = this.resolveMapping(ev.event);
      if (!mapping) continue;

      // Determine which lens IDs are affected
      const affectedLensIds = mapping.foregroundFanout
        ? lensesForForegroundEvent(index, ev.hwnd)
        : lensesForHwnd(index, ev.hwnd);

      const entityKey = `window:${ev.hwnd}`;
      const cause     = `winevent_0x${ev.event.toString(16).padStart(4, "0")}`;

      // Mark dirty for the event source window
      this.cbs.onDirty(entityKey, mapping.dirtyProps, cause, ev.receivedAtMonoMs, mapping.severity);

      // For foreground fanout, also mark ALL foreground-sensitive lens windows as dirty.
      // A foreground event on hwnd X means every other window lost foreground — their
      // target.foreground fluents are now stale regardless of which hwnd gained focus.
      if (mapping.foregroundFanout && affectedLensIds.size > 0) {
        for (const lensId of affectedLensIds) {
          const lensHwnd = index.lensToHwnd.get(lensId);
          if (lensHwnd && lensHwnd !== ev.hwnd) {
            this.cbs.onDirty(`window:${lensHwnd}`, mapping.dirtyProps, cause, ev.receivedAtMonoMs, mapping.severity);
          }
        }
      }

      // Schedule flush
      this.cbs.onSchedule(mapping.propertyClass, `${cause}:hwnd=${ev.hwnd}`);

      // Trigger EnumWindows if needed
      if (mapping.needsEnumWindows) {
        this.cbs.onEnumWindowsNeeded(cause);
      }
    }
  }

  /** Handle a queue overflow — emit global dirty and schedule immediate flush. */
  processOverflow(monoMs: number): void {
    this.cbs.onGlobalDirty("queue_overflow", monoMs);
    this.cbs.onSchedule("overflow", "queue_overflow");
  }

  private resolveMapping(eventCode: number): EventMapping | undefined {
    const phase5a = PHASE5A_EVENT_MAP.get(eventCode);
    if (phase5a) return phase5a;
    if (this.locationEventsEnabled) {
      return LOCATION_EVENT_MAP.get(eventCode);
    }
    return undefined;
  }
}
