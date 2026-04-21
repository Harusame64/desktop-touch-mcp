import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

import { isDisconnectError, wireLauncherStdio } from "../../bin/launcher.js";

class MockReadable extends EventEmitter {
  pipe = vi.fn();
}

class MockWritable extends EventEmitter {
  end = vi.fn();
  pipe = vi.fn();
  on = super.on.bind(this);
}

class MockChildProcess extends EventEmitter {
  stdin = new MockWritable();
  stdout = new MockReadable();
  stderr = new MockReadable();
  killed = false;
  exitCode = null;
  kill = vi.fn((signal?: string) => {
    this.killed = true;
    this.exitCode = signal ? 1 : 0;
    return true;
  });
}

describe("isDisconnectError", () => {
  it("recognizes EPIPE and ERR_STREAM_DESTROYED", () => {
    expect(isDisconnectError({ code: "EPIPE" })).toBe(true);
    expect(isDisconnectError({ code: "ERR_STREAM_DESTROYED" })).toBe(true);
    expect(isDisconnectError({ code: "ENOENT" })).toBe(false);
  });
});

describe("wireLauncherStdio", () => {
  it("pipes parent stdio into the child and back out", () => {
    const parentStdin = new MockReadable();
    const parentStdout = new MockWritable();
    const parentStderr = new MockWritable();
    const child = new MockChildProcess();

    wireLauncherStdio(child as never, {
      parentStdin: parentStdin as never,
      parentStdout: parentStdout as never,
      parentStderr: parentStderr as never,
      shutdownGraceMs: 5,
    });

    expect(parentStdin.pipe).toHaveBeenCalledWith(child.stdin);
    expect(child.stdout.pipe).toHaveBeenCalledWith(parentStdout);
    expect(child.stderr.pipe).toHaveBeenCalledWith(parentStderr);
  });

  it("requests graceful child shutdown when parent stdin closes", async () => {
    vi.useFakeTimers();
    try {
      const parentStdin = new MockReadable();
      const parentStdout = new MockWritable();
      const parentStderr = new MockWritable();
      const child = new MockChildProcess();

      wireLauncherStdio(child as never, {
        parentStdin: parentStdin as never,
        parentStdout: parentStdout as never,
        parentStderr: parentStderr as never,
        shutdownGraceMs: 25,
      });

      parentStdin.emit("end");
      expect(child.stdin.end).toHaveBeenCalledTimes(1);
      expect(child.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(25);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates the child immediately when parent stdout breaks", () => {
    const parentStdin = new MockReadable();
    const parentStdout = new MockWritable();
    const parentStderr = new MockWritable();
    const child = new MockChildProcess();

    wireLauncherStdio(child as never, {
      parentStdin: parentStdin as never,
      parentStdout: parentStdout as never,
      parentStderr: parentStderr as never,
      shutdownGraceMs: 25,
    });

    parentStdout.emit("error", { code: "EPIPE" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
