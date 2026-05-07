#!/usr/bin/env node
// ADR-011 A-2 follow-up — HTTP multi-session causal trail bench.
//
// Production HTTP server (`dist/index.js --http`) を spawn し、
// `StreamableHTTPClientTransport` 経由で **2 並走 SDK Client** を接続。
// 各 client が commit (notification_show) → query (desktop_state include=causal)
// を順次実行し、`caused_by.tool_call_id` の **session prefix** を観測。
//
// ## 検証目的
//
// PR #158 (ADR-011 A-2) で AsyncLocalStorage + SDK `extra.sessionId` 経由の
// per-session sessionId resolver を **wire 完成**。本 bench は production HTTP
// server 構成下で実機挙動を pin する:
//
// - **現状 (stateless mode)**: `server-windows.ts` の `sessionIdGenerator: undefined`
//   配下では SDK が `extra.sessionId` を発行しない → A-2 wire は **dormant**
//   (全 client が共有 "default" session に fallback)。caused_by.tool_call_id は
//   `default:N` 形式で session prefix が共通。**本 bench で実証**。
//
// - **将来 (stateful mode 有効化後)**: HTTP server を persistent McpServer +
//   session middleware に再設計 (or SDK の stateless+session 同居 mode 待ち) すれば
//   `extra.sessionId` が per-request UUID で発行され、A-2 wire が active 化。
//   caused_by.tool_call_id の session prefix が client ごとに異なる。
//   **本 bench は scope 外、別 ADR で扱う**。
//
// ## なぜ stateful mode を本 bench に含めないか
//
// per-request McpServer 構造 (server-windows.ts:377 「each HTTP request gets
// its own McpServer」) と SDK の stateful 設計 (`sessionIdGenerator: () => randomUUID()`
// が persistent McpServer を要求) は両立不能。stateful mode 有効化は server
// 全体の再アーキテクチャを伴うため別 ADR (ADR-011 Phase B 候補 or 別) で扱う。
//
// 本 bench は wire correctness の **unit test 軸ではなく実機 production 経路** での
// 「現状の挙動 pin + production gap の構造的記録」が役割。
//
// ## 期待結果 (stateless mode)
//
//   - 2 client の caused_by.tool_call_id が同一 session prefix `default:N` を持つ
//   - your_last_action は両 client で notification_show を指す (各自 commit が
//     共有 history ring に push される、後勝ちで上書きの可能性)
//   - exit code 0 (= stateless 期待挙動を pin、leak は production gap として既知)
//
// ## Usage
//
//   node benches/a2_http_multisession_isolation.mjs
//
// ## Requirements
//
//   - Windows session (notification_show が tray balloon 発火)
//   - `npm run build` (TS) + `npm run build:rs` (native addon) 完了
//   - `dist/index.js` 存在

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "dist", "index.js");

if (!existsSync(serverPath)) {
  console.error(`# FATAL: dist/index.js not found at ${serverPath}`);
  console.error(`#        run \`npm run build\` first.`);
  process.exit(2);
}

// ─── HTTP server lifecycle helper ───────────────────────────────────────────

const READY_LINE_RE = /MCP server running \(http\) on http:\/\/127\.0\.0\.1:(\d+)/;
const SERVER_BOOT_TIMEOUT_MS = 30_000;

async function spawnServer({ port }) {
  const env = {
    ...process.env,
    DESKTOP_TOUCH_AUTO_GUARD: "0",
  };
  const proc = spawn(process.execPath, [serverPath, "--http", "--port", String(port)], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  // Wait for the "MCP server running (http)" line on stderr.
  await new Promise((resolveBoot, rejectBoot) => {
    const timer = setTimeout(() => rejectBoot(new Error("server boot timeout")), SERVER_BOOT_TIMEOUT_MS);
    const onData = (chunk) => {
      const text = chunk.toString();
      if (READY_LINE_RE.test(text)) {
        clearTimeout(timer);
        proc.stderr.off("data", onData);
        resolveBoot();
      }
    };
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      rejectBoot(new Error(`server exited before ready (code ${code})`));
    });
  });
  return proc;
}

// Round 1 Opus P2-1: Windows では proc.kill("SIGTERM") は実装されず
// TerminateProcess 強制終了になり、server の `process.on("SIGTERM", shutdown)`
// graceful path は発火しない。さらに `proc.once("exit", r)` 単独では子が
// hang した場合 bench 全体が hang する (timeout 不在)。本 helper は
// (i) escalate kill (SIGTERM → 5s timeout → SIGKILL) で hang detection、
// (ii) graceful shutdown 経路の exercise は本 bench scope 外と明示する。
async function killServer(proc) {
  if (proc.killed) return;
  proc.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((r) => proc.once("exit", () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 5000)),
  ]);
  if (!exited) {
    // SIGKILL escalate (Windows でも TerminateProcess は同経路、ただし
    // SIGTERM 後 5s 待っても exit しない場合の safety net)
    try {
      proc.kill("SIGKILL");
      await Promise.race([
        new Promise((r) => proc.once("exit", () => r(true))),
        new Promise((r) => setTimeout(() => r(false), 2000)),
      ]);
    } catch {
      // already exited
    }
  }
}

function pickPort() {
  return 30_000 + Math.floor(Math.random() * 10_000);
}

// ─── SDK client helper ──────────────────────────────────────────────────────

async function newClient(port, label) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  const client = new Client({ name: `a2-bench-${label}`, version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

async function commitNotification(client, label) {
  return client.callTool({
    name: "notification_show",
    arguments: { title: `A-2 bench ${label}`, body: `session ${label}` },
  });
}

async function queryDesktopStateWithCausal(client) {
  return client.callTool({
    name: "desktop_state",
    arguments: { include: ["causal"] },
  });
}

function extractCausedBy(result) {
  // SDK returns content[0].text as JSON string of the tool result envelope.
  // SSOT: ADR-010 §8.2 + PR #115 architecture lock で `caused_by` は **envelope
  // 内 top-level** 配置 (compatHoist の strip 対象外、env opt-in / raw でも同位置)、
  // `envelope.caused_by` のような入れ子 shape は存在しない (Round 1 Opus P3-1)。
  try {
    const block = result?.content?.[0];
    if (!block || block.type !== "text" || typeof block.text !== "string") return null;
    const parsed = JSON.parse(block.text);
    return parsed?.caused_by ?? null;
  } catch {
    return null;
  }
}

// ─── Main bench ─────────────────────────────────────────────────────────────

const t0 = performance.now();
const port = pickPort();
console.log(`# === A-2 HTTP multi-session bench (stateless production mode) ===`);
console.log(`#   port=${port}`);

const proc = await spawnServer({ port });
let result;
try {
  const a = await newClient(port, "A");
  const b = await newClient(port, "B");

  // Each client commits its own notification, then queries causal.
  // commit return value is ignored — only the post-commit causal projection
  // (queried via desktop_state include=["causal"]) is the bench observable.
  // A-4 retrospective fix (Codex P2 #4、PR #159 follow-up): A→A→B→B 順
  // 並走 (旧: A→B→A→B) に変更し、stateless production の **last-writer-wins**
  // 挙動 (= B の commit が両 client の causal anchor として後勝ち) を strict
  // 検出。your_last_action の label 検証を `notification_show` substring
  // から `body:"session A"` / `body:"session B"` 厳密 match に強化、A 側が
  // B の commit を見たという「shared session prefix 以上の実害」 (= isolation
  // gap が production で何を引き起こすか) を expressive に pin。
  await commitNotification(a.client, "A");
  await commitNotification(b.client, "B");
  await sleep(50); // pushHistoryCompleted settle
  const qa = await queryDesktopStateWithCausal(a.client);
  const qb = await queryDesktopStateWithCausal(b.client);

  const cbA = extractCausedBy(qa);
  const cbB = extractCausedBy(qb);

  const idA = cbA?.tool_call_id ?? null;
  const idB = cbB?.tool_call_id ?? null;
  const actionA = cbA?.your_last_action ?? null;
  const actionB = cbB?.your_last_action ?? null;

  console.log(`#   client A: caused_by.tool_call_id = ${idA ?? "(absent)"} / your_last_action = ${actionA ?? "(absent)"}`);
  console.log(`#   client B: caused_by.tool_call_id = ${idB ?? "(absent)"} / your_last_action = ${actionB ?? "(absent)"}`);

  // Stateless mode acceptance (A-4 fix で strict 化):
  //   - Both clients should observe caused_by (commit was recorded in history ring)
  //   - tool_call_id session prefix should be SHARED ("default:")
  //     (= stateless production current behavior、A-2 wire dormant 確認)
  //   - **isolation gap の実害 strict pin**: A の query が **B の commit
  //     ("session B" body)** を `your_last_action` に見る (last-writer-wins)、
  //     これは isolation 不在の典型 production gap = LLM client A が他
  //     client B の操作を「自分がやった」と誤認知する runtime regression。
  //   - 旧 strict 不足 (`notification_show` substring のみ) は last-writer-wins
  //     の実害が pin できなかった問題 (Round 1 Codex P2 #4 反映)。
  let analysis = "indeterminate";
  let pass = false;
  if (idA && idB) {
    const sidA = idA.split(":")[0];
    const sidB = idB.split(":")[0];
    if (sidA === sidB) {
      // last-writer-wins: A→B 順で commit したため、B の "session B" body が両 anchor
      const aSawB = actionA?.includes('"body":"session B"') === true;
      const bSawB = actionB?.includes('"body":"session B"') === true;
      analysis = `shared session prefix "${sidA}" (= stateless production gap、A-4 strict): A saw B's commit = ${aSawB}, B saw B's commit = ${bSawB}`;
      // strict pass criteria: (1) shared "default" prefix + (2) last-writer-wins observable (両 anchor が B の body)
      pass = sidA === "default" && aSawB && bSawB;
    } else {
      analysis = `distinct session prefixes "${sidA}" / "${sidB}" — A-2 wire active!! 想定外 (stateless mode で per-session ring 分離は SDK の per-request McpServer 構造下で実現不能の理論前提に反する)`;
      pass = false;
    }
  } else {
    analysis = `caused_by absent (A=${idA ?? "null"}, B=${idB ?? "null"}) — wire / history ring failure`;
    pass = false;
  }
  console.log(`#   analysis: ${analysis}`);

  // Additional pin: action contains notification_show
  // A-4 fix: strict label verification 統合済 (line 235 近辺で aSawB / bSawB
  // を analysis に含める)、本 line は legacy 互換の loose check (notification_show
  // substring) を補助 trace として残す
  const actionLooseRefs = actionA?.includes("notification_show") && actionB?.includes("notification_show");
  console.log(`#   (legacy trace) your_last_action references notification_show on both: ${actionLooseRefs ? "yes" : "no"}`);

  result = { idA, idB, actionA, actionB, analysis, pass };

  await a.client.close();
  await b.client.close();
} catch (err) {
  console.error(`# FATAL: bench error: ${err?.message ?? err}`);
  await killServer(proc);
  process.exit(2);
} finally {
  await killServer(proc);
}

const elapsedSec = ((performance.now() - t0) / 1000).toFixed(1);
console.log("");
console.log("# === Summary ===");
console.log(`#   pass: ${result.pass ? "PASS" : "FAIL"}`);
console.log(`#   analysis: ${result.analysis}`);
console.log(`#   total elapsed: ${elapsedSec}s`);

// Production gap note (= 本 bench の最重要成果物):
console.log("");
console.log("# === Production gap (ADR-011 A-2 follow-up scope) ===");
console.log("#   現状 production HTTP server は stateless mode 固定。");
console.log("#   per-session causal trail isolation を活性化するには:");
console.log("#     (a) HTTP server を persistent McpServer + session middleware に再設計");
console.log("#     (b) MCP SDK の stateless + session_id 同居 mode を待つ");
console.log("#   どちらかが別 ADR で必要 (Phase A scope 外、Phase B または独立 phase)。");

process.exit(result.pass ? 0 : 1);
