/**
 * ADR-036 stage 2 B2b — the presenter resolves advice against ONE captured
 * configuration, and no advice line is converted yet.
 *
 * WHAT THIS ROUND CLAIMS, and what it deliberately does not: the wire is live and the
 * bytes do not move. Those are two statements and they need two instruments — "nothing
 * changed" is exactly what a DEAD wire also produces, so a byte comparison alone
 * cannot tell a working seam from an absent one. Every cell here is one of the two:
 * a line with a placeholder proves the wire, a line without one proves the bytes.
 *
 * WHY A CAPTURE AT ALL (gate 2, 2026-09-13, on the mechanism PR): the server reads the
 * two switches at different moments — the v2 flag once at module init, the locker per
 * `createMcpServer()` — while the resolver used to read ambient env at call time. The
 * cell that splits those two answers is the one that MOVES `process.env` after the
 * capture; a cell that leaves the environment still cannot tell them apart, which is
 * why win2's four-corner harness (one env per server, fixed before start) structurally
 * cannot judge this and says so in its own header.
 */
import { describe, it, expect } from "vitest";
import {
  captureAdviceConfiguration,
  adviceConfigurationWasCaptured,
  resetAdviceConfiguration,
  renderAdviceForCaller,
} from "../../src/tools/_advice-capability.js";
import { toToolFailure } from "../../src/tools/_errors.js";
import { ToolFailureError } from "../../src/errors/typed-errors.js";
import { buildFailureEnvelope } from "../../src/tools/_envelope.js";

const KEY = "DESKTOP_TOUCH_DISABLE_KEY_LOCKER";
const V2 = "DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2";

/** Run `body` with `process.env` set as given, and put the environment back. */
function withEnv(patch: Record<string, string | undefined>, body: () => void): void {
  const had = new Map<string, string | undefined>();
  for (const k of Object.keys(patch)) had.set(k, process.env[k]);
  try {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    body();
  } finally {
    for (const [k, v] of had) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetAdviceConfiguration();
  }
}

describe("ADR-036 B2b — the presenter reads one captured configuration", () => {
  it("follows the CAPTURE, not the environment as it stands when the advice is built", () => {
    // The whole point of the round, and the only shape that separates the two answers.
    withEnv({ [KEY]: undefined }, () => {
      captureAdviceConfiguration(process.env); // locker ON at registration
      process.env[KEY] = "1"; // …and someone turns it off afterwards
      expect(renderAdviceForCaller(["use {tool:credential_store}"])).toEqual(["use key_locker"]);
    });
    // And the other direction, so this is not one-sided: captured OFF stays off even
    // when the ambient environment says the locker is back.
    withEnv({ [KEY]: "1" }, () => {
      captureAdviceConfiguration(process.env);
      delete process.env[KEY];
      expect(renderAdviceForCaller(["use {tool:credential_store}"])).toEqual([]);
    });
  });

  it("falls back to the live environment when nothing captured — and says which it is", () => {
    // The fallback keeps every non-server caller working, and it is also how a
    // forgotten capture would hide. So it is pinned, and the state is readable.
    withEnv({ [KEY]: undefined }, () => {
      resetAdviceConfiguration();
      expect(adviceConfigurationWasCaptured()).toBe(false);
      expect(renderAdviceForCaller(["use {tool:credential_store}"])).toEqual(["use key_locker"]);
      captureAdviceConfiguration(process.env);
      expect(adviceConfigurationWasCaptured()).toBe(true);
    });
  });

  it("resolves through the FLAT road — the wire is live, not merely quiet", () => {
    withEnv({ [V2]: undefined }, () => {
      captureAdviceConfiguration(process.env);
      const flat = toToolFailure(
        new ToolFailureError("WindowNotFound", {
          displayMessage: "no window",
          suggest: ["Run {tool:list_window_titles} to see the titles"],
        }),
      );
      expect(flat.suggest).toEqual(["Run desktop_discover to see the titles"]);
    });
    withEnv({ [V2]: "1" }, () => {
      captureAdviceConfiguration(process.env);
      const flat = toToolFailure(
        new ToolFailureError("WindowNotFound", {
          displayMessage: "no window",
          suggest: ["Run {tool:list_window_titles} to see the titles"],
        }),
      );
      expect(flat.suggest).toEqual(["Run get_windows to see the titles"]);
    });
  });

  it("resolves through the ENVELOPE road, and drops a row whose capability is absent", () => {
    withEnv({ [V2]: "1", [KEY]: "1" }, () => {
      captureAdviceConfiguration(process.env);
      const env = buildFailureEnvelope("WindowNotFound", [
        { action: "Run {tool:list_window_titles} to see the titles" },
        { action: "Then {tool:credential_store} for the secret" },
        { action: "Plain advice, no placeholder" },
      ]);
      expect(env.if_unexpected.try_next).toEqual([
        { action: "Run get_windows to see the titles" },
        { action: "Plain advice, no placeholder" },
      ]);
    });
  });

  it("moves NO byte of a line that carries no placeholder, on either road", () => {
    // The other half. Today every shipped advice line is this case, which is why the
    // Windows measurement expects byte identity for the whole corpus.
    const lines = [
      "Re-run desktop_discover and act on the fresh entity",
      "Call key_locker({action:'launch_console'}) to get the paneId back",
      "run_macro({tool:\"screenshot\", args:{}}) is the product's own syntax",
    ];
    for (const corner of [{ [V2]: undefined }, { [V2]: "1" }]) {
      withEnv(corner, () => {
        captureAdviceConfiguration(process.env);
        expect(renderAdviceForCaller(lines)).toEqual(lines);
        const flat = toToolFailure(
          new ToolFailureError("ToolError", { displayMessage: "x", suggest: lines }),
        );
        expect(flat.suggest).toEqual(lines);
        const env = buildFailureEnvelope("ToolError", lines.map((action) => ({ action })));
        expect(env.if_unexpected.try_next).toEqual(lines.map((action) => ({ action })));
      });
    }
  });

  it("keeps the other fields of a try_next row when only its text resolves", () => {
    withEnv({ [V2]: "1" }, () => {
      captureAdviceConfiguration(process.env);
      const row = { action: "Run {tool:list_window_titles}", tool: "get_windows", args: { a: 1 } };
      const env = buildFailureEnvelope("WindowNotFound", [row as never]);
      expect(env.if_unexpected.try_next).toEqual([
        { action: "Run get_windows", tool: "get_windows", args: { a: 1 } },
      ]);
    });
  });
});
