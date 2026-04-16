/**
 * tests/unit/fluent-key-entity.test.ts
 *
 * Unit tests for fluentKeyForEntity — ensures the entity-kind prefix is
 * correctly applied and that unknown kinds throw at runtime.
 */

import { describe, it, expect } from "vitest";
import { fluentKeyForEntity } from "../../src/engine/perception/lens.js";
import type { EntityRef } from "../../src/engine/perception/types.js";

describe("fluentKeyForEntity", () => {
  it("produces window:<id>.<property> for window entities", () => {
    const entity: EntityRef = { kind: "window", id: "12345" };
    expect(fluentKeyForEntity(entity, "target.exists")).toBe("window:12345.target.exists");
  });

  it("produces browserTab:<id>.<property> for browserTab entities", () => {
    const entity: EntityRef = { kind: "browserTab", id: "abc-123" };
    expect(fluentKeyForEntity(entity, "browser.url")).toBe("browserTab:abc-123.browser.url");
  });

  it("window keys are unchanged from the existing format", () => {
    const entity: EntityRef = { kind: "window", id: "99" };
    expect(fluentKeyForEntity(entity, "modal.above")).toBe("window:99.modal.above");
  });

  it("throws on unknown entity kind", () => {
    const badEntity = { kind: "cursor", id: "0" } as unknown as EntityRef;
    expect(() => fluentKeyForEntity(badEntity, "x")).toThrow(/Unknown entity kind/);
  });
});
