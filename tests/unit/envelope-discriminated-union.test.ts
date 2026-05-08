/**
 * envelope-discriminated-union.test.ts
 *
 * Regression test for `withEnvelopeIncludeForUnion` discriminator access.
 *
 * Background: Zod v3 exposed `ZodDiscriminatedUnion.discriminator` on the
 * public surface; Zod v4 moved it under `_def.discriminator`. PR #153
 * bumped zod 4.3.6 → 4.4.x and the helper kept reading `union.discriminator`
 * (now `undefined`), breaking every variant's parse with "Invalid
 * discriminated union option at index 0" for keyboard / clipboard /
 * window_dock / scroll / terminal / browser_eval. Shipped to v1.3.0.
 *
 * This suite parses each affected registration schema with a valid input
 * shape (so the discriminator must resolve to a real string and dispatch
 * correctly) and one wrong-discriminator input (must surface a typed
 * Zod error rather than silently match the first variant).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  withEnvelopeIncludeForUnion,
} from "../../src/tools/_envelope.js";
import { keyboardRegistrationSchema } from "../../src/tools/keyboard.js";
import { clipboardRegistrationSchema } from "../../src/tools/clipboard.js";
import { windowDockRegistrationSchema } from "../../src/tools/window-dock.js";
import { scrollRegistrationSchema } from "../../src/tools/scroll.js";
import { terminalRegistrationSchema } from "../../src/tools/terminal.js";
import { browserEvalRegistrationSchema } from "../../src/tools/browser.js";

interface DiscUnionCase {
  name: string;
  schema: z.ZodTypeAny;
  validInput: Record<string, unknown>;
  validInputAlt?: Record<string, unknown>;
  invalidDiscriminatorInput: Record<string, unknown>;
}

const cases: DiscUnionCase[] = [
  {
    name: "keyboard",
    schema: keyboardRegistrationSchema,
    validInput: { action: "press", keys: "ctrl+n" },
    validInputAlt: { action: "type", text: "hello" },
    invalidDiscriminatorInput: { action: "bogus", text: "x" },
  },
  {
    name: "clipboard",
    schema: clipboardRegistrationSchema,
    validInput: { action: "read" },
    invalidDiscriminatorInput: { action: "no_such_action" },
  },
  {
    name: "window_dock",
    schema: windowDockRegistrationSchema,
    validInput: { action: "pin", title: "Notepad" },
    invalidDiscriminatorInput: { action: "no_such_action", title: "Notepad" },
  },
  {
    name: "scroll",
    schema: scrollRegistrationSchema,
    validInput: { action: "raw", direction: "down" },
    invalidDiscriminatorInput: { action: "no_such_action" },
  },
  {
    name: "terminal",
    schema: terminalRegistrationSchema,
    validInput: { action: "read", windowTitle: "PowerShell" },
    invalidDiscriminatorInput: { action: "no_such_action", windowTitle: "PowerShell" },
  },
  {
    name: "browser_eval",
    schema: browserEvalRegistrationSchema,
    validInput: { action: "js", expression: "1+1" },
    invalidDiscriminatorInput: { action: "no_such_action", expression: "1+1" },
  },
];

describe("withEnvelopeIncludeForUnion: discriminator access survives Zod v3 → v4 transition (#regression after zod 4.3.6 → 4.4.3 bump)", () => {
  for (const c of cases) {
    it(`${c.name}: valid input parses (discriminator dispatches correctly)`, () => {
      const result = c.schema.safeParse(c.validInput);
      expect(result.success, `parse of ${JSON.stringify(c.validInput)} failed: ${
        result.success ? "" : JSON.stringify(result.error.issues)
      }`).toBe(true);
    });

    if (c.validInputAlt !== undefined) {
      it(`${c.name}: alternate variant valid input also parses`, () => {
        const result = c.schema.safeParse(c.validInputAlt);
        expect(result.success).toBe(true);
      });
    }

    it(`${c.name}: include opt-in survives the wrap (registration schema accepts include:["envelope"])`, () => {
      const result = c.schema.safeParse({ ...c.validInput, include: ["envelope"] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as { include?: string[] }).include).toEqual(["envelope"]);
      }
    });

    it(`${c.name}: invalid discriminator surfaces a Zod typed error (not a silent match)`, () => {
      const result = c.schema.safeParse(c.invalidDiscriminatorInput);
      expect(result.success).toBe(false);
    });
  }
});

describe("withEnvelopeIncludeForUnion: explicit guard for missing discriminator", () => {
  it("throws a descriptive error when input is not a ZodDiscriminatedUnion", () => {
    const fakeUnion = { options: [], _def: {} } as unknown as Parameters<typeof withEnvelopeIncludeForUnion>[0];
    expect(() => withEnvelopeIncludeForUnion(fakeUnion)).toThrowError(
      /failed to resolve discriminator field/i,
    );
  });
});
