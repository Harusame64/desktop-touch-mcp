# browser_eval IIFE wrapping roadmap

Issue: https://github.com/Harusame64/desktop-touch-mcp/issues/21

Goal: make repeated `browser_eval` calls safe in the same tab by preventing
global `const` / `let` redeclaration collisions.

## Scope

- Add an automatic IIFE wrapping step in `browserEvalHandler`.
- Preserve explicitly wrapped user expressions.
- Keep raw text and `withPerception` result formatting unchanged.
- Add regression coverage for repeated declarations in the same tab.
- Update tool guidance so agents know multi-statement snippets should use
  `return` for the final value.

## Checklist

- [x] Confirm current `browserEvalHandler` passes `expression` directly to `evaluateInTab`.
- [x] Confirm browser e2e tests already launch Chrome and call `browserEvalHandler`.
- [x] Add a helper that prepares `browser_eval` expressions before CDP evaluation.
- [x] Skip wrapping when the user already passes a common IIFE form.
- [x] Wrap expression-shaped snippets as `;(async () => (...))()`.
- [x] Wrap statement-shaped snippets as `;(async () => { ... })()`.
- [x] Route `browserEvalHandler` through the helper.
- [x] Update `browserEvalSchema.expression` description.
- [x] Regenerate `src/stub-tool-catalog.ts`.
- [x] Add e2e coverage for repeated `const` declarations.
- [x] Add e2e coverage for multi-statement snippets with explicit `return`.
- [x] Run targeted browser e2e test.
- [x] Run `npm run build`.
- [x] Address Copilot review: preserve statement completion values.
- [x] Address Copilot review: only skip wrapping for standalone IIFE expressions.

## Implementation Notes

- Candidate file: `src/tools/browser.ts`
- Candidate test file: `tests/e2e/browser-tab-context.test.ts`
- `evaluateInTab` in `src/engine/cdp-bridge.ts` already uses
  `awaitPromise: true`, so an async IIFE result should be awaited by CDP.
- If the expression is a multi-statement snippet, the wrapper will not infer a
  final return value. Callers should write `return value` explicitly.

## Handoff State

- Started on 2026-04-20.
- `npm run build` passed.
- `npx vitest run --project=e2e tests/e2e/browser-tab-context.test.ts` passed
  with 11 tests.
- `npm run generate:stub-catalog` updated the browser_eval schema description in
  `src/stub-tool-catalog.ts`.
- Copilot review follow-up tightened IIFE detection and preserved completion
  values for statement snippets such as `const x = 1; x`.
- The first sandboxed Vitest attempt failed before tests with `spawn EPERM`;
  rerunning the same targeted test outside the sandbox succeeded.
- Existing dirty files before this work: `.gitignore`,
  `docs/Anti-Fukuwarai-V2.md`, `docs/anti-Fukuwarai-V2-design.md`,
  `docs/tool-descriptions.md`.
- Do not revert those existing changes.
