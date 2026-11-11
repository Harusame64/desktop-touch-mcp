/**
 * internal #290 — after a fetch, the launcher fails by setting the exit code, not by `process.exit`:
 * on Windows, Node 24.19.0 aborts in libuv when `process.exit` runs after a fetch (native assertion,
 * exit code not 1). The spike is internal 10aaecce.
 */
import { spawnSync } from "node:child_process";
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

  it("after a 404 fetch, exits 1 by the loop ending, well before the grace runs out", () => {
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
});
