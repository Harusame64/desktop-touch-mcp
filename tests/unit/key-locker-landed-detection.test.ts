/**
 * key-locker-landed-detection.test.ts — ADR-014 R3 L3 §2 (the two-mode save-gate).
 * Pins the mode classifier, the Mode-A exit-0 rule, the Mode-B auth accept/reject rule, and the
 * awaitLanded orchestration over injected seams.
 */
import { describe, expect, it } from "vitest";
import {
  awaitLanded,
  classifyLandedMode,
  isAuthAccepted,
  isExitAccepted,
  type LandedDeps,
} from "../../src/engine/key-locker/landed-detection.js";

describe("classifyLandedMode", () => {
  it("interactive logins → interactive (Mode B)", () => {
    for (const cmd of [
      "ssh user@host",
      "ssh -p 2222 deploy@prod.example.com",
      "LC_ALL=C ssh user@host", // env-assign prefix skipped
      "sudo -i",
      "sudo -s",
      "sudo --login",
      "su",
      "su -",
      "su postgres",
    ]) {
      expect(classifyLandedMode(cmd)).toBe("interactive");
    }
  });

  it("one-shot commands → one-shot (Mode A)", () => {
    for (const cmd of [
      "ssh host uptime", // one-shot remote command
      "ssh -N -L 5432:localhost:5432 host", // port-forward, no shell
      "ssh -f user@host tunnel", // backgrounded
      "sudo apt update", // plain sudo command
      "git push",
      "ssh-keygen -y -f ~/.ssh/id_ed25519",
      "echo hi",
    ]) {
      expect(classifyLandedMode(cmd)).toBe("one-shot");
    }
  });

  it("a later interactive segment still classifies interactive (`cd x && ssh user@host`)", () => {
    expect(classifyLandedMode("cd /tmp && ssh user@host")).toBe("interactive");
  });
});

describe("isExitAccepted (Mode A)", () => {
  it("accepts only reason=exited + exitCode 0", () => {
    expect(isExitAccepted({ reason: "exited", exitCode: 0 })).toBe(true);
    expect(isExitAccepted({ reason: "exited", exitCode: 1 })).toBe(false);
    expect(isExitAccepted({ reason: "exited" })).toBe(false); // no code
    expect(isExitAccepted({ reason: "timeout" })).toBe(false);
    expect(isExitAccepted({ reason: "quiet" })).toBe(false);
    expect(isExitAccepted({ reason: "pattern_matched", exitCode: 0 })).toBe(false); // wrong reason
  });
});

describe("isAuthAccepted (Mode B)", () => {
  it("accepts when the prompt cleared and no denial line appeared", () => {
    expect(isAuthAccepted("deploy@prod:~$ ", false)).toBe(true);
  });
  it("rejects on a denial line even if the prompt cleared", () => {
    for (const tail of [
      "Permission denied, please try again.",
      "sudo: 3 incorrect password attempts",
      "su: Authentication failure",
      "Access denied",
      "Received disconnect: Too many authentication failures",
    ]) {
      expect(isAuthAccepted(tail, false)).toBe(false);
    }
  });
  it("rejects when a hidden-input prompt is still present (re-prompt)", () => {
    expect(isAuthAccepted("[sudo] password for user: ", true)).toBe(false);
  });
});

describe("awaitLanded", () => {
  const modeADeps = (completion: { reason: string; exitCode?: number }): LandedDeps => ({
    runToExit: async () => completion,
    readPaneAfterAuth: async () => { throw new Error("Mode A must not read the pane"); },
  });
  const modeBDeps = (tail: string, stillHiddenPrompt: boolean): LandedDeps => ({
    runToExit: async () => { throw new Error("Mode B must not run exit mode"); },
    readPaneAfterAuth: async () => ({ tail, stillHiddenPrompt }),
  });

  it("Mode A (one-shot): exit 0 → accepted, exit 1 → rejected", async () => {
    expect(await awaitLanded(modeADeps({ reason: "exited", exitCode: 0 }), "git push")).toMatchObject({ accepted: true, mode: "one-shot", reason: "exit_0" });
    const r = await awaitLanded(modeADeps({ reason: "exited", exitCode: 1 }), "git push");
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("not_exit_0:exited");
  });

  it("Mode A: a timeout is not-landed (fail safe, no save)", async () => {
    const r = await awaitLanded(modeADeps({ reason: "timeout" }), "sudo -v");
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("not_exit_0:timeout");
  });

  it("Mode B (interactive): prompt cleared + no denial → accepted; denial → rejected", async () => {
    expect(await awaitLanded(modeBDeps("user@host:~$ ", false), "ssh user@host")).toMatchObject({ accepted: true, mode: "interactive", reason: "auth_accepted" });
    expect(await awaitLanded(modeBDeps("Permission denied, please try again.", true), "ssh user@host")).toMatchObject({ accepted: false, mode: "interactive", reason: "auth_rejected" });
  });
});
