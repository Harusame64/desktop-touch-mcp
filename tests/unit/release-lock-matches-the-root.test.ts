/**
 * internal #348 — the release zips ship what release/package-lock.json pins (installed with npm ci by
 * release.yml and scripts/build-release-macos.mjs). The tests and the dev server run on the root lock.
 * The versions they share must be the same, or the zip ships code nothing here ran.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), "utf8"));
const releasePkg = read("release/package.json");
const releaseLock = read("release/package-lock.json");
const rootPkg = read("package.json");
const rootLock = read("package-lock.json");
const names = Object.keys(releasePkg.dependencies as Record<string, string>);

describe("release/package-lock.json", () => {
  it("ships the runtime packages the server imports", () => {
    expect(names.sort()).toEqual(["@modelcontextprotocol/sdk", "@nut-tree-fork/nut-js", "sharp", "ws", "zod"]);
  });

  it.each(names)("pins %s to the version the root lock runs", (name) => {
    const shipped = releaseLock.packages[`node_modules/${name}`]?.version;
    const tested = rootLock.packages[`node_modules/${name}`]?.version;
    expect(shipped).toBeDefined();
    expect(shipped).toBe(tested);
  });

  it.each(names)("asks for %s with the range the root asks for", (name) => {
    expect(releasePkg.dependencies[name]).toBe(rootPkg.devDependencies[name]);
  });

  it("is the lock of release/package.json (npm ci refuses a lock that does not match)", () => {
    expect(releaseLock.packages[""].dependencies).toEqual(releasePkg.dependencies);
  });

  it("carries the root's top-level overrides", () => {
    const rootOverrides = Object.fromEntries(
      Object.entries(rootPkg.overrides as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
    );
    expect(releasePkg.overrides).toEqual(rootOverrides);
  });

  it("locks the Windows and the macOS binaries the zips need", () => {
    for (const k of ["node_modules/@img/sharp-win32-x64", "node_modules/@img/sharp-darwin-arm64", "node_modules/@nut-tree-fork/libnut-win32", "node_modules/@nut-tree-fork/libnut-darwin"]) {
      expect(releaseLock.packages[k], k).toBeDefined();
    }
  });
});
