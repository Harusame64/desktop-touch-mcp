/** Standard MCP tool result content block */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Standard MCP tool result (index signature required by MCP SDK) */
export interface ToolResult {
  content: ContentBlock[];
  [key: string]: unknown;
}

/** A callable tool handler */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolHandler<T = any> = (params: T) => Promise<ToolResult>;

// ─────────────────────────────────────────────────────────────────────────────
// Structured failure type
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolFailure {
  ok: false;
  code: string;
  error: string;
  suggest?: string[];
  context?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Wrap a successful payload as a ToolResult. */
export function ok<T>(payload: T, pretty = false): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, pretty ? 2 : undefined) }],
  };
}

/** Wrap a ToolFailure as a ToolResult. */
export function fail(error: ToolFailure): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(error) }],
  };
}
