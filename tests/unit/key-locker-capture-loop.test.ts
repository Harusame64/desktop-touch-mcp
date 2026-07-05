/**
 * key-locker-capture-loop.test.ts — ADR-014 R3 L3 §1 (the capture-on-use state machine).
 * Pins the MATCH autofill (+ D2 confirm backstop), the NO-MATCH capture→inject→landed→OFFER→[Save]
 * sequence with persist-only-on-consent (P1-2), and the reverse-orphan delete on every non-commit
 * exit including a thrown seam (P2-1). Pure orchestrator over injected fakes.
 */
import { describe, expect, it, vi } from "vitest";
import {
  runCaptureLoop,
  type CaptureLoopDeps,
  type CredentialEvent,
} from "../../src/engine/key-locker/capture-loop.js";
import type { BindingUri } from "../../src/engine/key-locker/binding.js";
import type { InjectResult } from "../../src/engine/key-locker/injector.js";
import type { LandedResult } from "../../src/engine/key-locker/landed-detection.js";

const SUDO: BindingUri = { scheme: "sudo", host: "localhost", targetUser: "root" };
const SSH: BindingUri = { scheme: "ssh", user: "deploy", host: "prod", port: 22, fpSet: ["SHA256:aaa"] };
const SSHKEY: BindingUri = { scheme: "sshkey", keyFp: "SHA256:zzz" };
const HTTPS: BindingUri = { scheme: "https-cred", host: "github.com", port: 443, user: "octocat" };

const SENDINPUT_OK = (verified = true): InjectResult => ({ ok: true, injector: "sendinput", verified });
const ABORT = (code: string): InjectResult => ({ ok: false, code: code as never });
const LANDED = (accepted: boolean, reason = accepted ? "exit_0" : "not_exit_0:timeout"): LandedResult =>
  ({ accepted, mode: "one-shot", reason });

const EVENT: CredentialEvent = { paneId: "pane-1", dispatchedCommand: "sudo -v" };

/** Fully-stubbed deps (known-local session, derives SUDO, NO-MATCH, inject ok, landed, [Save]); override per test. */
function makeDeps(o: Partial<CaptureLoopDeps> = {}): CaptureLoopDeps {
  return {
    getSession: vi.fn(() => ({ execHost: "localhost", isRemote: false })),
    deriveBinding: vi.fn(async () => SUDO),
    resolveBinding: vi.fn(async () => undefined), // NO MATCH by default
    bindBinding: vi.fn(),
    confirmPolicyFor: vi.fn(() => true),
    capture: vi.fn(async () => ({ captured: true })),
    deleteSecret: vi.fn(async () => {}),
    injectPane: vi.fn(async () => SENDINPUT_OK()),
    awaitLanded: vi.fn(async () => LANDED(true)),
    confirmInjection: vi.fn(async () => true),
    offerSave: vi.fn(async () => "save"),
    mintOpaqueId: vi.fn(() => "opaque-abc"),
    now: vi.fn(() => "2026-07-05T00:00:00.000Z"),
    ...o,
  };
}

describe("runCaptureLoop — declines (never touch the locker)", () => {
  it("UNKNOWN session ⇒ decline, no derive", async () => {
    const deps = makeDeps({ getSession: vi.fn(() => ({ unknown: true })) });
    expect(await runCaptureLoop(deps, EVENT)).toEqual({ kind: "declined", reason: "unknown_session" });
    expect(deps.deriveBinding).not.toHaveBeenCalled();
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it("deriveBinding null ⇒ decline (not a credential)", async () => {
    const deps = makeDeps({ deriveBinding: vi.fn(async () => null) });
    expect(await runCaptureLoop(deps, EVENT)).toEqual({ kind: "declined", reason: "not_a_credential" });
    expect(deps.resolveBinding).not.toHaveBeenCalled();
  });

  it("sshkey ⇒ decline (not pane-injectable — askpass forward flow, P3-2)", async () => {
    const deps = makeDeps({ deriveBinding: vi.fn(async () => SSHKEY) });
    expect(await runCaptureLoop(deps, EVENT)).toEqual({ kind: "declined", reason: "not_pane_channel" });
    expect(deps.resolveBinding).not.toHaveBeenCalled();
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it("https-cred ⇒ decline (git-credential forward flow)", async () => {
    const deps = makeDeps({ deriveBinding: vi.fn(async () => HTTPS) });
    expect(await runCaptureLoop(deps, EVENT)).toEqual({ kind: "declined", reason: "not_pane_channel" });
  });
});

describe("runCaptureLoop — MATCH (autofill a stored secret)", () => {
  it("confirm policy ON + confirmed ⇒ autofill with the stored opaqueId, no capture/bind", async () => {
    const deps = makeDeps({ resolveBinding: vi.fn(async () => ({ opaqueId: "stored-1" })) });
    expect(await runCaptureLoop(deps, EVENT)).toEqual({ kind: "filled_from_store", verified: true });
    expect(deps.confirmInjection).toHaveBeenCalledOnce();
    expect(deps.injectPane).toHaveBeenCalledWith(SUDO, "stored-1", true);
    expect(deps.capture).not.toHaveBeenCalled();
    expect(deps.bindBinding).not.toHaveBeenCalled();
  });

  it("confirm policy ON + REJECTED ⇒ confirm_rejected, no injection", async () => {
    const deps = makeDeps({
      resolveBinding: vi.fn(async () => ({ opaqueId: "stored-1" })),
      confirmInjection: vi.fn(async () => false),
    });
    expect(await runCaptureLoop(deps, EVENT)).toEqual({ kind: "confirm_rejected" });
    expect(deps.injectPane).not.toHaveBeenCalled();
  });

  it("confirm policy OFF ⇒ autofill without confirming (per-binding opt-out)", async () => {
    const deps = makeDeps({
      resolveBinding: vi.fn(async () => ({ opaqueId: "stored-1" })),
      confirmPolicyFor: vi.fn(() => false),
    });
    expect(await runCaptureLoop(deps, EVENT)).toEqual({ kind: "filled_from_store", verified: true });
    expect(deps.confirmInjection).not.toHaveBeenCalled();
  });

  it("MATCH inject abort ⇒ fill_aborted matched:true (no capture, no delete)", async () => {
    const deps = makeDeps({
      resolveBinding: vi.fn(async () => ({ opaqueId: "stored-1" })),
      injectPane: vi.fn(async () => ABORT("target_mismatch")),
    });
    expect(await runCaptureLoop(deps, EVENT)).toEqual({ kind: "fill_aborted", matched: true, code: "target_mismatch" });
    expect(deps.capture).not.toHaveBeenCalled();
    expect(deps.deleteSecret).not.toHaveBeenCalled();
  });

  it("filled_from_store.verified passes through the locker re-verify bit", async () => {
    const deps = makeDeps({
      resolveBinding: vi.fn(async () => ({ opaqueId: "stored-1" })),
      injectPane: vi.fn(async () => SENDINPUT_OK(false)),
    });
    expect(await runCaptureLoop(deps, EVENT)).toEqual({ kind: "filled_from_store", verified: false });
  });
});

describe("runCaptureLoop — NO MATCH (capture → inject → landed → OFFER → save/discard)", () => {
  it("landed + [Save] ⇒ bind the captured opaqueId + RETAIN (no delete)", async () => {
    const deps = makeDeps();
    expect(await runCaptureLoop(deps, EVENT)).toEqual({ kind: "saved", verified: true });
    expect(deps.capture).toHaveBeenCalledWith("opaque-abc");
    expect(deps.offerSave).toHaveBeenCalledOnce();
    expect(deps.bindBinding).toHaveBeenCalledWith("sudo://localhost/root", "opaque-abc", {
      scheme: "sudo",
      displayUri: "sudo://localhost/root",
      host: "localhost",
      targetUser: "root",
      createdAt: "2026-07-05T00:00:00.000Z",
    });
    expect(deps.deleteSecret).not.toHaveBeenCalled();
  });

  it("OFFER precedes PERSIST — offerSave is awaited before bindBinding (P1-2 ordering)", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      offerSave: vi.fn(async () => { order.push("offer"); return "save"; }),
      bindBinding: vi.fn(() => { order.push("bind"); }),
    });
    await runCaptureLoop(deps, EVENT);
    expect(order).toEqual(["offer", "bind"]);
  });

  it("landed + [Not now] ⇒ discard (delete, no bind)", async () => {
    const deps = makeDeps({ offerSave: vi.fn(async () => "not_now") });
    expect(await runCaptureLoop(deps, EVENT)).toEqual({ kind: "discarded", reason: "not_now" });
    expect(deps.bindBinding).not.toHaveBeenCalled();
    expect(deps.deleteSecret).toHaveBeenCalledWith("opaque-abc");
  });

  it("landed + [Never] ⇒ discard (delete, no bind)", async () => {
    const deps = makeDeps({ offerSave: vi.fn(async () => "never") });
    expect(await runCaptureLoop(deps, EVENT)).toEqual({ kind: "discarded", reason: "never" });
    expect(deps.deleteSecret).toHaveBeenCalledWith("opaque-abc");
  });

  it("NOT landed (exit≠0 / timeout) ⇒ discard, OFFER never shown (D5 save-gate)", async () => {
    const deps = makeDeps({ awaitLanded: vi.fn(async () => LANDED(false, "not_exit_0:timeout")) });
    expect(await runCaptureLoop(deps, EVENT)).toEqual({ kind: "discarded", reason: "not_landed", detail: "not_exit_0:timeout" });
    expect(deps.offerSave).not.toHaveBeenCalled();
    expect(deps.bindBinding).not.toHaveBeenCalled();
    expect(deps.deleteSecret).toHaveBeenCalledWith("opaque-abc");
  });

  it("capture CANCELLED ⇒ no inject, no delete (nothing was stored)", async () => {
    const deps = makeDeps({ capture: vi.fn(async () => ({ captured: false })) });
    expect(await runCaptureLoop(deps, EVENT)).toEqual({ kind: "capture_cancelled" });
    expect(deps.injectPane).not.toHaveBeenCalled();
    expect(deps.deleteSecret).not.toHaveBeenCalled();
    expect(deps.bindBinding).not.toHaveBeenCalled();
  });

  it("inject abort AFTER capture ⇒ fill_aborted matched:false + DELETE the capture", async () => {
    const deps = makeDeps({ injectPane: vi.fn(async () => ABORT("not_foreground")) });
    expect(await runCaptureLoop(deps, EVENT)).toEqual({ kind: "fill_aborted", matched: false, code: "not_foreground" });
    expect(deps.awaitLanded).not.toHaveBeenCalled();
    expect(deps.deleteSecret).toHaveBeenCalledWith("opaque-abc");
    expect(deps.bindBinding).not.toHaveBeenCalled();
  });
});

describe("runCaptureLoop — reverse-orphan closure on a thrown seam (P2-1)", () => {
  it("offerSave THROWS ⇒ delete the capture + typed fill_aborted (never a save)", async () => {
    const deps = makeDeps({ offerSave: vi.fn(async () => { throw new Error("dialog crashed"); }) });
    const r = await runCaptureLoop(deps, EVENT);
    expect(r.kind).toBe("fill_aborted");
    expect((r as { code: string }).code).toContain("loop_error:dialog crashed");
    expect(deps.deleteSecret).toHaveBeenCalledWith("opaque-abc");
    expect(deps.bindBinding).not.toHaveBeenCalled();
  });

  it("injectPane THROWS after capture ⇒ delete the capture (no orphan)", async () => {
    const deps = makeDeps({ injectPane: vi.fn(async () => { throw new Error("pipe drop"); }) });
    const r = await runCaptureLoop(deps, EVENT);
    expect(r.kind).toBe("fill_aborted");
    expect(deps.deleteSecret).toHaveBeenCalledWith("opaque-abc");
  });

  it("capture THROWS ⇒ delete defensively (may have stored before the reply dropped)", async () => {
    const deps = makeDeps({ capture: vi.fn(async () => { throw new Error("capture pipe timeout"); }) });
    const r = await runCaptureLoop(deps, EVENT);
    expect(r.kind).toBe("fill_aborted");
    expect(deps.deleteSecret).toHaveBeenCalledWith("opaque-abc");
  });

  it("a deleteSecret failure never masks the outcome (best-effort residual)", async () => {
    const deps = makeDeps({
      offerSave: vi.fn(async () => "not_now"),
      deleteSecret: vi.fn(async () => { throw new Error("delete failed"); }),
    });
    expect(await runCaptureLoop(deps, EVENT)).toEqual({ kind: "discarded", reason: "not_now" });
  });
});

describe("runCaptureLoop — metaFor per scheme + submit", () => {
  it("ssh save records host/user/port/fpSet + the resolved displayUri", async () => {
    const deps = makeDeps({ deriveBinding: vi.fn(async () => SSH) });
    await runCaptureLoop(deps, EVENT);
    expect(deps.bindBinding).toHaveBeenCalledWith(
      "ssh://deploy@prod:22|fp=SHA256:aaa",
      "opaque-abc",
      {
        scheme: "ssh",
        displayUri: "ssh://deploy@prod",
        host: "prod",
        user: "deploy",
        port: 22,
        fpSet: ["SHA256:aaa"],
        createdAt: "2026-07-05T00:00:00.000Z",
      },
    );
  });

  it("submit:false is threaded to injectPane; default is submit:true", async () => {
    const deps = makeDeps({ resolveBinding: vi.fn(async () => ({ opaqueId: "s" })) });
    await runCaptureLoop(deps, { ...EVENT, submit: false });
    expect(deps.injectPane).toHaveBeenCalledWith(SUDO, "s", false);

    const deps2 = makeDeps({ resolveBinding: vi.fn(async () => ({ opaqueId: "s" })) });
    await runCaptureLoop(deps2, EVENT);
    expect(deps2.injectPane).toHaveBeenCalledWith(SUDO, "s", true);
  });
});
