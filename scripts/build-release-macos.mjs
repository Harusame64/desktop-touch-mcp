#!/usr/bin/env node
// Mac port M3-2a: assemble the macOS release zip — the same contents as the Windows zip
// (release.yml "Prepare release directory" / "Install production dependencies" / "Prune" /
// "Create zip"), for Apple Silicon. One script so CI and a local run produce the same zip.
//
// Expects `npm run build` and the darwin addon (`desktop-touch-engine.darwin-arm64.node`) to exist.
// Usage: node scripts/build-release-macos.mjs [out.zip]   (default: desktop-touch-mcp-macos-arm64.zip)

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = resolve(process.argv[2] ?? join(ROOT, "desktop-touch-mcp-macos-arm64.zip"));
const REL = join(ROOT, "release_build_macos");
const ADDON = "desktop-touch-engine.darwin-arm64.node";
// The runtime dependencies the Windows zip carries (release.yml); sharp brings its darwin binary.
const RUNTIME_DEPS = ["@modelcontextprotocol/sdk", "@nut-tree-fork/nut-js", "sharp", "ws", "zod"];

const die = (m) => {
  console.error(`[build-release-macos] FAIL — ${m}`);
  process.exit(1);
};
if (process.platform !== "darwin" || process.arch !== "arm64") die(`run on Apple Silicon macOS (this is ${process.platform}/${process.arch})`);
for (const f of ["dist/index.js", ADDON, "index.js", "package.json"]) {
  if (!existsSync(join(ROOT, f))) die(`${f} is missing — run npm run build and the darwin addon build first`);
}

rmSync(REL, { recursive: true, force: true });
rmSync(OUT, { force: true });
mkdirSync(REL);
for (const f of ["package.json", "package-lock.json", "LICENSE", "README.md", "README.ja.md", "index.js", "index.d.ts", ADDON]) {
  cpSync(join(ROOT, f), join(REL, f));
}
cpSync(join(ROOT, "dist"), join(REL, "dist"), { recursive: true });
if (existsSync(join(ROOT, "assets"))) cpSync(join(ROOT, "assets"), join(REL, "assets"), { recursive: true });

// package.json as the Windows zip has it: main, runtime dependencies, no bin/files/scripts.
const pkg = JSON.parse(readFileSync(join(REL, "package.json"), "utf8"));
pkg.main = "dist/index.js";
pkg.dependencies = Object.fromEntries(
  RUNTIME_DEPS.map((n) => {
    const v = pkg.devDependencies?.[n] ?? pkg.dependencies?.[n];
    if (!v) die(`no version for ${n} in package.json`);
    return [n, v];
  })
);
delete pkg.bin;
delete pkg.files;
delete pkg.scripts;
writeFileSync(join(REL, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

// Production dependencies installed in isolation (the repo's devDependencies must not leak in).
const iso = mkdtempSync(join(tmpdir(), "dtmcp-release-"));
writeFileSync(
  join(iso, "package.json"),
  JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", dependencies: pkg.dependencies }, null, 2)
);
execFileSync("npm", ["install", "--no-package-lock", "--no-audit", "--no-fund"], { cwd: iso, stdio: "inherit" });
const nm = join(iso, "node_modules");
const count = existsSync(nm) ? readdirSync(nm).filter((d) => !d.startsWith(".")).length : 0;
if (count < 5) die(`expected 5+ top-level packages in node_modules, got ${count}`);
renameSync(nm, join(REL, "node_modules"));
rmSync(iso, { recursive: true, force: true });

// Prune: devDependencies off the shipped package.json.
delete pkg.devDependencies;
writeFileSync(join(REL, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

// Zip the contents (not the folder); -y keeps node_modules/.bin symlinks as links.
execFileSync("zip", ["-qry", OUT, "."], { cwd: REL, stdio: "inherit" });
const listing = execFileSync("unzip", ["-l", OUT], { encoding: "utf8" });
for (const must of ["dist/index.js", ADDON, "node_modules/sharp/package.json"]) {
  if (!new RegExp(`\\s${must.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(listing)) die(`${must} is not in the zip`);
}
if (!/node_modules\/@img\/sharp-darwin-arm64\//.test(listing)) die("sharp's darwin-arm64 binary is not in the zip");
console.error(`[build-release-macos] OK — ${OUT}`);
