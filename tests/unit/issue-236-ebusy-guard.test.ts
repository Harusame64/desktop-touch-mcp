/**
 * issue-236-ebusy-guard.test.ts — Phase 7 follow-up unit tests.
 *
 * Pins the issue #236 file-lock collision detector exposed by
 * `terminal.ts::detectFileLockCollision`. Covers the three platform-shape
 * patterns (Node.js EBUSY, Windows native, POSIX advisory lock) plus the
 * negative cases (empty / no signal) that the run-handler relies on to
 * skip the warning push when output is clean.
 *
 * The integration glue lives inline in `terminalRunHandler` (post-final-
 * read, after `output` is populated). Pure unit testing of the handler
 * is heavy (mocks for findTerminalWindow / readTerminalRaw / quiet
 * polling) so this file pins the **decision logic** that the integration
 * glue invokes — no UIA or PowerShell side effects.
 *
 * If any pattern in `terminal.ts::*_PATTERN` constants is touched, mirror
 * the change here in the same PR.
 */

import { describe, it, expect } from "vitest";
import { detectFileLockCollision } from "../../src/tools/terminal.js";

describe("Issue #236: detectFileLockCollision — Node EBUSY", () => {
  it("Node EBUSY with absolute Windows path → FileLockCollision warning + path extraction", () => {
    const output = `node:events:487
      throw er; // Unhandled 'error' event
      ^

Error: EBUSY: resource busy or locked, open 'D:\\git\\desktop-touch-mcp\\.vitest-out.txt'
Emitted 'error' event on WriteStream instance at: ...`;
    const result = detectFileLockCollision(output);
    expect(result).not.toBeNull();
    expect(result).toContain("FileLockCollision:");
    expect(result).toContain("D:\\git\\desktop-touch-mcp\\.vitest-out.txt");
    expect(result).toContain("'>' redirect collided");
  });

  it("Node EBUSY on POSIX path → match", () => {
    const output = "Error: EBUSY: resource busy or locked, open '/tmp/output.txt'";
    expect(detectFileLockCollision(output)).toContain("/tmp/output.txt");
  });

  it("Node EBUSY with stat verb (not just open) → match", () => {
    // `lstat` / `stat` / `unlink` etc. all surface as the same shape.
    const output =
      "Error: EBUSY: resource busy or locked, unlink 'D:\\foo\\bar.lock'";
    const result = detectFileLockCollision(output);
    expect(result).toContain("FileLockCollision:");
    expect(result).toContain("D:\\foo\\bar.lock");
  });

  it("Node EBUSY without quoted path → no match (defensive — incomplete error)", () => {
    // Bare "EBUSY: resource busy or locked" without the `verb 'path'` tail
    // is too generic to act on. Skip rather than emit a vague warning.
    const output = "Error: EBUSY: resource busy or locked";
    expect(detectFileLockCollision(output)).toBeNull();
  });
});

describe("Issue #236: detectFileLockCollision — Windows native", () => {
  it("Windows file-lock English string → match", () => {
    const output =
      "The process cannot access the file because it is being used by another process.";
    const result = detectFileLockCollision(output);
    expect(result).toContain("FileLockCollision:");
    expect(result).toContain("Windows file-lock");
  });

  it("Windows file-lock embedded in larger output → match (case-insensitive)", () => {
    const output = `move foo.txt bar/
The process Cannot access the FILE because it is being used by another process.
operation failed`;
    expect(detectFileLockCollision(output)).toContain("Windows file-lock");
  });
});

describe("Issue #236: detectFileLockCollision — POSIX advisory lock", () => {
  it("EAGAIN + Resource temporarily unavailable → match", () => {
    const output = `flock: cannot apply lock
errno: EAGAIN
Resource temporarily unavailable`;
    const result = detectFileLockCollision(output);
    expect(result).toContain("FileLockCollision:");
    expect(result).toContain("POSIX advisory lock");
  });

  it("EDEADLK with surrounding text → match", () => {
    const output =
      "fcntl(F_SETLK): EDEADLK\n  Resource temporarily unavailable\nbailing out";
    expect(detectFileLockCollision(output)).toContain("EAGAIN/EDEADLK");
  });

  it("EAGAIN without 'Resource temporarily unavailable' → no match (other EAGAIN uses)", () => {
    // EAGAIN appears in other contexts (non-blocking I/O retry). Avoid
    // false-positive by requiring the explicit lock-context string.
    const output = "read returned EAGAIN, retrying";
    expect(detectFileLockCollision(output)).toBeNull();
  });
});

describe("Issue #236: detectFileLockCollision — negative cases", () => {
  it("empty string → null (skip warning push)", () => {
    expect(detectFileLockCollision("")).toBeNull();
  });

  it("plain command output (no error) → null", () => {
    const output = "Hello, world!\nDone.\n";
    expect(detectFileLockCollision(output)).toBeNull();
  });

  it("output mentioning EBUSY in documentation context → null", () => {
    // A README excerpt, error-handling docs, etc. that quote "EBUSY"
    // without the actual error shape should NOT match.
    const output =
      "When you see EBUSY in your logs, check for orphan handles.";
    expect(detectFileLockCollision(output)).toBeNull();
  });

  it("output with 'resource busy or locked' but no EBUSY context → null", () => {
    // Defensive: Node's exact "EBUSY: resource busy or locked, verb 'path'"
    // shape is required. A free-form sentence containing "resource busy or
    // locked" without EBUSY shouldn't match.
    const output = "system note: resource busy or locked at startup";
    expect(detectFileLockCollision(output)).toBeNull();
  });
});

describe("Issue #236: detectFileLockCollision — priority ordering", () => {
  it("Node EBUSY beats Windows lock string when both present (Node has path detail)", () => {
    // If both patterns appear (rare, but possible in mixed-tool pipes),
    // the Node match wins because it carries the actionable path. Caller
    // gets one warning, not two.
    const output = `Error: EBUSY: resource busy or locked, open 'C:\\foo.txt'
Note: The process cannot access the file because it is being used by another process.`;
    const result = detectFileLockCollision(output);
    expect(result).toContain("Node EBUSY");
    expect(result).toContain("C:\\foo.txt");
    expect(result).not.toContain("Windows file-lock");
  });
});
