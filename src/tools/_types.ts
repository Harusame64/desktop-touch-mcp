/** Standard MCP tool result content block */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  // ADR-026: a by-ref link to disk-cached capture bytes (screenshot://by-ref/{id}).
  // Cheap to return; the client reads it via resources/read only when pixels are needed.
  | { type: "resource_link"; uri: string; name: string; mimeType?: string; description?: string };

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

// ─────────────────────────────────────────────────────────────────────────────
// Tool description builder (Tier A structured format)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a structured tool description for Tier A tools.
 * Produces a multi-section string: Purpose / Details / [Prefer] / [Caveats] / [Examples].
 */
export function buildDesc(d: {
  purpose: string;
  details: string;
  prefer?: string;
  caveats?: string;
  examples?: string[];
}): string {
  const parts = [`Purpose: ${d.purpose}`, `Details: ${d.details}`];
  if (d.prefer) parts.push(`Prefer: ${d.prefer}`);
  if (d.caveats) parts.push(`Caveats: ${d.caveats}`);
  if (d.examples?.length) parts.push(`Examples:\n${d.examples.map((e) => `  ${e}`).join("\n")}`);
  return parts.join("\n");
}
