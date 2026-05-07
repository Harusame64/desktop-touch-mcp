/**
 * session-context-a2.test.ts — ADR-011 Phase A A-2 contract test suite.
 *
 * Pins the bit-equal contract for AsyncLocalStorage-backed transport
 * session_id propagation (plan §4.2.2 option (b) + SDK
 * `RequestHandlerExtra.sessionId` hybrid)。
 *
 * Coverage:
 *   - A-2-1 ALS sessionId 伝播: runWithSessionContext 内で
 *     getMcpTransportSessionIdFromContext() が transport sessionId 返却、
 *     外側では undefined
 *   - A-2-2 nested context: ネスト後 outer context が復元される
 *     (AsyncLocalStorage 標準挙動の structural pin)
 *   - A-2-3 parseSessionMode: 4 cases ("single" / "multi" / "auto" / unknown)
 *     pure parser の env mutation race を構造的解消
 *     (CLAUDE.md feedback_pure_parser_for_env_helpers.md)
 *   - A-2-4 isSingleSessionPrototype env mode 駆動 (test pin 経路、
 *     env 直接 mutation 回避)
 *   - A-2-5 isSingleSessionPrototype "auto" + ALS sessionId 駆動
 *     (HTTP transport 検出 simulation)
 *   - A-2-6 desktopStateGetSessionId 統合: ALS sessionId 定義時 → 返却 /
 *     prototype gate 経由 → "multi:disabled" / default → "default"
 *   - A-2-7 defaultQuerySessionId 統合: A-1 と同型挙動を共有 resolver で
 *     pin (bit-equal contract、stub drift 構造的不能)
 *   - A-2-8 backward-compat test seam: A-1 既存 test seam
 *     (_setSingleSessionPrototypeForTest /
 *     _setDefaultQuerySingleSessionForTest) が新 shared store に forward
 *   - A-2-9 wrapper extra.sessionId 取込み: makeQueryWrapper 経由で
 *     extra?.sessionId が ALS に伝播 (multi-session HTTP transport
 *     simulation、`getSessionId` resolver が transport id 返却)
 */

import { describe, expect, it, afterEach } from "vitest";
import {
  runWithSessionContext,
  getMcpTransportSessionIdFromContext,
  isSingleSessionPrototype,
  parseSessionMode,
  _setSingleSessionPinForTest,
  _resetSingleSessionPinForTest,
  type SessionMode,
} from "../../src/tools/_session-context.js";
import {
  defaultQuerySessionId,
  makeQueryWrapper,
  genericQueryCausedByProjector,
  _setDefaultQuerySingleSessionForTest,
  _resetDefaultQuerySingleSessionForTest,
} from "../../src/tools/_envelope.js";
import {
  desktopStateGetSessionId,
  _setSingleSessionPrototypeForTest,
  _resetSingleSessionPrototypeForTest,
} from "../../src/tools/desktop-state.js";

afterEach(() => {
  _resetSingleSessionPinForTest();
});

// ── A-2-1: ALS sessionId 伝播 ────────────────────────────────────────────────

describe("A-2-1: runWithSessionContext で ALS 経由 sessionId 伝播", () => {
  it("内側で getMcpTransportSessionIdFromContext が transport sessionId 返却", () => {
    expect(getMcpTransportSessionIdFromContext()).toBeUndefined();
    runWithSessionContext("session-abc", () => {
      expect(getMcpTransportSessionIdFromContext()).toBe("session-abc");
    });
    // 外側 (ALS context 外) は undefined
    expect(getMcpTransportSessionIdFromContext()).toBeUndefined();
  });

  it("undefined sessionId 注入 → ALS 内 undefined のまま (single-session 透過維持)", () => {
    runWithSessionContext(undefined, () => {
      expect(getMcpTransportSessionIdFromContext()).toBeUndefined();
    });
  });
});

// ── A-2-2: nested context — outer 復元 ─────────────────────────────────────

describe("A-2-2: nested runWithSessionContext で outer 復元", () => {
  it("inner context 抜けると outer context が復元される (ALS 標準挙動)", () => {
    runWithSessionContext("outer", () => {
      expect(getMcpTransportSessionIdFromContext()).toBe("outer");
      runWithSessionContext("inner", () => {
        expect(getMcpTransportSessionIdFromContext()).toBe("inner");
      });
      expect(getMcpTransportSessionIdFromContext()).toBe("outer");
    });
  });
});

// ── A-2-3: parseSessionMode pure parser ─────────────────────────────────────

describe("A-2-3: parseSessionMode は pure (env mutation race 構造的解消)", () => {
  it.each<[string | undefined, SessionMode]>([
    ["single", "single"],
    ["multi", "multi"],
    ["auto", "auto"],
    [undefined, "auto"],
    ["", "auto"],
    ["nonsense", "auto"],
    ["SINGLE", "auto"], // case-sensitive、unknown は auto
  ])("parseSessionMode(%j) === %j", (input, expected) => {
    expect(parseSessionMode(input)).toBe(expected);
  });
});

// ── A-2-4: isSingleSessionPrototype env mode (test pin 経路) ────────────────

describe("A-2-4: isSingleSessionPrototype は test pin 優先", () => {
  it("test pin true → isSingleSessionPrototype() === true", () => {
    _setSingleSessionPinForTest(true);
    expect(isSingleSessionPrototype()).toBe(true);
  });

  it("test pin false → isSingleSessionPrototype() === false", () => {
    _setSingleSessionPinForTest(false);
    expect(isSingleSessionPrototype()).toBe(false);
  });

  it("pin reset 後は env-aware default に戻る (auto mode + no ALS → single)", () => {
    _setSingleSessionPinForTest(false);
    _resetSingleSessionPinForTest();
    // outside ALS context → auto mode で single (sessionId undefined)
    // env DESKTOP_TOUCH_SESSION_MODE 未設定 default = "auto"
    expect(isSingleSessionPrototype()).toBe(true);
  });
});

// ── A-2-5: auto mode で ALS sessionId 駆動 (HTTP transport simulation) ─────

describe("A-2-5: auto mode で ALS sessionId 検出 → multi-session 判定", () => {
  it("ALS sessionId undefined (stdio default) → single-session = true", () => {
    runWithSessionContext(undefined, () => {
      expect(isSingleSessionPrototype()).toBe(true);
    });
  });

  it("ALS sessionId defined (HTTP per-request id) → single-session = false", () => {
    runWithSessionContext("http-session-xyz", () => {
      expect(isSingleSessionPrototype()).toBe(false);
    });
  });
});

// ── A-2-6: desktopStateGetSessionId 統合 ────────────────────────────────────

describe("A-2-6: desktopStateGetSessionId が共有 resolver 経由で動作", () => {
  it("ALS sessionId 定義時 → transport sessionId 返却 (HTTP transport)", () => {
    runWithSessionContext("desktop-session-1", () => {
      expect(desktopStateGetSessionId({})).toBe("desktop-session-1");
    });
  });

  it("ALS なし + prototype false (multi pin) → \"multi:disabled\" sentinel", () => {
    _setSingleSessionPinForTest(false);
    expect(desktopStateGetSessionId({})).toBe("multi:disabled");
  });

  it("ALS なし + prototype true (default) → \"default\" fallback (stdio prototype)", () => {
    _setSingleSessionPinForTest(true);
    expect(desktopStateGetSessionId({})).toBe("default");
  });
});

// ── A-2-7: defaultQuerySessionId 統合 (A-1 bit-equal sync) ──────────────────

describe("A-2-7: defaultQuerySessionId と desktopStateGetSessionId が bit-equal", () => {
  it("3 シナリオで両 resolver の戻り値一致 (drift 構造的不能 — 共有 module 経由)", () => {
    // (1) ALS sessionId 定義
    runWithSessionContext("shared-session-abc", () => {
      expect(defaultQuerySessionId({})).toBe("shared-session-abc");
      expect(desktopStateGetSessionId({})).toBe("shared-session-abc");
    });

    // (2) ALS なし + multi-session pin → sentinel
    _setSingleSessionPinForTest(false);
    expect(defaultQuerySessionId({})).toBe("multi:disabled");
    expect(desktopStateGetSessionId({})).toBe("multi:disabled");
    _resetSingleSessionPinForTest();

    // (3) ALS なし + single-session pin → default
    _setSingleSessionPinForTest(true);
    expect(defaultQuerySessionId({})).toBe("default");
    expect(desktopStateGetSessionId({})).toBe("default");
  });
});

// ── A-2-8: backward-compat test seam forwarding ────────────────────────────

describe("A-2-8: A-1 test seam が共有 store に forward (rewrites 不要)", () => {
  it("_setDefaultQuerySingleSessionForTest(false) → desktopState 経由でも multi:disabled (shared store)", () => {
    _setDefaultQuerySingleSessionForTest(false);
    // _envelope.ts seam で pin した値が desktop-state.ts 側からも観測される
    expect(desktopStateGetSessionId({})).toBe("multi:disabled");
    _resetDefaultQuerySingleSessionForTest();
  });

  it("_setSingleSessionPrototypeForTest(false) → defaultQuery 経由でも multi:disabled (shared store)", () => {
    _setSingleSessionPrototypeForTest(false);
    expect(defaultQuerySessionId({})).toBe("multi:disabled");
    _resetSingleSessionPrototypeForTest();
  });
});

// ── A-2-Codex-P1: nested wrapper で outer context 継承 (run_macro simulation) ─

describe("A-2-Codex-P1: extra 不在の nested wrapper 呼出で outer ALS sessionId を inherit", () => {
  // Round 1 Codex P1 fix: `runWithSessionContext(undefined, ...)` が既存 ALS
  // context を `undefined` で上書きしていた regression。run_macro 内 step が
  // `entry.handler(validated)` (extra なし) で呼ばれるとき、parent HTTP
  // request の sessionId が消失して per-session causal isolation を破壊。
  // 修正後は outer sessionId を inherit、parent → child で causal trail 維持。
  it("outer 'parent-xyz' で wrap 後、inner extra 不在 wrap で parent-xyz が inherit される", () => {
    runWithSessionContext("parent-xyz", () => {
      // simulate: run_macro wrapper が outer scope を確立、step wrapper が
      // 内側で extra なしの呼出をする (TOOL_REGISTRY 経由 entry.handler)
      runWithSessionContext(undefined, () => {
        // inner step wrapper が ALS context を観測 — overwrite されず inherit
        expect(getMcpTransportSessionIdFromContext()).toBe("parent-xyz");
      });
      // outer scope に戻ったら parent-xyz のまま
      expect(getMcpTransportSessionIdFromContext()).toBe("parent-xyz");
    });
  });

  it("outer なし + inner extra 不在 → undefined のまま (top-level wrapper、stdio default)", () => {
    runWithSessionContext(undefined, () => {
      expect(getMcpTransportSessionIdFromContext()).toBeUndefined();
    });
  });

  it("outer 'parent-xyz' + inner explicit 'child-abc' → child-abc が override (SDK extra.sessionId 優先)", () => {
    runWithSessionContext("parent-xyz", () => {
      runWithSessionContext("child-abc", () => {
        // explicit sessionId は SDK の per-request attribution として override
        expect(getMcpTransportSessionIdFromContext()).toBe("child-abc");
      });
      expect(getMcpTransportSessionIdFromContext()).toBe("parent-xyz");
    });
  });

  it("nested wrapper 経由 getSessionId が parent transport id を返却 (run_macro full simulation)", async () => {
    // simulated run_macro: outer wrap (HTTP request) → inner step wrap (TOOL_REGISTRY)
    let observed: string | undefined;
    const stepWrapper = makeQueryWrapper(
      async () => ({ content: [{ type: "text" as const, text: '{"ok":true}' }] }),
      "inner_step",
      {
        causedByProjector: genericQueryCausedByProjector,
        getSessionId: () => {
          observed = defaultQuerySessionId({});
          return observed;
        },
      },
    );
    // outer scope = HTTP request handler simulation
    await runWithSessionContext("http-parent-1", async () => {
      // inner step呼出: extra なし (= run_macro の entry.handler(validated) 呼出)
      await stepWrapper({ include: ["causal"] } as Record<string, unknown>);
    });
    // step wrapper の getSessionId は parent context を inherit して http-parent-1 を返却
    expect(observed).toBe("http-parent-1");
  });
});

// ── A-2-N: 多重 transport 並走 ALS isolation (Round 1 Opus P3-1) ───────────

describe("A-2-N: 多重 transport 並走で ALS context が per-async-task isolated", () => {
  it("Promise.all で 2 sessionId 並列実行、context leak なし (HTTP transport multi-request simulation)", async () => {
    // Node.js AsyncLocalStorage は async_hooks で per-async-task isolation を
    // 保証する設計。本 test は将来 ALS resolver を refactor する際の
    // structural pin — 並走 transport request 同士の sessionId leak を構造的に
    // 検出する (CLAUDE.md §3.2 carry-over scope shrink 防御層、Round 1 P3-1)。
    const taskA = (async () => {
      return runWithSessionContext("session-A", async () => {
        // 微小 await で event loop 回し、別 task との interleaving を強制
        await Promise.resolve();
        const idMid = getMcpTransportSessionIdFromContext();
        await new Promise((r) => setTimeout(r, 0));
        const idEnd = getMcpTransportSessionIdFromContext();
        return { idMid, idEnd };
      });
    })();
    const taskB = (async () => {
      return runWithSessionContext("session-B", async () => {
        await Promise.resolve();
        const idMid = getMcpTransportSessionIdFromContext();
        await new Promise((r) => setTimeout(r, 0));
        const idEnd = getMcpTransportSessionIdFromContext();
        return { idMid, idEnd };
      });
    })();
    const [a, b] = await Promise.all([taskA, taskB]);
    expect(a.idMid).toBe("session-A");
    expect(a.idEnd).toBe("session-A");
    expect(b.idMid).toBe("session-B");
    expect(b.idEnd).toBe("session-B");
  });
});

// ── A-2-9: wrapper extra.sessionId 取込み (multi-session HTTP simulation) ──

describe("A-2-9: makeQueryWrapper で extra.sessionId が ALS 経由 getSessionId に伝播", () => {
  it("HTTP transport simulation: extra.sessionId provided → getSessionId resolves transport id", async () => {
    const captured: string[] = [];
    // S5 path に opt-in する getSessionId / causedByProjector を渡す
    const handler = async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "test_query", {
      causedByProjector: genericQueryCausedByProjector,
      getSessionId: () => {
        const sid = defaultQuerySessionId({});
        captured.push(sid);
        return sid;
      },
    });

    // include=["causal"] を渡して S5 path に hit させる + extra.sessionId 注入
    await wrapped({ include: ["causal"] } as Record<string, unknown>, {
      sessionId: "http-request-42",
    });

    // wrapper 内で getSessionId が呼ばれた時点で ALS context 内、
    // defaultQuerySessionId が transport id を観測
    expect(captured).toEqual(["http-request-42"]);
  });

  it("stdio simulation (extra なし) → getSessionId は \"default\" fallback", async () => {
    _setSingleSessionPinForTest(true); // single-session pin
    const captured: string[] = [];
    const handler = async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "test_query", {
      causedByProjector: genericQueryCausedByProjector,
      getSessionId: () => {
        const sid = defaultQuerySessionId({});
        captured.push(sid);
        return sid;
      },
    });

    // extra 引数なしで呼出 (stdio transport の挙動)
    await wrapped({ include: ["causal"] } as Record<string, unknown>);

    expect(captured).toEqual(["default"]);
  });
});
