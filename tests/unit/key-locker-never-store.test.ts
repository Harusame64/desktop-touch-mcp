// key-locker-never-store.test.ts — ADR-014 R3 L3-3 PR2 (the negative-binding "[Never]" tombstone store).
// Pins has/add, atomic persistence across a reload, idempotent add, and fail-safe tolerant load.
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NeverStore } from "../../src/engine/key-locker/never-store.js";

const dirs: string[] = [];
const freshDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "dtm-l3-never-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("NeverStore — add / has round-trip", () => {
  it("has is false until added, true after; survives a reload (atomic save)", () => {
    const dir = freshDir();
    const store = NeverStore.load(dir);
    expect(store.has("sudo://localhost/root")).toBe(false);
    store.add("sudo://localhost/root");
    expect(store.has("sudo://localhost/root")).toBe(true);
    // Another key is unaffected.
    expect(store.has("ssh://deploy@prod:22|fp=SHA256:aaa")).toBe(false);
    // Reload from disk — the tombstone persisted.
    expect(NeverStore.load(dir).has("sudo://localhost/root")).toBe(true);
  });

  it("add is idempotent — re-adding writes nothing new / does not duplicate", () => {
    const dir = freshDir();
    const store = NeverStore.load(dir);
    store.add("sudo://localhost/root");
    store.add("sudo://localhost/root");
    store.add("ssh://deploy@prod:22|fp=SHA256:aaa");
    const parsed = JSON.parse(readFileSync(join(dir, "never.json"), "utf8")) as { version: number; entries: string[] };
    expect(parsed.version).toBe(1);
    expect(parsed.entries).toEqual(["ssh://deploy@prod:22|fp=SHA256:aaa", "sudo://localhost/root"]); // sorted, deduped
  });

  it("no secret-shaped field is ever written — canonical keys only", () => {
    const dir = freshDir();
    NeverStore.load(dir).add("sudo://localhost/root");
    const raw = readFileSync(join(dir, "never.json"), "utf8");
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["entries", "version"]);
  });
});

describe("NeverStore — tolerant load (fail-safe to empty)", () => {
  it("corrupt never.json ⇒ starts empty, preserving the original as .corrupt", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "never.json"), "{not json!!", "utf8");
    const store = NeverStore.load(dir);
    expect(store.has("sudo://localhost/root")).toBe(false);
    expect(existsSync(join(dir, "never.json.corrupt"))).toBe(true);
  });

  it("wrong-shape file (valid JSON, not our schema) is treated as corrupt", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "never.json"), JSON.stringify({ version: 99, entries: "nope" }), "utf8");
    const store = NeverStore.load(dir);
    expect(store.has("x")).toBe(false);
    expect(existsSync(join(dir, "never.json.corrupt"))).toBe(true);
  });

  it("a non-string entry makes the whole file corrupt (fail-safe empty, preserved as .corrupt)", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "never.json"), JSON.stringify({ version: 1, entries: ["ok", 42] }), "utf8");
    expect(NeverStore.load(dir).has("ok")).toBe(false);
    expect(existsSync(join(dir, "never.json.corrupt"))).toBe(true);
  });

  it("a missing file starts empty without creating a .corrupt", () => {
    const dir = freshDir();
    expect(NeverStore.load(dir).has("x")).toBe(false);
    expect(existsSync(join(dir, "never.json.corrupt"))).toBe(false);
  });
});
