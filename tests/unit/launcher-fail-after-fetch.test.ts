/**
 * internal #290 — after a fetch, the launcher fails by setting the exit code, not by `process.exit`:
 * on Windows, Node 24.19.0 aborts in libuv when `process.exit` runs after a fetch (native assertion,
 * exit code not 1). The spike is internal 10aaecce.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const LAUNCHER = new URL("../../bin/launcher.js", import.meta.url);

/** Runs `body` in a child node that imported the launcher; returns its exit status and elapsed ms. */
function runChild(body: string): { status: number | null; ms: number; stderr: string } {
  const script = `
    import http from "node:http";
    const { failAfterFetch } = await import(${JSON.stringify(LAUNCHER.href)});
    ${body}
  `;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20000 });
  return { status: r.status, ms: Date.now() - t0, stderr: r.stderr };
}

describe("failAfterFetch", () => {
  it("sets the exit code to 1 and does not call process.exit at once", async () => {
    const { failAfterFetch } = await import(/* @vite-ignore */ `${LAUNCHER.href}?faf`);
    const calls: number[] = [];
    const proc = { exitCode: undefined as number | undefined, exit: (c: number) => { calls.push(c); } };
    failAfterFetch("boom", { proc, graceMs: 60_000 });
    expect(proc.exitCode).toBe(1);
    expect(calls).toEqual([]);
  });

  it("after a 404 fetch, exits 1 without waiting out the grace (the fallback timer does not hold the loop)", () => {
    const r = runChild(`
      const server = http.createServer((_q, s) => { s.statusCode = 404; s.end("not found"); });
      await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
      const res = await fetch("http://127.0.0.1:" + server.address().port + "/");
      server.close(); server.closeAllConnections();
      failAfterFetch("GitHub Releases API returned " + res.status, { graceMs: 15000 });
    `);
    expect(r.stderr).toContain("GitHub Releases API returned 404");
    expect(r.status).toBe(1);
    expect(r.ms).toBeLessThan(10000);
  });

  it("still exits 1 when something keeps the loop alive, once the grace has passed", () => {
    const r = runChild(`
      setInterval(() => {}, 1000);
      failAfterFetch("held", { graceMs: 300 });
    `);
    expect(r.status).toBe(1);
  });

  // The call site, not only the helper: the launcher run as the program, its release fetch answered 404
  // (agy on #935: reverting main's catch to fail() left every cell above green). Only on a platform the
  // launcher installs for; elsewhere it stops at the platform check, before any fetch.
  const supported = (process.platform === "darwin" && process.arch === "arm64") || process.platform === "win32";
  it.skipIf(!supported)("is what main's catch uses: a 404 from the release fetch ends in exit 1 without process.exit", () => {
    const dir = mkdtempSync(join(tmpdir(), "dtm-290-"));
    try {
      const preload = join(dir, "preload.mjs");
      writeFileSync(preload, `
        globalThis.fetch = async () => new Response("not found", { status: 404, statusText: "Not Found" });
        const exit = process.exit.bind(process);
        process.exit = (code) => { process.stderr.write("PROCESS_EXIT_CALLED\\n"); exit(code); };
      `);
      const r = spawnSync(
        process.execPath,
        ["--import", pathToFileURL(preload).href, fileURLToPath(LAUNCHER)],
        {
          encoding: "utf8",
          timeout: 20000,
          input: "",
          env: { ...process.env, DESKTOP_TOUCH_MCP_HOME: join(dir, "home"), DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED: "1" },
        },
      );
      expect(r.stderr).toContain("returned 404");
      expect(r.stderr).not.toContain("PROCESS_EXIT_CALLED");
      expect(r.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
