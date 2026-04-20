/**
 * Pure helpers for browser_eval IIFE wrapping.
 * No side-effectful imports — importable from tests without mocks.
 */

type AsyncFunctionConstructor = new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
const AsyncFunction = Object.getPrototypeOf(async function () { /* constructor only */ }).constructor as AsyncFunctionConstructor;

export function canParseAsExpression(expression: string): boolean {
  try {
    new AsyncFunction(`return (\n${expression}\n);`);
    return true;
  } catch {
    return false;
  }
}

export function isAlreadyWrappedIife(expression: string): boolean {
  const normalized = expression
    .trim()
    .replace(/^;/, "")
    .replace(/;+\s*$/, "");

  if (!/^\s*\(\s*(?:async\s+function\b|function\b|async\s*\([^)]*\)\s*=>|\([^)]*\)\s*=>)/.test(normalized)) {
    return false;
  }

  return canParseAsExpression(normalized);
}

export function prepareBrowserEvalExpression(expression: string): string {
  if (isAlreadyWrappedIife(expression)) return expression;

  if (canParseAsExpression(expression)) {
    return `;(async () => (\n${expression}\n))()`;
  }

  const serializedExpression = JSON.stringify(expression);
  return `;(async () => {
  const __mcpExpression = ${serializedExpression};
  try {
    return eval(__mcpExpression);
  } catch (__mcpEvalError) {
    if (
      __mcpEvalError instanceof SyntaxError ||
      (__mcpEvalError instanceof Error && __mcpEvalError.name === "EvalError")
    ) {
      return (async () => {
${expression}
      })();
    }
    throw __mcpEvalError;
  }
})()`;
}
