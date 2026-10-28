/**
 * Public #859 — a server whose stderr reader is gone exits instead of reporting errors to it forever.
 *
 * A real child process closes over the real pipe: the loop only exists with Node's own stream and
 * console machinery. The child loads `src/utils/broken-stream.ts` (the pieces `server-windows.ts`
 * wires) through Node's type stripping, and wires them the way `server-windows.ts` does: a stderr
 * listener, a once-only uncaught handler, and a shutdown that exits in a promise continuation.
 *
 * The "as before" cell wires none of it and must stay alive: it shows this harness reproduces the
 * loop win2 measured (1.16.0, 2.3.3 and main bc6d7d7c alive until killed, ~2,500 uncaught a second).
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODULE_URL = pathToFileURL(resolve(__dirname, "../../src/utils/broken-stream.ts")).href;
const canStripTypes = Boolean((process.features as { typescript?: unknown }).typescript);

// The child: `mode` is "fixed" (the #859 wiring), "asBefore" (no listener, no guard) or "deadline"
// (a shutdown whose await never settles, stderr left alone).
const CHILD = `
import { appendFileSync } from "node:fs";
const m = await import(process.env.BROKEN_STREAM_URL);
const mode = process.argv[2];
const log = process.env.CHILD_LOG;
let shuttingDown = false;
let handled = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = m.armExitDeadline((c) => process.exit(c), code, mode === "deadline" ? 300 : 10000);
  console.error("Shutting down...");
  Promise.all([mode === "deadline" ? new Promise(() => {}) : Promise.resolve()])
    .finally(() => { clearTimeout(deadline); process.exit(code); });
}
function handleUncaught(err) {
  if (mode !== "asBefore") {
    if (handled) return;
    handled = true;
    if (m.isBrokenStreamError(err)) m.silenceConsole();
  }
  appendFileSync(log, "uncaught\\n");
  try { console.error("uncaught", err.message); } catch {}
  shutdown(1);
}
if (mode !== "asBefore") m.watchBrokenStream(process.stderr, () => { appendFileSync(log, "broken\\n"); shutdown(1); });
process.on("uncaughtException", handleUncaught);
process.stdin.resume();
setInterval(() => console.error("probe"), 20);
if (mode === "deadline") setTimeout(() => shutdown(1), 100);
process.stdout.write("READY\\n");
`;

interface Outcome { code: number | null; killed: boolean; ms: number; uncaught: number; broken: number }

async function run(mode: "fixed" | "asBefore" | "deadline", waitMs: number): Promise<Outcome> {
  const dir = mkdtempSync(join(tmpdir(), "dt-859-"));
  const script = join(dir, "child.mjs");
  const log = join(dir, "child.log");
  writeFileSync(script, CHILD, "utf8");
  writeFileSync(log, "", "utf8");
  const child = spawn(process.execPath, [script, mode], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, BROKEN_STREAM_URL: MODULE_URL, CHILD_LOG: log },
  });
  child.stdin.on("error", () => {});
  child.stderr.on("data", () => {});
  let killed = false;
  let start = Date.now();
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  await new Promise<void>((ready, fail) => {
    const t = setTimeout(() => fail(new Error("child never said READY")), 10_000);
    child.stdout.on("data", (b: Buffer) => {
      if (String(b).includes("READY")) { clearTimeout(t); ready(); }
    });
  });
  // The parent stops reading stderr, as a client that went away does; stdin stays open.
  if (mode !== "deadline") child.stderr.destroy();
  start = Date.now();
  const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, waitMs);
  const code = await exited;
  clearTimeout(timer);
  const ms = Date.now() - start;
  const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n") : [];
  return {
    code, killed, ms,
    uncaught: lines.filter((l) => l === "uncaught").length,
    broken: lines.filter((l) => l === "broken").length,
  };
}

// The cells above rebuild the wiring in a child; they cannot see server-windows.ts lose it (win2 on
// #863: replacing the watchBrokenStream call in the built server went unnoticed by them). These read
// the server's code, comments removed, for the three pieces it must still call.
describe("public #859: server-windows.ts still wires the pieces", () => {
  const code = readFileSync(resolve(__dirname, "../../src/server-windows.ts"), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  const body = (fn: string): string => {
    const at = code.indexOf(`function ${fn}(`);
    expect(at, `function ${fn} not found`).toBeGreaterThanOrEqual(0);
    return code.slice(at, code.indexOf("\n}\n", at));
  };

  it("listens on stderr with watchBrokenStream and shuts down from it", () => {
    expect(code).toMatch(/watchBrokenStream\(process\.stderr,[\s\S]{0,400}?shutdown\(1\)/);
  });

  it("arms the exit deadline inside shutdown()", () => {
    expect(body("shutdown")).toMatch(/armExitDeadline\(/);
  });

  it("returns early from handleUncaught after the first call", () => {
    expect(body("handleUncaught")).toMatch(/if \(handledUncaught\) return;[\s\S]{0,80}handledUncaught = true;/);
  });
});

describe.skipIf(!canStripTypes)("public #859: a broken stderr does not keep the server alive", () => {
  it("exits with code 1 on its own, without an uncaught loop", async () => {
    const r = await run("fixed", 5_000);
    expect(r.killed, JSON.stringify(r)).toBe(false);
    expect(r.code).toBe(1);
    expect(r.broken).toBe(1);
    expect(r.uncaught).toBeLessThanOrEqual(1);
  }, 20_000);

  it("as before (no listener, no guard) the harness reproduces the loop: alive until killed", async () => {
    const r = await run("asBefore", 2_000);
    expect(r.killed, JSON.stringify(r)).toBe(true);
    expect(r.uncaught).toBeGreaterThan(100);
  }, 20_000);

  it("a shutdown whose await never settles still exits, by the deadline", async () => {
    const r = await run("deadline", 5_000);
    expect(r.killed, JSON.stringify(r)).toBe(false);
    expect(r.code).toBe(1);
  }, 20_000);
});
