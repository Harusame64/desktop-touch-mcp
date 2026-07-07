/**
 * terminal-dispatch-hook.test.ts
 *
 * Unit tests for the ADR-014 v2 R3 L3-4 S-A dispatch hook seam in terminal.ts.
 *
 * The seam lets an external module (the Key Locker wiring) observe every
 * command dispatched into a terminal pane, mirroring the setTerminalReadHook
 * pattern. These tests exercise the PURE seam (registration + fire-and-forget
 * try/catch isolation) WITHOUT a live terminal / Win32 window — the fire path
 * inside the send/run handlers needs a resolved window, so we drive the
 * exported `fireTerminalDispatch` helper directly instead of faking Win32.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  setTerminalDispatchHook,
  fireTerminalDispatch,
  terminalSendHandler,
  terminalRunHandler,
  type TerminalDispatchEvent,
} from "../../src/tools/terminal.js";

// The hook is module-global state; always clear it after each test so cases
// cannot leak a registered observer into one another.
afterEach(() => {
  setTerminalDispatchHook(null);
});

describe("terminal dispatch hook seam", () => {
  it("delivers { paneId, command } to a registered hook exactly once", () => {
    const events: TerminalDispatchEvent[] = [];
    setTerminalDispatchHook((ev) => {
      events.push(ev);
    });

    fireTerminalDispatch("123456", "echo hello");

    expect(events).toEqual([{ paneId: "123456", command: "echo hello" }]);
  });

  it("does nothing (no throw) when no hook is registered — the default", () => {
    // No setTerminalDispatchHook call: default observer is null.
    expect(() => fireTerminalDispatch("789", "ls -la")).not.toThrow();
  });

  it("is a no-op after setTerminalDispatchHook(null) clears the observer", () => {
    let calls = 0;
    setTerminalDispatchHook(() => {
      calls += 1;
    });
    fireTerminalDispatch("1", "first");
    expect(calls).toBe(1);

    setTerminalDispatchHook(null);
    fireTerminalDispatch("1", "second"); // must NOT reach the old hook
    expect(calls).toBe(1);
  });

  it("isolates a throwing hook — fire-and-forget never propagates the throw", () => {
    let seen: TerminalDispatchEvent | null = null;
    setTerminalDispatchHook((ev) => {
      seen = ev;
      throw new Error("observer blew up");
    });

    // The throw inside the hook must be swallowed: a hook throw can never break
    // a dispatch.
    expect(() => fireTerminalDispatch("42", "rm -rf /tmp/x")).not.toThrow();
    // ...and the hook still received the event before it threw.
    expect(seen).toEqual({ paneId: "42", command: "rm -rf /tmp/x" });
  });

  it("isolates an async hook's rejection — no unhandled promise rejection (Codex PR#511 P2)", async () => {
    // The hook is typed `=> void`, but TypeScript accepts async functions here.
    // A rejection thrown AFTER the synchronous portion escapes the try/catch and
    // would surface as an unhandled promise rejection. fireTerminalDispatch must
    // attach its own rejection handler so a fire-and-forget observer can never
    // leak one out.
    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown): void => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      let seen: TerminalDispatchEvent | null = null;
      // An async function returns Promise<void>, which TypeScript accepts for
      // this `=> void`-typed slot. It rejects AFTER a microtask turn — the very
      // shape that escapes a plain synchronous try/catch.
      const asyncHook = async (ev: TerminalDispatchEvent): Promise<void> => {
        seen = ev;
        await Promise.resolve();
        throw new Error("async observer blew up");
      };
      setTerminalDispatchHook(asyncHook);

      expect(() => fireTerminalDispatch("77", "kubectl get pods")).not.toThrow();
      expect(seen).toEqual({ paneId: "77", command: "kubectl get pods" });

      // Give the microtask + a macrotask turn for any unhandled rejection to fire.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toBeNull();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("passes the caller-provided paneId/command through verbatim (no rewrite)", () => {
    const received: TerminalDispatchEvent[] = [];
    setTerminalDispatchHook((ev) => received.push(ev));

    // The handlers pass the USER's original text; the seam must not munge it.
    const command = 'echo "quoted && chained"; printf %s done';
    fireTerminalDispatch("100200300", command);

    expect(received).toHaveLength(1);
    expect(received[0].command).toBe(command);
    expect(received[0].paneId).toBe("100200300");
  });

  it("String(bigint) yields the bare decimal paneId the handlers rely on", () => {
    // The send/run handlers derive paneId as String(win.hwnd) where win.hwnd is
    // a bigint. Confirm that contract: a bare base-10 string, identical to
    // hwnd.toString(10) (no 0x prefix, no 'n' suffix, no separators).
    const hwnd = 0x1a2b3c4dn; // a representative bigint window handle
    const paneId = String(hwnd);
    expect(paneId).toBe(hwnd.toString(10));
    expect(paneId).toBe("439041101");
    expect(paneId).toMatch(/^\d+$/);
  });
});

describe("terminal dispatch hook — no phantom fire on delivery failure (Codex PR#511 P1)", () => {
  afterEach(() => {
    setTerminalDispatchHook(null);
  });

  // A window title that findTerminalWindow can never resolve. Both handlers
  // short-circuit at window resolution BEFORE any delivery path runs, so the
  // dispatch hook must not fire — the fix moved the notification to fire only
  // AFTER a delivery path actually mutates the pane. (Whether the native window
  // enumeration returns "not found" or throws when the addon is absent, the
  // outer failure path returns without delivering, so the assertion holds
  // without faking Win32.)
  const NO_WINDOW = "no_such_window_dispatch_hook_failpath_zzz";

  it("terminalSendHandler does NOT fire the hook when the window is not found", async () => {
    const events: TerminalDispatchEvent[] = [];
    setTerminalDispatchHook((ev) => events.push(ev));

    await terminalSendHandler({
      windowTitle: NO_WINDOW,
      input: "echo should-not-fire",
      method: "auto",
      chunkSize: 100,
      pressEnter: true,
      focusFirst: false,
      restoreFocus: false,
      preferClipboard: false,
      pasteKey: "auto",
      trackFocus: false,
      settleMs: 100,
    });

    expect(events).toEqual([]); // no delivery ⇒ no dispatch record
  });

  it("terminalRunHandler does NOT fire the hook when the window is not found", async () => {
    const events: TerminalDispatchEvent[] = [];
    setTerminalDispatchHook((ev) => events.push(ev));

    await terminalRunHandler({
      windowTitle: NO_WINDOW,
      input: "echo should-not-fire",
      until: { mode: "quiet", quietMs: 100 },
      timeoutMs: 1_000,
    });

    expect(events).toEqual([]); // window_not_found short-circuit ⇒ no dispatch record
  });
});
