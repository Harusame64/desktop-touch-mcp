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

  it("requests graceful child shutdown when parent stdin closes after the child produced output", async () => {
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

      child.stderr.emit("data", Buffer.from("ready"));
      parentStdin.emit("end");
      expect(child.stdin.end).toHaveBeenCalledTimes(1);
      expect(child.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(25);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds off SIGTERM for a child that has produced no output (startup grace)", async () => {
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
        startupGraceMs: 100,
      });

      parentStdin.emit("end");
      expect(child.stdin.end).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(25);
      expect(child.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(75);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the startup ceiling when the first byte arrives while it is pending", async () => {
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
        startupGraceMs: 100,
      });

      parentStdin.emit("end");
      await vi.advanceTimersByTimeAsync(10);
      child.stdout.emit("data", Buffer.from("x"));

      // Early output must NOT shorten the pending ceiling: the runtime
      // prints engine diagnostics long before it can parse its CLI.
      await vi.advanceTimersByTimeAsync(15);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(64);
      expect(child.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(11);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the pending forced shutdown when the child exits during the startup grace", async () => {
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
        startupGraceMs: 100,
      });

      parentStdin.emit("end");
      child.emit("exit", 0, null);

      await vi.advanceTimersByTimeAsync(200);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not leave a stray timer when output arrives after the forced shutdown fired", async () => {
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
        startupGraceMs: 100,
      });

      parentStdin.emit("end");
      await vi.advanceTimersByTimeAsync(100);
      expect(child.kill).toHaveBeenCalledTimes(1);

      child.stdout.emit("data", Buffer.from("late"));
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(1000);
      expect(child.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not arm a timer when output arrives after an EPIPE termination", async () => {
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
        startupGraceMs: 100,
      });

      parentStdout.emit("error", { code: "EPIPE" });
      expect(child.kill).toHaveBeenCalledTimes(1);

      child.stdout.emit("data", Buffer.from("late"));
      expect(vi.getTimerCount()).toBe(0);
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
