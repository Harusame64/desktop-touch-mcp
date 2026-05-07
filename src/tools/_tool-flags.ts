/**
 * _tool-flags.ts — ADR-011 Phase B B-4 tool registry flags (Phase B plan
 * §10 OQ #8 Resolved 化、option (a) 採用)。
 *
 * **Procedural memory MVP scope** (B-4 land 2026-05-07):
 *
 * `run_macro` の inner steps が destructive tool を含むかを軽量走査する
 * ための per-tool flag。**query allowlist 設計** (default `destructive: true`、
 * query-safe tool のみ explicit `false` 立て): 新 tool 追加時に flag 立て
 * 忘れても安全側 (= 自動 suggest 対象外) に倒す inversion design。
 *
 * **判定 mechanism (Phase B plan §10 OQ #8 (a))**: `run_macro` の inner
 * steps を flag map で 1 step でも `isDestructiveCandidate=true` あれば
 * suggest 対象外。AST 走査 (option (b)) は本 PR scope 外、explicit consent
 * UX (option (c)) は Phase B 全体で non-goal (将来別 PR)。
 *
 * **MVP 制限 (Phase B plan §10 OQ #8 + Phase B B-4 着手時 user 諮問
 * 2026-05-07)**: procedural memory は **query / observation 系の safe
 * repeated workflow suggestion 限定**。destructive / side-effecting macro
 * の自動 suggest は Phase B では non-goal、将来 explicit consent UX と
 * 別 PR で扱う。
 */

/**
 * Query-safe (observation-only) tools — `run_macro` の inner step が
 * 全件 query-safe なら suggest 候補。entry 不在 = default destructive
 * (= suggest 対象外)、新 tool 追加時 flag 立て忘れに対する fail-safe。
 *
 * Phase B B-4 着手時 user 諮問 2026-05-07 で確定。`scroll` / `focus_window` /
 * `window_dock` は **destructive 扱い** (UI state を変化、実 user input
 * stream に近い)、当面 suggest 対象外。
 *
 * **`sleep` pseudo-command も intentionally allowlist 外** (registry entry
 * 不在 → fail-safe destructive 扱い): timing-aware safe macro (e.g.
 * "focus_window → sleep → screenshot") も suggest 対象外になるが、これは
 * Phase B では over-conservative 設計 (sleep 用途は debug / 観察 / timing
 * tuning が混在、将来必要に応じて allowlist 追加検討)。
 */
const QUERY_SAFE_TOOLS = new Set<string>([
  // Pure observation
  "desktop_state",
  "screenshot",
  "workspace_snapshot",
  // Discover (lease 発行のみ、action 自体は別 tool)
  "desktop_discover",
  // Browser query
  "browser_search",
  "browser_overview",
  "browser_locate",
  "browser_form",
  // Wait (state 変化を起こさない、polling のみ)
  "wait_until",
  // V1 fallback query
  "get_windows",
  "get_ui_elements",
]);

/**
 * Returns `true` if the named tool is **destructive candidate** (potentially
 * changes external / OS / app / input state)。entry 不在 = default
 * destructive (fail-safe inversion design)。
 *
 * Procedural memory suggest filter で「inner steps に 1 件でも
 * `isToolDestructive(t) === true` あれば suggest skip」と組み合わせて使う。
 */
export function isToolDestructive(toolName: string): boolean {
  return !QUERY_SAFE_TOOLS.has(toolName);
}

/** @internal Test-only — query-safe set の参照 (test での classification 検証用) */
export function _getQuerySafeToolsForTest(): readonly string[] {
  return [...QUERY_SAFE_TOOLS];
}
